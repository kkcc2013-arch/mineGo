# REQ-00614: 核心战斗逻辑业务指标监控系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00614 |
| 标题 | 核心战斗逻辑业务指标监控系统 |
| 类别 | 可观测性 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gym-service, gateway |
| 创建时间 | 2026-07-20 17:00 |

## 需求描述

为了更精准地度量核心战斗逻辑的健康度，需要引入一套基于业务维度的监控系统。目前仅有基础的服务器监控，无法洞察战斗结算异常、技能触发耗时异常、伤害数值偏移等业务侧问题。

目标：
1. 建立战斗全链路业务指标埋点规范。
2. 实现基于 Prometheus 的战斗业务指标实时采集。
3. 针对战斗胜负比、关键技能异常触发等指标设置阈值告警。

## 技术方案

### 1. 埋点规范定义
- 引入业务自定义 header 追踪战斗 ID。
- 在 `gym-service` 战斗结算模块增加业务数据采集（胜负、耗时、伤害）。

### 2. 指标采集
- 使用 `prom-client` 在 `gym-service` 暴露 `/metrics` 接口。
- 定义 `battle_duration_seconds` (Histogram), `battle_win_rate_ratio` (Gauge), `skill_execution_error_total` (Counter)。

### 3. 数据可视化
- 在 Grafana 新增 "Core Battle Dashboard"。
- 配置告警规则：如 `skill_execution_error_total` 每分钟超过 5 次触发高优先级告警。

## 验收标准

- [ ] 战斗核心指标已成功接入 Prometheus。
- [ ] Grafana 战斗监控仪表板已创建。
- [ ] 定义了至少 3 条战斗相关业务告警规则。
- [ ] 战斗逻辑异常（如结算超时）可被追踪回特定战斗 ID。

## 影响范围

- `gym-service` (战斗逻辑服务)
- `gateway` (监控接入)

## 参考

- [监控聚合设计文档](/data/mineGo/infrastructure/observability/dashboard/README.md)
