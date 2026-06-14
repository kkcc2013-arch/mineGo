// shared/errorHandler.js - API 错误处理中间件
'use strict';

const { ERROR_CODES, getErrorDefinition, getErrorCodeName } = require('./errorCodes');
const { 
  getLocalizedErrorMessage, 
  getSupportedLanguages, 
  isLanguageSupported, 
  getDefaultLanguage 
} = require('./errorMessages');

/**
 * 应用错误类
 * 用于创建标准化的应用错误
 */
class AppError extends Error {
  /**
   * 创建应用错误
   * @param {string} errorCode - 错误码名称
   * @param {Object} params - 参数对象（用于消息插值）
   * @param {Object} details - 详细信息
   * @param {Error} cause - 原始错误（用于错误链）
   */
  constructor(errorCode, params = {}, details = null, cause = null) {
    super(errorCode);
    this.name = 'AppError';
    this.code = errorCode;
    this.params = params;
    this.details = details;
    this.cause = cause;
    
    const errorDef = getErrorDefinition(errorCode);
    this.httpStatus = errorDef.httpStatus;
    this.numericCode = errorDef.code;
    this.category = errorDef.category;
    
    // 捕获堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
    
    // 如果有原始错误，附加其堆栈
    if (cause && cause.stack) {
      this.stack += '\nCaused by: ' + cause.stack;
    }
  }
  
  /**
   * 转换为 JSON 格式
   * @param {string} language - 语言代码
   * @returns {Object} JSON 对象
   */
  toJSON(language = getDefaultLanguage()) {
    return {
      success: false,
      error: {
        code: this.numericCode,
        name: this.code,
        message: getLocalizedErrorMessage(this.code, language, this.params),
        details: this.details
      }
    };
  }
  
  /**
   * 创建一个带有额外参数的新错误
   * @param {Object} extraParams - 额外参数
   * @returns {AppError} 新的错误实例
   */
  withParams(extraParams) {
    return new AppError(
      this.code, 
      { ...this.params, ...extraParams }, 
      this.details, 
      this.cause
    );
  }
  
  /**
   * 创建一个带有详细信息的新错误
   * @param {Object} details - 详细信息
   * @returns {AppError} 新的错误实例
   */
  withDetails(details) {
    return new AppError(this.code, this.params, details, this.cause);
  }
}

/**
 * 预定义错误工厂方法
 */
const Errors = {
  // 通用错误
  unknown: (params, details) => new AppError('UNKNOWN_ERROR', params, details),
  invalidRequest: (params, details) => new AppError('INVALID_REQUEST', params, details),
  unauthorized: (params, details) => new AppError('UNAUTHORIZED', params, details),
  forbidden: (params, details) => new AppError('FORBIDDEN', params, details),
  notFound: (params, details) => new AppError('NOT_FOUND', params, details),
  rateLimited: (params, details) => new AppError('RATE_LIMITED', params, details),
  
  // 用户错误
  userNotFound: (params, details) => new AppError('USER_NOT_FOUND', params, details),
  userAlreadyExists: (params, details) => new AppError('USER_ALREADY_EXISTS', params, details),
  invalidCredentials: (params, details) => new AppError('INVALID_CREDENTIALS', params, details),
  accountSuspended: (params, details) => new AppError('ACCOUNT_SUSPENDED', params, details),
  
  // 精灵错误
  pokemonNotFound: (params, details) => new AppError('POKEMON_NOT_FOUND', params, details),
  insufficientResources: (params, details) => new AppError('INSUFFICIENT_RESOURCES', params, details),
  bagFull: (params, details) => new AppError('BAG_FULL', params, details),
  
  // 捕捉错误
  catchFailed: (params, details) => new AppError('CATCH_FAILED', params, details),
  catchCooldown: (params, details) => new AppError('CATCH_COOLDOWN', params, details),
  
  // 道馆错误
  gymNotFound: (params, details) => new AppError('GYM_NOT_FOUND', params, details),
  gymBattleFailed: (params, details) => new AppError('GYM_BATTLE_FAILED', params, details),
  
  // 支付错误
  paymentFailed: (params, details) => new AppError('PAYMENT_FAILED', params, details),
  insufficientBalance: (params, details) => new AppError('INSUFFICIENT_BALANCE', params, details),
  
  // 反作弊错误
  gpsSpoofingDetected: (params, details) => new AppError('GPS_SPOOFING_DETECTED', params, details),
  speedLimitExceeded: (params, details) => new AppError('SPEED_LIMIT_EXCEEDED', params, details)
};

/**
 * 获取用户语言偏好
 * 优先级：用户设置 > Accept-Language > 默认语言
 * @param {Object} req - Express 请求对象
 * @returns {string} 语言代码
 */
