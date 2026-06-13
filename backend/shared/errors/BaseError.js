// backend/shared/errors/BaseError.js - 基础错误类
'use strict';

/**
 * 应用基础错误类
 * 
 * 所有自定义错误类都应继承此类
 */
class BaseError extends Error {
  /**
   * @param {string} code 错误码
   * @param {string} message 错误消息
   * @param {Object} options 选项
   * @param {number} options.statusCode HTTP 状态码
   * @param {Object} options.details 错误详情
   * @param {boolean} options.isOperational 是否为可预期的操作错误
   * @param {Error} options.cause 原始错误
   */
  constructor(code, message, options = {}) {
    super(message);
    
    this.code = code;
    this.statusCode = options.statusCode || 500;
    this.details = options.details || {};
    this.isOperational = options.isOperational !== false;
    this.timestamp = new Date().toISOString();
    
    // 保留原始错误
    if (options.cause) {
      this.cause = options.cause;
    }
    
    // 捕获堆栈信息
    Error.captureStackTrace(this, this.constructor);
  }
  
  /**
   * 转换为标准错误响应格式
   * @param {string} requestId 请求 ID
   * @param {string} path 请求路径
   * @returns {Object}
   */
  toJSON(requestId = null, path = null) {
    const response = {
      success: false,
      code: this.code,
      message: this.message,
      details: this.details,
      requestId,
      timestamp: this.timestamp
    };
    
    if (path) {
      response.path = path;
    }
    
    // 开发环境包含堆栈信息
    if (process.env.NODE_ENV !== 'production' && this.stack) {
      response.stack = this.stack;
    }
    
    return response;
  }
  
  /**
   * 获取错误分类
   */
  get category() {
    return 'base';
  }
  
  /**
   * 获取错误严重程度
   */
  get severity() {
    return this.statusCode >= 500 ? 'critical' : 'warning';
  }
}

module.exports = BaseError;
