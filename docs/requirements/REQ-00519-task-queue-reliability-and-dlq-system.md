# REQ-00519: 后端任务队列可靠性增强与死信处理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00519 |
| 标题 | 后端任务队列可靠性增强与死信处理系统 |
| 类别 | 运维/CICD |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | backend/jobs, Redis, Kafka, infrastructure/monitoring |
| 创建时间 | 2026-07-09 03:00 |

## 需求描述

为了提高系统后台异步任务的可靠性，需要引入更健壮的重试机制以及完善的死信队列（Dead Letter Queue, DLQ）处理机制。当任务处理多次失败后，应自动将其移入 DLQ，并触发运维告警，支持手动重试或自动修复逻辑。

## 技术方案

### 1. 任务重试策略
- 实现指数退避算法（Exponential Backoff）作为默认的重试策略。
- 为不同任务类型定义最大重试次数和重试间隔。

### 2. 死信队列（DLQ）机制
- 失败次数超过限制的任务，自动投递到 Redis/Kafka 的 `dlq-topic`。
- 提供 admin 界面查看 DLQ 中的任务详情及错误堆栈。

### 3. 告警与自动触发
- 监控 DLQ 队列长度，超过阈值触发 Prometheus 告警。
- 实现一个简单的 Controller 用于手动从 DLQ 中拉取任务重新处理。

## 验收标准

- [ ] 实现指数退避重试逻辑。
- [ ] 任务处理失败后能正确进入死信队列。
- [ ] 提供 admin 管理界面查询死信任务及其失败原因。
- [ ] 任务堆积到一定数量时触发自动告警。

## 影响范围

- `backend/jobs` 任务处理模块
- `infrastructure/monitoring` 告警配置
- `admin-dashboard` 管理界面

## 参考

- [RabbitMQ/Kafka DLQ patterns](https://www.rabbitmq.com/dlx.html)
