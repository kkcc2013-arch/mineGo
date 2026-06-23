# REQ-00297: 云成本异常检测与预算超支预警系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00297 |
| 标题 | 云成本异常检测与预算超支预警系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, monitoring, backend/shared/cost, Prometheus, Grafana, Slack, Email |
| 创建时间 | 2026-06-23 14:00 |

## 需求描述

建立云成本实时监控与异常检测系统，自动识别成本异常波动，提供预算超支预警，帮助团队及时发现并处理成本问题，避免云账单意外超支。

### 核心目标
1. **成本数据采集** - 多维度收集云资源消耗数据
2. **异常检测算法** - 基于 ML 的成本异常识别
3. **预算管理** - 预算设置、追踪、预警一体化
4. **智能告警** - 多渠道分级告警通知
5. **成本归因** - 自动归属成本到具体服务/团队

## 技术方案

### 1. 成本数据采集器 (CostDataCollector)

```typescript
// backend/shared/cost/collector.ts
interface CostDataPoint {
  timestamp: Date;
  service: string;
  resourceType: 'compute' | 'storage' | 'network' | 'database' | 'cache';
  provider: 'aws' | 'gcp' | 'azure';
  region: string;
  cost: number;
  usage: {
    cpu: number;
    memory: number;
    storage: number;
    bandwidth: number;
  };
  tags: Record<string, string>;
}

class CostDataCollector {
  private collectors: Map<string, CloudProviderCollector>;
  
  constructor() {
    this.collectors.set('aws', new AWSCostCollector());
    this.collectors.set('gcp', new GCPCostCollector());
    this.collectors.set('azure', new AzureCostCollector());
  }
  
  async collectCostData(): Promise<CostDataPoint[]> {
    const results: CostDataPoint[] = [];
    
    for (const [provider, collector] of this.collectors) {
      try {
        const data = await collector.getCostAndUsage({
          timeRange: this.getTimeRange('hourly'),
          granularity: 'HOURLY',
          metrics: ['BlendedCost', 'UsageQuantity'],
          groupBy: ['SERVICE', 'RESOURCE_TYPE', 'REGION']
        });
        results.push(...this.normalizeData(data, provider));
      } catch (error) {
        logger.error(`Failed to collect from ${provider}`, error);
      }
    }
    
    return results;
  }
  
  async storeCostData(data: CostDataPoint[]): Promise<void> {
    // 存储到时序数据库
    await prometheus.registerGauge({
      name: 'cloud_cost_hourly',
      help: 'Hourly cloud cost breakdown',
      labelNames: ['provider', 'service', 'resource_type', 'region']
    });
    
    for (const point of data) {
      await prometheus.gauge('cloud_cost_hourly', point.cost, {
        provider: point.provider,
        service: point.service,
        resource_type: point.resourceType,
        region: point.region
      });
    }
    
    // 持久化到数据库
    await db.costRecords.insertBatch(data);
  }
}
```

### 2. 异常检测引擎 (AnomalyDetectionEngine)

```typescript
// backend/shared/cost/anomaly-detector.ts
interface AnomalyResult {
  timestamp: Date;
  service: string;
  actualCost: number;
  expectedCost: number;
  deviation: number;
  deviationPercent: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  possibleCauses: string[];
  recommendations: string[];
}

class AnomalyDetectionEngine {
  private baselineWindow = 30; // 30天基线
  private sensitivityThreshold = 0.2; // 20%偏差阈值
  
  async detectAnomalies(
    currentData: CostDataPoint[],
    historicalData: CostDataPoint[]
  ): Promise<AnomalyResult[]> {
    const anomalies: AnomalyResult[] = [];
    
    // 按服务分组
    const serviceGroups = this.groupByService(currentData);
    
    for (const [service, data] of serviceGroups) {
      const historical = historicalData.filter(d => d.service === service);
      
      // 计算基线
      const baseline = this.calculateBaseline(historical);
      const current = this.aggregateCurrent(data);
      
      // 统计异常检测
      const statisticalAnomaly = this.statisticalDetection(current, baseline);
      
      // 趋势异常检测
      const trendAnomaly = this.trendDetection(current, historical);
      
      // ML异常检测（使用Isolation Forest）
      const mlAnomaly = await this.mlDetection(current, historical);
      
      // 综合评分
      const score = this.calculateAnomalyScore(
        statisticalAnomaly,
        trendAnomaly,
        mlAnomaly
      );
      
      if (score > this.sensitivityThreshold) {
        anomalies.push({
          timestamp: new Date(),
          service,
          actualCost: current,
          expectedCost: baseline.mean,
          deviation: current - baseline.mean,
          deviationPercent: (current - baseline.mean) / baseline.mean * 100,
          severity: this.getSeverity(score),
          possibleCauses: await this.identifyCauses(service, current, baseline),
          recommendations: this.generateRecommendations(service, score)
        });
      }
    }
    
    return anomalies;
  }
  
  private calculateBaseline(data: CostDataPoint[]): {
    mean: number;
    std: number;
    median: number;
    p95: number;
  } {
    const costs = data.map(d => d.cost);
    return {
      mean: ss.mean(costs),
      std: ss.standardDeviation(costs),
      median: ss.median(costs),
      p95: ss.quantile(costs, 0.95)
    };
  }
  
  private async mlDetection(
    current: number,
    historical: CostDataPoint[]
  ): Promise<number> {
    // 使用Isolation Forest算法
    const features = this.extractFeatures(historical);
    const isolationForest = new IsolationForest({
      nTrees: 100,
      contamination: 0.1
    });
    
    await isolationForest.fit(features);
    const score = isolationForest.anomalyScore([current]);
    
    return score;
  }
  
  private async identifyCauses(
    service: string,
    current: number,
    baseline: { mean: number }
  ): Promise<string[]> {
    const causes: string[] = [];
    
    // 检查资源使用量变化
    const usageChange = await this.checkUsageChange(service);
    if (usageChange.increased) {
      causes.push(`资源使用量增加 ${usageChange.percent}%`);
    }
    
    // 检查定价变化
    const priceChange = await this.checkPriceChange(service);
    if (priceChange.changed) {
      causes.push(`云服务商定价调整`);
    }
    
    // 检查配置变更
    const configChange = await this.checkConfigChange(service);
    if (configChange.changed) {
      causes.push(`实例规格/配置变更`);
    }
    
    // 检查异常流量
    const trafficAnomaly = await this.checkTrafficAnomaly(service);
    if (trafficAnomaly.anomalous) {
      causes.push(`异常流量激增`);
    }
    
    return causes;
  }
}
```

