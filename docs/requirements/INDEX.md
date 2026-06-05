# mineGo 需求总索引

> 自动维护，每小时新增 1 条。目标 10000 条或达成"可用"标准即止。

| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
| REQ-00001 | 附近精灵查询 Redis GEO 缓存层 | 性能优化 | P0 | done | location-service | 2026-06-04 15:11 |
| REQ-00002 | 结构化日志与 Prometheus 指标集成 | 可观测性/监控 | P0 | done | gateway、所有微服务 | 2026-06-04 16:00 |
| REQ-00003 | 支付订单幂等性与签名验证安全加固 | 安全加固 | P0 | done | payment-service、gateway | 2026-06-04 17:00 |
| REQ-00004 | 支付服务单元测试与集成测试覆盖 | 测试覆盖 | P1 | done | payment-service、backend/tests/ | 2026-06-05 00:30 |
| REQ-00005 | Prometheus 告警规则与 Alertmanager 集成 | 可观测性/监控 | P1 | done | infrastructure/k8s、所有微服务 | 2026-06-05 01:30 |
| REQ-00006 | K8s 滚动更新与回滚自动化 | 运维/CICD | P1 | done | infrastructure/k8s、GitHub Actions、所有微服务 | 2026-06-05 02:00 |
| REQ-00007 | 数据库迁移管理与版本控制系统 | 数据库/数据治理 | P1 | done | database/migrations、所有微服务 | 2026-06-05 03:00 |
| REQ-00008 | OpenAPI 文档与 API 设计规范统一 | API 设计规范 | P1 | done | gateway、所有微服务、docs/api-spec | 2026-06-05 04:00 |
| REQ-00009 | PWA 离线支持与 Service Worker 缓存策略 | 前端体验 | P0 | done | game-client、frontend/sw.js、frontend/manifest.json | 2026-06-05 05:00 |
| REQ-00010 | GPS 伪造检测与速度限制反作弊系统 | 反作弊 | P0 | done | gateway、location-service、catch-service、gym-service | 2026-06-05 06:00 |
