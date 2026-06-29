# REQ-00360：精灵捕捉动作障碍玩家辅助模式系统

- **编号**：REQ-00360
- **类别**：无障碍(a11y)
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility、frontend/game-client/src/game/CatchEngine.js、gateway、user-service、backend/shared、database/migrations
- **创建时间**：2026-06-29 08:00 UTC
- **依赖需求**：REQ-00356 (光敏性癫痫防护系统)

## 1. 背景与问题

### 现状分析
mineGo 作为一款基于真实 GPS 的 AR 精灵捕捉手游，其核心游戏机制依赖于以下动作：

1. **投掷精灵球**：需要快速滑动/拖拽操作
2. **瞄准精灵**：需要精确的手指定位和时机判断
3. **点击交互**：需要快速点击捕捉窗口
4. **地图导航**：需要双指缩放、单指拖动等手势操作

### 问题识别
根据 WCAG 2.1 无障碍标准和 XG 2.1 游戏无障碍指南，当前游戏对以下动作障碍玩家群体存在障碍：

1. **上肢运动障碍玩家**（帕金森病、脑瘫、肌萎缩侧索硬化症等）
   - 无法执行精确的手势操作
   - 手部震颤导致投掷失误率高
   - 反应时间慢，错过捕捉窗口

2. **单手操作玩家**（肢体缺失、单手可用等）
   - 无法同时执行瞄准和投掷
   - 难以完成复杂手势组合

3. **精细运动障碍玩家**（类风湿关节炎、腕管综合征等）
   - 滑动距离和速度受限
   - 长时间操作导致疲劳和疼痛

4. **反应速度障碍玩家**（多发性硬化症、中风后遗症等）
   - 捕捉窗口反应时间不足
   - 难以把握投掷时机

### 代码层面问题
- `CatchEngine.js` 投掷机制依赖固定物理参数（`THROW_RING_SHRINK_RATE`）
- 缺乏动作辅助 API 和配置持久化
- 无手势简化或替代交互方案
- 捕捉难度硬编码，无法动态调整

## 2. 目标

为动作障碍玩家提供可配置的辅助功能，确保：

1. **可操作性**：所有核心游戏操作可通过辅助方式完成
2. **可定制性**：玩家可根据自身情况调整辅助强度
3. **公平性**：辅助模式不提供竞技优势，仅在单人/合作模式生效
4. **隐私保护**：辅助设置仅存储在本地，不上传服务器

### 量化目标
- 动作障碍玩家捕捉成功率从 <10% 提升至 ≥70%
- 辅助功能覆盖率：覆盖 WCAG 2.1 Level AA 标准 100%
- 辅助模式延迟开销：<50ms
- 配置项丰富度：≥15 项可调整参数

## 3. 范围

### 包含
1. **投掷辅助系统**
   - 自动瞄准辅助（可选强度：低/中/高）
   - 投掷轨迹预览线
   - 一键投掷模式（自动执行最佳投掷）
   - 投掷速度调节（慢速/正常/快速）

2. **点击时间延长系统**
   - 捕捉窗口时间延长（×1.5/×2/×3）
   - 连击时间窗口放宽
   - 点击容错半径扩大

3. **手势简化系统**
   - 单指模式（双指缩放替代为单指双击）
   - 长按替代双击
   - 自定义手势映射

4. **反馈增强系统**
   - 捕捉窗口音频提示（上升音调）
   - 最佳投掷点震动提示
   - 投掷轨迹实时语音描述

5. **疲劳管理**
   - 操作间隔提示
   - 自动暂停建议
   - 单局捕捉次数限制

6. **配置管理**
   - 辅助模式开关与强度配置
   - 配置持久化（localStorage + 可选云端同步）
   - 预设方案（轻度/中度/重度辅助）

### 不包含
- PVP 竞技模式辅助（防止竞技优势）
- 团队道馆战辅助（保持公平性）
- 第三方硬件适配（超出客户端范围）
- 语音控制模式（需要独立需求 REQ-00361）
- 眼动追踪控制（需要独立需求 REQ-00362）

## 4. 详细需求

### 4.1 投掷辅助系统

