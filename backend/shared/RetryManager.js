// backend/shared/RetryManager.js
// REQ-00402: API 错误重试与智能退避系统

'use strict';

const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('retry-manager');

/**
 * 统一重试管理器
 */
class RetryManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelay = options.initialDelay ?? 100;
    this.maxDelay = options.maxDelay ?? 30000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.jitterType = options.jitterType ?? 'full';
    this.jitterRange = options.jitterRange ?? 0.5;
    this.timeout = options.timeout ?? 30000;
    this.retryBudget = options.retryBudget ?? null;

    this.errorClassifier = new ErrorClassifier(options.errorConfig);
    this.backoffStrategy = this.createBackoffStrategy(options.backoffType);
    this.metrics = new RetryMetrics();
  }

  createBackoffStrategy(type) {
    switch (type) {
      case 'exponential':
        return new ExponentialBackoff(this);
      case 'linear':
        return new LinearBackoff(this);
      case 'adaptive':
        return new AdaptiveBackoff(this);
      default:
        return new ExponentialBackoff(this);
    }
  }

  /**
   * 执行带重试的异步操作
   */
  async execute(operation, context = {}) {
    const {
      operationName = 'unknown',
      metadata = {},
      signal = null
    } = context;

    const startTime = Date.now();
    let lastError = null;
    let attempt = 0;

    // 检查重试预算
    if (this.retryBudget && !this.retryBudget.allow()) {
      this.metrics.recordBudgetExhausted(operationName);
      throw new RetryBudgetExhaustedError('Retry budget exhausted');
    }

    while (attempt <= this.maxRetries) {
      attempt++;

      try {
        // 检查是否已取消
        if (signal?.aborted) {
          throw new AbortError('Operation aborted');
        }

        // 执行操作（带超时）
        const result = await this.executeWithTimeout(
          operation,
          this.timeout,
          signal
        );

        // 成功，记录指标
        this.metrics.recordSuccess(operationName, attempt, Date.now() - startTime);

        // 更新自适应退避状态
        if (this.backoffStrategy instanceof AdaptiveBackoff) {
          this.backoffStrategy.recordSuccess();
        }

        logger.debug({
          operationName,
          attempt,
          duration: Date.now() - startTime
        }, 'Operation succeeded');

        return result;

      } catch (error) {
        lastError = error;

        // 分类错误
        const classification = this.errorClassifier.classify(error);

        // 不可重试错误，直接抛出
        if (!classification.retryable) {
          this.metrics.recordNonRetryableError(operationName, classification.type);
          logger.warn({
            operationName,
            attempt,
            errorType: classification.type,
            error: error.message
          }, 'Non-retryable error encountered');
          throw error;
        }

        // 达到最大重试次数
        if (attempt > this.maxRetries) {
          this.metrics.recordMaxRetriesExceeded(operationName, attempt);
          logger.error({
            operationName,
            attempts: attempt,
            error: error.message
          }, 'Max retries exceeded');
          throw new MaxRetriesExceededError(
            `Operation failed after ${attempt} attempts`,
            { cause: error, attempts: attempt }
          );
        }

        // 计算退避时间
        const delay = this.backoffStrategy.calculateDelay(attempt, classification);

        // 记录重试
        this.metrics.recordRetry(operationName, attempt, delay, classification.type);

        logger.info({
          operationName,
          attempt,
          delay,
          errorType: classification.type,
          error: error.message
        }, 'Retrying operation');

        // 等待退避时间
        await this.sleep(delay, signal);
      }
    }

    throw lastError;
  }

  async executeWithTimeout(operation, timeout, signal) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new TimeoutError(`Operation timed out after ${timeout}ms`));
      }, timeout);

      const abortHandler = () => {
        clearTimeout(timeoutId);
        reject(new AbortError('Operation aborted'));
      };

      signal?.addEventListener('abort', abortHandler, { once: true });

      operation()
        .then((result) => {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', abortHandler);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', abortHandler);
          reject(error);
        });
    });
  }

  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const abortHandler = () => {
        reject(new AbortError('Sleep aborted'));
      };

      signal?.addEventListener('abort', abortHandler, { once: true });

      setTimeout(() => {
        signal?.removeEventListener('abort', abortHandler);
        resolve();
      }, ms);
    });
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

  calculateDelay(attempt, classification) {
    // 基础延迟：指数增长
    let delay = Math.min(
      this.initialDelay * Math.pow(this.backoffFactor, attempt - 1),
      this.maxDelay
    );

    // 根据错误类型调整
    if (classification.severity === 'high') {
      delay *= 1.5;
    } else if (classification.severity === 'low') {
      delay *= 0.5;
    }

    // 应用抖动
    return this.applyJitter(delay);
  }

  applyJitter(delay) {
    switch (this.jitterType) {
      case 'full':
        // 完全随机抖动：[0, delay]
        return Math.random() * delay;

      case 'equal':
        // 等抖动：[delay/2, delay]
        return delay / 2 + Math.random() * (delay / 2);

      case 'decorrelated':
        // 去相关抖动：随机重置退避时间
        return Math.min(this.maxDelay, Math.random() * delay * 3);

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

  calculateDelay(attempt, classification) {
    let delay = Math.min(
      this.initialDelay + (attempt - 1) * this.increment,
      this.maxDelay
    );

    // 应用抖动
    return delay * (1 - this.jitterRange + Math.random() * this.jitterRange * 2);
  }
}

/**
 * 自适应退避算法
 */
class AdaptiveBackoff {
  constructor(config) {
    this.initialDelay = config.initialDelay;
    this.maxDelay = config.maxDelay;
    this.minDelay = config.minDelay ?? 50;

    // 自适应参数
    this.successCount = 0;
    this.failureCount = 0;
    this.currentDelay = this.initialDelay;

    // 学习参数
    this.increaseFactor = 1.5;
    this.decreaseFactor = 0.8;
    this.windowSize = 10;
    this.successThreshold = 0.7;
  }

  calculateDelay(attempt, classification) {
    // 根据历史成功率调整延迟
    this.adjustBasedOnHistory();

    // 根据错误类型调整
    let adjustedDelay = this.currentDelay;

    if (classification.severity === 'high') {
      adjustedDelay *= 1.5;
    } else if (classification.severity === 'low') {
      adjustedDelay *= 0.7;
    }

    return Math.max(
      this.minDelay,
      Math.min(adjustedDelay, this.maxDelay)
    );
  }

  recordSuccess() {
    this.successCount++;
    this.adjustBasedOnHistory();
  }

  recordFailure() {
    this.failureCount++;
  }

  adjustBasedOnHistory() {
    const total = this.successCount + this.failureCount;

    if (total >= this.windowSize) {
      const successRate = this.successCount / total;

      if (successRate > this.successThreshold) {
        // 成功率高，减少延迟
        this.currentDelay *= this.decreaseFactor;
      } else {
        // 成功率低，增加延迟
        this.currentDelay *= this.increaseFactor;
      }

      // 重置计数
      this.successCount = 0;
      this.failureCount = 0;

      // 限制范围
      this.currentDelay = Math.max(
        this.minDelay,
        Math.min(this.currentDelay, this.maxDelay)
      );
    }
  }
}

/**
 * 错误分类器
 */
class ErrorClassifier {
  constructor(config = {}) {
    this.config = {
      // HTTP 状态码分类
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
      nonRetryableStatusCodes: [400, 401, 403, 404, 405, 410, 422],

      // 错误类型分类
      retryableErrors: [
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH',
        'ENETUNREACH', 'EAI_AGAIN', 'ENOTFOUND'
      ],

      // 自定义规则
      ...config
    };
  }

  classify(error) {
    // HTTP 错误
    if (error.status || error.statusCode) {
      return this.classifyHttpError(error);
    }

    // 网络错误
    if (error.code) {
      return this.classifyNetworkError(error);
    }

    // 业务错误
    if (error.type || error.name) {
      return this.classifyBusinessError(error);
    }

    // 默认：可重试，中等严重程度
    return {
      retryable: true,
      type: 'unknown',
      severity: 'medium',
      suggestedDelay: null
    };
  }

  classifyHttpError(error) {
    const status = error.status || error.statusCode;

    // 429 Too Many Requests - 特殊处理
    if (status === 429) {
      return {
        retryable: true,
        type: 'rate_limit',
        severity: 'high',
        suggestedDelay: this.parseRetryAfter(error)
      };
    }

    // 服务端错误 - 可重试
    if (status >= 500 && status < 600) {
      return {
        retryable: true,
        type: 'server_error',
        severity: status >= 502 ? 'high' : 'medium'
      };
    }

    // 请求超时 - 可重试
    if (status === 408) {
      return {
        retryable: true,
        type: 'timeout',
        severity: 'medium'
      };
    }

    // 客户端错误 - 不重试
    if (this.config.nonRetryableStatusCodes.includes(status)) {
      return {
        retryable: false,
        type: 'client_error',
        severity: 'low'
      };
    }

    // 其他 4xx - 不重试
    if (status >= 400 && status < 500) {
      return {
        retryable: false,
        type: 'client_error',
        severity: 'low'
      };
    }

    return {
      retryable: true,
      type: 'http_unknown',
      severity: 'medium'
    };
  }

  classifyNetworkError(error) {
    const retryable = this.config.retryableErrors.includes(error.code);

    return {
      retryable,
      type: 'network',
      severity: retryable ? 'high' : 'low'
    };
  }

  classifyBusinessError(error) {
    // 已知业务错误类型
    const nonRetryableTypes = [
      'ValidationError', 'AuthenticationError', 'AuthorizationError',
      'NotFoundError', 'ConflictError', 'BusinessRuleViolation'
    ];

    const typeName = error.type || error.name;

    if (nonRetryableTypes.includes(typeName)) {
      return {
        retryable: false,
        type: 'business',
        severity: 'low'
      };
    }

    // 其他业务错误 - 可能是临时状态
    return {
      retryable: true,
      type: 'business',
      severity: 'medium'
    };
  }

  parseRetryAfter(error) {
    const retryAfter = error.headers?.['retry-after'];

    if (!retryAfter) return null;

    // 秒数格式
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }

    // 日期格式
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now());
    }

    return null;
  }
}

