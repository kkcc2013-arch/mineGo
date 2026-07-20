'use strict';

/**
 * 威胁响应执行器
 * 根据威胁等级自动执行响应动作
 */

class ThreatResponseExecutor {
  constructor(config = {}) {
    this.redis = config.redis;
    this.logger = config.logger || console;
    
    // 响应策略配置
    this.responseStrategies = {
      suspicious: {
        actions: ['log_enhanced', 'rate_limit_dynamic'],
        rateLimitMultiplier: 1.5,
        banDuration: 0
      },
      threat: {
        actions: ['challenge_captcha', 'rate_limit_aggressive', 'session_flag', 'alert_notify'],
        rateLimitMultiplier: 3,
        banDuration: 0
      },
      critical: {
        actions: ['ip_temp_ban', 'session_revoke', 'alert_escalate', 'block_request'],
        rateLimitMultiplier: 10,
        banDuration: 900 // 15分钟
      }
    };
    
    // IP 封禁前缀
    this.banKeyPrefix = 'threat:ban:';
    
    // 统计
    this.stats = {
      actionsExecuted: {},
      bansIssued: 0,
      challengesIssued: 0,
      sessionsRevoked: 0
    };
  }

  /**
   * 执行威胁响应
   * @param {Object} threatResult - 威胁检测结果
   * @param {Object} req - Express request
   * @param {Object} options - 额外选项
   * @returns {Promise<Object>} 执行结果
   */
  async execute(threatResult, req, options = {}) {
    const { threatLevel, threatScore, threatId, features } = threatResult;
    
    // 正常流量无需响应
    if (threatLevel === 'normal') {
      return { executed: false, reason: 'normal_traffic' };
    }
    
    const strategy = this.responseStrategies[threatLevel];
    if (!strategy) {
      this.logger.warn(`[ThreatResponseExecutor] Unknown threat level: ${threatLevel}`);
      return { executed: false, reason: 'unknown_level' };
    }
    
    const executionResults = [];
    const ip = features?.ip || this.getClientIp(req);
    
    // 执行策略中的每个动作
    for (const action of strategy.actions) {
      try {
        const result = await this.executeAction(action, {
          ip,
          threatId,
          threatScore,
          threatLevel,
          features,
          req,
          strategy,
          options
        });
        
        executionResults.push({
          action,
          success: result.success,
          message: result.message
        });
        
        // 更新统计
        this.stats.actionsExecuted[action] = (this.stats.actionsExecuted[action] || 0) + 1;
        
      } catch (error) {
        this.logger.error(`[ThreatResponseExecutor] Action ${action} failed:`, error);
        executionResults.push({
          action,
          success: false,
          error: error.message
        });
      }
    }
    
    return {
      executed: true,
      threatLevel,
      threatScore,
      threatId,
      actions: executionResults
    };
  }

  /**
   * 执行单个响应动作
   * @param {string} action - 动作名称
   * @param {Object} context - 执行上下文
   * @returns {Promise<Object>} 执行结果
   */
  async executeAction(action, context) {
    const actionHandlers = {
      'log_enhanced': () => this.actionLogEnhanced(context),
      'rate_limit_dynamic': () => this.actionRateLimitDynamic(context),
      'rate_limit_aggressive': () => this.actionRateLimitAggressive(context),
      'challenge_captcha': () => this.actionChallengeCaptcha(context),
      'challenge_captcha_soft': () => this.actionChallengeCaptchaSoft(context),
      'challenge_captcha_hard': () => this.actionChallengeCaptcha(context),
      'session_flag': () => this.actionSessionFlag(context),
      'session_revoke': () => this.actionSessionRevoke(context),
      'alert_notify': () => this.actionAlertNotify(context),
      'alert_escalate': () => this.actionAlertEscalate(context),
      'ip_temp_ban': () => this.actionIpTempBan(context),
      'block_request': () => this.actionBlockRequest(context)
    };
    
    const handler = actionHandlers[action];
    if (!handler) {
      return { success: false, message: `Unknown action: ${action}` };
    }
    
    return await handler();
  }

  /**
   * 动作：增强日志记录
   */
  async actionLogEnhanced(context) {
    const { ip, threatId, features, req } = context;
    
    this.logger.info('[ThreatResponse] Enhanced logging enabled', {
      threatId,
      ip,
      features,
      path: req?.path,
      method: req?.method,
      userAgent: req?.headers?.['user-agent'],
      timestamp: new Date().toISOString()
    });
    
    return { success: true, message: 'Enhanced logging enabled' };
  }

