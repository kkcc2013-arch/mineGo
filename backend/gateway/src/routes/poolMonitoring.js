/**
 * 连接池监控指标 API 端点
 * REQ-00623: 数据库连接池智能预热与动态自适应管理系统
 */

const express = require('express');
const router = express.Router();
const { getIntelligentPoolManager } = require('../../jobs/intelligentPoolManager');
const { getPoolConfigCenter } = require('../../shared/poolConfigCenter');
const { createLogger } = require('../../shared/logger');
const { successResp, AppError } = require('../../shared/auth');

const logger = createLogger('pool-monitoring-api');

/**
 * GET /api/v1/pools/status - 获取所有连接池状态
 */
router.get('/api/v1/pools/status', async (req, res, next) => {
  try {
    const poolManager = getIntelligentPoolManager();
    const configCenter = getPoolConfigCenter();

    const status = poolManager.getStatus();
    const configStatus = configCenter.getAllStatus();

    res.json(successResp({
      ...status,
      configCenter: configStatus,
      recommendations: poolManager.getOptimizationRecommendations()
    }));
  } catch (error) {
    logger.error('Failed to get pool status', { error: error.message });
    next(new AppError(500, 'Failed to get pool status', error.message));
  }
});

/**
 * GET /api/v1/pools/:service/status - 获取单个服务的连接池状态
 */
router.get('/api/v1/pools/:service/status', async (req, res, next) => {
  const { service } = req.params;

  try {
    const poolManager = getIntelligentPoolManager();
    const configCenter = getPoolConfigCenter();

    const allStatus = poolManager.getStatus();
    const serviceState = allStatus.poolStates[service];

    if (!serviceState) {
      return next(new AppError(404, 'Service not found', `No pool state found for service: ${service}`));
    }

    const config = configCenter.getConfig(service);

    res.json(successResp({
      service,
      state: serviceState,
      config,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Failed to get service pool status', { service, error: error.message });
    next(new AppError(500, 'Failed to get service pool status', error.message));
  }
});

/**
 * POST /api/v1/pools/preheat - 手动触发预热
 */
router.post('/api/v1/pools/preheat', async (req, res, next) => {
  const { expectedTraffic = 'high' } = req.body;

  try {
    const poolManager = getIntelligentPoolManager();

    logger.info('Manual preheat triggered', { expectedTraffic });

    const results = await poolManager.forcePreheat(expectedTraffic);

    res.json(successResp({
      message: 'Preheat completed',
      expectedTraffic,
      results,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Failed to preheat pools', { error: error.message });
    next(new AppError(500, 'Failed to preheat pools', error.message));
  }
});

/**
 * PUT /api/v1/pools/:service/config - 更新单个服务的连接池配置
 */
router.put('/api/v1/pools/:service/config', async (req, res, next) => {
  const { service } = req.params;
  const updates = req.body;

  try {
    const configCenter = getPoolConfigCenter();

    // 验证更新参数
    if (updates.maxSize && (updates.maxSize < 2 || updates.maxSize > 30)) {
      return next(new AppError(400, 'Invalid maxSize', 'maxSize must be between 2 and 30'));
    }

    if (updates.minSize && (updates.minSize < 1 || updates.minSize > updates.maxSize)) {
      return next(new AppError(400, 'Invalid minSize', 'minSize must be between 1 and maxSize'));
    }

    configCenter.updateConfigs({ [service]: updates });

    const newConfig = configCenter.getConfig(service);

    logger.info('Pool config updated via API', { service, updates });

    res.json(successResp({
      service,
      message: 'Pool config updated',
      newConfig,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Failed to update pool config', { service, error: error.message });
    next(new AppError(500, 'Failed to update pool config', error.message));
  }
});

/**
 * GET /api/v1/pools/recommendations - 获取优化建议
 */
router.get('/api/v1/pools/recommendations', async (req, res, next) => {
  try {
    const poolManager = getIntelligentPoolManager();

    const recommendations = poolManager.getOptimizationRecommendations();

    res.json(successResp({
      recommendations,
      count: recommendations.length,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Failed to get recommendations', { error: error.message });
    next(new AppError(500, 'Failed to get recommendations', error.message));
  }
});

/**
 * GET /api/v1/pools/metrics/history - 获取历史指标数据
 */
router.get('/api/v1/pools/metrics/history', async (req, res, next) => {
  const { service, hours = 1 } = req.query;

  try {
    // 从数据库查询历史数据
    const { PoolUsageHistory } = require('../../shared/models');
    
    const whereClause = {
      timestamp: {
        [Op.gte]: new Date(Date.now() - hours * 3600000)
      }
    };

    if (service) {
      whereClause.service_name = service;
    }

    const history = await PoolUsageHistory.findAll({
      where: whereClause,
      order: [['timestamp', 'DESC']],
      limit: 100
    });

    res.json(successResp({
      history,
      count: history.length,
      hours,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Failed to get metrics history', { error: error.message });
    next(new AppError(500, 'Failed to get metrics history', error.message));
  }
});

/**
 * GET /api/v1/pools/health - 健康检查
 */
router.get('/api/v1/pools/health', async (req, res, next) => {
  try {
    const poolManager = getIntelligentPoolManager();

    const status = poolManager.getStatus();
    const recommendations = poolManager.getOptimizationRecommendations();

    // 判断健康状态
    let healthStatus = 'healthy';
    const issues = [];

    if (recommendations.length > 0) {
      healthStatus = 'warning';
      issues.push(...recommendations.map(r => `${r.service}: ${r.reason}`));
    }

    // 检查是否有服务数据不足
    const servicesWithoutData = manager.services.filter(
      service => !status.poolStates[service] || status.poolStates[service].dataPoints < 5
    );

    if (servicesWithoutData.length > 0) {
      healthStatus = 'warning';
      issues.push(`Services with insufficient data: ${servicesWithoutData.join(', ')}`);
    }

    res.json(successResp({
      status: healthStatus,
      issues,
      recommendations: recommendations.length,
      servicesWithData: Object.keys(status.poolStates).length,
      timestamp: new Date().toISOString()
    }));
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    next(new AppError(500, 'Health check failed', error.message));
  }
});

module.exports = router;
