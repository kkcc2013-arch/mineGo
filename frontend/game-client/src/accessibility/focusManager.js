/**
 * Focus Manager - 焦点管理器
 * REQ-00503: 游戏客户端屏幕阅读器与 ARIA 无障碍支持
 * 
 * 提供焦点历史管理、焦点陷阱、焦点恢复等功能
 */

import ARIAUtils, { ARIAAttributes } from './ariaUtils.js';

/**
 * 焦点管理器类
 */
export class FocusManager {
  constructor() {
    this.focusHistory = [];
    this.maxHistoryLength = 10;
    this.trapStack = [];
    this.currentTrap = null;
    
    this.init();
  }

  /**
   * 初始化焦点管理器
   */
  init() {
    // 监听焦点变化
    document.addEventListener('focusin', (e) => {
      this.onFocusChange(e.target);
    });
    
    // 监听 ESC 键退出焦点陷阱
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.currentTrap) {
        const trap = this.currentTrap;
        if (trap.onEscape) {
          trap.onEscape();
        }
      }
    });
    
    console.log('[FocusManager] Initialized');
  }

  /**
   * 焦点变化处理
   */
  onFocusChange(element) {
    // 只记录可聚焦元素
    if (!ARIAUtils.isFocusable(element)) return;
    
    // 添加到历史记录
    this.focusHistory.push({
      element,
      timestamp: Date.now()
    });
    
    // 限制历史长度
    if (this.focusHistory.length > this.maxHistoryLength) {
      this.focusHistory.shift();
    }
  }

  /**
   * 保存当前焦点（用于打开模态框前）
   */
  saveFocus() {
    const currentFocus = document.activeElement;
    if (currentFocus && currentFocus !== document.body) {
      const record = {
        element: currentFocus,
        timestamp: Date.now()
      };
      
      // 标记为保存焦点
      record.saved = true;
      this.focusHistory.push(record);
      
      console.log('[FocusManager] Saved focus:', currentFocus.tagName, currentFocus.id);
    }
    return currentFocus;
  }

  /**
   * 恢复最近保存的焦点（用于关闭模态框后）
   */
  restoreFocus() {
    // 查找最近的保存焦点
    for (let i = this.focusHistory.length - 1; i >= 0; i--) {
      const record = this.focusHistory[i];
      if (record.saved && this.isElementVisible(record.element)) {
        this.focusElement(record.element);
        console.log('[FocusManager] Restored focus:', record.element.tagName, record.element.id);
        return true;
      }
    }
    
    // 没有找到，聚焦到 body
    document.body.focus();
    return false;
  }

  /**
   * 检查元素是否仍然可见
   */
  isElementVisible(element) {
    if (!element || !element.parentNode) return false;
    if (element.hidden) return false;
    if (ARIAUtils.getAttribute(element, ARIAAttributes.HIDDEN)) return false;
    
    const style = window.getComputedStyle(element);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden') return false;
    
    return true;
  }

  /**
   * 聚焦元素（带安全检查）
   */
  focusElement(element, options = {}) {
    if (!element) return false;
    if (!this.isElementVisible(element)) {
      console.warn('[FocusManager] Element not visible:', element);
      return false;
    }
    
    // 确保可聚焦
    if (!element.hasAttribute('tabindex')) {
      element.setAttribute('tabindex', '-1');
    }
    
    element.focus(options);
    return true;
  }

  /**
   * 聚焦第一个子元素
   */
  focusFirstChild(container) {
    const focusableChildren = ARIAUtils.getFocusableChildren(container);
    if (focusableChildren.length > 0) {
      this.focusElement(focusableChildren[0]);
      return true;
    }
    return false;
  }

  /**
   * 聚焦最后一个子元素
   */
  focusLastChild(container) {
    const focusableChildren = ARIAUtils.getFocusableChildren(container);
    if (focusableChildren.length > 0) {
      this.focusElement(focusableChildren[focusableChildren.length - 1]);
      return true;
    }
    return false;
  }

  /**
   * 创建焦点陷阱（模态框、抽屉等）
   */
  trapFocus(container, options = {}) {
    const trap = {
      container,
      previousFocus: document.activeElement,
      onEscape: options.onEscape,
      autoFocus: options.autoFocus !== false,
      returnFocus: options.returnFocus !== false
    };
    
    // 设置 aria-hidden="true" 到背景元素
    this.hideBackground(container);
    
    // 自动聚焦容器或第一个可聚焦元素
    if (trap.autoFocus) {
      if (options.initialFocus) {
        this.focusElement(options.initialFocus);
      } else {
        this.focusFirstChild(container);
      }
    }
    
    // 添加键盘事件监听
    const handler = (e) => this.handleTrapKeyDown(e, trap);
    container.addEventListener('keydown', handler);
    trap.handler = handler;
    
    // 推入陷阱栈
    this.trapStack.push(trap);
    this.currentTrap = trap;
    
    console.log('[FocusManager] Trap activated');
    return trap;
  }

  /**
   * 处理焦点陷阱内的键盘导航
   */
  handleTrapKeyDown(e, trap) {
    if (e.key !== 'Tab') return;
    
    const focusableChildren = ARIAUtils.getFocusableChildren(trap.container);
    if (focusableChildren.length === 0) return;
    
    const firstElement = focusableChildren[0];
    const lastElement = focusableChildren[focusableChildren.length - 1];
    
    // Shift+Tab 在第一个元素上，跳到最后
    if (e.shiftKey && document.activeElement === firstElement) {
      e.preventDefault();
      this.focusElement(lastElement);
    }
    // Tab 在最后一个元素上，跳到第一个
    else if (!e.shiftKey && document.activeElement === lastElement) {
      e.preventDefault();
      this.focusElement(firstElement);
    }
  }

  /**
   * 释放焦点陷阱
   */
  releaseTrap() {
    if (this.trapStack.length === 0) return;
    
    const trap = this.trapStack.pop();
    if (trap === this.currentTrap) {
      this.currentTrap = this.trapStack[this.trapStack.length - 1] || null;
    }
    
    // 移除事件监听
    if (trap.handler) {
      trap.container.removeEventListener('keydown', trap.handler);
    }
    
    // 恢复背景 aria-hidden
    this.showBackground();
    
    // 恢复焦点
    if (trap.returnFocus && trap.previousFocus) {
      this.focusElement(trap.previousFocus);
    }
    
    console.log('[FocusManager] Trap released');
  }

  /**
   * 隐藏背景内容（aria-hidden）
   */
  hideBackground(except) {
    // 获取所有顶级元素
    const topLevelElements = Array.from(document.body.children)
      .filter(el => el !== except && !el.contains(except) && el.id !== 'a11y-live-region' && el.id !== 'a11y-alert-region');
    
    topLevelElements.forEach(el => {
      // 记录原始状态
      if (!el.dataset.originalAriaHidden) {
        el.dataset.originalAriaHidden = el.getAttribute('aria-hidden') || 'not-set';
      }
      el.setAttribute('aria-hidden', 'true');
    });
    
    this.hiddenElements = topLevelElements;
  }

  /**
   * 显示背景内容
   */
  showBackground() {
    if (!this.hiddenElements) return;
    
    this.hiddenElements.forEach(el => {
      const original = el.dataset.originalAriaHidden;
      if (original === 'not-set') {
        el.removeAttribute('aria-hidden');
      } else {
        el.setAttribute('aria-hidden', original);
      }
      delete el.dataset.originalAriaHidden;
    });
    
    this.hiddenElements = null;
  }

  /**
   * 聚焦到特定区域（导航快捷键）
   */
  focusRegion(regionId) {
    const region = document.querySelector(`[aria-label="${regionId}"], #${regionId}, [role="region"][aria-label*="${regionId}"]`);
    if (region) {
      this.focusFirstChild(region);
      return true;
    }
    return false;
  }

  /**
   * 获取焦点历史
   */
  getFocusHistory() {
    return this.focusHistory.map(record => ({
      tag: record.element.tagName,
      id: record.element.id,
      timestamp: record.timestamp,
      saved: record.saved
    }));
  }

  /**
   * 清空焦点历史
   */
  clearHistory() {
    this.focusHistory = [];
    console.log('[FocusManager] History cleared');
  }
}

// 导出单例
export const focusManager = new FocusManager();
export default focusManager;