/**
 * REQ-00048: 好友系统前端组件
 * 精灵好友系统与社交互动增强
 */

'use strict';

// 好友系统管理器
class FriendSystem {
  constructor(apiClient, wsClient) {
    this.api = apiClient;
    this.ws = wsClient;
    this.friends = [];
    this.pendingRequests = [];
    this.pendingGifts = [];
    this.friendCode = null;
    this.listeners = new Map();
    
    this.config = {
      maxFriends: 400,
      maxDailyGifts: 50,
      onlineThresholdMinutes: 5,
      awayThresholdMinutes: 60
    };

    // 绑定 WebSocket 事件
    this.setupWebSocketListeners();
  }

  // ============================================
  // 初始化
  // ============================================

  async init() {
    try {
      await Promise.all([
        this.loadFriends(),
        this.loadPendingRequests(),
        this.loadPendingGifts(),
        this.loadFriendCode()
      ]);
      
      // 启动状态更新定时器
      this.startStatusUpdater();
      
      console.log('[FriendSystem] Initialized');
    } catch (error) {
      console.error('[FriendSystem] Init failed:', error);
    }
  }

  setupWebSocketListeners() {
    if (!this.ws) return;

    // 好友请求通知
    this.ws.on('friend_request_received', (data) => {
      this.loadPendingRequests();
      this.emit('request_received', data);
    });

    // 好友请求接受通知
    this.ws.on('friend_request_accepted', (data) => {
      this.loadFriends();
      this.emit('friend_accepted', data);
    });

    // 礼物接收通知
    this.ws.on('gift_received', (data) => {
      this.loadPendingGifts();
      this.emit('gift_received', data);
    });

    // 友情等级提升
    this.ws.on('friendship_level_up', (data) => {
      this.loadFriends();
      this.emit('friendship_level_up', data);
    });
  }

  // ============================================
  // 数据加载
  // ============================================

  async loadFriends(options = {}) {
    try {
      const response = await this.api.get('/social/friends', { params: options });
      this.friends = response.data.friends || [];
      this.emit('friends_updated', this.friends);
      return this.friends;
    } catch (error) {
      console.error('[FriendSystem] Load friends failed:', error);
      throw error;
    }
  }

  async loadPendingRequests() {
    try {
      const response = await this.api.get('/social/friends/requests/pending');
      this.pendingRequests = response.data || [];
      this.emit('requests_updated', this.pendingRequests);
      return this.pendingRequests;
    } catch (error) {
      console.error('[FriendSystem] Load pending requests failed:', error);
      throw error;
    }
  }

  async loadPendingGifts() {
    try {
      const response = await this.api.get('/social/friends/gifts/pending');
      this.pendingGifts = response.data.gifts || [];
      this.emit('gifts_updated', this.pendingGifts);
      return this.pendingGifts;
    } catch (error) {
      console.error('[FriendSystem] Load pending gifts failed:', error);
      throw error;
    }
  }

  async loadFriendCode() {
    try {
      const response = await this.api.get('/social/friends/my-code');
      this.friendCode = response.data.friendCode;
      return this.friendCode;
    } catch (error) {
      console.error('[FriendSystem] Load friend code failed:', error);
      throw error;
    }
  }

  // ============================================
  // 好友请求操作
  // ============================================

  async sendFriendRequest(toUserId, message = '') {
    try {
      const response = await this.api.post('/social/friends/request', {
        toUserId,
        message
      });
      
      this.emit('request_sent', response.data);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Send request failed:', error);
      throw error;
    }
  }

  async addFriendByCode(friendCode) {
    try {
      const response = await this.api.post('/social/friends/add-by-code', {
        friendCode: friendCode.toUpperCase()
      });
      
      this.emit('request_sent', response.data);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Add by code failed:', error);
      throw error;
    }
  }

  async acceptRequest(requestId) {
    try {
      const response = await this.api.post(`/social/friends/request/${requestId}/accept`);
      
      await Promise.all([
        this.loadFriends(),
        this.loadPendingRequests()
      ]);
      
      this.emit('request_accepted', response.data);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Accept request failed:', error);
      throw error;
    }
  }

