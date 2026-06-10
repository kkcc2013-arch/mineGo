// backend/shared/errorHandler.js - 统一错误处理中间件
'use strict';

const { ERROR_CODES, getErrorConfig } = require('./errorCodes');
const { createLogger } = require('./logger');
const promClient = require('prom-client');

const logger = createLogger('error-handler');

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  errorsTotal: new promClient.Counter({
    name: 'minego_errors_total',
    help: 'Total API errors by code and service',
    labelNames: ['error_code', 'service', 'category', 'severity'],
  }),

  errorResponseTime: new promClient.Histogram({
    name: 'minego_error_response_time_seconds',
    help: 'Error handling response time',
    labelNames: ['error_code'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1],
  }),
};

// ============================================================
// 应用错误类
// ============================================================

class AppError extends Error {
  constructor(code, details = {}, options = {}) {
    super();
    
    this.code = code;
    this.details = details;
    this.options = options;
    
    const config = getErrorConfig(code);
    if (!config) {
      // 未知错误码，使用通用错误
      this.config = {
        code: 'G1-003-999',
        httpStatus: 500,
        message: 'Internal server error',
        messageKey: 'error.system.internal_error',
        category: 'system',
        severity: 'critical',
        retryable: false,
        troubleshooting: '系统错误，请联系管理员。',
      };
      this.isUnknown = true;
      logger.warn(`Unknown error code: ${code}, falling back to generic error`);
    } else {
      this.config = config;
    }
    
    this.httpStatus = options.httpStatus || this.config.httpStatus;
    this.message = options.message || this.config.message;
    this.severity = options.severity || this.config.severity;
    this.retryable = options.retryable !== undefined ? options.retryable : this.config.retryable;
    
    // 维护原始错误堆栈
    if (options.cause) {
      this.cause = options.cause;
      this.stack = options.cause.stack;
    }
    
    Error.captureStackTrace(this, this.constructor);
  }
  
