// backend/shared/scalingMetrics.js
// 扩缩容指标收集模块
'use strict';

const client = require('prom-client');

// 扩缩容相关指标
const scalingMetrics = {
  // HPA 指标
  hpaCurrentReplicas: new client.Gauge({
    name: 'hpa_current_replicas',
    help: 'Current number of replicas',
    labelNames: ['service', 'namespace']
  }),

  hpaDesiredReplicas: new client.Gauge({
    name: 'hpa_desired_replicas',
    help: 'Desired number of replicas from HPA',
    labelNames: ['service', 'namespace']
  }),

  hpaMinReplicas: new client.Gauge({
    name: 'hpa_min_replicas',
    help: 'Minimum replicas configured',
    labelNames: ['service', 'namespace']
  }),

  hpaMaxReplicas: new client.Gauge({
    name: 'hpa_max_replicas',
    help: 'Maximum replicas configured',
    labelNames: ['service', 'namespace']
  }),

  hpaScalingEvents: new client.Counter({
    name: 'hpa_scaling_events_total',
    help: 'Total number of scaling events',
    labelNames: ['service', 'namespace', 'direction']
  }),

  // VPA 指标
  vpaCpuRequest: new client.Gauge({
    name: 'vpa_cpu_request_millicores',
    help: 'VPA recommended CPU request',
    labelNames: ['service', 'namespace', 'container']
  }),

  vpaMemoryRequest: new client.Gauge({
    name: 'vpa_memory_request_bytes',
    help: 'VPA recommended memory request',
    labelNames: ['service', 'namespace', 'container']
  }),

  // 预测性扩容指标
  predictedLoad: new client.Gauge({
    name: 'predicted_load_value',
    help: 'Predicted load for the service',
    labelNames: ['service', 'prediction_window_seconds']
  }),

  predictionConfidence: new client.Gauge({
    name: 'prediction_confidence',
    help: 'Confidence level of the prediction',
    labelNames: ['service']
  }),

  predictiveScalingExecutions: new client.Counter({
    name: 'predictive_scaling_executions_total',
    help: 'Total predictive scaling executions',
    labelNames: ['service', 'action', 'result']
  }),

  predictiveScalingRecommendations: new client.Gauge({
    name: 'predictive_scaling_recommendations_count',
    help: 'Current number of scaling recommendations',
    labelNames: ['direction']
  }),

  // 资源利用率指标
  resourceUtilizationEfficiency: new client.Gauge({
    name: 'resource_utilization_efficiency',
    help: 'Resource utilization efficiency score (0-1)',
    labelNames: ['service', 'resource_type']
  }),

  overProvisionedResources: new client.Gauge({
    name: 'overprovisioned_resources_count',
    help: 'Number of over-provisioned pods',
    labelNames: ['service', 'resource_type']
  }),

  underProvisionedResources: new client.Gauge({
    name: 'underprovisioned_resources_count',
    help: 'Number of under-provisioned pods',
    labelNames: ['service', 'resource_type']
  }),

  // 成本指标
  estimatedCostSavings: new client.Gauge({
    name: 'estimated_cost_savings_dollars',
    help: 'Estimated cost savings from autoscaling',
    labelNames: ['service', 'period']
  }),

  resourceWasteScore: new client.Gauge({
    name: 'resource_waste_score',
    help: 'Resource waste score (0-100, lower is better)',
    labelNames: ['service']
  }),
  
  // 扩缩容延迟指标
  scalingLatency: new client.Histogram({
    name: 'scaling_latency_seconds',
    help: 'Time taken for scaling operation',
    labelNames: ['service', 'direction'],
    buckets: [1, 5, 10, 30, 60, 120, 300]
  }),
  
  // 预测准确度指标
  predictionAccuracy: new client.Gauge({
    name: 'prediction_accuracy',
    help: 'Prediction accuracy compared to actual load',
    labelNames: ['service', 'prediction_window_seconds']
  })
};

/**
 * 收集扩缩容指标
 */
