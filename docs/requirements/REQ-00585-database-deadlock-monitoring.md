# REQ-00585: 数据库死锁检测与自动化记录分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00585 |
| 标题 | 数据库死锁检测与自动化记录分析系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database-proxy, backend-shared-db |
| 创建时间 | 2026-07-16 23:00 |

## 需求描述

在复杂的微服务架构中，多个服务并行操作数据库容易导致死锁问题。目前缺乏自动化的死锁捕获、上下文关联和可视化分析能力，导致排查困难。本需求旨在构建一套针对 PostgreSQL 的自动化死锁捕获与分析系统。

## 技术方案

### 1. 数据库层捕获
- 开启 Postgres `log_lock_waits` 和 `deadlock_timeout` 配置。
- 实现一个侧边监控脚本，实时解析 postgres 日志中的 `deadlock detected` 错误条目。

### 2. 上下文关联
- 在数据库查询中间件中植入 `trace_id` 注入逻辑，确保死锁发生时能通过日志关联到对应的 HTTP 请求链路。

### 3. 可观测性集成
- 将死锁信息推送至 prometheus 监控指标，并在 Grafana 中创建告警面板。
- 集成至分布式追踪系统，提供死锁时刻的 SQL 执行链路图。

## 验收标准

- [ ] 死锁发生时，监控系统能实时捕获并记录日志。
- [ ] 死锁日志中包含对应的 `trace_id` 和相关 SQL 上下文。
- [ ] 提供 Grafana 死锁告警仪表盘。
- [ ] 确保死锁捕获逻辑不会对数据库性能产生显著影响（需经过基准测试）。

## 影响范围

- `backend-shared-db` (数据库连接库)
- `database-proxy` (中间件)
- 可观测性相关模块 (Grafana/Prometheus)

## 参考

- [Postgres Deadlock Monitoring Docs](https://www.postgresql.org/docs/current/runtime-config-logging.html)
