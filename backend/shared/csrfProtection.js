'use strict';
/**
 * CSRF (Cross-Site Request Forgery) 保护中间件
 * REQ-00111: API 安全响应头与 CSP 强化系统
 */

const crypto = require('crypto');
const { createLogger } = require('./logger');

const logger = createLogger('csrf');

class CSRFProtection {
  constructor(options = {}) {
    this.cookieName = options.cookieName || 'XSRF-TOKEN';
    this.headerName = options.headerName || 'x-xsrf-token';
    this.sessionName = options.sessionName || 'csrfSecret';
    this.tokenLength = options.tokenLength || 32;

    this.cookieOptions = {
      httpOnly: false,  // 前端需要读取
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 86400,  // 24 小时
      ...options.cookieOptions
    };

    // 白名单路径（不需要 CSRF 保护）
    this.whitelistPaths = new Set(options.whitelistPaths || [
      '/api/v1/auth/login',
      '/api/v1/auth/register',
      '/api/v1/auth/refresh',
      '/api/v1/health',
      '/health',
      '/metrics'
    ]);

    // 安全方法（不需要 CSRF 保护）
    this.safeMethods = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);
  }

  /**
   * 生成 CSRF 令牌
   */
  generateToken() {
    return crypto.randomBytes(this.tokenLength).toString('base64url');
  }

  /**
   * 生成令牌签名（防止篡改）
   */
  signToken(token, secret) {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(token);
    return `${token}.${hmac.digest('base64url')}`;
  }

  /**
   * 验证令牌签名
   */
  verifyTokenSignature(signedToken, secret) {
    const parts = signedToken.split('.');
    if (parts.length !== 2) return { valid: false, reason: 'invalid_format' };

    const [token, signature] = parts;
    const expectedSignature = this.signToken(token, secret).split('.')[1];

    try {
      if (crypto.timingSafeEqual(
        Buffer.from(signature, 'base64url'),
        Buffer.from(expectedSignature, 'base64url')
      )) {
        return { valid: true, token };
      }
    } catch (e) {
      return { valid: false, reason: 'signature_mismatch' };
    }

    return { valid: false, reason: 'signature_mismatch' };
  }

  /**
   * 中间件：设置 CSRF Cookie 和令牌
   */
  setCSRFCookie() {
    return (req, res, next) => {
      // 如果没有 cookie-parser 中间件，跳过 CSRF 设置
      if (!req.cookies) {
        return next();
      }
      
      // 获取或生成 CSRF secret
      let secret = req.cookies[this.sessionName];
      if (!secret) {
        secret = crypto.randomBytes(32).toString('base64url');
        res.cookie(this.sessionName, secret, {
          ...this.cookieOptions,
          httpOnly: true  // secret 必须是 httpOnly
        });
      }

      // 获取或生成 CSRF token
      let token = req.cookies[this.cookieName];
      if (!token) {
        const rawToken = this.generateToken();
        token = this.signToken(rawToken, secret);
        res.cookie(this.cookieName, token, this.cookieOptions);
      }

      // 挂载到请求对象
      req.csrfToken = token;
      req.csrfSecret = secret;

      next();
    };
  }

  /**
   * 中间件：验证 CSRF 令牌
   */
  verifyCSRF() {
    return (req, res, next) => {
      // 安全方法豁免
      if (this.safeMethods.has(req.method)) {
        return next();
      }

      // 白名单路径豁免
      const pathWithoutQuery = req.path.split('?')[0];
      if (this.whitelistPaths.has(pathWithoutQuery)) {
        return next();
      }

      // 检查白名单前缀
      for (const whitelistPath of this.whitelistPaths) {
        if (pathWithoutQuery.startsWith(whitelistPath)) {
          return next();
        }
      }

      // 获取令牌
      const cookieToken = req.cookies[this.cookieName];
      const headerToken = req.headers[this.headerName];
      const secret = req.cookies[this.sessionName];

      // 验证令牌存在
      if (!cookieToken || !headerToken || !secret) {
        logger.warn('CSRF token missing', {
          path: req.path,
          method: req.method,
          hasCookie: !!cookieToken,
          hasHeader: !!headerToken,
          hasSecret: !!secret,
          ip: req.ip
        });

        return res.status(403).json({
          code: 1041,
          message: 'CSRF 令牌缺失',
          error: 'CSRF_TOKEN_MISSING'
        });
      }

      // 验证 Cookie 令牌签名
      const cookieVerification = this.verifyTokenSignature(cookieToken, secret);
      if (!cookieVerification.valid) {
        logger.warn('CSRF cookie token invalid', {
          path: req.path,
          reason: cookieVerification.reason,
          ip: req.ip
        });

        return res.status(403).json({
          code: 1042,
          message: 'CSRF Cookie 令牌无效',
          error: 'CSRF_COOKIE_INVALID'
        });
      }

      // 验证 Header 令牌签名
      const headerVerification = this.verifyTokenSignature(headerToken, secret);
      if (!headerVerification.valid) {
        logger.warn('CSRF header token invalid', {
          path: req.path,
          reason: headerVerification.reason,
          ip: req.ip
        });

        return res.status(403).json({
          code: 1043,
          message: 'CSRF Header 令牌无效',
          error: 'CSRF_HEADER_INVALID'
        });
      }

      // 验证 Cookie 和 Header 令牌匹配
      try {
        if (!crypto.timingSafeEqual(
          Buffer.from(cookieVerification.token),
          Buffer.from(headerVerification.token)
        )) {
          logger.warn('CSRF token mismatch', {
            path: req.path,
            ip: req.ip
          });

          return res.status(403).json({
            code: 1044,
            message: 'CSRF 令牌不匹配',
            error: 'CSRF_TOKEN_MISMATCH'
          });
        }
      } catch (e) {
        return res.status(403).json({
          code: 1044,
          message: 'CSRF 令牌不匹配',
          error: 'CSRF_TOKEN_MISMATCH'
        });
      }

      // 验证通过
      next();
    };
  }

  /**
   * 添加白名单路径
   */
  addToWhitelist(path) {
    this.whitelistPaths.add(path);
  }

  /**
   * 移除白名单路径
   */
  removeFromWhitelist(path) {
    this.whitelistPaths.delete(path);
  }

  /**
   * 获取当前 CSRF 令牌（供前端使用）
   */
  getToken(req) {
    return req.csrfToken;
  }
}

// 创建默认实例
const defaultCSRF = new CSRFProtection();

module.exports = {
  CSRFProtection,
  csrfProtection: defaultCSRF,
  setCSRFCookie: defaultCSRF.setCSRFCookie.bind(defaultCSRF),
  verifyCSRF: defaultCSRF.verifyCSRF.bind(defaultCSRF)
};
