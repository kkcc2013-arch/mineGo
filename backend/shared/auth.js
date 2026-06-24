// shared/auth.js - 认证模块（已集成统一错误处理和 KMS）
'use strict';

const jwt = require('jsonwebtoken');
const AuthenticationError = require('./errors/AuthenticationError');
const { asyncHandler } = require('./middleware/errorHandler');
const logger = require('./logger');

// KMS 支持（可选）
let kms = null;
let kmsEnabled = process.env.KMS_ENABLED === 'true';

/**
 * 初始化 KMS
 */
async function initKMS() {
  if (!kmsEnabled) return false;
  
  try {
    kms = require('./kms');
    logger.info('[Auth] KMS initialized successfully');
    return true;
  } catch (error) {
    logger.warn('[Auth] KMS not available, using environment variables:', error.message);
    kmsEnabled = false;
    return false;
  }
}

// 密钥缓存
let accessSecretCache = null;
let refreshSecretCache = null;
let secretCacheTime = 0;
const SECRET_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

/**
 * 获取访问密钥（优先 KMS）
 */
async function getAccessSecret() {
  // 优先使用 KMS
  if (kmsEnabled && kms) {
    const now = Date.now();
    if (accessSecretCache && (now - secretCacheTime) < SECRET_CACHE_TTL) {
      return accessSecretCache;
    }
    
    try {
      accessSecretCache = await kms.getKey('jwt-access-secret');
      secretCacheTime = now;
      return accessSecretCache;
    } catch (error) {
      logger.warn('[Auth] Failed to get access secret from KMS:', error.message);
      // 降级到环境变量
    }
  }
  
  // 降级到环境变量
  return process.env.JWT_ACCESS_SECRET || 'pmg-access-secret-change-in-prod';
}

/**
 * 获取刷新密钥（优先 KMS）
 */
async function getRefreshSecret() {
  // 优先使用 KMS
  if (kmsEnabled && kms) {
    const now = Date.now();
    if (refreshSecretCache && (now - secretCacheTime) < SECRET_CACHE_TTL) {
      return refreshSecretCache;
    }
    
    try {
      refreshSecretCache = await kms.getKey('jwt-refresh-secret');
      secretCacheTime = now;
      return refreshSecretCache;
    } catch (error) {
      logger.warn('[Auth] Failed to get refresh secret from KMS:', error.message);
      // 降级到环境变量
    }
  }
  
  // 降级到环境变量
  return process.env.JWT_REFRESH_SECRET || 'pmg-refresh-secret-change-in-prod';
}

const ACCESS_SECRET_ENV  = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET_ENV = process.env.JWT_REFRESH_SECRET;
const ACCESS_TTL  = process.env.JWT_ACCESS_TTL  || '24h';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '30d';

// Fail-fast: refuse to start in production with missing JWT secrets (if KMS is not enabled)
if (process.env.NODE_ENV === 'production' && !kmsEnabled) {
  if (!ACCESS_SECRET_ENV)  throw new Error('FATAL: JWT_ACCESS_SECRET must be set in production');
  if (!REFRESH_SECRET_ENV) throw new Error('FATAL: JWT_REFRESH_SECRET must be set in production');
}

// Development fallback (never reached in production due to fail-fast above)
const ACCESS_SECRET  = ACCESS_SECRET_ENV  || 'pmg-access-secret-change-in-prod';
const REFRESH_SECRET = REFRESH_SECRET_ENV || 'pmg-refresh-secret-change-in-prod';

/**
 * 签发访问令牌（支持 KMS）
 */
async function signAccessAsync(payload) {
  const secret = await getAccessSecret();
  return jwt.sign(payload, secret, { expiresIn: ACCESS_TTL, algorithm: 'HS256' });
}

/**
 * 签发访问令牌（同步版本，向后兼容）
 */
function signAccess(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL, algorithm: 'HS256' });
}

/**
 * 签发刷新令牌（支持 KMS）
 */
async function signRefreshAsync(payload) {
  const secret = await getRefreshSecret();
  return jwt.sign(payload, secret, { expiresIn: REFRESH_TTL, algorithm: 'HS256' });
}

/**
 * 签发刷新令牌（同步版本，向后兼容）
 */
function signRefresh(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL, algorithm: 'HS256' });
}

/**
 * 验证访问令牌（支持 KMS）
 */
async function verifyAccessAsync(token) {
  const secret = await getAccessSecret();
  return jwt.verify(token, secret);
}

