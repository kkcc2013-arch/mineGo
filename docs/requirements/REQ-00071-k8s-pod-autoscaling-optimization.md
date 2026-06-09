# REQ-00071: K8s Pod 资源自动扩缩容优化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00071 |
| 标题 | K8s Pod 资源自动扩缩容优化系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | infrastructure/k8s、gateway、所有微服务、backend/shared |
| 创建时间 | 2026-06-09 23:30 |

## 需求描述

当前 K8s 集群中的 Pod 资源配置是静态的，无法根据实际负载自动调整。这导致：
1. **资源浪费**：低负载时 Pod 占用过多资源，云成本居高不下
2. **性能瓶颈**：高负载时 Pod 资源不足，导致响应延迟飙升甚至服务不可用
3. **运维负担**：需要人工监控和手动调整资源配置，响应滞后

本需求实现完整的 K8s Pod 自动扩缩容系统，包括：
- **Horizontal Pod Autoscaler (HPA)**：基于 CPU/内存/自定义指标自动水平扩缩容
- **Vertical Pod Autoscaler (VPA)**：自动推荐和调整 Pod 资源请求/限制
- **预测性扩容**：基于历史数据预测负载峰值，提前扩容
- **成本优化仪表板**：实时监控资源利用率与成本关系

## 技术方案

### 1. HPA 配置与自定义指标

#### 1.1 基础 HPA 配置

```yaml
# infrastructure/k8s/hpa/gateway-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: gateway-hpa
  namespace: minego
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: gateway
  minReplicas: 2
  maxReplicas: 20
  metrics:
    # CPU 利用率指标
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    
    # 内存利用率指标
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    
    # 自定义指标：请求速率（QPS）
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "1000"
    
    # 自定义指标：活跃连接数
    - type: Pods
      pods:
        metric:
          name: active_websocket_connections
        target:
          type: AverageValue
          averageValue: "500"
  
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # 5分钟稳定窗口
      policies:
        - type: Percent
          value: 10  # 每次最多缩容10%
          periodSeconds: 60
        - type: Pods
          value: 2   # 或最多缩容2个Pod
          periodSeconds: 60
      selectPolicy: Min  # 选择影响最小的策略
    
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100  # 快速扩容，可以翻倍
          periodSeconds: 15
        - type: Pods
          value: 4
          periodSeconds: 15
      selectPolicy: Max  # 选择影响最大的策略

---
# infrastructure/k8s/hpa/catch-service-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: catch-service-hpa
  namespace: minego
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: catch-service
  minReplicas: 3
  maxReplicas: 30
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65
    
    - type: Pods
      pods:
        metric:
          name: catch_requests_per_second
        target:
          type: AverageValue
          averageValue: "500"

---
# infrastructure/k8s/hpa/location-service-hpa.yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: location-service-hpa
  namespace: minego
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: location-service
  minReplicas: 2
  maxReplicas: 15
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    
    - type: Pods
      pods:
        metric:
          name: geo_query_latency_p99
        target:
          type: AverageValue
          averageValue: "200m"  # 200ms
```

#### 1.2 自定义指标适配器

