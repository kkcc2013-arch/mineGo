/**
 * 隐私偏好中心组件
 * REQ-00322: Cookie 同意管理与隐私偏好中心
 */

class PrivacyPreferencesCenter {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.onSave = options.onSave || (() => {});
    
    this.categories = {
      necessary: { enabled: true, readonly: true },
      functional: { enabled: false, readonly: false },
      analytics: { enabled: false, readonly: false },
      marketing: { enabled: false, readonly: false },
      social: { enabled: false, readonly: false },
      performance: { enabled: false, readonly: false }
    };
    
    this.init();
  }

  async init() {
    await this.loadPreferences();
    this.render();
  }

  async loadPreferences() {
    try {
      const response = await fetch('/api/v1/privacy/consent', {
        credentials: 'include'
      });
      const data = await response.json();
      
      if (data.success && data.data.categories) {
        for (const [key, value] of Object.entries(data.data.categories)) {
          if (this.categories[key]) {
            this.categories[key].enabled = value;
          }
        }
      }
    } catch (error) {
      console.error('Failed to load preferences:', error);
    }
  }

  render() {
    const modal = document.createElement('div');
    modal.id = 'privacy-preferences-modal';
    modal.innerHTML = this.renderHTML();
    
    // 如果容器已存在元素，先移除
    const existing = document.getElementById('privacy-preferences-modal');
    if (existing) existing.remove();
    
    this.container.appendChild(modal);
    this.bindEvents(modal);
  }

  renderHTML() {
    return `
      <div class="privacy-modal-overlay">
        <div class="privacy-modal">
          <div class="privacy-modal-header">
            <h2>隐私偏好中心</h2>
            <button class="close-btn" aria-label="关闭">×</button>
          </div>
          
          <div class="privacy-modal-content">
            <div class="intro-text">
              <p>
                您可以在此管理和控制您的隐私偏好。我们尊重您的选择，并将根据您的设置调整数据收集和使用方式。
              </p>
            </div>
            
            <div class="category-list">
              ${this.renderCategory('necessary', '必要 Cookie', 
                '这些 Cookie 对于网站的正常运行至关重要，无法禁用。包括会话管理、安全验证等功能。',
                true, true)}
              
              ${this.renderCategory('functional', '功能性 Cookie',
                '这些 Cookie 用于记住您的偏好设置，如语言、主题等，以提供更好的用户体验。',
                this.categories.functional.enabled, false)}
              
              ${this.renderCategory('analytics', '分析 Cookie',
                '这些 Cookie 帮助我们了解访客如何使用网站，以便改进网站性能和内容。所有数据均为匿名。',
                this.categories.analytics.enabled, false)}
              
              ${this.renderCategory('marketing', '营销 Cookie',
                '这些 Cookie 用于追踪访问者跨网站的行为，以展示相关的广告和内容。',
                this.categories.marketing.enabled, false)}
              
              ${this.renderCategory('social', '社交媒体 Cookie',
                '这些 Cookie 由社交媒体平台设置，用于分享内容和集成社交功能。',
                this.categories.social.enabled, false)}
              
              ${this.renderCategory('performance', '性能 Cookie',
                '这些 Cookie 用于监控和分析网站性能，帮助优化加载速度和响应时间。',
                this.categories.performance.enabled, false)}
            </div>
            
            <div class="additional-info">
              <h3>了解更多</h3>
              <ul>
                <li><a href="/privacy/cookies" target="_blank">Cookie 政策</a></li>
                <li><a href="/privacy" target="_blank">隐私政策</a></li>
                <li><a href="/privacy/data-request" target="_blank">请求您的数据</a></li>
                <li><a href="/privacy/delete-account" target="_blank">删除账户</a></li>
              </ul>
            </div>
          </div>
          
          <div class="privacy-modal-footer">
            <button class="btn-secondary" id="btn-cancel">取消</button>
            <button class="btn-primary" id="btn-save-preferences">保存偏好</button>
          </div>
        </div>
      </div>
      
      <style>
        .privacy-modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
          z-index: 10000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          animation: fadeIn 0.2s ease-out;
        }
        
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        
        .privacy-modal {
          background: white;
          border-radius: 16px;
          max-width: 800px;
          width: 100%;
          max-height: 90vh;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        }
        
        .privacy-modal-header {
          padding: 24px;
          border-bottom: 1px solid #eee;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .privacy-modal-header h2 {
          margin: 0;
          font-size: 24px;
          color: #333;
        }
        
        .close-btn {
          background: none;
          border: none;
          font-size: 32px;
          color: #666;
          cursor: pointer;
          padding: 0;
          width: 40px;
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        
        .close-btn:hover {
          color: #333;
        }
        
        .privacy-modal-content {
          flex: 1;
          overflow-y: auto;
          padding: 24px;
        }
        
        .intro-text p {
          color: #555;
          line-height: 1.6;
          margin: 0 0 24px 0;
        }
        
        .category-list {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        
        .category-item {
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          padding: 16px;
          background: #fafafa;
        }
        
        .category-item.disabled {
          opacity: 0.6;
          background: #f5f5f5;
        }
        
        .category-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 8px;
        }
        
        .category-title {
          font-size: 16px;
          font-weight: 600;
          color: #333;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .badge-required {
          font-size: 12px;
          padding: 2px 8px;
          background: #2196F3;
          color: white;
          border-radius: 4px;
          font-weight: normal;
        }
        
        .toggle-switch {
          position: relative;
          width: 48px;
          height: 24px;
        }
        
        .toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        
        .toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: #ccc;
          transition: 0.3s;
          border-radius: 24px;
        }
        
        .toggle-slider:before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          transition: 0.3s;
          border-radius: 50%;
        }
        
        input:checked + .toggle-slider {
          background-color: #4CAF50;
        }
        
        input:checked + .toggle-slider:before {
          transform: translateX(24px);
        }
        
        input:disabled + .toggle-slider {
          background-color: #999;
          cursor: not-allowed;
        }
        
        .category-description {
          font-size: 14px;
          color: #666;
          line-height: 1.5;
        }
        
        .additional-info {
          margin-top: 32px;
          padding-top: 24px;
          border-top: 1px solid #e0e0e0;
        }
        
        .additional-info h3 {
          font-size: 16px;
          margin: 0 0 12px 0;
          color: #333;
        }
        
        .additional-info ul {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
        }
        
        .additional-info li a {
          color: #2196F3;
          text-decoration: none;
          padding: 8px 16px;
          background: #E3F2FD;
          border-radius: 4px;
          font-size: 14px;
        }
        
        .additional-info li a:hover {
          background: #BBDEFB;
        }
        
        .privacy-modal-footer {
          padding: 16px 24px;
          border-top: 1px solid #eee;
          display: flex;
          justify-content: flex-end;
          gap: 12px;
        }
        
        .privacy-modal-footer button {
          padding: 10px 24px;
          border: none;
          border-radius: 6px;
          font-size: 16px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }
        
        .btn-primary {
          background: #4CAF50;
          color: white;
        }
        
        .btn-primary:hover {
          background: #45a049;
        }
        
        .btn-secondary {
          background: #f5f5f5;
          color: #333;
          border: 1px solid #ddd;
        }
        
        .btn-secondary:hover {
          background: #e0e0e0;
        }
        
        @media (max-width: 768px) {
          .privacy-modal {
            max-height: 100vh;
            border-radius: 0;
          }
          
          .privacy-modal-header h2 {
            font-size: 20px;
          }
          
          .privacy-modal-content {
            padding: 16px;
          }
          
          .privacy-modal-footer {
            flex-direction: column;
          }
          
          .privacy-modal-footer button {
            width: 100%;
          }
        }
      </style>
    `;
  }

  renderCategory(key, title, description, enabled, readonly) {
    const disabled = readonly ? 'disabled' : '';
    const checked = enabled ? 'checked' : '';
    
    return `
      <div class="category-item ${readonly ? 'disabled' : ''}">
        <div class="category-header">
          <div class="category-title">
            ${title}
            ${readonly ? '<span class="badge-required">必需</span>' : ''}
          </div>
          <label class="toggle-switch">
            <input type="checkbox" 
                   data-category="${key}" 
                   ${checked} 
                   ${disabled}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <p class="category-description">${description}</p>
      </div>
    `;
  }

  bindEvents(modal) {
    const closeBtn = modal.querySelector('.close-btn');
    const cancelBtn = modal.querySelector('#btn-cancel');
    const saveBtn = modal.querySelector('#btn-save-preferences');
    
    closeBtn?.addEventListener('click', () => this.close());
    cancelBtn?.addEventListener('click', () => this.close());
    saveBtn?.addEventListener('click', () => this.savePreferences());
    
    // 阻止点击 overlay 关闭（可选）
    modal.querySelector('.privacy-modal-overlay')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('privacy-modal-overlay')) {
        this.close();
      }
    });
  }

  async savePreferences() {
    const modal = document.getElementById('privacy-preferences-modal');
    const checkboxes = modal.querySelectorAll('input[type="checkbox"][data-category]');
    
    const categories = {};
    checkboxes.forEach(checkbox => {
      const category = checkbox.dataset.category;
      categories[category] = checkbox.checked;
    });
    
    // 必要 Cookie 始终为 true
    categories.necessary = true;
    
    try {
      const response = await fetch('/api/v1/privacy/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ categories, source: 'preferences_center' })
      });
      
      const data = await response.json();
      
      if (data.success) {
        // 更新本地状态
        for (const [key, value] of Object.entries(categories)) {
          if (this.categories[key]) {
            this.categories[key].enabled = value;
          }
        }
        
        // 应用同意设置
        if (window.cookieBanner) {
          window.cookieBanner.applyConsent(categories);
        }
        
        this.onSave(categories);
        this.close();
        
        // 显示成功提示
        this.showToast('隐私偏好已保存', 'success');
      }
    } catch (error) {
      console.error('Failed to save preferences:', error);
      this.showToast('保存失败，请重试', 'error');
    }
  }

  close() {
    const modal = document.getElementById('privacy-preferences-modal');
    if (modal) {
      modal.remove();
    }
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%);
      padding: 12px 24px;
      background: ${type === 'success' ? '#4CAF50' : '#f44336'};
      color: white;
      border-radius: 8px;
      z-index: 10001;
      animation: fadeIn 0.2s;
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }
}

module.exports = PrivacyPreferencesCenter;
