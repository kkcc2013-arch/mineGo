# REQ-00212: 云资源利用率分析与成本归因系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00212 |
| 标题 | 云资源利用率分析与成本归因系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | infrastructure/k8s、gateway、所有微服务、backend/shared、admin-dashboard |
| 创建时间 | 2026-06-14 22:00 |

## 需求描述

### 背景
随着 mineGo 项目规模的扩大，云基础设施成本持续增长。当前缺乏精细化的资源利用率分析和成本归因机制，导致：
- 无法准确识别资源浪费（如低利用率 Pod、空闲实例）
- 无法按业务模块/服务归因成本，影响预算分配决策
- 缺乏成本趋势预测，难以提前预警预算超支

### 目标
构建一套云资源利用率分析与成本归因系统，实现：
1. **资源利用率监控**：实时跟踪 CPU、内存、存储、网络等资源利用率
2. **成本归因分析**：按服务、业务模块、用户层级归因云成本
3. **浪费检测告警**：自动识别低利用率资源并推送优化建议
4. **成本趋势预测**：基于历史数据预测未来成本趋势
5. **优化建议生成**：自动生成资源优化建议（如缩容、删除闲置资源）

## 技术方案

### 1. 资源利用率数据采集层

#### 1.1 Kubernetes Metrics 采集器
```javascript
// backend/shared/costTracker/metricsCollector.js

const k8s = require('@kubernetes/client-node');
const promClient = require('prom-client');

class MetricsCollector {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.metricsApi = this.kc.makeApiClient(k8s.MetricsApi);
    this.customMetricsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);
    
    // 注册 Prometheus 指标
    this.resourceUsageGauge = new promClient.Gauge({
      name: 'minego_resource_usage_ratio',
      help: 'Resource usage ratio by service',
      labelNames: ['service', 'resource_type', 'namespace']
    });
    
    this.costAttributionGauge = new promClient.Gauge({
      name: 'minego_cost_attribution_dollars',
      help: 'Cost attribution in dollars by service',
      labelNames: ['service', 'cost_category', 'period']
    });
  }
  
  /**
   * 采集 Pod 级别资源利用率
   */
  async collectPodMetrics() {
    const metrics = await this.metricsApi.listPodMetricsForAllNamespaces();
    const usageData = [];
    
    for (const item of metrics.body.items) {
      const serviceName = item.metadata.labels?.['app.kubernetes.io/name'] || 
                          item.metadata.labels?.app || 
                          'unknown';
      
      const cpuUsage = this.parseCpu(item.containers[0].usage.cpu);
      const memoryUsage = this.parseMemory(item.containers[0].usage.memory);
      
      // 获取资源请求/限制
      const limits = await this.getResourceLimits(item.metadata.name, item.metadata.namespace);
      
      const cpuRatio = limits.cpuRequest > 0 ? cpuUsage / limits.cpuRequest : 0;
      const memoryRatio = limits.memoryRequest > 0 ? memoryUsage / limits.memoryRequest : 0;
      
      usageData.push({
        pod: item.metadata.name,
        namespace: item.metadata.namespace,
        service: serviceName,
        cpuUsage,
        memoryUsage,
        cpuRequest: limits.cpuRequest,
        memoryRequest: limits.memoryRequest,
        cpuLimit: limits.cpuLimit,
        memoryLimit: limits.memoryLimit,
        cpuRatio,
        memoryRatio,
        timestamp: new Date().toISOString()
      });
      
      // 更新 Prometheus 指标
      this.resourceUsageGauge.set({ service: serviceName, resource_type: 'cpu', namespace: item.metadata.namespace }, cpuRatio);
      this.resourceUsageGauge.set({ service: serviceName, resource_type: 'memory', namespace: item.metadata.namespace }, memoryRatio);
    }
    
    return usageData;
  }
  
  /**
   * 解析 CPU 资源值（转换为 millicores）
   */
  parseCpu(cpuStr) {
    if (cpuStr.endsWith('n')) {
      return parseInt(cpuStr) / 1000000; // nano -> milli
    } else if (cpuStr.endsWith('u')) {
      return parseInt(cpuStr) / 1000; // micro -> milli
    } else if (cpuStr.endsWith('m')) {
      return parseInt(cpuStr);
    } else {
      return parseInt(cpuStr) * 1000; // cores -> milli
    }
  }
  
  /**
   * 解析内存资源值（转换为 bytes）
   */
  parseMemory(memStr) {
    const units = {
      'Ki': 1024,
      'Mi': 1024 * 1024,
      'Gi': 1024 * 1024 * 1024,
      'Ti': 1024 * 1024 * 1024 * 1024
    };
    
    for (const [unit, multiplier] of Object.entries(units)) {
      if (memStr.endsWith(unit)) {
        return parseInt(memStr) * multiplier;
      }
    }
    return parseInt(memStr);
  }
  
  /**
   * 采集存储利用率
   */
  async collectStorageMetrics() {
    const pvs = await this.customMetricsApi.listClusterCustomObject(
      'storage.k8s.io', 
      'v1', 
      'persistentvolumeclaims'
    );
    
    const storageData = [];
    for (const pvc of pvs.body.items) {
      const serviceName = pvc.metadata.labels?.['app.kubernetes.io/name'] || 'shared';
      const storageClass = pvc.spec.storageClassName || 'default';
      const capacity = this.parseMemory(pvc.status.capacity?.storage || '0');
      
      // 查询实际使用量（通过 Prometheus）
      const usedQuery = `kubelet_volume_stats_used_bytes{persistentvolumeclaim="${pvc.metadata.name}"}`;
      const used = await this.queryPrometheus(usedQuery);
      
      storageData.push({
        pvc: pvc.metadata.name,
        namespace: pvc.metadata.namespace,
        service: serviceName,
        storageClass,
        capacity,
        used,
        utilizationRatio: capacity > 0 ? used / capacity : 0,
        timestamp: new Date().toISOString()
      });
    }
    
    return storageData;
  }
}

module.exports = MetricsCollector;
```

