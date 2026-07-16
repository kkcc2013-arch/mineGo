# REQ-00563：SLO 合规性监控与违规预警系统

- **编号**：REQ-00563
- **类别**：运维/CICD
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway, infrastructure/monitoring, backend/shared/sloManager, Prometheus, Grafana, alert-service
- **创建时间**：2026-07-15 11:00
- **依赖需求**：REQ-00373 SLO 错误预算管理系统

## 1. 背景与问题

mineGo 项目已部署完善的监控和告警系统，包括：
- **drMonitor.js**：灾难恢复演练监控，记录 MTTR/MTTC
- **Prometheus + Grafana**：指标采集和可视化
- **多种告警规则**：性能、安全、资源等

然而，服务级别目标 (SLO) 合规性监控存在明显缺口：

1. **缺乏 SLO 定义与追踪**：没有统一的 SLO 定义（如可用性 99.9%、P95 延迟 < 200ms），难以量化服务质量
2. **错误预算不可见**：REQ-00373 已创建错误预算管理系统，但缺少实时合规性监控和预警
3. **违规事件无追溯**：SLO 违规后缺少事件记录、根因分析和改进跟踪
4. **报告生成手动化**：月度/季度 SLO 报告需人工整理，效率低下

影响：
- 服务降级难以量化评估
- 无法及时发现服务级别违规
- 缺少数据驱动的服务质量改进依据

## 2. 目标

构建完整的 SLO 合规性监控与预警系统：

1. **SLO 定义与管理**：支持多维度 SLO 配置（可用性、延迟、错误率等）
2. **实时合规性监控**：基于 Prometheus 指标实时计算 SLO 达成率
3. **错误预算追踪**：可视化错误预算消耗，预警超支风险
4. **违规事件管理**：自动记录违规事件，关联根因，跟踪修复
5. **自动化报告**：生成周期性 SLO 合规报告

## 3. 范围

### 包含

- SLO 定义与管理 API
- 基于 Prometheus 的实时 SLO 计算引擎
- 错误预算追踪与预警
- 违规事件检测、记录与跟踪
- SLO 合规性仪表盘（Grafana）
- 周期性报告生成（日/周/月）
- Prometheus 告警规则自动生成

### 不包含

- SLA 合同管理（作为后续需求）
- 第三方 SaaS 集成（如 Datadog SLO）
- 容量规划预测（已有独立需求）

## 4. 详细需求

### 4.1 SLO 定义与管理

**SLO 数据模型**：
```javascript
{
  sloId: 'slo_001',
  name: 'API 可用性',
  description: '核心 API 接口可用性目标',
  service: 'gateway',
  indicator: {
    type: 'availability',
    query: 'sum(rate(http_requests_total{status!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
    unit: 'percentage'
  },
  target: 99.9,
  warningThreshold: 99.5,
  window: '30d',
  status: 'active',
  createdAt: Date,
  updatedAt: Date
}
```

**支持的 SLO 类型**：
- **可用性 (Availability)**：请求成功率
- **延迟 (Latency)**：响应时间百分位数 (P50/P95/P99)
- **错误率 (Error Rate)**：HTTP 5xx 比例
- **吞吐量 (Throughput)**：请求处理能力
- **饱和度 (Saturation)**：资源使用率

**API 接口**：
- `POST /api/slo` - 创建 SLO 定义
- `GET /api/slo` - 列出所有 SLO
- `GET /api/slo/:sloId` - 获取 SLO 详情
- `PUT /api/slo/:sloId` - 更新 SLO 定义
- `DELETE /api/slo/:sloId` - 删除 SLO
- `GET /api/slo/:sloId/status` - 获取 SLO 合规状态
- `GET /api/slo/:sloId/budget` - 获取错误预算状态

### 4.2 实时 SLO 计算引擎

**计算逻辑**：
```javascript
// backend/shared/sloManager/SLOCalculator.js
class SLOCalculator {
  constructor(prometheusClient) {
    this.prometheus = prometheusClient;
  }

  async calculateSLOStatus(slo) {
    const query = this.buildSLOQuery(slo);
    const result = await this.prometheus.query(query);
    
    const currentValue = result.data.result[0]?.value[1] || 0;
    const isCompliant = currentValue >= slo.target;
    const budgetRemaining = this.calculateBudget(slo, currentValue);
    
    return {
      sloId: slo.sloId,
      name: slo.name,
      currentValue: parseFloat(currentValue),
      target: slo.target,
      isCompliant,
      budgetRemaining,
      budgetConsumed: 100 - budgetRemaining,
      trend: await this.calculateTrend(slo),
      lastViolation: await this.getLastViolation(slo.sloId)
    };
  }

  buildSLOQuery(slo) {
    switch (slo.indicator.type) {
      case 'availability':
        return `sum(rate(http_requests_total{service="${slo.service}",status!~"5.."}[${slo.window}])) 
                / sum(rate(http_requests_total{service="${slo.service}"}[${slo.window}])) * 100`;
      
      case 'latency':
        return `histogram_quantile(${slo.percentile || 0.95}, 
                sum(rate(http_request_duration_seconds_bucket{service="${slo.service}"}[${slo.window}])) by (le))`;
      
      case 'error_rate':
        return `sum(rate(http_requests_total{service="${slo.service}",status=~"5.."}[${slo.window}])) 
                / sum(rate(http_requests_total{service="${slo.service}"}[${slo.window}])) * 100`;
      
      default:
        return slo.indicator.query;
    }
  }

  calculateBudget(slo, currentValue) {
    // 错误预算 = (目标 - 当前值) / (目标 - 100%) * 100
    if (slo.indicator.type === 'availability') {
      const budgetTotal = 100 - slo.target;
      const budgetUsed = 100 - currentValue;
      return Math.max(0, 100 - (budgetUsed / budgetTotal) * 100);
    }
    // 其他类型的预算计算
    return 100 - (currentValue / slo.target) * 100;
  }
}
```

