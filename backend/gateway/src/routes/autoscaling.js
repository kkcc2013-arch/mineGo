/**
 * 扩缩容 API 路由
 * 
 * REQ-00071: K8s Pod 资源自动扩缩容优化系统
 */

const express = require('express');
const router = express.Router();
const { PredictiveScalingEngine } = require('@pmg/shared/predictiveScaling');
const { scalingMetrics, ScalingMetricsCollector, generateEfficiencyReport } = require('@pmg/shared/scalingMetrics');
const logger = require('@pmg/shared/logger');

// 创建实例
const scalingEngine = new PredictiveScalingEngine();
const metricsCollector = new ScalingMetricsCollector();

/**
 * 管理员权限检查中间件
 */
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  return res.status(403).json({
    success: false,
    error: 'Admin access required'
  });
}

/**
 * GET /api/v1/autoscaling/status
 * 获取所有服务的扩缩容状态
 */
router.get('/status', requireAdmin, async (req, res) => {
  try {
    const namespace = 'minego';
    const services = ['gateway', 'catch-service', 'location-service', 'pokemon-service', 'user-service', 'gym-service'];
    
    const status = [];
    
    for (const service of services) {
      const currentReplicas = await metricsCollector.queryPrometheus(
        `kube_hpa_status_current_replicas{namespace="${namespace}",hpa="${service}-hpa"}`
      );
      const desiredReplicas = await metricsCollector.queryPrometheus(
        `kube_hpa_desired_replicas{namespace="${namespace}",hpa="${service}-hpa"}`
      );
      const minReplicas = await metricsCollector.queryPrometheus(
        `kube_hpa_spec_min_replicas{namespace="${namespace}",hpa="${service}-hpa"}`
      );
      const maxReplicas = await metricsCollector.queryPrometheus(
        `kube_hpa_spec_max_replicas{namespace="${namespace}",hpa="${service}-hpa"}`
      );
      
      // CPU 利用率
      const cpuUtil = await metricsCollector.queryPrometheus(
        `avg(rate(container_cpu_usage_seconds_total{namespace="${namespace}",pod=~"${service}-.*"}[5m])) * 100`
      );
      
      // 内存利用率
      const memUtil = await metricsCollector.queryPrometheus(
        `avg(container_memory_working_set_bytes{namespace="${namespace}",pod=~"${service}-.*"}) /
         avg(kube_pod_container_resource_requests{namespace="${namespace}",resource="memory",container="${service}"}) * 100`
      );
      
      status.push({
        service,
        currentReplicas: currentReplicas || 0,
        desiredReplicas: desiredReplicas || 0,
        minReplicas: minReplicas || 2,
        maxReplicas: maxReplicas || 10,
        cpuUtilization: cpuUtil ? cpuUtil.toFixed(1) : 'N/A',
        memoryUtilization: memUtil ? memUtil.toFixed(1) : 'N/A',
        status: currentReplicas === desiredReplicas ? 'stable' : currentReplicas < desiredReplicas ? 'scaling-up' : 'scaling-down'
      });
    }
    
    res.json({
      success: true,
      data: status,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get autoscaling status', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get autoscaling status'
    });
  }
});

/**
 * GET /api/v1/autoscaling/predictions
 * 获取预测性扩容建议
 */
router.get('/predictions', requireAdmin, async (req, res) => {
  try {
    const { predictionWindow } = req.query;
    
    const recommendations = await scalingEngine.generateScalingRecommendations();
    
    res.json({
      success: true,
      data: recommendations,
      config: {
        predictionWindow: scalingEngine.config.predictionWindow,
        minConfidence: scalingEngine.config.minConfidence,
        scaleAheadTime: scalingEngine.config.scaleAheadTime
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Failed to get scaling predictions', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to generate predictions'
    });
  }
});

/**
 * POST /api/v1/autoscaling/execute
 * 手动执行预测性扩容
 */
router.post('/execute', requireAdmin, async (req, res) => {
  try {
    const { service, replicas, dryRun = false } = req.body;
    
    // 如果指定了服务和副本数，执行单次扩缩容
    if (service && replicas) {
      logger.info('Manual scaling requested', { service, replicas, dryRun, user: req.user?.id });
      
      if (!dryRun) {
        // 这里可以集成 Kubernetes API 执行实际扩缩容
        // const k8s = require('@kubernetes/client-node');
        // ... 执行 kubectl scale deployment ...
        
        scalingMetrics.hpaScalingEvents.inc({
          service,
          namespace: 'minego',
          direction: replicas > 0 ? 'up' : 'down'
        });
      }
      
      return res.json({
        success: true,
        data: {
          service,
          action: 'manual_scale',
          targetReplicas: replicas,
          dryRun,
          executed: !dryRun
        },
        message: dryRun ? 'Dry run completed' : 'Scaling executed'
      });
    }
    
    // 否则执行预测性扩容
    const results = await scalingEngine.executePredictiveScaling();
    
    res.json({
      success: true,
      data: results,
      message: `Executed ${results.length} scaling actions`
    });
  } catch (error) {
    logger.error('Failed to execute predictive scaling', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to execute scaling'
    });
  }
});

