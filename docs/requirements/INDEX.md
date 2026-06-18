# mineGo 需求总索引

> 自动维护，每小时新增 1 条。**目标 10000 条！**

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
|| REQ-00129 | 精灵数据备份与恢复系统 | 数据库/数据治理 | P1 | done | pokemon-service、user-service、database、backend/jobs、gateway | 2026-06-11 21:30 |
|| REQ-00130 | 实时业务事件流监控与分析系统 | 可观测性/监控 | P1 | done | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring | 2026-06-11 22:00 |
|| REQ-00131 | pokemon-service achievements 路由挂载与集成 | 集成与修复 | P0 | done | pokemon-service | 2026-06-11 23:00 |
| REQ-00024 | 蓝绿部署策略实现 | 运维/CICD | P1 | done | gateway、所有微服务、infrastructure/k8s、.github/workflows、scripts | 2026-06-05 16:05 |
| REQ-00025 | 数据库自动化备份与灾难恢复系统 | 数据库/数据治理 | P1 | done | PostgreSQL、database/backup、infrastructure/k8s、.github/workflows | 2026-06-05 17:00 |
|| REQ-00026 | 游戏内实时推送通知系统 | 前端体验 | P1 | done | game-client、gateway、reward-service、gym-service、social-service | 2026-06-05 18:00 |
|| REQ-00027 | 精灵详情页 3D 模型展示与交互 | 前端体验 | P2 | done | game-client、frontend/3d、pokemon-service | 2026-06-05 19:00 |
|| REQ-00028 | 玩家行为异常模式智能检测系统 | 反作弊 | P1 | done | gateway、catch-service、gym-service、social-service、backend/shared/anti-cheat.js | 2026-06-05 20:00 |
|| REQ-00029 | 游戏事件时区本地化与多时区支持 | 国际化/本地化 | P1 | done | gateway、user-service、gym-service、reward-service、game-client、frontend | 2026-06-05 21:15 |
|| REQ-00030 | 开发者贡献指南与项目文档完善 | 文档/开发者体验 | P2 | done | docs、README.md、CONTRIBUTING.md、ARCHITECTURE.md | 2026-06-05 22:05 |
|| REQ-00031 | API 响应缓存层与缓存失效策略 | 技术债/重构 | P2 | done | gateway、所有微服务、backend/shared、Redis | 2026-06-05 23:05 |
| REQ-00032 | 多渠道推送通知插件架构 | 可扩展性/解耦 | P1 | done | reward-service、user-service、backend/shared/notification、gateway | 2026-06-07 00:00 |
| REQ-00033 | API 压力测试与性能基准系统 | 测试覆盖 | P2 | done | backend/tests/performance、所有微服务、GitHub Actions | 2026-06-07 20:10 |
|| REQ-00034 | COPPA 合规与未成年人年龄验证系统 | 合规/隐私 | P1 | done | user-service、gateway、game-client、database/migrations | 2026-06-07 21:15 |
|| REQ-00035 | 游戏客户端色盲模式支持 | 无障碍(a11y) | P2 | done | game-client、frontend、game-client/src/components | 2026-06-07 22:00 |
|| REQ-00036 | 前端 Playwright E2E 测试系统 | 测试覆盖 | P1 | done | game-client、backend/tests/e2e、.github/workflows | 2026-06-08 16:40 |
|| REQ-00037 | 真实天气 API 集成与天气加成系统 | 功能增强 | P1 | done | location-service、catch-service、backend/shared、game-client、frontend | 2026-06-08 17:00 |
| REQ-00038 | API 敏感数据泄露防护与审计日志加密存储 | 安全加固 | P1 | done | gateway、所有微服务、backend/shared、database/migrations | 2026-06-08 19:48 |
|| REQ-00039 | 热点数据缓存预热系统 | 性能优化 | P1 | done | gateway、pokemon-service、location-service、backend/shared、Redis | 2026-06-08 23:05 |
| REQ-00040 | 云成本监控与预算告警系统 | 成本/资源优化 | P1 | done | infrastructure/k8s、gateway、所有微服务、backend/shared | 2026-06-08 23:30 |
| REQ-00041 | 多区域容灾切换与灾备恢复系统 | 容灾/高可用 | P0 | done | gateway、所有微服务、infrastructure/k8s、database、Redis | 2026-06-09 01:00 |
|| REQ-00042 | 基础设施即代码安全扫描与配置验证系统 | 运维/CICD | P1 | done | .github/workflows、infrastructure/k8s、Dockerfile、scripts | 2026-06-09 01:05 |
|| REQ-00043 | 延迟任务队列与可靠重试机制 | 技术债/重构 | P1 | done | 所有微服务、backend/shared、Kafka | 2026-06-09 02:00 |
| REQ-00044 | API 版本管理与向后兼容策略 | API 设计规范 | P1 | done | gateway、所有微服务、docs/api-spec | 2026-06-09 03:00 |
|| REQ-00045 | 设备完整性与模拟器检测系统 | 反作弊 | P1 | done | gateway、user-service、catch-service、gym-service、game-client、backend/shared | 2026-06-09 07:00 |
|| REQ-00046 | 精灵培育系统与遗传机制 | 功能增强 | P1 | done | pokemon-service、user-service、social-service、gateway、game-client、database/migrations ||
||| REQ-00047 | 精灵道具与背包管理系统 | 功能增强 | P1 | done | pokemon-service、reward-service、catch-service、social-service、gateway、game-client | 2026-06-09 12:50 |
|| REQ-00048 | 精灵好友系统与社交互动增强 | 功能增强 | P1 | done | social-service、user-service、gateway、game-client、pokemon-service、reward-service | 2026-06-09 10:00 |
| REQ-00049 | API 客户端 SDK 统一抽象层 | 技术债/重构 | P1 | done | backend/shared、gateway、所有微服务 | 2026-06-09 14:30 |
| REQ-00050 | 插件化中间件系统与生命周期管理 | 可扩展性/解耦 | P1 | done | gateway、所有微服务、backend/shared、infrastructure/k8s | 2026-06-09 13:00 |
| REQ-00051 | 多货币支持与汇率转换系统 | 国际化/本地化 | P1 | done | payment-service、user-service、gateway、backend/shared | 2026-06-09 15:00 |
| REQ-00052 | 静态资源 CDN 集成与图片优化系统 | 性能优化 | P1 | done | game-client、gateway、infrastructure/k8s、backend/shared | 2026-06-09 14:05 |
|| REQ-00053 | 用户隐私偏好管理中心与数据透明度报告 | 合规/隐私 | P2 | done | user-service、gateway、game-client、backend/shared、database/migrations | 2026-06-09 15:00 ||
|| REQ-00054 | 道馆战斗系统 | 功能增强 | P0 | done | gym-service、pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-09 16:00 |
| REQ-00055 | 精灵收藏展示系统 | 功能增强 | P1 | done | pokemon-service、social-service、user-service、gateway、game-client、database/migrations | 2026-06-09 16:35 |
| REQ-00056 | 精灵图鉴完成度奖励系统 | 功能增强 | P1 | done | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations | 2026-06-09 17:00 |
| REQ-00057 | 多因素认证（MFA）系统 | 安全加固 | P1 | done | user-service、gateway、game-client、backend/shared、database/migrations | 2026-06-09 17:05 |
| REQ-00057 | 游戏活动系统与限时活动管理 | 功能增强 | P0 | done | reward-service、location-service、pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-09 18:00 |
| REQ-00058 | 公会系统与团队社交功能 | 功能增强 | P1 | done | social-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-09 19:00 |
| REQ-00059 | 新手引导与教程系统 | 功能增强 | P1 | done | user-service、reward-service、gateway、game-client、database/migrations | 2026-06-09 20:00 |
|| REQ-00060 | 数据库分区表与大数据量表分区策略 | 数据库/数据治理 | P1 | done | database/migrations、所有微服务、backend/shared、PostgreSQL | 2026-06-09 18:05 |
|| REQ-00061 | 服务健康仪表板与自动恢复系统 | 运维/CICD | P1 | done | gateway、所有微服务、infrastructure/k8s、backend/shared | 2026-06-09 21:00 |
|| REQ-00062 | 游戏音效与背景音乐系统 | 前端体验 | P1 | done | game-client、frontend/audio、game-client/src/components | 2026-06-09 19:15 ||
|| REQ-00063 | 数据库慢查询分析与自动优化建议系统 | 数据库/数据治理 | P1 | done | database/migrations、所有微服务、backend/shared、infrastructure/k8s | 2026-06-09 22:00 |
| REQ-00064 | 风险触发式人机验证（CAPTCHA）系统 | 反作弊 | P1 | done | gateway、user-service、game-client、backend/shared、Redis | 2026-06-09 20:15 |
| REQ-00065 | 精灵进化与成长系统 | 功能增强 | P0 | done | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-09 23:00 |
|| REQ-00066 | API 错误码标准化与故障排查手册 | 文档/开发者体验 | P1 | done | gateway、所有微服务、backend/shared、docs/api-spec、docs/troubleshooting | 2026-06-10 07:00 |
| REQ-00067 | 精灵羁绊与互动养成系统 | 功能增强 | P1 | done | pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-09 22:30 |
| REQ-00068 | 服务降级策略与优雅降级管理器 | 容灾/高可用 | P1 | done | gateway、所有微服务、backend/shared、infrastructure/k8s | 2026-06-09 22:05 |
| REQ-00069 | 精灵资源管理系统与动态刷新控制 | 功能增强 | P1 | done | location-service、catch-service、backend/shared、game-client、database/migrations | 2026-06-09 23:30 |
|| REQ-00070 | Redis 内存优化与自动 TTL 策略 | 成本/资源优化 | P1 | done | backend/shared/cache.js、backend/shared/redis.js、gateway、所有微服务 | 2026-06-09 23:00 ||
|| REQ-00071 | K8s Pod 资源自动扩缩容优化系统 | 成本/资源优化 | P1 | done | infrastructure/k8s、gateway、所有微服务、backend/shared | 2026-06-09 23:30 |
| REQ-00072 | API 响应 Gzip/Brotli 压缩优化 | 性能优化 | P1 | done | gateway、所有微服务、backend/shared | 2026-06-10 00:20 |
| REQ-00073 | 玩家对战系统（PVP Duel） | 功能增强 | P0 | done | social-service、pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-10 01:25 |
| REQ-00074 | 玩家排行榜系统 | 功能增强 | P1 | done | social-service、user-service、pokemon-service、gym-service、gateway、game-client、Redis、database/migrations | 2026-06-10 10:00 |
|| REQ-00075 | IP 黑名单与恶意 IP 自动封禁系统 | 安全加固 | P1 | done | gateway、user-service、backend/shared、Redis、database/migrations | 2026-06-10 02:00 |
|| REQ-00076 | 精灵成就系统与里程碑奖励 | 功能增强 | P1 | done | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations | 2026-06-10 02:15 |
|| REQ-00077 | 数据库慢查询分析与自动优化建议系统 | 数据库/数据治理 | P1 | done | database/migrations、所有微服务、backend/shared、infrastructure/k8s | 2026-06-10 10:30 |
|| REQ-00078 | 金丝雀发布与流量分割系统 | 运维/CICD | P1 | done | gateway、所有微服务、infrastructure/k8s、.github/workflows、backend/shared | 2026-06-10 04:00 |
|| REQ-00079 | 精灵好感度系统与亲密度进化机制 | 功能增强 | P1 | done | pokemon-service、user-service、catch-service、reward-service、gateway、game-client、database/migrations | 2026-06-10 11:00 |
| REQ-00080 | API 请求响应 Schema 验证系统 | API 设计规范 | P1 | done | gateway、backend/shared、所有微服务、docs/api-spec/openapi | 2026-06-10 05:00 |
| REQ-00081 | 捕捉动画特效系统 | 前端体验 | P1 | done | game-client、frontend/effects、catch-service | 2026-06-10 06:00 |
| REQ-00082 | 精灵捕捉成功率异常检测系统 | 反作弊 | P1 | done | catch-service、gateway、backend/shared、Redis、PostgreSQL | 2026-06-10 07:00 |
| REQ-00083 | 区域化内容分发与地区专属活动管理系统 | 国际化/本地化 | P1 | done | location-service、reward-service、pokemon-service、gateway、game-client、database/migrations | 2026-06-10 08:15 |
| REQ-00084 | 数据库连接池监控与自适应扩缩容系统 | 成本/资源优化 | P1 | done | gateway、所有微服务、backend/shared、PostgreSQL、infrastructure/k8s | 2026-06-10 09:00 |
| REQ-00085 | 配置中心与动态配置热更新系统 | 技术债/重构 | P1 | done | gateway、所有微服务、backend/shared、Redis、infrastructure/k8s | 2026-06-10 09:00 |
|| REQ-00086 | 精灵特性系统与隐藏能力激活机制 | 功能增强 | P1 | done | pokemon-service、catch-service、gym-service、gateway、game-client、database/migrations | 2026-06-10 12:00 |
| REQ-00087 | 混沌工程与故障注入测试系统 | 容灾/高可用 | P1 | done | gateway、所有微服务、backend/shared、infrastructure/k8s、backend/tests/chaos | 2026-06-10 10:00 |
| REQ-00088 | Redis 连接池管理与健康监控系统 | 成本/资源优化 | P1 | done | backend/shared/redis.js、所有微服务、infrastructure/k8s、backend/shared/metrics.js | 2026-06-10 12:38 |
|| REQ-00089 | 数据跨境传输合规与本地化存储策略 | 合规/隐私 | P1 | done | user-service、gateway、database、backend/shared、infrastructure/k8s | 2026-06-10 13:00 |
| REQ-00090 | 精灵状态效果系统与战斗Buff/Debuff管理 | 功能增强 | P1 | done | pokemon-service、gym-service、gateway、game-client、database/migrations | 2026-06-10 14:00 |
| REQ-00091 | 精灵装备系统与属性加成机制 | 功能增强 | P1 | done | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-10 14:00 |
|| REQ-00092 | API 请求合并与批量查询优化 | 性能优化 | P1 | done | game-client、gateway、pokemon-service、social-service、gym-service | 2026-06-10 15:00 |
|| REQ-00093 | API 契约测试系统 | 测试覆盖 | P1 | done | gateway、所有微服务、backend/tests/contract | 2026-06-10 16:00 |
| REQ-00094 | 实时业务指标仪表板与运营监控系统 | 可观测性/监控 | P1 | done | gateway、所有微服务、infrastructure/k8s/monitoring、admin-dashboard | 2026-06-10 16:05 |
| REQ-00095 | 游戏状态持久化与离线状态恢复系统 | 前端体验 | P1 | done | game-client、frontend/storage、backend/shared、user-service | 2026-06-10 22:50 |
|| REQ-00096 | 数据库事务隔离级别控制与死锁检测机制 | 数据库/数据治理 | P1 | done | backend/shared/db.js、catch-service、gym-service、payment-service、social-service | 2026-06-11 00:20 |
|| REQ-00097 | 精灵日常任务系统与任务奖励机制 | 功能增强 | P1 | done | reward-service、user-service、pokemon-service、catch-service、social-service、gateway、game-client、database/migrations | 2026-06-10 17:00 |
| REQ-00098 | 自适应 API 限流与用户配额管理系统 | API 设计规范 | P1 | done | gateway、所有微服务、backend/shared、Redis、PostgreSQL | 2026-06-11 00:00 |
| REQ-00099 | 游戏消息中心与通知管理系统 | 前端体验 | P1 | done | game-client、frontend/components、user-service、gateway | 2026-06-11 01:40 |
| REQ-00100 | 自动化脚本与宏检测系统 | 反作弊 | P1 | done | gateway、catch-service、gym-service、game-client、backend/shared | 2026-06-11 02:00 |
| REQ-00101 | 后端 API 错误消息国际化系统 | 国际化/本地化 | P1 | done | gateway、所有微服务、backend/shared、frontend/game-client | 2026-06-11 03:00 |
| REQ-00102 | 精灵昼夜循环系统 | 功能增强 | P1 | done | location-service、catch-service、pokemon-service、gateway、game-client、database/migrations | 2026-06-11 04:00 |
| REQ-00103 | 微服务依赖图与循环依赖检测系统 | 技术债/重构 | P1 | done | gateway、所有微服务、backend/shared、infrastructure/k8s、docs/architecture | 2026-06-11 04:00 |
| REQ-00104 | 精灵交换市场与竞价拍卖系统 | 功能增强 | P1 | done | social-service、pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-11 04:30 |
|| REQ-00105 | 分布式锁服务与 Redis Redlock 实现 | 容灾/高可用 | P1 | done | backend/shared/distributedLock.js、所有微服务、Redis | 2026-06-11 05:15 |
| REQ-00106 | 玩家称号系统与个性化展示 | 功能增强 | P1 | done | user-service、pokemon-service、social-service、gateway、game-client、database/migrations | 2026-06-11 05:30 |
| REQ-00107 | 数据生命周期管理与自动清理策略 | 合规/隐私 | P1 | done | user-service、pokemon-service、social-service、payment-service、backend/shared、database/migrations、backend/jobs | 2026-06-11 06:00 |
| REQ-00108 | 游戏客户端光敏性癫痫安全模式 | 无障碍(a11y) | P2 | new | game-client、frontend/effects、frontend/game-client/src/accessibility、catch-service、gym-service | 2026-06-11 07:05 |
| REQ-00109 | 精灵团队战斗系统（Team Battle） | 功能增强 | P1 | done | gym-service、pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-11 10:25 |
| REQ-00110 | 前端资源懒加载与代码分割系统 | 性能优化 | P1 | done | game-client、frontend/game-client/src、frontend/game-client/src/components | 2026-06-11 11:35 |
| REQ-00110 | 精灵背包容量管理与扩展系统 | 功能增强 | P1 | done | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-11 11:00 |
| REQ-00111 | API 安全响应头与 CSP 强化系统 | 安全加固 | P1 | done | gateway、所有微服务、backend/shared、game-client | 2026-06-11 12:00 |
|| REQ-00129 | 精灵数据备份与恢复系统 | 数据库/数据治理 | P1 | done | pokemon-service、user-service、database、backend/jobs、gateway | 2026-06-11 21:30 |
|| REQ-00130 | 实时业务事件流监控与分析系统 | 可观测性/监控 | P1 | done | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring | 2026-06-11 22:00 |
|| REQ-00131 | pokemon-service achievements 路由挂载与集成 | 集成与修复 | P0 | done | pokemon-service | 2026-06-11 23:00 |
|| REQ-00114 | 精灵季节活动系统 | 功能增强 | P1 | done | location-service、catch-service、pokemon-service、reward-service、gateway、game-client、database/migrations | 2026-06-11 14:00 |
| REQ-00115 | 数据库连接池自适应调度与负载均衡系统 | 数据库/数据治理 | P1 | done | backend/shared/db.js、所有微服务、PostgreSQL、infrastructure/k8s | 2026-06-16 05:00 |
|| REQ-00116 | 精灵团队实时语音聊天系统 | 功能增强 | P1 | done | gym-service、social-service、user-service、gateway、game-client、infrastructure/k8s | 2026-06-11 16:00 |
| REQ-00117 | 地图手势交互优化与缩放流畅度提升 | 前端体验 | P2 | new | game-client、frontend/game-client/src/game、frontend/game-client/index.html | 2026-06-11 17:05 |
|| REQ-00149 | user-service ipAppeal 路由挂载与集成 | 集成与修复 | P0 | done | user-service、backend/services/user-service/src/index.js、backend/services/user-service/src/routes/ipAppeal.js | 2026-06-12 08:10 |
|| REQ-00150 | 背包容量扩展与购买系统 | 功能增强 | P1 | done | pokemon-service、user-service、payment-service、gateway、game-client | 2026-06-12 09:00 |
| REQ-00119 | pokemon-service 进化路由挂载与集成 | 集成与修复 | P0 | done | pokemon-service | 2026-06-11 17:30 |
| REQ-00120 | user-service 消息中心路由挂载与集成 | 集成与修复 | P0 | done | user-service | 2026-06-11 17:35 |
| REQ-00121 | social-service 排行榜路由挂载与集成 | 集成与修复 | P0 | done | social-service | 2026-06-11 17:40 |
| REQ-00122 | 微服务配置中心与动态配置热更新系统 | 可扩展性/解耦 | P1 | done | gateway、所有微服务、backend/shared/config、Redis | 2026-06-11 18:00 |
| REQ-00123 | pokemon-service showcase 路由挂载与集成 | 集成与修复 | P0 | done | pokemon-service | 2026-06-11 18:30 |
|| REQ-00124 | 消息中心服务单元测试覆盖 | 测试覆盖 | P1 | done | user-service、backend/tests/unit/ | 2026-06-11 19:10 |
| REQ-00126 | user-service MFA 路由挂载与集成 | 集成与修复 | P0 | done | user-service | 2026-06-11 20:05 |
| REQ-00127 | 用户数据删除请求管理系统 | 合规/隐私 | P1 | done | user-service、gateway、所有微服务、database、backend/jobs | 2026-06-11 20:15 |
| REQ-00128 | social-service PVP 路由挂载与集成 | 集成与修复 | P0 | done | social-service | 2026-06-11 21:05 |

