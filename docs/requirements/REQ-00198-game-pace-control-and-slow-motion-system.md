# REQ-00198：游戏节奏控制与慢速模式系统

- **编号**：REQ-00198
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：partial
- **涉及服务/模块**：game-client、frontend/game-client/src/game、frontend/game-client/src/accessibility、gateway
- **创建时间**：2026-06-14 14:00
- **依赖需求**：REQ-00017（无障碍访问支持）、REQ-00171（触觉反馈增强系统）

## 1. 背景与问题

当前 mineGo 游戏客户端的无障碍系统已覆盖键盘导航、屏幕阅读器、色盲模式、高对比度模式等功能，但缺少游戏节奏控制能力：

1. **捕捉机制速度过快**：CatchEngine 的投掷窗口、精灵球摇动、精灵逃逸等事件按标准速度执行，运动障碍用户（如帕金森病、关节炎）可能无法在时间窗口内完成操作
2. **战斗系统反应时间要求高**：道馆战斗和 PVP 对战中，技能释放、躲避指令需要在毫秒级内响应，对手部灵活度有较高要求
3. **认知负荷过重**：快速的事件序列（精灵出现 → 投掷 → 摇球 → 结果）对认知障碍用户造成压力，难以理解游戏进程
4. **缺少节奏调节入口**：当前无障碍设置面板仅支持字体大小、动画关闭、色盲模式，缺少游戏速度控制

行业标杆：
- Xbox Adaptive Controller 提供"慢速模式"，将游戏速度降至 50%
- 《最后生还者 2》支持"战斗时间延缓"功能，让玩家有更多反应时间
- 《蜘蛛侠：迈尔斯》支持"慢速战斗"选项，降低动作节奏

## 2. 目标

为运动障碍、认知障碍用户提供可配置的游戏节奏控制能力，确保：
- 用户可独立调节捕捉、战斗、UI 动画的速度倍率（0.5x - 2.0x）
- 慢速模式下游戏逻辑仍正常运行，不破坏游戏平衡
- 所有节奏控制可通过无障碍设置面板一键配置
- 持久化用户偏好，跨设备同步

## 3. 范围

### 包含
- CatchEngine 时间缩放（投掷窗口延长、摇球动画减速）
- 战斗系统节奏控制（攻击间隔延长、躲避窗口扩大）
- UI 动画速度调节（弹窗、过渡效果）
- 无障碍设置面板新增"游戏节奏"分组
- 用户偏好持久化（localStorage + user-service 同步）
- 慢速模式视觉提示（界面显示当前倍率）

### 不包含
- 多人匹配模式的节奏调节（避免破坏公平性）
- 服务器端逻辑修改（仅客户端视觉/交互层调整）
- 自动作弊检测规避（慢速模式不影响服务器判定）

## 4. 详细需求

### 4.1 节奏控制模块（GameSpeedManager）

```javascript
// frontend/game-client/src/accessibility/GameSpeedManager.js
export class GameSpeedManager {
  static SPEED = {
    SLOWEST: 0.5,   // 最慢 - 2倍时间
    SLOW: 0.75,     // 慢速 - 1.33倍时间
    NORMAL: 1.0,    // 标准
    FAST: 1.25,     // 快速
    FASTEST: 1.5    // 最快
  };
  
  // 各系统独立倍率
  config = {
    catch: 1.0,      // 捕捉场景
    battle: 1.0,     // 战斗场景
    animation: 1.0,  // UI 动画
    transition: 1.0  // 界面过渡
  };
  
  // 慢速模式预设
  presets = {
    'accessibility': { catch: 0.5, battle: 0.5, animation: 0.75, transition: 0.5 },
    'relaxed': { catch: 0.75, battle: 0.75, animation: 1.0, transition: 0.75 },
    'normal': { catch: 1.0, battle: 1.0, animation: 1.0, transition: 1.0 },
    'veteran': { catch: 1.25, battle: 1.0, animation: 1.25, transition: 1.0 }
  };
}
```

### 4.2 CatchEngine 集成

- `THROW_RING_SHRINK_RATE` 乘以当前速度倍率
- `startCatch()` 返回的 `timeLimit` 字段需根据倍率调整显示
- 精灵球摇动动画时长延长（`shakeDuration = base * 1/speedMultiplier`）
- 投掷反馈延迟调整，确保慢速模式下手感一致

### 4.3 战斗系统集成

