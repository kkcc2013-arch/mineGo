/**
 * backend/gateway/src/routes/businessEvents.js
 * 业务事件查询 API
 * 
 * @module routes/businessEvents
 * @description 提供事件查询、统计、热力图等 API
 */

const express = require('express');
const router = express.Router();
const { createLogger } = require('../../../shared/logger');
const { successResp, errorResp } = require('../../../shared/response');
const { requireAuth, requireAdmin } = require('../../../shared/auth');

const logger = createLogger('business-events-routes');

// ClickHouse 客户端（如果可用）
let clickhouse = null;
try {
  const { ClickHouse } = require('@clickhouse/client');
  clickhouse = new ClickHouse({
    host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
    database: 'minego_events'
  });
} catch (err) {
  logger.warn('ClickHouse client not available, using fallback');
}

// Redis 客户端
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

/**
 * @route   GET /api/events
 * @desc    查询业务事件
 * @query   type - 事件类型（可选）
 * @query   category - 事件类别（可选）
 * @query   userId - 用户 ID（可选）
 * @query   startTime - 开始时间（ISO 8601）
 * @query   endTime - 结束时间（ISO 8601）
 * @query   limit - 返回数量（默认 100）
 * @query   offset - 偏移量（默认 0）
 * @access  Admin
 */
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const {
      type,
      category,
      userId,
      startTime,
      endTime,
      limit = 100,
      offset = 0
    } = req.query;
    
    // 如果 ClickHouse 可用，使用 ClickHouse 查询
    if (clickhouse) {
      let sql = 'SELECT * FROM minego_events.business_events WHERE 1=1';
      const params = [];
      
      if (type) {
        sql += ` AND type = {type:String}`;
        params.push({ type });
      }
      if (category) {
        sql += ` AND category = {category:String}`;
        params.push({ category });
      }
      if (userId) {
        sql += ` AND user_id = {userId:String}`;
        params.push({ userId });
      }
      if (startTime) {
        sql += ` AND timestamp >= {startTime:DateTime64(3)}`;
        params.push({ startTime });
      }
      if (endTime) {
        sql += ` AND timestamp <= {endTime:DateTime64(3)}`;
        params.push({ endTime });
      }
      
      sql += ` ORDER BY timestamp DESC LIMIT {limit:UInt32} OFFSET {offset:UInt32}`;
      params.push({ limit: parseInt(limit), offset: parseInt(offset) });
      
      const result = await clickhouse.query({
        query: sql,
        query_params: Object.assign({}, ...params)
      }).toPromise();
      
      const events = result.map(row => ({
        id: row.id,
        type: row.type,
        category: row.category,
        timestamp: row.timestamp,
        userId: row.user_id,
        deviceId: row.device_id,
        location: row.location_lat && row.location_lng
          ? { lat: row.location_lat, lng: row.location_lng }
          : null,
        payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
        context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context
      }));
      
      res.json(successResp({ events, total: events.length }));
    } else {
      // Fallback: 从 Redis 获取最近事件
      const eventKeys = await redis.keys('events:recent:*');
      const events = [];
      
      for (const key of eventKeys.slice(0, parseInt(limit))) {
        const data = await redis.get(key);
        if (data) {
          events.push(JSON.parse(data));
        }
      }
      
      res.json(successResp({ events, total: events.length }));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to query events');
    next(err);
  }
});

/**
 * @route   GET /api/events/stats
 * @desc    获取事件统计（按类别/类型分组）
 * @query   interval - 时间间隔（hour/day）
 * @query   startTime - 开始时间
 * @query   endTime - 结束时间
 * @query   category - 事件类别（可选）
 * @access  Admin
 */
router.get('/stats', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { interval = 'hour', startTime, endTime, category } = req.query;
    
    if (clickhouse) {
      const table = interval === 'day' ? 'events_daily' : 'events_hourly';
      const timeField = interval === 'day' ? 'day' : 'hour';
      
      let sql = `
        SELECT 
          category,
          type,
          ${timeField} as time,
          sum(event_count) as count,
          sum(unique_users) as users
        FROM minego_events.${table}
        WHERE ${timeField} BETWEEN {startTime:DateTime} AND {endTime:DateTime}
      `;
      
      const params = { startTime, endTime };
      
      if (category) {
        sql += ` AND category = {category:String}`;
        params.category = category;
      }
      
      sql += `
        GROUP BY category, type, time
        ORDER BY time DESC
      `;
      
      const result = await clickhouse.query({
        query: sql,
        query_params: params
      }).toPromise();
      
      res.json(successResp({ stats: result }));
    } else {
      // Fallback: 从 Redis 获取统计
      const now = Date.now();
      const stats = [];
      
      // 获取各类别事件计数
      const categories = ['user', 'catch', 'gym', 'trade', 'payment', 'social', 'item', 'pvp'];
      
      for (const cat of categories) {
        if (category && category !== cat) continue;
        
        const count = await redis.get(`events:category:${cat}:24h`) || 0;
        stats.push({
          category: cat,
          count: parseInt(count),
          time: new Date(now).toISOString()
        });
      }
      
      res.json(successResp({ stats }));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get event stats');
    next(err);
  }
});

/**
 * @route   GET /api/events/heatmap
 * @desc    获取事件地理热力图数据
 * @query   eventType - 事件类型（可选）
 * @query   startTime - 开始时间
 * @query   endTime - 结束时间
 * @query   precision - 经纬度精度（默认 2）
 * @access  Admin
 */
