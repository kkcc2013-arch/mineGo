# REQ-00273: Kubernetes 资源限制优化与成本监控

- **编号**：REQ-00273
- **类别**：成本/资源优化
- **优先级**：P2
- **状态**：new
- **涉及服务/模块**：k8s/01-deployments、k8s/02-services、monitoring、backend/shared
- **创建时间**：2026-06-19 00:00 UTC
- **依赖需求**：REQ-00028（资源配额管理）

## 1. 背景与问题

当前 mineGo 项目在 Kubernetes 环境中运行，但存在以下资源优化问题：

1. **资源请求配置不合理**：部分服务资源配置过高，导致集群资源浪费
2. **缺少成本监控**：无法准确了解各服务的资源消耗和成本
3. **资源使用不透明**：缺少实时资源使用可视化，难以发现资源瓶颈
4. **自动扩缩容效率低**：HPA 配置不够精细，扩缩容响应慢

代码现状：
- `k8s/01-deployments/` 中各服务的资源请求和限制配置基于估算，未经实际负载验证
- 缺少成本分摊和资源使用效率分析工具
- Prometheus 已采集资源指标，但缺少成本维度的聚合分析
- HPA 配置基于 CPU 使用率，未考虑内存和自定义指标

## 2. 目标

实现 Kubernetes 资源优化和成本监控系统：

1. **资源配额优化**：基于实际负载数据调整各服务的资源请求和限制
2. **成本监控仪表板**：展示各服务、命名空间的资源消耗和成本
3. **资源使用效率分析**：识别资源浪费和优化机会
4. **智能扩缩容**：基于多维度指标的 HPA 和 VPA 配置

预期收益：
- 降低云资源成本 20-30%
- 提高集群资源利用率
- 优化服务性能和稳定性

## 3. 范围

### 包含
- 资源使用数据采集和分析
- 成本估算和分摊模型
- 资源配置优化建议生成器
- 成本监控仪表板（Grafana）
- 多维度 HPA 和 VPA 配置
- 资源优化报告生成

### 不包含
- 云厂商账单集成（后续需求）
- Spot/Preemptible 实例管理
- 集群自动扩缩容（Cluster Autoscaler）
- GPU 资源调度优化

## 4. 详细需求

### 4.1 资源使用数据采集

