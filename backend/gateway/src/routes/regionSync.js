/**
 * 多区域同步 API 路由
 * @module gateway/src/routes/regionSync
 */

'use strict';

const express = require('express');
const router = express.Router();
const { getRegionSyncService } = require('../../../shared/regionSync/RegionSyncService');
const { ArbitrationEngine } = require('../../../shared/regionSync/ArbitrationEngine');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('region-sync-routes');

// 管理员权限检查
function requireAdmin(req, res, next) {
  if (!req.user) {
    throw new AppError(1001, '未授权', 401);
  }
  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    throw new AppError(1002, '需要管理员权限', 403);
  }
  next();
}

/**
 * GET /api/v1/region/status
 * 获取所有区域状态
 */
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const syncService = getRegionSyncService();
    const states = await syncService.getAllRegionStates();
    
    res.json(successResp({
      regions: states,
      currentRegion: syncService.currentRegion,
      totalRegions: Object.keys(states).length,
      healthyRegions: Object.values(states).filter(s => s.health === 'healthy').length
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/status/:regionId
 * 获取指定区域状态
 */
router.get('/status/:regionId', requireAuth, async (req, res, next) => {
  try {
    const { regionId } = req.params;
    const syncService = getRegionSyncService();
    
    const state = await syncService.getRegionState(regionId);
    
    if (!state) {
      throw new AppError(4001, '区域不存在', 404);
    }
    
    res.json(successResp(state));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/health
 * 获取同步服务健康检查
 */
router.get('/health', async (req, res, next) => {
  try {
    const syncService = getRegionSyncService();
    const health = await syncService.healthCheck();
    
    res.json(successResp(health));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/services
 * 获取所有服务健康状态
 */
router.get('/services', requireAuth, async (req, res, next) => {
  try {
    const { regionId } = req.query;
    
    const { rows } = await query(`
      SELECT 
        sh.region_id,
        sh.service_name,
        sh.status,
        sh.health_score,
        sh.last_check_at,
        r.name as region_name,
        r.priority as region_priority
      FROM service_health sh
      JOIN regions r ON r.id = sh.region_id
      WHERE ($1::text IS NULL OR sh.region_id = $1)
      ORDER BY r.priority, sh.service_name
    `, [regionId || null]);
    
    res.json(successResp({
      services: rows,
      total: rows.length
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/metrics
 * 获取区域指标
 */
router.get('/metrics', requireAuth, async (req, res, next) => {
  try {
    const { regionId, period = '1h' } = req.query;
    
    const periodInterval = {
      '1h': '1 hour',
      '24h': '24 hours',
      '7d': '7 days'
    };
    
    const { rows } = await query(`
      SELECT 
        region_id,
        metric_name,
        metric_value,
        unit,
        collected_at
      FROM region_metrics
      WHERE ($1::text IS NULL OR region_id = $1)
      AND collected_at > NOW() - INTERVAL '${periodInterval[period] || '1 hour'}'
      ORDER BY collected_at DESC
    `, [regionId || null]);
    
    res.json(successResp({
      metrics: rows,
      period
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/events
 * 获取区域事件历史
 */
router.get('/events', requireAuth, async (req, res, next) => {
  try {
    const { regionId, limit = 50, offset = 0 } = req.query;
    
    const { rows } = await query(`
      SELECT 
        id,
        region_id,
        service_name,
        event_type,
        event_data,
        created_at
      FROM region_service_events
      WHERE ($1::text IS NULL OR region_id = $1)
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [regionId || null, parseInt(limit), parseInt(offset)]);
    
    res.json(successResp({
      events: rows,
      limit: parseInt(limit),
      offset: parseInt(offset)
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/swaps
 * 获取区域切换历史
 */
router.get('/swaps', requireAuth, async (req, res, next) => {
  try {
    const { limit = 50 } = req.query;
    
    const { rows } = await query(`
      SELECT 
        id,
        from_region,
        to_region,
        reason,
        executed_at,
        status,
        metadata
      FROM region_switch_events
      ORDER BY executed_at DESC
      LIMIT $1
    `, [parseInt(limit)]);
    
    res.json(successResp({
      swaps: rows,
      total: rows.length
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/arbitration/history
 * 获取仲裁历史
 */
router.get('/arbitration/history', requireAuth, async (req, res, next) => {
  try {
    const { limit = 50 } = req.query;
    
    const { rows } = await query(`
      SELECT 
        id,
        current_region,
        reason,
        analysis,
        result,
        timestamp
      FROM arbitration_history
      ORDER BY timestamp DESC
      LIMIT $1
    `, [parseInt(limit)]);
    
    res.json(successResp({
      history: rows,
      total: rows.length
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/region/alerts
 * 获取区域告警
 */
router.get('/alerts', requireAuth, async (req, res, next) => {
  try {
    const { acknowledged, severity, limit = 50 } = req.query;
    
    const conditions = ['1=1'];
    const params = [];
    
    if (acknowledged !== undefined) {
      params.push(acknowledged === 'true');
      conditions.push(`acknowledged = $${params.length}`);
    }
    
    if (severity) {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }
    
    params.push(parseInt(limit));
    
    const { rows } = await query(`
      SELECT 
        id,
        region_id,
        alert_type,
        message,
        severity,
        acknowledged,
        acknowledged_by,
        acknowledged_at,
        created_at
      FROM region_alerts
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `, params);
    
    res.json(successResp({
      alerts: rows,
      total: rows.length
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/region/alerts/:id/acknowledge
 * 确认告警
 */
router.post('/alerts/:id/acknowledge', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.sub || req.user.id;
    
    await query(`
      UPDATE region_alerts 
      SET acknowledged = true,
          acknowledged_by = $1,
          acknowledged_at = NOW()
      WHERE id = $2
    `, [userId, parseInt(id)]);
    
    res.json(successResp({ acknowledged: true }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/region/sync
 * 手动触发同步
 */
router.post('/sync', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const syncService = getRegionSyncService();
    await syncService.manualSync();
    
    res.json(successResp({ message: 'Sync triggered' }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/region/arbitration/execute
 * 执行仲裁
 */
router.post('/arbitration/execute', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { reason, conflictData } = req.body;
    const syncService = getRegionSyncService();
    
    const engine = new ArbitrationEngine();
    const regionStates = await syncService.getAllRegionStates();
    
    const result = await engine.arbitrate({
      currentRegion: syncService.currentRegion,
      reason,
      regionStates,
      conflictData
    });
    
    res.json(successResp(result));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/region/switch
 * 手动切换区域
 */
router.post('/switch', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { targetRegion, reason } = req.body;
    const userId = req.user.sub || req.user.id;
    
    if (!targetRegion) {
      throw new AppError(4001, '目标区域必须指定', 400);
    }
    
    // 记录切换
    await query(`
      INSERT INTO region_switch_events (from_region, to_region, reason, executed_at, status, metadata)
      VALUES ($1, $2, $3, NOW(), 'manual', $4)
    `, [
      process.env.REGION_ID || 'unknown',
      targetRegion,
      reason || 'Manual switch',
      JSON.stringify({ triggeredBy: userId })
    ]);
    
    // 更新 Redis
    const { getRedis } = require('../../../shared/redis');
    const redis = getRedis();
    await redis.set('region:active', targetRegion);
    await redis.publish('region:switch', JSON.stringify({
      from: process.env.REGION_ID,
      to: targetRegion,
      reason,
      timestamp: Date.now(),
      manual: true
    }));
    
    logger.info({ targetRegion, reason, userId }, 'Manual region switch executed');
    
    res.json(successResp({
      switched: true,
      targetRegion,
      reason
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * 内部 API：接收同步请求
 */
router.post('/internal/sync', async (req, res, next) => {
  try {
    const { sourceRegion, state } = req.body;
    
    // 验证来源区域
    const authToken = req.headers['x-region-auth'];
    if (authToken !== process.env.REGION_AUTH_TOKEN) {
      throw new AppError(1001, '无效的区域认证', 401);
    }
    
    // 验证状态哈希
    const syncService = getRegionSyncService();
    const currentState = await syncService._collectCurrentState();
    const currentHash = syncService._calculateHash(currentState);
    const sourceHash = state.hash;
    
    if (currentHash !== sourceHash) {
      // 状态不一致，返回冲突
      return res.json({
        conflict: true,
        conflictType: 'state_mismatch',
        ourState: currentState,
        theirState: state
      });
    }
    
    // 更新缓存的源区域状态
    syncService.regionStates.set(sourceRegion, state);
    
    res.json({
      success: true,
      conflict: false,
      ourState: currentState
    });
    
  } catch (err) {
    next(err);
  }
});

/**
 * 内部 API：获取区域状态
 */
router.get('/internal/state', async (req, res, next) => {
  try {
    const authToken = req.headers['x-region-auth'];
    if (authToken !== process.env.REGION_AUTH_TOKEN) {
      throw new AppError(1001, '无效的区域认证', 401);
    }
    
    const syncService = getRegionSyncService();
    const state = await syncService._collectCurrentState();
    
    res.json(state);
  } catch (err) {
    next(err);
  }
});

module.exports = router;