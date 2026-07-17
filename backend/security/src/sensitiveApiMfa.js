/**
 * 敏感 API 二次验证服务
 * 
 * REQ-00588: 敏感 API 二次身份验证与风控行为分级系统
 * 
 * 提供短信验证码、邮箱验证码、TOTP 等二次验证方式
 */

'use strict';

const { logger } = require('../../shared/logger');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

/**
 * 验证类型
 */
const VerificationType = {
  SMS: 'sms',
  EMAIL: 'email',
  TOTP: 'totp',
  RECOVERY_CODE: 'recovery_code',
  BIOMETRIC: 'biometric'
};

/**
 * 验证状态
 */
const VerificationStatus = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  EXPIRED: 'expired',
  FAILED: 'failed'
};

/**
 * 二次验证服务
 */
class SensitiveApiMfaService {
  constructor(db, redis, config = {}) {
    this.db = db;
    this.redis = redis;
    
    this.config = {
      // 验证码有效期（秒）
      codeTTL: config.codeTTL || 300, // 5 分钟
      // 已验证令牌有效期
      verifiedTokenTTL: config.verifiedTokenTTL || 300, // 5 分钟
      // 验证码长度
      codeLength: config.codeLength || 6,
      // 最大重试次数
      maxAttempts: config.maxAttempts || 5,
      // 重发间隔（秒）
      resendCooldown: config.resendCooldown || 60,
      // 快速验证码长度（用于 quick_verify）
      quickCodeLength: config.quickCodeLength || 4,
      ...config
    };
  }
  
  /**
   * 发起二次验证
   * @param {number} userId - 用户 ID
   * @param {string} challengeToken - 挑战令牌
   * @param {string} verificationType - 验证类型
   * @param {Object} options - 可选参数
   * @returns {Object} 发送结果
   */
  async initiateVerification(userId, challengeToken, verificationType, options = {}) {
    const verificationId = uuidv4();
    
    try {
      // 1. 验证挑战令牌
      const challengeKey = `mfa_challenge:${userId}:${challengeToken}`;
      const challengeData = await this.redis.hgetall(challengeKey);
      
      if (!challengeData || !challengeData.path) {
        return {
          success: false,
          error: 'INVALID_CHALLENGE_TOKEN',
          message: '挑战令牌无效或已过期'
        };
      }
      
      // 2. 检查重发冷却
      const cooldownKey = `mfa_cooldown:${userId}:${verificationType}`;
      const lastSent = await this.redis.get(cooldownKey);
      if (lastSent) {
        const remaining = this.config.resendCooldown - Math.floor((Date.now() - parseInt(lastSent)) / 1000);
        if (remaining > 0) {
          return {
            success: false,
            error: 'COOLDOWN_ACTIVE',
            message: `请在 ${remaining} 秒后重试`,
            retryAfter: remaining
          };
        }
      }
      
      // 3. 生成验证码
      const codeLength = options.quickVerify ? this.config.quickCodeLength : this.config.codeLength;
      const code = this.generateVerificationCode(codeLength);
      
      // 4. 存储验证信息
      const verificationKey = `mfa_verification:${verificationId}`;
      await this.redis.hset(verificationKey, {
        userId: userId.toString(),
        challengeToken,
        verificationType,
        code: this.hashCode(code),
        path: challengeData.path,
        riskScore: challengeData.riskScore || '50',
        attempts: '0',
        createdAt: Date.now().toString()
      });
      await this.redis.expire(verificationKey, this.config.codeTTL);
      
      // 5. 发送验证码
      const sendResult = await this.sendVerificationCode(userId, verificationType, code, options);
      
      // 6. 设置重发冷却
      await this.redis.setex(cooldownKey, this.config.resendCooldown, Date.now().toString());
      
      // 7. 记录审计日志
      await this.auditLog(userId, 'MFA_INITIATED', {
        verificationId,
        verificationType,
        path: challengeData.path
      });
      
      return {
        success: true,
        verificationId,
        verificationType,
        expiresAt: new Date(Date.now() + this.config.codeTTL * 1000).toISOString(),
        maskedDestination: sendResult.maskedDestination
      };
      
    } catch (error) {
      logger.error('Failed to initiate verification', {
        userId,
        verificationType,
        error: error.message
      });
      
      return {
        success: false,
        error: 'SYSTEM_ERROR',
        message: '系统错误，请稍后重试'
      };
    }
  }
  
