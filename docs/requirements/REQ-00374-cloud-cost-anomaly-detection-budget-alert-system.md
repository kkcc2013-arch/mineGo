# REQ-00374: 云成本异常检测与预算预警系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00374 |
| 标题 | 云成本异常检测与预算预警系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、monitoring、backend/shared/cost、Prometheus、Grafana、Slack、Email、infrastructure/k8s、admin-dashboard |
| 创建时间 | 2026-06-29 22:00 UTC |

## 需求描述

建立云资源成本实时监控系统，通过机器学习算法检测成本异常波动，实现预算超支预警、成本归因分析、资源利用率优化建议等功能，帮助团队及时发现成本异常并采取行动。

### 核心目标

1. **实时成本监控**：监控云资源使用量和费用，按服务/命名空间/资源类型分类统计
2. **异常检测**：使用统计方法和机器学习检测成本异常波动（突发增长、异常下降）
3. **预算管理**：设置预算阈值，实现预算超支预警（50%/80%/100%）
4. **成本归因**：自动分析成本变化原因，定位到具体服务或资源
5. **优化建议**：基于资源利用率数据，生成成本优化建议

## 技术方案

### 1. 成本数据采集层

```javascript
// backend/shared/cost/CostDataCollector.js
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const { KubernetesClient } = require('@kubernetes/client-node');
const Prometheus = require('prom-client');

class CostDataCollector {
  constructor() {
    this.costExplorer = new CostExplorerClient({ region: process.env.AWS_REGION });
    this.cloudWatch = new CloudWatchClient({ region: process.env.AWS_REGION });
    this.k8sClient = new KubernetesClient();
    
    // Prometheus 指标注册
    this.costGauge = new Prometheus.Gauge({
      name: 'cloud_cost_hourly_usd',
      help: 'Hourly cloud cost in USD',
      labelNames: ['service', 'namespace', 'resource_type', 'provider']
    });
    
    this.costAnomalyGauge = new Prometheus.Gauge({
      name: 'cloud_cost_anomaly_score',
      help: 'Cost anomaly detection score (0-1)',
      labelNames: ['service', 'namespace']
    });
  }
  
  /**
   * 采集 AWS Cost Explorer 数据
   */
  async collectAwsCostData(startDate, endDate) {
    const command = new GetCostAndUsageCommand({
      TimePeriod: {
        Start: startDate,
        End: endDate
      },
      Granularity: 'HOURLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [
        { Type: 'DIMENSION', Key: 'SERVICE' },
        { Type: 'TAG', Key: 'Namespace' },
        { Type: 'DIMENSION', Key: 'USAGE_TYPE' }
      ]
    });
    
    const response = await this.costExplorer.send(command);
    
    // 处理并存储数据
    for (const result of response.ResultsByTime) {
      for (const group of result.Groups) {
        const cost = parseFloat(group.Metrics.UnblendedCost.Amount);
        const labels = this.parseGroupKeys(group.Keys);
        
        this.costGauge.set(
          {
            service: labels.service || 'unknown',
            namespace: labels.namespace || 'default',
            resource_type: labels.usageType || 'general',
            provider: 'aws'
          },
          cost
        );
      }
    }
    
    return response.ResultsByTime;
  }
  
  /**
   * 采集 Kubernetes 资源使用数据
   */
  async collectK8sResourceMetrics() {
    const metrics = {
      cpu: {},
      memory: {},
      pods: {}
    };
    
    // 获取所有 Pod 资源使用
    const pods = await this.k8sClient.listPodForAllNamespaces();
    
    for (const pod of pods.body.items) {
      const namespace = pod.metadata.namespace;
      const podName = pod.metadata.name;
      
      // 解析资源请求和限制
      const containers = pod.spec.containers || [];
      let cpuRequest = 0;
      let memoryRequest = 0;
      
      for (const container of containers) {
        cpuRequest += this.parseCpu(container.resources?.requests?.cpu || '0');
        memoryRequest += this.parseMemory(container.resources?.requests?.memory || '0');
      }
      
      metrics.cpu[`${namespace}/${podName}`] = cpuRequest;
      memory[`${namespace}/${podName}`] = memoryRequest;
    }
    
    return metrics;
  }
  
  /**
   * 获取实时云成本数据
   */
  async getRealtimeCost() {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600000);
    
    // 从多个数据源聚合
    const [awsCost, k8sMetrics, prometheusMetrics] = await Promise.all([
      this.collectAwsCostData(
        hourAgo.toISOString().split('T')[0],
        now.toISOString().split('T')[0]
      ),
      this.collectK8sResourceMetrics(),
      this.getPrometheusMetrics()
    ]);
    
    return {
      timestamp: now.toISOString(),
      aws: awsCost,
      kubernetes: k8sMetrics,
      prometheus: prometheusMetrics
    };
  }
}

module.exports = CostDataCollector;
```

### 2. 成本异常检测引擎

