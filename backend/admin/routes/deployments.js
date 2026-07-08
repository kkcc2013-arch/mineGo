/**
 * 部署管理 API 路由
 * REQ-00492: 部署流水线可视化看板与状态追踪系统
 */

const express = require('express');
const router = express.Router();

/**
 * GET /api/deployments/overview
 * 获取所有服务状态概览
 */
router.get('/overview', async (req, res) => {
  try {
    const { environment = 'production' } = req.query;
    const overview = await req.deploymentService.getServicesOverview(environment);
    res.json({ 
      success: true, 
      environment,
      services: overview 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Overview error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/deployments/active
 * 获取活跃部署
 */
router.get('/active', async (req, res) => {
  try {
    const { environment } = req.query;
    const deployments = await req.deploymentService.getActiveDeployments(environment);
    res.json({ 
      success: true, 
      deployments 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Active error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/deployments/history
 * 获取所有服务的部署历史
 */
router.get('/history', async (req, res) => {
  try {
    const { limit = 50, service, status, environment } = req.query;
    const history = await req.deploymentService.getAllHistory(parseInt(limit), {
      service,
      status,
      environment
    });
    res.json({ 
      success: true, 
      history 
    });
  } catch (error) {
    console.error('[DeploymentAPI] History error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/deployments/:service/history
 * 获取特定服务的部署历史
 */
router.get('/:service/history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const history = await req.deploymentService.getServiceHistory(
      req.params.service, 
      parseInt(limit)
    );
    res.json({ 
      success: true, 
      service: req.params.service,
      history 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Service history error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/deployments/:deploymentId
 * 获取部署详情（含步骤和告警）
 */
router.get('/:deploymentId', async (req, res) => {
  try {
    const details = await req.deploymentService.getDeploymentDetails(
      req.params.deploymentId
    );
    
    if (!details) {
      return res.status(404).json({ 
        success: false, 
        error: 'Deployment not found' 
      });
    }
    
    res.json({ 
      success: true, 
      ...details 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Details error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/deployments
 * 创建部署记录（CI 调用）
 */
router.post('/', async (req, res) => {
  try {
    // 验证必要字段
    const required = ['service', 'environment', 'version'];
    for (const field of required) {
      if (!req.body[field]) {
        return res.status(400).json({ 
          success: false, 
          error: `Missing required field: ${field}` 
        });
      }
    }

    const deployment = await req.deploymentService.createDeployment(req.body);
    res.status(201).json({ 
      success: true, 
      deployment 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Create error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * PATCH /api/deployments/:deploymentId/status
 * 更新部署状态（CI 调用）
 */
router.patch('/:deploymentId/status', async (req, res) => {
  try {
    const { status, metadata } = req.body;
    
    if (!status) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing status' 
      });
    }

    const deployment = await req.deploymentService.updateStatus(
      req.params.deploymentId,
      status,
      metadata || {}
    );
    
    res.json({ 
      success: true, 
      deployment 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Status update error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/deployments/:deploymentId/steps
 * 添加部署步骤（CI 调用）
 */
router.post('/:deploymentId/steps', async (req, res) => {
  try {
    const { name, order, log } = req.body;
    
    if (!name || !order) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing step name or order' 
      });
    }

    const step = await req.deploymentService.addStep(
      req.params.deploymentId,
      { name, order: parseInt(order), log }
    );
    
    res.status(201).json({ 
      success: true, 
      step 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Add step error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * PATCH /api/deployments/:deploymentId/steps/:order
 * 完成部署步骤（CI 调用）
 */
router.patch('/:deploymentId/steps/:order', async (req, res) => {
  try {
    const { status, log, error } = req.body;
    
    if (!status) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing status' 
      });
    }

    const step = await req.deploymentService.completeStep(
      req.params.deploymentId,
      parseInt(req.params.order),
      status,
      { log, error }
    );
    
    res.json({ 
      success: true, 
      step 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Complete step error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/deployments/:deploymentId/alerts
 * 添加告警
 */
router.post('/:deploymentId/alerts', async (req, res) => {
  try {
    const { type, message } = req.body;
    
    if (!type || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing alert type or message' 
      });
    }

    const alert = await req.deploymentService.addAlert(
      req.params.deploymentId,
      type,
      message
    );
    
    res.status(201).json({ 
      success: true, 
      alert 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Add alert error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * PATCH /api/deployments/alerts/:alertId/acknowledge
 * 确认告警
 */
router.patch('/alerts/:alertId/acknowledge', async (req, res) => {
  try {
    const alert = await req.deploymentService.acknowledgeAlert(
      parseInt(req.params.alertId),
      req.user?.username || 'system'
    );
    
    res.json({ 
      success: true, 
      alert 
    });
  } catch (error) {
    console.error('[DeploymentAPI] Acknowledge error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;