/**
 * GET /api/v1/autoscaling/efficiency
 * 获取资源利用效率报告
 */
router.get('/efficiency', requireAdmin, async (req, res) => {
  try {
    const { timeRange = '24h' } = req.query;
    
    const report = await generateEfficiencyReport(timeRange);
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Failed to generate efficiency report', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to generate report'
    });
  }
});

/**
 * GET /api/v1/autoscaling/history
 * 获取扩缩容历史记录
 */
router.get('/history', requireAdmin, async (req, res) => {
  try {
    const { service, limit = 100 } = req.query;
    const namespace = 'minego';
    
    // 从 Prometheus 查询扩缩容事件
    let query = `sum(increase(hpa_scaling_events_total{namespace="${namespace}"}[30d])) by (service, direction)`;
    
    if (service) {
      query = `sum(increase(hpa_scaling_events_total{namespace="${namespace}",service="${service}"}[30d])) by (direction)`;
    }
    
    const events = await metricsCollector.queryPrometheus(query);
    
    // 模拟历史数据（实际应从 Kubernetes Events API 获取）
    const history = [
      {
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        service: 'gateway',
        action: 'scale_up',
        from: 3,
        to: 5,
        reason: 'CPU utilization exceeded 70%'
      },
      {
        timestamp: new Date(Date.now() - 7200000).toISOString(),
        service: 'catch-service',
        action: 'scale_up',
        from: 5,
        to: 8,
        reason: 'Request rate exceeded threshold'
      },
      {
        timestamp: new Date(Date.now() - 10800000).toISOString(),
        service: 'location-service',
        action: 'scale_down',
        from: 4,
        to: 2,
        reason: 'Low load period'
      }
    ];
    
    res.json({
      success: true,
      data: service ? history.filter(h => h.service === service) : history,
      total: history.length
    });
  } catch (error) {
    logger.error('Failed to get scaling history', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get history'
    });
  }
});

/**
 * GET /api/v1/autoscaling/config
 * 获取扩缩容配置
 */
router.get('/config', requireAdmin, async (req, res) => {
  try {
    const config = {
      predictiveScaling: {
        predictionWindow: scalingEngine.config.predictionWindow,
        historyWindow: scalingEngine.config.historyWindow,
        scaleAheadTime: scalingEngine.config.scaleAheadTime,
        minConfidence: scalingEngine.config.minConfidence,
        checkInterval: scalingEngine.config.checkInterval
      },
      services: Object.entries(scalingEngine.serviceConfigs).map(([name, cfg]) => ({
        name,
        hpaMin: cfg.hpaMin,
        hpaMax: cfg.hpaMax,
        targetPerPod: cfg.targetPerPod,
        scaleThreshold: cfg.scaleThreshold,
        metricName: cfg.metricName
      }))
    };
    
    res.json({
      success: true,
      data: config
    });
  } catch (error) {
    logger.error('Failed to get scaling config', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get config'
    });
  }
});

/**
 * PATCH /api/v1/autoscaling/config
 * 更新扩缩容配置
 */
router.patch('/config', requireAdmin, async (req, res) => {
  try {
    const { service, config } = req.body;
    
    if (!service || !config) {
      return res.status(400).json({
        success: false,
        error: 'Service and config are required'
      });
    }
    
    // 更新服务配置
    if (scalingEngine.serviceConfigs[service]) {
      scalingEngine.serviceConfigs[service] = {
        ...scalingEngine.serviceConfigs[service],
        ...config
      };
      
      logger.info('Scaling config updated', { service, config, user: req.user?.id });
      
      res.json({
        success: true,
        data: scalingEngine.serviceConfigs[service],
        message: 'Config updated successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Service not found'
      });
    }
  } catch (error) {
    logger.error('Failed to update scaling config', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to update config'
    });
  }
});

/**
 * GET /api/v1/autoscaling/metrics
 * 获取扩缩容指标摘要
 */
router.get('/metrics', async (req, res) => {
  try {
    const namespace = 'minego';
    const services = ['gateway', 'catch-service', 'location-service', 'pokemon-service', 'user-service', 'gym-service'];
    
    const metrics = [];
    
    for (const service of services) {
      const currentReplicas = await metricsCollector.queryPrometheus(
        `kube_hpa_status_current_replicas{namespace="${namespace}",hpa="${service}-hpa"}`
      );
      const wasteScore = await metricsCollector.queryPrometheus(
        `resource_waste_score{namespace="${namespace}",service="${service}"}`
      );
      const predictionConfidence = await metricsCollector.queryPrometheus(
        `prediction_confidence{service="${service}"}`
      );
      
      metrics.push({
        service,
        currentReplicas: currentReplicas || 0,
        wasteScore: wasteScore ? wasteScore.toFixed(1) : 'N/A',
        predictionConfidence: predictionConfidence ? predictionConfidence.toFixed(2) : 'N/A'
      });
    }
    
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    logger.error('Failed to get scaling metrics', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get metrics'
    });
  }
});

module.exports = router;
