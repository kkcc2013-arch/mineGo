// backend/shared/UserQuotaManager.js
// REQ-00367: 用户分层配额管理系统

'use strict';

const { getRedis } = require('./redis');
const { createLogger } = require('./logger');
const { query } = require('./db');
const metrics = require('./metrics');

const logger = createLogger('user-quota-manager');

/**
 * 用户配额管理器
 * 支持多层级配额、动态调整、配额预警
 */
class UserQuotaManager {
  constructor(options = {}) {
    this.redis = getRedis();
    this.cachePrefix = 'user_quota:';
    this.cacheTTL = 300; // 5 分钟缓存

    // 层级配额定义
    this.tierQuotas = new Map();
    this.loadTierQuotas();
  }

  /**
   * 加载层级配额配置
   */
  async loadTierQuotas() {
    try {
      const result = await query(`
        SELECT tier_name, requests_per_day, requests_per_hour, requests_per_minute, priority_weight, features
        FROM user_tier_quotas
      `);

      for (const row of result.rows) {
        this.tierQuotas.set(row.tier_name, {
          requestsPerDay: row.requests_per_day,
          requestsPerHour: row.requests_per_hour,
          requestsPerMinute: row.requests_per_minute,
          priority: this.getPriorityForTier(row.tier_name),
          features: row.features
        });
      }

      logger.info({ tierCount: this.tierQuotas.size }, 'Tier quotas loaded');
    } catch (err) {
      logger.error({ err }, 'Failed to load tier quotas, using defaults');
      // 默认配置
      this.tierQuotas.set('free', { requestsPerDay: 1000, requestsPerHour: 100, requestsPerMinute: 20, priority: 'normal' });
      this.tierQuotas.set('premium', { requestsPerDay: 10000, requestsPerHour: 500, requestsPerMinute: 100, priority: 'high' });
      this.tierQuotas.set('vip', { requestsPerDay: 50000, requestsPerHour: 2000, requestsPerMinute: 400, priority: 'highest' });
    }
  }

  /**
   * 获取层级优先级
   */
  getPriorityForTier(tier) {
    const priorityMap = {
      free: 'normal',
      premium: 'high',
      vip: 'highest',
      svip: 'highest'
    };
    return priorityMap[tier] || 'normal';
  }

  /**
   * 获取用户配额
   */
  async getUserQuota(userId) {
    const cacheKey = `${this.cachePrefix}${userId}`;

    // 尝试从缓存获取
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn({ err, userId }, 'Cache read failed');
    }

    // 从数据库获取
    try {
      const result = await query(`
        SELECT 
          user_id, quota_level, daily_limit, hourly_limit, minute_limit,
          used_today, used_this_hour, used_this_minute,
          quota_multiplier, multiplier_reason, multiplier_expires_at,
          last_reset_date, last_reset_hour, last_reset_minute
        FROM user_quotas
        WHERE user_id = $1
      `, [userId]);

      let quota;
      if (result.rows.length === 0) {
        // 创建默认配额
        await this.createUserQuota(userId);
        quota = await this.getUserQuotaFromDb(userId);
      } else {
        quota = result.rows[0];
      }

      // 检查是否需要重置
      await this.resetIfNeeded(quota);

      // 获取层级配置
      const tierConfig = this.tierQuotas.get(quota.quota_level) || this.tierQuotas.get('free');

      const quotaInfo = {
        userId: quota.user_id,
        tier: quota.quota_level,
        dailyLimit: Math.floor((tierConfig?.requestsPerDay || quota.daily_limit) * quota.quota_multiplier),
        hourlyLimit: Math.floor((tierConfig?.requestsPerHour || quota.hourly_limit) * quota.quota_multiplier),
        minuteLimit: Math.floor((tierConfig?.requestsPerMinute || quota.minute_limit) * quota.quota_multiplier),
        dailyUsed: quota.used_today,
        hourlyUsed: quota.used_this_hour,
        minuteUsed: quota.used_this_minute,
        dailyRemaining: Math.max(0, (tierConfig?.requestsPerDay || quota.daily_limit) - quota.used_today),
        hourlyRemaining: Math.max(0, (tierConfig?.requestsPerHour || quota.hourly_limit) - quota.used_this_hour),
        minuteRemaining: Math.max(0, (tierConfig?.requestsPerMinute || quota.minute_limit) - quota.used_this_minute),
        priority: tierConfig?.priority || 'normal',
        features: tierConfig?.features || {},
        quotaMultiplier: quota.quota_multiplier,
        multiplierReason: quota.multiplier_reason,
        multiplierExpiresAt: quota.multiplier_expires_at
      };

      // 缓存
      try {
        await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(quotaInfo));
      } catch (err) {
        logger.warn({ err, userId }, 'Cache write failed');
      }

