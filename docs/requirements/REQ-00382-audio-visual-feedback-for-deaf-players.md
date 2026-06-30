# REQ-00382: 游戏音效可视化与听障玩家视觉提示系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00382 |
| 标题 | 游戏音效可视化与听障玩家视觉提示系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client、frontend/game-client/src/accessibility、gateway、catch-service、gym-service、user-service、backend/shared |
| 创建时间 | 2026-06-30 07:00 UTC |

## 需求描述

为听障玩家提供完整的游戏音效可视化解决方案，将所有游戏内音频事件转换为视觉反馈，确保听障玩家能够完整体验游戏的核心玩法和社交功能。

### 核心目标
1. **音频事件实时捕获** - 捕捉游戏内所有音频事件（精灵出现、捕捉成功/失败、战斗音效、UI提示音）
2. **视觉反馈映射** - 将音频事件转换为直观的视觉元素（图标、颜色、动画、文字提示）
3. **自定义配置** - 允许玩家自定义视觉提示的样式、位置、灵敏度
4. **无障碍合规** - 符合 WCAG 2.1 AA 级别标准和 Section 508 要求

### 用户场景
- 听障玩家在捕捉精灵时，通过屏幕边缘的视觉闪烁和图标提示感知精灵出现
- 战斗中通过动态 UI 元素了解技能释放、命中/未命中、暴击等关键事件
- 社交消息通过视觉通知而非声音提示玩家

## 技术方案

### 1. 音频事件捕获与分发系统

```javascript
// frontend/game-client/src/accessibility/AudioEventCapture.js
class AudioEventCapture {
  constructor() {
    this.listeners = new Map();
    this.audioContext = null;
    this.analyser = null;
    this.visualFeedbackEnabled = true;
    this.audioEventQueue = [];
  }

  // 音频事件类型定义
  static AUDIO_EVENTS = {
    // 捕捉相关
    POKEMON_APPEAR: { id: 'pokemon_appear', priority: 'high', icon: '🔍', color: '#4CAF50' },
    CATCH_SUCCESS: { id: 'catch_success', priority: 'high', icon: '✅', color: '#2196F3' },
    CATCH_FAIL: { id: 'catch_fail', priority: 'medium', icon: '❌', color: '#F44336' },
    CATCH_BONUS: { id: 'catch_bonus', priority: 'medium', icon: '⭐', color: '#FFC107' },
    
    // 战斗相关
    BATTLE_START: { id: 'battle_start', priority: 'high', icon: '⚔️', color: '#FF5722' },
    SKILL_USE: { id: 'skill_use', priority: 'high', icon: '💫', color: '#9C27B0' },
    HIT: { id: 'hit', priority: 'medium', icon: '💥', color: '#E91E63' },
    CRITICAL: { id: 'critical', priority: 'high', icon: '🔥', color: '#FF9800' },
    MISS: { id: 'miss', priority: 'low', icon: '💨', color: '#9E9E9E' },
    VICTORY: { id: 'victory', priority: 'high', icon: '🏆', color: '#FFD700' },
    DEFEAT: { id: 'defeat', priority: 'high', icon: '💔', color: '#795548' },
    
    // UI 相关
    NOTIFICATION: { id: 'notification', priority: 'medium', icon: '🔔', color: '#00BCD4' },
    MESSAGE: { id: 'message', priority: 'medium', icon: '💬', color: '#3F51B5' },
    ERROR: { id: 'error', priority: 'high', icon: '⚠️', color: '#F44336' },
    SUCCESS: { id: 'success', priority: 'low', icon: '✓', color: '#4CAF50' }
  };

  async initialize() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      
      // 挂载到音频源
      this.connectAudioSources();
      
      // 启动事件监听
      this.startMonitoring();
      
      console.log('[AudioEventCapture] 初始化完成');
    } catch (error) {
      console.error('[AudioEventCapture] 初始化失败:', error);
    }
  }

  // 拦截 Howler.js 音频播放
  interceptHowler() {
    const originalPlay = window.Howl.prototype.play;
    const self = this;
    
    window.Howl.prototype.play = function(...args) {
      const soundId = args[0];
      const audioEvent = self.identifyAudioEvent(this._src, soundId);
      
      if (audioEvent && self.visualFeedbackEnabled) {
        self.emitVisualFeedback(audioEvent);
      }
      
      return originalPlay.apply(this, args);
    };
  }

  // 根据音频文件路径识别事件类型
  identifyAudioEvent(src, soundId) {
    const eventMap = {
      'pokemon_appear': AudioEventCapture.AUDIO_EVENTS.POKEMON_APPEAR,
      'catch_success': AudioEventCapture.AUDIO_EVENTS.CATCH_SUCCESS,
      'catch_fail': AudioEventCapture.AUDIO_EVENTS.CATCH_FAIL,
      'battle_skill': AudioEventCapture.AUDIO_EVENTS.SKILL_USE,
      'hit_normal': AudioEventCapture.AUDIO_EVENTS.HIT,
      'hit_critical': AudioEventCapture.AUDIO_EVENTS.CRITICAL,
      'miss': AudioEventCapture.AUDIO_EVENTS.MISS,
      'victory': AudioEventCapture.AUDIO_EVENTS.VICTORY,
      'defeat': AudioEventCapture.AUDIO_EVENTS.DEFEAT,
      'notification': AudioEventCapture.AUDIO_EVENTS.NOTIFICATION,
      'message': AudioEventCapture.AUDIO_EVENTS.MESSAGE
    };

    for (const [pattern, event] of Object.entries(eventMap)) {
      if (src.includes(pattern)) {
        return event;
      }
    }

    return null;
  }

  // 发射视觉反馈
  emitVisualFeedback(audioEvent) {
    const event = {
      ...audioEvent,
      timestamp: Date.now(),
      id: `${audioEvent.id}_${Date.now()}`
    };

    // 分发到所有监听器
    this.listeners.forEach(callback => callback(event));

    // 加入事件队列（用于调试和回放）
    this.audioEventQueue.push(event);
    if (this.audioEventQueue.length > 100) {
      this.audioEventQueue.shift();
    }
  }

  subscribe(callback) {
    const id = Date.now().toString();
    this.listeners.set(id, callback);
    return () => this.listeners.delete(id);
  }

  enable() {
    this.visualFeedbackEnabled = true;
  }

  disable() {
    this.visualFeedbackEnabled = false;
  }
}

export default AudioEventCapture;
```

