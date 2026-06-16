// backend/shared/rateLimitMonitor.js
// REQ-00147: API 请求速率限制绕过检测与防护系统

'use strict';

const { createLogger } = require('./logger');
const { getRedisClient } = require('./redis');
const { getClient: getDbClient } = require('./db');

const logger = createLogger('rate-limit-monitor');

/**
 * IP 轮换检测器
 * 检测短时间内同一账号使用多个 IP
 */
class IPRotationDetector {
  constructor(redis, config = {}) {
    this.redis = redis;
    this.windowSeconds = config.windowSeconds || 3600; // 1小时窗口
    this.ipThreshold = config.ipThreshold || 3; // 超过3个IP触发检测
    this.geoThreshold = config.geoThreshold || 1000; // 跨國距离阈值(km)
  }

  /**
   * 记录用户 IP 访问
   * @param {string} userId - 用户ID
   * @param {string} ip - IP地址
   */
  async recordIPAccess(userId, ip) {
    const key = `ratelimit:ips:${userId}`;
    const now = Date.now();
    
    // 使用 sorted set 存储 IP 和时间戳
    await this.redis.zadd(key, now, `${ip}:${now}`);
    
    // 清理过期记录
    const cutoff = now - this.windowSeconds * 1000;
    await this.redis.zremrangebyscore(key, '-inf', cutoff);
    
    // 设置过期时间
    await this.redis.expire(key, this.windowSeconds);
  }

  /**
   * 检测 IP 轮换行为
   * @param {string} userId - 用户ID
   * @param {string} currentIP - 当前IP
   * @returns {Object} 检测结果
   */
  async detectIPRotation(userId, currentIP) {
    const key = `ratelimit:ips:${userId}`;
    
    // 记录当前访问
    await this.recordIPAccess(userId, currentIP);
    
    // 获取最近的所有 IP 记录
    const records = await this.redis.zrange(key, 0, -1);
    const ips = [...new Set(records.map(r => r.split(':')[0]))];
    
    const uniqueIPCount = ips.length;
    
    // 风险评分
    let riskScore = 0;
    if (uniqueIPCount > 10) riskScore = 100;
    else if (uniqueIPCount > 5) riskScore = 70;
    else if (uniqueIPCount > 3) riskScore = 40;
    
    // 检查 IP 地理位置（简化版：检查 IP 前两段是否相同）
    const geoSpread = this.calculateGeoSpread(ips);
    if (geoSpread > 0.5) riskScore += 20; // 不同网段
    
    const result = {
      isRotation: uniqueIPCount > this.ipThreshold,
      riskScore: Math.min(100, riskScore),
      uniqueIPCount,
      geoSpread,
      ips: ips.slice(0, 10), // 只返回前10个
      timestamp: new Date().toISOString(),
    };
    
    if (result.isRotation) {
      logger.warn('IP rotation detected', {
        userId,
        uniqueIPCount,
        riskScore: result.riskScore,
        currentIP,
      });
    }
    
    return result;
  }

  /**
   * 计算 IP 地理分散度（简化版）
   * @param {string[]} ips - IP列表
   * @returns {number} 分散度 0-1
   */
  calculateGeoSpread(ips) {
    if (ips.length < 2) return 0;
    
    // 提取 IP 前两段作为网段标识
    const segments = new Set(
      ips.map(ip => ip.split('.').slice(0, 2).join('.'))
    );
    
    // 不同网段比例
    return segments.size / ips.length;
  }
}

/**
 * 账号分摊检测器
 * 检测同一 IP 下多账号协同请求
 */
class AccountDistributionDetector {
  constructor(redis, config = {}) {
    this.redis = redis;
    this.windowSeconds = config.windowSeconds || 300; // 5分钟窗口
    this.accountThreshold = config.accountThreshold || 3;
  }

  /**
   * 记录 IP 下的账号访问
   * @param {string} ip - IP地址
   * @param {string} userId - 用户ID
   * @param {string} endpoint - 端点
   */
  async recordAccountAccess(ip, userId, endpoint) {
    const key = `ratelimit:accounts:${ip}`;
    const now = Date.now();
    
    await this.redis.zadd(key, now, `${userId}:${endpoint}:${now}`);
    
    // 清理过期记录
    const cutoff = now - this.windowSeconds * 1000;
    await this.redis.zremrangebyscore(key, '-inf', cutoff);
    await this.redis.expire(key, this.windowSeconds);
  }