#### 1.2 云厂商成本 API 集成
```javascript
// backend/shared/costTracker/cloudCostProvider.js

const AWS = require('aws-sdk');
const { CloudBillingClient } = require('@google-cloud/billing');

class CloudCostProvider {
  constructor(config = {}) {
    this.provider = config.provider || process.env.CLOUD_PROVIDER || 'aws';
    
    if (this.provider === 'aws') {
      this.costExplorer = new AWS.CostExplorer({ region: 'us-east-1' });
    } else if (this.provider === 'gcp') {
      this.billingClient = new CloudBillingClient();
    }
  }
  
  /**
   * 获取 AWS 成本数据
   */
  async getAWSCostData(startDate, endDate, groupBy = 'SERVICE') {
    const params = {
      TimePeriod: {
        Start: startDate,
        End: endDate
      },
      Granularity: 'DAILY',
      Metrics: ['BlendedCost', 'UsageQuantity'],
      GroupBy: [
        { Type: 'DIMENSION', Key: groupBy }
      ]
    };
    
    const result = await this.costExplorer.getCostAndUsage(params).promise();
    
    return result.ResultsByTime.map(day => ({
      date: day.TimePeriod.Start,
      groups: day.Groups.map(g => ({
        key: g.Keys[0],
        cost: parseFloat(g.Metrics.BlendedCost.Amount),
        currency: g.Metrics.BlendedCost.Unit,
        usage: g.Metrics.UsageQuantity.Amount
      })),
      total: parseFloat(day.Total.BlendedCost.Amount)
    }));
  }
  
  /**
   * 获取带标签的成本归因
   */
  async getTaggedCostData(startDate, endDate, tagKey = 'Service') {
    const params = {
      TimePeriod: {
        Start: startDate,
        End: endDate
      },
      Granularity: 'DAILY',
      Metrics: ['BlendedCost'],
      GroupBy: [
        { Type: 'TAG', Key: tagKey }
      ]
    };
    
    const result = await this.costExplorer.getCostAndUsage(params).promise();
    
    return result.ResultsByTime.flatMap(day => 
      day.Groups
        .filter(g => !g.Keys[0].startsWith('$')) // 过滤未标记的资源
        .map(g => ({
          date: day.TimePeriod.Start,
          service: g.Keys[0],
          cost: parseFloat(g.Metrics.BlendedCost.Amount)
        }))
    );
  }
  
  /**
   * 获取 GCP 成本数据
   */
  async getGCPCostData(billingAccount, startDate, endDate) {
    const [billingData] = await this.billingClient.getBillingInfo({
      name: `billingAccounts/${billingAccount}`
    });
    
    // 使用 BigQuery 查询成本数据
    // 实际实现需要配置 BigQuery 导出
    return billingData;
  }
}

module.exports = CloudCostProvider;
```