/**
 * 验证访问令牌（同步版本，向后兼容）
 */
function verifyAccess(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

/**
 * 验证刷新令牌（支持 KMS）
 */
async function verifyRefreshAsync(token) {
  const secret = await getRefreshSecret();
  return jwt.verify(token, secret);
}

/**
 * 验证刷新令牌（同步版本，向后兼容）
 */
function verifyRefresh(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

/**
 * 认证中间件
 *
 * 验证 JWT 访问令牌，将用户信息注入 req.user
 */
function requireAuth(req, res, next) {
  const header = req.headers['authorization'];

  if (!header || !header.startsWith('Bearer ')) {
    return next(AuthenticationError.missingAuthHeader());
  }

  const token = header.slice(7);

  try {
    const payload = verifyAccess(token);
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return next(AuthenticationError.tokenExpired({ expiredAt: err.expiredAt }));
    }
    if (err.name === 'JsonWebTokenError') {
      return next(AuthenticationError.invalidToken({ reason: err.message }));
    }
    return next(AuthenticationError.invalidToken());
  }
}

/**
 * 可选认证中间件
 *
 * 如果令牌有效则注入用户信息，无效则继续（不报错）
 */
function optionalAuth(req, res, next) {
  const header = req.headers['authorization'];

  if (!header || !header.startsWith('Bearer ')) {
    return next();
  }

  const token = header.slice(7);

  try {
    const payload = verifyAccess(token);
    req.user = payload;
  } catch (err) {
    // 忽略错误，继续执行
  }

  next();
}

/**
 * 权限检查中间件
 *
 * @param {string|string[]} permissions 所需权限
 */
function requirePermissions(permissions) {
  const required = Array.isArray(permissions) ? permissions : [permissions];

  return (req, res, next) => {
    if (!req.user) {
      return next(AuthenticationError.missingAuthHeader());
    }

    const userPermissions = req.user.permissions || [];
    const hasPermission = required.some(p => userPermissions.includes(p));

    if (!hasPermission) {
      return next(AuthenticationError.insufficientPermissions(required.join(',')));
    }

    next();
  };
}

/**
 * 角色检查中间件
 *
 * @param {string|string[]} roles 所需角色
 */
function requireRoles(roles) {
  const required = Array.isArray(roles) ? roles : [roles];

  return (req, res, next) => {
    if (!req.user) {
      return next(AuthenticationError.missingAuthHeader());
    }

    const userRoles = req.user.roles || [];
    const hasRole = required.some(r => userRoles.includes(r));

    if (!hasRole) {
      return next(AuthenticationError.insufficientPermissions(`role:${required.join(',')}`));
    }

    next();
  };
}

/**
 * 管理员检查中间件
 */
function requireAdmin(req, res, next) {
  return requireRoles(['admin'])(req, res, next);
}

// ============================================================
// 兼容旧版本的导出（将逐步废弃）
// ============================================================

/**
 * @deprecated 使用 ./errors 模块中的错误类
 */
class AppError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * @deprecated 使用 res.success() 方法或 ResponseFormatter
 */
function successResp(data, message = 'ok') {
  return {
    success: true,
    code: 0,
    message,
    data,
    timestamp: new Date().toISOString()
  };
}

/**
 * @deprecated 使用 next(error) 传递错误给错误处理中间件
 */
function errorResp(code, message, details = {}) {
  return {
    success: false,
    code,
    message,
    details,
    timestamp: new Date().toISOString()
  };
}

/**
 * @deprecated 使用 ./middleware/errorHandler 中的 errorHandlerMiddleware
 */
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.httpStatus).json(errorResp(err.code, err.message));
  }
  if (err instanceof AuthenticationError) {
    return res.status(err.statusCode).json(err.toJSON(req.requestId));
  }
  console.error('[ERROR]', err);
  res.status(500).json(errorResp('GEN-004', 'Internal server error'));
}

module.exports = {
  // 核心功能（同步版本，向后兼容）
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  
  // 异步版本（推荐，支持 KMS）
  signAccessAsync,
  signRefreshAsync,
  verifyAccessAsync,
  verifyRefreshAsync,
  
  // KMS 初始化
  initKMS,
  
  // 中间件
  requireAuth,
  optionalAuth,
  requirePermissions,
  requireRoles,
  requireAdmin,

  // 兼容旧版本（将逐步废弃）
  AppError,
  successResp,
  errorResp,
  errorHandler,
  asyncHandler
};
