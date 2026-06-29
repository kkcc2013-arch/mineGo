// backend/shared/SmartRateLimitMiddleware.js
// REQ-00367: 智能限流中间件

'use strict';

const { intelligentRateLimiter } = require('./IntelligentRateLimiter');
const { userQuotaManager } = require('./UserQuotaManager');
const { requestPriorityQueue } = require('./RequestPriorityQueue');
const { quotaPredictor } = require('./QuotaPredictor');
const { costAttributionEngine } = require('./CostAttributionEngine');
const { createLogger } = require('./logger');

const logger = createLogger('smart-rate-limit-middleware');

/**
 * 智能限流中间件
 * 结合动态限流、配额管理、优先级队列
 */
async function smartRateLimitMiddleware(req, res, next) {
  const userId = req.user?.id;
  const endpoint = req.path;
  const requestId = req.requestId || generateRequestId();

  // 未认证请求使用基础限流
  if (!userId) {
    return basicRateLimit(req, res, next);
  }

  const startTime = Date.now();

  try {
    // 1. 检查智能限流
    const rateLimitResult = await intelligentRateLimiter.checkRateLimit(
      userId,
      endpoint,
      requestId
    );

    // 2. 获取配额信息
    const quotaInfo = await userQuotaManager.getUserQuota(userId);

    // 3. 检查配额预警
    const quotaWarning = await userQuotaManager.checkQuotaWarning(userId);

    // 添加预警信息到响应头
    if (quotaWarning.warnings.length > 0) {
      res.setHeader('X-Quota-Warning', JSON.stringify(quotaWarning.warnings.map(w => ({
        level: w.level,
        message: w.message
      }))));
    }

    // 4. 根据系统负载决定处理策略
    if (!rateLimitResult.allowed) {
      // 高负载时，将请求加入优先级队列
      if (rateLimitResult.loadLevel === 'high') {
        try {
          const queueResult = await requestPriorityQueue.enqueue({
            requestId,
            userId,
            endpoint,
            userTier: quotaInfo.tier,
            timestamp: startTime,
            method: req.method,
            headers: {
              'content-type': req.headers['content-type']
            }
          });

          logger.info({
            userId,
            endpoint,
            priority: queueResult.priority,
            queuePosition: queueResult.queuePosition
          }, 'Request queued due to high load');

          return res.status(202).json({
            message: '系统负载较高，请求已加入队列',
            queuePosition: queueResult.queuePosition,
            estimatedWaitTime: queueResult.estimatedWaitTime,
            requestId,
            priority: queueResult.priority
          });
        } catch (queueError) {
          logger.warn({
            userId,
            endpoint,
            error: queueError.message
          }, 'Queue full, request rejected');

          return res.status(503).json({
            error: '服务暂时不可用，请稍后重试',
            retryAfter: 60,
            requestId
          });
        }
      }

      // 正常限流拒绝
      return res.status(429).json({
        error: '请求过于频繁，请稍后再试',
        retryAfter: rateLimitResult.resetAt,
        current: rateLimitResult.current,
        limit: rateLimitResult.limit,
        remaining: rateLimitResult.remaining,
        userTier: quotaInfo.tier,
        requestId
      });
    }

    // 5. 添加限流信息到响应头
    res.setHeader('X-RateLimit-Limit', rateLimitResult.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitResult.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitResult.resetAt);
    res.setHeader('X-System-Load', rateLimitResult.loadLevel);
    res.setHeader('X-User-Tier', quotaInfo.tier);
    res.setHeader('X-Request-Id', requestId);

    // 6. 增加使用量
    await userQuotaManager.incrementUsage(userId, endpoint);

    // 7. 更新使用历史（用于预测）
    await quotaPredictor.updateUsageHistory(userId, endpoint);

    // 8. 响应完成后记录成本
    res.on('finish', () => {
      const responseTime = Date.now() - startTime;
      const responseSize = res.get('content-length') ? parseInt(res.get('content-length')) : 0;

      costAttributionEngine.recordRequestCost({
        userId,
        endpoint,
        requestId,
        responseTimeMs: responseTime,
        responseSizeBytes: responseSize,
        userTier: quotaInfo.tier
      }).catch(err => {
        logger.warn({ err, userId }, 'Failed to record request cost');
      });
    });

    next();
  } catch (error) {
    logger.error({
      err: error,
      userId,
      endpoint
    }, 'Smart rate limit middleware error');

    // 出错时放行，不影响用户体验
    next();
  }
}

