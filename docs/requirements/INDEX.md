# mineGo 需求总索引

> 自动维护，每小时新增 1 条。目标 10000 条或达成"可用"标准即止。

| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
| REQ-00614 | 核心战斗逻辑业务指标监控系统 | 可观测性 | P1 | done | gym-service | 2026-07-20 17:00 |
| REQ-00615 | 自动化灾难恢复演练系统 | 运维/CICD | P1 | done | infrastructure | 2026-07-20 17:00 |
| REQ-00616 | 智能资源调度与自动扩缩容系统 | 运维/CICD | P1 | new | infrastructure | 2026-07-20 18:00 |
| REQ-00617 | 用户体验实时监控与性能追踪系统（RUM/APM） | 可观测性 | P1 | new | game-client, gateway, backend/shared/monitoring | 2026-07-20 19:00 |
| REQ-00618 | 数据库读写分离与副本延迟监控系统 | 性能优化 | P1 | done | backend, database, gateway | 2026-07-20 20:00 |
| REQ-00619 | 核心战斗引擎业务测试覆盖框架 | 测试覆盖 | P1 | new | gym-service, battle-engine-module | 2026-07-21 00:00 |
| REQ-00620 | 游戏离线体验与 Service Worker 智能缓存管理系统 | 前端体验 | P1 | new | frontend/game-client, service-worker, backend/gateway | 2026-07-20 21:00 |
| REQ-00621 | GDPR/CCPA 自动化数据主体请求处理系统 | 合规/隐私 | P1 | new | user-service, data-platform, gateway | 2026-07-21 02:00 |
| REQ-00622 | API 请求参数统一验证与注入防护中间件系统 | API 设计规范 | P1 | done | gateway/middleware/validation, backend/shared/validators, 所有后端服务路由层 | 2026-07-20 22:00 |
| REQ-00623 | 数据库连接池智能预热与动态自适应管理系统 | 性能优化 | P1 | done | backend/jobs/intelligentPoolManager, backend/shared/database, backend/gateway/src/routes/poolMonitoring | 2026-07-21 12:00 |
|| REQ-00624 | 游戏内富文本内容本地化与版本管理系统 | 国际化/本地化 | P2 | new | gateway、user-service、reward-service、backend/shared/i18n、admin-dashboard、database/migrations | 2026-07-21 12:00 |
|| REQ-00625 | 游戏服务端云资源成本动态预测与智能优化系统 | 成本/资源优化 | P2 | new | infrastructure, backend | 2026-07-21 13:00 |
