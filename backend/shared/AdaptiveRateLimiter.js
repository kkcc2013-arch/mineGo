// backend/shared/AdaptiveRateLimiter.js
// REQ-00098: 自适应 API 限流与用户配额管理系统

'use strict';

const { getRedis } = require('./redis');
const { createLogger } = require('./logger');
const metrics = require('./metrics');
const { query } = require('./db');

const logger = createLogger('adaptive-rate-limiter');

/**
 * 自适应限流器
 * 根据系统负载动态调整限流阈值
 */
class AdaptiveRateLimiter {
  constructor(config = {}) {
    this.config = {
      checkIntervalMs: config.checkIntervalMs || 5000, // 5秒检查一次
      cooldownMs: config.cooldownMs || 10000, // 调整后冷却时间
      minLoadFactor: config.minLoadFactor || 0.3,
      maxLoadFactor: config.maxLoadFactor || 1.5,
      ...config
    };

    // 系统指标阈值
    this.thresholds = {
      cpu: { low: 50, medium: 70, high: 90 },
      memory: { low: 60, medium: 80, high: 90 },
      responseTime: { low: 200, medium: 500, high: 1000 }
    };

    // 当前状态
    this.currentLoadFactor = 1.0;
    this.systemLoadScore = 0;
    this.lastAdjustmentTime = 0;
    this.isAdjusting = false;

    // API 分级配置缓存
    this.tierConfigs = new Map();
    this.lastConfigRefresh = 0;
    this.configRefreshInterval = 60000; // 1分钟刷新一次

    // Prometheus 指标
    this.registerMetrics();
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    // 系统负载分数
    if (!metrics.register.getSingleMetric('adaptive_rate_limit_load_score')) {
      metrics.register.registerMetric(
        new metrics.promClient.Gauge({
          name: 'adaptive_rate_limit_load_score',
          help: 'Current system load score (0-100)',
          labelNames: ['service']
        })
      );
    }

    // 当前负载因子
    if (!metrics.register.getSingleMetric('adaptive_rate_limit_factor')) {
      metrics.register.registerMetric(
        new metrics.promClient.Gauge({
          name: 'adaptive_rate_limit_factor',
          help: 'Current rate limit load factor',
          labelNames: ['service']
        })
      );
    }

    // 限流触发次数
    if (!metrics.register.getSingleMetric('rate_limit_triggered_total')) {
      metrics.register.registerMetric(
        new metrics.promClient.Counter({
          name: 'rate_limit_triggered_total',
          help: 'Total rate limit triggers',
          labelNames: ['api_pattern', 'tier', 'user_level']
        })
      );
    }

    // 配额调整次数
    if (!metrics.register.getSingleMetric('quota_adjustments_total')) {
      metrics.register.registerMetric(
        new metrics.promClient.Counter({
          name: 'quota_adjustments_total',
          help: 'Total quota adjustments',
          labelNames: ['user_id', 'reason', 'action']
        })
      );
    }
  }

  /**
   * 刷新 API 分级配置
   */
  async refreshTierConfigs() {
    const now = Date.now();
    if (now - this.lastConfigRefresh < this.configRefreshInterval) {
      return;
    }

    try {
      const result = await query(`
        SELECT api_pattern, tier, base_limit_per_minute, burst_limit, enabled
        FROM api_tier_configs
        WHERE enabled = true
      `);

      this.tierConfigs.clear();
      for (const row of result.rows) {
        this.tierConfigs.set(row.api_pattern, {
          tier: row.tier,
          baseLimit: row.base_limit_per_minute,
          burstLimit: row.burst_limit
        });
      }

      this.lastConfigRefresh = now;
      logger.debug({ count: this.tierConfigs.size }, 'Tier configs refreshed');
    } catch (err) {
      logger.error({ err }, 'Failed to refresh tier configs');
    }
  }

