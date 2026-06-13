// backend/shared/errors/BusinessError.js - 业务逻辑错误
'use strict';

const BaseError = require('./BaseError');

/**
 * 业务逻辑错误
 * 
 * 用于业务规则不满足的场景
 */
class BusinessError extends BaseError {
  /**
   * @param {string} code 错误码
   * @param {string} message 错误消息
   * @param {Object} options 额外选项
   */
  constructor(code, message, options = {}) {
    super(code, message, {
      statusCode: options.statusCode || 400,
      isOperational: true,
      ...options
    });
    
    this.name = 'BusinessError';
  }
  
  get category() {
    return 'business';
  }
  
  get severity() {
    return 'warning';
  }
}

module.exports = BusinessError;
