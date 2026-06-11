// frontend/game-client/src/components/MessageCenter.js
// REQ-00099: 游戏消息中心与通知管理系统 - 前端组件
'use strict';

/**
 * 消息中心组件
 * 提供通知列表、已读/未读管理、通知偏好设置等功能
 */
class MessageCenter {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.apiClient = options.apiClient;
    this.onNavigate = options.onNavigate || (() => {});
    
    // 状态
    this.notifications = [];
    this.unreadCount = 0;
    this.currentTab = 'all';
    this.currentPage = 1;
    this.totalPages = 1;
    this.isLoading = false;
    this.isOpen = false;
    
    // 配置
    this.tabs = [
      { key: 'all', label: '全部', icon: '📬' },
      { key: 'RARE_SPAWN', label: '精灵', icon: '🐉' },
      { key: 'RAID_STARTED', label: 'Raid', icon: '⚔️' },
      { key: 'FRIEND_REQUEST', label: '好友', icon: '👥' },
      { key: 'QUEST_COMPLETE', label: '奖励', icon: '✅' },
      { key: 'SYSTEM', label: '系统', icon: '📢' },
    ];
    
    // DOM 元素
    this.element = null;
    this.listElement = null;
    this.badgeElement = null;
    
    // IndexedDB 缓存
    this.db = null;
    this.dbName = 'PMG_Messages';
    this.dbVersion = 1;
    
