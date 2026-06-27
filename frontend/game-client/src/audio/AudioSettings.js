/**
 * AudioSettings - 音频设置面板组件
 * 提供音量控制、静音开关等UI
 */

class AudioSettings {
  constructor(container, audioManager) {
    this.container = container;
    this.audioManager = audioManager;
    this.isOpen = false;
  }

  /**
   * 渲染设置面板
   */
  render() {
    const settings = this.audioManager.settings;

    const html = `
      <div class="audio-settings-panel ${this.isOpen ? 'open' : ''}">
        <div class="settings-header">
          <h3>音频设置</h3>
          <button class="close-btn" id="audio-settings-close">×</button>
        </div>
        
        <div class="settings-body">
          <!-- 主音量 -->
          <div class="setting-row">
            <label>总音量</label>
            <div class="slider-container">
              <input type="range" 
                     id="master-volume" 
                     min="0" 
                     max="100" 
                     value="${Math.round(settings.masterVolume * 100)}">
              <span class="volume-value" id="master-volume-val">${Math.round(settings.masterVolume * 100)}%</span>
            </div>
          </div>

          <!-- 背景音乐 -->
          <div class="setting-row">
            <label>背景音乐</label>
            <div class="slider-container">
              <input type="range" 
                     id="music-volume" 
                     min="0" 
                     max="100" 
                     value="${Math.round(settings.musicVolume * 100)}"
                     ${settings.musicMuted ? 'disabled' : ''}>
              <span class="volume-value" id="music-volume-val">${Math.round(settings.musicVolume * 100)}%</span>
              <button class="toggle-btn ${settings.musicMuted ? 'muted' : ''}" 
                      id="music-toggle">
                ${settings.musicMuted ? 'OFF' : 'ON'}
              </button>
            </div>
          </div>

          <!-- 音效 -->
          <div class="setting-row">
            <label>音效</label>
            <div class="slider-container">
              <input type="range" 
                     id="sfx-volume" 
                     min="0" 
                     max="100" 
                     value="${Math.round(settings.sfxVolume * 100)}"
                     ${settings.sfxMuted ? 'disabled' : ''}>
              <span class="volume-value" id="sfx-volume-val">${Math.round(settings.sfxVolume * 100)}%</span>
              <button class="toggle-btn ${settings.sfxMuted ? 'muted' : ''}" 
                      id="sfx-toggle">
                ${settings.sfxMuted ? 'OFF' : 'ON'}
              </button>
            </div>
          </div>

          <!-- 静音所有 -->
          <div class="setting-row">
            <label>全部静音</label>
            <button class="toggle-btn ${settings.muted ? 'muted' : ''}" 
                    id="master-toggle">
              ${settings.muted ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        <div class="settings-footer">
          <button class="test-btn" id="test-sound">测试音效</button>
        </div>
      </div>
    `;

    this.container.innerHTML = html;
    this.bindEvents();
  }

