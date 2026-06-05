// frontend/game-client/src/components/LanguageSelector.js
// Language selector component for i18n
'use strict';

import { i18n, t } from '../i18n/index.js';

class LanguageSelector {
  constructor(container) {
    this.container = container;
    this.isOpen = false;
    this.selectedLanguage = i18n.getLanguage();
    this.languages = i18n.getSupportedLanguages();
    this.render();
    this.bindEvents();
  }

  render() {
    const currentLang = this.languages.find(l => l.code === this.selectedLanguage);
    
    this.container.innerHTML = `
      <div class="lang-selector">
        <button class="lang-btn" type="button">
          <span class="lang-flag">${currentLang?.flag || '🌐'}</span>
          <span class="lang-name">${currentLang?.name || this.selectedLanguage}</span>
          <span class="lang-arrow">▼</span>
        </button>
        <div class="lang-dropdown ${this.isOpen ? 'open' : ''}">
          ${this.languages.map(lang => `
            <button class="lang-option ${lang.code === this.selectedLanguage ? 'selected' : ''}" 
                    data-lang="${lang.code}" type="button">
              <span class="lang-flag">${lang.flag}</span>
              <span class="lang-name">${lang.name}</span>
              ${lang.code === this.selectedLanguage ? '<span class="lang-check">✓</span>' : ''}
            </button>
          `).join('')}
        </div>
      </div>
    `;
    
    this.addStyles();
  }

  addStyles() {
    if (document.getElementById('lang-selector-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'lang-selector-styles';
    style.textContent = `
      .lang-selector {
        position: relative;
        display: inline-block;
      }
      .lang-btn {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 14px;
        background: var(--surface, #13161e);
        border: 1px solid var(--border, #252938);
        border-radius: 10px;
        color: var(--text, #e8eaf0);
        font-size: 14px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .lang-btn:hover {
        background: var(--surface2, #1a1e28);
        border-color: var(--blue, #3d8ef8);
      }
      .lang-flag {
        font-size: 18px;
        line-height: 1;
      }
      .lang-name {
        font-weight: 500;
      }
      .lang-arrow {
        font-size: 10px;
        color: var(--muted, #6b7280);
        transition: transform 0.2s ease;
      }
      .lang-selector.open .lang-arrow {
        transform: rotate(180deg);
      }
      .lang-dropdown {
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        right: 0;
        background: var(--surface, #13161e);
        border: 1px solid var(--border, #252938);
        border-radius: 10px;
        overflow: hidden;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-8px);
        transition: all 0.2s ease;
        z-index: 100;
        box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      }
      .lang-dropdown.open {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      .lang-option {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 12px 14px;
        background: transparent;
        border: none;
        color: var(--text, #e8eaf0);
        font-size: 14px;
        cursor: pointer;
        transition: background 0.15s ease;
        text-align: left;
      }
      .lang-option:hover {
        background: var(--surface2, #1a1e28);
      }
      .lang-option.selected {
        background: rgba(61, 142, 248, 0.1);
        color: var(--blue, #3d8ef8);
      }
      .lang-option .lang-check {
        margin-left: auto;
        color: var(--blue, #3d8ef8);
      }
    `;
    document.head.appendChild(style);
  }

  bindEvents() {
    const btn = this.container.querySelector('.lang-btn');
    const dropdown = this.container.querySelector('.lang-dropdown');
    
    // Toggle dropdown
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.isOpen = !this.isOpen;
      dropdown.classList.toggle('open', this.isOpen);
      this.container.querySelector('.lang-selector').classList.toggle('open', this.isOpen);
    });
    
    // Language selection
    dropdown.querySelectorAll('.lang-option').forEach(option => {
      option.addEventListener('click', async (e) => {
        const langCode = option.dataset.lang;
        if (langCode !== this.selectedLanguage) {
          await this.changeLanguage(langCode);
        }
        this.isOpen = false;
        dropdown.classList.remove('open');
        this.container.querySelector('.lang-selector').classList.remove('open');
      });
    });
    
    // Close on outside click
    document.addEventListener('click', () => {
      if (this.isOpen) {
        this.isOpen = false;
        dropdown.classList.remove('open');
        this.container.querySelector('.lang-selector').classList.remove('open');
      }
    });
  }

  async changeLanguage(langCode) {
    try {
      const success = await i18n.changeLanguage(langCode);
      if (success) {
        this.selectedLanguage = langCode;
        this.render();
        this.bindEvents();
        
        // Show notification
        if (window.pmgGame?.store?.addNotification) {
          window.pmgGame.store.addNotification(
            `🌐 ${t('language.changeNotice')}`,
            'info',
            2000
          );
        }
        
        // Reload page to apply changes fully
        setTimeout(() => location.reload(), 1500);
      }
    } catch (err) {
      console.error('[LanguageSelector] Failed to change language:', err);
    }
  }

  destroy() {
    this.container.innerHTML = '';
  }
}

// Factory function
export function createLanguageSelector(container) {
  return new LanguageSelector(container);
}

// Auto-init for elements with data-language-selector
export function autoInitLanguageSelectors() {
  document.querySelectorAll('[data-language-selector]').forEach(el => {
    if (!el._languageSelector) {
      el._languageSelector = new LanguageSelector(el);
    }
  });
}

export { LanguageSelector };