### 2. 视觉反馈渲染系统

```javascript
// frontend/game-client/src/accessibility/VisualFeedbackRenderer.js
class VisualFeedbackRenderer {
  constructor(container) {
    this.container = container || document.body;
    this.feedbackElements = [];
    this.settings = {
      position: 'top-right', // top-right, top-left, bottom-right, bottom-left, center
      duration: 3000,
      animationStyle: 'slide', // slide, fade, pop, pulse
      showIcon: true,
      showText: true,
      screenFlash: true,
      queueMode: 'parallel' // parallel, sequential
    };
    this.feedbackQueue = [];
    this.activeFeedbacks = new Set();
    this.maxConcurrent = 5;
  }

  // 创建视觉反馈
  createFeedback(audioEvent) {
    const feedback = document.createElement('div');
    feedback.className = `audio-visual-feedback ${this.settings.position}`;
    feedback.setAttribute('role', 'alert');
    feedback.setAttribute('aria-live', 'polite');
    feedback.setAttribute('aria-label', `${audioEvent.icon} ${this.getEventDescription(audioEvent)}`);

    feedback.innerHTML = `
      <div class="feedback-content" style="background-color: ${audioEvent.color}20; border-left: 4px solid ${audioEvent.color};">
        ${this.settings.showIcon ? `<span class="feedback-icon">${audioEvent.icon}</span>` : ''}
        ${this.settings.showText ? `<span class="feedback-text">${this.getEventDescription(audioEvent)}</span>` : ''}
      </div>
    `;

    // 添加动画类
    feedback.classList.add(`animation-${this.settings.animationStyle}`);

    // 根据优先级调整样式
    if (audioEvent.priority === 'high') {
      feedback.classList.add('priority-high');
      if (this.settings.screenFlash) {
        this.triggerScreenFlash(audioEvent.color);
      }
    }

    return feedback;
  }

  // 触发屏幕闪烁
  triggerScreenFlash(color) {
    const flash = document.createElement('div');
    flash.className = 'screen-flash';
    flash.style.backgroundColor = color;
    flash.style.opacity = '0.3';
    
    this.container.appendChild(flash);
    
    // 动画
    flash.animate([
      { opacity: 0.3 },
      { opacity: 0 }
    ], {
      duration: 500,
      easing: 'ease-out'
    }).onfinish = () => flash.remove();
  }

  // 显示反馈
  show(audioEvent) {
    // 检查并发限制
    if (this.settings.queueMode === 'sequential' && this.activeFeedbacks.size >= 1) {
      this.feedbackQueue.push(audioEvent);
      return;
    }

    if (this.activeFeedbacks.size >= this.maxConcurrent) {
      this.feedbackQueue.push(audioEvent);
      return;
    }

    const feedback = this.createFeedback(audioEvent);
    const feedbackId = Date.now();
    feedback.dataset.feedbackId = feedbackId;
    this.activeFeedbacks.add(feedbackId);

    this.container.appendChild(feedback);

    // 自动移除
    setTimeout(() => {
      this.removeFeedback(feedback, feedbackId);
    }, this.settings.duration);
  }

  removeFeedback(feedback, feedbackId) {
    feedback.classList.add('fade-out');
    
    setTimeout(() => {
      feedback.remove();
      this.activeFeedbacks.delete(feedbackId);
      
      // 处理队列中的下一个
      if (this.feedbackQueue.length > 0) {
        const nextEvent = this.feedbackQueue.shift();
        this.show(nextEvent);
      }
    }, 300);
  }

  getEventDescription(audioEvent) {
    const descriptions = {
      'pokemon_appear': '精灵出现',
      'catch_success': '捕捉成功',
      'catch_fail': '捕捉失败',
      'catch_bonus': '奖励捕捉',
      'battle_start': '战斗开始',
      'skill_use': '技能释放',
      'hit': '命中',
      'critical': '暴击',
      'miss': '未命中',
      'victory': '胜利',
      'defeat': '失败',
      'notification': '新通知',
      'message': '新消息',
      'error': '错误',
      'success': '成功'
    };
    return descriptions[audioEvent.id] || audioEvent.id;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }
}

export default VisualFeedbackRenderer;
```

