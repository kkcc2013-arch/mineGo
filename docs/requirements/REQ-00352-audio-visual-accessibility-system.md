# REQ-00352：游戏音效可视化与听障玩家视觉提示系统

- **编号**：REQ-00352
- **类别**：无障碍(a11y)
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility/AudioVisualizer.js、frontend/game-client/src/accessibility/VisualCueManager.js、frontend/game-client/src/audio/AudioManager.js、gateway、catch-service、gym-service
- **创建时间**：2026-06-29 01:05 UTC
- **依赖需求**：REQ-00017（基础无障碍支持）、REQ-00162（屏幕阅读器增强）

## 1. 背景与问题

当前 mineGo 游戏高度依赖音频反馈来传达关键游戏事件：
- **精灵出现提示**：野生精灵出现在附近时的音效
- **捕捉成功/失败**：投球结果的成功或失败音效
- **道馆战斗信号**：战斗开始、技能释放、战斗结果
- **奖励音效**：任务完成、成就解锁、每日奖励

**问题**：全球约有 **4.66 亿** 听障人士（WHO 数据），他们无法通过音效获取游戏信息，导致：
1. **游戏体验不完整**：错过重要的音频提示和氛围营造
2. **竞争劣势**：在实时战斗中听不到技能音效、攻击提示
3. **安全隐患**：某些警告音效无法传达给听障玩家
4. **违背无障碍原则**：违反 WCAG 2.1 Guideline 1.2（时间敏感媒体替代）

## 2. 目标

为听障和听损玩家提供完整的音频可视化系统，实现：
1. **音效实时可视化**：关键音效转换为视觉信号（震动、光效、动画）
2. **音效字幕/标签**：显示音效类型和含义的文字提示
3. **可配置视觉提示强度**：适应不同听损程度和敏感度
4. **不干扰其他玩家**：本地化视觉提示，不影响多人游戏体验

**预期收益**：
- 满足 WCAG 2.1 AAA 级标准（Success Criterion 1.2.1, 1.2.4, 1.2.5）
- 覆盖约 5-7% 的游戏潜在用户群体
- 提升游戏的无障碍品牌形象

## 3. 范围

### 包含
- 音效分类与优先级系统（关键/重要/氛围）
- 实时音效可视化引擎（震动、边框闪烁、图标动画）
- 音效字幕/标签显示系统
- 视觉提示配置面板（强度、类型、位置）
- 与现有 AudioManager、AnimationSettings 集成
- 移动端震动 API 集成

### 不包含
- 完整字幕系统（对话、剧情等文本内容）
- 手语视频支持
- 实时语音转文字（超出当前范围）

## 4. 详细需求

### 4.1 音效分类与优先级系统

```javascript
// frontend/game-client/src/accessibility/AudioEffectRegistry.js

export const AUDIO_EFFECT_TYPES = {
  // P0 - 关键：必须提供视觉替代
  CRITICAL: {
    pokemon_spawn: { 
      label: '精灵出现', 
      icon: '🔔',
      visual: { border: true, vibrate: true, icon: true, duration: 3000 }
    },
    catch_success: { 
      label: '捕捉成功', 
      icon: '✓',
      visual: { vibrate: true, icon: true, celebration: true }
    },
    catch_fail: { 
      label: '捕捉失败', 
      icon: '✗',
      visual: { vibrate: true, icon: true }
    },
    battle_start: { 
      label: '战斗开始', 
      icon: '⚔️',
      visual: { border: true, vibrate: true, flash: true }
    },
    battle_hit: { 
      label: '受到攻击', 
      icon: '💥',
      visual: { border: true, vibrate: true }
    },
    battle_skill: { 
      label: '技能释放', 
      icon: '✨',
      visual: { vibrate: true, icon: true }
    },
    battle_victory: { 
      label: '战斗胜利', 
      icon: '🏆',
      visual: { celebration: true, vibrate: true }
    },
    warning: { 
      label: '警告', 
      icon: '⚠️',
      visual: { border: true, vibrate: [200, 100, 200], flash: true }
    },
    achievement: { 
      label: '成就解锁', 
      icon: '🎖️',
      visual: { celebration: true, vibrate: true }
    }
  },
  
  // P1 - 重要：推荐视觉替代
  IMPORTANT: {
    item_pickup: { label: '获得物品', icon: '📦', visual: { vibrate: true, icon: true } },
    level_up: { label: '等级提升', icon: '⬆️', visual: { vibrate: true, celebration: true } },
    coin_collect: { label: '获得精币', icon: '💰', visual: { vibrate: true, icon: true } },
    quest_complete: { label: '任务完成', icon: '📋', visual: { vibrate: true, icon: true } },
    friend_online: { label: '好友上线', icon: '👋', visual: { icon: true } }
  },
  
  // P2 - 氛围：可选视觉替代
  AMBIENT: {
    menu_click: { label: '点击', icon: '👆', visual: { vibrate: 10 } },
    map_pan: { label: '地图移动', visual: {} },
    button_hover: { label: '悬停', visual: {} },
    background_music: { label: '背景音乐', visual: {} }
  }
};

export const VISUAL_CUE_INTENSITY = {
  OFF: 0,
  MINIMAL: 1,    // 仅关键音效
  MODERATE: 2,   // 关键 + 重要音效
  FULL: 3        // 所有音效
};
```