router.get('/heatmap', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const {
      eventType,
      startTime,
      endTime,
      precision = 2
    } = req.query;
    
    if (clickhouse) {
      let sql = `
        SELECT 
          round(location_lat, ${parseInt(precision)}) as lat,
          round(location_lng, ${parseInt(precision)}) as lng,
          count() as count
        FROM minego_events.business_events
        WHERE timestamp BETWEEN {startTime:DateTime} AND {endTime:DateTime}
          AND location_lat IS NOT NULL
          AND location_lng IS NOT NULL
      `;
      
      const params = { startTime, endTime };
      
      if (eventType) {
        sql += ` AND type = {eventType:String}`;
        params.eventType = eventType;
      }
      
      sql += `
        GROUP BY lat, lng
        ORDER BY count DESC
        LIMIT 10000
      `;
      
      const result = await clickhouse.query({
        query: sql,
        query_params: params
      }).toPromise();
      
      const heatmap = result.map(row => ({
        lat: row.lat,
        lng: row.lng,
        weight: row.count
      }));
      
      res.json(successResp({ heatmap }));
    } else {
      // Fallback: 返回空热力图
      res.json(successResp({ heatmap: [] }));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get heatmap');
    next(err);
  }
});

/**
 * @route   GET /api/events/timeline
 * @desc    获取事件时间线（按时间分组）
 * @query   eventType - 事件类型
 * @query   interval - 时间间隔（minute/hour/day）
 * @query   startTime - 开始时间
 * @query   endTime - 结束时间
 * @access  Admin
 */
router.get('/timeline', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const {
      eventType,
      interval = 'hour',
      startTime,
      endTime
    } = req.query;
    
    if (clickhouse) {
      const intervalFunc = {
        minute: 'toStartOfMinute',
        hour: 'toStartOfHour',
        day: 'toDate'
      }[interval] || 'toStartOfHour';
      
      let sql = `
        SELECT 
          ${intervalFunc}(timestamp) as time,
          count() as count,
          uniq(user_id) as unique_users
        FROM minego_events.business_events
        WHERE timestamp BETWEEN {startTime:DateTime} AND {endTime:DateTime}
      `;
      
      const params = { startTime, endTime };
      
      if (eventType) {
        sql += ` AND type = {eventType:String}`;
        params.eventType = eventType;
      }
      
      sql += `
        GROUP BY time
        ORDER BY time ASC
      `;
      
      const result = await clickhouse.query({
        query: sql,
        query_params: params
      }).toPromise();
      
      res.json(successResp({ timeline: result }));
    } else {
      // Fallback: 从 Redis 生成时间线
      const timeline = [];
      const start = new Date(startTime).getTime();
      const end = new Date(endTime).getTime();
      const intervalMs = interval === 'day' ? 86400000 : interval === 'hour' ? 3600000 : 60000;
      
      for (let t = start; t <= end; t += intervalMs) {
        const key = `events:${eventType || 'all'}:${Math.floor(t / intervalMs)}`;
        const count = await redis.get(key) || 0;
        
        timeline.push({
          time: new Date(t).toISOString(),
          count: parseInt(count),
          unique_users: 0
        });
      }
      
      res.json(successResp({ timeline }));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get timeline');
    next(err);
  }
});

/**
 * @route   GET /api/events/top
 * @desc    获取热门事件类型排行
 * @query   startTime - 开始时间
 * @query   endTime - 结束时间
 * @query   limit - 返回数量（默认 20）
 * @access  Admin
 */
router.get('/top', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { startTime, endTime, limit = 20 } = req.query;
    
    if (clickhouse) {
      const sql = `
        SELECT 
          type,
          category,
          count() as count,
          uniq(user_id) as unique_users
        FROM minego_events.business_events
        WHERE timestamp BETWEEN {startTime:DateTime} AND {endTime:DateTime}
        GROUP BY type, category
        ORDER BY count DESC
        LIMIT {limit:UInt32}
      `;
      
      const result = await clickhouse.query({
        query: sql,
        query_params: { startTime, endTime, limit: parseInt(limit) }
      }).toPromise();
      
      res.json(successResp({ top: result }));
    } else {
      // Fallback: 从 Redis 获取
      const top = [];
      const eventTypes = await redis.keys('events:*:24h');
      
      for (const key of eventTypes) {
        const count = await redis.get(key);
        if (count) {
          const type = key.replace('events:', '').replace(':24h', '');
          top.push({ type, count: parseInt(count), unique_users: 0 });
        }
      }
      
      top.sort((a, b) => b.count - a.count);
      res.json(successResp({ top: top.slice(0, parseInt(limit)) }));
    }
  } catch (err) {
    logger.error({ err }, 'Failed to get top events');
    next(err);
  }
});

/**
 * @route   GET /api/events/realtime
 * @desc    获取实时业务指标
 * @access  Admin
 */
router.get('/realtime', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    // 从 Redis 获取实时指标
    const [
      activeUsers,
      catchAttempts,
      catchSuccesses,
      tradeComplete,
      paymentSuccess
    ] = await Promise.all([
      redis.pfcount('active_users:5min'),
      redis.get('events:catch.attempt:1h'),
      redis.get('events:catch.success:1h'),
      redis.get('events:trade.complete:1h'),
      redis.get('events:payment.order_success:1h')
    ]);
    
    const realtime = {
      activeUsers,
      catchSuccessRate: catchAttempts > 0
        ? (catchSuccesses || 0) / catchAttempts
        : 0,
      tradeVolume: tradeComplete || 0,
      paymentSuccess: paymentSuccess || 0,
      timestamp: new Date().toISOString()
    };
    
    res.json(successResp({ realtime }));
  } catch (err) {
    logger.error({ err }, 'Failed to get realtime metrics');
    next(err);
  }
});

module.exports = router;
