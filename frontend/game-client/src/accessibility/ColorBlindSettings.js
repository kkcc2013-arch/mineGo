/**
 * 色盲模式设置 UI 组件
 * 提供用户友好的色盲模式选择界面
 * 
 * @module ColorBlindSettings
 */

import { colorBlindMode, COLOR_BLIND_TYPES } from './ColorBlindMode.js';

/**
 * 创建色盲模式设置面板
 */
function createColorBlindSettingsPanel() {
  const currentMode = colorBlindMode.getMode();
  const supportedTypes = colorBlindMode.getSupportedTypes();

  const panel = document.createElement('div');
  panel.id = 'colorblind-settings-panel';
  panel.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10001;
    animation: fadeIn 0.2s ease;
  `;

  const content = document.createElement('div');
  content.style.cssText = `
    background: var(--surface, #13161e);
    border: 1px solid var(--border, #252938);
    border-radius: 16px;
    padding: 24px;
    max-width: 400px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
  `;

  // 标题
  const title = document.createElement('div');
  title.style.cssText = `
    font-size: 20px;
    font-weight: 800;
    color: var(--text, #e8eaf0);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 10px;
  `;
  title.innerHTML = `<span style="font-size: 24px;">🎨</span> 色盲模式设置`;
  content.appendChild(title);

  // 说明文字
  const description = document.createElement('div');
  description.style.cssText = `
    font-size: 13px;
    color: var(--muted, #6b7280);
    margin-bottom: 20px;
    line-height: 1.5;
  `;
  description.textContent = '选择适合您视觉模式的配色方案，所有关键信息将通过形状、图标和文字多重传达。';
  content.appendChild(description);

  // 选项列表
  const optionsList = document.createElement('div');
  optionsList.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 20px;
  `;

  supportedTypes.forEach(type => {
    const option = document.createElement('div');
    option.style.cssText = `
      background: ${type.isCurrent ? 'var(--surface2, #1a1e28)' : 'transparent'};
      border: 2px solid ${type.isCurrent ? 'var(--blue, #3d8ef8)' : 'var(--border, #252938)'};
      border-radius: 12px;
      padding: 14px 16px;
      cursor: pointer;
      transition: all 0.15s;
      display: flex;
      align-items: center;
      gap: 12px;
    `;

    // 单选按钮
    const radio = document.createElement('div');
    radio.style.cssText = `
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 2px solid ${type.isCurrent ? 'var(--blue, #3d8ef8)' : 'var(--muted, #6b7280)'};
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    `;
    if (type.isCurrent) {
      radio.innerHTML = `<div style="width: 10px; height: 10px; border-radius: 50%; background: var(--blue, #3d8ef8);"></div>`;
    }

    // 标签
    const label = document.createElement('div');
    label.style.cssText = `
      flex: 1;
      font-size: 14px;
      font-weight: 600;
      color: var(--text, #e8eaf0);
    `;
    label.textContent = type.label;

    option.appendChild(radio);
    option.appendChild(label);

    // 点击事件
    option.addEventListener('click', () => {
      if (!type.isCurrent) {
        colorBlindMode.setMode(type.value);
        showToast(`✅ 已切换至 ${type.label}`);
        closeColorBlindSettings();
      }
    });

    // hover 效果
    option.addEventListener('mouseenter', () => {
      if (!type.isCurrent) {
        option.style.borderColor = 'var(--muted, #6b7280)';
        option.style.background = 'var(--surface2, #1a1e28)';
      }
    });
    option.addEventListener('mouseleave', () => {
      if (!type.isCurrent) {
        option.style.borderColor = 'var(--border, #252938)';
        option.style.background = 'transparent';
      }
    });

    optionsList.appendChild(option);
  });

  content.appendChild(optionsList);

  // 预览区域
  const previewSection = document.createElement('div');
  previewSection.style.cssText = `
    border-top: 1px solid var(--border, #252938);
    padding-top: 16px;
    margin-bottom: 20px;
  `;

  const previewTitle = document.createElement('div');
  previewTitle.style.cssText = `
    font-size: 11px;
    font-weight: 700;
    color: var(--muted, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 12px;
  `;
  previewTitle.textContent = '稀有度预览';
  previewSection.appendChild(previewTitle);

  // 稀有度图标预览
  const previewIcons = document.createElement('div');
  previewIcons.style.cssText = `
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  `;

  ['common', 'rare', 'epic', 'legendary'].forEach(rarity => {
    const icon = colorBlindMode.getRarityIcon(rarity);
    const item = document.createElement('div');
    item.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--bg, #0d0f14);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      color: ${icon.color};
    `;
    item.innerHTML = `<span style="font-size: 16px;">${icon.icon}</span> ${icon.label}`;
    previewIcons.appendChild(item);
  });

  previewSection.appendChild(previewIcons);
  content.appendChild(previewSection);

  // 关闭按钮
  const closeBtn = document.createElement('button');
  closeBtn.style.cssText = `
    width: 100%;
    padding: 14px;
    border: none;
    border-radius: 12px;
    background: var(--blue, #3d8ef8);
    color: #fff;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    transition: opacity 0.15s;
  `;
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', closeColorBlindSettings);
  closeBtn.addEventListener('mouseenter', () => closeBtn.style.opacity = '0.85');
  closeBtn.addEventListener('mouseleave', () => closeBtn.style.opacity = '1');
  content.appendChild(closeBtn);

  panel.appendChild(content);

  // 点击背景关闭
  panel.addEventListener('click', (e) => {
    if (e.target === panel) {
      closeColorBlindSettings();
    }
  });

  return panel;
}

/**
 * 显示色盲模式设置面板
 */
function showColorBlindSettings() {
  // 检查是否已存在
  if (document.getElementById('colorblind-settings-panel')) {
    return;
  }

  const panel = createColorBlindSettingsPanel();
  document.body.appendChild(panel);

  // ESC 键关闭
  const handleEscape = (e) => {
    if (e.key === 'Escape') {
      closeColorBlindSettings();
    }
  };
  document.addEventListener('keydown', handleEscape);
  panel.dataset.escapeHandler = 'true';

  // 存储处理函数引用
  panel._escapeHandler = handleEscape;
}

/**
 * 关闭色盲模式设置面板
 */
function closeColorBlindSettings() {
  const panel = document.getElementById('colorblind-settings-panel');
  if (panel) {
    if (panel._escapeHandler) {
      document.removeEventListener('keydown', panel._escapeHandler);
    }
    panel.style.animation = 'fadeOut 0.2s ease';
    setTimeout(() => panel.remove(), 200);
  }
}

/**
 * 显示 Toast 消息
 */
function showToast(message) {
  if (window.toast) {
    window.toast(message, 'ok');
  } else {
    console.log('[ColorBlindSettings]', message);
  }
}

/**
 * 在设置页面添加色盲模式选项
 */
function addColorBlindSettingsToProfile() {
  const invCard = document.querySelector('.inv-card:last-of-type');
  if (!invCard) return;

  const settingsRow = document.createElement('div');
  settingsRow.className = 'inv-row';
  settingsRow.style.cursor = 'pointer';
  settingsRow.innerHTML = `
    <div class="inv-icon">🎨</div>
    <div class="inv-name">色盲模式</div>
    <div class="inv-qty" id="current-colorblind-mode">${COLOR_BLIND_TYPES[colorBlindMode.getMode()]}</div>
  `;

  settingsRow.addEventListener('click', showColorBlindSettings);
  invCard.appendChild(settingsRow);

  // 监听模式变化，更新显示
  colorBlindMode.addListener((newMode) => {
    const display = document.getElementById('current-colorblind-mode');
    if (display) {
      display.textContent = COLOR_BLIND_TYPES[newMode];
    }
  });
}

/**
 * 初始化色盲模式
 */
function initColorBlindMode() {
  // 应用已保存的模式
  const savedMode = colorBlindMode.getMode();
  if (savedMode !== 'normal') {
    colorBlindMode.applyMode(savedMode);
  }

  // 添加到设置页面
  setTimeout(addColorBlindSettingsToProfile, 1000);

  console.log('[ColorBlindSettings] Initialized with mode:', savedMode);
}

// 导出函数
export {
  showColorBlindSettings,
  closeColorBlindSettings,
  addColorBlindSettingsToProfile,
  initColorBlindMode
};

// 挂载到 window 对象供全局调用
window.showColorBlindSettings = showColorBlindSettings;
window.closeColorBlindSettings = closeColorBlindSettings;

// 自动初始化
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initColorBlindMode);
  } else {
    initColorBlindMode();
  }
}
