// backend/gateway/src/routes/poolManagement.js
// Pool Management API Endpoints
'use strict';

const express = require('express');
const router = express.Router();
const { getPoolConfigCenter } = require('../../../shared/poolConfigCenter');
const { getPoolManagerInstance } = require('../../../shared/db');
const { successResp, AppError } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('pool-management-api');

// ============================================================
// GET /api/admin/pools/status - Get all pool status
// ============================================================
router.get('/api/admin/pools/status', async (req, res, next) => {
  try {
    const poolManager = getPoolManagerInstance();
    const configCenter = getPoolConfigCenter();
    
    const poolStats = poolManager.getStats();
    const aggregateStats = poolManager.getAggregateStats();
    const configStatus = configCenter.getAllStatus();
    
    res.json(successResp({
      pools: poolStats,
      aggregate: aggregateStats,
      config: configStatus,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get pool status');
    next(new AppError(500, 'Failed to get pool status', error.message));
  }
});

// ============================================================
// GET /api/admin/pools/:service/status - Get single service pool status
// ============================================================
router.get('/api/admin/pools/:service/status', async (req, res, next) => {
  const { service } = req.params;
  
  try {
    const poolManager = getPoolManagerInstance();
    const configCenter = getPoolConfigCenter();
    
    const poolName = `pool-${service}`;
    const poolStats = poolManager.getStats()[poolName];
    
    if (!poolStats) {
      return next(new AppError(404, 'Pool not found', `No pool found for service: ${service}`));
    }
    
    const config = configCenter.getConfig(service);
    
    res.json(successResp({
      service,
      pool: poolStats,
      config,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message, service }, 'Failed to get pool status');
    next(new AppError(500, 'Failed to get pool status', error.message));
  }
});

// ============================================================
// PUT /api/admin/pools/:service/config - Update pool configuration
// ============================================================
router.put('/api/admin/pools/:service/config', async (req, res, next) => {
  const { service } = req.params;
  const updates = req.body;
  
  try {
    const configCenter = getPoolConfigCenter();
    
    configCenter.updateConfigs({ [service]: updates });
    
    const newConfig = configCenter.getConfig(service);
    
    logger.info({ service, updates }, 'Pool config updated');
    
    res.json(successResp({
      service,
      message: 'Pool config updated',
      oldConfig: updates,
      newConfig,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message, service }, 'Failed to update pool config');
    next(new AppError(500, 'Failed to update pool config', error.message));
  }
});

// ============================================================
// POST /api/admin/pools/config/batch - Batch update configurations
// ============================================================
router.post('/api/admin/pools/config/batch', async (req, res, next) => {
  const updates = req.body;
  
  try {
    if (!updates || typeof updates !== 'object') {
      return next(new AppError(400, 'Invalid request', 'Request body must be an object'));
    }
    
    const configCenter = getPoolConfigCenter();
    configCenter.updateConfigs(updates);
    
    logger.info({ services: Object.keys(updates) }, 'Batch pool config update');
    
    res.json(successResp({
      message: 'Batch update completed',
      updatedServices: Object.keys(updates),
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to batch update pool configs');
    next(new AppError(500, 'Failed to batch update pool configs', error.message));
  }
});

// ============================================================
// POST /api/admin/pools/:service/optimize - Optimize pool configuration
// ============================================================
router.post('/api/admin/pools/:service/optimize', async (req, res, next) => {
  const { service } = req.params;
  
  try {
    const configCenter = getPoolConfigCenter();
    const optimizedConfig = configCenter.optimizeConfig(service);
    
    if (!optimizedConfig) {
      return res.json(successResp({
        service,
        message: 'Insufficient data for optimization',
        recommendation: 'Need at least 60 data points for optimization'
      }));
    }
    
    logger.info({ service, optimizedConfig }, 'Pool config optimized');
    
    res.json(successResp({
      service,
      message: 'Pool config optimized',
      optimizedConfig,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message, service }, 'Failed to optimize pool config');
    next(new AppError(500, 'Failed to optimize pool config', error.message));
  }
});

// ============================================================
// GET /api/admin/pools/:service/history - Get scaling history
// ============================================================
router.get('/api/admin/pools/:service/history', async (req, res, next) => {
  const { service } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const poolManager = getPoolManagerInstance();
    const poolName = `pool-${service}`;
    
    // Get pool state
    const poolStats = poolManager.getStats()[poolName];
    
    if (!poolStats) {
      return next(new AppError(404, 'Pool not found', `No pool found for service: ${service}`));
    }
    
    // In a real implementation, this would fetch from persistent storage
    // For now, return mock history
    const history = [];
    
    res.json(successResp({
      service,
      history,
      count: history.length,
      limit,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message, service }, 'Failed to get pool history');
    next(new AppError(500, 'Failed to get pool history', error.message));
  }
});

// ============================================================
// POST /api/admin/pools/:service/scale-up - Manual scale up
// ============================================================
router.post('/api/admin/pools/:service/scale-up', async (req, res, next) => {
  const { service } = req.params;
  const { amount = 3, reason = 'manual' } = req.body;
  
  try {
    const poolManager = getPoolManagerInstance();
    const poolName = `pool-${service}`;
    
    const poolState = poolManager.pools?.get(poolName);
    if (!poolState) {
      return next(new AppError(404, 'Pool not found', `No pool found for service: ${service}`));
    }
    
    const pool = poolState.pool;
    const oldMax = pool.options?.max || 10;
    const newMax = Math.min(oldMax + amount, 30);
    
    // Update max size
    if (pool.options) {
      pool.options.max = newMax;
    }
    
    // Pre-warm connections
    const currentTotal = pool.totalCount || 0;
    const toCreate = Math.min(newMax, oldMax + amount) - currentTotal;
    
    for (let i = 0; i < toCreate && i < amount; i++) {
      try {
        const client = await pool.connect();
        client.release();
      } catch (e) {
        break;
      }
    }
    
    logger.info({ service, oldMax, newMax, amount, reason }, 'Pool manually scaled up');
    
    res.json(successResp({
      service,
      message: 'Pool scaled up',
      oldSize: oldMax,
      newSize: newMax,
      amount,
      reason,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message, service }, 'Failed to scale up pool');
    next(new AppError(500, 'Failed to scale up pool', error.message));
  }
});

// ============================================================
// POST /api/admin/pools/:service/scale-down - Manual scale down
// ============================================================
router.post('/api/admin/pools/:service/scale-down', async (req, res, next) => {
  const { service } = req.params;
  const { amount = 2, reason = 'manual' } = req.body;
  
  try {
    const poolManager = getPoolManagerInstance();
    const poolName = `pool-${service}`;
    
    const poolState = poolManager.pools?.get(poolName);
    if (!poolState) {
      return next(new AppError(404, 'Pool not found', `No pool found for service: ${service}`));
    }
    
    const pool = poolState.pool;
    const oldMax = pool.options?.max || 10;
    const newMax = Math.max(oldMax - amount, 2);
    
    // Update max size
    if (pool.options) {
      pool.options.max = newMax;
    }
    
    logger.info({ service, oldMax, newMax, amount, reason }, 'Pool manually scaled down');
    
    res.json(successResp({
      service,
      message: 'Pool scaled down',
      oldSize: oldMax,
      newSize: newMax,
      amount,
      reason,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message, service }, 'Failed to scale down pool');
    next(new AppError(500, 'Failed to scale down pool', error.message));
  }
});

// ============================================================
// GET /api/admin/pools/recommendations - Get optimization recommendations
// ============================================================
router.get('/api/admin/pools/recommendations', async (req, res, next) => {
  try {
    const configCenter = getPoolConfigCenter();
    const recommendations = configCenter.getRecommendations();
    
    res.json(successResp({
      recommendations,
      count: recommendations.length,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get recommendations');
    next(new AppError(500, 'Failed to get recommendations', error.message));
  }
});

// ============================================================
// GET /api/admin/pools/health - Health check all pools
// ============================================================
router.get('/api/admin/pools/health', async (req, res, next) => {
  try {
    const poolManager = getPoolManagerInstance();
    const healthResults = await poolManager.healthCheck();
    
    const allHealthy = Object.values(healthResults).every(r => r.healthy);
    
    res.json(successResp({
      healthy: allHealthy,
      pools: healthResults,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to check pool health');
    next(new AppError(500, 'Failed to check pool health', error.message));
  }
});

module.exports = router;
