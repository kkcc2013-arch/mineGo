# REQ-00263: 游戏节奏控制与慢速模式系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00263 |
| 标题 | 游戏节奏控制与慢速模式系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P2 |
| 状态 | new |
| 涉及服务 | game-client、frontend/game-client/src/accessibility、catch-service、gym-service、gateway |
| 创建时间 | 2026-06-18 19:00 |

## 需求描述

为有认知障碍、反应速度较慢或手部运动障碍的玩家提供游戏节奏控制功能。该系统允许玩家自定义游戏速度，减慢动画、延长交互时间窗口，确保所有玩家都能享受游戏体验。

### 核心功能
1. **全局游戏速度调节**：0.25x - 1.0x 速度范围
2. **战斗时间延长**：延长精灵捕捉、道馆战斗的反应时间
3. **动画减速**：平滑降低所有动画速度
4. **交互窗口扩展**：延长按钮点击、滑动手势的有效时间
5. **提示延迟**：增加 UI 提示显示时长

## 技术方案

### 1. 游戏节奏控制器（GamePaceController）

```javascript
// frontend/game-client/src/accessibility/GamePaceController.js

class GamePaceController {
  constructor() {
    this.paceLevel = 1.0; // 默认正常速度
    this.config = {
      0.25: { animationSpeed: 0.25, interactionTimeMultiplier: 4, hintDelay: 3000 },
      0.5: { animationSpeed: 0.5, interactionTimeMultiplier: 2, hintDelay: 2000 },
      0.75: { animationSpeed: 0.75, interactionTimeMultiplier: 1.5, hintDelay: 1500 },
      1.0: { animationSpeed: 1.0, interactionTimeMultiplier: 1, hintDelay: 1000 }
    };
    this.listeners = new Map();
  }

  setPace(level) {
    if (!this.config[level]) {
      console.warn(`Invalid pace level: ${level}`);
      return;
    }
    this.paceLevel = level;
    this.applyPaceSettings();
    this.notifyListeners('paceChanged', { level, config: this.config[level] });
  }

  applyPaceSettings() {
    const settings = this.config[this.paceLevel];
    
    // 更新全局动画速度
    document.documentElement.style.setProperty('--animation-speed', settings.animationSpeed);
    
    // 更新 requestAnimationFrame 时间缩放
    window.__GAME_TIME_SCALE__ = settings.animationSpeed;
    
    // 存储交互时间倍数
    localStorage.setItem('gamePaceLevel', this.paceLevel);
  }

  getInteractionTime(baseTime) {
    return baseTime * this.config[this.paceLevel].interactionTimeMultiplier;
  }

  getHintDelay() {
    return this.config[this.paceLevel].hintDelay;
  }

  subscribe(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.listeners.get(event).delete(callback);
  }

  notifyListeners(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(cb => cb(data));
    }
  }

  getPaceLevel() {
    return this.paceLevel;
  }

  getPresetConfig(level) {
    return this.config[level] || this.config[1.0];
  }
}

// 单例导出
export const gamePaceController = new GamePaceController();
```

### 2. 动画时间缩放适配器

```javascript
// frontend/game-client/src/accessibility/AnimationTimeScaler.js

class AnimationTimeScaler {
  constructor() {
    this.timeScale = 1.0;
    this.lastTimestamp = 0;
  }

  initialize() {
    // 监听游戏节奏变化
    gamePaceController.subscribe('paceChanged', ({ config }) => {
      this.timeScale = config.animationSpeed;
    });
    
    // 初始化时加载保存的设置
    const savedPace = localStorage.getItem('gamePaceLevel');
    if (savedPace) {
      gamePaceController.setPace(parseFloat(savedPace));
    }
  }

  // 用于 Phaser/Ticker 的时间缩放
  getScaledDelta(delta) {
    return delta * this.timeScale;
  }

  // 创建慢速动画 tween
  createSlowTween(target, properties, duration, ease = 'Linear') {
    const scaledDuration = duration / this.timeScale;
    return {
      target,
      properties,
      duration: scaledDuration,
      ease,
      timeScale: this.timeScale
    };
  }

  // CSS 动画速度适配
  getCSSAnimationDuration(baseDuration) {
    return `${baseDuration / this.timeScale}s`;
  }
}

export const animationTimeScaler = new AnimationTimeScaler();
```

### 3. 捕捉系统时间扩展

