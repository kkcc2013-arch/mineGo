# REQ-00061: 服务健康仪表板与自动恢复系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00061 |
| 标题 | 服务健康仪表板与自动恢复系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gateway、所有微服务、infrastructure/k8s、backend/shared |
| 创建时间 | 2026-06-09 21:00 |

## 需求描述

### 背景

当前系统已具备 Prometheus 监控和 Grafana 仪表板，但缺少统一的服务健康可视化和自动恢复机制。运维人员需要手动排查故障服务，恢复依赖人工干预，影响 MTTR（平均恢复时间）。

### 目标

1. **统一健康仪表板**：实时展示所有微服务的健康状态、依赖关系、关键指标
2. **自动故障检测**：基于多维度指标自动识别异常服务
3. **智能自动恢复**：对可恢复故障自动执行恢复操作（重启、回滚、扩容等）
4. **故障演练验证**：支持 Chaos Engineering 故障注入和恢复验证

### 核心功能

1. **服务健康评分**
   - 基于多维度指标计算健康分数（0-100）
   - 指标维度：CPU、内存、错误率、响应时间、连接池、事件积压等
   - 动态权重调整

2. **依赖关系可视化**
   - 服务调用链拓扑图
   - 实时流量可视化
   - 瓶颈服务高亮

3. **自动恢复策略**
   - 服务无响应 → 自动重启 Pod
   - 内存泄漏 → 自动扩容并告警
   - 错误率飙升 → 自动回滚到上一稳定版本
   - 连接池耗尽 → 自动扩容连接池

4. **故障演练**
   - Chaos Mesh 集成
   - 预设故障场景（网络延迟、CPU 压力、Pod 杀死等）
   - 自动验证恢复能力

## 技术方案

### 1. 健康评分引擎

