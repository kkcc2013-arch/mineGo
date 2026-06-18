/**
 * 智能限流中间件
 * 基于用户信誉度和系统负载动态调整限流配额
 */

const Redis = require('ioredis');
const { logger, metrics } = require('./logger');
const userReputation = require('./UserReputationScore');

class IntelligentRateLimiter {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    
    // 基础配额配置
    this.BASE_LIMITS = {
      'GET /api/pokemon': { window: 60000, max: 100 },       // 100/分钟
      'POST /api/catch': { window: 60000, max: 30 },         // 30/分钟
      'GET /api/location/nearby': { window: 60000, max: 60 }, // 60/分钟
      'POST /api/gym/battle': { window: 60000, max: 20 },    // 20/分钟
      'POST /api/trade': { window: 60000, max: 10 },         // 10/分钟
      'POST /api/payment': { window: 60000, max: 5 },        // 5/分钟
      'default': { window: 60000, max: 60 }                   // 默认 60/分钟
    };
    
    // 系统负载阈值
    this.SYSTEM_LOAD = {
      low: { threshold: 0.5, multiplier: 1.2 },
      medium: { threshold: 0.75, multiplier: 1.0 },
      high: { threshold: 0.9, multiplier: 0.7 },
      critical: { threshold: 1.0, multiplier: 0.3 }
    };
  }
  
  /**
   * 主限流检查方法
   */
  async checkLimit(userId, endpoint, method) {
    const key = `${method} ${endpoint}`;
    const baseLimit = this.BASE_LIMITS[key] || this.BASE_LIMITS.default;
    
    // 获取用户信誉度
    const reputation = await userReputation.calculateReputation(userId);
    
    // 获取当前系统负载
    const systemLoad = await this.getSystemLoad();
    
    // 获取临时提升配额
    const boost = await this.getTemporaryBoost(userId);
    
    // 计算动态配额
    const dynamicLimit = this.calculateDynamicLimit(
      baseLimit.max,
      reputation.multiplier,
      systemLoad.multiplier,
      boost,
      userId
    );
    
    // 执行限流检查
    const result = await this.executeLimitCheck(
      userId,
      key,
      baseLimit.window,
      dynamicLimit
    );
    
    // 记录指标
    if (metrics && metrics.increment) {
      metrics.increment('rate_limit_check', 1, {
        userId,
        endpoint: key,
        allowed: result.allowed ? '1' : '0',
        reputationLevel: reputation.level,
        systemLoadLevel: systemLoad.level
      });
    }
    
    return {
      ...result,
      reputationLevel: reputation.level,
      systemLoadLevel: systemLoad.level
    };
  }
  
  /**
   * 计算动态配额
   */
  calculateDynamicLimit(baseMax, reputationMultiplier, systemMultiplier, boost, userId) {
    // 基础配额 × 信誉倍数 × 系统负载倍数 × 临时提升倍数
    let dynamicLimit = Math.floor(baseMax * reputationMultiplier * systemMultiplier * (boost || 1));
    
    // 保证最低配额（防止用户完全无法使用）
    dynamicLimit = Math.max(5, dynamicLimit);
    
    logger.debug('Dynamic limit calculated', {
      userId,
      baseMax,
      reputationMultiplier,
      systemMultiplier,
      boost,
      dynamicLimit
    });
    
    return dynamicLimit;
  }
  
  /**
   * 获取临时提升配额
   */
  async getTemporaryBoost(userId) {
    const key = `ratelimit:boost:${userId}`;
    const boost = await this.redis.get(key);
    
    if (boost) {
      const data = JSON.parse(boost);
      return data.multiplier;
    }
    
    return 1;
  }
  
  /**
   * 获取系统负载
   */
  async getSystemLoad() {
    const key = 'system:load';
    const cached = await this.redis.get(key);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 从系统指标获取负载
    const cpuUsage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    
    const load = {
      cpu: (cpuUsage.user + cpuUsage.system) / 1000000, // 转换为秒
      memory: memUsage.heapUsed / memUsage.heapTotal,
      connections: 0 // 可从连接池获取
    };
    
    const overallLoad = (load.cpu / 10 + load.memory) / 2; // CPU 归一化
    
    let level = 'low';
    let multiplier = this.SYSTEM_LOAD.low.multiplier;
    
    for (const [lvl, config] of Object.entries(this.SYSTEM_LOAD)) {
      if (overallLoad >= config.threshold) {
        level = lvl;
        multiplier = config.multiplier;
      }
    }
    
    const result = {
      overall: overallLoad,
      level,
      multiplier,
      details: load
    };
    
    // 缓存 10 秒
    await this.redis.setex(key, 10, JSON.stringify(result));
    
    return result;
  }
  
  /**
   * 执行限流检查（滑动窗口算法）
   */
  async executeLimitCheck(userId, endpoint, windowMs, maxRequests) {
    const key = `ratelimit:${userId}:${endpoint}`;
    const now = Date.now();
    const windowStart = now - windowMs;
    
    // 使用 Redis 有序集合实现滑动窗口
    const multi = this.redis.multi();
    
    // 移除窗口外的请求
    multi.zremrangebyscore(key, 0, windowStart);
    
    // 获取当前窗口内的请求数
    multi.zcard(key);
    
    // 添加当前请求
    multi.zadd(key, now, `${now}-${Math.random().toString(36).substr(2, 9)}`);
    
    // 设置过期时间
    multi.expire(key, Math.ceil(windowMs / 1000));
    
    const results = await multi.exec();
    const currentCount = results[1][1];
    
    const allowed = currentCount < maxRequests;
    const remaining = Math.max(0, maxRequests - currentCount - 1);
    const resetAt = now + windowMs;
    
    if (!allowed) {
      // 记录限流事件
      await this.recordLimitEvent(userId, endpoint, currentCount, maxRequests);
      
      logger.warn('Rate limit exceeded', {
        userId,
        endpoint,
        currentCount,
        maxRequests
      });
    }
    
    return {
      allowed,
      current: currentCount + 1,
      limit: maxRequests,
      remaining,
      resetAt,
      retryAfter: allowed ? 0 : Math.ceil((resetAt - now) / 1000)
    };
  }
  
  /**
   * 记录限流事件（用于行为分析）
   */
  async recordLimitEvent(userId, endpoint, current, limit) {
    const key = `ratelimit:events:${userId}`;
    const event = {
      endpoint,
      timestamp: new Date().toISOString(),
      current,
      limit
    };
    
    await this.redis.lpush(key, JSON.stringify(event));
    await this.redis.ltrim(key, 0, 99); // 保留最近 100 条
    
    // 短时间内频繁触发限流，可能需要降低信誉度
    const recentEvents = await this.redis.llen(key);
    if (recentEvents > 10) {
      await userReputation.recordBehaviorEvent(userId, 'violation_low', {
        reason: 'frequent_rate_limit',
        endpoint
      });
    }
  }
  
  /**
   * 临时配额提升（活动期间）
   */
  async grantTemporaryBoost(userId, multiplier, durationSeconds, reason) {
    const key = `ratelimit:boost:${userId}`;
    
    await this.redis.setex(key, durationSeconds, JSON.stringify({
      multiplier,
      reason,
      grantedAt: new Date().toISOString()
    }));
    
    logger.info('Temporary boost granted', {
      userId,
      multiplier,
      durationSeconds,
      reason
    });
    
    // 发布事件
    await this.redis.publish('rate_limit:boost', JSON.stringify({
      userId,
      multiplier,
      durationSeconds,
      reason
    }));
  }
  
  /**
   * 获取用户当前配额状态
   */
  async getQuotaStatus(userId) {
    const reputation = await userReputation.calculateReputation(userId);
    const systemLoad = await this.getSystemLoad();
    const boost = await this.redis.get(`ratelimit:boost:${userId}`);
    
    const status = {
      userId,
      reputation,
      systemLoad,
      boost: boost ? JSON.parse(boost) : null,
      quotas: {}
    };
    
    // 获取各接口当前使用情况
    for (const [endpoint, config] of Object.entries(this.BASE_LIMITS)) {
      if (endpoint === 'default') continue;
      
      const key = `ratelimit:${userId}:${endpoint}`;
      const current = await this.redis.zcard(key);
      const boostMultiplier = boost ? JSON.parse(boost).multiplier : 1;
      
      const dynamicMax = this.calculateDynamicLimit(
        config.max,
        reputation.multiplier,
        systemLoad.multiplier,
        boostMultiplier,
        userId
      );
      
      status.quotas[endpoint] = {
        current,
        max: dynamicMax,
        baseMax: config.max,
        remaining: Math.max(0, dynamicMax - current),
        window: config.window
      };
    }
    
    return status;
  }
}

module.exports = new IntelligentRateLimiter();
