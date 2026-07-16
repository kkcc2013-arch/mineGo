'use strict';

/**
 * 位置欺骗反制系统
 * REQ-00586: GPS 位置欺骗检测与虚拟定位防护系统
 * 
 * 根据风险等级执行分级反制措施
 */

const { query } = require('../../shared/db');
const { getRedis, setJSON, getJSON } = require('../../shared/redis');
const { createLogger } = require('../../shared/logger');
const metrics = require('../../shared/metrics');

const logger = createLogger('location-spoof-response');

// 反制措施持续时间
const DURATIONS = {
  MONITOR: null,
  RESTRICT: 24 * 60 * 60 * 1000,     // 24 小时
  SUSPEND: 7 * 24 * 60 * 60 * 1000,  // 7 天
  BAN: null                             // 永久
};

// 违规阈值
const VIOLATION_THRESHOLDS = {
  PERMANENT_BAN: 3  // 3 次严重违规永久封禁
};

class LocationSpoofResponse {
  constructor() {
    this.redis = null;
  }

  async init() {
    this.redis = await getRedis();
    logger.info('LocationSpoofResponse initialized');
  }

  /**
   * 根据风险评分执行反制措施
   */
  async executeCountermeasure(userId, riskScore, evidence) {
    const level = this.getRiskLevel(riskScore);

    logger.info({
      userId,
      riskScore,
      level
    }, 'Executing countermeasure');

    try {
      let result;

      switch (level) {
        case 'LOW':
          result = await this.lowRiskResponse(userId, evidence);
          break;
        case 'MEDIUM':
          result = await this.mediumRiskResponse(userId, evidence);
          break;
        case 'HIGH':
          result = await this.highRiskResponse(userId, evidence);
          break;
        case 'CRITICAL':
          result = await this.criticalRiskResponse(userId, evidence);
          break;
        default:
          result = await this.lowRiskResponse(userId, evidence);
      }

      // 记录反制措施
      await this.recordAction(userId, result, evidence);

      // 更新指标
      metrics.increment('location_spoof_actions_total', 1, { action: result.action });

      return result;
    } catch (error) {
      logger.error({ error, userId, riskScore }, 'Countermeasure execution failed');
      return { action: 'monitor', error: error.message };
    }
  }

  /**
   * 低风险响应（30分以下）：监控与记录
   */
  async lowRiskResponse(userId, evidence) {
    await this.addToWatchlist(userId, evidence);
    await this.logSuspiciousActivity(userId, 'location_spoofing_low', evidence);

    return {
      action: 'monitor',
      level: 'LOW',
      duration: DURATIONS.MONITOR,
      message: 'Location activity monitored'
    };
  }

  /**
   * 中风险响应（30-50分）：位置功能降级
   */
  async mediumRiskResponse(userId, evidence) {
    // 降级措施
    const restrictions = {
      rareSpawnPenalty: 0.5,   // 稀有精灵概率降低 50%
      gymAccess: false,         // 禁止攻击道馆
      pokestopBonus: 0.5,      // Pokestop 奖励减少 50%
      tradeRestricted: true     // 交易受限
    };

    await this.applyLocationRestrictions(userId, restrictions);
    await this.sendWarningNotification(userId, 'location_verification_required');
    await this.logSuspiciousActivity(userId, 'location_spoofing_medium', evidence);

    return {
      action: 'restrict',
      level: 'MEDIUM',
      duration: DURATIONS.RESTRICT,
      restrictions,
      message: 'Location features restricted due to suspicious activity'
    };
  }

  /**
   * 高风险响应（50-70分）：临时封禁
   */
  async highRiskResponse(userId, evidence) {
    const restrictions = {
      catch: false,             // 禁止捕捉
      gym: false,               // 禁止道馆
      trade: false,             // 禁止交易
      social: 'limited',        // 社交受限
      pokestop: false,          // 禁止 Pokestop
      raid: false               // 禁止 Raid
    };

    await this.applyTemporaryBan(userId, {
      duration: DURATIONS.SUSPEND,
      restrictions,
      reason: 'suspected_location_spoofing'
    });

    await this.requestManualReview(userId, evidence);
    await this.logSuspiciousActivity(userId, 'location_spoofing_high', evidence);

    return {
      action: 'suspend',
      level: 'HIGH',
      duration: DURATIONS.SUSPEND,
      restrictions,
      message: 'Account suspended for 7 days due to suspected location spoofing'
    };
  }