  /**
   * 转换为标准错误响应格式
   */
  toJSON(requestId) {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        messageKey: this.config.messageKey,
        details: this.details,
        requestId: requestId || null,
        docUrl: `${process.env.API_DOCS_URL || 'https://docs.minego.app'}/errors/${this.code}`,
        retryable: this.retryable,
        severity: this.severity,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

// ============================================================
// 便捷错误创建函数
// ============================================================

const Errors = {
  // 认证错误
  invalidToken: (details = {}) => new AppError('G1-001-001', details),
  tokenExpired: (details = {}) => new AppError('G1-001-002', details),
  missingAuthHeader: (details = {}) => new AppError('G1-001-003', details),
  insufficientPermissions: (details = {}) => new AppError('G1-001-004', details),
  
  // 限流错误
  rateLimitExceeded: (retryAfter, details = {}) => 
    new AppError('G1-002-001', { retryAfter, ...details }, { 
      troubleshooting: `请求过于频繁，请等待 ${retryAfter} 秒后重试。` 
    }),
  
  // 服务错误
  serviceUnavailable: (details = {}) => new AppError('G1-002-002', details),
  invalidRequestFormat: (details = {}) => new AppError('G1-003-001', details),
  
  // 用户错误
  emailAlreadyRegistered: (details = {}) => new AppError('U2-001-001', details),
  invalidEmail: (details = {}) => new AppError('U2-001-002', details),
  weakPassword: (details = {}) => new AppError('U2-001-003', details),
  invalidCredentials: (details = {}) => new AppError('U2-001-004', details),
  accountBanned: (details = {}) => new AppError('U2-001-005', details),
  accountSuspended: (suspendedUntil, details = {}) => 
    new AppError('U2-001-006', { suspendedUntil, ...details }),
  userNotFound: (details = {}) => new AppError('U2-002-001', details),
  usernameTaken: (details = {}) => new AppError('U2-002-002', details),
  invalidUsername: (details = {}) => new AppError('U2-002-003', details),
  
  // 好友错误
  friendNotFound: (details = {}) => new AppError('U2-003-001', details),
  alreadyFriends: (details = {}) => new AppError('U2-003-002', details),
  friendRequestExists: (details = {}) => new AppError('U2-003-003', details),
  friendListFull: (maxFriends = 200, details = {}) => 
    new AppError('U2-003-004', { maxFriends, ...details }),
  
  // 位置错误
  invalidCoordinates: (details = {}) => new AppError('L3-001-001', details),
  gpsSpoofingDetected: (details = {}) => new AppError('L3-001-002', details),
  speedExceeded: (maxSpeed, details = {}) => 
    new AppError('L3-001-003', { maxSpeed, ...details }),
  noNearbyPokemon: (details = {}) => new AppError('L3-001-004', details),
  
  // 精灵错误
  pokemonNotFound: (details = {}) => new AppError('P4-001-001', details),
  pokemonNotOwner: (details = {}) => new AppError('P4-001-002', details),
  pokemonAlreadyTransferred: (details = {}) => new AppError('P4-001-003', details),
  pokemonIsFavorite: (details = {}) => new AppError('P4-001-004', details),
  pokemonStorageFull: (maxPokemon = 500, details = {}) => 
    new AppError('P4-001-005', { maxPokemon, ...details }),
  moveNotFound: (details = {}) => new AppError('P4-002-001', details),
  cannotLearnMove: (details = {}) => new AppError('P4-002-002', details),
  
  // 捕捉错误
  pokemonEscaped: (details = {}) => new AppError('C5-001-001', details),
  noPokeballs: (details = {}) => new AppError('C5-001-002', details),
  pokemonOutOfRange: (maxDistance = 100, details = {}) => 
    new AppError('C5-001-003', { maxDistance, ...details }),
  catchBlockedAntiCheat: (details = {}) => new AppError('C5-001-004', details),
  invalidCatchAttempt: (details = {}) => new AppError('C5-001-005', details),
  
  // 道馆错误
  gymNotFound: (details = {}) => new AppError('G6-001-001', details),
  gymTooFar: (maxDistance = 100, details = {}) => 
    new AppError('G6-001-002', { maxDistance, ...details }),
  gymSameTeam: (details = {}) => new AppError('G6-001-003', details),
  noEligiblePokemon: (details = {}) => new AppError('G6-001-004', details),
  gymBattleCooldown: (cooldownMinutes, details = {}) => 
    new AppError('G6-001-005', { cooldownMinutes, ...details }),
  raidNotFound: (details = {}) => new AppError('G6-002-001', details),
  raidNotActive: (details = {}) => new AppError('G6-002-002', details),
  raidLobbyFull: (details = {}) => new AppError('G6-002-003', details),
  
  // 交易错误
  tradeNotFound: (details = {}) => new AppError('S7-001-001', details),
  tradeTooFar: (maxDistance = 100, details = {}) => 
    new AppError('S7-001-002', { maxDistance, ...details }),
  insufficientStardust: (requiredStardust, details = {}) => 
    new AppError('S7-001-003', { requiredStardust, ...details }),
  tradeAlreadyCompleted: (details = {}) => new AppError('S7-001-004', details),
  
  // 公会错误
  guildNotFound: (details = {}) => new AppError('S7-002-001', details),
  alreadyInGuild: (details = {}) => new AppError('S7-002-002', details),
  guildFull: (details = {}) => new AppError('S7-002-003', details),
  
  // 奖励错误
  rewardNotFound: (details = {}) => new AppError('R8-001-001', details),
  rewardAlreadyClaimed: (details = {}) => new AppError('R8-001-002', details),
  rewardNotAvailable: (availableAt, details = {}) => 
    new AppError('R8-001-003', { availableAt, ...details }),
  itemNotFound: (details = {}) => new AppError('R8-002-001', details),
  inventoryFull: (maxItems = 500, details = {}) => 
    new AppError('R8-002-002', { maxItems, ...details }),
  insufficientItems: (required, current, details = {}) => 
    new AppError('R8-002-003', { required, current, ...details }),
  
  // 支付错误
  orderNotFound: (details = {}) => new AppError('P9-001-001', details),
  orderAlreadyPaid: (details = {}) => new AppError('P9-001-002', details),
  orderExpired: (details = {}) => new AppError('P9-001-003', details),
  invalidPaymentAmount: (details = {}) => new AppError('P9-001-004', details),
  paymentFailed: (reason, details = {}) => 
    new AppError('P9-001-005', { reason, ...details }),
  duplicateOrder: (details = {}) => new AppError('P9-001-006', details),
  productNotFound: (details = {}) => new AppError('P9-002-001', details),
  productOutOfStock: (details = {}) => new AppError('P9-002-002', details),
  
  // 通用错误
  notFound: (resource, details = {}) => {
    const error = new AppError('G1-003-001', { resource, ...details }, { 
      httpStatus: 404,
      message: `${resource} not found`,
      messageKey: `error.${resource.toLowerCase()}.not_found`,
    });
    return error;
  },
  
  validationError: (field, message, details = {}) => {
    const error = new AppError('G1-003-001', { field, message, ...details }, {
      httpStatus: 400,
      message: `Validation error: ${message}`,
      messageKey: 'error.validation.failed',
    });
    return error;
  },
  
  internalError: (details = {}, cause = null) => {
    return new AppError('G1-003-999', details, {
      cause,
      httpStatus: 500,
      message: 'Internal server error',
      messageKey: 'error.system.internal_error',
      severity: 'critical',
    });
  },
};

// ============================================================
// 错误处理中间件
// ============================================================

/**
 * Express 错误处理中间件
 */
function errorHandlerMiddleware(err, req, res, next) {
  const startTime = Date.now();
  
  // 生成请求 ID
  const requestId = req.headers['x-request-id'] || 
                    req.id || 
                    `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  // 判断错误类型
  let appError;
  
  if (err instanceof AppError) {
    appError = err;
  } else if (err.name === 'ValidationError') {
    // Joi 验证错误
    appError = Errors.validationError(
      err.details?.[0]?.path?.join('.') || 'unknown',
      err.details?.[0]?.message || err.message,
      { validationErrors: err.details }
    );
  } else if (err.name === 'UnauthorizedError') {
    // JWT 认证错误
    appError = Errors.invalidToken({ jwtError: err.message });
  } else if (err.code === 'LIMIT_FILE_SIZE') {
    // Multer 文件大小限制
    appError = Errors.invalidRequestFormat({ 
      message: 'File size exceeds limit',
      maxSize: err.limit 
    });
  } else if (err.code === 'EBADCSRFTOKEN') {
    // CSRF 令牌错误
    appError = Errors.invalidToken({ csrf: true });
  } else if (err.statusCode || err.status) {
    // Express 内置错误
    const status = err.statusCode || err.status;
    appError = new AppError('G1-003-001', { 
      expressError: err.message 
    }, { 
      httpStatus: status,
      message: err.message 
    });
  } else {
    // 未知错误
    appError = Errors.internalError(
      { 
        originalError: err.message,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
      },
      err
    );
  }
  
  // 记录日志
  const logData = {
    code: appError.code,
    message: appError.message,
    requestId,
    method: req.method,
    url: req.originalUrl,
    userId: req.user?.id || 'anonymous',
    ip: req.ip,
    severity: appError.severity,
    details: appError.details,
  };
  
  if (appError.severity === 'critical') {
    logger.error('API Error:', logData);
  } else if (appError.severity === 'warning') {
    logger.warn('API Error:', logData);
  } else {
    logger.info('API Error:', logData);
  }
  
  // 记录 Prometheus 指标
  const responseTime = (Date.now() - startTime) / 1000;
  metrics.errorsTotal.inc({
    error_code: appError.code,
    service: process.env.SERVICE_NAME || 'unknown',
    category: appError.config.category,
    severity: appError.severity,
  });
  metrics.errorResponseTime.observe({ error_code: appError.code }, responseTime);
  
  // 发送响应
  const response = appError.toJSON(requestId);
  
  // 在开发环境添加堆栈信息
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    response.error.stack = err.stack;
  }
  
  res.status(appError.httpStatus).json(response);
}

// ============================================================
// 404 处理中间件
// ============================================================

function notFoundHandler(req, res, next) {
  const error = Errors.notFound('Resource', { 
    method: req.method,
    path: req.originalUrl,
  });
  next(error);
}

// ============================================================
// 异步路由包装器
// ============================================================

/**
 * 包装异步路由处理器，自动捕获错误
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ============================================================
// 请求 ID 中间件
// ============================================================

function requestIdMiddleware(req, res, next) {
  req.id = req.headers['x-request-id'] || 
           `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = {
  AppError,
  Errors,
  errorHandlerMiddleware,
  notFoundHandler,
  asyncHandler,
  requestIdMiddleware,
  metrics,
};
