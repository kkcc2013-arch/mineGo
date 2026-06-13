# REQ-00171：游戏触觉反馈增强系统

- **编号**：REQ-00171
- **类别**：前端体验
- **优先级**：P1
- **状态**：done
- **涉及服务/模块**：game-client、frontend/game-client/src/haptics、frontend/game-client/src/game/CatchEngine.js、frontend/game-client/src/audio/AudioManager.js
- **创建时间**：2026-06-13 22:00
- **依赖需求**：无

## 1. 背景与问题

当前游戏客户端的触觉反馈（haptic feedback）实现较为简单：

1. **反馈类型单一**：仅使用了基础的 `navigator.vibrate(200)` 和 `navigator.vibrate(50)`，缺乏差异化的震动模式
2. **场景覆盖不全**：仅在通知和静音时有震动反馈，捕捉投掷、精灵出现、战斗等核心场景缺少触觉反馈
3. **无震动配置**：用户无法自定义震动强度、开关，无法在静音模式下仅通过触觉感知游戏状态
4. **设备适配不足**：未区分支持 Vibration API 的设备和不支持的设备，未针对不同设备能力优化体验

触觉反馈对于移动游戏体验至关重要，它能：
- 增强操作确认感（投球、点击按钮）
- 提供状态提示（捕捉成功/失败、精灵逃跑）
- 在静音环境下替代音效，保持游戏沉浸感

## 2. 目标

建立完整的触觉反馈系统，提升移动端游戏操作的触感体验：

- 支持 15+ 种差异化震动模式，覆盖捕捉、战斗、UI 交互、成就等场景
- 提供用户可配置的震动强度（弱/中/强/关闭）
- 实现震动模式的优雅降级，兼容不支持 Vibration API 的设备
- 在静音模式下自动增强触觉反馈替代音效

## 3. 范围

- **包含**：
  - HapticManager 核心模块设计与实现
  - 15+ 种预定义震动模式
  - 用户震动偏好设置界面（设置面板集成）
  - CatchEngine、BattleScene、UI 组件触觉集成
  - 静音模式下的触觉增强逻辑

- **不包含**：
  - iOS Taptic Engine 特殊 API 支持（使用标准 Vibration API）
  - 自定义震动模式编辑器
  - 服务端触觉反馈存储

## 4. 详细需求

### 4.1 HapticManager 核心模块

创建 `frontend/game-client/src/haptics/HapticManager.js`：

```javascript
class HapticManager {
  // 震动强度等级
  static INTENSITY = {
    OFF: 0,
    LIGHT: 1,
    MEDIUM: 2,
    STRONG: 3
  };

  // 预定义震动模式（毫秒数组）
  static PATTERNS = {
    // UI 交互
    'tap': [10],
    'button_press': [15],
    'toggle_on': [20, 50, 20],
    'toggle_off': [40],
    'dialog_open': [30],
    'dialog_close': [20],
    
    // 捕捉场景
    'catch_throw': [25, 30, 10],
    'catch_hit': [50],
    'catch_shake_1': [30],
    'catch_shake_2': [30, 50, 30],
    'catch_shake_3': [30, 50, 30, 50, 30],
    'catch_success': [100, 50, 30, 50, 100],
    'catch_escape': [60, 30, 60],
    'catch_fled': [200, 100, 200],
    'throw_excellent': [30, 20, 30, 20, 80],
    'throw_great': [20, 30, 60],
    'throw_nice': [40],
    
    // 战斗场景
    'battle_start': [100, 50, 100],
    'battle_attack': [40],
    'battle_hit': [60],
    'battle_crit': [30, 20, 30, 60],
    'battle_dodge': [20],
    'battle_win': [100, 50, 50, 50, 100],
    'battle_lose': [200, 100, 200, 100, 200],
    
    // 成就/奖励
    'level_up': [100, 50, 50, 50, 50, 50, 150],
    'achievement': [80, 40, 80, 40, 150],
    'reward': [50, 30, 50],
    
    // 精灵出现
    'pokemon_spawn_nearby': [50, 100, 50],
    'pokemon_spawn_rare': [100, 50, 100, 50, 200],
    'pokemon_spawn_legendary': [200, 100, 100, 50, 50, 50, 200],
    
    // 警告/错误
    'warning': [100, 50, 100],
    'error': [150, 50, 150],
    'low_battery': [200, 100, 200, 100, 200],
    
    // 导航
    'map_scroll': [5],
    'map_zoom': [10],
    'direction_change': [15]
  };

  // 根据强度缩放震动模式
  static scalePattern(pattern, intensity) {
    if (intensity === 0) return [];
    const scale = intensity === 1 ? 0.5 : intensity === 2 ? 1 : 1.5;
    return pattern.map((v, i) => Math.round(v * (i % 2 === 0 ? scale : 1)));
  }
}
```