```yaml
# infrastructure/k8s/monitoring/prometheus-adapter.yaml
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1beta1.custom.metrics.k8s.io
spec:
  service:
    name: prometheus-adapter
    namespace: monitoring
  group: custom.metrics.k8s.io
  version: v1beta1
  insecureSkipTLSVerify: true
  groupPriorityMinimum: 100
  versionPriority: 100

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prometheus-adapter
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      name: prometheus-adapter
  template:
    metadata:
      labels:
        name: prometheus-adapter
    spec:
      containers:
        - name: prometheus-adapter
          image: k8s.gcr.io/prometheus-adapter/prometheus-adapter:v0.9.0
          args:
            - --cert-dir=/var/run/serving-cert
            - --config=/etc/adapter/config.yaml
            - --prometheus-url=http://prometheus-server.monitoring.svc:9090
            - --secure-port=6443
          volumeMounts:
            - name: config
              mountPath: /etc/adapter
              readOnly: true
      volumes:
        - name: config
          configMap:
            name: prometheus-adapter-config

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-adapter-config
  namespace: monitoring
data:
  config.yaml: |
    rules:
      # HTTP 请求速率
      - name: http_requests_per_second
        seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace: {resource: "namespace"}
            pod: {resource: "pod"}
        metricsQuery: 'sum(rate(http_requests_total{namespace="<<.Namespace>>",pod=~"<<.Pod>>"}[2m])) by (pod)'

      # 活跃 WebSocket 连接数
      - name: active_websocket_connections
        seriesQuery: 'websocket_active_connections{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace: {resource: "namespace"}
            pod: {resource: "pod"}
        metricsQuery: 'avg(websocket_active_connections{namespace="<<.Namespace>>",pod=~"<<.Pod>>"}) by (pod)'

      # 捕捉请求速率
      - name: catch_requests_per_second
        seriesQuery: 'catch_requests_total{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace: {resource: "namespace"}
            pod: {resource: "pod"}
        metricsQuery: 'sum(rate(catch_requests_total{namespace="<<.Namespace>>",pod=~"<<.Pod>>"}[2m])) by (pod)'

      # GEO 查询延迟
      - name: geo_query_latency_p99
        seriesQuery: 'geo_query_duration_seconds{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace: {resource: "namespace"}
            pod: {resource: "pod"}
        metricsQuery: 'histogram_quantile(0.99, sum(rate(geo_query_duration_seconds_bucket{namespace="<<.Namespace>>",pod=~"<<.Pod>>"}[5m])) by (pod, le))'

      # 数据库连接池使用率
      - name: db_connection_pool_utilization
        seriesQuery: 'db_connection_pool_used{namespace!="",pod!=""}'
        resources:
          overrides:
            namespace: {resource: "namespace"}
            pod: {resource: "pod"}
        metricsQuery: 'avg(db_connection_pool_used{namespace="<<.Namespace>>",pod=~"<<.Pod>>"} / db_connection_pool_size{namespace="<<.Namespace>>",pod=~"<<.Pod>>"}) by (pod) * 100'
```

### 2. VPA 自动资源推荐

```yaml
# infrastructure/k8s/vpa/gateway-vpa.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: gateway-vpa
  namespace: minego
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: gateway
  updatePolicy:
    updateMode: "Auto"  # Auto | Recreate | Initial | Off
  resourcePolicy:
    containerPolicies:
      - containerName: gateway
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 4000m
          memory: 8Gi
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits

---
# infrastructure/k8s/vpa/pokemon-service-vpa.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: pokemon-service-vpa
  namespace: minego
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pokemon-service
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: pokemon-service
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 2000m
          memory: 4Gi

---
# infrastructure/k8s/vpa/location-service-vpa.yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: location-service-vpa
  namespace: minego
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: location-service
  updatePolicy:
    updateMode: "Auto"
  resourcePolicy:
    containerPolicies:
      - containerName: location-service
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 2000m
          memory: 4Gi
```

### 3. 预测性扩容系统

