// frontend/game-client/src/language/LanguageSwitcher.js - REQ-00393 前端语言切换组件
'use strict';

class LanguageSwitcher {
  constructor(apiClient) {
    this.api = apiClient;
    this.currentLanguage = localStorage.getItem('language') || 'en';
    this.listeners = [];
    this.pendingRequest = null;
    
    // 欢迎消息
    this.welcomeMessages = {
      zh: '语言已切换为中文',
      en: 'Language switched to English',
      ja: '言語が日本語に切り替わりました'
    };
    
    // 支持的语言
    this.supportedLanguages = ['zh', 'en', 'ja'];
    
    // 语言名称
    this.languageNames = {
      zh: '中文',
      en: 'English',
      ja: '日本語'
    };
  }

  /**
   * 初始化语言系统
   */
  async init() {
    // 从服务器同步语言设置
    try {
      const response = await this.api.get('/api/user/language');
      if (response.language && response.language !== this.currentLanguage) {
        await this.applyLanguage(response.language, false);
      }
    } catch (error) {
      console.warn('获取服务器语言失败，使用本地设置', error);
    }
    
    // 设置 WebSocket 语言同步监听
    this.setupWebSocketLanguageSync();
    
    console.log('语言系统初始化完成', { language: this.currentLanguage });
  }

  /**
   * 切换语言
   * @param {string} language - 目标语言代码
   * @returns {Promise<object>}
   */
  async switchLanguage(language) {
    // 验证语言有效性
    if (!this.supportedLanguages.includes(language)) {
      throw new Error(`不支持的语言: ${language}`);
    }
    
    // 防止重复请求
    if (this.pendingRequest) {
      return this.pendingRequest;
    }
    
    const previousLanguage = this.currentLanguage;
    
    try {
      this.pendingRequest = this.api.put('/api/user/language', { language });
      
      const response = await this.pendingRequest;
      
      if (response.success) {
        await this.applyLanguage(language, true);
        
        // 显示切换成功通知
        this.showNotification(this.welcomeMessages[language]);
        
        // 触发语言变更回调
        this.notifyListeners({
          language,
          previousLanguage,
          message: response.message,
          sessionPreserved: response.sessionPreserved
        });
        
        console.log('语言切换成功', { previousLanguage, newLanguage: language });
        
        return {
          success: true,
          language,
          previousLanguage,
          message: response.message
        };
      }
      
      return response;
      
    } catch (error) {
      console.error('切换语言失败', error);
      this.showError(this.getLocalizedMessage('language_switch_failed'));
      
      // 回滚到之前语言
      this.currentLanguage = previousLanguage;
      
      throw error;
      
    } finally {
      this.pendingRequest = null;
    }
  }

  /**
   * 应用语言设置
   * @param {string} language - 语言代码
   * @param {boolean} updateServer - 是否已更新服务器
   */
  async applyLanguage(language, updateServer = true) {
    this.currentLanguage = language;
    
    // 更新 localStorage
    localStorage.setItem('language', language);
    
    // 更新 i18n 配置
    if (window.i18n) {
      window.i18n.setLocale(language);
    }
    
    // 更新 HTML lang 属性
    document.documentElement.lang = language;
    
    // 刷新页面内容
    await this.refreshUIContent();
    
    // 更新页面标题
    this.updatePageTitle();
    
    // 更新 RTL/LTR 方向（如果需要）
    this.updateTextDirection(language);
    
    console.log('语言已应用', { language, updateServer });
  }