### 4.2 设置存储

震动偏好存储在 localStorage：

```javascript
{
  "haptic_enabled": true,
  "haptic_intensity": 2,  // 0-3
  "haptic_in_silent_mode": true  // 静音时自动增强
}
```

### 4.3 核心场景集成

**捕捉场景集成点**：
- `CatchEngine.throw()` → 触发 `catch_throw`
- `CatchEngine._onBallHit()` → 触发 `catch_hit`
- `CatchEngine._onShake()` → 触发 `catch_shake_1/2/3`（根据摇晃次数）
- `CatchEngine._onCaught()` → 触发 `catch_success`
- `CatchEngine._onFled()` → 触发 `catch_fled`

**战斗场景集成点**：
- `BattleScene.start()` → 触发 `battle_start`
- `BattleScene.attack()` → 触发 `battle_attack`
- `BattleScene.onHit()` → 触发 `battle_hit`
- `BattleScene.onWin()` → 触发 `battle_win`

### 4.4 静音模式联动

当 `AudioManager.muted === true` 且 `haptic_in_silent_mode === true`：
- 自动将震动强度提升一级（最高 STRONG）
- 为原本只有音效的操作添加触觉反馈

### 4.5 设备兼容性处理

```javascript
// 检测 Vibration API 支持
isSupported() {
  return 'vibrate' in navigator;
}

// iOS 需要用户交互后才能触发震动
// 在第一次 touchstart 时解锁
unlockOnUserGesture() {
  document.addEventListener('touchstart', () => {
    this._unlocked = true;
  }, { once: true });
}
```

### 4.6 设置界面

在游戏设置面板添加"震动"选项：

```
[震动设置]
┌────────────────────────────────┐
│ 震动反馈      [开关]           │
│ 震动强度      ○轻 ●中 ○强     │
│ 静音时增强    [开关]           │
└────────────────────────────────┘
```

## 5. 验收标准（可测试）

- [ ] HapticManager 模块可独立导入使用
- [ ] 支持至少 15 种预定义震动模式
- [ ] 用户可在设置中调整震动强度（弱/中/强/关闭）
- [ ] 捕捉场景（投掷、命中、捕捉成功/失败）有对应触觉反馈
- [ ] 战斗场景（攻击、命中、胜利/失败）有对应触觉反馈
- [ ] 静音模式下触觉反馈自动增强
- [ ] 不支持 Vibration API 的设备优雅降级（无报错）
- [ ] 震动偏好设置可持久化到 localStorage

## 6. 工作量估算

**M（中等）**

- HapticManager 核心模块：2 小时
- 震动模式定义：1 小时
- 场景集成（捕捉、战斗、UI）：3 小时
- 设置界面：1 小时
- 测试与调试：1 小时

总计：约 8 小时

## 7. 优先级理由

P1 理由：
- 移动端游戏核心体验优化，触觉反馈是提升沉浸感的重要手段
- 实现难度适中，影响面可控
- 用户反馈中常有"想要震动反馈"的诉求
- 对静音场景下的游戏体验有显著提升
