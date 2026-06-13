// backend/shared/errors/ValidationError.js - 参数验证错误
'use strict';

const BaseError = require('./BaseError');
const ERROR_CODES = require('./errorCodes');

/**
 * 参数验证错误
 * 
 * 用于请求参数验证失败的场景
 */
class ValidationError extends BaseError {
  /**
   * @param {string} field 字段名
   * @param {string} message 错误消息
   * @param {Object} options 额外选项
   */
  constructor(field, message, options = {}) {
    const code = ERROR_CODES.VALIDATION_ERROR || 'VAL-001';
    super(code, message, {
      statusCode: 400,
      details: {
        field,
        ...options.details
      },
      ...options
    });
    
    this.field = field;
    this.name = 'ValidationError';
  }
  
  get category() {
    return 'validation';
  }
  
  get severity() {
    return 'info';
  }
  
  /**
   * 从 Joi 验证错误创建
   */
  static fromJoiError(joiError) {
    const firstError = joiError.details?.[0] || {};
    return new ValidationError(
      firstError.path?.join('.') || 'unknown',
      firstError.message || joiError.message,
      {
        details: {
          validationErrors: joiError.details
        }
      }
    );
  }
  
  /**
   * 批量创建验证错误
   */
  static batch(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      return null;
    }
    
    const firstError = errors[0];
    return new ValidationError(
      firstError.field || 'unknown',
      firstError.message || 'Validation failed',
      {
        details: {
          allErrors: errors
        }
      }
    );
  }
}

module.exports = ValidationError;