  /**
   * 验证二次验证码
   * @param {string} verificationId - 验证 ID
   * @param {string} code - 验证码
   * @returns {Object} 验证结果
   */
  async verifyCode(verificationId, code) {
    try {
      const verificationKey = `mfa_verification:${verificationId}`;
      const data = await this.redis.hgetall(verificationKey);
      
      if (!data || !data.userId) {
        return {
          success: false,
          error: 'VERIFICATION_NOT_FOUND',
          message: '验证请求不存在或已过期'
        };
      }
      
      const userId = parseInt(data.userId);
      
      // 检查尝试次数
      const attempts = parseInt(data.attempts || '0');
      if (attempts >= this.config.maxAttempts) {
        await this.handleFailedVerification(userId, verificationId, 'max_attempts_exceeded');
        return {
          success: false,
          error: 'MAX_ATTEMPTS_EXCEEDED',
          message: '验证失败次数过多，请重新发起验证'
        };
      }
      
      // 验证码比对
      const isValid = this.verifyCodeHash(code, data.code);
      
      if (!isValid) {
        // 增加尝试次数
        await this.redis.hincrby(verificationKey, 'attempts', 1);
        
        // 记录失败
        await this.recordFailedAttempt(userId);
        
        const remaining = this.config.maxAttempts - attempts - 1;
        return {
          success: false,
          error: 'INVALID_CODE',
          message: '验证码错误',
          remainingAttempts: remaining
        };
      }
      
      // 验证成功，生成已验证令牌
      const verifiedToken = await this.createVerifiedToken(userId, data.path, data.riskScore);
      
      // 删除验证记录
      await this.redis.del(verificationKey);
      
      // 清除失败计数
      await this.redis.del(`failed_mfa:${userId}`);
      
      // 记录审计日志
      await this.auditLog(userId, 'MFA_VERIFIED', {
        verificationId,
        path: data.path
      });
      
      return {
        success: true,
        verifiedToken,
        expiresAt: new Date(Date.now() + this.config.verifiedTokenTTL * 1000).toISOString(),
        allowedPath: data.path
      };
      
    } catch (error) {
      logger.error('Failed to verify code', {
        verificationId,
        error: error.message
      });
      
      return {
        success: false,
        error: 'SYSTEM_ERROR',
        message: '系统错误，请稍后重试'
      };
    }
  }
  
  /**
   * 创建已验证令牌
   */
  async createVerifiedToken(userId, path, riskScore) {
    const token = uuidv4();
    const key = `mfa_verified:${userId}:${token}`;
    
    await this.redis.hset(key, {
      path,
      riskScore: riskScore.toString(),
      verifiedAt: Date.now().toString()
    });
    await this.redis.expire(key, this.config.verifiedTokenTTL);
    
    return token;
  }
  
  /**
   * 发送验证码
   */
  async sendVerificationCode(userId, verificationType, code, options = {}) {
    try {
      // 获取用户验证信息
      const userInfo = await this.getUserVerificationInfo(userId, verificationType);
      
      if (!userInfo || !userInfo.destination) {
        throw new Error(`User has no ${verificationType} configured`);
      }
      
      // 根据类型发送
      switch (verificationType) {
        case VerificationType.SMS:
          await this.sendSmsCode(userInfo.destination, code);
          break;
          
        case VerificationType.EMAIL:
          await this.sendEmailCode(userInfo.destination, code);
          break;
          
        default:
          throw new Error(`Unsupported verification type: ${verificationType}`);
      }
      
      return {
        success: true,
        maskedDestination: this.maskDestination(userInfo.destination, verificationType)
      };
      
    } catch (error) {
      logger.error('Failed to send verification code', {
        userId,
        verificationType,
        error: error.message
      });
      
      throw error;
    }
  }
  
  /**
   * 发送短信验证码
   */
  async sendSmsCode(phone, code) {
    // 实际实现需要对接短信服务商
    logger.info('SMS verification code sent', { phone: this.maskDestination(phone, 'sms') });
    
    // 开发环境打印验证码
    if (process.env.NODE_ENV !== 'production') {
      logger.info(`[DEV] SMS code for ${phone}: ${code}`);
    }
    
    // 发布到 Redis 消息队列，由短信服务消费
    await this.redis.publish('sms:send', JSON.stringify({
      to: phone,
      template: 'mfa_verification',
      params: { code }
    }));
  }
  
  /**
   * 发送邮箱验证码
   */
  async sendEmailCode(email, code) {
    // 实际实现需要对接邮件服务
    logger.info('Email verification code sent', { email: this.maskDestination(email, 'email') });
    
    // 开发环境打印验证码
    if (process.env.NODE_ENV !== 'production') {
      logger.info(`[DEV] Email code for ${email}: ${code}`);
    }
    
    // 发布到 Redis 消息队列，由邮件服务消费
    await this.redis.publish('email:send', JSON.stringify({
      to: email,
      template: 'mfa_verification',
      params: { code }
    }));
  }
  
