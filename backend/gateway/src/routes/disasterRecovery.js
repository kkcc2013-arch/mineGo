/**
 * Disaster Recovery API Routes
 * 
 * 容灾管理 API：
 * - GET  /api/dr/status - 获取容灾状态
 * - GET  /api/dr/health - 获取健康检查结果
 * - POST /api/dr/failover - 手动触发故障切换
 * - GET  /api/dr/failover/history - 获取切换历史
 * - POST /api/dr/drill - 调度容灾演练
 * - POST /api/dr/drill/:drillId/start - 开始演练
 * - POST /api/dr/drill/:drillId/rollback - 回切演练
 * - GET  /api/dr/drill/history - 获取演练历史
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const HealthChecker = require('../../shared/disasterRecovery/HealthChecker');
const FailoverController = require('../../shared/disasterRecovery/FailoverController');
const DrillManager = require('../../shared/disasterRecovery/DrillManager');
const DatabaseSync = require('../../shared/disasterRecovery/DatabaseSync');

// 初始化组件
let healthChecker = null;
let failoverController = null;
let drillManager = null;
let databaseSync = null;

/**
 * 初始化容灾系统
 */
function initializeDisasterRecovery() {
  if (healthChecker) return;
  
  // 获取服务列表
  const services = [
    { name: 'user-service', url: process.env.USER_SERVICE_URL || 'http://localhost:8081' },
    { name: 'pokemon-service', url: process.env.POKEMON_SERVICE_URL || 'http://localhost:8083' },
    { name: 'catch-service', url: process.env.CATCH_SERVICE_URL || 'http://localhost:8084' },
    { name: 'gym-service', url: process.env.GYM_SERVICE_URL || 'http://localhost:8085' },
    { name: 'social-service', url: process.env.SOCIAL_SERVICE_URL || 'http://localhost:8086' },
    { name: 'payment-service', url: process.env.PAYMENT_SERVICE_URL || 'http://localhost:8088' },
    { name: 'location-service', url: process.env.LOCATION_SERVICE_URL || 'http://localhost:8082' },
    { name: 'reward-service', url: process.env.REWARD_SERVICE_URL || 'http://localhost:8087' }
  ];
  
  // 初始化健康检查器
  healthChecker = new HealthChecker({
    services,
    checkInterval: 5000,
    timeout: 3000,
    failureThreshold: 3,
    recoveryThreshold: 2
  });
  
  // 初始化故障切换控制器
  failoverController = new FailoverController({
    primaryRegion: process.env.PRIMARY_REGION || 'cn-east-1',
    secondaryRegion: process.env.SECONDARY_REGION || 'cn-north-1',
    currentRegion: process.env.REGION || 'cn-east-1',
    autoFailover: process.env.AUTO_FAILOVER !== 'false',
    cooldownPeriod: 300000
  });
  
  // 初始化演练管理器
  drillManager = new DrillManager(failoverController, {
    maxDrillDuration: 1800000,
    autoRollback: true
  });
  
  // 初始化数据库同步监控
  databaseSync = new DatabaseSync({
    syncInterval: 5000,
    lagThreshold: 60000
  });
  
  // 启动服务
  healthChecker.start();
  failoverController.initialize();
  databaseSync.start();
  
  console.log('[DisasterRecovery] System initialized');
}

// 延迟初始化
initializeDisasterRecovery();

/**
 * GET /api/dr/status
 * 获取容灾状态
 */
router.get('/status', async (req, res) => {
  try {
    const healthStatus = healthChecker.getHealthStatus();
    const failoverState = failoverController.getState();
    const activeDrill = drillManager.activeDrill;
    const dbSyncStatus = databaseSync.getLastStatus();
    
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
    console.error('[DR] Failed to get status:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/health
 * 获取详细健康检查结果
 */
router.get('/health', async (req, res) => {
  try {
    const status = healthChecker.getHealthStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    console.error('[DR] Failed to get health status:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/failover
 * 手动触发故障切换
 */
router.post('/failover', async (req, res) => {
  try {
    const { reason, force = false } = req.body;
    
    // 权限检查（在生产环境中应该使用中间件）
    if (req.user && !req.user?.roles?.includes('admin')) {
      return res.status(403).json({ 
        success: false, 
        error: 'Insufficient permissions' 
      });
    }
    
    console.log('[DR] Manual failover triggered:', { 
      user: req.user?.id, 
      reason 
    });
    
    const result = await failoverController.failover({
      trigger: 'manual',
      reason: reason || 'Manual failover by admin',
      force
    });
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DR] Failover failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/failover/history
 * 获取故障切换历史
 */
router.get('/failover/history', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const history = failoverController.getHistory(parseInt(limit));
    
    res.json({ success: true, data: history });
  } catch (error) {
    console.error('[DR] Failed to get failover history:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill
 * 调度容灾演练
 */
router.post('/drill', async (req, res) => {
  try {
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
    console.error('[DR] Failed to schedule drill:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/start
 * 开始演练
 */
router.post('/drill/:drillId/start', async (req, res) => {
  try {
    const { drillId } = req.params;
    
    const result = await drillManager.startDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DR] Failed to start drill:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/rollback
 * 回切演练
 */
router.post('/drill/:drillId/rollback', async (req, res) => {
  try {
    const { drillId } = req.params;
    
    const result = await drillManager.rollbackDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DR] Failed to rollback drill:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/drill/:drillId/cancel
 * 取消演练
 */
router.post('/drill/:drillId/cancel', async (req, res) => {
  try {
    const { drillId } = req.params;
    
    const result = await drillManager.cancelDrill(drillId);
    
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[DR] Failed to cancel drill:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/drill/history
 * 获取演练历史
 */
router.get('/drill/history', async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const history = drillManager.getDrillHistory(parseInt(limit));
    
    res.json({ success: true, data: history });
  } catch (error) {
    console.error('[DR] Failed to get drill history:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/drill/:drillId
 * 获取演练状态
 */
router.get('/drill/:drillId', async (req, res) => {
  try {
    const { drillId } = req.params;
    const status = drillManager.getDrillStatus(drillId);
    
    if (!status) {
      return res.status(404).json({ 
        success: false, 
        error: 'Drill not found' 
      });
    }
    
    res.json({ success: true, data: status });
  } catch (error) {
    console.error('[DR] Failed to get drill status:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/db-sync
 * 获取数据库同步状态
 */
router.get('/db-sync', async (req, res) => {
  try {
    const status = databaseSync.getLastStatus();
    
    res.json({ success: true, data: status });
  } catch (error) {
    console.error('[DR] Failed to get db sync status:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/dr/db-sync/force
 * 强制数据库同步
 */
router.post('/db-sync/force', async (req, res) => {
  try {
    const result = await databaseSync.forceSync();
    
    res.json({ success: true, data: { synced: result } });
  } catch (error) {
    console.error('[DR] Failed to force sync:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/dr/config
 * 获取容灾配置
 */
router.get('/config', async (req, res) => {
  try {
    const config = {
      primaryRegion: failoverController.config.primaryRegion,
      secondaryRegion: failoverController.config.secondaryRegion,
      currentRegion: failoverController.config.currentRegion,
      autoFailover: failoverController.config.autoFailover,
      cooldownPeriod: failoverController.config.cooldownPeriod,
      dnsTTL: failoverController.config.dnsTTL,
      healthCheckInterval: healthChecker.config.checkInterval,
      failureThreshold: healthChecker.config.failureThreshold,
      recoveryThreshold: healthChecker.config.recoveryThreshold
    };
    
    res.json({ success: true, data: config });
  } catch (error) {
    console.error('[DR] Failed to get config:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
