# REQ-00040: 云成本监控与预算告警系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00040 |
| 标题 | 云成本监控与预算告警系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | infrastructure/k8s、gateway、所有微服务、backend/shared |
| 创建时间 | 2026-06-08 23:30 |

## 需求描述

### 背景
mineGo 项目已部署到 K8s 环境，涉及多个云资源（计算、存储、网络、数据库）。随着用户规模增长，云成本可能快速膨胀，需要建立完善的成本监控与预算告警系统。

### 目标
1. 实时监控云资源使用成本
2. 按服务/命名空间细分成本归属
3. 设置预算阈值，超标自动告警
4. 提供成本趋势分析与优化建议
5. 支持成本报告自动生成

### 业务价值
- 预防预算超支，控制运营成本
- 识别资源浪费，优化利用率
- 支持成本中心核算，精细化运营
- 为扩容决策提供数据支撑

## 技术方案

### 1. 成本数据采集层

#### 1.1 Prometheus Metrics 扩展
```javascript
// backend/shared/costMetrics.js

const promClient = require('prom-client');

// 云资源成本指标
const costGauge = new promClient.Gauge({
  name: 'cloud_cost_total_usd',
  help: 'Total cloud cost in USD',
  labelNames: ['service', 'resource_type', 'namespace', 'provider']
});

const costByServiceGauge = new promClient.Gauge({
  name: 'cloud_cost_by_service_usd',
  help: 'Cloud cost per service in USD',
  labelNames: ['service_name', 'resource_type']
});

const budgetUsageGauge = new promClient.Gauge({
  name: 'budget_usage_percentage',
  help: 'Budget usage percentage',
  labelNames: ['budget_name', 'period']
});

// 资源使用指标
const resourceUtilizationGauge = new promClient.Gauge({
  name: 'resource_utilization_percentage',
  help: 'Resource utilization percentage',
  labelNames: ['service', 'resource_type', 'namespace']
});

// 预测成本指标
const predictedCostGauge = new promClient.Gauge({
  name: 'predicted_monthly_cost_usd',
  help: 'Predicted monthly cost based on current usage',
  labelNames: ['service']
});

module.exports = {
  costGauge,
  costByServiceGauge,
  budgetUsageGauge,
  resourceUtilizationGauge,
  predictedCostGauge
};
```

