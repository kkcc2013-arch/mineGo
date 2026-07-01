# REQ-00414：动作障碍辅助模式系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00414 |
| 标题 | 动作障碍辅助模式系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、shared/config、admin-dashboard |
| 创建时间 | 2026-07-01 16:00 |

## 需求描述

为动作障碍玩家提供完整的游戏辅助功能，包括单手操作模式、自定义手势、按键持续时间调节、目标锁定增强、自动辅助瞄准等，确保动作障碍玩家能够完整体验游戏核心玩法。

### 目标用户
- 单手/单臂操作受限玩家
- 精细运动障碍玩家（帕金森、脑瘫等）
- 反应时间受限玩家
- 手部震颤玩家
- 临时运动损伤玩家（骨折、扭伤等）

### 核心功能
1. **单手操作模式**：左侧/右侧单手布局切换
2. **自定义手势系统**：简化手势、宏手势定义
3. **按键持续时间调节**：长按时间可配置（100ms-3000ms）
4. **目标锁定增强**：智能目标选择、锁定优先级
5. **自动辅助功能**：自动瞄准辅助、自动精灵技能释放
6. **操作速度调节**：游戏节奏可降速（0.5x-1.0x）
7. **误触防护**：震颤过滤、操作确认机制

## 技术方案

### 1. 辅助模式配置管理器