```javascript
// backend/shared/predictiveScaling.js

const { PrometheusDriver } = require('prometheus-query');
const logger = require('./logger');

/**
 * 预测性扩容引擎
 * 基于历史负载数据预测未来负载，提前扩容
 */
class PredictiveScalingEngine {
  constructor(config = {}) {
    this.prometheus = new PrometheusDriver({
      endpoint: config.prometheusUrl || process.env.PROMETHEUS_URL,
    });
    
    // 预测配置
    this.config = {
      predictionWindow: config.predictionWindow || 15 * 60, // 预测未来15分钟
      historyWindow: config.historyWindow || 7 * 24 * 3600, // 使用7天历史数据
      scaleAheadTime: config.scaleAheadTime || 5 * 60, // 提前5分钟扩容
      minConfidence: config.minConfidence || 0.7, // 最低置信度阈值
      ...config
    };
    
    // 服务配置
    this.serviceConfigs = {
      gateway: {
        hpaMin: 2,
        hpaMax: 20,
        metricName: 'http_requests_per_second',
        targetPerPod: 1000,
        scaleThreshold: 0.8, // 当预测负载达到80%时开始扩容
      },
      'catch-service': {
        hpaMin: 3,
        hpaMax: 30,
        metricName: 'catch_requests_per_second',
        targetPerPod: 500,
        scaleThreshold: 0.75,
      },
      'location-service': {
        hpaMin: 2,
        hpaMax: 15,
        metricName: 'geo_query_latency_p99',
        targetPerPod: 200,
        scaleThreshold: 0.7,
      }
    };
    
    // 历史数据缓存
    this.historyCache = new Map();
    this.lastUpdateTime = null;
  }

  /**
   * 从 Prometheus 获取历史负载数据
   */
  async fetchHistoryData(serviceName, metricName) {
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - this.config.historyWindow;
    
    const query = `avg_over_time(${metricName}{namespace="minego",service="${serviceName}"}[7d])`;
    
    try {
      const result = await this.prometheus.rangeQuery(
        query,
        startTime,
        endTime,
        3600 // 每小时一个数据点
      );
      
      return result.result.map(item => ({
        timestamp: item.values[0].time,
        value: parseFloat(item.values[0].value)
      }));
    } catch (error) {
      logger.error('Failed to fetch history data', {
        service: serviceName,
        error: error.message
      });
      return [];
    }
  }

  /**
   * 时间序列分析：检测周期性模式
   */
  analyzePeriodicPattern(historyData) {
    if (historyData.length < 168) { // 至少需要7天数据
      return null;
    }
    
    // 按小时分组，检测日内模式
    const hourlyPattern = new Array(24).fill(0);
    const hourlyCounts = new Array(24).fill(0);
    
    historyData.forEach(point => {
      const hour = new Date(point.timestamp * 1000).getHours();
      hourlyPattern[hour] += point.value;
      hourlyCounts[hour]++;
    });
    
    // 计算每小时平均值
    const hourlyAvg = hourlyPattern.map((sum, i) => 
      hourlyCounts[i] > 0 ? sum / hourlyCounts[i] : 0
    );
    
    // 检测周内模式（工作日 vs 周末）
    const weekdayPattern = new Array(7).fill(0);
    const weekdayCounts = new Array(7).fill(0);
    
    historyData.forEach(point => {
      const day = new Date(point.timestamp * 1000).getDay();
      weekdayPattern[day] += point.value;
      weekdayCounts[day]++;
    });
    
    const weekdayAvg = weekdayPattern.map((sum, i) =>
      weekdayCounts[i] > 0 ? sum / weekdayCounts[i] : 0
    );
    
    return {
      hourly: hourlyAvg,
      weekly: weekdayAvg
    };
  }

  /**
   * 预测未来负载
   */
  async predictFutureLoad(serviceName, predictionWindow) {
    const config = this.serviceConfigs[serviceName];
    if (!config) {
      return null;
    }
    
    // 获取历史数据
    const historyData = await this.fetchHistoryData(serviceName, config.metricName);
    
    // 分析周期性模式
    const pattern = this.analyzePeriodicPattern(historyData);
    if (!pattern) {
      logger.warn('Insufficient data for prediction', { serviceName });
      return null;
    }
    
    // 当前时间
    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    
    // 预测未来负载（基于历史模式）
    const predictions = [];
    const currentBaseLoad = pattern.weekly[currentDay] * pattern.hourly[currentHour] / 
                            (pattern.weekly.reduce((a, b) => a + b, 0) / 7);
    
    for (let i = 0; i < predictionWindow / 60; i++) {
      const futureTime = new Date(now.getTime() + i * 60 * 1000);
      const futureHour = futureTime.getHours();
      const futureDay = futureTime.getDay();
      
      // 基于小时和周模式的预测
      const hourlyFactor = pattern.hourly[futureHour] / 
                          (pattern.hourly.reduce((a, b) => a + b, 0) / 24);
      const weeklyFactor = pattern.weekly[futureDay] / 
                          (pattern.weekly.reduce((a, b) => a + b, 0) / 7);
      
      const predictedLoad = currentBaseLoad * hourlyFactor * weeklyFactor;
      
      predictions.push({
        timestamp: Math.floor(futureTime.getTime() / 1000),
        load: predictedLoad,
        hour: futureHour,
        day: futureDay
      });
    }
    
    // 计算置信度（基于历史数据量和波动性）
    const variance = this.calculateVariance(historyData);
    const confidence = Math.max(0, Math.min(1, 1 - variance / 2));
    
    return {
      service: serviceName,
      predictions,
      confidence,
      pattern: {
        peakHours: this.findPeakHours(pattern.hourly),
        peakDays: this.findPeakDays(pattern.weekly)
      }
    };
  }

  /**
   * 计算方差
   */
  calculateVariance(data) {
    if (data.length === 0) return 1;
    
    const mean = data.reduce((sum, p) => sum + p.value, 0) / data.length;
    const variance = data.reduce((sum, p) => sum + Math.pow(p.value - mean, 2), 0) / data.length;
    
    return Math.sqrt(variance) / mean; // 变异系数
  }

  /**
   * 找出高峰时段
   */
  findPeakHours(hourlyPattern) {
    const sorted = hourlyPattern
      .map((value, hour) => ({ hour, value }))
      .sort((a, b) => b.value - a.value);
    
    return sorted.slice(0, 5).map(p => p.hour);
  }

  /**
   * 找出高峰日期
   */
  findPeakDays(weeklyPattern) {
    const sorted = weeklyPattern
      .map((value, day) => ({ day, value }))
      .sort((a, b) => b.value - a.value);
    
    return sorted.slice(0, 3).map(p => p.day);
  }

  /**
   * 生成扩容建议
   */
  async generateScalingRecommendations() {
    const recommendations = [];
    
    for (const [serviceName, config] of Object.entries(this.serviceConfigs)) {
      const prediction = await this.predictFutureLoad(
        serviceName,
        this.config.predictionWindow
      );
      
      if (!prediction || prediction.confidence < this.config.minConfidence) {
        continue;
      }
      
      // 找出预测窗口内的最大负载
      const maxLoad = Math.max(...prediction.predictions.map(p => p.load));
      const currentReplicas = await this.getCurrentReplicas(serviceName);
      const requiredReplicas = Math.ceil(maxLoad / config.targetPerPod);
      
      // 如果预测负载超过阈值，生成扩容建议
      if (requiredReplicas > currentReplicas && 
          maxLoad / currentReplicas / config.targetPerPod > config.scaleThreshold) {
        recommendations.push({
          service: serviceName,
          action: 'scale_up',
          currentReplicas,
          recommendedReplicas: Math.min(requiredReplicas, config.hpaMax),
          predictedLoad: maxLoad,
          confidence: prediction.confidence,
          peakTime: prediction.predictions.find(p => p.load === maxLoad)?.timestamp,
          executeAt: Math.floor(Date.now() / 1000) + this.config.scaleAheadTime,
          reason: `Predicted load ${maxLoad.toFixed(0)} exceeds threshold`
        });
      }
      
      // 如果预测负载远低于当前容量，生成缩容建议
      const minLoad = Math.min(...prediction.predictions.map(p => p.load));
      const minRequiredReplicas = Math.ceil(minLoad / config.targetPerPod / 0.5); // 50% buffer
      
      if (minRequiredReplicas < currentReplicas - 1 && 
          currentReplicas > config.hpaMin) {
        recommendations.push({
          service: serviceName,
          action: 'scale_down',
          currentReplicas,
          recommendedReplicas: Math.max(minRequiredReplicas, config.hpaMin),
          predictedLoad: minLoad,
          confidence: prediction.confidence,
          reason: `Predicted load ${minLoad.toFixed(0)} allows scale down`
        });
      }
    }
    
    return recommendations;
  }

  /**
   * 获取当前副本数
   */
  async getCurrentReplicas(serviceName) {
    try {
      const result = await this.prometheus.singleQuery(
        `kube_deployment_status_replicas{namespace="minego",deployment="${serviceName}"}`
      );
      
      if (result.result && result.result.length > 0) {
        return parseInt(result.result[0].value[1]);
      }
    } catch (error) {
      logger.error('Failed to get current replicas', {
        service: serviceName,
        error: error.message
      });
    }
    
    return this.serviceConfigs[serviceName]?.hpaMin || 1;
  }

  /**
   * 执行预测性扩容
   */
  async executePredictiveScaling() {
    const recommendations = await this.generateScalingRecommendations();
    const results = [];
    
    for (const rec of recommendations) {
      if (rec.action === 'scale_up' && rec.confidence >= this.config.minConfidence) {
        logger.info('Executing predictive scale up', rec);
        
        // 通过 Kubernetes API 或 kubectl 执行扩容
        // 这里可以集成到 K8s 的 HPA 或直接调用 Deployment API
        
        results.push({
          ...rec,
          status: 'executed',
          timestamp: new Date().toISOString()
        });
      } else {
        logger.info('Skipping scale recommendation', { 
          reason: 'Low confidence',
          recommendation: rec 
        });
      }
    }
    
    return results;
  }
}

// 定时任务：每5分钟检查一次预测性扩容
async function startPredictiveScalingJob() {
  const engine = new PredictiveScalingEngine();
  
  // 立即执行一次
  await engine.executePredictiveScaling();
  
  // 定时执行
  setInterval(async () => {
    try {
      await engine.executePredictiveScaling();
    } catch (error) {
      logger.error('Predictive scaling job failed', { error: error.message });
    }
  }, 5 * 60 * 1000);
  
  logger.info('Predictive scaling job started', {
    interval: '5 minutes'
  });
}

module.exports = {
  PredictiveScalingEngine,
  startPredictiveScalingJob
};
```