### 3. 战斗音效可视化覆盖层

```javascript
// frontend/game-client/src/accessibility/BattleVisualOverlay.js
class BattleVisualOverlay {
  constructor(battleScene) {
    this.battleScene = battleScene;
    this.overlayElements = new Map();
    this.skillIndicators = [];
    this.damageNumbers = [];
    this.statusEffects = [];
  }

  // 技能释放视觉指示
  showSkillIndicator(skillData) {
    const indicator = document.createElement('div');
    indicator.className = 'skill-indicator';
    indicator.innerHTML = `
      <div class="skill-name">${skillData.name}</div>
      <div class="skill-type">${skillData.type}</div>
      <div class="skill-power">${skillData.power || ''}</div>
    `;

    // 位置计算（基于释放者位置）
    const position = this.getSkillOriginPosition(skillData.caster);
    indicator.style.left = `${position.x}px`;
    indicator.style.top = `${position.y}px`;

    this.battleScene.uiLayer.appendChild(indicator);
    
    // 动画
    indicator.animate([
      { opacity: 0, transform: 'scale(0.5)' },
      { opacity: 1, transform: 'scale(1)' },
      { opacity: 0, transform: 'scale(1.2)' }
    ], {
      duration: 1500,
      easing: 'ease-out'
    }).onfinish = () => indicator.remove();
  }

  // 伤害数字可视化
  showDamageNumber(damageData) {
    const number = document.createElement('div');
    number.className = `damage-number ${damageData.isCritical ? 'critical' : ''}`;
    number.textContent = damageData.isCritical ? `${damageData.value}!` : damageData.value;
    number.setAttribute('aria-label', `造成 ${damageData.value} 点${damageData.isCritical ? '暴击' : ''}伤害`);

    const target = this.getCharacterPosition(damageData.target);
    number.style.left = `${target.x + Math.random() * 20 - 10}px`;
    number.style.top = `${target.y}px`;

    this.battleScene.effectsLayer.appendChild(number);

    // 上浮动画
    number.animate([
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(-50px)' }
    ], {
      duration: 2000,
      easing: 'ease-out'
    }).onfinish = () => number.remove();
  }

  // 状态效果视觉指示
  showStatusEffect(effectData) {
    const effect = document.createElement('div');
    effect.className = `status-effect-indicator ${effectData.type}`;
    effect.innerHTML = `
      <span class="effect-icon">${this.getStatusIcon(effectData.type)}</span>
      <span class="effect-name">${effectData.name}</span>
      <span class="effect-duration">${effectData.duration || ''}</span>
    `;

    const target = this.getCharacterPosition(effectData.target);
    effect.style.left = `${target.x}px`;
    effect.style.top = `${target.y - 60}px`;

    this.battleScene.uiLayer.appendChild(effect);

    // 存储引用以便更新
    effect.dataset.effectId = effectData.id;
    this.statusEffects.push(effect);

    return effect;
  }

  getStatusIcon(type) {
    const icons = {
      burn: '🔥',
      freeze: '❄️',
      paralyze: '⚡',
      poison: '☠️',
      sleep: '💤',
      confusion: '😵',
      boost: '⬆️',
      nerf: '⬇️'
    };
    return icons[type] || '✨';
  }

  getCharacterPosition(characterId) {
    const character = this.battleScene.getCharacterById(characterId);
    return character ? { x: character.x, y: character.y } : { x: 0, y: 0 };
  }

  getSkillOriginPosition(casterId) {
    const caster = this.battleScene.getCharacterById(casterId);
    return caster ? { x: caster.x + caster.width / 2, y: caster.y } : { x: 0, y: 0 };
  }

  clear() {
    this.overlayElements.forEach(el => el.remove());
    this.overlayElements.clear();
    this.skillIndicators.forEach(el => el.remove());
    this.skillIndicators = [];
    this.damageNumbers.forEach(el => el.remove());
    this.damageNumbers = [];
    this.statusEffects.forEach(el => el.remove());
    this.statusEffects = [];
  }
}

export default BattleVisualOverlay;
```

