# REQ-00375：多云成本分摊与资源归因优化系统

- **编号**：REQ-00375
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/CostAllocator.js、backend/shared/ResourceAttributionEngine.js、infrastructure/k8s、admin-dashboard、Prometheus、Grafana
- **创建时间**：2026-06-29 23:10 UTC
- **依赖需求**：REQ-00374（云成本异常检测）、REQ-00212（云资源利用率成本归因）

## 1. 背景与问题

### 现状分析

mineGo 项目已具备云成本监控能力（REQ-00374），但缺少精细化成本分摊机制：

1. **成本归因模糊**：无法将云资源成本精确归因到具体业务模块或用户行为
2. **跨服务成本难以分摊**：gateway 服务消耗资源但服务于多个下游服务，成本分摊比例不清晰
3. **缺乏成本中心概念**：无法按业务域（捕捉/社交/支付/道馆）统计成本
4. **无成本决策支持**：无法基于成本数据做出"哪个功能成本高"的决策
5. **多云/混合云场景缺失**：AWS/GCP/Azure 资源成本无法统一管理

### 业务影响

- 团队无法量化每个业务功能的真实运营成本
- 无法基于成本数据进行功能优先级排序
- 成本超预算时无法快速定位高消耗模块
- 跨团队项目成本分摊争议无法数据化解决

## 2. 目标

构建多云成本分摊与资源归因优化系统：

1. **成本中心管理**：定义业务域成本中心（捕捉、社交、支付、道馆、基础设施）
2. **资源归因引擎**：自动归因 K8s Pod、Redis 内存、数据库连接、带宽消耗到成本中心
3. **多云成本聚合**：支持 AWS/GCP/Azure 成本数据统一采集与分析
4. **成本分摊算法**：gateway/共享资源成本按流量比例分摊到下游服务
5. **成本决策仪表板**：可视化各成本中心的月度成本趋势、归因明细、优化建议

## 3. 范围

### 包含

- 成本中心定义与配置管理（CostCenterManager）
- 资源归因引擎（ResourceAttributionEngine）
- 多云成本数据采集适配器（AWS/GCP/Azure）
- 共享资源成本分摊算法（流量比例/请求比例/连接比例）
- Prometheus 指标导出与 Grafana 仪表板
- API 端点：查询成本中心成本、归因明细、优化建议

### 不包含

- 云厂商账单管理系统（已有支付系统）
- 成本预算审批流程（管理流程）
- 自动资源缩容决策执行（仅提建议）

## 4. 详细需求

### 4.1 成本中心定义

```javascript
// backend/shared/CostCenterManager.js
const DEFAULT_COST_CENTERS = {
  'catch': {
    name: '精灵捕捉业务域',
    services: ['catch-service', 'location-service'],
    responsibleTeam: 'catch-team',
    budgetLimit: 5000 // USD/month
  },
  'social': {
    name: '社交互动业务域',
    services: ['social-service', 'user-service'],
    responsibleTeam: 'social-team',
    budgetLimit: 3000
  },
  'payment': {
    name: '支付交易业务域',
    services: ['payment-service'],
    responsibleTeam: 'payment-team',
    budgetLimit: 2000
  },
  'gym': {
    name: '道馆战斗业务域',
    services: ['gym-service'],
    responsibleTeam: 'gym-team',
    budgetLimit: 4000
  },
  'infrastructure': {
    name: '基础设施共享',
    services: ['gateway', 'postgres', 'redis', 'kafka'],
    responsibleTeam: 'sre-team',
    budgetLimit: 10000
  }
};
```

### 4.2 资源归因规则

```javascript
// 资源归因维度
const ATTRIBUTION_DIMENSIONS = {
  CPU: {
    metric: 'container_cpu_usage_seconds_total',
    unitCost: 0.05 // USD/core-hour
  },
  MEMORY: {
    metric: 'container_memory_working_set_bytes',
    unitCost: 0.02 // USD/GB-hour
  },
  NETWORK: {
    metric: 'container_network_transmit_bytes_total',
    unitCost: 0.08 // USD/GB
  },
  STORAGE: {
    metric: 'kubelet_volume_stats_used_bytes',
    unitCost: 0.01 // USD/GB-hour
  },
  DATABASE: {
    metric: 'pg_database_size_bytes',
    unitCost: 0.15 // USD/GB-hour
  },
  REDIS: {
    metric: 'redis_memory_used_bytes',
    unitCost: 0.10 // USD/GB-hour
  }
};
```

### 4.3 共享资源分摊算法

```javascript
// Gateway 成本分摊（按请求比例）
function allocateGatewayCost(totalCost, downstreamRequests) {
  const allocation = {};
  const totalRequests = sum(downstreamRequests.values());
  
  for (const [service, requests] of downstreamRequests) {
    const ratio = requests / totalRequests;
    allocation[service] = totalCost * ratio;
  }
  
  return allocation;
}

// Redis 成本分摊（按内存使用比例）
function allocateRedisCost(totalCost, serviceMemoryUsage) {
  const allocation = {};
  const totalMemory = sum(serviceMemoryUsage.values());
  
  for (const [service, memory] of serviceMemoryUsage) {
    const ratio = memory / totalMemory;
    allocation[service] = totalCost * ratio;
  }
  
  return allocation;
}

// PostgreSQL 成本分摊（按数据库大小）
function allocateDatabaseCost(totalCost, databaseSizes) {
  const allocation = {};
  const totalSize = sum(databaseSizes.values());
  
  for (const [db, size] of databaseSizes) {
    const ratio = size / totalSize;
    allocation[db] = totalCost * ratio;
  }
  
  return allocation;
}
```