  /**
   * 匹配 API 模式
   */
  matchApiPattern(apiPath) {
    // 精确匹配
    if (this.tierConfigs.has(apiPath)) {
      return this.tierConfigs.get(apiPath);
    }

    // 通配符匹配
    for (const [pattern, config] of this.tierConfigs) {
      if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -2);
        if (apiPath.startsWith(prefix)) {
          return config;
        }
      }
    }

    // 默认配置
    return {
      tier: 'normal',
      baseLimit: 100,
      burstLimit: 150
    };
  }

  /**
   * 计算系统负载分数（0-100）
   */
  calculateLoadScore(value, thresholds) {
    if (value < thresholds.low) return 0;
    if (value < thresholds.medium) {
      return 20 + (value - thresholds.low) / (thresholds.medium - thresholds.low) * 30;
    }
    if (value < thresholds.high) {
      return 50 + (value - thresholds.medium) / (thresholds.high - thresholds.medium) * 30;
    }
    return 80 + Math.min((value - thresholds.high) / 10, 1) * 20;
  }

  /**
   * 根据系统指标调整限流因子
   */
  async adjustLimit(systemMetrics) {
    const now = Date.now();

    // 冷却期检查
    if (now - this.lastAdjustmentTime < this.config.cooldownMs) {
      return {
        loadFactor: this.currentLoadFactor,
        loadScore: this.systemLoadScore,
        adjusted: false,
        reason: 'cooldown'
      };
    }

    // 防止并发调整
    if (this.isAdjusting) {
      return {
        loadFactor: this.currentLoadFactor,
        loadScore: this.systemLoadScore,
        adjusted: false,
        reason: 'adjusting'
      };
    }

    this.isAdjusting = true;

    try {
      const { cpu = 0, memory = 0, avgResponseTime = 0 } = systemMetrics;

      // 计算各维度负载分数
      const cpuScore = this.calculateLoadScore(cpu, this.thresholds.cpu);
      const memoryScore = this.calculateLoadScore(memory, this.thresholds.memory);
      const responseScore = this.calculateLoadScore(avgResponseTime, this.thresholds.responseTime);

      // 综合负载分数（加权平均）
      this.systemLoadScore = Math.round(cpuScore * 0.4 + memoryScore * 0.3 + responseScore * 0.3);

      // 根据负载分数调整因子
      let newFactor = this.currentLoadFactor;

      if (this.systemLoadScore >= 80) {
        // 高负载：大幅降低限流阈值
        newFactor = 0.3;
      } else if (this.systemLoadScore >= 60) {
        // 中高负载：适度降低
        newFactor = 0.5;
      } else if (this.systemLoadScore >= 40) {
        // 正常负载：保持基础
        newFactor = 1.0;
      } else if (this.systemLoadScore >= 20) {
        // 低负载：适度提升
        newFactor = 1.2;
      } else {
        // 极低负载：大幅提升
        newFactor = 1.5;
      }

      // 限制因子范围
      newFactor = Math.max(this.config.minLoadFactor, Math.min(this.config.maxLoadFactor, newFactor));

      const adjusted = newFactor !== this.currentLoadFactor;
      const oldFactor = this.currentLoadFactor;
      this.currentLoadFactor = newFactor;
      this.lastAdjustmentTime = now;

      // 更新 Prometheus 指标
      const loadScoreGauge = metrics.register.getSingleMetric('adaptive_rate_limit_load_score');
      const factorGauge = metrics.register.getSingleMetric('adaptive_rate_limit_factor');

      if (loadScoreGauge) loadScoreGauge.set({ service: 'gateway' }, this.systemLoadScore);
      if (factorGauge) factorGauge.set({ service: 'gateway' }, this.currentLoadFactor);

      // 记录调整日志
      logger.info({
        event: 'RATE_LIMIT_ADJUSTED',
        oldFactor,
        newFactor,
        loadScore: this.systemLoadScore,
        cpu,
        memory,
        avgResponseTime
      }, 'Rate limit factor adjusted');

      return {
        loadFactor: this.currentLoadFactor,
        loadScore: this.systemLoadScore,
        adjusted,
        oldFactor,
        newFactor
      };
    } finally {
      this.isAdjusting = false;
    }
  }

  /**
   * 检查是否允许请求（Redis 分布式限流）
   */
  async checkRateLimit(userId, apiPath, options = {}) {
    await this.refreshTierConfigs();

    const config = this.matchApiPattern(apiPath);
    const effectiveLimit = Math.floor(config.baseLimit * this.currentLoadFactor);

    const redis = getRedis();
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 60); // 当前分钟开始

    const key = `ratelimit:${userId}:${apiPath}:${windowStart}`;

    try {
      const current = await redis.incr(key);
      await redis.expire(key, 60);

      const allowed = current <= effectiveLimit;
      const remaining = Math.max(0, effectiveLimit - current);

      if (!allowed) {
        // 记录限流触发
        const triggerCounter = metrics.register.getSingleMetric('rate_limit_triggered_total');
        if (triggerCounter) {
          triggerCounter.inc({ api_pattern: apiPath, tier: config.tier, user_level: options.userLevel || 'free' });
        }

        logger.warn({
          userId,
          apiPath,
          tier: config.tier,
          current,
          limit: effectiveLimit
        }, 'Rate limit exceeded');
      }

      return {
        allowed,
        current,
        limit: effectiveLimit,
        remaining,
        resetIn: 60 - (now % 60),
        tier: config.tier
      };
    } catch (err) {
      logger.error({ err, userId, apiPath }, 'Rate limit check failed');
      // 失败时允许请求（降级策略）
      return {
        allowed: true,
        current: 0,
        limit: effectiveLimit,
        remaining: effectiveLimit,
        resetIn: 60,
        tier: config.tier,
        error: err.message
      };
    }
  }

  /**
   * 获取当前限流状态
   */
  getStatus() {
    return {
      loadFactor: this.currentLoadFactor,
      loadScore: this.systemLoadScore,
      lastAdjustment: this.lastAdjustmentTime,
      tierConfigsCount: this.tierConfigs.size,
      thresholds: this.thresholds
    };
  }

  /**
   * 手动设置负载因子（管理员接口）
   */
  setLoadFactor(factor, reason = 'manual') {
    const oldFactor = this.currentLoadFactor;
    this.currentLoadFactor = Math.max(this.config.minLoadFactor, Math.min(this.config.maxLoadFactor, factor));
    this.lastAdjustmentTime = Date.now();

    logger.info({
      event: 'LOAD_FACTOR_MANUAL_SET',
      oldFactor,
      newFactor: this.currentLoadFactor,
      reason
    }, 'Load factor manually set');

    return {
      oldFactor,
      newFactor: this.currentLoadFactor,
      reason
    };
  }
}

