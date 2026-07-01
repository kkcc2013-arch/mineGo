// backend/shared/SensitiveOperationGuard.js - 敏感操作守卫
'use strict';

const RiskEvaluator = require('./RiskEvaluator');
const { redis } = require('./database');
const { createLogger } = require('./logger');

const logger = createLogger('sensitive-operation-guard');

/**
 * 敏感操作守卫 - 根据风险评估控制操作访问
 */
class SensitiveOperationGuard {
  constructor(options = {}) {
    this.riskEvaluator = new RiskEvaluator(options.riskConfig);
    
    // 风险等级对应的验证要求
    this.verificationRequirements = {
      critical: {
        requiresMfa: true,
        requiresSms: false,
        requiresEmail: false,
        requiresCaptcha: false,
        cooldown: 300000, // 5 分钟
        maxAttempts: 1
      },
      high: {
        requiresMfa: false,
        requiresSms: true,
        requiresEmail: false,
        requiresCaptcha: true,
        cooldown: 60000, // 1 分钟
        maxAttempts: 2
      },
      medium: {
        requiresMfa: false,
        requiresSms: false,
        requiresEmail: false,
        requiresCaptcha: true,
        cooldown: 30000, // 30 秒
        maxAttempts: 3
      },
      low: {
        requiresMfa: false,
        requiresSms: false,
        requiresEmail: false,
        requiresCaptcha: false,
        cooldown: 0,
        maxAttempts: 10
      }
    };
    
    // 操作到路由的映射
    this.routeOperationMap = new Map([
      ['POST:/api/v1/payment/purchase', 'payment.purchase'],
      ['POST:/api/v1/payment/refund', 'payment.refund'],
      ['POST:/api/v1/payment/withdraw', 'payment.withdraw'],
      ['POST:/api/v1/payment/bindCard', 'payment.bindCard'],
      ['DELETE:/api/v1/payment/card', 'payment.unbindCard'],
      
      ['PUT:/api/v1/user/password', 'user.changePassword'],
      ['POST:/api/v1/user/bindEmail', 'user.bindEmail'],
      ['POST:/api/v1/user/bindPhone', 'user.bindPhone'],
      ['DELETE:/api/v1/user/account', 'user.deleteAccount'],
      ['GET:/api/v1/user/export', 'user.exportData'],
      ['PUT:/api/v1/user/profile', 'user.updateProfile'],
      
      ['POST:/api/v1/pokemon/trade', 'pokemon.trade'],
      ['POST:/api/v1/pokemon/transfer', 'pokemon.transfer'],
      ['POST:/api/v1/pokemon/release', 'pokemon.release'],
      
      ['POST:/api/v1/social/friends', 'social.addFriend'],
      ['DELETE:/api/v1/social/friends', 'social.removeFriend'],
      ['POST:/api/v1/social/messages', 'social.sendMessage'],
      
      ['POST:/api/v1/gym/challenge', 'gym.challenge'],
      ['POST:/api/v1/gym/claim', 'gym.claim']
    ]);
    
    // 累计风险阈值（一段时间内的累计风险）
    this.cumulativeRiskThreshold = options.cumulativeRiskThreshold ?? 200;
    this.cumulativeRiskWindow = options.cumulativeRiskWindow ?? 3600000; // 1 小时
  }

