# mineGo 未完成需求清单

> 生成时间：2026-09-24（由评审脚本从 `docs/requirements/REQ-*.md` 的状态字段汇总）  
> 口径：状态不是 `done` 的需求即视为未完成（`partial` = 部分验收项已完成，见需求文档末尾"实现记录"）；同一编号有多个文件时逐个列出并标注"重号"。  
> 注意：状态为 `done` 的需求**不等于可用**，抽样核验结果见 [项目评审报告](../review/PROJECT-REVIEW-20260924.md#3-done-需求真实性核验)。

## 汇总

| 优先级 | 未完成数 |
|---|---|
| P0 | 6 |
| P1 | 408 |
| P2 | 30 |
| **合计** | **444** |

### 按类别

| 类别 | 数量 |
|---|---|
| 功能增强 | 69 |
| 性能优化 | 49 |
| 国际化/本地化 | 27 |
| 安全加固 | 26 |
| 可观测性/监控 | 26 |
| 数据库/数据治理 | 26 |
| 运维/CICD | 25 |
| 合规/隐私 | 23 |
| 成本/资源优化 | 21 |
| 无障碍(a11y) | 21 |
| 前端体验 | 20 |
| 测试覆盖 | 20 |
| 技术债/重构 | 17 |
| API 设计规范 | 17 |
| 反作弊 | 14 |
| 可观测性 | 12 |
| 可扩展性/解耦 | 11 |
| 容灾/高可用 | 6 |
| 文档/开发者体验 | 5 |
| 运营/数据分析 | 2 |
| Data Governance | 1 |
| 数据治理/分析 | 1 |
| 稳定性/高可用 | 1 |
| 前端体验/运维 | 1 |
| 安全加固/反作弊 | 1 |
| 性能优化/运维 | 1 |
| 合规/运维 | 1 |

## P0 需求处置（本轮）

| 编号 | 标题 | 涉及服务 | 状态 / 本轮处置 |
|---|---|---|---|
| [REQ-00040](./REQ-00040-redis-cache-layer.md) (重号) | 实现 Redis 分布式缓存层 | api-gateway, core-service | ✅ 已完成（2026-09-24）：网关读缓存、写后失效、故障降级、命中率指标 |
| [REQ-00041](./REQ-00041-game-client-memory-scanning-protection.md) (重号) | Game Client Dynamic Memory Scanning and Protection System | game-client | ⏸️ 延后：纯客户端内存防护，需原生客户端，服务端无法落地 |
| [REQ-00042](./REQ-00042-distributed-tracing-log-aggregation.md) (重号) | 分布式追踪与日志聚合平台集成 | gateway, user-service, catch-service, pokemon-serv | 🟡 部分完成：trace_id 全链路贯通；Jaeger/Loki/告警未部署（需容器环境） |
| [REQ-00044](./REQ-00044-implement-gdpr-data-compliance.md) (重号) | 实现 GDPR 兼容的数据删除与导出接口 | user-service, data-service | 🟡 部分完成：导出/删除 API + 冷却期自动清理；前端 UI 未做 |
| [REQ-00558](./REQ-00558-team-realtime-collaboration-voice-chat.md) | 游戏客户端团队实时协作与语音通信系统 | game-client, social-service, gym-service, WebSocke | ⏸️ 延后：实时语音需 WebRTC/TURN 基础设施，超出本轮范围 |
| [REQ-00565](./REQ-00565-database-sensitive-field-encryption-system.md) | 数据库敏感字段透明加密系统 | backend/shared/crypto、user-service、payment-service | 🟡 部分完成：手机号加密+盲索引+轮换；其他字段、Vault 未做 |
| [REQ-00586](./REQ-00586-gps-location-spoofing-detection-system.md) (重号) | GPS 位置欺骗检测与虚拟定位防护系统 | game-client、gateway、location-service、backend/secur | 🟡 部分完成：服务端检测/降级/管理接口；客户端检测、地形、申诉未做 |
| [REQ-00592](./REQ-00592-production-deployment-health-rollback.md) | 生产环境部署健康检查与自动回滚系统 | k8s-operator, cicd-pipeline, monitoring | ✅ 已完成（2026-09-24）：PM2 部署健康检查 + 自动回滚（已实测） |

## P1 未完成（408 条，本轮不实现，进入待办池）

<details><summary>功能增强（67）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00048](./REQ-00048-pokemon-friend-system-social-interaction.md) | 精灵好友系统与社交互动增强 | social-service、user-service、gateway、game | 2026-06-09 10:00 |
| [REQ-00058](./REQ-00058-guild-system-and-team-social-features.md) | 公会系统与团队社交功能 | social-service、user-service、reward-servi | 2026-06-09 19:00 |
| [REQ-00059](./REQ-00059-beginner-tutorial-and-guidance-system.md) | 新手引导与教程系统 | user-service、reward-service、gateway、game | 2026-06-09 20:00 |
| [REQ-00069](./REQ-00069-pokemon-spawn-management-dynamic-refresh-control.md) | 精灵资源管理系统与动态刷新控制 | location-service、catch-service、backend/s | 2026-06-09 23:30 |
| [REQ-00076](./REQ-00076-pokemon-achievement-and-milestone-reward-system.md) | 精灵成就系统与里程碑奖励 | pokemon-service、reward-service、user-serv | 2026-06-10 02:15 |
| [REQ-00079](./REQ-00079-pokemon-friendship-and-affinity-system.md) | 精灵好感度系统与亲密度进化机制 | pokemon-service、user-service、catch-servi | 2026-06-10 11:00 |
| [REQ-00091](./REQ-00091-pokemon-equipment-system-and-stat-bonus-mechanism.md) | 精灵装备系统与属性加成机制 | pokemon-service、user-service、reward-serv | 2026-06-10 14:00 |
| [REQ-00106](./REQ-00106-player-title-system-and-personalization.md) | 玩家称号系统与个性化展示 | user-service、pokemon-service、social-serv | 2026-06-11 05:30 |
| [REQ-00112](./REQ-00112-pokemon-skill-cooldown-and-energy-system.md) | 精灵技能冷却与能量系统 | pokemon-service、gym-service、gateway、game | 2026-06-11 12:34 |
| [REQ-00125](./REQ-00125-pokemon-cosmetic-customization-system.md) | 精灵外观定制系统 | pokemon-service、user-service、reward-serv | 2026-06-11 19:30 |
| [REQ-00143](./REQ-00143-pokemon-skill-combo-system.md) | 精灵自定义技能组合与连招系统 | pokemon-service、gym-service、social-servi | 2026-06-12 05:00 |
| [REQ-00150](./REQ-00150-bag-capacity-upgrade-system.md) | 背包容量扩展与购买系统 | pokemon-service、user-service、payment-ser | 2026-06-12 09:00 |
| [REQ-00151](./REQ-00151-pokemon-bond-skill-unlock-mechanism.md) | 精灵羁绊技能解锁机制 | pokemon-service、backend/services/pokemon | 2026-06-12 09:00 |
| [REQ-00156](./REQ-00156-pokemon-recovery-station-system.md) | 精灵恢复站系统 | location-service、pokemon-service、user-se | 2026-06-13 09:00 |
| [REQ-00172](./REQ-00172-pokemon-stamina-fatigue-system.md) | 精灵体力系统与疲劳度管理 | pokemon-service、gym-service、catch-servic | 2026-06-13 22:30 |
| [REQ-00183](./REQ-00183-pokemon-item-crafting-and-recipe-system.md) | 精灵道具合成与配方系统 | pokemon-service、reward-service、user-serv | 2026-06-14 04:30 |
| [REQ-00195](./REQ-00195-pokemon-status-resistance-system.md) | 精灵异常状态抗性与免疫计算系统 | pokemon-service、gym-service、catch-servic | 2026-06-14 12:30 |
| [REQ-00197](./REQ-00197-pokemon-talent-and-hidden-attribute-system.md) | 精灵天赋系统与隐藏属性机制 | pokemon-service、catch-service、gym-servic | 2026-06-14 14:00 |
| [REQ-00206](./REQ-00206-pokemon-trade-tax-fee-system.md) | 精灵交易税务与手续费系统 | social-service、pokemon-service、user-serv | 2026-06-14 18:00 |
| [REQ-00216](./REQ-00216-pokemon-experience-dynamic-adjustment-system.md) | 精灵经验值动态调整与智能加速系统 | pokemon-service、user-service、reward-serv | 2026-06-15 00:00 |
| [REQ-00228](./REQ-00228-social-privacy-settings-and-friend-permissions.md) | 游戏社交隐私设置与好友权限管理系统 | social-service、user-service、gateway、game | 2026-06-15 19:00 |
| [REQ-00230](./REQ-00230-pokemon-exp-history-growth-tracking.md) | 精灵经验值获取历史与成长轨迹追踪系统 | pokemon-service、gateway、game-client、data | 2026-06-15 20:00 |
| [REQ-00235](./REQ-00235-pokemon-mutation-and-rare-variants.md) (重号) | 精灵变异系统与稀有形态 | pokemon-service、catch-service、location-s | 2026-06-15 23:00 |
| [REQ-00235](./REQ-00235-user-feedback-and-bug-report-system.md) (重号) | 用户反馈与 Bug 报告收集系统 | user-service、gateway、game-client、admin-d | 2026-06-15 22:30 |
| [REQ-00236](./REQ-00236-pokemon-mutation-and-rare-variants.md) | 精灵变异系统与稀有形态 | pokemon-service、catch-service、location-s | 2026-06-15 23:00 |
| [REQ-00240](./REQ-00240-pokemon-release-and-resource-recycle.md) | 精灵放生与资源回收系统 | pokemon-service、user-service、reward-serv | 2026-06-16 10:00 |
| [REQ-00243](./REQ-00243-pokemon-mood-and-emotion-system.md) | 精灵心情系统与情绪表现 | pokemon-service、user-service、gateway、gam | 2026-06-16 03:30 |
| [REQ-00245](./REQ-00245-pokemon-awakening-system.md) | 精灵觉醒系统与潜能激活 | pokemon-service、user-service、reward-serv | 2026-06-16 05:00 |
| [REQ-00253](./REQ-00253-pokemon-expedition-system.md) (重号) | 精灵远征探险系统 | pokemon-service、location-service、reward- | 2026-06-16 15:00 |
| [REQ-00253](./REQ-00253-精灵远征探险系统.md) (重号) | 精灵远征探险系统 | pokemon-service、location-service、reward- | 2026-06-16 15:00 |
| [REQ-00256](./REQ-00256-pokemon-legend-lore-collection-system.md) | 精灵传说系统与图鉴收集故事 | pokemon-service、user-service、gateway、gam | 2026-06-16 17:30 |
| [REQ-00260](./REQ-00260-exploration-region-collection-system.md) (重号) | 精灵图鉴探索系统与区域收集奖励 | pokemon-service、location-service、reward- | 2026-06-18 16:00 |
| [REQ-00265](./REQ-00265-pokemon-enchantment-and-attribute-enhancement-system.md) | 精灵附魔系统与属性强化 | pokemon-service、reward-service、user-serv | 2026-06-18 20:00 |
| [REQ-00276](./REQ-00276-pokemon-breeding-system.md) | 精灵培育系统与基因遗传机制 | pokemon-service, reward-service, user-se | 2026-06-22 02:00 |
| [REQ-00278](./REQ-00278-pokemon-nature-system.md) | 精灵性格系统与战斗风格塑造 | pokemon-service, battle-service, user-se | 2026-06-22 03:00 |
| [REQ-00283](./REQ-00283-pokemon-talent-and-hidden-attributes-system.md) | 精灵天赋系统与隐藏属性机制 | pokemon-service, battle-service, user-se | 2026-06-22 06:00 |
| [REQ-00288](./REQ-00288-pokemon-skill-combo-system.md) | 精灵技能连击系统与组合技效果 | catch-service, gym-service, pokemon-serv | 2026-06-22 09:00 |
| [REQ-00291](./REQ-00291-pokemon-ecological-food-web-system.md) (重号) | 精灵生态链与食物网系统 | pokemon-service, location-service, catch | 2026-06-22 11:00 |
| [REQ-00299](./REQ-00299-pokemon-skill-cooldown-optimization.md) | 精灵技能冷却时间智能优化系统 | pokemon-service、gym-service、gateway、game | 2026-06-23 15:00 |
| [REQ-00311](./REQ-00311-skill-cooldown-smart-acceleration-and-chain-system.md) | 精灵技能冷却智能加速与连击链系统 | pokemon-service、gym-service、gateway、game | 2026-06-24 05:00 |
| [REQ-00313](./REQ-00313-pokemon-equipment-enhancement-and-evolution-system.md) | 精灵装备强化与进化系统 | pokemon-service、reward-service、user-serv | 2026-06-24 07:00 |
| [REQ-00324](./REQ-00324-pokemon-move-combo-recommendation-system.md) | 精灵技能组合推荐系统 | pokemon-service、user-service、gateway、gam | 2026-06-25 01:10 |
| [REQ-00326](./REQ-00326-pokemon-friend-interaction-system.md) | 精灵好友互动系统 | pokemon-service、social-service、user-serv | 2026-06-25 02:05 |
| [REQ-00327](./REQ-00327-player-profile-stats-dashboard.md) (重号) | 玩家个人资料与数据统计展示系统 | user-service、pokemon-service、social-serv | 2026-06-27 00:42 |
| [REQ-00342](./REQ-00342-pokemon-rental-market-system.md) | 精灵租赁市场与短期使用系统 | pokemon-service、social-service、user-serv | 2026-06-26 11:00 |
| [REQ-00355](./REQ-00355-pokemon-evolution-path-visualization-system.md) | 精灵进化路径可视化系统 | pokemon-service、gateway、game-client、data | 2026-06-29 04:00 |
| [REQ-00357](./REQ-00357-pokemon-battle-ai-strategy-assistant.md) | 精灵团队战斗AI策略助手系统 | gym-service、pokemon-service、user-service | 2026-06-29 07:00 |
| [REQ-00359](./REQ-00359-pokemon-collection-room-decoration-system.md) | 精灵收藏室与个性化装饰系统 | pokemon-service、user-service、reward-serv | 2026-06-29 08:00 |
| [REQ-00361](./REQ-00361-pokemon-inheritance-and-legacy-system.md) (重号) | 精灵传承系统与属性遗产机制 | pokemon-service、user-service、reward-serv | 2026-06-29 09:15 |
| [REQ-00364](./REQ-00364-pokemon-skill-chain-combo-system.md) | 精灵技能连击系统与组合技效果 | pokemon-service、gym-service、social-servi | 2026-06-29 13:00 |
| [REQ-00365](./REQ-00365-battle-ai-strategy-assistant.md) | 精灵团队战斗AI策略助手系统 | gym-service、pokemon-service、user-service | 2026-06-29 14:00 |
| [REQ-00369](./REQ-00369-pokemon-catch-combo-reward-system.md) | 精灵捕捉连击奖励系统 | catch-service、reward-service、user-servic | 2026-06-29 16:00 |
| [REQ-00370](./REQ-00370-pokemon-training-camp-system.md) (重号) | 精灵训练营系统 | pokemon-service、user-service、reward-serv | 2026-06-29 17:30 |
| [REQ-00377](./REQ-00377-pokemon-data-visibility-control-system.md) | 精灵数据可见性控制与隐私分级系统 | pokemon-service、social-service、user-serv | 2026-06-30 00:00 |
| [REQ-00379](./REQ-00379-battle-replay-highlight-sharing-system.md) | 精灵战斗回放与精彩时刻分享系统 | gym-service、social-service、user-service、 | 2026-06-30 04:00 |
| [REQ-00387](./REQ-00387-player-profile-card-system.md) | 玩家资料卡与档案展示系统 | user-service、social-service、pokemon-serv | 2026-06-30 12:00 |
| [REQ-00388](./REQ-00388-friend-interaction-enhancement-system.md) | 玩家好友互动增强系统 | social-service、user-service、pokemon-serv | 2026-06-30 13:00 |
| [REQ-00390](./REQ-00390-pokemon-merge-evolution-system.md) | 精灵合并进化系统 | pokemon-service、user-service、reward-serv | 2026-06-30 17:00 |
| [REQ-00396](./REQ-00396-pokemon-ecosystem-food-web-system.md) | 精灵生态链与食物网系统 | pokemon-service、location-service、catch-s | 2026-06-30 19:20 |
| [REQ-00403](./REQ-00403-collection-room-system.md) | 精灵收藏室与个性化展示系统 | pokemon-service、user-service、social-serv | 2026-07-01 02:00 |
| [REQ-00408](./REQ-00408-pokemon-talent-system-and-hidden-attributes.md) | 精灵天赋系统与隐藏属性解锁机制 | pokemon-service、catch-service、gym-servic | 2026-07-01 11:00 |
| [REQ-00419](./REQ-00419-spirit-habitat-ecosystem-system.md) | 精灵栖息地系统与生态环境影响机制 | game-core、catch-service、location-service | 2026-07-01 21:00 |
| [REQ-00425](./REQ-00425-in-game-notification-and-smart-push-system.md) | 游戏内通知与智能消息推送系统 | gateway、notification-service（新建）、user-se | 2026-07-02 23:00 |
| [REQ-00469](./REQ-00469-game-battle-replay-sharing-system.md) | 游戏实时对战回放录制与分享系统 | battle-service, media-service, social-se | 2026-07-07 03:00 |
| [REQ-00487](./REQ-00487-pokemon-competitive-league-system.md) | 精灵竞技联赛系统 | pokemon-service、social-service、reward-se | 2026-07-07 15:00 |
| [REQ-00531](./REQ-00531-dynamic-config-ab-testing-platform.md) | 游戏内动态配置与 A/B 测试实验管理平台 | gateway, backend/config, admin-dashboard | 2026-07-11 10:00 |
| [REQ-00612](./REQ-00612-pokemon-training-and-specialization-system.md) (重号) | 精灵训练特训系统与专项能力提升机制 | pokemon-service、gateway、game-client、back | 2026-07-20 18:00 |

