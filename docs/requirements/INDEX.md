# mineGo 需求总索引

> 自动维护，每小时新增 1 条。目标 10000 条或达成"可用"标准即止。

| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
| REQ-00001 | 附近精灵查询 Redis GEO 缓存层 | 性能优化 | P0 | done | location-service | 2026-06-04 15:11 |
| REQ-00002 | 结构化日志与 Prometheus 指标集成 | 可观测性/监控 | P0 | done | gateway、所有微服务 | 2026-06-04 16:00 |
| REQ-00003 | 支付订单幂等性与签名验证安全加固 | 安全加固 | P0 | done | payment-service、gateway | 2026-06-04 17:00 |
| REQ-00004 | 支付服务单元测试与集成测试覆盖 | 测试覆盖 | P1 | done | payment-service、backend/tests/ | 2026-06-05 00:30 |
| REQ-00005 | Prometheus 告警规则与 Alertmanager 集成 | 可观测性/监控 | P1 | new | infrastructure/k8s、所有微服务 | 2026-06-05 01:30 |
