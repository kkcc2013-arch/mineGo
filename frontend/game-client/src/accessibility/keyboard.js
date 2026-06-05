/**
 * Keyboard Navigator - 全局键盘导航系统
 * 支持Tab导航、快捷键、焦点陷阱等功能
 */

export class KeyboardNavigator {
  constructor() {
    this.focusedElement = null;
    this.focusableElements = [];
    this.handlers = {};
    this.announcer = null;
    this.init();
  }

  init() {
    document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.registerDefaultHandlers();
    console.log('[A11y] Keyboard navigator initialized');
  }

  /**
   * 注册默认快捷键处理器
   */
  registerDefaultHandlers() {
    // 游戏操作快捷键
    this.registerHandler('c', () => this.openCatchScreen());
    this.registerHandler('m', () => this.openMapScreen());
    this.registerHandler('p', () => this.openProfileScreen());
    this.registerHandler('g', () => this.openGymList());
    this.registerHandler('s', () => this.openSettings());
    this.registerHandler('h', () => this.openHelp());
    
    // 地图操作快捷键
    this.registerHandler('+', () => this.zoomInMap());
    this.registerHandler('=', () => this.zoomInMap());
    this.registerHandler('-', () => this.zoomOutMap());
    this.registerHandler('r', () => this.resetMapView());
    
    // Escape - 关闭弹窗
    this.registerHandler('Escape', () => this.closeModal());
    
    console.log('[A11y] Default shortcuts registered: C/M/P/G/S/H/+/=/-/R/Escape');
  }

  /**
   * 注册快捷键处理器
   */
  registerHandler(key, handler) {
    this.handlers[key.toLowerCase()] = handler;
  }

  /**
   * 处理键盘事件
   */
  handleKeyDown(e) {
    // 跳过输入框
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      return;
    }

    const key = this.normalizeKey(e);
    const handler = this.handlers[key];

    if (handler) {
      e.preventDefault();
      handler();
      this.announceAction(key);
    }
  }

  /**
   * 标准化按键名称
   */
  normalizeKey(e) {
    let key = e.key.toLowerCase();
    if (e.shiftKey && key !== 'shift') key = `shift+${key}`;
    if (e.ctrlKey && key !== 'control') key = `ctrl+${key}`;
    return key;
  }

  /**
   * 设置焦点到元素
   */
  setFocus(element) {
    if (element && element.focus) {
      element.focus();
      this.focusedElement = element;
      const label = element.getAttribute('aria-label') || 
                    element.textContent?.trim() || 
                    element.id;
      this.announce(`已聚焦: ${label}`);
    }
  }

  /**
   * 更新可聚焦元素列表
   */
  updateFocusableElements(container = document.body) {
    this.focusableElements = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    console.log(`[A11y] Found ${this.focusableElements.length} focusable elements`);
  }

  /**
   * 焦点陷阱（用于模态框）
   */
  trapFocus(container) {
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    // 设置初始焦点到第一个元素
    first.focus();

    container.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      
      // Escape 关闭模态框
      if (e.key === 'Escape') {
        this.closeModal();
      }
    });

    console.log('[A11y] Focus trap activated on modal');
  }

  /**
   * 解除焦点陷阱
   */
  releaseFocus(previousElement) {
    if (previousElement && previousElement.focus) {
      previousElement.focus();
    }
    console.log('[A11y] Focus trap released');
  }

  /**
   * 屏幕导航操作
   */
  openCatchScreen() {
    const catchBtn = document.querySelector('[aria-label="捕捉精灵"]');
    if (catchBtn) {
      catchBtn.click();
    } else {
      this.showScreen('catch');
    }
  }

  openMapScreen() {
    this.showScreen('map');
  }

  openProfileScreen() {
    this.showScreen('profile');
  }

  openGymList() {
    // 触发道馆列表显示
    const gymBtn = document.querySelector('[aria-label="附近道馆"]');
    if (gymBtn) gymBtn.click();
  }

  openSettings() {
    // 显示设置面板
    const settingsPanel = document.getElementById('settings-panel');
    if (settingsPanel) {
      settingsPanel.style.display = 'block';
      this.trapFocus(settingsPanel);
    }
  }

  openHelp() {
    // 显示帮助面板
    const helpPanel = document.getElementById('help-panel');
    if (helpPanel) {
      helpPanel.style.display = 'block';
      this.trapFocus(helpPanel);
    }
  }

  zoomInMap() {
    if (window.gameMap) {
      window.gameMap.zoomIn();
      this.announce('地图放大');
    }
  }

  zoomOutMap() {
    if (window.gameMap) {
      window.gameMap.zoomOut();
      this.announce('地图缩小');
    }
  }

  resetMapView() {
    if (window.gameMap) {
      window.gameMap.resetView();
      this.announce('地图视图已重置');
    }
  }

  closeModal() {
    const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (modal) {
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
      this.releaseFocus(this.previousFocus);
      this.announce('弹窗已关闭');
    }
  }

  showScreen(screenId) {
    const screen = document.getElementById(screenId);
    if (screen) {
      // 隐藏所有屏幕
      document.querySelectorAll('.screen').forEach(s => {
        s.classList.remove('active');
        s.setAttribute('aria-hidden', 'true');
      });
      
      // 显示目标屏幕
      screen.classList.add('active');
      screen.setAttribute('aria-hidden', 'false');
      
      // 更新焦点元素
      this.updateFocusableElements(screen);
      if (this.focusableElements.length > 0) {
        this.setFocus(this.focusableElements[0]);
      }
      
      this.announce(`已切换到 ${screen.getAttribute('aria-label') || screenId} 屏幕`);
    }
  }

  /**
   * 设置 announcer
   */
  setAnnouncer(announcer) {
    this.announcer = announcer;
  }

  /**
   * 通知屏幕阅读器
   */
  announce(message) {
    if (this.announcer) {
      this.announcer.announce(message);
    }
  }

  /**
   * 通知执行的动作
   */
  announceAction(key) {
    const actionMap = {
      'c': '打开捕捉界面',
      'm': '打开地图',
      'p': '打开背包',
      'g': '打开道馆列表',
      's': '打开设置',
      'h': '打开帮助',
      '+': '放大地图',
      '=': '放大地图',
      '-': '缩小地图',
      'r': '重置地图视图',
      'escape': '关闭弹窗'
    };
    
    const action = actionMap[key];
    if (action) {
      this.announce(action);
    }
  }
}

// 导出单例
export const keyboardNavigator = new KeyboardNavigator();