### 4.3 错误预算追踪与预警

**预算状态模型**：
```javascript
{
  sloId: 'slo_001',
  period: {
    start: '2026-07-01',
    end: '2026-07-31'
  },
  budgetTotal: 43.2, // 分钟（30天 * 0.1% 允许不可用）
  budgetConsumed: 12.5,
  budgetRemaining: 30.7,
  consumptionRate: 0.8, // 预算消耗速率（分钟/天）
  projectedExhaustion: '2026-07-28', // 预计耗尽日期
  alerts: [
    {
      type: 'budget_warning',
      threshold: 50,
      triggeredAt: '2026-07-15T10:00:00Z',
      message: '错误预算已消耗 50%'
    }
  ]
}
```

**预警规则**：
1. **预算消耗预警**：当预算消耗达 50%/75%/90% 时告警
2. **违规预警**：当 SLO 不满足目标时立即告警
3. **趋势预警**：预测将在周期内耗尽预算时告警

### 4.4 违规事件管理

**事件模型**：
```javascript
{
  eventId: 'evt_001',
  sloId: 'slo_001',
  type: 'slo_violation',
  severity: 'critical',
  startedAt: '2026-07-15T10:30:00Z',
  endedAt: '2026-07-15T10:35:00Z',
  duration: 300, // 秒
  details: {
    currentValue: 98.5,
    target: 99.9,
    deviation: -1.4
  },
  rootCause: {
    identified: true,
    category: 'database_timeout',
    description: 'PostgreSQL 连接池耗尽',
    relatedAlerts: ['alert_db_conn_exhausted']
  },
  remediation: {
    action: 'increased_pool_size',
    status: 'completed',
    resolvedBy: 'user_001'
  },
  status: 'resolved'
}
```

**事件流程**：
1. **检测**：实时监控检测到 SLO 违规
2. **记录**：自动创建违规事件记录
3. **关联**：关联相关告警和日志
4. **通知**：发送告警到配置渠道
5. **跟踪**：记录修复过程和结果

### 4.5 Grafana 仪表盘

**仪表盘组件**：
- **SLO 总览**：所有 SLO 合规状态一览
- **详细图表**：每个 SLO 的历史趋势
- **错误预算**：预算消耗可视化
- **违规事件**：事件时间线和统计
- **服务对比**：不同服务的 SLO 对比

### 4.6 自动化报告

**报告模板**：
```markdown
# SLO 合规报告 - 2026年7月

## 概览

| SLO | 目标 | 实际值 | 状态 | 预算消耗 |
|-----|------|--------|------|----------|
| API 可用性 | 99.9% | 99.85% | ⚠️ | 45% |
| P95 延迟 | < 200ms | 185ms | ✅ | 12% |
| 错误率 | < 0.1% | 0.08% | ✅ | 20% |

## 违规事件

本月共发生 3 次 SLO 违规事件：
1. [2026-07-10] API 可用性下降至 98.5%，持续 5 分钟
2. [2026-07-12] P95 延迟升至 250ms，持续 2 分钟
3. [2026-07-15] 错误率上升至 0.15%，持续 3 分钟

## 改进建议

1. 增加 gateway 副本数以降低单点故障风险
2. 优化数据库连接池配置
3. 完善熔断器响应策略
```

**报告 API**：
- `POST /api/slo/reports/generate` - 生成报告
- `GET /api/slo/reports` - 列出历史报告
- `GET /api/slo/reports/:reportId` - 获取报告详情

## 5. 验收标准（可测试）

- [ ] 支持创建、更新、删除 SLO 定义
- [ ] 实时计算 SLO 合规状态，延迟 < 10s
- [ ] 错误预算追踪准确，支持多种预算类型
- [ ] 预算消耗预警在阈值触发后 30s 内发出
- [ ] 违规事件自动记录，包含根因关联
- [ ] Grafana 仪表盘展示所有 SLO 状态
- [ ] 支持生成日/周/月度 SLO 报告
- [ ] 提供 Prometheus 告警规则自动生成
- [ ] API 响应时间 P95 < 200ms
- [ ] 测试覆盖率 > 80%

## 6. 工作量估算

**L (Large)**

理由：
- 涉及多个组件（API、计算引擎、事件管理、报告）
- 需要与现有 Prometheus/Grafana 集成
- 需要设计完善的 SLO 数据模型
- 预计开发时间：2-3 周

## 7. 优先级理由

**P1（高优先级）**

1. **服务质量量化**：缺少 SLO 监控难以客观评估服务质量
2. **问题发现及时性**：当前依赖人工巡检，效率低下
3. **依赖已实现**：REQ-00373 已实现错误预算管理系统，可复用
4. **运维成熟度提升**：是运维/CICD 领域的关键能力
5. **合规性要求**：部分企业客户要求 SLO 报告作为交付物