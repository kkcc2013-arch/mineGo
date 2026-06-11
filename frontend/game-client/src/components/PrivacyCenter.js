/**
 * REQ-00053: 用户隐私偏好管理中心 - 前端组件
 * 隐私偏好管理界面
 */

class PrivacyCenter {
  constructor(apiClient) {
    this.api = apiClient;
    this.preferences = {};
    this.categories = [];
    this.currentPolicy = null;
    this.language = localStorage.getItem('language') || 'zh-CN';
    
    // 绑定方法
    this.init = this.init.bind(this);
    this.render = this.render.bind(this);
    this.handlePreferenceChange = this.handlePreferenceChange.bind(this);
  }

  /**
   * 初始化隐私中心
   */
  async init() {
    try {
      // 并行获取数据
      const [categoriesRes, preferencesRes, policyRes] = await Promise.all([
        this.api.get('/privacy/categories'),
        this.api.get('/privacy/preferences'),
        this.api.get('/privacy/policy')
      ]);
      
      this.categories = categoriesRes.data || [];
      this.preferences = preferencesRes.data?.preferences || {};
      this.currentPolicy = policyRes.data?.current || null;
      this.policyAccepted = preferencesRes.data?.policyAccepted ?? true;
      
      return true;
    } catch (error) {
      console.error('Failed to initialize privacy center:', error);
      return false;
    }
  }

