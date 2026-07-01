# REQ-00402: API 错误重试与智能退避系统

- **编号**：REQ-00402
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/RetryManager.js、backend/shared/middleware/retryMiddleware.js、game-client
- **创建时间**：2026-07-01 01:00 UTC
- **依赖需求**：REQ-00014（熔断降级）、REQ-00023（分布式追踪）

## 1. 背景与问题

当前 mineGo 项目的 API 调用错误处理存在以下问题：

### 1.1 重试策略不统一
- 各微服务独立实现重试逻辑，策略不一致
- 部分服务使用固定间隔重试，部分无重试机制
- 缺少跨服务调用的重试协调，可能导致级联重试风暴

### 1.2 退避算法简单
- 固定间隔重试在服务恢复时可能导致请求洪峰
- 未考虑服务负载和错误类型，重试效率低
- 缺少抖动（Jitter）机制，多客户端同时重试时产生惊群效应

### 1.3 错误分类不足
- 所有错误统一处理，未区分临时性错误和永久性错误
- 缺少基于 HTTP 状态码的智能重试决策
- 业务错误和技术错误混合处理

### 1.4 可观测性缺失
- 重试次数、成功率等指标分散
- 缺少重试链路追踪
- 难以定位重试相关问题

## 2. 目标

构建统一的 API 错误重试与智能退避系统：

1. **统一重试框架**：所有服务使用一致的重试策略
2. **智能退避算法**：支持指数退避、线性退避、自适应退避
3. **错误分类处理**：根据错误类型选择最佳重试策略
4. **防止重试风暴**：抖动机制、重试预算、熔断联动
5. **完整可观测性**：重试指标、链路追踪、告警机制

**预期收益：**
- API 调用成功率提升 15%
- 服务恢复后请求洪峰减少 80%
- 错误定位时间减少 60%

## 3. 范围

### 包含
- RetryManager 核心模块
- 多种退避算法实现
- 错误分类器
- 重试中间件
- 客户端 SDK 重试支持
- Prometheus 指标集成
- 单元测试和集成测试

### 不包含
- 前端 UI 重试状态展示（后续需求）
- 数据库事务重试（已有独立机制）
- 消息队列消费重试（已有独立机制）

## 4. 详细需求

### 4.1 RetryManager 核心模块

```javascript
// backend/shared/RetryManager.js

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

        return result;

      } catch (error) {
        lastError = error;
        
        // 分类错误
        const classification = this.errorClassifier.classify(error);
        
        // 不可重试错误，直接抛出
        if (!classification.retryable) {
          this.metrics.recordNonRetryableError(operationName, classification.type);
          throw error;
        }

        // 达到最大重试次数
        if (attempt > this.maxRetries) {
          this.metrics.recordMaxRetriesExceeded(operationName, attempt);
          throw new MaxRetriesExceededError(
            `Operation failed after ${attempt} attempts`,
            { cause: error, attempts: attempt }
          );
        }

        // 计算退避时间
        const delay = this.backoffStrategy.calculateDelay(attempt, classification);
        
        // 记录重试
        this.metrics.recordRetry(operationName, attempt, delay, classification.type);

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
    setInterval(() => {
      this.currentBudget = Math.min(
        this.maxBudget,
        this.currentBudget + this.refillRate
      );
    }, this.refillInterval);
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
    this.counters = new Map();
    this.histograms = new Map();
  }

  recordSuccess(operationName, attempts, duration) {
    this.increment(`retry.${operationName}.success`);
    this.increment(`retry.${operationName}.attempts`, attempts);
    this.observe(`retry.${operationName}.duration`, duration);
  }

  recordRetry(operationName, attempt, delay, errorType) {
    this.increment(`retry.${operationName}.total`);
    this.increment(`retry.${operationName}.attempt.${attempt}`);
    this.increment(`retry.${operationName}.error.${errorType}`);
  }

  recordMaxRetriesExceeded(operationName, attempts) {
    this.increment(`retry.${operationName}.exhausted`);
    this.increment(`retry.${operationName}.attempts`, attempts);
  }

  recordNonRetryableError(operationName, errorType) {
    this.increment(`retry.${operationName}.non_retryable`);
    this.increment(`retry.${operationName}.error.${errorType}`);
  }

  recordBudgetExhausted(operationName) {
    this.increment(`retry.${operationName}.budget_exhausted`);
  }

  increment(metric, value = 1) {
    const current = this.counters.get(metric) || 0;
    this.counters.set(metric, current + value);
  }

  observe(metric, value) {
    if (!this.histograms.has(metric)) {
      this.histograms.set(metric, []);
    }
    this.histograms.get(metric).push(value);
  }

  exportPrometheus() {
    const lines = [];
    
    // 计数器
    for (const [name, value] of this.counters) {
      lines.push(`# HELP ${name} Retry counter`);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name} ${value}`);
    }
    
    // 直方图（简化）
    for (const [name, values] of this.histograms) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      lines.push(`# HELP ${name} Retry duration`);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name} ${avg.toFixed(2)}`);
    }
    
    return lines.join('\n');
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
```

