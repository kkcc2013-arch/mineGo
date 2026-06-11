/**
 * 扩缩容指标收集模块
 * 收集 HPA、VPA、预测性扩容相关指标
 * 
 * REQ-00071: K8s Pod 资源自动扩缩容优化系统
 */

const client = require('prom-client');
const logger = require('./logger');

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

  vpaCpuTarget: new client.Gauge({
    name: 'vpa_cpu_target_utilization',
    help: 'VPA CPU target utilization',
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
  })
};

/**
 * 扩缩容指标收集器
 */
class ScalingMetricsCollector {
  constructor(config = {}) {
    this.prometheusUrl = config.prometheusUrl || process.env.PROMETHEUS_URL || 'http://prometheus-server:9090';
    this.namespace = config.namespace || 'minego';
    this.services = config.services || [
      'gateway',
      'catch-service',
      'location-service',
      'pokemon-service',
      'user-service',
      'gym-service'
    ];
  }

  /**
   * 查询 Prometheus
   */
  async queryPrometheus(query) {
    try {
      const response = await fetch(`${this.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
      const data = await response.json();
      
      if (data.status === 'success' && data.data.result.length > 0) {
        return parseFloat(data.data.result[0].value[1]);
      }
      return null;
    } catch (error) {
      logger.debug('Prometheus query failed', { query, error: error.message });
      return null;
    }
  }

  /**
   * 收集 HPA 指标
   */
  async collectHPAMetrics() {
    for (const service of this.services) {
      try {
        // 当前副本数
        const currentReplicas = await this.queryPrometheus(
          `kube_hpa_status_current_replicas{namespace="${this.namespace}",hpa="${service}-hpa"}`
        );
        if (currentReplicas !== null) {
          scalingMetrics.hpaCurrentReplicas.set(
            { service, namespace: this.namespace },
            currentReplicas
          );
        }

        // 期望副本数
        const desiredReplicas = await this.queryPrometheus(
          `kube_hpa_desired_replicas{namespace="${this.namespace}",hpa="${service}-hpa"}`
        );
        if (desiredReplicas !== null) {
          scalingMetrics.hpaDesiredReplicas.set(
            { service, namespace: this.namespace },
            desiredReplicas
          );
        }

        // 最小副本数
        const minReplicas = await this.queryPrometheus(
          `kube_hpa_spec_min_replicas{namespace="${this.namespace}",hpa="${service}-hpa"}`
        );
        if (minReplicas !== null) {
          scalingMetrics.hpaMinReplicas.set(
            { service, namespace: this.namespace },
            minReplicas
          );
        }

        // 最大副本数
        const maxReplicas = await this.queryPrometheus(
          `kube_hpa_spec_max_replicas{namespace="${this.namespace}",hpa="${service}-hpa"}`
        );
        if (maxReplicas !== null) {
          scalingMetrics.hpaMaxReplicas.set(
            { service, namespace: this.namespace },
            maxReplicas
          );
        }
      } catch (error) {
        logger.error('Failed to collect HPA metrics', {
          service,
          error: error.message
        });
      }
    }
  }

  /**
   * 收集 VPA 指标
   */
  async collectVPAMetrics() {
    for (const service of this.services) {
      try {
        // CPU 推荐
        const cpuRequest = await this.queryPrometheus(
          `vpa_container_recommendation_target_cpu{namespace="${this.namespace}",vpa="${service}-vpa"}`
        );
        if (cpuRequest !== null) {
          scalingMetrics.vpaCpuRequest.set(
            { service, namespace: this.namespace, container: service },
            cpuRequest
          );
        }

        // 内存推荐
        const memoryRequest = await this.queryPrometheus(
          `vpa_container_recommendation_target_memory{namespace="${this.namespace}",vpa="${service}-vpa"}`
        );
        if (memoryRequest !== null) {
          scalingMetrics.vpaMemoryRequest.set(
            { service, namespace: this.namespace, container: service },
            memoryRequest
          );
        }
      } catch (error) {
        logger.error('Failed to collect VPA metrics', {
          service,
          error: error.message
        });
      }
    }
  }

  /**
   * 计算资源利用率效率
   */
  async calculateUtilizationEfficiency(service) {
    try {
      // CPU 利用率
      const cpuUtil = await this.queryPrometheus(
        `avg(rate(container_cpu_usage_seconds_total{namespace="${this.namespace}",pod=~"${service}-.*"}[5m])) / 
         avg(kube_pod_container_resource_requests{namespace="${this.namespace}",resource="cpu",container="${service}"})`
      );

      // 内存利用率
      const memUtil = await this.queryPrometheus(
        `avg(container_memory_working_set_bytes{namespace="${this.namespace}",pod=~"${service}-.*"}) /
         avg(kube_pod_container_resource_requests{namespace="${this.namespace}",resource="memory",container="${service}"})`
      );

      return {
        cpu: cpuUtil !== null ? Math.min(1, cpuUtil) : 0.5,
        memory: memUtil !== null ? Math.min(1, memUtil) : 0.5
      };
    } catch (error) {
      return { cpu: 0.5, memory: 0.5 };
    }
  }

  /**
   * 计算资源浪费分数
   */
  calculateWasteScore(utilization) {
    // 理想利用率在 60-80% 之间
    // 低于 60% 表示浪费，高于 80% 表示资源紧张
    const idealMin = 0.6;
    const idealMax = 0.8;
    
    let wasteScore = 0;
    
    for (const type of ['cpu', 'memory']) {
      const util = utilization[type];
      
      if (util < idealMin) {
        // 浪费 = (理想最小值 - 实际值) * 100
        wasteScore += (idealMin - util) * 50;
      } else if (util > idealMax) {
        // 资源紧张也扣分
        wasteScore += (util - idealMax) * 50;
      }
    }
    
    return Math.min(100, wasteScore);
  }

  /**
   * 收集资源利用率指标
   */
  async collectUtilizationMetrics() {
    for (const service of this.services) {
      try {
        const utilization = await this.calculateUtilizationEfficiency(service);
        
        // 设置利用率效率
        scalingMetrics.resourceUtilizationEfficiency.set(
          { service, resource_type: 'cpu' },
          utilization.cpu
        );
        scalingMetrics.resourceUtilizationEfficiency.set(
          { service, resource_type: 'memory' },
          utilization.memory
        );
        
        // 计算并设置资源浪费分数
        const wasteScore = this.calculateWasteScore(utilization);
        scalingMetrics.resourceWasteScore.set(
          { service },
          wasteScore
        );
        
        // 检测过度配置
        if (utilization.cpu < 0.4) {
          scalingMetrics.overProvisionedResources.set(
            { service, resource_type: 'cpu' },
            1
          );
        }
        
        if (utilization.memory < 0.4) {
          scalingMetrics.overProvisionedResources.set(
            { service, resource_type: 'memory' },
            1
          );
        }
        
        // 检测资源不足
        if (utilization.cpu > 0.9) {
          scalingMetrics.underProvisionedResources.set(
            { service, resource_type: 'cpu' },
            1
          );
        }
        
        if (utilization.memory > 0.9) {
          scalingMetrics.underProvisionedResources.set(
            { service, resource_type: 'memory' },
            1
          );
        }
      } catch (error) {
        logger.error('Failed to collect utilization metrics', {
          service,
          error: error.message
        });
      }
    }
  }

  /**
   * 收集所有指标
   */
  async collectAll() {
    await Promise.all([
      this.collectHPAMetrics(),
      this.collectVPAMetrics(),
      this.collectUtilizationMetrics()
    ]);
  }

  /**
   * 启动定时收集
   */
  start(intervalMs = 60000) {
    logger.info('Starting scaling metrics collector', { interval: intervalMs });
    
    // 立即执行一次
    this.collectAll().catch(err => {
      logger.error('Initial metrics collection failed', { error: err.message });
    });
    
    // 定时执行
    this.intervalId = setInterval(async () => {
      try {
        await this.collectAll();
      } catch (error) {
        logger.error('Metrics collection failed', { error: error.message });
      }
    }, intervalMs);
    
    return this;
  }

  /**
   * 停止定时收集
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Scaling metrics collector stopped');
    }
    return this;
  }
}

/**
 * 生成效率报告
 */
async function generateEfficiencyReport(timeRange = '24h') {
  const collector = new ScalingMetricsCollector();
  const report = {
    timeRange,
    services: [],
    summary: {
      totalSavings: 0,
      averageEfficiency: 0,
      overProvisioned: 0,
      underProvisioned: 0
    }
  };
  
  for (const service of collector.services) {
    const utilization = await collector.calculateUtilizationEfficiency(service);
    const avgUtil = (utilization.cpu + utilization.memory) / 2;
    
    // 计算潜在节省
    const potentialSavings = avgUtil < 0.5 ? (0.6 - avgUtil) * 100 : 0;
    
    report.services.push({
      name: service,
      cpuUtilization: utilization.cpu.toFixed(2),
      memoryUtilization: utilization.memory.toFixed(2),
      efficiency: avgUtil < 0.6 ? 'over-provisioned' : avgUtil > 0.9 ? 'under-provisioned' : 'optimal',
      potentialSavings: potentialSavings.toFixed(0) + '%'
    });
    
    if (avgUtil < 0.5) report.summary.overProvisioned++;
    if (avgUtil > 0.9) report.summary.underProvisioned++;
  }
  
  report.summary.averageEfficiency = (
    report.services.reduce((sum, s) => sum + parseFloat(s.cpuUtilization), 0) / report.services.length
  ).toFixed(2);
  
  return report;
}

module.exports = {
  scalingMetrics,
  ScalingMetricsCollector,
  generateEfficiencyReport
};