  /**
   * 检测账号分摊行为
   * @param {string} ip - IP地址
   * @returns {Object} 检测结果
   */
  async detectAccountDistribution(ip) {
    const key = `ratelimit:accounts:${ip}`;
    
    const records = await this.redis.zrange(key, 0, -1);
    const accounts = [...new Set(records.map(r => r.split(':')[0]))];
    
    if (accounts.length < this.accountThreshold) {
      return { isDistribution: false, riskScore: 0, accountCount: accounts.length };
    }
    
    // 分析请求时间模式
    const timestamps = records.map(r => parseInt(r.split(':').pop()));
    const correlation = this.calculateTimeCorrelation(timestamps);
    
    const result = {
      isDistribution: correlation > 0.7 && accounts.length > this.accountThreshold,
      riskScore: Math.min(100, (correlation * 50 + accounts.length * 5)),
      accountCount: accounts.length,
      correlation,
      accounts: accounts.slice(0, 10),
      timestamp: new Date().toISOString(),
    };
    
    if (result.isDistribution) {
      logger.warn('Account distribution detected', {
        ip,
        accountCount: accounts.length,
        riskScore: result.riskScore,
        correlation,
      });
    }
    
    return result;
  }

  /**
   * 计算时间相关性（请求是否高度同步）
   * @param {number[]} timestamps - 时间戳列表
   * @returns {number} 相关性 0-1
   */
  calculateTimeCorrelation(timestamps) {
    if (timestamps.length < 4) return 0;
    
    // 计算时间间隔的标准差
    timestamps.sort((a, b) => a - b);
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }
    
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, i) => sum + Math.pow(i - mean, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    
    // 标准差越小，相关性越高（请求时间越规律）
    const maxStdDev = mean * 2;
    return Math.max(0, 1 - stdDev / maxStdDev);
  }
}

/**
 * 时间窗口边界攻击检测器
 * 检测窗口边界集中请求
 */
class WindowBoundaryDetector {
  constructor(redis, config = {}) {
    this.redis = redis;
    this.windowMs = config.windowMs || 60000; // 1分钟窗口
  }

  /**
   * 记录请求时间
   * @param {string} userId - 用户ID
   * @param {string} endpoint - 端点
   */
  async recordRequestTime(userId, endpoint) {
    const key = `ratelimit:requests:${userId}:${endpoint}`;
    const now = Date.now();
    
    await this.redis.zadd(key, now, now.toString());
    
    // 保留最近2个窗口的数据
    const cutoff = now - this.windowMs * 2;
    await this.redis.zremrangebyscore(key, '-inf', cutoff);
    await this.redis.expire(key, Math.ceil(this.windowMs * 2 / 1000));
  }

  /**
   * 检测边界攻击
   * @param {string} userId - 用户ID
   * @param {string} endpoint - 端点
   * @returns {Object} 检测结果
   */
  async detectBoundaryAttack(userId, endpoint) {
    const key = `ratelimit:requests:${userId}:${endpoint}`;
    const now = Date.now();
    
    await this.recordRequestTime(userId, endpoint);
    
    const requests = await this.redis.zrange(key, 0, -1, 'WITHSCORES');
    
    if (requests.length < 10) {
      return { isBoundaryAttack: false, riskScore: 0 };
    }
    
    // 分析请求在窗口中的位置
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs;
    const boundaryStart = windowStart + this.windowMs * 0.9; // 窗口末尾10%
    
    let boundaryCount = 0;
    let totalCount = 0;
    
    for (let i = 0; i < requests.length; i += 2) {
      const timestamp = parseInt(requests[i + 1]);
      if (timestamp >= windowStart) {
        totalCount++;
        if (timestamp >= boundaryStart) {
          boundaryCount++;
        }
      }
    }
    
    const boundaryRatio = totalCount > 0 ? boundaryCount / totalCount : 0;
    
    const result = {
      isBoundaryAttack: boundaryRatio > 0.5 && totalCount > 5,
      riskScore: Math.min(100, boundaryRatio * 100 + (totalCount > 10 ? 20 : 0)),
      boundaryRatio,
      boundaryCount,
      totalCount,
      timestamp: new Date().toISOString(),
    };
    
    if (result.isBoundaryAttack) {
      logger.warn('Boundary attack detected', {
        userId,
        endpoint,
        boundaryRatio,
        riskScore: result.riskScore,
      });
    }
    
    return result;
  }
}