### 4.2 重试中间件

```javascript
// backend/shared/middleware/retryMiddleware.js

const { RetryManager, RetryBudget } = require('../RetryManager');
const { logger } = require('../logger');

/**
 * Express 中间件：为出站请求添加重试能力
 */
function createRetryMiddleware(options = {}) {
  const retryManager = new RetryManager({
    maxRetries: options.maxRetries ?? 3,
    initialDelay: options.initialDelay ?? 100,
    maxDelay: options.maxDelay ?? 10000,
    backoffType: options.backoffType ?? 'exponential',
    jitterType: options.jitterType ?? 'full',
    timeout: options.timeout ?? 30000,
    retryBudget: options.enableBudget ? new RetryBudget(options.budgetConfig) : null,
    errorConfig: options.errorConfig
  });

  // 将 RetryManager 挂载到 app.locals
  return (req, res, next) => {
    req.retryManager = retryManager;
    next();
  };
}

/**
 * 包装 fetch 函数，添加重试能力
 */
function createRetryableFetch(retryManager) {
  return async (url, options = {}) => {
    return retryManager.execute(async () => {
      const response = await fetch(url, {
        ...options,
        signal: options.signal
      });

      // 检查响应状态
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.headers = Object.fromEntries(response.headers.entries());
        throw error;
      }

      return response;
    }, {
      operationName: options.operationName || url,
      metadata: { url, method: options.method || 'GET' },
      signal: options.signal
    });
  };
}

/**
 * 服务间调用重试包装器
 */
function wrapServiceClient(client, retryManager) {
  const originalRequest = client.request.bind(client);
  
  client.request = async function(options) {
    return retryManager.execute(
      () => originalRequest(options),
      {
        operationName: `${options.service}.${options.method}`,
        metadata: options,
        signal: options.signal
      }
    );
  };
  
  return client;
}

module.exports = {
  createRetryMiddleware,
  createRetryableFetch,
  wrapServiceClient
};
```

### 4.3 客户端 SDK 重试支持

```javascript
// frontend/game-client/src/api/RetryableClient.js

class RetryableClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = baseUrl;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialDelay = options.initialDelay ?? 100;
    this.maxDelay = options.maxDelay ?? 10000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.timeout = options.timeout ?? 30000;
    
    this.pendingRequests = new Map();
  }

  async request(method, path, data = null, options = {}) {
    const requestId = `${method}:${path}:${Date.now()}`;
    const controller = new AbortController();
    
    this.pendingRequests.set(requestId, controller);
    
    try {
      const result = await this.executeWithRetry(
        () => this.doRequest(method, path, data, controller.signal),
        { ...options, requestId }
      );
      
      return result;
    } finally {
      this.pendingRequests.delete(requestId);
    }
  }

  async executeWithRetry(operation, context) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.maxRetries) {
      attempt++;

      try {
        const result = await operation();
        return result;
      } catch (error) {
        lastError = error;

        // 检查是否可重试
        if (!this.isRetryable(error)) {
          throw error;
        }

        // 检查是否达到最大重试次数
        if (attempt > this.maxRetries) {
          throw error;
        }

        // 计算延迟
        const delay = this.calculateDelay(attempt, error);
        
        // 等待
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  async doRequest(method, path, data, signal) {
    const url = `${this.baseUrl}${path}`;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      signal
    };

    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  isRetryable(error) {
    // 网络错误
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return true;
    }

    // HTTP 状态码
    if (error.status) {
      return [408, 429, 500, 502, 503, 504].includes(error.status);
    }

    return false;
  }

  calculateDelay(attempt, error) {
    // 使用 Retry-After 头
    if (error.status === 429 && error.headers?.['retry-after']) {
      const retryAfter = parseInt(error.headers['retry-after'], 10);
      if (!isNaN(retryAfter)) {
        return retryAfter * 1000;
      }
    }

    // 指数退避 + 抖动
    const baseDelay = this.initialDelay * Math.pow(this.backoffFactor, attempt - 1);
    const cappedDelay = Math.min(baseDelay, this.maxDelay);
    const jitter = cappedDelay * Math.random();
    
    return cappedDelay * 0.5 + jitter * 0.5;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  cancelAll() {
    this.pendingRequests.forEach(controller => controller.abort());
    this.pendingRequests.clear();
  }
}

export default RetryableClient;
```