### 4. 成本优化仪表板

```javascript
// backend/shared/scalingMetrics.js

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
 * 收集扩缩容指标
 */
async function collectScalingMetrics() {
  const k8s = require('@kubernetes/client-node');
  
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  
  const autoscalingV2 = kc.makeApiClient(k8s.AutoscalingV2Api);
  const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
  const customMetrics = kc.makeApiClient(k8s.Custom_objectsApi);
  
  const namespace = 'minego';
  
  try {
    // 获取所有 HPA
    const hpas = await autoscalingV2.listHorizontalPodAutoscalerForAllNamespaces();
    
    for (const hpa of hpas.body.items) {
      if (hpa.metadata.namespace !== namespace) continue;
      
      const serviceName = hpa.spec.scaleTargetRef.name;
      
      scalingMetrics.hpaMinReplicas.set(
        { service: serviceName, namespace },
        hpa.spec.minReplicas
      );
      
      scalingMetrics.hpaMaxReplicas.set(
        { service: serviceName, namespace },
        hpa.spec.maxReplicas
      );
      
      if (hpa.status) {
        scalingMetrics.hpaCurrentReplicas.set(
          { service: serviceName, namespace },
          hpa.status.currentReplicas || 0
        );
        
        scalingMetrics.hpaDesiredReplicas.set(
          { service: serviceName, namespace },
          hpa.status.desiredReplicas || 0
        );
      }
    }
    
    // 获取所有 Deployment
    const deployments = await appsV1.listNamespacedDeployment(namespace);
    
    for (const deployment of deployments.body.items) {
      const serviceName = deployment.metadata.name;
      const containers = deployment.spec.template.spec.containers;
      
      for (const container of containers) {
        if (container.resources?.requests) {
          const cpuRequest = container.resources.requests.cpu;
          const memoryRequest = container.resources.requests.memory;
          
          // 解析 CPU (e.g., "500m" -> 500)
          const cpuValue = cpuRequest.endsWith('m') 
            ? parseInt(cpuRequest) 
            : parseFloat(cpuRequest) * 1000;
          
          scalingMetrics.vpaCpuRequest.set(
            { service: serviceName, namespace, container: container.name },
            cpuValue
          );
          
          // 解析内存 (e.g., "512Mi" -> 536870912)
          const memValue = memoryRequest.endsWith('Mi')
            ? parseInt(memoryRequest) * 1024 * 1024
            : memoryRequest.endsWith('Gi')
            ? parseInt(memoryRequest) * 1024 * 1024 * 1024
            : parseInt(memoryRequest);
          
          scalingMetrics.vpaMemoryRequest.set(
            { service: serviceName, namespace, container: container.name },
            memValue
          );
        }
      }
      
      // 计算资源利用率效率
      const utilization = await calculateUtilizationEfficiency(serviceName);
      scalingMetrics.resourceUtilizationEfficiency.set(
        { service: serviceName, resource_type: 'cpu' },
        utilization.cpu
      );
      scalingMetrics.resourceUtilizationEfficiency.set(
        { service: serviceName, resource_type: 'memory' },
        utilization.memory
      );
      
      // 计算资源浪费分数
      const wasteScore = calculateWasteScore(utilization);
      scalingMetrics.resourceWasteScore.set(
        { service: serviceName },
        wasteScore
      );
    }
    
  } catch (error) {
    console.error('Failed to collect scaling metrics:', error);
  }
}

/**
 * 计算资源利用率效率
 */
async function calculateUtilizationEfficiency(serviceName) {
  // 从 Prometheus 查询实际使用 vs 请求的比率
  const prometheus = require('./prometheusClient');
  
  try {
    const cpuUtil = await prometheus.query(
      `avg(rate(container_cpu_usage_seconds_total{namespace="minego",pod=~"${serviceName}-.*"}[5m])) / 
       avg(kube_pod_container_resource_requests{namespace="minego",resource="cpu",container="${serviceName}"})`
    );
    
    const memUtil = await prometheus.query(
      `avg(container_memory_working_set_bytes{namespace="minego",pod=~"${serviceName}-.*"}) /
       avg(kube_pod_container_resource_requests{namespace="minego",resource="memory",container="${serviceName}"})`
    );
    
    return {
      cpu: Math.min(1, cpuUtil || 0),
      memory: Math.min(1, memUtil || 0)
    };
  } catch (error) {
    return { cpu: 0.5, memory: 0.5 }; // 默认值
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

module.exports = {
  scalingMetrics,
  collectScalingMetrics
};
```