- `battle-service` 客户端本地战斗逻辑：
  - 攻击冷却延长：`cooldown = baseCooldown / speedMultiplier`
  - 躲避窗口扩大：`dodgeWindow = baseWindow / speedMultiplier`
  - 技能特效播放速度：`effectSpeed = speedMultiplier`
- PVP 模式禁用节奏控制，显示提示："多人对战不支持慢速模式"

### 4.4 UI 动画速度控制

- CSS `transition-duration` 动态调整：
  ```css
  :root {
    --speed-multiplier: 1.0;
    --transition-duration: calc(300ms / var(--speed-multiplier));
  }
  ```
- 弹窗显示/隐藏速度
- 精灵卡片翻转动画
- 地图缩放动画

### 4.5 无障碍设置面板

在现有设置面板新增分组：

```html
<div class="settings-group">
  <h3 class="settings-group-title">游戏节奏</h3>
  
  <div class="speed-preset-selector">
    <button data-preset="accessibility">无障碍模式（最慢）</button>
    <button data-preset="relaxed">轻松模式</button>
    <button data-preset="normal" class="active">标准</button>
    <button data-preset="veteran">老玩家模式</button>
  </div>
  
  <div class="speed-custom-toggles">
    <label>
      捕捉场景速度
      <input type="range" min="0.5" max="1.5" step="0.25" value="1.0" data-config="catch">
      <span class="speed-value">1.0x</span>
    </label>
    <label>
      战斗场景速度
      <input type="range" min="0.5" max="1.5" step="0.25" value="1.0" data-config="battle">
      <span class="speed-value">1.0x</span>
    </label>
    <label>
      UI 动画速度
      <input type="range" min="0.5" max="1.5" step="0.25" value="1.0" data-config="animation">
      <span class="speed-value">1.0x</span>
    </label>
  </div>
</div>
```

### 4.6 视觉提示

- 界面右上角显示当前倍率徽章（仅当非 1.0x 时）：
  ```
  ┌─────────────┐
  │ 🐢 0.5x 速度 │
  └─────────────┘
  ```
- 颜色编码：
  - ≤ 0.75x：绿色（无障碍友好）
  - 1.0x：蓝色（标准）
  - ≥ 1.25x：橙色（快速）

### 4.7 数据持久化

```javascript
// 保存到 localStorage
localStorage.setItem('gameSpeedConfig', JSON.stringify(config));

// 同步到 user-service
await apiClient.updateUserPreferences({
  accessibility: {
    gameSpeed: config
  }
});

// 启动时恢复
const saved = localStorage.getItem('gameSpeedConfig');
if (saved) {
  gameSpeedManager.applyConfig(JSON.parse(saved));
}
```

### 4.8 API 支持

新增 user-service 路由：

```
PUT /api/v1/user/preferences/accessibility
{
  "gameSpeed": {
    "catch": 0.75,
    "battle": 0.5,
    "animation": 1.0,
    "transition": 0.75
  }
}
```

## 5. 验收标准（可测试）

- [ ] 在无障碍设置面板可调节捕捉场景速度（0.5x/0.75x/1.0x/1.25x/1.5x）
- [ ] 慢速模式（0.5x）下，精灵球摇动动画时长延长至 2 倍
- [ ] 慢速模式下，投掷窗口圆环收缩速度降至 50%
- [ ] 战斗场景可独立调节速度，躲避窗口相应扩大
- [ ] PVP 模式下节奏控制禁用，显示提示信息
- [ ] 设置持久化到 localStorage，刷新页面后保持
- [ ] 设置同步到 user-service，跨设备登录后自动恢复
- [ ] 界面显示当前速度倍率徽章（非 1.0x 时）
- [ ] 预设模式一键切换（无障碍/轻松/标准/老玩家）
- [ ] E2E 测试覆盖：慢速模式捕捉成功、战斗躲避成功

## 6. 工作量估算

**M（中等）**
- 理由：核心逻辑集中在客户端，涉及 3 个模块改造（CatchEngine、BattleUI、Settings），UI 组件较简单，不需要服务器核心逻辑修改

## 7. 优先级理由

P2 理由：
1. **影响范围明确**：主要惠及运动障碍和认知障碍用户群体，属于 WCAG 2.1 AAA 级要求
2. **不影响核心体验**：大部分用户不会使用此功能，但对特定群体至关重要
3. **技术风险低**：仅客户端时间缩放，不涉及服务器逻辑
4. **合规加分项**：符合 Xbox/PlayStation 无障碍设计指南，有助于应用商店审核
5. **边际成本低**：一次开发，长期受益，无需持续维护

## 实现记录（2026-09-25）