```javascript
// backend/shared/cost/CostAnomalyDetector.js
const { AnomalyDetector } = require('node-stats');
const EventEmitter = require('events');

class CostAnomalyDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      // 历史数据窗口（天）
      historicalWindow: options.historicalWindow || 30,
      // 异常阈值（标准差倍数）
      threshold: options.threshold || 2.5,
      // 最小样本数
      minSamples: options.minSamples || 24,
      // 季节性周期（小时）
      seasonalPeriod: options.seasonalPeriod || 24,
      // 启用机器学习
      enableML: options.enableML !== false
    };
    
    // 存储历史数据
    this.historyStore = new Map();
    
    // 异常类型
    this.anomalyTypes = {
      SPIKE: 'spike',           // 成本突增
      DROP: 'drop',             // 异常下降
      TREND_CHANGE: 'trend',    // 趋势变化
      PERSISTENT: 'persistent'  // 持续异常
    };
  }
  
  /**
   * 检测成本异常
   * @param {Object} currentCost - 当前成本数据
   * @param {string} serviceKey - 服务标识
   * @returns {Object} 检测结果
   */
  async detect(currentCost, serviceKey) {
    // 获取历史数据
    const history = await this.getHistory(serviceKey);
    
    // 更新历史数据
    history.push({
      timestamp: currentCost.timestamp,
      value: currentCost.amount,
      labels: currentCost.labels
    });
    
    // 保持窗口大小
    if (history.length > this.config.historicalWindow * 24) {
      history.shift();
    }
    
    // 检查样本数
    if (history.length < this.config.minSamples) {
      return { anomaly: false, reason: 'insufficient_data' };
    }
    
    // 提取数值序列
    const values = history.map(h => h.value);
    
    // 统计检测
    const statisticalResult = this.statisticalDetection(values, currentCost.amount);
    
    // 季节性检测
    const seasonalResult = this.seasonalDetection(values, currentCost.amount);
    
    // 趋势检测
    const trendResult = this.trendDetection(values);
    
    // 综合判断
    const isAnomaly = statisticalResult.isAnomaly || 
                      seasonalResult.isAnomaly || 
                      trendResult.isAnomaly;
    
    const result = {
      serviceKey,
      timestamp: currentCost.timestamp,
      currentValue: currentCost.amount,
      isAnomaly,
      anomalyType: null,
      score: 0,
      details: {
        statistical: statisticalResult,
        seasonal: seasonalResult,
        trend: trendResult
      }
    };
    
    if (isAnomaly) {
      // 确定异常类型
      if (statisticalResult.isAnomaly && currentCost.amount > statisticalResult.mean) {
        result.anomalyType = this.anomalyTypes.SPIKE;
      } else if (statisticalResult.isAnomaly && currentCost.amount < statisticalResult.mean) {
        result.anomalyType = this.anomalyTypes.DROP;
      } else if (trendResult.isAnomaly) {
        result.anomalyType = this.anomalyTypes.TREND_CHANGE;
      }
      
      // 计算异常分数
      result.score = this.calculateAnomalyScore(statisticalResult, seasonalResult, trendResult);
      
      // 发出异常事件
      this.emit('anomaly', result);
    }
    
    // 保存历史
    await this.saveHistory(serviceKey, history);
    
    return result;
  }
  
  /**
   * 统计检测（Z-score 方法）
   */
  statisticalDetection(values, currentValue) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    const zScore = stdDev > 0 ? Math.abs(currentValue - mean) / stdDev : 0;
    
    return {
      mean,
      stdDev,
      zScore,
      isAnomaly: zScore > this.config.threshold,
      threshold: this.config.threshold
    };
  }
  
  /**
   * 季节性检测
   */
  seasonalDetection(values, currentValue) {
    const period = this.config.seasonalPeriod;
    
    if (values.length < period * 2) {
      return { isAnomaly: false, reason: 'insufficient_seasonal_data' };
    }
    
    // 获取相同时间段的历史数据
    const currentIndex = values.length;
    const samePeriodValues = [];
    
    for (let i = 0; i < Math.floor(values.length / period); i++) {
      const idx = currentIndex - (i + 1) * period;
      if (idx >= 0) {
        samePeriodValues.push(values[idx]);
      }
    }
    
    if (samePeriodValues.length < 3) {
      return { isAnomaly: false, reason: 'insufficient_period_data' };
    }
    
    // 计算同周期统计
    const periodMean = samePeriodValues.reduce((a, b) => a + b, 0) / samePeriodValues.length;
    const periodVariance = samePeriodValues.reduce((sum, v) => sum + Math.pow(v - periodMean, 2), 0) / samePeriodValues.length;
    const periodStdDev = Math.sqrt(periodVariance);
    
    const deviation = periodStdDev > 0 ? Math.abs(currentValue - periodMean) / periodStdDev : 0;
    
    return {
      periodMean,
      periodStdDev,
      deviation,
      isAnomaly: deviation > this.config.threshold,
      historicalPeriods: samePeriodValues.length
    };
  }
  
  /**
   * 趋势检测
   */
  trendDetection(values) {
    const n = values.length;
    
    // 线性回归
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // 计算趋势显著性
    const predicted = values.map((_, i) => slope * i + intercept);
    const residuals = values.map((v, i) => v - predicted[i]);
    const mse = residuals.reduce((sum, r) => sum + r * r, 0) / n;
    
    // 检测趋势变化
    const recentSlope = this.calculateRecentSlope(values, Math.floor(n / 4));
    const historicalSlope = this.calculateHistoricalSlope(values, Math.floor(n / 4));
    
    const slopeChange = Math.abs(recentSlope - historicalSlope) / (Math.abs(historicalSlope) + 0.0001);
    
    return {
      slope,
      intercept,
      mse,
      recentSlope,
      historicalSlope,
      slopeChange,
      isAnomaly: slopeChange > 0.5, // 趋势变化超过50%
      trendDirection: slope > 0 ? 'increasing' : slope < 0 ? 'decreasing' : 'stable'
    };
  }
  
  /**
   * 计算异常分数
   */
  calculateAnomalyScore(statistical, seasonal, trend) {
    let score = 0;
    
    // 统计异常权重
    if (statistical.isAnomaly) {
      score += Math.min(statistical.zScore / 5, 0.5);
    }
    
    // 季节性异常权重
    if (seasonal.isAnomaly) {
      score += Math.min(seasonal.deviation / 5, 0.3);
    }
    
    // 趋势异常权重
    if (trend.isAnomaly) {
      score += Math.min(trend.slopeChange, 0.2);
    }
    
    return Math.min(score, 1);
  }
}

module.exports = CostAnomalyDetector;
```