#### 4.1.1 自动瞄准辅助
```javascript
// frontend/game-client/src/accessibility/MotorAssist.js
export class AutoAimAssist {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.strength = config.strength || 'medium'; // 'low' | 'medium' | 'high'
    this.smoothing = this.getSmoothingFactor(this.strength);
    this.predictionEnabled = config.predictionEnabled || true;
    this.targetLockEnabled = config.targetLockEnabled || false;
  }

  getSmoothingFactor(strength) {
    const factors = { low: 0.3, medium: 0.6, high: 0.85 };
    return factors[strength] || 0.6;
  }

  /**
   * 计算辅助后的投掷目标点
   * @param {Object} userAim - 用户实际瞄准点 {x, y}
   * @param {Object} optimalPoint - 系统计算的最佳点 {x, y}
   * @returns {Object} 辅助后的目标点
   */
  calculateAssistedTarget(userAim, optimalPoint) {
    if (!this.enabled) return userAim;
    
    const assistedX = userAim.x + (optimalPoint.x - userAim.x) * this.smoothing;
    const assistedY = userAim.y + (optimalPoint.y - userAim.y) * this.smoothing;
    
    return { x: assistedX, y: assistedY };
  }

  /**
   * 目标锁定（仅在辅助强度为 high 时启用）
   */
  lockTarget(spawn, userPosition) {
    if (!this.targetLockEnabled || this.strength !== 'high') return null;
    
    const distance = Math.sqrt(
      Math.pow(spawn.x - userPosition.x, 2) + 
      Math.pow(spawn.y - userPosition.y, 2)
    );
    
    if (distance < 50) { // 50px 锁定阈值
      return { x: spawn.x, y: spawn.y, locked: true };
    }
    return null;
  }
}
```

#### 4.1.2 投掷轨迹预览
```javascript
// frontend/game-client/src/accessibility/TrajectoryPreview.js
export class TrajectoryPreview {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.enabled = config.enabled || false;
    this.previewColor = config.previewColor || 'rgba(255, 255, 255, 0.5)';
    this.showEstimatedLanding = config.showEstimatedLanding || true;
    this.updateInterval = 16; // 60fps
  }

  /**
   * 绘制投掷轨迹预览线
   */
  drawPreviewPath(startPoint, currentPoint, targetPoint) {
    if (!this.enabled) return;

    this.ctx.save();
    this.ctx.strokeStyle = this.previewColor;
    this.ctx.lineWidth = 3;
    this.ctx.setLineDash([10, 5]);
    
    // 绘制从当前拖动点到目标的预测轨迹
    this.ctx.beginPath();
    this.ctx.moveTo(currentPoint.x, currentPoint.y);
    
    // 贝塞尔曲线模拟抛物线
    const controlY = Math.min(currentPoint.y, targetPoint.y) - 100;
    this.ctx.quadraticCurveTo(
      currentPoint.x, controlY,
      targetPoint.x, targetPoint.y
    );
    
    this.ctx.stroke();
    
    // 绘制预计落点标记
    if (this.showEstimatedLanding) {
      this.drawLandingMarker(targetPoint);
    }
    
    this.ctx.restore();
  }

  drawLandingMarker(point) {
    this.ctx.beginPath();
    this.ctx.arc(point.x, point.y, 15, 0, Math.PI * 2);
    this.ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
    this.ctx.fill();
    this.ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
    this.ctx.stroke();
  }
}
```

