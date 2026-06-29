// gateway/src/routes/quota.js
// REQ-00367: 配额管理 API 路由

'use strict';

const express = require('express');
const router = express.Router();
const {
  smartRateLimitMiddleware,
  quotaStatusMiddleware,
  optimizationSuggestionsMiddleware,
  rateLimitStatusMiddleware,
  costReportMiddleware,
  usagePredictionMiddleware
} = require('../../../shared/SmartRateLimitMiddleware');
const { userQuotaManager } = require('../../../shared/UserQuotaManager');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('quota-routes');

/**
 * 认证中间件
 */
function authMiddleware(req, res, next) {
  // 从请求中获取用户信息
  const user = req.user || req.headers['x-user'];
  if (!user) {
    return res.status(401).json({ error: '未认证' });
  }
  next();
}

/**
 * 管理员权限中间件
 */
function adminMiddleware(req, res, next) {
  const user = req.user;
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

/**
 * GET /api/quota/status
 * 获取当前用户配额状态
 */
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const quota = await userQuotaManager.getQuotaStatus(userId);

    res.json({
      success: true,
      data: quota
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Failed to get quota status');
    res.status(500).json({
      success: false,
      error: '获取配额状态失败'
    });
  }
});

/**
 * GET /api/quota/warnings
 * 获取配额预警信息
 */
router.get('/warnings', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { quotaPredictor } = require('../../../shared/QuotaPredictor');

    const warnings = await quotaPredictor.generateWarnings(userId);

    res.json({
      success: true,
      data: warnings
    });
  } catch (error) {
    logger.error({ err: error, userId: req.user?.id }, 'Failed to get warnings');
    res.status(500).json({
      success: false,
      error: '获取预警信息失败'
    });
  }
});

/**
 * GET /api/quota/prediction
 * 获取配额使用预测
 */
router.get('/prediction', authMiddleware, async (req, res) => {
  try {
    await usagePredictionMiddleware(req, res);
  } catch (error) {
    logger.error({ err: error }, 'Prediction middleware error');
    res.status(500).json({ error: '获取预测失败' });
  }
});

/**
 * GET /api/quota/suggestions
 * 获取优化建议
 */
router.get('/suggestions', authMiddleware, async (req, res) => {
  try {
    await optimizationSuggestionsMiddleware(req, res);
  } catch (error) {
    logger.error({ err: error }, 'Suggestions middleware error');
    res.status(500).json({ error: '获取建议失败' });
  }
});

/**
 * POST /api/quota/adjust
 * 调整用户配额（管理员）
 */
router.post('/adjust', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { userId, adjustment, reason, duration } = req.body;

    if (!userId || !adjustment || !reason) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数'
      });
    }

    const result = await userQuotaManager.adjustQuota(userId, adjustment, reason, { duration });

    res.json({
      success: true,
      data: result,
      message: '配额调整成功'
    });
  } catch (error) {
    logger.error({ err: error, body: req.body }, 'Failed to adjust quota');
    res.status(500).json({
      success: false,
      error: '配额调整失败'
    });
  }
});

/**
 * GET /api/quota/admin/status
 * 获取限流系统状态（管理员）
 */
router.get('/admin/status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await rateLimitStatusMiddleware(req, res);
  } catch (error) {
    logger.error({ err: error }, 'Admin status middleware error');
    res.status(500).json({ error: '获取状态失败' });
  }
});

/**
 * GET /api/quota/admin/cost-report
 * 获取成本报告（管理员）
 */
router.get('/admin/cost-report', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await costReportMiddleware(req, res);
  } catch (error) {
    logger.error({ err: error }, 'Cost report middleware error');
    res.status(500).json({ error: '获取成本报告失败' });
  }
});

/**
 * GET /api/quota/admin/queue-status
 * 获取队列状态（管理员）
 */
router.get('/admin/queue-status', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { requestPriorityQueue } = require('../../../shared/RequestPriorityQueue');

    const status = await requestPriorityQueue.getQueueStatus();
    const stats = await requestPriorityQueue.getQueueStats();

    res.json({
      success: true,
      data: {
        status,
        stats
      }
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get queue status');
    res.status(500).json({
      success: false,
      error: '获取队列状态失败'
    });
  }
});

/**
 * DELETE /api/quota/admin/queue
 * 清空队列（管理员）
 */
router.delete('/admin/queue', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { priority } = req.query;
    const { requestPriorityQueue } = require('../../../shared/RequestPriorityQueue');

    await requestPriorityQueue.clearQueue(priority || null);

    res.json({
      success: true,
      message: priority ? `${priority} 队列已清空` : '所有队列已清空'
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to clear queue');
    res.status(500).json({
      success: false,
      error: '清空队列失败'
    });
  }
});

/**
 * POST /api/quota/admin/set-load-factor
 * 手动设置负载因子（管理员）
 */
router.post('/admin/set-load-factor', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { factor, reason } = req.body;

    if (factor === undefined || factor < 0.1 || factor > 2.0) {
      return res.status(400).json({
        success: false,
        error: '负载因子必须在 0.1 到 2.0 之间'
      });
    }

    const { intelligentRateLimiter } = require('../../../shared/IntelligentRateLimiter');

    // 手动设置负载因子
    intelligentRateLimiter.currentAdjustmentFactor = factor;
    intelligentRateLimiter.lastCheckTime = Date.now();

    logger.info({
      event: 'LOAD_FACTOR_MANUALLY_SET',
      factor,
      reason,
      adminId: req.user.id
    }, 'Load factor manually set by admin');

    res.json({
      success: true,
      data: {
        factor,
        reason
      },
      message: '负载因子已更新'
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to set load factor');
    res.status(500).json({
      success: false,
      error: '设置负载因子失败'
    });
  }
});

module.exports = router;