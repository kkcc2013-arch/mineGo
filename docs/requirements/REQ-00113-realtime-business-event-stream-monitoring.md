# REQ-00113：实时业务事件流监控与分析系统

- **编号**：REQ-00113
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/eventStream.js、backend/shared/realTimeAnalytics.js、infrastructure/k8s/monitoring、Kafka
- **创建时间**：2026-06-11 13:05
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标）、REQ-00013（事件驱动架构）

## 1. 背景与问题

当前 mineGo 项目已具备完善的 Prometheus 指标、结构化日志和分布式追踪能力，但缺少**实时业务事件流监控**能力：

1. **业务事件分散**：捕捉、道馆战斗、交易、支付等业务事件分散在各服务，无法实时聚合分析
2. **无法实时洞察**：运营人员无法实时看到"当前在线人数"、"正在进行的 Raid 数量"、"最近 5 分钟捕捉成功率"等关键业务指标
3. **异常发现滞后**：业务异常（如捕捉成功率骤降、支付失败率上升）依赖定时聚合，发现延迟 5-15 分钟
4. **缺少事件关联**：无法追踪"用户 A 的捕捉事件 → 触发成就 → 发送通知"这类事件链路

竞品分析：Pokémon GO 后台可实时看到全球捕捉热力图、活跃玩家数、Raid 参与率等，运营决策响应时间 < 1 分钟。

## 2. 目标

构建实时业务事件流监控系统，实现：

1. **毫秒级事件收集**：业务事件通过 Kafka 实时收集，延迟 < 100ms
2. **实时业务仪表板**：提供 20+ 实时业务指标 API，支持 WebSocket 推送
3. **异常自动检测**：基于滑动窗口的实时异常检测，检测延迟 < 30s
4. **事件关联追踪**：支持事件链路追踪，关联分析跨服务业务流程
5. **自定义事件订阅**：支持运营配置关注的事件类型和条件

预期收益：
- 运营响应时间从 5-15 分钟降至 < 1 分钟
- 业务异常发现时间缩短 90%
- 支持实时运营决策（如动态调整活动奖励）

## 3. 范围

- **包含**：
  - 业务事件收集器（统一事件 Schema）
  - Kafka 事件流处理管道
  - 实时聚合分析引擎（滑动窗口统计）
  - 实时业务指标 API（20+ 指标）
  - WebSocket 实时推送
  - 异常检测器（基于统计阈值）
  - 事件关联追踪器
  - Prometheus 指标集成

- **不包含**：
  - 前端仪表板 UI（属于 admin-dashboard 需求）
  - 机器学习预测（属于 REQ-00028 行为异常检测）
  - 历史数据存储（已有日志系统）

## 4. 详细需求

### 4.1 业务事件 Schema

```javascript
// 统一业务事件结构
{
  eventId: 'uuid',
  eventType: 'catch.success' | 'catch.fail' | 'gym.battle.start' | 'gym.battle.end' | 
             'trade.request' | 'trade.complete' | 'payment.success' | 'payment.fail' |
             'user.login' | 'user.logout' | 'raid.join' | 'raid.complete' | 'achievement.unlock',
  timestamp: '2026-06-11T13:00:00.000Z',
  userId: 'user-123',
  sessionId: 'session-456',
  service: 'catch-service',
  region: 'asia-east',
  data: { /* 事件特定数据 */ },
  metadata: {
    deviceType: 'ios',
    appVersion: '1.2.0',
    latency: 150,
    traceId: 'trace-789'
  }
}
```

### 4.2 实时聚合指标（20+）

| 指标类别 | 指标名称 | 计算方式 | 窗口 |
|---------|---------|---------|------|
| 活跃度 | active_users_1m | 1 分钟内活跃用户数 | 1m |
| 活跃度 | active_users_5m | 5 分钟内活跃用户数 | 5m |
| 活跃度 | concurrent_sessions | 当前在线会话数 | 实时 |
| 捕捉 | catch_success_rate_5m | 5 分钟捕捉成功率 | 5m |
| 捕捉 | catch_total_1m | 1 分钟捕捉总数 | 1m |
| 捕捉 | catch_by_rarity_5m | 按稀有度分组捕捉数 | 5m |
| 道馆 | gym_battles_active | 当前进行中的道馆战斗数 | 实时 |
| 道馆 | gym_battles_5m | 5 分钟道馆战斗数 | 5m |
| Raid | raids_active | 当前活跃 Raid 数 | 实时 |
| Raid | raid_participants_5m | 5 分钟 Raid 参与人数 | 5m |
| 交易 | trades_5m | 5 分钟交易数 | 5m |
| 交易 | trade_success_rate_5m | 5 分钟交易成功率 | 5m |
| 支付 | payment_success_rate_5m | 5 分钟支付成功率 | 5m |
| 支付 | payment_revenue_1h | 1 小时收入 | 1h |
| 成就 | achievements_5m | 5 分钟解锁成就数 | 5m |
| 分布 | users_by_region | 按地区分布的用户数 | 实时 |
| 分布 | events_by_service | 按服务分布的事件数 | 5m |
| 性能 | p95_latency_5m | 5 分钟 P95 延迟 | 5m |
| 性能 | error_rate_5m | 5 分钟错误率 | 5m |

