// shared/routes/dbPoolRoutes.js - Database Pool Management API Routes
'use strict';

const express = require('express');
const router = express.Router();
const { createLogger } = require('../logger');

const logger = createLogger('db-pool-routes');

/**
 * GET /api/v1/admin/db-pool/status
 * Get status of all connection pools
 */
router.get('/status', async (req, res) => {
  try {
    const poolManager = req.app.locals.poolManager;
    const priorityPool = req.app.locals.priorityPool;
    const loadScheduler = req.app.locals.loadScheduler;
    const warmer = req.app.locals.connectionWarmer;
    const healthChecker = req.app.locals.connectionHealthChecker;

    const response = {
      timestamp: new Date().toISOString(),
      pools: {},
      aggregate: null,
      load: null,
      warmup: null,
      health: null
    };

    // Basic pool stats
    if (poolManager) {
      response.pools = poolManager.getStats();
      response.aggregate = poolManager.getAggregateStats();
    }

    // Priority pool stats
    if (priorityPool) {
      response.priorityPools = priorityPool.getStats();
    }

    // Load scheduler status
    if (loadScheduler) {
      response.load = loadScheduler.getStatus();
    }

    // Warmup schedule
    if (warmer) {
      response.warmup = warmer.getPeakSchedule();
    }

    // Health status
    if (healthChecker) {
      response.health = healthChecker.getHealthStatus();
    }

    res.json(response);
  } catch (err) {
    logger.error({ err }, 'Failed to get pool status');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/admin/db-pool/pools/:priority
 * Get specific priority pool details
 */
router.get('/pools/:priority', async (req, res) => {
  try {
    const { priority } = req.params;
    const priorityPool = req.app.locals.priorityPool;

    if (!priorityPool) {
      return res.status(404).json({ error: 'Priority pool not available' });
    }

    const stats = priorityPool.getStats();
    const poolStats = stats[priority];

    if (!poolStats) {
      return res.status(404).json({ error: `Priority ${priority} not found` });
    }

    res.json({
      priority,
      stats: poolStats,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get priority pool');
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/v1/admin/db-pool/config
 * Update pool configuration
 */
router.patch('/config', async (req, res) => {
  try {
    const { priority, maxConnections, minConnections } = req.body;
    const priorityPool = req.app.locals.priorityPool;

    if (!priorityPool) {
      return res.status(404).json({ error: 'Priority pool not available' });
    }

    if (!priority || !priorityPool.pools[priority]) {
      return res.status(400).json({ error: 'Invalid priority' });
    }

    const pool = priorityPool.pools[priority];
    const poolState = priorityPool.poolStates[priority];

    // Update max connections
    if (maxConnections) {
      const newMax = parseInt(maxConnections);
      if (newMax < 2 || newMax > 100) {
        return res.status(400).json({ error: 'maxConnections must be between 2 and 100' });
      }
      
      pool.options.max = newMax;
      poolState.currentMax = newMax;
      
      logger.info({
        priority,
        oldMax: poolState.currentMax,
        newMax
      }, 'Pool max connections updated');
    }

    res.json({
      success: true,
      priority,
      config: {
        max: poolState.currentMax,
        min: poolState.currentMin
      }
    });
  } catch (err) {
    logger.error({ err }, 'Failed to update pool config');
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/db-pool/warmup
 * Trigger manual connection warmup
 */
router.post('/warmup', async (req, res) => {
  try {
    const { targetConnections, priority = 'NORMAL' } = req.body;
    const warmer = req.app.locals.connectionWarmer;

    if (!warmer) {
      return res.status(404).json({ error: 'Connection warmer not available' });
    }

    if (!targetConnections || targetConnections < 1) {
      return res.status(400).json({ error: 'targetConnections must be positive' });
    }

    // Trigger warmup
    await warmer.warmupNow(targetConnections, priority);

    res.json({
      success: true,
      message: `Warmup triggered for ${targetConnections} connections`,
      priority
    });
  } catch (err) {
    logger.error({ err }, 'Failed to trigger warmup');
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/db-pool/scale
 * Manual scale pool up or down
 */
router.post('/scale', async (req, res) => {
  try {
    const { priority, direction, amount = 5 } = req.body;
    const priorityPool = req.app.locals.priorityPool;

    if (!priorityPool) {
      return res.status(404).json({ error: 'Priority pool not available' });
    }

    if (!priority || !priorityPool.pools[priority]) {
      return res.status(400).json({ error: 'Invalid priority' });
    }

    if (!['up', 'down'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be "up" or "down"' });
    }

    const pool = priorityPool.pools[priority];
    const poolState = priorityPool.poolStates[priority];
    
    const oldMax = poolState.currentMax;
    let newMax;

    if (direction === 'up') {
      newMax = Math.min(oldMax + amount, 100);
    } else {
      newMax = Math.max(oldMax - amount, 2);
    }

    pool.options.max = newMax;
    poolState.currentMax = newMax;

    logger.info({
      priority,
      direction,
      oldMax,
      newMax
    }, 'Manual pool scale');

    res.json({
      success: true,
      priority,
      direction,
      oldMax,
      newMax
    });
  } catch (err) {
    logger.error({ err }, 'Failed to scale pool');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/admin/db-pool/health
 * Get connection health status
 */
router.get('/health', async (req, res) => {
  try {
    const healthChecker = req.app.locals.connectionHealthChecker;

    if (!healthChecker) {
      return res.status(404).json({ error: 'Health checker not available' });
    }

    const status = healthChecker.getHealthStatus();

    res.json({
      timestamp: new Date().toISOString(),
      ...status
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get health status');
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/admin/db-pool/health-check
 * Trigger immediate health check
 */
router.post('/health-check', async (req, res) => {
  try {
    const healthChecker = req.app.locals.connectionHealthChecker;

    if (!healthChecker) {
      return res.status(404).json({ error: 'Health checker not available' });
    }

    const result = await healthChecker.performHealthCheck();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (err) {
    logger.error({ err }, 'Failed to perform health check');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/admin/db-pool/load
 * Get load scheduler status
 */
router.get('/load', async (req, res) => {
  try {
    const loadScheduler = req.app.locals.loadScheduler;

    if (!loadScheduler) {
      return res.status(404).json({ error: 'Load scheduler not available' });
    }

    const status = loadScheduler.getStatus();

    res.json({
      timestamp: new Date().toISOString(),
      ...status
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get load status');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/admin/db-pool/recommendations
 * Get connection pool recommendations
 */
router.get('/recommendations', async (req, res) => {
  try {
    const loadScheduler = req.app.locals.loadScheduler;
    const priorityPool = req.app.locals.priorityPool;

    const recommendations = [];

    if (loadScheduler) {
      const status = loadScheduler.getStatus();
      
      // Check load level
      if (status.loadLevel === 'HIGH' || status.loadLevel === 'CRITICAL') {
        recommendations.push({
          type: 'scale_up',
          priority: 'HIGH',
          message: `Load is ${status.loadLevel} (${status.currentLoadScore.toFixed(2)}). Consider scaling up connections.`,
          suggestedAction: 'POST /api/v1/admin/db-pool/scale with { priority: "HIGH", direction: "up" }'
        });
      }

      // Check predictions
      for (const [minutes, predicted] of Object.entries(status.predictions)) {
        if (predicted > 80) {
          recommendations.push({
            type: 'preemptive_scale',
            message: `Predicted high load in ${minutes} minutes (${predicted.toFixed(2)}). Consider preemptive scaling.`,
            suggestedAction: 'POST /api/v1/admin/db-pool/warmup'
          });
        }
      }
    }

    if (priorityPool) {
      const stats = priorityPool.getStats();
      
      for (const [priority, poolStats] of Object.entries(stats)) {
        const utilization = parseFloat(poolStats.utilization);
        
        if (utilization > 90) {
          recommendations.push({
            type: 'high_utilization',
            priority,
            message: `${priority} pool utilization is ${poolStats.utilization}. Queue length: ${poolStats.queueLength}`,
            suggestedAction: `PATCH /api/v1/admin/db-pool/config with { priority: "${priority}", maxConnections: ${poolStats.max + 5} }`
          });
        }
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      recommendations
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get recommendations');
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