/**
 * 用户配额管理器
 */
class UserQuotaManager {
  constructor() {
    this.logger = createLogger('quota-manager');
    this.cachePrefix = 'quota:';
  }

  /**
   * 获取用户配额信息
   */
  async getUserQuota(userId) {
    const redis = getRedis();
    const cacheKey = `${this.cachePrefix}${userId}`;

    // 尝试从缓存获取
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      this.logger.warn({ err, userId }, 'Cache read failed');
    }

    // 从数据库获取
    const result = await query(`
      SELECT 
        user_id, quota_level, daily_limit, hourly_limit, minute_limit,
        used_today, used_this_hour, used_this_minute,
        quota_multiplier, multiplier_reason, multiplier_expires_at,
        last_reset_date, last_reset_hour, last_reset_minute
      FROM user_quotas
      WHERE user_id = $1
    `, [userId]);

    if (result.rows.length === 0) {
      // 创建默认配额
      await this.createUserQuota(userId);
      return this.getUserQuota(userId);
    }

    const quota = result.rows[0];
    await this.resetIfNeeded(quota);

    // 缓存 5 分钟
    try {
      await redis.setex(cacheKey, 300, JSON.stringify(quota));
    } catch (err) {
      this.logger.warn({ err, userId }, 'Cache write failed');
    }

    return quota;
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

    // 检查是否需要重置日配额
    if (quota.last_reset_date !== today) {
      updates.used_today = 0;
      updates.last_reset_date = today;
      needsUpdate = true;
    }

    // 检查是否需要重置小时配额
    if (quota.last_reset_hour !== currentHour) {
      updates.used_this_hour = 0;
      updates.last_reset_hour = currentHour;
      needsUpdate = true;
    }

    // 检查是否需要重置分钟配额
    if (quota.last_reset_minute !== currentMinute) {
      updates.used_this_minute = 0;
      updates.last_reset_minute = currentMinute;
      needsUpdate = true;
    }

    // 检查配额系数是否过期
    if (quota.multiplier_expires_at && new Date(quota.multiplier_expires_at) < now) {
      updates.quota_multiplier = 1.0;
      updates.multiplier_reason = null;
      updates.multiplier_expires_at = null;
      needsUpdate = true;
    }

