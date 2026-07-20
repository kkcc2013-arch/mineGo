'use strict';

/**
 * 威胁检测控制器
 * 处理威胁事件上报、查询、反馈等 API
 */

class ThreatDetectionController {
  constructor(config = {}) {
    this.redis = config.redis;
    this.db = config.db;
    this.logger = config.logger || console;
    this.engine = config.engine;
    this.executor = config.executor;
  }

  /**
   * 处理威胁事件上报
   * POST /api/security/threat/report
   */
  async report(req, res) {
    try {
      const { eventType, data, deviceFingerprint, timestamp } = req.body;
      const userId = req.user?.id;
      const ip = this.getClientIp(req);
      
      // 验证请求
      if (!eventType || !timestamp) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'eventType and timestamp are required'
        });
      }
      
      // 计算风险分数
      const riskScore = this.calculateRiskScore(eventType, data);
      
      // 存储威胁事件
      const threatId = `threat-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
      
      const event = {
        threat_id: threatId,
        source_ip: ip,
        user_id: userId,
        threat_score: riskScore,
        threat_level: this.getLevelFromScore(riskScore),
        features: {
          eventType,
          data,
          deviceFingerprint,
          clientTimestamp: timestamp
        },
        created_at: new Date()
      };
      
      // 存入数据库
      await this.db.query(
        `INSERT INTO threat_events 
         (threat_id, source_ip, user_id, threat_score, threat_level, features, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.threat_id, event.source_ip, event.user_id, event.threat_score, 
         event.threat_level, JSON.stringify(event.features), event.created_at]
      );
      
      // 高风险事件触发风控
      if (riskScore >= 80) {
        await this.triggerRiskControl(userId, event);
      }
      
      res.json({
        success: true,
        threatId,
        riskScore,
        action: riskScore >= 80 ? 'restricted' : 'none'
      });
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Report error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to process threat report'
      });
    }
  }

  /**
   * 获取威胁检测配置
   * GET /api/security/threat/config
   */
  async getConfig(req, res) {
    try {
      const config = {
        enabled: true,
        sensitivityLevel: 'medium',
        challengeThreshold: 50,
        blockThreshold: 70,
        banDuration: 900,
        features: {
          rateLimit: true,
          captcha: true,
          ipBlocking: true
        }
      };
      
      res.json(config);
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Get config error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to get config'
      });
    }
  }

  /**
   * 查询威胁事件
   * GET /api/security/threat/events
   */
  async getEvents(req, res) {
    try {
      const { ip, level, startDate, endDate, limit = 50, offset = 0 } = req.query;
      
      let query = 'SELECT * FROM threat_events WHERE 1=1';
      const params = [];
      
      if (ip) {
        params.push(ip);
        query += ` AND source_ip = $${params.length}`;
      }
      
      if (level) {
        params.push(level);
        query += ` AND threat_level = $${params.length}`;
      }
      
      if (startDate) {
        params.push(startDate);
        query += ` AND created_at >= $${params.length}`;
      }
      
      if (endDate) {
        params.push(endDate);
        query += ` AND created_at <= $${params.length}`;
      }
      
      params.push(limit);
      query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
      
      params.push(offset);
      query += ` OFFSET $${params.length}`;
      
      const result = await this.db.query(query, params);
      
      res.json({
        events: result.rows,
        pagination: {
          limit,
          offset,
          total: result.rows.length
        }
      });
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Get events error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to get events'
      });
    }
  }

  /**
   * 提交威胁反馈
   * POST /api/security/threat/feedback
   */
  async submitFeedback(req, res) {
    try {
      const { threatId, label, comment } = req.body;
      const reviewerId = req.user?.id;
      
      if (!threatId || !label) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'threatId and label are required'
        });
      }
      
      const validLabels = ['true_positive', 'false_positive', 'unknown'];
      if (!validLabels.includes(label)) {
        return res.status(400).json({
          error: 'BadRequest',
          message: `label must be one of: ${validLabels.join(', ')}`
        });
      }
      
      // 更新威胁事件
      await this.db.query(
        `UPDATE threat_events 
         SET feedback_label = $1, feedback_comment = $2, feedback_by = $3, feedback_at = NOW()
         WHERE threat_id = $4`,
        [label, comment, reviewerId, threatId]
      );
      
      // 记录反馈历史
      await this.db.query(
        `INSERT INTO threat_feedback_history (threat_id, label, comment, reviewer_id)
         VALUES ($1, $2, $3, $4)`,
        [threatId, label, comment, reviewerId]
      );
      
      res.json({
        success: true,
        threatId,
        label,
        message: 'Feedback submitted successfully'
      });
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Feedback error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to submit feedback'
      });
    }
  }

  /**
   * 获取 IP 封禁状态
   * GET /api/security/threat/ban/:ip
   */
  async getBanStatus(req, res) {
    try {
      const { ip } = req.params;
      
      const result = await this.db.query(
        `SELECT * FROM ip_bans WHERE ip_address = $1 AND is_active = TRUE`,
        [ip]
      );
      
      if (result.rows.length === 0) {
        return res.json({
          banned: false,
          ip
        });
      }
      
      const ban = result.rows[0];
      
      res.json({
        banned: true,
        ip: ban.ip_address,
        reason: ban.reason,
        threatId: ban.threat_id,
        bannedAt: ban.banned_at,
        expiresAt: ban.expires_at,
        remainingSeconds: Math.max(0, Math.ceil((new Date(ban.expires_at) - new Date()) / 1000))
      });
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Get ban status error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to get ban status'
      });
    }
  }

  /**
   * 手动封禁 IP
   * POST /api/security/threat/ban
   */
  async banIp(req, res) {
    try {
      const { ip, duration, reason } = req.body;
      const bannedBy = req.user?.id || 'admin';
      
      if (!ip || !duration || !reason) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'ip, duration, and reason are required'
        });
      }
      
      const expiresAt = new Date(Date.now() + duration * 1000);
      
      await this.db.query(
        `INSERT INTO ip_bans (ip_address, reason, banned_at, expires_at, banned_by)
         VALUES ($1, $2, NOW(), $3, $4)
         ON CONFLICT (ip_address) 
         DO UPDATE SET reason = $2, expires_at = $3, banned_by = $4, is_active = TRUE, unbanned_at = NULL`,
        [ip, reason, expiresAt, bannedBy]
      );
      
      // 同步到 Redis
      await this.redis.setex(`threat:ban:${ip}`, duration, JSON.stringify({
        reason,
        bannedAt: Date.now(),
        expiresAt: expiresAt.getTime()
      }));
      
      res.json({
        success: true,
        ip,
        reason,
        duration,
        expiresAt: expiresAt.toISOString()
      });
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Ban IP error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to ban IP'
      });
    }
  }

  /**
   * 解除 IP 封禁
   * DELETE /api/security/threat/ban/:ip
   */
  async unbanIp(req, res) {
    try {
      const { ip } = req.params;
      const unbannedBy = req.user?.id || 'admin';
      
      await this.db.query(
        `UPDATE ip_bans SET is_active = FALSE, unbanned_at = NOW(), unbanned_by = $1 WHERE ip_address = $2`,
        [unbannedBy, ip]
      );
      
      // 从 Redis 移除
      await this.redis.del(`threat:ban:${ip}`);
      
      res.json({
        success: true,
        ip,
        message: 'IP unbanned successfully'
      });
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Unban IP error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to unban IP'
      });
    }
  }

  /**
   * 获取威胁统计
   * GET /api/security/threat/stats
   */
  async getStats(req, res) {
    try {
      const stats = {
        engine: this.engine?.getStats() || {},
        executor: this.executor?.getStats() || {}
      };
      
      // 数据库统计
      const dbStats = await this.db.query(
        `SELECT 
          threat_level,
          COUNT(*) as count,
          AVG(threat_score) as avg_score
         FROM threat_events
         WHERE created_at > NOW() - INTERVAL '24 hours'
         GROUP BY threat_level`
      );
      
      stats.database = dbStats.rows.reduce((acc, row) => {
        acc[row.threat_level] = {
          count: parseInt(row.count),
          avgScore: parseFloat(row.avg_score).toFixed(2)
        };
        return acc;
      }, {});
      
      res.json(stats);
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Get stats error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to get stats'
      });
    }
  }

  /**
   * 验证验证码
   * POST /api/security/captcha/verify
   */
  async verifyCaptcha(req, res) {
    try {
      const { token, challengeToken } = req.body;
      const ip = this.getClientIp(req);
      
      if (!token || !challengeToken) {
        return res.status(400).json({
          error: 'BadRequest',
          message: 'token and challengeToken are required'
        });
      }
      
      // 这里应该调用实际的验证码验证服务
      // 简化实现：直接验证
      const isValid = await this.verifyCaptchaToken(token, challengeToken);
      
      if (isValid) {
        // 清除挑战状态
        await this.redis.del(`threat:challenge:${ip}`);
        
        res.json({
          success: true,
          message: 'Captcha verified successfully'
        });
      } else {
        res.status(400).json({
          success: false,
          message: 'Captcha verification failed'
        });
      }
      
    } catch (error) {
      this.logger.error('[ThreatDetectionController] Captcha verify error:', error);
      res.status(500).json({
        error: 'InternalError',
        message: 'Failed to verify captcha'
      });
    }
  }

  /**
   * 计算风险分数
   */
  calculateRiskScore(eventType, data) {
    const baseScores = {
      'scanner_detected': 90,
      'debugger_detected': 95,
      'memory_tampered': 85,
      'timing_anomaly': 60,
      'code_tampered': 100,
      'ptrace_attached': 95,
      'behavior_anomaly': 70,
      'rate_limit_exceeded': 50,
      'auth_failure': 40
    };
    
    let score = baseScores[eventType] || 50;
    
    // 根据数据调整
    if (data?.scanCount > 10) score += 10;
    if (data?.persistDuration > 30000) score += 15;
    if (data?.repeatCount > 3) score += 10;
    
    return Math.min(score, 100);
  }

  /**
   * 根据分数获取等级
   */
  getLevelFromScore(score) {
    if (score >= 70) return 'critical';
    if (score >= 50) return 'threat';
    if (score >= 30) return 'suspicious';
    return 'normal';
  }

  /**
   * 触发风控措施
   */
  async triggerRiskControl(userId, event) {
    this.logger.warn('[ThreatDetectionController] Risk control triggered', {
      userId,
      threatId: event.threat_id,
      riskScore: event.threat_score
    });
    
    // 发布风控事件
    await this.redis.publish('risk:control', JSON.stringify({
      userId,
      threatId: event.threat_id,
      riskScore: event.threat_score,
      eventType: event.features.eventType,
      timestamp: Date.now()
    }));
  }

  /**
   * 验证验证码令牌（简化实现）
   */
  async verifyCaptchaToken(token, challengeToken) {
    // 实际实现应该调用验证码服务
    // 这里简化为检查令牌有效性
    return token && token.length > 10;
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
}

module.exports = ThreatDetectionController;