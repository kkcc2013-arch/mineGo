// backend/shared/RetryManager.js
// REQ-00402: API 错误重试与智能退避系统
//
// 2026-09 重写要点（保持原导出 API 不变）：
// - 指标单例注册到共享 registry（原实现每 new 一次就重复注册 prom 指标 → 抛错）
// - 重试预算按"每次重试"消耗（原实现只在首次调用时检查一次），定时器 unref
// - AbortError / 超时 / 预算耗尽 正确分类为不可重试；支持 axios 风格 error.response.status
// - 429/503 的 Retry-After 优先于计算出的退避时间（上限 maxDelay）
// - 去相关抖动（decorrelated jitter）按 AWS 架构博客公式使用上一次延迟
// - 总截止时间 deadline（毫秒）：剩余时间不足以再等一次时不再重试
// - onRetry / onGiveUp / onSuccess 钩子（用于 retry_events / retry_stats_hourly 落库）

'use strict';

const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('retry-manager');

let sharedRegistry = null;
function registry() {
  if (!sharedRegistry) {
    try { sharedRegistry = require('./metrics').register; } catch { sharedRegistry = promClient.register; }
  }
  return sharedRegistry;
}

function metric(Type, config) {
  const reg = registry();
  return reg.getSingleMetric(config.name) || new Type({ ...config, registers: [reg] });
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);

/**
 * 统一重试管理器
 */
class RetryManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelay = options.initialDelay ?? 100;
    this.maxDelay = options.maxDelay ?? 30000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.backoffType = options.backoffType || 'exponential';
    this.jitterType = options.jitterType ?? 'full';
    this.jitterRange = options.jitterRange ?? 0.5;
    this.timeout = options.timeout ?? 30000;
    this.deadline = options.deadline ?? null;
    this.retryBudget = options.retryBudget ?? null;
    this.serviceName = options.serviceName || process.env.SERVICE_NAME || 'unknown';
    this.hooks = { onRetry: options.onRetry, onGiveUp: options.onGiveUp, onSuccess: options.onSuccess };

    this.errorClassifier = new ErrorClassifier(options.errorConfig);
    this.backoffStrategy = this.createBackoffStrategy(this.backoffType);
    this.metrics = new RetryMetrics();
  }

  /** 从 retry_configs 行构造 */
  static fromConfig(row = {}, extra = {}) {
    return new RetryManager({
      serviceName: row.service_name,
      maxRetries: row.max_retries,
      initialDelay: row.initial_delay_ms,
      maxDelay: row.max_delay_ms,
      backoffType: row.backoff_type,
      jitterType: row.jitter_type,
      timeout: row.timeout_ms,
      retryBudget: row.retry_budget_max ? new RetryBudget({ maxBudget: row.retry_budget_max, refillRate: row.retry_budget_refill || 10 }) : null,
      errorConfig: row.error_config || undefined,
      ...extra,
    });
  }

  createBackoffStrategy(type) {
    switch (type) {
      case 'linear':
        return new LinearBackoff(this);
      case 'adaptive':
        return new AdaptiveBackoff(this);
      case 'exponential':
      default:
        return new ExponentialBackoff(this);
    }
  }

  _hook(name, payload) {
    const fn = this.hooks[name];
    if (typeof fn === 'function') {
      try { fn(payload); } catch (err) { logger.debug({ err: err.message }, `retry hook ${name} failed`); }
    }
  }

  /**
   * 执行带重试的异步操作
   * @param {Function} operation (attempt) => Promise
   * @param {object} context { operationName, metadata, signal, maxRetries, deadline }
   */
  async execute(operation, context = {}) {
    const {
      operationName = 'unknown',
      metadata = {},
      signal = null,
    } = context;
    const maxRetries = context.maxRetries ?? this.maxRetries;
    const deadline = context.deadline ?? this.deadline;

    const startTime = Date.now();
    let attempt = 0;
    let prevDelay = this.initialDelay;
    const errorTypes = {};

    for (;;) {
      attempt++;
      try {
        if (signal && signal.aborted) throw new AbortError('Operation aborted');
        const remaining = deadline ? deadline - (Date.now() - startTime) : null;
        const attemptTimeout = remaining !== null ? Math.max(1, Math.min(this.timeout, remaining)) : this.timeout;
        const result = await this.executeWithTimeout(() => operation(attempt), attemptTimeout, signal);

        const duration = Date.now() - startTime;
        this.metrics.recordSuccess(operationName, attempt, duration, this.serviceName);
        if (this.backoffStrategy instanceof AdaptiveBackoff) this.backoffStrategy.recordSuccess();
        if (this.retryBudget && typeof this.retryBudget.recordRequest === 'function') this.retryBudget.recordRequest();
        if (attempt > 1) this._hook('onSuccess', { operationName, attempt, duration, metadata, errorTypes });
        return result;
      } catch (error) {
        const classification = this.errorClassifier.classify(error);
        errorTypes[classification.type] = (errorTypes[classification.type] || 0) + 1;
        if (this.backoffStrategy instanceof AdaptiveBackoff) this.backoffStrategy.recordFailure();

        if (!classification.retryable) {
          this.metrics.recordNonRetryableError(operationName, classification.type, this.serviceName);
          if (attempt > 1) this._hook('onGiveUp', { operationName, attempt, error, reason: 'non_retryable', duration: Date.now() - startTime, metadata, errorTypes });
          throw error;
        }

        if (attempt > maxRetries) {
          this.metrics.recordMaxRetriesExceeded(operationName, attempt, this.serviceName);
          this._hook('onGiveUp', { operationName, attempt, error, reason: 'max_retries', duration: Date.now() - startTime, metadata, errorTypes });
          logger.warn({ operationName, attempts: attempt, error: error.message }, 'Max retries exceeded');
          throw new MaxRetriesExceededError(`Operation failed after ${attempt} attempts`, { cause: error, attempts: attempt });
        }

        // 预算按每次重试消耗，避免故障期间重试放大流量（重试风暴）
        if (this.retryBudget && !this.retryBudget.allow()) {
          this.metrics.recordBudgetExhausted(operationName, this.serviceName);
          this._hook('onGiveUp', { operationName, attempt, error, reason: 'budget_exhausted', duration: Date.now() - startTime, metadata, errorTypes });
          const e = new RetryBudgetExhaustedError('Retry budget exhausted');
          e.cause = error;
          throw e;
        }

        let delay = this.backoffStrategy.calculateDelay(attempt, classification, prevDelay);
        if (classification.suggestedDelay !== null && classification.suggestedDelay !== undefined) {
          delay = Math.min(Math.max(delay, classification.suggestedDelay), this.maxDelay);
        }
        delay = Math.max(0, Math.round(delay));
        prevDelay = Math.max(delay, this.initialDelay);

        if (deadline && Date.now() - startTime + delay >= deadline) {
          this._hook('onGiveUp', { operationName, attempt, error, reason: 'deadline', duration: Date.now() - startTime, metadata, errorTypes });
          throw new TimeoutError(`Retry deadline ${deadline}ms exceeded`);
        }

        this.metrics.recordRetry(operationName, attempt, delay, classification.type, this.serviceName);
        this._hook('onRetry', { operationName, attempt, delay, errorType: classification.type, error, metadata });
        logger.debug({ operationName, attempt, delay, errorType: classification.type, error: error.message }, 'Retrying operation');

        await this.sleep(delay, signal);
      }
    }
  }

  async executeWithTimeout(operation, timeout, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', abortHandler);
        fn(v);
      };
      const timeoutId = setTimeout(() => done(reject, new TimeoutError(`Operation timed out after ${timeout}ms`)), timeout);
      const abortHandler = () => done(reject, new AbortError('Operation aborted'));
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });
      Promise.resolve()
        .then(operation)
        .then((r) => done(resolve, r), (e) => done(reject, e));
    });
  }

  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(new AbortError('Sleep aborted'));
      const t = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', abortHandler);
        resolve();
      }, ms);
      const abortHandler = () => { clearTimeout(t); reject(new AbortError('Sleep aborted')); };
      if (signal) signal.addEventListener('abort', abortHandler, { once: true });
    });
  }

  /**
   * 带重试的 HTTP 请求（只对幂等请求或带 Idempotency-Key 的请求自动重试）
   * 返回 fetch Response；最终失败的 HTTP 错误会带上 status/headers
   */
  async fetch(url, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const idem = IDEMPOTENT_METHODS.has(method) || Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key' || h.toLowerCase() === 'x-idempotency-key');
    const fetchImpl = options.fetchImpl || fetch;
    const once = () => fetchImpl(url, { ...options, fetchImpl: undefined, operationName: undefined });
    if (!idem) return once(); // 非幂等请求不自动重试，原样返回响应
    const run = async () => {
      const res = await once();
      if (!res.ok && this.errorClassifier.config.retryableStatusCodes.includes(res.status)) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        err.headers = Object.fromEntries(res.headers.entries());
        err.response = res;
        throw err;
      }
      return res;
    };
    try {
      return await this.execute(run, { operationName: options.operationName || `${method} ${String(url).split('?')[0]}`, signal: options.signal });
    } catch (err) {
      const inner = err instanceof MaxRetriesExceededError ? err.cause : err;
      if (inner && inner.response) return inner.response; // 返回最后一次的 HTTP 响应，交给调用方处理
      throw err;
    }
  }
}