  /**
   * 获取用户验证信息
   */
  async getUserVerificationInfo(userId, verificationType) {
    try {
      const result = await this.db.query(`
        SELECT 
          phone, email, totp_enabled, totp_secret
        FROM users
        WHERE id = $1
      `, [userId]);
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const user = result.rows[0];
      
      switch (verificationType) {
        case VerificationType.SMS:
          return { destination: user.phone };
        case VerificationType.EMAIL:
          return { destination: user.email };
        case VerificationType.TOTP:
          return { destination: 'totp', secret: user.totp_secret, enabled: user.totp_enabled };
        default:
          return null;
      }
      
    } catch (error) {
      logger.error('Failed to get user verification info', { userId, error: error.message });
      return null;
    }
  }
  
  /**
   * 生成验证码
   */
  generateVerificationCode(length = 6) {
    const digits = '0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
      code += digits[Math.floor(Math.random() * digits.length)];
    }
    return code;
  }
  
  /**
   * 哈希验证码
   */
  hashCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
  }
  
  /**
   * 验证码哈希比对
   */
  verifyCodeHash(code, hash) {
    return this.hashCode(code) === hash;
  }
  
  /**
   * 掩码目标地址
   */
  maskDestination(destination, type) {
    if (type === 'sms') {
      // 手机号掩码：138****1234
      if (destination.length >= 11) {
        return destination.slice(0, 3) + '****' + destination.slice(-4);
      }
    }
    if (type === 'email') {
      // 邮箱掩码：a***@example.com
      const [local, domain] = destination.split('@');
      if (local && domain) {
        return local[0] + '***@' + domain;
      }
    }
    return '****';
  }
  
  /**
   * 记录失败尝试
   */
  async recordFailedAttempt(userId) {
    const key = `failed_mfa:${userId}`;
    const count = await this.redis.incr(key);
    await this.redis.expire(key, 3600); // 1 小时
    
    // 如果失败次数过多，触发安全告警
    if (count >= 5) {
      await this.triggerSecurityAlert(userId, 'multiple_mfa_failures', { count });
    }
  }
  
  /**
   * 处理失败的验证
   */
  async handleFailedVerification(userId, verificationId, reason) {
    await this.redis.del(`mfa_verification:${verificationId}`);
    
    await this.auditLog(userId, 'MFA_BLOCKED', {
      verificationId,
      reason
    });
  }
  
  /**
   * 审计日志
   */
  async auditLog(userId, action, details) {
    try {
      await this.db.query(`
        INSERT INTO security_audit_log (
          user_id, action, details, created_at
        ) VALUES ($1, $2, $3, NOW())
      `, [userId, action, JSON.stringify(details)]);
      
      logger.info('Security audit log', { userId, action, details });
      
    } catch (error) {
      logger.error('Failed to write audit log', { userId, action, error: error.message });
    }
  }
  
  /**
   * 触发安全告警
   */
  async triggerSecurityAlert(userId, alertType, details) {
    await this.redis.publish('security:alert', JSON.stringify({
      userId,
      alertType,
      details,
      timestamp: new Date().toISOString()
    }));
    
    logger.warn('Security alert triggered', { userId, alertType, details });
  }
  
  /**
   * 检查用户是否启用了 MFA
   */
  async isUserMfaEnabled(userId) {
    try {
      const result = await this.db.query(`
        SELECT mfa_enabled, mfa_type 
        FROM user_security_settings 
        WHERE user_id = $1
      `, [userId]);
      
      return result.rows[0]?.mfa_enabled || false;
    } catch {
      return false;
    }
  }
  
  /**
   * 获取可用的验证方式
   */
  async getAvailableVerificationMethods(userId) {
    try {
      const result = await this.db.query(`
        SELECT 
          u.phone IS NOT NULL as has_phone,
          u.email IS NOT NULL as has_email,
          uss.mfa_enabled,
          uss.mfa_type,
          uss.totp_enabled
        FROM users u
        LEFT JOIN user_security_settings uss ON u.id = uss.user_id
        WHERE u.id = $1
      `, [userId]);
      
      if (result.rows.length === 0) {
        return [];
      }
      
      const user = result.rows[0];
      const methods = [];
      
      if (user.has_phone) methods.push({ type: 'sms', label: '短信验证' });
      if (user.has_email) methods.push({ type: 'email', label: '邮箱验证' });
      if (user.totp_enabled) methods.push({ type: 'totp', label: '身份验证器' });
      
      return methods;
      
    } catch (error) {
      logger.error('Failed to get available verification methods', { userId, error: error.message });
      return [];
    }
  }
}

module.exports = SensitiveApiMfaService;
module.exports.VerificationType = VerificationType;
module.exports.VerificationStatus = VerificationStatus;