  /**
   * 绑定事件
   */
  bindEvents() {
    // 主音量滑块
    const masterVolume = document.getElementById('master-volume');
    masterVolume?.addEventListener('input', (e) => {
      const value = e.target.value / 100;
      this.audioManager.setMasterVolume(value);
      document.getElementById('master-volume-val').textContent = `${e.target.value}%`;
    });

    // 音乐音量滑块
    const musicVolume = document.getElementById('music-volume');
    musicVolume?.addEventListener('input', (e) => {
      const value = e.target.value / 100;
      this.audioManager.setMusicVolume(value);
      document.getElementById('music-volume-val').textContent = `${e.target.value}%`;
    });

    // 音效音量滑块
    const sfxVolume = document.getElementById('sfx-volume');
    sfxVolume?.addEventListener('input', (e) => {
      const value = e.target.value / 100;
      this.audioManager.setSfxVolume(value);
      document.getElementById('sfx-volume-val').textContent = `${e.target.value}%`;
    });

    // 音乐开关
    const musicToggle = document.getElementById('music-toggle');
    musicToggle?.addEventListener('click', () => {
      const muted = this.audioManager.toggleMusicMute();
      musicToggle.textContent = muted ? 'OFF' : 'ON';
      musicToggle.classList.toggle('muted', muted);
      musicVolume.disabled = muted;
    });

    // 音效开关
    const sfxToggle = document.getElementById('sfx-toggle');
    sfxToggle?.addEventListener('click', () => {
      const muted = this.audioManager.toggleSfxMute();
      sfxToggle.textContent = muted ? 'OFF' : 'ON';
      sfxToggle.classList.toggle('muted', muted);
      sfxVolume.disabled = muted;
    });

    // 全局静音
    const masterToggle = document.getElementById('master-toggle');
    masterToggle?.addEventListener('click', () => {
      const muted = this.audioManager.toggleMute();
      masterToggle.textContent = muted ? 'ON' : 'OFF';
      masterToggle.classList.toggle('muted', muted);
    });

    // 测试音效
    const testSound = document.getElementById('test-sound');
    testSound?.addEventListener('click', () => {
      this.audioManager.playSfx('ui_click');
    });

    // 关闭按钮
    const closeBtn = document.getElementById('audio-settings-close');
    closeBtn?.addEventListener('click', () => {
      this.toggle();
    });
  }

  /**
   * 切换面板显示
   */
  toggle() {
    this.isOpen = !this.isOpen;
    const panel = this.container.querySelector('.audio-settings-panel');
    if (panel) {
      panel.classList.toggle('open', this.isOpen);
    }
  }

  /**
   * 打开面板
   */
  open() {
    if (!this.isOpen) {
      this.toggle();
    }
  }

  /**
   * 关闭面板
   */
  close() {
    if (this.isOpen) {
      this.toggle();
    }
  }
}

// CSS 样式（可以单独提取到 CSS 文件）
const styles = `
.audio-settings-panel {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.9);
  background: rgba(255, 255, 255, 0.95);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  padding: 24px;
  min-width: 320px;
  opacity: 0;
  pointer-events: none;
  transition: all 0.3s ease;
  z-index: 1000;
}

.audio-settings-panel.open {
  opacity: 1;
  pointer-events: auto;
  transform: translate(-50%, -50%) scale(1);
}

.settings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ddd;
}

.settings-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.close-btn {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
  color: #666;
  padding: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
}

.close-btn:hover {
  background: #f0f0f0;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 8px 0;
}

.setting-row label {
  font-weight: 500;
  color: #333;
  min-width: 80px;
}

.slider-container {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.slider-container input[type="range"] {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: #ddd;
  border-radius: 2px;
  outline: none;
}

.slider-container input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  background: #4CAF50;
  border-radius: 50%;
  cursor: pointer;
}

.slider-container input[type="range"]::-moz-range-thumb {
  width: 16px;
  height: 16px;
  background: #4CAF50;
  border-radius: 50%;
  cursor: pointer;
  border: none;
}

.slider-container input[type="range"]:disabled {
  opacity: 0.5;
}

.volume-value {
  min-width: 40px;
  text-align: right;
  color: #666;
  font-size: 14px;
}

.toggle-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 16px;
  background: #4CAF50;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.toggle-btn.muted {
  background: #ccc;
}

.toggle-btn:hover {
  opacity: 0.9;
}

.settings-footer {
  margin-top: 20px;
  padding-top: 12px;
  border-top: 1px solid #ddd;
  text-align: center;
}

.test-btn {
  padding: 8px 24px;
  border: none;
  border-radius: 20px;
  background: #2196F3;
  color: white;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.test-btn:hover {
  background: #1976D2;
}
`;

// 注入样式
function injectStyles() {
  const styleElement = document.createElement('style');
  styleElement.textContent = styles;
  document.head.appendChild(styleElement);
}

module.exports = { AudioSettings, injectStyles };