    // 初始化
    this.init();
  }
  
  /**
   * 初始化
   */
  async init() {
    // 初始化 IndexedDB
    await this.initIndexedDB();
    
    // 创建 DOM 元素
    this.createElement();
    
    // 加载未读数量
    await this.loadUnreadCount();
    
    // 监听 WebSocket 通知
    this.setupWebSocketListener();
    
    console.log('[MessageCenter] Initialized');
  }
  
  /**
   * 初始化 IndexedDB
   */
  async initIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onerror = () => {
        console.error('[MessageCenter] IndexedDB error:', request.error);
        resolve(); // 降级处理，不阻塞初始化
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // 通知存储
        if (!db.objectStoreNames.contains('notifications')) {
          const store = db.createObjectStore('notifications', { keyPath: 'id' });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('isRead', 'isRead', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
        
        // 元数据存储
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'key' });
        }
      };
    });
  }
  
  /**
   * 创建 DOM 元素
   */
  createElement() {
    // 消息中心容器
    this.element = document.createElement('div');
    this.element.className = 'message-center';
    this.element.innerHTML = `
      <div class="message-center-overlay"></div>
      <div class="message-center-panel">
        <div class="message-center-header">
          <h2>消息中心</h2>
          <div class="message-center-actions">
            <button class="btn-mark-all-read" style="display: none;">全部已读</button>
            <button class="btn-settings">⚙️</button>
            <button class="btn-close">✕</button>
          </div>
        </div>
        
        <div class="message-center-tabs">
          ${this.tabs.map(tab => `
            <button class="tab-btn ${tab.key === 'all' ? 'active' : ''}" data-tab="${tab.key}">
              ${tab.icon} ${tab.label}
            </button>
          `).join('')}
        </div>
        
        <div class="message-center-content">
          <div class="message-list"></div>
          <div class="message-empty" style="display: none;">
            <div class="empty-icon">📭</div>
            <div class="empty-text">暂无消息</div>
          </div>
          <div class="message-loading" style="display: none;">
            <div class="loading-spinner"></div>
          </div>
        </div>
        
        <div class="message-center-footer">
          <button class="btn-clear-read">清空已读消息</button>
        </div>
      </div>
      
      <div class="message-settings-panel" style="display: none;">
        <div class="settings-header">
          <button class="btn-back">← 返回</button>
          <h3>通知设置</h3>
        </div>
        <div class="settings-content">
          <div class="settings-section">
            <h4>通知类型</h4>
            <div class="settings-options">
              <label><input type="checkbox" name="rare_spawn" checked> 稀有精灵刷新</label>
              <label><input type="checkbox" name="raid_started" checked> Raid 战斗提醒</label>
              <label><input type="checkbox" name="friend_request" checked> 好友请求</label>
              <label><input type="checkbox" name="gift_received" checked> 礼物接收</label>
              <label><input type="checkbox" name="quest_complete" checked> 任务完成</label>
              <label><input type="checkbox" name="system" checked> 系统公告</label>
            </div>
          </div>
          
          <div class="settings-section">
            <h4>免打扰时段</h4>
            <label class="quiet-hours-toggle">
              <input type="checkbox" name="quiet_hours_enabled"> 启用免打扰
            </label>
            <div class="quiet-hours-times" style="display: none;">
              <input type="time" name="quiet_start" value="22:00">
              <span>至</span>
              <input type="time" name="quiet_end" value="08:00">
            </div>
          </div>
          
          <button class="btn-save-settings">保存设置</button>
        </div>
      </div>
    `;
    
    // 缓存元素引用
    this.listElement = this.element.querySelector('.message-list');
    this.emptyElement = this.element.querySelector('.message-empty');
    this.loadingElement = this.element.querySelector('.message-loading');
    this.markAllReadBtn = this.element.querySelector('.btn-mark-all-read');
    this.settingsPanel = this.element.querySelector('.message-settings-panel');
    this.mainPanel = this.element.querySelector('.message-center-panel');
    
    // 绑定事件
    this.bindEvents();
    
    // 添加到容器
    this.container.appendChild(this.element);
  }
  
  /**
   * 绑定事件
   */
  bindEvents() {
    // 关闭按钮
    this.element.querySelector('.btn-close').addEventListener('click', () => {
      this.close();
    });
    
    // 点击遮罩关闭
    this.element.querySelector('.message-center-overlay').addEventListener('click', () => {
      this.close();
    });
    
    // 标签页切换
    this.element.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = e.target.dataset.tab;
        this.switchTab(tab);
      });
    });
    
    // 全部已读
    this.markAllReadBtn.addEventListener('click', () => {
      this.markAllRead();
    });
    
    // 清空已读消息
    this.element.querySelector('.btn-clear-read').addEventListener('click', () => {
      this.clearReadNotifications();
    });
    
    // 设置按钮
    this.element.querySelector('.btn-settings').addEventListener('click', () => {
      this.showSettings();
    });
    
    // 设置面板返回
    this.element.querySelector('.btn-back').addEventListener('click', () => {
      this.hideSettings();
    });
    
    // 免打扰时段切换
    const quietToggle = this.element.querySelector('input[name="quiet_hours_enabled"]');
    const quietTimes = this.element.querySelector('.quiet-hours-times');
    quietToggle.addEventListener('change', (e) => {
      quietTimes.style.display = e.target.checked ? 'flex' : 'none';
    });
    
    // 保存设置
    this.element.querySelector('.btn-save-settings').addEventListener('click', () => {
      this.saveSettings();
    });
    
    // 下拉刷新
    this.setupPullToRefresh();
  }
  
  /**
   * 打开消息中心
   */
  async open() {
    if (this.isOpen) return;
    
    this.isOpen = true;
    this.element.classList.add('open');
    
    // 加载通知列表
    await this.loadNotifications();
  }
  
  /**
   * 关闭消息中心
   */
  close() {
    this.isOpen = false;
    this.element.classList.remove('open');
    this.hideSettings();
  }
  
  /**
   * 切换标签页
   */
  async switchTab(tab) {
    if (this.currentTab === tab) return;
    
    this.currentTab = tab;
    this.currentPage = 1;
    
    // 更新标签页样式
    this.element.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    
    // 重新加载通知
    await this.loadNotifications();
  }
  
  /**
   * 加载通知列表
   */
  async loadNotifications() {
    if (this.isLoading) return;
    
    this.isLoading = true;
    this.listElement.innerHTML = '';
    this.loadingElement.style.display = 'flex';
    this.emptyElement.style.display = 'none';
    
    try {
      // 构建查询参数
      const params = {
        page: this.currentPage,
        limit: 20,
      };
      
      if (this.currentTab !== 'all') {
        params.type = this.currentTab;
      }
      
      // 调用 API
      const response = await this.apiClient.get('/api/notifications', { params });
      
      if (response.success) {
        this.notifications = response.data.notifications;
        this.totalPages = response.data.pagination.totalPages;
        this.unreadCount = response.data.unreadCount;
        
        // 更新 UI
        this.renderNotifications();
        this.updateBadge();
        this.updateMarkAllReadButton();
        
        // 缓存到 IndexedDB
        await this.cacheNotifications(this.notifications);
      }
    } catch (error) {
      console.error('[MessageCenter] Load notifications error:', error);
      
      // 尝试从缓存加载
      const cached = await this.getCachedNotifications();
      if (cached.length > 0) {
        this.notifications = cached;
        this.renderNotifications();
      }
    } finally {
      this.isLoading = false;
      this.loadingElement.style.display = 'none';
    }
  }
  
  /**
   * 渲染通知列表
   */
  renderNotifications() {
    if (this.notifications.length === 0) {
      this.emptyElement.style.display = 'flex';
      return;
    }
    
    this.emptyElement.style.display = 'none';
    
    this.listElement.innerHTML = this.notifications.map(notification => `
      <div class="notification-card ${notification.isRead ? 'read' : 'unread'}" data-id="${notification.id}">
        ${!notification.isRead ? '<div class="unread-dot"></div>' : ''}
        <div class="notification-icon">${notification.icon}</div>
        <div class="notification-content">
          <div class="notification-title">${notification.title}</div>
          <div class="notification-body">${notification.body}</div>
          <div class="notification-time">${notification.timeAgo}</div>
        </div>
        ${this.getActionButtons(notification)}
      </div>
    `).join('');
    
    // 绑定点击事件
    this.listElement.querySelectorAll('.notification-card').forEach(card => {
      const id = card.dataset.id;
      
      // 点击卡片
      card.addEventListener('click', (e) => {
        if (!e.target.classList.contains('action-btn')) {
          this.handleNotificationClick(id);
        }
      });
      
      // 操作按钮
      card.querySelectorAll('.action-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const action = btn.dataset.action;
          this.handleNotificationAction(id, action);
        });
      });
    });
  }
  
  /**
   * 获取操作按钮
   */
  getActionButtons(notification) {
    const actions = [];
    
    switch (notification.type) {
      case 'RARE_SPAWN':
        actions.push({ action: 'navigate', label: '前往', icon: '🗺️' });
        break;
      case 'RAID_STARTED':
        actions.push({ action: 'join', label: '加入', icon: '⚔️' });
        break;
      case 'FRIEND_REQUEST':
        actions.push({ action: 'accept', label: '接受', icon: '✓' });
        actions.push({ action: 'reject', label: '拒绝', icon: '✕' });
        break;
      case 'QUEST_COMPLETE':
        actions.push({ action: 'claim', label: '领取', icon: '🎁' });
        break;
    }
    
    if (actions.length === 0) return '';
    
    return `<div class="notification-actions">
      ${actions.map(a => `<button class="action-btn" data-action="${a.action}">${a.icon} ${a.label}</button>`).join('')}
    </div>`;
  }
  
  /**
   * 处理通知点击
   */
  async handleNotificationClick(id) {
    const notification = this.notifications.find(n => n.id === id);
    if (!notification) return;
    
    // 标记为已读
    if (!notification.isRead) {
      await this.markAsRead(id);
    }
    
    // 展开详情（如果有）
    // TODO: 实现通知详情展开
  }
  
  /**
   * 处理通知操作
   */
  async handleNotificationAction(id, action) {
    const notification = this.notifications.find(n => n.id === id);
    if (!notification) return;
    
    switch (action) {
      case 'navigate':
        // 导航到地图位置
        if (notification.data.lat && notification.data.lng) {
          this.close();
          this.onNavigate('map', {
            lat: notification.data.lat,
            lng: notification.data.lng,
          });
        }
        break;
        
      case 'join':
        // 加入 Raid
        if (notification.data.raidId) {
          this.close();
          this.onNavigate('raid', { raidId: notification.data.raidId });
        }
        break;
        
      case 'accept':
        // 接受好友请求
        await this.apiClient.post(`/api/friends/accept`, {
          friendId: notification.data.friendId,
        });
        break;
        
      case 'reject':
        // 拒绝好友请求
        await this.apiClient.post(`/api/friends/reject`, {
          friendId: notification.data.friendId,
        });
        break;
        
      case 'claim':
        // 领取奖励
        await this.apiClient.post(`/api/rewards/claim`, {
          rewardId: notification.data.rewardId,
        });
        break;
    }
    
    // 标记为已读
    await this.markAsRead(id);
  }
  
  /**
   * 标记为已读
   */
  async markAsRead(id) {
    try {
      await this.apiClient.patch(`/api/notifications/${id}/read`);
      
      // 更新本地状态
      const notification = this.notifications.find(n => n.id === id);
      if (notification) {
        notification.isRead = true;
      }
      
      // 更新 UI
      const card = this.listElement.querySelector(`[data-id="${id}"]`);
      if (card) {
        card.classList.remove('unread');
        card.classList.add('read');
        card.querySelector('.unread-dot')?.remove();
      }
      
      // 更新未读数量
      await this.loadUnreadCount();
      this.updateMarkAllReadButton();
    } catch (error) {
      console.error('[MessageCenter] Mark as read error:', error);
    }
  }
  
  /**
   * 全部标记已读
   */
  async markAllRead() {
    try {
      await this.apiClient.post('/api/notifications/batch-read', { all: true });
      
      // 更新本地状态
      this.notifications.forEach(n => n.isRead = true);
      
      // 重新渲染
      this.renderNotifications();
      
      // 更新未读数量
      this.unreadCount = 0;
      this.updateBadge();
      this.updateMarkAllReadButton();
    } catch (error) {
      console.error('[MessageCenter] Mark all read error:', error);
    }
  }
  
  /**
   * 清空已读消息
   */
  async clearReadNotifications() {
    if (!confirm('确定要清空所有已读消息吗？')) return;
    
    try {
      await this.apiClient.post('/api/notifications/clear-read');
      
      // 重新加载
      await this.loadNotifications();
    } catch (error) {
      console.error('[MessageCenter] Clear read notifications error:', error);
    }
  }
  
  /**
   * 加载未读数量
   */
  async loadUnreadCount() {
    try {
      const response = await this.apiClient.get('/api/notifications/unread-count');
      
      if (response.success) {
        this.unreadCount = response.data.total;
        this.updateBadge();
      }
    } catch (error) {
      console.error('[MessageCenter] Load unread count error:', error);
    }
  }
  
  /**
   * 更新徽章
   */
  updateBadge() {
    if (!this.badgeElement) return;
    
    if (this.unreadCount > 0) {
      this.badgeElement.style.display = 'flex';
      this.badgeElement.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
    } else {
      this.badgeElement.style.display = 'none';
    }
  }
  
  /**
   * 更新"全部已读"按钮
   */
  updateMarkAllReadButton() {
    this.markAllReadBtn.style.display = this.unreadCount > 0 ? 'block' : 'none';
  }
  
  /**
   * 显示设置面板
   */
  async showSettings() {
    this.mainPanel.style.display = 'none';
    this.settingsPanel.style.display = 'block';
    
    // 加载当前设置
    try {
      const response = await this.apiClient.get('/api/notifications/preferences');
      
      if (response.success) {
        const prefs = response.data;
        
        // 更新表单
        if (prefs.notificationTypes) {
          Object.entries(prefs.notificationTypes).forEach(([type, enabled]) => {
            const checkbox = this.element.querySelector(`input[name="${type}"]`);
            if (checkbox) checkbox.checked = enabled;
          });
        }
        
        if (prefs.quietHours) {
          const enabled = prefs.quietHours.enabled;
          this.element.querySelector('input[name="quiet_hours_enabled"]').checked = enabled;
          this.element.querySelector('.quiet-hours-times').style.display = enabled ? 'flex' : 'none';
          
          if (prefs.quietHours.start) {
            this.element.querySelector('input[name="quiet_start"]').value = prefs.quietHours.start;
          }
          if (prefs.quietHours.end) {
            this.element.querySelector('input[name="quiet_end"]').value = prefs.quietHours.end;
          }
        }
      }
    } catch (error) {
      console.error('[MessageCenter] Load preferences error:', error);
    }
  }
  
  /**
   * 隐藏设置面板
   */
  hideSettings() {
    this.settingsPanel.style.display = 'none';
    this.mainPanel.style.display = 'block';
  }
  
  /**
   * 保存设置
   */
  async saveSettings() {
    const notificationTypes = {
      rare_spawn: this.element.querySelector('input[name="rare_spawn"]').checked,
      raid_started: this.element.querySelector('input[name="raid_started"]').checked,
      friend_request: this.element.querySelector('input[name="friend_request"]').checked,
      gift_received: this.element.querySelector('input[name="gift_received"]').checked,
      quest_complete: this.element.querySelector('input[name="quest_complete"]').checked,
      system: this.element.querySelector('input[name="system"]').checked,
    };
    
    const quietHours = {
      enabled: this.element.querySelector('input[name="quiet_hours_enabled"]').checked,
      start: this.element.querySelector('input[name="quiet_start"]').value,
      end: this.element.querySelector('input[name="quiet_end"]').value,
    };
    
    try {
      await this.apiClient.patch('/api/notifications/preferences', {
        notificationTypes,
        quietHours,
      });
      
      alert('设置已保存');
      this.hideSettings();
    } catch (error) {
      console.error('[MessageCenter] Save settings error:', error);
      alert('保存失败，请重试');
    }
  }
  
  /**
   * 设置 WebSocket 监听
   */
  setupWebSocketListener() {
    // 监听新通知事件
    document.addEventListener('notification:received', async (event) => {
      const notification = event.detail;
      
      // 更新未读数量
      this.unreadCount++;
      this.updateBadge();
      
      // 如果消息中心打开，刷新列表
      if (this.isOpen) {
        await this.loadNotifications();
      }
    });
  }
  
  /**
   * 设置下拉刷新
   */
  setupPullToRefresh() {
    let startY = 0;
    let isPulling = false;
    
    this.listElement.addEventListener('touchstart', (e) => {
      if (this.listElement.scrollTop === 0) {
        startY = e.touches[0].clientY;
        isPulling = true;
      }
    });
    
    this.listElement.addEventListener('touchmove', (e) => {
      if (!isPulling) return;
      
      const currentY = e.touches[0].clientY;
      const diff = currentY - startY;
      
      if (diff > 60) {
        // 触发刷新
        isPulling = false;
        this.loadNotifications();
      }
    });
    
    this.listElement.addEventListener('touchend', () => {
      isPulling = false;
    });
  }
  
  /**
   * 缓存通知到 IndexedDB
   */
  async cacheNotifications(notifications) {
    if (!this.db) return;
    
    const tx = this.db.transaction('notifications', 'readwrite');
    const store = tx.objectStore('notifications');
    
    for (const notification of notifications) {
      store.put(notification);
    }
    
    // 更新同步时间
    const metadataTx = this.db.transaction('metadata', 'readwrite');
    const metadataStore = metadataTx.objectStore('metadata');
    metadataStore.put({ key: 'lastSyncTime', value: Date.now() });
  }
  
  /**
   * 从 IndexedDB 获取缓存通知
   */
  async getCachedNotifications() {
    if (!this.db) return [];
    
    return new Promise((resolve) => {
      const tx = this.db.transaction('notifications', 'readonly');
      const store = tx.objectStore('notifications');
      const request = store.getAll();
      
      request.onsuccess = () => {
        resolve(request.result || []);
      };
      
      request.onerror = () => {
        resolve([]);
      };
    });
  }
  
  /**
   * 创建导航栏徽章
   */
  createNavbarBadge(navbarElement) {
    // 创建消息图标
    const icon = document.createElement('button');
    icon.className = 'navbar-message-icon';
    icon.innerHTML = '🔔';
    icon.addEventListener('click', () => this.open());
    
    // 创建徽章
    this.badgeElement = document.createElement('span');
    this.badgeElement.className = 'navbar-message-badge';
    this.badgeElement.style.display = 'none';
    icon.appendChild(this.badgeElement);
    
    // 添加到导航栏
    navbarElement.appendChild(icon);
    
    // 初始更新
    this.updateBadge();
    
    return icon;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageCenter;
} else {
  window.MessageCenter = MessageCenter;
}
