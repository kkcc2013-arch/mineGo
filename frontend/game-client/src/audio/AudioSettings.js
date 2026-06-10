/**
 * AudioSettings - 音频设置面板组件
 * 
 * 功能：
 * - 音量滑块控制（主音量、音乐、音效）
 * - 音乐/音效开关
 * - 静音按钮
 * - 实时预览
 * 
 * @module AudioSettings
 */

class AudioSettings {
  constructor(container, audioManager) {
    this.container = container;
    this.audioManager = audioManager || window.audioManager;
    this.elements = {};
    
    this.init();
  }
  
  /**
   * 初始化设置面板
   */
  init() {
    this.render();
    this.bindEvents();
    this.updateUI();
  }
  
  /**
   * 渲染 UI
   */
  render() {
    const html = `
      <div class="audio-settings-panel">
        <h3 class="settings-title">🔊 音频设置</h3>
        
        <div class="setting-group">
          <div class="setting-row">
            <label class="setting-label">主音量</label>
            <div class="setting-control">
              <input type="range" 
                     id="master-volume-slider" 
                     class="volume-slider"
                     min="0" 
                     max="100" 
                     value="${Math.round(this.audioManager.masterVolume * 100)}">
              <span id="master-volume-value" class="volume-value">${Math.round(this.audioManager.masterVolume * 100)}%</span>
            </div>
          </div>
          
          <div class="setting-row">
            <label class="setting-label">背景音乐</label>
            <div class="setting-control">
              <input type="range" 
                     id="music-volume-slider" 
                     class="volume-slider"
                     min="0" 
                     max="100" 
                     value="${Math.round(this.audioManager.musicVolume * 100)}">
              <span id="music-volume-value" class="volume-value">${Math.round(this.audioManager.musicVolume * 100)}%</span>
              <button id="music-toggle-btn" 
                      class="toggle-btn ${this.audioManager.musicEnabled ? 'active' : ''}"
                      aria-label="切换背景音乐">
                ${this.audioManager.musicEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
          
          <div class="setting-row">
            <label class="setting-label">音效</label>
            <div class="setting-control">
              <input type="range" 
                     id="sfx-volume-slider" 
                     class="volume-slider"
                     min="0" 
                     max="100" 
                     value="${Math.round(this.audioManager.sfxVolume * 100)}">
              <span id="sfx-volume-value" class="volume-value">${Math.round(this.audioManager.sfxVolume * 100)}%</span>
              <button id="sfx-toggle-btn" 
                      class="toggle-btn ${this.audioManager.sfxEnabled ? 'active' : ''}"
                      aria-label="切换音效">
                ${this.audioManager.sfxEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        </div>
        
        <div class="setting-actions">
          <button id="mute-btn" 
                  class="action-btn ${this.audioManager.muted ? 'muted' : ''}"
                  aria-label="静音">
            ${this.audioManager.muted ? '🔇 已静音' : '🔊 静音'}
          </button>
          <button id="test-sound-btn" class="action-btn secondary" aria-label="测试音效">
            🎵 测试音效
          </button>
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    
    // 缓存元素引用
    this.elements = {
      masterVolumeSlider: document.getElementById('master-volume-slider'),
      masterVolumeValue: document.getElementById('master-volume-value'),
      musicVolumeSlider: document.getElementById('music-volume-slider'),
      musicVolumeValue: document.getElementById('music-volume-value'),
      musicToggleBtn: document.getElementById('music-toggle-btn'),
      sfxVolumeSlider: document.getElementById('sfx-volume-slider'),
      sfxVolumeValue: document.getElementById('sfx-volume-value'),
      sfxToggleBtn: document.getElementById('sfx-toggle-btn'),
      muteBtn: document.getElementById('mute-btn'),
      testSoundBtn: document.getElementById('test-sound-btn')
    };
  }
  
  /**
   * 绑定事件
   */
  bindEvents() {
    // 主音量滑块
    this.elements.masterVolumeSlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value) / 100;
      this.audioManager.setMasterVolume(value);
      this.elements.masterVolumeValue.textContent = `${e.target.value}%`;
    });
    
    // 音乐音量滑块
    this.elements.musicVolumeSlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value) / 100;
      this.audioManager.setMusicVolume(value);
      this.elements.musicVolumeValue.textContent = `${e.target.value}%`;
    });
    
    // 音效音量滑块
    this.elements.sfxVolumeSlider.addEventListener('input', (e) => {
      const value = parseInt(e.target.value) / 100;
      this.audioManager.setSfxVolume(value);
      this.elements.sfxVolumeValue.textContent = `${e.target.value}%`;
    });
    
    // 音乐开关
    this.elements.musicToggleBtn.addEventListener('click', () => {
      const enabled = !this.audioManager.musicEnabled;
      this.audioManager.setMusicEnabled(enabled);
      this.elements.musicToggleBtn.textContent = enabled ? 'ON' : 'OFF';
      this.elements.musicToggleBtn.classList.toggle('active', enabled);
      
      // 播放点击音效
      this.audioManager.playSfx('ui_click');
    });
    
    // 音效开关
    this.elements.sfxToggleBtn.addEventListener('click', () => {
      const enabled = !this.audioManager.sfxEnabled;
      this.audioManager.setSfxEnabled(enabled);
      this.elements.sfxToggleBtn.textContent = enabled ? 'ON' : 'OFF';
      this.elements.sfxToggleBtn.classList.toggle('active', enabled);
      
      if (enabled) {
        this.audioManager.playSfx('ui_click');
      }
    });
    
    // 静音按钮
    this.elements.muteBtn.addEventListener('click', () => {
      this.audioManager.toggleMute();
      this.updateMuteButton();
    });
    
    // 测试音效按钮
    this.elements.testSoundBtn.addEventListener('click', () => {
      this.testSound();
    });
  }
  
  /**
   * 更新 UI
   */
  updateUI() {
    // 更新滑块值
    this.elements.masterVolumeSlider.value = Math.round(this.audioManager.masterVolume * 100);
    this.elements.masterVolumeValue.textContent = `${Math.round(this.audioManager.masterVolume * 100)}%`;
    
    this.elements.musicVolumeSlider.value = Math.round(this.audioManager.musicVolume * 100);
    this.elements.musicVolumeValue.textContent = `${Math.round(this.audioManager.musicVolume * 100)}%`;
    
    this.elements.sfxVolumeSlider.value = Math.round(this.audioManager.sfxVolume * 100);
    this.elements.sfxVolumeValue.textContent = `${Math.round(this.audioManager.sfxVolume * 100)}%`;
    
    // 更新开关状态
    this.elements.musicToggleBtn.textContent = this.audioManager.musicEnabled ? 'ON' : 'OFF';
    this.elements.musicToggleBtn.classList.toggle('active', this.audioManager.musicEnabled);
    
    this.elements.sfxToggleBtn.textContent = this.audioManager.sfxEnabled ? 'ON' : 'OFF';
    this.elements.sfxToggleBtn.classList.toggle('active', this.audioManager.sfxEnabled);
    
    // 更新静音按钮
    this.updateMuteButton();
  }
  
  /**
   * 更新静音按钮
   */
  updateMuteButton() {
    this.elements.muteBtn.textContent = this.audioManager.muted ? '🔇 已静音' : '🔊 静音';
    this.elements.muteBtn.classList.toggle('muted', this.audioManager.muted);
  }
  
  /**
   * 测试音效
   */
  async testSound() {
    // 播放一系列音效
    await this.audioManager.playSfx('ui_click');
    
    setTimeout(() => {
      this.audioManager.playSfx('ui_notification');
    }, 300);
    
    setTimeout(() => {
      this.audioManager.playSfx('reward');
    }, 600);
  }
  
  /**
   * 显示面板
   */
  show() {
    this.container.style.display = 'block';
  }
  
  /**
   * 隐藏面板
   */
  hide() {
    this.container.style.display = 'none';
  }
  
  /**
   * 切换显示
   */
  toggle() {
    const isVisible = this.container.style.display !== 'none';
    this.container.style.display = isVisible ? 'none' : 'block';
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AudioSettings;
} else if (typeof window !== 'undefined') {
  window.AudioSettings = AudioSettings;
}