/**
 * 指数退避算法
 */
class ExponentialBackoff {
  constructor(config) {
    this.initialDelay = config.initialDelay;
    this.maxDelay = config.maxDelay;
    this.backoffFactor = config.backoffFactor;
    this.jitterType = config.jitterType;
    this.jitterRange = config.jitterRange;
  }

  calculateDelay(attempt, classification = {}, prevDelay = this.initialDelay) {
    let delay = Math.min(this.initialDelay * Math.pow(this.backoffFactor, attempt - 1), this.maxDelay);
    if (classification.severity === 'high') delay *= 1.5;
    else if (classification.severity === 'low') delay *= 0.5;
    return Math.min(this.maxDelay, this.applyJitter(delay, prevDelay));
  }

  applyJitter(delay, prevDelay = this.initialDelay) {
    switch (this.jitterType) {
      case 'none':
        return delay;
      case 'full':
        // 完全随机抖动：[0, delay]
        return Math.random() * delay;
      case 'equal':
        // 等抖动：[delay/2, delay]
        return delay / 2 + Math.random() * (delay / 2);
      case 'decorrelated': {
        // 去相关抖动：sleep = min(cap, random_between(base, prev * 3))
        const lo = this.initialDelay;
        const hi = Math.max(lo, prevDelay * 3);
        return Math.min(this.maxDelay, lo + Math.random() * (hi - lo));
      }
      default:
        return delay * (1 - this.jitterRange + Math.random() * this.jitterRange * 2);
    }
  }
}

/**
 * 线性退避算法
 */
class LinearBackoff {
  constructor(config) {
    this.initialDelay = config.initialDelay;
    this.maxDelay = config.maxDelay;
    this.increment = config.increment ?? 1000;
    this.jitterRange = config.jitterRange;
  }

  calculateDelay(attempt) {
    const delay = Math.min(this.initialDelay + (attempt - 1) * this.increment, this.maxDelay);
    return Math.min(this.maxDelay, delay * (1 - this.jitterRange + Math.random() * this.jitterRange * 2));
  }
}

/**
 * 自适应退避算法：按近期成功率调整基准延迟（成功率高 → 缩短，低 → 拉长），叠加指数增长
 */
class AdaptiveBackoff {
  constructor(config) {
    this.initialDelay = config.initialDelay;
    this.maxDelay = config.maxDelay;
    this.minDelay = config.minDelay ?? 50;
    this.backoffFactor = config.backoffFactor ?? 2;

    this.successCount = 0;
    this.failureCount = 0;
    this.currentDelay = this.initialDelay;

    this.increaseFactor = 1.5;
    this.decreaseFactor = 0.8;
    this.windowSize = 10;
    this.successThreshold = 0.7;
  }

  calculateDelay(attempt, classification = {}) {
    this.adjustBasedOnHistory();
    let adjustedDelay = this.currentDelay * Math.pow(this.backoffFactor, Math.max(0, attempt - 1));
    if (classification.severity === 'high') adjustedDelay *= 1.5;
    else if (classification.severity === 'low') adjustedDelay *= 0.7;
    return Math.max(this.minDelay, Math.min(adjustedDelay, this.maxDelay));
  }

  recordSuccess() {
    this.successCount++;
    this.adjustBasedOnHistory();
  }

  recordFailure() {
    this.failureCount++;
    this.adjustBasedOnHistory();
  }

  adjustBasedOnHistory() {
    const total = this.successCount + this.failureCount;
    if (total >= this.windowSize) {
      const successRate = this.successCount / total;
      this.currentDelay *= successRate > this.successThreshold ? this.decreaseFactor : this.increaseFactor;
      this.successCount = 0;
      this.failureCount = 0;
      this.currentDelay = Math.max(this.minDelay, Math.min(this.currentDelay, this.maxDelay));
    }
  }
}

/**
 * 错误分类器
 */