```javascript
// frontend/game-client/src/accessibility/MotorAssistManager.js

class MotorAssistManager {
  constructor() {
    // 辅助模式配置
    this.config = {
      enabled: false,
      handedness: 'right',      // 'left' | 'right' | 'both'
      gestureSimplification: false,
      tapDuration: {
        min: 100,              // 最小点击持续时间（ms）
        max: 3000,             // 最大长按识别时间（ms）
        defaultLongPress: 800  // 默认长按时间
      },
      tremorFilter: {
        enabled: false,
        sensitivity: 'medium', // 'low' | 'medium' | 'high'
        stabilizationRadius: 20 // 防抖半径（像素）
      },
      targetLock: {
        enabled: false,
        autoSelectNearest: true,
        lockDistance: 100,      // 锁定距离阈值
        priorityMode: 'nearest' // 'nearest' | 'weakest' | 'rarest'
      },
      autoAim: {
        enabled: false,
        assistLevel: 'moderate', // 'light' | 'moderate' | 'strong'
        snapRadius: 30          // 吸附半径
      },
      speedAdjustment: {
        enabled: false,
        factor: 1.0,           // 0.5 - 1.0
        affectedMechanics: ['catch', 'battle', 'ar'] // 受影响的游戏机制
      },
      misclickProtection: {
        enabled: false,
        confirmationDelay: 0,   // 确认延迟（ms）
        doubleTapToConfirm: false,
        holdToActivate: false
      }
    };
    
    // 加载用户配置
    this.loadUserConfig();
    
    // 状态追踪
    this.state = {
      lastInputTime: 0,
      pendingAction: null,
      lockedTarget: null,
      tremorBuffer: []
    };
  }
  
  /**
   * 启用辅助模式
   */
  enable(profile = 'default') {
    const profiles = {
      'oneHanded': this.getOneHandedProfile(),
      'tremor': this.getTremorProfile(),
      'slowReaction': this.getSlowReactionProfile(),
      'limitedRange': this.getLimitedRangeProfile(),
      'default': this.config
    };
    
    this.config = { ...this.config, ...profiles[profile], enabled: true };
    this._applyConfig();
    this._notifyModeChange(true);
    
    // 记录分析事件
    this._trackEvent('motor_assist_enabled', { profile });
  }
  
  /**
   * 单手操作配置
   */
  getOneHandedProfile() {
    return {
      handedness: 'right',
      gestureSimplification: true,
      tapDuration: { min: 150, max: 2000, defaultLongPress: 600 },
      targetLock: { enabled: true, autoSelectNearest: true },
      misclickProtection: { enabled: true, doubleTapToConfirm: true }
    };
  }
  
  /**
   * 震颤过滤配置
   */
  getTremorProfile() {
    return {
      tremorFilter: {
        enabled: true,
        sensitivity: 'high',
        stabilizationRadius: 30
      },
      misclickProtection: {
        enabled: true,
        confirmationDelay: 200,
        holdToActivate: true
      },
      tapDuration: { min: 200, max: 3000, defaultLongPress: 1000 }
    };
  }
  
  /**
   * 反应时间受限配置
   */
  getSlowReactionProfile() {
    return {
      speedAdjustment: {
        enabled: true,
        factor: 0.7,
        affectedMechanics: ['catch', 'battle']
      },
      targetLock: { enabled: true, priorityMode: 'nearest' },
      autoAim: { enabled: true, assistLevel: 'strong', snapRadius: 50 }
    };
  }
  
  /**
   * 运动范围受限配置
   */
  getLimitedRangeProfile() {
    return {
      targetLock: {
        enabled: true,
        autoSelectNearest: true,
        lockDistance: 200
      },
      autoAim: { enabled: true, assistLevel: 'moderate', snapRadius: 40 }
    };
  }
  
  /**
   * 处理触摸输入（带震颤过滤）
   */
  processTouch(x, y, timestamp) {
    // 震颤过滤
    if (this.config.tremorFilter.enabled) {
      const stabilized = this._applyTremorFilter(x, y);
      x = stabilized.x;
      y = stabilized.y;
    }
    
    // 目标锁定增强
    if (this.config.targetLock.enabled) {
      const target = this._findLockedTarget(x, y);
      if (target) {
        return { x: target.x, y: target.y, locked: true, target };
      }
    }
    
    // 自动瞄准辅助
    if (this.config.autoAim.enabled) {
      const snapped = this._applyAutoAim(x, y);
      return { x: snapped.x, y: snapped.y, snapped: true };
    }
    
    return { x, y };
  }
  
  /**
   * 震颤过滤算法
   */
  _applyTremorFilter(x, y) {
    const now = Date.now();
    this.state.tremorBuffer.push({ x, y, timestamp: now });
    
    // 保持最近 100ms 的数据点
    const cutoff = now - 100;
    this.state.tremorBuffer = this.state.tremorBuffer
      .filter(p => p.timestamp > cutoff);
    
    if (this.state.tremorBuffer.length < 3) {
      return { x, y };
    }
    
    // 计算加权平均位置
    const radius = this.config.tremorFilter.stabilizationRadius;
    let sumX = 0, sumY = 0, totalWeight = 0;
    
    this.state.tremorBuffer.forEach((point, i) => {
      const weight = (i + 1) / this.state.tremorBuffer.length;
      sumX += point.x * weight;
      sumY += point.y * weight;
      totalWeight += weight;
    });
    
    const avgX = sumX / totalWeight;
    const avgY = sumY / totalWeight;
    
    // 如果偏离超过稳定半径，则平滑过渡
    const dx = x - avgX;
    const dy = y - avgY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    if (distance > radius) {
      const factor = radius / distance;
      return {
        x: avgX + dx * factor * 0.3,
        y: avgY + dy * factor * 0.3
      };
    }
    
    return { x: avgX, y: avgY };
  }
  
  /**
   * 目标锁定查找
   */
  _findLockedTarget(x, y) {
    const gameObjects = this._getActiveGameObjects();
    const threshold = this.config.targetLock.lockDistance;
    
    let nearestTarget = null;
    let nearestDistance = Infinity;
    
    gameObjects.forEach(obj => {
      const dx = obj.x - x;
      const dy = obj.y - y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < threshold && distance < nearestDistance) {
        nearestDistance = distance;
        nearestTarget = obj;
      }
    });
    
    if (nearestTarget && this.config.targetLock.autoSelectNearest) {
      this.state.lockedTarget = nearestTarget;
      return nearestTarget;
    }
    
    return null;
  }
  
  /**
   * 自动瞄准吸附
   */
  _applyAutoAim(x, y) {
    const targets = this._getActiveGameObjects();
    const snapRadius = this.config.autoAim.snapRadius;
    
    for (const target of targets) {
      const dx = target.x - x;
      const dy = target.y - y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      if (distance < snapRadius) {
        // 根据辅助等级计算吸附强度
        const assistFactors = { light: 0.3, moderate: 0.5, strong: 0.8 };
        const factor = assistFactors[this.config.autoAim.assistLevel];
        
        return {
          x: x + dx * factor,
          y: y + dy * factor
        };
      }
    }
    
    return { x, y };
  }
  
  /**
   * 处理按键持续时间
   */
  processTapDuration(duration) {
    const { min, max, defaultLongPress } = this.config.tapDuration;
    
    // 短按过滤（防止误触）
    if (duration < min) {
      return { type: 'rejected', reason: 'too_short' };
    }
    
    // 长按识别
    if (duration >= defaultLongPress) {
      return { type: 'longPress', duration };
    }
    
    // 普通点击
    return { type: 'tap', duration };
  }
  
  /**
   * 误触保护确认
   */
  async confirmAction(action) {
    const { misclickProtection } = this.config;
    
    if (!misclickProtection.enabled) {
      return { confirmed: true };
    }
    
    // 双击确认
    if (misclickProtection.doubleTapToConfirm) {
      return new Promise(resolve => {
        this.state.pendingAction = {
          action,
          resolve,
          timeout: setTimeout(() => {
            this.state.pendingAction = null;
            resolve({ confirmed: false, reason: 'timeout' });
          }, 2000)
        };
      });
    }
    
    // 按住激活
    if (misclickProtection.holdToActivate) {
      return new Promise(resolve => {
        const holdTime = this.config.tapDuration.defaultLongPress;
        setTimeout(() => {
          resolve({ confirmed: true });
        }, holdTime);
      });
    }
    
    // 延迟确认
    if (misclickProtection.confirmationDelay > 0) {
      await new Promise(r => setTimeout(r, misclickProtection.confirmationDelay));
    }
    
    return { confirmed: true };
  }
  
  /**
   * 应用游戏速度调整
   */
  applySpeedAdjustment(originalSpeed, mechanic) {
    if (!this.config.speedAdjustment.enabled) {
      return originalSpeed;
    }
    
    if (!this.config.speedAdjustment.affectedMechanics.includes(mechanic)) {
      return originalSpeed;
    }
    
    return originalSpeed * this.config.speedAdjustment.factor;
  }
}

module.exports = MotorAssistManager;
```