> 按 2026-09-25 起的验证方式：只写代码与测试，未启动服务做验证；✅ = 代码已实现、待验证。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 在无障碍设置面板可调节捕捉场景速度（0.5x/0.75x/1.0x/1.25x/1.5x） | ✅ | 设置 → 游戏节奏：捕捉速度 0.25/0.5/0.75/1.0/1.25/1.5/2.0x |
| 慢速模式（0.5x）下，精灵球摇动动画时长延长至 2 倍 | ⚠️ | 全部 CSS/WAAPI 动画 playbackRate = 倍率（0.5x 时长 ×2，e2e 校验 3s 动画有效时长 6s）；CatchEngine 的粒子摇动特效（effects/ParticleSystem）当前客户端未启用，未单独缩放 |
| 慢速模式下，投掷窗口圆环收缩速度降至 50% | ✅ | `CatchEngine.timeScale` 缩放圆环收缩步长（判定用），index.html 显示圆环步长同样乘 timeScale（e2e 测得 0.5x 下 500ms 变化 7.5%，1.0x 约 15%） |
| 战斗场景可独立调节速度，躲避窗口相应扩大 | ❌ | `pace.battle` 与 `PMG_A11Y.battleTiming(ms)` 已提供，但客户端没有战斗界面可接入，躲避窗口未实际扩大 |
| PVP 模式下节奏控制禁用，显示提示信息 | ⚠️ | `PMG_A11Y.setCompetitive("pvp")` 或 `pmg:battle` 事件 mode=pvp 时强制 1.0x 并显示"竞技模式：辅助已禁用"；客户端暂无 PVP 入口 |
| 设置持久化到 localStorage，刷新页面后保持 | ✅ | localStorage，刷新后保持 |
| 设置同步到 user-service，跨设备登录后自动恢复 | ✅ | 登录/启动时拉取云端偏好（云端较新覆盖本地），修改后 600ms 防抖 PUT |
| 界面显示当前速度倍率徽章（非 1.0x 时） | ✅ | 右下角"⏱ 速度 x 倍"徽章（非 1.0x 时） |
| 预设模式一键切换（无障碍/轻松/标准/老玩家） | ✅ | 无障碍 0.5x / 轻松 0.75x / 标准 / 老玩家 1.25x 一键切换；`-`/`=` 快捷键 |
| E2E 测试覆盖：慢速模式捕捉成功、战斗躲避成功 | ⚠️ | e2e 覆盖慢速圆环与一键投掷捕捉成功；战斗躲避无界面可测 |

- 入口：`frontend/game-client/index.html` → `src/bootstrap/features.js` → `src/bootstrap/a11y.js` 的 `initAccessibility(ctx)`；设置入口「我的 → 无障碍设置」（`window.showAccessibilitySettings`，或按 `,`），模块在 `src/accessibility/`
- 迁移：`database/migrations/20260925_010000__user_preferences.sql`（`user_preferences`：user_id UUID → users(id) ON DELETE CASCADE、namespace、prefs JSONB，主键 (user_id, namespace)，全部 IF NOT EXISTS）；偏好云端同步：user-service `GET/PUT/DELETE /users/me/preferences/:namespace`（`src/routes/preferences.js` + `src/services/userPreferences.js` 校验），经网关 `/v1/users/me/preferences/a11y`（网关已有 `/v1/users` 鉴权代理，未改网关）
- 测试：前端纯逻辑单测 `node --test frontend/game-client/tests/a11y/unit.test.mjs frontend/game-client/tests/a11y/voice.test.mjs`（宿主机已运行 63/63 通过）；后端单测 `cd backend && node --test tests/unit/a11y-backend.test.js`（宿主机已运行 9/9，已加入 `npm run test:unit`）；服务冒烟 `BASE_URL=<网关> node scripts/smoke-a11y.js`；浏览器 e2e `BASE_URL=<网关> APP_URL=<客户端> NODE_PATH=<playwright-core+axe-core> node scripts/e2e-a11y.js`；性能 `scripts/bench-a11y-client.js`。验证方式调整前曾在 CI 栈跑过一次：smoke-a11y 17/17、e2e 60/60（之后新增的用例未运行，**待验证**）
- 待验证：慢速模式下完整捕捉一次；战斗界面接入后补战斗节奏；硬件相关（振动/手柄/Web Speech）以模拟对象测试，⚠️ 真机未验证
- 备注：未完成：战斗场景节奏（客户端无战斗界面，接入点 `battleTiming()` 已就绪）。
- 使用与接入文档：`docs/accessibility/a11y-guide.md`
