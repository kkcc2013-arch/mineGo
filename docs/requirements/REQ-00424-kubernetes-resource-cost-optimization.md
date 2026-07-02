# REQ-00424：Kubernetes 资源成本优化与智能扩缩容系统

- **编号**：REQ-00424
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务**：k8s/hpa、k8s/vpa、monitoring、admin-dashboard、shared/cost-optimizer
- **创建时间**：2026-07-02 21:53
- **依赖需求**：REQ-00078 金丝雀发布与流量分割系统（已完成）

## 1. 背景与问题

mineGo 项目已在 Kubernetes 上运行 9 个微服务，但当前存在多个成本优化问题：

1. **资源浪费严重**：多数 Pod 配置了过高的 requests/limits，实际使用率仅 15-30%
2. **扩缩容策略简单**：HPA 仅基于 CPU 阈值，未考虑内存、QPS、自定义指标
3. **缺乏成本可视化**：无法按服务/命名空间追踪实际资源成本
4. **闲置资源未回收**：开发/测试环境在非工作时间仍运行，浪费云资源
5. **Spot/Preemptible 实例未利用**：所有工作负载运行在按需实例上

估算当前月度成本约 $5000，通过优化可降低 40-60%。

## 2. 目标

建立智能化的资源成本优化系统：
- 资源利用率从 15-30% 提升至 60-80%
- 月度云成本降低 40% 以上（$2000+/月）
- 扩缩容响应时间 < 60 秒
- 提供按服务/团队的细粒度成本报告
- 自动调度到成本更低的节点类型

## 3. 范围

- **包含**：资源配额优化、智能 HPA/VPA、成本追踪与报告、闲置资源回收、Spot 实例调度
- **不包含**：数据库性能优化（REQ-00331 已创建）、CDN 成本优化（独立需求）

## 4. 详细需求

### 4.1 资源配额智能分析与推荐

```javascript
// shared/cost-optimizer/src/resource-analyzer.js

class ResourceAnalyzer {
  constructor(prometheusClient) {
    this.prometheus = prometheusClient;
    this.metrics = {
      cpu: 'container_cpu_usage_seconds_total',
      memory: 'container_memory_working_set_bytes',
      requests: 'kube_pod_container_resource_requests',
      limits: 'kube_pod_container_resource_limits'
    };
  }

  async analyzeServiceUsage(serviceName, days = 7) {
    const result = {
      service: serviceName,
      analysis: {},
      recommendations: [],
      potentialSavings: 0
    };

    // 1. 获取资源使用历史
    const usageData = await this.getResourceUsage(serviceName, days);
    const requestData = await this.getResourceRequests(serviceName);

    // 2. 计算利用率
    const cpuUtilization = this.calculateUtilization(
      usageData.cpu, requestData.cpu
    );
    const memoryUtilization = this.calculateUtilization(
      usageData.memory, requestData.memory
    );

    // 3. 识别过度配置
    if (cpuUtilization.p95 < 0.3) {
      const recommendedCPU = Math.ceil(usageData.cpu.p95 * 1.5);
      const currentCPU = requestData.cpu;
      const savings = (currentCPU - recommendedCPU) * 24 * 30 * this.cpuCostPerCore;

      result.recommendations.push({
        type: 'cpu_overprovisioned',
        current: currentCPU,
        recommended: recommendedCPU,
        utilization: cpuUtilization,
        savingsPerMonth: savings
      });
      result.potentialSavings += savings;
    }

    if (memoryUtilization.p95 < 0.4) {
      const recommendedMemory = Math.ceil(usageData.memory.p95 * 1.3);
      const currentMemory = requestData.memory;
      const savings = (currentMemory - recommendedMemory) * 24 * 30 * this.memoryCostPerGB / 1024;

      result.recommendations.push({
        type: 'memory_overprovisioned',
        current: currentMemory,
        recommended: recommendedMemory,
        utilization: memoryUtilization,
        savingsPerMonth: savings
      });
      result.potentialSavings += savings;
    }

    // 4. 识别配置不足风险
    if (cpuUtilization.p99 > 0.8 || memoryUtilization.p99 > 0.9) {
      result.recommendations.push({
        type: 'resource_risk',
        severity: 'high',
        message: '资源接近或超过限制，可能导致性能问题',
        utilization: cpuUtilization.p99 > 0.8 ? cpuUtilization : memoryUtilization
      });
    }

    result.analysis = {
      cpuUtilization,
      memoryUtilization,
      dataPoints: usageData.count,
      period: `${days} days`
    };

    return result;
  }

  async generateOptimizationReport() {
    const services = await this.getAllServices();
    const report = {
      timestamp: new Date(),
      totalSavings: 0,
      recommendations: [],
      priority: 'high'
    };

    for (const service of services) {
      const analysis = await this.analyzeServiceUsage(service.name);
      if (analysis.potentialSavings > 0) {
        report.recommendations.push(analysis);
        report.totalSavings += analysis.potentialSavings;
      }
    }

    // 按潜在节省金额排序
    report.recommendations.sort((a, b) => 
      b.potentialSavings - a.potentialSavings
    );

    return report;
  }

  calculateUtilization(usage, requested) {
    return {
      avg: usage.avg / requested,
      p50: usage.p50 / requested,
      p95: usage.p95 / requested,
      p99: usage.p99 / requested,
      max: usage.max / requested
    };
  }
}
```