### 2. 单手操作布局系统

```javascript
// frontend/game-client/src/accessibility/OneHandedLayoutManager.js

class OneHandedLayoutManager {
  constructor() {
    this.layouts = {
      right: this.getRightHandedLayout(),
      left: this.getLeftHandedLayout(),
      default: this.getDefaultLayout()
    };
    
    this.currentLayout = 'default';
    this.transitionDuration = 300;
  }
  
  /**
   * 右手操作布局
   */
  getRightHandedLayout() {
    return {
      joystick: {
        position: { x: '20%', y: '70%' },
        size: 120,
        reach: 'thumb'
      },
      actionButtons: {
        catch: { position: { x: '80%', y: '75%' }, size: 80 },
        battle: { position: { x: '65%', y: '80%' }, size: 60 },
        bag: { position: { x: '80%', y: '60%' }, size: 50 },
        map: { position: { x: '65%', y: '65%' }, size: 50 }
      },
      quickActions: {
        position: { x: '90%', y: '30%' },
        arrangement: 'vertical'
      },
      menu: {
        position: { x: '85%', y: '5%' }
      }
    };
  }
  
  /**
   * 左手操作布局
   */
  getLeftHandedLayout() {
    return {
      joystick: {
        position: { x: '80%', y: '70%' },
        size: 120,
        reach: 'thumb'
      },
      actionButtons: {
        catch: { position: { x: '20%', y: '75%' }, size: 80 },
        battle: { position: { x: '35%', y: '80%' }, size: 60 },
        bag: { position: { x: '20%', y: '60%' }, size: 50 },
        map: { position: { x: '35%', y: '65%' }, size: 50 }
      },
      quickActions: {
        position: { x: '10%', y: '30%' },
        arrangement: 'vertical'
      },
      menu: {
        position: { x: '15%', y: '5%' }
      }
    };
  }
  
  /**
   * 应用布局
   */
  applyLayout(handedness) {
    const layout = this.layouts[handedness];
    if (!layout) return;
    
    this.currentLayout = handedness;
    
    // 动画过渡
    Object.entries(layout).forEach(([element, config]) => {
      this._animateElement(element, config);
    });
    
    // 保存偏好
    localStorage.setItem('oneHandedLayout', handedness);
  }
  
  /**
   * 动画元素位置
   */
  _animateElement(elementId, config) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    element.style.transition = `all ${this.transitionDuration}ms ease`;
    
    if (config.position) {
      element.style.left = config.position.x;
      element.style.top = config.position.y;
    }
    
    if (config.size) {
      element.style.width = `${config.size}px`;
      element.style.height = `${config.size}px`;
    }
  }
  
  /**
   * 获取触达热区
   */
  getReachZones(handedness) {
    const layout = this.layouts[handedness];
    return {
      primary: {
        center: layout.joystick.position,
        radius: 150,
        description: '主要操作区域'
      },
      secondary: {
        center: layout.actionButtons.catch.position,
        radius: 100,
        description: '次要操作区域'
      },
      extended: {
        center: layout.quickActions.position,
        radius: 80,
        description: '扩展操作区域'
      }
    };
  }
}

module.exports = OneHandedLayoutManager;
```

