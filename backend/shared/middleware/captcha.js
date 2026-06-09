/**
 * CAPTCHA Middleware
 * 风险触发式人机验证中间件
 * 
 * REQ-00064: 风险触发式人机验证（CAPTCHA）系统
 */

const CaptchaTrigger = require('../captchaTrigger');
const { createLogger } = require('../logger');

const logger = createLogger('captcha-middleware');
const captchaTrigger = new CaptchaTrigger();

/**
 * 创建验证中间件
 * @param {Object} options - 配置选项
 * @param {string} options.action - 操作类型
 * @param {string} options.difficulty - 默认难度 (low|medium|high)
 * @param {string[]} options.skipRoles - 跳过的角色
 * @returns {Function} Express 中间件
 */
function createCaptchaMiddleware(options = {}) {
  const {
    action = 'unknown',
    difficulty = 'medium',
    skipRoles = ['admin']
  } = options;

  return async (req, res, next) => {
    try {
      // 检查是否跳过
      if (skipRoles.includes(req.user?.role)) {
        return next();
      }

      const userId = req.user?.id;
      if (!userId) {
        return next();
      }

      // 构建上下文
      const context = {
        ipAddress: req.ip,
        deviceFingerprint: req.headers['x-device-fingerprint'],
        userAgent: req.headers['user-agent'],
        ...req.body.context
      };

      // 检查是否需要验证
      const trigger = await captchaTrigger.checkTrigger(userId, action, context);

      if (!trigger) {
        return next();
      }

      // 触发验证
      const session = await captchaTrigger.trigger(userId, trigger, context);

      // 返回验证要求
      return res.status(403).json({
        error: 'captcha_required',
        message: 'Verification required to continue',
        captcha: {
          sessionId: session.sessionId,
          sessionType: session.sessionType,
          difficulty: session.difficulty,
          challengeData: session.challengeData
        }
      });

    } catch (error) {
      logger.error({ error, action }, 'Captcha middleware error');
      // 出错时允许通过，避免阻塞正常请求
      return next();
    }
  };
}

/**
 * 验证请求中间件
 * 检查请求中是否包含有效的验证令牌
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function requireCaptchaVerification(options = {}) {
  const { headerName = 'x-captcha-token' } = options;

  return async (req, res, next) => {
    try {
      const captchaToken = req.headers[headerName];

      if (!captchaToken) {
        return res.status(403).json({
          error: 'captcha_required',
          message: 'Captcha verification required'
        });
      }

      // 验证令牌
      const result = await verifyCaptchaToken(captchaToken, req.user?.id);

      if (!result.valid) {
        return res.status(403).json({
          error: 'captcha_invalid',
          message: result.message || 'Invalid or expired captcha verification'
        });
      }

      // 验证通过，继续
      next();

    } catch (error) {
      logger.error({ error }, 'Captcha verification error');
      return res.status(500).json({
        error: 'captcha_verification_error',
        message: 'Failed to verify captcha'
      });
    }
  };
}

/**
 * 验证令牌
 * @param {string} token - 验证令牌
 * @param {string} userId - 用户ID
 * @returns {Object} 验证结果
 */
async function verifyCaptchaToken(token, userId) {
  // 简化实现：检查 Redis 中的验证记录
  const redis = captchaTrigger.redis;
  const key = `captcha:verified:${userId}`;

  const storedToken = await redis.get(key);

  if (storedToken === token) {
    // 验证成功后删除令牌（一次性使用）
    await redis.del(key);
    return { valid: true };
  }

  return { valid: false, message: 'Invalid or expired token' };
}

/**
 * 检查账号是否冻结
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function checkAccountFrozen(options = {}) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return next();
      }

      const redis = captchaTrigger.redis;
      const frozenKey = `account:frozen:${userId}`;

      const isFrozen = await redis.exists(frozenKey);

      if (isFrozen) {
        return res.status(403).json({
          error: 'account_frozen',
          message: 'Account is temporarily frozen due to suspicious activity',
          contactSupport: true
        });
      }

      next();

    } catch (error) {
      logger.error({ error }, 'Check account frozen error');
      return next();
    }
  };
}

/**
 * 高风险操作中间件
 * 自动检查高风险操作并触发验证
 */
const highRiskActions = {
  login: createCaptchaMiddleware({ action: 'login', difficulty: 'medium' }),
  catch: createCaptchaMiddleware({ action: 'catch', difficulty: 'medium' }),
  gym: createCaptchaMiddleware({ action: 'gym', difficulty: 'low' }),
  trade: createCaptchaMiddleware({ action: 'trade', difficulty: 'high' }),
  payment: createCaptchaMiddleware({ action: 'payment', difficulty: 'high' }),
  transfer: createCaptchaMiddleware({ action: 'transfer', difficulty: 'high' })
};

module.exports = {
  createCaptchaMiddleware,
  requireCaptchaVerification,
  checkAccountFrozen,
  highRiskActions
};
