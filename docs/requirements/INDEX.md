# mineGo 需求总索引

> 自动维护，每小时新增 1 条。目标 10000 条或达成"可用"标准即止。

| 编号 | 标题 | 类别 | 优先级 | 状态 | 涉及服务 | 创建时间 |
|------|------|------|--------|------|----------|----------|
| REQ-00413 | 游戏文本自动方向布局系统 | 国际化/本地化 | P2 | new | game-client、shared/i18n、admin-dashboard | 2026-07-01 15:00 |
| REQ-00414 | 动作障碍辅助模式系统 | 无障碍(a11y) | P1 | new | game-client、shared/config、admin-dashboard | 2026-07-01 16:00 |
| REQ-00415 | 代码质量度量与重构建议系统 | 技术债/重构 | P2 | new | shared/analyzer、admin-dashboard、github-actions | 2026-07-01 17:00 |
| REQ-00416 | 游戏经济系统异常检测与防刷风控系统 | 反作弊 | P1 | done | payment-service、reward-service、trade-service、gateway、admin-dashboard、shared/risk-engine | 2026-07-01 18:00 |
| REQ-00417 | 玩家会话超时智能管理与渐进式断开系统 | 性能优化 | P1 | new | gateway、auth-service、game-client、admin-dashboard | 2026-07-01 19:00 |
| REQ-00418 | AR模式作弊检测与照片验证系统 | 反作弊 | P1 | new | catch-service、location-service、gateway、shared/anti-cheat、admin-dashboard | 2026-07-01 20:00 |