  /**
   * 渲染隐私偏好管理界面
   */
  render() {
    const container = document.createElement('div');
    container.className = 'privacy-center';
    container.innerHTML = `
      <style>
        .privacy-center {
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        .privacy-header {
          text-align: center;
          margin-bottom: 30px;
        }
        
        .privacy-header h1 {
          font-size: 28px;
          color: #333;
          margin-bottom: 10px;
        }
        
        .privacy-header p {
          color: #666;
          font-size: 14px;
        }
        
        .privacy-section {
          background: #fff;
          border-radius: 12px;
          padding: 20px;
          margin-bottom: 20px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        
        .privacy-section h2 {
          font-size: 18px;
          color: #333;
          margin-bottom: 15px;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .category-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 15px 0;
          border-bottom: 1px solid #eee;
        }
        
        .category-item:last-child {
          border-bottom: none;
        }
        
        .category-info {
          flex: 1;
        }
        
        .category-name {
          font-weight: 600;
          color: #333;
          margin-bottom: 4px;
        }
        
        .category-desc {
          font-size: 13px;
          color: #666;
          margin-bottom: 4px;
        }
        
        .category-retention {
          font-size: 12px;
          color: #999;
        }
        
        .category-toggle {
          position: relative;
          width: 50px;
          height: 28px;
        }
        
        .category-toggle input {
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
          transition: .3s;
          border-radius: 28px;
        }
        
        .toggle-slider:before {
          position: absolute;
          content: "";
          height: 22px;
          width: 22px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          transition: .3s;
          border-radius: 50%;
        }
        
        .category-toggle input:checked + .toggle-slider {
          background-color: #4CAF50;
        }
        
        .category-toggle input:checked + .toggle-slider:before {
          transform: translateX(22px);
        }
        
        .category-toggle input:disabled + .toggle-slider {
          background-color: #e0e0e0;
          cursor: not-allowed;
        }
        
        .required-badge {
          background: #2196F3;
          color: white;
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 11px;
          margin-left: 8px;
        }
        
        .policy-link {
          color: #2196F3;
          text-decoration: none;
          font-size: 14px;
        }
        
        .policy-link:hover {
          text-decoration: underline;
        }
        
        .policy-version {
          font-size: 13px;
          color: #666;
          margin-top: 8px;
        }
        
        .btn {
          padding: 10px 20px;
          border-radius: 8px;
          border: none;
          cursor: pointer;
          font-size: 14px;
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
        }
        
        .btn-secondary:hover {
          background: #e0e0e0;
        }
        
        .action-buttons {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        
        .toast {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          padding: 12px 24px;
          border-radius: 8px;
          color: white;
          font-size: 14px;
          z-index: 1000;
          opacity: 0;
          transition: opacity 0.3s;
        }
        
        .toast.show {
          opacity: 1;
        }
        
        .toast.success {
          background: #4CAF50;
        }
        
        .toast.error {
          background: #f44336;
        }
        
        .policy-modal {
          display: none;
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.5);
          z-index: 1000;
          justify-content: center;
          align-items: center;
        }
        
        .policy-modal.show {
          display: flex;
        }
        
        .policy-modal-content {
          background: white;
          border-radius: 12px;
          padding: 30px;
          max-width: 700px;
          max-height: 80vh;
          overflow-y: auto;
        }
        
        .policy-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        
        .policy-modal-header h2 {
          margin: 0;
        }
        
        .policy-modal-close {
          background: none;
          border: none;
          font-size: 24px;
          cursor: pointer;
          color: #666;
        }
        
        .policy-content {
          white-space: pre-wrap;
          font-size: 14px;
          line-height: 1.6;
          color: #333;
        }
      </style>
      
      <div class="privacy-header">
        <h1>🔐 ${this.t('Privacy Center')}</h1>
        <p>${this.t('Manage your data collection preferences and view transparency reports')}</p>
      </div>
      
      <!-- 数据收集状态 -->
      <div class="privacy-section">
        <h2>📊 ${this.t('Data Collection Status')}</h2>
        <div id="categories-list">
          ${this.renderCategories()}
        </div>
      </div>
      
      <!-- 隐私政策 -->
      <div class="privacy-section">
        <h2>📄 ${this.t('Privacy Policy')}</h2>
        <div class="policy-version">
          ${this.t('Current Version')}: ${this.currentPolicy?.version || 'v1.0'} 
          (${this.currentPolicy?.effectiveDate || '2026-01-01'})
        </div>
        <div style="margin-top: 12px;">
          <a href="#" class="policy-link" id="view-policy-link">
            ${this.t('View Policy')}
          </a>
          <span style="margin: 0 10px;">|</span>
          <a href="#" class="policy-link" id="view-history-link">
            ${this.t('View History')}
          </a>
        </div>
      </div>
      
      <!-- 数据使用报告 -->
      <div class="privacy-section">
        <h2>📈 ${this.t('Data Usage Report')}</h2>
        <div class="action-buttons">
          <button class="btn btn-secondary" id="view-report-btn">
            ${this.t('View This Month Report')}
          </button>
          <button class="btn btn-secondary" id="view-report-history-btn">
            ${this.t('View History Reports')}
          </button>
        </div>
      </div>
      
      <!-- 数据管理 -->
      <div class="privacy-section">
        <h2>🔧 ${this.t('Data Management')}</h2>
        <div class="action-buttons">
          <button class="btn btn-primary" id="export-data-btn">
            ${this.t('Export My Data')}
          </button>
          <button class="btn btn-secondary" id="request-deletion-btn">
            ${this.t('Request Deletion')}
          </button>
        </div>
      </div>
      
      <!-- 隐私政策弹窗 -->
      <div class="policy-modal" id="policy-modal">
        <div class="policy-modal-content">
          <div class="policy-modal-header">
            <h2>${this.t('Privacy Policy')}</h2>
            <button class="policy-modal-close" id="close-modal-btn">&times;</button>
          </div>
          <div class="policy-content" id="policy-content">
            ${this.currentPolicy?.content || ''}
          </div>
        </div>
      </div>
    `;
    
    this.attachEventListeners(container);
    return container;
  }

  /**
   * 渲染数据类别列表
   */
  renderCategories() {
    return this.categories.map(cat => {
      const pref = this.preferences[cat.id] || { collectable: true };
      const isDisabled = cat.required;
      const checked = pref.collectable ? 'checked' : '';
      const disabled = isDisabled ? 'disabled' : '';
      
      return `
        <div class="category-item" data-category="${cat.id}">
          <div class="category-info">
            <div class="category-name">
              ${cat.name}
              ${cat.required ? `<span class="required-badge">${this.t('Required')}</span>` : ''}
            </div>
            <div class="category-desc">${cat.description}</div>
            <div class="category-retention">${this.t('Retention')}: ${cat.retentionDisplay}</div>
          </div>
          <label class="category-toggle">
            <input type="checkbox" 
              data-category="${cat.id}" 
              ${checked} 
              ${disabled}
              class="category-checkbox">
            <span class="toggle-slider"></span>
          </label>
        </div>
      `;
    }).join('');
  }