</details>

<details><summary>性能优化（49）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00164](./REQ-00164-pokemon-image-lazy-loading-and-progressive-loading.md) | 精灵详情页图片懒加载与渐进式加载系统 | game-client、frontend/game-client/src/com | 2026-06-13 18:05 |
| [REQ-00165](./REQ-00165-realtime-competitive-leaderboard-optimization.md) | 实时竞技排行榜优化与热度预测系统 | social-service、user-service、gym-service、 | 2026-06-13 18:15 |
| [REQ-00174](./REQ-00174-database-materialized-views-query-optimization.md) | 数据库物化视图与复杂查询优化系统 | pokemon-service、social-service、gym-servi | 2026-06-13 23:05 |
| [REQ-00182](./REQ-00182-client-side-pokemon-data-prefetch-and-cache-system.md) | 客户端精灵数据预取与智能缓存系统 | game-client、gateway、pokemon-service、back | 2026-06-14 04:00 |
| [REQ-00192](./REQ-00192-pokemon-battle-damage-precompute-and-cache-system.md) | 精灵战斗伤害预计算与结果缓存系统 | gym-service、pokemon-service、backend/shar | 2026-06-14 10:35 |
| [REQ-00217](./REQ-00217-database-query-deduplication-middleware.md) | 数据库查询请求合并与去重中间件 | backend/shared/QueryDeduplication.js、gat | 2026-06-15 00:05 |
| [REQ-00227](./REQ-00227-pokemon-precompile-cache-incremental-sync.md) | 精灵数据预编译缓存与增量同步系统 | pokemon-service、gateway、backend/shared/P | 2026-06-15 18:05 |
| [REQ-00232](./REQ-00232-database-connection-health-monitoring-system.md) | 数据库连接池健康检测与自动恢复系统 | backend/shared、所有微服务、PostgreSQL、infrastr | 2026-06-15 21:00 |
| [REQ-00251](./REQ-00251-api-response-serialization-optimization.md) | API 响应序列化优化与 JSON 压缩系统 | gateway、所有微服务、backend/shared/JsonOptimiz | 2026-06-16 08:00 |
| [REQ-00254](./REQ-00254-database-query-plan-cache-optimizer.md) | 数据库查询执行计划缓存与智能优化器系统 | postgresql、backend/shared、所有微服务、database | 2026-06-16 15:05 |
| [REQ-00290](./REQ-00290-websocket-connection-pool-message-batch-optimization.md) | WebSocket 连接池与消息批处理性能优化 | gym-service、social-service、backend/share | 2026-06-22 10:00 |
| [REQ-00301](./REQ-00301-full-chain-load-testing-and-performance-benchmark-system.md) | 全链路压测系统与生产环境性能基准 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-23 16:00 |
| [REQ-00320](./REQ-00320-game-client-rendering-optimization.md) | 游戏客户端渲染性能优化与帧率稳定系统 | game-client、frontend/game-client/src/ren | 2026-06-24 12:00 |
| [REQ-00325](./REQ-00325-battle-animation-frame-rate-optimization-system.md) | 战斗动画帧率优化与流畅度提升系统 | game-client、gym-service、catch-service、ba | 2026-06-25 02:00 |
| [REQ-00340](./REQ-00340-pokemon-data-precompiled-cache-and-incremental-sync.md) | 精灵数据预编译缓存与增量同步系统 | pokemon-service、gateway、backend/shared、g | 2026-06-26 11:00 |
| [REQ-00350](./REQ-00350-pokemon-batch-query-and-data-aggregation-optimization.md) | 精灵详情批量查询与数据聚合优化系统 | pokemon-service、gateway、backend/shared、R | 2026-06-27 06:00 |
| [REQ-00362](./REQ-00362-pokemon-skill-damage-precompute-cache-system.md) (重号) | 精灵技能伤害预计算与智能缓存系统 | gym-service、pokemon-service、backend/shar | 2026-06-29 11:00 |
| [REQ-00383](./REQ-00383-catch-result-batch-persistence-optimization.md) | 精灵捕捉结果批处理与异步持久化优化系统 | catch-service、backend/shared、Redis、Kafka | 2026-06-30 09:00 |
| [REQ-00417](./REQ-00417-smart-session-timeout-management.md) | 玩家会话超时智能管理与渐进式断开系统 | gateway、auth-service、game-client、admin-d | 2026-07-01 19:00 |
| [REQ-00421](./REQ-00421-player-login-performance-optimization.md) | 玩家登录性能优化与快速恢复系统 | gateway、auth-service、player-service、game | 2026-07-02 02:00 |
| [REQ-00422](./REQ-00422-sprite-precompiled-cache-system.md) | 精灵数据预编译缓存系统 | game-core、catch-service、battle-service、s | 2026-07-02 03:00 |
| [REQ-00489](./REQ-00489-game-data-local-persistence-and-sync-manager.md) | 游戏内数据本地持久化与状态同步管理器 | game-client/storage/network-manager | 2026-07-08 10:00 |
| [REQ-00498](./REQ-00498-pokemon-search-and-sort-query-optimization.md) | 精灵搜索与排序查询性能优化系统 | pokemon-service、backend/shared、game-clie | 2026-07-08 07:00 |
| [REQ-00502](./REQ-00502-performance-analysis-framework.md) | 性能分析与深度优化框架设计 | backend/shared/perf, gateway/src/middlew | 2026-07-08 11:00 |
| [REQ-00523](./REQ-00523-database-query-result-cache-invalidation-system.md) | 数据库查询结果缓存失效智能同步系统 | backend/shared/cache, database/cdc, gate | 2026-07-09 14:00 |
| [REQ-00526](./REQ-00526-api-streaming-compression.md) | 实现 API 响应数据流式压缩与流处理系统 | gateway, backend/shared, game-client | 2026-07-09 15:00 |
| [REQ-00537](./REQ-00537-database-performance-tuning-advisor.md) (重号) | 数据库性能查询调优自动化建议系统 | backend/shared/database, infrastructure/ | 2026-07-11 16:00 |
| [REQ-00538](./REQ-00538-game-client-high-performance-cache-sync-and-consistency-check-system.md) (重号) | 游戏客户端高性能缓存同步与一致性检查系统 | game-client, gateway, backend/shared/cac | 2026-07-11 17:00 |
| [REQ-00539](./REQ-00539-database-slow-query-auto-optimization-and-index-recommendation-system.md) | 数据库慢查询自动调优建议与索引推荐系统 | backend/shared/database, infrastructure/ | 2026-07-11 17:00 |
| [REQ-00542](./REQ-00542-api-gateway-request-response-transformer-pipeline.md) | API Gateway 请求响应转换器管道系统 | gateway、backend/shared/transformPipeline | 2026-07-11 13:00 |
| [REQ-00544](./REQ-00544-performance-auto-diagnosis-engine.md) (重号) | 游戏性能数据分析与自动诊断引擎 | backend-analysis, performance-monitor | 2026-07-13 10:00 |
| [REQ-00545](./REQ-00545-api-performance-sampling-intelligent-analysis-and-auto-tuning-recommendation-system.md) | API 性能采样数据智能分析与自动调优建议系统 | backend/shared/performanceSamplingAnalys | 2026-07-12 17:00 |
| [REQ-00552](./REQ-00552-database-query-plan-cache-optimizer.md) (重号) | 数据库执行计划智能缓存与优化系统 | database-service, backend/shared, infras | 2026-07-15 05:00 |
| [REQ-00552](./REQ-00552-websocket-connection-pool-adaptive-scaling-and-resource-optimization.md) (重号) | WebSocket 连接池自适应伸缩与资源优化系统 | backend/shared/websocket、gateway、infrast | 2026-07-16 15:00 |
| [REQ-00554](./REQ-00554-api-content-negotiation-and-smart-media-conversion.md) | API响应协议内容协商与媒体类型智能转换 | api-gateway, backend/shared, game-client | 2026-07-15 08:00 |
| [REQ-00557](./REQ-00557-game-asset-delta-update.md) | 游戏环境资源包差异化增量更新系统 | asset-service, game-client, cdn-gateway | 2026-07-15 11:00 |
| [REQ-00559](./REQ-00559-database-connection-pool-intelligent-preheat-and-adaptive-management.md) | 数据库连接池智能预热与自适应管理系统 | backend/shared/db, 所有微服务, infrastructure | 2026-07-15 09:00 |
| [REQ-00574](./REQ-00574-database-connection-pool-dynamic-scaling.md) | 实现数据库连接池动态伸缩与自适应调度 | core-service, database-manager | 2026-07-16 13:00 |
| [REQ-00575](./REQ-00575-postgresql-prepared-statement-optimization.md) | PostgreSQL 预编译语句优化 | shared/db.js, location-service, catch-se | 2026-07-16 16:00 |
| [REQ-00577](./REQ-00577-nodejs-heap-memory-gc-optimization.md) | Node.js 堆内存智能管理与 GC 优化系统 | backend/shared/memoryManager, gateway, c | 2026-07-16 17:00 |
| [REQ-00580](./REQ-00580-websocket-message-batch-queue-memory-optimization.md) | WebSocket 消息批处理队列内存优化 | backend/shared/websocket/MessageBatchQue | 2026-07-16 19:00 |
| [REQ-00581](./REQ-00581-database-pool-intelligent-adaptive-management.md) | 数据库连接池智能预热与动态自适应管理系统 | backend-gateway, database-manager | 2026-07-16 12:00 |
| [REQ-00585](./REQ-00585-database-deadlock-monitoring.md) | 数据库死锁检测与自动化记录分析系统 | database-proxy, backend-shared-db | 2026-07-16 23:00 |
| [REQ-00586](./REQ-00586-nodejs-memory-leak-diagnosis-toolchain.md) (重号) | Node.js 内存泄露自动诊断工具链 | backend-gateway, backend-shared | 2026-07-17 01:00 |
| [REQ-00595](./REQ-00595-game-assets-preload-cache-invalidation.md) | 游戏资源预加载与高效缓存失效策略 | game-client, cdn-gateway, resource-serve | 2026-07-19 10:00 |
| [REQ-00596](./REQ-00596-game-resource-smart-priority-loading.md) | 游戏资源动态加载智能优先级调度系统 | game-client, resource-manager, cdn-gatew | 2026-07-19 12:00 |
| [REQ-00601](./REQ-00601-high-concurrency-api-cache-update-optimization.md) (重号) | 高并发下接口响应式缓存更新优化 | api-gateway, cache-service | 2026-07-20 10:00 |
| [REQ-00605](./REQ-00605-resource-diff-incremental-update.md) | 游戏资源包差分更新与增量同步系统 | game-client, resource-manager, cdn-gatew | 2026-07-20 14:00 |
| [REQ-00623](./REQ-00623-database-connection-pool-intelligent-preheat-and-adaptive-management.md) | 数据库连接池智能预热与动态自适应管理系统 | backend/jobs/pool-manager, backend/share | 2026-07-21 09:00 |