/**
 * 限流状态完整性验证器
 */
class RateLimitIntegrityValidator {
  constructor(redis, config = {}) {
    this.redis = redis;
    this.tolerance = config.tolerance || 0.1; // 10% 容差
  }

  /**
   * 验证限流状态完整性
   * @param {string} key - Redis key
   * @param {number} expectedCount - 预期计数
   * @returns {Object} 验证结果
   */
  async validateRateLimitState(key, expectedCount) {
    const actualCount = parseInt(await this.redis.get(key) || '0');
    
    const discrepancy = Math.abs(actualCount - expectedCount);
    const discrepancyRatio = expectedCount > 0 ? discrepancy / expectedCount : 0;
    
    const result = {
      valid: discrepancyRatio <= this.tolerance,
      tampered: discrepancyRatio > this.tolerance,
      actualCount,
      expectedCount,
      discrepancy,
      discrepancyRatio,
      timestamp: new Date().toISOString(),
    };
    
    if (result.tampered) {
      logger.error('Rate limit state tampering detected', {
        key,
        actualCount,
        expectedCount,
        discrepancyRatio,
      });
    }
    
    return result;
  }

  /**
   * 重置被篡改的限流状态
   * @param {string} key - Redis key
   * @param {number} correctCount - 正确计数
   */
  async resetTamperedState(key, correctCount) {
    await this.redis.set(key, correctCount.toString());
    logger.info('Reset tampered rate limit state', { key, correctCount });
  }
}

/**
 * 绕过行为处理器
 */
class BypassHandler {
  constructor(db, redis, config = {}) {
    this.db = db;
    this.redis = redis;
    this.autoBlockThreshold = config.autoBlockThreshold || 80;
    this.blockDurationMs = config.blockDurationMs || 3600000; // 1小时
  }

  /**
   * 记录绕过尝试
   * @param {Object} attempt - 绕过尝试信息
   */
  async recordBypassAttempt(attempt) {
    const query = `
      INSERT INTO rate_limit_bypass_attempts (
        user_id, ip, type, risk_score, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING id
    `;
    
    const result = await this.db.query(query, [
      attempt.userId,
      attempt.ip,
      attempt.type,
      attempt.riskScore,
      JSON.stringify(attempt.details),
    ]);
    
    // 更新 Redis 统计
    const statsKey = `ratelimit:stats:${attempt.type}`;
    await this.redis.hincrby(statsKey, 'total', 1);
    if (attempt.blocked) {
      await this.redis.hincrby(statsKey, 'blocked', 1);
    }
    
    return result.rows[0].id;
  }

  /**
   * 处理绕过行为
   * @param {Object} detection - 检测结果
   * @param {string} userId - 用户ID
   * @param {string} ip - IP地址
   * @returns {Object} 处理结果
   */
  async handleBypass(detection, userId, ip) {
    const shouldBlock = detection.riskScore >= this.autoBlockThreshold;
    
    if (shouldBlock) {
      await this.blockUser(userId, detection.type, detection.riskScore);
    }
    
    // 记录尝试
    const attemptId = await this.recordBypassAttempt({
      userId,
      ip,
      type: detection.type,
      riskScore: detection.riskScore,
      details: detection,
      blocked: shouldBlock,
    });
    
    return {
      attemptId,
      blocked: shouldBlock,
      riskScore: detection.riskScore,
    };
  }

  /**
   * 封禁用户
   * @param {string} userId - 用户ID
   * @param {string} reason - 原因
   * @param {number} riskScore - 风险分数
   */
  async blockUser(userId, reason, riskScore) {
    const blockKey = `ratelimit:blocked:${userId}`;
    const expiresAt = Date.now() + this.blockDurationMs;
    
    await this.redis.set(blockKey, JSON.stringify({
      reason,
      riskScore,
      blockedAt: new Date().toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    }), 'PX', this.blockDurationMs);
    
    // 记录到数据库
    const query = `
      INSERT INTO rate_limit_blocks (
        user_id, reason, risk_score, blocked_until, created_at
      ) VALUES ($1, $2, $3, $4, NOW())
    `;
    
    await this.db.query(query, [
      userId,
      reason,
      riskScore,
      new Date(expiresAt),
    ]);
    
    logger.warn('User blocked for rate limit bypass', {
      userId,
      reason,
      riskScore,
      duration: this.blockDurationMs,
    });
  }

