# REQ-00610: API 请求响应链路分布式追踪数据可视化增强

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00610 |
| 标题 | API 请求响应链路分布式追踪数据可视化增强 |
| 类别 | 可观测性 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, backend/shared/tracing, observability-dashboard |
| 创建时间 | 2026-07-20 15:00 |

## 需求描述

目前分布式追踪（Jaeger）能够记录基础的 Span 信息，但在处理复杂业务链路（如跨服务调用、异步消息队列、数据库查询）时，可视化效果不足。需要增强前端的可视化表现，支持：
1. 异步任务与原始请求的关联展示（Trace Context 关联）。
2. 数据库查询耗时在链路中的高亮显示。
3. 关键性能指标（P99, P95）在链路图谱上的聚合展示。

## 技术方案

### 1. 后端注入追踪增强
- 改进 Span 标签注入逻辑，确保在消息队列中传递完整的 Trace Context。
- 收集数据库查询统计信息并作为 Annotation 注入到 Span 中。

### 2. 前端展示增强
- 使用 D3.js 或类似的图表库对 Jaeger 导出的 JSON 数据进行渲染。
- 开发聚合视图，能够将同类型请求合并统计。

## 验收标准

- [ ] 分布式链路能够完整显示消息队列后的异步处理 Span。
- [ ] 链路图谱支持以热力图形式展示各服务的响应耗时。
- [ ] 关键业务指标（如 P99）在链路界面中实时可见。

## 影响范围

- gateway
- observability-dashboard
- backend/shared/tracing

## 参考

- Distributed Tracing Docs
- Observability Architecture.md