### 4. 用户偏好配置

```javascript
// frontend/game-client/src/accessibility/AudioVisualSettings.js
const DEFAULT_SETTINGS = {
  enabled: true,
  
  // 反馈位置
  position: 'top-right',
  
  // 反馈持续时间（毫秒）
  duration: 3000,
  
  // 动画样式
  animationStyle: 'slide', // slide, fade, pop, pulse
  
  // 显示元素
  showIcon: true,
  showText: true,
  
  // 屏幕闪烁
  screenFlash: true,
  screenFlashIntensity: 0.3,
  
  // 队列模式
  queueMode: 'parallel', // parallel, sequential
  maxConcurrent: 5,
  
  // 事件过滤
  enabledEvents: [
    'pokemon_appear',
    'catch_success',
    'catch_fail',
    'battle_start',
    'skill_use',
    'critical',
    'victory',
    'defeat',
    'notification',
    'message'
  ],
  
  // 优先级阈值
  minPriority: 'low', // high, medium, low
  
  // 颜色自定义
  customColors: {},
  
  // 声音波形可视化
  waveformVisualization: false,
  waveformPosition: 'bottom'
};

class AudioVisualSettings {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.loadFromStorage();
  }

  loadFromStorage() {
    try {
      const saved = localStorage.getItem('audioVisualSettings');
      if (saved) {
        this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
      }
    } catch (error) {
      console.error('[AudioVisualSettings] 加载设置失败:', error);
    }
  }

  saveToStorage() {
    try {
      localStorage.setItem('audioVisualSettings', JSON.stringify(this.settings));
    } catch (error) {
      console.error('[AudioVisualSettings] 保存设置失败:', error);
    }
  }

  update(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    this.saveToStorage();
    this.emit('settingsChanged', this.settings);
  }

  enable() {
    this.update({ enabled: true });
  }

  disable() {
    this.update({ enabled: false });
  }

  isEventEnabled(eventId) {
    return this.settings.enabled && 
           this.settings.enabledEvents.includes(eventId);
  }

  getSettings() {
    return { ...this.settings };
  }

  // 事件系统
  listeners = new Set();
  
  on(event, callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  emit(event, data) {
    this.listeners.forEach(cb => cb(event, data));
  }
}

export { DEFAULT_SETTINGS, AudioVisualSettings };
```

### 5. 设置界面组件