### 3. 预算管理系统 (BudgetManager)

```typescript
// backend/shared/cost/budget-manager.ts
interface Budget {
  id: string;
  name: string;
  type: 'total' | 'service' | 'team' | 'project';
  targetId: string;
  amount: number;
  period: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  startDate: Date;
  endDate?: Date;
  alerts: BudgetAlert[];
  tags: string[];
}

interface BudgetAlert {
  threshold: number; // 百分比
  channels: ('email' | 'slack' | 'pagerduty')[];
  recipients: string[];
}

interface BudgetStatus {
  budgetId: string;
  periodStart: Date;
  periodEnd: Date;
  budgetAmount: number;
  spentAmount: number;
  remainingAmount: number;
  percentUsed: number;
  forecastedSpend: number;
  status: 'on_track' | 'at_risk' | 'over_budget';
}

class BudgetManager {
  async createBudget(budget: Omit<Budget, 'id'>): Promise<Budget> {
    const id = generateId();
    const newBudget = { ...budget, id };
    
    await db.budgets.create(newBudget);
    
    // 初始化监控
    await this.initializeBudgetMonitoring(newBudget);
    
    return newBudget;
  }
  
  async getBudgetStatus(budgetId: string): Promise<BudgetStatus> {
    const budget = await db.budgets.findById(budgetId);
    const period = this.getCurrentPeriod(budget);
    
    // 获取当前周期花费
    const spent = await this.calculateSpent(budget, period);
    
    // 预测周期末花费
    const forecast = await this.forecastSpend(budget, spent, period);
    
    return {
      budgetId,
      periodStart: period.start,
      periodEnd: period.end,
      budgetAmount: budget.amount,
      spentAmount: spent,
      remainingAmount: budget.amount - spent,
      percentUsed: (spent / budget.amount) * 100,
      forecastedSpend: forecast,
      status: this.determineStatus(spent, forecast, budget.amount)
    };
  }
  
  async checkBudgetAlerts(): Promise<void> {
    const budgets = await db.budgets.findActive();
    
    for (const budget of budgets) {
      const status = await this.getBudgetStatus(budget.id);
      
      for (const alert of budget.alerts) {
        if (status.percentUsed >= alert.threshold) {
          // 检查是否已发送过此阈值告警
          const alreadyAlerted = await this.checkAlertHistory(
            budget.id,
            alert.threshold,
            status.periodStart
          );
          
          if (!alreadyAlerted) {
            await this.sendAlert(budget, status, alert);
            await this.recordAlert(budget.id, alert.threshold);
          }
        }
      }
      
      // 预测超支预警
      if (status.forecastedSpend > budget.amount) {
        await this.sendForecastAlert(budget, status);
      }
    }
  }
  
  private async forecastSpend(
    budget: Budget,
    currentSpent: number,
    period: { start: Date; end: Date }
  ): Promise<number> {
    const totalDays = differenceInDays(period.end, period.start);
    const elapsedDays = differenceInDays(new Date(), period.start);
    const remainingDays = totalDays - elapsedDays;
    
    // 基于历史数据的加权预测
    const historicalAvg = await this.getHistoricalAvgSpend(budget);
    const recentTrend = await this.getRecentTrend(budget, 7);
    
    // 组合预测
    const dailyBurn = currentSpent / elapsedDays;
    const forecastedRemaining = (dailyBurn * 0.5 + recentTrend * 0.3 + historicalAvg * 0.2) * remainingDays;
    
    return currentSpent + forecastedRemaining;
  }
}
```

