# mineGo 需求总索引

> 自动维护，每小时新增 1 条。目标 10000 条或达成"可用"标准即止。

| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
| REQ-00001 | 结构化日志与 Prometheus 指标 | 性能优化 | P1 | done | backend/shared | 2026-06-04 |
| REQ-00044 | API 版本管理与向后兼容策略 | API 设计规范 | P1 | done | gateway, 所有微服务 | 2026-06-09 |
| REQ-00055 | 精灵收藏展示系统 | 功能增强 | P1 | new | pokemon-service, social-service | 2026-06-09 |
| REQ-00057 | 多因素认证（MFA）系统 | 安全加固 | P1 | new | user-service, gateway | 2026-06-09 |
| REQ-00060 | 数据库分区表与大数据量表分区策略 | 数据库/数据治理 | P1 | done | database/migrations | 2026-06-09 |
| REQ-00268 | 游戏内容数据库多语言支持 | 国际化/本地化 | P2 | done | database, backend/shared | 2026-06-18 |
| REQ-00269 | 锦标赛与竞技场赛季系统 | 功能增强 | P2 | done | gym-service, social-service | 2026-06-18 |
| REQ-00270 | 攻击模式检测系统 | 反作弊 | P1 | done | backend/shared, catch-service | 2026-06-18 |
| REQ-00271 | 精灵昵称与自定义名牌系统 | 功能增强 | P3 | done | pokemon-service, user-service | 2026-06-18 |
| REQ-00272 | API 契约测试系统与自动化 Mock 服务生成 | 测试覆盖 | P1 | done | backend/tests, gateway | 2026-06-18 |
| REQ-00259 | 数据库读写分离与主从同步监控系统 | 数据库/数据治理 | P1 | done | backend/shared, database | 2026-06-22 |
| REQ-00273 | Kubernetes 资源限制优化与成本监控 | 成本/资源优化 | P2 | new | k8s, monitoring | 2026-06-19 |
| REQ-00274 | 游戏活动服务单元测试覆盖 | 测试覆盖 | P2 | new | reward-service, backend/tests | 2026-06-22 |
| REQ-00275 | 告警智能关联与根因分析系统 | 可观测性/监控 | P1 | new | backend/shared, monitoring, gateway | 2026-06-22 |
