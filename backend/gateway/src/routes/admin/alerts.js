'use strict';
/**
 * Alert Management Routes
 * REQ-00439: 熔断器事件告警系统集成
 */

const express = require('express');
const router = express.Router();
const { getAlertManager } = require('@pmg/shared/alerting');
const { createLogger } = require('@pmg/shared/logger');
const { requireAuth, successResp, AppError } = require('@pmg/shared/auth');

const logger = createLogger('alert-routes');

/**
 * GET /api/admin/alerts/history
 * 查询告警历史
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { level, service, limit } = req.query;
    const alertManager = getAlertManager();
    
    const history = alertManager.getHistory({
      level,
      service,
      limit: parseInt(limit) || 100
    });
    
    successResp(res, {
      total: history.length,
      alerts: history
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get alert history');
    next(new AppError('Failed to get alert history', 500));
  }
});

/**
 * GET /api/admin/alerts/silences
 * 查询静默规则
 */
router.get('/silences', requireAuth, async (req, res, next) => {
  try {
    const alertManager = getAlertManager();
    const silences = alertManager.getSilences();
    
    successResp(res, {
      total: silences.length,
      silences
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get silences');
    next(new AppError('Failed to get silences', 500));
  }
});

/**
 * POST /api/admin/alerts/silences
 * 创建静默规则
 */
router.post('/silences', requireAuth, async (req, res, next) => {
  try {
    const { pattern, durationMinutes } = req.body;
    
    if (!pattern || !durationMinutes) {
      return next(new AppError('Missing required fields: pattern, durationMinutes', 400));
    }
    
    const alertManager = getAlertManager();
    alertManager.setSilence(pattern, durationMinutes * 60 * 1000);
    
    logger.info({
      userId: req.user.id,
      pattern,
      durationMinutes
    }, 'Silence rule created');
    
    successResp(res, {
      message: 'Silence rule created',
      pattern,
      durationMinutes
    });
  } catch (error) {
    logger.error({ error }, 'Failed to create silence');
    next(new AppError('Failed to create silence', 500));
  }
});

/**
 * DELETE /api/admin/alerts/silences/:pattern
 * 删除静默规则
 */
router.delete('/silences/:pattern', requireAuth, async (req, res, next) => {
  try {
    const { pattern } = req.params;
    const alertManager = getAlertManager();
    
    alertManager.removeSilence(decodeURIComponent(pattern));
    
    logger.info({
      userId: req.user.id,
      pattern
    }, 'Silence rule removed');
    
    successResp(res, {
      message: 'Silence rule removed',
      pattern
    });
  } catch (error) {
    logger.error({ error }, 'Failed to remove silence');
    next(new AppError('Failed to remove silence', 500));
  }
});

/**
 * POST /api/admin/alerts/test
 * 发送测试告警
 */
router.post('/test', requireAuth, async (req, res, next) => {
  try {
    const { level = 'info', service = 'test-service' } = req.body;
    
    const alertManager = getAlertManager();
    await alertManager.send({
      level,
      service,
      event: 'test-alert',
      message: `测试告警: ${service} - ${level}`,
      data: {
        timestamp: new Date().toISOString(),
        triggeredBy: req.user.id
      }
    });
    
    logger.info({
      userId: req.user.id,
      level,
      service
    }, 'Test alert sent');
    
    successResp(res, {
      message: 'Test alert sent',
      level,
      service
    });
  } catch (error) {
    logger.error({ error }, 'Failed to send test alert');
    next(new AppError('Failed to send test alert', 500));
  }
});

module.exports = router;