```javascript
// backend/shared/ResourceMonitor.js
const Prometheus = require('prom-client');
const client = require('prom-client');

class ResourceMonitor {
  constructor() {
    this.registry = new client.Registry();
    
    // 资源使用指标
    this.metrics = {
      cpuUsage: new client.Gauge({
        name: 'container_cpu_usage_seconds_total',
        help: 'Container CPU usage in seconds',
        labelNames: ['service', 'namespace', 'pod'],
        registers: [this.registry]
      }),
      
      memoryUsage: new client.Gauge({
        name: 'container_memory_working_set_bytes',
        help: 'Container memory working set in bytes',
        labelNames: ['service', 'namespace', 'pod'],
        registers: [this.registry]
      }),
      
      resourceRequests: new client.Gauge({
        name: 'kube_pod_container_resource_requests',
        help: 'Container resource requests',
        labelNames: ['service', 'namespace', 'resource', 'unit'],
        registers: [this.registry]
      }),
      
      resourceLimits: new client.Gauge({
        name: 'kube_pod_container_resource_limits',
        help: 'Container resource limits',
        labelNames: ['service', 'namespace', 'resource', 'unit'],
        registers: [this.registry]
      }),
      
      resourceEfficiency: new client.Gauge({
        name: 'resource_efficiency_ratio',
        help: 'Resource usage vs requests ratio',
        labelNames: ['service', 'namespace', 'resource_type'],
        registers: [this.registry]
      }),
      
      estimatedCost: new client.Gauge({
        name: 'estimated_hourly_cost_usd',
        help: 'Estimated hourly cost in USD',
        labelNames: ['service', 'namespace', 'resource_type'],
        registers: [this.registry]
      })
    };
  }
  
  /**
   * 计算资源使用效率
   */
  async calculateResourceEfficiency(service, namespace) {
    const usage = await this.getResourceUsage(service, namespace);
    const requests = await this.getResourceRequests(service, namespace);
    
    const cpuEfficiency = usage.cpu / requests.cpu;
    const memoryEfficiency = usage.memory / requests.memory;
    
    this.metrics.resourceEfficiency.set(
      { service, namespace, resource_type: 'cpu' },
      cpuEfficiency
    );
    
    this.metrics.resourceEfficiency.set(
      { service, namespace, resource_type: 'memory' },
      memoryEfficiency
    );
    
    return {
      cpu: cpuEfficiency,
      memory: memoryEfficiency,
      overall: (cpuEfficiency + memoryEfficiency) / 2
    };
  }
  
  /**
   * 估算服务成本
   */
  async estimateServiceCost(service, namespace) {
    // AWS 价格模型（示例）
    const pricing = {
      cpuPerCoreHour: 0.043, // $0.043 per vCPU-hour
      memoryPerGBHour: 0.005 // $0.005 per GB-hour
    };
    
    const requests = await this.getResourceRequests(service, namespace);
    const usage = await this.getResourceUsage(service, namespace);
    
    // 按请求估算成本
    const requestCost = 
      (requests.cpu * pricing.cpuPerCoreHour) +
      (requests.memory / 1024 * pricing.memoryPerGBHour);
    
    // 按实际使用估算成本
    const usageCost = 
      (usage.cpu * pricing.cpuPerCoreHour) +
      (usage.memory / 1024 * pricing.memoryPerGBHour);
    
    const wasteCost = requestCost - usageCost;
    
    this.metrics.estimatedCost.set(
      { service, namespace, resource_type: 'request' },
      requestCost
    );
    
    this.metrics.estimatedCost.set(
      { service, namespace, resource_type: 'usage' },
      usageCost
    );
    
    return {
      requestCost,
      usageCost,
      wasteCost,
      efficiency: usageCost / requestCost
    };
  }
}
```

### 4.2 成本分析报告生成器