|| REQ-00129 | 精灵数据备份与恢复系统 | 数据库/数据治理 | P1 | done | pokemon-service、user-service、database、backend/jobs、gateway | 2026-06-11 21:30 |
|| REQ-00130 | 实时业务事件流监控与分析系统 | 可观测性/监控 | P1 | done | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring | 2026-06-11 22:00 |
|| REQ-00131 | payment-service 多货币支持路由挂载与集成 | 集成与修复 | P0 | done | payment-service | 2026-06-11 23:00 |
|| REQ-00142 | location-service spawnConfig 路由挂载与集成 | 集成与修复 | P0 | done | location-service | 2026-06-12 04:10 |
|| REQ-00143 | 精灵自定义技能组合与连招系统 | 功能增强 | P1 | new | pokemon-service、gym-service、social-service、gateway、game-client、database/migrations | 2026-06-12 05:00 |
|| REQ-00133 | pokemon-service pokedex 路由挂载与集成 | 集成与修复 | P0 | done | pokemon-service | 2026-06-11 23:20 |
|| REQ-00134 | social-service friends 路由挂载与集成 | 集成与修复 | P0 | done | social-service | 2026-06-11 23:30 |
|| REQ-00135 | reward-service events 路由挂载与集成 | 集成与修复 | P0 | done | reward-service | 2026-06-11 23:40 |
|| REQ-00136 | FCM/APNs 移动推送通知系统 | 功能增强 | P1 | done | user-service、reward-service、gateway、game-client、Firebase、Apple Developer | 2026-06-12 00:00 |
| REQ-00137 | 游戏内容本地化内容管理与翻译工作流系统 | 国际化/本地化 | P1 | done | gateway、user-service、reward-service、backend/shared、admin-dashboard、database/migrations | 2026-06-12 00:35 |
| REQ-00138 | pokemon-service inventory 路由挂载与集成 | 集成与修复 | P0 | done | pokemon-service | 2026-06-12 01:25 |
| REQ-00139 | 事件总线适配器抽象层 | 可扩展性/解耦 | P1 | done | backend/shared/EventBusAdapter.js、backend/shared/adapters/、所有微服务 | 2026-06-12 02:00 |
|| REQ-00140 | 低峰期服务自动休眠与智能唤醒系统 | 成本/资源优化 | P1 | new | gateway、所有微服务、backend/shared/sleepManager.js、backend/shared/trafficAnalyzer.js、infrastructure/k8s、backend/jobs | 2026-06-12 03:00 |
|| REQ-00141 | reward-service events 路由挂载与集成 | 集成与修复 | P0 | done | reward-service、gateway | 2026-06-12 03:30 |
|| REQ-00142 | location-service spawnConfig 路由挂载与集成 | 集成与修复 | P0 | done | location-service | 2026-06-12 04:10 |
|| REQ-00143 | 精灵自定义技能组合与连招系统 | 功能增强 | P1 | new | pokemon-service、gym-service、social-service、gateway、game-client、database/migrations | 2026-06-12 05:00 |
|| REQ-00144 | 游戏客户端高对比度模式支持系统 | 无障碍(a11y) | P2 | done | game-client、frontend/game-client/src/accessibility、frontend/game-client/styles | 2026-06-12 05:10 |
|| REQ-00145 | 精灵详情批量查询优化 | 性能优化 | P1 | done | pokemon-service、gateway、game-client、backend/shared | 2026-06-12 06:10 |
| REQ-00146 | 道馆战斗伤害公式与属性克制计算系统 | 功能增强 | P1 | done | gym-service、pokemon-service、backend/shared | 2026-06-12 07:00 |
|| REQ-00147 | API 请求速率限制绕过检测与防护系统 | 安全加固 | P1 | done | gateway、backend/shared/rateLimitMonitor.js、Redis、PostgreSQL | 2026-06-12 07:15 |
|| REQ-00148 | 分布式追踪与请求链路可视化系统 | 可观测性/监控 | P1 | done | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring | 2026-06-12 08:00 |
|| REQ-00149 | user-service ipAppeal 路由挂载与集成 | 集成与修复 | P0 | done | user-service、backend/services/user-service/src/index.js、backend/services/user-service/src/routes/ipAppeal.js | 2026-06-12 08:10 |
|| REQ-00150 | 背包容量扩展与购买系统 | 功能增强 | P1 | done | pokemon-service、user-service、payment-service、gateway、game-client | 2026-06-12 09:00 |

