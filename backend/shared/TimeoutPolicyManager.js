'use strict';

/**
 * REQ-00584: API 超时策略标准化与分级超时治理系统
 * 集中式超时策略管理器
 */

const { createLogger } = require('./logger');
const Redis = require('ioredis');
const client = require('prom-client');

const logger = createLogger('timeout-policy');

// ── 超时等级定义 ─────────────────────────────────────────────
const TIMEOUT_LEVELS = {
  L1_FAST_READ: {
    level: 'L1',
    description: '快速读操作（单个资源查询、缓存命中路径）',
    defaultMs: 3000,
    maxMs: 5000,
    minMs: 500
  },
  L2_STANDARD_WRITE: {
    level: 'L2',
    description: '标准写操作（创建、更新、删除）',
    defaultMs: 10000,
    maxMs: 15000,
    minMs: 2000
  },
  L3_BATCH_OPERATION: {
    level: 'L3',
    description: '批量操作（列表查询、批量导入、聚合统计）',
    defaultMs: 30000,
    maxMs: 60000,
    minMs: 5000
  },
  L4_STREAMING: {
    level: 'L4',
    description: '流式长连接操作（道馆实时战斗、大范围地图查询）',
    defaultMs: 60000,
    maxMs: 120000,
    minMs: 10000
  }
};

// ── Prometheus 指标 ───────────────────────────────────────────
const timeoutThresholdGauge = new client.Gauge({
  name: 'minego_api_timeout_threshold_seconds',
  help: '当前API路由的超时阈值（秒）',
  labelNames: ['route', 'method', 'level']
});

const timeoutExceededCounter = new client.Counter({
  name: 'minego_api_timeout_exceeded_total',
  help: 'API超时次数统计',
  labelNames: ['route', 'method', 'level']
});

const timeoutNegotiationCounter = new client.Counter({
  name: 'minego_api_timeout_negotiation_total',
  help: '客户端超时协商结果统计',
  labelNames: ['route', 'result'] // result: accepted, capped, rejected
});

const timeoutUpdateCounter = new client.Counter({
  name: 'minego_api_timeout_update_total',
  help: '超时策略动态更新次数',
  labelNames: ['route', 'action'] // action: created, updated, deleted
});

// ── TimeoutPolicyManager 类 ─────────────────────────────────────
class TimeoutPolicyManager {
  constructor(config = {}) {
    this.redis = config.redis || new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
    this.cachePrefix = 'timeout_policy:';
    this.cacheTTL = config.cacheTTL || 300; // 5分钟本地缓存
    this.policies = new Map();
    this.routePatternCache = new Map();
    this.defaults = TIMEOUT_LEVELS;
    this.initialized = false;
    
    // 默认路由策略
    this.defaultPolicies = {
      // L1 - 快速读
      'GET /api/v2/users/:id': 'L1',
      'GET /api/v2/users/me': 'L1',
      'GET /api/v2/pokemon/:id': 'L1',
      'GET /api/v2/pokemon/:id/details': 'L1',
      'GET /api/v2/items': 'L1',
      'GET /api/v2/inventory': 'L1',
      'GET /api/v2/pokestops/nearby': 'L1',
      'GET /api/v2/gyms/nearby': 'L1',
      'GET /api/v2/catch/available': 'L1',
      
      // L2 - 标准写
      'POST /api/v2/catch': 'L2',
      'POST /api/v2/catch/:id': 'L2',
      'PUT /api/v2/users/:id': 'L2',
      'POST /api/v2/trades': 'L2',
      'POST /api/v2/trades/:id/accept': 'L2',
      'DELETE /api/v2/pokemon/:id': 'L2',
      'POST /api/v2/items/use': 'L2',
      'POST /api/v2/gyms/:id/battle': 'L2',
      
      // L3 - 批量操作
      'GET /api/v2/pokemon': 'L3',
      'GET /api/v2/pokemon/search': 'L3',
      'GET /api/v2/admin/users': 'L3',
      'POST /api/v2/admin/import': 'L3',
      'GET /api/v2/leaderboard': 'L3',
      'GET /api/v2/events': 'L3',
      
      // L4 - 流式/长连接
      'WS /api/v2/gym/battle': 'L4',
      'GET /api/v2/map/region': 'L4'
    };
  }

