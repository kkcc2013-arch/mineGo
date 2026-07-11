# REQ-00533: 游戏服务端异常日志追踪与告警聚合系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00533 |
| 标题 | 游戏服务端异常日志追踪与告警聚合系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/shared/logger, infrastructure/monitoring, backend/jobs |
| 创建时间 | 2026-07-11 12:00 |

## 需求描述

当前服务端异常日志分散在各个服务的日志文件中，难以快速定位跨服务的逻辑故障。此需求旨在建立一个全自动的异常日志追踪与聚合系统，能够自动将同一业务链路下的异常日志关联起来，并根据错误类别、频率、严重程度进行告警聚合，减少告警噪音。

## 技术方案

### 1. 日志链路关联
- 在所有后端服务中引入 Trace ID，在日志输出时自动附带 `traceId`。
- 修改 `backend/shared/logger.js`，确保所有 error 级别的日志自动提取当前上下文的 `traceId` 和 `spanId`。

### 2. 告警聚合服务
- 开发 `backend/jobs/errorAggregationJob.js`，定期从 Elasticsearch/Loki 拉取最近的 error 日志。
- 实现基于指纹（Error Message + Stacktrace 简化版）的聚合算法。
- 对于聚合后的错误组，记录首次发生时间、最后发生时间、频率。

### 3. 告警策略
- 当同一指纹的错误在短时间内频率超过阈值（如 5 分钟 100 次）时，推送到告警平台（AlertManager/DingTalk）。
- 实现自动降噪：对于已知且处于监控中的错误，暂不告警，仅记录并在 dashboard 展示。

## 验收标准

- [ ] 日志自动附带 `traceId`，可通过日志平台按 `traceId` 追踪全链路异常。
- [ ] 错误聚合服务能够将相似的异常日志合并，并展示频率统计。
- [ ] 告警聚合功能上线，频率超过阈值时触发告警。
- [ ] 告警通知包含关键信息（服务名、错误详情、影响范围）。

## 影响范围

- `backend/shared/logger.js`
- `infrastructure/monitoring`
- `backend/jobs/errorAggregationJob.js`

## 参考

- [REQ-00275: 告警智能相关性与根因分析系统](/data/mineGo/docs/requirements/REQ-00275-alert-intelligent-correlation-and-root-cause-analysis-system.md)
- [REQ-00501: 日志输出适配器抽象层](/data/mineGo/docs/requirements/REQ-00501-logging-output-adapter-abstract-layer.md)
