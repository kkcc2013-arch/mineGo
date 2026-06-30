/**
 * 统一错误处理中间件
 * 
 * 提供标准化的错误响应格式：
 * { success: false, error: { code, message, details, i18nKey, docUrl }, meta: {...} }
 */

'use strict';

const logger = require('../logger');
const ErrorCodes = require('../errors/ErrorCodes');
const { v4: uuidv4 } = require('uuid');

/**
 * 应用错误类
 */
class AppError extends Error {
  /**
   * @param {string|Object} errorCode - 错误码或错误定义
   * @param {Object} details - 错误详情
   */
  constructor(errorCode, details = null) {
    const errorDef = typeof errorCode === 'string' 
      ? ErrorCodes[errorCode] 
      : errorCode;
    
    if (!errorDef) {
      throw new Error(`Unknown error code: ${errorCode}`);
    }

    super(errorDef.message);
    this.name = 'AppError';
    this.code = errorDef.code;
    this.httpStatus = errorDef.httpStatus;
    this.i18nKey = errorDef.i18nKey;
    this.details = details;
    this.isOperational = true;
  }

  /**
   * 转换为 JSON 格式
   */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      i18nKey: this.i18nKey
    };
  }
}

/**
 * 构建错误响应
 */
function _buildErrorResponse(requestId, errorDef, details = null) {
  return {
    success: false,
    error: {
      code: errorDef.code,
      message: errorDef.message,
      details,
      i18nKey: errorDef.i18nKey,
      docUrl: `https://docs.minego.game/errors/${errorDef.code}`
    },
    meta: {
      requestId,
      timestamp: new Date().toISOString()
    }
  };
}

/**
 * 统一错误处理中间件
 */
function errorHandler(err, req, res, next) {
  // 如果响应已发送，交给默认错误处理
  if (res.headersSent) {
    return next(err);
  }

  const requestId = res.locals?.requestId || uuidv4();

  // AppError - 业务错误
  if (err instanceof AppError) {
    logger.warn({
      requestId,
      code: err.code,
      message: err.message,
      details: err.details,
      path: req.path,
      method: req.method
    }, 'Business error');

    const response = _buildErrorResponse(requestId, {
      code: err.code,
      httpStatus: err.httpStatus,
      message: err.message,
      i18nKey: err.i18nKey
    }, err.details);

    return res.status(err.httpStatus).json(response);
  }

  // Joi 验证错误
  if (err.name === 'ValidationError' && err.isJoi) {
    logger.warn({
      requestId,
      errors: err.details,
      path: req.path
    }, 'Validation error');

    const details = err.details.map(d => ({
      field: d.path.join('.'),
      message: d.message,
      type: d.type
    }));

    const response = _buildErrorResponse(requestId, ErrorCodes.VALIDATION_ERROR, details);
    return res.status(400).json(response);
  }

  // express-validator 错误
  if (err.name === 'ArgumentError' || err.array) {
    const errors = err.array ? err.array() : err.errors;
    logger.warn({
      requestId,
      errors,
      path: req.path
    }, 'Validation error');

    const response = _buildErrorResponse(requestId, ErrorCodes.VALIDATION_ERROR, errors);
    return res.status(400).json(response);
  }

  // JWT 错误
  if (err.name === 'JsonWebTokenError') {
    const response = _buildErrorResponse(requestId, ErrorCodes.USER_AUTH_INVALID_TOKEN);
    return res.status(401).json(response);
  }

  if (err.name === 'TokenExpiredError') {
    const response = _buildErrorResponse(requestId, ErrorCodes.USER_AUTH_TOKEN_EXPIRED);
    return res.status(401).json(response);
  }

  if (err.name === 'NotBeforeError') {
    const response = _buildErrorResponse(requestId, ErrorCodes.USER_AUTH_INVALID_TOKEN);
    return res.status(401).json(response);
  }

  // PostgreSQL 错误
  if (err.code === '23505') { // Unique violation
    logger.warn({
      requestId,
      constraint: err.constraint,
      path: req.path
    }, 'Duplicate key error');

    const response = _buildErrorResponse(requestId, ErrorCodes.RESOURCE_ALREADY_EXISTS, {
      constraint: err.constraint
    });
    return res.status(409).json(response);
  }

  if (err.code === '23503') { // Foreign key violation
    logger.warn({
      requestId,
      constraint: err.constraint,
      path: req.path
    }, 'Foreign key error');

    const response = _buildErrorResponse(requestId, ErrorCodes.RESOURCE_NOT_FOUND, {
      constraint: err.constraint
    });
    return res.status(404).json(response);
  }

  if (err.code === '23514') { // Check violation
    logger.warn({
      requestId,
      constraint: err.constraint,
      path: req.path
    }, 'Check constraint error');

    const response = _buildErrorResponse(requestId, ErrorCodes.VALIDATION_ERROR, {
      constraint: err.constraint
    });
    return res.status(400).json(response);
  }

  // Redis 错误
  if (err.code === 'ECONNREFUSED' && err.port === 6379) {
    logger.error({
      requestId,
      error: err.message,
      path: req.path
    }, 'Redis connection error');

    const response = _buildErrorResponse(requestId, ErrorCodes.SYSTEM_REDIS_ERROR);
    return res.status(500).json(response);
  }

  // 超时错误
  if (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT') {
    logger.error({
      requestId,
      error: err.message,
      path: req.path
    }, 'Request timeout');

    const response = _buildErrorResponse(requestId, ErrorCodes.SYSTEM_TIMEOUT);
    return res.status(504).json(response);
  }

  // 未知错误 - 500
  logger.error({
    requestId,
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body
  }, 'Unexpected error');

  const response = _buildErrorResponse(requestId, ErrorCodes.SYSTEM_INTERNAL_ERROR);
  return res.status(500).json(response);
}

/**
 * 404 处理
 */
function notFoundHandler(req, res) {
  const requestId = res.locals?.requestId || uuidv4();

  const response = _buildErrorResponse(requestId, ErrorCodes.RESOURCE_NOT_FOUND, {
    method: req.method,
    path: req.path
  });

  res.status(404).json(response);
}

/**
 * 异步路由包装器
 * 自动捕获 Promise 错误并传递给错误处理中间件
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 创建错误快捷方法
 */
function createError(errorCode, details = null) {
  return new AppError(errorCode, details);
}

module.exports = {
  AppError,
  errorHandler,
  notFoundHandler,
  asyncHandler,
  createError
};
