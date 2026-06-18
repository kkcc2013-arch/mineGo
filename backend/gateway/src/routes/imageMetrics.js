// backend/gateway/src/routes/imageMetrics.js
// 图片加载性能指标 API
'use strict';

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');
const { rateLimit } = require('../../../shared/rateLimit');

const logger = createLogger('image-metrics');

// 图片指标上报速率限制（每分钟 60 次）
const metricsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user?.sub || req.ip
});

/**
 * POST /api/metrics/image-load
 * 图片加载统计上报
 */
router.post('/api/metrics/image-load', metricsRateLimit, async (req, res) => {
  try {
    const {
      pokemonId,
      loadTime,
      cached,
      timestamp,
      userAgent,
      connection
    } = req.body;
    
    const userId = req.user?.sub || null;
    
    // 参数校验
    if (!pokemonId || typeof loadTime !== 'number') {
      return res.status(400).json({
        success: false,
        error: 'Invalid parameters: pokemonId and loadTime are required'
      });
    }
    
    // 限制 loadTime 范围（防止异常值）
    const normalizedLoadTime = Math.max(0, Math.min(loadTime, 60000)); // 最大 60 秒
    
    // 记录到数据库（异步，不阻塞响应）
    query(`
      INSERT INTO image_load_metrics 
      (pokemon_id, user_id, load_time_ms, was_cached, device_type, connection_type, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
    `, [
      pokemonId,
      userId,
      normalizedLoadTime,
      Boolean(cached),
      parseDeviceType(userAgent),
      connection || 'unknown',
      timestamp || Date.now()
    ]).catch(err => {
      logger.error({ err, pokemonId }, 'Failed to save image metrics to database');
    });
    
    // 更新 Prometheus 指标
    if (metrics && metrics.histogram) {
      metrics.histogram('image_load_time_ms', normalizedLoadTime, {
        pokemon_id: String(pokemonId),
        cached: String(Boolean(cached)),
        device_type: parseDeviceType(userAgent) || 'unknown'
      });
    }
    
    if (metrics && metrics.increment) {
      metrics.increment('image_loads_total', 1, {
        cached: String(Boolean(cached))
      });
    }
    
    // 快速响应
    res.json({ success: true });
    
  } catch (error) {
    logger.error({ error }, 'Failed to record image metrics');
    res.status(500).json({ success: false, error: 'Failed to record metrics' });
  }
});

/**
 * GET /api/metrics/image-stats
 * 获取图片加载统计
 */
