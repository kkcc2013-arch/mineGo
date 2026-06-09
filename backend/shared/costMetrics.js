// shared/costMetrics.js - 云成本监控 Prometheus 指标
'use strict';
const promClient = require('prom-client');
const metrics = require('./metrics');

// 使用主 metrics 模块的 registry
const registry = metrics.register;

// ============================================================
// 云成本指标
// ============================================================
const costGauge = new promClient.Gauge({
  name: 'minego_cloud_cost_total_usd',
  help: 'Total cloud cost in USD',
  labelNames: ['provider', 'resource_type', 'namespace', 'service'],
  registers: [registry]
});

const costByServiceGauge = new promClient.Gauge({
  name: 'minego_cloud_cost_by_service_usd',
  help: 'Cloud cost per service in USD',
  labelNames: ['service_name', 'resource_type'],
  registers: [registry]
});

const budgetUsageGauge = new promClient.Gauge({
  name: 'minego_budget_usage_percentage',
  help: 'Budget usage percentage',
  labelNames: ['budget_name', 'period'],
  registers: [registry]
});

const budgetSpentGauge = new promClient.Gauge({
  name: 'minego_budget_spent_usd',
  help: 'Budget spent amount in USD',
  labelNames: ['budget_name', 'period'],
  registers: [registry]
});

const budgetLimitGauge = new promClient.Gauge({
  name: 'minego_budget_limit_usd',
  help: 'Budget limit amount in USD',
  labelNames: ['budget_name', 'period'],
  registers: [registry]
});

// ============================================================
// 资源使用指标
// ============================================================
const resourceUtilizationGauge = new promClient.Gauge({
  name: 'minego_resource_utilization_percentage',
  help: 'Resource utilization percentage',
  labelNames: ['service', 'resource_type', 'namespace'],
  registers: [registry]
});

const resourceAllocatedGauge = new promClient.Gauge({
  name: 'minego_resource_allocated_units',
  help: 'Allocated resource units (cpu_cores, memory_bytes)',
  labelNames: ['service', 'resource_type', 'namespace'],
  registers: [registry]
});

const resourceUsedGauge = new promClient.Gauge({
  name: 'minego_resource_used_units',
  help: 'Used resource units',
  labelNames: ['service', 'resource_type', 'namespace'],
  registers: [registry]
});

// ============================================================
// 成本预测指标
// ============================================================
const predictedCostGauge = new promClient.Gauge({
  name: 'minego_predicted_monthly_cost_usd',
  help: 'Predicted monthly cost based on current usage',
  labelNames: ['service'],
  registers: [registry]
});

const costAnomalyGauge = new promClient.Gauge({
  name: 'minego_cost_anomaly_score',
  help: 'Cost anomaly detection score (z-score)',
  labelNames: ['service', 'date'],
  registers: [registry]
});

// ============================================================
// 成本优化指标
// ============================================================
const potentialSavingsGauge = new promClient.Gauge({
  name: 'minego_potential_savings_usd',
  help: 'Potential cost savings from optimization',
  labelNames: ['optimization_type', 'service'],
  registers: [registry]
});

const costAlertCounter = new promClient.Counter({
  name: 'minego_cost_alerts_total',
  help: 'Total number of cost alerts triggered',
  labelNames: ['budget_name', 'threshold', 'level'],
  registers: [registry]
});

// ============================================================
// 告警阈值触发记录
// ============================================================
const thresholdTriggered = new Map();

/**
 * 记录阈值触发
 */
function recordThresholdTrigger(budgetName, threshold) {
  const key = `${budgetName}_${threshold}`;
  thresholdTriggered.set(key, Date.now());
}

/**
 * 检查阈值是否已触发
 */
function isThresholdTriggered(budgetName, threshold) {
  const key = `${budgetName}_${threshold}`;
  return thresholdTriggered.has(key);
}

/**
 * 清除阈值触发记录
 */
function clearThresholdTriggers() {
  thresholdTriggered.clear();
}

module.exports = {
  // 成本指标
  costGauge,
  costByServiceGauge,
  budgetUsageGauge,
  budgetSpentGauge,
  budgetLimitGauge,
  
  // 资源使用指标
  resourceUtilizationGauge,
  resourceAllocatedGauge,
  resourceUsedGauge,
  
  // 预测指标
  predictedCostGauge,
  costAnomalyGauge,
  
  // 优化指标
  potentialSavingsGauge,
  costAlertCounter,
  
  // 辅助函数
  recordThresholdTrigger,
  isThresholdTriggered,
  clearThresholdTriggers
};
