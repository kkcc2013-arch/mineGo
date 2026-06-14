# REQ-00185：SLO 预算燃尽与合规性预测系统

- **编号**：REQ-00185
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/sloBudgetTracker.js、infrastructure/k8s/monitoring、admin-dashboard
- **创建时间**：2026-06-14 06:00
- **依赖需求**：REQ-00005（Prometheus 告警）、REQ-00159（服务健康自愈）

## 1. 背景与问题

当前项目已有完善的 Prometheus 指标和告警规则，覆盖 P0/P1/P2 级别的技术指标告警。但缺少**业务视角的 SLO（服务级别目标）预算管理**：

**现状问题**：
1. 告警阈值固定（如错误率 > 10%），无法区分业务高峰/低谷时段
2. 无法提前预测 SLO 违约风险（错误预算即将耗尽时才发现）
3. 运维团队被动响应告警，而非主动预防 SLO 违约
4. 缺少错误预算消耗速度的可视化，难以评估变更风险

**真实场景**：
- 支付服务 SLO 99.95%，但月中促销期间错误率从 0.1% 上升到 0.3%，错误预算在 2 小时内耗尽
- 位置服务在周末高峰时段响应时间从 150ms 飙升到 450ms，但固定阈值告警未触发
- 新版本上线后，错误预算消耗速度加快 3 倍，但团队未感知风险

## 2. 目标

建立**基于业务时段的 SLO 预算燃尽预测系统**，实现：

1. **预算燃尽预测**：预测当前错误预算何时耗尽（提前 1-4 小时告警）
2. **动态阈值调整**：根据业务高峰/低谷时段调整告警敏感度
3. **变更风险评估**：评估新版本发布对错误预算的影响
4. **SLO 合规性报告**：生成周期性 SLO 合规报告，支持管理决策

**可量化目标**：
- SLO 违约提前告警时间：从 0 分钟提升到平均 2 小时
- 告警误报率降低 30%（动态阈值替代固定阈值）
- 变更后预算消耗异常检测准确率 > 90%

## 3. 范围

### 包含
1. **SLO 预算计算引擎**：
   - 支持 7 天/30 天滚动窗口
   - 自动计算错误预算余额、消耗速度、预计耗尽时间
   - 支持多维度 SLO（可用性、延迟、错误率）

2. **业务时段识别**：
   - 自动识别高峰时段（基于历史流量模式）
   - 高峰时段动态降低告警阈值（如错误率阈值从 10% 降到 5%）
   - 低峰时段提高阈值，减少噪音告警

3. **预算燃尽预测**：
   - 基于历史趋势预测预算消耗曲线
   - 提前告警（预算剩余 < 20%，或预计 4 小时内耗尽）
   - 支持可视化展示预算消耗速度

4. **变更影响分析**：
   - 对比变更前后的预算消耗速度
   - 自动标注异常变更（消耗速度增加 > 50%）

5. **Prometheus 指标暴露**：
   - `minego_slo_budget_remaining_ratio`：剩余预算比例
   - `minego_slo_budget_burn_rate`：预算燃烧率（%/小时）
   - `minego_slo_budget_exhaustion_hours`：预计耗尽小时数
   - `minego_slo_compliance_score`：合规评分（0-100）

### 不包含
- 业务 SLA 合同管理（属于 CRM 系统）
- 成本分摊计算（属于 REQ-00040 云成本监控）
- 自动回滚决策（属于 REQ-00159 服务健康自愈）

## 4. 详细需求

### 4.1 SLO 预算追踪器（backend/shared/sloBudgetTracker.js）

```javascript
class SLOBudgetTracker {
  constructor(config) {
    // SLO 配置
    this.slos = {
      'gateway': { target: 0.999, window: '30d' },
      'payment-service': { target: 0.9995, window: '7d' },
      'location-service': { target: 0.995, window: '7d' },
      'catch-service': { target: 0.99, window: '7d' }
    };
  }

  /**
   * 计算错误预算
   * @returns {Object} { budgetRemaining, burnRate, exhaustionHours, trend }
   */
  calculateBudget(serviceName, windowStart, windowEnd) {
    // 从 Prometheus 查询：
    // 1. 总请求数
    // 2. 失败请求数
    // 3. 计算预算消耗
  }

  /**
   * 预测预算耗尽时间
   * 使用线性回归预测燃烧率趋势
   */
  predictExhaustion(serviceName) {
    // 基于最近 24h 燃烧率，预测何时耗尽
  }

  /**
   * 检测业务时段
   */
  detectBusinessHours(serviceName) {
    // 分析过去 7 天的流量模式
    // 返回：{ peak: ['10:00-12:00', '18:00-21:00'], normal: [...], low: [...] }
  }
}
```