```javascript
// frontend/game-client/src/components/AudioVisualSettingsPanel.js
import { AudioVisualSettings, DEFAULT_SETTINGS } from '../accessibility/AudioVisualSettings';

class AudioVisualSettingsPanel {
  constructor() {
    this.settings = new AudioVisualSettings();
    this.panel = null;
  }

  render() {
    const currentSettings = this.settings.getSettings();
    
    return `
      <div class="audio-visual-settings-panel" role="dialog" aria-label="音效可视化设置">
        <h2>音效可视化设置</h2>
        <p class="settings-description">
          为听障玩家提供的音效视觉替代方案
        </p>

        <div class="settings-section">
          <h3>基础设置</h3>
          
          <div class="setting-item">
            <label for="av-enabled">
              <input type="checkbox" id="av-enabled" 
                     ${currentSettings.enabled ? 'checked' : ''}>
              启用音效可视化
            </label>
          </div>

          <div class="setting-item">
            <label for="av-position">提示位置</label>
            <select id="av-position">
              <option value="top-right" ${currentSettings.position === 'top-right' ? 'selected' : ''}>右上角</option>
              <option value="top-left" ${currentSettings.position === 'top-left' ? 'selected' : ''}>左上角</option>
              <option value="bottom-right" ${currentSettings.position === 'bottom-right' ? 'selected' : ''}>右下角</option>
              <option value="bottom-left" ${currentSettings.position === 'bottom-left' ? 'selected' : ''}>左下角</option>
              <option value="center" ${currentSettings.position === 'center' ? 'selected' : ''}>中央</option>
            </select>
          </div>

          <div class="setting-item">
            <label for="av-duration">显示时长</label>
            <input type="range" id="av-duration" 
                   min="1000" max="10000" step="500"
                   value="${currentSettings.duration}">
            <span class="range-value">${currentSettings.duration / 1000}秒</span>
          </div>

          <div class="setting-item">
            <label for="av-animation">动画样式</label>
            <select id="av-animation">
              <option value="slide" ${currentSettings.animationStyle === 'slide' ? 'selected' : ''}>滑入</option>
              <option value="fade" ${currentSettings.animationStyle === 'fade' ? 'selected' : ''}>淡入</option>
              <option value="pop" ${currentSettings.animationStyle === 'pop' ? 'selected' : ''}>弹出</option>
              <option value="pulse" ${currentSettings.animationStyle === 'pulse' ? 'selected' : ''}>脉冲</option>
            </select>
          </div>
        </div>

        <div class="settings-section">
          <h3>视觉元素</h3>
          
          <div class="setting-item">
            <label>
              <input type="checkbox" id="av-show-icon" 
                     ${currentSettings.showIcon ? 'checked' : ''}>
              显示图标
            </label>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="av-show-text" 
                     ${currentSettings.showText ? 'checked' : ''}>
              显示文字描述
            </label>
          </div>

          <div class="setting-item">
            <label>
              <input type="checkbox" id="av-screen-flash" 
                     ${currentSettings.screenFlash ? 'checked' : ''}>
              重要事件屏幕闪烁
            </label>
          </div>

          <div class="setting-item">
            <label for="av-flash-intensity">闪烁强度</label>
            <input type="range" id="av-flash-intensity" 
                   min="0.1" max="0.5" step="0.1"
                   value="${currentSettings.screenFlashIntensity}">
          </div>
        </div>

        <div class="settings-section">
          <h3>事件过滤</h3>
          <div class="event-filters">
            ${this.renderEventFilters(currentSettings.enabledEvents)}
          </div>
        </div>

        <div class="settings-section">
          <h3>预览</h3>
          <button class="preview-button" id="av-preview">
            测试效果
          </button>
        </div>

        <div class="settings-actions">
          <button class="reset-button" id="av-reset">
            重置默认
          </button>
          <button class="save-button" id="av-save">
            保存设置
          </button>
        </div>
      </div>
    `;
  }

  renderEventFilters(enabledEvents) {
    const events = [
      { id: 'pokemon_appear', label: '精灵出现', icon: '🔍' },
      { id: 'catch_success', label: '捕捉成功', icon: '✅' },
      { id: 'catch_fail', label: '捕捉失败', icon: '❌' },
      { id: 'battle_start', label: '战斗开始', icon: '⚔️' },
      { id: 'skill_use', label: '技能释放', icon: '💫' },
      { id: 'critical', label: '暴击', icon: '🔥' },
      { id: 'victory', label: '胜利', icon: '🏆' },
      { id: 'defeat', label: '失败', icon: '💔' },
      { id: 'notification', label: '通知', icon: '🔔' },
      { id: 'message', label: '消息', icon: '💬' }
    ];

    return events.map(event => `
      <label class="event-filter-item">
        <input type="checkbox" value="${event.id}"
               ${enabledEvents.includes(event.id) ? 'checked' : ''}>
        ${event.icon} ${event.label}
      </label>
    `).join('');
  }

  bindEvents() {
    // 启用/禁用
    document.getElementById('av-enabled').addEventListener('change', (e) => {
      this.settings.update({ enabled: e.target.checked });
    });

    // 位置
    document.getElementById('av-position').addEventListener('change', (e) => {
      this.settings.update({ position: e.target.value });
    });

    // 显示图标
    document.getElementById('av-show-icon').addEventListener('change', (e) => {
      this.settings.update({ showIcon: e.target.checked });
    });

    // 显示文字
    document.getElementById('av-show-text').addEventListener('change', (e) => {
      this.settings.update({ showText: e.target.checked });
    });

    // 屏幕闪烁
    document.getElementById('av-screen-flash').addEventListener('change', (e) => {
      this.settings.update({ screenFlash: e.target.checked });
    });

    // 事件过滤
    document.querySelectorAll('.event-filter-item input').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        const enabledEvents = Array.from(
          document.querySelectorAll('.event-filter-item input:checked')
        ).map(cb => cb.value);
        this.settings.update({ enabledEvents });
      });
    });

    // 重置
    document.getElementById('av-reset').addEventListener('click', () => {
      this.settings.update(DEFAULT_SETTINGS);
      this.refresh();
    });

    // 预览
    document.getElementById('av-preview').addEventListener('click', () => {
      this.showPreview();
    });
  }

  showPreview() {
    // 触发测试事件
    window.dispatchEvent(new CustomEvent('audioEvent', {
      detail: { id: 'pokemon_appear', icon: '🔍', color: '#4CAF50', priority: 'high' }
    }));
  }

  refresh() {
    const container = document.querySelector('.audio-visual-settings-panel');
    if (container) {
      container.innerHTML = this.render();
      this.bindEvents();
    }
  }
}

export default AudioVisualSettingsPanel;
```