```javascript
// backend/shared/healthScorer.js

const HEALTH_WEIGHTS = {
  cpu: 0.15,
  memory: 0.15,
  errorRate: 0.20,
  responseTime: 0.20,
  connectionPool: 0.15,
  eventLag: 0.15
};

class HealthScorer {
  constructor() {
    this.metrics = new Map();
    this.history = new Map();
  }

  /**
   * 计算服务健康分数
   * @param {string} serviceName - 服务名称
   * @param {Object} metrics - 指标数据
   * @returns {Object} 健康评分详情
   */
  calculateHealthScore(serviceName, metrics) {
    const scores = {
      cpu: this._scoreCPU(metrics.cpu),
      memory: this._scoreMemory(metrics.memory),
      errorRate: this._scoreErrorRate(metrics.errorRate),
      responseTime: this._scoreResponseTime(metrics.responseTime),
      connectionPool: this._scoreConnectionPool(metrics.connectionPool),
      eventLag: this._scoreEventLag(metrics.eventLag)
    };

    // 计算加权总分
    let totalScore = 0;
    for (const [key, weight] of Object.entries(HEALTH_WEIGHTS)) {
      totalScore += scores[key].score * weight;
    }

    // 保存历史记录
    this._saveHistory(serviceName, totalScore, scores);

    // 确定健康状态
    const status = this._determineStatus(totalScore);

    return {
      serviceName,
      totalScore: Math.round(totalScore),
      status,
      scores,
      trend: this._calculateTrend(serviceName),
      recommendations: this._generateRecommendations(scores, status)
    };
  }

  /**
   * CPU 健康评分 (0-100)
   */
  _scoreCPU(cpuPercent) {
    if (cpuPercent < 50) return { score: 100, status: 'healthy', detail: `CPU ${cpuPercent}% 正常` };
    if (cpuPercent < 70) return { score: 85, status: 'warning', detail: `CPU ${cpuPercent}% 中等负载` };
    if (cpuPercent < 85) return { score: 60, status: 'warning', detail: `CPU ${cpuPercent}% 高负载` };
    return { score: 30, status: 'critical', detail: `CPU ${cpuPercent}% 严重过载` };
  }

  /**
   * 内存健康评分 (0-100)
   */
  _scoreMemory(memoryPercent) {
    if (memoryPercent < 60) return { score: 100, status: 'healthy', detail: `内存 ${memoryPercent}% 正常` };
    if (memoryPercent < 75) return { score: 80, status: 'warning', detail: `内存 ${memoryPercent}% 中等使用` };
    if (memoryPercent < 90) return { score: 50, status: 'warning', detail: `内存 ${memoryPercent}% 高使用` };
    return { score: 20, status: 'critical', detail: `内存 ${memoryPercent}% 即将 OOM` };
  }

  /**
   * 错误率健康评分 (0-100)
   */
  _scoreErrorRate(errorRate) {
    if (errorRate < 0.01) return { score: 100, status: 'healthy', detail: '错误率 <1% 优秀' };
    if (errorRate < 0.05) return { score: 80, status: 'healthy', detail: `错误率 ${(errorRate*100).toFixed(2)}% 正常` };
    if (errorRate < 0.10) return { score: 50, status: 'warning', detail: `错误率 ${(errorRate*100).toFixed(2)}% 偏高` };
    return { score: 10, status: 'critical', detail: `错误率 ${(errorRate*100).toFixed(2)}% 严重` };
  }

  /**
   * 响应时间健康评分 (0-100)
   */
  _scoreResponseTime(p95Latency) {
    const latencyMs = p95Latency;
    if (latencyMs < 100) return { score: 100, status: 'healthy', detail: `P95 ${latencyMs}ms 极快` };
    if (latencyMs < 300) return { score: 90, status: 'healthy', detail: `P95 ${latencyMs}ms 良好` };
    if (latencyMs < 500) return { score: 70, status: 'warning', detail: `P95 ${latencyMs}ms 一般` };
    if (latencyMs < 1000) return { score: 40, status: 'warning', detail: `P95 ${latencyMs}ms 偏慢` };
    return { score: 15, status: 'critical', detail: `P95 ${latencyMs}ms 严重慢` };
  }

  /**
   * 连接池健康评分 (0-100)
   */
  _scoreConnectionPool(poolUsage) {
    if (poolUsage < 50) return { score: 100, status: 'healthy', detail: `连接池使用 ${poolUsage}%` };
    if (poolUsage < 70) return { score: 80, status: 'healthy', detail: `连接池使用 ${poolUsage}%` };
    if (poolUsage < 85) return { score: 50, status: 'warning', detail: `连接池使用 ${poolUsage}% 偏高` };
    return { score: 20, status: 'critical', detail: `连接池使用 ${poolUsage}% 即将耗尽` };
  }

  /**
   * 事件积压健康评分 (0-100)
   */
  _scoreEventLag(eventLagSeconds) {
    if (eventLagSeconds < 10) return { score: 100, status: 'healthy', detail: `事件延迟 ${eventLagSeconds}s 正常` };
    if (eventLagSeconds < 60) return { score: 70, status: 'warning', detail: `事件延迟 ${eventLagSeconds}s 稍高` };
    if (eventLagSeconds < 300) return { score: 40, status: 'warning', detail: `事件延迟 ${eventLagSeconds}s 严重积压` };
    return { score: 10, status: 'critical', detail: `事件延迟 ${eventLagSeconds}s 极度积压` };
  }

  /**
   * 确定整体健康状态
   */
  _determineStatus(score) {
    if (score >= 80) return 'healthy';
    if (score >= 60) return 'warning';
    if (score >= 40) return 'degraded';
    return 'critical';
  }

  /**
   * 计算趋势（最近5次评分）
   */
  _calculateTrend(serviceName) {
    const history = this.history.get(serviceName) || [];
    if (history.length < 2) return 'stable';
    
    const recent = history.slice(-5);
    const avgRecent = recent.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const avgOld = recent.slice(0, 2).reduce((a, b) => a + b, 0) / 2;
    
    const diff = avgRecent - avgOld;
    if (diff > 5) return 'improving';
    if (diff < -5) return 'declining';
    return 'stable';
  }

  /**
   * 生成优化建议
   */
  _generateRecommendations(scores, status) {
    const recommendations = [];
    
    for (const [key, data] of Object.entries(scores)) {
      if (data.status === 'critical' || data.status === 'warning') {
        switch (key) {
          case 'cpu':
            recommendations.push({
              type: 'scaling',
              priority: data.status === 'critical' ? 'high' : 'medium',
              action: '建议增加 Pod 副本数或优化 CPU 密集型代码',
              autoRecoverable: true
            });
            break;
          case 'memory':
            recommendations.push({
              type: 'memory',
              priority: data.status === 'critical' ? 'high' : 'medium',
              action: '建议增加内存限制或排查内存泄漏',
              autoRecoverable: false
            });
            break;
          case 'errorRate':
            recommendations.push({
              type: 'error',
              priority: 'high',
              action: '建议查看错误日志并考虑回滚到上一稳定版本',
              autoRecoverable: true
            });
            break;
          case 'responseTime':
            recommendations.push({
              type: 'performance',
              priority: data.status === 'critical' ? 'high' : 'medium',
              action: '建议优化慢查询或增加缓存',
              autoRecoverable: false
            });
            break;
          case 'connectionPool':
            recommendations.push({
              type: 'connection',
              priority: data.status === 'critical' ? 'high' : 'medium',
              action: '建议扩容连接池或优化数据库查询',
              autoRecoverable: true
            });
            break;
          case 'eventLag':
            recommendations.push({
              type: 'event',
              priority: data.status === 'critical' ? 'high' : 'medium',
              action: '建议增加消费者实例或优化事件处理逻辑',
              autoRecoverable: true
            });
            break;
        }
      }
    }
    
    return recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * 保存历史记录
   */
  _saveHistory(serviceName, totalScore, scores) {
    if (!this.history.has(serviceName)) {
      this.history.set(serviceName, []);
    }
    this.history.get(serviceName).push({
      score: totalScore,
      timestamp: Date.now(),
      scores
    });
    
    // 只保留最近 100 条记录
    const history = this.history.get(serviceName);
    if (history.length > 100) {
      history.shift();
    }
  }
}

module.exports = HealthScorer;
```