### 2. 成本归因引擎

#### 2.1 服务级成本分配
```javascript
// backend/shared/costTracker/costAttributor.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

class CostAttributor {
  constructor() {
    this.hourlyRates = {
      cpu: 0.04,       // $/core-hour
      memory: 0.005,   // $/GB-hour
      storage: 0.0001, // $/GB-hour
      network: 0.01    // $/GB egress
    };
  }
  
  /**
   * 计算服务级成本
   */
  async calculateServiceCost(serviceName, periodStart, periodEnd) {
    // 获取服务资源使用记录
    const usageRecords = await prisma.resourceUsage.findMany({
      where: {
        service: serviceName,
        timestamp: {
          gte: new Date(periodStart),
          lte: new Date(periodEnd)
        }
      }
    });
    
    // 计算加权平均资源使用量
    const avgCpu = this.calculateWeightedAverage(usageRecords, 'cpuUsage');
    const avgMemory = this.calculateWeightedAverage(usageRecords, 'memoryUsage');
    
    // 计算时间段（小时）
    const hours = (new Date(periodEnd) - new Date(periodStart)) / (1000 * 60 * 60);
    
    // 计算成本
    const cpuCost = avgCpu / 1000 * this.hourlyRates.cpu * hours;
    const memoryCost = avgMemory / (1024 * 1024 * 1024) * this.hourlyRates.memory * hours;
    
    // 获取存储成本
    const storageCost = await this.calculateStorageCost(serviceName, periodStart, periodEnd);
    
    // 获取网络成本
    const networkCost = await this.calculateNetworkCost(serviceName, periodStart, periodEnd);
    
    return {
      service: serviceName,
      period: { start: periodStart, end: periodEnd },
      costs: {
        cpu: cpuCost,
        memory: memoryCost,
        storage: storageCost,
        network: networkCost,
        total: cpuCost + memoryCost + storageCost + networkCost
      },
      usage: {
        avgCpuCores: avgCpu / 1000,
        avgMemoryGB: avgMemory / (1024 * 1024 * 1024),
        hours
      }
    };
  }
  
  /**
   * 按业务模块归因成本
   */
  async attributeCostByBusinessModule(periodStart, periodEnd) {
    // 业务模块到服务的映射
    const moduleMapping = {
      'gameplay': ['catch-service', 'gym-service', 'pokemon-service'],
      'social': ['social-service'],
      'commerce': ['payment-service', 'reward-service'],
      'infrastructure': ['gateway', 'location-service', 'user-service']
    };
    
    const moduleCosts = {};
    
    for (const [module, services] of Object.entries(moduleMapping)) {
      let totalCost = 0;
      
      for (const service of services) {
        const cost = await this.calculateServiceCost(service, periodStart, periodEnd);
        totalCost += cost.costs.total;
      }
      
      moduleCosts[module] = {
        total: totalCost,
        services,
        percentage: 0 // 稍后计算
      };
    }
    
    // 计算百分比
    const grandTotal = Object.values(moduleCosts).reduce((sum, m) => sum + m.total, 0);
    for (const module of Object.keys(moduleCosts)) {
      moduleCosts[module].percentage = (moduleCosts[module].total / grandTotal * 100).toFixed(2);
    }
    
    return moduleCosts;
  }
  
  /**
   * 用户级成本归因（估算）
   */
  async attributeCostByUser(userId, periodStart, periodEnd) {
    // 获取用户活动指标
    const userActivity = await prisma.userActivity.aggregate({
      where: {
        userId,
        timestamp: {
          gte: new Date(periodStart),
          lte: new Date(periodEnd)
        }
      },
      _sum: {
        apiCalls: true,
        catchEvents: true,
        battleEvents: true
      }
    });
    
    // 获取总平台活动
    const totalActivity = await prisma.userActivity.aggregate({
      where: {
        timestamp: {
          gte: new Date(periodStart),
          lte: new Date(periodEnd)
        }
      },
      _sum: {
        apiCalls: true,
        catchEvents: true,
        battleEvents: true
      }
    });
    
    // 计算用户成本份额
    const userApiCalls = userActivity._sum.apiCalls || 0;
    const totalApiCalls = totalActivity._sum.apiCalls || 1;
    const costShare = userApiCalls / totalApiCalls;
    
    // 获取平台总成本
    const platformCost = await this.getPlatformTotalCost(periodStart, periodEnd);
    
    return {
      userId,
      period: { start: periodStart, end: periodEnd },
      estimatedCost: platformCost * costShare,
      activity: {
        apiCalls: userApiCalls,
        catchEvents: userActivity._sum.catchEvents || 0,
        battleEvents: userActivity._sum.battleEvents || 0
      },
      costShare: (costShare * 100).toFixed(4) + '%'
    };
  }
}

module.exports = CostAttributor;
```

