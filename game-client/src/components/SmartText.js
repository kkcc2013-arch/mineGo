/**
 * SmartText - 前端智能文本截断组件
 * 
 * 提供响应式文本截断，自动适配可用空间
 * 
 * @module game-client/src/components/SmartText
 */

class SmartText {
  /**
   * 创建 SmartText 实例
   * @param {HTMLElement} element - 目标 DOM 元素
   * @param {Object} options - 配置选项
   */
  constructor(element, options = {}) {
    this.element = element;
    this.maxLines = options.maxLines || 2;
    this.maxLength = options.maxLength || null;
    this.locale = options.locale || navigator.language || 'en';
    this.ellipsis = options.ellipsis || '...';
    this.showTooltip = options.showTooltip !== false;
    this.onClickExpand = options.onClickExpand || false;
    this.truncator = options.truncator || null; // 可传入服务端截断器
    
    this.originalText = '';
    this.isTruncated = false;
    this.resizeObserver = null;
    
    this.init();
  }

  /**
   * 初始化组件
   */
  init() {
    if (this.element._smartText) {
      console.warn('SmartText already initialized on this element');
      return;
    }
    this.element._smartText = this;
    
    // 监听窗口大小变化
    this.setupResizeObserver();
    
    // 初始化渲染
    const text = this.element.textContent || this.element.dataset.text || '';
    if (text) {
      this.render(text);
    }
  }