  /**
   * 注册语言变更监听器
   * @param {function} callback - 回调函数
   */
  addListener(callback) {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * 通知所有监听器
   * @param {object} event - 事件数据
   */
  notifyListeners(event) {
    for (const callback of this.listeners) {
      try {
        callback(event);
      } catch (error) {
        console.error('语言监听器回调失败', error);
      }
    }
  }

  /**
   * 刷新 UI 内容
   */
  async refreshUIContent() {
    // 更新所有带有 data-i18n 属性的元素
    const textElements = document.querySelectorAll('[data-i18n]');
    
    for (const element of textElements) {
      const key = element.getAttribute('data-i18n');
      const text = this.getLocalizedMessage(key);
      if (text) {
        element.textContent = text;
      }
    }
    
    // 更新所有带有 data-i18n-placeholder 属性的元素
    const placeholderElements = document.querySelectorAll('[data-i18n-placeholder]');
    
    for (const element of placeholderElements) {
      const key = element.getAttribute('data-i18n-placeholder');
      const text = this.getLocalizedMessage(key);
      if (text) {
        element.placeholder = text;
      }
    }
    
    // 更新所有带有 data-i18n-title 属性的元素
    const titleElements = document.querySelectorAll('[data-i18n-title]');
    
    for (const element of titleElements) {
      const key = element.getAttribute('data-i18n-title');
      const text = this.getLocalizedMessage(key);
      if (text) {
        element.title = text;
      }
    }
    
    // 更新所有带有 data-i18n-value 属性的元素
    const valueElements = document.querySelectorAll('[data-i18n-value]');
    
    for (const element of valueElements) {
      const key = element.getAttribute('data-i18n-value');
      const text = this.getLocalizedMessage(key);
      if (text) {
        element.value = text;
      }
    }
    
    // 更新动态内容区域
    await this.updateDynamicContent();
    
    console.log('UI 内容已刷新', { textElements: textElements.length });
  }

  /**
   * 更新动态内容区域
   */
  async updateDynamicContent() {
    // 更新菜单栏
    const menuItems = document.querySelectorAll('.menu-item');
    for (const item of menuItems) {
      const key = item.getAttribute('data-i18n');
      if (key) {
        item.textContent = this.getLocalizedMessage(key);
      }
    }
    
    // 更新按钮文本
    const buttons = document.querySelectorAll('button[data-i18n]');
    for (const button of buttons) {
      const key = button.getAttribute('data-i18n');
      if (key) {
        button.textContent = this.getLocalizedMessage(key);
      }
    }
    
    // 更新表单标签
    const labels = document.querySelectorAll('label[data-i18n]');
    for (const label of labels) {
      const key = label.getAttribute('data-i18n');
      if (key) {
        label.textContent = this.getLocalizedMessage(key);
      }
    }
  }

  /**
   * 更新页面标题
   */
  updatePageTitle() {
    const titleKey = document.body.getAttribute('data-i18n-page-title') || 'page_title';
    document.title = this.getLocalizedMessage(titleKey) || 'Pocket Monster Go';
  }

  /**
   * 更新文本方向（RTL/LTR）
   */
  updateTextDirection(language) {
    // 目前所有支持的语言都是 LTR，预留 RTL 支持
    const rtlLanguages = ['ar', 'he', 'fa'];
    const direction = rtlLanguages.includes(language) ? 'rtl' : 'ltr';
    document.documentElement.dir = direction;
  }

  /**
   * WebSocket 语言同步监听
   */
  setupWebSocketLanguageSync() {
    if (window.gameWebSocket) {
      window.gameWebSocket.on('language-updated', async (data) => {
        console.log('WebSocket 语言同步', data);
        
        if (data.language && data.language !== this.currentLanguage) {
          await this.applyLanguage(data.language, false);
          this.showNotification(data.message);
          this.notifyListeners({
            language: data.language,
            previousLanguage: data.previousLanguage,
            source: 'websocket',
            message: data.message
          });
        }
      });
      
      // 监听参与者语言变更（战斗场景）
      window.gameWebSocket.on('participant-language-changed', (data) => {
        console.log('战斗参与者语言变更', data);
        // 可以在这里更新对战 UI 显示的语言
      });
    }
  }

  /**
   * 显示通知
   * @param {string} message - 消息内容
   */
  showNotification(message) {
    if (window.toastManager) {
      window.toastManager.show(message, { type: 'success', duration: 3000 });
    } else {
      // 简单的通知实现
      const notification = document.createElement('div');
      notification.className = 'language-notification';
      notification.textContent = message;
      notification.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: #4CAF50;
        color: white;
        padding: 12px 24px;
        border-radius: 4px;
        z-index: 10000;
        animation: fadeInOut 3s ease;
      `;
      document.body.appendChild(notification);
      
      setTimeout(() => {
        notification.remove();
      }, 3000);
    }
  }

  /**
   * 显示错误
   * @param {string} message - 错误消息
   */
  showError(message) {
    if (window.toastManager) {
      window.toastManager.show(message, { type: 'error', duration: 5000 });
    } else {
      console.error(message);
    }
  }

  /**
   * 获取本地化消息
   * @param {string} key - 消息键
   * @returns {string}
   */
  getLocalizedMessage(key) {
    const messages = {
      'page_title': {
        zh: '精灵捕捉 Go',
        en: 'Pocket Monster Go',
        ja: 'ポケモンGo'
      },
      'language_switch_failed': {
        zh: '语言切换失败，请稍后重试',
        en: 'Language switch failed, please try again later',
        ja: '言語切り替え失敗、後で再試行してください'
      },
      'menu_home': {
        zh: '首页',
        en: 'Home',
        ja: 'ホーム'
      },
      'menu_map': {
        zh: '地图',
        en: 'Map',
        ja: 'マップ'
      },
      'menu_bag': {
        zh: '背包',
        en: 'Bag',
        ja: 'バッグ'
      },
      'menu_pokedex': {
        zh: '图鉴',
        en: 'Pokedex',
        ja: 'ポケモン図鑑'
      },
      'menu_social': {
        zh: '社交',
        en: 'Social',
        ja: 'ソーシャル'
      },
      'menu_shop': {
        zh: '商店',
        en: 'Shop',
        ja: 'ショップ'
      },
      'menu_settings': {
        zh: '设置',
        en: 'Settings',
        ja: '設定'
      },
      'btn_confirm': {
        zh: '确认',
        en: 'Confirm',
        ja: '確認'
      },
      'btn_cancel': {
        zh: '取消',
        en: 'Cancel',
        ja: 'キャンセル'
      },
      'btn_save': {
        zh: '保存',
        en: 'Save',
        ja: '保存'
      },
      'btn_close': {
        zh: '关闭',
        en: 'Close',
        ja: '閉じる'
      },
      'settings_language': {
        zh: '语言设置',
        en: 'Language Settings',
        ja: '言語設定'
      },
      'settings_language_desc': {
        zh: '切换游戏显示语言，无需重新登录',
        en: 'Switch game display language without re-login',
        ja: 'ゲーム表示言語を切り替え、再ログイン不要'
      }
    };
    
    const msgSet = messages[key];
    if (msgSet) {
      return msgSet[this.currentLanguage] || msgSet['en'] || key;
    }
    
    // 尝试从全局 i18n 获取
    if (window.i18n) {
      return window.i18n.translate(key);
    }
    
    return key;
  }

  /**
   * 获取当前语言
   * @returns {string}
   */
  getCurrentLanguage() {
    return this.currentLanguage;
  }

  /**
   * 获取支持的语言列表
   * @returns {object[]}
   */
  getSupportedLanguages() {
    return this.supportedLanguages.map(code => ({
      code,
      name: this.languageNames[code],
      isCurrent: code === this.currentLanguage
    }));
  }

  /**
   * 创建语言选择 UI
   * @returns {HTMLElement}
   */
  createLanguageSelector() {
    const container = document.createElement('div');
    container.className = 'language-selector';
    
    const label = document.createElement('label');
    label.textContent = this.getLocalizedMessage('settings_language');
    label.setAttribute('data-i18n', 'settings_language');
    container.appendChild(label);
    
    const select = document.createElement('select');
    select.className = 'language-select';
    
    for (const lang of this.getSupportedLanguages()) {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = lang.name;
      option.selected = lang.isCurrent;
      select.appendChild(option);
    }
    
    select.addEventListener('change', async (e) => {
      const newLanguage = e.target.value;
      try {
        await this.switchLanguage(newLanguage);
      } catch (error) {
        // 恢复选择
        select.value = this.currentLanguage;
      }
    });
    
    container.appendChild(select);
    
    const description = document.createElement('p');
    description.className = 'language-description';
    description.textContent = this.getLocalizedMessage('settings_language_desc');
    description.setAttribute('data-i18n', 'settings_language_desc');
    container.appendChild(description);
    
    return container;
  }
}

// 导出单例
window.languageSwitcher = new LanguageSwitcher(window.apiClient || {});

module.exports = LanguageSwitcher;