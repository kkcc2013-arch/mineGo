// backend/shared/AdaptiveRateLimitMiddleware.js
// REQ-00098: 自适应限流中间件

'use strict';

const { adaptiveRateLimiter, userQuotaManager } = require('./AdaptiveRateLimiter');
const { createLogger } = require('./logger');
const { query } = require('./db');
const os = require('os');

const logger = createLogger('rate-limit-middleware');

/**
 * 系统指标收集器
 */
class SystemMetricsCollector {
  constructor() {
    this.lastCpuUsage = process.cpuUsage();
    this.lastCheckTime = Date.now();
  }

  /**
   * 获取 CPU 使用率
   */
  getCpuUsage() {
    const currentUsage = process.cpuUsage(this.lastCpuUsage);
    const now = Date.now();
    const elapsedMs = now - this.lastCheckTime;

    // 计算 CPU 使用百分比
    const userPercent = (currentUsage.user / 1000) / elapsedMs * 100;
    const systemPercent = (currentUsage.system / 1000) / elapsedMs * 100;
    const totalPercent = userPercent + systemPercent;

    this.lastCpuUsage = process.cpuUsage();
    this.lastCheckTime = now;

    return Math.min(100, totalPercent);
  }

  /**
   * 获取内存使用率
   */
  getMemoryUsage() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return (usedMemory / totalMemory) * 100;
  }

  /**
   * 获取所有系统指标
   */
  getSystemMetrics() {
    return {
      cpu: this.getCpuUsage(),
      memory: this.getMemoryUsage(),
      avgResponseTime: this.getAverageResponseTime()
    };
  }

  /**
   * 获取平均响应时间（从 Redis 或内存）
   */
  getAverageResponseTime() {
    // 从最近请求的响应时间计算（简单实现）
    // 实际项目中应该从 Prometheus 或监控系统获取
    return global.avgResponseTime || 200;
  }

  /**
   * 更新响应时间统计
   */
  updateResponseTime(responseTime) {
    if (!global.responseTimes) {
      global.responseTimes = [];
    }

    global.responseTimes.push(responseTime);

    // 只保留最近 100 个
    if (global.responseTimes.length > 100) {
      global.responseTimes.shift();
    }

    // 计算平均值
    global.avgResponseTime = global.responseTimes.reduce((a, b) => a + b, 0) / global.responseTimes.length;
  }
}

const metricsCollector = new SystemMetricsCollector();

/**
 * 自适应限流中间件
 */
