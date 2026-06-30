// backend/services/admin/routes/bandwidth.js
// REQ-00397: API 响应压缩与带宽优化系统 - 管理路由

'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../../../shared/auth');
const { requirePermission } = require('../../../shared/middleware/permission');
const { getOptimizer, getBandwidthStats } = require('../../../shared/middleware/bandwidthOptimizer');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('bandwidth-routes');

/**
 * 获取带宽优化统计
 * GET /api/v1/admin/bandwidth/stats
 */
router.get('/stats',
  auth.authenticate,
  requirePermission('admin.system.read'),
  async (req, res) => {
    try {
      const optimizer = getOptimizer();
      const stats = optimizer.getStats();
      
      res.json({
        success: true,
        data: {
          compression: stats,
          config: {
            threshold: optimizer.config.compression.threshold,
            algorithms: optimizer.config.compression.algorithms,
            cacheEnabled: optimizer.config.cache.enabled,
            cacheTTL: optimizer.config.cache.ttl
          },
          timestamp: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('Failed to get bandwidth stats', { error: error.message });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get bandwidth statistics'
        }
      });
    }
  }
);

/**
 * 获取带宽使用历史
 * GET /api/v1/admin/bandwidth/history
 */
router.get('/history',
  auth.authenticate,
  requirePermission('admin.system.read'),
  async (req, res) => {
    try {
      const { hours = 24, service } = req.query;
      const db = require('../../../shared/db');
      
      let query = `
        SELECT 
          hour_bucket,
          service,
          total_bytes,
          compressed_bytes,
          request_count,
          avg_compression_ratio
        FROM bandwidth_history
        WHERE hour_bucket > NOW() - INTERVAL '${parseInt(hours)} hours'
      `;
      
      const params = [];
      if (service) {
        query += ' AND service = $1';
        params.push(service);
      }
      
      query += ' ORDER BY hour_bucket DESC';
      
      const result = await db.query(query, params);
      
      res.json({
        success: true,
        data: {
          history: result.rows,
          hours: parseInt(hours)
        }
      });
    } catch (error) {
      logger.error('Failed to get bandwidth history', { error: error.message });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get bandwidth history'
        }
      });
    }
  }
);

/**
 * 获取端点带宽使用排行
 * GET /api/v1/admin/bandwidth/endpoints
 */
router.get('/endpoints',
  auth.authenticate,
  requirePermission('admin.system.read'),
  async (req, res) => {
    try {
      const { limit = 20, orderBy = 'total_bytes' } = req.query;
      const db = require('../../../shared/db');
      
      const result = await db.query(`
        SELECT 
          endpoint,
          SUM(request_count) as total_requests,
          SUM(total_bytes) as total_bytes,
          SUM(compressed_bytes) as compressed_bytes,
          ROUND(AVG(compression_ratio), 2) as avg_compression_ratio,
          ROUND(SUM(total_bytes)::numeric / NULLIF(SUM(request_count), 0), 0) as avg_response_size
        FROM bandwidth_stats
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY endpoint
        ORDER BY ${orderBy} DESC
        LIMIT $1
      `, [parseInt(limit)]);
      
      res.json({
        success: true,
        data: {
          endpoints: result.rows,
          orderBy,
          limit: parseInt(limit)
        }
      });
    } catch (error) {
      logger.error('Failed to get endpoint stats', { error: error.message });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to get endpoint statistics'
        }
      });
    }
  }
);

/**
 * 更新带宽优化配置
 * PUT /api/v1/admin/bandwidth/config
 */
router.put('/config',
  auth.authenticate,
  requirePermission('admin.system.write'),
  async (req, res) => {
    try {
      const optimizer = getOptimizer();
      const { threshold, level, cacheEnabled, cacheTTL } = req.body;
      
      if (threshold) {
        optimizer.config.compression.threshold = Math.max(128, Math.min(10240, threshold));
      }
      
      if (level && typeof level === 'object') {
        optimizer.config.compression.level = {
          ...optimizer.config.compression.level,
          ...level
        };
      }
      
      if (typeof cacheEnabled === 'boolean') {
        optimizer.config.cache.enabled = cacheEnabled;
      }
      
      if (cacheTTL) {
        optimizer.config.cache.ttl = Math.max(60, Math.min(3600, cacheTTL));
      }
      
      logger.info('Bandwidth config updated', {
        userId: req.user?.id,
        changes: { threshold, level, cacheEnabled, cacheTTL }
      });
      
      res.json({
        success: true,
        message: 'Bandwidth optimization config updated',
        data: {
          config: {
            threshold: optimizer.config.compression.threshold,
            level: optimizer.config.compression.level,
            cacheEnabled: optimizer.config.cache.enabled,
            cacheTTL: optimizer.config.cache.ttl
          }
        }
      });
    } catch (error) {
      logger.error('Failed to update bandwidth config', { error: error.message });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to update bandwidth configuration'
        }
      });
    }
  }
);

/**
 * 清除压缩缓存
 * POST /api/v1/admin/bandwidth/cache/clear
 */
router.post('/cache/clear',
  auth.authenticate,
  requirePermission('admin.system.write'),
  async (req, res) => {
    try {
      const { getRedis } = require('../../../shared/redis');
      const redis = getRedis();
      
      // 扫描并删除所有压缩缓存键
      const keys = await redis.keys('bw:cache:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      
      // 重置缓存统计
      const optimizer = getOptimizer();
      optimizer.stats.cacheHits = 0;
      
      logger.info('Compression cache cleared', {
        userId: req.user?.id,
        keysDeleted: keys.length
      });
      
      res.json({
        success: true,
        message: `Cleared ${keys.length} cache entries`
      });
    } catch (error) {
      logger.error('Failed to clear cache', { error: error.message });
      res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to clear compression cache'
        }
      });
    }
  }
);

module.exports = router;