### 3. 简化手势系统

```javascript
// frontend/game-client/src/accessibility/SimplifiedGestureSystem.js

class SimplifiedGestureSystem {
  constructor() {
    // 标准手势映射
    this.gestureMappings = {
      // 简化的捕捉手势
      'simpleCatch': {
        original: 'spiral',
        simplified: 'doubleTap',
        description: '双击代替画圈捕捉'
      },
      // 简化的投掷手势
      'simpleThrow': {
        original: 'swipeUp',
        simplified: 'tapHold',
        description: '长按代替上滑投掷'
      },
      // 简化的躲避手势
      'simpleDodge': {
        original: 'swipeDirection',
        simplified: 'tapZone',
        description: '点击区域代替滑动躲避'
      }
    };
    
    // 宏手势定义
    this.macroGestures = {
      'quickCatch': {
        sequence: ['tap', 'tap', 'hold'],
        action: 'instantCatch',
        cooldown: 3000
      },
      'quickBattle': {
        sequence: ['swipeUp', 'tap'],
        action: 'enterBattle',
        cooldown: 2000
      }
    };
    
    this.enabled = false;
    this.gestureBuffer = [];
    this.lastMacroTime = 0;
  }
  
  /**
   * 启用简化手势
   */
  enable() {
    this.enabled = true;
    this.gestureBuffer = [];
  }
  
  /**
   * 处理输入事件
   */
  processInput(event) {
    if (!this.enabled) return { handled: false };
    
    // 记录手势
    this.gestureBuffer.push({
      type: event.type,
      timestamp: Date.now(),
      position: event.position
    });
    
    // 保持最近 2 秒的手势
    const cutoff = Date.now() - 2000;
    this.gestureBuffer = this.gestureBuffer.filter(g => g.timestamp > cutoff);
    
    // 检查宏手势
    const macroMatch = this._matchMacroGesture();
    if (macroMatch) {
      return { handled: true, action: macroMatch.action };
    }
    
    // 检查简化手势映射
    const simplifiedMatch = this._matchSimplifiedGesture(event);
    if (simplifiedMatch) {
      return { handled: true, action: simplifiedMatch.action };
    }
    
    return { handled: false };
  }
  
  /**
   * 匹配宏手势
   */
  _matchMacroGesture() {
    const now = Date.now();
    
    for (const [name, macro] of Object.entries(this.macroGestures)) {
      // 检查冷却时间
      if (now - this.lastMacroTime < macro.cooldown) continue;
      
      // 匹配手势序列
      const recentGestures = this.gestureBuffer
        .slice(-macro.sequence.length)
        .map(g => g.type);
      
      if (JSON.stringify(recentGestures) === JSON.stringify(macro.sequence)) {
        this.lastMacroTime = now;
        this.gestureBuffer = [];
        return { name, action: macro.action };
      }
    }
    
    return null;
  }
  
  /**
   * 匹配简化手势
   */
  _matchSimplifiedGesture(event) {
    for (const [name, mapping] of Object.entries(this.gestureMappings)) {
      if (event.type === mapping.simplified) {
        return {
          name,
          action: mapping.original,
          description: mapping.description
        };
      }
    }
    return null;
  }
  
  /**
   * 定义自定义宏手势
   */
  defineMacro(name, sequence, action, cooldown = 2000) {
    this.macroGestures[name] = { sequence, action, cooldown };
  }
}

module.exports = SimplifiedGestureSystem;
```