function adaptiveRateLimitMiddleware(options = {}) {
  const {
    enabled = true,
    excludePaths = ['/health', '/metrics', '/api/v2/user/quota'],
    onBlocked = null
  } = options;

  // 定期检查并调整限流因子
  let adjustmentInterval = null;

  if (enabled) {
    adjustmentInterval = setInterval(async () => {
      try {
        const systemMetrics = metricsCollector.getSystemMetrics();
        await adaptiveRateLimiter.adjustLimit(systemMetrics);
      } catch (err) {
        logger.error({ err }, 'Failed to adjust rate limit');
      }
    }, 5000); // 每 5 秒调整一次
  }

  return async (req, res, next) => {
    if (!enabled) {
      return next();
    }

    // 排除特定路径
    if (excludePaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    // 未认证用户使用 IP 限流
    const userId = req.user?.id || req.ip;
    const apiPath = req.path;
    const userLevel = req.user?.quotaLevel || 'free';

    try {
      // 检查 API 限流
      const rateLimitResult = await adaptiveRateLimiter.checkRateLimit(userId, apiPath, { userLevel });

      // 设置响应头
      res.set({
        'X-RateLimit-Limit': rateLimitResult.limit,
        'X-RateLimit-Remaining': rateLimitResult.remaining,
        'X-RateLimit-Reset': rateLimitResult.resetIn,
        'X-RateLimit-Tier': rateLimitResult.tier
      });

      if (!rateLimitResult.allowed) {
        // 被限流
        if (onBlocked) {
          return onBlocked(req, res, rateLimitResult);
        }

        logger.warn({
          userId,
          apiPath,
          tier: rateLimitResult.tier,
          current: rateLimitResult.current,
          limit: rateLimitResult.limit
        }, 'Request blocked by rate limit');

        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: '请求过于频繁，请稍后再试',
            retryAfter: rateLimitResult.resetIn,
            limit: rateLimitResult.limit,
            current: rateLimitResult.current
          }
        });
      }

      // 检查用户配额
      if (req.user?.id) {
        const quotaStatus = await userQuotaManager.getUserQuota(userId);
        const effectiveMinuteLimit = Math.floor(quotaStatus.minute_limit * quotaStatus.quota_multiplier);

        if (quotaStatus.used_this_minute >= effectiveMinuteLimit) {
          logger.warn({
            userId,
            used: quotaStatus.used_this_minute,
            limit: effectiveMinuteLimit
          }, 'User quota exceeded');

          return res.status(429).json({
            success: false,
            error: {
              code: 'QUOTA_EXCEEDED',
              message: '您的请求配额已用尽，请稍后再试',
              quotaLevel: quotaStatus.quota_level,
              used: quotaStatus.used_this_minute,
              limit: effectiveMinuteLimit,
              resetIn: 60 - new Date().getSeconds()
            }
          });
        }

        // 增加使用量
        await userQuotaManager.incrementUsage(userId, apiPath);
      }

      // 记录响应时间
      const startTime = Date.now();

      res.on('finish', () => {
        const responseTime = Date.now() - startTime;
        metricsCollector.updateResponseTime(responseTime);
      });

      next();
    } catch (err) {
      logger.error({ err, userId, apiPath }, 'Rate limit middleware error');
      // 出错时允许请求（降级策略）
      next();
    }
  };
}

/**
 * 反作弊联动处理函数
 * 当反作弊系统检测到异常时调用
 */
async function handleAnomalyDetection(userId, anomalyScore) {
  try {
    if (anomalyScore > 80) {
      // 高风险：降低配额到 30%
      await userQuotaManager.adjustUserQuota(userId, {
        quotaMultiplier: 0.3,
        reason: '高风险异常行为',
        duration: '30d'
      });

      logger.warn({
        event: 'ANOMALY_HIGH_RISK',
        userId,
        anomalyScore
      }, 'High risk anomaly detected, quota reduced to 30%');
    } else if (anomalyScore > 60) {
      // 中风险：降低配额到 50%
      await userQuotaManager.adjustUserQuota(userId, {
        quotaMultiplier: 0.5,
        reason: '中风险异常行为',
        duration: '14d'
      });

      logger.warn({
        event: 'ANOMALY_MEDIUM_RISK',
        userId,
        anomalyScore
      }, 'Medium risk anomaly detected, quota reduced to 50%');
    } else if (anomalyScore > 40) {
      // 低风险：降低配额到 70%
      await userQuotaManager.adjustUserQuota(userId, {
        quotaMultiplier: 0.7,
        reason: '低风险异常行为',
        duration: '7d'
      });

      logger.info({
        event: 'ANOMALY_LOW_RISK',
        userId,
        anomalyScore
      }, 'Low risk anomaly detected, quota reduced to 70%');
    }
  } catch (err) {
    logger.error({ err, userId, anomalyScore }, 'Failed to handle anomaly detection');
  }
}

/**
 * 恢复用户配额
 * 当异常行为消除时调用
 */
async function restoreUserQuota(userId) {
  try {
    await userQuotaManager.adjustUserQuota(userId, {
      quotaMultiplier: 1.0,
      reason: '异常行为已消除',
      duration: null
    });

    logger.info({
      event: 'QUOTA_RESTORED',
      userId
    }, 'User quota restored');
  } catch (err) {
    logger.error({ err, userId }, 'Failed to restore user quota');
  }
}

/**
 * 清理函数
 */
function cleanup() {
  if (adjustmentInterval) {
    clearInterval(adjustmentInterval);
  }
}

module.exports = {
  adaptiveRateLimitMiddleware,
  SystemMetricsCollector,
  metricsCollector,
  handleAnomalyDetection,
  restoreUserQuota,
  cleanup
};