```javascript
// backend/shared/CostAnalyzer.js
class CostAnalyzer {
  constructor(k8sClient, prometheusClient) {
    this.k8s = k8sClient;
    this.prometheus = prometheusClient;
    this.pricingModel = new PricingModel();
  }
  
  /**
   * 生成成本分析报告
   */
  async generateCostReport(namespace) {
    const deployments = await this.k8s.listDeployments(namespace);
    const report = {
      timestamp: new Date().toISOString(),
      namespace,
      services: [],
      summary: {
        totalRequestCost: 0,
        totalUsageCost: 0,
        totalWasteCost: 0,
        averageEfficiency: 0
      }
    };
    
    for (const deployment of deployments) {
      const analysis = await this.analyzeDeployment(deployment);
      report.services.push(analysis);
      
      report.summary.totalRequestCost += analysis.cost.requestCost;
      report.summary.totalUsageCost += analysis.cost.usageCost;
      report.summary.totalWasteCost += analysis.cost.wasteCost;
    }
    
    report.summary.averageEfficiency = 
      report.summary.totalUsageCost / report.summary.totalRequestCost;
    
    // 优化建议
    report.recommendations = this.generateRecommendations(report);
    
    return report;
  }
  
  /**
   * 分析单个 Deployment
   */
  async analyzeDeployment(deployment) {
    const name = deployment.metadata.name;
    const namespace = deployment.metadata.namespace;
    
    // 获取资源配置
    const containers = deployment.spec.template.spec.containers;
    const requests = this.extractResourceRequests(containers);
    const limits = this.extractResourceLimits(containers);
    
    // 获取实际使用（过去 7 天平均）
    const usage = await this.getActualUsage(name, namespace, '7d');
    
    // 计算效率
    const efficiency = {
      cpu: usage.cpu.avg / requests.cpu,
      memory: usage.memory.avg / requests.memory,
      overall: 0
    };
    efficiency.overall = (efficiency.cpu + efficiency.memory) / 2;
    
    // 估算成本
    const cost = await this.pricingModel.estimateCost(
      requests,
      usage,
      namespace
    );
    
    return {
      name,
      namespace,
      requests,
      limits,
      usage,
      efficiency,
      cost,
      status: this.evaluateStatus(efficiency)
    };
  }
  
  /**
   * 生成优化建议
   */
  generateRecommendations(report) {
    const recommendations = [];
    
    for (const service of report.services) {
      // CPU 使用率过低
      if (service.efficiency.cpu < 0.3) {
        recommendations.push({
          service: service.name,
          type: 'reduce-cpu-request',
          severity: 'high',
          message: `CPU 请求 ${service.requests.cpu} cores，但实际使用仅 ${(service.efficiency.cpu * 100).toFixed(1)}%`,
          saving: service.cost.wasteCost * 0.7,
          suggestedValue: Math.ceil(service.usage.cpu.avg * 1.5)
        });
      }
      
      // 内存使用率过低
      if (service.efficiency.memory < 0.4) {
        recommendations.push({
          service: service.name,
          type: 'reduce-memory-request',
          severity: 'high',
          message: `内存请求 ${service.requests.memory} MB，但实际使用仅 ${(service.efficiency.memory * 100).toFixed(1)}%`,
          saving: service.cost.wasteCost * 0.3,
          suggestedValue: Math.ceil(service.usage.memory.avg * 1.3)
        });
      }
      
      // CPU 接近限制
      if (service.usage.cpu.max > service.limits.cpu * 0.9) {
        recommendations.push({
          service: service.name,
          type: 'increase-cpu-limit',
          severity: 'medium',
          message: `CPU 使用峰值 ${service.usage.cpu.max.toFixed(2)} 接近限制 ${service.limits.cpu}`,
          suggestedValue: Math.ceil(service.limits.cpu * 1.5)
        });
      }
      
      // 内存接近限制
      if (service.usage.memory.max > service.limits.memory * 0.9) {
        recommendations.push({
          service: service.name,
          type: 'increase-memory-limit',
          severity: 'high',
          message: `内存使用峰值 ${service.usage.memory.max} MB 接近限制 ${service.limits.memory} MB`,
          suggestedValue: Math.ceil(service.limits.memory * 1.5)
        });
      }
    }
    
    // 按节省成本排序
    recommendations.sort((a, b) => (b.saving || 0) - (a.saving || 0));
    
    return recommendations;
  }
}

/**
 * 定价模型
 */
class PricingModel {
  constructor() {
    // AWS 定价（示例，实际应从 API 获取）
    this.prices = {
      'us-east-1': {
        cpu: 0.043,    // $/vCPU-hour
        memory: 0.005  // $/GB-hour
      },
      'us-west-2': {
        cpu: 0.046,
        memory: 0.0053
      },
      'eu-west-1': {
        cpu: 0.049,
        memory: 0.0056
      }
    };
    
    this.defaultRegion = 'us-east-1';
  }
  
  async estimateCost(requests, usage, namespace) {
    const region = this.getRegionForNamespace(namespace);
    const pricing = this.prices[region] || this.prices[this.defaultRegion];
    
    const requestCost = 
      (requests.cpu * pricing.cpu) +
      (requests.memory / 1024 * pricing.memory);
    
    const usageCost = 
      (usage.cpu.avg * pricing.cpu) +
      (usage.memory.avg / 1024 * pricing.memory);
    
    return {
      requestCost,
      usageCost,
      wasteCost: requestCost - usageCost,
      hourlyRate: requestCost,
      dailyRate: requestCost * 24,
      monthlyRate: requestCost * 24 * 30
    };
  }
  
  getRegionForNamespace(namespace) {
    // 从命名空间推断区域
    // 实际应从配置或标签获取
    return this.defaultRegion;
  }
}
```

### 4.3 资源优化建议器

