// backend/shared/errors/RateLimitError.js - 限流错误
'use strict';

const BaseError = require('./BaseError');
const ERROR_CODES = require('./errorCodes');

/**
 * 限流错误
 * 
 * 用于请求频率超限的场景
 */
class RateLimitError extends BaseError {
  /**
   * @param {number} retryAfter 重试等待秒数
   * @param {Object} options 额外选项
   */
  constructor(retryAfter, options = {}) {
    super(
      ERROR_CODES.RATE_LIMIT_EXCEEDED || 'RATE-001',
      'Rate limit exceeded',
      {
        statusCode: 429,
        isOperational: true,
        details: {
          retryAfter,
          ...options.details
        },
        ...options
      }
    );
    
    this.retryAfter = retryAfter;
    this.name = 'RateLimitError';
  }
  
  get category() {
    return 'rate_limit';
  }
  
  get severity() {
    return 'warning';
  }
  
  toJSON(requestId = null, path = null) {
    const response = super.toJSON(requestId, path);
    response.retryAfter = this.retryAfter;
    return response;
  }
}

module.exports = RateLimitError;
