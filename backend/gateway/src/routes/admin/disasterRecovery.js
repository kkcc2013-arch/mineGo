/**
 * 灾备管理 API 路由
 * @requirement REQ-00376
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const Redis = require('ioredis');
const { createLogger } = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');
const DisasterRecoveryEngine = require('../../../shared/disasterRecovery/DisasterRecoveryEngine');
const DrillManager = require('../../../shared/disasterRecovery/DrillManager');

const logger = createLogger('disaster-recovery-routes');

// 初始化
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

let drEngine = null;
let drillManager = null;

function getDREngine() {
  if (!drEngine) {
    drEngine = new DisasterRecoveryEngine({
      primaryRegion: process.env.PRIMARY_REGION || 'beijing',
      standbyRegion: process.env.STANDBY_REGION || 'shanghai',
      healthCheckInterval: 10000,
      failureThreshold: 3,
      rtoTarget: 300000,
      rpoTarget: 60000
    });
  }
  return drEngine;
}

function getDrillManager() {
  if (!drillManager) {
    drillManager = new DrillManager({
      pool,
      redis,
      drEngine: getDREngine()
    });
  }
  return drillManager;
}

/**
 * GET /admin/disaster-recovery/status
 * 获取灾备系统整体状态
 */
router.get('/status', async (req, res) => {
  try {
    const engine = getDREngine();
    const status = engine.getStatus();
    
    // 获取最近切换历史
    const historyResult = await pool.query(`
      SELECT * FROM v_recent_switch_history
      LIMIT 5
    `);
    
    // 获取当前区域健康状态
    const healthResult = await pool.query(`
      SELECT * FROM v_current_region_health
    `);
    
    res.json({
      success: true,
      data: {
        ...status,
        recentHistory: historyResult.rows,
        regionHealth: healthResult.rows,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取灾备状态失败');
    res.status(500).json({
      success: false,
      error: '获取灾备状态失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/disaster-recovery/regions
 * 获取所有区域健康状态
 */
router.get('/regions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        r.region_code,
        r.is_primary,
        r.priority,
        r.capacity_weight,
        r.is_active,
        h.health_score,
        h.status,
        h.dimensions,
        h.recorded_at
      FROM disaster_recovery_region_config r
      LEFT JOIN v_current_region_health h ON r.region_code = h.region_code
      WHERE r.is_active = true
      ORDER BY r.is_primary DESC, r.priority ASC
    `);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取区域状态失败');
    res.status(500).json({
      success: false,
      error: '获取区域状态失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/disaster-recovery/regions/:regionCode/health
 * 获取指定区域健康详情
 */
router.get('/regions/:regionCode/health', async (req, res) => {
  try {
    const { regionCode } = req.params;
    const hours = parseInt(req.query.hours) || 24;
    
    const result = await pool.query(`
      SELECT 
        region_code,
        health_score,
        status,
        dimensions,
        recorded_at
      FROM disaster_recovery_region_health
      WHERE region_code = $1
        AND recorded_at > NOW() - INTERVAL '${hours} hours'
      ORDER BY recorded_at DESC
      LIMIT 1000
    `, [regionCode]);
    
    // 计算统计数据
    const scores = result.rows.map(r => parseFloat(r.health_score));
    const stats = {
      current: scores[0] || null,
      min: Math.min(...scores),
      max: Math.max(...scores),
      avg: scores.reduce((a, b) => a + b, 0) / scores.length,
      trend: scores.length > 10 ? 
        (scores.slice(0, 10).reduce((a, b) => a + b, 0) / 10) - 
        (scores.slice(-10).reduce((a, b) => a + b, 0) / 10) : 0
    };
    
    res.json({
      success: true,
      data: {
        regionCode,
        history: result.rows,
        stats
      }
    });
  } catch (error) {
    logger.error({ error: error.message, region: req.params.regionCode }, '获取区域健康详情失败');
    res.status(500).json({
      success: false,
      error: '获取区域健康详情失败',
      message: error.message
    });
  }
});

/**
 * POST /admin/disaster-recovery/regions/:regionCode/health
 * 手动更新区域健康状态（用于测试）
 */
router.post('/regions/:regionCode/health', async (req, res) => {
  try {
    const { regionCode } = req.params;
    const { dimensions } = req.body;
    
    if (!dimensions) {
      return res.status(400).json({
        success: false,
        error: '缺少 dimensions 参数'
      });
    }
    
    // 调用数据库函数计算健康分数
    const result = await pool.query(
      'SELECT update_region_health_score($1, $2) as health_score',
      [regionCode, JSON.stringify(dimensions)]
    );
    
    const healthScore = result.rows[0].health_score;
    
    // 发布健康更新事件
    await redis.publish('dr:health:update', JSON.stringify({
      regionCode,
      healthScore,
      dimensions,
      timestamp: new Date().toISOString()
    }));
    
    res.json({
      success: true,
      data: {
        regionCode,
        healthScore,
        dimensions
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, '更新区域健康状态失败');
    res.status(500).json({
      success: false,
      error: '更新区域健康状态失败',
      message: error.message
    });
  }
});

/**
 * POST /admin/disaster-recovery/switch
 * 手动触发灾备切换
 */
router.post('/switch', async (req, res) => {
  try {
    const { targetRegion, reason, force } = req.body;
    
    if (!targetRegion) {
      return res.status(400).json({
        success: false,
        error: '缺少 targetRegion 参数'
      });
    }
    
    const engine = getDREngine();
    
    // 检查是否已有切换在进行
    if (engine.failoverInProgress) {
      return res.status(409).json({
        success: false,
        error: '已有灾备切换正在进行'
      });
    }
    
    // 记录切换请求
    const historyResult = await pool.query(`
      INSERT INTO disaster_recovery_switch_history 
        (from_region, to_region, trigger_reason, switch_type, triggered_by, started_at)
      VALUES 
        ($1, $2, $3, 'manual', $4, NOW())
      RETURNING id
    `, [engine.primaryRegion, targetRegion, reason || 'Manual trigger', req.user?.username || 'admin']);
    
    const switchId = historyResult.rows[0].id;
    
    logger.info({
      switchId,
      fromRegion: engine.primaryRegion,
      toRegion: targetRegion,
      reason,
      triggeredBy: req.user?.username
    }, '开始手动灾备切换');
    
    // 触发切换
    const result = await engine.triggerFailover(['manual_switch']);
    
    // 更新切换记录
    await pool.query(`
      UPDATE disaster_recovery_switch_history
      SET 
        success = $1,
        completed_at = NOW(),
        duration_ms = $2,
        steps_completed = $3,
        error_message = $4
      WHERE id = $5
    `, [result.success, result.rto, JSON.stringify(result.steps), result.error || null, switchId]);
    
    res.json({
      success: true,
      data: {
        switchId,
        ...result
      }
    });
    
  } catch (error) {
    logger.error({ error: error.message }, '灾备切换失败');
    res.status(500).json({
      success: false,
      error: '灾备切换失败',
      message: error.message
    });
  }
});

/**
 * POST /admin/disaster-recovery/rollback
 * 回滚到原主区域
 */
router.post('/rollback', async (req, res) => {
  try {
    const { reason } = req.body;
    
    const engine = getDREngine();
    
    if (!engine.isFailedOver) {
      return res.status(400).json({
        success: false,
        error: '当前未处于灾备状态，无法回滚'
      });
    }
    
    logger.info({
      reason,
      triggeredBy: req.user?.username
    }, '开始灾备回滚');
    
    const result = await engine.failback();
    
    res.json({
      success: true,
      data: result
    });
    
  } catch (error) {
    logger.error({ error: error.message }, '灾备回滚失败');
    res.status(500).json({
      success: false,
      error: '灾备回滚失败',
      message: error.message
    });
  }
});

/**
 * POST /admin/disaster-recovery/drill
 * 启动灾备演练
 */
router.post('/drill', async (req, res) => {
  try {
    const { 
      drillType = 'simulation', 
      targetRegion,
      executeFailover = false,
      scheduledAt
    } = req.body;
    
    const drillMgr = getDrillManager();
    const drillId = `drill-${Date.now()}`;
    
    const result = await drillMgr.execute({
      drillId,
      drillType,
      targetRegion: targetRegion || process.env.STANDBY_REGION || 'shanghai',
      executeFailover,
      scheduledAt
    });
    
    res.json({
      success: true,
      data: {
        drillId,
        ...result
      }
    });
    
  } catch (error) {
    logger.error({ error: error.message }, '灾备演练失败');
    res.status(500).json({
      success: false,
      error: '灾备演练失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/disaster-recovery/drills
 * 获取演练历史
 */
router.get('/drills', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    const result = await pool.query(`
      SELECT 
        drill_id,
        drill_type,
        execute_failover,
        target_standby_region,
        status,
        result,
        created_at,
        completed_at,
        created_by
      FROM disaster_recovery_drills
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    logger.error({ error: error.message }, '获取演练历史失败');
    res.status(500).json({
      success: false,
      error: '获取演练历史失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/disaster-recovery/history
 * 获取切换历史记录
 */
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const switchType = req.query.type;
    
    let query = `
      SELECT * FROM disaster_recovery_switch_history
      WHERE 1=1
    `;
    const params = [];
    
    if (switchType) {
      query += ` AND switch_type = $${params.length + 1}`;
      params.push(switchType);
    }
    
    query += ` ORDER BY started_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);
    
    const result = await pool.query(query, params);
    
    res.json({
      success: true,
      data: result.rows
    });
    
  } catch (error) {
    logger.error({ error: error.message }, '获取切换历史失败');
    res.status(500).json({
      success: false,
      error: '获取切换历史失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/disaster-recovery/config
 * 获取区域配置
 */
router.get('/config', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM disaster_recovery_region_config
      ORDER BY is_primary DESC, priority ASC
    `);
    
    const thresholdsResult = await pool.query(`
      SELECT * FROM disaster_recovery_health_thresholds
      ORDER BY dimension
    `);
    
    res.json({
      success: true,
      data: {
        regions: result.rows,
        thresholds: thresholdsResult.rows
      }
    });
    
  } catch (error) {
    logger.error({ error: error.message }, '获取配置失败');
    res.status(500).json({
      success: false,
      error: '获取配置失败',
      message: error.message
    });
  }
});

/**
 * PUT /admin/disaster-recovery/config/:regionCode
 * 更新区域配置
 */
router.put('/config/:regionCode', async (req, res) => {
  try {
    const { regionCode } = req.params;
    const { 
      priority, 
      capacity_weight, 
      is_active,
      postgresql_endpoint,
      redis_endpoint,
      kafka_endpoint
    } = req.body;
    
    const updateFields = [];
    const params = [regionCode];
    let paramIndex = 2;
    
    if (priority !== undefined) {
      updateFields.push(`priority = $${paramIndex++}`);
      params.push(priority);
    }
    if (capacity_weight !== undefined) {
      updateFields.push(`capacity_weight = $${paramIndex++}`);
      params.push(capacity_weight);
    }
    if (is_active !== undefined) {
      updateFields.push(`is_active = $${paramIndex++}`);
      params.push(is_active);
    }
    if (postgresql_endpoint !== undefined) {
      updateFields.push(`postgresql_endpoint = $${paramIndex++}`);
      params.push(postgresql_endpoint);
    }
    if (redis_endpoint !== undefined) {
      updateFields.push(`redis_endpoint = $${paramIndex++}`);
      params.push(redis_endpoint);
    }
    if (kafka_endpoint !== undefined) {
      updateFields.push(`kafka_endpoint = $${paramIndex++}`);
      params.push(kafka_endpoint);
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({
        success: false,
        error: '没有要更新的字段'
      });
    }
    
    params.push(regionCode);
    
    const result = await pool.query(`
      UPDATE disaster_recovery_region_config
      SET ${updateFields.join(', ')}
      WHERE region_code = $1
      RETURNING *
    `, params);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: '区域不存在'
      });
    }
    
    logger.info({ 
      regionCode, 
      updates: req.body,
      updatedBy: req.user?.username 
    }, '区域配置已更新');
    
    res.json({
      success: true,
      data: result.rows[0]
    });
    
  } catch (error) {
    logger.error({ error: error.message }, '更新配置失败');
    res.status(500).json({
      success: false,
      error: '更新配置失败',
      message: error.message
    });
  }
});

/**
 * GET /admin/disaster-recovery/metrics
 * 获取灾备指标（供 Prometheus 抓取）
 */
router.get('/metrics', async (req, res) => {
  try {
    const engine = getDREngine();
    const status = engine.getStatus();
    
    const metricsOutput = [
      `# HELP dr_failover_active 当前是否处于灾备状态`,
      `# TYPE dr_failover_active gauge`,
      `dr_failover_active ${status.isFailedOver ? 1 : 0}`,
      ``,
      `# HELP dr_failover_in_progress 切换是否正在进行`,
      `# TYPE dr_failover_in_progress gauge`,
      `dr_failover_in_progress ${status.failoverInProgress ? 1 : 0}`,
      ``,
      `# HELP dr_region_health_score 区域健康分数`,
      `# TYPE dr_region_health_score gauge`,
    ];
    
    const healthResult = await pool.query(`
      SELECT region_code, health_score 
      FROM v_current_region_health
    `);
    
    for (const row of healthResult.rows) {
      metricsOutput.push(`dr_region_health_score{region="${row.region_code}"} ${row.health_score}`);
    }
    
    res.set('Content-Type', 'text/plain');
    res.send(metricsOutput.join('\n'));
    
  } catch (error) {
    logger.error({ error: error.message }, '获取指标失败');
    res.status(500).send('# Error getting metrics');
  }
});

module.exports = router;