#### 1.2 云提供商 API 集成
```javascript
// backend/shared/cloudCostCollector.js

/**
 * 云成本数据采集器
 * 支持 AWS/Azure/GCP 阿里云等主流云厂商
 */
class CloudCostCollector {
  constructor(config = {}) {
    this.providers = new Map();
    this.config = config;
  }

  /**
   * 注册云提供商
   */
  registerProvider(name, adapter) {
    this.providers.set(name, adapter);
  }

  /**
   * 采集所有云提供商的成本数据
   */
  async collectAllCosts() {
    const results = [];
    
    for (const [name, adapter] of this.providers) {
      try {
        const cost = await adapter.getCost({
          granularity: 'DAILY',
          metrics: ['UnblendedCost'],
          timePeriod: this.getTimePeriod()
        });
        
        results.push({
          provider: name,
          data: cost,
          timestamp: Date.now()
        });
      } catch (error) {
        console.error(`Failed to collect cost from ${name}:`, error);
      }
    }
    
    return results;
  }

  /**
   * 按服务维度拆分成本
   */
  async collectCostByService(namespace = 'default') {
    const serviceCosts = new Map();
    
    // K8s 资源使用量采集
    const podMetrics = await this.getPodMetrics(namespace);
    
    // 节点成本分摊计算
    const nodeCostPerCore = await this.getNodeCostPerCore();
    const nodeCostPerMemory = await this.getNodeCostPerMemory();
    
    for (const pod of podMetrics) {
      const cpuCost = pod.cpuUsage * nodeCostPerCore;
      const memCost = pod.memoryUsage * nodeCostPerMemory;
      const serviceName = pod.labels['app'] || pod.labels['service'];
      
      const currentCost = serviceCosts.get(serviceName) || 0;
      serviceCosts.set(serviceName, currentCost + cpuCost + memCost);
    }
    
    return Object.fromEntries(serviceCosts);
  }

  /**
   * 获取 Pod 资源指标
   */
  async getPodMetrics(namespace) {
    // 通过 Kubernetes Metrics API 获取
    const metricsUrl = `${this.config.k8sApiUrl}/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods`;
    const response = await fetch(metricsUrl, {
      headers: { 'Authorization': `Bearer ${this.config.k8sToken}` }
    });
    
    const data = await response.json();
    return data.items.map(item => ({
      name: item.metadata.name,
      namespace: item.metadata.namespace,
      labels: item.metadata.labels,
      cpuUsage: this.parseCpu(item.containers[0].usage.cpu),
      memoryUsage: this.parseMemory(item.containers[0].usage.memory)
    }));
  }

  parseCpu(cpuStr) {
    // 转换 "100m" -> 0.1 cores
    if (cpuStr.endsWith('m')) {
      return parseInt(cpuStr) / 1000;
    }
    return parseFloat(cpuStr);
  }

  parseMemory(memStr) {
    // 转换 "512Mi" -> bytes
    const units = {
      'Ki': 1024,
      'Mi': 1024 * 1024,
      'Gi': 1024 * 1024 * 1024
    };
    
    for (const [unit, multiplier] of Object.entries(units)) {
      if (memStr.endsWith(unit)) {
        return parseFloat(memStr) * multiplier;
      }
    }
    return parseFloat(memStr);
  }

  getTimePeriod() {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    
    return {
      Start: start.toISOString().split('T')[0],
      End: end.toISOString().split('T')[0]
    };
  }
}

// AWS Cost Explorer 适配器
class AWSCostAdapter {
  constructor(config) {
    this.config = config;
  }

  async getCost(params) {
    // 调用 AWS Cost Explorer API
    const AWS = require('aws-sdk');
    const ce = new AWS.CostExplorer({ region: 'us-east-1' });
    
    const result = await ce.getCostAndUsage(params).promise();
    return result.ResultsByTime;
  }
}

// 阿里云成本适配器
class AliCloudCostAdapter {
  constructor(config) {
    this.config = config;
  }

  async getCost(params) {
    // 调用阿里云账单 API
    const response = await fetch('https://business.ap-southeast-1.aliyuncs.com/', {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify({
        Action: 'QueryBill',
        BillingCycle: params.timePeriod.Start.substring(0, 7)
      })
    });
    
    return await response.json();
  }

  getAuthHeaders() {
    // 实现阿里云签名
    return {
      'Content-Type': 'application/json',
      'Authorization': `ACS ${this.config.accessKeyId}:${this.getSignature()}`
    };
  }

  getSignature() {
    // 签名逻辑
    return '';
  }
}

module.exports = {
  CloudCostCollector,
  AWSCostAdapter,
  AliCloudCostAdapter
};
```

### 2. 预算管理与告警

#### 2.1 预算配置
```javascript
// backend/shared/budgetManager.js

const { budgetUsageGauge } = require('./costMetrics');
const { sendAlert } = require('./alerting');

/**
 * 预算管理器
 */
class BudgetManager {
  constructor(config = {}) {
    this.budgets = new Map();
    this.alertThresholds = config.alertThresholds || [0.5, 0.8, 0.9, 1.0];
    this.alertedThresholds = new Map();
  }

  /**
   * 添加预算配置
   */
  addBudget(budget) {
    this.budgets.set(budget.name, {
      ...budget,
      startDate: new Date(budget.startDate),
      endDate: budget.endDate ? new Date(budget.endDate) : null,
      scope: budget.scope || 'all', // 'all' | 'service' | 'namespace'
      notifications: budget.notifications || []
    });
  }

  /**
   * 检查预算状态
   */
  async checkBudgetStatus(currentCosts) {
    const results = [];
    
    for (const [name, budget] of this.budgets) {
      const period = this.getCurrentPeriod(budget);
      const spent = this.calculateSpent(currentCosts, budget);
      const percentage = spent / budget.amount;
      
      // 更新 Prometheus 指标
      budgetUsageGauge.set({ budget_name: name, period: period }, percentage);
      
      // 检查告警阈值
      const thresholdHit = this.checkThresholds(name, percentage);
      
      if (thresholdHit) {
        await this.sendBudgetAlert(budget, spent, percentage, thresholdHit);
      }
      
      results.push({
        name,
        spent,
        budget: budget.amount,
        percentage,
        thresholdHit,
        period
      });
    }
    
    return results;
  }

  /**
   * 检查阈值触发
   */
  checkThresholds(budgetName, percentage) {
    const alertedKey = (threshold) => `${budgetName}_${threshold}`;
    
    for (const threshold of this.alertThresholds) {
      if (percentage >= threshold) {
        // 避免重复告警
        if (!this.alertedThresholds.has(alertedKey(threshold))) {
          this.alertedThresholds.set(alertedKey(threshold), true);
          return threshold;
        }
      }
    }
    
    return null;
  }

  /**
   * 发送预算告警
   */
  async sendBudgetAlert(budget, spent, percentage, threshold) {
    const alertLevel = threshold >= 1.0 ? 'critical' : 
                        threshold >= 0.9 ? 'high' : 
                        threshold >= 0.8 ? 'warning' : 'info';
    
    const message = {
      type: 'budget_alert',
      level: alertLevel,
      budget: budget.name,
      spent: spent.toFixed(2),
      limit: budget.amount.toFixed(2),
      percentage: (percentage * 100).toFixed(1),
      threshold: (threshold * 100).toFixed(0),
      timestamp: new Date().toISOString()
    };
    
    // 多渠道通知
    for (const channel of budget.notifications) {
      await sendAlert({
        channel: channel.type,
        recipient: channel.recipient,
        subject: `[${alertLevel.toUpperCase()}] 预算告警: ${budget.name}`,
        body: this.formatAlertMessage(message)
      });
    }
  }

  formatAlertMessage(message) {
    return `
