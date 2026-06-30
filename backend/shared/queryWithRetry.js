/**
 * REQ-00399: 带重试机制的数据库查询
 * 提供自动重试功能，处理临时性数据库错误
 */

const { query: dbQuery } = require('./db');
const logger = require('./logger');

// 默认重试配置
const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 100,
  maxDelayMs: 2000,
  backoffMultiplier: 2,
  retryableErrors: [
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'connection terminated',
    'terminating connection due to administrator command',
    'deadlock detected'
  ]
};

/**
 * 检查错误是否可重试
 */
function isRetryableError(error) {
  const errorMessage = error?.message?.toLowerCase() || '';
  const errorCode = error?.code;
  
  return DEFAULT_RETRY_CONFIG.retryableErrors.some(
    retryable => 
      errorCode === retryable || 
      errorMessage.includes(retryable.toLowerCase())
  );
}

/**
 * 计算退避延迟
 */
function calculateDelay(attempt, initialDelay, maxDelay, multiplier) {
  const delay = initialDelay * Math.pow(multiplier, attempt);
  return Math.min(delay, maxDelay);
}

/**
 * 延迟执行
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的数据库查询
 * 
 * @param {string} text - SQL 查询文本
 * @param {Array} params - 查询参数
 * @param {Object} options - 重试选项
 * @returns {Promise} 查询结果
 */
async function queryWithRetry(text, params, options = {}) {
  const config = { ...DEFAULT_RETRY_CONFIG, ...options };
  let lastError;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await dbQuery(text, params);
    } catch (error) {
      lastError = error;
      
      // 最后一次尝试，不再重试
      if (attempt === config.maxRetries) {
        break;
      }
      
      // 检查是否可重试
      if (!isRetryableError(error)) {
        throw error;
      }
      
      const delay = calculateDelay(
        attempt,
        config.initialDelayMs,
        config.maxDelayMs,
        config.backoffMultiplier
      );
      
      logger.warn({
        module: 'queryWithRetry',
        msg: `Query failed, retrying (${attempt + 1}/${config.maxRetries})`,
        error: error.message,
        delay,
        query: text.substring(0, 100)
      });
      
      await sleep(delay);
    }
  }
  
  // 所有重试都失败，抛出最后的错误
  logger.error({
    module: 'queryWithRetry',
    msg: `Query failed after ${config.maxRetries + 1} attempts`,
    error: lastError?.message,
    query: text.substring(0, 100)
  });
  
  throw lastError;
}

module.exports = {
  query: queryWithRetry,
  queryWithRetry,
  isRetryableError,
  DEFAULT_RETRY_CONFIG
};