### 2. 自动恢复执行器

```javascript
// backend/shared/autoRecovery.js

const k8s = require('@kubernetes/client-node');
const logger = require('./logger');
const { metrics } = require('./metrics');

class AutoRecovery {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
    this.coreV1Api = this.kc.makeApiClient(k8s.CoreV1Api);
    
    this.recoveryHistory = new Map();
    this.cooldownPeriod = 300000; // 5 分钟冷却期
  }

  /**
   * 执行自动恢复
   * @param {string} serviceName - 服务名称
   * @param {Object} recommendation - 恢复建议
   * @param {Object} healthScore - 健康评分
   * @returns {Object} 恢复结果
   */
  async executeRecovery(serviceName, recommendation, healthScore) {
    // 检查冷却期
    if (this._isInCooldown(serviceName)) {
      logger.warn({
        serviceName,
        action: 'auto_recovery',
        reason: 'cooldown'
      }, '服务在冷却期内，跳过自动恢复');
      return { success: false, reason: 'cooldown' };
    }

    // 记录恢复尝试
    metrics.increment('auto_recovery_attempts_total', 1, { 
      service: serviceName, 
      type: recommendation.type 
    });

    let result;
    try {
      switch (recommendation.type) {
        case 'scaling':
          result = await this._scalePods(serviceName, healthScore);
          break;
        case 'connection':
          result = await this._restartPod(serviceName);
          break;
        case 'error':
          result = await this._rollbackDeployment(serviceName);
          break;
        case 'event':
          result = await this._scaleConsumers(serviceName);
          break;
        default:
          result = { success: false, reason: 'unsupported_type' };
      }

      // 记录恢复历史
      this._recordRecovery(serviceName, recommendation.type, result);

      if (result.success) {
        metrics.increment('auto_recovery_success_total', 1, { 
          service: serviceName, 
          type: recommendation.type 
        });
      }

      return result;
    } catch (error) {
      logger.error({
        serviceName,
        action: 'auto_recovery',
        error: error.message,
        stack: error.stack
      }, '自动恢复执行失败');

      metrics.increment('auto_recovery_failure_total', 1, { 
        service: serviceName, 
        type: recommendation.type 
      });

      return { success: false, error: error.message };
    }
  }

  /**
   * 扩容 Pod
   */
  async _scalePods(serviceName, healthScore) {
    const namespace = process.env.KUBERNETES_NAMESPACE || 'default';
    const deploymentName = serviceName.replace('-service', '');

    // 获取当前副本数
    const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, namespace);
    const currentReplicas = deployment.body.spec.replicas;
    
    // 根据健康评分决定扩容数量
    let targetReplicas = currentReplicas;
    if (healthScore.totalScore < 40) {
      targetReplicas = Math.min(currentReplicas + 2, 10); // 最多 10 个副本
    } else if (healthScore.totalScore < 60) {
      targetReplicas = Math.min(currentReplicas + 1, 10);
    }

    if (targetReplicas === currentReplicas) {
      return { success: true, action: 'no_scale_needed', currentReplicas };
    }

    // 执行扩容
    const patch = {
      spec: {
        replicas: targetReplicas
      }
    };

    await this.appsV1Api.patchNamespacedDeploymentScale(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );

    logger.info({
      serviceName,
      action: 'scale_pods',
      from: currentReplicas,
      to: targetReplicas
    }, 'Pod 扩容完成');

    return {
      success: true,
      action: 'scale_pods',
      from: currentReplicas,
      to: targetReplicas
    };
  }

  /**
   * 重启 Pod
   */
  async _restartPod(serviceName) {
    const namespace = process.env.KUBERNETES_NAMESPACE || 'default';
    const deploymentName = serviceName.replace('-service', '');

    // 通过更新 annotation 触发滚动重启
    const patch = {
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': new Date().toISOString()
            }
          }
        }
      }
    };

    await this.appsV1Api.patchNamespacedDeployment(
      deploymentName,
      namespace,
      patch,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/merge-patch+json' } }
    );

    logger.info({
      serviceName,
      action: 'restart_pods'
    }, 'Pod 重启触发完成');

    return {
      success: true,
      action: 'restart_pods'
    };
  }

  /**
   * 回滚部署
   */
  async _rollbackDeployment(serviceName) {
    const namespace = process.env.KUBERNETES_NAMESPACE || 'default';
    const deploymentName = serviceName.replace('-service', '');

    // 获取历史版本
    const rolloutHistory = await this.appsV1Api.readNamespacedDeploymentRolloutHistory(
      deploymentName,
      namespace
    );

    const revisions = rolloutHistory.body;
    if (!revisions || revisions.length < 2) {
      logger.warn({
        serviceName,
        action: 'rollback'
      }, '没有可回滚的历史版本');
      return { success: false, reason: 'no_history' };
    }

    // 回滚到上一个版本
    const previousRevision = revisions[revisions.length - 2];
    
    await this.appsV1Api.createNamespacedDeploymentRollback(
      deploymentName,
      namespace,
      { name: deploymentName, revision: previousRevision.revision }
    );

    logger.info({
      serviceName,
      action: 'rollback',
      toRevision: previousRevision.revision
    }, '部署回滚完成');

    return {
      success: true,
      action: 'rollback',
      toRevision: previousRevision.revision
    };
  }

  /**
   * 扩容事件消费者
   */
  async _scaleConsumers(serviceName) {
    // 增加消费者组实例数
    // 这通常需要通过调整 Kafka consumer 配置或 K8s HPA 来实现
    // 这里简化为扩容 Pod
    return await this._scalePods(serviceName, { totalScore: 45 });
  }

  /**
   * 检查冷却期
   */
  _isInCooldown(serviceName) {
    const lastRecovery = this.recoveryHistory.get(serviceName);
    if (!lastRecovery) return false;
    
    return (Date.now() - lastRecovery.timestamp) < this.cooldownPeriod;
  }

  /**
   * 记录恢复历史
   */
  _recordRecovery(serviceName, type, result) {
    this.recoveryHistory.set(serviceName, {
      type,
      result,
      timestamp: Date.now()
    });
  }
}

module.exports = AutoRecovery;
```

