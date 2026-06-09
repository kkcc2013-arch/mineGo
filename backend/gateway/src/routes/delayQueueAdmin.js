'use strict';

const express = require('express');
const { getDelayQueue } = require('../../../shared/DelayQueue');
const { getDelayQueueMonitor } = require('../../../shared/delayQueueMonitor');
const { getDelayBucketScheduler } = require('../../../shared/delayBucketScheduler');
const { createLogger } = require('../../../shared/logger');

const router = express.Router();
const logger = createLogger('delay-queue-admin');

/**
 * GET /api/admin/delay-queue/stats
 * Get queue statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const delayQueue = getDelayQueue();
    const stats = await delayQueue.getStats();
    
    res.json({ 
      success: true, 
      stats,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get queue stats');
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /api/admin/delay-queue/health
 * Get queue health status
 */
router.get('/health', async (req, res) => {
  try {
    const monitor = getDelayQueueMonitor();
    const health = await monitor.getHealth();
    
    res.json(health);
  } catch (err) {
    logger.error({ err }, 'Failed to get queue health');
    res.status(500).json({ error: 'Failed to get health' });
  }
});

/**
 * GET /api/admin/delay-queue/scheduler
 * Get scheduler statistics
 */
router.get('/scheduler', async (req, res) => {
  try {
    const scheduler = getDelayBucketScheduler();
    const stats = scheduler.getStats();
    
    res.json({ 
      success: true, 
      scheduler: stats,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get scheduler stats');
    res.status(500).json({ error: 'Failed to get scheduler stats' });
  }
});

/**
 * GET /api/admin/delay-queue/monitor
 * Get monitor statistics
 */
router.get('/monitor', async (req, res) => {
  try {
    const monitor = getDelayQueueMonitor();
    const stats = monitor.getStats();
    
    res.json({ 
      success: true, 
      monitor: stats,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get monitor stats');
    res.status(500).json({ error: 'Failed to get monitor stats' });
  }
});

/**
 * POST /api/admin/delay-queue/tasks
 * Manually schedule a task
 */
router.post('/tasks', async (req, res) => {
  try {
    const { taskType, payload, delay, priority, maxRetries, metadata } = req.body;
    
    if (!taskType) {
      return res.status(400).json({ error: 'taskType is required' });
    }
    
    const delayQueue = getDelayQueue();
    const result = await delayQueue.schedule(taskType, payload || {}, {
      delay: delay || 0,
      priority: priority || 'normal',
      maxRetries: maxRetries || 5,
      metadata: metadata || {},
    });
    
    logger.info({ 
      taskType, 
      taskId: result.taskId,
      delay,
      priority,
    }, 'Task manually scheduled');
    
    res.json({ 
      success: true, 
      ...result,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to schedule task');
    res.status(500).json({ error: 'Failed to schedule task' });
  }
});

/**
 * POST /api/admin/delay-queue/recurring
 * Schedule a recurring task
 */
router.post('/recurring', async (req, res) => {
  try {
    const { taskType, payload, cronExpression, priority, maxRetries } = req.body;
    
    if (!taskType || !cronExpression) {
      return res.status(400).json({ error: 'taskType and cronExpression are required' });
    }
    
    const delayQueue = getDelayQueue();
    const result = await delayQueue.scheduleRecurring(taskType, payload || {}, cronExpression, {
      priority: priority || 'low',
      maxRetries: maxRetries || 3,
    });
    
    logger.info({ 
      taskType, 
      taskId: result.taskId,
      cronExpression,
    }, 'Recurring task scheduled');
    
    res.json({ 
      success: true, 
      ...result,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to schedule recurring task');
    res.status(500).json({ error: 'Failed to schedule recurring task' });
  }
});

/**
 * DELETE /api/admin/delay-queue/recurring/:taskId
 * Cancel a recurring task
 */
router.delete('/recurring/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    
    const delayQueue = getDelayQueue();
    const cancelled = delayQueue.cancelRecurring(taskId);
    
    if (cancelled) {
      logger.info({ taskId }, 'Recurring task cancelled');
      res.json({ success: true, message: 'Recurring task cancelled' });
    } else {
      res.status(404).json({ error: 'Recurring task not found' });
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cancel recurring task');
    res.status(500).json({ error: 'Failed to cancel recurring task' });
  }
});

/**
 * POST /api/admin/delay-queue/dlq/:taskId/retry
 * Retry a DLQ task manually
 */
router.post('/dlq/:taskId/retry', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { taskType, payload, maxRetries } = req.body;
    
    if (!taskType) {
      return res.status(400).json({ error: 'taskType is required in body' });
    }
    
    const monitor = getDelayQueueMonitor();
    const result = await monitor.retryTask(taskId, {
      type: taskType,
      payload: payload || {},
      maxRetries: maxRetries || 5,
    });
    
    logger.info({ 
      taskId, 
      newTaskId: result.taskId,
    }, 'DLQ task manually retried');
    
    res.json({ 
      success: true, 
      message: 'Task retry scheduled',
      newTaskId: result.taskId,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to retry DLQ task');
    res.status(500).json({ error: 'Failed to retry task' });
  }
});

/**
 * GET /api/admin/delay-queue/buckets
 * Get delay bucket information
 */
router.get('/buckets', async (req, res) => {
  try {
    const buckets = [
      { name: 'immediate', interval: '1s', range: '< 0ms' },
      { name: '1m', interval: '5s', range: '< 1 minute' },
      { name: '5m', interval: '15s', range: '< 5 minutes' },
      { name: '15m', interval: '1m', range: '< 15 minutes' },
      { name: '1h', interval: '5m', range: '< 1 hour' },
      { name: '6h', interval: '15m', range: '< 6 hours' },
      { name: '24h', interval: '1h', range: '< 24 hours' },
    ];
    
    res.json({ 
      success: true, 
      buckets,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get bucket info');
    res.status(500).json({ error: 'Failed to get bucket info' });
  }
});

/**
 * POST /api/admin/delay-queue/monitor/config
 * Update monitor configuration
 */
router.post('/monitor/config', async (req, res) => {
  try {
    const { autoRetryEnabled, alertThreshold, maxAutoRetries } = req.body;
    
    const monitor = getDelayQueueMonitor();
    
    if (typeof autoRetryEnabled === 'boolean') {
      monitor.autoRetryEnabled = autoRetryEnabled;
    }
    if (typeof alertThreshold === 'number') {
      monitor.alertThreshold = alertThreshold;
    }
    if (typeof maxAutoRetries === 'number') {
      monitor.maxAutoRetries = maxAutoRetries;
    }
    
    logger.info({ 
      autoRetryEnabled: monitor.autoRetryEnabled,
      alertThreshold: monitor.alertThreshold,
      maxAutoRetries: monitor.maxAutoRetries,
    }, 'Monitor config updated');
    
    res.json({ 
      success: true, 
      config: {
        autoRetryEnabled: monitor.autoRetryEnabled,
        alertThreshold: monitor.alertThreshold,
        maxAutoRetries: monitor.maxAutoRetries,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update monitor config');
    res.status(500).json({ error: 'Failed to update config' });
  }
});

/**
 * POST /api/admin/delay-queue/monitor/clear-alerts
 * Clear alert counts
 */
router.post('/monitor/clear-alerts', async (req, res) => {
  try {
    const monitor = getDelayQueueMonitor();
    monitor.clearAlertCounts();
    
    logger.info('Alert counts cleared');
    
    res.json({ success: true, message: 'Alert counts cleared' });
  } catch (err) {
    logger.error({ err }, 'Failed to clear alerts');
    res.status(500).json({ error: 'Failed to clear alerts' });
  }
});

module.exports = router;