/**
 * 重试预算管理器
 */
class RetryBudget {
  constructor(options = {}) {
    this.maxBudget = options.maxBudget ?? 100;
    this.minBudget = options.minBudget ?? 10;
    this.currentBudget = this.maxBudget;
    this.refillRate = options.refillRate ?? 10; // 每秒恢复
    this.refillInterval = options.refillInterval ?? 1000;

    this.refillTimer = null;
    this.startRefillTimer();
  }

  allow() {
    if (this.currentBudget <= 0) {
      return false;
    }

    this.currentBudget--;
    return true;
  }

  startRefillTimer() {
    this.refillTimer = setInterval(() => {
      this.currentBudget = Math.min(
        this.maxBudget,
        this.currentBudget + this.refillRate
      );
    }, this.refillInterval);
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
 * 重试指标收集器
 */
class RetryMetrics {
  constructor() {
    // Prometheus 指标
    this.retryTotal = new promClient.Counter({
      name: 'retry_total',
      help: 'Total number of retry attempts',
      labelNames: ['service', 'operation', 'error_type']
    });

    this.retrySuccess = new promClient.Counter({
      name: 'retry_success_total',
      help: 'Total number of successful operations after retry',
      labelNames: ['service', 'operation']
    });

    this.retryExhausted = new promClient.Counter({
      name: 'retry_exhausted_total',
      help: 'Total number of operations that exhausted retries',
      labelNames: ['service', 'operation']
    });

    this.retryDelay = new promClient.Histogram({
      name: 'retry_delay_ms',
      help: 'Retry delay in milliseconds',
      labelNames: ['service', 'operation'],
      buckets: [10, 50, 100, 500, 1000, 5000, 10000, 30000]
    });

    this.retryDuration = new promClient.Histogram({
      name: 'retry_duration_ms',
      help: 'Total operation duration including retries',
      labelNames: ['service', 'operation'],
      buckets: [100, 500, 1000, 5000, 10000, 30000, 60000]
    });

    this.retryBudgetExhausted = new promClient.Counter({
      name: 'retry_budget_exhausted_total',
      help: 'Total number of budget exhausted events',
      labelNames: ['service', 'operation']
    });
  }

  recordSuccess(operationName, attempts, duration) {
    const service = process.env.SERVICE_NAME || 'unknown';
    this.retrySuccess.inc({ service, operation: operationName });
    this.retryDuration.observe({ service, operation: operationName }, duration);
  }

  recordRetry(operationName, attempt, delay, errorType) {
    const service = process.env.SERVICE_NAME || 'unknown';
    this.retryTotal.inc({ service, operation: operationName, error_type: errorType });
    this.retryDelay.observe({ service, operation: operationName }, delay);
  }

  recordMaxRetriesExceeded(operationName, attempts) {
    const service = process.env.SERVICE_NAME || 'unknown';
    this.retryExhausted.inc({ service, operation: operationName });
  }

  recordNonRetryableError(operationName, errorType) {
    const service = process.env.SERVICE_NAME || 'unknown';
    // 记录到日志即可
    logger.warn({ service, operation: operationName, errorType }, 'Non-retryable error');
  }

  recordBudgetExhausted(operationName) {
    const service = process.env.SERVICE_NAME || 'unknown';
    this.retryBudgetExhausted.inc({ service, operation: operationName });
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
  }
}

class TimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
    this.retryable = true;
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
  RetryBudgetExhaustedError,
  MaxRetriesExceededError,
  TimeoutError,
  AbortError
};
