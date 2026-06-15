# REQ-00234: API 请求速率限制智能适配与动态配额系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00234 |
| 标题 | API 请求速率限制智能适配与动态配额系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、backend/shared、Redis、PostgreSQL |
| 创建时间 | 2026-06-15 22:05 |

## 需求描述

当前系统的 API 速率限制采用静态配置策略，存在以下问题：

1. **固定配额不合理**：正常用户在高峰期可能触发限流，而恶意用户可以通过多账号规避限制
2. **无法识别用户行为模式**：不同用户的使用模式差异大，固定阈值无法精准区分正常/异常行为
3. **缺乏动态调整能力**：无法根据系统负载、用户信誉、历史行为动态调整配额
4. **限流策略过于粗暴**：对所有接口采用统一限流策略，缺乏精细化控制

本需求实现一套智能速率限制系统，能够：
- 基于用户信誉度动态调整配额
- 根据系统负载自动调节限流阈值
- 识别异常请求模式并自动降级配额
- 提供精细化接口级别限流配置
- 支持临时配额提升（如活动期间）

## 技术方案

### 1. 用户信誉度评分系统

```javascript
// backend/shared/UserReputationScore.js

const Redis = require('ioredis');
const { logger, metrics } = require('./logger');
const { db } = require('./db');

class UserReputationScore {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
    this.SCORE_KEY_PREFIX = 'user:reputation:';
    this.BEHAVIOR_KEY_PREFIX = 'user:behavior:';
    
    // 信誉度因子权重
    this.FACTORS = {
      accountAge: 0.15,           // 账号年龄
      activityConsistency: 0.20,  // 活跃一致性
      violationHistory: 0.25,     // 违规历史（负向）
      paymentReliability: 0.15,   // 支付可靠性
      socialTrust: 0.10,          // 社交信任度
      gameplayNorms: 0.15         // 游戏行为规范性
    };
    
    // 信誉等级阈值
    this.LEVELS = {
      NEW: { min: 0, max: 30, multiplier: 0.5 },       // 新用户
      BRONZE: { min: 30, max: 50, multiplier: 0.8 },   // 青铜
      SILVER: { min: 50, max: 70, multiplier: 1.0 },   // 白银
      GOLD: { min: 70, max: 85, multiplier: 1.3 },     // 黄金
      PLATINUM: { min: 85, max: 100, multiplier: 1.5 } // 铂金
    };
  }
  
  /**
   * 计算用户综合信誉度
   */
  async calculateReputation(userId) {
    const cacheKey = `${this.SCORE_KEY_PREFIX}${userId}`;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 获取各维度数据
    const factors = await Promise.all([
      this.getAccountAge(userId),
      this.getActivityConsistency(userId),
      this.getViolationHistory(userId),
      this.getPaymentReliability(userId),
      this.getSocialTrust(userId),
      this.getGameplayNorms(userId)
    ]);
    
    // 计算加权总分
    let totalScore = 0;
    const breakdown = {};
    
    const factorNames = Object.keys(this.FACTORS);
    factors.forEach((score, index) => {
      const factorName = factorNames[index];
      const weight = this.FACTORS[factorName];
      totalScore += score * weight;
      breakdown[factorName] = { score, weight, contribution: score * weight };
    });
    
    // 确定信誉等级
    const level = this.determineLevel(totalScore);
    
    const result = {
      userId,
      totalScore: Math.round(totalScore * 100) / 100,
      level: level.name,
      multiplier: level.multiplier,
      breakdown,
      calculatedAt: new Date().toISOString()
    };
    
    // 缓存 1 小时
    await this.redis.setex(cacheKey, 3600, JSON.stringify(result));
    
    metrics.gauge('user_reputation_score', totalScore, { userId, level: level.name });
    
    return result;
  }
  
  /**
   * 账号年龄评分
   */
  async getAccountAge(userId) {
    const result = await db.query(
      `SELECT created_at FROM users WHERE id = $1`,
      [userId]
    );
    
    if (!result.rows.length) return 0;
    
    const ageInDays = (Date.now() - new Date(result.rows[0].created_at)) / (1000 * 60 * 60 * 24);
    
    // 年龄评分曲线：7天内快速上升，30天后趋于平缓
    if (ageInDays < 7) return Math.min(100, ageInDays * 10);
    if (ageInDays < 30) return 70 + (ageInDays - 7) * 1;
    if (ageInDays < 90) return 93 + (ageInDays - 30) * 0.1;
    return 100;
  }
  
  /**
   * 活跃一致性评分
   */
  async getActivityConsistency(userId) {
    const result = await db.query(`
      SELECT 
        COUNT(DISTINCT DATE(created_at)) as active_days,
        COUNT(*) as total_requests
      FROM api_access_logs
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '30 days'
    `, [userId]);
    
    if (!result.rows.length || result.rows[0].active_days === 0) return 50; // 默认中等
    
    const { active_days, total_requests } = result.rows[0];
    const avgRequestsPerDay = total_requests / active_days;
    
    // 活跃天数占比
    const dayConsistency = (active_days / 30) * 100;
    
    // 请求量合理性（异常高或低都扣分）
    const requestReasonability = avgRequestsPerDay > 10 && avgRequestsPerDay < 1000 
      ? 100 
      : Math.max(0, 100 - Math.abs(Math.log10(avgRequestsPerDay + 1) - 2) * 20);
    
    return (dayConsistency * 0.6 + requestReasonability * 0.4);
  }
  
  /**
   * 违规历史评分（负向指标）
   */
  async getViolationHistory(userId) {
    const result = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE severity = 'high') as high_violations,
        COUNT(*) FILTER (WHERE severity = 'medium') as medium_violations,
        COUNT(*) FILTER (WHERE severity = 'low') as low_violations,
        MAX(created_at) as last_violation
      FROM user_violations
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '90 days'
    `, [userId]);
    
    if (!result.rows.length) return 100;
    
    const { high_violations, medium_violations, low_violations, last_violation } = result.rows[0];
    
    // 扣分规则
    let deduction = 0;
    deduction += parseInt(high_violations || 0) * 30;
    deduction += parseInt(medium_violations || 0) * 10;
    deduction += parseInt(low_violations || 0) * 3;
    
    // 时间衰减：近期违规扣分更多
    if (last_violation) {
      const daysSinceViolation = (Date.now() - new Date(last_violation)) / (1000 * 60 * 60 * 24);
      const timeMultiplier = Math.max(0.5, 1 - daysSinceViolation / 90);
      deduction *= timeMultiplier;
    }
    
    return Math.max(0, 100 - deduction);
  }
  
  /**
   * 支付可靠性评分
   */
  async getPaymentReliability(userId) {
    const result = await db.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status = 'refunded') as refunded,
        COUNT(*) FILTER (WHERE status = 'chargeback') as chargebacks,
        COUNT(*) as total
      FROM payment_orders
      WHERE user_id = $1
    `, [userId]);
    
    if (!result.rows.length || result.rows[0].total === 0) return 70; // 无支付记录默认中等
    
    const { completed, refunded, chargebacks, total } = result.rows[0];
    
    // 拒付是严重负面信号
    const chargebackRate = parseInt(chargebacks || 0) / parseInt(total);
    if (chargebackRate > 0.05) return 20;
    if (chargebackRate > 0) return 50;
    
    // 退款率
    const refundRate = parseInt(refunded || 0) / parseInt(total);
    const refundScore = Math.max(0, 100 - refundRate * 200);
    
    // 完成率
    const completionRate = parseInt(completed || 0) / parseInt(total);
    const completionScore = completionRate * 100;
    
    return refundScore * 0.5 + completionScore * 0.5;
  }
  
  /**
   * 社交信任度评分
   */
  async getSocialTrust(userId) {
    const result = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM friendships WHERE user_id = $1 AND status = 'accepted') as friends,
        (SELECT COUNT(*) FROM guild_members WHERE user_id = $1) as guilds,
        (SELECT COUNT(*) FROM user_reports WHERE reported_user_id = $1) as reports_received,
        (SELECT COUNT(*) FROM user_reports WHERE reporter_id = $1 AND status = 'valid') as valid_reports
    `, [userId]);
    
    if (!result.rows.length) return 70;
    
    const { friends, guilds, reports_received, valid_reports } = result.rows[0];
    
    let score = 50;
    
    // 好友数加分
    score += Math.min(20, parseInt(friends || 0) * 0.5);
    
    // 公会成员加分
    score += Math.min(10, parseInt(guilds || 0) * 5);
    
    // 被举报扣分
    score -= Math.min(40, parseInt(reports_received || 0) * 10);
    
    // 有效举报加分（社区贡献）
    score += Math.min(10, parseInt(valid_reports || 0) * 2);
    
    return Math.max(0, Math.min(100, score));
  }
  
  /**
   * 游戏行为规范性评分
   */
  async getGameplayNorms(userId) {
    const result = await db.query(`
      SELECT 
        AVG(catch_rate) as avg_catch_rate,
        AVG(battle_win_rate) as avg_win_rate,
        COUNT(*) FILTER (WHERE is_suspicious = true) as suspicious_actions
      FROM user_gameplay_stats
      WHERE user_id = $1
        AND created_at > NOW() - INTERVAL '30 days'
    `, [userId]);
    
    if (!result.rows.length) return 70;
    
    const { avg_catch_rate, avg_win_rate, suspicious_actions } = result.rows[0];
    
    let score = 80;
    
    // 异常捕捉率扣分（过高可能使用外挂）
    const catchRate = parseFloat(avg_catch_rate) || 0;
    if (catchRate > 0.95) score -= 30;
    else if (catchRate > 0.85) score -= 10;
    
    // 异常胜率扣分
    const winRate = parseFloat(avg_win_rate) || 0;
    if (winRate > 0.9) score -= 20;
    else if (winRate > 0.8) score -= 5;
    
    // 可疑行为扣分
    score -= Math.min(30, parseInt(suspicious_actions || 0) * 5);
    
    return Math.max(0, score);
  }
  
  /**
   * 确定信誉等级
   */
  determineLevel(score) {
    for (const [name, config] of Object.entries(this.LEVELS)) {
      if (score >= config.min && score < config.max) {
        return { name, ...config };
      }
    }
    return { name: 'PLATINUM', ...this.LEVELS.PLATINUM };
  }
  
  /**
   * 记录行为事件（影响未来评分）
   */
  async recordBehaviorEvent(userId, eventType, data = {}) {
    const key = `${this.BEHAVIOR_KEY_PREFIX}${userId}`;
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      ...data
    };
    
    await this.redis.lpush(key, JSON.stringify(event));
    await this.redis.ltrim(key, 0, 999); // 保留最近 1000 条
    
    // 根据事件类型更新评分
    const scoreDelta = this.getEventScoreDelta(eventType, data);
    if (scoreDelta !== 0) {
      await this.adjustReputationScore(userId, scoreDelta);
    }
  }
  
  getEventScoreDelta(eventType, data) {
    const deltas = {
      'violation_high': -30,
      'violation_medium': -10,
      'violation_low': -3,
      'valid_report': 2,
      'payment_completed': 5,
      'payment_refunded': -5,
      'chargeback': -50,
      'suspicious_catch': -5,
      'friend_accepted': 1,
      'guild_joined': 2
    };
    
    return deltas[eventType] || 0;
  }
  
  async adjustReputationScore(userId, delta) {
    const cacheKey = `${this.SCORE_KEY_PREFIX}${userId}`;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      const data = JSON.parse(cached);
      data.totalScore = Math.max(0, Math.min(100, data.totalScore + delta));
      data.level = this.determineLevel(data.totalScore).name;
      await this.redis.setex(cacheKey, 3600, JSON.stringify(data));
    }
    
    // 清除缓存，下次重新计算
    await this.redis.del(cacheKey);
    
    logger.info('Reputation score adjusted', { userId, delta });
  }
}

