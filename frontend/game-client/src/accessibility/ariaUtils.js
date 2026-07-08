/**
 * ARIA Utilities - ARIA 无障碍工具库
 * REQ-00503: 游戏客户端屏幕阅读器与 ARIA 无障碍支持
 * 
 * 提供 ARIA 角色管理、状态更新、语义化辅助等功能
 */

/**
 * ARIA 角色常量（按 WCAG 2.1 规范）
 */
export const ARIARoles = {
  // 文档结构角色
  APPLICATION: 'application',
  ARTICLE: 'article',
  REGION: 'region',
  NAVIGATION: 'navigation',
  MAIN: 'main',
  ASIDE: 'aside',
  SECTION: 'section',
  
  // 交互角色
  BUTTON: 'button',
  LINK: 'link',
  CHECKBOX: 'checkbox',
  RADIO: 'radio',
  SLIDER: 'slider',
  SPINBUTTON: 'spinbutton',
  TEXTBOX: 'textbox',
  MENU: 'menu',
  MENUITEM: 'menuitem',
  MENUITEMCHECKBOX: 'menuitemcheckbox',
  MENUITEMRADIO: 'menuitemradio',
  
  // 列表角色
  LIST: 'list',
  LISTITEM: 'listitem',
  
  // 状态角色
  STATUS: 'status',
  ALERT: 'alert',
  LOG: 'log',
  PROGRESSBAR: 'progressbar',
  METER: 'meter',
  TIMER: 'timer',
  
  // 对话框
  DIALOG: 'dialog',
  ALERTDIALOG: 'alertdialog',
  TOOLTIP: 'tooltip',
  
  // 图形角色
  IMG: 'img',
  FIGURE: 'figure',
  GRAPHIC: 'graphic',
  
  // 其他
  TAB: 'tab',
  TABLIST: 'tablist',
  TABPANEL: 'tabpanel',
  TREE: 'tree',
  TREEITEM: 'treeitem',
  GRID: 'grid',
  GRIDCELL: 'gridcell',
  ROW: 'row',
  TABLE: 'table',
  CELL: 'cell'
};

/**
 * ARIA 状态属性常量
 */
export const ARIAAttributes = {
  // 状态
  EXPANDED: 'aria-expanded',
  SELECTED: 'aria-selected',
  CHECKED: 'aria-checked',
  PRESSED: 'aria-pressed',
  DISABLED: 'aria-disabled',
  READONLY: 'aria-readonly',
  REQUIRED: 'aria-required',
  INVALID: 'aria-invalid',
  BUSY: 'aria-busy',
  
  // 值
  VALUENOW: 'aria-valuenow',
  VALUETEXT: 'aria-valuetext',
  VALUEMIN: 'aria-valuemin',
  VALUEMAX: 'aria-valuemax',
  
  // 关系
  LABEL: 'aria-label',
  LABELLEDBY: 'aria-labelledby',
  DESCRIBEDBY: 'aria-describedby',
  CONTROLS: 'aria-controls',
  OWNS: 'aria-owns',
  HASPOPUP: 'aria-haspopup',
  
  // 实时区域
  LIVE: 'aria-live',
  ATOMIC: 'aria-atomic',
  RELEVANT: 'aria-relevant',
  
  // 其他
  HIDDEN: 'aria-hidden',
  CURRENT: 'aria-current',
  ORIENTATION: 'aria-orientation',
  MULTISELECTABLE: 'aria-multiselectable',
  AUTOCOMPLETE: 'aria-autocomplete'
};

/**
 * ARIA 工具类
 */
export class ARIAUtils {
  /**
   * 设置元素的 ARIA 角色
   */
  static setRole(element, role) {
    if (!element || !role) return;
    element.setAttribute('role', role);
  }

  /**
   * 设置 ARIA 属性
   */
  static setAttribute(element, attribute, value) {
    if (!element || !attribute) return;
    
    // 布尔值处理
    if (typeof value === 'boolean') {
      element.setAttribute(attribute, value.toString());
    } else if (value !== null && value !== undefined) {
      element.setAttribute(attribute, value.toString());
    } else {
      element.removeAttribute(attribute);
    }
  }