function getUserLanguage(req) {
  // 1. 查询参数中的语言（用于测试）
  if (req.query?.lang && isLanguageSupported(req.query.lang)) {
    return req.query.lang;
  }
  
  // 2. 用户设置的语言偏好
  if (req.user?.language && isLanguageSupported(req.user.language)) {
    return req.user.language;
  }
  
  // 3. Accept-Language 头
  const acceptLanguage = req.headers['accept-language'];
  if (acceptLanguage) {
    // 解析 Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
    const languages = acceptLanguage.split(',').map(lang => {
      const [code] = lang.trim().split(';');
      return code.trim();
    });
    
    // 匹配支持的语言
    for (const lang of languages) {
      // 精确匹配
      if (isLanguageSupported(lang)) {
        return lang;
      }
      
      // 前缀匹配（如 zh 匹配 zh-CN）
      const matched = getSupportedLanguages().find(s => 
        s.startsWith(lang) || lang.startsWith(s.split('-')[0])
      );
      if (matched) {
        return matched;
      }
    }
  }
  
  // 4. 默认语言
  return getDefaultLanguage();
}

/**
 * API 错误处理中间件
 * 自动根据用户的语言偏好返回本地化的错误消息
 */
function errorHandler(err, req, res, next) {
  // 如果响应已发送，跳过
  if (res.headersSent) {
    return next(err);
  }
  
  // 获取用户语言偏好
  const language = getUserLanguage(req);
  
  // 解析错误
  let errorCode, httpStatus, numericCode, params, details;
  
  if (err instanceof AppError) {
    // AppError 实例
    errorCode = err.code;
    httpStatus = err.httpStatus;
    numericCode = err.numericCode;
    params = err.params || {};
    details = err.details;
  } else if (err.name === 'ValidationError') {
    // Joi 验证错误
    errorCode = 'VALIDATION_ERROR';
    const errorDef = getErrorDefinition(errorCode);
    httpStatus = errorDef.httpStatus;
    numericCode = errorDef.code;
    params = { 
      field: err.details?.[0]?.path?.join('.') || 'unknown',
      details: err.message 
    };
    details = err.details;
  } else if (err.name === 'UnauthorizedError') {
    // JWT 认证错误
    errorCode = 'UNAUTHORIZED';
    const errorDef = getErrorDefinition(errorCode);
    httpStatus = errorDef.httpStatus;
    numericCode = errorDef.code;
    params = {};
    details = { jwtError: err.message };
  } else {
    // 通用错误
    errorCode = 'UNKNOWN_ERROR';
    const errorDef = getErrorDefinition(errorCode);
    httpStatus = errorDef.httpStatus;
    numericCode = errorDef.code;
    params = {};
    details = {
      originalError: err.message,
      stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined
    };
  }
  
  // 获取本地化错误消息
  const localizedMessage = getLocalizedErrorMessage(errorCode, language, params);
  
  // 记录错误日志
  const logger = req.app?.locals?.logger || console;
  logger.error({
    errorCode,
    numericCode,
    httpStatus,
    message: localizedMessage,
    language,
    path: req.path,
    method: req.method,
    userId: req.user?.id,
    ip: req.ip,
    details: process.env.NODE_ENV !== 'production' ? details : undefined
  });
  
  // Prometheus 指标（如果可用）
  if (req.app?.locals?.metrics?.incrementCounter) {
    req.app.locals.metrics.incrementCounter('api_errors_total', {
      error_code: errorCode,
      service: process.env.SERVICE_NAME || 'unknown',
      language
    });
  }
  
  // 构建响应
  const response = {
    success: false,
    error: {
      code: numericCode,
      name: errorCode,
      message: localizedMessage
    }
  };
  
  // 开发环境添加详细信息
  if (process.env.NODE_ENV !== 'production' && details) {
    response.error.details = details;
  }
  
  // 发送响应
  res.status(httpStatus).json(response);
}

/**
 * 404 处理中间件
 */
function notFoundHandler(req, res, next) {
  const language = getUserLanguage(req);
  const message = getLocalizedErrorMessage('NOT_FOUND', language);
  
  res.status(404).json({
    success: false,
    error: {
      code: 1004,
      name: 'NOT_FOUND',
      message
    }
  });
}

/**
 * 异步处理包装器
 * 用于包装异步路由处理器，自动捕获错误
 * @param {Function} fn - 异步函数
 * @returns {Function} 包装后的函数
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 从原生错误创建 AppError
 * @param {Error} err - 原生错误
 * @param {string} fallbackCode - 回退错误码
 * @returns {AppError} AppError 实例
 */
function fromError(err, fallbackCode = 'UNKNOWN_ERROR') {
  if (err instanceof AppError) {
    return err;
  }
  
  return new AppError(fallbackCode, {}, { 
    originalError: err.message 
  }, err);
}

module.exports = {
  AppError,
  Errors,
  errorHandler,
  notFoundHandler,
  asyncHandler,
  getUserLanguage,
  fromError
};