router.get('/api/metrics/image-stats', async (req, res) => {
  try {
    const { period = '24h', pokemonId } = req.query;
    
    const periodHours = {
      '1h': 1,
      '6h': 6,
      '24h': 24,
      '7d': 168,
      '30d': 720
    };
    
    const hours = periodHours[period] || 24;
    
    let queryText = `
      SELECT 
        COUNT(*) as total_loads,
        AVG(load_time_ms) as avg_load_time,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
        PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY load_time_ms) as p90_load_time,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY load_time_ms) as p99_load_time,
        MIN(load_time_ms) as min_load_time,
        MAX(load_time_ms) as max_load_time,
        SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count,
        COUNT(DISTINCT pokemon_id) as unique_pokemon,
        COUNT(DISTINCT user_id) as unique_users
      FROM image_load_metrics
      WHERE created_at > NOW() - INTERVAL '${hours} hours'
    `;
    
    const queryParams = [];
    
    if (pokemonId) {
      queryText += ' AND pokemon_id = $1';
      queryParams.push(parseInt(pokemonId, 10));
    }
    
    const { rows } = await query(queryText, queryParams);
    
    const stats = rows[0] || {};
    
    res.json({
      success: true,
      data: {
        period,
        totalLoads: parseInt(stats.total_loads, 10) || 0,
        avgLoadTime: Math.round(parseFloat(stats.avg_load_time) || 0),
        p50LoadTime: Math.round(parseFloat(stats.p50_load_time) || 0),
        p90LoadTime: Math.round(parseFloat(stats.p90_load_time) || 0),
        p95LoadTime: Math.round(parseFloat(stats.p95_load_time) || 0),
        p99LoadTime: Math.round(parseFloat(stats.p99_load_time) || 0),
        minLoadTime: parseInt(stats.min_load_time, 10) || 0,
        maxLoadTime: parseInt(stats.max_load_time, 10) || 0,
        cachedCount: parseInt(stats.cached_count, 10) || 0,
        uniquePokemon: parseInt(stats.unique_pokemon, 10) || 0,
        uniqueUsers: parseInt(stats.unique_users, 10) || 0,
        cacheHitRate: stats.total_loads > 0
          ? ((stats.cached_count / stats.total_loads) * 100).toFixed(2) + '%'
          : '0%'
      }
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to get image stats');
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

/**
 * GET /api/metrics/image-stats/by-pokemon
 * 按精灵分组的加载统计
 */
router.get('/api/metrics/image-stats/by-pokemon', async (req, res) => {
  try {
    const { period = '24h', limit = 20, sortBy = 'loads' } = req.query;
    
    const periodHours = {
      '1h': 1,
      '24h': 24,
      '7d': 168,
      '30d': 720
    };
    
    const hours = periodHours[period] || 24;
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    
    const sortColumn = sortBy === 'time' ? 'avg_load_time' : 'total_loads';
    
    const { rows } = await query(`
      SELECT 
        pokemon_id,
        COUNT(*) as total_loads,
        AVG(load_time_ms) as avg_load_time,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
        SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count
      FROM image_load_metrics
      WHERE created_at > NOW() - INTERVAL '${hours} hours'
      GROUP BY pokemon_id
      ORDER BY ${sortColumn} DESC
      LIMIT $1
    `, [limitNum]);
    
    res.json({
      success: true,
      data: rows.map(row => ({
        pokemonId: parseInt(row.pokemon_id, 10),
        totalLoads: parseInt(row.total_loads, 10),
        avgLoadTime: Math.round(parseFloat(row.avg_load_time) || 0),
        p50LoadTime: Math.round(parseFloat(row.p50_load_time) || 0),
        p95LoadTime: Math.round(parseFloat(row.p95_load_time) || 0),
        cachedCount: parseInt(row.cached_count, 10),
        cacheHitRate: row.total_loads > 0
          ? ((row.cached_count / row.total_loads) * 100).toFixed(2) + '%'
          : '0%'
      }))
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to get image stats by pokemon');
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

/**
 * GET /api/metrics/image-stats/by-device
 * 按设备类型分组的加载统计
 */
router.get('/api/metrics/image-stats/by-device', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    const periodHours = {
      '1h': 1,
      '24h': 24,
      '7d': 168
    };
    
    const hours = periodHours[period] || 24;
    
    const { rows } = await query(`
      SELECT 
        device_type,
        connection_type,
        COUNT(*) as total_loads,
        AVG(load_time_ms) as avg_load_time,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY load_time_ms) as p50_load_time,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY load_time_ms) as p95_load_time,
        SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count
      FROM image_load_metrics
      WHERE created_at > NOW() - INTERVAL '${hours} hours'
      GROUP BY device_type, connection_type
      ORDER BY total_loads DESC
    `);
    
    res.json({
      success: true,
      data: rows.map(row => ({
        deviceType: row.device_type || 'unknown',
        connectionType: row.connection_type || 'unknown',
        totalLoads: parseInt(row.total_loads, 10),
        avgLoadTime: Math.round(parseFloat(row.avg_load_time) || 0),
        p50LoadTime: Math.round(parseFloat(row.p50_load_time) || 0),
        p95LoadTime: Math.round(parseFloat(row.p95_load_time) || 0),
        cachedCount: parseInt(row.cached_count, 10),
        cacheHitRate: row.total_loads > 0
          ? ((row.cached_count / row.total_loads) * 100).toFixed(2) + '%'
          : '0%'
      }))
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to get image stats by device');
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

/**
 * GET /api/metrics/image-stats/trend
 * 图片加载趋势（按小时分组）
 */
router.get('/api/metrics/image-stats/trend', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    
    const periodHours = {
      '6h': 6,
      '24h': 24,
      '7d': 168
    };
    
    const hours = periodHours[period] || 24;
    
    const { rows } = await query(`
      SELECT 
        DATE_TRUNC('hour', created_at) as hour,
        COUNT(*) as total_loads,
        AVG(load_time_ms) as avg_load_time,
        SUM(CASE WHEN was_cached THEN 1 ELSE 0 END) as cached_count
      FROM image_load_metrics
      WHERE created_at > NOW() - INTERVAL '${hours} hours'
      GROUP BY DATE_TRUNC('hour', created_at)
      ORDER BY hour ASC
    `);
    
    res.json({
      success: true,
      data: rows.map(row => ({
        timestamp: row.hour.toISOString(),
        totalLoads: parseInt(row.total_loads, 10),
        avgLoadTime: Math.round(parseFloat(row.avg_load_time) || 0),
        cachedCount: parseInt(row.cached_count, 10),
        cacheHitRate: row.total_loads > 0
          ? ((row.cached_count / row.total_loads) * 100).toFixed(2) + '%'
          : '0%'
      }))
    });
    
  } catch (error) {
    logger.error({ error }, 'Failed to get image stats trend');
    res.status(500).json({ success: false, error: 'Failed to get stats' });
  }
});

/**
 * 解析设备类型
 */
function parseDeviceType(userAgent) {
  if (!userAgent) return 'unknown';
  
  const ua = userAgent.toLowerCase();
  
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    if (ua.includes('iphone') || ua.includes('ipad')) {
      return 'ios';
    }
    return 'android';
  }
  
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'tablet';
  }
  
  if (ua.includes('windows')) {
    return 'windows';
  }
  
  if (ua.includes('mac')) {
    return 'mac';
  }
  
  if (ua.includes('linux')) {
    return 'linux';
  }
  
  return 'desktop';
}

module.exports = router;
