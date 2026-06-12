/**
 * HighContrastMode - 高对比度模式支持系统
 * WCAG 2.1 AAA 合规，支持低视力用户和强光环境
 * 
 * @module accessibility/HighContrastMode
 * @version 1.0.0
 */

export class HighContrastMode {
  constructor() {
    this.enabled = false;
    this.systemPreference = false;
    this.userPreference = null; // null = 跟随系统
    this.modes = ['standard', 'high-contrast', 'black-white'];
    this.currentMode = 'standard';
    
    // 高对比度配色方案
    this.colorSchemes = {
      'high-contrast': {
        background: '#000000',
        foreground: '#FFFFFF',
        primary: '#FFFF00',      // 黄色按钮
        secondary: '#00FFFF',    // 青色次要按钮
        danger: '#FF0000',       // 红色警告
        success: '#00FF00',      // 绿色成功
        warning: '#FFA500',      // 橙色警告
        link: '#00FFFF',         // 青色链接
        border: '#FFFFFF',       // 白色边框
        focusRing: '#FFFF00'     // 黄色焦点环
      },
      'black-white': {
        background: '#000000',
        foreground: '#FFFFFF',
        primary: '#FFFFFF',
        secondary: '#FFFFFF',
        danger: '#FFFFFF',
        success: '#FFFFFF',
        warning: '#FFFFFF',
        link: '#FFFFFF',
        border: '#FFFFFF',
        focusRing: '#FFFFFF'
      }
    };
    
    // Prometheus 指标
    this.metrics = {
      enabled: false,
      modeChanges: 0,
      systemPreference: false
    };
  }
  
  /**
   * 初始化：检测系统偏好
   */
  init() {
    // 检测系统高对比度偏好
    const mediaQuery = window.matchMedia('(prefers-contrast: more)');
    this.systemPreference = mediaQuery.matches;
    
    // 从 localStorage 读取用户偏好
    const stored = localStorage.getItem('high-contrast-preference');
    this.userPreference = stored || null;
    
    // 监听系统偏好变化
    mediaQuery.addEventListener('change', (e) => {
      console.log('[HighContrast] System preference changed:', e.matches);
      this.systemPreference = e.matches;
      this.metrics.systemPreference = e.matches;
      this.applyMode();
    });
    
    // 应用模式
    this.applyMode();
    
    console.log('[HighContrast] Initialized', {
      systemPreference: this.systemPreference,
      userPreference: this.userPreference,
      currentMode: this.currentMode
    });
    
    return this;
  }
  
  /**
   * 应用模式
   */
  applyMode() {
    // 确定有效模式：用户偏好 > 系统偏好 > 标准
    let effectiveMode = 'standard';
    
    if (this.userPreference && this.userPreference !== 'auto') {
      effectiveMode = this.userPreference;
    } else if (this.systemPreference) {
      effectiveMode = 'high-contrast';
    }
    
    this.currentMode = effectiveMode;
    this.enabled = effectiveMode !== 'standard';
    this.metrics.enabled = this.enabled;
    
    const root = document.documentElement;
    
    // 移除所有高对比度类
    root.classList.remove('high-contrast', 'black-white');
    
    // 应用新模式
    if (this.enabled) {
      root.classList.add(effectiveMode);
      this.injectHighContrastStyles(effectiveMode);
    } else {
      // 移除注入的样式
      const style = document.getElementById('high-contrast-styles');
      if (style) style.remove();
    }
    
    // 触发事件
    window.dispatchEvent(new CustomEvent('high-contrast-change', {
      detail: { mode: effectiveMode, enabled: this.enabled }
    }));
    
    console.log('[HighContrast] Mode applied:', effectiveMode);
  }
  
  /**
   * 设置用户偏好
   * @param {string} mode - 'standard' | 'high-contrast' | 'black-white' | 'auto'
   */
  setPreference(mode) {
    if (!this.modes.includes(mode) && mode !== 'auto') {
      console.error('[HighContrast] Invalid mode:', mode);
      return;
    }
    
    this.userPreference = mode === 'auto' ? null : mode;
    
    // 持久化
    if (mode === 'auto') {
      localStorage.removeItem('high-contrast-preference');
    } else {
      localStorage.setItem('high-contrast-preference', mode);
    }
    
    // 更新指标
    this.metrics.modeChanges++;
    
    // 应用模式
    this.applyMode();
  }
  
