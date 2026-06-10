/**
 * REQ-00061: 服务健康仪表板 API
 * 提供服务健康状态查询、拓扑可视化、自动恢复等接口
 */

const express = require('express');
const router = express.Router();
const HealthScorer = require('../../../shared/healthScorer');
const AutoRecovery = require('../../../shared/autoRecovery');
const { metrics } = require('../../../shared/metrics');
const logger = require('../../../shared/logger');

const healthScorer = new HealthScorer();
const autoRecovery = new AutoRecovery();

// 服务列表
const SERVICES = [
  'user-service',
  'location-service',
  'pokemon-service',
  'catch-service',
  'gym-service',
  'social-service',
  'reward-service',
  'payment-service',
  'gateway'
];

// 服务依赖拓扑
const SERVICE_TOPOLOGY = {
  nodes: [
    { id: 'gateway', label: 'Gateway', group: 'infrastructure' },
    { id: 'user-service', label: 'User Service', group: 'core' },
    { id: 'location-service', label: 'Location Service', group: 'core' },
    { id: 'pokemon-service', label: 'Pokemon Service', group: 'core' },
    { id: 'catch-service', label: 'Catch Service', group: 'core' },
    { id: 'gym-service', label: 'Gym Service', group: 'core' },
    { id: 'social-service', label: 'Social Service', group: 'core' },
    { id: 'reward-service', label: 'Reward Service', group: 'core' },
    { id: 'payment-service', label: 'Payment Service', group: 'core' },
    { id: 'postgres', label: 'PostgreSQL', group: 'data' },
    { id: 'redis', label: 'Redis', group: 'data' },
    { id: 'kafka', label: 'Kafka', group: 'data' }
  ],
  edges: [
    { from: 'gateway', to: 'user-service', traffic: 1000 },
    { from: 'gateway', to: 'location-service', traffic: 800 },
    { from: 'gateway', to: 'pokemon-service', traffic: 600 },
    { from: 'gateway', to: 'catch-service', traffic: 500 },
    { from: 'gateway', to: 'gym-service', traffic: 300 },
    { from: 'gateway', to: 'social-service', traffic: 200 },
    { from: 'gateway', to: 'reward-service', traffic: 400 },
    { from: 'gateway', to: 'payment-service', traffic: 100 },
    { from: 'user-service', to: 'postgres', traffic: 1000 },
    { from: 'location-service', to: 'postgres', traffic: 800 },
    { from: 'location-service', to: 'redis', traffic: 800 },
    { from: 'pokemon-service', to: 'postgres', traffic: 600 },
    { from: 'catch-service', to: 'postgres', traffic: 500 },
    { from: 'catch-service', to: 'kafka', traffic: 500 },
    { from: 'gym-service', to: 'postgres', traffic: 300 },
    { from: 'social-service', to: 'postgres', traffic: 200 },
    { from: 'reward-service', to: 'postgres', traffic: 400 },
    { from: 'reward-service', to: 'kafka', traffic: 400 },
    { from: 'payment-service', to: 'postgres', traffic: 100 }
  ]
};

/**
 * GET /api/health/services
 * 获取所有服务健康状态
 */