### 5. 扩缩容 API 路由

```javascript
// backend/gateway/src/routes/autoscaling.js

const express = require('express');
const router = express.Router();
const { PredictiveScalingEngine } = require('../../shared/predictiveScaling');
const { scalingMetrics } = require('../../shared/scalingMetrics');
const authMiddleware = require('../middleware/auth');
const logger = require('../../shared/logger');

const scalingEngine = new PredictiveScalingEngine();

/**
 * GET /api/v1/autoscaling/status
 * 获取所有服务的扩缩容状态
 */
router.get('/status', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const k8s = require('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const autoscalingV2 = kc.makeApiClient(k8s.AutoscalingV2Api);
    
    const hpas = await autoscalingV2.listHorizontalPodAutoscalerForAllNamespaces();
    
    const status = hpas.body.items
      .filter(hpa => hpa.metadata.namespace === 'minego')
      .map(hpa => ({
        service: hpa.spec.scaleTargetRef.name,
        currentReplicas: hpa.status.currentReplicas,
        desiredReplicas: hpa.status.desiredReplicas,
        minReplicas: hpa.spec.minReplicas,
        maxReplicas: hpa.spec.maxReplicas,
        currentMetrics: hpa.status.currentMetrics?.map(m => ({
          type: m.type,
          resource: m.resource?.name,
          current: m.resource?.current?.averageUtilization
        })),
        conditions: hpa.status.conditions?.map(c => ({
          type: c.type,
          status: c.status,
          reason: c.reason,
          message: c.message
        }))
      }));
    
    res.json({
      success: true,
      data: status
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
router.get('/predictions', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const recommendations = await scalingEngine.generateScalingRecommendations();
    
    res.json({
      success: true,
      data: recommendations,
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
router.post('/execute', authMiddleware.requireAdmin, async (req, res) => {
  try {
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
router.get('/efficiency', authMiddleware.requireAdmin, async (req, res) => {
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
 * 生成效率报告
 */
async function generateEfficiencyReport(timeRange) {
  const prometheus = require('../../shared/prometheusClient');
  
  // 查询各服务的资源利用率
  const services = ['gateway', 'catch-service', 'location-service', 'pokemon-service', 'user-service'];
  
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
  
  for (const service of services) {
    const cpuUtil = await prometheus.query(
      `avg_over_time(container_cpu_usage_seconds_total{namespace="minego",pod=~"${service}-.*"}[${timeRange}]) /
       avg_over_time(kube_pod_container_resource_requests{namespace="minego",resource="cpu",container="${service}"}[${timeRange}])`
    );
    
    const memUtil = await prometheus.query(
      `avg_over_time(container_memory_working_set_bytes{namespace="minego",pod=~"${service}-.*"}[${timeRange}]) /
       avg_over_time(kube_pod_container_resource_requests{namespace="minego",resource="memory",container="${service}"}[${timeRange}])`
    );
    
    const avgUtil = (cpuUtil + memUtil) / 2;
    
    // 计算潜在节省
    const potentialSavings = avgUtil < 0.5 ? (0.6 - avgUtil) * 100 : 0;
    
    report.services.push({
      name: service,
      cpuUtilization: cpuUtil.toFixed(2),
      memoryUtilization: memUtil.toFixed(2),
      efficiency: avgUtil < 0.6 ? 'over-provisioned' : avgUtil > 0.9 ? 'under-provisioned' : 'optimal',
      potentialSavings: potentialSavings.toFixed(0) + '%'
    });
    
    if (avgUtil < 0.5) report.summary.overProvisioned++;
    if (avgUtil > 0.9) report.summary.underProvisioned++;
  }
  
  report.summary.averageEfficiency = (
    report.services.reduce((sum, s) => sum + parseFloat(s.cpuUtilization), 0) / services.length
  ).toFixed(2);
  
  return report;
}

module.exports = router;
```