  /**
   * 绑定事件监听器
   */
  attachEventListeners(container) {
    // 类别开关变化
    container.querySelectorAll('.category-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', async (e) => {
        const category = e.target.dataset.category;
        const collectable = e.target.checked;
        await this.handlePreferenceChange(category, collectable);
      });
    });
    
    // 查看隐私政策
    container.querySelector('#view-policy-link').addEventListener('click', async (e) => {
      e.preventDefault();
      this.showPolicyModal();
    });
    
    // 关闭弹窗
    container.querySelector('#close-modal-btn').addEventListener('click', () => {
      container.querySelector('#policy-modal').classList.remove('show');
    });
    
    // 查看报告
    container.querySelector('#view-report-btn').addEventListener('click', async () => {
      await this.showReport();
    });
    
    // 导出数据
    container.querySelector('#export-data-btn').addEventListener('click', async () => {
      await this.exportData();
    });
    
    // 请求删除
    container.querySelector('#request-deletion-btn').addEventListener('click', async () => {
      await this.requestDeletion();
    });
  }

  /**
   * 处理偏好变化
   */
  async handlePreferenceChange(category, collectable) {
    try {
      const result = await this.api.patch('/privacy/preferences', {
        [category]: collectable
      });
      
      if (result.success) {
        this.showToast(this.t('Preference updated successfully'), 'success');
        
        // 更新本地状态
        this.preferences[category] = {
          ...this.preferences[category],
          collectable,
          updatedAt: new Date().toISOString()
        };
      } else if (result.errors) {
        // 恢复开关状态
        const checkbox = document.querySelector(`[data-category="${category}"]`);
        if (checkbox) {
          checkbox.checked = !collectable;
        }
        this.showToast(result.errors[0].error, 'error');
      }
    } catch (error) {
      console.error('Failed to update preference:', error);
      this.showToast(this.t('Failed to update preference'), 'error');
      
      // 恢复开关状态
      const checkbox = document.querySelector(`[data-category="${category}"]`);
      if (checkbox) {
        checkbox.checked = !collectable;
      }
    }
  }

  /**
   * 显示隐私政策弹窗
   */
  async showPolicyModal() {
    const modal = document.querySelector('#policy-modal');
    const content = document.querySelector('#policy-content');
    
    if (this.currentPolicy?.content) {
      content.textContent = this.currentPolicy.content;
    } else {
      try {
        const result = await this.api.get('/privacy/policy');
        content.textContent = result.data?.current?.content || '';
      } catch (error) {
        content.textContent = this.t('Failed to load privacy policy');
      }
    }
    
    modal.classList.add('show');
  }

  /**
   * 显示数据使用报告
   */
  async showReport() {
    try {
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const month = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}`;
      
      const result = await this.api.get(`/privacy/report?month=${month}`);
      
      if (result.success && result.data) {
        const report = result.data;
        this.showReportModal(report);
      }
    } catch (error) {
      console.error('Failed to load report:', error);
      this.showToast(this.t('Failed to load report'), 'error');
    }
  }

  /**
   * 显示报告弹窗
   */
  showReportModal(report) {
    const modal = document.createElement('div');
    modal.className = 'policy-modal show';
    modal.innerHTML = `
      <div class="policy-modal-content" style="max-width: 600px;">
        <div class="policy-modal-header">
          <h2>${this.t('Data Usage Report')} - ${report.month}</h2>
          <button class="policy-modal-close">&times;</button>
        </div>
        <div style="line-height: 1.8;">
          <p><strong>${this.t('Total Data Points')}:</strong> ${report.summary?.totalDataPoints || 0}</p>
          <p><strong>${this.t('Access Count')}:</strong> ${report.summary?.accessCount || 0}</p>
          <p><strong>${this.t('Third Party Shares')}:</strong> ${report.summary?.shareCount || 0}</p>
          
          <h3 style="margin-top: 20px;">${this.t('Data by Category')}</h3>
          <ul>
            ${Object.entries(report.summary?.dataByCategory || {}).map(([cat, count]) => 
              `<li>${cat}: ${count}</li>`
            ).join('')}
          </ul>
          
          <h3 style="margin-top: 20px;">${this.t('Retention Status')}</h3>
          <ul>
            ${Object.entries(report.retentionStatus || {}).map(([cat, status]) => 
              `<li>${cat}: ${status}</li>`
            ).join('')}
          </ul>
        </div>
      </div>
    `;
    
    modal.querySelector('.policy-modal-close').addEventListener('click', () => {
      modal.remove();
    });
    
    document.body.appendChild(modal);
  }

  /**
   * 导出数据
   */
  async exportData() {
    try {
      this.showToast(this.t('Preparing data export...'), 'success');
      
      const result = await this.api.get('/gdpr/export');
      
      if (result.data) {
        // 创建下载
        const blob = new Blob([JSON.stringify(result.data, null, 2)], { 
          type: 'application/json' 
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `minego-data-export-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        this.showToast(this.t('Data exported successfully'), 'success');
      }
    } catch (error) {
      console.error('Failed to export data:', error);
      this.showToast(this.t('Failed to export data'), 'error');
    }
  }

  /**
   * 请求删除数据
   */
  async requestDeletion() {
    const confirmed = confirm(
      this.t('Are you sure you want to request data deletion? This action cannot be undone.')
    );
    
    if (!confirmed) return;
    
    try {
      const result = await this.api.post('/gdpr/delete');
      
      if (result.success) {
        this.showToast(this.t('Deletion request submitted'), 'success');
      }
    } catch (error) {
      console.error('Failed to request deletion:', error);
      this.showToast(this.t('Failed to request deletion'), 'error');
    }
  }

  /**
   * 显示提示
   */
  showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  /**
   * 翻译
   */
  t(key) {
    const translations = {
      'zh-CN': {
        'Privacy Center': '隐私管理中心',
        'Manage your data collection preferences and view transparency reports': '管理您的数据收集偏好并查看透明度报告',
        'Data Collection Status': '数据收集状态',
        'Privacy Policy': '隐私政策',
        'Current Version': '当前版本',
        'View Policy': '查看政策',
        'View History': '查看历史',
        'Data Usage Report': '数据使用报告',
        'View This Month Report': '查看本月报告',
        'View History Reports': '查看历史报告',
        'Data Management': '数据管理',
        'Export My Data': '导出我的数据',
        'Request Deletion': '请求删除',
        'Required': '必需',
        'Retention': '保留期限',
        'Preference updated successfully': '偏好更新成功',
        'Failed to update preference': '偏好更新失败',
        'Failed to load privacy policy': '加载隐私政策失败',
        'Failed to load report': '加载报告失败',
        'Total Data Points': '总数据点',
        'Access Count': '访问次数',
        'Third Party Shares': '第三方共享次数',
        'Data by Category': '按类别统计',
        'Retention Status': '保留状态',
        'Preparing data export...': '正在准备数据导出...',
        'Data exported successfully': '数据导出成功',
        'Failed to export data': '数据导出失败',
        'Are you sure you want to request data deletion? This action cannot be undone.': '确定要请求数据删除吗？此操作无法撤销。',
        'Deletion request submitted': '删除请求已提交',
        'Failed to request deletion': '删除请求失败'
      },
      'en-US': {
        'Privacy Center': 'Privacy Center',
        'Manage your data collection preferences and view transparency reports': 'Manage your data collection preferences and view transparency reports',
        'Data Collection Status': 'Data Collection Status',
        'Privacy Policy': 'Privacy Policy',
        'Current Version': 'Current Version',
        'View Policy': 'View Policy',
        'View History': 'View History',
        'Data Usage Report': 'Data Usage Report',
        'View This Month Report': 'View This Month Report',
        'View History Reports': 'View History Reports',
        'Data Management': 'Data Management',
        'Export My Data': 'Export My Data',
        'Request Deletion': 'Request Deletion',
        'Required': 'Required',
        'Retention': 'Retention',
        'Preference updated successfully': 'Preference updated successfully',
        'Failed to update preference': 'Failed to update preference',
        'Failed to load privacy policy': 'Failed to load privacy policy',
        'Failed to load report': 'Failed to load report',
        'Total Data Points': 'Total Data Points',
        'Access Count': 'Access Count',
        'Third Party Shares': 'Third Party Shares',
        'Data by Category': 'Data by Category',
        'Retention Status': 'Retention Status',
        'Preparing data export...': 'Preparing data export...',
        'Data exported successfully': 'Data exported successfully',
        'Failed to export data': 'Failed to export data',
        'Are you sure you want to request data deletion? This action cannot be undone.': 'Are you sure you want to request data deletion? This action cannot be undone.',
        'Deletion request submitted': 'Deletion request submitted',
        'Failed to request deletion': 'Failed to request deletion'
      }
    };
    
    return translations[this.language]?.[key] || key;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PrivacyCenter;
} else {
  window.PrivacyCenter = PrivacyCenter;
}