预算告警通知

预算名称: ${message.budget}
告警等级: ${message.level.toUpperCase()}
使用金额: $${message.spent}
预算限额: $${message.limit}
使用比例: ${message.percentage}%
触发阈值: ${message.threshold}%

时间: ${message.timestamp}

请及时检查云资源使用情况，必要时调整预算或优化资源。
    `.trim();
  }

  getCurrentPeriod(budget) {
    const now = new Date();
    
    if (budget.period === 'monthly') {
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    } else if (budget.period === 'weekly') {
      const week = Math.ceil(now.getDate() / 7);
      return `${now.getFullYear()}-W${week}`;
    }
    
    return now.getFullYear().toString();
  }

  calculateSpent(costs, budget) {
    if (budget.scope === 'all') {
      return costs.reduce((sum, c) => sum + c.amount, 0);
    } else if (budget.scope === 'service') {
      return costs
        .filter(c => budget.services?.includes(c.service))
        .reduce((sum, c) => sum + c.amount, 0);
    }
    
    return 0;
  }

  /**
   * 重置告警状态（新周期）
   */
  resetAlerts() {
    this.alertedThresholds.clear();
  }
}

module.exports = { BudgetManager };
```

### 3. 成本预测与趋势分析

```javascript
// backend/shared/costPredictor.js

/**
 * 成本预测器
 * 基于历史数据进行预测
 */
class CostPredictor {
  constructor(historicalData = []) {
    this.historicalData = historicalData;
  }

  /**
   * 线性回归预测
   */
  predictLinearRegression(days = 30) {
    const data = this.historicalData.slice(-30); // 使用最近 30 天数据
    
    if (data.length < 7) {
      return null; // 数据不足
    }
    
    // 最小二乘法
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = data.length;
    
    data.forEach((point, i) => {
      const x = i;
      const y = point.cost;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    });
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // 预测未来 N 天
    const predictions = [];
    for (let i = 0; i < days; i++) {
      predictions.push({
        day: i + 1,
        predictedCost: slope * (data.length + i) + intercept
      });
    }
    
    return {
      method: 'linear_regression',
      slope,
      intercept,
      predictions,
      monthlyTotal: this.calculateMonthlyTotal(predictions)
    };
  }

  /**
   * 移动平均预测
   */
  predictMovingAverage(windowSize = 7, days = 30) {
    const data = this.historicalData.slice(-windowSize);
    
    if (data.length < windowSize) {
      return null;
    }
    
    const avgCost = data.reduce((sum, d) => sum + d.cost, 0) / data.length;
    
    const predictions = [];
    for (let i = 0; i < days; i++) {
      predictions.push({
        day: i + 1,
        predictedCost: avgCost
      });
    }
    
    return {
      method: 'moving_average',
      windowSize,
      predictions,
      monthlyTotal: avgCost * 30
    };
  }

  /**
   * 计算月度预测总额
   */
  calculateMonthlyTotal(predictions) {
    return predictions.slice(0, 30).reduce((sum, p) => sum + p.predictedCost, 0);
  }

  /**
   * 检测异常成本
   */
  detectAnomalies(threshold = 2) {
    const data = this.historicalData;
    
    if (data.length < 7) {
      return [];
    }
    
    const mean = data.reduce((sum, d) => sum + d.cost, 0) / data.length;
    const variance = data.reduce((sum, d) => sum + Math.pow(d.cost - mean, 2), 0) / data.length;
    const stdDev = Math.sqrt(variance);
    
    return data.filter(d => {
      const zScore = Math.abs((d.cost - mean) / stdDev);
      return zScore > threshold;
    });
  }

  /**
   * 生成成本优化建议
   */
  generateOptimizationSuggestions(currentCosts) {
    const suggestions = [];
    
    // 检查低利用率资源
    currentCosts.forEach(cost => {
      if (cost.utilization < 0.2) {
        suggestions.push({
          type: 'underutilized',
          service: cost.service,
          resourceType: cost.resourceType,
          currentUtilization: cost.utilization,
          recommendation: `资源利用率仅 ${(cost.utilization * 100).toFixed(1)}%，建议缩小配置`,
          potentialSaving: cost.monthlyCost * 0.5
        });
      }
    });
    
    // 检查预留实例机会
    const steadyServices = currentCosts.filter(c => c.variance < 0.1);
    steadyServices.forEach(service => {
      suggestions.push({
        type: 'reserved_instance',
        service: service.service,
        recommendation: '资源使用稳定，建议购买预留实例节省成本',
        potentialSaving: service.monthlyCost * 0.3
      });
    });
    
    return suggestions.sort((a, b) => b.potentialSaving - a.potentialSaving);
  }
}

module.exports = { CostPredictor };
```

