/**
 * Font Size Manager - 字体大小调整系统
 * 支持4档字体大小调整
 */

export class FontSizeManager {
  constructor() {
    this.sizes = ['small', 'medium', 'large', 'x-large'];
    this.sizeValues = {
      'small': '14px',
      'medium': '16px',
      'large': '18px',
      'x-large': '20px'
    };
    this.sizeLabels = {
      'small': '小',
      'medium': '中',
      'large': '大',
      'x-large': '特大'
    };
    this.currentSize = localStorage.getItem('font-size') || 'medium';
    this.init();
  }

  init() {
    this.apply();
    console.log('[A11y] Font size manager initialized, current size:', this.currentSize);
  }

  /**
   * 设置字体大小
   */
  setSize(size) {
    if (this.sizes.includes(size)) {
      this.currentSize = size;
      localStorage.setItem('font-size', size);
      this.apply();
      console.log('[A11y] Font size set to:', size);
    }
  }

  /**
   * 应用字体大小到 DOM
   */
  apply() {
    const root = document.documentElement;
    root.style.fontSize = this.sizeValues[this.currentSize];
    
    // 更新 CSS 类
    root.classList.remove('font-small', 'font-medium', 'font-large', 'font-x-large');
    root.classList.add(`font-${this.currentSize}`);
  }

  /**
   * 增大字体
   */
  increase() {
    const index = this.sizes.indexOf(this.currentSize);
    if (index < this.sizes.length - 1) {
      this.setSize(this.sizes[index + 1]);
      return true;
    }
    return false;
  }

  /**
   * 减小字体
   */
  decrease() {
    const index = this.sizes.indexOf(this.currentSize);
    if (index > 0) {
      this.setSize(this.sizes[index - 1]);
      return true;
    }
    return false;
  }

  /**
   * 获取当前大小索引
   */
  getCurrentIndex() {
    return this.sizes.indexOf(this.currentSize);
  }

  /**
   * 创建设置 UI
   */
  createSettingsUI(container) {
    const settingsDiv = document.createElement('div');
    settingsDiv.className = 'a11y-setting';
    settingsDiv.innerHTML = `
      <div role="group" aria-labelledby="font-size-label">
        <span id="font-size-label" class="setting-label">字体大小</span>
        <div class="setting-slider" role="slider" 
             aria-valuemin="0" 
             aria-valuemax="${this.sizes.length - 1}"
             aria-valuenow="${this.getCurrentIndex()}"
             aria-valuetext="${this.sizeLabels[this.currentSize]}"
             tabindex="0">
          <div class="slider-track">
            ${this.sizes.map((size, i) => `
              <button 
                class="slider-step ${size === this.currentSize ? 'active' : ''}"
                data-size="${size}"
                aria-label="${this.sizeLabels[size]}"
                aria-pressed="${size === this.currentSize}"
              >
                ${this.sizeLabels[size]}
              </button>
            `).join('')}
          </div>
        </div>
        <div class="setting-value" aria-live="polite">
          当前：${this.sizeLabels[this.currentSize]}
        </div>
      </div>
    `;

    // 绑定事件
    settingsDiv.querySelectorAll('.slider-step').forEach(btn => {
      btn.addEventListener('click', () => {
        const size = btn.dataset.size;
        this.setSize(size);
        
        // 更新按钮状态
        settingsDiv.querySelectorAll('.slider-step').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        
        // 更新滑块值
        const slider = settingsDiv.querySelector('.setting-slider');
        slider.setAttribute('aria-valuenow', this.getCurrentIndex());
        slider.setAttribute('aria-valuetext', this.sizeLabels[this.currentSize]);
        
        // 更新状态描述
        settingsDiv.querySelector('.setting-value').textContent = `当前：${this.sizeLabels[this.currentSize]}`;
      });
    });

    // 键盘导航
    const slider = settingsDiv.querySelector('.setting-slider');
    slider.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (this.increase()) {
          const nextBtn = settingsDiv.querySelector(`[data-size="${this.currentSize}"]`);
          nextBtn.click();
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (this.decrease()) {
          const prevBtn = settingsDiv.querySelector(`[data-size="${this.currentSize}"]`);
          prevBtn.click();
        }
      }
    });

    container.appendChild(settingsDiv);
    return settingsDiv;
  }
}

// 导出单例
export const fontSizeManager = new FontSizeManager();