### 4.2 智能扩缩容策略（多指标 HPA）

```yaml
# k8s/hpa/intelligent-hpa.yaml

apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: catch-service-hpa
  namespace: production
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: catch-service
  minReplicas: 2
  maxReplicas: 20
  metrics:
    # CPU 利用率
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    
    # 内存利用率
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
    
    # 自定义指标：QPS
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
          value: 2    # 或最多缩容2个Pod
          periodSeconds: 60
      selectPolicy: Min  # 选择影响最小的策略
    
    scaleUp:
      stabilizationWindowSeconds: 60
      policies:
        - type: Percent
          value: 100  # 紧急情况可快速扩容
          periodSeconds: 15
        - type: Pods
          value: 4
          periodSeconds: 15
      selectPolicy: Max  # 选择影响最大的策略

---
# 垂直扩缩容建议
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: catch-service-vpa
  namespace: production
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: catch-service
  updatePolicy:
    updateMode: "Auto"  # 自动应用建议
  resourcePolicy:
    containerPolicies:
      - containerName: catch-service
        minAllowed:
          cpu: 100m
          memory: 256Mi
        maxAllowed:
          cpu: 2000m
          memory: 4Gi
        controlledResources: ["cpu", "memory"]
        controlledValues: RequestsAndLimits
```

### 4.3 成本追踪与报告系统

```javascript
// shared/cost-optimizer/src/cost-tracker.js

class CostTracker {
  constructor(k8sClient, prometheusClient) {
    this.k8s = k8sClient;
    this.prometheus = prometheusClient;
    this.prices = {
      cpu: 0.04,      // $/core/hour
      memory: 0.005,  // $/GB/hour
      storage: 0.1    // $/GB/month
    };
  }

  async calculateServiceCost(serviceName, namespace = 'production') {
    const pods = await this.getServicePods(serviceName, namespace);
    const cost = {
      service: serviceName,
      namespace,
      cpu: { cores: 0, cost: 0 },
      memory: { gb: 0, cost: 0 },
      total: 0
    };

    for (const pod of pods) {
      const resources = await this.getPodResources(pod);
      
      cost.cpu.cores += resources.cpu.requestCores;
      cost.memory.gb += resources.memory.requestGB / 1024;
    }

    // 计算小时成本
    cost.cpu.cost = cost.cpu.cores * this.prices.cpu;
    cost.memory.cost = cost.memory.gb * this.prices.memory;
    
    // 月度成本
    cost.total = (cost.cpu.cost + cost.memory.cost) * 24 * 30;

    return cost;
  }

  async generateMonthlyCostReport() {
    const services = await this.getAllServices();
    const report = {
      month: new Date().toISOString().slice(0, 7),
      services: [],
      totalCost: 0,
      costByNamespace: {},
      recommendations: []
    };

    for (const service of services) {
      const cost = await this.calculateServiceCost(
        service.name, 
        service.namespace
      );
      
      report.services.push(cost);
      report.totalCost += cost.total;
      
      if (!report.costByNamespace[service.namespace]) {
        report.costByNamespace[service.namespace] = 0;
      }
      report.costByNamespace[service.namespace] += cost.total;
    }

    // 添加优化建议
    const analyzer = new ResourceAnalyzer(this.prometheus);
    const optimization = await analyzer.generateOptimizationReport();
    report.recommendations = optimization.recommendations;
    report.potentialSavings = optimization.totalSavings;

    // 保存报告
    await this.saveReport(report);

    return report;
  }

  async saveReport(report) {
    // 保存到数据库供历史查询
    await this.db.query(`
      INSERT INTO cost_reports (month, data, created_at)
      VALUES ($1, $2, NOW())
    `, [report.month, JSON.stringify(report)]);
  }
}
```

