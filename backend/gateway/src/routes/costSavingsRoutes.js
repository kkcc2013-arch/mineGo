/**
 * 成本节省仪表板 API
 * REQ-00161: 低峰期服务自动休眠与智能唤醒系统
 */

const express = require('express');
const router = express.Router();
const SleepManager = require('../../shared/SleepManager');
const TrafficAnalyzer = require('../../shared/TrafficAnalyzer');
const logger = require('../../shared/logger');

// 单例实例
let sleepManager = null;
let trafficAnalyzer = null;

function getSleepManager() {
  if (!sleepManager) {
    sleepManager = new SleepManager();
  }
  return sleepManager;
}

function getTrafficAnalyzer() {
  if (!trafficAnalyzer) {
    trafficAnalyzer = new TrafficAnalyzer();
  }
  return trafficAnalyzer;
}

/**
 * GET /api/cost-savings/summary
 * 获取成本节省统计摘要
 */
router.get('/summary', async (req, res) => {
  try {
    const manager = getSleepManager();
    const savings = await manager.calculateCostSavings();
    const totalSavings = savings.reduce((sum, s) => sum + parseFloat(s.estimatedSavings), 0);

    res.json({
      success: true,
      data: {
        totalEstimatedSavings: totalSavings.toFixed(2),
        currency: 'USD',
        period: 'last_24h',
        breakdown: savings,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get cost savings summary', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cost-savings/history/:serviceName
 * 获取服务休眠历史
 */
router.get('/history/:serviceName', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const manager = getSleepManager();
    const history = await manager.getServiceSleepHistory(serviceName);

    res.json({
      success: true,
      data: {
        service: serviceName,
        history,
        count: history.length
      }
    });
  } catch (error) {
    logger.error('Failed to get service sleep history', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cost-savings/traffic-analysis
 * 获取流量分析数据
 */
router.get('/traffic-analysis', async (req, res) => {
  try {
    const analyzer = getTrafficAnalyzer();
    const hourlyStats = analyzer.getHourlyStats();

    // 转换为可序列化格式
    const serializedStats = {};
    for (const [hour, stats] of Object.entries(hourlyStats)) {
      serializedStats[hour] = {
        ...stats,
        services: Object.fromEntries(stats.services || new Map())
      };
    }

    const peakHours = await analyzer.predictPeakHours();

    res.json({
      success: true,
      data: {
        hourlyStats: serializedStats,
        peakHours,
        timezone: process.env.TIMEZONE || 'UTC'
      }
    });
  } catch (error) {
    logger.error('Failed to get traffic analysis', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cost-savings/service-traffic/:serviceName
 * 获取服务流量历史
 */
router.get('/service-traffic/:serviceName', async (req, res) => {
  try {
    const { serviceName } = req.params;
    const hours = parseInt(req.query.hours) || 24;

    const analyzer = getTrafficAnalyzer();
    const history = await analyzer.getServiceTrafficHistory(serviceName, hours);

    res.json({
      success: true,
      data: {
        service: serviceName,
        history,
        hours
      }
    });
  } catch (error) {
    logger.error('Failed to get service traffic history', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cost-savings/sleeping-services
 * 获取当前休眠的服务列表
 */
router.get('/sleeping-services', async (req, res) => {
  try {
    const manager = getSleepManager();
    const sleeping = await manager.getSleepingServices();

    res.json({
      success: true,
      data: {
        sleepingServices: sleeping,
        count: sleeping.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get sleeping services', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/cost-savings/control
 * 手动触发休眠/唤醒（管理员权限）
 */
router.post('/control', async (req, res) => {
  try {
    // 权限检查
    if (!req.user?.roles?.includes('admin')) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const { service, action, replicas } = req.body;

    // 参数验证
    if (!service || !action || replicas === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: service, action, replicas'
      });
    }

    if (!['sleep', 'wake'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Must be "sleep" or "wake"'
      });
    }

    const manager = getSleepManager();
    const result = await manager.manualControl(
      service,
      action,
      parseInt(replicas),
      req.user.email || req.user.id || 'unknown'
    );

    res.json({
      success: true,
      data: result,
      message: `${service} ${action} triggered successfully`
    });

  } catch (error) {
    logger.error('Failed to execute manual control', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cost-savings/status
 * 获取系统整体状态
 */
router.get('/status', async (req, res) => {
  try {
    const manager = getSleepManager();
    const analyzer = getTrafficAnalyzer();

    const sleepingServices = await manager.getSleepingServices();
    const totalSavings = await manager.getTotalCostSavings();

    res.json({
      success: true,
      data: {
        sleepingServices,
        sleepingCount: sleepingServices.length,
        totalCostSavings: totalSavings.toFixed(2),
        currency: 'USD',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Failed to get status', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