| REQ-00151 | 精灵羁绊技能解锁机制 | 功能增强 | P1 | done | pokemon-service、game-client、database/migrations | 2026-06-12 09:00 |
| REQ-00152 | gym-service battle 路由挂载与集成 | 集成与修复 | P0 | done | gym-service、backend/services/gym-service/src/index.js、backend/services/gym-service/src/routes/battle.js | 2026-06-12 10:05 |
| REQ-00153 | 游戏内截图分享与社交传播系统 | 前端体验 | P1 | done | game-client、frontend/game-client/src/share、gateway、user-service、backend/shared | 2026-06-13 06:40 |
| REQ-00154 | 游戏客户端内存篡改检测与防护系统 | 反作弊 | P1 | done | game-client、gateway、catch-service、gym-service、backend/shared/memoryGuard.js | 2026-06-13 07:00 |
|| REQ-00155 | OpenAPI 文档多语言描述与国际化支持 | 国际化/本地化 | P1 | done | gateway、docs/api-spec/openapi、backend/shared、backend/scripts | 2026-06-13 08:00 |
|| REQ-00156 | 精灵恢复站系统 | 功能增强 | P1 | done | location-service、pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-13 09:00 |
|| REQ-00157 | 统一错误处理与 API 响应格式标准化 | 技术债/重构 | P1 | done | 所有微服务、backend/shared、gateway、game-client | 2026-06-13 09:05 |
|| REQ-00158 | 业务事件异常检测与智能告警系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring | 2026-06-13 10:00 |
| REQ-00159 | 服务健康自愈与自动恢复系统 | 容灾/高可用 | P1 | done | gateway、所有微服务、backend/shared、infrastructure/k8s | 2026-06-13 10:05 |
| REQ-00160 | 精灵特殊个体值（彩蛋）系统 | 功能增强 | P1 | done | pokemon-service、catch-service、location-service、gateway、game-client、database/migrations | 2026-06-13 15:00 |
| REQ-00161 | 低峰期服务自动休眠与智能唤醒系统 | 成本/资源优化 | P1 | done | gateway、所有微服务、backend/shared/TrafficAnalyzer.js、backend/shared/SleepManager.js、backend/jobs/peakHourPreheater.js | 2026-06-16 04:00 | gateway、所有微服务、backend/shared/sleepManager.js、backend/shared/trafficAnalyzer.js、infrastructure/k8s、backend/jobs | 2026-06-13 10:30 |
|| REQ-00233 | 游戏控制器与手柄输入支持系统 | 无障碍(a11y) | P2 | new | game-client、frontend/game-client/src/input、frontend/game-client/src/accessibility | 2026-06-15 21:05 |
|| REQ-00234 | API 请求速率限制智能适配与动态配额系统 | 安全加固 | P1 | done | gateway、user-service、backend/shared、Redis、PostgreSQL | 2026-06-15 22:05 |