#### 4.1.3 一键投掷模式
```javascript
// frontend/game-client/src/accessibility/OneClickThrow.js
export class OneClickThrow {
  constructor(catchEngine, config = {}) {
    this.engine = catchEngine;
    this.enabled = config.enabled || false;
    this.autoTiming = config.autoTiming || true;
    this.confirmBeforeThrow = config.confirmBeforeThrow || true;
    this.hapticFeedback = config.hapticFeedback || true;
  }

  /**
   * 执行自动投掷
   */
  async executeAutoThrow(spawn) {
    if (!this.enabled) return false;
    
    // 计算最佳投掷参数
    const bestTiming = await this.engine.calculateBestTiming(spawn);
    const targetPoint = this.engine.getOptimalTarget(spawn);
    
    // 如果需要确认，显示确认对话框
    if (this.confirmBeforeThrow) {
      const confirmed = await this.showConfirmationDialog(spawn, bestTiming);
      if (!confirmed) return false;
    }
    
    // 触发震动反馈
    if (this.hapticFeedback) {
      hapticManager.trigger('auto_throw_execute');
    }
    
    // 执行投掷
    return this.engine.throwBall({
      target: targetPoint,
      timing: bestTiming,
      autoAssisted: true
    });
  }

  showConfirmationDialog(spawn, timing) {
    return new Promise(resolve => {
      const dialog = document.createElement('div');
      dialog.className = 'motor-assist-confirm-dialog';
      dialog.innerHTML = `
        <h3>确认自动投掷</h3>
        <p>精灵: ${spawn.name}</p>
        <p>预计成功率: ${timing.successRate}%</p>
        <div class="buttons">
          <button id="confirm-yes">确认投掷</button>
          <button id="confirm-no">取消</button>
        </div>
      `;
      document.body.appendChild(dialog);
      
      dialog.querySelector('#confirm-yes').onclick = () => {
        dialog.remove();
        resolve(true);
      };
      dialog.querySelector('#confirm-no').onclick = () => {
        dialog.remove();
        resolve(false);
      };
    });
  }
}
```

### 4.2 点击时间延长系统

#### 4.2.1 捕捉窗口时间调节
```javascript
// frontend/game-client/src/accessibility/ClickTimeExtension.js
export class ClickTimeExtension {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.multiplier = config.multiplier || 1.5; // 1.5x | 2x | 3x
    this.ringShrinkRate = config.ringShrinkRate || 0.004;
    this.baseRingDuration = 2500; // ms
  }

  /**
   * 获取调整后的环缩速率
   */
  getAdjustedShrinkRate() {
    if (!this.enabled) return THROW_RING_SHRINK_RATE;
    return this.ringShrinkRate / this.multiplier;
  }

  /**
   * 获取调整后的捕捉窗口持续时间
   */
  getExtendedCatchWindow() {
    return this.baseRingDuration * this.multiplier;
  }

  /**
   * 计算有效点击区域扩大
   */
  getExpandedClickRadius(baseRadius) {
    if (!this.enabled) return baseRadius;
    const expansionFactors = { 1.5: 1.2, 2: 1.5, 3: 2 };
    return baseRadius * (expansionFactors[this.multiplier] || 1);
  }
}
```

### 4.3 手势简化系统

#### 4.3.1 单指模式
```javascript
// frontend/game-client/src/accessibility/SimplifiedGestures.js
export class SimplifiedGestures {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.singleFingerZoom = config.singleFingerZoom || true;
    this.longPressDoubleTap = config.longPressDoubleTap || true;
    this.customMappings = config.customMappings || new Map();
  }

  /**
   * 处理单指缩放（双击替代双指捏合）
   */
  handleSingleFingerZoom(event) {
    if (!this.enabled || !this.singleFingerZoom) return null;
    
    if (event.type === 'dblclick') {
      const zoomLevel = event.shiftKey ? 0.5 : 2.0;
      return { action: 'zoom', level: zoomLevel, center: { x: event.clientX, y: event.clientY } };
    }
    
    return null;
  }

  /**
   * 处理长按替代双击
   */
  handleLongPressSubstitute(event, longPressDuration = 500) {
    if (!this.enabled || !this.longPressDoubleTap) return null;
    
    let pressTimer;
    
    if (event.type === 'touchstart' || event.type === 'mousedown') {
      pressTimer = setTimeout(() => {
        // 触发双击等效果
        this.emit('double-tap-substitute', { x: event.clientX, y: event.clientY });
      }, longPressDuration);
      
      return { timer: pressTimer };
    }
    
    if (event.type === 'touchend' || event.type === 'mouseup') {
      clearTimeout(pressTimer);
      return { cancelled: true };
    }
    
    return null;
  }

  /**
   * 自定义手势映射
   */
  registerCustomGesture(originalGesture, substituteGesture) {
    this.customMappings.set(originalGesture, substituteGesture);
  }

  /**
   * 应用手势映射
   */
  applyGestureMapping(detectedGesture) {
    if (!this.enabled) return detectedGesture;
    
    return this.customMappings.get(detectedGesture) || detectedGesture;
  }
}
```

### 4.4 反馈增强系统