  /**
   * 初始化 - 加载策略配置
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      logger.info('Initializing TimeoutPolicyManager...');
      
      // 加载默认策略
      for (const [route, level] of Object.entries(this.defaultPolicies)) {
        this.register(route, level);
      }
      
      // 从 Redis 加载自定义策略
      await this.loadFromRedis();
      
      this.initialized = true;
      logger.info('TimeoutPolicyManager initialized', { 
        policyCount: this.policies.size 
      });
    } catch (error) {
      logger.error('Failed to initialize TimeoutPolicyManager', { error: error.message });
      throw error;
    }
  }

  /**
   * 注册路由超时策略
   * @param {string} route - 路由模式 (e.g., 'GET /api/v2/users/:id')
   * @param {string} level - 超时等级 (L1/L2/L3/L4)
   * @param {Object} options - 可选配置
   */
  register(route, level, options = {}) {
    const levelConfig = this.defaults[level];
    if (!levelConfig) {
      throw new Error(`Invalid timeout level: ${level}`);
    }
    
    const policy = {
      route,
      level,
      defaultMs: options.defaultMs || levelConfig.defaultMs,
      maxMs: options.maxMs || levelConfig.maxMs,
      minMs: options.minMs || levelConfig.minMs,
      description: options.description || levelConfig.description,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    this.policies.set(route, policy);
    
    // 更新 Prometheus 指标
    timeoutThresholdGauge.set(
      { route, method: this.extractMethod(route), level },
      policy.defaultMs / 1000
    );
    
    logger.debug('Timeout policy registered', { route, level, defaultMs: policy.defaultMs });
  }

  /**
   * 获取路由超时策略
   * @param {string} routePath - 路由路径
   * @param {string} method - HTTP 方法
   * @returns {Object} 超时策略
   */
  getTimeout(routePath, method = 'GET') {
    const routeKey = `${method.toUpperCase()} ${routePath}`;
    
    // 精确匹配
    if (this.policies.has(routeKey)) {
      return this.policies.get(routeKey);
    }
    
    // 模式匹配
    for (const [pattern, policy] of this.policies) {
      if (this.matchRoute(pattern, routeKey)) {
        return policy;
      }
    }
    
    // 默认返回 L2
    return {
      ...this.defaults.L2_STANDARD_WRITE,
      route: routeKey,
      level: 'L2',
      defaultMs: this.defaults.L2_STANDARD_WRITE.defaultMs,
      maxMs: this.defaults.L2_STANDARD_WRITE.maxMs,
      minMs: this.defaults.L2_STANDARD_WRITE.minMs
    };
  }

  /**
   * 路由模式匹配
   */
  matchRoute(pattern, routeKey) {
    // 缓存正则
    if (!this.routePatternCache.has(pattern)) {
      const regexPattern = pattern
        .replace(/:[a-zA-Z]+/g, '[^/]+')
        .replace(/\//g, '\\/');
      this.routePatternCache.set(pattern, new RegExp(`^${regexPattern}$`));
    }
    
    const regex = this.routePatternCache.get(pattern);
    return regex.test(routeKey);
  }

  /**
   * 客户端超时协商
   * @param {string} routePath - 路由路径
   * @param {string} method - HTTP 方法
   * @param {number} clientTimeout - 客户端请求的超时值（毫秒）
   * @returns {Object} 协商结果
   */
  negotiateTimeout(routePath, method, clientTimeout) {
    const policy = this.getTimeout(routePath, method);
    
    if (!clientTimeout || clientTimeout <= 0) {
      return {
        effectiveTimeout: policy.defaultMs,
        level: policy.level,
        negotiated: false,
        result: 'default'
      };
    }
    
    // 小于最小值，使用最小值
    if (clientTimeout < policy.minMs) {
      timeoutNegotiationCounter.inc({ route: routePath, result: 'rejected' });
      return {
        effectiveTimeout: policy.minMs,
        level: policy.level,
        negotiated: true,
        result: 'rejected',
        reason: 'Below minimum threshold'
      };
    }
    
    // 超过最大值，截断
    if (clientTimeout > policy.maxMs) {
      timeoutNegotiationCounter.inc({ route: routePath, result: 'capped' });
      return {
        effectiveTimeout: policy.maxMs,
        level: policy.level,
        negotiated: true,
        result: 'capped',
        reason: 'Exceeds maximum threshold'
      };
    }
    
    // 在范围内，接受客户端值
    timeoutNegotiationCounter.inc({ route: routePath, result: 'accepted' });
    return {
      effectiveTimeout: clientTimeout,
      level: policy.level,
      negotiated: true,
      result: 'accepted'
    };
  }

  /**
   * 记录超时事件
   */
  recordTimeout(routePath, method) {
    const policy = this.getTimeout(routePath, method);
    timeoutExceededCounter.inc({ 
      route: routePath, 
      method, 
      level: policy.level 
    });
    
    logger.warn('API timeout recorded', { route: routePath, method, level: policy.level });
  }

  /**
   * 动态更新超时配置
   * @param {string} route - 路由
   * @param {number} newTimeoutMs - 新的超时值
   * @param {string} userId - 操作用户
   */
  async updateTimeout(route, newTimeoutMs, userId = 'system') {
    const existing = this.policies.get(route);
    
    if (existing) {
      // 验证新值在范围内
      if (newTimeoutMs < existing.minMs || newTimeoutMs > existing.maxMs) {
        throw new Error(`Timeout ${newTimeoutMs}ms out of range [${existing.minMs}, ${existing.maxMs}]`);
      }
      
      existing.defaultMs = newTimeoutMs;
      existing.updatedAt = new Date().toISOString();
      existing.updatedBy = userId;
      
      // 更新 Prometheus
      timeoutThresholdGauge.set(
        { route, method: this.extractMethod(route), level: existing.level },
        newTimeoutMs / 1000
      );
      
      timeoutUpdateCounter.inc({ route, action: 'updated' });
    } else {
      // 创建新策略，默认 L2
      this.register(route, 'L2', { defaultMs: newTimeoutMs });
      timeoutUpdateCounter.inc({ route, action: 'created' });
    }
    
    // 持久化到 Redis
    await this.saveToRedis(route);
    
    logger.info('Timeout policy updated', { route, newTimeoutMs, userId });
  }

  /**
   * 从 Redis 加载策略
   */
  async loadFromRedis() {
    try {
      const keys = await this.redis.keys(`${this.cachePrefix}*`);
      
      for (const key of keys) {
        const data = await this.redis.get(key);
        if (data) {
          const policy = JSON.parse(data);
          this.policies.set(policy.route, policy);
        }
      }
      
      logger.info('Loaded policies from Redis', { count: keys.length });
    } catch (error) {
      logger.error('Failed to load policies from Redis', { error: error.message });
    }
  }

  /**
   * 保存策略到 Redis
   */
  async saveToRedis(route) {
    const policy = this.policies.get(route);
    if (policy) {
      await this.redis.set(
        `${this.cachePrefix}${route}`,
        JSON.stringify(policy),
        'EX',
        86400 // 24小时过期
      );
    }
  }

  /**
   * 获取所有策略列表
   */
  getAllPolicies() {
    return Array.from(this.policies.values());
  }

  /**
   * 获取策略统计
   */
  getStats() {
    const stats = {
      total: this.policies.size,
      byLevel: {}
    };
    
    for (const level of Object.keys(this.defaults)) {
      stats.byLevel[level] = 0;
    }
    
    for (const policy of this.policies.values()) {
      stats.byLevel[policy.level] = (stats.byLevel[policy.level] || 0) + 1;
    }
    
    return stats;
  }

  /**
   * 从路由键提取方法
   */
  extractMethod(route) {
    const parts = route.split(' ');
    return parts.length > 1 ? parts[0] : 'GET';
  }

  /**
   * 删除策略
   */
  async deletePolicy(route) {
    if (this.policies.has(route)) {
      this.policies.delete(route);
      await this.redis.del(`${this.cachePrefix}${route}`);
      timeoutUpdateCounter.inc({ route, action: 'deleted' });
      logger.info('Timeout policy deleted', { route });
      return true;
    }
    return false;
  }

  /**
   * 重新加载配置（热更新入口）
   */
  async reload() {
    logger.info('Reloading timeout policies...');
    this.policies.clear();
    this.routePatternCache.clear();
    
    // 重新注册默认策略
    for (const [route, level] of Object.entries(this.defaultPolicies)) {
      this.register(route, level);
    }
    
    // 从 Redis 重新加载
    await this.loadFromRedis();
    
    logger.info('Timeout policies reloaded', { count: this.policies.size });
  }

  /**
   * 关闭资源
   */
  async shutdown() {
    if (this.redis && this.redis.status !== 'end') {
      await this.redis.quit();
    }
    logger.info('TimeoutPolicyManager shutdown complete');
  }
}

// 导出单例和类
const instance = new TimeoutPolicyManager();

module.exports = {
  TimeoutPolicyManager,
  timeoutPolicyManager: instance,
  TIMEOUT_LEVELS
};