### 3. 资源浪费检测系统

```javascript
// backend/shared/costTracker/wasteDetector.js

class WasteDetector {
  constructor() {
    this.thresholds = {
      lowCpuUtilization: 0.1,    // CPU 利用率 < 10%
      lowMemoryUtilization: 0.15, // 内存利用率 < 15%
      idlePodHours: 24,           // 空闲超过 24 小时
      oversizedRatio: 3           // 资源请求 > 实际使用 3 倍
    };
  }
  
  /**
   * 检测低利用率资源
   */
  async detectUnderutilizedResources() {
    const issues = [];
    
    // 获取过去 7 天的资源使用数据
    const usageData = await this.fetchUsageHistory(7);
    
    for (const pod of usageData) {
      // 检测 CPU 低利用率
      if (pod.avgCpuRatio < this.thresholds.lowCpuUtilization) {
        issues.push({
          type: 'LOW_CPU_UTILIZATION',
          severity: 'warning',
          resource: pod.name,
          service: pod.service,
          currentValue: pod.avgCpuRatio,
          threshold: this.thresholds.lowCpuUtilization,
          recommendation: `降低 CPU 请求从 ${pod.cpuRequest}m 到 ${Math.ceil(pod.avgCpuUsage * 1.5)}m`,
          estimatedSavings: this.calculateSavings(pod, 'cpu')
        });
      }
      
      // 检测内存低利用率
      if (pod.avgMemoryRatio < this.thresholds.lowMemoryUtilization) {
        issues.push({
          type: 'LOW_MEMORY_UTILIZATION',
          severity: 'warning',
          resource: pod.name,
          service: pod.service,
          currentValue: pod.avgMemoryRatio,
          threshold: this.thresholds.lowMemoryUtilization,
          recommendation: `降低内存请求从 ${pod.memoryRequest}Mi 到 ${Math.ceil(pod.avgMemoryUsage * 1.2 / 1024 / 1024)}Mi`,
          estimatedSavings: this.calculateSavings(pod, 'memory')
        });
      }
      
      // 检测资源过度配置
      if (pod.cpuRequest / pod.avgCpuUsage > this.thresholds.oversizedRatio) {
        issues.push({
          type: 'OVERSIZED_RESOURCE',
          severity: 'info',
          resource: pod.name,
          service: pod.service,
          currentRequest: pod.cpuRequest,
          actualUsage: pod.avgCpuUsage,
          ratio: pod.cpuRequest / pod.avgCpuUsage,
          recommendation: '考虑缩容资源配置'
        });
      }
    }
    
    return issues;
  }
  
  /**
   * 检测空闲资源
   */
  async detectIdleResources() {
    const issues = [];
    
    // 查找无流量 Pod
    const idlePods = await this.findPodsWithoutTraffic(this.thresholds.idlePodHours);
    
    for (const pod of idlePods) {
      issues.push({
        type: 'IDLE_POD',
        severity: 'critical',
        resource: pod.name,
        service: pod.service,
        idleHours: pod.idleHours,
        recommendation: '考虑删除或缩容该 Pod',
        estimatedSavings: this.calculateSavings(pod, 'all')
      });
    }
    
    // 查找未挂载的 PVC
    const unusedPVCs = await this.findUnusedPVCs();
    for (const pvc of unusedPVCs) {
      issues.push({
        type: 'UNUSED_PVC',
        severity: 'warning',
        resource: pvc.name,
        namespace: pvc.namespace,
        size: pvc.capacity,
        recommendation: '删除未使用的持久卷声明',
        estimatedSavings: pvc.capacity * 0.0001 * 24 * 30 // $/GB-month
      });
    }
    
    return issues;
  }
  
  /**
   * 生成优化建议报告
   */
  async generateOptimizationReport() {
    const underutilized = await this.detectUnderutilizedResources();
    const idle = await this.detectIdleResources();
    const allIssues = [...underutilized, ...idle];
    
    // 按严重程度排序
    allIssues.sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
    
    // 计算总节省潜力
    const totalSavings = allIssues.reduce((sum, issue) => 
      sum + (issue.estimatedSavings || 0), 0
    );
    
    // 按服务分组
    const byService = {};
    for (const issue of allIssues) {
      if (!byService[issue.service]) {
        byService[issue.service] = [];
      }
      byService[issue.service].push(issue);
    }
    
    return {
      generatedAt: new Date().toISOString(),
      totalIssues: allIssues.length,
      criticalCount: allIssues.filter(i => i.severity === 'critical').length,
      warningCount: allIssues.filter(i => i.severity === 'warning').length,
      potentialMonthlySavings: totalSavings,
      issues: allIssues,
      issuesByService: byService,
      topRecommendations: allIssues.slice(0, 10)
    };
  }
  
  /**
   * 计算成本节省
   */
  calculateSavings(pod, resourceType) {
    const hoursPerMonth = 24 * 30;
    
    if (resourceType === 'cpu') {
      const wastedCores = (pod.cpuRequest - pod.avgCpuUsage) / 1000;
      return wastedCores * 0.04 * hoursPerMonth;
    } else if (resourceType === 'memory') {
      const wastedGB = (pod.memoryRequest - pod.avgMemoryUsage) / (1024 * 1024 * 1024);
      return wastedGB * 0.005 * hoursPerMonth;
    } else {
      // all
      const cpuSavings = this.calculateSavings(pod, 'cpu');
      const memSavings = this.calculateSavings(pod, 'memory');
      return cpuSavings + memSavings;
    }
  }
}

module.exports = WasteDetector;
```