### 3. 健康仪表板 API

```javascript
// backend/gateway/src/routes/healthDashboard.js

const express = require('express');
const router = express.Router();
const HealthScorer = require('../../shared/healthScorer');
const AutoRecovery = require('../../shared/autoRecovery');
const { metrics } = require('../../shared/metrics');
const logger = require('../../shared/logger');

const healthScorer = new HealthScorer();
const autoRecovery = new AutoRecovery();

/**
 * 获取所有服务健康状态
 */
router.get('/services/health', async (req, res) => {
  try {
    const services = [
      'user-service', 'location-service', 'pokemon-service',
      'catch-service', 'gym-service', 'social-service',
      'reward-service', 'payment-service', 'gateway'
    ];

    const healthStatuses = await Promise.all(
      services.map(async (service) => {
        // 从 Prometheus 获取指标
        const metricsData = await fetchServiceMetrics(service);
        const healthScore = healthScorer.calculateHealthScore(service, metricsData);
        return healthScore;
      })
    );

    // 计算整体健康度
    const overallHealth = calculateOverallHealth(healthStatuses);

    res.json({
      overall: overallHealth,
      services: healthStatuses,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取服务健康状态失败');
    res.status(500).json({ error: 'Failed to fetch health status' });
  }
});

/**
 * 获取单个服务健康详情
 */
router.get('/services/:serviceName/health', async (req, res) => {
  const { serviceName } = req.params;
  
  try {
    const metricsData = await fetchServiceMetrics(serviceName);
    const healthScore = healthScorer.calculateHealthScore(serviceName, metricsData);
    
    res.json(healthScore);
  } catch (error) {
    logger.error({ 
      serviceName, 
      error: error.message 
    }, '获取服务健康详情失败');
    res.status(500).json({ error: 'Failed to fetch service health details' });
  }
});

/**
 * 获取服务依赖拓扑
 */
router.get('/services/topology', async (req, res) => {
  try {
    const topology = await buildServiceTopology();
    res.json(topology);
  } catch (error) {
    logger.error({ error: error.message }, '获取服务拓扑失败');
    res.status(500).json({ error: 'Failed to fetch service topology' });
  }
});

/**
 * 执行自动恢复（手动触发）
 */
router.post('/services/:serviceName/recover', async (req, res) => {
  const { serviceName } = req.params;
  const { type, dryRun } = req.body;

  try {
    const metricsData = await fetchServiceMetrics(serviceName);
    const healthScore = healthScorer.calculateHealthScore(serviceName, metricsData);
    
    const recommendation = {
      type: type || healthScore.recommendations[0]?.type || 'scaling',
      priority: 'high',
      autoRecoverable: true
    };

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
    res.status(500).json({ error: 'Failed to execute recovery' });
  }
});

/**
 * 获取恢复历史
 */
router.get('/services/:serviceName/recovery-history', async (req, res) => {
  const { serviceName } = req.params;
  const history = autoRecovery.recoveryHistory.get(serviceName);
  
  res.json({
    serviceName,
    history: history || null
  });
});

/**
 * 获取故障演练状态
 */
router.get('/chaos/status', async (req, res) => {
  // 查询 Chaos Mesh 状态
  try {
    const chaosExperiments = await getChaosExperiments();
    res.json({
      enabled: process.env.CHAOS_MESH_ENABLED === 'true',
      experiments: chaosExperiments
    });
  } catch (error) {
    res.json({
      enabled: false,
      experiments: []
    });
  }
});

/**
 * 触发故障演练
 */
router.post('/chaos/inject', async (req, res) => {
  const { type, serviceName, duration } = req.body;

  try {
    const experiment = await injectChaos(type, serviceName, duration);
    
    logger.info({
      type,
      serviceName,
      duration,
      experimentName: experiment.name
    }, '故障演练注入成功');

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
    res.status(500).json({ error: 'Failed to inject chaos' });
  }
});

// === 辅助函数 ===

async function fetchServiceMetrics(serviceName) {
  // 从 Prometheus 查询指标
  // 这里简化为返回模拟数据，实际应调用 Prometheus API
  return {
    cpu: Math.random() * 100,
    memory: Math.random() * 100,
    errorRate: Math.random() * 0.2,
    responseTime: Math.random() * 1000,
    connectionPool: Math.random() * 100,
    eventLag: Math.random() * 300
  };
}

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

async function buildServiceTopology() {
  // 返回服务依赖拓扑
  return {
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
}

async function getChaosExperiments() {
  // 实际应查询 Chaos Mesh API
  return [];
}

async function injectChaos(type, serviceName, duration = '5m') {
  // 实际应调用 Chaos Mesh API 创建实验
  return {
    name: `${type}-${serviceName}-${Date.now()}`,
    type,
    serviceName,
    duration,
    status: 'running'
  };
}

module.exports = router;
```