class ErrorClassifier {
  constructor(config = {}) {
    this.config = {
      retryableStatusCodes: [408, 425, 429, 500, 502, 503, 504],
      nonRetryableStatusCodes: [400, 401, 403, 404, 405, 409, 410, 413, 415, 422],
      retryableErrors: [
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
        'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
      ],
      ...config,
    };
  }

  classify(error) {
    if (!error) return { retryable: false, type: 'unknown', severity: 'low', suggestedDelay: null };
    if (error.name === 'AbortError' || error instanceof AbortError) {
      return { retryable: false, type: 'aborted', severity: 'low', suggestedDelay: null };
    }
    if (error instanceof RetryBudgetExhaustedError || error.retryable === false) {
      return { retryable: false, type: error.name === 'RetryBudgetExhaustedError' ? 'budget' : 'explicit', severity: 'low', suggestedDelay: null };
    }
    const status = error.status || error.statusCode || (error.response && error.response.status);
    if (status) return this.classifyHttpError(error, status);
    if (error.name === 'TimeoutError' || error instanceof TimeoutError) {
      return { retryable: true, type: 'timeout', severity: 'medium', suggestedDelay: null };
    }
    const code = error.code || (error.cause && error.cause.code);
    if (code && typeof code === 'string') return this.classifyNetworkError({ code });
    if (error.name === 'TypeError' && /fetch failed/i.test(error.message || '')) {
      return { retryable: true, type: 'network', severity: 'high', suggestedDelay: null };
    }
    if (error.type || error.name) return this.classifyBusinessError(error);
    return { retryable: true, type: 'unknown', severity: 'medium', suggestedDelay: null };
  }

  classifyHttpError(error, status = error.status || error.statusCode) {
    if (status === 429) {
      return { retryable: true, type: 'rate_limit', severity: 'high', suggestedDelay: this.parseRetryAfter(error) };
    }
    if (status === 503) {
      return { retryable: true, type: 'server_error', severity: 'high', suggestedDelay: this.parseRetryAfter(error) };
    }
    if (this.config.retryableStatusCodes.includes(status)) {
      return { retryable: true, type: status === 408 ? 'timeout' : 'server_error', severity: status >= 502 ? 'high' : 'medium', suggestedDelay: null };
    }
    if (status >= 500 && status < 600) {
      return { retryable: false, type: 'server_error', severity: 'medium', suggestedDelay: null };
    }
    if (status >= 400 && status < 500) {
      return { retryable: false, type: 'client_error', severity: 'low', suggestedDelay: null };
    }
    return { retryable: false, type: 'http_unknown', severity: 'low', suggestedDelay: null };
  }

  classifyNetworkError(error) {
    const retryable = this.config.retryableErrors.includes(error.code);
    return { retryable, type: 'network', severity: retryable ? 'high' : 'low', suggestedDelay: null };
  }

  classifyBusinessError(error) {
    const nonRetryableTypes = [
      'ValidationError', 'AuthenticationError', 'AuthorizationError',
      'NotFoundError', 'ConflictError', 'BusinessRuleViolation', 'BusinessError', 'AppError',
    ];
    const typeName = error.type || error.name;
    if (nonRetryableTypes.includes(typeName)) {
      return { retryable: false, type: 'business', severity: 'low', suggestedDelay: null };
    }
    return { retryable: true, type: 'business', severity: 'medium', suggestedDelay: null };
  }

  parseRetryAfter(error) {
    const h = error.headers || (error.response && error.response.headers) || {};
    const retryAfter = typeof h.get === 'function' ? h.get('retry-after') : (h['retry-after'] || h['Retry-After']);
    if (!retryAfter) return null;
    if (/^\d+(\.\d+)?$/.test(String(retryAfter).trim())) return Math.round(parseFloat(retryAfter) * 1000);
    const date = new Date(retryAfter);
    if (!Number.isNaN(date.getTime())) return Math.max(0, date.getTime() - Date.now());
    return null;
  }
}

/**
 * 重试预算（令牌桶）：maxBudget 个令牌，每 refillInterval 恢复 refillRate 个；
 * 可选 ratio：额外按"请求数 × ratio"补充，保证重试量不超过正常流量的一定比例
 */
class RetryBudget {
  constructor(options = {}) {
    this.maxBudget = options.maxBudget ?? 100;
    this.minBudget = options.minBudget ?? 10;
    this.currentBudget = this.maxBudget;
    this.refillRate = options.refillRate ?? 10;
    this.refillInterval = options.refillInterval ?? 1000;
    this.ratio = options.ratio ?? 0;
    this._fraction = 0;

    this.refillTimer = null;
    if (options.autoRefill !== false) this.startRefillTimer();
  }

