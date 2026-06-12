// backend/shared/middleware/rateLimit.js
// REQ-00138: 共享限流中间件

'use strict';

const rateLimit = require('express-rate-limit');
const { createLogger } = require('../logger');

const logger = createLogger('rate-limit');

/**
 * 创建限流中间件
 * @param {Object} options - 配置选项
 * @param {number} options.windowMs - 时间窗口（毫秒）
 * @param {number} options.max - 最大请求数
 * @param {string} options.message - 自定义错误消息
 * @returns {Function} Express 中间件
 */
function rateLimiter(options = {}) {
  const {
    windowMs = 60000, // 默认 1 分钟
    max = 100,        // 默认 100 次
    message = '请求过于频繁，请稍后再试'
  } = options;

  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: message,
      code: 'RATE_LIMIT_EXCEEDED'
    },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        userId: req.user?.id,
        path: req.path,
        method: req.method
      });
      res.status(429).json({
        success: false,
        error: message,
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }
  });
}

/**
 * 预设限流器
 */
const rateLimiters = {
  // 严格限流（每秒 10 次）
  strict: rateLimiter({ windowMs: 1000, max: 10 }),
  
  // 标准限流（每分钟 100 次）
  standard: rateLimiter({ windowMs: 60000, max: 100 }),
  
  // 宽松限流（每小时 1000 次）
  relaxed: rateLimiter({ windowMs: 3600000, max: 1000 }),
  
  // API 限流（每分钟 60 次）
  api: rateLimiter({ windowMs: 60000, max: 60 }),
  
  // 认证限流（每分钟 5 次，防止暴力破解）
  auth: rateLimiter({ windowMs: 60000, max: 5, message: '登录尝试过于频繁，请稍后再试' })
};

module.exports = {
  rateLimiter,
  rateLimiters
};