      return quotaInfo;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to get user quota');
      throw err;
    }
  }

  /**
   * 从数据库获取配额
   */
  async getUserQuotaFromDb(userId) {
    const result = await query(`
      SELECT * FROM user_quotas WHERE user_id = $1
    `, [userId]);
    return result.rows[0];
  }

  /**
   * 重置过期配额
   */
  async resetIfNeeded(quota) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    let needsUpdate = false;
    const updates = {};

    if (quota.last_reset_date !== today) {
      updates.used_today = 0;
      updates.last_reset_date = today;
      needsUpdate = true;
    }

    if (quota.last_reset_hour !== currentHour) {
      updates.used_this_hour = 0;
      updates.last_reset_hour = currentHour;
      needsUpdate = true;
    }

    if (quota.last_reset_minute !== currentMinute) {
      updates.used_this_minute = 0;
      updates.last_reset_minute = currentMinute;
      needsUpdate = true;
    }

    if (quota.multiplier_expires_at && new Date(quota.multiplier_expires_at) < now) {
      updates.quota_multiplier = 1.0;
      updates.multiplier_reason = null;
      updates.multiplier_expires_at = null;
      needsUpdate = true;
    }

    if (needsUpdate) {
      const setClauses = [];
      const values = [quota.user_id];
      let paramIndex = 2;

      for (const [key, value] of Object.entries(updates)) {
        setClauses.push(`${this.toSnakeCase(key)} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }

      await query(`
        UPDATE user_quotas SET ${setClauses.join(', ')}
        WHERE user_id = $1
      `, values);

      // 清除缓存
      await this.redis.del(`${this.cachePrefix}${quota.user_id}`);
    }
  }

  /**
   * 创建用户配额
   */
  async createUserQuota(userId, tier = 'free') {
    const tierConfig = this.tierQuotas.get(tier) || this.tierQuotas.get('free');
    const now = new Date();

    await query(`
      INSERT INTO user_quotas (
        user_id, quota_level, daily_limit, hourly_limit, minute_limit,
        used_today, used_this_hour, used_this_minute,
        quota_multiplier, last_reset_date, last_reset_hour, last_reset_minute
      ) VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 1.0, $6, $7, $8)
      ON CONFLICT (user_id) DO UPDATE SET
        quota_level = $2,
        daily_limit = $3,
        hourly_limit = $4,
        minute_limit = $5
    `, [
      userId, tier,
      tierConfig.requestsPerDay, tierConfig.requestsPerHour, tierConfig.requestsPerMinute,
      now.toISOString().split('T')[0], now.getHours(), now.getMinutes()
    ]);

    logger.info({ userId, tier }, 'User quota created');
  }

  /**
   * 增加使用量
   */
  async incrementUsage(userId, endpoint) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const result = await query(`
      UPDATE user_quotas SET
        used_today = used_today + 1,
        used_this_hour = used_this_hour + 1,
        used_this_minute = used_this_minute + 1,
        last_reset_date = $2,
        last_reset_hour = $3,
        last_reset_minute = $4
      WHERE user_id = $1
      RETURNING used_today, used_this_hour, used_this_minute, quota_multiplier, daily_limit, hourly_limit, minute_limit
    `, [userId, today, currentHour, currentMinute]);

    if (result.rows.length > 0) {
      // 清除缓存
      await this.redis.del(`${this.cachePrefix}${userId}`);
      return result.rows[0];
    }

    return null;
  }

  /**
   * 动态调整用户配额
   */
  async adjustQuota(userId, adjustment, reason, details = {}) {
    const expiresAt = details.duration ? new Date(Date.now() + this.parseDuration(details.duration)) : null;

    // 插入调整记录
    await query(`
      INSERT INTO quota_adjustments (user_id, adjustment, reason, details)
      VALUES ($1, $2, $3, $4)
    `, [userId, adjustment, reason, JSON.stringify(details)]);

    // 更新用户配额系数
    if (adjustment !== 0) {
      await query(`
        UPDATE user_quotas SET
          quota_multiplier = GREATEST(0.1, LEAST(2.0, quota_multiplier + $2)),
          multiplier_reason = $3,
          multiplier_expires_at = COALESCE($4, multiplier_expires_at)
        WHERE user_id = $1
      `, [userId, adjustment * 0.1, reason, expiresAt]);
    }

    // 清除缓存
    await this.redis.del(`${this.cachePrefix}${userId}`);

    logger.info({
      userId,
      adjustment,
      reason,
      expiresAt
    }, 'User quota adjusted');

    return {
      userId,
      adjustment,
      reason,
      expiresAt
    };
  }

  /**
   * 配额预警检测
   */
  async checkQuotaWarning(userId) {
    const quota = await this.getUserQuota(userId);
    const dailyUsagePercentage = (quota.dailyUsed / quota.dailyLimit) * 100;
    const hourlyUsagePercentage = (quota.hourlyUsed / quota.hourlyLimit) * 100;

    const warnings = [];

    // 日配额预警
    if (dailyUsagePercentage >= 90) {
      warnings.push({
        level: 'critical',
        type: 'daily_exhaustion',
        message: '日配额即将用尽',
        usagePercentage: dailyUsagePercentage,
        recommendation: '请立即升级套餐或减少使用频率'
      });

      // 记录预警
      await this.recordWarning(userId, 'daily_exhaustion', 'critical', 
        '日配额即将用尽', dailyUsagePercentage, '请立即升级套餐或减少使用频率');
    } else if (dailyUsagePercentage >= 80) {
      warnings.push({
        level: 'warning',
        type: 'daily_high',
        message: '日配额使用已超过 80%',
        usagePercentage: dailyUsagePercentage,
        recommendation: '建议升级至 Premium 套餐或等待配额重置'
      });

      await this.recordWarning(userId, 'daily_high', 'warning',
        '日配额使用已超过 80%', dailyUsagePercentage, '建议升级至 Premium 套餐');
    }

    // 小时配额预警
    if (hourlyUsagePercentage >= 90) {
      warnings.push({
        level: 'high',
        type: 'hourly_exhaustion',
        message: '小时配额即将用尽',
        usagePercentage: hourlyUsagePercentage,
        recommendation: '建议等待当前小时重置'
      });
    }

    return {
      userId,
      dailyUsagePercentage,
      hourlyUsagePercentage,
      warnings,
      quota
    };
  }

  /**
   * 记录预警
   */
  async recordWarning(userId, warningType, severity, message, usagePercentage, recommendation) {
    try {
      await query(`
        INSERT INTO quota_warnings (user_id, warning_type, severity, message, usage_percentage, recommendation)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [userId, warningType, severity, message, usagePercentage, recommendation]);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to record warning');
    }
  }

  /**
   * 解析持续时间
   */
  parseDuration(duration) {
    if (typeof duration === 'number') return duration;
    const match = duration.match(/^(\d+)([dhm])$/);
    if (!match) return 24 * 60 * 60 * 1000;

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 'd': return value * 24 * 60 * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'm': return value * 60 * 1000;
      default: return value;
    }
  }

  /**
   * 转换为蛇形命名
   */
  toSnakeCase(str) {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }

  /**
   * 获取配额状态摘要
   */
  async getQuotaStatus(userId) {
    const quota = await this.getUserQuota(userId);
    const warnings = await this.checkQuotaWarning(userId);

    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const endOfHour = new Date(now);
    endOfHour.setMinutes(59, 59, 999);

    return {
      ...quota,
      warnings: warnings.warnings,
      resetIn: {
        daily: this.formatDuration(endOfDay - now),
        hourly: this.formatDuration(endOfHour - now),
        minute: this.formatDuration(60000 - (now.getSeconds() * 1000 + now.getMilliseconds()))
      }
    };
  }

  /**
   * 格式化持续时间
   */
  formatDuration(ms) {
    const hours = Math.floor(ms / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    const seconds = Math.floor((ms % (60 * 1000)) / 1000);

    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
}

// 单例
const userQuotaManager = new UserQuotaManager();

module.exports = {
  UserQuotaManager,
  userQuotaManager
};