async function collectScalingMetrics() {
  const namespace = 'minego';
  const services = ['gateway', 'catch-service', 'location-service', 'pokemon-service', 'user-service', 'gym-service'];
  
  try {
    // 模拟收集指标（生产环境应从 Kubernetes API 获取）
    for (const service of services) {
      // 模拟 HPA 指标
      const currentReplicas = 2 + Math.floor(Math.random() * 5);
      const desiredReplicas = currentReplicas;
      const minReplicas = 2;
      const maxReplicas = service === 'catch-service' ? 30 : 20;
      
      scalingMetrics.hpaCurrentReplicas.set({ service, namespace }, currentReplicas);
      scalingMetrics.hpaDesiredReplicas.set({ service, namespace }, desiredReplicas);
      scalingMetrics.hpaMinReplicas.set({ service, namespace }, minReplicas);
      scalingMetrics.hpaMaxReplicas.set({ service, namespace }, maxReplicas);
      
      // 模拟资源利用率
      const cpuUtil = 0.5 + Math.random() * 0.4;
      const memUtil = 0.6 + Math.random() * 0.3;
      
      scalingMetrics.resourceUtilizationEfficiency.set({ service, resource_type: 'cpu' }, cpuUtil);
      scalingMetrics.resourceUtilizationEfficiency.set({ service, resource_type: 'memory' }, memUtil);
      
      // 计算资源浪费分数
      const wasteScore = calculateWasteScore({ cpu: cpuUtil, memory: memUtil });
      scalingMetrics.resourceWasteScore.set({ service }, wasteScore);
      
      // 标记过度/不足配置
      if (cpuUtil < 0.6) {
        scalingMetrics.overProvisionedResources.set({ service, resource_type: 'cpu' }, 1);
      } else if (cpuUtil > 0.9) {
        scalingMetrics.underProvisionedResources.set({ service, resource_type: 'cpu' }, 1);
      }
      
      // 模拟预测指标
      const predictedLoad = 500 + Math.random() * 500;
      const confidence = 0.7 + Math.random() * 0.25;
      
      scalingMetrics.predictedLoad.set({ service, prediction_window_seconds: '900' }, predictedLoad);
      scalingMetrics.predictionConfidence.set({ service }, confidence);
      
      // 模拟成本节省
      const monthlySavings = cpuUtil < 0.5 ? (0.6 - cpuUtil) * 50 : 0;
      scalingMetrics.estimatedCostSavings.set({ service, period: 'monthly' }, monthlySavings);
    }
    
    // 模拟预测性扩容指标
    scalingMetrics.predictiveScalingRecommendations.set({ direction: 'up' }, Math.floor(Math.random() * 3));
    scalingMetrics.predictiveScalingRecommendations.set({ direction: 'down' }, Math.floor(Math.random() * 2));
    
  } catch (error) {
    console.error('Failed to collect scaling metrics:', error);
  }
}

/**
 * 计算资源浪费分数
 */
function calculateWasteScore(utilization) {
  // 理想利用率在 60-80% 之间
  // 低于 60% 表示浪费，高于 80% 表示资源紧张
  const idealMin = 0.6;
  const idealMax = 0.8;
  
  let wasteScore = 0;
  
  for (const type of ['cpu', 'memory']) {
    const util = utilization[type];
    
    if (util < idealMin) {
      // 浪费 = (理想最小值 - 实际值) * 100
      wasteScore += (idealMin - util) * 50; // 最多 30 分
    } else if (util > idealMax) {
      // 资源紧张也扣分
      wasteScore += (util - idealMax) * 50;
    }
  }
  
  return Math.min(100, wasteScore);
}

/**
 * 记录扩缩容事件
 */
function recordScalingEvent(service, direction, namespace = 'minego') {
  scalingMetrics.hpaScalingEvents.inc({ service, namespace, direction });
  
  // 记录扩缩容延迟
  const latency = Math.random() * 30; // 模拟延迟
  scalingMetrics.scalingLatency.observe({ service, direction }, latency);
}

/**
 * 记录预测性扩容执行
 */
function recordPredictiveScalingExecution(service, action, result) {
  scalingMetrics.predictiveScalingExecutions.inc({ service, action, result });
}

/**
 * 记录预测指标
 */
function recordPredictionMetrics(service, predictedLoad, confidence, windowSeconds = 900) {
  scalingMetrics.predictedLoad.set({ service, prediction_window_seconds: String(windowSeconds) }, predictedLoad);
  scalingMetrics.predictionConfidence.set({ service }, confidence);
}

/**
 * 更新预测准确度
 */
function updatePredictionAccuracy(service, predictedLoad, actualLoad, windowSeconds = 900) {
  const accuracy = Math.min(1, Math.max(0, 1 - Math.abs(predictedLoad - actualLoad) / Math.max(predictedLoad, actualLoad)));
  scalingMetrics.predictionAccuracy.set({ service, prediction_window_seconds: String(windowSeconds) }, accuracy);
}

// 启动定时收集任务
let metricsCollectionTimer = null;

function startMetricsCollection(intervalMs = 60000) {
  if (metricsCollectionTimer) {
    clearInterval(metricsCollectionTimer);
  }
  
  // 立即收集一次
  collectScalingMetrics();
  
  // 定时收集
  metricsCollectionTimer = setInterval(collectScalingMetrics, intervalMs);
  
  console.log('[scalingMetrics] Started metrics collection', { interval: `${intervalMs}ms` });
}

function stopMetricsCollection() {
  if (metricsCollectionTimer) {
    clearInterval(metricsCollectionTimer);
    metricsCollectionTimer = null;
    console.log('[scalingMetrics] Stopped metrics collection');
  }
}

module.exports = {
  scalingMetrics,
  collectScalingMetrics,
  calculateWasteScore,
  recordScalingEvent,
  recordPredictiveScalingExecution,
  recordPredictionMetrics,
  updatePredictionAccuracy,
  startMetricsCollection,
  stopMetricsCollection
};