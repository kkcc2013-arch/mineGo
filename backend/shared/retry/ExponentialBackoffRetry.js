/**
 * Exponential Backoff Retry - 指数退避重试策略
 * REQ-00519: 后端任务队列可靠性增强与死信处理系统
 * 
 * 功能：
 * - 指数退避算法实现
 * - 抖动（Jitter）支持
 * - 自适应重试策略
 * 
 * @module backend/shared/retry/ExponentialBackoffRetry
 * @version 1.0.0
 */

'use strict';

/**
 * ExponentialBackoffRetry - 指数退避重试策略
 */
class ExponentialBackoffRetry {
  constructor(options = {}) {
    this.options = {
      baseDelay: options.baseDelay || 1000,        // 基础延迟（1秒）
      maxDelay: options.maxDelay || 60000,         // 最大延迟（60秒）
      maxRetries: options.maxRetries || 5,         // 最大重试次数
      backoffFactor: options.backoffFactor || 2,   // 退避因子
      jitter: options.jitter || true,              // 是否启用抖动
      jitterRange: options.jitterRange || 0.5,     // 抖动范围（±50%）
      ...options
    };
    
    this.retryHistory = [];
  }

  /**
   * 计算重试延迟
   * @param {number} attempt - 当前尝试次数
   * @returns {number} - 延迟毫秒数
   */
  calculateDelay(attempt) {
    // 指数退避公式：delay = baseDelay * backoffFactor ^ attempt
    let delay = this.options.baseDelay * Math.pow(
      this.options.backoffFactor,
      attempt
    );
    
    // 限制最大延迟
    delay = Math.min(delay, this.options.maxDelay);
    
    // 应用抖动（防止重试风暴）
    if (this.options.jitter) {
      delay = this.applyJitter(delay);
    }
    
    // 记录历史
    this.retryHistory.push({
      attempt,
      delay,
      timestamp: Date.now()
    });
    
    return Math.round(delay);
  }

  /**
   * 应用抖动
   * @param {number} delay - 基础延迟
   * @returns {number} - 应用抖动后的延迟
   */
  applyJitter(delay) {
    const jitterRange = this.options.jitterRange;
    const jitter = delay * jitterRange * (Math.random() * 2 - 1);
    return delay + jitter;
  }

  /**
   * 获取重试策略配置
   * @param {string} taskType - 任务类型
   * @returns {Object} - 重试配置
   */
  getTaskRetryConfig(taskType) {
    // 不同任务类型的重试配置
    const configs = {
      // 数据删除任务 - 低优先级，快速失败
      'data_deletion': {
        maxRetries: 3,
        baseDelay: 500,
        maxDelay: 10000,
        backoffFactor: 1.5
      },
      
      // 数据导出任务 - 高优先级，长时间等待
      'data_export': {
        maxRetries: 10,
        baseDelay: 2000,
        maxDelay: 120000,
        backoffFactor: 2.5
      },
      
      // 备份任务 - 中等优先级
      'backup': {
        maxRetries: 5,
        baseDelay: 1000,
        maxDelay: 60000,
        backoffFactor: 2
      },
      
      // 索引维护任务 - 高优先级
      'index_maintenance': {
        maxRetries: 7,
        baseDelay: 1000,
        maxDelay: 90000,
        backoffFactor: 2
      },
      
      // 告警任务 - 最高优先级，必须成功
      'alert': {
        maxRetries: 15,
        baseDelay: 100,
        maxDelay: 30000,
        backoffFactor: 1.5
      },
      
      // 默认配置
      'default': {
        maxRetries: this.options.maxRetries,
        baseDelay: this.options.baseDelay,
        maxDelay: this.options.maxDelay,
        backoffFactor: this.options.backoffFactor
      }
    };
    
    return configs[taskType] || configs.default;
  }

  /**
   * 预估下次重试时间
   * @param {number} currentAttempt - 当前尝试次数
   * @returns {Date} - 预估下次重试时间
   */
  estimateNextRetry(currentAttempt) {
    const delay = this.calculateDelay(currentAttempt + 1);
    return new Date(Date.now() + delay);
  }

  /**
   * 获取退避序列
   * @param {number} maxAttempts - 最大尝试次数
   * @returns {Array<number>} - 延迟序列
   */
  getBackoffSequence(maxAttempts) {
    const sequence = [];
    for (let i = 0; i < maxAttempts; i++) {
      sequence.push(this.calculateDelay(i));
    }
    return sequence;
  }

  /**
   * 重试历史分析
   * @returns {Object} - 分析结果
   */
  analyzeRetryHistory() {
    if (this.retryHistory.length === 0) {
      return { totalAttempts: 0 };
    }
    
    const delays = this.retryHistory.map(h => h.delay);
    
    return {
      totalAttempts: this.retryHistory.length,
      averageDelay: delays.reduce((a, b) => a + b, 0) / delays.length,
      minDelay: Math.min(...delays),
      maxDelay: Math.max(...delays),
      lastDelay: delays[delays.length - 1],
      history: this.retryHistory.slice(-10)  // 最近 10 次
    };
  }

  /**
   * 检查是否应该继续重试
   * @param {number} attempt - 当前尝试次数
   * @param {Error} error - 最后的错误
   * @returns {boolean} - 是否继续重试
   */
  shouldRetry(attempt, error) {
    // 超过最大重试次数
    if (attempt >= this.options.maxRetries) {
      return false;
    }
    
    // 不可重试的错误类型
    const nonRetryableErrors = [
      'ValidationError',
      'AuthenticationError',
      'AuthorizationError',
      'NotFoundError',
      'ConflictError'
    ];
    
    if (nonRetryableErrors.includes(error.name) || 
        nonRetryableErrors.includes(error.code)) {
      return false;
    }
    
    // 可重试的错误类型
    const retryableErrors = [
      'TimeoutError',
      'ConnectionError',
      'NetworkError',
      'ServiceUnavailableError',
      'RateLimitError',
      'TemporaryError'
    ];
    
    if (retryableErrors.includes(error.name) || 
        retryableErrors.includes(error.code)) {
      return true;
    }
    
    // 默认可重试
    return true;
  }

  /**
   * 清空历史
   */
  clearHistory() {
    this.retryHistory = [];
  }
}

module.exports = { ExponentialBackoffRetry };