### 4. 操作速度调节器

```javascript
// frontend/game-client/src/accessibility/SpeedAdjuster.js

class SpeedAdjuster {
  constructor() {
    this.factor = 1.0;  // 0.5 - 1.0
    this.affectedMechanics = new Set();
    this.enabled = false;
    
    // 游戏机制的时间因子配置
    this.mechanicConfigs = {
      'catch': {
        originalDuration: 10000,  // 捕捉窗口（ms）
        minDuration: 20000
      },
      'battle': {
        originalTurnTime: 30000,  // 回合时间（ms）
        minTurnTime: 60000
      },
      'ar': {
        originalSpawnTime: 5000,  // 精灵出现时间
        minSpawnTime: 10000
      },
      'pvp': {
        originalTime: 20000,
        minTime: 40000
      }
    };
  }
  
  /**
   * 设置速度因子
   */
  setFactor(factor) {
    this.factor = Math.max(0.5, Math.min(1.0, factor));
    this.enabled = this.factor < 1.0;
    
    // 通知游戏系统
    this._broadcastSpeedChange();
  }
  
  /**
   * 获取调整后的时间
   */
  getAdjustedTime(mechanic, originalTime) {
    if (!this.enabled || !this.affectedMechanics.has(mechanic)) {
      return originalTime;
    }
    
    const config = this.mechanicConfigs[mechanic];
    const adjusted = originalTime * (1 / this.factor);
    
    // 不超过最小时间限制
    if (config) {
      return Math.min(adjusted, config.minDuration || adjusted);
    }
    
    return adjusted;
  }
  
  /**
   * 获取调整后的动画速度
   */
  getAdjustedAnimation(originalSpeed) {
    if (!this.enabled) return originalSpeed;
    return originalSpeed * this.factor;
  }
  
  /**
   * 启用特定机制的调整
   */
  enableMechanic(mechanic) {
    this.affectedMechanics.add(mechanic);
  }
  
  /**
   * 禁用特定机制的调整
   */
  disableMechanic(mechanic) {
    this.affectedMechanics.delete(mechanic);
  }
  
  /**
   * 广播速度变化
   */
  _broadcastSpeedChange() {
    window.dispatchEvent(new CustomEvent('speedFactorChanged', {
      detail: {
        factor: this.factor,
        affectedMechanics: Array.from(this.affectedMechanics)
      }
    }));
  }
}

module.exports = SpeedAdjuster;
```

### 5. 辅助模式设置界面

