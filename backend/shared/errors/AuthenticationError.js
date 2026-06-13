// backend/shared/errors/AuthenticationError.js - 认证授权错误
'use strict';

const BaseError = require('./BaseError');
const ERROR_CODES = require('./errorCodes');

/**
 * 认证授权错误
 * 
 * 用于身份验证和权限校验失败的场景
 */
class AuthenticationError extends BaseError {
  /**
   * @param {string} code 错误码
   * @param {string} message 错误消息
   * @param {Object} options 额外选项
   */
  constructor(code, message, options = {}) {
    super(code, message, {
      statusCode: options.statusCode || 401,
      isOperational: true,
      ...options
    });
    
    this.name = 'AuthenticationError';
  }
  
  get category() {
    return 'authentication';
  }
  
  get severity() {
    return 'warning';
  }
  
  /**
   * 无效令牌
   */
  static invalidToken(details = {}) {
    return new AuthenticationError(
      ERROR_CODES.AUTH_INVALID_TOKEN || 'AUTH-001',
      'Invalid access token',
      { details, statusCode: 401 }
    );
  }
  
  /**
   * 令牌过期
   */
  static tokenExpired(details = {}) {
    return new AuthenticationError(
      ERROR_CODES.AUTH_TOKEN_EXPIRED || 'AUTH-002',
      'Access token expired',
      { details, statusCode: 401 }
    );
  }
  
  /**
   * 缺少认证头
   */
  static missingAuthHeader() {
    return new AuthenticationError(
      ERROR_CODES.AUTH_MISSING_HEADER || 'AUTH-003',
      'Missing authorization header',
      { statusCode: 401 }
    );
  }
  
  /**
   * 权限不足
   */
  static insufficientPermissions(requiredPermission = null) {
    return new AuthenticationError(
      ERROR_CODES.AUTH_FORBIDDEN || 'AUTH-004',
      'Insufficient permissions',
      {
        statusCode: 403,
        details: requiredPermission ? { requiredPermission } : {}
      }
    );
  }
  
  /**
   * 用户名或密码错误
   */
  static invalidCredentials() {
    return new AuthenticationError(
      ERROR_CODES.AUTH_INVALID_CREDENTIALS || 'AUTH-005',
      'Invalid username or password',
      { statusCode: 401 }
    );
  }
  
  /**
   * 账户已被禁用
   */
  static accountDisabled(reason = null) {
    return new AuthenticationError(
      ERROR_CODES.AUTH_ACCOUNT_DISABLED || 'AUTH-006',
      'Account has been disabled',
      {
        statusCode: 403,
        details: reason ? { reason } : {}
      }
    );
  }
}

module.exports = AuthenticationError;