### 4.2 音效可视化引擎

```javascript
// frontend/game-client/src/accessibility/AudioVisualizer.js

export class AudioVisualizer {
  constructor() {
    this.enabled = false;
    this.intensity = VISUAL_CUE_INTENSITY.MODERATE;
    this.cueTypes = {
      border: true,
      vibrate: true,
      icon: true,
      flash: false,
      caption: true
    };
    this.position = 'top-right'; // caption 位置
    this.vibrationEnabled = 'vibrate' in navigator;
    this.containerEl = null;
    this.queue = [];
    this.displaying = new Set();
  }

  /**
   * 初始化可视化容器
   */
  init() {
    // 创建视觉提示容器
    this.containerEl = document.createElement('div');
    this.containerEl.id = 'audio-visualizer-container';
    this.containerEl.className = 'audio-visualizer';
    this.containerEl.setAttribute('aria-live', 'polite');
    this.containerEl.setAttribute('aria-atomic', 'true');
    document.body.appendChild(this.containerEl);

    // 创建边框闪烁元素
    this.borderFlashEl = document.createElement('div');
    this.borderFlashEl.id = 'audio-border-flash';
    this.borderFlashEl.className = 'border-flash';
    document.body.appendChild(this.borderFlashEl);

    console.log('[AudioVisualizer] Initialized, vibration:', this.vibrationEnabled);
  }

  /**
   * 播放音效的可视化
   * @param {string} effectType - 音效类型
   * @param {object} options - 额外选项
   */
  visualize(effectType, options = {}) {
    if (!this.enabled) return;

    const effect = this.getEffectConfig(effectType);
    if (!effect || !this.shouldDisplay(effect.priority)) return;

    const visualConfig = { ...effect.visual, ...options };

    // 边框闪烁
    if (visualConfig.border && this.cueTypes.border) {
      this.triggerBorderFlash(visualConfig.duration || 1000, effect.priority);
    }

    // 震动
    if (visualConfig.vibrate && this.cueTypes.vibrate && this.vibrationEnabled) {
      this.triggerVibration(visualConfig.vibrate);
    }

    // 图标/字幕显示
    if ((visualConfig.icon || visualConfig.caption !== false) && this.cueTypes.icon) {
      this.showIconLabel(effect.icon, effect.label, visualConfig.duration);
    }

    // 屏幕闪烁（警告类）
    if (visualConfig.flash && this.cueTypes.flash) {
      this.triggerScreenFlash();
    }

    // 庆祝动画
    if (visualConfig.celebration) {
      this.triggerCelebration();
    }

    // ARIA 通知
    a11yAnnouncer.announce(`${effect.label} - ${effect.icon}`);
  }

  /**
   * 触发边框闪烁
   */
  triggerBorderFlash(duration, priority) {
    const colors = {
      0: '#ff6b6b', // P0 - 红色
      1: '#ffd93d', // P1 - 黄色
      2: '#6bcb77'  // P2 - 绿色
    };
    
    this.borderFlashEl.style.borderColor = colors[priority] || '#ff6b6b';
    this.borderFlashEl.classList.add('active');
    
    setTimeout(() => {
      this.borderFlashEl.classList.remove('active');
    }, duration);
  }

  /**
   * 触发震动
   */
  triggerVibration(pattern) {
    if (!this.vibrationEnabled) return;
    
    const vibrationPattern = Array.isArray(pattern) ? pattern : [pattern];
    navigator.vibrate(vibrationPattern);
  }

  /**
   * 显示图标和文字标签
   */
  showIconLabel(icon, label, duration = 3000) {
    const cueEl = document.createElement('div');
    cueEl.className = `audio-cue ${this.position}`;
    cueEl.innerHTML = `
      <span class="cue-icon">${icon}</span>
      <span class="cue-label">${label}</span>
    `;
    
    this.containerEl.appendChild(cueEl);
    
    // 入场动画
    requestAnimationFrame(() => {
      cueEl.classList.add('enter');
    });
    
    // 自动消失
    setTimeout(() => {
      cueEl.classList.remove('enter');
      cueEl.classList.add('exit');
      setTimeout(() => cueEl.remove(), 300);
    }, duration);
  }

  /**
   * 触发屏幕闪烁
   */
  triggerScreenFlash() {
    const flashEl = document.createElement('div');
    flashEl.className = 'screen-flash';
    document.body.appendChild(flashEl);
    
    setTimeout(() => flashEl.remove(), 200);
  }

  /**
   * 触发庆祝动画
   */
  triggerCelebration() {
    // 使用粒子效果或 confetti
    if (window.confetti) {
      window.confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 }
      });
    }
  }

  /**
   * 判断是否应该显示
   */
  shouldDisplay(priority) {
    return priority <= this.intensity;
  }

  /**
   * 配置更新
   */
  configure(config) {
    if (config.enabled !== undefined) this.enabled = config.enabled;
    if (config.intensity !== undefined) this.intensity = config.intensity;
    if (config.cueTypes) {
      this.cueTypes = { ...this.cueTypes, ...config.cueTypes };
    }
    if (config.position) this.position = config.position;
    
    console.log('[AudioVisualizer] Configured:', this);
  }
}

export const audioVisualizer = new AudioVisualizer();
```