  /**
   * 动作：动态限流
   */
  async actionRateLimitDynamic(context) {
    const { ip, strategy } = context;
    
    // 设置动态限流键
    const limitKey = `threat:ratelimit:${ip}`;
    const multiplier = strategy.rateLimitMultiplier;
    
    await this.redis.setex(
      limitKey, 
      3600, 
      JSON.stringify({ multiplier, reason: 'suspicious_activity' })
    );
    
    return { 
      success: true, 
      message: `Dynamic rate limit set with multiplier ${multiplier}x` 
    };
  }

  /**
   * 动作：激进限流
   */
  async actionRateLimitAggressive(context) {
    const { ip, strategy } = context;
    
    const limitKey = `threat:ratelimit:${ip}`;
    const multiplier = strategy.rateLimitMultiplier;
    
    await this.redis.setex(
      limitKey, 
      7200, 
      JSON.stringify({ multiplier, reason: 'threat_detected', aggressive: true })
    );
    
    return { 
      success: true, 
      message: `Aggressive rate limit set with multiplier ${multiplier}x` 
    };
  }

  /**
   * 动作：触发验证码
   */
  async actionChallengeCaptcha(context) {
    const { ip, threatId, req } = context;
    
    // 生成验证码挑战令牌
    const challengeToken = this.generateChallengeToken(ip, threatId);
    
    // 存储挑战状态
    const challengeKey = `threat:challenge:${ip}`;
    await this.redis.setex(
      challengeKey, 
      300, // 5分钟有效期
      JSON.stringify({
        token: challengeToken,
        threatId,
        attempts: 0,
        maxAttempts: 3
      })
    );
    
    this.stats.challengesIssued++;
    
    return { 
      success: true, 
      message: 'Captcha challenge issued',
      challengeToken,
      challengeRequired: true
    };
  }

  /**
   * 动作：软验证码（低频触发）
   */
  async actionChallengeCaptchaSoft(context) {
    const { ip, req } = context;
    
    // 检查最近是否已触发过验证码
    const recentChallenge = await this.redis.get(`threat:challenge:${ip}`);
    
    if (recentChallenge) {
      return { success: true, message: 'Recent challenge already exists' };
    }
    
    return await this.actionChallengeCaptcha(context);
  }

  /**
   * 动作：标记会话
   */
  async actionSessionFlag(context) {
    const { threatId, features, req } = context;
    const sessionId = features?.sessionId || req?.session?.id;
    
    if (!sessionId) {
      return { success: false, message: 'No session to flag' };
    }
    
    const flagKey = `threat:session_flag:${sessionId}`;
    await this.redis.setex(
      flagKey, 
      86400, // 24小时
      JSON.stringify({
        threatId,
        flaggedAt: Date.now(),
        reason: 'threat_detected'
      })
    );
    
    return { success: true, message: `Session ${sessionId} flagged` };
  }

  /**
   * 动作：撤销会话
   */
  async actionSessionRevoke(context) {
    const { threatId, features, req } = context;
    const sessionId = features?.sessionId || req?.session?.id;
    const userId = features?.userId || req?.user?.id;
    
    if (sessionId) {
      // 标记会话为已撤销
      const revokeKey = `threat:session_revoke:${sessionId}`;
      await this.redis.setex(
        revokeKey, 
        86400, 
        JSON.stringify({
          threatId,
          revokedAt: Date.now(),
          reason: 'critical_threat'
        })
      );
    }
    
    // 如果有用户ID，将该用户的所有会话标记为需要重新认证
    if (userId) {
      const userReauthKey = `threat:require_reauth:${userId}`;
      await this.redis.setex(userReauthKey, 86400, threatId);
    }
    
    this.stats.sessionsRevoked++;
    
    return { 
      success: true, 
      message: `Session ${sessionId} revoked, user ${userId} requires reauth` 
    };
  }

  /**
   * 动作：发送告警通知
   */
  async actionAlertNotify(context) {
    const { threatId, threatScore, threatLevel, ip, features } = context;
    
    // 发送告警（实际实现可能使用 Kafka、Webhook 等）
    const alert = {
      id: `alert-${Date.now()}`,
      threatId,
      threatLevel,
      threatScore,
      ip,
      timestamp: Date.now(),
      features: features ? {
        requestRate: features.requestRate,
        errorRate: features.errorRate,
        uniquePaths: features.uniquePaths
      } : {}
    };
    
    // 发布到告警通道
    if (this.redis) {
      await this.redis.publish('threat:alerts', JSON.stringify(alert));
    }
    
    this.logger.warn('[ThreatResponse] Threat alert issued', alert);
    
    return { success: true, message: 'Alert notification sent', alert };
  }

  /**
   * 动作：升级告警
   */
  async actionAlertEscalate(context) {
    const { threatId, threatScore, ip } = context;
    
    // 发送升级告警（通知安全团队）
    const escalation = {
      id: `escalation-${Date.now()}`,
      threatId,
      threatScore,
      ip,
      timestamp: Date.now(),
      severity: 'critical',
      requiresReview: true
    };
    
    if (this.redis) {
      await this.redis.publish('threat:escalations', JSON.stringify(escalation));
    }
    
    this.logger.error('[ThreatResponse] Threat escalated', escalation);
    
    return { success: true, message: 'Alert escalated', escalation };
  }