```javascript
// backend/shared/ResourceOptimizer.js
class ResourceOptimizer {
  constructor() {
    this.thresholds = {
      cpu: {
        underUtilized: 0.3,    // 使用率 < 30% 认为低效
        optimal: [0.5, 0.7],   // 50-70% 为最优范围
        overUtilized: 0.8       // 使用率 > 80% 需扩容
      },
      memory: {
        underUtilized: 0.4,
        optimal: [0.6, 0.75],
        overUtilized: 0.85
      }
    };
  }
  
  /**
   * 生成资源配置建议
   */
  async generateResourceRecommendations(service) {
    const usage = await this.getUsageMetrics(service);
    const current = await this.getCurrentConfig(service);
    
    const recommendations = {
      cpu: this.analyzeResource('cpu', usage.cpu, current.cpu),
      memory: this.analyzeResource('memory', usage.memory, current.memory)
    };
    
    return {
      service: service.name,
      current,
      usage,
      recommendations,
      yamlPatch: this.generateYAMLPatch(recommendations)
    };
  }
  
  /**
   * 分析资源配置
   */
  analyzeResource(type, usage, current) {
    const threshold = this.thresholds[type];
    const utilization = usage.avg / current.request;
    
    if (utilization < threshold.underUtilized) {
      // 降低请求和限制
      return {
        action: 'reduce',
        currentRequest: current.request,
        recommendedRequest: Math.ceil(usage.avg * 1.5),
        currentLimit: current.limit,
        recommendedLimit: Math.ceil(usage.max * 1.5),
        reasoning: `${type} 使用率 ${(utilization * 100).toFixed(1)}% 过低，建议降低请求`,
        estimatedSaving: this.calculateSaving(type, current.request, usage.avg * 1.5)
      };
    } else if (utilization > threshold.overUtilized) {
      // 增加请求和限制
      return {
        action: 'increase',
        currentRequest: current.request,
        recommendedRequest: Math.ceil(usage.avg * 1.3),
        currentLimit: current.limit,
        recommendedLimit: Math.ceil(usage.max * 1.5),
        reasoning: `${type} 使用率 ${(utilization * 100).toFixed(1)}% 过高，建议增加资源`,
        priority: 'high'
      };
    } else {
      // 保持当前配置
      return {
        action: 'maintain',
        currentRequest: current.request,
        recommendedRequest: current.request,
        currentLimit: current.limit,
        recommendedLimit: current.limit,
        reasoning: `${type} 使用率 ${(utilization * 100).toFixed(1)}% 在合理范围内`
      };
    }
  }
  
  /**
   * 生成 YAML 补丁
   */
  generateYAMLPatch(recommendations) {
    const patch = {
      spec: {
        template: {
          spec: {
            containers: [{
              name: 'main',
              resources: {
                requests: {},
                limits: {}
              }
            }]
          }
        }
      }
    };
    
    if (recommendations.cpu.action !== 'maintain') {
      patch.spec.template.spec.containers[0].resources.requests.cpu = 
        `${recommendations.cpu.recommendedRequest}m`;
      patch.spec.template.spec.containers[0].resources.limits.cpu = 
        `${recommendations.cpu.recommendedLimit}m`;
    }
    
    if (recommendations.memory.action !== 'maintain') {
      patch.spec.template.spec.containers[0].resources.requests.memory = 
        `${recommendations.memory.recommendedRequest}Mi`;
      patch.spec.template.spec.containers[0].resources.limits.memory = 
        `${recommendations.memory.recommendedLimit}Mi`;
    }
    
    return patch;
  }
}
```

### 4.4 Grafana 成本仪表板

```json
{
  "dashboard": {
    "title": "Kubernetes Resource Cost Dashboard",
    "panels": [
      {
        "title": "Total Cluster Cost",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(estimated_hourly_cost_usd) * 24 * 30",
            "legendFormat": "Monthly Cost"
          }
        ]
      },
      {
        "title": "Cost by Service",
        "type": "piechart",
        "targets": [
          {
            "expr": "sum(estimated_hourly_cost_usd) by (service)",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "Resource Efficiency by Service",
        "type": "bargauge",
        "targets": [
          {
            "expr": "avg(resource_efficiency_ratio) by (service)",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "CPU Usage vs Requests",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(container_cpu_usage_seconds_total) by (service)",
            "legendFormat": "{{service}} Usage"
          },
          {
            "expr": "sum(kube_pod_container_resource_requests{resource='cpu'}) by (service)",
            "legendFormat": "{{service}} Request"
          }
        ]
      },
      {
        "title": "Memory Usage vs Requests",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(container_memory_working_set_bytes) by (service)",
            "legendFormat": "{{service}} Usage"
          },
          {
            "expr": "sum(kube_pod_container_resource_requests{resource='memory'}) by (service)",
            "legendFormat": "{{service}} Request"
          }
        ]
      },
      {
        "title": "Cost Trend (7 days)",
        "type": "graph",
        "targets": [
          {
            "expr": "sum(estimated_hourly_cost_usd) by (service)",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "Resource Waste",
        "type": "table",
        "targets": [
          {
            "expr": "sum(estimated_hourly_cost_usd{resource_type='waste'}) by (service)",
            "format": "table"
          }
        ]
      }
    ]
  }
}
```