### 3. 预算管理与预警系统

```javascript
// backend/shared/cost/BudgetManager.js
const EventEmitter = require('events');

class BudgetManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.budgets = new Map(); // 预算配置
    this.alertThresholds = [0.5, 0.8, 0.9, 1.0]; // 预警阈值
    this.alertHistory = new Map(); // 告警历史（防止重复）
  }
  
  /**
   * 设置预算
   * @param {string} budgetId - 预算ID
   * @param {Object} config - 预算配置
   */
  setBudget(budgetId, config) {
    const budget = {
      id: budgetId,
      name: config.name,
      type: config.type, // 'monthly', 'quarterly', 'yearly'
      amount: config.amount,
      currency: config.currency || 'USD',
      scope: config.scope, // 'global', 'namespace', 'service', 'resource_type'
      scopeValue: config.scopeValue,
      alertChannels: config.alertChannels || ['slack', 'email'],
      alertRecipients: config.alertRecipients || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    this.budgets.set(budgetId, budget);
    
    return budget;
  }
  
  /**
   * 检查预算使用情况
   * @param {string} budgetId - 预算ID
   * @param {number} currentSpend - 当前支出
   * @returns {Object} 检查结果
   */
  checkBudget(budgetId, currentSpend) {
    const budget = this.budgets.get(budgetId);
    
    if (!budget) {
      throw new Error(`Budget not found: ${budgetId}`);
    }
    
    const utilization = currentSpend / budget.amount;
    const remaining = budget.amount - currentSpend;
    const projectedEndOfMonth = this.projectSpend(budgetId, currentSpend);
    
    const result = {
      budgetId,
      budgetName: budget.name,
      budgetAmount: budget.amount,
      currentSpend,
      remaining,
      utilization,
      projectedEndOfMonth,
      status: this.getStatus(utilization),
      alerts: []
    };
    
    // 检查是否需要发送告警
    for (const threshold of this.alertThresholds) {
      if (utilization >= threshold) {
        const alertKey = `${budgetId}_${threshold}_${this.getPeriod(budget.type)}`;
        
        // 检查是否已发送过此阈值的告警
        if (!this.alertHistory.has(alertKey)) {
          const alert = {
            threshold,
            level: this.getAlertLevel(threshold),
            message: this.generateAlertMessage(budget, currentSpend, threshold),
            channels: budget.alertChannels,
            recipients: budget.alertRecipients,
            timestamp: new Date().toISOString()
          };
          
          result.alerts.push(alert);
          this.alertHistory.set(alertKey, alert);
          
          // 发出告警事件
          this.emit('alert', alert);
        }
      }
    }
    
    return result;
  }
  
  /**
   * 预测月底支出
   */
  projectSpend(budgetId, currentSpend) {
    const budget = this.budgets.get(budgetId);
    const now = new Date();
    
    let periodStart, periodEnd, periodDays, elapsedDays;
    
    if (budget.type === 'monthly') {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      periodDays = periodEnd.getDate();
      elapsedDays = now.getDate();
    } else if (budget.type === 'quarterly') {
      const quarter = Math.floor(now.getMonth() / 3);
      periodStart = new Date(now.getFullYear(), quarter * 3, 1);
      periodEnd = new Date(now.getFullYear(), (quarter + 1) * 3, 0);
      periodDays = Math.ceil((periodEnd - periodStart) / (1000 * 60 * 60 * 24));
      elapsedDays = Math.ceil((now - periodStart) / (1000 * 60 * 60 * 24));
    } else {
      periodStart = new Date(now.getFullYear(), 0, 1);
      periodEnd = new Date(now.getFullYear(), 11, 31);
      periodDays = 365;
      elapsedDays = Math.ceil((now - periodStart) / (1000 * 60 * 60 * 24));
    }
    
    // 简单线性预测
    const dailyRate = currentSpend / elapsedDays;
    const projected = dailyRate * periodDays;
    
    return projected;
  }
  
  /**
   * 获取状态
   */
  getStatus(utilization) {
    if (utilization >= 1.0) return 'exceeded';
    if (utilization >= 0.9) return 'critical';
    if (utilization >= 0.8) return 'warning';
    if (utilization >= 0.5) return 'caution';
    return 'healthy';
  }
  
  /**
   * 获取告警级别
   */
  getAlertLevel(threshold) {
    if (threshold >= 1.0) return 'critical';
    if (threshold >= 0.9) return 'high';
    if (threshold >= 0.8) return 'medium';
    return 'low';
  }
  
  /**
   * 生成告警消息
   */
  generateAlertMessage(budget, currentSpend, threshold) {
    const percentage = Math.round(threshold * 100);
    
    return {
      title: `预算预警: ${budget.name}`,
      severity: this.getAlertLevel(threshold),
      details: {
        budgetName: budget.name,
        budgetType: budget.type,
        budgetAmount: `$${budget.amount.toLocaleString()}`,
        currentSpend: `$${currentSpend.toLocaleString()}`,
        utilization: `${percentage}%`,
        threshold: `${percentage}%`
      },
      recommendations: this.generateRecommendations(budget, currentSpend, threshold),
      timestamp: new Date().toISOString()
    };
  }
  
  /**
   * 生成优化建议
   */
  generateRecommendations(budget, currentSpend, threshold) {
    const recommendations = [];
    
    if (threshold >= 0.9) {
      recommendations.push({
        priority: 'critical',
        action: '立即审查资源使用情况',
        details: '预算即将耗尽，建议立即检查是否有不必要的资源运行'
      });
      
      recommendations.push({
        priority: 'high',
        action: '考虑暂停非关键服务',
        details: '识别并暂停非生产环境的资源或开发测试环境'
      });
    }
    
    if (threshold >= 0.8) {
      recommendations.push({
        priority: 'medium',
        action: '审查资源利用率',
        details: '检查是否存在资源利用率低下的实例或服务'
      });
      
      recommendations.push({
        priority: 'medium',
        action: '考虑预留实例',
        details: '对于稳定的工作负载，考虑购买预留实例以降低成本'
      });
    }
    
    return recommendations;
  }
  
  /**
   * 获取周期标识
   */
  getPeriod(budgetType) {
    const now = new Date();
    if (budgetType === 'monthly') {
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    } else if (budgetType === 'quarterly') {
      const quarter = Math.floor(now.getMonth() / 3) + 1;
      return `${now.getFullYear()}-Q${quarter}`;
    } else {
      return String(now.getFullYear());
    }
  }
}

module.exports = BudgetManager;
```