  allow() {
    if (this.currentBudget < 1) return false;
    this.currentBudget--;
    return true;
  }

  recordRequest() {
    if (!this.ratio) return;
    this._fraction += this.ratio;
    if (this._fraction >= 1) {
      const whole = Math.floor(this._fraction);
      this._fraction -= whole;
      this.currentBudget = Math.min(this.maxBudget, this.currentBudget + whole);
    }
  }

  refill() {
    this.currentBudget = Math.min(this.maxBudget, this.currentBudget + this.refillRate);
  }

  startRefillTimer() {
    this.refillTimer = setInterval(() => this.refill(), this.refillInterval);
    if (this.refillTimer.unref) this.refillTimer.unref();
  }

  stopRefillTimer() {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
      this.refillTimer = null;
    }
  }

  getBudget() {
    return this.currentBudget;
  }
}

/**
 * 重试指标收集器（单例注册，可被多个 RetryManager 共享）
 */
class RetryMetrics {
  constructor() {
    const labels = ['service', 'operation'];
    this.retryTotal = metric(promClient.Counter, { name: 'retry_total', help: 'Total number of retry attempts', labelNames: ['service', 'operation', 'error_type'] });
    this.retrySuccess = metric(promClient.Counter, { name: 'retry_success_total', help: 'Operations that succeeded (label retried=true when succeeded after retry)', labelNames: [...labels, 'retried'] });
    this.retryExhausted = metric(promClient.Counter, { name: 'retry_exhausted_total', help: 'Operations that exhausted retries', labelNames: labels });
    this.retryNonRetryable = metric(promClient.Counter, { name: 'retry_non_retryable_total', help: 'Operations failed with non-retryable errors', labelNames: ['service', 'operation', 'error_type'] });
    this.retryDelay = metric(promClient.Histogram, { name: 'retry_delay_ms', help: 'Retry delay in milliseconds', labelNames: labels, buckets: [10, 50, 100, 500, 1000, 5000, 10000, 30000] });
    this.retryDuration = metric(promClient.Histogram, { name: 'retry_duration_ms', help: 'Total operation duration including retries', labelNames: labels, buckets: [10, 50, 100, 500, 1000, 5000, 10000, 30000, 60000] });
    this.retryAttempts = metric(promClient.Histogram, { name: 'retry_attempts', help: 'Attempts per successful operation', labelNames: labels, buckets: [1, 2, 3, 4, 5, 8] });
    this.retryBudgetExhausted = metric(promClient.Counter, { name: 'retry_budget_exhausted_total', help: 'Total number of budget exhausted events', labelNames: labels });
  }

  recordSuccess(operationName, attempts, duration, service = process.env.SERVICE_NAME || 'unknown') {
    this.retrySuccess.inc({ service, operation: operationName, retried: attempts > 1 ? 'true' : 'false' });
    this.retryDuration.observe({ service, operation: operationName }, duration);
    this.retryAttempts.observe({ service, operation: operationName }, attempts);
  }

  recordRetry(operationName, attempt, delay, errorType, service = process.env.SERVICE_NAME || 'unknown') {
    this.retryTotal.inc({ service, operation: operationName, error_type: errorType });
    this.retryDelay.observe({ service, operation: operationName }, delay);
  }

  recordMaxRetriesExceeded(operationName, attempts, service = process.env.SERVICE_NAME || 'unknown') {
    this.retryExhausted.inc({ service, operation: operationName });
  }

  recordNonRetryableError(operationName, errorType, service = process.env.SERVICE_NAME || 'unknown') {
    this.retryNonRetryable.inc({ service, operation: operationName, error_type: errorType });
  }

  recordBudgetExhausted(operationName, service = process.env.SERVICE_NAME || 'unknown') {
    this.retryBudgetExhausted.inc({ service, operation: operationName });
  }
}

/**
 * 重试事件落库：retry_events（只记录发生过重试的操作）+ retry_stats_hourly（按小时聚合，定期 flush）
 */
class RetryStatsRecorder {
  constructor({ query, serviceName, flushIntervalMs = 30000, logger: log = logger } = {}) {
    this.query = query;
    this.serviceName = serviceName;
    this.log = log;
    this.agg = new Map();
    this.events = [];
    if (flushIntervalMs) {
      this.timer = setInterval(() => this.flush().catch(() => {}), flushIntervalMs);
      if (this.timer.unref) this.timer.unref();
    }
  }