### 6. Grafana 扩缩容仪表板

```json
// infrastructure/k8s/monitoring/grafana-dashboards/autoscaling.json
{
  "dashboard": {
    "title": "mineGo Autoscaling Dashboard",
    "uid": "minego-autoscaling",
    "panels": [
      {
        "title": "HPA Status Overview",
        "type": "table",
        "gridPos": {"x": 0, "y": 0, "w": 24, "h": 8},
        "targets": [
          {
            "expr": "kube_hpa_status_current_replicas{namespace=\"minego\"}",
            "legendFormat": "{{hpa}}"
          }
        ],
        "transformations": [
          {
            "id": "merge",
            "options": {}
          }
        ]
      },
      {
        "title": "Replica Count Over Time",
        "type": "graph",
        "gridPos": {"x": 0, "y": 8, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "hpa_current_replicas{namespace=\"minego\"}",
            "legendFormat": "{{service}} - Current"
          },
          {
            "expr": "hpa_desired_replicas{namespace=\"minego\"}",
            "legendFormat": "{{service}} - Desired"
          }
        ]
      },
      {
        "title": "CPU Utilization vs Request",
        "type": "graph",
        "gridPos": {"x": 12, "y": 8, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "avg(rate(container_cpu_usage_seconds_total{namespace=\"minego\"}[5m])) by (pod) * 100",
            "legendFormat": "{{pod}} - Usage"
          },
          {
            "expr": "kube_pod_container_resource_limits{namespace=\"minego\",resource=\"cpu\"} * 100",
            "legendFormat": "{{pod}} - Limit"
          }
        ]
      },
      {
        "title": "Scaling Events",
        "type": "stat",
        "gridPos": {"x": 0, "y": 16, "w": 6, "h": 4},
        "targets": [
          {
            "expr": "sum(increase(hpa_scaling_events_total{namespace=\"minego\",direction=\"up\"}[24h]))",
            "legendFormat": "Scale Up (24h)"
          }
        ]
      },
      {
        "title": "Predictive Scaling Executions",
        "type": "stat",
        "gridPos": {"x": 6, "y": 16, "w": 6, "h": 4},
        "targets": [
          {
            "expr": "sum(increase(predictive_scaling_executions_total[24h]))",
            "legendFormat": "Executions (24h)"
          }
        ]
      },
      {
        "title": "Resource Waste Score",
        "type": "gauge",
        "gridPos": {"x": 12, "y": 16, "w": 6, "h": 4},
        "targets": [
          {
            "expr": "avg(resource_waste_score{namespace=\"minego\"})",
            "legendFormat": "Avg Waste Score"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "max": 100,
            "min": 0,
            "thresholds": {
              "mode": "absolute",
              "steps": [
                {"color": "green", "value": 0},
                {"color": "yellow", "value": 30},
                {"color": "red", "value": 60}
              ]
            }
          }
        }
      },
      {
        "title": "Estimated Cost Savings",
        "type": "stat",
        "gridPos": {"x": 18, "y": 16, "w": 6, "h": 4},
        "targets": [
          {
            "expr": "sum(estimated_cost_savings_dollars{period=\"monthly\"})",
            "legendFormat": "Monthly Savings ($)"
          }
        ]
      },
      {
        "title": "Prediction Confidence",
        "type": "graph",
        "gridPos": {"x": 0, "y": 20, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "prediction_confidence{namespace=\"minego\"}",
            "legendFormat": "{{service}}"
          }
        ],
        "fieldConfig": {
          "defaults": {
            "max": 1,
            "min": 0
          }
        }
      },
      {
        "title": "Predicted vs Actual Load",
        "type": "graph",
        "gridPos": {"x": 12, "y": 20, "w": 12, "h": 8},
        "targets": [
          {
            "expr": "predicted_load_value{service=\"gateway\"}",
            "legendFormat": "Gateway - Predicted"
          },
          {
            "expr": "rate(http_requests_total{service=\"gateway\"}[5m])",
            "legendFormat": "Gateway - Actual"
          }
        ]
      }
    ]
  }
}
```