router.get('/services', async (req, res) => {
  try {
    const healthStatuses = await Promise.all(
      SERVICES.map(async (service) => {
        const metricsData = await fetchServiceMetrics(service);
        return healthScorer.calculateHealthScore(service, metricsData);
      })
    );

    // 计算整体健康度
    const overallHealth = calculateOverallHealth(healthStatuses);

    // 更新 Prometheus 指标
    for (const status of healthStatuses) {
      metrics.gauge('service_health_score', status.totalScore, { service: status.serviceName });
    }

    res.json({
      overall: overallHealth,
      services: healthStatuses,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取服务健康状态失败');
    res.status(500).json({ error: 'Failed to fetch health status', message: error.message });
  }
});

/**
 * GET /api/health/services/:serviceName
 * 获取单个服务健康详情
 */
router.get('/services/:serviceName', async (req, res) => {
  const { serviceName } = req.params;

  if (!SERVICES.includes(serviceName)) {
    return res.status(404).json({ error: 'Service not found', availableServices: SERVICES });
  }

  try {
    const metricsData = await fetchServiceMetrics(serviceName);
    const healthScore = healthScorer.calculateHealthScore(serviceName, metricsData);
    const history = healthScorer.getHistory(serviceName, 10);

    res.json({
      ...healthScore,
      history
    });
  } catch (error) {
    logger.error({
      serviceName,
      error: error.message
    }, '获取服务健康详情失败');
    res.status(500).json({ error: 'Failed to fetch service health details', message: error.message });
  }
});

/**
 * GET /api/health/topology
 * 获取服务依赖拓扑
 */
router.get('/topology', async (req, res) => {
  try {
    // 可以根据实时流量更新拓扑权重
    const topology = { ...SERVICE_TOPOLOGY };

    // 添加健康状态到节点
    for (const node of topology.nodes) {
      if (SERVICES.includes(node.id)) {
        const summary = healthScorer.getSummary();
        if (summary[node.id]) {
          node.health = summary[node.id];
        }
      }
    }

    res.json(topology);
  } catch (error) {
    logger.error({ error: error.message }, '获取服务拓扑失败');
    res.status(500).json({ error: 'Failed to fetch service topology', message: error.message });
  }
});

/**
 * POST /api/health/services/:serviceName/recover
 * 执行自动恢复（手动触发）
 */
router.post('/services/:serviceName/recover', async (req, res) => {
  const { serviceName } = req.params;
  const { type, dryRun } = req.body;

  if (!SERVICES.includes(serviceName)) {
    return res.status(404).json({ error: 'Service not found', availableServices: SERVICES });
  }

  try {
    const metricsData = await fetchServiceMetrics(serviceName);
    const healthScore = healthScorer.calculateHealthScore(serviceName, metricsData);

    // 确定恢复类型
    let recommendation;
    if (type) {
      recommendation = {
        type,
        priority: 'high',
        autoRecoverable: true
      };
    } else if (healthScore.recommendations.length > 0) {
      recommendation = healthScore.recommendations[0];
    } else {
      return res.json({
        serviceName,
        healthScore: healthScore.totalScore,
        status: healthScore.status,
        message: '服务健康，无需恢复'
      });
    }

    if (dryRun) {
      res.json({
        dryRun: true,
        serviceName,
        recommendation,
        healthScore: healthScore.totalScore,
        wouldExecute: recommendation.autoRecoverable
      });
      return;
    }

    const result = await autoRecovery.executeRecovery(serviceName, recommendation, healthScore);

    res.json({
      serviceName,
      recommendation,
      result,
      healthScore: healthScore.totalScore
    });
  } catch (error) {
    logger.error({
      serviceName,
      error: error.message
    }, '执行自动恢复失败');
    res.status(500).json({ error: 'Failed to execute recovery', message: error.message });
  }
});

/**
 * GET /api/health/services/:serviceName/recovery-history
 * 获取恢复历史
 */
router.get('/services/:serviceName/recovery-history', async (req, res) => {
  const { serviceName } = req.params;
  const { limit = 10 } = req.query;

  const history = autoRecovery.getRecoveryHistory(serviceName, parseInt(limit));

  res.json({
    serviceName,
    history,
    count: history.length
  });
});

/**
 * GET /api/health/recovery-history
 * 获取所有服务的恢复历史
 */
router.get('/recovery-history', async (req, res) => {
  const history = autoRecovery.getAllRecoveryHistory();

  res.json({
    history,
    services: Object.keys(history)
  });
});

/**
 * POST /api/health/services/:serviceName/clear-cooldown
 * 清除冷却期
 */
router.post('/services/:serviceName/clear-cooldown', async (req, res) => {
  const { serviceName } = req.params;

  autoRecovery.clearCooldown(serviceName);

  res.json({
    success: true,
    serviceName,
    message: '冷却期已清除'
  });
});

/**
 * GET /api/health/summary
 * 获取所有服务的健康摘要
 */
router.get('/summary', async (req, res) => {
  try {
    const summary = healthScorer.getSummary();

    // 计算统计数据
    const scores = Object.values(summary).map(s => s.score);
    const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    const statusCounts = {
      healthy: 0,
      warning: 0,
      degraded: 0,
      critical: 0
    };

    for (const s of Object.values(summary)) {
      statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    }

    res.json({
      summary,
      stats: {
        avgScore: Math.round(avgScore),
        totalServices: Object.keys(summary).length,
        ...statusCounts
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取健康摘要失败');
    res.status(500).json({ error: 'Failed to fetch summary', message: error.message });
  }
});

/**
 * GET /api/health/chaos/status
 * 获取故障演练状态
 */
router.get('/chaos/status', async (req, res) => {
  try {
    const chaosEnabled = process.env.CHAOS_MESH_ENABLED === 'true';
    const experiments = await getChaosExperiments();

    res.json({
      enabled: chaosEnabled,
      experiments,
      supportedTypes: [
        'network-delay',
        'network-loss',
        'cpu-stress',
        'memory-stress',
        'pod-kill',
        'io-latency'
      ]
    });
  } catch (error) {
    res.json({
      enabled: false,
      experiments: [],
      error: error.message
    });
  }
});

/**
 * POST /api/health/chaos/inject
 * 触发故障演练
 */
router.post('/chaos/inject', async (req, res) => {
  const { type, serviceName, duration = '5m', intensity = 'medium' } = req.body;

  if (!type || !serviceName) {
    return res.status(400).json({ error: 'Missing required fields: type, serviceName' });
  }

  try {
    const experiment = await injectChaos(type, serviceName, duration, intensity);

    logger.info({
      type,
      serviceName,
      duration,
      experimentName: experiment.name
    }, '故障演练注入成功');

    metrics.increment('chaos_experiment_injected_total', 1, {
      service: serviceName,
      type
    });

    res.json({
      success: true,
      experiment
    });
  } catch (error) {
    logger.error({
      type,
      serviceName,
      error: error.message
    }, '故障演练注入失败');
    res.status(500).json({ error: 'Failed to inject chaos', message: error.message });
  }
});

// === 辅助函数 ===

/**
 * 从 Prometheus 获取服务指标
 */
async function fetchServiceMetrics(serviceName) {
  // 实际实现应该调用 Prometheus API
  // 这里返回模拟数据用于演示
  const baseMetrics = {
    cpu: 30 + Math.random() * 40,
    memory: 40 + Math.random() * 30,
    errorRate: Math.random() * 0.05,
    responseTime: 50 + Math.random() * 200,
    connectionPool: 20 + Math.random() * 30,
    eventLag: Math.random() * 20
  };

  // 根据服务特性调整指标
  if (serviceName === 'gateway') {
    baseMetrics.cpu += 20;
    baseMetrics.responseTime += 50;
  } else if (serviceName === 'location-service') {
    baseMetrics.connectionPool += 20;
  } else if (serviceName === 'payment-service') {
    baseMetrics.errorRate *= 0.5; // 支付服务错误率更低
  }

  return baseMetrics;
}

/**
 * 计算整体健康度
 */
function calculateOverallHealth(healthStatuses) {
  const totalServices = healthStatuses.length;
  const healthyCount = healthStatuses.filter(s => s.status === 'healthy').length;
  const warningCount = healthStatuses.filter(s => s.status === 'warning').length;
  const degradedCount = healthStatuses.filter(s => s.status === 'degraded').length;
  const criticalCount = healthStatuses.filter(s => s.status === 'critical').length;

  const avgScore = healthStatuses.reduce((sum, s) => sum + s.totalScore, 0) / totalServices;

  let status = 'healthy';
  if (criticalCount > 0) status = 'critical';
  else if (degradedCount > 0) status = 'degraded';
  else if (warningCount > 0) status = 'warning';

  return {
    status,
    avgScore: Math.round(avgScore),
    breakdown: {
      healthy: healthyCount,
      warning: warningCount,
      degraded: degradedCount,
      critical: criticalCount,
      total: totalServices
    }
  };
}

/**
 * 获取 Chaos Mesh 实验
 */
async function getChaosExperiments() {
  // 实际应该查询 Chaos Mesh API
  return [];
}

/**
 * 注入故障
 */
async function injectChaos(type, serviceName, duration, intensity) {
  const experimentName = `${type}-${serviceName}-${Date.now()}`;

  // 实际应该调用 Chaos Mesh API 创建实验
  // 这里返回模拟结果
  const intensityMap = {
    low: 1,
    medium: 2,
    high: 3
  };

  return {
    name: experimentName,
    type,
    serviceName,
    duration,
    intensity: intensityMap[intensity] || 2,
    status: 'running',
    createdAt: new Date().toISOString(),
    simulated: true
  };
}

module.exports = router;
module.exports.healthScorer = healthScorer;
module.exports.autoRecovery = autoRecovery;