```javascript
// frontend/game-client/src/game/CatchEngine.js (增强)

class CatchEngine {
  constructor() {
    this.baseThrowWindow = 2000; // 基础投掷窗口 2 秒
    this.baseReactionTime = 1500; // 基础反应时间 1.5 秒
    this.paceController = gamePaceController;
  }

  startCatchSession(pokemon) {
    // 根据游戏节奏调整时间窗口
    const extendedWindow = this.paceController.getInteractionTime(this.baseThrowWindow);
    const extendedReaction = this.paceController.getInteractionTime(this.baseReactionTime);

    this.session = {
      pokemon,
      throwWindow: extendedWindow,
      reactionTime: extendedReaction,
      startTime: Date.now(),
      paceLevel: this.paceController.getPaceLevel()
    };

    // 发送遥测数据到后端
    this.reportCatchSessionStart(this.session);
    
    return this.session;
  }

  getRemainingTime() {
    if (!this.session) return 0;
    const elapsed = Date.now() - this.session.startTime;
    return Math.max(0, this.session.throwWindow - elapsed);
  }

  isWithinTimeWindow() {
    return this.getRemainingTime() > 0;
  }

  async reportCatchSessionStart(session) {
    try {
      await fetch('/api/v1/catch/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pokemonId: session.pokemon.id,
          paceLevel: session.paceLevel,
          extendedWindow: session.throwWindow,
          timestamp: session.startTime
        })
      });
    } catch (error) {
      console.error('Failed to report catch session:', error);
    }
  }
}
```

### 4. 道馆战斗时间扩展

```javascript
// frontend/game-client/src/game/BattleEngine.js (增强)

class BattleEngine {
  constructor() {
    this.baseTurnTime = 30000; // 基础回合时间 30 秒
    this.baseAnimationDuration = 1000; // 基础动画 1 秒
  }

  calculateTurnTime(player) {
    const baseTime = this.baseTurnTime;
    const paceLevel = gamePaceController.getPaceLevel();
    
    // 慢速模式下延长回合时间
    return gamePaceController.getInteractionTime(baseTime);
  }

  getAnimationDuration(baseAnimation) {
    return baseAnimation / gamePaceController.getPresetConfig(
      gamePaceController.getPaceLevel()
    ).animationSpeed;
  }

  async executeMove(move, attacker, defender) {
    const animationDuration = this.getAnimationDuration(this.baseAnimationDuration);
    
    // 延长技能动画
    await this.playMoveAnimation(move, attacker, defender, animationDuration);
    
    // 延长伤害显示
    await this.showDamageIndicator(defender, animationDuration * 0.5);
  }
}
```

### 5. 后端慢速模式验证

```javascript
// backend/shared/middleware/slowModeValidator.js

class SlowModeValidator {
  constructor() {
    this.validPaceLevels = [0.25, 0.5, 0.75, 1.0];
    this.maxInteractionMultiplier = 4;
  }

  validatePaceLevel(level) {
    return this.validPaceLevels.includes(level);
  }

  validateExtendedTime(baseTime, extendedTime, paceLevel) {
    const config = {
      0.25: 4,
      0.5: 2,
      0.75: 1.5,
      1.0: 1
    };
    
    const expectedMultiplier = config[paceLevel] || 1;
    const actualMultiplier = extendedTime / baseTime;
    
    // 允许 10% 误差
    return Math.abs(actualMultiplier - expectedMultiplier) <= 0.1;
  }

  // 检测滥用慢速模式
  detectAbuse(userId, sessions) {
    // 检查用户是否频繁切换节奏
    const recentPaceChanges = sessions.filter(s => s.paceChanged).length;
    
    // 检查用户是否在关键时刻切换节奏
    const criticalMomentChanges = sessions.filter(
      s => s.paceChanged && s.isCriticalMoment
    ).length;
    
    if (criticalMomentChanges > 3) {
      return {
        isAbuse: true,
        reason: 'Frequent pace changes during critical moments',
        risk: 'medium'
      };
    }
    
    return { isAbuse: false };
  }
}

export default new SlowModeValidator();
```

### 6. UI 设置界面