  /**
   * 注入高对比度样式
   */
  injectHighContrastStyles(mode) {
    const colors = this.colorSchemes[mode];
    if (!colors) return;
    
    let style = document.getElementById('high-contrast-styles');
    if (!style) {
      style = document.createElement('style');
      style.id = 'high-contrast-styles';
      document.head.appendChild(style);
    }
    
    style.textContent = `
      :root {
        --hc-bg: ${colors.background};
        --hc-fg: ${colors.foreground};
        --hc-primary: ${colors.primary};
        --hc-secondary: ${colors.secondary};
        --hc-danger: ${colors.danger};
        --hc-success: ${colors.success};
        --hc-warning: ${colors.warning};
        --hc-link: ${colors.link};
        --hc-border: ${colors.border};
        --hc-focus: ${colors.focusRing};
      }
      
      /* 全局高对比度样式 */
      .${mode} {
        background-color: var(--hc-bg) !important;
        color: var(--hc-fg) !important;
      }
      
      .${mode} body {
        background-color: var(--hc-bg) !important;
        color: var(--hc-fg) !important;
      }
      
      /* 按钮样式 */
      .${mode} .btn,
      .${mode} button {
        background-color: var(--hc-primary) !important;
        color: var(--hc-bg) !important;
        border: 3px solid var(--hc-border) !important;
        font-weight: bold !important;
        padding: 8px 16px !important;
      }
      
      .${mode} .btn-primary,
      .${mode} button.primary {
        background-color: var(--hc-primary) !important;
      }
      
      .${mode} .btn-secondary,
      .${mode} button.secondary {
        background-color: var(--hc-secondary) !important;
      }
      
      .${mode} .btn-danger,
      .${mode} button.danger {
        background-color: var(--hc-danger) !important;
      }
      
      .${mode} .btn-success,
      .${mode} button.success {
        background-color: var(--hc-success) !important;
      }
      
      /* 链接样式 */
      .${mode} a {
        color: var(--hc-link) !important;
        text-decoration: underline !important;
        font-weight: bold !important;
      }
      
      .${mode} a:hover,
      .${mode} a:focus {
        outline: 3px solid var(--hc-focus) !important;
      }
      
      /* 焦点环增强 */
      .${mode} *:focus,
      .${mode} *:focus-visible {
        outline: 4px solid var(--hc-focus) !important;
        outline-offset: 2px !important;
      }
      
      /* 地图标记高对比度 */
      .${mode} .map-marker,
      .${mode} .pokemon-marker {
        border: 4px solid var(--hc-border) !important;
        background-color: var(--hc-primary) !important;
        color: var(--hc-bg) !important;
        font-weight: bold !important;
      }
      
      /* 精灵图标边框 */
      .${mode} .pokemon-icon,
      .${mode} .pokemon-sprite {
        border: 3px solid var(--hc-border) !important;
        box-shadow: 0 0 10px var(--hc-primary) !important;
      }
      
      /* 输入框增强 */
      .${mode} input,
      .${mode} select,
      .${mode} textarea {
        background-color: var(--hc-bg) !important;
        color: var(--hc-fg) !important;
        border: 3px solid var(--hc-border) !important;
        font-size: 16px !important;
        padding: 8px !important;
      }
      
      .${mode} input::placeholder {
        color: var(--hc-fg) !important;
        opacity: 0.7 !important;
      }
      
      /* 卡片和面板 */
      .${mode} .card,
      .${mode} .panel,
      .${mode} .modal {
        background-color: var(--hc-bg) !important;
        color: var(--hc-fg) !important;
        border: 3px solid var(--hc-border) !important;
        box-shadow: none !important;
      }
      
      /* 表格 */
      .${mode} table {
        border: 3px solid var(--hc-border) !important;
        border-collapse: collapse !important;
      }
      
      .${mode} th,
      .${mode} td {
        border: 2px solid var(--hc-border) !important;
        padding: 8px !important;
      }
      
      .${mode} th {
        background-color: var(--hc-primary) !important;
        color: var(--hc-bg) !important;
        font-weight: bold !important;
      }
      
      /* 分隔线 */
      .${mode} hr,
      .${mode} .divider {
        border: 2px solid var(--hc-border) !important;
        background: none !important;
      }
      
      /* 图标增强 */
      .${mode} .icon,
      .${mode} .emoji {
        filter: none !important;
      }
      
      /* 隐藏装饰元素 */
      .${mode} .decorative,
      .${mode} [aria-hidden="true"]:not(.pokemon-icon):not(.pokemon-sprite) {
        opacity: 0.3 !important;
      }
      
      /* 错误和警告消息 */
      .${mode} .error,
      .${mode} .alert-error {
        background-color: var(--hc-danger) !important;
        color: var(--hc-bg) !important;
        border: 3px solid var(--hc-danger) !important;
        font-weight: bold !important;
      }
      
      .${mode} .success,
      .${mode} .alert-success {
        background-color: var(--hc-success) !important;
        color: var(--hc-bg) !important;
        border: 3px solid var(--hc-success) !important;
        font-weight: bold !important;
      }
      
      .${mode} .warning,
      .${mode} .alert-warning {
        background-color: var(--hc-warning) !important;
        color: var(--hc-bg) !important;
        border: 3px solid var(--hc-warning) !important;
        font-weight: bold !important;
      }
      
      /* 导航标签 */
      .${mode} .nav-tab,
      .${mode} .tab {
        border: 3px solid var(--hc-border) !important;
        font-weight: bold !important;
      }
      
      .${mode} .nav-tab.active,
      .${mode} .tab.active {
        background-color: var(--hc-primary) !important;
        color: var(--hc-bg) !important;
      }
      
      /* 进度条 */
      .${mode} .progress-bar {
        border: 3px solid var(--hc-border) !important;
        background-color: var(--hc-bg) !important;
      }
      
      .${mode} .progress-fill {
        background-color: var(--hc-primary) !important;
      }
      
      /* 徽章和标签 */
      .${mode} .badge,
      .${mode} .tag,
      .${mode} .chip {
        border: 2px solid var(--hc-border) !important;
        font-weight: bold !important;
      }
      
      /* 下拉菜单 */
      .${mode} .dropdown,
      .${mode} .menu {
        border: 3px solid var(--hc-border) !important;
        background-color: var(--hc-bg) !important;
      }
      
      .${mode} .dropdown-item:hover,
      .${mode} .menu-item:hover {
        background-color: var(--hc-primary) !important;
        color: var(--hc-bg) !important;
      }
    `;
  }
  