</details>

<details><summary>数据库/数据治理（26）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00096](./REQ-00096-database-transaction-isolation-and-deadlock-detection.md) (重号) | 数据库事务隔离级别控制与死锁检测机制 | backend/shared/db.js、catch-service、gym-s | 2026-06-11 00:20 |
| [REQ-00115](./REQ-00115-database-connection-pool-adaptive-scheduling.md) | 数据库连接池自适应调度与负载均衡系统 | backend/shared/db.js、所有微服务、PostgreSQL、in | 2026-06-11 15:50 |
| [REQ-00129](./REQ-00129-pokemon-data-backup-and-restore-system.md) | 精灵数据备份与恢复系统 | pokemon-service、user-service、database、ba | 2026-06-11 21:30 |
| [REQ-00186](./REQ-00186-data-lineage-and-change-tracking-system.md) (重号) | 数据血缘追踪与变更历史溯源系统 | backend/shared/dataLineage.js、所有微服务、data | 2026-06-14 07:00 |
| [REQ-00186](./REQ-00186-pokemon-historical-data-archiving-system.md) (重号) | 精灵历史数据归档与冷热分离系统 | pokemon-service、user-service、database、ba | 2026-06-14 07:00 |
| [REQ-00187](./REQ-00187-data-lineage-and-change-tracking-system.md) | 数据血缘追踪与变更历史溯源系统 | backend/shared/dataLineage.js、所有微服务、data | 2026-06-14 07:03 |
| [REQ-00199](./REQ-00199-data-lineage-tracking-and-impact-analysis.md) | 数据血缘追踪与影响分析系统 | gateway、所有微服务、backend/shared、database、in | 2026-06-14 15:00 |
| [REQ-00223](./REQ-00223-database-schema-change-impact-analysis.md) | 数据库表结构变更影响分析与自动化迁移验证系统 | backend/shared/SchemaChangeAnalyzer.js、b | 2026-06-15 16:00 |
| [REQ-00259](./REQ-00259-database-read-write-split-and-replication-monitoring.md) | 数据库读写分离与主从同步监控系统 | backend/shared/db.js、backend/shared/Read | 2026-06-18 15:00 |
| [REQ-00267](./REQ-00267-data-lineage-visualization-impact-analysis.md) | 数据血缘可视化与影响分析系统 | gateway、所有微服务、backend/shared、admin-dashb | 2026-06-18 21:00 |
| [REQ-00312](./REQ-00312-database-capacity-planning-and-intelligent-alerting-system.md) | 数据库容量规划与智能预警系统 | backend/shared、所有微服务、PostgreSQL、infrastr | 2026-06-24 06:00 |
| [REQ-00318](./REQ-00318-database-backup-verification-system.md) | 数据库备份自动验证与灾难恢复演练系统 | database/migrations、backend/jobs、backend | 2026-06-24 11:00 |
| [REQ-00323](./REQ-00323-database-partitioning-strategy.md) | 数据库分区表与大数据量表分区策略 | database/migrations、pokemon-service、user | 2026-06-25 01:00 |
| [REQ-00331](./REQ-00331-database-index-intelligent-analysis-optimization-system.md) | 数据库索引智能分析与自动优化系统 | backend/shared、所有微服务、database/migrations | 2026-06-26 02:00 |
| [REQ-00334](./REQ-00334-database-read-write-split-replication-monitoring.md) | 数据库读写分离与主从同步监控系统 | 所有微服务、backend/shared、PostgreSQL、infrastr | 2026-06-26 07:00 |
| [REQ-00346](./REQ-00346-data-lineage-tracking-and-impact-analysis-system.md) (重号) | 数据血缘追踪与影响分析系统 | gateway、所有微服务、backend/shared、admin-dashb | 2026-06-27 05:00 |
| [REQ-00373](./REQ-00373-database-schema-conflict-detection-and-multi-env-consistency-system.md) (重号) | 数据库Schema版本冲突检测与多环境一致性验证系统 | database/migrations、backend/shared、所有微服务 | 2026-06-29 21:00 |
| [REQ-00420](./REQ-00420-database-backup-automated-verification-and-rehearsal-system.md) | 数据库备份自动验证与演练系统 | database、backup-service、monitoring、admin | 2026-07-02 01:00 |
| [REQ-00428](./REQ-00428-database-read-write-split-replication-monitoring.md) | 数据库读写分离监控与延迟告警系统 | database-service, monitoring-service | 2026-07-03 07:00 |
| [REQ-00430](./REQ-00430-database-slow-query-analysis-auto-optimization.md) | 游戏数据库查询慢查询分析与自动调优系统 | database-service、monitoring-service、shar | 2026-07-03 09:00 |
| [REQ-00432](./REQ-00432-database-schema-change-impact-analysis.md) | 数据库模式变更影响分析系统 | database-service、cicd-pipeline、shared/an | 2026-07-03 11:00 |
| [REQ-00464](./REQ-00464-implement-dynamic-database-index-maintenance-system.md) | 实现动态数据库索引维护系统 | database/maintenance | 2026-07-06 10:00 |
| [REQ-00471](./REQ-00471-database-tiered-storage-system.md) | 数据库热数据自动分层存储系统 | database-service/data-infrastructure | 2026-07-07 10:00 |
| [REQ-00478](./REQ-00478-game-data-archiving-and-lifecycle-management-system.md) | 游戏数据归档与生命周期管理系统 | database-service、user-service、catch-serv | 2026-07-07 09:00 |
| [REQ-00548](./REQ-00548-database-query-performance-baseline-and-drift-detection.md) (重号) | 数据库查询性能基线与漂移检测系统 | database, backend/shared, infrastructure | 2026-07-14 07:51 |
| [REQ-00601](./REQ-00601-database-schema-change-impact-analysis-and-risk-assessment-system.md) (重号) | 数据库 Schema 变更智能影响分析与风险评估系统 | database/migrate.js、backend/shared/schem | 2026-07-20 02:00 |

</details>

<details><summary>可观测性/监控（24）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00113](./REQ-00113-realtime-business-event-stream-monitoring.md) | 实时业务事件流监控与分析系统 | gateway、所有微服务、backend/shared/eventStream | 2026-06-11 13:05 |
| [REQ-00130](./REQ-00130-realtime-business-event-stream-monitoring.md) | 实时业务事件流监控与分析系统 | gateway、所有微服务、backend/shared、Kafka、infra | 2026-06-11 22:00 |
| [REQ-00158](./REQ-00158-business-event-anomaly-detection.md) | 业务事件异常检测与智能告警系统 | gateway、所有微服务、backend/shared、Kafka、infra | 2026-06-13 10:00 |
| [REQ-00166](./REQ-00166-realtime-event-stream-monitoring-system.md) (重号) | 实时业务事件流监控与分析系统 | gateway、所有微服务、backend/shared、Kafka、infra | 2026-06-13 19:00 |
| [REQ-00168](./REQ-00168-distributed-tracing-link-visualization.md) | 分布式追踪与请求链路可视化系统 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-13 21:00 |
| [REQ-00179](./REQ-00179-distributed-tracing-request-chain-visualization.md) | 分布式追踪与请求链路可视化系统 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-14 03:00 |
| [REQ-00185](./REQ-00185-slo-budget-burn-rate-prediction-system.md) | SLO 预算燃尽与合规性预测系统 | gateway、所有微服务、backend/shared/sloBudgetTr | 2026-06-14 06:00 |
| [REQ-00191](./REQ-00191-realtime-business-event-stream-monitoring.md) | 实时业务事件流监控与分析系统 | gateway、所有微服务、backend/shared、Kafka、infra | 2026-06-14 11:00 |
| [REQ-00203](./REQ-00203-distributed-tracing-opentelemetry-integration.md) | 分布式追踪与 OpenTelemetry 集成系统 | gateway、所有微服务、backend/shared/tracing、inf | 2026-06-14 17:00 |
| [REQ-00225](./REQ-00225-monitoring-data-downsampling-long-term-storage.md) | 监控数据降采样与长期存储系统 | infrastructure/k8s/monitoring、backend/sh | 2026-06-15 17:05 |
| [REQ-00239](./REQ-00239-slo-error-budget-alerting-system.md) | SLO 错误预算燃尽告警与服务健康评分系统 | gateway、所有微服务、backend/shared/sloBudgetTr | 2026-06-16 01:00 |
| [REQ-00275](./REQ-00275-alert-intelligent-correlation-and-root-cause-analysis-system.md) | 告警智能关联与根因分析系统 | backend/shared/alertCorrelator.js、infras | 2026-06-22 01:00 |
| [REQ-00321](./REQ-00321-api-circuit-breaker-dashboard-visualization.md) | API 熔断器仪表板可视化与实时状态监控 | gateway、所有微服务、backend/shared、admin-dashb | 2026-06-24 13:30 |
| [REQ-00332](./REQ-00332-api-response-time-anomaly-detection-and-intelligent-alerting-system.md) | API 响应时间异常检测与智能告警系统 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-26 07:00 |
| [REQ-00347](./REQ-00347-service-call-anomaly-prediction-dependency-health-propagation.md) | 服务调用异常预测与依赖健康传播追踪系统 | gateway、所有微服务、backend/shared/ServiceCall | 2026-06-27 04:00 |
| [REQ-00358](./REQ-00358-realtime-service-health-aggregation-dashboard.md) | 实时服务健康聚合仪表板与异常预测系统 | gateway、所有微服务、backend/shared/ServiceHeal | 2026-06-29 07:12 |
| [REQ-00371](./REQ-00371-realtime-log-anomaly-detection-and-early-warning-system.md) | 实时日志异常检测与预警系统 | gateway、所有微服务、backend/shared/LogAnomalyD | 2026-06-29 19:00 |
| [REQ-00472](./REQ-00472-distributed-tracing-performance-anomaly-detection-system.md) | 分布式链路追踪性能异常检测系统 | gateway-service、shared/tracing、monitorin | 2026-07-07 05:00 |
| [REQ-00480](./REQ-00480-log-anomaly-detection-and-alert-aggregation-system.md) | 日志异常检测与智能告警聚合系统 | gateway/shared/logger、backend/shared/ale | 2026-07-07 10:00 |
| [REQ-00518](./REQ-00518-monitoring-data-intelligent-summary-and-automated-reporting-system.md) (重号) | 监控数据智能摘要与自动化报告系统 | backend/shared/monitorReport、gateway/src | 2026-07-09 08:46 |
| [REQ-00528](./REQ-00528-distributed-tracing-intelligent-sampling-performance-bottleneck-diagnostics.md) | 分布式追踪智能采样与性能瓶颈自动诊断系统 | gateway、backend/shared/tracing、backend/s | 2026-07-10 07:00 |
| [REQ-00529](./REQ-00529-api-request-chain-tracing-and-full-chain-latency-analysis-system.md) (重号) | API 请求链路追踪与全链路延迟分析系统 | gateway、所有后端服务、backend/shared/tracing、ba | 2026-07-10 08:00 |
| [REQ-00533](./REQ-00533-game-server-error-log-tracking-and-alert-aggregation-system.md) | 游戏服务端异常日志追踪与告警聚合系统 | backend/shared/logger, infrastructure/mo | 2026-07-11 12:00 |
| [REQ-00617](./REQ-00617-user-experience-realtime-monitoring-rum-system.md) | 用户体验实时监控与性能追踪系统（RUM/APM） | game-client、gateway、backend/shared/monit | 2026-07-20 19:00 |