### 4. 智能告警系统 (AlertingSystem)

```typescript
// backend/shared/cost/alerting.ts
interface CostAlert {
  id: string;
  type: 'anomaly' | 'budget_threshold' | 'forecast' | 'trend';
  severity: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  details: Record<string, any>;
  channels: string[];
  recipients: string[];
  createdAt: Date;
  acknowledged: boolean;
}

class CostAlertingSystem {
  private notifiers: Map<string, Notifier>;
  
  constructor() {
    this.notifiers = new Map([
      ['email', new EmailNotifier()],
      ['slack', new SlackNotifier()],
      ['pagerduty', new PagerDutyNotifier()],
      ['webhook', new WebhookNotifier()]
    ]);
  }
  
  async sendAnomalyAlert(anomaly: AnomalyResult): Promise<void> {
    const alert: CostAlert = {
      id: generateId(),
      type: 'anomaly',
      severity: this.mapSeverity(anomaly.severity),
      title: `成本异常: ${anomaly.service}`,
      message: this.formatAnomalyMessage(anomaly),
      details: anomaly,
      channels: this.getAlertChannels(anomaly.severity),
      recipients: await this.getServiceOwners(anomaly.service),
      createdAt: new Date(),
      acknowledged: false
    };
    
    await this.sendAlert(alert);
  }
  
  async sendBudgetAlert(
    budget: Budget,
    status: BudgetStatus,
    alert: BudgetAlert
  ): Promise<void> {
    const alertData: CostAlert = {
      id: generateId(),
      type: 'budget_threshold',
      severity: this.getBudgetSeverity(status.percentUsed),
      title: `预算告警: ${budget.name} 已使用 ${status.percentUsed.toFixed(1)}%`,
      message: this.formatBudgetMessage(budget, status),
      details: { budget, status },
      channels: alert.channels,
      recipients: alert.recipients,
      createdAt: new Date(),
      acknowledged: false
    };
    
    await this.sendAlert(alertData);
  }
  
  private formatAnomalyMessage(anomaly: AnomalyResult): string {
    return `
🔴 **成本异常检测**

**服务**: ${anomaly.service}
**当前花费**: $${anomaly.actualCost.toFixed(2)}
**预期花费**: $${anomaly.expectedCost.toFixed(2)}
**偏差**: ${anomaly.deviationPercent.toFixed(1)}% ($${anomaly.deviation.toFixed(2)})

**可能原因**:
${anomaly.possibleCauses.map(c => `• ${c}`).join('\n')}

**建议操作**:
${anomaly.recommendations.map(r => `• ${r}`).join('\n')}

[查看详情](${this.getDashboardUrl(anomaly.service)})
    `.trim();
  }
  
  private async sendAlert(alert: CostAlert): Promise<void> {
    // 存储告警记录
    await db.costAlerts.create(alert);
    
    // 发送到各渠道
    for (const channel of alert.channels) {
      const notifier = this.notifiers.get(channel);
      if (notifier) {
        try {
          await notifier.send(alert);
        } catch (error) {
          logger.error(`Failed to send alert via ${channel}`, error);
        }
      }
    }
    
    // 更新Prometheus指标
    await prometheus.counter('cost_alerts_total', 1, {
      type: alert.type,
      severity: alert.severity
    });
  }
}
```

### 5. 成本归因服务 (CostAttributionService)