## 验收标准

- [ ] HPA 为所有核心服务配置完成（gateway、catch-service、location-service、pokemon-service、user-service）
- [ ] 自定义指标适配器部署并正常工作
- [ ] VPA 为至少 3 个核心服务配置完成
- [ ] 预测性扩容引擎实现并集成
- [ ] 成本优化仪表板在 Grafana 中可用
- [ ] API 端点 `/api/v1/autoscaling/status` 返回所有服务扩缩容状态
- [ ] API 端点 `/api/v1/autoscaling/predictions` 返回预测性扩容建议
- [ ] 扩缩容事件记录到日志和 Prometheus 指标
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 压力测试验证：自动扩容响应时间 < 60 秒
- [ ] 文档完善：包括扩缩容策略说明、调优指南

## 影响范围

### 新增文件
- `infrastructure/k8s/hpa/` - HPA 配置文件（gateway、catch-service、location-service 等）
- `infrastructure/k8s/vpa/` - VPA 配置文件
- `infrastructure/k8s/monitoring/prometheus-adapter.yaml` - 自定义指标适配器
- `infrastructure/k8s/monitoring/grafana-dashboards/autoscaling.json` - 扩缩容仪表板
- `backend/shared/predictiveScaling.js` - 预测性扩容引擎
- `backend/shared/scalingMetrics.js` - 扩缩容指标收集
- `backend/gateway/src/routes/autoscaling.js` - 扩缩容 API 路由
- `backend/tests/unit/autoscaling.test.js` - 单元测试

### 修改文件
- `backend/gateway/src/index.js` - 集成扩缩容 API 路由
- `backend/shared/metrics.js` - 添加扩缩容指标
- `.github/workflows/deploy.yml` - 部署流程集成 VPA/HPA

## 参考

- [Kubernetes HPA 文档](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [Kubernetes VPA 文档](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [Prometheus Adapter](https://github.com/kubernetes-sigs/prometheus-adapter)
- [预测性扩容最佳实践](https://cloud.google.com/kubernetes-engine/docs/concepts/podautoscaling)