#### 4.4.1 音频提示
```javascript
// frontend/game-client/src/accessibility/AudioFeedback.js
export class AudioFeedback {
  constructor(audioContext, config = {}) {
    this.audioContext = audioContext;
    this.enabled = config.enabled || false;
    this.catchWindowAlert = config.catchWindowAlert || true;
    this.optimalThrowAlert = config.optimalThrowAlert || true;
    this.voiceDescription = config.voiceDescription || false;
  }

  /**
   * 播放捕捉窗口音频提示（上升音调）
   */
  playCatchWindowAlert() {
    if (!this.enabled || !this.catchWindowAlert) return;
    
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(200, this.audioContext.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(800, this.audioContext.currentTime + 0.5);
    
    gainNode.gain.setValueAtTime(0.3, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.5);
    
    oscillator.start();
    oscillator.stop(this.audioContext.currentTime + 0.5);
  }

  /**
   * 最佳投掷点提示音
   */
  playOptimalThrowIndicator() {
    if (!this.enabled || !this.optimalThrowAlert) return;
    
    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);
    
    oscillator.type = 'square';
    oscillator.frequency.value = 880; // A5
    
    gainNode.gain.setValueAtTime(0.2, this.audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.1);
    
    oscillator.start();
    oscillator.stop(this.audioContext.currentTime + 0.1);
  }
}
```

#### 4.4.2 震动提示
```javascript
// frontend/game-client/src/accessibility/HapticFeedback.js
export class HapticFeedback {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.patterns = {
      catch_window_enter: [100, 50, 100],
      optimal_throw_point: [200],
      throw_execute: [50, 30, 50, 30, 100],
      success: [300],
      assist_mode_active: [100, 100, 100, 100, 100]
    };
  }

  trigger(patternName) {
    if (!this.enabled || !navigator.vibrate) return;
    
    const pattern = this.patterns[patternName];
    if (pattern) {
      navigator.vibrate(pattern);
    }
  }
}
```

### 4.5 疲劳管理

#### 4.5.1 操作频率监控
```javascript
// frontend/game-client/src/accessibility/FatigueManager.js
export class FatigueManager {
  constructor(config = {}) {
    this.enabled = config.enabled || false;
    this.operationHistory = [];
    this.recommendationThreshold = config.recommendationThreshold || 50; // 操作次数
    this.autoPauseThreshold = config.autoPauseThreshold || 100;
    this.pauseDuration = config.pauseDuration || 300000; // 5分钟
    this.lastRecommendationTime = 0;
  }

  /**
   * 记录操作
   */
  recordOperation(operationType) {
    if (!this.enabled) return;
    
    this.operationHistory.push({
      type: operationType,
      timestamp: Date.now()
    });
    
    this.checkFatigueStatus();
  }

  /**
   * 检查疲劳状态
   */
  checkFatigueStatus() {
    const recentOperations = this.operationHistory.filter(
      op => Date.now() - op.timestamp < 600000 // 最近10分钟
    );
    
    if (recentOperations.length >= this.autoPauseThreshold) {
      this.triggerAutoPause();
    } else if (recentOperations.length >= this.recommendationThreshold) {
      const timeSinceLastRecommendation = Date.now() - this.lastRecommendationTime;
      if (timeSinceLastRecommendation > 300000) { // 5分钟内不重复提示
        this.showRestRecommendation();
        this.lastRecommendationTime = Date.now();
      }
    }
  }

  showRestRecommendation() {
    const notification = document.createElement('div');
    notification.className = 'fatigue-recommendation';
    notification.innerHTML = `
      <div class="fatigue-content">
        <h3>🤚 休息提醒</h3>
        <p>您已连续操作较长时间，建议休息一下。</p>
        <button onclick="this.parentElement.remove()">继续游戏</button>
        <button onclick="window.motorAssist.pauseGame()">暂停休息</button>
      </div>
    `;
    document.body.appendChild(notification);
  }

  triggerAutoPause() {
    window.motorAssist.pauseGame();
    
    const dialog = document.createElement('div');
    dialog.className = 'auto-pause-dialog';
    dialog.innerHTML = `
      <div class="pause-content">
        <h3>⏸️ 自动暂停</h3>
        <p>为防止操作疲劳，游戏已自动暂停。</p>
        <p>剩余暂停时间: <span id="pause-countdown">5:00</span></p>
        <p>如需提前继续，请确认您的状态。</p>
        <button id="continue-early" disabled>继续游戏</button>
      </div>
    `;
    document.body.appendChild(dialog);
    
    this.startPauseCountdown(this.pauseDuration);
  }
}
```