  async rejectRequest(requestId) {
    try {
      const response = await this.api.post(`/social/friends/request/${requestId}/reject`);
      
      await this.loadPendingRequests();
      
      this.emit('request_rejected', response.data);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Reject request failed:', error);
      throw error;
    }
  }

  // ============================================
  // 好友管理
  // ============================================

  async removeFriend(friendId) {
    try {
      const response = await this.api.delete(`/social/friends/${friendId}`);
      
      await this.loadFriends();
      
      this.emit('friend_removed', { friendId });
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Remove friend failed:', error);
      throw error;
    }
  }

  async searchUsers(query, limit = 20) {
    try {
      const response = await this.api.get('/social/friends/search', {
        params: { q: query, limit }
      });
      return response.data || [];
    } catch (error) {
      console.error('[FriendSystem] Search users failed:', error);
      throw error;
    }
  }

  async getFriendDetail(friendId) {
    try {
      const response = await this.api.get(`/social/friends/${friendId}`);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Get friend detail failed:', error);
      throw error;
    }
  }

  async getLeaderboard(type = 'friendship', limit = 10) {
    try {
      const response = await this.api.get('/social/friends/leaderboard', {
        params: { type, limit }
      });
      return response.data || [];
    } catch (error) {
      console.error('[FriendSystem] Get leaderboard failed:', error);
      throw error;
    }
  }

  // ============================================
  // 礼物系统
  // ============================================

  async sendGift(friendId, giftType, giftId, quantity = 1, giftName = '') {
    try {
      const response = await this.api.post(`/social/friends/${friendId}/gift`, {
        giftType,
        giftId,
        quantity,
        giftName
      });
      
      this.emit('gift_sent', response.data);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Send gift failed:', error);
      throw error;
    }
  }

  async claimGift(giftId) {
    try {
      const response = await this.api.post(`/social/friends/gifts/${giftId}/claim`);
      
      await this.loadPendingGifts();
      
      this.emit('gift_claimed', response.data);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Claim gift failed:', error);
      throw error;
    }
  }

  async claimAllGifts() {
    try {
      const response = await this.api.post('/social/friends/gifts/claim-all');
      
      await this.loadPendingGifts();
      
      this.emit('gifts_claimed', response.data);
      return response.data;
    } catch (error) {
      console.error('[FriendSystem] Claim all gifts failed:', error);
      throw error;
    }
  }

  // ============================================
  // 状态更新
  // ============================================

  startStatusUpdater() {
    // 每30秒更新一次在线状态
    this.statusInterval = setInterval(async () => {
      try {
        await this.api.post('/social/friends/update-status');
      } catch (error) {
        // 静默失败
      }
    }, 30000);
  }

  stopStatusUpdater() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }
  }

  // ============================================
  // 辅助方法
  // ============================================

  getOnlineStatusColor(status) {
    switch (status) {
      case 'online': return '#4CAF50';
      case 'away': return '#FFC107';
      default: return '#9E9E9E';
    }
  }

  getOnlineStatusText(status) {
    switch (status) {
      case 'online': return '在线';
      case 'away': return '离开';
      default: return '离线';
    }
  }

  getFriendshipLevelEmoji(level) {
    const emojis = ['🤝', '💚', '💚💚', '💚💚💚', '💚💚💚💚', '💚💚💚💚💚'];
    return emojis[level] || emojis[0];
  }

  getFriendshipLevelName(level) {
    const names = ['新朋友', '好朋友', '挚友', '知己', '死党', '灵魂伴侣'];
    return names[level] || names[0];
  }

  getFriendById(friendId) {
    return this.friends.find(f => f.id === friendId);
  }

  isFriend(userId) {
    return this.friends.some(f => f.id === userId);
  }

  getFriendCount() {
    return this.friends.length;
  }

  getPendingRequestCount() {
    return this.pendingRequests.length;
  }

  getPendingGiftCount() {
    return this.pendingGifts.length;
  }

  // ============================================
  // 事件系统
  // ============================================

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      const callbacks = this.listeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`[FriendSystem] Event callback error (${event}):`, error);
        }
      });
    }
  }

  // ============================================
  // 清理
  // ============================================

  destroy() {
    this.stopStatusUpdater();
    this.listeners.clear();
    this.friends = [];
    this.pendingRequests = [];
    this.pendingGifts = [];
  }
}

