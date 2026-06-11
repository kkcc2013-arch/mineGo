/**
 * 金丝雀发布 Prometheus 指标
 */

const client = require('prom-client');

// 金丝雀流量比例
const canaryTrafficGauge = new client.Gauge({
  name: 'canary_traffic_percentage',
  help: 'Current traffic percentage for canary deployment',
  labelNames: ['service', 'canary_version', 'deployment_id']
});

// 金丝雀请求计数
const canaryRequestsTotal = new client.Counter({
  name: 'canary_requests_total',
  help: 'Total requests routed to canary version',
  labelNames: ['service', 'canary_version', 'status']
});

// 金丝雀错误计数
const canaryErrorsTotal = new client.Counter({
  name: 'canary_errors_total',
  help: 'Total errors from canary version',
  labelNames: ['service', 'canary_version', 'error_type']
});

// 金丝雀延迟直方图
const canaryLatencyHistogram = new client.Histogram({
  name: 'canary_request_duration_seconds',
  help: 'Request latency for canary version',
  labelNames: ['service', 'canary_version'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10]
});

// 金丝雀部署状态
const canaryDeploymentStatus = new client.Gauge({
  name: 'canary_deployment_status',
  help: 'Current status of canary deployment (0=inactive, 1=active, 2=promoting, 3=completed, 4=rolled_back)',
  labelNames: ['service', 'deployment_id']
});

// 金丝雀指标验证结果
const canaryMetricsValid = new client.Gauge({
  name: 'canary_metrics_valid',
  help: 'Whether canary metrics are within thresholds (1=valid, 0=invalid)',
  labelNames: ['service', 'deployment_id']
});

// 金丝雀部署总数
const canaryDeploymentsTotal = new client.Counter({
  name: 'canary_deployments_total',
  help: 'Total canary deployments',
  labelNames: ['service', 'strategy']
});

// 金丝雀回滚总数
const canaryRollbacksTotal = new client.Counter({
  name: 'canary_rollbacks_total',
  help: 'Total canary rollbacks',
  labelNames: ['service', 'reason']
});

/**
 * 更新金丝雀流量指标
 */
function updateTrafficMetric(service, canaryVersion, deploymentId, trafficPercentage) {
  canaryTrafficGauge.set(
    { service, canary_version: canaryVersion, deployment_id: deploymentId.toString() },
    trafficPercentage
  );
}

/**
 * 记录金丝雀请求
 */
function recordRequest(service, canaryVersion, status, durationSeconds) {
  canaryRequestsTotal.inc({ service, canary_version: canaryVersion, status });
  
  if (durationSeconds) {
    canaryLatencyHistogram.observe(
      { service, canary_version: canaryVersion },
      durationSeconds
    );
  }
}

/**
 * 记录金丝雀错误
 */
function recordError(service, canaryVersion, errorType) {
  canaryErrorsTotal.inc({ service, canary_version: canaryVersion, error_type: errorType });
}

/**
 * 更新金丝雀部署状态
 */
function updateDeploymentStatus(service, deploymentId, status) {
  const statusMap = {
    'inactive': 0,
    'active': 1,
    'promoting': 2,
    'completed': 3,
    'rolled_back': 4,
    'cancelled': 5
  };
  
  canaryDeploymentStatus.set(
    { service, deployment_id: deploymentId.toString() },
    statusMap[status] || 0
  );
}

/**
 * 更新指标验证结果
 */
function updateMetricsValidation(service, deploymentId, isValid) {
  canaryMetricsValid.set(
    { service, deployment_id: deploymentId.toString() },
    isValid ? 1 : 0
  );
}

/**
 * 记录金丝雀部署
 */
function recordDeployment(service, strategy) {
  canaryDeploymentsTotal.inc({ service, strategy });
}

/**
 * 记录金丝雀回滚
 */
function recordRollback(service, reason) {
  canaryRollbacksTotal.inc({ service, reason });
}

module.exports = {
  canaryTrafficGauge,
  canaryRequestsTotal,
  canaryErrorsTotal,
  canaryLatencyHistogram,
  canaryDeploymentStatus,
  canaryMetricsValid,
  canaryDeploymentsTotal,
  canaryRollbacksTotal,
  updateTrafficMetric,
  recordRequest,
  recordError,
  updateDeploymentStatus,
  updateMetricsValidation,
  recordDeployment,
  recordRollback
};