### 4.4 闲置资源自动回收

```javascript
// shared/cost-optimizer/src/idle-resource-cleaner.js

class IdleResourceCleaner {
  constructor(k8sClient, config) {
    this.k8s = k8sClient;
    this.config = {
      // 非工作时间（UTC）
      offHours: {
        start: 22,  // 22:00 UTC
        end: 6      // 06:00 UTC
      },
      // 开发环境命名空间
      devNamespaces: ['development', 'staging', 'test'],
      // 保留的最小副本数
      minReplicas: {
        development: 0,
        staging: 1,
        test: 0
      }
    };
  }

  async scheduleScaleDown() {
    const hour = new Date().getUTCHours();
    
    // 检查是否在非工作时间
    if (!this.isOffHour(hour)) {
      return;
    }

    for (const namespace of this.config.devNamespaces) {
      const deployments = await this.k8s.listDeployments(namespace);
      
      for (const deployment of deployments) {
        const minReplicas = this.config.minReplicas[namespace] || 0;
        
        // 检查是否有活跃用户
        const hasActiveUsers = await this.checkActiveUsers(namespace);
        
        if (!hasActiveUsers) {
          await this.scaleDown(deployment, minReplicas);
          console.log(`Scaled down ${deployment.metadata.name} in ${namespace}`);
        }
      }
    }
  }

  async scheduleScaleUp() {
    const hour = new Date().getUTCHours();
    
    // 检查是否在工作时间
    if (this.isOffHour(hour)) {
      return;
    }

    for (const namespace of this.config.devNamespaces) {
      const deployments = await this.k8s.listDeployments(namespace);
      
      for (const deployment of deployments) {
        const desiredReplicas = await this.getDesiredReplicas(deployment);
        const currentReplicas = deployment.spec.replicas;
        
        if (currentReplicas < desiredReplicas) {
          await this.scaleUp(deployment, desiredReplicas);
          console.log(`Scaled up ${deployment.metadata.name} in ${namespace}`);
        }
      }
    }
  }

  isOffHour(hour) {
    const { start, end } = this.config.offHours;
    if (start > end) {
      return hour >= start || hour < end;
    }
    return hour >= start && hour < end;
  }

  async checkActiveUsers(namespace) {
    // 检查最近15分钟是否有活跃连接
    const query = `sum(rate(http_requests_total{namespace="${namespace}"}[15m]))`;
    const result = await this.prometheus.query(query);
    
    return result > 0.1;  // 每秒至少0.1个请求
  }
}
```

### 4.5 Spot/Preemptible 实例调度

```yaml
# k8s/node-pools/spot-pool.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: pokemon-service
  namespace: production
spec:
  replicas: 5
  template:
    spec:
      # 优先调度到 Spot 实例
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              preference:
                matchExpressions:
                  - key: cloud.google.com/spot
                    operator: In
                    values:
                      - "true"
                  # 或 AWS Spot
                  - key: ec2.amazonaws.com/spot-instance
                    operator: In
                    values:
                      - "true"
      
      # Spot 实例中断处理
      tolerations:
        - key: "cloud.google.com/spot-preemptible"
          operator: "Equal"
          value: "true"
          effect: "NoSchedule"
      
      # 优雅终止时间
      terminationGracePeriodSeconds: 300
      
      containers:
        - name: pokemon-service
          image: pokemon-service:latest
          # 快速启动和恢复
          readinessProbe:
            initialDelaySeconds: 5
            periodSeconds: 5
          livenessProbe:
            initialDelaySeconds: 10
            periodSeconds: 10

---
# PodDisruptionBudget 确保 Spot 实例中断时服务可用
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: pokemon-service-pdb
  namespace: production
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: pokemon-service
```

