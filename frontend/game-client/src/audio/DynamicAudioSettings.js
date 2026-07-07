/**
 * DynamicAudioSettings - 动态音效设置 UI 组件
 * REQ-00470：游戏内动态音效与背景音乐智能调节系统
 * 
 * 功能：
 * - 显示动态调节开关
 * - 调节强度倍数
 * - 设置环境音效偏好
 */

class DynamicAudioSettings {
  constructor(container) {
    this.container = container;
    this.audioManager = null;
    this.adjuster = null;
    
    this.state = {
      enabled: true,
      intensityMultiplier: 1.0,
      ambientLevel: 0.5
    };
  }
  
  /**
   * 初始化
   */
  init(audioManager) {
    this.audioManager = audioManager;
    this.adjuster = audioManager?.getDynamicAdjuster();
    
    // 加载用户偏好
    if (this.adjuster) {
      this.state = {
        enabled: this.adjuster.userPreferences.dynamicAdjustmentEnabled,
        intensityMultiplier: this.adjuster.userPreferences.intensityMultiplier,
        ambientLevel: this.adjuster.userPreferences.preferredAmbientLevel
      };
    }
    
    this.render();
    this.attachEventListeners();
  }
  
  /**
   * 渲染 UI
   */
  render() {
    this.container.innerHTML = `
      <div class="dynamic-audio-settings">
        <h3>${i18n.t('audio.dynamic.title')}</h3>
        <p class="description">${i18n.t('audio.dynamic.description')}</p>
        
        <div class="setting-item">
          <label>
            <input type="checkbox" 
                   id="dynamic-enabled" 
                   ${this.state.enabled ? 'checked' : ''}>
            ${i18n.t('audio.dynamic.enabled')}
          </label>
          <p class="hint">${i18n.t('audio.dynamic.enabled.hint')}</p>
        </div>
        
        <div class="setting-item ${this.state.enabled ? '' : 'disabled'}">
          <label for="intensity-slider">
            ${i18n.t('audio.dynamic.intensity')}
          </label>
          <div class="slider-container">
            <input type="range" 
                   id="intensity-slider"
                   min="0.5" 
                   max="1.5" 
                   step="0.1"
                   value="${this.state.intensityMultiplier}"
                   ${!this.state.enabled ? 'disabled' : ''}>
            <span class="slider-value">${(this.state.intensityMultiplier * 100).toFixed(0)}%</span>
          </div>
          <p class="hint">${i18n.t('audio.dynamic.intensity.hint')}</p>
        </div>
        
        <div class="setting-item ${this.state.enabled ? '' : 'disabled'}">
          <label for="ambient-slider">
            ${i18n.t('audio.dynamic.ambient')}
          </label>
          <div class="slider-container">
            <input type="range" 
                   id="ambient-slider"
                   min="0" 
                   max="1" 
                   step="0.1"
                   value="${this.state.ambientLevel}"
                   ${!this.state.enabled ? 'disabled' : ''}>
            <span class="slider-value">${(this.state.ambientLevel * 100).toFixed(0)}%</span>
          </div>
          <p class="hint">${i18n.t('audio.dynamic.ambient.hint')}</p>
        </div>
        
        <div class="status-indicator">
          <span class="status-dot ${this.state.enabled && this.adjuster ? 'active' : ''}"></span>
          <span class="status-text">${this.getStatusText()}</span>
        </div>
        
        ${this.renderDebugInfo()}
      </div>
    `;
  }
  
  /**
   * 渲染调试信息
   */
  renderDebugInfo() {
    if (!this.adjuster || !this.state.enabled) {
      return '';
    }
    
    const report = this.adjuster.getStatusReport();
    
    return `
      <details class="debug-info">
        <summary>${i18n.t('audio.dynamic.debug')}</summary>
        <div class="debug-content">
          <p><strong>${i18n.t('audio.dynamic.debug.battleIntensity')}:</strong> ${(report.state.battleIntensity * 100).toFixed(0)}%</p>
          <p><strong>${i18n.t('audio.dynamic.debug.weather')}:</strong> ${report.state.weather}</p>
          <p><strong>${i18n.t('audio.dynamic.debug.bgmStyle')}:</strong> ${report.state.bgmStyle}</p>
          <p><strong>${i18n.t('audio.dynamic.debug.lowpass')}:</strong> ${report.audio.lowpassFreq.toFixed(0)} Hz</p>
          <p><strong>${i18n.t('audio.dynamic.debug.reverb')}:</strong> ${(report.audio.reverbMix * 100).toFixed(0)}%</p>
        </div>
      </details>
    `;
  }
  