|| REQ-00163 | 游戏客户端内存篡改检测与防护系统 | 反作弊 | P1 | new | game-client、gateway、catch-service、gym-service、backend/shared | 2026-06-13 16:00 |
|| REQ-00164 | 精灵详情页图片懒加载与渐进式加载系统 | 性能优化 | P1 | done | game-client、frontend/game-client/src/components、backend/shared/CDNManager.js、gateway | 2026-06-13 18:05 |
|| REQ-00165 | 实时竞技排行榜优化与热度预测系统 | 性能优化 | P1 | new | social-service、user-service、gym-service、gateway、Redis、backend/shared | 2026-06-13 18:15 |
|| REQ-00166 | 实时业务事件流监控与分析系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring | 2026-06-13 19:00 |
| REQ-00166 | API 集成测试覆盖率提升与自动化回归测试系统 | 测试覆盖 | P1 | new | backend/tests/integration、所有微服务、GitHub Actions、docs/api-spec | 2026-06-13 19:35 |
|| REQ-00167 | 游戏内容本地化数据层与动态翻译系统 | 国际化/本地化 | P1 | done | pokemon-service、location-service、reward-service、gateway、database/migrations、game-client | 2026-06-13 20:05 |
|| REQ-00168 | 分布式追踪与请求链路可视化系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring | 2026-06-13 21:00 |
|| REQ-00169 | 微服务启动器统一化与服务样板代码消除 | 技术债/重构 | P1 | new | pokemon-service、location-service、social-service、catch-service、gym-service、reward-service、payment-service、backend/shared | 2026-06-13 21:00 |
|| REQ-00170 | 游戏客户端离线模式与断线重连系统 | 前端体验 | P1 | new | game-client、frontend/game-client/src/offline、gateway、backend/shared、user-service | 2026-06-13 21:15 |
|| REQ-00171 | 游戏触觉反馈增强系统 | 前端体验 | P1 | done | game-client、frontend/game-client/src/haptics、frontend/game-client/src/game/CatchEngine.js、frontend/game-client/src/audio/AudioManager.js | 2026-06-13 22:00 ||
| REQ-00172 | 精灵体力系统与疲劳度管理 | 功能增强 | P1 | done | pokemon-service、gym-service、catch-service、gateway、game-client、database/migrations | 2026-06-16 07:05 |
|| REQ-00173 | 游戏教程本地化与动态提示系统 | 国际化/本地化 | P1 | new | game-client、gateway、user-service、pokemon-service、backend/shared、database/migrations | 2026-06-13 23:05 |
||| REQ-00174 | 数据库物化视图与复杂查询优化系统 | 性能优化 | P1 | new | pokemon-service、social-service、gym-service、user-service、database/migrations、backend/shared | 2026-06-13 23:05 ||
|| REQ-00175 | 实时交易异常检测与风控系统 | 安全加固 | P1 | new | social-service、pokemon-service、user-service、gateway、backend/shared | 2026-06-14 01:00 |
|| REQ-00176 | 部署流水线状态跟踪与回滚管理系统 | 运维/CICD | P1 | new | gateway、所有微服务、.github/workflows、backend/shared、infrastructure/k8s、backend/jobs | 2026-06-14 01:00 |
||| REQ-00177 | 服务网格流量镜像测试系统 | 测试覆盖 | P1 | new | gateway、所有微服务、infrastructure/k8s、backend/tests/traffic | 2026-06-14 02:00 |
||| REQ-00178 | 容器镜像生命周期管理与存储优化系统 | 成本/资源优化 | P1 | new | infrastructure/k8s、.github/workflows、backend/shared、所有微服务 | 2026-06-14 02:00 |
||| REQ-00179 | 分布式追踪与请求链路可视化系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring | 2026-06-14 03:00 |
||| REQ-00180 | 游戏键盘导航与快捷键系统 | 无障碍(a11y) | P2 | new | game-client、frontend/game-client/src/accessibility、frontend/game-client/src/input、frontend/game-client/src/components | 2026-06-14 03:00 |
||| REQ-00181 | 游戏客户端内存完整性保护与篡改检测系统 | 反作弊 | P1 | new | game-client、gateway、catch-service、gym-service、backend/shared | 2026-06-14 04:00 |
||| REQ-00182 | 客户端精灵数据预取与智能缓存系统 | 性能优化 | P1 | new | game-client、gateway、pokemon-service、backend/shared | 2026-06-14 04:00 |
||| REQ-00183 | 精灵道具合成与配方系统 | 功能增强 | P1 | new | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations | 2026-06-14 04:30 |
| REQ-00184 | 数据隐私影响评估（DPIA）自动化系统 | 合规/隐私 | P1 | new | user-service、gateway、admin-dashboard、backend/jobs、database/migrations | 2026-06-14 05:00 |
|| REQ-00239 | SLO 错误预算燃尽告警与服务健康评分系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared/sloBudgetTracker.js、infrastructure/k8s/monitoring、admin-dashboard | 2026-06-16 01:00 |
|| REQ-00240 | 精灵放生与资源回收系统 | 功能增强 | P1 | done | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-16 10:00 |
|| REQ-00186 | 精灵历史数据归档与冷热分离系统 | 数据库/数据治理 | P1 | new | pokemon-service、user-service、database、backend/jobs、backend/shared、infrastructure/k8s | 2026-06-14 07:00 |
|| REQ-00188 | 用户语言偏好持久化与跨设备同步系统 | 国际化/本地化 | P1 | new | user-service、gateway、game-client、database/migrations、backend/shared/i18n.js | 2026-06-14 08:05 |

