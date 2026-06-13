// backend/shared/errors/ExternalServiceError.js - 外部服务错误
'use strict';

const BaseError = require('./BaseError');
const ERROR_CODES = require('./errorCodes');

/**
 * 外部服务错误
 * 
 * 用于调用第三方服务失败的场景
 */
class ExternalServiceError extends BaseError {
  /**
   * @param {string} serviceName 服务名称
   * @param {string} message 错误消息
   * @param {Error} cause 原始错误
   * @param {Object} options 额外选项
   */
  constructor(serviceName, message, cause = null, options = {}) {
    const code = ERROR_CODES.EXTERNAL_SERVICE_ERROR || 'EXT-001';
    super(code, message, {
      statusCode: options.statusCode || 502,
      isOperational: true,
      details: {
        service: serviceName,
        ...options.details
      },
      cause,
      ...options
    });
    
    this.serviceName = serviceName;
    this.name = 'ExternalServiceError';
  }
  
  get category() {
    return 'external_service';
  }
  
  get severity() {
    return 'critical';
  }
  
  /**
   * 创建超时错误
   */
  static timeout(serviceName, timeoutMs) {
    return new ExternalServiceError(serviceName, `Service timeout after ${timeoutMs}ms`, null, {
      details: { timeout: true, timeoutMs }
    });
  }
  
  /**
   * 创建连接失败错误
   */
  static connectionFailed(serviceName, error) {
    return new ExternalServiceError(serviceName, `Failed to connect to ${serviceName}`, error, {
      details: { connectionFailed: true }
    });
  }
}

module.exports = ExternalServiceError;
