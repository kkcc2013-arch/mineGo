/**
 * Animation Settings - 动画控制系统
 * 支持系统设置和用户偏好
 */

export class AnimationSettings {
  constructor() {
    this.systemPreference = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.userPreference = localStorage.getItem('reduced-motion') === 'true';
    this.init();
  }

  init() {
    // 监听系统设置变化
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.systemPreference = e.matches;
      this.applySettings();
      console.log('[A11y] System reduced-motion preference changed:', e.matches);
    });

    // 应用初始设置
    this.applySettings();
    console.log('[A11y] Animation settings initialized, reducedMotion:', this.shouldReduceMotion());
  }

  /**
   * 是否应该减少动画
   */
  shouldReduceMotion() {
    return this.systemPreference || this.userPreference;
  }

  /**
   * 是否应该播放动画
   */
  shouldAnimate() {
    return !this.shouldReduceMotion();
  }

  /**
   * 启用减少动画模式
   */
  enableReducedMotion() {
    this.userPreference = true;
    localStorage.setItem('reduced-motion', 'true');
    this.applySettings();
    console.log('[A11y] Reduced motion enabled by user');
  }

  /**
   * 禁用减少动画模式
   */
  disableReducedMotion() {
    this.userPreference = false;
    localStorage.setItem('reduced-motion', 'false');
    this.applySettings();
    console.log('[A11y] Reduced motion disabled by user');
  }

  /**
   * 应用设置到 DOM
   */
  applySettings() {
    const root = document.documentElement;
    
    if (this.shouldReduceMotion()) {
      root.classList.add('reduced-motion');
      this.injectReducedMotionStyles();
    } else {
      root.classList.remove('reduced-motion');
    }
  }

  /**
   * 注入减少动画 CSS
   */
  injectReducedMotionStyles() {
    if (!document.getElementById('reduced-motion-styles')) {
      const style = document.createElement('style');
      style.id = 'reduced-motion-styles';
      style.textContent = `
        body.reduced-motion *,
        body.reduced-motion *::before,
        body.reduced-motion *::after {
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: 0.01ms !important;
          scroll-behavior: auto !important;
        }
        
        body.reduced-motion .logo-emoji,
        body.reduced-motion .wild-emoji {
          animation: none !important;
        }
        
        body.reduced-motion .ring-fill {
          transition: none !important;
        }
      `;
      document.head.appendChild(style);
    }
  }

  /**
   * 获取动画设置状态描述
   */
  getStatusDescription() {
    if (this.systemPreference) {
      return '系统设置：减少动画';
    }
    if (this.userPreference) {
      return '用户设置：减少动画';
    }
    return '正常动画';
  }

  /**
   * 创建设置 UI
   */
  createSettingsUI(container) {
    const settingsDiv = document.createElement('div');
    settingsDiv.className = 'a11y-setting';
    settingsDiv.innerHTML = `
      <div role="group" aria-labelledby="animation-setting-label">
        <span id="animation-setting-label" class="setting-label">动画设置</span>
        <div class="setting-options">
          <button 
            class="setting-btn ${!this.shouldReduceMotion() ? 'active' : ''}"
            data-value="normal"
            aria-pressed="${!this.shouldReduceMotion()}"
          >
            正常动画
          </button>
          <button 
            class="setting-btn ${this.shouldReduceMotion() ? 'active' : ''}"
            data-value="reduced"
            aria-pressed="${this.shouldReduceMotion()}"
          >
            减少动画
          </button>
        </div>
        <div class="setting-note" aria-live="polite">
          ${this.getStatusDescription()}
        </div>
      </div>
    `;

    // 绑定事件
    settingsDiv.querySelectorAll('.setting-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const value = btn.dataset.value;
        if (value === 'reduced') {
          this.enableReducedMotion();
        } else {
          this.disableReducedMotion();
        }
        
        // 更新按钮状态
        settingsDiv.querySelectorAll('.setting-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        
        // 更新状态描述
        settingsDiv.querySelector('.setting-note').textContent = this.getStatusDescription();
      });
    });

    container.appendChild(settingsDiv);
    return settingsDiv;
  }
}

// 导出单例
export const animationSettings = new AnimationSettings();