### 6. 样式定义

```css
/* frontend/game-client/src/styles/audio-visual-feedback.css */
.audio-visual-feedback {
  position: fixed;
  z-index: 10000;
  pointer-events: none;
  
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 300px;
  
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

.audio-visual-feedback.top-right {
  top: 80px;
  right: 20px;
}

.audio-visual-feedback.top-left {
  top: 80px;
  left: 20px;
}

.audio-visual-feedback.bottom-right {
  bottom: 80px;
  right: 20px;
}

.audio-visual-feedback.bottom-left {
  bottom: 80px;
  left: 20px;
}

.audio-visual-feedback.center {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  align-items: center;
}

.feedback-content {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: 8px;
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  
  animation: feedback-enter 0.3s ease-out;
}

.feedback-icon {
  font-size: 24px;
  line-height: 1;
}

.feedback-text {
  font-size: 14px;
  font-weight: 500;
  color: #fff;
}

/* 动画样式 */
.animation-slide .feedback-content {
  animation: slideIn 0.3s ease-out;
}

.animation-fade .feedback-content {
  animation: fadeIn 0.3s ease-out;
}

.animation-pop .feedback-content {
  animation: popIn 0.3s ease-out;
}

.animation-pulse .feedback-content {
  animation: pulseIn 0.5s ease-out;
}

/* 高优先级样式 */
.priority-high .feedback-content {
  border-width: 3px;
  font-weight: 600;
}

.priority-high .feedback-icon {
  font-size: 28px;
}

/* 屏幕闪烁 */
.screen-flash {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
  z-index: 9999;
}

/* 战斗覆盖层 */
.skill-indicator {
  position: absolute;
  padding: 8px 16px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  text-align: center;
  z-index: 1000;
}

.damage-number {
  position: absolute;
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.5);
  z-index: 1001;
}

.damage-number.critical {
  font-size: 32px;
  color: #FF9800;
  animation: criticalBounce 0.5s ease-out;
}

.status-effect-indicator {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 12px;
  z-index: 1002;
}

/* 动画关键帧 */
@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes popIn {
  from {
    transform: scale(0.5);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes pulseIn {
  0% {
    transform: scale(0.8);
    opacity: 0;
  }
  50% {
    transform: scale(1.1);
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}

@keyframes criticalBounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-10px); }
}

@keyframes feedback-enter {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.fade-out {
  animation: feedback-exit 0.3s ease-out forwards;
}

@keyframes feedback-exit {
  to {
    opacity: 0;
    transform: translateY(-10px);
  }
}

/* 减少动画偏好 */
@media (prefers-reduced-motion: reduce) {
  .audio-visual-feedback,
  .feedback-content,
  .skill-indicator,
  .damage-number,
  .status-effect-indicator {
    animation: none !important;
    transition: none !important;
  }
}

/* 高对比度模式 */
@media (prefers-contrast: high) {
  .feedback-content {
    border: 2px solid #fff;
    background: #000;
  }
  
  .feedback-text {
    color: #fff;
  }
}
```