### 4. 成本报告 API

```javascript
// backend/gateway/src/routes/costReport.js

const express = require('express');
const router = express.Router();
const { CloudCostCollector } = require('../../shared/cloudCostCollector');
const { BudgetManager } = require('../../shared/budgetManager');
const { CostPredictor } = require('../../shared/costPredictor');

// 初始化
const costCollector = new CloudCostCollector();
const budgetManager = new BudgetManager();

/**
 * GET /api/costs/summary
 * 获取成本概览
 */
router.get('/summary', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    
    const costs = await costCollector.collectAllCosts();
    const byService = await costCollector.collectCostByService('default');
    
    const total = costs.reduce((sum, c) => {
      return sum + c.data.reduce((s, d) => s + parseFloat(d.Total.UnblendedCost.Amount), 0);
    }, 0);
    
    res.json({
      period,
      totalCost: total,
      currency: 'USD',
      byService,
      byProvider: costs.map(c => ({
        provider: c.provider,
        total: c.data.reduce((s, d) => s + parseFloat(d.Total?.UnblendedCost?.Amount || 0), 0)
      })),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/by-service
 * 按服务获取成本
 */
router.get('/by-service', async (req, res) => {
  try {
    const { namespace = 'default', days = 7 } = req.query;
    
    const costs = await costCollector.collectCostByService(namespace);
    
    res.json({
      namespace,
      period: `${days}d`,
      services: Object.entries(costs).map(([name, cost]) => ({
        name,
        cost,
        currency: 'USD'
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/budgets
 * 获取预算列表和状态
 */
router.get('/budgets', async (req, res) => {
  try {
    const costs = await costCollector.collectAllCosts();
    const status = await budgetManager.checkBudgetStatus(costs);
    
    res.json({
      budgets: status,
      totalBudget: Array.from(budgetManager.budgets.values())
        .reduce((sum, b) => sum + b.amount, 0),
      totalSpent: status.reduce((sum, s) => sum + s.spent, 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/budgets
 * 创建新预算
 */
router.post('/budgets', async (req, res) => {
  try {
    const { name, amount, period, scope, notifications } = req.body;
    
    budgetManager.addBudget({
      name,
      amount: parseFloat(amount),
      period: period || 'monthly',
      scope: scope || 'all',
      notifications: notifications || [],
      startDate: new Date()
    });
    
    res.status(201).json({ message: 'Budget created', name });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/prediction
 * 获取成本预测
 */
router.get('/prediction', async (req, res) => {
  try {
    const historicalData = await this.getHistoricalData(30);
    const predictor = new CostPredictor(historicalData);
    
    const linear = predictor.predictLinearRegression(30);
    const anomalies = predictor.detectAnomalies();
    const currentCosts = await costCollector.collectCostByService('default');
    const suggestions = predictor.generateOptimizationSuggestions(currentCosts);
    
    res.json({
      prediction: linear,
      anomalies,
      optimizationSuggestions: suggestions,
      potentialMonthlySaving: suggestions.reduce((sum, s) => sum + s.potentialSaving, 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/costs/report
 * 生成成本报告
 */
router.get('/report', async (req, res) => {
  try {
    const { format = 'json', period = 'monthly' } = req.query;
    
    const costs = await costCollector.collectAllCosts();
    const byService = await costCollector.collectCostByService('default');
    const budgetStatus = await budgetManager.checkBudgetStatus(costs);
    const historicalData = await this.getHistoricalData(30);
    const predictor = new CostPredictor(historicalData);
    const prediction = predictor.predictLinearRegression(30);
    const suggestions = predictor.generateOptimizationSuggestions(byService);
    
    const report = {
      generatedAt: new Date().toISOString(),
      period,
      summary: {
        totalCost: costs.reduce((sum, c) => sum + c.total, 0),
        byService,
        byProvider: costs.map(c => ({ provider: c.provider, total: c.total })),
        budgetStatus
      },
      prediction,
      recommendations: suggestions,
      nextSteps: this.generateNextSteps(suggestions)
    };
    
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.send(this.convertToCSV(report));
    } else {
      res.json(report);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

### 5. 定时任务与监控集成

```javascript
// backend/shared/costMonitor.js

