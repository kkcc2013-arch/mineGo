# mineGo 需求总索引

> 自动维护，每次开发循环新增 1 条需求。

| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
| REQ-00490 | API性能回归测试自动化与基准线管理系统 | 测试覆盖 | P1 | done | backend/tests/regression | 2026-07-08 00:09 |
| REQ-00491 | 监控指标生命周期管理与废弃治理系统 | 可观测性/监控 | P2 | new | backend/shared/metrics | 2026-07-08 01:17 |
| REQ-00492 | 部署流水线可视化看板与状态追踪系统 | 运维/CICD | P1 | done | backend/admin, admin-dashboard | 2026-07-08 03:00 |
| REQ-00493 | 自动化灾难恢复演练系统 | 运维/CICD | P1 | done | infrastructure/k8s/dr, backend/jobs | 2026-07-08 03:00 |
| REQ-00494 | 游戏内行为数据实时风控与反作弊自动化分析系统 | 安全加固 | P0 | done | backend/security, backend/analysis | 2026-07-08 04:00 |
| REQ-00495 | 文化敏感内容本地化过滤与合规适配系统 | 国际化/本地化 | P1 | new | gateway、pokemon-service、social-service、admin-dashboard、backend/jobs | 2026-07-08 04:00 |
|| REQ-00496 | 推送通知内容多语言本地化与智能语言适配系统 | 国际化/本地化 | P1 | done | gateway、user-service、backend/shared/pushNotificationService.js、backend/shared/i18n.js、Redis、PostgreSQL | 2026-07-08 06:00 |
|| REQ-00497 | 用户协议变更版本管理与强制确认通知系统 | 合规/隐私 | P1 | new | gateway, user-service, backend/jobs/privacyUpdateNotify.js | 2026-07-08 07:00 |
| REQ-00500 | 服务端数字格式化本地化与多语言统一系统 | 国际化/本地化 | P1 | done | backend/shared/numberFormat.js、所有后端服务、gateway/middleware、日志系统、推送通知 | 2026-07-08 10:00 |
| REQ-00501 | 日志输出适配器抽象层与插件化架构 | 可扩展性/解耦 | P1 | new | backend/shared/logger.js、所有后端服务、infrastructure/logging | 2026-07-08 10:00 |
| REQ-00502 | 性能分析与深度优化框架设计 | 性能优化 | P1 | new | backend/shared/perf, gateway/src/middleware/perf | 2026-07-08 11:00 |
| REQ-00503 | 游戏客户端屏幕阅读器与 ARIA 无障碍支持 | 无障碍(a11y) | P1 | done | game-client、frontend/game-client/src/accessibility、所有 UI 组件 | 2026-07-08 12:00 || REQ-00504 | 全链路监控可视化大屏实现 | 可观测性 | P1 | new | infrastructure, observability-platform | 2026-07-09 04:00 |