  /**
   * 获取 ARIA 属性值
   */
  static getAttribute(element, attribute) {
    if (!element || !attribute) return null;
    const value = element.getAttribute(attribute);
    
    // 布尔值转换
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value === '' || value === null) return null;
    
    // 数字转换
    const num = Number(value);
    if (!isNaN(num)) return num;
    
    return value;
  }

  /**
   * 设置元素标签（支持多语言）
   */
  static setLabel(element, label) {
    this.setAttribute(element, ARIAAttributes.LABEL, label);
  }

  /**
   * 设置可见状态（aria-hidden）
   */
  static setHidden(element, hidden) {
    this.setAttribute(element, ARIAAttributes.HIDDEN, hidden);
    
    // 同时设置 tabindex，防止隐藏元素获得焦点
    if (hidden) {
      element.setAttribute('tabindex', '-1');
    } else {
      const originalTabindex = element.dataset.originalTabindex;
      if (originalTabindex !== undefined) {
        element.setAttribute('tabindex', originalTabindex);
        delete element.dataset.originalTabindex;
      } else {
        element.removeAttribute('tabindex');
      }
    }
  }

  /**
   * 设置扩展状态（用于展开/折叠）
   */
  static setExpanded(element, expanded) {
    this.setAttribute(element, ARIAAttributes.EXPANDED, expanded);
  }

  /**
   * 设置选中状态（用于单选/多选）
   */
  static setSelected(element, selected) {
    this.setAttribute(element, ARIAAttributes.SELECTED, selected);
  }

  /**
   * 设置勾选状态（用于复选框）
   */
  static setChecked(element, checked) {
    // 支持 'mixed' 状态（部分选中）
    if (checked === 'mixed') {
      this.setAttribute(element, ARIAAttributes.CHECKED, 'mixed');
    } else {
      this.setAttribute(element, ARIAAttributes.CHECKED, Boolean(checked));
    }
  }

  /**
   * 设置禁用状态
   */
  static setDisabled(element, disabled) {
    this.setAttribute(element, ARIAAttributes.DISABLED, disabled);
    if (disabled) {
      element.setAttribute('disabled', 'disabled');
      element.setAttribute('tabindex', '-1');
    } else {
      element.removeAttribute('disabled');
      element.removeAttribute('tabindex');
    }
  }

  /**
   * 设置进度值（用于进度条、血条等）
   */
  static setValue(element, value, min = 0, max = 100, text = null) {
    this.setAttribute(element, ARIAAttributes.VALUENOW, value);
    this.setAttribute(element, ARIAAttributes.VALUEMIN, min);
    this.setAttribute(element, ARIAAttributes.VALUEMAX, max);
    
    if (text !== null) {
      this.setAttribute(element, ARIAAttributes.VALUETEXT, text);
    } else {
      // 默认文本：百分比
      const percentage = Math.round((value - min) / (max - min) * 100);
      this.setAttribute(element, ARIAAttributes.VALUETEXT, `${percentage}%`);
    }
  }

  /**
   * 设置关联元素（aria-controls、aria-labelledby 等）
   */
  static setRelation(element, attribute, targetId) {
    if (!element || !attribute || !targetId) return;
    
    if (Array.isArray(targetId)) {
      element.setAttribute(attribute, targetId.join(' '));
    } else {
      element.setAttribute(attribute, targetId);
    }
  }

  /**
   * 创建实时区域
   */
  static createLiveRegion(id, priority = 'polite') {
    const region = document.createElement('div');
    region.id = id;
    region.setAttribute('role', priority === 'assertive' ? 'alert' : 'status');
    region.setAttribute('aria-live', priority);
    region.setAttribute('aria-atomic', 'true');
    region.className = 'sr-only'; // 视觉隐藏，屏幕阅读器可访问
    document.body.appendChild(region);
    return region;
  }

  /**
   * 更新实时区域内容
   */
  static updateLiveRegion(element, message) {
    if (!element) return;
    
    // 清空后重新设置，确保屏幕阅读器捕获变化
    element.textContent = '';
    setTimeout(() => {
      element.textContent = message;
    }, 100);
  }

  /**
   * 创建语义化按钮（替代 div 点击）
   */
  static createButton(text, onClick, options = {}) {
    const button = document.createElement('button');
    button.textContent = text;
    button.setAttribute('type', 'button');
    
    if (options.ariaLabel) {
      this.setLabel(button, options.ariaLabel);
    }
    
    if (options.disabled) {
      this.setDisabled(button, true);
    }
    
    if (options.class) {
      button.className = options.class;
    }
    
    if (onClick) {
      button.addEventListener('click', onClick);
    }
    
    return button;
  }

  /**
   * 创建列表项
   */
  static createListItem(content, index, total, options = {}) {
    const item = document.createElement('article');
    this.setRole(item, ARIARoles.LISTITEM);
    item.setAttribute('aria-posinset', index.toString());
    item.setAttribute('aria-setsize', total.toString());
    
    if (content instanceof HTMLElement) {
      item.appendChild(content);
    } else {
      item.textContent = content;
    }
    
    if (options.class) {
      item.className = options.class;
    }
    
    return item;
  }

  /**
   * 创建进度条/血条
   */
  static createMeter(label, value, min, max, options = {}) {
    const container = document.createElement('div');
    this.setRole(container, ARIARoles.METER);
    this.setLabel(container, label);
    this.setValue(container, value, min, max);
    
    if (options.class) {
      container.className = options.class;
    }
    
    // 可视化进度条
    const bar = document.createElement('div');
    bar.className = 'meter-fill';
    bar.style.width = `${(value - min) / (max - min) * 100}%`;
    container.appendChild(bar);
    
    return container;
  }

  /**
   * 检查元素是否可聚焦
   */
  static isFocusable(element) {
    if (!element) return false;
    
    // 检查是否被隐藏
    if (this.getAttribute(element, ARIAAttributes.HIDDEN)) return false;
    if (element.hidden) return false;
    if (element.getAttribute('tabindex') === '-1') return false;
    
    // 检查是否是原生可聚焦元素
    const focusableTags = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'];
    if (focusableTags.includes(element.tagName)) {
      return !element.disabled;
    }
    
    // 检查是否设置了 tabindex
    return element.hasAttribute('tabindex');
  }

  /**
   * 获取所有可聚焦的子元素
   */
  static getFocusableChildren(container) {
    const selector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
      '[role="button"]:not([aria-disabled="true"])',
      '[role="link"]:not([aria-disabled="true"])',
      '[role="menuitem"]:not([aria-disabled="true"])'
    ].join(', ');
    
    return Array.from(container.querySelectorAll(selector))
      .filter(el => this.isFocusable(el));
  }

  /**
   * 为 div 添加按钮语义（快速改造）
   */
  static upgradeToButton(element) {
    if (!element) return;
    
    this.setRole(element, ARIARoles.BUTTON);
    element.setAttribute('tabindex', '0');
    
    // 添加键盘交互
    element.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        element.click();
      }
    });
  }

  /**
   * 为 div 添加链接语义
   */
  static upgradeToLink(element, href) {
    if (!element) return;
    
    this.setRole(element, ARIARoles.LINK);
    element.setAttribute('tabindex', '0');
    
    // 点击和回车导航
    element.addEventListener('click', () => {
      if (href) window.location.href = href;
    });
    
    element.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (href) window.location.href = href;
      }
    });
  }
}

/**
 * 屏幕阅读器样式（CSS 类名）
 */
export const ScreenReaderStyles = `
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  }
  
  .sr-only-focusable:focus,
  .sr-only-focusable:active {
    position: static;
    width: auto;
    height: auto;
    overflow: visible;
    clip: auto;
    white-space: normal;
  }
`;

// 自动注入样式
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = ScreenReaderStyles;
  document.head.appendChild(style);
}

export default ARIAUtils;