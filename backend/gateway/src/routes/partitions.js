/**
 * REQ-00060: 分区管理 API 路由
 * 
 * 提供分区管理、统计、维护的 REST API
 */

const express = require('express');
const router = express.Router();
const partitionManager = require('@pmg/shared/partitionManager');
const { logger, metrics } = require('@pmg/shared/index');

/**
 * GET /api/partitions/overview
 * 获取所有分区表的概览
 */
router.get('/overview', async (req, res) => {
  try {
    const overview = await partitionManager.getOverview();
    res.json({
      success: true,
      data: overview,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get partition overview', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get partition overview',
      message: error.message
    });
  }
});

/**
 * GET /api/partitions/:tableName
 * 获取指定表的分区详情
 */
router.get('/:tableName', async (req, res) => {
  try {
    const { tableName } = req.params;

    // 验证表名
    const validTables = Object.keys(partitionManager.partitionConfigs);
    if (!validTables.includes(tableName)) {
      return res.status(400).json({
        success: false,
        error: `Invalid table name. Valid tables: ${validTables.join(', ')}`
      });
    }

    const stats = await partitionManager.getPartitionStats(tableName);
    const config = partitionManager.partitionConfigs[tableName];

    const totalSize = stats.reduce((sum, s) => sum + s.sizeBytes, 0);
    const totalRows = stats.reduce((sum, s) => sum + s.rowCount, 0);

    res.json({
      success: true,
      data: {
        tableName,
        config,
        partitionCount: stats.length,
        totalSizeBytes: totalSize,
        totalRows,
        partitions: stats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get table partitions', {
      table: req.params.tableName,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to get table partitions',
      message: error.message
    });
  }
});

/**
 * POST /api/partitions/:tableName/create
 * 为指定表创建未来分区
 */
router.post('/:tableName/create', async (req, res) => {
  try {
    const { tableName } = req.params;
    const { count = 3 } = req.body;

    // 验证表名
    const validTables = Object.keys(partitionManager.partitionConfigs);
    if (!validTables.includes(tableName)) {
      return res.status(400).json({
        success: false,
        error: `Invalid table name. Valid tables: ${validTables.join(', ')}`
      });
    }

    const created = await partitionManager.ensureFuturePartitions(tableName, count);

    res.json({
      success: true,
      data: {
        tableName,
        createdPartitions: created,
        count: created.length
      },
      message: `Created ${created.length} partition(s) for ${tableName}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to create partitions', {
      table: req.params.tableName,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to create partitions',
      message: error.message
    });
  }
});

/**
 * POST /api/partitions/:tableName/archive
 * 归档指定表的旧分区
 */
router.post('/:tableName/archive', async (req, res) => {
  try {
    const { tableName } = req.params;

    // 验证表名
    const validTables = Object.keys(partitionManager.partitionConfigs);
    if (!validTables.includes(tableName)) {
      return res.status(400).json({
        success: false,
        error: `Invalid table name. Valid tables: ${validTables.join(', ')}`
      });
    }

    const archived = await partitionManager.archiveOldPartitions(tableName);

    res.json({
      success: true,
      data: {
        tableName,
        archivedPartitions: archived,
        count: archived.length
      },
      message: `Archived ${archived.length} partition(s) for ${tableName}`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to archive partitions', {
      table: req.params.tableName,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: 'Failed to archive partitions',
      message: error.message
    });
  }
});

/**
 * POST /api/partitions/maintenance
 * 执行分区维护任务（创建、归档、删除）
 */
router.post('/maintenance', async (req, res) => {
  try {
    const results = await partitionManager.runMaintenance();

    res.json({
      success: true,
      data: results,
      message: 'Partition maintenance completed',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to run partition maintenance', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to run partition maintenance',
      message: error.message
    });
  }
});

/**
 * GET /api/partitions/config
 * 获取分区配置信息
 */
router.get('/config/list', async (req, res) => {
  try {
    const configs = {};

    for (const [tableName, config] of Object.entries(partitionManager.partitionConfigs)) {
      configs[tableName] = {
        granularity: config.granularity,
        retention: config.retentionMonths || config.retentionDays || config.retentionWeeks || 'permanent',
        archive: config.archiveMonths || config.archiveDays || config.archiveWeeks || 'none'
      };
    }

    res.json({
      success: true,
      data: configs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get partition configs', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get partition configs',
      message: error.message
    });
  }
});

/**
 * GET /api/partitions/stats/summary
 * 获取分区统计摘要（用于监控仪表板）
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const overview = await partitionManager.getOverview();

    const summary = {
      tables: Object.keys(overview).length,
      totalPartitions: 0,
      totalSizeBytes: 0,
      totalRows: 0,
      byTable: {}
    };

    for (const [tableName, data] of Object.entries(overview)) {
      if (data.partitionCount !== undefined) {
        summary.totalPartitions += data.partitionCount;
        summary.totalSizeBytes += data.totalSizeBytes || 0;
        summary.totalRows += data.totalRows || 0;
        summary.byTable[tableName] = {
          partitions: data.partitionCount,
          sizeBytes: data.totalSizeBytes || 0,
          rows: data.totalRows || 0
        };
      }
    }

    // 更新 Prometheus 指标
    metrics.gauge('partition_total_count', summary.totalPartitions);
    metrics.gauge('partition_total_size_bytes', summary.totalSizeBytes);
    metrics.gauge('partition_total_rows', summary.totalRows);

    res.json({
      success: true,
      data: summary,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get partition stats summary', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get partition stats summary',
      message: error.message
    });
  }
});

module.exports = router;