  /**
   * 检查用户是否被封禁
   * @param {string} userId - 用户ID
   * @returns {Object|null} 封禁信息
   */
  async checkBlocked(userId) {
    const blockKey = `ratelimit:blocked:${userId}`;
    const blocked = await this.redis.get(blockKey);
    
    if (blocked) {
      return JSON.parse(blocked);
    }
    
    return null;
  }
}

/**
 * 限流绕过监控主类
 */
class RateLimitMonitor {
  constructor(config = {}) {
    this.redis = config.redis || getRedisClient();
    this.db = config.db || getDbClient();
    
    this.ipRotationDetector = new IPRotationDetector(this.redis, config.ipRotation);
    this.accountDistributionDetector = new AccountDistributionDetector(this.redis, config.accountDistribution);
    this.windowBoundaryDetector = new WindowBoundaryDetector(this.redis, config.windowBoundary);
    this.integrityValidator = new RateLimitIntegrityValidator(this.redis, config.integrity);
    this.bypassHandler = new BypassHandler(this.db, this.redis, config.bypass);
    
    this.enabled = config.enabled !== false;
  }

  /**
   * 综合检测
   * @param {string} userId - 用户ID
   * @param {string} ip - IP地址
   * @param {string} endpoint - 端点
   * @returns {Object} 综合检测结果
   */
  async comprehensiveCheck(userId, ip, endpoint) {
    if (!this.enabled) {
      return { enabled: false };
    }
    
    // 先检查是否已被封禁
    const blocked = await this.bypassHandler.checkBlocked(userId);
    if (blocked) {
      return {
        blocked: true,
        blockInfo: blocked,
        riskScore: 100,
      };
    }
    
    // 并行执行所有检测
    const [ipRotation, accountDistribution, boundaryAttack] = await Promise.all([
      this.ipRotationDetector.detectIPRotation(userId, ip),
      this.accountDistributionDetector.detectAccountDistribution(ip),
      this.windowBoundaryDetector.detectBoundaryAttack(userId, endpoint),
    ]);
    
    // 计算综合风险分数
    const riskScore = Math.max(
      ipRotation.riskScore,
      accountDistribution.riskScore,
      boundaryAttack.riskScore
    );
    
    const result = {
      ipRotation,
      accountDistribution,
      boundaryAttack,
      riskScore,
      shouldBlock: riskScore >= 80,
      timestamp: new Date().toISOString(),
    };
    
    // 如果检测到绕过行为，记录并处理
    if (riskScore >= 40) {
      const type = ipRotation.isRotation ? 'ip_rotation' :
                   accountDistribution.isDistribution ? 'account_distribution' :
                   boundaryAttack.isBoundaryAttack ? 'boundary_attack' : 'unknown';
      
      const handling = await this.bypassHandler.handleBypass(
        { type, riskScore, ...result[type] },
        userId,
        ip
      );
      
      result.handling = handling;
    }
    
    return result;
  }

  /**
   * 获取统计信息
   * @param {Object} options - 查询选项
   * @returns {Object} 统计信息
   */
  async getStats(options = {}) {
    const { startDate, endDate } = options;
    
    // 从 Redis 获取实时统计
    const types = ['ip_rotation', 'account_distribution', 'boundary_attack'];
    const stats = {};
    
    for (const type of types) {
      const key = `ratelimit:stats:${type}`;
      stats[type] = {
        total: parseInt(await this.redis.hget(key, 'total') || '0'),
        blocked: parseInt(await this.redis.hget(key, 'blocked') || '0'),
      };
    }
    
    // 从数据库获取历史统计
    const query = `
      SELECT 
        type,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE blocked = true) as blocked,
        AVG(risk_score) as avg_risk_score
      FROM rate_limit_bypass_attempts
      WHERE created_at >= $1 AND created_at <= $2
      GROUP BY type
    `;
    
    const dbResult = await this.db.query(query, [
      startDate || new Date(Date.now() - 86400000),
      endDate || new Date(),
    ]);
    
    return {
      realtime: stats,
      historical: dbResult.rows,
    };
  }
}

module.exports = {
  RateLimitMonitor,
  IPRotationDetector,
  AccountDistributionDetector,
  WindowBoundaryDetector,
  RateLimitIntegrityValidator,
  BypassHandler,
};