|| REQ-00189 | 游戏内实时数据可视化与统计仪表板 | 前端体验 | P1 | new | game-client、frontend/game-client/src/components/StatsDashboard.js、frontend/game-client/src/charts、gateway、user-service、pokemon-service、reward-service | 2026-06-14 09:05 |
|||| REQ-00190 | 自动化灾难恢复演练与验证系统 | 运维/CICD | P1 | new | infrastructure/k8s、gateway、所有微服务、backend/jobs、backend/shared、.github/workflows | 2026-06-14 10:00 |
|| REQ-00191 | 实时业务事件流监控与分析系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring | 2026-06-14 11:00 |
| REQ-00192 | 精灵战斗伤害预计算与结果缓存系统 | 性能优化 | P1 | new | gym-service、pokemon-service、backend/shared/DamageCache.js、Redis、game-client | 2026-06-14 10:35 |
|| REQ-00193 | 消除 console.log 与统一结构化日志使用 | 技术债/重构 | P1 | done | gym-service、location-service、user-service、backend/shared/logger.js | 2026-06-14 11:00 |
| REQ-00194 | 事件总线适配器抽象层 | 可扩展性/解耦 | P1 | new | backend/shared/EventBusAdapter.js、backend/shared/adapters/、所有微服务、gateway | 2026-06-14 12:00 |