### 4.3 AudioManager 集成

```javascript
// 修改 frontend/game-client/src/audio/AudioManager.js

import { audioVisualizer } from '../accessibility/AudioVisualizer.js';

class AudioManager {
  // ... 现有代码 ...

  /**
   * 播放音效（增强版，支持可视化）
   */
  playSound(effectType, options = {}) {
    // 原有音频播放逻辑
    const audio = this.sounds.get(effectType);
    if (audio && this.soundEnabled && !this.muted) {
      audio.currentTime = 0;
      audio.play().catch(err => {
        console.warn('[AudioManager] Play failed:', err);
      });
    }

    // 新增：触发音效可视化
    audioVisualizer.visualize(effectType, options);
  }
}
```

### 4.4 视觉提示配置面板

```javascript
// frontend/game-client/src/accessibility/VisualCueSettings.js

export class VisualCueSettings {
  constructor(container) {
    this.container = container;
    this.config = this.loadConfig();
  }

  loadConfig() {
    const saved = localStorage.getItem('audio-visualizer-config');
    return saved ? JSON.parse(saved) : {
      enabled: false,
      intensity: VISUAL_CUE_INTENSITY.MODERATE,
      cueTypes: {
        border: true,
        vibrate: true,
        icon: true,
        flash: false,
        caption: true
      },
      position: 'top-right'
    };
  }

  saveConfig() {
    localStorage.setItem('audio-visualizer-config', JSON.stringify(this.config));
  }

  createSettingsUI() {
    const html = `
      <div class="visual-cue-settings">
        <h3>音效可视化设置</h3>
        <p class="settings-description">为听障玩家提供音效的视觉替代提示</p>
        
        <div class="setting-group">
          <label class="toggle-label">
            <input type="checkbox" id="cue-enabled" ${this.config.enabled ? 'checked' : ''}>
            <span>启用音效可视化</span>
          </label>
        </div>
        
        <div class="setting-group ${this.config.enabled ? '' : 'disabled'}">
          <label>提示强度</label>
          <div class="intensity-selector" role="radiogroup">
            <button class="intensity-btn ${this.config.intensity === 1 ? 'active' : ''}" 
                    data-intensity="1" role="radio" aria-checked="${this.config.intensity === 1}">
              最小 (仅关键提示)
            </button>
            <button class="intensity-btn ${this.config.intensity === 2 ? 'active' : ''}" 
                    data-intensity="2" role="radio" aria-checked="${this.config.intensity === 2}">
              适中 (推荐)
            </button>
            <button class="intensity-btn ${this.config.intensity === 3 ? 'active' : ''}" 
                    data-intensity="3" role="radio" aria-checked="${this.config.intensity === 3}">
              完整 (所有提示)
            </button>
          </div>
        </div>
        
        <div class="setting-group ${this.config.enabled ? '' : 'disabled'}">
          <label>提示类型</label>
          <div class="cue-types">
            <label class="checkbox-label">
              <input type="checkbox" data-cue="border" ${this.config.cueTypes.border ? 'checked' : ''}>
              <span>边框闪烁</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" data-cue="vibrate" ${this.config.cueTypes.vibrate ? 'checked' : ''}>
              <span>震动反馈</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" data-cue="icon" ${this.config.cueTypes.icon ? 'checked' : ''}>
              <span>图标+文字标签</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" data-cue="flash" ${this.config.cueTypes.flash ? 'checked' : ''}>
              <span>屏幕闪烁 (警告类)</span>
            </label>
            <label class="checkbox-label">
              <input type="checkbox" data-cue="caption" ${this.config.cueTypes.caption ? 'checked' : ''}>
              <span>字幕显示</span>
            </label>
          </div>
        </div>
        
        <div class="setting-group ${this.config.enabled ? '' : 'disabled'}">
          <label>提示位置</label>
          <select id="cue-position">
            <option value="top-right" ${this.config.position === 'top-right' ? 'selected' : ''}>右上角</option>
            <option value="top-left" ${this.config.position === 'top-left' ? 'selected' : ''}>左上角</option>
            <option value="bottom-right" ${this.config.position === 'bottom-right' ? 'selected' : ''}>右下角</option>
            <option value="bottom-left" ${this.config.position === 'bottom-left' ? 'selected' : ''}>左下角</option>
          </select>
        </div>
        
        <div class="setting-actions">
          <button class="btn-test" id="test-visual-cue">测试效果</button>
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    this.bindEvents();
  }

  bindEvents() {
    // 启用开关
    this.container.querySelector('#cue-enabled').addEventListener('change', (e) => {
      this.config.enabled = e.target.checked;
      this.saveConfig();
      audioVisualizer.configure(this.config);
      this.updateDisabledState();
    });

    // 强度选择
    this.container.querySelectorAll('.intensity-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const intensity = parseInt(e.target.dataset.intensity);
        this.config.intensity = intensity;
        this.saveConfig();
        audioVisualizer.configure(this.config);
        this.updateIntensityUI();
      });
    });

    // 提示类型
    this.container.querySelectorAll('[data-cue]').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        this.config.cueTypes[e.target.dataset.cue] = e.target.checked;
        this.saveConfig();
        audioVisualizer.configure(this.config);
      });
    });

    // 位置选择
    this.container.querySelector('#cue-position').addEventListener('change', (e) => {
      this.config.position = e.target.value;
      this.saveConfig();
      audioVisualizer.configure(this.config);
    });

    // 测试按钮
    this.container.querySelector('#test-visual-cue').addEventListener('click', () => {
      audioVisualizer.visualize('pokemon_spawn');
    });
  }

  updateDisabledState() {
    const groups = this.container.querySelectorAll('.setting-group');
    groups.forEach(g => {
      g.classList.toggle('disabled', !this.config.enabled);
    });
  }

  updateIntensityUI() {
    this.container.querySelectorAll('.intensity-btn').forEach(btn => {
      const isActive = parseInt(btn.dataset.intensity) === this.config.intensity;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-checked', isActive);
    });
  }
}
```

### 4.5 样式文件

```css
/* frontend/game-client/src/accessibility/AudioVisualizer.css */