### 4. 成本趋势预测与告警

```javascript
// backend/shared/costTracker/costForecaster.js

const tf = require('@tensorflow/tfjs-node');

class CostForecaster {
  constructor() {
    this.model = null;
    this.historyDays = 90;
    this.forecastDays = 30;
  }
  
  /**
   * 训练成本预测模型
   */
  async trainModel(historicalData) {
    // 准备训练数据
    const xs = [];
    const ys = [];
    
    for (let i = 7; i < historicalData.length; i++) {
      // 使用过去 7 天预测第 8 天
      const features = historicalData.slice(i - 7, i).map(d => [
        d.totalCost,
        d.dayOfWeek,
        d.isHoliday ? 1 : 0,
        d.activeUsers
      ]);
      xs.push(features.flat());
      ys.push(historicalData[i].totalCost);
    }
    
    const xTensor = tf.tensor2d(xs);
    const yTensor = tf.tensor2d(ys, [ys.length, 1]);
    
    // 构建简单 LSTM 模型
    this.model = tf.sequential();
    this.model.add(tf.layers.dense({
      units: 32,
      activation: 'relu',
      inputShape: [28] // 7 days * 4 features
    }));
    this.model.add(tf.layers.dense({
      units: 16,
      activation: 'relu'
    }));
    this.model.add(tf.layers.dense({
      units: 1
    }));
    
    this.model.compile({
      optimizer: 'adam',
      loss: 'meanSquaredError'
    });
    
    await this.model.fit(xTensor, yTensor, {
      epochs: 100,
      batchSize: 32,
      validationSplit: 0.2
    });
    
    xTensor.dispose();
    yTensor.dispose();
  }
  
  /**
   * 预测未来成本
   */
  async forecastFutureCost(recentData) {
    if (!this.model) {
      throw new Error('Model not trained');
    }
    
    const forecasts = [];
    let lastWeekData = recentData.slice(-7);
    
    for (let i = 0; i < this.forecastDays; i++) {
      const features = lastWeekData.map(d => [
        d.totalCost,
        d.dayOfWeek,
        d.isHoliday ? 1 : 0,
        d.activeUsers
      ]);
      
      const input = tf.tensor2d([features.flat()]);
      const prediction = this.model.predict(input);
      const predictedCost = await prediction.data();
      
      forecasts.push({
        date: this.addDays(new Date(), i + 1),
        predictedCost: predictedCost[0],
        confidence: this.calculateConfidence(i)
      });
      
      // 更新滑动窗口
      lastWeekData = [...lastWeekData.slice(1), {
        totalCost: predictedCost[0],
        dayOfWeek: (lastWeekData[6].dayOfWeek + 1) % 7,
        isHoliday: false,
        activeUsers: lastWeekData[6].activeUsers
      }];
      
      input.dispose();
      prediction.dispose();
    }
    
    return {
      forecasts,
      totalPredictedCost: forecasts.reduce((sum, f) => sum + f.predictedCost, 0),
      avgDailyCost: forecasts.reduce((sum, f) => sum + f.predictedCost, 0) / forecasts.length
    };
  }
  
  /**
   * 计算预测置信区间
   */
  calculateConfidence(daysAhead) {
    // 置信度随预测天数递减
    return Math.max(0.5, 0.95 - daysAhead * 0.015);
  }
  
  /**
   * 检测成本异常
   */
  async detectAnomalies(currentCost, historicalAvg, historicalStd) {
    const zScore = (currentCost - historicalAvg) / historicalStd;
    
    if (Math.abs(zScore) > 2) {
      return {
        isAnomaly: true,
        severity: Math.abs(zScore) > 3 ? 'critical' : 'warning',
        zScore,
        currentCost,
        expectedRange: {
          min: historicalAvg - 2 * historicalStd,
          max: historicalAvg + 2 * historicalStd
        },
        message: zScore > 0 
          ? `成本异常上涨 ${((zScore - 2) * 50).toFixed(1)}%`
          : `成本异常下降 ${((-zScore - 2) * 50).toFixed(1)}%`
      };
    }
    
    return { isAnomaly: false };
  }
}

module.exports = CostForecaster;
```