```javascript
// frontend/game-client/src/components/AccessibilitySettings.js

import React, { useState, useEffect } from 'react';
import { gamePaceController } from '../accessibility/GamePaceController';

function AccessibilitySettings({ onClose }) {
  const [paceLevel, setPaceLevel] = useState(1.0);
  
  useEffect(() => {
    setPaceLevel(gamePaceController.getPaceLevel());
  }, []);

  const handlePaceChange = (level) => {
    setPaceLevel(level);
    gamePaceController.setPaceLevel(level);
  };

  const paceOptions = [
    { level: 1.0, label: '正常速度', description: '标准游戏体验' },
    { level: 0.75, label: '稍慢', description: '动画减慢 25%' },
    { level: 0.5, label: '较慢', description: '动画减慢 50%，交互时间延长' },
    { level: 0.25, label: '很慢', description: '最慢模式，适合需要更多时间的玩家' }
  ];

  return (
    <div className="accessibility-settings">
      <h2>无障碍设置</h2>
      
      <section className="pace-control">
        <h3>游戏节奏控制</h3>
        <p className="description">
          调整游戏速度以适应您的游戏节奏。此功能可以帮助需要更多反应时间的玩家。
        </p>
        
        <div className="pace-options">
          {paceOptions.map(option => (
            <button
              key={option.level}
              className={`pace-option ${paceLevel === option.level ? 'active' : ''}`}
              onClick={() => handlePaceChange(option.level)}
              aria-pressed={paceLevel === option.level}
            >
              <span className="label">{option.label}</span>
              <span className="description">{option.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="preview">
        <h3>效果预览</h3>
        <div className="animation-preview" style={{
          animationDuration: `${2 / paceLevel}s`
        }}>
          动画示例
        </div>
        <p>交互时间窗口: {Math.round(2000 * (1 / paceLevel))}ms</p>
      </section>

      <button onClick={onClose} className="close-button">
        保存并关闭
      </button>
    </div>
  );
}

export default AccessibilitySettings;
```

### 7. 数据库迁移

```sql
-- database/migrations/20260618_add_pace_preferences.sql

-- 用户无障碍偏好表
CREATE TABLE IF NOT EXISTS user_accessibility_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pace_level DECIMAL(3, 2) DEFAULT 1.0,
  slow_mode_enabled BOOLEAN DEFAULT false,
  animation_reduction INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

-- 慢速模式使用日志
CREATE TABLE IF NOT EXISTS slow_mode_usage_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_type VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'explore'
  pace_level DECIMAL(3, 2) NOT NULL,
  base_time_ms INTEGER NOT NULL,
  extended_time_ms INTEGER NOT NULL,
  session_result VARCHAR(50),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_slow_mode_logs_user ON slow_mode_usage_logs(user_id);
CREATE INDEX idx_slow_mode_logs_created ON slow_mode_usage_logs(created_at);

-- 注释
COMMENT ON TABLE user_accessibility_preferences IS '用户无障碍偏好设置';
COMMENT ON TABLE slow_mode_usage_logs IS '慢速模式使用日志，用于检测滥用';
```

## 验收标准

- [ ] 玩家可以在设置中选择 0.25x、0.5x、0.75x、1.0x 四个游戏速度
- [ ] 游戏速度设置在所有游戏模块中生效（捕捉、战斗、探索）
- [ ] 捕捉投掷时间窗口随游戏速度等比例延长
- [ ] 道馆战斗回合时间随游戏速度等比例延长
- [ ] 所有动画（精灵出现、捕捉动画、战斗特效）正确减速
- [ ] UI 提示显示时间随游戏速度延长
- [ ] 游戏速度设置在游戏重启后保持
- [ ] 后端验证游戏速度设置的合法性
- [ ] 检测并防止滥用慢速模式进行作弊
- [ ] 设置界面符合 WCAG 2.1 AA 标准
- [ ] 单元测试覆盖率 ≥ 80%

## 影响范围

- `frontend/game-client/src/accessibility/GamePaceController.js` (新增)
- `frontend/game-client/src/accessibility/AnimationTimeScaler.js` (新增)
- `frontend/game-client/src/game/CatchEngine.js` (修改)
- `frontend/game-client/src/game/BattleEngine.js` (修改)
- `frontend/game-client/src/components/AccessibilitySettings.js` (新增)
- `backend/shared/middleware/slowModeValidator.js` (新增)
- `database/migrations/20260618_add_pace_preferences.sql` (新增)
- `gateway/src/routes/accessibility.js` (新增)

## 参考

- [Xbox Accessibility Guidelines - Game Speed](https://docs.microsoft.com/en-us/gaming/accessibility/guidelines/game-speed)
- [Game Accessibility Guidelines - Adjustable Game Speed](https://gameaccessibilityguidelines.com/allow-the-game-to-be-played-at-a-slower-speed/)
- [WCAG 2.1 - Enough Time](https://www.w3.org/TR/WCAG21/#enough-time)
- [Phaser 3 Time Scale](https://photonstorm.github.io/phaser3-docs/Phaser.Time.Clock.html#timeScale)
