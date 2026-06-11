/**
 * REQ-00057: MFA 中间件
 * 用于敏感操作的 MFA 验证
 */

const jwt = require('jsonwebtoken');
const mfaService = require('../../../shared/mfaService');
const { createLogger } = require('../../../shared/logger');
const logger = createLogger('gateway');

/**
 * MFA 验证中间件
 * @param {Object} options - 配置选项
 * @param {number} options.maxAge - MFA token 有效期（秒），默认 300 秒（5 分钟）
 */
function mfaRequired(options = {}) {
  const { maxAge = 300 } = options;

  return async (req, res, next) => {
    // 如果用户未启用 MFA，直接通过
    if (!req.user?.mfaEnabled) {
      return next();
    }

    const mfaToken = req.headers['x-mfa-token'];
    
    if (!mfaToken) {
      return res.status(403).json({
        code: 1040,
        message: '此操作需要 MFA 验证',
        mfaRequired: true,
        hint: '请提供有效的 x-mfa-token 请求头'
      });
    }

    try {
      // 验证 MFA token（短期 JWT）
      const decoded = jwt.verify(mfaToken, process.env.JWT_SECRET || 'minego-secret');
      
      // 检查 token 类型
      if (decoded.type !== 'mfa') {
        return res.status(403).json({
          code: 1041,
          message: 'MFA 验证无效',
          mfaRequired: true
        });
      }

      // 检查用户 ID 是否匹配
      if (decoded.userId !== req.user.id) {
        return res.status(403).json({
          code: 1042,
          message: 'MFA token 与当前用户不匹配',
          mfaRequired: true
        });
      }

      // 检查是否过期
      const tokenAge = Math.floor(Date.now() / 1000) - decoded.iat;
      if (tokenAge > maxAge) {
        return res.status(403).json({
          code: 1043,
          message: 'MFA 验证已过期，请重新验证',
          mfaRequired: true
        });
      }

      // 将 MFA 验证信息附加到请求对象
      req.mfaVerified = true;
      req.mfaVerifiedAt = new Date(decoded.iat * 1000);

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(403).json({
          code: 1044,
          message: 'MFA 验证已过期，请重新验证',
          mfaRequired: true
        });
      }

      if (error.name === 'JsonWebTokenError') {
        return res.status(403).json({
          code: 1045,
          message: 'MFA token 无效',
          mfaRequired: true
        });
      }

      logger.error('MFA middleware error', { error: error.message });
      return res.status(500).json({
        code: 1046,
        message: 'MFA 验证失败'
      });
    }
  };
}

/**
 * 生成 MFA token
 */
function generateMfaToken(userId) {
  return jwt.sign(
    {
      userId,
      type: 'mfa',
      iat: Math.floor(Date.now() / 1000)
    },
    process.env.JWT_SECRET || 'minego-secret',
    { expiresIn: '5m' }
  );
}

/**
 * 敏感操作列表
 */
const SENSITIVE_OPERATIONS = {
  CHANGE_PASSWORD: 'change_password',
  BIND_PAYMENT: 'bind_payment',
  UNBIND_PAYMENT: 'unbind_payment',
  LARGE_TRANSACTION: 'large_transaction',
  DELETE_ACCOUNT: 'delete_account',
  DISABLE_MFA: 'disable_mfa',
  REGENERATE_RECOVERY_CODES: 'regenerate_recovery_codes',
  TRANSFER_POKEMON: 'transfer_pokemon'
};

/**
 * 敏感操作检查中间件
 */
function sensitiveOperationRequired(operation) {
  return (req, res, next) => {
    // 标记需要的 MFA 操作
    req.sensitiveOperation = operation;
    
    // 如果用户未启用 MFA，记录日志并继续
    if (!req.user?.mfaEnabled) {
      logger.info('Sensitive operation without MFA', {
        userId: req.user?.id,
        operation
      });
      return next();
    }

    // 使用 MFA 中间件
    return mfaRequired()(req, res, next);
  };
}

module.exports = {
  mfaRequired,
  generateMfaToken,
  sensitiveOperationRequired,
  SENSITIVE_OPERATIONS
};