const cron = require('node-cron');
const { CloudCostCollector } = require('./cloudCostCollector');
const { BudgetManager } = require('./budgetManager');
const { costGauge, costByServiceGauge, predictedCostGauge } = require('./costMetrics');
const logger = require('./logger');

/**
 * 成本监控定时任务
 */
class CostMonitor {
  constructor(config = {}) {
    this.collector = new CloudCostCollector(config);
    this.budgetManager = new BudgetManager(config);
    this.isRunning = false;
  }

  /**
   * 启动定时监控
   */
  start() {
    if (this.isRunning) return;
    
    // 每小时采集一次成本数据
    cron.schedule('0 * * * *', () => this.collectAndReport());
    
    // 每天重置预算告警状态
    cron.schedule('0 0 * * *', () => this.budgetManager.resetAlerts());
    
    // 每周生成成本报告
    cron.schedule('0 0 * * 0', () => this.generateWeeklyReport());
    
    this.isRunning = true;
    logger.info('Cost monitor started');
  }

  /**
   * 采集并上报成本数据
   */
  async collectAndReport() {
    try {
      logger.info('Starting cost collection...');
      
      // 采集云成本
      const costs = await this.collector.collectAllCosts();
      
      // 更新 Prometheus 指标
      for (const cost of costs) {
        const total = cost.data.reduce((sum, d) => 
          sum + parseFloat(d.Total?.UnblendedCost?.Amount || 0), 0);
        
        costGauge.set(
          { provider: cost.provider, resource_type: 'all', namespace: 'default' },
          total
        );
      }
      
      // 按服务维度采集
      const serviceCosts = await this.collector.collectCostByService('default');
      
      for (const [service, cost] of Object.entries(serviceCosts)) {
        costByServiceGauge.set(
          { service_name: service, resource_type: 'compute' },
          cost
        );
      }
      
      // 检查预算
      await this.budgetManager.checkBudgetStatus(costs);
      
      logger.info('Cost collection completed', { 
        providers: costs.length,
        services: Object.keys(serviceCosts).length
      });
    } catch (error) {
      logger.error('Cost collection failed', { error: error.message });
    }
  }

  /**
   * 生成周报
   */
  async generateWeeklyReport() {
    try {
      logger.info('Generating weekly cost report...');
      
      const report = await this.generateReport('weekly');
      
      // 发送邮件通知
      await this.sendReportEmail(report);
      
      logger.info('Weekly report sent');
    } catch (error) {
      logger.error('Failed to generate weekly report', { error: error.message });
    }
  }

  async sendReportEmail(report) {
    // 集成邮件服务发送报告
  }
}

