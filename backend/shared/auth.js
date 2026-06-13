// shared/auth.js - 认证模块（已集成统一错误处理）
'use strict';

const jwt = require('jsonwebtoken');
const AuthenticationError = require('./errors/AuthenticationError');
const { asyncHandler } = require('./middleware/errorHandler');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'pmg-access-secret-change-in-prod';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'pmg-refresh-secret-change-in-prod';
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '24h';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '30d';

/**
 * 签发访问令牌
 */
function signAccess(payload) {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_TTL, algorithm: 'HS256' });
}

/**
 * 签发刷新令牌
 */
function signRefresh(payload) {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_TTL, algorithm: 'HS256' });
}

/**
 * 验证访问令牌
 */
function verifyAccess(token) {
  return jwt.verify(token, ACCESS_SECRET);
}

/**
 * 验证刷新令牌
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
  // 核心功能
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
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
