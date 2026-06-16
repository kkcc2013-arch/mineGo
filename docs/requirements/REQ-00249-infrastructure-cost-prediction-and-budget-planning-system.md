# REQ-00249：基础设施成本预测与预算智能规划系统

- **编号**：REQ-00249
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、infrastructure/k8s、admin-dashboard、所有微服务、backend/jobs
- **创建时间**：2026-06-16 07:00
- **依赖需求**：REQ-00040（云成本监控与预算告警系统）、REQ-00212（云资源利用率分析与成本归因系统）

## 1. 背景与问题

当前 mineGo 已实现了云成本监控（REQ-00040）和资源利用率分析（REQ-00212），但缺少成本预测能力：

1. **预算被动响应**：目前只能在成本超支后触发告警，无法提前预判趋势
2. **缺乏智能规划**：运营团队无法获得资源扩缩容的成本影响预估
3. **异常成本滞后**：异常消费模式需要人工分析，发现延迟
4. **优化建议缺失**：系统无法自动推荐资源调整方案

随着用户增长和业务扩展，基础设施成本占比逐年上升，需要从被动监控转向主动预测和智能规划。

## 2. 目标

建立智能成本预测与规划系统：
- 7天/30天成本趋势预测，准确率 ≥ 85%
- 自动生成预算优化建议
- 异常成本模式实时检测，检测延迟 < 5 分钟
- 提供资源调整的成本影响模拟

## 3. 范围

- **包含**：
  - 成本预测模型（时间序列分析）
  - 预算智能规划建议引擎
  - 异常成本模式检测
  - 成本影响模拟器
  - 管理后台可视化界面

- **不包含**：
  - 自动执行资源调整（仅建议）
  - 第三方云厂商 API 集成（使用现有 CloudCostCollector）
  - 跨区域成本分配

## 4. 详细需求

### 4.1 成本预测引擎

```javascript
// backend/shared/CostPredictor.js
class CostPredictor {
  constructor(config) {
    this.modelType = config.modelType || 'arima'; // arima | prophet | linear
    this.historyDays = config.historyDays || 90;
    this.forecastDays = config.forecastDays || 30;
  }
  
  // 时间序列预测
  async predict(params) {
    const { service, startDate, endDate, granularity } = params;
    // 支持按服务/命名空间/资源类型维度预测
  }
  
  // 多模型融合预测
  async ensembleForecast(params) {
    // 组合多个模型提高预测准确率
  }
  
  // 预测置信区间
  async getConfidenceInterval(prediction, confidence = 0.95) {
    // 返回上下界
  }
}
```

### 4.2 预算智能规划建议

```javascript
// backend/shared/BudgetPlanner.js
class BudgetPlanner {
  constructor(config) {
    this.predictor = new CostPredictor(config);
    this.optimizer = new ResourceOptimizer(config);
  }
  
  // 生成优化建议
  async generateRecommendations(budget) {
    return {
      savings: [
        { action: 'scale_down', service: 'reward-service', cpu: 2, savings: 120 },
        { action: 'resize_pv', namespace: 'default', savings: 50 }
      ],
      warnings: [
        { type: 'budget_exceed', probability: 0.75, days: 12 }
      ],
      optimizations: [
        { type: 'spot_instances', potential_savings: 200 }
      ]
    };
  }
  
  // 成本影响模拟
  async simulateImpact(changes) {
    // 模拟资源调整对成本的影响
  }
}
```

### 4.3 异常成本检测

```javascript
// backend/shared/CostAnomalyDetector.js
class CostAnomalyDetector {
  constructor(config) {
    this.baselineWindowDays = config.baselineWindowDays || 14;
    this.anomalyThresholds = {
      dailySpike: 2.0,      // 日环比增长 100%
      weeklySpike: 1.5,     // 周环比增长 50%
      unexpectedService: 0.2 // 新服务占比 20%
    };
  }
  
  // 实时异常检测
  async detectAnomalies(currentCost, history) {
    // 返回异常列表
  }
  
  // 异常根因分析
  async analyzeRootCause(anomaly) {
    // 关联资源变化、用户活动、业务事件
  }
}
```

### 4.4 API 接口

```
POST /api/v1/cost/predict
GET  /api/v1/cost/recommendations
POST /api/v1/cost/simulate
GET  /api/v1/cost/anomalies
GET  /api/v1/cost/forecast/:service
```

### 4.5 管理后台集成

- 成本预测趋势图（7/30/90 天）
- 预算优化建议卡片
- 异常成本告警列表
- 成本模拟器工具

## 5. 验收标准（可测试）

- [ ] 成本预测准确率测试：历史数据回测 MAPE ≤ 15%
- [ ] 7天预测误差测试：绝对误差 ≤ 10%
- [ ] 异常检测延迟测试：从异常发生到告警 ≤ 5 分钟
- [ ] 优化建议生成测试：每次分析时间 ≤ 10 秒
- [ ] 成本模拟测试：支持至少 5 种调整场景
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试通过

## 6. 工作量估算

**L** - 涉及多个新模块开发、时间序列模型集成、前端可视化

## 7. 优先级理由

P1 理由：
1. 基础设施成本是游戏项目的重要支出项
2. 用户增长带来的成本压力需要主动管理
3. 为运营决策提供数据支持，直接影响项目盈利能力