  /**
   * 创建 Express 中间件
   */
  createMiddleware() {
    return async (req, res, next) => {
      // 未登录用户跳过
      if (!req.user) {
        return next();
      }
      
      // 查找操作类型
      const operation = this.getOperationFromRequest(req);
      
      // 非敏感操作跳过
      if (!operation) {
        return next();
      }
      
      try {
        // 执行风险评估
        const evaluation = await this.riskEvaluator.evaluate({
          operation,
          userId: req.user.sub || req.user.id,
          deviceId: req.headers['x-device-id'],
          ip: req.ip || req.connection.remoteAddress,
          userAgent: req.headers['user-agent'],
          location: req.body?.location ? {
            lat: req.body.location.lat,
            lng: req.body.location.lng
          } : null,
          metadata: {
            path: req.path,
            method: req.method,
            body: this.sanitizeBody(req.body)
          }
        });
        
        // 挂载评估结果
        req.riskEvaluation = evaluation;
        
        // 检查是否需要验证
        const verification = this.checkVerificationRequirement(evaluation, req);
        
        if (verification.required) {
          // 返回验证要求
          return res.status(403).json({
            error: 'VERIFICATION_REQUIRED',
            message: '此操作需要额外验证',
            verification: verification.requirements,
            riskLevel: evaluation.level,
            riskScore: evaluation.score,
            requestId: this.generateRequestId()
          });
        }
        
        // 检查冷却时间
        const cooldownCheck = await this.checkCooldown(req.user.sub || req.user.id, operation);
        
        if (cooldownCheck.inCooldown) {
          return res.status(429).json({
            error: 'COOLDOWN_ACTIVE',
            message: '操作过于频繁，请稍后再试',
            remainingTime: cooldownCheck.remainingTime,
            operation
          });
        }
        
        // 检查累计风险
        const cumulativeCheck = await this.checkCumulativeRisk(req.user.sub || req.user.id);
        
        if (cumulativeCheck.exceeded) {
          logger.warn({
            userId: req.user.sub || req.user.id,
            operation,
            cumulativeRisk: cumulativeCheck.total
          }, 'Cumulative risk exceeded');
          
          return res.status(403).json({
            error: 'RISK_LIMIT_EXCEEDED',
            message: '您的账户近期存在较多敏感操作，已被临时限制',
            retryAfter: cumulativeCheck.resetTime,
            supportContact: '/support'
          });
        }
        
        // 记录操作开始
        await this.recordOperationStart(req.user.sub || req.user.id, operation, evaluation);
        
        // 包装响应以记录操作结果
        this.wrapResponse(res, req.user.sub || req.user.id, operation, evaluation);
        
        next();
        
      } catch (error) {
        logger.error({ error, operation, userId: req.user?.sub }, 'Sensitive operation guard failed');
        
        // 安全起见，拒绝访问
        return res.status(500).json({
          error: 'RISK_EVALUATION_FAILED',
          message: '安全检查失败，请稍后再试'
        });
      }
    };
  }

  /**
   * 从请求中获取操作类型
   */
  getOperationFromRequest(req) {
    const key = `${req.method}:${req.path}`;
    return this.routeOperationMap.get(key) || null;
  }

  /**
   * 检查验证要求
   */
  checkVerificationRequirement(evaluation, req) {
    const requirements = this.verificationRequirements[evaluation.level];
    
    // 检查是否已完成验证
    const verifiedTypes = req.headers['x-verified-types']?.split(',') || [];
    const providedCaptcha = req.headers['x-captcha-token'];
    
    const result = {
      required: false,
      requirements: {}
    };
    
    // MFA 验证
    if (requirements.requiresMfa && !verifiedTypes.includes('mfa')) {
      result.required = true;
      result.requirements.mfa = true;
    }
    
    // 短信验证
    if (requirements.requiresSms && !verifiedTypes.includes('sms')) {
      result.required = true;
      result.requirements.sms = true;
    }
    
    // 邮箱验证
    if (requirements.requiresEmail && !verifiedTypes.includes('email')) {
      result.required = true;
      result.requirements.email = true;
    }
    
    // 图形验证码
    if (requirements.requiresCaptcha && !providedCaptcha) {
      result.required = true;
      result.requirements.captcha = true;
    }
    
    return result;
  }

  /**
   * 检查冷却时间
   */
  async checkCooldown(userId, operation) {
    const cooldownKey = `cooldown:${userId}:${operation}`;
    const lastOperation = await redis.get(cooldownKey);
    
    if (!lastOperation) {
      return { inCooldown: false };
    }
    
    const requirements = this.verificationRequirements[
      this.riskEvaluator.getOperationRisk(operation)?.level || 'medium'
    ];
    
    const lastTime = parseInt(lastOperation, 10);
    const elapsed = Date.now() - lastTime;
    const remaining = requirements.cooldown - elapsed;
    
    if (remaining > 0) {
      return {
        inCooldown: true,
        remainingTime: remaining
      };
    }
    
    return { inCooldown: false };
  }

