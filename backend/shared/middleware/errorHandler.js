// backend/shared/middleware/errorHandler.js - 统一错误处理中间件
'use strict';

const { createLogger } = require('../logger');
const metrics = require('../metrics');
const BaseError = require('../errors/BaseError');
const ValidationError = require('../errors/ValidationError');
const AuthenticationError = require('../errors/AuthenticationError');
const RateLimitError = require('../errors/RateLimitError');
const ERROR_CODES = require('../errors/errorCodes');

const logger = createLogger('error-handler');

/**
 * 统一错误处理中间件
 */
function errorHandlerMiddleware(err, req, res, next) {
  const startTime = Date.now();
  
  // 生成或获取请求 ID
  const requestId = req.headers['x-request-id'] || 
                    req.id || 
                    `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // 判断错误类型并转换为标准格式
  let normalizedError;
  
  if (err instanceof BaseError) {
    normalizedError = err;
  } else if (err.name === 'ValidationError') {
    // Joi 或其他验证库错误
    normalizedError = ValidationError.fromJoiError(err);
  } else if (err.name === 'UnauthorizedError') {
    // express-jwt 错误
    normalizedError = AuthenticationError.invalidToken({ jwtError: err.message });
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    // Multer 文件大小限制
    normalizedError = new ValidationError('file', 'File size exceeds limit', {
      details: { maxSize: err.limit }
    });
  } else if (err.code === 'EBADCSRFTOKEN') {
    // CSRF 令牌错误
    normalizedError = AuthenticationError.invalidToken({ csrf: true });
  } else if (err.statusCode || err.status) {
    // Express 内置错误
    const status = err.statusCode || err.status;
    normalizedError = new BaseError(
      ERROR_CODES.VALIDATION_ERROR,
      err.message,
      { statusCode: status }
    );
  } else {
    // 未知错误
    normalizedError = new BaseError(
      ERROR_CODES.INTERNAL_ERROR,
      'Internal server error',
      {
        statusCode: 500,
        isOperational: false,
        details: process.env.NODE_ENV !== 'production' 
          ? { originalError: err.message, stack: err.stack }
          : {}
      }
    );
  }
  
  // 记录日志
  const logData = {
    code: normalizedError.code,
    message: normalizedError.message,
    requestId,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.sub || 'anonymous',
    ip: req.ip,
    category: normalizedError.category,
    severity: normalizedError.severity,
    details: normalizedError.details
  };
  
  if (normalizedError.statusCode >= 500) {
    logger.error('API Error:', logData);
    // 生产环境记录完整堆栈
    if (process.env.NODE_ENV === 'production') {
      logger.error('Stack trace:', err.stack);
    }
  } else if (normalizedError.statusCode >= 400) {
    logger.warn('Client error:', logData);
  } else {
    logger.info('Request handled:', logData);
  }
  
  // 记录 Prometheus 指标
  try {
    metrics.increment('errors_total', 1, {
      service: process.env.SERVICE_NAME || 'unknown',
      code: normalizedError.code,
      category: normalizedError.category || 'unknown',
      severity: normalizedError.severity || 'unknown'
    });
  } catch (metricError) {
    logger.warn('Failed to record metrics:', metricError.message);
  }
  
  // 构建响应
  const response = normalizedError.toJSON(requestId, req.originalUrl);
  
  // 添加 Retry-After 头（限流错误）
  if (normalizedError instanceof RateLimitError) {
    res.setHeader('Retry-After', normalizedError.retryAfter);
  }
  
  // 添加 X-Request-Id 头
  res.setHeader('X-Request-Id', requestId);
  
  // 发送响应
  res.status(normalizedError.statusCode).json(response);
}

/**
 * 404 处理中间件
 */
function notFoundHandler(req, res, next) {
  const { NotFoundError } = require('../errors');
  const error = new NotFoundError('Resource', req.originalUrl, {
    details: { method: req.method }
  });
  next(error);
}

/**
 * 异步路由包装器
 * 自动捕获异步错误并传递给错误处理中间件
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  errorHandlerMiddleware,
  notFoundHandler,
  asyncHandler
};