### 4.6 数据库 Schema

```sql
-- 成本报告表
CREATE TABLE cost_reports (
  id SERIAL PRIMARY KEY,
  month VARCHAR(7) NOT NULL,  -- 'YYYY-MM'
  data JSONB NOT NULL,
  total_cost DECIMAL(10, 2),
  potential_savings DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(month)
);

CREATE INDEX idx_cost_reports_month ON cost_reports(month);

-- 资源使用历史表
CREATE TABLE resource_usage_history (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  namespace VARCHAR(50) NOT NULL,
  cpu_usage_cores DECIMAL(10, 4),
  memory_usage_gb DECIMAL(10, 4),
  cpu_request_cores DECIMAL(10, 4),
  memory_request_gb DECIMAL(10, 4),
  cpu_utilization DECIMAL(5, 4),
  memory_utilization DECIMAL(5, 4),
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_resource_usage_service ON resource_usage_history(service_name, recorded_at DESC);
CREATE INDEX idx_resource_usage_time ON resource_usage_history(recorded_at);

-- 优化建议表
CREATE TABLE optimization_recommendations (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(100) NOT NULL,
  recommendation_type VARCHAR(50) NOT NULL,
  current_value DECIMAL(10, 4),
  recommended_value DECIMAL(10, 4),
  savings_per_month DECIMAL(10, 2),
  status VARCHAR(20) DEFAULT 'pending',  -- pending, applied, rejected
  applied_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_optimization_status ON optimization_recommendations(status, created_at DESC);
```

### 4.7 Prometheus 指标

```javascript
const costMetrics = {
  // 服务成本
  serviceCost: new Gauge({
    name: 'minego_service_cost_usd_per_month',
    help: 'Monthly cost per service in USD',
    labelNames: ['service', 'namespace', 'resource_type']
  }),

  // 资源利用率
  resourceUtilization: new Gauge({
    name: 'minego_resource_utilization_ratio',
    help: 'Resource utilization ratio',
    labelNames: ['service', 'namespace', 'resource']
  }),

  // 扩缩容事件
  scalingEventsTotal: new Counter({
    name: 'minego_scaling_events_total',
    help: 'Total scaling events',
    labelNames: ['service', 'direction', 'reason']
  }),

  // 成本节省
  costSavings: new Gauge({
    name: 'minego_cost_savings_usd_per_month',
    help: 'Monthly cost savings in USD',
    labelNames: ['service', 'optimization_type']
  }),

  // Spot 实例使用率
  spotInstanceUsage: new Gauge({
    name: 'minego_spot_instance_usage_ratio',
    help: 'Spot instance usage ratio',
    labelNames: ['service']
  })
};
```

## 5. 验收标准

- [ ] 资源分析器：自动识别过度配置的服务，生成优化建议
- [ ] 智能扩缩容：HPA 支持 CPU/内存/QPS/连接数多指标，响应时间 < 60 秒
- [ ] 成本追踪：按服务/命名空间生成月度成本报告
- [ ] 闲置资源回收：开发环境非工作时间自动缩容到 0 或最小副本
- [ ] Spot 实例：至少 30% 的非关键服务运行在 Spot 实例上
- [ ] 成本降低：月度云成本降低 40% 以上
- [ ] 数据库表创建完成，历史数据可查询
- [ ] Prometheus 指标可查询：service_cost、resource_utilization 等
- [ ] 管理后台可查看成本趋势和优化建议
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

XL - 需要实现多个优化模块、K8s 配置、数据库、监控、管理界面

## 7. 优先级理由

P1 - 当前资源利用率低（15-30%），月度成本 $5000+，优化后可节省 $2000+/月，ROI 极高。且智能扩缩容能提升服务稳定性和用户体验。