  /**
   * 检查累计风险
   */
  async checkCumulativeRisk(userId) {
    const cumulativeKey = `risk:cumulative:${userId}`;
    const windowStart = Date.now() - this.cumulativeRiskWindow;
    
    // 获取时间窗口内的风险记录
    const records = await redis.zrangebyscore(
      cumulativeKey,
      windowStart,
      Date.now(),
      'WITHSCORES'
    );
    
    let total = 0;
    for (let i = 1; i < records.length; i += 2) {
      total += parseInt(records[i], 10);
    }
    
    // 清理旧记录
    await redis.zremrangebyscore(cumulativeKey, '-inf', windowStart);
    
    return {
      exceeded: total > this.cumulativeRiskThreshold,
      total,
      resetTime: windowStart + this.cumulativeRiskWindow
    };
  }

  /**
   * 记录操作开始
   */
  async recordOperationStart(userId, operation, evaluation) {
    const timestamp = Date.now();
    
    // 设置冷却时间
    const requirements = this.verificationRequirements[evaluation.level];
    const cooldownKey = `cooldown:${userId}:${operation}`;
    await redis.setex(cooldownKey, Math.ceil(requirements.cooldown / 1000), timestamp.toString());
    
    // 记录累计风险
    const cumulativeKey = `risk:cumulative:${userId}`;
    await redis.zadd(cumulativeKey, timestamp, `${operation}:${timestamp}`);
    await redis.expire(cumulativeKey, Math.ceil(this.cumulativeRiskWindow / 1000));
    
    // 记录操作详情
    const detailKey = `operation:detail:${userId}:${timestamp}`;
    await redis.setex(detailKey, 3600 * 24, JSON.stringify({
      operation,
      evaluation,
      status: 'started',
      timestamp
    }));
  }

  /**
   * 包装响应以记录结果
   */
  wrapResponse(res, userId, operation, evaluation) {
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    const startTime = Date.now();
    
    res.json = function(data) {
      recordOperationResult(userId, operation, evaluation, res.statusCode, startTime);
      return originalJson(data);
    };
    
    res.send = function(data) {
      recordOperationResult(userId, operation, evaluation, res.statusCode, startTime);
      return originalSend(data);
    };
  }

  /**
   * 记录操作结果
   */
  async recordOperationResult(userId, operation, evaluation, statusCode, startTime) {
    const success = statusCode >= 200 && statusCode < 300;
    const duration = Date.now() - startTime;
    
    // 更新操作历史
    const historyKey = `user:operations:${userId}`;
    const record = {
      operation,
      level: evaluation.level,
      score: evaluation.score,
      status: success ? 'success' : 'failed',
      statusCode,
      duration,
      timestamp: Date.now()
    };
    
    await redis.lpush(historyKey, JSON.stringify(record));
    await redis.ltrim(historyKey, 0, 100);
    
    // 更新统计
    const statsKey = `operation:stats:${operation}`;
    await redis.hincrby(statsKey, success ? 'success' : 'failed', 1);
    await redis.hincrby(statsKey, 'total', 1);
    
    logger.info({
      userId,
      operation,
      level: evaluation.level,
      score: evaluation.score,
      success,
      duration
    }, 'Sensitive operation completed');
  }

  /**
   * 清理请求体中的敏感信息
   */
  sanitizeBody(body) {
    if (!body) return {};
    
    const sanitized = { ...body };
    const sensitiveFields = ['password', 'newPassword', 'oldPassword', 'token', 'cardNumber', 'cvv'];
    
    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '***';
      }
    }
    
    return sanitized;
  }

  /**
   * 生成请求 ID
   */
  generateRequestId() {
    return `req_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
  }

  /**
   * 注册自定义路由操作映射
   */
  registerRoute(method, path, operation) {
    this.routeOperationMap.set(`${method}:${path}`, operation);
  }

  /**
   * 获取所有注册的路由
   */
  getRegisteredRoutes() {
    return Array.from(this.routeOperationMap.entries()).map(([route, operation]) => ({
      route,
      operation
    }));
  }

  /**
   * 更新验证要求
   */
  updateVerificationRequirements(level, requirements) {
    this.verificationRequirements[level] = {
      ...this.verificationRequirements[level],
      ...requirements
    };
  }
}

// 导出单例或类
let instance = null;

function getInstance(options) {
  if (!instance) {
    instance = new SensitiveOperationGuard(options);
  }
  return instance;
}

module.exports = {
  SensitiveOperationGuard,
  getInstance,
  createMiddleware: (options) => getInstance(options).createMiddleware()
};