```vue
<!-- frontend/game-client/src/views/settings/MotorAssistSettings.vue -->

<template>
  <div class="motor-assist-settings">
    <h2>动作障碍辅助设置</h2>
    
    <!-- 预设配置选择 -->
    <section class="preset-section">
      <h3>快速配置</h3>
      <div class="preset-grid">
        <button 
          v-for="preset in presets" 
          :key="preset.id"
          :class="['preset-card', { active: activePreset === preset.id }]"
          @click="applyPreset(preset.id)">
          <div class="preset-icon">{{ preset.icon }}</div>
          <div class="preset-name">{{ preset.name }}</div>
          <div class="preset-desc">{{ preset.description }}</div>
        </button>
      </div>
    </section>
    
    <!-- 单手操作设置 -->
    <section class="handedness-section">
      <h3>单手操作模式</h3>
      <div class="toggle-group">
        <button 
          :class="{ active: handedness === 'right' }"
          @click="setHandedness('right')">
          右手操作
        </button>
        <button 
          :class="{ active: handedness === 'left' }"
          @click="setHandedness('left')">
          左手操作
        </button>
        <button 
          :class="{ active: handedness === 'default' }"
          @click="setHandedness('default')">
          双手操作
        </button>
      </div>
      
      <div class="layout-preview">
        <div class="phone-frame" :class="handedness">
          <!-- 布局预览 -->
        </div>
      </div>
    </section>
    
    <!-- 按键持续时间 -->
    <section class="timing-section">
      <h3>按键持续时间</h3>
      <div class="slider-group">
        <label>长按识别时间</label>
        <input 
          type="range" 
          v-model="longPressDuration"
          min="200" 
          max="2000" 
          step="100">
        <span>{{ longPressDuration }}ms</span>
      </div>
      
      <div class="slider-group">
        <label>最小点击时间</label>
        <input 
          type="range" 
          v-model="minTapDuration"
          min="50" 
          max="500" 
          step="50">
        <span>{{ minTapDuration }}ms</span>
      </div>
    </section>
    
    <!-- 震颤过滤 -->
    <section class="tremor-section">
      <h3>震颤过滤</h3>
      <div class="toggle-row">
        <span>启用震颤过滤</span>
        <input type="checkbox" v-model="tremorFilterEnabled">
      </div>
      
      <div class="slider-group" v-if="tremorFilterEnabled">
        <label>过滤强度</label>
        <input 
          type="range" 
          v-model="tremorSensitivity"
          min="1" 
          max="3" 
          step="1">
        <span>{{ ['低', '中', '高'][tremorSensitivity - 1] }}</span>
      </div>
      
      <div class="slider-group" v-if="tremorFilterEnabled">
        <label>稳定半径</label>
        <input 
          type="range" 
          v-model="stabilizationRadius"
          min="10" 
          max="50" 
          step="5">
        <span>{{ stabilizationRadius }}px</span>
      </div>
    </section>
    
    <!-- 目标锁定 -->
    <section class="target-lock-section">
      <h3>目标锁定</h3>
      <div class="toggle-row">
        <span>启用目标锁定</span>
        <input type="checkbox" v-model="targetLockEnabled">
      </div>
      
      <div class="radio-group" v-if="targetLockEnabled">
        <label>锁定优先级</label>
        <label>
          <input type="radio" v-model="targetPriority" value="nearest"> 最近目标
        </label>
        <label>
          <input type="radio" v-model="targetPriority" value="weakest"> 最弱目标
        </label>
        <label>
          <input type="radio" v-model="targetPriority" value="rarest"> 稀有目标
        </label>
      </div>
    </section>
    
    <!-- 自动辅助 -->
    <section class="auto-assist-section">
      <h3>自动辅助</h3>
      <div class="toggle-row">
        <span>自动瞄准辅助</span>
        <input type="checkbox" v-model="autoAimEnabled">
      </div>
      
      <div class="slider-group" v-if="autoAimEnabled">
        <label>辅助强度</label>
        <input 
          type="range" 
          v-model="autoAimLevel"
          min="1" 
          max="3" 
          step="1">
        <span>{{ ['轻微', '中等', '强力'][autoAimLevel - 1] }}</span>
      </div>
      
      <div class="toggle-row">
        <span>自动技能释放（战斗中）</span>
        <input type="checkbox" v-model="autoSkillEnabled">
      </div>
    </section>
    
    <!-- 游戏速度 -->
    <section class="speed-section">
      <h3>游戏速度调整</h3>
      <div class="toggle-row">
        <span>启用速度调整</span>
        <input type="checkbox" v-model="speedAdjustEnabled">
      </div>
      
      <div class="slider-group" v-if="speedAdjustEnabled">
        <label>游戏速度</label>
        <input 
          type="range" 
          v-model="speedFactor"
          min="50" 
          max="100" 
          step="10">
        <span>{{ speedFactor }}%</span>
      </div>
      
      <div class="checkbox-group" v-if="speedAdjustEnabled">
        <label>应用到：</label>
        <label v-for="mechanic in mechanics" :key="mechanic.id">
          <input 
            type="checkbox" 
            :value="mechanic.id"
            v-model="affectedMechanics">
          {{ mechanic.name }}
        </label>
      </div>
    </section>
    
    <!-- 误触防护 -->
    <section class="misclick-section">
      <h3>误触防护</h3>
      <div class="toggle-row">
        <span>启用误触防护</span>
        <input type="checkbox" v-model="misclickProtectionEnabled">
      </div>
      
      <div class="toggle-row" v-if="misclickProtectionEnabled">
        <span>双击确认重要操作</span>
        <input type="checkbox" v-model="doubleTapConfirm">
      </div>
      
      <div class="toggle-row" v-if="misclickProtectionEnabled">
        <span>长按激活关键按钮</span>
        <input type="checkbox" v-model="holdToActivate">
      </div>
      
      <div class="slider-group" v-if="misclickProtectionEnabled">
        <label>确认延迟</label>
        <input 
          type="range" 
          v-model="confirmationDelay"
          min="0" 
          max="1000" 
          step="100">
        <span>{{ confirmationDelay }}ms</span>
      </div>
    </section>
    
    <!-- 测试区域 -->
    <section class="test-section">
      <h3>设置测试</h3>
      <button @click="openTestMode" class="test-button">
        进入测试模式
      </button>
    </section>
  </div>
</template>

<script>
export default {
  name: 'MotorAssistSettings',
  data() {
    return {
      presets: [
        { 
          id: 'oneHanded', 
          name: '单手模式', 
          icon: '👆',
          description: '适合单手操作玩家'
        },
        { 
          id: 'tremor', 
          name: '震颤模式', 
          icon: '🤲',
          description: '手部震颤过滤辅助'
        },
        { 
          id: 'slowReaction', 
          name: '慢速模式', 
          icon: '🐢',
          description: '延长反应时间窗口'
        },
        { 
          id: 'limitedRange', 
          name: '有限范围模式', 
          icon: '🎯',
          description: '增强目标锁定辅助'
        }
      ],
      activePreset: null,
      handedness: 'default',
      longPressDuration: 800,
      minTapDuration: 100,
      tremorFilterEnabled: false,
      tremorSensitivity: 2,
      stabilizationRadius: 20,
      targetLockEnabled: false,
      targetPriority: 'nearest',
      autoAimEnabled: false,
      autoAimLevel: 2,
      autoSkillEnabled: false,
      speedAdjustEnabled: false,
      speedFactor: 100,
      affectedMechanics: ['catch', 'battle'],
      misclickProtectionEnabled: false,
      doubleTapConfirm: false,
      holdToActivate: false,
      confirmationDelay: 0,
      mechanics: [
        { id: 'catch', name: '精灵捕捉' },
        { id: 'battle', name: '精灵战斗' },
        { id: 'ar', name: 'AR 模式' },
        { id: 'pvp', name: '玩家对战' }
      ]
    };
  },
  methods: {
    applyPreset(presetId) {
      this.activePreset = presetId;
      this.$refs.motorAssist.enable(presetId);
    },
    setHandedness(hand) {
      this.handedness = hand;
      this.$refs.layoutManager.applyLayout(hand);
    },
    openTestMode() {
      this.$router.push('/settings/motor-assist/test');
    }
  }
};
</script>
```

