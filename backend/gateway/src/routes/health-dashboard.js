/**
 * REQ-00061: 服务健康仪表板前端页面
 */

const express = require('express');
const router = express.Router();
const ServiceHealthDashboard = require('../../shared/ServiceHealthDashboard');

// 全局仪表板实例
let dashboardInstance = null;

/**
 * 获取或创建仪表板实例
 */
async function getDashboard() {
  if (!dashboardInstance) {
    dashboardInstance = new ServiceHealthDashboard();
    await dashboardInstance.start();
  }
  return dashboardInstance;
}

/**
 * GET /api/v1/health/dashboard
 * 获取所有服务健康状态
 */
router.get('/dashboard', async (req, res) => {
  try {
    const dashboard = await getDashboard();
    const health = await dashboard.getAllServicesHealth();
    
    res.json({
      success: true,
      data: health
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/health/services/:serviceName
 * 获取单个服务健康状态
 */
router.get('/services/:serviceName', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const dashboard = await getDashboard();
    const health = await dashboard.getServiceHealth(serviceName);
    
    res.json({
      success: true,
      data: health
    });
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/v1/health/services/:serviceName/recover
 * 手动触发服务恢复
 */
router.post('/services/:serviceName/recover', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { strategy } = req.body;
    
    const dashboard = await getDashboard();
    const result = await dashboard.triggerRecovery(serviceName, strategy || 'restart');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/health/dependency-graph
 * 获取服务依赖关系图
 */
router.get('/dependency-graph', async (req, res) => {
  try {
    const dashboard = await getDashboard();
    const health = await dashboard.getAllServicesHealth();
    
    res.json({
      success: true,
      data: health.dependencyGraph
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/v1/health/alerts
 * 获取活跃告警
 */
router.get('/alerts', async (req, res) => {
  try {
    const dashboard = await getDashboard();
    const alerts = Array.from(dashboard.activeAlerts.values());
    
    res.json({
      success: true,
      data: alerts
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
