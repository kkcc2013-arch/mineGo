# REQ-00435: 游戏触觉反馈增强与自定义系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00435 |
| 标题 | 游戏触觉反馈增强与自定义系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P2 |
| 状态 | implemented |
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

## 实现记录（2026-09-25）

> 按 2026-09-25 起的验证方式：只写代码与测试，未启动服务做验证；✅ = 代码已实现、待验证。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 触觉反馈管理器已实现并正确封装 | ✅ | `haptics/HapticManager.js`（vibrate(pattern, { intensity, scene })）扩展百分比强度、场景开关、能力检测与记录 |
| 捕捉成功、战斗碰撞、界面操作已触发触觉反馈 | ✅ | 捕捉成功（CatchEngine）、界面操作（增强模式）；战斗碰撞 battle_hit 由 `pmg:battle` 契约触发（客户端无战斗界面） |
| 设置页面支持调节触觉反馈强度及开关 | ✅ | 设置 → 触觉：开关 + 强度 0–200%（需求 0–100%，为超集） |
| 不同震动模式（短促、长效）在设备上表现符合预期 | ⚠️ | 真机未验证 |

- 入口：`frontend/game-client/index.html` → `src/bootstrap/features.js` → `src/bootstrap/a11y.js` 的 `initAccessibility(ctx)`；设置入口「我的 → 无障碍设置」（`window.showAccessibilitySettings`，或按 `,`），模块在 `src/accessibility/`
- 迁移：`database/migrations/20260925_010000__user_preferences.sql`（`user_preferences`：user_id UUID → users(id) ON DELETE CASCADE、namespace、prefs JSONB，主键 (user_id, namespace)，全部 IF NOT EXISTS）；偏好云端同步：user-service `GET/PUT/DELETE /users/me/preferences/:namespace`（`src/routes/preferences.js` + `src/services/userPreferences.js` 校验），经网关 `/v1/users/me/preferences/a11y`（网关已有 `/v1/users` 鉴权代理，未改网关）
- 测试：前端纯逻辑单测 `node --test frontend/game-client/tests/a11y/unit.test.mjs frontend/game-client/tests/a11y/voice.test.mjs`（宿主机已运行 63/63 通过）；后端单测 `cd backend && node --test tests/unit/a11y-backend.test.js`（宿主机已运行 9/9，已加入 `npm run test:unit`）；服务冒烟 `BASE_URL=<网关> node scripts/smoke-a11y.js`；浏览器 e2e `BASE_URL=<网关> APP_URL=<客户端> NODE_PATH=<playwright-core+axe-core> node scripts/e2e-a11y.js`；性能 `scripts/bench-a11y-client.js`。验证方式调整前曾在 CI 栈跑过一次：smoke-a11y 17/17、e2e 60/60（之后新增的用例未运行，**待验证**）
- 待验证：Android 真机震动手感；硬件相关（振动/手柄/Web Speech）以模拟对象测试，⚠️ 真机未验证
- 使用与接入文档：`docs/accessibility/a11y-guide.md`
