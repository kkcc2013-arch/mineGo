# REQ-00566: 高对比度模式与视觉辅助增强系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00566 |
| 标题 | 高对比度模式与视觉辅助增强系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | game-client, ui-framework, localization-service |
| 创建时间 | 2026-07-16 10:00 |

## 需求描述

为了满足视觉障碍玩家的需求，本项目需开发一套"高对比度模式"及相关视觉辅助增强系统。该系统允许玩家在游戏设置中开启高对比度主题，确保文字与背景、交互元素与游戏场景之间有足够的对比度，并提供色彩校准选项。

## 技术方案

### 1. UI 渲染适配
- 在 UI 框架层引入主题变量管理，支持运行时动态切换全局 CSS/材质主题。
- 高对比度模式下：
    - 字体加粗并调整为明亮色系（如白或亮黄）。
    - 禁用模糊背景，改为纯色或高对比色块。
    - 交互按钮添加明显的描边标识。

### 2. 视觉辅助配置项
- 提供色彩盲点模拟预览与校准滑块（针对红绿色盲、全色盲）。
- 集成全局 UI 缩放比例控制。

## 验收标准

- [ ] 玩家可在设置菜单中开启/关闭高对比度模式，切换立即生效。
- [ ] 确保在最高难度（如强光场景）下，所有交互文字对比度符合 WCAG AA 标准。
- [ ] 提供至少 3 种针对不同色觉障碍的色彩校准方案。

## 影响范围

- `game-client`: 负责渲染 UI 和配置应用。
- `ui-framework`: 全局样式配置与主题管理。

## 参考

- WCAG 2.1 Accessibility Guidelines

## 实现记录（2026-09-25）

> 按 2026-09-25 起的验证方式：只写代码与测试，未启动服务做验证；✅ = 代码已实现、待验证。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 玩家可在设置菜单中开启/关闭高对比度模式，切换立即生效。 | ✅ | 设置 → 视觉 → 高对比度开关（`Alt+H` 快捷键），CSS 变量即时切换 |
| 确保在最高难度（如强光场景）下，所有交互文字对比度符合 WCAG AA 标准。 | ✅ | 高对比度主题：纯黑底、白字（21:1）、次要文字亮黄，按钮加粗描边，禁用渐变/模糊；axe 高对比度页面无 color-contrast 违规（调整前运行） |
| 提供至少 3 种针对不同色觉障碍的色彩校准方案。 | ✅ | 红色盲/绿色盲/蓝黄色盲 daltonize 校准滤镜 + 全色盲方案，强度滑块 0–1；另有界面缩放 0.8–1.6 |

- 入口：`frontend/game-client/index.html` → `src/bootstrap/features.js` → `src/bootstrap/a11y.js` 的 `initAccessibility(ctx)`；设置入口「我的 → 无障碍设置」（`window.showAccessibilitySettings`，或按 `,`），模块在 `src/accessibility/`
- 迁移：`database/migrations/20260925_010000__user_preferences.sql`（`user_preferences`：user_id UUID → users(id) ON DELETE CASCADE、namespace、prefs JSONB，主键 (user_id, namespace)，全部 IF NOT EXISTS）；偏好云端同步：user-service `GET/PUT/DELETE /users/me/preferences/:namespace`（`src/routes/preferences.js` + `src/services/userPreferences.js` 校验），经网关 `/v1/users/me/preferences/a11y`（网关已有 `/v1/users` 鉴权代理，未改网关）
- 测试：前端纯逻辑单测 `node --test frontend/game-client/tests/a11y/unit.test.mjs frontend/game-client/tests/a11y/voice.test.mjs`（宿主机已运行 63/63 通过）；后端单测 `cd backend && node --test tests/unit/a11y-backend.test.js`（宿主机已运行 9/9，已加入 `npm run test:unit`）；服务冒烟 `BASE_URL=<网关> node scripts/smoke-a11y.js`；浏览器 e2e `BASE_URL=<网关> APP_URL=<客户端> NODE_PATH=<playwright-core+axe-core> node scripts/e2e-a11y.js`；性能 `scripts/bench-a11y-client.js`。验证方式调整前曾在 CI 栈跑过一次：smoke-a11y 17/17、e2e 60/60（之后新增的用例未运行，**待验证**）
- 待验证：强光户外下的可读性；硬件相关（振动/手柄/Web Speech）以模拟对象测试，⚠️ 真机未验证
- 使用与接入文档：`docs/accessibility/a11y-guide.md`
