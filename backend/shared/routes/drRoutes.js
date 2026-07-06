// backend/shared/routes/drRoutes.js
// 灾备管理 API 路由
'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../logger');
const { DisasterRecoveryEngine, DrillManager } = require('../disasterRecovery');
const { metrics } = require('../metrics');

// 灾备引擎实例（由启动脚本初始化）
let drEngine = null;
let drillManager = null;

/**
 * 初始化灾备路由
 */
function initialize(engine) {
  drEngine = engine;
  
  // 初始化演练管理器
  drillManager = new DrillManager(engine, {
    scheduleInterval: 7 * 24 * 60 * 60 * 1000, // 7 天
    maxDrillDuration: 1800000, // 30 分钟
    autoRollback: true
  });
  
  logger.info('灾备 API 路由已初始化');
}

/**
 * 获取灾备状态
 * GET /api/admin/dr/status
 */
router.get('/status', async (req, res) => {
  try {
    if (!drEngine) {
      return res.status(503).json({ error: '灾备引擎未初始化' });
    }
    
    const status = drEngine.getStatus();
    const rpo = await drEngine.checkRPO();
    
    res.json({
      primaryRegion: status.primaryRegion,
      standbyRegion: status.standbyRegion,
      activeRegion: status.activeRegion,
      isFailedOver: status.isFailedOver,
      failoverInProgress: status.failoverInProgress,
      rto: status.lastFailoverRTO || 0,
      rpo: rpo.rpoMs || 0,
      syncLag: rpo.rpoMs || 0,
      lastHealthCheck: status.lastHealthCheck?.timestamp,
      rtoTarget: status.rtoTarget,
      rpoTarget: status.rpoTarget,
      lastDrill: drillManager?.getActiveDrill()?.startTime || null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取灾备状态失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 执行健康检查
 * POST /api/admin/dr/health-check
 */
router.post('/health-check', async (req, res) => {
  try {
    if (!drEngine) {
      return res.status(503).json({ error: '灾备引擎未初始化' });
    }
    
    const checks = await drEngine.performHealthCheck();
    
    res.json({
      success: true,
      checks,
      allHealthy: Object.values(checks).every(c => c.healthy),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ error: error.message }, '健康检查失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 启动灾备演练
 * POST /api/admin/dr/drill
 */
router.post('/drill', async (req, res) => {
  try {
    if (!drillManager) {
      return res.status(503).json({ error: '演练管理器未初始化' });
    }
    
    const { type, duration, autoRollback } = req.body;
    
    // 检查是否已有演练进行中
    if (drillManager.getActiveDrill()) {
      return res.status(400).json({ error: '已有演练正在进行' });
    }
    
    // 调度演练
    const drill = await drillManager.scheduleDrill({
      type: type || 'planned',
      duration: duration * 60 * 1000 || 1800000,
      autoRollback: autoRollback !== false,
      createdBy: req.user?.id || 'admin'
    });
    
    // 立即开始演练
    const result = await drillManager.startDrill(drill.id);
    
    metrics.increment('dr_drill_started_total', 1, { type });
    
    res.json({
      success: true,
      drillId: drill.id,
      result,
      message: '演练已启动'
    });
  } catch (error) {
    logger.error({ error: error.message }, '启动演练失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取演练历史
 * GET /api/admin/dr/drill-history
 */
router.get('/drill-history', async (req, res) => {
  try {
    if (!drillManager) {
      return res.status(503).json({ error: '演练管理器未初始化' });
    }
    
    const limit = parseInt(req.query.limit) || 10;
    const history = drillManager.getDrillHistory(limit);
    
    res.json({
      success: true,
      history,
      total: history.length
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取演练历史失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 手动故障切换
 * POST /api/admin/dr/failover
 */
router.post('/failover', async (req, res) => {
  try {
    if (!drEngine) {
      return res.status(503).json({ error: '灾备引擎未初始化' });
    }
    
    const { reason, targetRegion, autoRollback } = req.body;
    
    // 检查是否已在切换中
    if (drEngine.failoverInProgress) {
      return res.status(400).json({ error: '故障切换正在进行' });
    }
    
    // 检查是否已切换
    if (drEngine.isFailedOver) {
      return res.status(400).json({ error: '已在备区域运行，无需切换' });
    }
    
    logger.info({
      reason,
      targetRegion,
      autoRollback,
      triggeredBy: req.user?.id || 'admin'
    }, '手动故障切换请求');
    
    // 执行切换
    const result = await drEngine.triggerFailover([reason || 'manual']);
    
    metrics.increment('dr_manual_failover_total', 1, { reason });
    
    // 设置自动回切
    if (autoRollback) {
      setTimeout(async () => {
        try {
          await rollbackFailover();
          logger.info('自动回切完成');
        } catch (error) {
          logger.error({ error: error.message }, '自动回切失败');
        }
      }, 30 * 60 * 1000); // 30分钟后
    }
    
    res.json({
      success: true,
      result,
      message: '故障切换成功'
    });
  } catch (error) {
    logger.error({ error: error.message }, '故障切换失败');
    metrics.increment('dr_manual_failover_total', 1, { result: 'failure' });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 紧急故障切换
 * POST /api/admin/dr/emergency-failover
 */
router.post('/emergency-failover', async (req, res) => {
  try {
    if (!drEngine) {
      return res.status(503).json({ error: '灾备引擎未初始化' });
    }
    
    const { password, reason } = req.body;
    
    // 验证密码（实际实现需要更安全的验证机制）
    const adminPassword = process.env.EMERGENCY_FAILOVER_PASSWORD;
    if (!adminPassword || password !== adminPassword) {
      logger.warn({
        ip: req.ip,
        reason
      }, '紧急切换密码验证失败');
      return res.status(401).json({ error: '密码验证失败' });
    }
    
    // 检查是否已在切换中
    if (drEngine.failoverInProgress) {
      return res.status(400).json({ error: '故障切换正在进行' });
    }
    
    logger.critical({
      reason,
      triggeredBy: req.ip,
      emergency: true
    }, '紧急故障切换请求');
    
    // 执行切换（不检查已切换状态，强制执行）
    const result = await drEngine.triggerFailover(['emergency', reason]);
    
    metrics.increment('dr_emergency_failover_total', 1, { reason });
    
    res.json({
      success: true,
      result,
      message: '紧急切换已执行'
    });
  } catch (error) {
    logger.error({ error: error.message }, '紧急切换失败');
    metrics.increment('dr_emergency_failover_total', 1, { result: 'failure' });
    res.status(500).json({ error: error.message });
  }
});

/**
 * 回切故障切换
 * POST /api/admin/dr/rollback
 */
router.post('/rollback', async (req, res) => {
  try {
    if (!drEngine) {
      return res.status(503).json({ error: '灾备引擎未初始化' });
    }
    
    // 检查是否已切换
    if (!drEngine.isFailedOver) {
      return res.status(400).json({ error: '未在备区域运行，无需回切' });
    }
    
    logger.info({
      triggeredBy: req.user?.id || 'admin'
    }, '手动回切请求');
    
    // 执行回切（实际上是反向切换）
    const result = await drEngine.triggerFailover(['rollback']);
    
    metrics.increment('dr_rollback_total', 1);
    
    res.json({
      success: true,
      result,
      message: '回切成功'
    });
  } catch (error) {
    logger.error({ error: error.message }, '回切失败');
    res.status(500).json({ error: error.message });
  }
});

// 内部回切函数
async function rollbackFailover() {
  if (!drEngine || !drEngine.isFailedOver) {
    return;
  }
  
  await drEngine.triggerFailover(['auto-rollback']);
}

/**
 * 获取 RPO 状态
 * GET /api/admin/dr/rpo
 */
router.get('/rpo', async (req, res) => {
  try {
    if (!drEngine) {
      return res.status(503).json({ error: '灾备引擎未初始化' });
    }
    
    const rpo = await drEngine.checkRPO();
    
    res.json({
      success: true,
      rpoMs: rpo.rpoMs,
      withinTarget: rpo.withinTarget,
      target: drEngine.rpoTarget,
      timestamp: rpo.timestamp
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取 RPO 失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取演练状态
 * GET /api/admin/dr/drill/:drillId
 */
router.get('/drill/:drillId', async (req, res) => {
  try {
    if (!drillManager) {
      return res.status(503).json({ error: '演练管理器未初始化' });
    }
    
    const status = drillManager.getDrillStatus(req.params.drillId);
    
    if (!status) {
      return res.status(404).json({ error: '演练不存在' });
    }
    
    res.json({
      success: true,
      drill: status
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取演练状态失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 取消演练
 * POST /api/admin/dr/drill/:drillId/cancel
 */
router.post('/drill/:drillId/cancel', async (req, res) => {
  try {
    if (!drillManager) {
      return res.status(503).json({ error: '演练管理器未初始化' });
    }
    
    const result = await drillManager.cancelDrill(req.params.drillId);
    
    res.json({
      success: true,
      drill: result,
      message: '演练已取消'
    });
  } catch (error) {
    logger.error({ error: error.message }, '取消演练失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 导出灾备报告
 * GET /api/admin/dr/report
 */
router.get('/report', async (req, res) => {
  try {
    if (!drEngine) {
      return res.status(503).json({ error: '灾备引擎未初始化' });
    }
    
    const status = drEngine.getStatus();
    const rpo = await drEngine.checkRPO();
    const health = drEngine.lastHealthCheck;
    const history = drillManager?.getDrillHistory(20) || [];
    
    const report = {
      title: 'mineGo 灾备系统报告',
      generatedAt: new Date().toISOString(),
      summary: {
        primaryRegion: status.primaryRegion,
        standbyRegion: status.standbyRegion,
        activeRegion: status.activeRegion,
        isFailedOver: status.isFailedOver,
        rtoTarget: status.rtoTarget,
        rpoTarget: status.rpoTarget,
        currentRPO: rpo.rpoMs,
        withinRPOTarget: rpo.withinTarget
      },
      healthStatus: health,
      drillHistory: history,
      recommendations: generateRecommendations(status, rpo, health)
    };
    
    // 设置响应头以触发下载
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="dr-report.json"');
    
    res.json(report);
  } catch (error) {
    logger.error({ error: error.message }, '生成报告失败');
    res.status(500).json({ error: error.message });
  }
});

/**
 * 生成建议
 */
function generateRecommendations(status, rpo, health) {
  const recommendations = [];
  
  if (!rpo.withinTarget) {
    recommendations.push({
      priority: 'high',
      category: 'RPO',
      suggestion: '数据同步延迟超标，建议检查主从复制状态或增加同步带宽'
    });
  }
  
  if (!health?.allHealthy) {
    recommendations.push({
      priority: 'critical',
      category: 'Health',
      suggestion: '部分服务健康检查失败，建议立即检查故障服务'
    });
  }
  
  const lastDrill = drillManager?.getDrillHistory(1)?.[0];
  if (!lastDrill || (Date.now() - new Date(lastDrill.startTime).getTime() > 30 * 24 * 60 * 60 * 1000)) {
    recommendations.push({
      priority: 'medium',
      category: 'Drill',
      suggestion: '超过30天未进行灾备演练，建议定期演练验证灾备能力'
    });
  }
  
  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'low',
      category: 'Maintenance',
      suggestion: '灾备系统运行正常，建议保持定期演练'
    });
  }
  
  return recommendations;
}

module.exports = { router, initialize };