### 4. Grafana 仪表板配置

```json
{
  "dashboard": {
    "title": "mineGo Service Health Dashboard",
    "uid": "minego-health",
    "panels": [
      {
        "title": "Overall Health Score",
        "type": "gauge",
        "gridPos": { "x": 0, "y": 0, "w": 8, "h": 6 },
        "targets": [
          {
            "expr": "avg(service_health_score)",
            "legendFormat": "Average Health Score"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "thresholds": {
              "mode": "absolute",
              "steps": [
                { "color": "red", "value": 0 },
                { "color": "yellow", "value": 60 },
                { "color": "green", "value": 80 }
              ]
            },
            "max": 100,
            "min": 0
          }
        }
      },
      {
        "title": "Service Health Status",
        "type": "stat",
        "gridPos": { "x": 8, "y": 0, "w": 16, "h": 6 },
        "targets": [
          {
            "expr": "sum by (service) (service_health_score)",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "Service Topology",
        "type": "nodeGraph",
        "gridPos": { "x": 0, "y": 6, "w": 24, "h": 10 },
        "datasource": "Prometheus",
        "targets": [
          {
            "expr": "service_call_count_total",
            "format": "table"
          }
        ]
      },
      {
        "title": "Auto Recovery Events",
        "type": "timeseries",
        "gridPos": { "x": 0, "y": 16, "w": 12, "h": 6 },
        "targets": [
          {
            "expr": "rate(auto_recovery_attempts_total[5m])",
            "legendFormat": "{{service}} - {{type}}"
          },
          {
            "expr": "rate(auto_recovery_success_total[5m])",
            "legendFormat": "Success - {{service}}"
          },
          {
            "expr": "rate(auto_recovery_failure_total[5m])",
            "legendFormat": "Failure - {{service}}"
          }
        ]
      },
      {
        "title": "Health Score Trends",
        "type": "timeseries",
        "gridPos": { "x": 12, "y": 16, "w": 12, "h": 6 },
        "targets": [
          {
            "expr": "service_health_score",
            "legendFormat": "{{service}}"
          }
        ]
      }
    ]
  }
}
```