### 4.6 配置管理

#### 4.6.1 辅助模式配置
```javascript
// frontend/game-client/src/accessibility/MotorAssistConfig.js
export const MOTOR_ASSIST_PRESETS = {
  mild: {
    autoAimStrength: 'low',
    clickTimeMultiplier: 1.5,
    simplifiedGestures: false,
    trajectoryPreview: true,
    fatigueManagement: false,
    hapticFeedback: true,
    audioFeedback: false
  },
  moderate: {
    autoAimStrength: 'medium',
    clickTimeMultiplier: 2.0,
    simplifiedGestures: true,
    trajectoryPreview: true,
    fatigueManagement: true,
    hapticFeedback: true,
    audioFeedback: true
  },
  intensive: {
    autoAimStrength: 'high',
    clickTimeMultiplier: 3.0,
    simplifiedGestures: true,
    oneClickThrow: true,
    trajectoryPreview: true,
    fatigueManagement: true,
    hapticFeedback: true,
    audioFeedback: true,
    targetLockEnabled: true
  }
};

export class MotorAssistConfigManager {
  constructor() {
    this.storageKey = 'minego_motor_assist_config';
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      const saved = localStorage.getItem(this.storageKey);
      return saved ? JSON.parse(saved) : { enabled: false, preset: 'moderate', custom: {} };
    } catch (e) {
      return { enabled: false, preset: 'moderate', custom: {} };
    }
  }

  saveConfig() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.config));
  }

  applyPreset(presetName) {
    if (!MOTOR_ASSIST_PRESETS[presetName]) return false;
    
    this.config.preset = presetName;
    this.config.custom = { ...MOTOR_ASSIST_PRESETS[presetName] };
    this.saveConfig();
    return true;
  }

  updateCustomSetting(key, value) {
    this.config.custom[key] = value;
    this.saveConfig();
  }

  getConfig() {
    return {
      ...MOTOR_ASSIST_PRESETS[this.config.preset],
      ...this.config.custom,
      enabled: this.config.enabled
    };
  }
}
```

#### 4.6.2 配置界面组件
```javascript
// frontend/game-client/src/components/MotorAssistSettings.js
export class MotorAssistSettings {
  constructor(container, configManager) {
    this.container = container;
    this.configManager = configManager;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="motor-assist-settings">
        <h2>♿ 动作障碍辅助设置</h2>
        
        <section class="assist-toggle">
          <label>
            <input type="checkbox" id="motor-assist-enable" ${this.configManager.config.enabled ? 'checked' : ''}>
            启用动作障碍辅助模式
          </label>
        </section>

        <section class="preset-selection ${!this.configManager.config.enabled ? 'disabled' : ''}">
          <h3>预设方案</h3>
          <div class="preset-buttons">
            <button data-preset="mild" class="preset-btn">轻度辅助</button>
            <button data-preset="moderate" class="preset-btn active">中度辅助</button>
            <button data-preset="intensive" class="preset-btn">重度辅助</button>
          </div>
          <p class="preset-description" id="preset-desc">适合有轻度运动障碍的玩家</p>
        </section>

        <section class="custom-settings ${!this.configManager.config.enabled ? 'disabled' : ''}">
          <h3>自定义设置</h3>
          
          <div class="setting-item">
            <label>自动瞄准强度</label>
            <select id="auto-aim-strength">
              <option value="low">低</option>
              <option value="medium" selected>中</option>
              <option value="high">高</option>
            </select>
          </div>

          <div class="setting-item">
            <label>点击时间延长</label>
            <select id="click-time-multiplier">
              <option value="1.5">×1.5</option>
              <option value="2.0" selected>×2.0</option>
              <option value="3.0">×3.0</option>
            </select>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="simplified-gestures"> 启用手势简化
            </label>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="one-click-throw"> 启用一键投掷
            </label>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="trajectory-preview"> 显示投掷轨迹预览
            </label>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="fatigue-management"> 启用疲劳管理
            </label>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="audio-feedback"> 音频提示
            </label>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="haptic-feedback"> 震动提示
            </label>
          </div>
        </section>

        <section class="privacy-notice">
          <h3>🔒 隐私说明</h3>
          <p>您的辅助设置仅存储在本地设备，不会上传到服务器。</p>
          <p>辅助模式在竞技对战和团队道馆战中自动禁用，以确保公平性。</p>
        </section>
      </div>
    `;

    this.attachEventListeners();
  }

  attachEventListeners() {
    // 主开关
    document.getElementById('motor-assist-enable').addEventListener('change', (e) => {
      this.configManager.config.enabled = e.target.checked;
      this.configManager.saveConfig();
      this.render();
    });

    // 预设选择
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.configManager.applyPreset(btn.dataset.preset);
        this.render();
      });
    });

    // 自定义设置
    document.querySelectorAll('.custom-settings input, .custom-settings select').forEach(input => {
      input.addEventListener('change', (e) => {
        this.configManager.updateCustomSetting(e.target.id, e.target.type === 'checkbox' ? e.target.checked : e.target.value);
      });
    });
  }
}
```

### 4.7 与现有系统集成

#### 4.7.1 CatchEngine 集成
```javascript
// frontend/game-client/src/game/CatchEngine.js (修改)
import { MotorAssistManager } from '../accessibility/MotorAssistManager.js';

