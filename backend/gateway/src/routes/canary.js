/**
 * 金丝雀发布管理 API
 */

const express = require('express');
const router = express.Router();
const canaryManager = require('../../../shared/canaryManager');
const canaryRouter = require('../middleware/canaryRouter');
const { db } = require('../../../shared/db');
const logger = require('../../../shared/logger');
const authMiddleware = require('../middleware/auth');

// 所有路由需要管理员权限
router.use(authMiddleware.requireAdmin);

/**
 * GET /api/canary/deployments
 * 获取所有金丝雀发布
 */
router.get('/deployments', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const deployments = await canaryManager.getAllDeployments(limit);
    
    res.json({ 
      success: true, 
      deployments,
      count: deployments.length 
    });
  } catch (error) {
    logger.error('Failed to get canary deployments', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id
 * 获取单个金丝雀发布详情
 */
router.get('/deployments/:id', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const deployment = await canaryManager.getDeployment(deploymentId);
    
    if (!deployment) {
      return res.status(404).json({ 
        success: false, 
        error: 'Deployment not found' 
      });
    }
    
    // 获取最新指标
    const metrics = await canaryManager.collectMetrics(deploymentId);
    
    // 获取历史
    const history = await canaryManager.getDeploymentHistory(deploymentId, 20);
    
    res.json({ 
      success: true, 
      deployment, 
      metrics,
      history
    });
  } catch (error) {
    logger.error('Failed to get canary deployment', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments
 * 创建金丝雀发布
 */
router.post('/deployments', async (req, res) => {
  try {
    const {
      serviceName,
      canaryVersion,
      stableVersion,
      strategy = 'progressive',
      initialTraffic = 5,
      autoPromote = true,
      metricsBaseline = {}
    } = req.body;
    
    // 验证必填字段
    if (!serviceName || !canaryVersion || !stableVersion) {
      return res.status(400).json({ 
        success: false, 
        error: 'serviceName, canaryVersion, and stableVersion are required' 
      });
    }
    
    // 验证流量百分比
    if (initialTraffic < 0 || initialTraffic > 100) {
      return res.status(400).json({ 
        success: false, 
        error: 'initialTraffic must be between 0 and 100' 
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
      createdBy: req.user?.id
    });
    
    // 刷新路由配置
    await canaryRouter.manualRefresh();
    
    res.status(201).json({ 
      success: true, 
      deployment 
    });
  } catch (error) {
    logger.error('Failed to create canary deployment', { 
      error: error.message,
      body: req.body 
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PUT /api/canary/deployments/:id/traffic
 * 调整金丝雀流量
 */
router.put('/deployments/:id/traffic', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const { traffic } = req.body;
    
    if (typeof traffic !== 'number' || traffic < 0 || traffic > 100) {
      return res.status(400).json({ 
        success: false, 
        error: 'traffic must be a number between 0 and 100' 
      });
    }
    
    const result = await canaryManager.adjustTraffic(deploymentId, traffic);
    
    // 刷新路由配置
    await canaryRouter.manualRefresh();
    
    res.json({ 
      success: true, 
      ...result 
    });
  } catch (error) {
    logger.error('Failed to adjust canary traffic', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/promote
 * 推进金丝雀发布
 */
router.post('/deployments/:id/promote', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const result = await canaryManager.promoteCanary(deploymentId);
    
    // 刷新路由配置
    await canaryRouter.manualRefresh();
    
    res.json({ 
      success: true, 
      ...result 
    });
  } catch (error) {
    logger.error('Failed to promote canary deployment', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/rollback
 * 回滚金丝雀发布
 */
router.post('/deployments/:id/rollback', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const { reason } = req.body;
    
    const result = await canaryManager.rollbackCanary(deploymentId, reason || 'Manual rollback');
    
    // 刷新路由配置
    await canaryRouter.manualRefresh();
    
    res.json({ 
      success: true, 
      ...result 
    });
  } catch (error) {
    logger.error('Failed to rollback canary deployment', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/complete
 * 完成金丝雀发布
 */
router.post('/deployments/:id/complete', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const result = await canaryManager.completeCanary(deploymentId);
    
    // 刷新路由配置
    await canaryRouter.manualRefresh();
    
    res.json({ 
      success: true, 
      ...result 
    });
  } catch (error) {
    logger.error('Failed to complete canary deployment', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id/history
 * 获取金丝雀发布历史
 */
router.get('/deployments/:id/history', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 50;
    
    const history = await canaryManager.getDeploymentHistory(deploymentId, limit);
    
    res.json({ 
      success: true, 
      history,
      count: history.length 
    });
  } catch (error) {
    logger.error('Failed to get canary deployment history', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/deployments/:id/metrics
 * 获取金丝雀发布指标
 */
router.get('/deployments/:id/metrics', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const limit = parseInt(req.query.limit) || 100;
    
    const metrics = await canaryManager.getMetricsSnapshots(deploymentId, limit);
    
    res.json({ 
      success: true, 
      metrics,
      count: metrics.length 
    });
  } catch (error) {
    logger.error('Failed to get canary deployment metrics', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/deployments/:id/validate
 * 验证金丝雀发布指标
 */
router.post('/deployments/:id/validate', async (req, res) => {
  try {
    const deploymentId = parseInt(req.params.id);
    const result = await canaryManager.validateMetrics(deploymentId);
    
    res.json({ 
      success: true, 
      ...result 
    });
  } catch (error) {
    logger.error('Failed to validate canary metrics', { 
      error: error.message,
      deploymentId: req.params.id 
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/configs
 * 获取当前金丝雀路由配置
 */
router.get('/configs', (req, res) => {
  try {
    const configs = canaryRouter.getConfigs();
    
    res.json({ 
      success: true, 
      configs,
      count: Object.keys(configs).length 
    });
  } catch (error) {
    logger.error('Failed to get canary configs', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/canary/refresh
 * 手动刷新金丝雀路由配置
 */
router.post('/refresh', async (req, res) => {
  try {
    const configs = await canaryRouter.manualRefresh();
    
    res.json({ 
      success: true, 
      configs,
      count: Object.keys(configs).length,
      message: 'Canary configs refreshed successfully'
    });
  } catch (error) {
    logger.error('Failed to refresh canary configs', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/canary/service/:serviceName/active
 * 获取服务的活跃金丝雀发布
 */
router.get('/service/:serviceName/active', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const deployment = await canaryManager.getActiveCanary(serviceName);
    
    if (!deployment) {
      return res.json({ 
        success: true, 
        deployment: null,
        message: 'No active canary deployment for this service' 
      });
    }
    
    const metrics = await canaryManager.collectMetrics(deployment.id);
    
    res.json({ 
      success: true, 
      deployment,
      metrics
    });
  } catch (error) {
    logger.error('Failed to get active canary deployment', { 
      error: error.message,
      serviceName: req.params.serviceName 
    });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
