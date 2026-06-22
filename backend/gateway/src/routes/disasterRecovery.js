const express = require('express');
const router = express.Router();
const { logger } = require('@pmg/shared/logging');
const HealthChecker = require('@pmg/shared/disasterRecovery/HealthChecker');
const FailoverController = require('@pmg/shared/disasterRecovery/FailoverController');
const DrillManager = require('@pmg/shared/disasterRecovery/DrillManager');
const DatabaseSync = require('@pmg/shared/disasterRecovery/DatabaseSync');

// 初始化组件（延迟初始化，避免模块加载时立即创建实例）
let healthChecker = null;
let failoverController = null;
let drillManager = null;
let databaseSync = null;

function initComponents() {
  if (!healthChecker) {
    healthChecker = new HealthChecker({
      services: [
        { name: 'user-service', url: process.env.USER_SERVICE_URL || 'http://user-service:8080' },
        { name: 'pokemon-service', url: process.env.POKEMON_SERVICE_URL || 'http://pokemon-service:8080' },
        { name: 'catch-service', url: process.env.CATCH_SERVICE_URL || 'http://catch-service:8080' },
        { name: 'gym-service', url: process.env.GYM_SERVICE_URL || 'http://gym-service:8080' },
        { name: 'social-service', url: process.env.SOCIAL_SERVICE_URL || 'http://social-service:8080' },
        { name: 'payment-service', url: process.env.PAYMENT_SERVICE_URL || 'http://payment-service:8080' },
        { name: 'location-service', url: process.env.LOCATION_SERVICE_URL || 'http://location-service:8080' },
        { name: 'reward-service', url: process.env.REWARD_SERVICE_URL || 'http://reward-service:8080' }
      ]
    });

    failoverController = new FailoverController();
    drillManager = new DrillManager(failoverController);
    databaseSync = new DatabaseSync();

    // 启动健康检查和数据库同步监控
    healthChecker.start().catch(err => {
      logger.error('Failed to start health checker', { error: err.message });
    });
    
    failoverController.initialize().catch(err => {
      logger.error('Failed to initialize failover controller', { error: err.message });
    });
    
    databaseSync.start().catch(err => {
      logger.error('Failed to start database sync monitor', { error: err.message });
    });
  }
}

/**
 * GET /api/dr/status
 * 获取容灾状态
 */
router.get('/status', async (req, res) => {
  try {
    initComponents();
    
    const healthStatus = healthChecker.getHealthStatus();
    const failoverState = failoverController.getState();
    const activeDrill = drillManager.getActiveDrill();
    const dbSyncStatus = await databaseSync.getStatus();
    
    res.json({
      success: true,
      data: {
        health: healthStatus,
        failover: failoverState,
        drill: activeDrill ? { id: activeDrill.id, status: activeDrill.status } : null,
        databaseSync: dbSyncStatus,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get DR status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/health
 * 获取详细健康检查结果
 */
router.get('/health', async (req, res) => {
  try {
    initComponents();
    
    const status = healthChecker.getHealthStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get health status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/failover
 * 手动触发故障切换
 */
router.post('/failover', async (req, res) => {
  try {
    initComponents();
    
    const { reason, force = false } = req.body;
    
    // 权限检查（如果有用户信息）
    if (req.user && !req.user?.roles?.includes('admin')) {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions' 
      });
    }
    
    logger.info('Manual failover triggered', { 
      user: req.user?.id || 'system', 
      reason 
    });
    
    const result = await failoverController.failover({
      trigger: 'manual',
      reason: reason || 'Manual failover by admin',
      force
    });
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failover failed', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/failover/history
 * 获取故障切换历史
 */
router.get('/failover/history', async (req, res) => {
  try {
    initComponents();
    
    const { limit = 10 } = req.query;
    const history = failoverController.state.failoverHistory.slice(-parseInt(limit));
    
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get failover history', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill
 * 调度容灾演练
 */
router.post('/drill', async (req, res) => {
  try {
    initComponents();
    
    // 权限检查
    if (req.user && !req.user?.roles?.includes('admin')) {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions' 
      });
    }
    
    const { scheduledTime, duration, autoRollback } = req.body;
    
    const drill = await drillManager.scheduleDrill({
      scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
      duration,
      autoRollback,
      createdBy: req.user?.id || 'system'
    });
    
    res.json({ success: true, data: drill });
  } catch (error) {
    logger.error('Failed to schedule drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/start
 * 开始演练
 */
router.post('/drill/:drillId/start', async (req, res) => {
  try {
    initComponents();
    
    const { drillId } = req.params;
    
    const result = await drillManager.startDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to start drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/rollback
 * 回切演练
 */
router.post('/drill/:drillId/rollback', async (req, res) => {
  try {
    initComponents();
    
    const { drillId } = req.params;
    
    const result = await drillManager.rollbackDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to rollback drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/cancel
 * 取消演练
 */
router.post('/drill/:drillId/cancel', async (req, res) => {
  try {
    initComponents();
    
    const { drillId } = req.params;
    
    const result = await drillManager.cancelDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Failed to cancel drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/drill/history
 * 获取演练历史
 */
router.get('/drill/history', async (req, res) => {
  try {
    initComponents();
    
    const { limit = 10 } = req.query;
    const history = drillManager.getDrillHistory(parseInt(limit));
    
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('Failed to get drill history', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/drill/active
 * 获取当前活跃演练
 */
router.get('/drill/active', async (req, res) => {
  try {
    initComponents();
    
    const activeDrill = drillManager.getActiveDrill();
    
    res.json({ success: true, data: activeDrill });
  } catch (error) {
    logger.error('Failed to get active drill', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/database-sync
 * 获取数据库同步状态
 */
router.get('/database-sync', async (req, res) => {
  try {
    initComponents();
    
    const status = await databaseSync.getStatus();
    
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Failed to get database sync status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/database-sync/force
 * 强制数据库同步
 */
router.post('/database-sync/force', async (req, res) => {
  try {
    initComponents();
    
    const result = await databaseSync.forceSync();
    
    res.json({ success: true, data: { synced: result } });
  } catch (error) {
    logger.error('Failed to force database sync', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