// ============================================
// UI 组件（用于浏览器环境）
// ============================================

// 好友列表组件
class FriendListComponent {
  constructor(container, friendSystem) {
    this.container = container;
    this.fs = friendSystem;
    this.activeTab = 'friends';
    this.searchQuery = '';
    this.searchResults = [];
    
    this.init();
  }

  init() {
    this.render();
    this.bindEvents();
    
    // 监听数据更新
    this.fs.on('friends_updated', () => this.renderFriends());
    this.fs.on('requests_updated', () => this.renderRequests());
    this.fs.on('gifts_updated', () => this.renderGifts());
  }

  render() {
    this.container.innerHTML = `
      <div class="friend-system">
        <div class="friend-header">
          <h2>好友系统</h2>
          <button class="close-btn" data-action="close">×</button>
        </div>
        
        <div class="friend-tabs">
          <button class="tab-btn active" data-tab="friends">
            好友 <span class="badge" id="friend-count">0</span>
          </button>
          <button class="tab-btn" data-tab="requests">
            请求 <span class="badge" id="request-count">0</span>
          </button>
          <button class="tab-btn" data-tab="gifts">
            礼物 <span class="badge" id="gift-count">0</span>
          </button>
          <button class="tab-btn" data-tab="add">
            添加
          </button>
        </div>
        
        <div class="friend-content" id="friend-content"></div>
      </div>
    `;
    
    this.updateBadges();
    this.renderTabContent();
  }