### 5. 成本仪表板 API

```javascript
// backend/shared/costTracker/costDashboard.js

const express = require('express');
const router = express.Router();
const MetricsCollector = require('./metricsCollector');
const CostAttributor = require('./costAttributor');
const WasteDetector = require('./wasteDetector');
const CostForecaster = require('./costForecaster');

const metricsCollector = new MetricsCollector();
const costAttributor = new CostAttributor();
const wasteDetector = new WasteDetector();
const costForecaster = new CostForecaster();

/**
 * GET /api/cost/overview
 * 成本概览仪表板
 */
router.get('/overview', async (req, res) => {
  const { period = '7d' } = req.query;
  
  const [currentCost, previousCost, forecast, topServices] = await Promise.all([
    costAttributor.getPlatformTotalCost(period),
    costAttributor.getPlatformTotalCost(this.getPreviousPeriod(period)),
    costForecaster.forecastFutureCost(/* ... */),
    costAttributor.getTopCostServices(5)
  ]);
  
  const changePercent = ((currentCost - previousCost) / previousCost * 100).toFixed(2);
  
  res.json({
    currentPeriod: {
      total: currentCost,
      currency: 'USD'
    },
    previousPeriod: {
      total: previousCost
    },
    change: {
      amount: currentCost - previousCost,
      percent: changePercent
    },
    forecast: forecast,
    topServices,
    alerts: await this.getActiveAlerts()
  });
});

/**
 * GET /api/cost/by-service
 * 按服务查看成本
 */
router.get('/by-service', async (req, res) => {
  const { period = '30d', service } = req.query;
  
  if (service) {
    const cost = await costAttributor.calculateServiceCost(service, period);
    res.json(cost);
  } else {
    const allServices = await costAttributor.getAllServicesCost(period);
    res.json(allServices);
  }
});

/**
 * GET /api/cost/by-module
 * 按业务模块查看成本
 */
router.get('/by-module', async (req, res) => {
  const { period = '30d' } = req.query;
  const moduleCosts = await costAttributor.attributeCostByBusinessModule(period);
  res.json(moduleCosts);
});

/**
 * GET /api/cost/optimization
 * 获取优化建议
 */
router.get('/optimization', async (req, res) => {
  const report = await wasteDetector.generateOptimizationReport();
  res.json(report);
});

/**
 * GET /api/cost/forecast
 * 获取成本预测
 */
router.get('/forecast', async (req, res) => {
  const { days = 30 } = req.query;
  const historicalData = await this.getHistoricalCostData(90);
  
  await costForecaster.trainModel(historicalData);
  const forecast = await costForecaster.forecastFutureCost(historicalData);
  
  res.json(forecast);
});

/**
 * GET /api/cost/anomalies
 * 获取成本异常
 */
router.get('/anomalies', async (req, res) => {
  const { period = '7d' } = req.query;
  const anomalies = await this.detectCostAnomalies(period);
  res.json(anomalies);
});

module.exports = router;
```