### 4. 成本归因分析器

```javascript
// backend/shared/cost/CostAttributor.js
class CostAttributor {
  constructor() {
    this.serviceMappings = new Map();
    this.tagMappings = new Map();
  }
  
  /**
   * 分析成本变化原因
   * @param {Object} currentData - 当前成本数据
   * @param {Object} previousData - 历史成本数据
   * @returns {Object} 归因分析结果
   */
  async analyze(currentData, previousData) {
    const attributions = [];
    
    // 按服务归因
    const serviceAttribution = this.attributeByService(currentData, previousData);
    attributions.push(...serviceAttribution);
    
    // 按资源类型归因
    const resourceAttribution = this.attributeByResourceType(currentData, previousData);
    attributions.push(...resourceAttribution);
    
    // 按命名空间归因
    const namespaceAttribution = this.attributeByNamespace(currentData, previousData);
    attributions.push(...namespaceAttribution);
    
    // 排序并返回主要贡献者
    return attributions
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 10);
  }
  
  /**
   * 按服务归因
   */
  attributeByService(current, previous) {
    const results = [];
    const serviceChanges = new Map();
    
    // 计算各服务变化
    for (const item of current.services || []) {
      serviceChanges.set(item.service, {
        current: item.cost,
        previous: 0,
        service: item.service
      });
    }
    
    for (const item of previous.services || []) {
      const existing = serviceChanges.get(item.service) || { current: 0, service: item.service };
      existing.previous = item.cost;
      serviceChanges.set(item.service, existing);
    }
    
    // 计算变化率和贡献
    for (const [service, data] of serviceChanges) {
      const change = data.current - data.previous;
      const changePercent = data.previous > 0 
        ? ((change / data.previous) * 100).toFixed(2)
        : (data.current > 0 ? 100 : 0);
      
      results.push({
        dimension: 'service',
        key: service,
        currentValue: data.current,
        previousValue: data.previous,
        change,
        changePercent: parseFloat(changePercent),
        contribution: 0 // 后续计算
      });
    }
    
    // 计算贡献率
    const totalChange = results.reduce((sum, r) => sum + Math.abs(r.change), 0);
    for (const result of results) {
      result.contribution = totalChange > 0 
        ? Math.abs(result.change) / totalChange 
        : 0;
    }
    
    return results;
  }
  
  /**
   * 按资源类型归因
   */
  attributeByResourceType(current, previous) {
    const results = [];
    const resourceChanges = new Map();
    
    // 计算各资源类型变化
    for (const item of current.resourceTypes || []) {
      resourceChanges.set(item.type, {
        current: item.cost,
        previous: 0,
        type: item.type
      });
    }
    
    for (const item of previous.resourceTypes || []) {
      const existing = resourceChanges.get(item.type) || { current: 0, type: item.type };
      existing.previous = item.cost;
      resourceChanges.set(item.type, existing);
    }
    
    for (const [type, data] of resourceChanges) {
      const change = data.current - data.previous;
      const changePercent = data.previous > 0 
        ? ((change / data.previous) * 100).toFixed(2)
        : (data.current > 0 ? 100 : 0);
      
      results.push({
        dimension: 'resource_type',
        key: type,
        currentValue: data.current,
        previousValue: data.previous,
        change,
        changePercent: parseFloat(changePercent),
        contribution: 0
      });
    }
    
    const totalChange = results.reduce((sum, r) => sum + Math.abs(r.change), 0);
    for (const result of results) {
      result.contribution = totalChange > 0 
        ? Math.abs(result.change) / totalChange 
        : 0;
    }
    
    return results;
  }
  
  /**
   * 按命名空间归因
   */
  attributeByNamespace(current, previous) {
    const results = [];
    const nsChanges = new Map();
    
    for (const item of current.namespaces || []) {
      nsChanges.set(item.namespace, {
        current: item.cost,
        previous: 0,
        namespace: item.namespace
      });
    }
    
    for (const item of previous.namespaces || []) {
      const existing = nsChanges.get(item.namespace) || { current: 0, namespace: item.namespace };
      existing.previous = item.cost;
      nsChanges.set(item.namespace, existing);
    }
    
    for (const [namespace, data] of nsChanges) {
      const change = data.current - data.previous;
      const changePercent = data.previous > 0 
        ? ((change / data.previous) * 100).toFixed(2)
        : (data.current > 0 ? 100 : 0);
      
      results.push({
        dimension: 'namespace',
        key: namespace,
        currentValue: data.current,
        previousValue: data.previous,
        change,
        changePercent: parseFloat(changePercent),
        contribution: 0
      });
    }
    
    const totalChange = results.reduce((sum, r) => sum + Math.abs(r.change), 0);
    for (const result of results) {
      result.contribution = totalChange > 0 
        ? Math.abs(result.change) / totalChange 
        : 0;
    }
    
    return results;
  }
  
  /**
   * 生成归因报告
   */
  generateReport(attributions) {
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalContributors: attributions.length,
        topContributors: attributions.slice(0, 5),
        categories: this.categorizeAttributions(attributions)
      },
      details: attributions,
      recommendations: this.generateOptimizationRecommendations(attributions)
    };
    
    return report;
  }
  
  /**
   * 分类归因
   */
  categorizeAttributions(attributions) {
    const categories = {
      increased: attributions.filter(a => a.change > 0),
      decreased: attributions.filter(a => a.change < 0),
      stable: attributions.filter(a => a.change === 0)
    };
    
    return {
      increased: categories.increased.length,
      decreased: categories.decreased.length,
      stable: categories.stable.length,
      totalChange: categories.increased.reduce((sum, a) => sum + a.change, 0) +
                   categories.decreased.reduce((sum, a) => sum + a.change, 0)
    };
  }
  
  /**
   * 生成优化建议
   */
  generateOptimizationRecommendations(attributions) {
    const recommendations = [];
    
    // 检查成本大幅增加的服务
    for (const attr of attributions) {
      if (attr.changePercent > 50 && attr.change > 100) {
        recommendations.push({
          type: 'cost_increase',
          severity: 'high',
          target: attr.key,
          dimension: attr.dimension,
          suggestion: `${attr.key} 的成本增长了 ${attr.changePercent}%，建议检查资源使用情况`,
          potentialSaving: attr.change * 0.3 // 假设可节省30%
        });
      }
      
      // 检查高成本低利用率资源
      if (attr.currentValue > 1000 && attr.contribution > 0.1) {
        recommendations.push({
          type: 'optimization_opportunity',
          severity: 'medium',
          target: attr.key,
          dimension: attr.dimension,
          suggestion: `${attr.key} 占总成本的 ${(attr.contribution * 100).toFixed(1)}%，建议优化资源利用率`,
          potentialSaving: attr.currentValue * 0.2 // 假设可优化20%
        });
      }
    }
    
    return recommendations;
  }
}

module.exports = CostAttributor;
```