module.exports = new UserReputationScore();
```

### 2. 智能限流中间件

```javascript
// backend/shared/IntelligentRateLimiter.js

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
    
    // 计算动态配额
    const dynamicLimit = this.calculateDynamicLimit(
      baseLimit.max,
      reputation.multiplier,
      systemLoad.multiplier,
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
    metrics.increment('rate_limit_check', 1, {
      userId,
      endpoint: key,
      allowed: result.allowed,
      reputationLevel: reputation.level,
      systemLoadLevel: systemLoad.level
    });
    
    return {
      ...result,
      reputationLevel: reputation.level,
      systemLoadLevel: systemLoad.level
    };
  }
  
  /**
   * 计算动态配额
   */
  calculateDynamicLimit(baseMax, reputationMultiplier, systemMultiplier, userId) {
    // 基础配额 × 信誉倍数 × 系统负载倍数
    let dynamicLimit = Math.floor(baseMax * reputationMultiplier * systemMultiplier);
    
    // 保证最低配额（防止用户完全无法使用）
    dynamicLimit = Math.max(5, dynamicLimit);
    
    logger.debug('Dynamic limit calculated', {
      userId,
      baseMax,
      reputationMultiplier,
      systemMultiplier,
      dynamicLimit
    });
    
    return dynamicLimit;
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
    
    // 从 Prometheus 或系统指标获取负载
    // 这里简化实现，实际应从监控系统集成
    const load = {
      cpu: process.cpuUsage().user / 1000000, // 秒
      memory: process.memoryUsage().heapUsed / process.memoryUsage().heapTotal,
      connections: 0 // 从连接池获取
    };
    
    const overallLoad = (load.cpu + load.memory) / 2;
    
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
      const dynamicMax = this.calculateDynamicLimit(
        config.max,
        reputation.multiplier,
        systemLoad.multiplier,
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
```

### 3. Gateway 集成中间件

```javascript
// gateway/src/middleware/intelligentRateLimit.js

const rateLimiter = require('../../shared/IntelligentRateLimiter');
const { logger } = require('../../shared/logger');

/**
 * 智能限流中间件
 */
async function intelligentRateLimitMiddleware(req, res, next) {
  // 排除健康检查等接口
  const excludedPaths = ['/health', '/metrics', '/favicon.ico'];
  if (excludedPaths.some(path => req.path.startsWith(path))) {
    return next();
  }
  
  // 未登录用户使用 IP 限流
  const userId = req.user?.id || `ip:${req.ip}`;
  const endpoint = req.path;
  const method = req.method;
  
  try {
    const result = await rateLimiter.checkLimit(userId, endpoint, method);
    
    // 设置响应头
    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', result.resetAt);
    res.setHeader('X-Reputation-Level', result.reputationLevel);
    
    if (!result.allowed) {
      res.setHeader('Retry-After', result.retryAfter);
      
      logger.warn('Request rate limited', {
        userId,
        endpoint,
        method,
        current: result.current,
        limit: result.limit,
        reputationLevel: result.reputationLevel,
        ip: req.ip
      });
      
      return res.status(429).json({
        error: 'Too Many Requests',
        message: '请求过于频繁，请稍后再试',
        retryAfter: result.retryAfter,
        reputationLevel: result.reputationLevel
      });
    }
    
    next();
  } catch (error) {
    logger.error('Rate limit check failed', {
      userId,
      endpoint,
      method,
      error: error.message
    });
    
    // 限流检查失败时放行，避免影响正常请求
    next();
  }
}

module.exports = intelligentRateLimitMiddleware;
```

### 4. 管理接口 - 配额管理

```javascript
// gateway/src/routes/admin/rateLimitAdmin.js

const express = require('express');
const router = express.Router();
const rateLimiter = require('../../../shared/IntelligentRateLimiter');
const userReputation = require('../../../shared/UserReputationScore');
const { requireAdmin } = require('../../middleware/auth');

/**
 * 获取用户配额状态
 */
router.get('/quota/:userId', requireAdmin, async (req, res) => {
  try {
    const status = await rateLimiter.getQuotaStatus(req.params.userId);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 授予临时配额提升
 */
router.post('/boost/:userId', requireAdmin, async (req, res) => {
  try {
    const { multiplier, durationSeconds, reason } = req.body;
    
    if (!multiplier || multiplier < 1 || multiplier > 10) {
      return res.status(400).json({ error: 'multiplier must be between 1 and 10' });
    }
    
    if (!durationSeconds || durationSeconds < 60 || durationSeconds > 86400) {
      return res.status(400).json({ error: 'durationSeconds must be between 60 and 86400' });
    }
    
    await rateLimiter.grantTemporaryBoost(
      req.params.userId,
      multiplier,
      durationSeconds,
      reason || 'Admin granted'
    );
    
    res.json({
      success: true,
      message: 'Temporary boost granted',
      multiplier,
      durationSeconds,
      reason
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 重置用户限流计数
 */
router.post('/reset/:userId', requireAdmin, async (req, res) => {
  try {
    const { endpoint } = req.body;
    const key = `ratelimit:${req.params.userId}:${endpoint || '*'}`;
    
    if (endpoint) {
      await rateLimiter.redis.del(key);
    } else {
      // 重置所有接口
      const keys = await rateLimiter.redis.keys(`ratelimit:${req.params.userId}:*`);
      if (keys.length > 0) {
        await rateLimiter.redis.del(...keys);
      }
    }
    
    res.json({ success: true, message: 'Rate limit counters reset' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取信誉度详情
 */
router.get('/reputation/:userId', requireAdmin, async (req, res) => {
  try {
    const reputation = await userReputation.calculateReputation(req.params.userId);
    res.json(reputation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 手动调整信誉度
 */
router.post('/reputation/:userId/adjust', requireAdmin, async (req, res) => {
  try {
    const { delta, reason } = req.body;
    
    if (typeof delta !== 'number' || delta < -100 || delta > 100) {
      return res.status(400).json({ error: 'delta must be between -100 and 100' });
    }
    
    await userReputation.adjustReputationScore(req.params.userId, delta);
    
    // 记录审计日志
    logger.info('Reputation manually adjusted', {
      adminId: req.user.id,
      targetUserId: req.params.userId,
      delta,
      reason
    });
    
    res.json({ success: true, delta, reason });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取系统限流统计
 */
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const systemLoad = await rateLimiter.getSystemLoad();
    
    // 获取限流事件统计
    const keys = await rateLimiter.redis.keys('ratelimit:events:*');
    let totalEvents = 0;
    const topUsers = [];
    
    for (const key of keys.slice(0, 100)) {
      const count = await rateLimiter.redis.llen(key);
      totalEvents += count;
      const userId = key.replace('ratelimit:events:', '');
      topUsers.push({ userId, eventCount: count });
    }
    
    topUsers.sort((a, b) => b.eventCount - a.eventCount);
    
    res.json({
      systemLoad,
      totalRateLimitedUsers: keys.length,
      totalLimitEvents: totalEvents,
      topRateLimitedUsers: topUsers.slice(0, 10)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### 5. 数据库迁移

```sql
-- database/migrations/20260615220000_create_user_violations_table.sql

-- 用户违规记录表
CREATE TABLE IF NOT EXISTS user_violations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id)
);

CREATE INDEX idx_user_violations_user_id ON user_violations(user_id);
CREATE INDEX idx_user_violations_created_at ON user_violations(created_at);
CREATE INDEX idx_user_violations_severity ON user_violations(severity);

-- 用户游戏行为统计表
CREATE TABLE IF NOT EXISTS user_gameplay_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  catch_rate DECIMAL(5,4),
  battle_win_rate DECIMAL(5,4),
  is_suspicious BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_gameplay_stats_user_id ON user_gameplay_stats(user_id);
CREATE INDEX idx_user_gameplay_stats_created_at ON user_gameplay_stats(created_at);

-- 临时配额提升记录表
CREATE TABLE IF NOT EXISTS rate_limit_boosts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  multiplier DECIMAL(3,2) NOT NULL,
  duration_seconds INTEGER NOT NULL,
  reason TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  granted_by INTEGER REFERENCES users(id)
);

CREATE INDEX idx_rate_limit_boosts_user_id ON rate_limit_boosts(user_id);
CREATE INDEX idx_rate_limit_boosts_expires_at ON rate_limit_boosts(expires_at);

-- 触发器：自动清理过期的提升记录
CREATE OR REPLACE FUNCTION cleanup_expired_boosts()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM rate_limit_boosts WHERE expires_at < NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_cleanup_expired_boosts
AFTER INSERT ON rate_limit_boosts
EXECUTE FUNCTION cleanup_expired_boosts();
```

## 验收标准

- [ ] 用户信誉度评分系统上线，包含 6 个评分维度
- [ ] 信誉等级分为 5 级（NEW/BRONZE/SILVER/GOLD/PLATINUM）
- [ ] 高信誉用户配额可提升至基础值的 1.5 倍
- [ ] 低信誉用户配额限制为基础值的 0.5 倍
- [ ] 系统负载高时自动降级配额（最低 0.3 倍）
- [ ] 滑动窗口限流算法正确实现
- [ ] 管理员可授予临时配额提升（1-10 倍，最长 24 小时）
- [ ] 频繁触发限流会降低用户信誉度
- [ ] 提供 6 个管理接口（配额查询、提升、重置、信誉查询、调整、统计）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证端到端限流流程
- [ ] 性能测试：限流检查延迟 < 5ms（P99）

## 影响范围

- 新增文件：
  - `backend/shared/UserReputationScore.js`
  - `backend/shared/IntelligentRateLimiter.js`
  - `gateway/src/middleware/intelligentRateLimit.js`
  - `gateway/src/routes/admin/rateLimitAdmin.js`
  - `database/migrations/20260615220000_create_user_violations_table.sql`

- 修改文件：
  - `gateway/src/index.js`（集成新中间件）
  - `backend/shared/logger.js`（添加相关指标）

- 依赖服务：
  - Redis（限流计数器、缓存）
  - PostgreSQL（用户行为数据存储）

## 参考

- [Redis Rate Limiting Patterns](https://redis.io/commands/INCR#pattern-rate-limiter-2)
- [RFC 6585 - HTTP Status Code 429](https://tools.ietf.org/html/rfc6585#section-4)
- [Stripe Rate Limiting Design](https://stripe.com/blog/rate-limiters)
- [Cloudflare Intelligent Rate Limiting](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
