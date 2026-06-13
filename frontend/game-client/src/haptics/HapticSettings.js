/**
 * HapticSettings - 震动设置组件
 * 
 * 提供用户可配置的震动强度和开关设置界面
 */

import { hapticManager, HapticManager } from './HapticManager.js';

export class HapticSettings {
  constructor(container) {
    this.container = container;
    this.elements = {};
    this._render();
    this._bindEvents();
    this._loadState();
  }

  _render() {
    const html = `
      <div class="haptic-settings">
        <div class="setting-group">
          <label class="setting-label">
            <span class="label-text">震动反馈</span>
            <div class="toggle-switch">
              <input type="checkbox" id="haptic-enabled" class="toggle-input">
              <span class="toggle-slider"></span>
            </div>
          </label>
        </div>
        
        <div class="setting-group intensity-group" id="intensity-section">
          <label class="setting-label">
            <span class="label-text">震动强度</span>
          </label>
          <div class="intensity-options">
            <label class="intensity-option">
              <input type="radio" name="haptic-intensity" value="1">
              <span class="option-label">轻</span>
            </label>
            <label class="intensity-option">
              <input type="radio" name="haptic-intensity" value="2" checked>
              <span class="option-label">中</span>
            </label>
            <label class="intensity-option">
              <input type="radio" name="haptic-intensity" value="3">
              <span class="option-label">强</span>
            </label>
          </div>
        </div>
        
        <div class="setting-group" id="silent-boost-section">
          <label class="setting-label">
            <span class="label-text">静音时增强震动</span>
            <div class="toggle-switch">
              <input type="checkbox" id="haptic-silent-boost" class="toggle-input">
              <span class="toggle-slider"></span>
            </div>
          </label>
          <p class="setting-hint">当游戏静音时，自动增强震动反馈</p>
        </div>
        
        <div class="setting-group">
          <button id="haptic-test" class="test-btn">
            <span>🫨</span> 测试震动
          </button>
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    
    // 缓存元素引用
    this.elements = {
      enabled: this.container.querySelector('#haptic-enabled'),
      intensityOptions: this.container.querySelectorAll('input[name="haptic-intensity"]'),
      silentBoost: this.container.querySelector('#haptic-silent-boost'),
      testBtn: this.container.querySelector('#haptic-test'),
      intensitySection: this.container.querySelector('#intensity-section'),
      silentBoostSection: this.container.querySelector('#silent-boost-section')
    };
  }

  _bindEvents() {
    // 震动开关
    this.elements.enabled.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      hapticManager.setEnabled(enabled);
      this._updateUI();
      
      if (enabled) {
        hapticManager.vibrate('toggle_on');
      }
    });

    // 强度选择
    this.elements.intensityOptions.forEach(option => {
      option.addEventListener('change', (e) => {
        const intensity = parseInt(e.target.value, 10);
        hapticManager.setIntensity(intensity);
        hapticManager.vibrate('button_press');
      });
    });

    // 静音增强开关
    this.elements.silentBoost.addEventListener('change', (e) => {
      hapticManager.setSilentModeBoost(e.target.checked);
      hapticManager.vibrate('toggle_on');
    });

    // 测试按钮
    this.elements.testBtn.addEventListener('click', () => {
      this._testHaptic();
    });
  }

  _loadState() {
    // 加载当前设置状态
    this.elements.enabled.checked = hapticManager.isEnabled();
    this.elements.silentBoost.checked = hapticManager._silentModeBoost;
    
    const intensity = hapticManager.getIntensity();
    this.elements.intensityOptions.forEach(option => {
      option.checked = parseInt(option.value, 10) === intensity;
    });
    
    this._updateUI();
  }

  _updateUI() {
    const enabled = hapticManager.isEnabled() && hapticManager.isSupported();
    
    // 根据主开关状态禁用/启用子选项
    this.elements.intensitySection.style.opacity = enabled ? '1' : '0.5';
    this.elements.intensitySection.style.pointerEvents = enabled ? 'auto' : 'none';
    
    this.elements.silentBoostSection.style.opacity = enabled ? '1' : '0.5';
    this.elements.silentBoostSection.style.pointerEvents = enabled ? 'auto' : 'none';
    
    this.elements.testBtn.disabled = !enabled;
  }

  _testHaptic() {
    // 播放测试震动序列
    const patterns = ['tap', 'button_press', 'catch_success'];
    
    let delay = 0;
    patterns.forEach((pattern, index) => {
      setTimeout(() => {
        hapticManager.vibrate(pattern);
      }, delay);
      delay += 500;
    });
  }

  /**
   * 销毁组件
   */
  destroy() {
    this.container.innerHTML = '';
    this.elements = {};
  }
}

export default HapticSettings;