### 6. 数据库迁移

```sql
-- database/migrations/20260614_cost_tracking.sql

-- 资源使用记录表
CREATE TABLE resource_usage (
  id BIGSERIAL PRIMARY KEY,
  service VARCHAR(100) NOT NULL,
  pod_name VARCHAR(255),
  namespace VARCHAR(100),
  cpu_usage_milli INTEGER NOT NULL,
  memory_usage_bytes BIGINT NOT NULL,
  cpu_request_milli INTEGER,
  memory_request_bytes BIGINT,
  cpu_limit_milli INTEGER,
  memory_limit_bytes BIGINT,
  cpu_ratio DECIMAL(5,4),
  memory_ratio DECIMAL(5,4),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_resource_usage_service ON resource_usage(service, timestamp);
CREATE INDEX idx_resource_usage_timestamp ON resource_usage(timestamp);

-- 成本归因记录表
CREATE TABLE cost_attribution (
  id BIGSERIAL PRIMARY KEY,
  service VARCHAR(100) NOT NULL,
  business_module VARCHAR(100),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  cpu_cost DECIMAL(10,4),
  memory_cost DECIMAL(10,4),
  storage_cost DECIMAL(10,4),
  network_cost DECIMAL(10,4),
  total_cost DECIMAL(10,4),
  currency VARCHAR(3) DEFAULT 'USD',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_cost_attribution_service ON cost_attribution(service, period_start);
CREATE INDEX idx_cost_attribution_period ON cost_attribution(period_start, period_end);

-- 优化建议表
CREATE TABLE optimization_recommendations (
  id BIGSERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  resource_name VARCHAR(255),
  service VARCHAR(100),
  description TEXT,
  recommendation TEXT,
  estimated_savings DECIMAL(10,2),
  status VARCHAR(20) DEFAULT 'pending',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_opt_rec_status ON optimization_recommendations(status, severity);

-- 成本预算表
CREATE TABLE cost_budgets (
  id BIGSERIAL PRIMARY KEY,
  service VARCHAR(100),
  business_module VARCHAR(100),
  monthly_budget DECIMAL(10,2) NOT NULL,
  alert_threshold DECIMAL(3,2) DEFAULT 0.8,
  period_month VARCHAR(7) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(service, period_month),
  UNIQUE(business_module, period_month)
);

-- 用户活动统计表（用于用户级成本归因）
CREATE TABLE user_activity_stats (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  api_calls INTEGER DEFAULT 0,
  catch_events INTEGER DEFAULT 0,
  battle_events INTEGER DEFAULT 0,
  session_minutes INTEGER DEFAULT 0,
  period_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, period_date)
);

CREATE INDEX idx_user_activity_date ON user_activity_stats(period_date);
```