### 5. 告警通知服务

```javascript
// backend/shared/cost/CostAlertService.js
const { WebClient } = require('@slack/web-api');
const nodemailer = require('nodemailer');

class CostAlertService {
  constructor(options = {}) {
    this.slackClient = new WebClient(options.slackToken);
    this.emailTransporter = nodemailer.createTransport(options.emailConfig);
    this.alertQueue = [];
    this.isProcessing = false;
  }
  
  /**
   * 发送成本告警
   */
  async sendAlert(alert) {
    // 添加到队列
    this.alertQueue.push(alert);
    
    // 处理队列
    if (!this.isProcessing) {
      await this.processQueue();
    }
  }
  
  /**
   * 处理告警队列
   */
  async processQueue() {
    this.isProcessing = true;
    
    while (this.alertQueue.length > 0) {
      const alert = this.alertQueue.shift();
      
      try {
        // 发送到各渠道
        const promises = [];
        
        if (alert.channels.includes('slack')) {
          promises.push(this.sendToSlack(alert));
        }
        
        if (alert.channels.includes('email')) {
          promises.push(this.sendToEmail(alert));
        }
        
        await Promise.allSettled(promises);
        
      } catch (error) {
        console.error('Failed to send cost alert:', error);
        // 重试逻辑
        if (alert.retryCount < 3) {
          alert.retryCount = (alert.retryCount || 0) + 1;
          this.alertQueue.unshift(alert);
        }
      }
    }
    
    this.isProcessing = false;
  }
  
  /**
   * 发送到 Slack
   */
  async sendToSlack(alert) {
    const message = this.formatSlackMessage(alert);
    
    await this.slackClient.chat.postMessage({
      channel: process.env.COST_ALERT_SLACK_CHANNEL || '#cost-alerts',
      ...message
    });
  }
  
  /**
   * 格式化 Slack 消息
   */
  formatSlackMessage(alert) {
    const colorMap = {
      low: '#36a64f',
      medium: '#ff9900',
      high: '#ff6600',
      critical: '#ff0000'
    };
    
    const emojiMap = {
      low: '⚠️',
      medium: '🔶',
      high: '🔴',
      critical: '🚨'
    };
    
    return {
      text: `${emojiMap[alert.level]} ${alert.message.title}`,
      attachments: [{
        color: colorMap[alert.level],
        title: alert.message.title,
        fields: [
          {
            title: '当前支出',
            value: alert.message.details.currentSpend,
            short: true
          },
          {
            title: '预算金额',
            value: alert.message.details.budgetAmount,
            short: true
          },
          {
            title: '使用率',
            value: alert.message.details.utilization,
            short: true
          },
          {
            title: '阈值',
            value: alert.message.details.threshold,
            short: true
          }
        ],
        actions: alert.message.recommendations.slice(0, 3).map(rec => ({
          type: 'button',
          text: rec.action,
          url: `${process.env.ADMIN_DASHBOARD_URL}/cost/optimization`
        }))
      }]
    };
  }
  
  /**
   * 发送邮件
   */
  async sendToEmail(alert) {
    const emailContent = this.formatEmailContent(alert);
    
    await this.emailTransporter.sendMail({
      from: process.env.COST_ALERT_EMAIL_FROM,
      to: alert.recipients.join(','),
      subject: `${alert.message.title} - ${alert.level.toUpperCase()}`,
      html: emailContent
    });
  }
  
  /**
   * 格式化邮件内容
   */
  formatEmailContent(alert) {
    const recommendations = alert.message.recommendations
      .map(rec => `<li><strong>${rec.action}</strong>: ${rec.details}</li>`)
      .join('');
    
    return `
      <html>
        <body style="font-family: Arial, sans-serif;">
          <h2 style="color: ${alert.level === 'critical' ? '#ff0000' : '#333'}">
            ${alert.message.title}
          </h2>
          
          <table style="border-collapse: collapse; width: 100%; max-width: 500px;">
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;"><strong>预算名称</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${alert.message.details.budgetName}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;"><strong>当前支出</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${alert.message.details.currentSpend}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;"><strong>预算金额</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${alert.message.details.budgetAmount}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;"><strong>使用率</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${alert.message.details.utilization}</td>
            </tr>
          </table>
          
          <h3>建议行动</h3>
          <ul>${recommendations}</ul>
          
          <p style="margin-top: 20px;">
            <a href="${process.env.ADMIN_DASHBOARD_URL}/cost/dashboard"
               style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              查看成本仪表板
            </a>
          </p>
          
          <hr style="margin-top: 30px;">
          <p style="color: #666; font-size: 12px;">
            此邮件由 mineGo 成本监控系统自动发送 | ${alert.timestamp}
          </p>
        </body>
      </html>
    `;
  }
}

module.exports = CostAlertService;
```