### 4.5 HPA 多维度配置

```yaml
# k8s/01-deployments/gateway-hpa.yaml
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
  minReplicas: 3
  maxReplicas: 20
  metrics:
  # CPU 使用率
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  
  # 内存使用率
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 75
  
  # 自定义指标：请求速率
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: 1000
  
  # 自定义指标：连接数
  - type: Pods
    pods:
      metric:
        name: active_websocket_connections
      target:
        type: AverageValue
        averageValue: 500
  
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
      - type: Percent
        value: 10
        periodSeconds: 60
      - type: Pods
        value: 2
        periodSeconds: 60
      selectPolicy: Min
    
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
      - type: Percent
        value: 100
        periodSeconds: 15
      - type: Pods
        value: 4
        periodSeconds: 15
      selectPolicy: Max
```

### 4.6 成本报告 API

```javascript
// backend/services/monitoring/routes/cost-routes.js
const express = require('express');
const router = express.Router();
const CostAnalyzer = require('../../shared/CostAnalyzer');
const auth = require('../../shared/auth-middleware');

const costAnalyzer = new CostAnalyzer();

/**
 * GET /api/cost/report
 * 获取成本分析报告
 */
router.get('/report', auth.requireAdmin, async (req, res) => {
  try {
    const { namespace = 'minego', period = '7d' } = req.query;
    
    const report = await costAnalyzer.generateCostReport(namespace, period);
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cost/services/:serviceName
 * 获取单个服务的成本分析
 */
router.get('/services/:serviceName', auth.requireAdmin, async (req, res) => {
  try {
    const { serviceName } = req.params;
    const { namespace = 'minego' } = req.query;
    
    const analysis = await costAnalyzer.analyzeService(serviceName, namespace);
    
    res.json({
      success: true,
      data: analysis
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cost/recommendations
 * 获取优化建议
 */
router.get('/recommendations', auth.requireAdmin, async (req, res) => {
  try {
    const { namespace = 'minego' } = req.query;
    
    const recommendations = await costAnalyzer.getAllRecommendations(namespace);
    
    res.json({
      success: true,
      data: recommendations
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/cost/apply-recommendation
 * 应用优化建议
 */
router.post('/apply-recommendation', auth.requireAdmin, async (req, res) => {
  try {
    const { service, type, value } = req.body;
    
    const result = await costAnalyzer.applyRecommendation(service, type, value);
    
    res.json({
      success: true,
      message: `Recommendation applied to ${service}`,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

## 5. 验收标准

- [ ] 资源使用数据采集准确率 100%
- [ ] 成本估算误差 < 15%
- [ ] 成本监控仪表板实时显示资源消耗
- [ ] 优化建议生成器识别出至少 5 个优化机会
- [ ] 应用优化建议后资源成本降低 ≥ 20%
- [ ] HPA 基于多维度指标正常工作
- [ ] 所有服务资源配置在最优范围内（CPU 50-70%，内存 60-75%）
- [ ] Prometheus 指标采集正常
- [ ] 成本报告 API 正常响应
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**规模：M**

理由：
- 需要开发资源监控和成本分析模块
- 配置 Prometheus 指标和 Grafana 仪表板
- 实现优化建议生成器
- 配置多维度 HPA
- 测试和验证工作量中等

预计工时：3-4 天

## 7. 优先级理由

P2 优先级，原因：
- 成本优化对生产环境有直接经济价值
- 当前资源配置存在明显浪费
- 不影响核心功能，但能提升整体效率
- 为未来大规模部署奠定基础