  /**
   * 极高风险响应（70分以上）：永久封禁或长时封禁
   */
  async criticalRiskResponse(userId, evidence) {
    const violations = await this.getViolationHistory(userId);

    if (violations.count >= VIOLATION_THRESHOLDS.PERMANENT_BAN) {
      // 多次违规：永久封禁
      await this.applyPermanentBan(userId, {
        reason: 'repeated_location_spoofing',
        evidence: await this.collectFullEvidence(userId, evidence),
        appealable: true
      });

      await this.logSuspiciousActivity(userId, 'location_spoofing_permanent_ban', evidence);

      return {
        action: 'ban',
        level: 'CRITICAL',
        duration: 'permanent',
        message: 'Account permanently banned for repeated location spoofing'
      };
    }

    // 首次极高风险：长时封禁（30 天）
    const duration = 30 * 24 * 60 * 60 * 1000;
    await this.applyTemporaryBan(userId, {
      duration,
      restrictions: {
        catch: false,
        gym: false,
        trade: false,
        social: false,
        pokestop: false,
        raid: false
      },
      reason: 'critical_location_spoofing'
    });

    await this.requestManualReview(userId, evidence);
    await this.logSuspiciousActivity(userId, 'location_spoofing_critical', evidence);

    return {
      action: 'suspend',
      level: 'CRITICAL',
      duration,
      message: 'Account suspended for 30 days due to critical location spoofing'
    };
  }

  /**
   * 添加到监控列表
   */
  async addToWatchlist(userId, evidence) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:watchlist:${userId}`;
      await this.redis.set(key, JSON.stringify({
        userId,
        addedAt: Date.now(),
        evidence: evidence ? JSON.stringify(evidence).substring(0, 1000) : null,
        checkCount: 1
      }), 'EX', 86400 * 30); // 30 天

      // 同时添加到监控集合
      await this.redis.sadd('location:watchlist:users', userId);
    } catch (error) {
      logger.error({ error, userId }, 'Failed to add to watchlist');
    }
  }

  /**
   * 应用位置限制
   */
  async applyLocationRestrictions(userId, restrictions) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:restrictions:${userId}`;
      await this.redis.set(key, JSON.stringify({
        restrictions,
        appliedAt: Date.now(),
        expiresAt: Date.now() + DURATIONS.RESTRICT
      }), 'EX', DURATIONS.RESTRICT / 1000);