### 7. 定时任务与告警

```javascript
// backend/jobs/costTrackingJob.js

const cron = require('node-cron');
const MetricsCollector = require('../shared/costTracker/metricsCollector');
const WasteDetector = require('../shared/costTracker/wasteDetector');
const CostForecaster = require('../shared/costTracker/costForecaster');
const { sendSlackAlert, sendEmailAlert } = require('../shared/notifier');

const metricsCollector = new MetricsCollector();
const wasteDetector = new WasteDetector();
const costForecaster = new CostForecaster();

// 每小时采集资源使用数据
cron.schedule('0 * * * *', async () => {
  console.log('[CostTracking] Collecting metrics...');
  const metrics = await metricsCollector.collectPodMetrics();
  await metricsCollector.saveMetrics(metrics);
  
  // 更新 Prometheus 指标
  metricsCollector.updatePrometheusMetrics(metrics);
});

// 每日生成优化报告
cron.schedule('0 6 * * *', async () => {
  console.log('[CostTracking] Generating optimization report...');
  const report = await wasteDetector.generateOptimizationReport();
  
  if (report.criticalCount > 0) {
    await sendSlackAlert({
      channel: '#cost-alerts',
      title: '🚨 资源优化建议',
      message: `发现 ${report.criticalCount} 个严重问题，月节省潜力 $${report.potentialMonthlySavings.toFixed(2)}`,
      details: report.topRecommendations
    });
  }
});

// 每周成本预测与预算检查
cron.schedule('0 9 * * 1', async () => {
  console.log('[CostTracking] Running cost forecast...');
  const forecast = await costForecaster.forecastFutureCost(/* ... */);
  const budget = await costAttributor.getMonthlyBudget();
  
  if (forecast.totalPredictedCost > budget * 1.1) {
    await sendEmailAlert({
      to: 'finance@minego.com',
      subject: '⚠️ 预算超支预警',
      body: `预测本月成本 $${forecast.totalPredictedCost.toFixed(2)}，超出预算 ${((forecast.totalPredictedCost / budget - 1) * 100).toFixed(1)}%`
    });
  }
});
```

## 验收标准

- [ ] 实现资源利用率数据采集，覆盖 CPU、内存、存储、网络
- [ ] 成本归因支持服务级、业务模块级、用户级三个维度
- [ ] 资源浪费检测能识别低利用率资源、空闲 Pod、未使用存储
- [ ] 成本预测模型准确率 > 80%（7 天预测）
- [ ] 优化建议报告包含具体节省金额估算
- [ ] 成本仪表板 API 支持概览、按服务、按模块、优化建议等查询
- [ ] 定时任务按小时采集数据、每日生成报告、每周预测预算
- [ ] Slack/Email 告警在严重问题或预算超支时触发
- [ ] Prometheus 指标导出供 Grafana 可视化
- [ ] 数据库迁移脚本正确创建所需表和索引

## 影响范围

- **新增模块**：
  - `backend/shared/costTracker/` - 成本追踪核心模块
  - `backend/jobs/costTrackingJob.js` - 定时任务
  - `database/migrations/20260614_cost_tracking.sql` - 数据库迁移

- **修改模块**：
  - `infrastructure/k8s/monitoring/` - 添加成本相关 Grafana 仪表板
  - `admin-dashboard/` - 添加成本管理界面
  - `.github/workflows/` - 添加成本报告推送步骤

- **依赖**：
  - Kubernetes Metrics Server
  - AWS Cost Explorer API 或 GCP Cloud Billing API
  - TensorFlow.js（用于成本预测）
  - Prometheus（指标导出）

## 参考

- [AWS Cost Explorer API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_CostExplorer.html)
- [GCP Cloud Billing API](https://cloud.google.com/billing/docs/reference/rest)
- [Kubernetes Resource Metrics API](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [FinOps Foundation Best Practices](https://www.finops.org/framework/)
