# REQ-00144：游戏客户端高对比度模式支持系统

- **编号**：REQ-00144
- **类别**：无障碍(a11y)
- **优先级**：P2
- **状态**：done
- **涉及服务/模块**：game-client、frontend/game-client/src/accessibility、frontend/game-client/styles
- **创建时间**：2026-06-12 05:10
- **依赖需求**：REQ-00017（无障碍访问支持）

## 1. 背景与问题

当前 mineGo 游戏客户端已实现色盲模式（REQ-00035）、字体大小调节、动画减弱等无障碍功能，但缺少**高对比度模式**支持。

高对比度模式是 WCAG 2.1 AAA 级要求，对于以下用户群体至关重要：
- **低视力用户**：需要更高的颜色对比度才能清晰辨识界面元素
- **老年用户**：随着年龄增长，对比度敏感度下降
- **强光环境下使用的用户**：户外 AR 游戏场景常见

当前问题：
1. 现有配色方案对比度不足（部分按钮文字对比度仅 2.5:1，未达 AA 标准 4.5:1）
2. 缺少系统级高对比度偏好检测（`prefers-contrast: more`）
3. 无高对比度主题切换 UI
4. 地图标记、精灵图标在强光下辨识度低

## 2. 目标

实现完整的高对比度模式支持系统，达成以下目标：
- **WCAG 2.1 AAA 合规**：所有文本对比度 ≥ 7:1，大文本 ≥ 4.5:1
- **系统偏好自动检测**：响应 `prefers-contrast: more` 媒体查询
- **手动切换支持**：用户可手动开启/关闭高对比度模式
- **AR 场景优化**：地图标记、精灵图标在强光下清晰可辨
- **预期影响**：低视力用户可访问性提升 100%+，户外使用体验提升 40%+

## 3. 范围

- **包含**：
  - 高对比度模式核心管理模块（HighContrastMode.js）
  - 高对比度 CSS 主题（high-contrast.css）
  - 系统偏好检测与响应
  - 用户偏好存储与切换 UI
  - 地图标记高对比度样式
  - 精灵图标高对比度边框
  - 单元测试覆盖

- **不包含**：
  - 服务端逻辑（纯前端功能）
  - 色盲模式与高对比度模式的交互（已在 REQ-00035 中实现）
  - 第三方地图 SDK 的高对比度支持（需等待 SDK 更新）

## 4. 详细需求

### 4.1 核心模块：HighContrastMode.js

```javascript
// frontend/game-client/src/accessibility/HighContrastMode.js

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
  }
  
  // 初始化：检测系统偏好
  init() {
    this.systemPreference = window.matchMedia('(prefers-contrast: more)').matches;
    this.userPreference = localStorage.getItem('high-contrast-preference');
    
    // 监听系统偏好变化
    window.matchMedia('(prefers-contrast: more)').addEventListener('change', (e) => {
      this.systemPreference = e.matches;
      this.applyMode();
    });
    
    this.applyMode();
  }
  
  // 应用模式
  applyMode() {
    const effectiveMode = this.userPreference || (this.systemPreference ? 'high-contrast' : 'standard');
    this.currentMode = effectiveMode;
    this.enabled = effectiveMode !== 'standard';
    
    const root = document.documentElement;
    root.classList.remove('high-contrast', 'black-white');
    
    if (this.enabled) {
      root.classList.add(effectiveMode);
      this.injectHighContrastStyles(effectiveMode);
    }
    
    // 触发事件
    window.dispatchEvent(new CustomEvent('high-contrast-change', {
      detail: { mode: effectiveMode, enabled: this.enabled }
    }));
  }
  
  // 设置用户偏好
  setPreference(mode) {
    this.userPreference = mode;
    localStorage.setItem('high-contrast-preference', mode);
    this.applyMode();
  }
  
  // 注入高对比度样式
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
      
      .${mode} .btn,
      .${mode} button {
        background-color: var(--hc-primary) !important;
        color: var(--hc-bg) !important;
        border: 3px solid var(--hc-border) !important;
        font-weight: bold !important;
      }
      
      .${mode} .btn-primary {
        background-color: var(--hc-primary) !important;
      }
      
      .${mode} .btn-danger {
        background-color: var(--hc-danger) !important;
      }
      
      .${mode} a {
        color: var(--hc-link) !important;
        text-decoration: underline !important;
      }
      
      /* 焦点环增强 */
      .${mode} *:focus-visible {
        outline: 4px solid var(--hc-focus) !important;
        outline-offset: 2px !important;
      }
      
      /* 地图标记高对比度 */
      .${mode} .map-marker {
        border: 4px solid var(--hc-border) !important;
        background-color: var(--hc-primary) !important;
      }
      
      /* 精灵图标边框 */
      .${mode} .pokemon-icon {
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
      }
    `;
  }
  
  // 创建设置 UI
  createSettingsUI(container) {
    const ui = document.createElement('div');
    ui.className = 'high-contrast-settings';
    ui.innerHTML = `
      <label class="setting-label">
        <span>高对比度模式</span>
        <select id="high-contrast-mode" aria-label="选择高对比度模式">
          <option value="standard">标准</option>
          <option value="high-contrast">高对比度（黄/黑）</option>
          <option value="black-white">黑白模式</option>
        </select>
      </label>
      <p class="setting-hint">提高界面元素对比度，适合低视力用户或强光环境</p>
    `;
    
    const select = ui.querySelector('#high-contrast-mode');
    select.value = this.currentMode;
    select.addEventListener('change', (e) => {
      this.setPreference(e.target.value);
    });
    
    container.appendChild(ui);
    return ui;
  }
}