### 4.4 数据库迁移

```sql
-- database/migrations/20260701_00_retry_system.sql
-- API 重试系统表

-- 重试配置表
CREATE TABLE IF NOT EXISTS retry_configs (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL UNIQUE,
  max_retries INTEGER DEFAULT 3,
  initial_delay_ms INTEGER DEFAULT 100,
  max_delay_ms INTEGER DEFAULT 30000,
  backoff_type VARCHAR(20) DEFAULT 'exponential',
  jitter_type VARCHAR(20) DEFAULT 'full',
  timeout_ms INTEGER DEFAULT 30000,
  retry_budget_max INTEGER DEFAULT 100,
  retry_budget_refill INTEGER DEFAULT 10,
  error_config JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 重试事件日志表（用于分析）
CREATE TABLE IF NOT EXISTS retry_events (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  attempt INTEGER NOT NULL,
  delay_ms INTEGER,
  error_type VARCHAR(50),
  error_message TEXT,
  success BOOLEAN NOT NULL,
  duration_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_retry_events_service ON retry_events(service_name);
CREATE INDEX idx_retry_events_operation ON retry_events(operation_name);
CREATE INDEX idx_retry_events_created ON retry_events(created_at);
CREATE INDEX idx_retry_events_success ON retry_events(success);

-- 重试统计聚合表
CREATE TABLE IF NOT EXISTS retry_stats_hourly (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  operation_name VARCHAR(255) NOT NULL,
  hour_timestamp TIMESTAMP NOT NULL,
  total_attempts BIGINT DEFAULT 0,
  successful_attempts BIGINT DEFAULT 0,
  retry_attempts BIGINT DEFAULT 0,
  avg_delay_ms DOUBLE PRECISION,
  error_breakdown JSONB,
  UNIQUE(service_name, operation_name, hour_timestamp)
);

CREATE INDEX idx_retry_stats_service ON retry_stats_hourly(service_name);
CREATE INDEX idx_retry_stats_hour ON retry_stats_hourly(hour_timestamp);

COMMENT ON TABLE retry_configs IS '服务重试配置';
COMMENT ON TABLE retry_events IS '重试事件日志';
COMMENT ON TABLE retry_stats_hourly IS '重试统计聚合';
```

## 5. 验收标准（可测试）

- [ ] RetryManager 支持指数退避、线性退避、自适应退避三种算法
- [ ] 错误分类器能正确识别 HTTP 状态码、网络错误、业务错误
- [ ] 抖动机制有效防止多客户端同时重试（惊群效应）
- [ ] 重试预算管理器正确限制重试次数
- [ ] 超时控制正常工作，不会无限等待
- [ ] AbortSignal 支持正确取消正在进行的重试
- [ ] Prometheus 指标正确导出重试次数、成功率、延迟分布
- [ ] 中间件正确注入 RetryManager 到请求上下文
- [ ] 客户端 SDK 正确处理重试逻辑
- [ ] 单元测试覆盖率 > 85%

## 6. 工作量估算

**L（Large）** - 需要实现核心模块、中间件、客户端 SDK、数据库迁移和完整的测试套件。预计 2-3 天。

## 7. 优先级理由

**P1** - API 重试是系统稳定性的关键组件，直接影响服务间调用的可靠性。统一的重试策略可以：
- 减少因临时故障导致的请求失败
- 防止重试风暴导致的级联故障
- 提供完整的可观测性，便于问题定位

该需求是实现"生产可用"目标的必要组件。