### 7. 集成到主应用

```javascript
// frontend/game-client/src/game/Game.js - 集成片段
import AudioEventCapture from '../accessibility/AudioEventCapture';
import VisualFeedbackRenderer from '../accessibility/VisualFeedbackRenderer';
import { AudioVisualSettings } from '../accessibility/AudioVisualSettings';

class Game {
  constructor() {
    // ... 其他初始化代码
    
    // 初始化音效可视化系统
    this.initAudioVisualSystem();
  }

  async initAudioVisualSystem() {
    const settings = new AudioVisualSettings();
    
    if (settings.getSettings().enabled) {
      const audioCapture = new AudioEventCapture();
      const visualRenderer = new VisualFeedbackRenderer();
      
      await audioCapture.initialize();
      audioCapture.interceptHowler();
      
      // 订阅音频事件并显示视觉反馈
      audioCapture.subscribe((event) => {
        if (settings.isEventEnabled(event.id)) {
          visualRenderer.show(event);
        }
      });
      
      this.audioVisualSystem = {
        capture: audioCapture,
        renderer: visualRenderer,
        settings
      };
    }
  }
}
```

### 8. 后端支持 - 用户偏好同步

```javascript
// user-service/routes/accessibility.js
const express = require('express');
const router = express.Router();
const { authenticate } = require('../../shared/auth');
const UserAccessibility = require('../models/UserAccessibility');

/**
 * 获取用户无障碍设置
 */
router.get('/settings', authenticate, async (req, res) => {
  try {
    const settings = await UserAccessibility.findOne({
      where: { userId: req.user.id }
    });
    
    res.json({
      success: true,
      data: settings?.audioVisualSettings || null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取设置失败'
    });
  }
});

/**
 * 更新用户无障碍设置
 */
router.post('/settings', authenticate, async (req, res) => {
  try {
    const { audioVisualSettings } = req.body;
    
    const [settings, created] = await UserAccessibility.findOrCreate({
      where: { userId: req.user.id },
      defaults: {
        userId: req.user.id,
        audioVisualSettings
      }
    });
    
    if (!created) {
      await settings.update({ audioVisualSettings });
    }
    
    res.json({
      success: true,
      data: settings.audioVisualSettings
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '保存设置失败'
    });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 所有游戏内音频事件均能被捕获并转换为视觉反馈
- [ ] 视觉反馈支持多种位置选项（四角、中央）
- [ ] 支持自定义显示时长、动画样式
- [ ] 重要事件（精灵出现、捕捉结果、战斗关键事件）有醒目的视觉提示
- [ ] 屏幕闪烁功能对高优先级事件生效
- [ ] 设置界面完整，支持启用/禁用、事件过滤、预览测试
- [ ] 设置持久化存储（本地 + 云端同步）
- [ ] 符合 WCAG 2.1 AA 级别标准
- [ ] 支持 prefers-reduced-motion 媒体查询
- [ ] 支持高对比度模式
- [ ] 战斗场景有独立的视觉覆盖层（技能指示、伤害数字、状态效果）
- [ ] 屏幕阅读器可读（ARIA 属性完整）
- [ ] 移动端适配良好
- [ ] 性能影响 < 5ms 每帧

## 影响范围

- `frontend/game-client/src/accessibility/` - 新增音效可视化核心模块
- `frontend/game-client/src/components/` - 新增设置面板组件
- `frontend/game-client/src/styles/` - 新增样式文件
- `frontend/game-client/src/game/Game.js` - 集成入口
- `user-service/routes/accessibility.js` - 后端路由
- `user-service/models/UserAccessibility.js` - 数据模型
- `database/migrations/` - 新增迁移文件

## 参考

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [Section 508 Standards](https://www.section508.gov/)
- [Game Accessibility Guidelines](http://gameaccessibilityguidelines.com/)
- [WebAIM Screen Reader User Survey](https://webaim.org/projects/screenreadersurvey/)
- [Phaser 3 Accessibility Plugin](https://phaser.io/examples/v3/category/accessibility)
