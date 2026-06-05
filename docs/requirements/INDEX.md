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
| REQ-00011 | 游戏客户端多语言国际化支持 | 国际化/本地化 | P2 | done | game-client、gateway、所有微服务 | 2026-06-05 08:15 |
| REQ-00012 | 微服务启动样板代码重构与统一 | 技术债/重构 | P2 | new | 所有微服务、backend/shared | 2026-06-05 09:20 |
| REQ-00013 | 事件驱动架构与服务解耦 | 可扩展性/解耦 | P1 | new | 所有微服务、Kafka、backend/shared | 2026-06-05 09:25 |
| REQ-00014 | 服务熔断与降级机制 | 容灾/高可用 | P0 | new | gateway、所有微服务、backend/shared | 2026-06-05 09:30 |
| REQ-00015 | 数据库连接池优化与成本控制 | 成本/资源优化 | P2 | new | 所有微服务、database、backend/shared | 2026-06-05 09:35 |
| REQ-00016 | GDPR 合规与用户数据隐私保护 | 合规/隐私 | P1 | new | user-service、所有微服务、gateway、database | 2026-06-05 09:40 |
| REQ-00017 | 游戏客户端无障碍访问支持 | 无障碍(a11y) | P2 | new | game-client、frontend | 2026-06-05 09:45 |
| REQ-00018 | 精灵交易系统 | 功能增强 | P1 | new | social-service、pokemon-service、user-service、gateway、game-client | 2026-06-05 09:50 |
