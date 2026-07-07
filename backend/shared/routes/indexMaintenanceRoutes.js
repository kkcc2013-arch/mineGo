// routes/indexMaintenanceRoutes.js - Index Maintenance API Routes
'use strict';

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../shared/logger');
const { indexMonitor, getLatestStats, getHistoricalTrend, generateReport } = require('../../shared/indexUsageMonitor');
const { indexMaintenanceJob, run, getStats, JOB_CONFIG, ACTIONS } = require('../jobs/indexMaintenanceJob');
const { authMiddleware, requireRole } = require('../../shared/auth');

const logger = createLogger('index-maintenance-routes');

/**
 * GET /api/index-maintenance/stats
 * Get latest index statistics
 */
router.get('/stats', authMiddleware, async (req, res) => {
  try {
    const stats = await getLatestStats();

    if (!stats) {
      return res.json({
        status: 'no_data',
        message: 'No index statistics available. Run collection first.'
      });
    }

    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get index stats');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/index-maintenance/report
 * Get index analysis report
 */
router.get('/report', authMiddleware, async (req, res) => {
  try {
    const report = await generateReport();
    res.json({
      status: 'success',
      data: report
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to generate report');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/index-maintenance/trend
 * Get historical trend data
 */
router.get('/trend', authMiddleware, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const trend = await getHistoricalTrend(days);

    res.json({
      status: 'success',
      data: trend
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get trend data');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/index-maintenance/collect
 * Trigger index statistics collection
 * Requires admin role
 */
router.post('/collect', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    logger.info({ userId: req.user?.sub }, 'Manual index collection triggered');

    const stats = await indexMonitor.collectIndexStats();

    res.json({
      status: 'success',
      message: 'Index statistics collected successfully',
      data: {
        totalIndexes: stats?.total || 0,
        unusedCount: stats?.unused?.length || 0,
        lowUsageCount: stats?.lowUsage?.length || 0,
        duplicateCount: stats?.duplicates?.length || 0,
        summary: stats?.summary
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to collect index stats');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/index-maintenance/run
 * Run maintenance job with specific action
 * Requires admin role
 */
router.post('/run', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { action } = req.body;

    if (!action || !Object.values(ACTIONS).includes(action)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid action. Must be one of: ${Object.values(ACTIONS).join(', ')}`,
        validActions: Object.values(ACTIONS)
      });
    }

    logger.info({ userId: req.user?.sub, action }, 'Manual maintenance job triggered');

    const result = await run(action);

    res.json({
      status: 'success',
      message: `Maintenance job '${action}' executed successfully`,
      data: result
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to run maintenance job');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/index-maintenance/remove
 * Remove specific unused index (requires admin approval)
 */
router.post('/remove', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { indexName, schema, tableName, force } = req.body;

    if (!indexName || !schema) {
      return res.status(400).json({
        status: 'error',
        message: 'indexName and schema are required'
      });
    }

    // Safety check: don't remove primary keys or foreign keys
    if (indexName.includes('_pkey') || indexName.includes('_fk')) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot remove primary key or foreign key indexes'
      });
    }

    // Get current stats to verify it's safe to remove
    const stats = await getLatestStats();
    const indexInfo = stats?.stats?.indexes?.find(i => i.name === indexName);

    if (!force && indexInfo?.scans > 0) {
      return res.status(400).json({
        status: 'error',
        message: `Index has ${indexInfo.scans} scans and cannot be auto-removed. Use force=true to override.`,
        indexInfo
      });
    }

    logger.info({
      userId: req.user?.sub,
      indexName,
      schema,
      tableName,
      force
    }, 'Manual index removal requested');

    // In dry run mode, don't actually execute
    if (JOB_CONFIG.dryRun) {
      return res.json({
        status: 'dry_run',
        message: 'Dry run mode - index would be removed',
        sql: `DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${indexName};`
      });
    }

    // Execute the removal
    const { query } = require('../../shared/db');
    const sql = `DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${indexName};`;
    await query(sql);

    // Record the action
    logger.info({
      userId: req.user?.sub,
      indexName,
      schema,
      tableName,
      sql
    }, 'Index successfully removed');

    res.json({
      status: 'success',
      message: `Index ${indexName} removed successfully`,
      sql
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to remove index');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/index-maintenance/job-stats
 * Get job execution statistics
 */
router.get('/job-stats', authMiddleware, async (req, res) => {
  try {
    const stats = getStats();
    res.json({
      status: 'success',
      data: stats
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get job stats');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/index-maintenance/config
 * Get current configuration
 */
router.get('/config', authMiddleware, requireRole('admin'), async (req, res) => {
  try {
    res.json({
      status: 'success',
      data: JOB_CONFIG
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get config');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/index-maintenance/unused
 * Get list of unused indexes
 */
router.get('/unused', authMiddleware, async (req, res) => {
  try {
    const stats = await getLatestStats();

    if (!stats) {
      return res.json({
        status: 'no_data',
        message: 'No statistics available'
      });
    }

    res.json({
      status: 'success',
      data: stats.stats.unused.map(idx => ({
        name: idx.name,
        table: idx.table,
        size: idx.size,
        scans: idx.scans,
        risk: idx.risk.level,
        recommendation: idx.recommendation[0]?.sql
      }))
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get unused indexes');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/index-maintenance/duplicates
 * Get list of duplicate indexes
 */
router.get('/duplicates', authMiddleware, async (req, res) => {
  try {
    const stats = await getLatestStats();

    if (!stats) {
      return res.json({
        status: 'no_data',
        message: 'No statistics available'
      });
    }

    res.json({
      status: 'success',
      data: stats.stats.duplicates
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get duplicate indexes');
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * GET /api/index-maintenance/health
 * Health check endpoint
 */
router.get('/health', async (req, res) => {
  try {
    const latestStats = await getLatestStats();
    const jobStats = getStats();

    const health = {
      status: 'healthy',
      components: {
        statsCollector: latestStats ? 'ok' : 'no_data',
        maintenanceJob: jobStats.running ? 'running' : 'idle',
        config: JOB_CONFIG.enabled ? 'enabled' : 'disabled'
      },
      lastCollection: latestStats?.timestamp || null,
      lastRun: jobStats.lastRunTime || null,
      metrics: {
        totalRuns: jobStats.runs,
        indexesRemoved: jobStats.indexesRemoved,
        errors: jobStats.errors
      }
    };

    res.json(health);
  } catch (error) {
    logger.error({ error: error.message }, 'Health check failed');
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

module.exports = router;