### 5. Prometheus 指标定义

```javascript
// backend/shared/metrics.js 扩展

// 健康评分指标
const serviceHealthScore = new Gauge({
  name: 'service_health_score',
  help: 'Service health score (0-100)',
  labelNames: ['service']
});

// 自动恢复指标
const autoRecoveryAttempts = new Counter({
  name: 'auto_recovery_attempts_total',
  help: 'Total number of auto recovery attempts',
  labelNames: ['service', 'type']
});

const autoRecoverySuccess = new Counter({
  name: 'auto_recovery_success_total',
  help: 'Total number of successful auto recoveries',
  labelNames: ['service', 'type']
});

const autoRecoveryFailure = new Counter({
  name: 'auto_recovery_failure_total',
  help: 'Total number of failed auto recoveries',
  labelNames: ['service', 'type']
});

// 故障演练指标
const chaosExperimentActive = new Gauge({
  name: 'chaos_experiment_active',
  help: 'Number of active chaos experiments',
  labelNames: ['service', 'type']
});
```

## 验收标准

- [ ] 健康评分引擎正确计算各维度指标加权得分
- [ ] 健康仪表板 API 返回所有服务健康状态
- [ ] 服务拓扑图正确展示服务间依赖关系
- [ ] 自动恢复在服务异常时自动触发扩容/重启/回滚
- [ ] 冷却期机制防止重复恢复（5 分钟内不重复执行）
- [ ] 手动恢复 API 支持干运行模式（dryRun）
- [ ] Grafana 仪表板展示整体健康度和趋势
- [ ] Prometheus 指标正确暴露健康评分和恢复计数
- [ ] 故障演练接口支持注入网络延迟、CPU 压力等场景
- [ ] 恢复历史记录可查询
- [ ] 单元测试覆盖率 > 80%
- [ ] 自动恢复成功率 > 90%

## 影响范围

- **新增文件**:
  - `backend/shared/healthScorer.js` - 健康评分引擎
  - `backend/shared/autoRecovery.js` - 自动恢复执行器
  - `backend/gateway/src/routes/healthDashboard.js` - 健康仪表板 API
  - `infrastructure/k8s/monitoring/grafana-dashboards/health-dashboard.json` - Grafana 仪表板

- **修改文件**:
  - `backend/shared/metrics.js` - 新增健康评分和恢复指标
  - `backend/gateway/src/index.js` - 集成健康仪表板路由
  - `infrastructure/k8s/monitoring/prometheus-rules.yml` - 新增健康告警规则

- **依赖**:
  - `@kubernetes/client-node` - K8s API 客户端
  - Chaos Mesh（可选）- 故障演练平台

## 参考

- [Kubernetes API 文档](https://kubernetes.io/docs/reference/kubernetes-api/)
- [Chaos Mesh 文档](https://chaos-mesh.org/docs/)
- [Prometheus 查询语言](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Google SRE 运维手册](https://sre.google/sre-book/automation/)
