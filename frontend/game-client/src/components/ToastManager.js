/**
 * ToastManager - 智能化 Toast 通知系统
 * 支持多优先级队列、可撤销操作、消息历史、用户行为分析
 */

import './ToastManager.css';

class ToastManager extends EventTarget {
  constructor(options = {}) {
    super();
    
    // 配置
    this.config = {
      maxConcurrent: 3,              // 同时展示数量
      defaultDuration: 5000,         // 默认展示时长（ms）
      criticalDuration: 0,           // Critical 永不自动消失
      position: 'top-right',         // 默认位置
      animationDuration: 300,        // 动画时长
      persistCount: 100,             // 历史记录数量
      enableAnalytics: true,         // 启用用户行为分析
      ...options
    };
    
    // 多优先级队列
    this.queues = {
      critical: [],  // 最高优先级，持久展示
      error: [],     // 错误消息
      warning: [],   // 警告消息
      success: [],   // 成功消息
      info: []       // 信息消息
    };
    
    // 当前展示的 Toast
    this.activeToasts = new Map();  // id -> { toast, element }
    
    // 历史记录
    this.history = [];
    
    // 用户行为统计
    this.analytics = {
      shown: 0,
      clicked: 0,
      dismissed: 0,
      undone: 0
    };
    
    // 容器元素
    this.container = null;
    
    // 初始化标志
    this.initialized = false;
  }
  
  /**
   * 初始化 Toast 管理器
   */
  init() {
    if (this.initialized) return;
    
    // 创建容器
    this.createContainer();
    
    // 加载历史记录
    this.loadHistory();
    
    // 设置错误处理器
    this.setupErrorHandler();
    
    // 设置快捷键
    this.setupKeyboardShortcuts();
    
    this.initialized = true;
    console.log('[ToastManager] Initialized');
  }
  
  /**
   * 创建 Toast 容器
   */
  createContainer() {
    this.container = document.createElement('div');
    this.container.id = 'toast-container';
    this.container.className = `toast-container toast-${this.config.position}`;
    this.container.setAttribute('role', 'region');
    this.container.setAttribute('aria-label', '通知消息');
    document.body.appendChild(this.container);
  }
  