</details>

<details><summary>安全加固（24）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00175](./REQ-00175-realtime-trade-anomaly-detection.md) | 实时交易异常检测与风控系统 | social-service、pokemon-service、user-serv | 2026-06-14 01:00 |
| [REQ-00200](./REQ-00200-sensitive-operation-risk-verification-system.md) | 敏感操作二次验证与风险分级验证系统 | gateway、user-service、payment-service、soc | 2026-06-14 15:05 |
| [REQ-00214](./REQ-00214-sensitive-operation-verification.md) | 敏感操作二次验证与风险分级验证系统 | gateway、user-service、payment-service、soc | 2026-06-14 23:00 |
| [REQ-00215](./REQ-00215-api-request-signature-and-replay-attack-prevention.md) | API 请求签名验证与重放攻击防护系统 | gateway、所有微服务、backend/shared、game-client | 2026-06-14 23:00 |
| [REQ-00218](./REQ-00218-screenshot-content-safety-audit.md) | 游戏客户端截图内容安全审核系统 | game-client、gateway、user-service、backend | 2026-06-15 01:00 |
| [REQ-00219](./REQ-00219-session-anomaly-detection-auto-protection.md) | 会话异常检测与自动防护系统 | gateway、user-service、backend/shared/sess | 2026-06-15 13:30 |
| [REQ-00221](./REQ-00221-container-image-vulnerability-scanning.md) | 容器镜像安全扫描与漏洞预警系统 | infrastructure/k8s、所有微服务、.github/workflo | 2026-06-15 15:00 |
| [REQ-00234](./REQ-00234-api-rate-limit-intelligent-adaptation.md) | API 请求速率限制智能适配与动态配额系统 | gateway、user-service、backend/shared、Redi | 2026-06-15 22:05 |
| [REQ-00270](./REQ-00270-attack-pattern-detection-system.md) | 攻击模式检测与实时威胁识别系统 | gateway、user-service、catch-service、gym-s | 2026-06-18 22:30 |
| [REQ-00327](./REQ-00327-session-security-hijacking-protection-system.md) (重号) | 会话劫持防护与安全会话管理系统 | gateway、user-service、backend/shared、Redi | 2026-06-25 04:00 |
| [REQ-00328](./REQ-00328-api-key-leakage-detection-system.md) (重号) | API 密钥泄露检测与实时告警系统 | gateway、user-service、admin-dashboard、bac | 2026-06-27 01:00 |
| [REQ-00328](./REQ-00328-websocket-security-message-integrity-system.md) (重号) | WebSocket 通信安全加固与消息完整性验证系统 | gym-service、catch-service、gateway、backen | 2026-06-25 05:00 |
| [REQ-00344](./REQ-00344-anomaly-login-detection-geofence-protection.md) | 玩家账号异常登录检测与地理围栏防护系统 | user-service、gateway、backend/shared、Redi | 2026-06-27 02:00 |
| [REQ-00363](./REQ-00363-api-request-signature-verification-and-anti-replay-attack-system.md) | API 请求签名验证与防重放攻击系统 | gateway、user-service、backend/shared、game | 2026-06-29 12:10 |
| [REQ-00380](./REQ-00380-api-security-baseline-automated-check-system.md) | API 安全配置基线自动化检查系统 | gateway、所有微服务、backend/shared、.github/wor | 2026-06-30 05:00 |
| [REQ-00389](./REQ-00389-api-rate-limit-by-pass-detection-protection-system.md) | API 请求速率限制绕过检测与防护系统 | gateway、user-service、backend/shared/Rate | 2026-06-30 16:00 |
| [REQ-00394](./REQ-00394-api-sensitive-parameter-masking-and-log-security-protection-system.md) | API 敏感参数自动脱敏与日志安全防护系统 | gateway、所有微服务、backend/shared/logger.js、b | 2026-06-30 19:05 |
| [REQ-00399](./REQ-00399-security-event-correlation-and-auto-response-system.md) | 安全事件关联分析与自动化响应系统 | gateway、user-service、所有微服务、backend/share | 2026-06-30 22:10 |
| [REQ-00406](./REQ-00406-player-account-anomaly-login-detection-and-geofencing-system.md) | 玩家账号异常登录检测与地理围栏防护系统 | user-service、gateway、backend/shared、Redi | 2026-07-01 05:00 |
| [REQ-00507](./REQ-00507-password-strength-policy-and-breach-detection-system.md) (重号) | 密码强度策略与泄露检测系统 | user-service/src/routes/sessions.js、user | 2026-07-08 16:00 |
| [REQ-00513](./REQ-00513-automated-security-compliance-scanning-system.md) | 自动化安全合规扫描与配置加固系统 | infrastructure/k8s, backend/security, CI | 2026-07-08 21:00 |
| [REQ-00561](./REQ-00561-sensitive-api-secondary-auth-and-risk-behavior-grading-system.md) | 敏感API二次认证与风险行为分级控制系统 | gateway、user-service、backend/shared/secu | 2026-07-15 10:00 |
| [REQ-00576](./REQ-00576-automated-api-security-stress-test-framework.md) | 自动化 API 安全压力测试框架 | gateway, backend/tests/security | 2026-07-16 15:00 |
| [REQ-00597](./REQ-00597-api-gateway-intelligent-threat-detection-auto-response.md) | API 网关智能威胁检测与自动响应系统 | gateway, user-service, backend/shared/th | 2026-07-19 05:48 |

</details>

<details><summary>合规/隐私（22）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00089](./REQ-00089-data-cross-border-transfer-compliance.md) | 数据跨境传输合规与本地化存储策略 | user-service、gateway、database、backend/sh | 2026-06-10 13:00 |
| [REQ-00107](./REQ-00107-data-lifecycle-management-auto-cleanup.md) | 数据生命周期管理与自动清理策略 | user-service、pokemon-service、social-serv | 2026-06-11 06:00 |
| [REQ-00127](./REQ-00127-user-data-deletion-requests-management.md) | 用户数据删除请求管理系统 | user-service、gateway、所有微服务、database、back | 2026-06-11 20:15 |
| [REQ-00184](./REQ-00184-data-protection-impact-assessment-system.md) | 数据隐私影响评估（DPIA）自动化系统 | user-service、gateway、admin-dashboard、bac | 2026-06-14 05:00 |
| [REQ-00213](./REQ-00213-gdpr-data-subject-request-management-system.md) | GDPR 数据主体权利请求管理系统 | user-service、gateway、admin-dashboard、bac | 2026-06-14 22:00 |
| [REQ-00238](./REQ-00238-biometric-data-protection-system.md) | 用户生物特征数据保护与存储合规系统 | user-service、gateway、game-client、backend | 2026-06-16 01:00 |
| [REQ-00246](./REQ-00246-data-leak-emergency-response-notification-system.md) | 数据泄露应急响应与通知系统 | gateway、user-service、所有微服务、backend/share | 2026-06-16 05:00 |
| [REQ-00303](./REQ-00303-sensitive-operation-audit-log.md) | 敏感操作审计日志与操作追溯系统 | gateway、user-service、payment-service、soc | 2026-06-23 08:00 |
| [REQ-00305](./REQ-00305-gdpr-dsr-automation-system.md) | GDPR 数据主体权利请求自动化管理系统 | user-service、gateway、admin-dashboard、bac | 2026-06-24 01:00 |
| [REQ-00309](./REQ-00309-dpia-automation-system.md) | 数据隐私影响评估（DPIA）自动化系统 | user-service、gateway、admin-dashboard、bac | 2026-06-24 04:00 |
| [REQ-00322](./REQ-00322-cookie-consent-management-and-privacy-preferences-center.md) | Cookie 同意管理与隐私偏好中心 | gateway、user-service、game-client、admin-d | 2026-06-25 00:01 |
| [REQ-00338](./REQ-00338-gdpr-data-subject-rights-automation.md) | GDPR 数据主体权利请求自动化管理系统 | user-service、gateway、admin-dashboard、bac | 2026-06-26 09:00 |
| [REQ-00341](./REQ-00341-privacy-policy-version-management-notification-system.md) | 隐私政策版本管理与变更通知系统 | user-service、gateway、game-client、admin-d | 2026-06-26 10:00 |
| [REQ-00384](./REQ-00384-gdpr-data-subject-rights-request-management-system.md) | GDPR 数据主体权利请求管理系统 | user-service、gateway、admin-dashboard、bac | 2026-06-30 10:00 |
| [REQ-00404](./REQ-00404-secure-device-data-wipe-and-compliance-system.md) | 退役设备数据安全擦除与合规报告系统 | user-service、gateway、admin-dashboard、bac | 2026-07-01 03:00 |
| [REQ-00410](./REQ-00410-data-protection-impact-assessment-automation.md) | 数据隐私影响评估（DPIA）自动化系统 | user-service、gateway、admin-dashboard、bac | 2026-07-01 12:00 |
| [REQ-00477](./REQ-00477-unified-user-consent-management-platform.md) | 统一用户同意管理平台 | gateway、user-service、game-client、databas | 2026-07-07 08:00 |
| [REQ-00522](./REQ-00522-data-retention-policy-transparency-notification-system.md) | 数据保留政策透明化与用户通知系统 | gateway、user-service、backend/shared/data | 2026-07-09 03:00 |
| [REQ-00529](./REQ-00529-跨境数据传输合规性自动检测与审计系统.md) (重号) | 跨境数据传输合规性自动检测与审计系统 | gateway、user-service、backend/shared/cros | 2026-07-11 04:40 |
| [REQ-00562](./REQ-00562-international-compliance-audit-system.md) | 国际化内容合规性审计与隐私合规自动扫描系统 | localization-service, security-service,  | 2026-07-15 15:00 |
| [REQ-00583](./REQ-00583-game-voice-chat-security-audit.md) | 游戏内实时语音聊天安全合规审计系统 | social-service, gateway, voice-chat-serv | 2026-07-16 22:00 |
| [REQ-00621](./REQ-00621-dsar-automation-service.md) | GDPR/CCPA 自动化数据主体请求处理系统 (DSAR) | user-service, data-platform, gateway | 2026-07-21 02:00 |

</details>