  /**
   * 获取状态文本
   */
  getStatusText() {
    if (!this.adjuster) {
      return i18n.t('audio.dynamic.status.unavailable');
    }
    
    if (!this.state.enabled) {
      return i18n.t('audio.dynamic.status.disabled');
    }
    
    return i18n.t('audio.dynamic.status.active');
  }
  
  /**
   * 绑定事件监听器
   */
  attachEventListeners() {
    // 启用开关
    const enabledCheckbox = this.container.querySelector('#dynamic-enabled');
    if (enabledCheckbox) {
      enabledCheckbox.addEventListener('change', (e) => {
        this.state.enabled = e.target.checked;
        this.applySettings();
        this.render(); // 重新渲染以更新禁用状态
      });
    }
    
    // 强度滑块
    const intensitySlider = this.container.querySelector('#intensity-slider');
    if (intensitySlider) {
      intensitySlider.addEventListener('input', (e) => {
        this.state.intensityMultiplier = parseFloat(e.target.value);
        this.updateSliderValue(e.target, this.state.intensityMultiplier);
        this.applySettings();
      });
    }
    
    // 环境音效滑块
    const ambientSlider = this.container.querySelector('#ambient-slider');
    if (ambientSlider) {
      ambientSlider.addEventListener('input', (e) => {
        this.state.ambientLevel = parseFloat(e.target.value);
        this.updateSliderValue(e.target, this.state.ambientLevel);
        this.applySettings();
      });
    }
  }
  
  /**
   * 更新滑块显示值
   */
  updateSliderValue(slider, value) {
    const valueSpan = slider.parentElement.querySelector('.slider-value');
    if (valueSpan) {
      valueSpan.textContent = `${(value * 100).toFixed(0)}%`;
    }
  }
  
  /**
   * 应用设置
   */
  applySettings() {
    if (!this.adjuster) return;
    
    this.adjuster.setUserPreferences({
      dynamicAdjustmentEnabled: this.state.enabled,
      intensityMultiplier: this.state.intensityMultiplier,
      preferredAmbientLevel: this.state.ambientLevel
    });
    
    this.adjuster.setEnabled(this.state.enabled);
  }
}

// CSS 样式
const styles = `
.dynamic-audio-settings {
  padding: 16px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 8px;
  margin-top: 16px;
}

.dynamic-audio-settings h3 {
  margin: 0 0 8px 0;
  font-size: 16px;
}

.dynamic-audio-settings .description {
  font-size: 13px;
  color: #666;
  margin-bottom: 16px;
}

.setting-item {
  margin-bottom: 16px;
}

.setting-item.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.setting-item label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.setting-item input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.slider-container input[type="range"] {
  flex: 1;
  height: 6px;
  cursor: pointer;
}

.slider-value {
  min-width: 40px;
  text-align: right;
  font-weight: bold;
}

.hint {
  font-size: 12px;
  color: #888;
  margin-top: 4px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 4px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;
}

.status-dot.active {
  background: #4caf50;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.debug-info {
  margin-top: 16px;
  font-size: 12px;
}

.debug-content {
  padding: 12px;
  background: rgba(0, 0, 0, 0.02);
  margin-top: 8px;
  border-radius: 4px;
}

.debug-content p {
  margin: 4px 0;
}
`;

// 注入样式
if (typeof document !== 'undefined' && !document.getElementById('dynamic-audio-settings-styles')) {
  const styleSheet = document.createElement('style');
  styleSheet.id = 'dynamic-audio-settings-styles';
  styleSheet.textContent = styles;
  document.head.appendChild(styleSheet);
}

// i18n 回退
const i18n = window.i18n || {
  t: (key) => {
    const fallbacks = {
      'audio.dynamic.title': '动态音效调节',
      'audio.dynamic.description': '根据游戏状态自动调整音效强度和背景音乐风格',
      'audio.dynamic.enabled': '启用动态调节',
      'audio.dynamic.enabled.hint': '在战斗、天气变化时自动调整音效',
      'audio.dynamic.intensity': '效果强度',
      'audio.dynamic.intensity.hint': '调节动态效果的整体强度',
      'audio.dynamic.ambient': '环境音效',
      'audio.dynamic.ambient.hint': '天气相关的环境音效音量',
      'audio.dynamic.status.active': '运行中',
      'audio.dynamic.status.disabled': '已禁用',
      'audio.dynamic.status.unavailable': '不可用',
      'audio.dynamic.debug': '调试信息',
      'audio.dynamic.debug.battleIntensity': '战斗强度',
      'audio.dynamic.debug.weather': '天气',
      'audio.dynamic.debug.bgmStyle': 'BGM 风格',
      'audio.dynamic.debug.lowpass': '低通滤波器',
      'audio.dynamic.debug.reverb': '混响'
    };
    return fallbacks[key] || key;
  }
};

// 导出
export { DynamicAudioSettings };
export default DynamicAudioSettings;