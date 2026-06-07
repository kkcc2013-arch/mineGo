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
|| REQ-00012 | 微服务启动样板代码重构与统一 | 技术债/重构 | P2 | done | 所有微服务、backend/shared | 2026-06-05 09:20 |
|| REQ-00013 | 事件驱动架构与服务解耦 | 可扩展性/解耦 | P1 | done | 所有微服务、Kafka、backend/shared | 2026-06-05 09:25 |
|| REQ-00014 | 服务熔断与降级机制 | 容灾/高可用 | P0 | done | gateway、所有微服务、backend/shared | 2026-06-05 09:30 |
|| REQ-00015 | 数据库连接池优化与成本控制 | 成本/资源优化 | P2 | done | 所有微服务、database、backend/shared | 2026-06-05 09:35 |
| REQ-00016 | GDPR 合规与用户数据隐私保护 | 合规/隐私 | P1 | done | user-service、所有微服务、gateway、database | 2026-06-05 09:40 |
| REQ-00017 | 游戏客户端无障碍访问支持 | 无障碍(a11y) | P2 | done | game-client、frontend | 2026-06-05 09:45 |
| REQ-00018 | 精灵交易系统 | 功能增强 | P1 | done | social-service、pokemon-service、user-service、gateway、game-client | 2026-06-05 09:50 |
|| REQ-00019 | 精灵技能学习与技能机器系统 | 功能增强 | P1 | done | pokemon-service、catch-service、reward-service、game-client、database/migrations | 2026-06-05 10:00 |
| REQ-00020 | 精灵列表查询复合索引优化 | 性能优化 | P1 | done | pokemon-service、database/migrations | 2026-06-05 11:00 |
|| REQ-00021 | JWT 令牌黑名单与强制登出机制 | 安全加固 | P1 | done | gateway、user-service、backend/shared、Redis | 2026-06-05 12:00 |
| REQ-00022 | 集成测试框架与 API 端到端测试覆盖 | 测试覆盖 | P1 | done | backend/tests/integration、所有微服务、GitHub Actions | 2026-06-05 14:35 |
|| REQ-00023 | 分布式链路追踪与 Jaeger 集成 | 可观测性/监控 | P1 | done | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring | 2026-06-05 15:00 |
| REQ-00024 | 蓝绿部署策略实现 | 运维/CICD | P1 | done | gateway、所有微服务、infrastructure/k8s、.github/workflows、scripts | 2026-06-05 16:05 |
| REQ-00025 | 数据库自动化备份与灾难恢复系统 | 数据库/数据治理 | P1 | done | PostgreSQL、database/backup、infrastructure/k8s、.github/workflows | 2026-06-05 17:00 |
|| REQ-00026 | 游戏内实时推送通知系统 | 前端体验 | P1 | done | game-client、gateway、reward-service、gym-service、social-service | 2026-06-05 18:00 |
|| REQ-00027 | 精灵详情页 3D 模型展示与交互 | 前端体验 | P2 | done | game-client、frontend/3d、pokemon-service | 2026-06-05 19:00 |
|| REQ-00028 | 玩家行为异常模式智能检测系统 | 反作弊 | P1 | done | gateway、catch-service、gym-service、social-service、backend/shared/anti-cheat.js | 2026-06-05 20:00 |
|| REQ-00029 | 游戏事件时区本地化与多时区支持 | 国际化/本地化 | P1 | done | gateway、user-service、gym-service、reward-service、game-client、frontend | 2026-06-05 21:15 |
| REQ-00030 | 开发者贡献指南与项目文档完善 | 文档/开发者体验 | P2 | done | docs、README.md、CONTRIBUTING.md、ARCHITECTURE.md | 2026-06-05 22:05 |
|| REQ-00031 | API 响应缓存层与缓存失效策略 | 技术债/重构 | P2 | done | gateway、所有微服务、backend/shared、Redis | 2026-06-05 23:05 |
| REQ-00032 | 多渠道推送通知插件架构 | 可扩展性/解耦 | P1 | done | reward-service、user-service、backend/shared/notification、gateway | 2026-06-07 00:00 |