### 4.3 异常检测规则

```javascript
// 可配置的异常检测规则
const anomalyRules = [
  {
    name: 'catch_success_rate_drop',
    metric: 'catch_success_rate_5m',
    condition: 'value < baseline * 0.7', // 低于基线 30%
    baseline: 'rolling_avg_1h', // 1 小时滚动平均
    severity: 'warning',
    cooldown: 300 // 5 分钟冷却
  },
  {
    name: 'payment_failure_spike',
    metric: 'payment_success_rate_5m',
    condition: 'value < 0.9', // 支付成功率 < 90%
    severity: 'critical',
    cooldown: 60
  },
  {
    name: 'latency_spike',
    metric: 'p95_latency_5m',
    condition: 'value > 500', // P95 延迟 > 500ms
    severity: 'warning',
    cooldown: 120
  },
  {
    name: 'error_rate_spike',
    metric: 'error_rate_5m',
    condition: 'value > 0.05', // 错误率 > 5%
    severity: 'critical',
    cooldown: 60
  }
];
```

### 4.4 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| /api/v1/realtime/metrics | GET | 获取所有实时指标 |
| /api/v1/realtime/metrics/:name | GET | 获取单个指标 |
| /api/v1/realtime/events/stream | WebSocket | 实时事件流订阅 |
| /api/v1/realtime/events/query | POST | 查询历史事件（最近 1 小时） |
| /api/v1/realtime/anomalies | GET | 获取当前异常列表 |
| /api/v1/realtime/anomalies/acknowledge | POST | 确认异常 |
| /api/v1/realtime/correlation/:eventId | GET | 获取事件关联链路 |
| /api/v1/realtime/subscribe | POST | 配置事件订阅规则 |

### 4.5 Prometheus 指标

```
# 实时业务指标
minego_realtime_active_users{window="1m"} 1234
minego_realtime_active_users{window="5m"} 5678
minego_realtime_concurrent_sessions 890
minego_realtime_catch_success_rate{window="5m"} 0.85
minego_realtime_catch_total{window="1m",rarity="legendary"} 12
minego_realtime_gym_battles_active 45
minego_realtime_raids_active 8
minego_realtime_payment_revenue{window="1h"} 12345.67
minego_realtime_p95_latency{window="5m"} 156
minego_realtime_error_rate{window="5m"} 0.012

# 异常检测指标
minego_realtime_anomalies_total{severity="critical"} 2
minego_realtime_anomalies_total{severity="warning"} 5
minego_realtime_anomaly_detected{rule="catch_success_rate_drop"} 1
```

## 5. 验收标准（可测试）

- [ ] 业务事件收集器支持 12 种事件类型，事件延迟 < 100ms
- [ ] 实时指标 API 返回 20+ 指标，数据延迟 < 5s
- [ ] WebSocket 推送支持 1000+ 并发连接，消息延迟 < 1s
- [ ] 异常检测器在指标异常时 30s 内发出告警
- [ ] 事件关联追踪可追踪跨 3+ 服务的事件链路
- [ ] 滑动窗口统计正确（1m/5m/1h 窗口）
- [ ] 所有实时指标暴露为 Prometheus 指标
- [ ] 单元测试覆盖核心逻辑 80%+
- [ ] 压力测试：支持 10000 events/s 吞吐量

## 6. 工作量估算

**L（Large）**

- 事件收集器与 Kafka 集成：2 天
- 实时聚合分析引擎：3 天
- 异常检测器：2 天
- API 端点与 WebSocket：2 天
- 事件关联追踪：1 天
- Prometheus 集成与测试：1 天
- 单元测试与文档：1 天

总计：约 12 天

## 7. 优先级理由

**P1 理由**：

1. **运营关键**：实时业务洞察是运营决策的基础，直接影响活动效果和收入
2. **异常响应**：快速发现业务异常可减少损失，支付异常每分钟都可能造成用户流失
3. **竞品差距**：Pokémon GO 具备完善的实时监控，这是产品竞争力差距
4. **依赖成熟**：已有 Kafka、Prometheus、WebSocket 基础设施，实现成本低
5. **可观测性补全**：当前只有技术指标监控，缺少业务层面的可观测性
