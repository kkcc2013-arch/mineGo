# mineGo 需求总索引

> 自动维护，每小时新增 1 条。目标 10000 条或达成"可用"标准即止。

| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
| REQ-00001 | 结构化日志与 Prometheus 指标 | 性能优化 | P1 | done | backend/shared | 2026-06-04 |
| REQ-00044 | API 版本管理与向后兼容策略 | API 设计规范 | P1 | done | gateway, 所有微服务 | 2026-06-09 |
| REQ-00055 | 精灵收藏展示系统 | 功能增强 | P1 | done | pokemon-service, social-service | 2026-06-09 |
| REQ-00057 | 多因素认证（MFA）系统 | 安全加固 | P1 | done | user-service, gateway | 2026-06-09 |
| REQ-00060 | 数据库分区表与大数据量表分区策略 | 数据库/数据治理 | P1 | done | database/migrations | 2026-06-09 |
| REQ-00268 | 游戏内容数据库多语言支持 | 国际化/本地化 | P2 | done | database, backend/shared | 2026-06-18 |
| REQ-00269 | 锦标赛与竞技场赛季系统 | 功能增强 | P2 | done | gym-service, social-service | 2026-06-18 |
| REQ-00270 | 攻击模式检测系统 | 反作弊 | P1 | done | backend/shared, catch-service | 2026-06-18 |
| REQ-00271 | 精灵昵称与自定义名牌系统 | 功能增强 | P3 | done | pokemon-service, user-service | 2026-06-18 |
| REQ-00272 | API 契约测试系统与自动化 Mock 服务生成 | 测试覆盖 | P1 | done | backend/tests, gateway | 2026-06-18 |
| REQ-00259 | 数据库读写分离与主从同步监控系统 | 数据库/数据治理 | P1 | done | backend/shared, database | 2026-06-22 |
| REQ-00273 | Kubernetes 资源限制优化与成本监控 | 成本/资源优化 | P2 | new | k8s, monitoring | 2026-06-19 |
| REQ-00274 | 游戏活动服务单元测试覆盖 | 测试覆盖 | P2 | new | reward-service, backend/tests | 2026-06-22 |
| REQ-00275 | 告警智能关联与根因分析系统 | 可观测性/监控 | P1 | done | backend/shared, monitoring, gateway | 2026-06-22 |
| REQ-00276 | 精灵培育系统与基因遗传机制 | 功能增强 | P1 | done | pokemon-service, reward-service, user-service | 2026-06-22 02:00 |
| REQ-00277 | 服务发现与动态路由系统 | 可扩展性/解耦 | P1 | new | gateway, backend/shared, 所有微服务 | 2026-06-22 02:00 |
| REQ-00278 | 精灵性格系统与战斗风格塑造 | 功能增强 | P1 | new | pokemon-service, battle-service, user-service | 2026-06-22 03:00 |
|| REQ-00279 | 反作弊行为模式机器学习检测系统 | 反作弊 | P1 | new | backend/shared, catch-service, gym-service, ml-service | 2026-06-22 03:15 |
|| REQ-00280 | 游戏数值本地化显示系统 | 国际化/本地化 | P2 | new | game-client, backend/shared | 2026-06-22 04:00 |
| REQ-00281 | 游戏色盲模式与视觉辅助系统 | 无障碍(a11y) | P1 | new | game-client, pokemon-service, backend/shared | 2026-06-22 05:00 |
| REQ-00282 | 开发者环境一键初始化与智能诊断系统 | 文档/开发者体验 | P1 | done | backend, scripts, docs | 2026-06-22 05:00 |
| REQ-00283 | 精灵天赋系统与隐藏属性机制 | 功能增强 | P1 | new | pokemon-service, battle-service, user-service | 2026-06-22 06:00 |
| REQ-00284 | 分布式事务编排与 Saga 补偿机制系统 | 可扩展性/解耦 | P1 | new | backend/shared, gateway, catch-service, gym-service, payment-service | 2026-06-22 06:00 |
|| REQ-00285 | 服务实例优雅停机与连接排空系统 | 容灾/高可用 | P1 | new | backend/shared, gateway, 所有微服务, k8s | 2026-06-22 07:00 |
| REQ-00286 | 游戏认知障碍支持与简化模式系统 | 无障碍(a11y) | P1 | new | game-client, user-service, pokemon-service, backend/shared | 2026-06-22 08:00 |