## 验收标准

- [ ] 单手操作布局支持左/右手切换，UI自动重新排列
- [ ] 震颤过滤能有效平滑手部震颤，可配置过滤强度（低/中/高）
- [ ] 目标锁定功能在100px范围内自动吸附目标
- [ ] 自动瞄准辅助提供三级强度（轻微/中等/强力）
- [ ] 按键持续时间可调节（100ms-3000ms范围）
- [ ] 游戏速度可在50%-100%范围内调整，不影响其他玩家PVP体验
- [ ] 误触防护支持双击确认和长按激活两种模式
- [ ] 简化手势系统支持双击代替画圈捕捉等手势简化
- [ ] 宏手势功能允许玩家自定义手势序列
- [ ] 设置界面提供实时测试区域，玩家可立即验证配置效果
- [ ] 所有辅助功能在设置界面有清晰开关，可独立启用/禁用
- [ ] 配置自动保存，下次启动自动应用
- [ ] 预设配置（单手/震颤/慢速/有限范围）一键切换
- [ ] 辅助模式状态在游戏界面有明确指示器
- [ ] 符合WCAG 2.1 AA级无障碍标准

## 影响范围

- frontend/game-client/src/accessibility/ - 新增辅助模式模块
- frontend/game-client/src/views/settings/ - 设置界面
- frontend/game-client/src/config/ - 辅助模式配置
- shared/config/accessibility-presets.json - 预设配置
- admin-dashboard - 辅助模式使用统计面板

## 参考

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Apple Accessibility Guidelines](https://developer.apple.com/accessibility/)
- [Android Accessibility Features](https://developer.android.com/guide/topics/ui/accessibility)
- Xbox Adaptive Controller 设计理念
- REQ-00356 光敏性癫痫防护系统（已完成）
- REQ-00382 音效可视化系统（已完成）