/* 边框闪烁 */
.border-flash {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border: 0 solid transparent;
  pointer-events: none;
  z-index: 9999;
  transition: border-width 0.1s ease;
}

.border-flash.active {
  border-width: 8px;
  animation: border-pulse 1s ease-out;
}

@keyframes border-pulse {
  0% { opacity: 1; }
  50% { opacity: 0.5; }
  100% { opacity: 0; }
}

/* 音效提示容器 */
.audio-visualizer {
  position: fixed;
  z-index: 9998;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.audio-visualizer.top-right { top: 60px; right: 10px; }
.audio-visualizer.top-left { top: 60px; left: 10px; }
.audio-visualizer.bottom-right { bottom: 60px; right: 10px; }
.audio-visualizer.bottom-left { bottom: 60px; left: 10px; }

/* 单个提示 */
.audio-cue {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(0, 0, 0, 0.85);
  border-radius: 24px;
  color: white;
  font-size: 14px;
  transform: translateX(100px);
  opacity: 0;
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.audio-cue.enter {
  transform: translateX(0);
  opacity: 1;
}

.audio-cue.exit {
  transform: translateX(100px);
  opacity: 0;
}

.audio-cue .cue-icon {
  font-size: 20px;
}

/* 屏幕闪烁 */
.screen-flash {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: white;
  opacity: 0;
  pointer-events: none;
  z-index: 9997;
  animation: screen-flash 0.2s ease-out;
}

@keyframes screen-flash {
  0% { opacity: 0.5; }
  100% { opacity: 0; }
}

/* 设置面板样式 */
.visual-cue-settings .setting-group {
  margin-bottom: 16px;
}

.visual-cue-settings .setting-group.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.visual-cue-settings .intensity-selector {
  display: flex;
  gap: 8px;
}

.intensity-btn {
  flex: 1;
  padding: 8px 12px;
  border: 2px solid #ddd;
  border-radius: 8px;
  background: white;
  cursor: pointer;
  transition: all 0.2s;
}

.intensity-btn:hover {
  border-color: #666;
}

.intensity-btn.active {
  border-color: #4CAF50;
  background: #e8f5e9;
  font-weight: bold;
}

.cue-types {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checkbox-label,
.toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.btn-test {
  padding: 10px 20px;
  background: #2196F3;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
}

.btn-test:hover {
  background: #1976D2;
}
```

### 4.6 Gateway 音效事件推送

```javascript
// backend/gateway/middleware/audioEventMiddleware.js

/**
 * 为关键游戏事件添加音效事件元数据
 * 客户端根据此元数据触发音效可视化
 */
export function audioEventMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  
  res.json = function(data) {
    // 检测是否有关键游戏事件
    if (data && data.event) {
      data.audioVisualHint = getAudioVisualHint(data.event);
    }
    return originalJson(data);
  };
  
  next();
}

function getAudioVisualHint(event) {
  const hints = {
    'pokemon.spawn': { effect: 'pokemon_spawn', priority: 0 },
    'catch.success': { effect: 'catch_success', priority: 0 },
    'catch.fail': { effect: 'catch_fail', priority: 0 },
    'battle.start': { effect: 'battle_start', priority: 0 },
    'battle.hit': { effect: 'battle_hit', priority: 0 },
    'battle.skill': { effect: 'battle_skill', priority: 1 },
    'battle.victory': { effect: 'battle_victory', priority: 0 },
    'achievement.unlock': { effect: 'achievement', priority: 0 },
    'quest.complete': { effect: 'quest_complete', priority: 1 },
    'warning': { effect: 'warning', priority: 0 }
  };
  
  return hints[event] || null;
}
```

## 5. 验收标准（可测试）

- [ ] 音效可视化可通过设置面板启用/禁用
- [ ] P0 关键音效（精灵出现、捕捉成功/失败、战斗开始、警告）必须提供至少 2 种视觉提示
- [ ] 边框闪烁效果在 500ms 内可被用户感知，颜色按优先级区分
- [ ] 震动反馈在支持的移动设备上正常工作（iOS/Android）
- [ ] 图标+文字标签显示持续时间 ≥ 2s，支持自定义位置
- [ ] 配置可持久化到 localStorage，下次访问自动恢复
- [ ] 与现有 AnimationSettings（减少动画模式）兼容，不会在 reduce-motion 模式下过度动画
- [ ] 不影响正常音频播放，仅作为补充
- [ ] ARIA 实时区域正确标记，屏幕阅读器可读出提示内容
- [ ] 移动端和桌面端均能正常显示视觉提示

## 6. 工作量估算

**L（Large）** - 需要约 2-3 天完成

理由：
- 涉及多个新模块开发
- 需要梳理并集成所有关键音效类型
- 移动端震动 API 兼容性测试
- 与现有无障碍系统集成
- UI 设计和样式开发

## 7. 优先级理由

**P1（高优先级）**

1. **无障碍合规**：满足 WCAG 2.1 AAA 级标准对时间敏感媒体的替代要求
2. **用户群体大**：全球约 5% 人口有不同程度的听力损失
3. **竞争优势**：主流手游中此功能尚不普及，可提升品牌形象
4. **依赖基础已就绪**：REQ-00017 和 REQ-00162 已实现基础无障碍框架