### 6. 定时任务与集成

```javascript
// backend/jobs/costMonitoring.js
const cron = require('node-cron');
const CostDataCollector = require('../shared/cost/CostDataCollector');
const CostAnomalyDetector = require('../shared/cost/CostAnomalyDetector');
const BudgetManager = require('../shared/cost/BudgetManager');
const CostAttributor = require('../shared/cost/CostAttributor');
const CostAlertService = require('../shared/cost/CostAlertService');

class CostMonitoringJob {
  constructor() {
    this.collector = new CostDataCollector();
    this.anomalyDetector = new CostAnomalyDetector();
    this.budgetManager = new BudgetManager();
    this.attributor = new CostAttributor();
    this.alertService = new CostAlertService({
      slackToken: process.env.SLACK_BOT_TOKEN,
      emailConfig: {
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      }
    });
    
    this.setupEventHandlers();
  }
  
  /**
   * 设置事件处理器
   */
  setupEventHandlers() {
    // 异常检测事件
    this.anomalyDetector.on('anomaly', async (anomaly) => {
      console.log('[Cost Anomaly]', anomaly);
      await this.handleAnomaly(anomaly);
    });
    
    // 预算告警事件
    this.budgetManager.on('alert', async (alert) => {
      console.log('[Budget Alert]', alert);
      await this.alertService.sendAlert(alert);
    });
  }
  
  /**
   * 启动定时任务
   */
  start() {
    // 每小时采集成本数据
    cron.schedule('0 * * * *', async () => {
      console.log('[Cost Monitor] Starting hourly cost collection...');
      await this.collectAndAnalyze();
    });
    
    // 每6小时检查预算
    cron.schedule('0 */6 * * *', async () => {
      console.log('[Cost Monitor] Checking budgets...');
      await this.checkAllBudgets();
    });
    
    // 每天生成成本报告
    cron.schedule('0 9 * * *', async () => {
      console.log('[Cost Monitor] Generating daily report...');
      await this.generateDailyReport();
    });
    
    // 每周生成优化建议
    cron.schedule('0 10 * * 1', async () => {
      console.log('[Cost Monitor] Generating weekly optimization report...');
      await this.generateWeeklyOptimizationReport();
    });
    
    console.log('[Cost Monitor] Started successfully');
  }
  
  /**
   * 采集并分析数据
   */
  async collectAndAnalyze() {
    try {
      // 采集数据
      const costData = await this.collector.getRealtimeCost();
      
      // 异常检测
      for (const service of Object.keys(costData.services || {})) {
        const anomaly = await this.anomalyDetector.detect(
          {
            timestamp: costData.timestamp,
            amount: costData.services[service],
            labels: { service }
          },
          service
        );
        
        if (anomaly.isAnomaly) {
          console.log(`[Anomaly Detected] ${service}: ${anomaly.anomalyType}`);
        }
      }
      
    } catch (error) {
      console.error('[Cost Monitor] Collection error:', error);
    }
  }
  
  /**
   * 检查所有预算
   */
  async checkAllBudgets() {
    const budgets = this.budgetManager.budgets;
    
    for (const [budgetId, budget] of budgets) {
      // 获取当前支出
      const currentSpend = await this.getCurrentSpend(budget);
      
      // 检查预算
      const result = this.budgetManager.checkBudget(budgetId, currentSpend);
      
      console.log(`[Budget Check] ${budget.name}: ${(result.utilization * 100).toFixed(1)}%`);
    }
  }
  
  /**
   * 获取当前支出
   */
  async getCurrentSpend(budget) {
    // 根据预算范围查询成本
    const costData = await this.collector.getRealtimeCost();
    
    if (budget.scope === 'global') {
      return costData.total || 0;
    }
    
    if (budget.scope === 'namespace') {
      return costData.namespaces?.find(n => n.namespace === budget.scopeValue)?.cost || 0;
    }
    
    if (budget.scope === 'service') {
      return costData.services?.find(s => s.service === budget.scopeValue)?.cost || 0;
    }
    
    return 0;
  }
  
  /**
   * 处理异常
   */
  async handleAnomaly(anomaly) {
    // 发送告警
    await this.alertService.sendAlert({
      level: anomaly.score > 0.7 ? 'high' : 'medium',
      channels: ['slack', 'email'],
      recipients: ['ops@minego.com', 'finops@minego.com'],
      message: {
        title: `成本异常: ${anomaly.serviceKey}`,
        severity: anomaly.anomalyType,
        details: {
          service: anomaly.serviceKey,
          currentValue: `$${anomaly.currentValue.toFixed(2)}`,
          anomalyType: anomaly.anomalyType,
          score: `${(anomaly.score * 100).toFixed(0)}%`
        },
        recommendations: [
          {
            action: '检查服务资源使用',
            details: `该服务出现 ${anomaly.anomalyType} 类型的成本异常`
          }
        ]
      },
      timestamp: anomaly.timestamp
    });
  }
  
  /**
   * 生成每日报告
   */
  async generateDailyReport() {
    // 实现每日报告生成逻辑
  }
  
  /**
   * 生成每周优化报告
   */
  async generateWeeklyOptimizationReport() {
    // 实现每周优化报告逻辑
  }
}

module.exports = CostMonitoringJob;
```