<details><summary>国际化/本地化（22）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00101](./REQ-00101-backend-api-error-message-i18n.md) | 后端 API 错误消息国际化系统 | gateway、所有微服务、backend/shared、frontend/ga | 2026-06-11 03:00 |
| [REQ-00137](./REQ-00137-translation-management-and-workflow-system.md) | 游戏内容本地化内容管理与翻译工作流系统 | gateway、user-service、reward-service、back | 2026-06-12 00:35 |
| [REQ-00155](./REQ-00155-openapi-documentation-i18n-support.md) | OpenAPI 文档多语言描述与国际化支持 | gateway、docs/api-spec/openapi、backend/sh | 2026-06-13 08:00 |
| [REQ-00167](./REQ-00167-game-content-localization-database-layer.md) | 游戏内容本地化数据层与动态翻译系统 | pokemon-service、location-service、reward- | 2026-06-13 20:05 |
| [REQ-00173](./REQ-00173-game-tutorial-localization-system.md) | 游戏教程本地化与动态提示系统 | game-client、gateway、user-service、pokemon | 2026-06-13 23:05 |
| [REQ-00188](./REQ-00188-user-language-preference-persistence-sync.md) | 用户语言偏好持久化与跨设备同步系统 | user-service、gateway、game-client、databas | 2026-06-14 08:05 |
| [REQ-00224](./REQ-00224-currency-formatting-and-regional-payment-localization.md) | 国际化货币格式化与区域支付本地化系统 | payment-service、user-service、gateway、gam | 2026-06-15 17:00 |
| [REQ-00229](./REQ-00229-plural-forms-and-gender-grammar-localization.md) | 游戏界面复数形式与性别语法本地化系统 | game-client、frontend/game-client/src/i18 | 2026-06-15 19:05 |
| [REQ-00244](./REQ-00244-rtl-language-layout-auto-adaptation.md) | RTL 语言布局自动适配系统 | game-client、frontend/game-client/src/i18 | 2026-06-16 04:00 |
| [REQ-00268](./REQ-00268-game-content-i18n-database.md) | 游戏内容数据库多语言支持与本地化表结构设计 | pokemon-service、location-service、reward- | 2026-06-18 21:00 |
| [REQ-00335](./REQ-00335-game-distance-unit-localization-system.md) | 游戏距离单位本地化与智能转换系统 | game-client、frontend/game-client/src/uti | 2026-06-26 05:00 |
| [REQ-00345](./REQ-00345-dynamic-localization-and-language-recommendation-system.md) | 游戏内容动态本地化与多语言智能推荐系统 | gateway、user-service、pokemon-service、loc | 2026-06-27 04:00 |
| [REQ-00346](./REQ-00346-game-timezone-smart-conversion-cross-timezone-event-sync.md) (重号) | 游戏时区智能转换与跨时区活动同步系统 | gateway、user-service、reward-service、loca | 2026-06-27 03:00 |
| [REQ-00351](./REQ-00351-game-number-format-localization-system.md) | 游戏数字格式本地化系统 | game-client、gateway、user-service、pokemon | 2026-06-27 06:00 |
| [REQ-00353](./REQ-00353-game-content-translation-management-system.md) | 游戏内容翻译管理与翻译工作流自动化系统 | gateway、pokemon-service、backend/shared/i | 2026-06-29 02:00 |
| [REQ-00370](./REQ-00370-translation-missing-detection-and-intelligent-fallback-system.md) (重号) | 翻译缺失检测与智能回退机制系统 | gateway、backend/shared/i18n、admin-dashbo | 2026-06-29 17:00 |
| [REQ-00411](./REQ-00411-audio-localization-management-system.md) | 游戏语音内容本地化与音频翻译管理系统 | pokemon-service、user-service、reward-serv | 2026-07-01 13:05 |
| [REQ-00473](./REQ-00473-global-timezone-scheduler.md) | 全球化环境下多时区动态调度补偿系统 | scheduler-service/shared/timezone-lib | 2026-07-07 11:00 |
| [REQ-00488](./REQ-00488-game-text-localization-cache-system.md) | 游戏内文本本地化与智能缓存系统 | pokemon-service/game-client/shared/i18n/ | 2026-07-07 16:46 |
| [REQ-00500](./REQ-00500-server-side-number-formatting-localization.md) | 服务端数字格式化本地化与多语言统一系统 | backend/shared/numberFormat.js、所有后端服务、ga | 2026-07-08 09:00 |
| [REQ-00515](./REQ-00515-game-server-plural-rules-engine.md) (重号) | 游戏服务端多语言智能复数与语法规则引擎 | backend/shared/i18n, gateway/middleware | 2026-07-09 01:00 |
| [REQ-00612](./REQ-00612-global-timezone-scheduler.md) (重号) | 全球化业务实时时区调度与跨区协作支持系统 | gateway, user-service, game-event-servic | 2026-07-20 16:00 |

</details>

<details><summary>运维/CICD（22）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00176](./REQ-00176-deployment-pipeline-state-tracking-and-rollback-management.md) | 部署流水线状态跟踪与回滚管理系统 | gateway、所有微服务、.github/workflows、backend/ | 2026-06-14 01:00 |
| [REQ-00190](./REQ-00190-automated-disaster-recovery-drill-system.md) | 自动化灾难恢复演练与验证系统 | infrastructure/k8s、gateway、所有微服务、backend | 2026-06-14 10:00 |
| [REQ-00222](./REQ-00222-cicd-build-cache-and-supply-chain-security.md) | CI/CD 构建缓存优化与依赖供应链安全验证系统 | .github/workflows、backend、frontend、scrip | 2026-06-15 15:00 |
| [REQ-00241](./REQ-00241-sbom-generation-supply-chain-security.md) | 软件物料清单（SBOM）生成与供应链安全验证系统 | .github/workflows、backend/shared、所有微服务、i | 2026-06-16 02:10 |
| [REQ-00258](./REQ-00258-deployment-changelog-auto-generation-system.md) (重号) | 部署变更日志自动生成与发布说明系统 | .github/workflows、backend/shared/Changel | 2026-06-18 14:00 |
| [REQ-00260](./REQ-00260-cicd-pipeline-visualization-dashboard.md) (重号) | CI/CD 管道执行可视化与实时监控仪表板系统 | .github/workflows、admin-dashboard、backen | 2026-06-18 16:00 |
| [REQ-00264](./REQ-00264-cicd-pipeline-history-and-performance-analytics.md) | CI/CD 流水线运行历史与性能分析系统 | .github/workflows、backend/shared/Pipelin | 2026-06-18 19:00 |
| [REQ-00266](./REQ-00266-deployment-window-smart-scheduling-system.md) | 部署窗口智能调度系统 | .github/workflows、backend/shared/Deploym | 2026-06-18 20:00 |
| [REQ-00306](./REQ-00306-database-migration-rollback-system.md) | 数据库迁移回滚自动化与版本控制系统 | database/migrations、所有微服务、backend/shared | 2026-06-24 01:00 |
| [REQ-00314](./REQ-00314-service-graceful-shutdown-and-connection-draining-system.md) | 服务实例优雅停机与连接排空系统 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-24 08:00 |
| [REQ-00409](./REQ-00409-microservice-config-center-hot-reload.md) | 微服务配置中心与动态配置热更新系统 | gateway、所有微服务、backend/shared/configCente | 2026-07-01 11:00 |
| [REQ-00429](./REQ-00429-game-client-resumable-resource-update-system.md) | 游戏客户端断点续传资源更新系统 | game-client、cdn-service、storage-service、 | 2026-07-03 08:00 |
| [REQ-00431](./REQ-00431-config-hot-update.md) | 微服务分布式配置热更新与版本控制系统 | config-service(新建)、gateway、auth-service、 | 2026-07-03 10:00 |
| [REQ-00437](./REQ-00437-deployment-window-smart-scheduling-system.md) | 部署窗口智能调度系统 | ci-cd, orchestration | 2026-07-06 08:00 |
| [REQ-00486](./REQ-00486-cicd-pipeline-realtime-visualization-and-smart-diagnosis.md) | CI/CD流水线实时可视化与智能诊断系统 | admin-dashboard/ci-cd-monitor/github-act | 2026-07-07 14:00 |
| [REQ-00493](./REQ-00493-automated-disaster-recovery-drill-system.md) | 自动化灾难恢复演练系统 | infrastructure/k8s/dr, backend/jobs | 2026-07-08 03:00 |
| [REQ-00510](./REQ-00510-production-deployment-health-verification-and-auto-rollback-system.md) | 生产环境部署后健康检查自动化验证与回滚触发系统 | .github/workflows、infrastructure/health、 | 2026-07-08 19:00 |
| [REQ-00520](./REQ-00520-backend-service-api-compatibility-versioning-system.md) | 后端服务 API 兼容性版本管理与自动化测试系统 | gateway、所有后端服务、backend/shared/apiVersion | 2026-07-09 02:00 |
| [REQ-00563](./REQ-00563-slo-compliance-monitoring-and-alert-system.md) | SLO 合规性监控与违规预警系统 | gateway, infrastructure/monitoring, back | 2026-07-15 11:00 |
| [REQ-00568](./REQ-00568-server-resource-lifecycle-management-system.md) | 游戏服务器资源生命周期自动管理与资源回收系统 | infrastructure-manager, kubernetes-contr | 2026-07-16 11:00 |
| [REQ-00590](./REQ-00590-ci-cd-pipeline-efficiency-analysis-and-bottleneck-detection-system.md) (重号) | CI/CD 流水线执行效率分析与瓶颈定位系统 | .github/workflows、backend/jobs/pipelineA | 2026-07-19 04:00 |
| [REQ-00615](./REQ-00615-automated-disaster-recovery-drill-system.md) | 自动化灾难恢复演练系统 | infrastructure, gateway, monitoring | 2026-07-20 17:00 |

</details>

<details><summary>成本/资源优化（19）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00071](./REQ-00071-k8s-pod-autoscaling-optimization.md) | K8s Pod 资源自动扩缩容优化系统 | infrastructure/k8s、gateway、所有微服务、backend | 2026-06-09 23:30 |
| [REQ-00088](./REQ-00088-redis-connection-pool-management-and-health-monitoring.md) | Redis 连接池管理与健康监控系统 | backend/shared/redis.js、所有微服务、infrastruc | 2026-06-10 12:38 |
| [REQ-00140](./REQ-00140-low-traffic-service-auto-sleep-and-smart-wake-up-system.md) | 低峰期服务自动休眠与智能唤醒系统 | gateway、所有微服务、backend/shared/sleepManage | 2026-06-12 03:00 |
| [REQ-00161](./REQ-00161-low-peak-service-auto-sleep-and-smart-wake.md) | 低峰期服务自动休眠与智能唤醒系统 | gateway、所有微服务、backend/shared/sleepManage | 2026-06-13 10:30 |
| [REQ-00178](./REQ-00178-container-image-lifecycle-management-and-storage-optimization.md) | 容器镜像生命周期管理与存储优化系统 | infrastructure/k8s、.github/workflows、bac | 2026-06-14 02:00 |
| [REQ-00212](./REQ-00212-cloud-resource-utilization-cost-attribution-system.md) | 云资源利用率分析与成本归因系统 | infrastructure/k8s、gateway、所有微服务、backend | 2026-06-14 22:00 |
| [REQ-00248](./REQ-00248-kubernetes-pvc-lifecycle-management-and-auto-scaling.md) | Kubernetes 存储卷生命周期管理与自动扩缩容系统 | infrastructure/k8s、backend/shared/PVCMan | 2026-06-16 06:00 |
| [REQ-00249](./REQ-00249-infrastructure-cost-prediction-and-budget-planning-system.md) | 基础设施成本预测与预算智能规划系统 | backend/shared、infrastructure/k8s、admin- | 2026-06-16 07:00 |
| [REQ-00297](./REQ-00297-cloud-cost-anomaly-detection-budget-alert-system.md) | 云成本异常检测与预算超支预警系统 | gateway, monitoring, backend/shared/cost | 2026-06-23 14:00 |
| [REQ-00308](./REQ-00308-microservice-api-batch-request-optimization.md) | 微服务 API 请求合并与批量处理优化系统 | gateway、所有微服务、backend/shared/middleware、 | 2026-06-24 03:00 |
| [REQ-00367](./REQ-00367-api-rate-limit-dynamic-quota-system.md) | API 请求限流智能优化与动态配额分配系统 | gateway、user-service、所有微服务、backend/share | 2026-06-29 15:00 |
| [REQ-00374](./REQ-00374-cloud-cost-anomaly-detection-budget-alert-system.md) | 云成本异常检测与预算预警系统 | gateway、monitoring、backend/shared/cost、P | 2026-06-29 22:00 |
| [REQ-00375](./REQ-00375-multi-cloud-cost-allocation-and-resource-attribution-system.md) (重号) | 多云成本分摊与资源归因优化系统 | gateway、所有微服务、backend/shared/CostAllocat | 2026-06-29 23:10 |
| [REQ-00424](./REQ-00424-kubernetes-resource-cost-optimization.md) | Kubernetes 资源成本优化与智能扩缩容系统 | k8s/hpa、k8s/vpa、monitoring、admin-dashboa | 2026-07-02 21:53 |
| [REQ-00466](./REQ-00466-cost-anomaly-detection-and-auto-alert-response-system.md) | 成本异常检测与自动告警响应系统 | backend/shared/cost-alerting、backend/job | 2026-07-07 00:20 |
| [REQ-00482](./REQ-00482-dynamic-container-load-prediction-autoscaling.md) | 动态容器资源负载预测与主动扩缩容系统 | k8s-operator/monitoring/autoscaler | 2026-07-07 15:00 |
| [REQ-00506](./REQ-00506-container-resource-optimization.md) | 游戏服务端容器资源智能利用率分析与自动裁剪系统 | infrastructure/k8s/resources, backend/sh | 2026-07-09 05:00 |
| [REQ-00538](./REQ-00538-preview-test-environment-auto-reclamation.md) (重号) | 预览与测试环境智能资源回收与成本优化系统 | .github/workflows、infrastructure/k8s/env | 2026-07-11 10:15 |
| [REQ-00613](./REQ-00613-cloud-resource-cost-attribution-allocation-system.md) | 云资源成本归因与分摊精细化系统 | gateway、所有微服务、backend/shared/costAttribu | 2026-07-20 16:00 |

