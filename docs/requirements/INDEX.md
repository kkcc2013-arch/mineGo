# mineGo 需求总索引

> 自动维护，每小时新增 1 条。目标 10000 条或达成"可用"标准即止。

|| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
|| REQ-00413 | 游戏文本自动方向布局系统 | 国际化/本地化 | P2 | new | game-client、shared/i18n、admin-dashboard | 2026-07-01 15:00 |
|| REQ-00414 | 动作障碍辅助模式系统 | 无障碍(a11y) | P1 | new | game-client、shared/config、admin-dashboard | 2026-07-01 16:00 |
|| REQ-00415 | 代码质量度量与重构建议系统 | 技术债/重构 | P2 | new | shared/analyzer、admin-dashboard、github-actions | 2026-07-01 17:00 |
|| REQ-00416 | 游戏经济系统异常检测与防刷风控系统 | 反作弊 | P1 | done | payment-service、reward-service、trade-service、gateway、admin-dashboard、shared/risk-engine | 2026-07-01 18:00 |
|| REQ-00417 | 玩家会话超时智能管理与渐进式断开系统 | 性能优化 | P1 | new | gateway、auth-service、game-client、admin-dashboard | 2026-07-01 19:00 |
|| REQ-00418 | AR模式作弊检测与照片验证系统 | 反作弊 | P1 | new | catch-service、location-service、gateway、shared/anti-cheat、admin-dashboard | 2026-07-01 20:00 |
|| REQ-00419 | 精灵栖息地系统与生态环境影响机制 | 功能增强 | P1 | new | game-core、catch-service、location-service、map-service、shared/ecosystem、admin-dashboard | 2026-07-01 21:00 |
|| REQ-00420 | 数据库备份自动验证与演练系统 | 数据库/数据治理 | P1 | new | database、backup-service、monitoring、admin-dashboard | 2026-07-02 01:00 |
|| REQ-00421 | 玩家登录性能优化与快速恢复系统 | 性能优化 | P1 | new | gateway、auth-service、player-service、game-client、shared/cache | 2026-07-02 02:00 |
|| REQ-00422 | 精灵数据预编译缓存系统 | 性能优化 | P1 | new | game-core、catch-service、battle-service、shared/cache、admin-dashboard | 2026-07-02 03:00 |
|| REQ-00424 | Kubernetes 资源成本优化与智能扩缩容系统 | 成本/资源优化 | P1 | new | k8s/hpa、k8s/vpa、monitoring、admin-dashboard、shared/cost-optimizer | 2026-07-02 21:53 |
|| REQ-00425 | 游戏内通知与智能消息推送系统 | 功能增强 | P1 | new | gateway、notification-service（新建）、user-service、social-service、reward-service、game-client、admin-dashboard | 2026-07-02 23:00 |
|| REQ-00426 | 游戏界面屏幕阅读器智能增强与语义化标注系统 | 无障碍(a11y) | P1 | new | game-client、shared/a11y、admin-dashboard | 2026-07-03 01:00 |
||| REQ-00427 | 游戏经济系统反欺诈机器学习模型自动训练与部署系统 | 反作弊 | P1 | new | shared/risk-engine、payment-service、reward-service、admin-dashboard | 2026-07-03 04:00 |
    20||| REQ-00428 | 数据库读写分离监控与延迟告警系统 | 数据库/数据治理 | P1 | new | database-service、monitoring-service | 2026-07-03 07:00 |
    21||| REQ-00429 | 游戏客户端断点续传资源更新系统 | 运维/CICD | P1 | new | game-client、cdn-service、storage-service、admin-dashboard | 2026-07-03 08:00 |