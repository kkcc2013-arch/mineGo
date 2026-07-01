/**
 * 金丝雀发布 Prometheus 指标
 * 
 * @module canaryMetrics
 */

const client = require('prom-client');

// 金丝雀流量比例
const canaryTrafficGauge = new client.Gauge({
  name: 'canary_traffic_percentage',
  help: 'Current traffic percentage for canary deployment',
  labelNames: ['service', 'canary_version']
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
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10]
});

// 金丝雀部署状态
const canaryDeploymentStatus = new client.Gauge({
  name: 'canary_deployment_status',
  help: 'Current status of canary deployment (0=inactive, 1=active, 2=promoting, 3=completed, 4=rolled_back)',
  labelNames: ['service']
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
  help: 'Total number of canary deployments',
  labelNames: ['service', 'status']
});

// 金丝雀部署持续时间
const canaryDeploymentDuration = new client.Gauge({
  name: 'canary_deployment_duration_seconds',
  help: 'Duration of current canary deployment in seconds',
  labelNames: ['service', 'deployment_id']
});

/**
 * 记录金丝雀请求
 */
function recordCanaryRequest(service, version, statusCode, latencyMs) {
  const status = statusCode < 400 ? 'success' : (statusCode < 500 ? 'client_error' : 'server_error');
  
  canaryRequestsTotal.increment({ service, canary_version: version, status });
  
  if (statusCode >= 500) {
    canaryErrorsTotal.increment({ 
      service, 
      canary_version: version, 
      error_type: 'http_' + statusCode 
    });
  }
  
  canaryLatencyHistogram.observe(
    { service, canary_version: version },
    latencyMs / 1000
  );
}

/**
 * 更新金丝雀部署状态
 */
function updateDeploymentStatus(service, status) {
  const statusMap = {
    inactive: 0,
    active: 1,
    promoting: 2,
    completed: 3,
    rolled_back: 4
  };
  
  canaryDeploymentStatus.set({ service }, statusMap[status] || 0);
}

/**
 * 记录金丝雀部署事件
 */
function recordDeploymentEvent(service, status) {
  canaryDeploymentsTotal.increment({ service, status });
}

module.exports = {
  canaryTrafficGauge,
  canaryRequestsTotal,
  canaryErrorsTotal,
  canaryLatencyHistogram,
  canaryDeploymentStatus,
  canaryMetricsValid,
  canaryDeploymentsTotal,
  canaryDeploymentDuration,
  recordCanaryRequest,
  updateDeploymentStatus,
  recordDeploymentEvent
};