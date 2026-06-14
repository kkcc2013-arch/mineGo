/**
 * 业务指标 API 路由
 * REQ-00094: 实时业务指标仪表板与运营监控系统
 */

const express = require('express');
const router = express.Router();
const { BusinessMetricsCollector } = require('../../../shared/businessMetrics');
const { authenticate, requireAdmin } = require('../../../../shared/middleware/auth');

// 业务指标采集器实例（需要在外部初始化并传入）
let metricsCollector = null;

/**
 * 初始化业务指标采集器
 */
function initBusinessMetrics(redis, db) {
  if (!metricsCollector) {
    metricsCollector = new BusinessMetricsCollector(redis, db);
  }
  return metricsCollector;
}

/**
 * GET /api/admin/metrics/realtime
 * 获取实时业务指标
 */
router.get('/realtime', authenticate, requireAdmin, async (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics collector not initialized' });
    }

    const metrics = await metricsCollector.getRealtimeMetrics();
    res.json(metrics);
  } catch (error) {
    console.error('Failed to get realtime metrics:', error);
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

/**
 * GET /api/admin/metrics/hourly
 * 获取小时级指标数据
 */
router.get('/hourly', authenticate, requireAdmin, async (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics collector not initialized' });
    }

    const { start, end } = req.query;
    const startDate = start ? new Date(start) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : new Date();

    const data = await metricsCollector.getHourlyMetrics(startDate, endDate);
    res.json({
      period: { start: startDate, end: endDate },
      data
    });
  } catch (error) {
    console.error('Failed to get hourly metrics:', error);
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

/**
 * GET /api/admin/metrics/daily
 * 获取日级指标数据
 */
router.get('/daily', authenticate, requireAdmin, async (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics collector not initialized' });
    }

    const { start, end } = req.query;
    const startDate = start ? new Date(start) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = end ? new Date(end) : new Date();

    const data = await metricsCollector.getDailyMetrics(startDate, endDate);
    res.json({
      period: { start: startDate, end: endDate },
      data
    });
  } catch (error) {
    console.error('Failed to get daily metrics:', error);
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

/**
 * GET /api/admin/metrics/geo
 * 获取地理分布数据
 */
router.get('/geo', authenticate, requireAdmin, async (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics collector not initialized' });
    }

    const distribution = await metricsCollector.getGeoDistribution();
    res.json({
      timestamp: new Date(),
      distribution
    });
  } catch (error) {
    console.error('Failed to get geo distribution:', error);
    res.status(500).json({ error: 'Failed to retrieve geo distribution' });
  }
});

/**
 * GET /api/admin/metrics/prometheus
 * 获取 Prometheus 格式的业务指标
 */
router.get('/prometheus', async (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics collector not initialized' });
    }

    const metrics = await metricsCollector.getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metrics);
  } catch (error) {
    console.error('Failed to get Prometheus metrics:', error);
    res.status(500).json({ error: 'Failed to retrieve metrics' });
  }
});

/**
 * POST /api/admin/metrics/event
 * 记录业务事件（供各微服务调用）
 */
router.post('/event', authenticate, async (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics collector not initialized' });
    }

    const { eventType, data } = req.body;

    switch (eventType) {
      case 'player_online':
        await metricsCollector.recordPlayerOnline(data.userId, data.region);
        break;
      
      case 'player_offline':
        await metricsCollector.recordPlayerOffline(data.userId, data.region);
        break;
      
      case 'pokemon_catch':
        await metricsCollector.recordPokemonCatch(
          data.userId,
          data.pokemonId,
          data.success,
          data.duration,
          data.region
        );
        break;
      
      case 'pokemon_spawn':
        metricsCollector.recordPokemonSpawn(data.pokemonId, data.region);
        break;
      
      case 'pokemon_evolve':
        metricsCollector.recordPokemonEvolve(data.pokemonId);
        break;
      
      case 'pokemon_trade':
        metricsCollector.recordPokemonTrade(data.region);
        break;
      
      case 'gym_battle':
        metricsCollector.recordGymBattle(data.gymId, data.result);
        break;
      
      case 'raid':
        metricsCollector.recordRaid(data.gymId, data.result);
        break;
      
      case 'friendship':
        metricsCollector.recordFriendship();
        break;
      
      case 'gift':
        metricsCollector.recordGift(data.giftType);
        break;
      
      case 'message':
        metricsCollector.recordMessage(data.messageType);
        break;
      
      case 'payment':
        await metricsCollector.recordPayment(
          data.userId,
          data.amount,
          data.currency,
          data.product
        );
        break;
      
      case 'refund':
        metricsCollector.recordRefund(data.reason);
        break;
      
      default:
        return res.status(400).json({ error: `Unknown event type: ${eventType}` });
    }

    res.json({ success: true, eventType });
  } catch (error) {
    console.error('Failed to record metric event:', error);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

/**
 * GET /api/admin/metrics/summary
 * 获取业务指标摘要（适用于仪表板概览）
 */
router.get('/summary', authenticate, requireAdmin, async (req, res) => {
  try {
    if (!metricsCollector) {
      return res.status(503).json({ error: 'Metrics collector not initialized' });
    }

    const realtime = await metricsCollector.getRealtimeMetrics();
    
    // 获取趋势数据（对比昨日）
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayStart = new Date(yesterday);
    yesterdayStart.setHours(0, 0, 0, 0);
    const yesterdayEnd = new Date(yesterday);
    yesterdayEnd.setHours(23, 59, 59, 999);
    
    const yesterdayMetrics = await metricsCollector.getDailyMetrics(yesterdayStart, yesterdayEnd);
    const yesterdayData = yesterdayMetrics[0] || {};

    res.json({
      current: realtime,
      trends: {
        players: {
          dauTrend: yesterdayData.dau 
            ? ((realtime.players.dau - yesterdayData.dau) / yesterdayData.dau * 100).toFixed(2) + '%'
            : 'N/A',
          revenueTrend: yesterdayData.revenue 
            ? ((realtime.payment.revenue - yesterdayData.revenue) / yesterdayData.revenue * 100).toFixed(2) + '%'
            : 'N/A'
        }
      },
      alerts: [] // TODO: 集成告警系统
    });
  } catch (error) {
    console.error('Failed to get metrics summary:', error);
    res.status(500).json({ error: 'Failed to retrieve summary' });
  }
});

module.exports = {
  router,
  initBusinessMetrics
};