### 4.4 多云成本采集

```javascript
// AWS Cost Explorer API 适配器
class AwsCostAdapter {
  async fetchCost(startDate, endDate) {
    const client = new AWS.CostExplorer();
    const result = await client.getCostAndUsage({
      TimePeriod: { Start: startDate, End: endDate },
      Granularity: 'DAILY',
      Metrics: ['BlendedCost', 'UsageQuantity'],
      GroupBy: [{ Type: 'SERVICE', Key: 'Amazon EC2' }]
    });
    return this.parseResult(result);
  }
}

// GCP Cloud Billing API 适配器
class GcpCostAdapter {
  async fetchCost(startDate, endDate) {
    const client = new CloudBillingClient();
    const result = await client.getCloudBillingAccount({
      billingAccount: this.billingAccount,
      startDate,
      endDate
    });
    return this.parseResult(result);
  }
}

// Azure Cost Management API 适配器
class AzureCostAdapter {
  async fetchCost(startDate, endDate) {
    const client = new AzureCostManagement();
    const result = await client.queryUsage({
      subscriptionId: this.subscriptionId,
      timeframe: { from: startDate, to: endDate }
    });
    return this.parseResult(result);
  }
}
```

### 4.5 Prometheus 指标导出

```javascript
const metrics = {
  costCenterTotalGauge: new Gauge({
    name: 'minego_cost_center_total_usd',
    help: 'Total cost for cost center',
    labelNames: ['center', 'month']
  }),
  costCenterAllocatedGauge: new Gauge({
    name: 'minego_cost_center_allocated_usd',
    help: 'Allocated cost for cost center',
    labelNames: ['center', 'source']
  }),
  resourceAttributionGauge: new Gauge({
    name: 'minego_resource_attribution_usd',
    help: 'Resource cost attribution',
    labelNames: ['resource_type', 'service', 'cost_center']
  }),
  costSharingRatioGauge: new Gauge({
    name: 'minego_cost_sharing_ratio',
    help: 'Cost sharing ratio for shared resources',
    labelNames: ['service', 'resource']
  }),
  budgetUtilizationGauge: new Gauge({
    name: 'minego_budget_utilization_ratio',
    help: 'Budget utilization ratio',
    labelNames: ['cost_center']
  })
};
```

### 4.6 API 端点

```javascript
// gateway/src/routes/cost.js

// 查询成本中心汇总
router.get('/cost/centers', async (req, res) => {
  const summary = await CostAllocator.getCostCenterSummary();
  res.json({
    centers: summary,
    totalMonthlyCost: sum(summary.map(s => s.totalCost)),
    optimizationSuggestions: generateOptimizations(summary)
  });
});

// 查询资源归因明细
router.get('/cost/attribution/:center', async (req, res) => {
  const attribution = await ResourceAttributionEngine.getAttribution(req.params.center);
  res.json({
    center: req.params.center,
    resources: attribution,
    total: sum(attribution.map(a => a.cost))
  });
});

// 查询共享资源分摊
router.get('/cost/sharing', async (req, res) => {
  const sharing = await CostAllocator.getSharedResourceAllocation();
  res.json(sharing);
});

// 查询优化建议
router.get('/cost/optimization', async (req, res) => {
  const suggestions = await CostOptimizer.generateSuggestions();
  res.json({
    suggestions,
    estimatedSavings: sum(suggestions.map(s => s.estimatedSaving))
  });
});
```

## 5. 验收标准（可测试）

- [ ] 创建 `backend/shared/CostCenterManager.js` - 成本中心管理模块
- [ ] 创建 `backend/shared/ResourceAttributionEngine.js` - 资源归因引擎
- [ ] 创建多云成本适配器（AWS/GCP/Azure）
- [ ] 成本分摊算法验证（gateway 按请求比例分摊误差 < 1%）
- [ ] Redis 成本按内存使用比例分摊
- [ ] PostgreSQL 成本按数据库大小分摊
- [ ] Prometheus 指标正确导出：`minego_cost_*` 系列
- [ ] Grafana 仪表板显示各成本中心月度成本
- [ ] API `/cost/centers` 返回成本中心汇总
- [ ] API `/cost/optimization` 返回优化建议
- [ ] 单元测试覆盖率 > 85%
- [ ] 预算利用率超过 80% 时告警

## 6. 工作量估算

**L** - 涉及多云适配器开发、分摊算法设计、成本中心管理、Grafana 仪表板、API 端点

## 7. 优先级理由

**P1** - 成本归因是运营决策的关键：
- REQ-00374 实现了成本监控，但缺少精细化归因
- 成本分摊支持跨团队项目成本公平分配
- 成本数据驱动的优化决策可节省 15-30% 云成本
- 为后续成本优化（如自动缩容决策）提供数据基础