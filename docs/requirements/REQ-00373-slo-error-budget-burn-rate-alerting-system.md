# REQ-00373：SLO 错误预算燃尽率预警与自动熔断系统

- **编号**：REQ-00373
- **类别**：容灾/高可用
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、backend/shared/SloManager.js、backend/shared/SloBudgetTracker.js、backend/shared/middleware/sloMiddleware.js、infrastructure/k8s/monitoring、Prometheus、Grafana
- **创建时间**：2026-06-29 21:00 UTC
- **依赖需求**：REQ-00002（结构化日志）、REQ-00023（分布式追踪）、REQ-00275（告警关联）

## 1. 背景与问题

### 现状分析

mineGo 项目当前监控体系已具备：

- ✅ Prometheus 指标采集与告警规则
- ✅ Grafana 监控仪表板
- ✅ Jaeger 分布式追踪
- ✅ 结构化日志（ELK 标准格式）
- ✅ 熔断/降级/限流机制

但 **缺少 SLO（服务级别目标）错误预算管理**：

1. **阈值告警无目标导向**：当前告警基于静态阈值（如错误率 > 10%），无法关联业务 SLO 目标

2. **错误预算不可见**：团队不知道"本月还剩多少错误预算"，无法做取舍决策

3. **燃尽率未监控**：不知道当前错误消耗速度，无法预警预算耗尽时间

4. **缺乏自动熔断**：预算耗尽时没有自动触发服务降级/熔断机制

### 业务影响

- SRE 团队无法基于错误预算做出"发布暂停"或"功能冻结"决策
- 没有清晰的"可用性目标"，导致过度告警或告警不足
- 故障期间的错误"燃烧"无法量化，无法事后复盘

## 2. 目标

构建完整的 SLO 错误预算管理系统，实现：

1. **定义服务 SLO**：为核心服务定义可用性目标（99.9% / 99.5% / 99%）
2. **错误预算计算**：按时间窗口计算剩余错误预算（如 30 天窗口）
3. **燃尽率监控**：实时计算错误预算消耗速度，预警耗尽时间
4. **预算耗尽熔断**：当预算耗尽时自动触发服务熔断/降级
5. **Grafana 可视化**：错误预算仪表板，燃尽率图表，预算剩余趋势

## 3. 范围

### 包含

- SLO 定义与配置管理（SloManager）
- 错误预算追踪与计算（SloBudgetTracker）
- 燃尽率计算与预警（SloBurnRateAlert）
- 预算耗尽自动熔断（SloBudgetExhaustionHandler）
- Prometheus 指标导出
- Grafana 仪表板配置
- API 端点：查询当前 SLO 状态、预算剩余、燃尽率

### 不包含

- SLA 合同管理（合同层面的承诺）
- 客户通知系统（已有通知渠道）
- SLO 报告生成（后续需求）

## 4. 详细需求

### 4.1 SLO 定义与配置

```javascript
// backend/shared/SloManager.js
const DEFAULT_SLOS = {
  'gateway': { target: 0.999, window: '30d' },      // 99.9% 可用性
  'user-service': { target: 0.999, window: '30d' },
  'pokemon-service': { target: 0.995, window: '30d' },
  'catch-service': { target: 0.995, window: '30d' },
  'gym-service': { target: 0.99, window: '30d' },    // 实时战斗允许稍低
  'payment-service': { target: 0.9999, window: '30d' }, // 支付最严格
  'location-service': { target: 0.995, window: '30d' },
  'social-service': { target: 0.99, window: '30d' },
  'reward-service': { target: 0.99, window: '30d' }
};
```

### 4.2 错误预算计算

**预算公式**：
```
错误预算 = (1 - SLO目标) × 时间窗口请求总数

例如：
- gateway SLO 99.9%，30天窗口
- 假设每天 10M 请求 → 30天 300M 请求
- 错误预算 = (1 - 0.999) × 300M = 300,000 次错误允许
```

**预算消耗**：
```
已消耗预算 = 累计错误数（5xx + 超时 + 显式失败）
剩余预算 = 总预算 - 已消耗预算
预算剩余率 = 剩余预算 / 总预算
```

### 4.3 燃尽率计算

**燃尽率公式**：
```
燃尽率 = 错误增长速度 / 剩余预算

计算周期：1h, 6h, 24h, 72h
- 1h 燃尽率：过去1小时错误数 / 剩余预算 × (窗口时长 / 1h)
- 24h 燃尽率：过去24小时错误数 / 剩余预算 × (窗口时长 / 24h)
```

**燃尽率阈值**：
```javascript
const BURN_RATE_THRESHOLDS = {
  fast: 2.0,    // 2x 燃尽率 → 预算将在一半时间耗尽 → P0 告警
  medium: 1.0,  // 正常燃尽 → 预算按计划耗尽 → P1 告警
  slow: 0.5     // 慢燃尽 → 预算消耗低于预期 → P2 提示
};
```

### 4.4 预算耗尽熔断

当预算剩余率 < 5% 或燃尽率 > 2.0 时：