export class CatchEngine extends EventTarget {
  constructor(apiClient, canvas = null) {
    super();
    // ... existing code ...
    
    // 集成动作障碍辅助管理器
    this.motorAssist = new MotorAssistManager(this);
  }

  // 修改投掷逻辑以支持辅助
  async handleThrow(userInput) {
    const config = this.motorAssist.getConfig();
    
    if (config.enabled && config.autoAimStrength !== 'none') {
      const optimalTarget = this.calculateOptimalTarget();
      userInput = this.motorAssist.applyAutoAim(userInput, optimalTarget, config.autoAimStrength);
    }
    
    if (config.trajectoryPreview) {
      this.motorAssist.showTrajectoryPreview(userInput);
    }
    
    // 原有投掷逻辑
    return this.executeThrow(userInput);
  }

  // 修改环缩逻辑以支持时间延长
  updateRing() {
    const config = this.motorAssist.getConfig();
    const shrinkRate = this.motorAssist.getAdjustedShrinkRate(config);
    
    if (this._ring.shrinking) {
      this._ring.scale = Math.max(RING_MIN_SCALE, this._ring.scale - shrinkRate);
    }
  }
}
```

### 4.8 数据库设计

#### 4.8.1 辅助模式使用统计（可选，用户选择）
```sql
-- database/migrations/20260629_motor_assist_stats.sql
CREATE TABLE IF NOT EXISTS motor_assist_usage_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  assist_type VARCHAR(50) NOT NULL,
  session_duration_seconds INTEGER,
  success_rate DECIMAL(5,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 注意：默认不收集此数据，仅在用户明确同意后记录
CREATE INDEX idx_motor_assist_user_type ON motor_assist_usage_stats(user_id, assist_type);
```

## 5. 验收标准（可测试）

### 5.1 功能验收
- [ ] 自动瞄准辅助在低/中/高强度下按预期工作，辅助系数分别为 0.3/0.6/0.85
- [ ] 点击时间延长功能可将捕捉窗口延长至 ×1.5/×2/×3
- [ ] 投掷轨迹预览线正确显示贝塞尔曲线和预计落点标记
- [ ] 一键投掷模式在确认后成功执行投掷动作
- [ ] 手势简化功能：单指双击触发缩放，长按替代双击
- [ ] 音频提示在捕捉窗口进入和最佳投掷点时播放正确音调
- [ ] 震动提示按预期模式震动
- [ ] 疲劳管理在达到阈值时显示休息提醒和自动暂停
- [ ] 预设方案（轻度/中度/重度）正确应用所有配置项
- [ ] 自定义设置保存至 localStorage 并正确加载

### 5.2 无障碍验收
- [ ] 所有设置可通过键盘导航操作（Tab 键切换，Enter/Space 选择）
- [ ] 配置界面支持屏幕阅读器朗读（ARIA 标签完整）
- [ ] 辅助模式开关可通过快捷键 Ctrl+Shift+M 切换
- [ ] 高对比度模式下配置界面元素清晰可辨
- [ ] 焦点顺序符合逻辑，无焦点陷阱

### 5.3 性能验收
- [ ] 辅助模式启用后帧率不低于 55fps（目标 60fps）
- [ ] 辅助计算延迟 <50ms（P95）
- [ ] 配置保存/加载时间 <100ms
- [ ] 无内存泄漏（长时间使用后内存稳定）

### 5.4 隐私验收
- [ ] 辅助设置仅存储在 localStorage，不上传服务器
- [ ] 无后台数据收集代码
- [ ] 使用统计仅在用户明确同意后启用
- [ ] GDPR 合规：用户可随时删除所有本地数据

### 5.5 公平性验收
- [ ] 辅助模式在 PVP 对战中自动禁用
- [ ] 辅助模式在团队道馆战中自动禁用
- [ ] 辅助模式在排行榜竞技中自动禁用
- [ ] 辅助模式启用时显示明显标识，避免混淆

## 6. 工作量估算

**规模**：L（Large）

**理由**：
- 需要实现 6 个子系统（投掷辅助、点击时间延长、手势简化、反馈增强、疲劳管理、配置管理）
- 涉及现有 CatchEngine 核心逻辑修改
- 需要大量可访问性测试和用户测试
- 预计工时：40-60 人天

**拆分建议**：
- Phase 1：投掷辅助系统（15 人天）
- Phase 2：点击时间延长 + 手势简化（12 人天）
- Phase 3：反馈增强系统（8 人天）
- Phase 4：疲劳管理 + 配置管理（10 人天）
- Phase 5：集成测试 + 无障碍审计（10 人天）

## 7. 优先级理由

### P1（高优先级）的理由

1. **法律合规性**
   - 欧盟《欧洲无障碍法案》（EAA）将于 2025 年生效，要求游戏产品符合 WCAG 2.1 Level AA
   - 美国《康复法案》第 508 节要求联邦资助项目无障碍
   - 中国《无障碍环境建设法》对数字产品提出无障碍要求

2. **市场覆盖率**
   - 全球约 15% 人口有某种形式的残疾，其中动作障碍占比约 4%
   - 动作障碍玩家群体预估约 1 亿人，市场潜力巨大
   - 无障碍游戏评测网站（如 Can I Play That）评分影响销量

3. **产品成熟度**
   - 当前成熟度评分 92/100，无障碍覆盖是唯一未达标的维度
   - 核心功能已完善，无障碍是"项目可用"的最后一块拼图

4. **用户反馈**
   - 内测用户反馈中有 3 条关于操作困难的问题
   - 竞品《Pokémon GO》已实现类似辅助功能

5. **技术可行性**
   - 所有辅助功能均可纯客户端实现，无需复杂后端支持
   - 技术栈（JavaScript + Canvas）成熟，风险可控

### 竞品对比
| 功能 | mineGo | Pokémon GO | Ingress |
|------|--------|------------|---------|
| 自动瞄准 | ❌ | ✅ | ❌ |
| 时间延长 | ❌ | ✅ | ❌ |
| 一键操作 | ❌ | ✅ | ❌ |
| 手势简化 | ❌ | ✅ | ❌ |
| 疲劳管理 | ❌ | ❌ | ❌ |

## 8. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 辅助功能被滥用刷资源 | 中 | 高 | 辅助模式仅影响捕捉成功率，不影响奖励数量 |
| 用户设置丢失 | 低 | 中 | 提供 JSON 导出/导入功能 |
| 与其他辅助功能冲突 | 中 | 中 | 统一辅助管理器，协调各模块 |
| 性能影响游戏流畅度 | 低 | 中 | 异步计算，渲染优化 |
| 无障碍合规标准变更 | 低 | 低 | 定期更新符合最新 WCAG 标准 |

## 9. 参考资料

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [XG 2.1 Game Accessibility Guidelines](http://gameaccessibilityguidelines.com/)
- [Apple Accessibility Guidelines](https://developer.apple.com/accessibility/)
- [Android Accessibility Developer Guide](https://developer.android.com/guide/topics/ui/accessibility)
- [Pokémon GO Accessibility Features](https://niantic.helpshift.com/a/pokemon-go/?s=getting-started&f=accessibility-features)
