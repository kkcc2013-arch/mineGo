# REQ-00504: 全链路监控可视化大屏实现

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00504 |
| 标题 | 全链路监控可视化大屏实现 |
| 类别 | 可观测性 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | infrastructure, observability-platform |
| 创建时间 | 2026-07-09 04:00 |

## 需求描述

当前 mineGo 项目虽然实现了分布式追踪和基础监控，但缺乏一个全局的、可视化的监控大屏，导致运维人员无法直观地感知系统的实时健康状态和链路瓶颈。
本需求目标是开发一套全链路监控可视化大屏，能够实时展示：
1. 核心链路（注册、登录、捕捉、对战）的 SLA/SLO 指标。
2. 微服务间的拓扑依赖图及实时流量负载。
3. 关键业务异常指标的实时分布。

## 技术方案

### 1. 数据集成层
- 基于 OpenTelemetry 收集的 traces 和 metrics。
- 对接已有的 Prometheus 和 Jaeger/Tempo 数据源。
- 引入 Grafana 作为底层渲染引擎，自定义仪表盘 JSON 模型。

### 2. 可视化界面
- 使用 React + Recharts 开发自适应监控大屏。
- 采用 Socket.io 推送关键告警指标，实现毫秒级页面更新。
- 实现拓扑图联动：点击异常节点自动下钻到相应的 Trace 详情页。

## 验收标准

- [ ] 监控大屏在 500ms 内加载完毕。
- [ ] 支持核心业务链路（捕捉/对战）实时延迟和错误率显示。
- [ ] 拓扑图支持自动发现并展示 80% 以上的服务节点关系。
- [ ] 异常链路发生时，大屏能自动高亮告警节点。

## 影响范围

- /data/mineGo/infrastructure/observability
- /data/mineGo/dashboard/monitor

## 参考

- OpenTelemetry Documentation: <https://opentelemetry.io/>
- Grafana API Guide: <https://grafana.com/docs/>
