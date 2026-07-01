/**
 * 金丝雀发布管理 API
 * 
 * @module routes/canary
 */

const express = require('express');
const router = express.Router();
const { canaryManager } = require('../../shared/canaryManager');
const { db } = require('../../shared/db');
const { logger } = require('../../shared/logger');
const { requireAdmin, requireAuth } = require('../middleware/auth');

/**
 * GET /api/canary/deployments
 * 获取所有金丝雀发布
 */
router.get('/deployments', requireAdmin, async (req, res) => {
  try {
    const { status, service, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM canary_deployments WHERE 1=1';
    const params = [];
    
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    
    if (service) {
      params.push(service);
      query += ` AND service_name = $${params.length}`;
    }
    
    params.push(limit);
    query += ` ORDER BY created_at DESC LIMIT $${params.length}`;
    
    const result = await db.query(query, params);
    
    res.json({ 
      success: true, 
      count: result.rows.length,
      deployments: result.rows 
    });
  } catch (error) {
    logger.error('[CanaryAPI] Get deployments failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/deployments/active
 * 获取所有活跃的金丝雀发布
 */
router.get('/deployments/active', requireAuth, async (req, res) => {
  try {
    const deployments = await canaryManager.getAllActive();
    
    res.json({ 
      success: true, 
      count: deployments.length,
      deployments 
    });
  } catch (error) {
    logger.error('[CanaryAPI] Get active deployments failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id
 * 获取单个金丝雀发布详情
 */
router.get('/deployments/:id', requireAdmin, async (req, res) => {
  try {
    const deployment = await canaryManager.getDeployment(parseInt(req.params.id));
    
    if (!deployment) {
      return res.status(404).json({ success: false, error: 'Deployment not found' });
    }
    
    // 获取最新指标
    const metrics = await canaryManager.collectMetrics(parseInt(req.params.id));
    
    // 获取历史
    const history = await canaryManager.getHistory(parseInt(req.params.id), 10);
    
    res.json({ 
      success: true, 
      deployment, 
      metrics,
      history 
    });
  } catch (error) {
    logger.error('[CanaryAPI] Get deployment failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments
 * 创建金丝雀发布
 */
router.post('/deployments', requireAdmin, async (req, res) => {
  try {
    const {
      serviceName,
      canaryVersion,
      stableVersion,
      strategy = 'progressive',
      initialTraffic = 5,
      autoPromote = true,
      metricsBaseline = {},
      rules = {}
    } = req.body;
    
    // 参数验证
    if (!serviceName || !canaryVersion || !stableVersion) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: serviceName, canaryVersion, stableVersion' 
      });
    }
    
    const deployment = await canaryManager.createCanaryDeployment({
      serviceName,
      canaryVersion,
      stableVersion,
      strategy,
      initialTraffic,
      autoPromote,
      metricsBaseline,
      rules
    });
    
    logger.info(`[CanaryAPI] Created canary deployment #${deployment.id}`, {
      serviceName,
      canaryVersion,
      user: req.user?.id
    });
    
    res.status(201).json({ success: true, deployment });
  } catch (error) {
    logger.error('[CanaryAPI] Create deployment failed:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/canary/deployments/:id/traffic
 * 调整金丝雀流量
 */
router.put('/deployments/:id/traffic', requireAdmin, async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const { traffic, reason = '' } = req.body;
    
    if (typeof traffic !== 'number' || traffic < 0 || traffic > 100) {
      return res.status(400).json({ 
        success: false, 
        error: 'Traffic must be a number between 0 and 100' 
      });
    }
    
    const result = await canaryManager.adjustTraffic(deploymentId, traffic, reason);
    
    logger.info(`[CanaryAPI] Adjusted traffic for #${deploymentId} to ${traffic}%`);
    
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[CanaryAPI] Adjust traffic failed:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/promote
 * 推进金丝雀发布（进入下一阶段）
 */
router.post('/deployments/:id/promote', requireAdmin, async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const result = await canaryManager.promoteCanary(deploymentId);
    
    logger.info(`[CanaryAPI] Promoted canary deployment #${deploymentId}`);
    
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[CanaryAPI] Promote failed:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/complete
 * 完成金丝雀发布
 */
router.post('/deployments/:id/complete', requireAdmin, async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const result = await canaryManager.completeCanary(deploymentId);
    
    logger.info(`[CanaryAPI] Completed canary deployment #${deploymentId}`);
    
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[CanaryAPI] Complete failed:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/rollback
 * 回滚金丝雀发布
 */
router.post('/deployments/:id/rollback', requireAdmin, async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const { reason = 'Manual rollback' } = req.body;
    
    const result = await canaryManager.rollbackCanary(deploymentId, reason);
    
    logger.warn(`[CanaryAPI] Rolled back canary deployment #${deploymentId}: ${reason}`);
    
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[CanaryAPI] Rollback failed:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id/history
 * 获取金丝雀发布历史
 */
router.get('/deployments/:id/history', requireAdmin, async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const { limit = 50 } = req.query;
    
    const history = await canaryManager.getHistory(deploymentId, parseInt(limit));
    
    res.json({ success: true, count: history.length, history });
  } catch (error) {
    logger.error('[CanaryAPI] Get history failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id/metrics
 * 获取金丝雀发布指标
 */
router.get('/deployments/:id/metrics', requireAdmin, async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    
    // 当前指标
    const currentMetrics = await canaryManager.collectMetrics(deploymentId);
    
    // 历史指标
    const history = await canaryManager.getMetricsHistory(deploymentId, 100);
    
    res.json({ 
      success: true, 
      current: currentMetrics,
      history 
    });
  } catch (error) {
    logger.error('[CanaryAPI] Get metrics failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/validate
 * 验证金丝雀发布指标
 */
router.post('/deployments/:id/validate', requireAdmin, async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const result = await canaryManager.validateMetrics(deploymentId);
    
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[CanaryAPI] Validate failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/services/:service/active
 * 获取指定服务的活跃金丝雀发布
 */
router.get('/services/:service/active', requireAuth, async (req, res) => {
  try {
    const deployment = await canaryManager.getActiveCanary(req.params.service);
    
    res.json({ 
      success: true, 
      hasActive: !!deployment,
      deployment 
    });
  } catch (error) {
    logger.error('[CanaryAPI] Get service active canary failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/services/:service/history
 * 获取指定服务的历史金丝雀发布
 */
router.get('/services/:service/history', requireAdmin, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const history = await canaryManager.getServiceHistory(req.params.service, parseInt(limit));
    
    res.json({ success: true, count: history.length, history });
  } catch (error) {
    logger.error('[CanaryAPI] Get service history failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/auto-promote
 * 手动触发自动推进检查（管理员）
 */
router.post('/auto-promote', requireAdmin, async (req, res) => {
  try {
    const results = await canaryManager.autoPromoteCanary();
    
    logger.info('[CanaryAPI] Auto-promote check completed', { results });
    
    res.json({ success: true, results });
  } catch (error) {
    logger.error('[CanaryAPI] Auto-promote failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/health
 * 健康检查
 */
router.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    service: 'canary-api',
    timestamp: new Date()
  });
});

module.exports = router;