module.exports = { CostMonitor };
```

### 6. 数据库表设计

```sql
-- database/pending/20260608_233000__add_cloud_cost_tables.sql

-- 预算配置表
CREATE TABLE budget_configs (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  period VARCHAR(20) NOT NULL, -- 'daily', 'weekly', 'monthly'
  scope VARCHAR(20) NOT NULL, -- 'all', 'service', 'namespace'
  scope_values JSONB, -- 具体的服务或命名空间列表
  alert_thresholds JSONB DEFAULT '[0.5, 0.8, 0.9, 1.0]',
  notifications JSONB, -- 通知渠道配置
  start_date TIMESTAMP WITH TIME ZONE NOT NULL,
  end_date TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 成本记录表
CREATE TABLE cost_records (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  service_name VARCHAR(100),
  namespace VARCHAR(100),
  resource_type VARCHAR(50),
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'USD',
  period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cost_records_provider ON cost_records(provider);
CREATE INDEX idx_cost_records_service ON cost_records(service_name);
CREATE INDEX idx_cost_records_period ON cost_records(period_start, period_end);

-- 预算告警历史表
CREATE TABLE budget_alerts (
  id SERIAL PRIMARY KEY,
  budget_name VARCHAR(100) NOT NULL REFERENCES budget_configs(name),
  threshold DECIMAL(3, 2) NOT NULL,
  percentage DECIMAL(5, 2) NOT NULL,
  spent_amount DECIMAL(10, 2) NOT NULL,
  budget_amount DECIMAL(10, 2) NOT NULL,
  alert_level VARCHAR(20) NOT NULL,
  notified_channels JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_budget_alerts_budget ON budget_alerts(budget_name);
CREATE INDEX idx_budget_alerts_created ON budget_alerts(created_at DESC);

-- 成本优化建议表
CREATE TABLE cost_optimization_suggestions (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  service_name VARCHAR(100),
  resource_type VARCHAR(50),
  current_value DECIMAL(10, 2),
  recommended_value DECIMAL(10, 2),
  potential_saving DECIMAL(10, 2),
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'applied', 'dismissed'
  applied_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认预算配置
INSERT INTO budget_configs (name, amount, period, scope, notifications, start_date)
VALUES 
  ('monthly-total', 1000.00, 'monthly', 'all', 
   '[{"type": "email", "recipient": "ops@example.com"}, {"type": "slack", "recipient": "#alerts"}]',
   CURRENT_TIMESTAMP),
  ('user-service-budget', 200.00, 'monthly', 'service',
   '[{"type": "email", "recipient": "user-team@example.com"}]',
   CURRENT_TIMESTAMP);
```

## 验收标准

- [ ] 云成本数据能从主流云厂商（AWS/阿里云）采集
- [ ] 按服务维度拆分成本，支持命名空间过滤
- [ ] 预算阈值配置支持 50%/80%/90%/100% 四级
- [ ] 超过阈值时发送多渠道告警（邮件/Slack/钉钉）
- [ ] 成本预测准确率 > 80%（基于 7 天历史）
- [ ] 生成周报/月报，支持 JSON/CSV 格式
- [ ] Prometheus 指标暴露：cloud_cost_total_usd 等 5 个核心指标
- [ ] API 端点：/api/costs/summary、/api/budgets、/api/costs/prediction
- [ ] 单元测试覆盖 > 85%
- [ ] 文档完善：API 文档、配置指南

## 影响范围

- **新增文件**:
  - backend/shared/costMetrics.js
  - backend/shared/cloudCostCollector.js
  - backend/shared/budgetManager.js
  - backend/shared/costPredictor.js
  - backend/shared/costMonitor.js
  - backend/gateway/src/routes/costReport.js
  - database/pending/20260608_233000__add_cloud_cost_tables.sql
  
- **修改文件**:
  - backend/gateway/src/index.js（集成成本报告路由）
  - backend/shared/metrics.js（扩展成本相关指标）
  - infrastructure/k8s/monitoring/prometheus-rules.yml（添加成本告警规则）
  
- **配置文件**:
  - .env.example（添加云厂商凭证模板）

## 参考

- AWS Cost Explorer API: https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_CostExplorer.html
- Kubernetes Resource Quotas: https://kubernetes.io/docs/concepts/policy/resource-quotas/
- Prometheus Cost Monitoring: https://sustainable-computing.io/
- OpenCost: https://opencost.io/