</details>

<details><summary>测试覆盖（19）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00166](./REQ-00166-api-integration-test-coverage-improvement.md) (重号) | API 集成测试覆盖率提升与自动化回归测试系统 | backend/tests/integration、所有微服务、GitHub A | 2026-06-13 19:35 |
| [REQ-00177](./REQ-00177-service-mesh-traffic-mirroring-test.md) | 服务网格流量镜像测试系统 | gateway、所有微服务、infrastructure/k8s、backend | 2026-06-14 02:00 |
| [REQ-00196](./REQ-00196-route-integration-test-coverage.md) | 微服务路由层集成测试覆盖率提升计划 | 所有微服务、backend/tests/integration、backend/ | 2026-06-14 13:00 |
| [REQ-00226](./REQ-00226-api-contract-test-mock-service.md) | API 请求契约测试自动化与 Mock 服务生成系统 | gateway、所有微服务、backend/tests/contract、doc | 2026-06-15 18:00 |
| [REQ-00237](./REQ-00237-microservice-e2e-integration-test-contract-validation.md) | 微服务端到端集成测试与契约验证自动化系统 | backend/tests/integration、backend/tests/ | 2026-06-16 00:00 |
| [REQ-00272](./REQ-00272-api-contract-testing-system-and-mock-service-generation.md) | API 契约测试系统与自动化 Mock 服务生成 | gateway、所有微服务、backend/tests/contract、doc | 2026-06-18 23:00 |
| [REQ-00292](./REQ-00292-microservice-chaos-testing-framework.md) | 微服务混沌测试框架与故障注入系统 | backend/tests/chaos, backend/services/*, | 2026-06-23 01:00 |
| [REQ-00310](./REQ-00310-microservice-integration-testing-framework-and-e2e-scenarios.md) | 微服务集成测试框架与端到端场景验证系统 | backend/tests/integration, 所有微服务, backen | 2026-06-24 04:00 |
| [REQ-00352](./REQ-00352-microservice-integration-test-framework.md) (重号) | 微服务集成测试框架与端到端场景验证系统 | backend/tests/integration、所有微服务、backend/ | 2026-06-29 01:00 |
| [REQ-00366](./REQ-00366-microservice-core-business-unit-test-coverage.md) | 微服务核心业务逻辑单元测试覆盖率提升与自动化测试守卫系统 | catch-service、gym-service、pokemon-servic | 2026-06-29 14:00 |
| [REQ-00381](./REQ-00381-websocket-realtime-communication-load-testing-system.md) | WebSocket 实时通信压力测试与并发安全验证系统 | gym-service、catch-service、gateway、backen | 2026-06-30 06:15 |
| [REQ-00512](./REQ-00512-test-mock-data-management-system.md) | 测试 Mock 数据集中管理与智能生成系统 | backend/shared/testUtils、所有后端服务、database | 2026-07-08 20:01 |
| [REQ-00516](./REQ-00516-chaos-testing-framework.md) (重号) | 微服务混沌测试框架自动化执行与报告系统 | infrastructure/k8s/chaos-mesh, backend/s | 2026-07-09 02:00 |
| [REQ-00544](./REQ-00544-test-data-factory-pattern-system.md) (重号) | 微服务测试数据工厂模式与智能 Fixture 生成系统 | backend/tests、backend/shared/testUtils、c | 2026-07-12 16:03 |
| [REQ-00560](./REQ-00560-automated-mutation-testing-system.md) | 自动化变异测试系统 | backend/shared, test-suite, cicd-pipelin | 2026-07-15 15:00 |
| [REQ-00564](./REQ-00564-contract-test-mock-server-auto-generation.md) (重号) | API契约测试Mock服务自动生成系统 | backend/shared/testing、gateway、所有微服务、doc | 2026-07-16 01:00 |
| [REQ-00564](./REQ-00564-microservice-contract-test-mock-generator.md) (重号) | 微服务契约测试Mock服务自动生成系统 | backend/shared, test-suite, api-gateway | 2026-07-16 09:00 |
| [REQ-00598](./REQ-00598-gym-battle-combo-engine-test-coverage.md) | 道馆战斗引擎与连击系统单元测试覆盖 | gym-service, battleEngine.js, comboEngin | 2026-07-20 00:05 |
| [REQ-00619](./REQ-00619-core-battle-engine-test-coverage-framework.md) (重号) | 核心战斗引擎业务测试覆盖框架 | gym-service, battle-engine-module | 2026-07-21 00:00 |

</details>

<details><summary>前端体验（16）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00040](./REQ-00040-high-performance-pwa-offline-sync.md) (重号) | 高性能PWA离线持久化同步系统 | frontend, api-gateway, sync-service | 2026-07-15 10:00 |
| [REQ-00099](./REQ-00099-game-message-center-and-notification-management-system.md) | 游戏消息中心与通知管理系统 | game-client、frontend/components、user-ser | 2026-06-11 01:40 |
| [REQ-00170](./REQ-00170-game-client-offline-reconnect.md) | 游戏客户端离线模式与断线重连系统 | game-client、frontend/game-client/src/off | 2026-06-13 21:15 |
| [REQ-00189](./REQ-00189-in-game-stats-dashboard-visualization.md) | 游戏内实时数据可视化与统计仪表板 | game-client、frontend/game-client/src/com | 2026-06-14 09:05 |
| [REQ-00204](./REQ-00204-pokemon-action-queue-animation-preload.md) | 精灵动作队列与动画预加载系统 | game-client、frontend/game-client/src/ani | 2026-06-14 17:00 |
| [REQ-00207](./REQ-00207-pokemon-compare-tool-and-attribute-analysis.md) | 精灵对比工具与属性分析系统 | game-client、frontend/game-client/src/com | 2026-06-14 19:00 |
| [REQ-00209](./REQ-00209-game-map-marker-cluster-optimization.md) | 游戏地图标记聚合与渲染优化 | game-client、frontend/game-client/src/map | 2026-06-14 20:00 |
| [REQ-00258](./REQ-00258-catch-animation-effects-and-particle-optimization.md) (重号) | 精灵捕捉动画特效系统增强与粒子效果优化 | game-client、frontend/game-client/src/eff | 2026-06-18 14:00 |
| [REQ-00261](./REQ-00261-notification-center-push-system.md) | 游戏内实时通知中心与消息推送系统 | gateway、user-service、social-service、rewa | 2026-06-18 17:00 |
| [REQ-00295](./REQ-00295-game-resource-preload-intelligent-system.md) | 游戏资源预热与智能预加载系统 | game-client, cdn, location-service, poke | 2026-06-23 10:00 |
| [REQ-00304](./REQ-00304-network-adaptive-optimization-system.md) | 游戏客户端网络自适应与弱网优化系统 | game-client、gateway、catch-service、gym-se | 2026-06-23 09:00 |
| [REQ-00317](./REQ-00317-offline-resource-pack-incremental-update-system.md) | 游戏客户端离线资源包与增量更新系统 | game-client、gateway、location-service、pok | 2026-06-24 08:00 |
| [REQ-00401](./REQ-00401-ar-catch-mode-enhancement.md) | 精灵 AR 捕捉模式增强系统 | game-client、gateway、catch-service、locati | 2026-07-01 00:00 |
| [REQ-00567](./REQ-00567-smart-skeleton-screen-loading-system.md) | 智能骨架屏加载占位系统 | game-client, frontend/game-client/src/co | 2026-07-16 03:00 |
| [REQ-00603](./REQ-00603-game-client-touch-gesture-smart-recognition-system.md) | 游戏客户端触摸手势智能识别与优化系统 | game-client, touch-input-handler, gestur | 2026-07-20 04:00 |
| [REQ-00620](./REQ-00620-game-offline-experience-service-worker-cache-system.md) | 游戏离线体验与 Service Worker 智能缓存管理系统 | frontend/game-client、service-worker、back | 2026-07-20 21:00 |

</details>

<details><summary>API 设计规范（16）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00098](./REQ-00098-adaptive-api-rate-limiting-and-user-quota-management.md) | 自适应 API 限流与用户配额管理系统 | gateway、所有微服务、backend/shared、Redis、Postg | 2026-06-11 00:00 |
| [REQ-00201](./REQ-00201-api-contract-version-negotiation-system.md) | API 契约版本协商与灰度兼容系统 | gateway、所有微服务、backend/shared、docs/api-sp | 2026-06-14 16:00 |
| [REQ-00302](./REQ-00302-api-pagination-standardization-system.md) | API 分页与列表响应标准化系统 | gateway、所有微服务、backend/shared/middleware、 | 2026-06-23 07:05 |
| [REQ-00315](./REQ-00315-api-response-schema-validation-and-data-contract-system.md) | API 响应 Schema 验证与数据契约系统 | gateway、所有微服务、backend/shared、docs/api-sp | 2026-06-24 09:00 |
| [REQ-00368](./REQ-00368-api-content-negotiation-and-media-type-management.md) | API 内容协商与媒体类型管理系统 | gateway、所有微服务、backend/shared/middleware/ | 2026-06-29 15:00 |
| [REQ-00386](./REQ-00386-api-response-format-standardization-and-error-code-unification-system.md) | API 响应格式标准化与错误码统一系统 | 所有微服务、backend/shared/middleware、gateway、 | 2026-06-30 12:00 |
| [REQ-00402](./REQ-00402-api-error-retry-intelligent-backoff-system.md) | API 错误重试与智能退避系统 | gateway、所有微服务、backend/shared/RetryManage | 2026-07-01 01:00 |
| [REQ-00407](./REQ-00407-api-deprecation-notice-and-migration-guide-system.md) | API 弃用通知与迁移引导系统 | gateway、所有微服务、backend/shared/deprecation | 2026-07-01 10:00 |
| [REQ-00465](./REQ-00465-api-response-pagination-standardization.md) | API 响应分页标准化与性能优化系统 | backend/shared/pagination、gateway、所有微服务 | 2026-07-06 17:00 |
| [REQ-00476](./REQ-00476-api-performance-budget-and-benchmark-automation-system.md) | API性能预算与基准测试自动化系统 | gateway/shared/performance-budget、backen | 2026-07-07 07:00 |
| [REQ-00518](./REQ-00518-api-hateoas-links-and-resource-discovery-system.md) (重号) | API 超媒体链接（HATEOAS）与资源发现系统 | backend/shared/utils/ApiResponse.js、gate | 2026-07-09 01:00 |
| [REQ-00518](./REQ-00518-api-hypermedia-links-hateoas-and-resource-discovery-system.md) (重号) | API 超媒体链接（HATEOAS）与资源发现系统 | backend/shared/utils/ApiResponse.js、gate | 2026-07-09 01:00 |
| [REQ-00532](./REQ-00532-api-response-field-projection-and-dynamic-fieldsets.md) | API 响应字段投影与动态字段集系统 | gateway、所有后端服务、backend/shared/utils/Fiel | 2026-07-11 06:00 |
| [REQ-00547](./REQ-00547-api-response-schema-enforcement-and-contract-testing-system.md) | API 响应 Schema 强制执行与合约测试自动化系统 | gateway、所有后端服务、backend/shared/schemaVali | 2026-07-12 19:00 |
| [REQ-00548](./REQ-00548-api-request-signature-verification-and-anti-tampering-protection-system.md) (重号) | API 请求签名验证与防篡改保护系统 | gateway、所有后端服务、backend/shared/requestSig | 2026-07-15 04:00 |
| [REQ-00622](./REQ-00622-api-request-parameter-validation-injection-protection-system.md) | API 请求参数统一验证与注入防护中间件系统 | gateway/middleware/validation, backend/s | 2026-07-20 22:00 |

</details>

<details><summary>技术债/重构（15）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00085](./REQ-00085-config-center-and-hot-reload-system.md) | 配置中心与动态配置热更新系统 | gateway、所有微服务、backend/shared、Redis、infra | 2026-06-10 09:00 |
| [REQ-00103](./REQ-00103-microservice-dependency-graph-and-cycle-detection.md) | 微服务依赖图与循环依赖检测系统 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-11 04:00 |
| [REQ-00169](./REQ-00169-service-launcher-unification.md) | 微服务启动器统一化与服务样板代码消除 | pokemon-service、location-service、social- | 2026-06-13 21:00 |
| [REQ-00193](./REQ-00193-console-logging-elimination.md) | 消除 console.log 与统一结构化日志使用 | gym-service、location-service、user-servic | 2026-06-14 11:00 |
| [REQ-00211](./REQ-00211-microservice-boilerplate-unified-initializer.md) | 微服务样板代码统一初始化器 | 所有微服务（gateway, user, location, pokemon,  | 2026-06-14 21:00 |
| [REQ-00242](./REQ-00242-microservice-config-unification-and-env-validation.md) | 微服务启动配置统一化与环境变量校验系统 | 所有微服务、backend/shared/configValidator.js、 | 2026-06-16 03:00 |
| [REQ-00330](./REQ-00330-code-quality-metrics-and-refactoring-advisor-system.md) | 代码质量度量系统与自动化重构建议引擎 | backend/shared、所有微服务、.github/workflows、a | 2026-06-26 01:00 |
| [REQ-00517](./REQ-00517-error-intelligence-analysis-and-root-cause-localization-system.md) | 错误智能分析与根因定位系统 | backend/shared/errorAnalysis、gateway/mid | 2026-07-09 00:00 |
| [REQ-00534](./REQ-00534-code-duplication-detection-and-intelligent-merge-recommendation.md) | 代码重复检测与智能合并建议系统 | backend/shared/codeQuality/DuplicationDe | 2026-07-11 07:00 |
| [REQ-00553](./REQ-00553-shared-module-refactoring.md) | 微服务共享模块拆分与职责边界重构 | backend/shared、所有微服务 | 2026-07-15 03:00 |
| [REQ-00570](./REQ-00570-trade-fraud-refactoring.md) | 贸易反作弊引擎模块化重构 | trade-service, anti-cheat-service | 2026-07-16 12:00 |
| [REQ-00571](./REQ-00571-trade-fraud-detection-refactoring.md) | tradeFraudDetection.js 服务代码拆分与模块化重构 | trade-service, anti-cheat-service | 2026-07-16 13:00 |
| [REQ-00572](./REQ-00572-device-integrity-refactoring.md) | deviceIntegrity.js 模块拆分与重构 | gateway, backend/security | 2026-07-16 14:00 |
| [REQ-00619](./REQ-00619-service-dependency-consolidation-and-initialization-refactoring.md) (重号) | 服务依赖配置统一与初始化模块重构 | backend/shared/config、backend/shared/dep | 2026-07-20 20:05 |
| [REQ-00624](./REQ-00624-console-logging-migration-to-structured-logger.md) (重号) | Console 调用全面迁移至结构化日志系统 | 所有后端服务、backend/shared/logger.js、backend/ | 2026-07-21 11:00 |

</details>

<details><summary>反作弊（13）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00082](./REQ-00082-catch-success-anomaly-detection-system.md) | 精灵捕捉成功率异常检测系统 | catch-service、gateway、backend/shared/ant | 2026-06-10 07:00 |
| [REQ-00163](./REQ-00163-game-client-memory-tamper-detection.md) | 游戏客户端内存篡改检测与防护系统 | game-client、gateway、catch-service、gym-se | 2026-06-13 16:00 |
| [REQ-00181](./REQ-00181-game-client-memory-integrity-protection.md) | 游戏客户端内存完整性保护与篡改检测系统 | game-client、gateway、catch-service、gym-se | 2026-06-14 04:00 |
| [REQ-00247](./REQ-00247-catch-location-forgery-detection.md) | 精灵捕捉地点伪造检测系统 | catch-service、location-service、user-serv | 2026-06-16 06:00 |
| [REQ-00279](./REQ-00279-anti-cheat-ml-detection-system.md) | 反作弊行为模式机器学习检测系统 | backend/shared、catch-service、gym-service | 2026-06-22 03:15 |
| [REQ-00298](./REQ-00298-websocket-communication-anomaly-detection-and-realtime-blocking.md) | WebSocket 通信异常检测与实时阻断系统 | gym-service、catch-service、gateway、backen | 2026-06-23 05:00 |
| [REQ-00412](./REQ-00412-automated-script-detection-and-behavior-fingerprint.md) | 游戏自动化脚本检测与行为指纹识别系统 | gateway、user-service、catch-service、gym-s | 2026-07-01 14:00 |
| [REQ-00418](./REQ-00418-ar-mode-cheat-detection-system.md) | AR 模式作弊检测与照片验证系统 | catch-service、location-service、gateway、s | 2026-07-01 20:00 |
| [REQ-00427](./REQ-00427-game-economy-ml-anti-fraud-system.md) | 游戏经济系统反欺诈机器学习模型自动训练与部署系统 | shared/risk-engine、payment-service、rewar | 2026-07-03 04:00 |
| [REQ-00503](./REQ-00503-game-client-injection-tool-detection-protection-system.md) (重号) | 游戏客户端注入工具检测与防护系统 | game-client、gateway/src/middleware/secur | 2026-07-08 11:00 |
| [REQ-00556](./REQ-00556-machine-learning-behavior-anomaly-detection.md) | 基于机器学习的实时行为异常检测系统 | anti-cheat-service, ml-service, user-ser | 2026-07-15 05:05 |
| [REQ-00604](./REQ-00604-game-client-memory-scanning-detection-prevention-system.md) | 游戏客户端内存扫描检测与防护系统 | game-client、backend/security、gateway、bac | 2026-07-20 05:00 |
| [REQ-00608](./REQ-00608-anti-cheat-rule-dynamic-update-abtest-system.md) | 反作弊规则动态更新与灰度测试系统 | backend/shared/risk-engine, gateway, adm | 2026-07-20 13:47 |

</details>

<details><summary>无障碍(a11y)（12）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00281](./REQ-00281-game-colorblind-mode-and-visual-assistance-system.md) | 游戏色盲模式与视觉辅助系统 | game-client, pokemon-service, backend/sh | 2026-06-22 05:00 |
| [REQ-00286](./REQ-00286-game-cognitive-accessibility-system.md) | 游戏认知障碍支持与简化模式系统 | game-client, user-service, pokemon-servi | 2026-06-22 08:00 |
| [REQ-00316](./REQ-00316-game-haptics-feedback-system.md) | 游戏触觉反馈增强与震动优化系统 | game-client、catch-service、gym-service、ba | 2026-06-24 10:00 |
| [REQ-00337](./REQ-00337-pokemon-voice-description-and-blind-friendly-information-system.md) | 精灵详情语音描述与盲人友好信息系统 | game-client、frontend/game-client/src/acc | 2026-06-26 06:00 |
| [REQ-00352](./REQ-00352-audio-visual-accessibility-system.md) (重号) | 游戏音效可视化与听障玩家视觉提示系统 | game-client、frontend/game-client/src/acc | 2026-06-29 01:05 |
| [REQ-00360](./REQ-00360-motor-impairment-assist-system.md) | 精灵捕捉动作障碍玩家辅助模式系统 | game-client、frontend/game-client/src/acc | 2026-06-29 08:00 |
| [REQ-00382](./REQ-00382-audio-visual-feedback-for-deaf-players.md) | 游戏音效可视化与听障玩家视觉提示系统 | game-client、frontend/game-client/src/acc | 2026-06-30 07:00 |
| [REQ-00414](./REQ-00414-motor-impairment-assistive-mode-system.md) | 动作障碍辅助模式系统 | game-client、shared/config、admin-dashboar | 2026-07-01 16:00 |
| [REQ-00426](./REQ-00426-screen-reader-enhancement-semantic-labeling.md) | 游戏界面屏幕阅读器智能增强与语义化标注系统 | game-client、shared/a11y、admin-dashboard | 2026-07-03 01:00 |
| [REQ-00503](./REQ-00503-screen-reader-aria-support.md) (重号) | 游戏客户端屏幕阅读器与 ARIA 无障碍支持 | game-client、frontend/game-client/src/acc | 2026-07-08 12:00 |
| [REQ-00536](./REQ-00536-game-client-voice-control-and-voice-navigation-system.md) | 游戏客户端语音控制与语音导航系统 | game-client、frontend/game-client/src/acc | 2026-07-11 08:00 |
| [REQ-00566](./REQ-00566-high-contrast-visual-accessibility.md) | 高对比度模式与视觉辅助增强系统 | game-client, ui-framework, localization- | 2026-07-16 10:00 |

</details>

<details><summary>可观测性（12）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00293](./REQ-00293-distributed-tracing-opentelemetry-integration.md) | 分布式追踪与 OpenTelemetry 集成系统 | gateway, 所有微服务, backend/shared/tracing,  | 2026-06-23 09:00 |
| [REQ-00535](./REQ-00535-game-server-realtime-performance-dashboard-and-auto-diagnosis.md) | 游戏服务端实时性能看板与自动诊断系统 | infrastructure/monitoring, backend/share | 2026-07-11 15:00 |
| [REQ-00540](./REQ-00540-distributed-tracing-context-propagation-enhancement.md) | 游戏服务全链路分布式追踪链路上下文传递增强 | gateway, backend/shared, pokemon-service | 2026-07-11 18:00 |
| [REQ-00541](./REQ-00541-api-request-performance-trace-system.md) | API 请求响应链路的可观测性与性能溯源系统 | API Gateway, Backend Services, Distribut | 2026-07-11 18:30 |
| [REQ-00546](./REQ-00546-api-response-latency-jitter-monitoring.md) (重号) | 微服务间API响应时间抖动监控与智能告警系统 | api-gateway, observability-service, metr | 2026-07-13 10:00 |
| [REQ-00549](./REQ-00549-real-time-api-latency-and-jitter-monitoring-system.md) (重号) | Real-time API Latency and Jitter Monitoring System | API Gateway, Monitoring Service, Dashboa | 2026-07-11 10:00 |
| [REQ-00555](./REQ-00555-game-server-log-anomaly-clustering-system.md) | 游戏服务端异常日志追踪与智能聚类告警系统 | log-collector, observability-service, ba | 2026-07-15 09:00 |
| [REQ-00573](./REQ-00573-implement-distributed-tracing-root-cause-analysis-engine.md) | 实现分布式链路异常根因分析引擎 | tracing-service, analytics-engine | 2026-07-16 12:45 |
| [REQ-00594](./REQ-00594-game-realtime-performance-diagnosis-engine.md) | 游戏内实时性能瓶颈自诊断引擎 | game-client, gateway, backend-metrics | 2026-07-19 09:00 |
| [REQ-00599](./REQ-00599-api-latency-anomaly-detection-system.md) | API 响应延迟异常检测与智能告警系统 | API Gateway, Monitoring Service | 2026-07-20 09:00 |
| [REQ-00606](./REQ-00606-game-client-rendering-performance-monitor.md) | 游戏客户端渲染性能智能监控与告警系统 | game-client, performance-monitor, alert- | 2026-07-20 15:00 |
| [REQ-00610](./REQ-00610-api-tracing-visualization.md) | API 请求响应链路分布式追踪数据可视化增强 | gateway, backend/shared/tracing, observa | 2026-07-20 15:00 |

</details>

<details><summary>可扩展性/解耦（11）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00050](./REQ-00050-plugin-middleware-system-lifecycle-management.md) | 插件化中间件系统与生命周期管理 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-09 13:00 |
| [REQ-00122](./REQ-00122-microservice-config-center-and-hot-reload.md) | 微服务配置中心与动态配置热更新系统 | gateway、所有微服务、backend/shared/config、Redi | 2026-06-11 18:00 |
| [REQ-00194](./REQ-00194-event-bus-adapter-abstraction-layer.md) | 事件总线适配器抽象层 | backend/shared/EventBusAdapter.js、backen | 2026-06-14 12:00 |
| [REQ-00277](./REQ-00277-service-discovery-and-dynamic-routing-system.md) | 服务发现与动态路由系统 | gateway, backend/shared, 所有微服务, k8s/01-s | 2026-06-22 02:00 |
| [REQ-00284](./REQ-00284-distributed-transaction-saga-orchestration-system.md) | 分布式事务编排与 Saga 补偿机制系统 | backend/shared, gateway, catch-service,  | 2026-06-22 06:00 |
| [REQ-00300](./REQ-00300-dynamic-service-discovery-and-registry.md) | 动态服务注册发现与健康感知路由系统 | gateway、所有微服务、backend/shared/serviceRegi | 2026-06-23 06:00 |
| [REQ-00319](./REQ-00319-microservice-dependency-injection-container-and-auto-binding-system.md) | 微服务依赖注入容器与自动服务发现绑定系统 | backend/shared/DependencyContainer.js、ba | 2026-06-24 09:00 |
| [REQ-00499](./REQ-00499-事件驱动服务编排与分布式状态机引擎.md) | 事件驱动服务编排与分布式状态机引擎 | backend/shared、catch-service、gym-service | 2026-07-08 08:30 |
| [REQ-00549](./REQ-00549-service-lifecycle-state-machine-and-graceful-transition-system.md) (重号) | 服务生命周期状态机与优雅转换系统 | backend/shared/serviceLifecycle、gateway、 | 2026-07-16 10:00 |
| [REQ-00600](./REQ-00600-dynamic-module-loader-di-container.md) | 动态模块加载器与依赖注入容器系统 | backend/shared/moduleLoader、backend/shar | 2026-07-20 01:00 |
| [REQ-00607](./REQ-00607-microservice-cross-service-dependency-decoupling.md) | 微服务跨服务依赖解耦与统一服务发现机制 | gateway, catch-service, gym-service, pok | 2026-07-20 09:00 |

</details>

<details><summary>容灾/高可用（6）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00087](./REQ-00087-chaos-engineering-fault-injection-testing-system.md) (重号) | 混沌工程与故障注入测试系统 | gateway、所有微服务、backend/shared、infrastruct | 2026-06-10 10:00 |
| [REQ-00285](./REQ-00285-service-graceful-shutdown-and-connection-draining-system.md) | 服务实例优雅停机与连接排空系统 | backend/shared, gateway, 所有微服务, k8s | 2026-06-22 07:00 |
| [REQ-00530](./REQ-00530-data-recovery-integrity-verification-and-consistency-repair-system.md) | 数据恢复完整性校验与一致性自动修复系统 | backend/shared/disasterRecovery、backend/ | 2026-07-11 05:00 |
| [REQ-00569](./REQ-00569-cross-region-disaster-recovery-drill-automation-system.md) | 跨区域容灾演练自动化与灾备切换决策引擎 | gateway, infrastructure, multiRegionArbi | 2026-07-16 04:00 |
| [REQ-00593](./REQ-00593-fault-scenario-discovery-chaos-verification.md) | 灾备故障场景自动发现与混沌验证覆盖系统 | backend/shared/disasterRecovery, backend | 2026-07-19 03:00 |
| [REQ-00609](./REQ-00609-rpo-rto-realtime-monitoring-early-warning-system.md) | RPO/RTO 实时监控与预警告警系统 | backend/shared/disasterRecovery, gateway | 2026-07-20 14:00 |

</details>

<details><summary>文档/开发者体验（4）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00205](./REQ-00205-developer-environment-auto-setup-tool.md) | 开发者环境自动化配置工具 | scripts/setup-dev.js、backend/shared/conf | 2026-06-14 18:00 |
| [REQ-00438](./REQ-00438-api-call-examples-library-and-best-practices-documentation-system.md) | API 调用示例库与最佳实践文档系统 | backend/docs/examples、frontend/game-clie | 2026-07-06 08:17 |
| [REQ-00551](./REQ-00551-api-error-code-playground-interactive-docs.md) (重号) | API 错误码交互式文档与在线调试沙盒系统 | gateway、admin-dashboard、docs-site、backen | 2026-07-16 14:00 |
| [REQ-00589](./REQ-00589-microservice-architecture-visualization.md) | 微服务架构可视化与 API 依赖关系图谱系统 | admin-dashboard, gateway, 所有后端服务, docs-s | 2026-07-17 00:00 |

</details>

<details><summary>运营/数据分析（2）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00354](./REQ-00354-player-behavior-funnel-analysis-and-churn-prediction-system.md) | 玩家行为漏斗分析与流失预警系统 | user-service、gateway、backend/shared、back | 2026-06-29 03:00 |
| [REQ-00405](./REQ-00405-player-churn-prediction-and-retention-system.md) | 玩家流失预测与智能挽留系统 | user-service、reward-service、social-servi | 2026-07-01 04:00 |

</details>

<details><summary>Data Governance（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00040](./REQ-00040-offline-cache-consistency-system.md) (重号) | Offline Cache Data Consistency & Synchronization System | game-client, gateway, backend | 2026-07-11 16:05 |

</details>

<details><summary>数据治理/分析（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00208](./REQ-00208-player-behavior-analysis-user-profile-system.md) | 玩家行为数据分析与用户画像系统 | user-service、gateway、backend/shared、back | 2026-06-14 19:10 |

</details>

<details><summary>稳定性/高可用（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00296](./REQ-00296-slo-error-budget-management-auto-degradation-system.md) | SLO 错误预算管理与自动降级系统 | gateway, 所有微服务, backend/shared/slo, back | 2026-06-23 12:00 |

</details>

<details><summary>前端体验/运维（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00336](./REQ-00336-hotupdate-resource-management-system.md) | 精灵资源动态更新与热修复系统 | game-client、gateway、pokemon-service、loca | 2026-06-26 08:00 |

</details>

<details><summary>安全加固/反作弊（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00475](./REQ-00475-real-time-behavior-risk-control.md) | 游戏内实时行为风控与异常操作拦截系统 | gateway-service/risk-control-engine | 2026-07-07 12:00 |

</details>

<details><summary>性能优化/运维（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00484](./REQ-00484-db-connection-pool-auto-scaling.md) | 数据库连接池自动弹性伸缩与健康巡检系统 | database-service/connection-pool-manager | 2026-07-08 03:00 |

</details>

<details><summary>合规/运维（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00590](./REQ-00590-cross-region-data-consistency-verification.md) (重号) | 跨区域数据同步一致性校验系统 | database-replica, cross-region-sync-mana | 2026-07-17 06:00 |

</details>

## P2 未完成（30 条，本轮不实现，进入待办池）

<details><summary>无障碍(a11y)（9）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00108](./REQ-00108-game-client-photosensitive-epilepsy-safe-mode.md) | 游戏客户端光敏性癫痫安全模式 | game-client、frontend/effects、frontend/ga | 2026-06-11 07:05 |
| [REQ-00162](./REQ-00162-in-game-screen-reader-voice-navigation-enhancement.md) | 游戏内屏幕阅读器语音导航增强系统 | game-client、frontend/game-client/src/acc | 2026-06-13 17:05 |
| [REQ-00180](./REQ-00180-game-keyboard-navigation-and-shortcut-system.md) | 游戏键盘导航与快捷键系统 | game-client、frontend/game-client/src/acc | 2026-06-14 03:00 |
| [REQ-00198](./REQ-00198-game-pace-control-and-slow-motion-system.md) | 游戏节奏控制与慢速模式系统 | game-client、frontend/game-client/src/gam | 2026-06-14 14:00 |
| [REQ-00233](./REQ-00233-game-controller-gamepad-input-support-system.md) | 游戏控制器与手柄输入支持系统 | game-client、frontend/game-client/src/inp | 2026-06-15 21:05 |
| [REQ-00263](./REQ-00263-game-pace-control-and-slow-mode.md) | 游戏节奏控制与慢速模式系统 | game-client、frontend/game-client/src/acc | 2026-06-18 19:00 |
| [REQ-00435](./REQ-00435-game-haptics-feedback-enhancement.md) | 游戏触觉反馈增强与自定义系统 | game-client | 2026-07-06 07:00 |
| [REQ-00474](./REQ-00474-color-blind-accessibility-system.md) | 游戏色彩感知障碍辅助与自定义调色板系统 | game-client、shared/color-system、admin-da | 2026-07-07 06:00 |
| [REQ-00611](./REQ-00611-game-realtime-subtitles-hearing-impairment-support.md) | 游戏实时字幕与听觉障碍支持系统 | game-client、backend/shared/subtitles、use | 2026-07-20 15:00 |

</details>

<details><summary>国际化/本地化（5）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00252](./REQ-00252-game-datetime-format-localization.md) | 游戏内日期时间格式本地化系统 | game-client、frontend/game-client/src/i18 | 2026-06-16 09:00 |
| [REQ-00280](./REQ-00280-game-number-localization-display-system.md) | 游戏数值本地化显示系统 | game-client/src/utils、game-client/src/co | 2026-06-22 04:00 |
| [REQ-00413](./REQ-00413-game-text-auto-direction-layout-system.md) | 游戏文本自动方向布局系统 | game-client、shared/i18n、admin-dashboard | 2026-07-01 15:00 |
| [REQ-00591](./REQ-00591-localization-collaboration-approval-workflow.md) | 本地化内容协作审批工作流系统 | gateway、admin-dashboard、backend/shared/i | 2026-07-17 01:00 |
| [REQ-00624](./REQ-00624-game-rich-content-i18n-version-management-system.md) (重号) | 游戏内富文本内容本地化与版本管理系统 | gateway、user-service、reward-service、back | 2026-07-21 12:00 |

</details>

<details><summary>前端体验（4）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00117](./REQ-00117-map-gesture-interaction-optimization.md) | 地图手势交互优化与缩放流畅度提升 | game-client、frontend/game-client/src/gam | 2026-06-11 17:05 |
| [REQ-00433](./REQ-00433-screen-transition-animation-and-microinteraction-system.md) | 游戏界面转场动画与微交互体验优化系统 | game-client/src/transitions, game-client | 2026-07-06 05:15 |
| [REQ-00470](./REQ-00470-dynamic-audio-adjustment-system.md) | 游戏内动态音效与背景音乐智能调节系统 | game-client, audio-service | 2026-07-07 09:00 |
| [REQ-00602](./REQ-00602-skeleton-loading-and-progress-indicator-system.md) | 游戏内加载骨架屏与智能进度指示系统 | game-client、frontend/game-client/src/com | 2026-07-20 03:00 |

</details>

<details><summary>运维/CICD（3）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00287](./REQ-00287-cicd-pipeline-dependency-analysis-and-parallel-optimization.md) | CI/CD 管道执行依赖分析与并行优化系统 | .github/workflows, backend/jobs, admin-d | 2026-06-22 08:00 |
| [REQ-00423](./REQ-00423-deployment-changelog-auto-generation.md) | 部署变更日志自动生成系统 | github-actions、admin-dashboard、notificat | 2026-07-02 04:00 |
| [REQ-00509](./REQ-00509-cicd-cache-intelligent-management-system.md) | CI/CD 缓存智能管理与优化系统 | .github/workflows、backend/shared/cacheMa | 2026-07-08 17:00 |

</details>

<details><summary>成本/资源优化（2）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00273](./REQ-00273-kubernetes-resource-optimization-and-cost-monitoring.md) | Kubernetes 资源限制优化与成本监控 | k8s/01-deployments、k8s/02-services、monit | 2026-06-19 00:00 |
| [REQ-00625](./REQ-00625-game-server-cloud-resource-cost-prediction-and-optimization.md) | 游戏服务端云资源成本动态预测与智能优化系统 | infrastructure, backend | 2026-07-21 13:00 |

</details>

<details><summary>技术债/重构（2）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00349](./REQ-00349-error-handling-module-consolidation.md) | 错误处理模块重构与统一化 | backend/shared/auth.js、backend/shared/er | 2026-06-27 05:00 |
| [REQ-00415](./REQ-00415-code-quality-metrics-and-refactoring-suggestions.md) | 代码质量度量与重构建议系统 | shared/analyzer、admin-dashboard、github-a | 2026-07-01 17:00 |

</details>

<details><summary>功能增强（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00271](./REQ-00271-pokemon-nickname-and-custom-name-tag-system.md) | 精灵昵称与自定义名牌系统 | pokemon-service、user-service、gateway、gam | 2026-06-18 23:00 |

</details>

<details><summary>测试覆盖（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00274](./REQ-00274-event-service-comprehensive-unit-test-coverage.md) | 游戏活动服务单元测试覆盖 | reward-service、backend/tests/unit | 2026-06-22 00:47 |

</details>

<details><summary>API 设计规范（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00329](./REQ-00329-api-endpoint-naming-convention-linter-and-doc-sync.md) (重号) | API 端点命名规范自动校验与文档同步系统 | gateway、所有微服务、backend/shared/apiLinter.j | 2026-06-26 00:27 |

</details>

<details><summary>文档/开发者体验（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00378](./REQ-00378-architecture-decision-records-and-knowledge-base.md) | 微服务架构决策记录（ADR）系统与知识库管理 | docs/architecture、backend/shared、所有微服务、a | 2026-06-30 03:00 |

</details>

<details><summary>可观测性/监控（1）</summary>

| 编号 | 标题 | 涉及服务 | 创建时间 |
|---|---|---|---|
| [REQ-00491](./REQ-00491-metric-lifecycle-management-system.md) | 监控指标生命周期管理与废弃治理系统 | backend/shared/metrics、gateway/middlewar | 2026-07-08 01:17 |

</details>

