'use strict';
/**
 * 安全响应头中间件
 * REQ-00111: API 安全响应头与 CSP 强化系统
 */

const { createLogger } = require('./logger');
const { generateCSPHeader, selectCSPPolicy } = require('./cspConfig');

const logger = createLogger('security-headers');

/**
 * API 安全响应头中间件
 */
function apiSecurityHeaders(req, res, next) {
  // 基础安全头
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // HSTS (HTTP Strict Transport Security)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload');
  }

  // 禁用缓存（API 响应）
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  next();
}

/**
 * 前端页面安全响应头中间件
 */
function frontendSecurityHeaders(req, res, next) {
  // 基础安全头
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Referrer Policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions Policy（权限策略）
  res.setHeader('Permissions-Policy',
    'geolocation=(self), ' +
    'camera=(), ' +
    'microphone=(), ' +
    'payment=(self), ' +
    'usb=(), ' +
    'magnetometer=(), ' +
    'gyroscope=()'
  );

  // HSTS
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload');
  }

  next();
}

/**
 * 敏感 API 额外安全响应头中间件
 * 用于支付、用户管理等敏感接口
 */
function sensitiveSecurityHeaders(req, res, next) {
  // 跨域资源策略
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  // 严格缓存控制
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  next();
}

/**
 * CSP (Content Security Policy) 中间件
 */
function cspHeaders(req, res, next) {
  const policy = selectCSPPolicy(req);
  const cspValue = generateCSPHeader(policy);

  if (policy.reportOnly) {
    res.setHeader('Content-Security-Policy-Report-Only', cspValue);
  } else {
    res.setHeader('Content-Security-Policy', cspValue);
  }

  next();
}

/**
 * Origin 验证中间件（用于敏感 API）
 */
function verifyOrigin(allowedOrigins = []) {
  const allowedSet = new Set(allowedOrigins);

  // 从环境变量获取允许的 origins
  if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(',').forEach(o => allowedSet.add(o.trim()));
  }

  // 默认允许的 origins
  allowedSet.add('https://minego.com');
  allowedSet.add('https://www.minego.com');
  allowedSet.add('https://game.minego.com');
  allowedSet.add('https://admin.minego.com');

  return (req, res, next) => {
    const origin = req.headers['origin'];
    const referer = req.headers['referer'];

    // 如果没有 origin 和 referer，可能是直接访问或同源请求
    if (!origin && !referer) {
      // 对于敏感 API，要求必须有 origin
      return res.status(403).json({
        code: 1045,
        message: '缺少 Origin 头',
        error: 'ORIGIN_MISSING'
      });
    }

    // 验证 origin
    if (origin && !allowedSet.has(origin)) {
      logger.warn('Origin not allowed', {
        origin,
        allowedOrigins: Array.from(allowedSet),
        path: req.path,
        ip: req.ip
      });

      return res.status(403).json({
        code: 1046,
        message: 'Origin 不被允许',
        error: 'ORIGIN_NOT_ALLOWED'
      });
    }

    // 如果没有 origin，验证 referer
    if (!origin && referer) {
      try {
        const refererUrl = new URL(referer);
        const refererOrigin = refererUrl.origin;

        if (!allowedSet.has(refererOrigin)) {
          logger.warn('Referer origin not allowed', {
            referer,
            refererOrigin,
            path: req.path,
            ip: req.ip
          });

          return res.status(403).json({
            code: 1047,
            message: 'Referer Origin 不被允许',
            error: 'REFERER_NOT_ALLOWED'
          });
        }
      } catch (e) {
        return res.status(403).json({
          code: 1048,
          message: 'Referer 格式无效',
          error: 'REFERER_INVALID'
        });
      }
    }

    next();
  };
}

/**
 * 组合安全头中间件
 */
function createSecurityMiddleware(options = {}) {
  const {
    enableCSRF = true,
    enableCSP = true,
    enableOriginCheck = false,
    isSensitive = false,
    allowedOrigins = []
  } = options;

  const middlewares = [];

  // API 安全头
  middlewares.push(apiSecurityHeaders);

  // 敏感 API 额外安全头
  if (isSensitive) {
    middlewares.push(sensitiveSecurityHeaders);
  }

  // Origin 验证
  if (enableOriginCheck) {
    middlewares.push(verifyOrigin(allowedOrigins));
  }

  // CSP
  if (enableCSP) {
    middlewares.push(cspHeaders);
  }

  return middlewares;
}

module.exports = {
  apiSecurityHeaders,
  frontendSecurityHeaders,
  sensitiveSecurityHeaders,
  cspHeaders,
  verifyOrigin,
  createSecurityMiddleware
};