  hooks() {
    return {
      onRetry: (e) => this._agg(e.operationName, { retry: 1, delay: e.delay, errorType: e.errorType }),
      onSuccess: (e) => { this._agg(e.operationName, { success: 1, attempts: e.attempt, duration: e.duration }); this._event(e, true); },
      onGiveUp: (e) => { this._agg(e.operationName, { attempts: e.attempt, duration: e.duration, errorType: e.reason }); this._event(e, false); },
    };
  }

  _agg(op, { retry = 0, success = 0, attempts = 0, delay = null, duration = null, errorType = null }) {
    const hour = new Date(); hour.setMinutes(0, 0, 0);
    const key = `${op}|${hour.toISOString()}`;
    const a = this.agg.get(key) || { op, hour, total: 0, success: 0, retries: 0, delaySum: 0, delayMax: 0, durSum: 0, durN: 0, errors: {} };
    a.total += attempts;
    a.success += success;
    a.retries += retry;
    if (delay !== null) { a.delaySum += delay; a.delayMax = Math.max(a.delayMax, delay); }
    if (duration !== null) { a.durSum += duration; a.durN++; }
    if (errorType) a.errors[errorType] = (a.errors[errorType] || 0) + 1;
    this.agg.set(key, a);
  }

  _event(e, success) {
    if (this.events.length > 1000) return;
    this.events.push({ op: e.operationName, attempt: e.attempt, success, duration: e.duration, errorType: e.reason || Object.keys(e.errorTypes || {})[0] || null, message: e.error ? String(e.error.message).slice(0, 500) : null, metadata: e.metadata || {} });
  }

  async flush() {
    if (!this.query) return;
    const events = this.events.splice(0);
    const aggs = [...this.agg.values()];
    this.agg.clear();
    for (const ev of events) {
      await this.query(
        `INSERT INTO retry_events (service_name, operation_name, attempt, error_type, error_message, success, duration_ms, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [this.serviceName, ev.op.slice(0, 255), ev.attempt, ev.errorType, ev.message, ev.success, ev.duration, JSON.stringify(ev.metadata)]).catch((err) => this.log.debug({ err: err.message }, 'retry_events insert failed'));
    }
    for (const a of aggs) {
      await this.query(
        `INSERT INTO retry_stats_hourly (service_name, operation_name, hour_timestamp, total_attempts, successful_attempts, retry_attempts, avg_delay_ms, max_delay_ms, error_breakdown, avg_duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (service_name, operation_name, hour_timestamp) DO UPDATE SET
           total_attempts = retry_stats_hourly.total_attempts + EXCLUDED.total_attempts,
           successful_attempts = retry_stats_hourly.successful_attempts + EXCLUDED.successful_attempts,
           retry_attempts = retry_stats_hourly.retry_attempts + EXCLUDED.retry_attempts,
           avg_delay_ms = COALESCE(EXCLUDED.avg_delay_ms, retry_stats_hourly.avg_delay_ms),
           max_delay_ms = GREATEST(COALESCE(retry_stats_hourly.max_delay_ms, 0), COALESCE(EXCLUDED.max_delay_ms, 0)),
           error_breakdown = COALESCE(retry_stats_hourly.error_breakdown, '{}'::jsonb) || EXCLUDED.error_breakdown,
           avg_duration_ms = COALESCE(EXCLUDED.avg_duration_ms, retry_stats_hourly.avg_duration_ms)`,
        [this.serviceName, a.op.slice(0, 255), a.hour, a.total, a.success, a.retries, a.retries ? a.delaySum / a.retries : null, a.delayMax || null, JSON.stringify(a.errors), a.durN ? a.durSum / a.durN : null]).catch((err) => this.log.debug({ err: err.message }, 'retry_stats_hourly upsert failed'));
    }
  }
}

// 自定义错误类型
class RetryBudgetExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RetryBudgetExhaustedError';
    this.retryable = false;
  }
}

class MaxRetriesExceededError extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'MaxRetriesExceededError';
    this.attempts = options?.attempts;
    this.cause = options?.cause;
    this.retryable = false;
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

class AbortError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AbortError';
    this.retryable = false;
  }
}

module.exports = {
  RetryManager,
  ExponentialBackoff,
  LinearBackoff,
  AdaptiveBackoff,
  ErrorClassifier,
  RetryBudget,
  RetryMetrics,
  RetryStatsRecorder,
  RetryBudgetExhaustedError,
  MaxRetriesExceededError,
  TimeoutError,
  AbortError,
  IDEMPOTENT_METHODS,
};
