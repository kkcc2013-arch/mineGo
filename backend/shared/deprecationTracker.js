// backend/shared/deprecationTracker.js
// REQ-00044: 废弃 API 追踪与告警
'use strict';

const { createLogger } = require('@pmg/shared/logger');
const metrics = require('@pmg/shared/metrics');
const getRedis = require('@pmg/shared/redis').getRedis;

const logger = createLogger('deprecation-tracker');

/**
 * 废弃 API 追踪器
 * 
 * 功能：
 * - 标记端点为废弃
 * - 追踪废弃端点使用量
 * - 自动告警
 * - 检查下线时间
 */
class DeprecationTracker {
  constructor(options = {}) {
    this.redis = options.redis || getRedis();
    this.deprecatedEndpoints = new Map();
    this.usageStats = new Map();
    this.initialized = false;
    
    // Redis 键前缀
    this.keyPrefix = options.keyPrefix || 'minego:deprecation:';
    
    // 告警阈值
    this.alertThreshold = options.alertThreshold || 100;  // 每 100 次使用告警
    this.alertCooldown = options.alertCooldown || 3600000; // 1 小时告警冷却
    
    // 告警状态
    this.lastAlertTime = new Map();
  }
  
  /**
   * 初始化追踪器
   */
  async init() {
    if (this.initialized) return;
    
    try {
      // 从 Redis 加载已有的废弃记录
      await this._loadDeprecationRecords();
      this.initialized = true;
      logger.info('DeprecationTracker initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize DeprecationTracker');
      // 即使 Redis 失败也能基本工作
      this.initialized = true;
    }
  }
  
  /**
   * 标记端点为废弃
   * @param {string} endpoint - 端点路径
   * @param {object} options - 废弃选项
   */
  async deprecate(endpoint, options = {}) {
    const sunsetDate = options.sunsetAt || new Date(Date.now() + 180 * 24 * 60 * 60 * 1000); // 默认 6 个月
    
    const record = {
      endpoint,
      deprecatedAt: options.deprecatedAt || new Date().toISOString(),
      sunsetAt: sunsetDate.toISOString ? sunsetAt.toISOString() : sunsetDate,
      migrationGuide: options.migrationGuide || null,
      replacement: options.replacement || null,
      reason: options.reason || 'API 更新',
      usageCount: 0,
      lastUsedAt: null,
      notifiedClients: [],
    };
    
    this.deprecatedEndpoints.set(endpoint, record);
    
    // 持久化到 Redis
    await this._saveDeprecationRecord(record);
    
    // 记录指标
    metrics.apiDeprecatedEndpoints?.inc();
    
    logger.info({
      endpoint,
      deprecatedAt: record.deprecatedAt,
      sunsetAt: record.sunsetAt,
      replacement: record.replacement,
    }, 'Endpoint marked as deprecated');
    
    return record;
  }
  
  /**
   * 追踪废弃端点使用
   * @param {string} endpoint - 端点路径
   * @param {string} clientId - 客户端 ID
   */
  async trackUsage(endpoint, clientId) {
    if (!this.deprecatedEndpoints.has(endpoint)) {
      return;
    }
    
    const record = this.deprecatedEndpoints.get(endpoint);
    record.usageCount++;
    record.lastUsedAt = new Date().toISOString();
    
    // 更新使用统计
    if (!this.usageStats.has(endpoint)) {
      this.usageStats.set(endpoint, new Map());
    }
    const stats = this.usageStats.get(endpoint);
    stats.set(clientId, (stats.get(clientId) || 0) + 1);
    
    // 记录指标
    metrics.apiDeprecatedEndpointUsage?.inc({ endpoint });
    
    // 检查是否需要告警
    if (record.usageCount % this.alertThreshold === 0) {
      await this._sendUsageAlert(endpoint, record);
    }
    
    // 异步更新 Redis（不阻塞请求）
    this._updateUsageRecord(endpoint, record).catch(err => {
      logger.debug({ err, endpoint }, 'Failed to update usage record');
    });
  }
  
  /**
   * 检查是否有端点应该下线
   */
  checkSunset() {
    const now = new Date();
    const toSunset = [];
    
    for (const [endpoint, record] of this.deprecatedEndpoints) {
      const sunsetDate = new Date(record.sunsetAt);
      if (sunsetDate <= now) {
        toSunset.push({ endpoint, record });
      }
    }
    
    return toSunset;
  }
  
  /**
   * 获取所有废弃端点
   */
  getAllDeprecated() {
    return Array.from(this.deprecatedEndpoints.entries()).map(([endpoint, record]) => ({
      endpoint,
      ...record,
    }));
  }
  
  /**
   * 获取端点详情
   */
  getEndpoint(endpoint) {
    return this.deprecatedEndpoints.get(endpoint) || null;
  }
  
  /**
   * 获取使用统计
   */
  getUsageStats(endpoint) {
    if (!endpoint) {
      // 返回所有统计
      const allStats = {};
      for (const [ep, clients] of this.usageStats) {
        allStats[ep] = Object.fromEntries(clients);
      }
      return allStats;
    }
    
    const stats = this.usageStats.get(endpoint);
    return stats ? Object.fromEntries(stats) : {};
  }
  
  /**
   * 移除端点（下线后）
   */
  async removeEndpoint(endpoint) {
    this.deprecatedEndpoints.delete(endpoint);
    this.usageStats.delete(endpoint);
    
    try {
      await this.redis.del(`${this.keyPrefix}endpoint:${endpoint}`);
      await this.redis.del(`${this.keyPrefix}usage:${endpoint}`);
      logger.info({ endpoint }, 'Deprecated endpoint removed');
    } catch (err) {
      logger.error({ err, endpoint }, 'Failed to remove deprecated endpoint from Redis');
    }
  }
  