      logger.info({ userId, restrictions }, 'Location restrictions applied');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to apply location restrictions');
    }
  }

  /**
   * 获取用户当前限制
   */
  async getRestrictions(userId) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:restrictions:${userId}`;
      const data = await getJSON(this.redis, key);
      return data;
    } catch (error) {
      return null;
    }
  }

  /**
   * 应用临时封禁
   */
  async applyTemporaryBan(userId, options) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:ban:${userId}`;
      await this.redis.set(key, JSON.stringify({
        userId,
        type: 'temporary',
        reason: options.reason,
        restrictions: options.restrictions,
        startedAt: Date.now(),
        expiresAt: Date.now() + options.duration
      }), 'EX', options.duration / 1000);

      // 记录违规次数
      const violationKey = `location:violations:${userId}`;
      await this.redis.incr(violationKey);
      await this.redis.expire(violationKey, 86400 * 90); // 90 天内累计

      // 写入数据库
      try {
        await query(`
          INSERT INTO location_spoof_bans
          (user_id, ban_type, reason, evidence, duration_ms, start_at, end_at, created_at)
          VALUES ($1, $2, $3, $4, $5, NOW(), NOW() + INTERVAL '1 millisecond' * $5, NOW())
        `, [
          userId,
          'suspend',
          options.reason,
          JSON.stringify(options.restrictions),
          options.duration
        ]);
      } catch (dbError) {
        logger.debug({ error: dbError.message }, 'DB write skipped for temporary ban');
      }

      logger.info({
        userId,
        duration: options.duration,
        reason: options.reason
      }, 'Temporary ban applied');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to apply temporary ban');
    }
  }

  /**
   * 应用永久封禁
   */
  async applyPermanentBan(userId, options) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:ban:${userId}`;
      await this.redis.set(key, JSON.stringify({
        userId,
        type: 'permanent',
        reason: options.reason,
        evidence: options.evidence,
        appealable: options.appealable,
        startedAt: Date.now()
      }));

      // 写入数据库
      try {
        await query(`
          INSERT INTO location_spoof_bans
          (user_id, ban_type, reason, evidence, duration_ms, start_at, created_at)
          VALUES ($1, $2, $3, $4, NULL, NOW(), NOW())
        `, [
          userId,
          'ban',
          options.reason,
          JSON.stringify(options.evidence)
        ]);
      } catch (dbError) {
        logger.debug({ error: dbError.message }, 'DB write skipped for permanent ban');
      }

      logger.warn({ userId, reason: options.reason }, 'Permanent ban applied');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to apply permanent ban');
    }
  }

  /**
   * 发送警告通知
   */
  async sendWarningNotification(userId, type) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:warning:${userId}`;
      const warningCount = await this.redis.incr(key);
      await this.redis.expire(key, 86400 * 30);

      // 通过 Kafka 发送通知事件
      const notification = {
        type: 'location_spoof_warning',
        userId,
        warningCount,
        message: this.getWarningMessage(type, warningCount),
        timestamp: Date.now()
      };

      // 发布到通知频道
      await this.redis.publish('notifications:location', JSON.stringify(notification));

      logger.info({ userId, type, warningCount }, 'Warning notification sent');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to send warning notification');
    }
  }

  /**
   * 获取警告消息
   */
  getWarningMessage(type, count) {
    const messages = {
      location_verification_required: [
        '您的位置数据存在异常，部分功能暂时受限。',
        '检测到位置异常，请确保使用真实位置。',
        '多次位置异常，账户可能被临时封禁。'
      ]
    };

    const list = messages[type] || messages.location_verification_required;
    const index = Math.min(count - 1, list.length - 1);
    return list[index] || list[list.length - 1];
  }

  /**
   * 请求人工审核
   */
  async requestManualReview(userId, evidence) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:review_queue`;
      await this.redis.lpush(key, JSON.stringify({
        userId,
        evidence,
        requestedAt: Date.now(),
        status: 'pending'
      }));

      logger.info({ userId }, 'Manual review requested');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to request manual review');
    }
  }

  /**
   * 获取违规历史
   */
  async getViolationHistory(userId) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:violations:${userId}`;
      const count = parseInt(await this.redis.get(key) || '0', 10);
      return { count };
    } catch (error) {
      return { count: 0 };
    }
  }

  /**
   * 收集完整证据
   */
  async collectFullEvidence(userId, initialEvidence) {
    return {
      initial: initialEvidence,
      timestamp: Date.now(),
      source: 'location_spoof_response'
    };
  }

  /**
   * 记录反制措施
   */
  async recordAction(userId, result, evidence) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:actions:${userId}`;
      await this.redis.lpush(key, JSON.stringify({
        action: result.action,
        level: result.level,
        duration: result.duration,
        evidence: evidence ? JSON.stringify(evidence).substring(0, 500) : null,
        timestamp: Date.now()
      }));
      await this.redis.ltrim(key, 0, 49); // 保留最近 50 条
    } catch (error) {
      logger.error({ error, userId }, 'Failed to record action');
    }
  }

  /**
   * 记录可疑活动
   */
  async logSuspiciousActivity(userId, type, evidence) {
    logger.warn({
      userId,
      type,
      evidence: evidence ? JSON.stringify(evidence).substring(0, 200) : null
    }, 'Suspicious location activity logged');
  }

  /**
   * 获取风险等级
   */
  getRiskLevel(score) {
    if (score >= 70) return 'CRITICAL';
    if (score >= 50) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * 检查用户是否被封禁
   */
  async isBanned(userId) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:ban:${userId}`;
      const data = await this.redis.get(key);

      if (!data) return { banned: false };

      const ban = JSON.parse(data);

      // 检查是否过期
      if (ban.type === 'temporary' && ban.expiresAt && ban.expiresAt < Date.now()) {
        await this.redis.del(key);
        return { banned: false };
      }

      return {
        banned: true,
        type: ban.type,
        reason: ban.reason,
        expiresAt: ban.expiresAt
      };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to check ban status');
      return { banned: false };
    }
  }

  /**
   * 解除封禁（管理操作）
   */
  async liftBan(userId, liftedBy, reason) {
    try {
      if (!this.redis) this.redis = await getRedis();

      const key = `location:ban:${userId}`;
      await this.redis.del(key);

      logger.info({ userId, liftedBy, reason }, 'Ban lifted');
      return { success: true };
    } catch (error) {
      logger.error({ error, userId }, 'Failed to lift ban');
      return { success: false, error: error.message };
    }
  }
}

// 导出单例
const locationSpoofResponse = new LocationSpoofResponse();
module.exports = {
  LocationSpoofResponse,
  locationSpoofResponse,
  DURATIONS,
  VIOLATION_THRESHOLDS
};