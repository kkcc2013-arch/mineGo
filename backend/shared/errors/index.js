// backend/shared/errors/index.js - 统一错误处理模块入口
'use strict';

/**
 * 统一错误处理系统
 * 
 * 提供标准化的错误分类、错误码管理和响应格式化
 */

const BaseError = require('./BaseError');
const ValidationError = require('./ValidationError');
const BusinessError = require('./BusinessError');
const DatabaseError = require('./DatabaseError');
const ExternalServiceError = require('./ExternalServiceError');
const AuthenticationError = require('./AuthenticationError');
const RateLimitError = require('./RateLimitError');
const NotFoundError = require('./NotFoundError');

const ERROR_CODES = require('./errorCodes');

module.exports = {
  // 错误基类
  BaseError,
  
  // 具体错误类
  ValidationError,
  BusinessError,
  DatabaseError,
  ExternalServiceError,
  AuthenticationError,
  RateLimitError,
  NotFoundError,
  
  // 错误码
  ERROR_CODES,
  
  // 便捷创建函数
  ...require('./factory'),
};