  /**
   * 显示 Toast
   */
  show(options) {
    if (!this.initialized) this.init();
    
    const toast = {
      id: `toast-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: options.type || 'info',
      title: options.title || null,
      message: options.message,
      icon: options.icon || this.getDefaultIcon(options.type),
      duration: options.duration ?? this.config.defaultDuration,
      persistent: options.persistent ?? (options.type === 'critical'),
      actions: options.actions || [],
      undo: options.undo || null,
      data: options.data || {},
      createdAt: Date.now(),
      shownAt: null,
      clickedAt: null,
      dismissedAt: null
    };
    
    // 添加到队列
    this.addToQueue(toast);
    
    // 尝试展示
    this.processQueue();
    
    // 记录历史
    this.addToHistory(toast);
    
    // 发送事件
    this.dispatchEvent(new CustomEvent('toast:added', { detail: toast }));
    
    return toast.id;
  }
  
  /**
   * 快捷方法：成功消息
   */
  success(message, options = {}) {
    return this.show({ type: 'success', message, ...options });
  }
  
  /**
   * 快捷方法：错误消息
   */
  error(message, options = {}) {
    return this.show({ type: 'error', message, ...options });
  }
  
  /**
   * 快捷方法：警告消息
   */
  warning(message, options = {}) {
    return this.show({ type: 'warning', message, ...options });
  }
  
  /**
   * 快捷方法：信息消息
   */
  info(message, options = {}) {
    return this.show({ type: 'info', message, ...options });
  }
  
  /**
   * 快捷方法：严重错误（持久展示）
   */
  critical(title, message, options = {}) {
    return this.show({
      type: 'critical',
      title,
      message,
      persistent: true,
      ...options
    });
  }
  
  /**
   * 可撤销操作
   */
  showWithUndo(message, undoCallback, options = {}) {
    return this.show({
      type: options.type || 'info',
      message,
      undo: {
        callback: undoCallback,
        timeout: options.undoTimeout || 10000
      },
      ...options
    });
  }
  
  /**
   * 错误处理集成
   */
  showErrorWithRetry(error, retryCallback, options = {}) {
    const errorInfo = this.parseError(error);
    
    return this.show({
      type: 'error',
      title: errorInfo.message || '操作失败',
      message: errorInfo.retryable ? '点击重试按钮重新操作' : '',
      actions: errorInfo.retryable ? [
        { label: '重试', onClick: retryCallback, primary: true },
        { label: '忽略', onClick: () => {} }
      ] : [],
      duration: errorInfo.retryable ? 15000 : 5000,
      data: { error: errorInfo },
      ...options
    });
  }
  
  /**
   * 解析错误信息
   */
  parseError(error) {
    if (typeof error === 'string') {
      return { message: error, retryable: false };
    }
    
    if (error.response) {
      // API 错误
      const status = error.response.status;
      return {
        message: error.response.data?.message || this.getErrorMessage(status),
        retryable: status >= 500 || status === 429,
        status
      };
    }
    
    if (error.name === 'NetworkError' || error.name === 'TypeError') {
      return {
        message: '网络连接失败，请检查网络设置',
        retryable: true
      };
    }
    
    return {
      message: error.message || '未知错误',
      retryable: false
    };
  }
  
  /**
   * 获取错误消息
   */
  getErrorMessage(status) {
    const messages = {
      400: '请求参数错误',
      401: '未授权，请重新登录',
      403: '没有权限执行此操作',
      404: '请求的资源不存在',
      409: '操作冲突，请刷新后重试',
      429: '请求过于频繁，请稍后重试',
      500: '服务器错误，请稍后重试',
      502: '网关错误',
      503: '服务暂时不可用',
      504: '网关超时'
    };
    return messages[status] || `请求失败 (${status})`;
  }
  
  /**
   * 添加到队列
   */
  addToQueue(toast) {
    const priority = toast.type;
    if (this.queues[priority]) {
      this.queues[priority].push(toast);
    } else {
      this.queues.info.push(toast);
    }
  }
  
  /**
   * 处理队列
   */
  processQueue() {
    // 检查当前展示数量
    if (this.activeToasts.size >= this.config.maxConcurrent) {
      return;
    }
    
    // 按优先级遍历队列
    const priorityOrder = ['critical', 'error', 'warning', 'success', 'info'];
    
    for (const priority of priorityOrder) {
      const queue = this.queues[priority];
      
      if (queue.length > 0) {
        const toast = queue.shift();
        this.displayToast(toast);
        break;
      }
    }
  }
  
  /**
   * 展示 Toast
   */
  displayToast(toast) {
    // 创建 DOM 元素
    const element = this.createToastElement(toast);
    
    // 添加到容器
    this.container.appendChild(element);
    
    // 记录展示
    toast.shownAt = Date.now();
    this.activeToasts.set(toast.id, { toast, element });
    
    // 统计
    this.analytics.shown++;
    this.reportAnalytics('shown', toast);
    
    // 自动消失
    if (!toast.persistent && toast.duration > 0) {
      setTimeout(() => this.dismiss(toast.id), toast.duration);
    }
    
    // 撤销倒计时
    if (toast.undo) {
      this.startUndoCountdown(toast, element);
    }
    
    // 尝试展示下一个
    setTimeout(() => this.processQueue(), 100);
  }
  
  /**
   * 创建 Toast DOM 元素
   */
  createToastElement(toast) {
    const element = document.createElement('div');
    element.className = `toast toast-${toast.type}`;
    element.setAttribute('data-toast-id', toast.id);
    element.setAttribute('role', 'alert');
    element.setAttribute('aria-live', toast.type === 'critical' ? 'assertive' : 'polite');
    
    // 图标
    const iconEl = document.createElement('div');
    iconEl.className = 'toast-icon';
    iconEl.textContent = toast.icon;
    element.appendChild(iconEl);
    
    // 内容
    const contentEl = document.createElement('div');
    contentEl.className = 'toast-content';
    
    if (toast.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'toast-title';
      titleEl.textContent = toast.title;
      contentEl.appendChild(titleEl);
    }
    
    if (toast.message) {
      const messageEl = document.createElement('div');
      messageEl.className = 'toast-message';
      messageEl.textContent = toast.message;
      contentEl.appendChild(messageEl);
    }
    
    // 操作按钮
    if (toast.actions.length > 0 || toast.undo) {
      const actionsEl = document.createElement('div');
      actionsEl.className = 'toast-actions';
      
      // 撤销按钮
      if (toast.undo) {
        const undoBtn = document.createElement('button');
        undoBtn.className = 'toast-btn undo-btn';
        undoBtn.innerHTML = `撤销 <span class="undo-countdown">${Math.ceil(toast.undo.timeout / 1000)}s</span>`;
        undoBtn.addEventListener('click', () => this.handleUndo(toast.id));
        actionsEl.appendChild(undoBtn);
      }
      
      // 自定义操作按钮
      toast.actions.forEach((action, index) => {
        const btn = document.createElement('button');
        btn.className = `toast-btn ${action.primary ? 'toast-btn-primary' : ''}`;
        btn.textContent = action.label;
        btn.addEventListener('click', () => this.handleActionClick(toast.id, index));
        actionsEl.appendChild(btn);
      });
      
      contentEl.appendChild(actionsEl);
    }
    
    element.appendChild(contentEl);
    
    // 关闭按钮
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.dismiss(toast.id));
    element.appendChild(closeBtn);
    
    return element;
  }
  
  /**
   * 获取默认图标
   */
  getDefaultIcon(type) {
    const icons = {
      critical: '⚠',
      error: '✗',
      warning: '⚠',
      success: '✓',
      info: 'ℹ'
    };
    return icons[type] || 'ℹ';
  }
  
  /**
   * 撤销倒计时
   */
  startUndoCountdown(toast, element) {
    const timeout = toast.undo.timeout;
    const startTime = Date.now();
    
    const updateCountdown = () => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, timeout - elapsed);
      const seconds = Math.ceil(remaining / 1000);
      
      const countdownEl = element.querySelector('.undo-countdown');
      if (countdownEl) {
        countdownEl.textContent = `${seconds}s`;
      }
      
      if (remaining > 0 && this.activeToasts.has(toast.id)) {
        requestAnimationFrame(updateCountdown);
      } else if (remaining <= 0) {
        // 超时后移除撤销按钮
        const undoBtn = element.querySelector('.undo-btn');
        if (undoBtn) {
          undoBtn.remove();
        }
      }
    };
    
    updateCountdown();
  }
  
  /**
   * 执行撤销
   */
  handleUndo(toastId) {
    const entry = this.activeToasts.get(toastId);
    if (!entry || !entry.toast.undo) return;
    
    try {
      entry.toast.undo.callback();
      
      // 统计
      this.analytics.undone++;
      this.reportAnalytics('undone', entry.toast);
      
      // 显示撤销成功
      this.success('操作已撤销', { duration: 2000 });
    } catch (error) {
      console.error('[ToastManager] Undo failed:', error);
      this.error('撤销失败', { duration: 3000 });
    }
    
    // 移除 Toast
    this.dismiss(toastId);
  }
  
  /**
   * 用户点击操作按钮
   */
  handleActionClick(toastId, actionIndex) {
    const entry = this.activeToasts.get(toastId);
    if (!entry) return;
    
    const action = entry.toast.actions[actionIndex];
    if (action && action.onClick) {
      action.onClick();
      
      // 统计
      this.analytics.clicked++;
      entry.toast.clickedAt = Date.now();
      this.reportAnalytics('clicked', entry.toast, { actionIndex });
      
      // 移除 Toast（除非配置为保留）
      if (!action.keepToast) {
        this.dismiss(toastId);
      }
    }
  }
  
  /**
   * 关闭 Toast
   */
  dismiss(toastId) {
    const entry = this.activeToasts.get(toastId);
    if (!entry) return;
    
    const { toast, element } = entry;
    
    // 统计
    if (!toast.clickedAt) {
      this.analytics.dismissed++;
      this.reportAnalytics('dismissed', toast);
    }
    
    // 动画移除
    element.classList.add('toast-exit');
    
    setTimeout(() => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
      this.activeToasts.delete(toastId);
      
      // 尝试展示下一个
      this.processQueue();
    }, this.config.animationDuration);
  }
  
  /**
   * 添加到历史
   */
  addToHistory(toast) {
    this.history.unshift({
      id: toast.id,
      type: toast.type,
      title: toast.title,
      message: toast.message,
      createdAt: toast.createdAt,
      shownAt: toast.shownAt,
      actions: toast.actions.length,
      hadUndo: !!toast.undo
    });
    
    // 限制数量
    if (this.history.length > this.config.persistCount) {
      this.history = this.history.slice(0, this.config.persistCount);
    }
    
    // 持久化到 localStorage
    this.saveHistory();
  }
  
  /**
   * 保存历史到 localStorage
   */
  saveHistory() {
    try {
      localStorage.setItem('pmg_toast_history', JSON.stringify(this.history));
    } catch (e) {
      console.warn('[ToastManager] Failed to save history:', e);
    }
  }
  
  /**
   * 加载历史记录
   */
  loadHistory() {
    try {
      const saved = localStorage.getItem('pmg_toast_history');
      if (saved) {
        this.history = JSON.parse(saved);
      }
    } catch (e) {
      console.warn('[ToastManager] Failed to load history:', e);
      this.history = [];
    }
  }
  
  /**
   * 获取历史记录
   */
  getHistory(filters = {}) {
    let result = [...this.history];
    
    // 按类型筛选
    if (filters.type) {
      result = result.filter(t => t.type === filters.type);
    }
    
    // 按时间筛选
    if (filters.since) {
      result = result.filter(t => t.createdAt >= filters.since);
    }
    
    // 搜索
    if (filters.search) {
      const query = filters.search.toLowerCase();
      result = result.filter(t => 
        t.title?.toLowerCase().includes(query) ||
        t.message?.toLowerCase().includes(query)
      );
    }
    
    return result;
  }
  
  /**
   * 清空历史
   */
  clearHistory() {
    this.history = [];
    localStorage.removeItem('pmg_toast_history');
    this.dispatchEvent(new CustomEvent('history:cleared'));
  }
  
  /**
   * 获取统计数据
   */
  getAnalytics() {
    return { ...this.analytics };
  }
  
  /**
   * 上报分析数据
   */
  reportAnalytics(event, toast, extra = {}) {
    const data = {
      event,
      toastId: toast?.id,
      type: toast?.type,
      duration: toast?.shownAt ? Date.now() - toast.shownAt : 0,
      hadActions: toast?.actions?.length > 0,
      hadUndo: !!toast?.undo,
      ...extra,
      timestamp: Date.now()
    };
    
    // 发送到后端（可选，批量上报）
    if (this.config.enableAnalytics && navigator.sendBeacon) {
      try {
        navigator.sendBeacon('/api/v1/analytics/toast', JSON.stringify(data));
      } catch (e) {
        // 忽略发送错误
      }
    }
    
    // 本地事件
    this.dispatchEvent(new CustomEvent('analytics', { detail: data }));
  }
  
  /**
   * 设置错误处理器
   */
  setupErrorHandler() {
    // 全局错误捕获
    window.addEventListener('error', (event) => {
      const error = event.error || event.message;
      
      // 忽略脚本加载错误
      if (event.target !== window) return;
      
      this.showErrorWithRetry(error, () => {
        window.location.reload();
      }, {
        title: '系统错误',
        persistent: true
      });
    });
    
    // Promise 未捕获错误
    window.addEventListener('unhandledrejection', (event) => {
      const error = event.reason;
      
      this.showErrorWithRetry(error, () => {
        // 重试逻辑由调用方决定
      }, {
        title: '异步操作失败'
      });
    });
  }
  
  /**
   * 设置键盘快捷键
   */
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Escape 关闭最上层的 Toast
      if (e.key === 'Escape' && this.activeToasts.size > 0) {
        const lastToastId = Array.from(this.activeToasts.keys()).pop();
        this.dismiss(lastToastId);
      }
      
      // Ctrl+H 打开历史记录
      if (e.ctrlKey && e.key === 'h') {
        e.preventDefault();
        this.toggleHistoryPanel();
      }
    });
  }
  
  /**
   * 显示历史记录面板
   */
  toggleHistoryPanel() {
    let panel = document.getElementById('toast-history-panel');
    
    if (panel) {
      panel.hidden = !panel.hidden;
      return;
    }
    
    // 创建历史记录面板
    panel = this.createHistoryPanel();
    document.body.appendChild(panel);
  }
  
  /**
   * 创建历史记录面板
   */
  createHistoryPanel() {
    const panel = document.createElement('div');
    panel.id = 'toast-history-panel';
    panel.className = 'toast-history-panel';
    
    panel.innerHTML = `
      <div class="history-header">
        <h3>通知历史</h3>
        <button class="history-clear-btn">清空</button>
      </div>
      <div class="history-filters">
        <select class="history-filter-type">
          <option value="">全部类型</option>
          <option value="critical">严重</option>
          <option value="error">错误</option>
          <option value="warning">警告</option>
          <option value="success">成功</option>
          <option value="info">信息</option>
        </select>
        <input type="search" class="history-search" placeholder="搜索通知...">
      </div>
      <div class="history-list"></div>
    `;
    
    // 渲染历史列表
    this.renderHistoryList(panel.querySelector('.history-list'));
    
    // 清空按钮
    panel.querySelector('.history-clear-btn').addEventListener('click', () => {
      this.clearHistory();
      this.renderHistoryList(panel.querySelector('.history-list'));
    });
    
    // 类型筛选
    panel.querySelector('.history-filter-type').addEventListener('change', (e) => {
      this.renderHistoryList(panel.querySelector('.history-list'), { type: e.target.value });
    });
    
    // 搜索
    panel.querySelector('.history-search').addEventListener('input', (e) => {
      this.renderHistoryList(panel.querySelector('.history-list'), { search: e.target.value });
    });
    
    return panel;
  }
  
  /**
   * 渲染历史列表
   */
  renderHistoryList(container, filters = {}) {
    const history = this.getHistory(filters);
    
    if (history.length === 0) {
      container.innerHTML = '<div class="history-empty">暂无通知记录</div>';
      return;
    }
    
    container.innerHTML = history.map(item => `
      <div class="history-item history-item-${item.type}">
        <div class="history-item-time">${this.formatTime(item.createdAt)}</div>
        <div class="history-item-title">${item.title || ''}</div>
        <div class="history-item-message">${item.message || ''}</div>
      </div>
    `).join('');
  }
  
  /**
   * 格式化时间
   */
  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  
  /**
   * 更新位置
   */
  setPosition(position) {
    this.config.position = position;
    if (this.container) {
      this.container.className = `toast-container toast-${position}`;
    }
  }
  
  /**
   * 销毁
   */
  destroy() {
    // 移除所有 Toast
    this.activeToasts.forEach((entry, id) => {
      this.dismiss(id);
    });
    
    // 移除容器
    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    
    // 移除历史面板
    const panel = document.getElementById('toast-history-panel');
    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel);
    }
    
    this.initialized = false;
    console.log('[ToastManager] Destroyed');
  }
}

// 创建全局实例
const toastManager = new ToastManager();

// 自动初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => toastManager.init());
} else {
  toastManager.init();
}

// 导出到全局
window.toastManager = toastManager;
window.toast = {
  success: (msg, opts) => toastManager.success(msg, opts),
  error: (msg, opts) => toastManager.error(msg, opts),
  warning: (msg, opts) => toastManager.warning(msg, opts),
  info: (msg, opts) => toastManager.info(msg, opts),
  show: (opts) => toastManager.show(opts)
};

export { ToastManager, toastManager };
export default toastManager;
