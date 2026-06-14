// gateway/src/routes/redis-admin.js - Redis 连接池管理 API
'use strict';

const express = require('express');
const router = express.Router();
const { getPoolManager } = require('../../../shared/RedisPoolManager');

/**
 * GET /admin/redis/pools
 * 获取所有连接池状态
 */
router.get('/pools', async (req, res) => {
  try {
    const manager = getPoolManager();
    const stats = manager.getAllPoolStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/redis/pools/:name
 * 获取指定连接池状态
 */
router.get('/pools/:name', async (req, res) => {
  try {
    const manager = getPoolManager();
    const stats = manager.getPoolStats(req.params.name);

    if (!stats) {
      return res.status(404).json({ success: false, error: 'Pool not found' });
    }

    res.json({ success: true, data: stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/redis/health
 * 健康检查
 */
router.get('/health', async (req, res) => {
  try {
    const manager = getPoolManager();
    const poolName = req.query.pool || 'default';
    const health = await manager.healthCheck(poolName);
    res.json({ success: true, data: health });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /admin/redis/pools/:name/reset
 * 重置连接池
 */
router.post('/pools/:name/reset', async (req, res) => {
  try {
    const manager = getPoolManager();
    await manager.resetPool(req.params.name);
    res.json({ success: true, message: `Pool "${req.params.name}" reset completed` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/redis/leaks
 * 泄漏检测报告
 */
router.get('/leaks', async (req, res) => {
  try {
    const manager = getPoolManager();
    const poolName = req.query.pool || 'default';
    const leaks = manager.detectLeaks(poolName);
    res.json({ success: true, data: { pool: poolName, leaks, count: leaks.length } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /admin/redis/metrics
 * Prometheus 指标摘要
 */
router.get('/metrics', async (req, res) => {
  try {
    const manager = getPoolManager();
    const stats = manager.getAllPoolStats();

    // 构建指标摘要
    const summary = {
      pools: {},
      totalConnections: 0,
      totalActive: 0,
      totalIdle: 0,
      totalWaiting: 0,
      healthStatus: 'healthy',
    };

    for (const [name, poolStats] of Object.entries(stats)) {
      if (!poolStats) continue;

      summary.pools[name] = {
        total: poolStats.total,
        active: poolStats.active,
        idle: poolStats.idle,
        waiting: poolStats.waiting,
        health: poolStats.health?.status || 'unknown',
        latency: poolStats.health?.latency || 0,
      };

      summary.totalConnections += poolStats.total;
      summary.totalActive += poolStats.active;
      summary.totalIdle += poolStats.idle;
      summary.totalWaiting += poolStats.waiting;

      if (poolStats.health?.status === 'unhealthy') {
        summary.healthStatus = 'unhealthy';
      } else if (poolStats.health?.status === 'degraded' && summary.healthStatus !== 'unhealthy') {
        summary.healthStatus = 'degraded';
      }
    }

    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