    if (needsUpdate) {
      await query(`
        UPDATE user_quotas SET 
          used_today = COALESCE($2, used_today),
          used_this_hour = COALESCE($3, used_this_hour),
          used_this_minute = COALESCE($4, used_this_minute),
          quota_multiplier = COALESCE($5, quota_multiplier),
          multiplier_reason = COALESCE($6, multiplier_reason),
          multiplier_expires_at = COALESCE($7, multiplier_expires_at),
          last_reset_date = COALESCE($8, last_reset_date),
          last_reset_hour = COALESCE($9, last_reset_hour),
          last_reset_minute = COALESCE($10, last_reset_minute)
        WHERE user_id = $1
      `, [
        quota.user_id,
        updates.used_today,
        updates.used_this_hour,
        updates.used_this_minute,
        updates.quota_multiplier,
        updates.multiplier_reason,
        updates.multiplier_expires_at,
        updates.last_reset_date,
        updates.last_reset_hour,
        updates.last_reset_minute
      ]);

      // 清除缓存
      const redis = getRedis();
      await redis.del(`${this.cachePrefix}${quota.user_id}`);
    }
  }

  /**
   * 创建用户配额
   */
  async createUserQuota(userId, level = 'free') {
    const limits = {
      free: { daily: 1000, hourly: 100, minute: 20 },
      vip: { daily: 3000, hourly: 300, minute: 60 },
      svip: { daily: 10000, hourly: 1000, minute: 200 }
    };

    const config = limits[level] || limits.free;

    await query(`
      INSERT INTO user_quotas (user_id, quota_level, daily_limit, hourly_limit, minute_limit)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id) DO UPDATE SET
        quota_level = $2,
        daily_limit = $3,
        hourly_limit = $4,
        minute_limit = $5
    `, [userId, level, config.daily, config.hourly, config.minute]);

    this.logger.info({ userId, level }, 'User quota created');
  }

  /**
   * 增加使用量
   */
  async incrementUsage(userId, apiPath) {
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
      RETURNING used_today, used_this_hour, used_this_minute, quota_multiplier
    `, [userId, today, currentHour, currentMinute]);

    if (result.rows.length > 0) {
      // 清除缓存
      const redis = getRedis();
      await redis.del(`${this.cachePrefix}${userId}`);
      return result.rows[0];
    }

    return null;
  }

  /**
   * 调整用户配额系数（反作弊联动）
   */
  async adjustUserQuota(userId, options) {
    const { quotaMultiplier, reason, duration } = options;
    const expiresAt = duration ? new Date(Date.now() + this.parseDuration(duration)) : null;

    await query(`
      UPDATE user_quotas SET
        quota_multiplier = $2,
        multiplier_reason = $3,
        multiplier_expires_at = COALESCE($4, multiplier_expires_at)
      WHERE user_id = $1
    `, [userId, quotaMultiplier, reason, expiresAt]);

    // 清除缓存
    const redis = getRedis();
    await redis.del(`${this.cachePrefix}${userId}`);

    // 记录调整
    const adjustCounter = metrics.register.getSingleMetric('quota_adjustments_total');
    if (adjustCounter) {
      adjustCounter.inc({
        user_id: String(userId),
        reason,
        action: quotaMultiplier < 1 ? 'decrease' : 'increase'
      });
    }

    this.logger.info({
      userId,
      quotaMultiplier,
      reason,
      expiresAt
    }, 'User quota adjusted');

    return {
      userId,
      newMultiplier: quotaMultiplier,
      reason,
      expiresAt
    };
  }

  /**
   * 解析持续时间字符串
   */
  parseDuration(duration) {
    const match = duration.match(/^(\d+)([dhm])$/);
    if (!match) return 24 * 60 * 60 * 1000; // 默认 1 天

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
   * 获取用户配额状态（供查询 API 使用）
   */
  async getQuotaStatus(userId) {
    const quota = await this.getUserQuota(userId);

    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const endOfHour = new Date(now);
    endOfHour.setMinutes(59, 59, 999);

    return {
      userId: quota.user_id,
      quotaLevel: quota.quota_level,
      limits: {
        daily: Math.floor(quota.daily_limit * quota.quota_multiplier),
        hourly: Math.floor(quota.hourly_limit * quota.quota_multiplier),
        minute: Math.floor(quota.minute_limit * quota.quota_multiplier)
      },
      used: {
        today: quota.used_today,
        thisHour: quota.used_this_hour,
        thisMinute: quota.used_this_minute
      },
      remaining: {
        daily: Math.max(0, Math.floor(quota.daily_limit * quota.quota_multiplier) - quota.used_today),
        hourly: Math.max(0, Math.floor(quota.hourly_limit * quota.quota_multiplier) - quota.used_this_hour),
        minute: Math.max(0, Math.floor(quota.minute_limit * quota.quota_multiplier) - quota.used_this_minute)
      },
      resetIn: {
        daily: this.formatDuration(endOfDay - now),
        hourly: this.formatDuration(endOfHour - now),
        minute: this.formatDuration(60000 - (now.getSeconds() * 1000 + now.getMilliseconds()))
      },
      quotaMultiplier: quota.quota_multiplier,
      multiplierReason: quota.multiplier_reason,
      multiplierExpiresAt: quota.multiplier_expires_at
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

// 单例导出
const adaptiveRateLimiter = new AdaptiveRateLimiter();
const userQuotaManager = new UserQuotaManager();

module.exports = {
  AdaptiveRateLimiter,
  UserQuotaManager,
  adaptiveRateLimiter,
  userQuotaManager
};