### 7. API 路由集成

```javascript
// backend/services/admin-dashboard/routes/costRoutes.js
const express = require('express');
const router = express.Router();
const CostDataCollector = require('../../shared/cost/CostDataCollector');
const BudgetManager = require('../../shared/cost/BudgetManager');
const CostAttributor = require('../../shared/cost/CostAttributor');

const collector = new CostDataCollector();
const budgetManager = new BudgetManager();
const attributor = new CostAttributor();

/**
 * GET /api/cost/current
 * 获取当前成本数据
 */
router.get('/current', async (req, res) => {
  try {
    const data = await collector.getRealtimeCost();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/cost/history
 * 获取历史成本数据
 */
router.get('/history', async (req, res) => {
  try {
    const { startDate, endDate, groupBy } = req.query;
    const data = await collector.getHistoricalCost(startDate, endDate, groupBy);
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/cost/anomalies
 * 获取成本异常列表
 */
router.get('/anomalies', async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const anomalies = await collector.getAnomalies(limit, offset);
    res.json({ success: true, data: anomalies });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/cost/budgets
 * 创建预算
 */
router.post('/budgets', async (req, res) => {
  try {
    const budget = budgetManager.setBudget(Date.now().toString(), req.body);
    res.json({ success: true, data: budget });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/cost/budgets
 * 获取预算列表
 */
router.get('/budgets', async (req, res) => {
  try {
    const budgets = Array.from(budgetManager.budgets.values());
    res.json({ success: true, data: budgets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/cost/budgets/:id
 * 获取预算详情
 */
router.get('/budgets/:id', async (req, res) => {
  try {
    const budget = budgetManager.budgets.get(req.params.id);
    if (!budget) {
      return res.status(404).json({ success: false, error: 'Budget not found' });
    }
    res.json({ success: true, data: budget });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/cost/attribution
 * 获取成本归因分析
 */
router.get('/attribution', async (req, res) => {
  try {
    const currentData = await collector.getRealtimeCost();
    const previousData = await collector.getHistoricalCost(
      new Date(Date.now() - 7 * 24 * 3600000).toISOString().split('T')[0],
      new Date(Date.now() - 1 * 24 * 3600000).toISOString().split('T')[0]
    );
    
    const attribution = await attributor.analyze(currentData, previousData);
    const report = attributor.generateReport(attribution);
    
    res.json({ success: true, data: report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 成本数据采集器能实时获取 AWS Cost Explorer 数据
- [ ] 成本数据采集器能获取 Kubernetes 资源使用数据
- [ ] 异常检测引擎能检测成本突增、异常下降、趋势变化
- [ ] 异常检测准确率 >= 85%（基于历史数据验证）
- [ ] 预算管理支持月度、季度、年度预算
- [ ] 预算告警在 50%/80%/90%/100% 阈值触发
- [ ] 告警通知能发送到 Slack 和邮件
- [ ] 成本归因分析能定位成本变化的主要原因
- [ ] Admin Dashboard 能查看成本仪表板
- [ ] Prometheus 指标正确暴露成本数据
- [ ] 系统能处理每小时 10000+ 条成本数据点
- [ ] 告警延迟 < 5 分钟
- [ ] 数据保留 365 天用于趋势分析

## 影响范围

- 新增文件：
  - `backend/shared/cost/CostDataCollector.js`
  - `backend/shared/cost/CostAnomalyDetector.js`
  - `backend/shared/cost/BudgetManager.js`
  - `backend/shared/cost/CostAttributor.js`
  - `backend/shared/cost/CostAlertService.js`
  - `backend/jobs/costMonitoring.js`
  - `backend/services/admin-dashboard/routes/costRoutes.js`
- 修改文件：
  - `backend/services/admin-dashboard/index.js` (挂载路由)
  - `infrastructure/k8s/monitoring/prometheus.yml` (添加成本指标)
- 依赖：
  - AWS SDK v3 (Cost Explorer, CloudWatch)
  - Kubernetes Client
  - Slack Web API
  - Nodemailer
  - node-stats (统计分析)

## 参考

- [AWS Cost Explorer API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html)
- [Kubernetes Resource Metrics](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-usage-monitoring/)
- [FinOps Foundation](https://www.finops.org/)
- [Prometheus Metric Types](https://prometheus.io/docs/concepts/metric_types/)