```javascript
// backend/shared/middleware/sloMiddleware.js
async function sloBudgetExhaustionHandler(req, res, next) {
  const budgetStatus = await SloBudgetTracker.getStatus(req.service);
  
  if (budgetStatus.remainingRatio < 0.05 || budgetStatus.burnRate > 2.0) {
    // 自动熔断策略
    await triggerAutoDegradation(req.service, {
      reason: 'slo_budget_exhausted',
      remainingRatio: budgetStatus.remainingRatio,
      burnRate: budgetStatus.burnRate,
      actions: ['disable_non_essential_features', 'throttle_requests']
    });
    
    // 返回降级响应
    return res.status(503).json({
      error: 'SERVICE_DEGRADED',
      reason: 'SLO budget exhausted, non-essential features disabled',
      retryAfter: 60
    });
  }
  
  next();
}
```

### 4.5 Prometheus 指标导出

```javascript
// backend/shared/SloBudgetTracker.js
const metrics = {
  sloTargetGauge: new Gauge({
    name: 'minego_slo_target',
    help: 'SLO target for service',
    labelNames: ['service']
  }),
  sloBudgetTotalGauge: new Gauge({
    name: 'minego_slo_budget_total',
    help: 'Total error budget for current window',
    labelNames: ['service', 'window']
  }),
  sloBudgetRemainingGauge: new Gauge({
    name: 'minego_slo_budget_remaining',
    help: 'Remaining error budget',
    labelNames: ['service', 'window']
  }),
  sloBudgetRemainingRatioGauge: new Gauge({
    name: 'minego_slo_budget_remaining_ratio',
    help: 'Remaining budget ratio (0-1)',
    labelNames: ['service', 'window']
  }),
  sloBurnRateGauge: new Gauge({
    name: 'minego_slo_burn_rate',
    help: 'Error budget burn rate',
    labelNames: ['service', 'period']
  }),
  sloBudgetExhaustionCounter: new Counter({
    name: 'minego_slo_budget_exhaustion_events',
    help: 'Number of SLO budget exhaustion events',
    labelNames: ['service']
  })
};
```

### 4.6 Grafana 仪表板配置

```yaml
# infrastructure/k8s/monitoring/grafana-dashboards/slo-budget.json
{
  "title": "SLO Error Budget Dashboard",
  "panels": [
    {
      "title": "Budget Remaining Ratio",
      "type": "gauge",
      "targets": [{
        "expr": "minego_slo_budget_remaining_ratio{service=\"$service\"}"
      }],
      "thresholds": [
        { "value": 0.05, "color": "red" },
        { "value": 0.2, "color": "yellow" },
        { "value": 0.5, "color": "green" }
      ]
    },
    {
      "title": "Burn Rate Trend",
      "type": "graph",
      "targets": [
        { "expr": "minego_slo_burn_rate{service=\"$service\",period=\"1h\"}" },
        { "expr": "minego_slo_burn_rate{service=\"$service\",period=\"24h\"}" }
      ]
    },
    {
      "title": "Budget Consumption Timeline",
      "type": "stat",
      "targets": [{
        "expr": "minego_slo_budget_total - minego_slo_budget_remaining"
      }]
    }
  ]
}
```

### 4.7 API 端点

```javascript
// gateway/src/routes/slo.js
router.get('/slo/status', async (req, res) => {
  const statuses = await SloManager.getAllSloStatuses();
  res.json({
    services: statuses,
    summary: {
      totalBudget: sum(statuses.map(s => s.totalBudget)),
      totalRemaining: sum(statuses.map(s => s.remainingBudget)),
      overallHealth: calculateOverallHealth(statuses)
    }
  });
});

router.get('/slo/:service', async (req, res) => {
  const status = await SloBudgetTracker.getStatus(req.params.service);
  res.json(status);
});

router.post('/slo/:service/recalculate', async (req, res) => {
  await SloBudgetTracker.recalculate(req.params.service);
  res.json({ message: 'Budget recalculation triggered' });
});
```

## 5. 验收标准（可测试）

- [ ] 创建 `backend/shared/SloManager.js` - SLO 配置管理模块
- [ ] 创建 `backend/shared/SloBudgetTracker.js` - 错误预算追踪模块
- [ ] 错误预算计算准确性验证（与 Prometheus 指标对比误差 < 1%）
- [ ] 燃尽率计算覆盖 1h/6h/24h/72h 四个周期
- [ ] 当燃尽率 > 2.0 时触发 P0 告警
- [ ] 当预算剩余率 < 5% 时触发自动熔断
- [ ] Prometheus 指标正确导出：`minego_slo_*` 系列
- [ ] Grafana 仪表板正确显示预算剩余率和燃尽率趋势
- [ ] API `/slo/status` 返回所有服务的 SLO 状态
- [ ] 单元测试覆盖率 > 90%
- [ ] 集成测试：模拟预算耗尽场景，验证熔断触发

## 6. 工作量估算

**L** - 涉及核心模块开发、Prometheus/Grafana 集成、熔断机制联动、多服务协调

## 7. 优先级理由

**P0** - SLO 错误预算是 SRE 站点可靠性的核心指标：
- STATUS.md 明确指出"稳定性与高可用"维度得分 13/15，关键缺口是 SLO 错误预算管理
- 错误预算管理是 Google SRE 最佳实践的核心内容
- 无 SLO 意味着无法量化"多少错误是可接受的"
- 预算耗尽熔断是防止大规模故障的最后一道防线
- 完成后"稳定性与高可用"维度得分可提升至 15/15