/**
 * 基础限流（未认证用户）
 */
async function basicRateLimit(req, res, next) {
  const endpoint = req.path;
  const ip = req.ip || req.connection.remoteAddress;

  try {
    const result = await intelligentRateLimiter.checkRateLimit(
      `ip:${ip}`,
      endpoint,
      req.requestId
    );

    if (!result.allowed) {
      return res.status(429).json({
        error: '请求过于频繁，请稍后再试',
        retryAfter: result.resetAt
      });
    }

    res.setHeader('X-RateLimit-Limit', result.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);

    next();
  } catch (error) {
    logger.error({ err: error, ip }, 'Basic rate limit error');
    next();
  }
}

/**
 * 生成请求ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 配额状态查询中间件
 */
async function quotaStatusMiddleware(req, res, next) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: '未认证' });
  }

  try {
    const status = await userQuotaManager.getQuotaStatus(userId);
    const warnings = await quotaPredictor.generateWarnings(userId);

    res.json({
      quota: status,
      warnings: warnings.warnings,
      prediction: warnings.predictionSummary
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get quota status');
    res.status(500).json({ error: '获取配额状态失败' });
  }
}

/**
 * 优化建议查询中间件
 */
async function optimizationSuggestionsMiddleware(req, res, next) {
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).json({ error: '未认证' });
  }

  try {
    const suggestions = await costAttributionEngine.generateOptimizationSuggestions(userId);

    res.json({
      userId,
      suggestions,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get optimization suggestions');
    res.status(500).json({ error: '获取优化建议失败' });
  }
}

/**
 * 限流状态查询中间件（管理员）
 */
async function rateLimitStatusMiddleware(req, res, next) {
  try {
    const limiterStatus = intelligentRateLimiter.getStatus();
    const queueStatus = await requestPriorityQueue.getQueueStatus();
    const queueStats = await requestPriorityQueue.getQueueStats();

    res.json({
      limiter: limiterStatus,
      queue: {
        status: queueStatus,
        stats: queueStats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get rate limit status');
    res.status(500).json({ error: '获取限流状态失败' });
  }
}

/**
 * 成本报告中间件（管理员）
 */
async function costReportMiddleware(req, res, next) {
  const timeRange = req.query.timeRange || '7d';

  try {
    const report = await costAttributionEngine.getCostReport(timeRange);

    res.json(report);
  } catch (error) {
    logger.error({ err: error }, 'Failed to get cost report');
    res.status(500).json({ error: '获取成本报告失败' });
  }
}

/**
 * 预测趋势中间件
 */
async function usagePredictionMiddleware(req, res, next) {
  const userId = req.user?.id;
  const hours = parseInt(req.query.hours) || 24;

  if (!userId) {
    return res.status(401).json({ error: '未认证' });
  }

  try {
    const prediction = await quotaPredictor.predictUsageTrend(userId, hours);

    res.json(prediction);
  } catch (error) {
    logger.error({ err: error, userId }, 'Failed to get usage prediction');
    res.status(500).json({ error: '获取使用预测失败' });
  }
}

module.exports = {
  smartRateLimitMiddleware,
  basicRateLimit,
  quotaStatusMiddleware,
  optimizationSuggestionsMiddleware,
  rateLimitStatusMiddleware,
  costReportMiddleware,
  usagePredictionMiddleware,
  generateRequestId
};