  /**
   * 动作：IP 临时封禁
   */
  async actionIpTempBan(context) {
    const { ip, threatId, threatScore, strategy } = context;
    const duration = strategy.banDuration || 900; // 默认15分钟
    
    // 添加到封禁列表
    const banKey = `${this.banKeyPrefix}${ip}`;
    await this.redis.setex(
      banKey, 
      duration, 
      JSON.stringify({
        threatId,
        threatScore,
        bannedAt: Date.now(),
        expiresAt: Date.now() + duration * 1000,
        reason: 'critical_threat_detected'
      })
    );
    
    this.stats.bansIssued++;
    
    this.logger.warn('[ThreatResponse] IP temporarily banned', {
      ip,
      duration,
      threatId,
      threatScore
    });
    
    return { 
      success: true, 
      message: `IP ${ip} banned for ${duration} seconds`,
      banDuration: duration
    };
  }

  /**
   * 动作：拒绝请求
   */
  async actionBlockRequest(context) {
    const { threatId, ip } = context;
    
    return { 
      success: true, 
      message: 'Request blocked',
      blocked: true,
      blockReason: `Critical threat detected: ${threatId}`,
      httpResponse: {
        status: 403,
        body: {
          error: 'Access Denied',
          message: 'Security policy violation detected',
          threatId
        }
      }
    };
  }

  /**
   * 检查 IP 是否被封禁
   * @param {string} ip - IP 地址
   * @returns {Promise<Object|null>} 封禁信息或 null
   */
  async checkBanStatus(ip) {
    const banKey = `${this.banKeyPrefix}${ip}`;
    const banData = await this.redis.get(banKey);
    
    if (banData) {
      return JSON.parse(banData);
    }
    
    return null;
  }

  /**
   * 手动解封 IP
   * @param {string} ip - IP 地址
   * @param {string} reason - 解封原因
   */
  async unbanIp(ip, reason = 'manual_unban') {
    const banKey = `${this.banKeyPrefix}${ip}`;
    await this.redis.del(banKey);
    
    this.logger.info('[ThreatResponse] IP unbanned', { ip, reason });
    
    return { success: true, message: `IP ${ip} unbanned` };
  }

  /**
   * 检查是否需要验证码挑战
   * @param {string} ip - IP 地址
   * @returns {Promise<Object|null>} 挑战信息或 null
   */
  async checkChallengeRequired(ip) {
    const challengeKey = `threat:challenge:${ip}`;
    const challengeData = await this.redis.get(challengeKey);
    
    if (challengeData) {
      return JSON.parse(challengeData);
    }
    
    return null;
  }

  /**
   * 验证验证码挑战
   * @param {string} ip - IP 地址
   * @param {string} token - 挑战令牌
   * @returns {Promise<boolean>} 是否验证通过
   */
  async verifyChallenge(ip, token) {
    const challengeData = await this.checkChallengeRequired(ip);
    
    if (!challengeData) {
      return { valid: false, reason: 'no_challenge' };
    }
    
    if (challengeData.token !== token) {
      // 增加尝试次数
      challengeData.attempts++;
      
      if (challengeData.attempts >= challengeData.maxAttempts) {
        // 超过最大尝试次数，触发封禁
        await this.actionIpTempBan({ 
          ip, 
          threatId: challengeData.threatId,
          strategy: { banDuration: 300 } // 5分钟
        });
        await this.redis.del(`threat:challenge:${ip}`);
        return { valid: false, reason: 'max_attempts_exceeded' };
      }
      
      await this.redis.setex(
        `threat:challenge:${ip}`, 
        300, 
        JSON.stringify(challengeData)
      );
      
      return { valid: false, reason: 'invalid_token', attemptsRemaining: challengeData.maxAttempts - challengeData.attempts };
    }
    
    // 验证通过，清除挑战
    await this.redis.del(`threat:challenge:${ip}`);
    
    return { valid: true, reason: 'challenge_passed' };
  }

  /**
   * 生成挑战令牌
   */
  generateChallengeToken(ip, threatId) {
    const crypto = require('crypto');
    return crypto
      .createHash('sha256')
      .update(`${ip}:${threatId}:${Date.now()}`)
      .digest('hex')
      .substring(0, 32);
  }

  /**
   * 获取客户端 IP
   */
  getClientIp(req) {
    return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers?.['x-real-ip'] ||
           req.connection?.remoteAddress ||
           'unknown';
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this.stats };
  }
}

module.exports = ThreatResponseExecutor;