export const highContrastMode = new HighContrastMode();
```

### 4.2 CSS 主题文件

```css
/* frontend/game-client/styles/high-contrast.css */

/* 高对比度模式基础样式 */
.high-contrast,
.black-white {
  /* 增强所有边框 */
  * {
    border-color: currentColor !important;
  }
  
  /* 增强文本可读性 */
  body {
    font-weight: 500;
    letter-spacing: 0.02em;
  }
  
  /* 隐藏纯装饰元素 */
  .decorative,
  [aria-hidden="true"]:not(.pokemon-icon) {
    opacity: 0.3;
  }
  
  /* 增强卡片边框 */
  .card,
  .panel,
  .modal {
    border-width: 3px !important;
    box-shadow: none !important;
  }
  
  /* 增强表格边框 */
  table,
  th,
  td {
    border: 2px solid currentColor !important;
  }
  
  /* 增强分隔线 */
  hr,
  .divider {
    border-width: 2px !important;
  }
  
  /* 增强图标边框 */
  .icon,
  .emoji {
    filter: none !important;
  }
}

/* 黑白模式特殊样式 */
.black-white {
  /* 移除所有颜色，仅保留黑白 */
  * {
    background-image: none !important;
  }
  
  img:not(.pokemon-icon) {
    filter: grayscale(100%) contrast(150%) !important;
  }
}

/* 打印样式优化 */
@media print {
  .high-contrast,
  .black-white {
    background-color: #FFFFFF !important;
    color: #000000 !important;
  }
}
```

### 4.3 地图标记高对比度支持

```javascript
// 在 MapManager.js 中集成高对比度模式

import { highContrastMode } from '../accessibility/HighContrastMode.js';

class MapManager {
  createPokemonMarker(pokemon) {
    const marker = document.createElement('div');
    marker.className = 'pokemon-marker';
    
    // 高对比度模式下添加边框和标签
    if (highContrastMode.enabled) {
      marker.classList.add('high-contrast-marker');
      marker.innerHTML = `
        <div class="marker-icon">${pokemon.icon}</div>
        <div class="marker-label">${pokemon.name}</div>
      `;
      marker.setAttribute('aria-label', `${pokemon.name} 精灵，距离 ${pokemon.distance}米`);
    } else {
      marker.innerHTML = `<img src="${pokemon.icon}" alt="${pokemon.name}">`;
    }
    
    return marker;
  }
}

// 监听高对比度模式变化
window.addEventListener('high-contrast-change', (e) => {
  if (e.detail.enabled) {
    mapManager.refreshAllMarkers();
  }
});
```

### 4.4 Prometheus 指标

```javascript
// 新增 3 个 Prometheus 指标
highContrastModeEnabled: new Gauge({
  name: 'game_client_high_contrast_mode_enabled',
  help: '高对比度模式是否启用',
  labelNames: ['mode']
}),

highContrastModeChanges: new Counter({
  name: 'game_client_high_contrast_mode_changes_total',
  help: '高对比度模式切换次数'
}),

highContrastSystemPreference: new Gauge({
  name: 'game_client_high_contrast_system_preference',
  help: '系统高对比度偏好'
})
```

## 5. 验收标准（可测试）

- [ ] 所有文本元素对比度 ≥ 7:1（AAA 级），大文本 ≥ 4.5:1
- [ ] 所有交互元素（按钮、链接、输入框）有清晰的焦点指示（≥ 4px 边框）
- [ ] 系统偏好 `prefers-contrast: more` 自动检测并应用高对比度模式
- [ ] 用户可手动切换标准/高对比度/黑白三种模式
- [ ] 用户偏好持久化到 localStorage，刷新后保持
- [ ] 地图标记在高对比度模式下有清晰的边框和文字标签
- [ ] 精灵图标在高对比度模式下有 3px 边框和发光效果
- [ ] 高对比度模式切换触发 `high-contrast-change` 事件
- [ ] 单元测试覆盖核心功能（≥ 25 个测试用例）
- [ ] 与色盲模式可同时启用，样式不冲突

## 6. 工作量估算

**M（中等）**

理由：
- 核心模块代码量约 300 行
- CSS 样式约 200 行
- 地图集成约 100 行
- 单元测试约 200 行
- 无服务端改动
- 预计 1-2 天完成

## 7. 优先级理由

**P2（中等优先级）**

理由：
1. **无障碍合规**：WCAG 2.1 AAA 要求，但非核心功能
2. **用户覆盖**：低视力用户约占 4-8%，户外使用场景常见
3. **依赖已有**：基于 REQ-00017 无障碍基础设施，实现成本低
4. **不影响核心链路**：注册/捕捉/支付等核心功能不受影响
5. **提升用户体验**：对目标用户群体价值显著，体现产品社会责任
