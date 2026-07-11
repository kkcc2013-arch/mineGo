# REQ-00540: 游戏服务全链路分布式追踪链路上下文传递增强

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00540 |
| 标题 | 游戏服务全链路分布式追踪链路上下文传递增强 |
| 类别 | 可观测性 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, backend/shared, pokemon-service, user-service, social-service |
| 创建时间 | 2026-07-11 18:00 |

## 需求描述

当前分布式链路追踪虽然已实现基本链路，但在跨异步任务队列、跨微服务 RPC 调用以及跨第三方 SDK 调用的场景下，TraceId 丢失情况严重，导致链路断层。需要构建一套标准化的链路上下文传递规范和中间件。

## 技术方案

### 1. 异步任务上下文传播
- 在 `backend/shared/TaskQueueManager` 中增加 TraceContext 自动注入/抽取逻辑。
- 对 Kafka/Redis 的消息发布与消费进行封装，确保 Message Header 中携带 X-Trace-Id。

### 2. 微服务调用透传
- 规范 Axios/Fetch 请求封装，强制在所有 outgoing 请求中透传 `X-Trace-Id`, `X-Span-Id`, `X-Parent-Span-Id`。
- 在网关（Gateway）层实现上下文的校验与初始化。

### 3. 可视化修正
- 适配 Jaeger/OpenTelemetry 采样策略，对跨异步任务的任务流进行 Parent-Child 关系自动重构。

## 验收标准

- [ ] 所有异步任务队列支持 TraceId 自动透传，无链路断层。
- [ ] 所有微服务间 RPC 调用 TraceId 完整传递。
- [ ] 链路追踪仪表盘能够完整展示完整调用栈，包含异步任务处理过程。
- [ ] 增加测试用例，模拟跨服务异步调用测试链路完整性。

## 影响范围

- gateway, backend/shared, pokemon-service, user-service, social-service

## 参考

- [OpenTelemetry Context Propagation Spec](https://opentelemetry.io/docs/specs/otel/context/api-propagators/)