```typescript
// backend/shared/cost/attribution.ts
interface CostAttribution {
  service: string;
  team: string;
  project: string;
  environment: 'production' | 'staging' | 'development';
  cost: number;
  percent: number;
}

class CostAttributionService {
  private tagMapping: Map<string, CostAttribution>;
  
  constructor() {
    this.tagMapping = new Map();
  }
  
  async attributeCosts(costData: CostDataPoint[]): Promise<CostAttribution[]> {
    const attributions: CostAttribution[] = [];
    const totalCost = costData.reduce((sum, d) => sum + d.cost, 0);
    
    for (const point of costData) {
      // 优先使用云资源标签
      const attribution = await this.getAttributionFromTags(point.tags);
      
      if (!attribution) {
        // 回退到资源命名规则推断
        const inferred = await this.inferAttribution(point);
        attribution = inferred;
      }
      
      // 聚合归因数据
      const key = `${attribution.service}-${attribution.team}`;
      const existing = attributions.find(
        a => a.service === attribution.service && a.team === attribution.team
      );
      
      if (existing) {
        existing.cost += point.cost;
        existing.percent = (existing.cost / totalCost) * 100;
      } else {
        attributions.push({
          ...attribution,
          cost: point.cost,
          percent: (point.cost / totalCost) * 100
        });
      }
    }
    
    return attributions;
  }
  
  async generateCostReport(
    period: { start: Date; end: Date },
    groupBy: 'service' | 'team' | 'project'
  ): Promise<CostReport> {
    const costData = await this.getCostData(period);
    const attributions = await this.attributeCosts(costData);
    
    const grouped = this.groupBy(attributions, groupBy);
    
    return {
      period,
      totalCost: costData.reduce((sum, d) => sum + d.cost, 0),
      breakdown: Object.entries(grouped).map(([key, items]) => ({
        name: key,
        cost: items.reduce((sum, i) => sum + i.cost, 0),
        items
      })),
      comparison: await this.getPeriodComparison(period),
      trends: await this.getCostTrends(period, groupBy)
    };
  }
}
```

### 6. Grafana 仪表盘配置

```yaml
# infrastructure/monitoring/dashboards/cost-overview.json
{
  "dashboard": {
    "title": "Cloud Cost Overview",
    "panels": [
      {
        "title": "Total Monthly Cost",
        "type": "stat",
        "targets": [
          {
            "expr": "sum(cloud_cost_hourly) * 24 * 30",
            "legendFormat": "Projected Monthly"
          }
        ]
      },
      {
        "title": "Cost by Service",
        "type": "piechart",
        "targets": [
          {
            "expr": "sum by (service) (cloud_cost_hourly)",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "Cost Trend (7 Days)",
        "type": "timeseries",
        "targets": [
          {
            "expr": "sum(cloud_cost_hourly)",
            "legendFormat": "Total"
          },
          {
            "expr": "avg_over_time(cloud_cost_hourly[7d])",
            "legendFormat": "7-day Average"
          }
        ]
      },
      {
        "title": "Budget Status",
        "type": "table",
        "targets": [
          {
            "expr": "budget_percent_used",
            "format": "table"
          }
        ]
      },
      {
        "title": "Cost Anomalies",
        "type": "alertlist",
        "options": {
          "alertName": "CostAnomaly"
        }
      }
    ]
  }
}
```

### 7. 定时任务调度

```typescript
// backend/shared/cost/scheduler.ts
class CostMonitoringScheduler {
  private scheduler: Scheduler;
  
  constructor() {
    this.scheduler = new Scheduler();
    this.setupJobs();
  }
  
  private setupJobs(): void {
    // 每小时采集成本数据
    this.scheduler.schedule('0 * * * *', async () => {
      await this.costCollector.collectAndStore();
    });
    
    // 每15分钟检测异常
    this.scheduler.schedule('*/15 * * * *', async () => {
      const anomalies = await this.anomalyDetector.detect();
      for (const anomaly of anomalies) {
        await this.alerting.sendAnomalyAlert(anomaly);
      }
    });
    
    // 每小时检查预算告警
    this.scheduler.schedule('0 * * * *', async () => {
      await this.budgetManager.checkBudgetAlerts();
    });
    
    // 每天生成成本报告
    this.scheduler.schedule('0 9 * * *', async () => {
      await this.generateDailyReport();
    });
    
    // 每周预测和趋势分析
    this.scheduler.schedule('0 9 * * 1', async () => {
      await this.generateWeeklyAnalysis();
    });
  }
}
```

## 验收标准

- [ ] 成本数据采集器支持 AWS/GCP/Azure 三大云厂商
- [ ] 异常检测准确率达到 90% 以上（人工验证）
- [ ] 预算告警在达到阈值后 5 分钟内发送
- [ ] 支持 Slack/Email/PagerDuty 多渠道告警
- [ ] 成本归因准确覆盖 95% 以上的资源
- [ ] Grafana 仪表盘展示实时成本数据
- [ ] 预测准确率达到 85% 以上（与实际对比）
- [ ] 系统自身成本不超过总云成本的 0.1%
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试覆盖主要流程

## 影响范围

- backend/shared/cost/* (新增模块)
- backend/services/monitoring/* (扩展)
- infrastructure/monitoring/dashboards/* (新增仪表盘)
- infrastructure/k8s/services/cost-monitoring.yaml (新增部署配置)
- docs/runbooks/cost-management.md (新增运维文档)

## 参考

- [AWS Cost Explorer API](https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_CostExplorer.html)
- [GCP Cloud Billing API](https://cloud.google.com/billing/docs/apis)
- [Isolation Forest Algorithm](https://scikit-learn.org/stable/modules/outlier_detection.html#isolation-forest)
- [FinOps Foundation Best Practices](https://www.finops.org/framework/)
