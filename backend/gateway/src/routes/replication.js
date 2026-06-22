/**
 * REQ-00259: 数据库复制监控 API 路由
 * 提供读写分离和复制状态查询接口
 * 
 * 创建时间: 2026-06-22 01:05
 */

'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../shared/db');
const { createLogger } = require('../../shared/logger');

const logger = createLogger('replication-routes');

/**
 * GET /api/replication/overview
 * 获取主从复制状态概览
 */
router.get('/overview', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM replication_overview
    `);
    
    // 获取配置
    const configResult = await query(`
      SELECT key, value FROM read_write_config
    `);
    
    const config = {};
    for (const row of configResult.rows) {
      config[row.key] = row.value;
    }
    
    res.json({
      success: true,
      data: {
        nodes: result.rows,
        config,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get replication overview');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/replication/stats
 * 获取读写分布统计
 */
router.get('/stats', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    let intervalClause;
    switch (period) {
      case '1h':
        intervalClause = "created_at > NOW() - INTERVAL '1 hour'";
        break;
      case '6h':
        intervalClause = "created_at > NOW() - INTERVAL '6 hours'";
        break;
      case '24h':
      default:
        intervalClause = "created_at > NOW() - INTERVAL '24 hours'";
    }
    
    // 读写比例
    const ratioResult = await query(`
      SELECT 
        query_type,
        COUNT(*) as count,
        AVG(execution_time_ms) as avg_time_ms,
        COUNT(*) FILTER (WHERE success = false) as error_count
      FROM read_write_routing_logs
      WHERE ${intervalClause}
      GROUP BY query_type
    `);
    
    // 节点分布
    const nodeResult = await query(`
      SELECT 
        target_node,
        query_type,
        COUNT(*) as count,
        AVG(execution_time_ms) as avg_time_ms
      FROM read_write_routing_logs
      WHERE ${intervalClause}
      GROUP BY target_node, query_type
      ORDER BY count DESC
    `);
    
    // 错误趋势
    const errorResult = await query(`
      SELECT 
        DATE_TRUNC('hour', created_at) as hour,
        COUNT(*) FILTER (WHERE success = false) as error_count,
        COUNT(*) as total_count
      FROM read_write_routing_logs
      WHERE ${intervalClause}
      GROUP BY DATE_TRUNC('hour', created_at)
      ORDER BY hour
    `);
    
    res.json({
      success: true,
      data: {
        period,
        queryTypes: ratioResult.rows,
        nodeDistribution: nodeResult.rows,
        errorTrend: errorResult.rows,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get replication stats');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/replication/health
 * 健康检查端点
 */
router.get('/health', async (req, res) => {
  try {
    // 检查主库连接
    const masterResult = await query('SELECT 1 as test');
    const masterHealthy = masterResult.rows.length > 0;
    
    // 获取从库状态
    const replicaResult = await query(`
      SELECT 
        node_name,
        is_healthy,
        sync_delay_ms,
        last_check_at
      FROM replication_status
      WHERE node_type = 'replica' AND is_active = true
    `);
    
    const healthyReplicas = replicaResult.rows.filter(r => r.is_healthy).length;
    const totalReplicas = replicaResult.rows.length;
    
    // 计算整体健康状态
    const allHealthy = masterHealthy && (totalReplicas === 0 || healthyReplicas > 0);
    
    res.json({
      success: true,
      data: {
        status: allHealthy ? 'healthy' : 'degraded',
        master: {
          healthy: masterHealthy
        },
        replicas: {
          total: totalReplicas,
          healthy: healthyReplicas,
          details: replicaResult.rows
        },
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Health check failed');
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: error.message
    });
  }
});

/**
 * GET /api/replication/failover/history
 * 获取故障切换历史
 */
router.get('/failover/history', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    
    const result = await query(`
      SELECT 
        id,
        event_type,
        old_master,
        new_master,
        reason,
        duration_ms,
        success,
        triggered_by,
        created_at
      FROM failover_events
      ORDER BY created_at DESC
      LIMIT $1
    `, [parseInt(limit)]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get failover history');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/replication/hourly-stats
 * 获取每小时统计（用于图表）
 */
router.get('/hourly-stats', async (req, res) => {
  try {
    const result = await query(`
      SELECT * FROM read_write_hourly_stats
      ORDER BY hour DESC
      LIMIT 48
    `);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get hourly stats');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/replication/config
 * 更新配置（需要管理员权限）
 */
router.put('/config', async (req, res) => {
  try {
    const { key, value } = req.body;
    
    // 验证配置键
    const validKeys = [
      'sync_delay_threshold_ms',
      'read_weight_distribution',
      'replica_health_check_interval_ms',
      'failover_timeout_ms',
      'max_replication_lag_bytes',
      'read_from_master_on_failure',
      'enable_query_routing_log'
    ];
    
    if (!validKeys.includes(key)) {
      return res.status(400).json({
        success: false,
        error: `Invalid config key: ${key}`
      });
    }
    
    await query(`
      UPDATE read_write_config
      SET value = $1, updated_at = NOW()
      WHERE key = $2
    `, [JSON.stringify(value), key]);
    
    logger.info({ key, value }, 'Replication config updated');
    
    res.json({
      success: true,
      message: 'Config updated'
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to update config');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/replication/health-check
 * 手动触发健康检查
 */
router.post('/health-check', async (req, res) => {
  try {
    // 查询主库状态
    const masterResult = await query(`
      SELECT 
        pg_current_wal_lsn() as current_lsn,
        pg_is_in_recovery() as is_replica
    `);
    
    // 查询从库状态
    const replicaResult = await query(`
      SELECT 
        client_addr,
        application_name,
        state,
        sync_state,
        sent_lsn,
        replay_lsn,
        EXTRACT(EPOCH FROM (now() - reply_time)) as seconds_since_reply
      FROM pg_stat_replication
    `);
    
    // 更新主库状态
    await query(`
      INSERT INTO replication_status (node_name, node_type, connection_string, is_healthy, last_check_at)
      VALUES ('master', 'master', $1, true, NOW())
      ON CONFLICT (node_name)
      DO UPDATE SET is_healthy = true, last_check_at = NOW()
    `, [process.env.DATABASE_URL?.substring(0, 50) + '...' || 'local']);
    
    res.json({
      success: true,
      data: {
        master: masterResult.rows[0],
        replicas: replicaResult.rows,
        timestamp: new Date()
      }
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Manual health check failed');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