  /**
   * 设置 ResizeObserver 监听容器大小变化
   */
  setupResizeObserver() {
    if (typeof ResizeObserver === 'undefined') return;
    
    this.resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        if (this.originalText && this.autoTruncate) {
          this.render(this.originalText, true);
        }
      }
    });
    
    this.resizeObserver.observe(this.element);
  }

  /**
   * 计算可用字符数
   * @returns {number} 可用字符数
   */
  calculateAvailableChars() {
    const availableWidth = this.element.clientWidth;
    if (availableWidth === 0) return this.maxLength || 50;
    
    const computedStyle = getComputedStyle(this.element);
    const fontSize = parseFloat(computedStyle.fontSize);
    const letterSpacing = parseFloat(computedStyle.letterSpacing) || 0;
    
    // 考虑字体宽度的修正系数（中文字符更宽）
    const isCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(this.locale);
    const charWidthRatio = isCJK ? 1.0 : 0.6;
    
    // 计算每行字符数
    const charWidth = fontSize * charWidthRatio + letterSpacing;
    const charsPerLine = Math.floor(availableWidth / charWidth);
    
    // 总字符数 = 每行字符数 × 行数
    const totalChars = charsPerLine * this.maxLines;
    
    return Math.max(totalChars, 10); // 至少保留 10 个字符
  }

  /**
   * 渲染文本（自动截断）
   * @param {string} text - 原始文本
   * @param {boolean} isResize - 是否是 resize 触发
   */
  render(text, isResize = false) {
    this.originalText = text;
    this.autoTruncate = true;
    
    // 计算可用空间
    const maxLength = this.maxLength || this.calculateAvailableChars();
    
    // 执行截断
    const result = this.truncateText(text, maxLength);
    
    // 更新 DOM
    this.element.textContent = result.truncated;
    this.isTruncated = result.wasTruncated;
    
    // 如果截断了，添加交互
    if (result.wasTruncated) {
      this.element.classList.add('truncated');
      if (this.showTooltip) {
        this.addTooltip(text);
      }
      if (this.onClickExpand) {
        this.addExpandHandler(text);
      }
    } else {
      this.element.classList.remove('truncated');
      this.element.removeAttribute('title');
    }
    
    // 派发自定义事件
    this.element.dispatchEvent(new CustomEvent('smarttext:rendered', {
      detail: { original: text, truncated: result.truncated, wasTruncated: result.wasTruncated }
    }));
  }

  /**
   * 截断文本（前端简化版）
   * @param {string} text - 原始文本
   * @param {number} maxLength - 最大长度
   * @returns {Object} 截断结果
   */
  truncateText(text, maxLength) {
    if (!text || text.length <= maxLength) {
      return { truncated: text, wasTruncated: false };
    }
    
    // 提取并保护占位符
    const placeholders = [];
    const placeholderRegex = /\{[^}]+\}/g;
    let protectedText = text.replace(placeholderRegex, (match) => {
      const index = placeholders.length;
      placeholders.push(match);
      return `__PH_${index}__`;
    });
    
    // 执行截断
    const actualMaxLength = maxLength - this.ellipsis.length;
    let truncated = protectedText.substring(0, actualMaxLength);
    
    // 语言特定的截断策略（前端简化版）
    truncated = this.applyLanguageStrategy(truncated, actualMaxLength);
    
    // 恢复占位符
    placeholders.forEach((placeholder, index) => {
      const marker = `__PH_${index}__`;
      if (truncated.includes(marker)) {
        truncated = truncated.replace(marker, placeholder);
      }
    });
    
    return {
      truncated: truncated.trim() + this.ellipsis,
      wasTruncated: true
    };
  }

  /**
   * 应用语言特定的截断策略（前端简化版）
   * @param {string} text - 文本
   * @param {number} maxLength - 最大长度
   * @returns {string} 处理后的文本
   */
  applyLanguageStrategy(text, maxLength) {
    // 中文：在标点后截断
    if (/[\u4e00-\u9fff]/.test(text)) {
      const punctuation = ['。', '，', '！', '？', '、', '；', '：'];
      const threshold = Math.floor(maxLength * 0.7);
      for (let i = maxLength - 1; i >= threshold; i--) {
        if (punctuation.includes(text[i])) {
          return text.substring(0, i + 1);
        }
      }
    }
    
    // 英语等：在空格处截断
    if (/[a-zA-Z]/.test(text)) {
      const threshold = Math.floor(maxLength * 0.7);
      for (let i = maxLength - 1; i >= threshold; i--) {
        if (text[i] === ' ') {
          return text.substring(0, i);
        }
      }
    }
    
    return text;
  }

  /**
   * 添加 Tooltip 显示完整文本
   * @param {string} fullText - 完整文本
   */
  addTooltip(fullText) {
    this.element.title = fullText;
    this.element.setAttribute('aria-label', fullText);
  }

  /**
   * 添加点击展开处理
   * @param {string} fullText - 完整文本
   */
  addExpandHandler(fullText) {
    this.element.style.cursor = 'pointer';
    this.element.setAttribute('role', 'button');
    this.element.setAttribute('aria-expanded', 'false');
    
    this.element.addEventListener('click', (e) => {
      this.toggleExpand(fullText, e);
    });
    
    // 键盘支持
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.toggleExpand(fullText, e);
      }
    });
  }

  /**
   * 切换展开/收起
   * @param {string} fullText - 完整文本
   * @param {Event} event - 事件对象
   */
  toggleExpand(fullText, event) {
    if (this.isTruncated) {
      this.element.textContent = fullText;
      this.element.classList.remove('truncated');
      this.element.classList.add('expanded');
      this.element.setAttribute('aria-expanded', 'true');
      this.isTruncated = false;
      
      // 派发展开事件
      this.element.dispatchEvent(new CustomEvent('smarttext:expanded', {
        detail: { text: fullText }
      }));
    } else {
      this.render(fullText);
      this.element.classList.add('truncated');
      this.element.classList.remove('expanded');
      this.element.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * 更新配置
   * @param {Object} options - 新配置
   */
  updateOptions(options) {
    Object.assign(this, options);
    if (this.originalText) {
      this.render(this.originalText, true);
    }
  }

  /**
   * 销毁组件
   */
  destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.element._smartText = null;
    this.element.classList.remove('truncated', 'expanded');
    this.element.removeAttribute('title');
    this.element.removeAttribute('aria-expanded');
    this.element.removeAttribute('role');
  }

  /**
   * 静态方法：初始化所有 .smart-text 元素
   * @param {Object} options - 配置选项
   * @returns {Array<SmartText>} 创建的实例数组
   */
  static initAll(options = {}) {
    const elements = document.querySelectorAll('.smart-text');
    const instances = [];
    
    elements.forEach(el => {
      instances.push(new SmartText(el, options));
    });
    
    return instances;
  }
}

// 自动初始化（如果 DOMContentLoaded 已触发）
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      SmartText.initAll();
    });
  } else {
    // DOM 已加载，延迟初始化
    setTimeout(() => SmartText.initAll(), 0);
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SmartText;
}

// 挂载到全局（用于非模块化环境）
if (typeof window !== 'undefined') {
  window.SmartText = SmartText;
}