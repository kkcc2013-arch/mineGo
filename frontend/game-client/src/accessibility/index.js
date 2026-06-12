/**
 * Accessibility Module - 无障碍访问支持
 * 导出所有无障碍相关模块
 */

export { KeyboardNavigator, keyboardNavigator } from './keyboard.js';
export { A11yAnnouncer, a11yAnnouncer } from './announcer.js';
export { AnimationSettings, animationSettings } from './animation.js';
export { FontSizeManager, fontSizeManager } from './fontSize.js';
export { ColorBlindFriendly } from './colorBlind.js';
export { HighContrastMode, highContrastMode } from './HighContrastMode.js';

/**
 * 初始化所有无障碍模块
 */
export function initAccessibility() {
  console.log('[A11y] Initializing accessibility modules...');
  
  // 连接 announcer 到 keyboard navigator
  keyboardNavigator.setAnnouncer(a11yAnnouncer);
  
  // 在 DOMContentLoaded 后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setupAccessibility();
    });
  } else {
    setupAccessibility();
  }
}

/**
 * 设置无障碍功能
 */
function setupAccessibility() {
  console.log('[A11y] Setting up accessibility features...');
  
  // 添加跳过链接
  addSkipLink();
  
  // 更新可聚焦元素
  keyboardNavigator.updateFocusableElements();
  
  // 设置初始 ARIA 状态
  setupARIAStates();
  
  // 监听焦点变化
  monitorFocusChanges();
  
  console.log('[A11y] Accessibility setup complete');
}

/**
 * 添加跳过导航链接
 */
function addSkipLink() {
  const skipLink = document.createElement('a');
  skipLink.href = '#main-content';
  skipLink.className = 'skip-link';
  skipLink.textContent = '跳到主要内容';
  skipLink.setAttribute('aria-label', '跳到主要内容');
  document.body.insertBefore(skipLink, document.body.firstChild);
  console.log('[A11y] Skip link added');
}

/**
 * 设置初始 ARIA 状态
 */
function setupARIAStates() {
  // 设置屏幕可见性
  document.querySelectorAll('.screen').forEach(screen => {
    const isActive = screen.classList.contains('active');
    screen.setAttribute('aria-hidden', !isActive);
    screen.setAttribute('role', 'region');
  });
  
  // 设置导航标签
  document.querySelectorAll('.nav-tab').forEach((tab, index) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', '0');
    tab.setAttribute('aria-selected', tab.classList.contains('on'));
  });
  
  console.log('[A11y] ARIA states initialized');
}

/**
 * 监听焦点变化
 */
function monitorFocusChanges() {
  document.addEventListener('focusin', (e) => {
    const target = e.target;
    if (target.classList.contains('nav-tab')) {
      // 更新导航焦点状态
      document.querySelectorAll('.nav-tab').forEach(t => {
        t.setAttribute('aria-selected', t === target);
      });
    }
  });
}

/**
 * 创建无障碍设置面板
 */
export function createAccessibilitySettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'accessibility-settings';
  panel.className = 'settings-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'a11y-settings-title');
  panel.style.display = 'none';
  
  panel.innerHTML = `
    <div class="settings-content">
      <h2 id="a11y-settings-title" class="settings-title">无障碍设置</h2>
      
      <div class="settings-group">
        <h3 class="settings-group-title">显示设置</h3>
        <div id="font-size-setting"></div>
        <div id="animation-setting"></div>
      </div>
      
      <div class="settings-group">
        <h3 class="settings-group-title">键盘快捷键</h3>
        <div class="shortcuts-help" role="list">
          <div role="listitem"><kbd>C</kbd> - 打开捕捉界面</div>
          <div role="listitem"><kbd>M</kbd> - 打开地图</div>
          <div role="listitem"><kbd>P</kbd> - 打开背包</div>
          <div role="listitem"><kbd>G</kbd> - 打开道馆列表</div>
          <div role="listitem"><kbd>S</kbd> - 打开设置</div>
          <div role="listitem"><kbd>H</kbd> - 打开帮助</div>
          <div role="listitem"><kbd>+/-</kbd> - 放大/缩小地图</div>
          <div role="listitem"><kbd>R</kbd> - 重置地图视图</div>
          <div role="listitem"><kbd>Esc</kbd> - 关闭弹窗</div>
        </div>
      </div>
      
      <div class="settings-actions">
        <button class="btn-close" aria-label="关闭设置">关闭</button>
      </div>
    </div>
  `;
  
  // 添加字体大小设置 UI
  const fontSizeContainer = panel.querySelector('#font-size-setting');
  fontSizeManager.createSettingsUI(fontSizeContainer);
  
  // 添加动画设置 UI
  const animationContainer = panel.querySelector('#animation-setting');
  animationSettings.createSettingsUI(animationContainer);
  
  // 关闭按钮事件
  const closeBtn = panel.querySelector('.btn-close');
  closeBtn.addEventListener('click', () => {
    panel.style.display = 'none';
    keyboardNavigator.releaseFocus(panel.previousFocus);
  });
  
  document.body.appendChild(panel);
  return panel;
}

/**
 * 打开无障碍设置面板
 */
export function openAccessibilitySettings() {
  let panel = document.getElementById('accessibility-settings');
  if (!panel) {
    panel = createAccessibilitySettingsPanel();
  }
  
  panel.previousFocus = document.activeElement;
  panel.style.display = 'block';
  panel.removeAttribute('aria-hidden');
  keyboardNavigator.trapFocus(panel);
  a11yAnnouncer.announce('无障碍设置面板已打开');
}

// 自动初始化
initAccessibility();