  /**
   * 创建设置 UI
   */
  createSettingsUI(container) {
    const ui = document.createElement('div');
    ui.className = 'high-contrast-settings';
    ui.setAttribute('role', 'group');
    ui.setAttribute('aria-labelledby', 'high-contrast-title');
    
    ui.innerHTML = `
      <div class="setting-header">
        <h3 id="high-contrast-title" class="setting-title">高对比度模式</h3>
      </div>
      
      <div class="setting-control">
        <label class="setting-label" for="high-contrast-mode">
          <span class="label-text">显示模式</span>
          <select id="high-contrast-mode" 
                  class="setting-select"
                  aria-describedby="high-contrast-hint">
            <option value="auto">跟随系统</option>
            <option value="standard">标准</option>
            <option value="high-contrast">高对比度（黄/黑）</option>
            <option value="black-white">黑白模式</option>
          </select>
        </label>
        <p id="high-contrast-hint" class="setting-hint">
          提高界面元素对比度，适合低视力用户或强光环境使用
        </p>
      </div>
      
      <div class="setting-info">
        <div class="info-item">
          <span class="info-label">当前模式：</span>
          <span id="current-mode-display" class="info-value">${this.getModeDisplayName(this.currentMode)}</span>
        </div>
        <div class="info-item">
          <span class="info-label">系统偏好：</span>
          <span class="info-value">${this.systemPreference ? '高对比度' : '标准'}</span>
        </div>
      </div>
    `;
    
    // 绑定事件
    const select = ui.querySelector('#high-contrast-mode');
    
    // 设置当前值
    if (this.userPreference === null) {
      select.value = 'auto';
    } else {
      select.value = this.userPreference;
    }
    
    select.addEventListener('change', (e) => {
      this.setPreference(e.target.value);
      
      // 更新显示
      const display = ui.querySelector('#current-mode-display');
      display.textContent = this.getModeDisplayName(this.currentMode);
    });
    
    // 监听模式变化
    window.addEventListener('high-contrast-change', () => {
      const display = ui.querySelector('#current-mode-display');
      display.textContent = this.getModeDisplayName(this.currentMode);
    });
    
    container.appendChild(ui);
    return ui;
  }
  
  /**
   * 获取模式显示名称
   */
  getModeDisplayName(mode) {
    const names = {
      'standard': '标准',
      'high-contrast': '高对比度',
      'black-white': '黑白'
    };
    return names[mode] || mode;
  }
  
  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      enabled: this.enabled,
      currentMode: this.currentMode,
      systemPreference: this.systemPreference,
      userPreference: this.userPreference,
      metrics: { ...this.metrics }
    };
  }
  
  /**
   * 检查对比度合规性
   * @returns {Object} 对比度检查结果
   */
  checkContrastCompliance() {
    // WCAG 2.1 AAA 标准：
    // - 普通文本：≥ 7:1
    // - 大文本（≥18pt 或 ≥14pt 加粗）：≥ 4.5:1
    
    const results = {
      compliant: true,
      checks: []
    };
    
    // 高对比度模式下的理论对比度
    if (this.currentMode === 'high-contrast') {
      results.checks.push({
        element: 'body text',
        ratio: 21, // 黑底白字 = 21:1
        required: 7,
        passes: true
      });
      
      results.checks.push({
        element: 'button text',
        ratio: 19.56, // 黄底黑字 ≈ 19.56:1
        required: 7,
        passes: true
      });
    } else if (this.currentMode === 'black-white') {
      results.checks.push({
        element: 'all elements',
        ratio: 21, // 黑底白字 = 21:1
        required: 7,
        passes: true
      });
    } else {
      // 标准模式需要实际测量
      results.checks.push({
        element: 'standard mode',
        ratio: 'varies',
        required: 7,
        passes: 'unknown',
        note: '需要实际测量页面元素对比度'
      });
    }
    
    results.compliant = results.checks.every(c => c.passes === true);
    
    return results;
  }
}

// 创建单例实例
export const highContrastMode = new HighContrastMode();

// 自动初始化（在 DOMContentLoaded 后）
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      highContrastMode.init();
    });
  } else {
    highContrastMode.init();
  }
}

export default highContrastMode;