  bindEvents() {
    // 标签切换
    this.container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = btn.dataset.tab;
        this.container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderTabContent();
      });
    });

    // 关闭按钮
    this.container.querySelector('.close-btn').addEventListener('click', () => {
      this.emit('close');
    });
  }

  updateBadges() {
    const friendCount = document.getElementById('friend-count');
    const requestCount = document.getElementById('request-count');
    const giftCount = document.getElementById('gift-count');
    
    if (friendCount) friendCount.textContent = this.fs.getFriendCount();
    if (requestCount) requestCount.textContent = this.fs.getPendingRequestCount();
    if (giftCount) giftCount.textContent = this.fs.getPendingGiftCount();
  }

  renderTabContent() {
    const content = document.getElementById('friend-content');
    if (!content) return;

    switch (this.activeTab) {
      case 'friends':
        this.renderFriends();
        break;
      case 'requests':
        this.renderRequests();
        break;
      case 'gifts':
        this.renderGifts();
        break;
      case 'add':
        this.renderAddFriend();
        break;
    }
  }

  renderFriends() {
    const content = document.getElementById('friend-content');
    if (!content) return;

    const friends = this.fs.friends;
    
    content.innerHTML = `
      <div class="friends-list">
        ${friends.length === 0 ? 
          '<div class="empty-state">暂无好友，快去添加吧！</div>' :
          friends.map(friend => this.renderFriendCard(friend)).join('')
        }
      </div>
    `;

    // 绑定好友卡片事件
    content.querySelectorAll('.friend-card').forEach(card => {
      const friendId = card.dataset.friendId;
      
      card.querySelector('[data-action="gift"]')?.addEventListener('click', () => {
        this.showGiftDialog(friendId);
      });
      
      card.querySelector('[data-action="profile"]')?.addEventListener('click', () => {
        this.showFriendProfile(friendId);
      });
      
      card.querySelector('[data-action="remove"]')?.addEventListener('click', () => {
        this.confirmRemoveFriend(friendId);
      });
    });
  }

  renderFriendCard(friend) {
    const statusColor = this.fs.getOnlineStatusColor(friend.online_status);
    const statusText = this.fs.getOnlineStatusText(friend.online_status);
    const levelEmoji = this.fs.getFriendshipLevelEmoji(friend.friendship_level);
    
    return `
      <div class="friend-card" data-friend-id="${friend.id}">
        <div class="friend-avatar">
          <img src="${friend.avatar_url || '/images/default-avatar.png'}" alt="${friend.username}">
          <span class="online-indicator" style="background-color: ${statusColor}" title="${statusText}"></span>
        </div>
        <div class="friend-info">
          <div class="friend-name">${friend.username}</div>
          <div class="friend-level">Lv.${friend.level}</div>
          <div class="friendship-level" title="${this.fs.getFriendshipLevelName(friend.friendship_level)}">
            ${levelEmoji} (${friend.friendship_points})
          </div>
        </div>
        <div class="friend-actions">
          ${friend.pending_gifts > 0 ? `<span class="gift-badge">${friend.pending_gifts}个礼物</span>` : ''}
          <button class="action-btn" data-action="gift" title="赠送礼物">🎁</button>
          <button class="action-btn" data-action="profile" title="查看资料">👤</button>
          <button class="action-btn danger" data-action="remove" title="删除好友">×</button>
        </div>
      </div>
    `;
  }

  renderRequests() {
    const content = document.getElementById('friend-content');
    if (!content) return;

    const requests = this.fs.pendingRequests;
    
    content.innerHTML = `
      <div class="requests-list">
        ${requests.length === 0 ?
          '<div class="empty-state">暂无好友请求</div>' :
          requests.map(req => `
            <div class="request-card" data-request-id="${req.id}">
              <div class="request-avatar">
                <img src="${req.avatar_url || '/images/default-avatar.png'}" alt="${req.username}">
              </div>
              <div class="request-info">
                <div class="request-name">${req.username}</div>
                <div class="request-level">Lv.${req.level}</div>
                ${req.message ? `<div class="request-message">"${req.message}"</div>` : ''}
              </div>
              <div class="request-actions">
                <button class="accept-btn" data-action="accept">接受</button>
                <button class="reject-btn" data-action="reject">拒绝</button>
              </div>
            </div>
          `).join('')
        }
      </div>
    `;

    // 绑定事件
    content.querySelectorAll('.request-card').forEach(card => {
      const requestId = card.dataset.requestId;
      
      card.querySelector('[data-action="accept"]')?.addEventListener('click', async () => {
        try {
          await this.fs.acceptRequest(parseInt(requestId));
          this.updateBadges();
        } catch (error) {
          alert('接受失败: ' + error.message);
        }
      });
      
      card.querySelector('[data-action="reject"]')?.addEventListener('click', async () => {
        try {
          await this.fs.rejectRequest(parseInt(requestId));
          this.updateBadges();
        } catch (error) {
          alert('拒绝失败: ' + error.message);
        }
      });
    });
  }

  renderGifts() {
    const content = document.getElementById('friend-content');
    if (!content) return;

    const gifts = this.fs.pendingGifts;
    
    content.innerHTML = `
      <div class="gifts-list">
        ${gifts.length === 0 ?
          '<div class="empty-state">暂无待领取礼物</div>' :
          `
            <button class="claim-all-btn" id="claim-all-btn">全部领取</button>
            ${gifts.map(gift => `
              <div class="gift-card" data-gift-id="${gift.id}">
                <div class="gift-avatar">
                  <img src="${gift.from_avatar || '/images/default-avatar.png'}" alt="${gift.from_username}">
                </div>
                <div class="gift-info">
                  <div class="gift-from">来自 ${gift.from_username}</div>
                  <div class="gift-type">${this.getGiftTypeName(gift.gift_type)}</div>
                  <div class="gift-name">${gift.gift_name || '礼物'} ×${gift.quantity}</div>
                </div>
                <div class="gift-actions">
                  <button class="claim-btn" data-action="claim">领取</button>
                </div>
              </div>
            `).join('')}
          `
        }
      </div>
    `;

    // 绑定事件
    content.querySelector('#claim-all-btn')?.addEventListener('click', async () => {
      try {
        const result = await this.fs.claimAllGifts();
        alert(`成功领取 ${result.claimed} 个礼物`);
        this.updateBadges();
      } catch (error) {
        alert('领取失败: ' + error.message);
      }
    });

    content.querySelectorAll('.gift-card').forEach(card => {
      const giftId = card.dataset.giftId;
      
      card.querySelector('[data-action="claim"]')?.addEventListener('click', async () => {
        try {
          const result = await this.fs.claimGift(parseInt(giftId));
          alert(`成功领取: ${result.giftName} ×${result.quantity}\n获得友情点数: ${result.pointsEarned}`);
          this.updateBadges();
        } catch (error) {
          alert('领取失败: ' + error.message);
        }
      });
    });
  }

  renderAddFriend() {
    const content = document.getElementById('friend-content');
    if (!content) return;

    content.innerHTML = `
      <div class="add-friend-panel">
        <div class="search-section">
          <input type="text" id="friend-search" placeholder="搜索用户名..." maxlength="50">
          <button id="search-btn">搜索</button>
        </div>
        <div id="search-results" class="search-results"></div>
        
        <div class="divider">或</div>
        
        <div class="friend-code-section">
          <input type="text" id="friend-code-input" placeholder="输入好友码" maxlength="12" style="text-transform: uppercase">
          <button id="add-by-code-btn">添加</button>
        </div>
        
        <div class="my-friend-code">
          <label>我的好友码:</label>
          <div class="code-display">${this.fs.friendCode || '加载中...'}</div>
          <button id="copy-code-btn">📋 复制</button>
        </div>
      </div>
    `;

    // 绑定事件
    const searchInput = content.querySelector('#friend-search');
    const searchBtn = content.querySelector('#search-btn');
    const searchResults = content.querySelector('#search-results');

    const doSearch = async () => {
      const query = searchInput.value.trim();
      if (query.length < 2) {
        searchResults.innerHTML = '';
        return;
      }

      try {
        const users = await this.fs.searchUsers(query);
        searchResults.innerHTML = users.map(user => `
          <div class="search-result-item" data-user-id="${user.id}">
            <img src="${user.avatar_url || '/images/default-avatar.png'}" alt="${user.username}">
            <span>${user.username} (Lv.${user.level})</span>
            <button class="add-btn" data-action="add">添加</button>
          </div>
        `).join('');

        searchResults.querySelectorAll('.search-result-item').forEach(item => {
          const userId = item.dataset.userId;
          item.querySelector('[data-action="add"]')?.addEventListener('click', async () => {
            try {
              await this.fs.sendFriendRequest(userId);
              alert('好友请求已发送');
            } catch (error) {
              alert('发送失败: ' + error.message);
            }
          });
        });
      } catch (error) {
        searchResults.innerHTML = '<div class="error">搜索失败</div>';
      }
    };

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') doSearch();
    });

    // 好友码添加
    content.querySelector('#add-by-code-btn')?.addEventListener('click', async () => {
      const code = content.querySelector('#friend-code-input').value.trim();
      if (!code) {
        alert('请输入好友码');
        return;
      }

      try {
        await this.fs.addFriendByCode(code);
        alert('好友请求已发送');
        content.querySelector('#friend-code-input').value = '';
      } catch (error) {
        alert('添加失败: ' + error.message);
      }
    });

    // 复制好友码
    content.querySelector('#copy-code-btn')?.addEventListener('click', () => {
      navigator.clipboard.writeText(this.fs.friendCode || '').then(() => {
        alert('好友码已复制');
      });
    });
  }

  getGiftTypeName(type) {
    const names = {
      item: '道具',
      candy: '精灵糖果',
      stardust: '星尘'
    };
    return names[type] || type;
  }

  showGiftDialog(friendId) {
    // TODO: 实现礼物选择对话框
    this.emit('show_gift_dialog', { friendId });
  }

  showFriendProfile(friendId) {
    // TODO: 实现好友资料页面
    this.emit('show_profile', { friendId });
  }

  async confirmRemoveFriend(friendId) {
    if (confirm('确定要删除这个好友吗？')) {
      try {
        await this.fs.removeFriend(friendId);
        this.updateBadges();
      } catch (error) {
        alert('删除失败: ' + error.message);
      }
    }
  }

  on(event, callback) {
    if (!this.eventListeners) this.eventListeners = new Map();
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  emit(event, data) {
    if (this.eventListeners?.has(event)) {
      this.eventListeners.get(event).forEach(cb => cb(data));
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FriendSystem, FriendListComponent };
} else {
  window.FriendSystem = FriendSystem;
  window.FriendListComponent = FriendListComponent;
}