### 4.2 动态阈值调整器

```javascript
class DynamicThresholdAdjuster {
  /**
   * 根据业务时段调整告警阈值
   */
  adjustThreshold(serviceName, baseThreshold, currentHour) {
    const businessHours = sloTracker.detectBusinessHours(serviceName);
    
    if (businessHours.peak.includes(currentHour)) {
      // 高峰时段：降低阈值 50%，更敏感
      return baseThreshold * 0.5;
    }
    
    if (businessHours.low.includes(currentHour)) {
      // 低峰时段：提高阈值 50%，减少噪音
      return baseThreshold * 1.5;
    }
    
    return baseThreshold;
  }
}
```

### 4.3 Prometheus 指标

```yaml
# 预算指标
- minego_slo_budget_remaining_ratio{service="gateway"} 0.85
- minego_slo_budget_burn_rate{service="payment-service"} 2.5  # %/小时
- minego_slo_budget_exhaustion_hours{service="gateway"} 72
- minego_slo_compliance_score{service="gateway"} 95

# 时段指标
- minego_slo_business_period{service="gateway", period="peak"} 1  # 1=当前时段
```

### 4.4 告警规则增强

```yaml
# 预算燃尽预警（提前 4 小时）
- alert: SLOBudgetExhaustingSoon
  expr: minego_slo_budget_exhaustion_hours < 4
  for: 5m
  labels:
    severity: warning
    priority: P1
  annotations:
    summary: "{{ $labels.service }} SLO 预算即将耗尽"
    description: "预计 {{ $value }} 小时后预算耗尽，当前燃烧率 {{ $labels.burn_rate }}%/h"

# 预算燃烧率异常
- alert: SLOBudgetBurnRateAnomaly
  expr: |
    minego_slo_budget_burn_rate > 
    avg_over_time(minego_slo_budget_burn_rate[7d]) * 2
  for: 10m
  labels:
    severity: warning
    priority: P1
  annotations:
    summary: "{{ $labels.service }} 预算燃烧率异常"
    description: "燃烧率是历史平均的 2 倍，可能存在问题"
```

### 4.5 API 端点

```
GET /api/slo/budget/:service
  - 返回：{ budgetRemaining, burnRate, exhaustionTime, trend }

GET /api/slo/report
  - 返回：所有服务的 SLO 合规性报告

POST /api/slo/config
  - 更新 SLO 目标和窗口
```

### 4.6 管理后台集成

在 `admin-dashboard` 新增 SLO 监控面板：
1. 预算余额仪表盘（红/黄/绿三色预警）
2. 燃烧率趋势图（最近 7 天）
3. 业务时段热力图
4. 变更影响对比（变更前后燃烧率）

## 5. 验收标准（可测试）

- [ ] 支付服务错误预算计算准确，误差 < 5%（与手动计算对比）
- [ ] 高峰时段（10:00-12:00）告警阈值自动降低到基础值的 50%
- [ ] 预算燃尽预测误差 < 2 小时（与实际耗尽时间对比）
- [ ] Prometheus 指标 `/metrics` 端点暴露所有 SLO 指标
- [ ] 变更后燃烧率增加 > 50% 时自动生成告警
- [ ] 管理后台 SLO 面板显示实时数据，刷新间隔 < 10s
- [ ] 单元测试覆盖预算计算、时段检测、预测算法（覆盖率 > 80%）

## 6. 工作量估算

**L（Large）**

理由：
- 需要实现预算计算引擎（复杂算法）
- 需要集成 Prometheus 查询 API
- 需要实现动态阈值调整逻辑
- 需要修改现有告警规则
- 需要新增管理后台面板
- 预估工作量：3-4 人日

## 7. 优先级理由

**P1 理由**：

1. **业务价值高**：SLO 违约直接影响用户信任和收入，提前预警能显著降低风险
2. **填补关键缺口**：现有监控缺少业务视角，无法预测 SLO 违约
3. **提升运维效率**：动态阈值减少噪音告警，预算预测支持主动决策
4. **支持快速迭代**：变更影响分析帮助团队评估发布风险
5. **依赖已有基础**：基于现有 Prometheus 指标和健康评分系统，实现成本低

与 REQ-00159（服务健康自愈）配合，形成完整的**预防-检测-自愈**闭环。
