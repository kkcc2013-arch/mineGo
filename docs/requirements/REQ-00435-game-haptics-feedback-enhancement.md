# REQ-00435: 游戏触觉反馈增强与自定义系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00435 |
| 标题 | 游戏触觉反馈增强与自定义系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P2 |
| 状态 | new |
| 涉及服务 | game-client |
| 创建时间 | 2026-07-06 07:00 |

## 需求描述

为了提升游戏的沉浸感并为听力障碍玩家提供额外的信息反馈通道，需要开发一套全面的触觉反馈系统（Haptics Feedback System）。该系统将根据游戏内的不同事件（如捕捉成功、进化、战斗碰撞等）触发不同频率和强度的震动，并允许用户在设置中自定义反馈级别。

## 技术方案

### 1. 触觉管理器 (HapticManager)
- 封装 Web Haptics API，提供统一的 `trigger(type, intensity)` 接口。
- 支持不同类型的预设震动波形。

### 2. 事件集成
- 在 `CatchEngine`、`BattleEngine` 等模块中接入 `HapticManager`。
- 捕捉成功：长震动，表示成功。
- 战斗碰撞：短脉冲震动，表现打击感。

### 3. 设置面板
- 在设置菜单增加触觉反馈强度调节（滑块 0-100%）。
- 支持关闭触觉反馈，满足特定玩家偏好。

## 验收标准

- [ ] 触觉反馈管理器已实现并正确封装
- [ ] 捕捉成功、战斗碰撞、界面操作已触发触觉反馈
- [ ] 设置页面支持调节触觉反馈强度及开关
- [ ] 不同震动模式（短促、长效）在设备上表现符合预期

## 影响范围

- `frontend/game-client/src/haptics/HapticManager.js`
- `frontend/game-client/src/settings/`

## 参考

- [Web Haptics API Draft](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)