|| REQ-00195 | 精灵异常状态抗性与免疫计算系统 | 功能增强 | P1 | new | pokemon-service、gym-service、catch-service、gateway、game-client、database/migrations | 2026-06-14 12:30 |
|| REQ-00196 | 微服务路由层集成测试覆盖率提升计划 | 测试覆盖 | P1 | new | 所有微服务、backend/tests/integration、backend/tests/unit | 2026-06-14 13:00 |
|| REQ-00197 | 精灵天赋系统与隐藏属性机制 | 功能增强 | P1 | new | pokemon-service、catch-service、gym-service、gateway、game-client、database/migrations | 2026-06-14 14:00 |
|| REQ-00233 | 游戏控制器与手柄输入支持系统 | 无障碍(a11y) | P2 | new | game-client、frontend/game-client/src/input、frontend/game-client/src/accessibility | 2026-06-15 21:05 |
|| REQ-00234 | API 请求速率限制智能适配与动态配额系统 | 安全加固 | P1 | done | gateway、user-service、backend/shared、Redis、PostgreSQL | 2026-06-15 22:05 |
||| REQ-00199 | 数据血缘追踪与影响分析系统 | 数据库/数据治理 | P1 | new | gateway、所有微服务、backend/shared、database、infrastructure/k8s/monitoring | 2026-06-14 15:00 |
|| REQ-00200 | 敏感操作二次验证与风险分级验证系统 | 安全加固 | P1 | new | gateway、user-service、payment-service、social-service、backend/shared/riskVerifier.js、game-client | 2026-06-14 15:05 |
|| REQ-00201 | API 契约版本协商与灰度兼容系统 | API 设计规范 | P1 | new | gateway、所有微服务、backend/shared、docs/api-spec | 2026-06-14 16:00 |
||| REQ-00202 | 安全模块单元测试覆盖率提升系统 | 测试覆盖 | P1 | done | backend/shared、backend/tests/unit、所有微服务 | 2026-06-14 16:05 |
|| REQ-00203 | 分布式追踪与 OpenTelemetry 集成系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared/tracing、infrastructure/k8s/monitoring | 2026-06-14 17:00 |
|| REQ-00204 | 精灵动作队列与动画预加载系统 | 前端体验 | P1 | new | game-client、frontend/game-client/src/animation、frontend/game-client/src/game、gateway、pokemon-service | 2026-06-14 17:00 |
|| REQ-00205 | 开发者环境自动化配置工具 | 文档/开发者体验 | P1 | new | scripts/setup-dev.js、backend/shared/config、.env.example、Dockerfile.dev、docs | 2026-06-14 18:00 |
|| REQ-00206 | 精灵交易税务与手续费系统 | 功能增强 | P1 | new | social-service、pokemon-service、user-service、payment-service、gateway、game-client、database/migrations | 2026-06-14 18:00 |
| REQ-00207 | 精灵对比工具与属性分析系统 | 前端体验 | P1 | new | game-client、frontend/game-client/src/components/PokemonCompare.js、pokemon-service、gateway | 2026-06-14 19:00 |
| REQ-00208 | 玩家行为数据分析与用户画像系统 | 数据治理/分析 | P1 | new | user-service、gateway、backend/shared、backend/jobs、admin-dashboard | 2026-06-14 19:10 |
| REQ-00209 | 游戏地图标记聚合与渲染优化 | 前端体验 | P1 | new | game-client、frontend/game-client/src/map、frontend/game-client/src/components、gateway、location-service | 2026-06-14 20:00 |
|| REQ-00210 | 精灵亲密度进化计算与提示系统 | 功能增强 | P1 | done | pokemon-service、gateway、game-client、database/migrations | 2026-06-14 21:00 |
|| REQ-00211 | 微服务样板代码统一初始化器 | 技术债/重构 | P1 | done | 所有微服务、backend/shared | 2026-06-14 21:00 |
|| REQ-00212 | 云资源利用率分析与成本归因系统 | 成本/资源优化 | P1 | new | infrastructure/k8s、gateway、所有微服务、backend/shared、admin-dashboard | 2026-06-14 22:00 |
|| REQ-00213 | GDPR 数据主体权利请求管理系统 | 合规/隐私 | P1 | new | user-service、gateway、admin-dashboard、backend/jobs、database/migrations | 2026-06-14 22:00 |
|| REQ-00214 | 敏感操作二次验证与风险分级验证系统 | 安全加固 | P1 | new | gateway、user-service、payment-service、social-service、backend/shared/riskVerifier.js、game-client | 2026-06-14 23:00 |
|| REQ-00215 | API 请求签名验证与重放攻击防护系统 | 安全加固 | P1 | new | gateway、所有微服务、backend/shared、game-client | 2026-06-14 23:00 |
|| REQ-00216 | 精灵经验值动态调整与智能加速系统 | 功能增强 | P1 | new | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-15 00:00 |
||| REQ-00217 | 数据库查询请求合并与去重中间件 | 性能优化 | P1 | new | backend/shared/QueryDeduplication.js、gateway、所有微服务、backend/shared/db.js | 2026-06-15 00:05 |
|| REQ-00218 | 游戏客户端截图内容安全审核系统 | 安全加固 | P1 | new | game-client、gateway、user-service、backend/shared/contentSafety.js | 2026-06-15 01:00 |
| REQ-00219 | 会话异常检测与自动防护系统 | 安全加固 | P1 | new | gateway、user-service、backend/shared/sessionAnomalyDetector.js、Redis、PostgreSQL、game-client | 2026-06-15 13:30 |
|| REQ-00220 | 实时业务指标服务单元测试覆盖 | 测试覆盖 | P1 | done | backend/shared/realtimeBusinessMetrics.js、backend/tests/unit、gateway、所有微服务 | 2026-06-15 14:00 |
|| REQ-00221 | 容器镜像安全扫描与漏洞预警系统 | 安全加固 | P1 | new | infrastructure/k8s、所有微服务、.github/workflows、backend/shared | 2026-06-15 15:00 |
| REQ-00222 | CI/CD 构建缓存优化与依赖供应链安全验证系统 | 运维/CICD | P1 | new | .github/workflows、backend、frontend、scripts、npm/yarn | 2026-06-15 15:00 |
|| REQ-00223 | 数据库表结构变更影响分析与自动化迁移验证系统 | 数据库/数据治理 | P1 | new | backend/shared/SchemaChangeAnalyzer.js、backend/shared/MigrationValidator.js、database/migrations、所有微服务、admin-dashboard | 2026-06-15 16:00 |
|| REQ-00224 | 国际化货币格式化与区域支付本地化系统 | 国际化/本地化 | P1 | new | payment-service、user-service、gateway、game-client、backend/shared | 2026-06-15 17:00 |
| REQ-00225 | 监控数据降采样与长期存储系统 | 可观测性/监控 | P1 | new | infrastructure/k8s/monitoring、backend/shared、Prometheus、VictoriaMetrics、admin-dashboard | 2026-06-15 17:05 |
| REQ-00226 | API 请求契约测试自动化与 Mock 服务生成系统 | 测试覆盖 | P1 | new | gateway、所有微服务、backend/tests/contract、docs/api-spec、frontend/game-client | 2026-06-15 18:00 |
|| REQ-00227 | 精灵数据预编译缓存与增量同步系统 | 性能优化 | P1 | new | pokemon-service、gateway、backend/shared/PokemonPrecompileCache.js、game-client、Redis、database/migrations | 2026-06-15 18:05 |
|| REQ-00228 | 游戏社交隐私设置与好友权限管理系统 | 功能增强 | P1 | new | social-service、user-service、gateway、game-client、database/migrations | 2026-06-15 19:00 |
|| REQ-00229 | 游戏界面复数形式与性别语法本地化系统 | 国际化/本地化 | P1 | new | game-client、frontend/game-client/src/i18n、gateway、所有微服务、backend/shared/i18n.js | 2026-06-15 19:05 |
|| REQ-00230 | 精灵经验值获取历史与成长轨迹追踪系统 | 功能增强 | P1 | new | pokemon-service、gateway、game-client、database/migrations | 2026-06-15 20:00 |
|| REQ-00231 | 通用 API 幂等性中间件系统 | 性能优化 | P1 | new | backend/shared/IdempotencyMiddleware.js、gateway、catch-service、gym-service、payment-service、Redis | 2026-06-15 20:40 |
|| REQ-00232 | 数据库连接池健康检测与自动恢复系统 | 性能优化 | P1 | new | backend/shared、所有微服务、PostgreSQL、infrastructure/k8s | 2026-06-15 21:00 |
|| REQ-00233 | 游戏控制器与手柄输入支持系统 | 无障碍(a11y) | P2 | new | game-client、frontend/game-client/src/input、frontend/game-client/src/accessibility | 2026-06-15 21:05 |
|| REQ-00234 | API 请求速率限制智能适配与动态配额系统 | 安全加固 | P1 | done | gateway、user-service、backend/shared、Redis、PostgreSQL | 2026-06-15 22:05 |
| REQ-00235 | 用户反馈与 Bug 报告收集系统 | 功能增强 | P1 | new | user-service、gateway、game-client、admin-dashboard、backend/shared | 2026-06-15 22:30 |
| REQ-00236 | 精灵变异系统与稀有形态 | 功能增强 | P1 | new | pokemon-service、catch-service、location-service、gateway、game-client、database/migrations | 2026-06-15 23:00 |
|| REQ-00237 | 微服务端到端集成测试与契约验证自动化系统 | 测试覆盖 | P1 | new | backend/tests/integration、backend/tests/contract、所有微服务、gateway、.github/workflows | 2026-06-16 00:00 |
|| REQ-00238 | 用户生物特征数据保护与存储合规系统 | 合规/隐私 | P1 | new | user-service、gateway、game-client、backend/shared、database/migrations | 2026-06-16 01:00 |
|| REQ-00239 | SLO 错误预算燃尽告警与服务健康评分系统 | 可观测性/监控 | P1 | new | gateway、所有微服务、backend/shared/sloBudgetTracker.js、infrastructure/k8s/monitoring、admin-dashboard | 2026-06-16 01:00 |
|| REQ-00240 | 精灵放生与资源回收系统 | 功能增强 | P1 | done | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-16 10:00 |
|| REQ-00241 | 软件物料清单（SBOM）生成与供应链安全验证系统 | 运维/CICD | P1 | new | .github/workflows、backend/shared、所有微服务、infrastructure/k8s | 2026-06-16 02:10 |
|| REQ-00242 | 微服务启动配置统一化与环境变量校验系统 | 技术债/重构 | P1 | new | 所有微服务、backend/shared/configValidator.js、backend/shared/ServiceBootstrap.js | 2026-06-16 03:00 |
| REQ-00243 | 精灵心情系统与情绪表现 | 功能增强 | P1 | new | pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-16 03:30 |
|| REQ-00244 | RTL 语言布局自动适配系统 | 国际化/本地化 | P1 | new | game-client、frontend/game-client/src/i18n、frontend/game-client/src/styles、gateway、backend/shared/i18n.js | 2026-06-16 04:00 |
|| REQ-00245 | 精灵觉醒系统与潜能激活 | 功能增强 | P1 | new | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations | 2026-06-16 05:00 |
|| REQ-00246 | 数据泄露应急响应与通知系统 | 合规/隐私 | P1 | new | gateway、user-service、所有微服务、backend/shared/DataLeakResponder.js、backend/jobs、infrastructure/k8s/monitoring、admin-dashboard | 2026-06-16 05:00 |
|| REQ-00247 | 精灵捕捉地点伪造检测系统 | 反作弊 | P1 | new | catch-service、location-service、user-service、gateway、backend/shared | 2026-06-16 06:00 |
| REQ-00248 | Kubernetes 存储卷生命周期管理与自动扩缩容系统 | 成本/资源优化 | P1 | new | infrastructure/k8s、backend/shared、backend/jobs、所有微服务、admin-dashboard | 2026-06-16 06:00 |
|| REQ-00249 | 基础设施成本预测与预算智能规划系统 | 成本/资源优化 | P1 | new | backend/shared、infrastructure/k8s、admin-dashboard、所有微服务、backend/jobs | 2026-06-16 07:00 |
| REQ-00250 | 多设备登录管理与设备信任系统 | 安全加固 | P1 | new | user-service、gateway、game-client、backend/shared、database/migrations、admin-dashboard | 2026-06-16 08:00 |
| REQ-00251 | API 响应序列化优化与 JSON 压缩系统 | 性能优化 | P1 | new | gateway、所有微服务、backend/shared/JsonOptimizer.js、game-client | 2026-06-16 08:00 |
| REQ-00252 | 游戏内日期时间格式本地化系统 | 国际化/本地化 | P2 | new | game-client、frontend/game-client/src/i18n、backend/shared/i18n.js、gateway、所有微服务 | 2026-06-16 09:00 |
| REQ-00253 | 精灵远征探险系统 | 功能增强 | P1 | new | pokemon-service、location-service、reward-service、gateway、game-client、database/migrations | 2026-06-16 15:00 |
| REQ-00254 | 数据库查询执行计划缓存与智能优化器系统 | 性能优化 | P1 | new | postgresql、backend/shared、所有微服务、database/migrations | 2026-06-16 15:05 |
|| REQ-00255 | API 请求参数注入攻击防护系统 | 安全加固 | P1 | done | gateway、所有微服务、backend/shared/InjectionGuard.js、backend/shared/InputSanitizer.js | 2026-06-18 13:10 |
|| REQ-00256 | 精灵传说系统与图鉴收集故事 | 功能增强 | P1 | new | pokemon-service、user-service、gateway、game-client、database/migrations | 2026-06-16 17:30 |
| REQ-00257 | API 回归测试自动化与 Breaking Change 检测系统 | 测试覆盖 | P1 | new | gateway、所有微服务、backend/tests/regression、backend/shared/OpenAPIComparator.js、.github/workflows、docs/api-spec | 2026-06-18 13:05 |
| REQ-00258 | 部署变更日志自动生成与发布说明系统 | 运维/CICD | P1 | new | .github/workflows、backend/shared/ChangelogGenerator.js、scripts、docs、admin-dashboard | 2026-06-18 14:00 |
| REQ-00258 | 精灵捕捉动画特效系统增强与粒子效果优化 | 前端体验 | P1 | new | game-client、frontend/game-client/src/effects、frontend/game-client/src/game/CatchEngine.js、gateway | 2026-06-18 14:00 |
|| REQ-00259 | 数据库读写分离与主从同步监控系统 | 数据库/数据治理 | P1 | new | backend/shared/db.js、backend/shared/ReadWriteRouter.js、所有微服务、PostgreSQL、infrastructure/k8s、admin-dashboard | 2026-06-18 15:00 |
|| REQ-00260 | 精灵图鉴探索系统与区域收集奖励 | 功能增强 | P1 | new | pokemon-service、location-service、reward-service、user-service、gateway、game-client、database/migrations | 2026-06-18 16:00 |
|| REQ-00261 | 游戏内实时通知中心与消息推送系统 | 前端体验 | P1 | new | gateway、user-service、social-service、reward-service、game-client、backend/shared | 2026-06-18 17:00 |
|| REQ-00262 | 实时对战 WebSocket 连接系统 | 功能增强 | P1 | new | gym-service、social-service、gateway、game-client、infrastructure/k8s | 2026-06-18 18:00 |
|| REQ-00263 | 游戏节奏控制与慢速模式系统 | 无障碍(a11y) | P2 | new | game-client、frontend/game-client/src/accessibility、catch-service、gym-service、gateway | 2026-06-18 19:00 |