  /**
   * 获取接近下线的端点
   */
  getUpcomingSunsets(withinDays = 30) {
    const now = new Date();
    const threshold = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);
    
    const upcoming = [];
    
    for (const [endpoint, record] of this.deprecatedEndpoints) {
      const sunsetDate = new Date(record.sunsetAt);
      if (sunsetDate <= threshold && sunsetDate > now) {
        const daysUntilSunset = Math.ceil((sunsetDate - now) / (24 * 60 * 60 * 1000));
        upcoming.push({
          endpoint,
          ...record,
          daysUntilSunset,
        });
      }
    }
    
    return upcoming.sort((a, b) => a.daysUntilSunset - b.daysUntilSunset);
  }
  
  /**
   * 发送使用告警
   */
  async _sendUsageAlert(endpoint, record) {
    const now = Date.now();
    const lastAlert = this.lastAlertTime.get(endpoint) || 0;
    
    // 检查告警冷却
    if (now - lastAlert < this.alertCooldown) {
      return;
    }
    
    this.lastAlertTime.set(endpoint, now);
    
    const stats = this.usageStats.get(endpoint);
    const uniqueClients = stats ? stats.size : 0;
    
    logger.warn({
      endpoint,
      totalUsage: record.usageCount,
      uniqueClients,
      deprecatedAt: record.deprecatedAt,
      sunsetAt: record.sunsetAt,
      replacement: record.replacement,
    }, 'Deprecated endpoint usage alert');
    
    // 记录告警指标
    metrics.apiDeprecationAlerts?.inc({ endpoint });
    
    // 可以在这里集成告警通知（钉钉、Slack 等）
    // await notificationService.send({
    //   type: 'api-deprecation',
    //   endpoint,
    //   usage: record.usageCount,
    //   clients: uniqueClients,
    // });
  }
  
  /**
   * 保存废弃记录到 Redis
   */
  async _saveDeprecationRecord(record) {
    try {
      const key = `${this.keyPrefix}endpoint:${record.endpoint}`;
      await this.redis.hset(key, {
        endpoint: record.endpoint,
        deprecatedAt: record.deprecatedAt,
        sunsetAt: record.sunsetAt,
        migrationGuide: record.migrationGuide || '',
        replacement: record.replacement || '',
        reason: record.reason,
        usageCount: record.usageCount.toString(),
        lastUsedAt: record.lastUsedAt || '',
      });
      
      // 设置过期时间为下线后 1 年
      const ttl = Math.max(
        365 * 24 * 60 * 60,
        Math.floor((new Date(record.sunsetAt).getTime() - Date.now()) / 1000) + 365 * 24 * 60 * 60
      );
      await this.redis.expire(key, ttl);
    } catch (err) {
      logger.error({ err, endpoint: record.endpoint }, 'Failed to save deprecation record');
    }
  }
  
  /**
   * 更新使用记录
   */
  async _updateUsageRecord(endpoint, record) {
    try {
      const key = `${this.keyPrefix}endpoint:${endpoint}`;
      await this.redis.hset(key, {
        usageCount: record.usageCount.toString(),
        lastUsedAt: record.lastUsedAt || '',
      });
    } catch (err) {
      logger.debug({ err, endpoint }, 'Failed to update usage in Redis');
    }
  }
  
  /**
   * 从 Redis 加载废弃记录
   */
  async _loadDeprecationRecords() {
    try {
      const pattern = `${this.keyPrefix}endpoint:*`;
      const keys = await this.redis.keys(pattern);
      
      for (const key of keys) {
        const data = await this.redis.hgetall(key);
        if (data && data.endpoint) {
          this.deprecatedEndpoints.set(data.endpoint, {
            endpoint: data.endpoint,
            deprecatedAt: data.deprecatedAt,
            sunsetAt: data.sunsetAt,
            migrationGuide: data.migrationGuide || null,
            replacement: data.replacement || null,
            reason: data.reason,
            usageCount: parseInt(data.usageCount || '0', 10),
            lastUsedAt: data.lastUsedAt || null,
          });
        }
      }
      
      logger.info({ count: this.deprecatedEndpoints.size }, 'Loaded deprecation records from Redis');
    } catch (err) {
      logger.error({ err }, 'Failed to load deprecation records from Redis');
    }
  }
}

// 单例实例
let trackerInstance = null;

/**
 * 获取追踪器单例
 */
function getDeprecationTracker(options = {}) {
  if (!trackerInstance) {
    trackerInstance = new DeprecationTracker(options);
  }
  return trackerInstance;
}

// 初始化 Prometheus 指标
function initDeprecationMetrics() {
  metrics.apiDeprecatedEndpoints = metrics.register.getSingleMetric('api_deprecated_endpoints_total') ||
    new metrics.client.Gauge({
      name: 'api_deprecated_endpoints_total',
      help: 'Total number of deprecated API endpoints',
    });
  
  metrics.apiDeprecatedEndpointUsage = metrics.register.getSingleMetric('api_deprecated_endpoint_usage_total') ||
    new metrics.client.Counter({
      name: 'api_deprecated_endpoint_usage_total',
      help: 'Total usage of deprecated API endpoints',
      labelNames: ['endpoint'],
    });
  
  metrics.apiDeprecationAlerts = metrics.register.getSingleMetric('api_deprecation_alerts_total') ||
    new metrics.client.Counter({
      name: 'api_deprecation_alerts_total',
      help: 'Total deprecation usage alerts sent',
      labelNames: ['endpoint'],
    });
}

// 初始化指标
try {
  initDeprecationMetrics();
} catch (err) {
  logger.debug({ err }, 'Deprecation metrics may already exist');
}

module.exports = {
  DeprecationTracker,
  getDeprecationTracker,
  initDeprecationMetrics,
};
