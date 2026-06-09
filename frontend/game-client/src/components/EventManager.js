/**
 * REQ-00057: 游戏活动系统前端组件
 * 活动列表、活动详情、任务进度、活动商店
 */

class EventManager {
  constructor(apiClient) {
    this.api = apiClient;
    this.activeEvents = [];
    this.currentEvent = null;
    this.eventListeners = new Map();
  }

  /**
   * 初始化活动管理器
   */
  async initialize() {
    try {
      await this.loadActiveEvents();
      
      // 定时刷新活动状态
      setInterval(() => this.refreshEvents(), 60000);
      
      console.log('✅ Event Manager initialized');
    } catch (error) {
      console.error('Failed to initialize Event Manager:', error);
    }
  }

  /**
   * 加载活跃活动列表
   */
  async loadActiveEvents() {
    try {
      const response = await this.api.get('/events');
      this.activeEvents = response.events || [];
      this.emit('eventsLoaded', this.activeEvents);
      return this.activeEvents;
    } catch (error) {
      console.error('Failed to load events:', error);
      return [];
    }
  }

  /**
   * 刷新活动状态
   */
  async refreshEvents() {
    await this.loadActiveEvents();
  }

  /**
   * 获取活动详情
   */
  async getEventDetails(eventId) {
    try {
      const response = await this.api.get(`/events/${eventId}`);
      this.currentEvent = response.event;
      return this.currentEvent;
    } catch (error) {
      console.error('Failed to get event details:', error);
      return null;
    }
  }

  /**
   * 参与活动
   */
  async joinEvent(eventId) {
    try {
      const response = await this.api.post(`/events/${eventId}/join`);
      this.emit('eventJoined', { eventId, participation: response.participation });
      return response;
    } catch (error) {
      console.error('Failed to join event:', error);
      throw error;
    }
  }

  /**
   * 完成任务
   */
  async completeTask(eventId, taskId) {
    try {
      const response = await this.api.post(`/events/${eventId}/tasks/${taskId}/complete`);
      this.emit('taskCompleted', { eventId, taskId });
      return response;
    } catch (error) {
      console.error('Failed to complete task:', error);
      throw error;
    }
  }

  /**
   * 领取活动奖励
   */
  async claimRewards(eventId) {
    try {
      const response = await this.api.post(`/events/${eventId}/claim`);
      this.emit('rewardsClaimed', { eventId });
      return response;
    } catch (error) {
      console.error('Failed to claim rewards:', error);
      throw error;
    }
  }

  /**
   * 活动商店购买
   */
  async purchaseFromShop(eventId, shopItemId, quantity = 1) {
    try {
      const response = await this.api.post(
        `/events/${eventId}/shop/${shopItemId}/purchase`,
        { quantity }
      );
      this.emit('shopPurchased', { eventId, shopItemId, quantity });
      return response;
    } catch (error) {
      console.error('Failed to purchase from shop:', error);
      throw error;
    }
  }

  /**
   * 获取活动排行榜
   */
  async getLeaderboard(eventId, limit = 100) {
    try {
      const response = await this.api.get(`/events/${eventId}/leaderboard?limit=${limit}`);
      return response.leaderboard;
    } catch (error) {
      console.error('Failed to get leaderboard:', error);
      return [];
    }
  }

  /**
   * 计算活动剩余时间
   */
  getTimeRemaining(event) {
    const now = new Date();
    const endTime = new Date(event.end_time);
    const diff = endTime - now;

    if (diff <= 0) return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    return { days, hours, minutes, seconds, expired: false };
  }

  /**
   * 格式化剩余时间显示
   */
  formatTimeRemaining(timeRemaining) {
    if (timeRemaining.expired) return '活动已结束';
    
    const parts = [];
    if (timeRemaining.days > 0) parts.push(`${timeRemaining.days}天`);
    if (timeRemaining.hours > 0) parts.push(`${timeRemaining.hours}小时`);
    if (timeRemaining.minutes > 0) parts.push(`${timeRemaining.minutes}分`);
    if (timeRemaining.seconds > 0 && timeRemaining.days === 0) parts.push(`${timeRemaining.seconds}秒`);
    
    return parts.join(' ') || '即将结束';
  }

  /**
   * 事件监听
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  /**
   * 触发事件
   */
  emit(event, data) {
    const listeners = this.eventListeners.get(event) || [];
    listeners.forEach(callback => callback(data));
  }
}

/**
 * 活动列表 UI 组件
 */
class EventListUI {
  constructor(container, eventManager) {
    this.container = container;
    this.eventManager = eventManager;
    this.eventCards = new Map();
  }

  render() {
    const events = this.eventManager.activeEvents;
    
    this.container.innerHTML = `
      <div class="event-list-header">
        <h2>🎮 活动中心</h2>
        <span class="event-count">${events.length} 个活动进行中</span>
      </div>
      <div class="event-list-content">
        ${events.length === 0 ? '<p class="no-events">暂无进行中的活动</p>' : ''}
      </div>
    `;

    const content = this.container.querySelector('.event-list-content');
    
    events.forEach(event => {
      const card = this.createEventCard(event);
      content.appendChild(card);
    });
  }

  createEventCard(event) {
    const card = document.createElement('div');
    card.className = 'event-card';
    card.dataset.eventId = event.id;

    const timeRemaining = this.eventManager.getTimeRemaining(event);
    const timeDisplay = this.eventManager.formatTimeRemaining(timeRemaining);
    const progress = this.calculateProgress(event);

    card.innerHTML = `
      <div class="event-banner" style="background-image: url('${event.banner_image || ''}')">
        ${event.icon ? `<img src="${event.icon}" class="event-icon" alt="${event.title}">` : ''}
        <span class="event-type-badge">${this.getEventTypeLabel(event.event_type)}</span>
      </div>
      <div class="event-info">
        <h3 class="event-title">${event.title}</h3>
        <p class="event-description">${event.description || ''}</p>
        <div class="event-meta">
          <span class="event-time">⏱️ ${timeDisplay}</span>
          <span class="event-participants">👥 ${event.participant_count || 0} 人参与</span>
        </div>
        ${progress ? `
          <div class="event-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progress.percent}%"></div>
            </div>
            <span class="progress-text">${progress.current}/${progress.total}</span>
          </div>
        ` : ''}
      </div>
      <button class="event-action-btn" data-event-id="${event.id}">
        ${event.participation_status ? '查看详情' : '立即参与'}
      </button>
    `;

    card.querySelector('.event-action-btn').addEventListener('click', () => {
      this.openEventDetail(event.id);
    });

    return card;
  }

  calculateProgress(event) {
    if (!event.user_progress) return null;
    
    const progress = event.user_progress;
    if (progress.score !== undefined) {
      return {
        current: progress.score,
        total: progress.target || 100,
        percent: Math.min(100, (progress.score / (progress.target || 100)) * 100)
      };
    }
    return null;
  }

  getEventTypeLabel(type) {
    const labels = {
      'spawn_boost': '🦎 精灵活动',
      'shiny_boost': '✨ 闪光活动',
      'double_xp': '⭐ 双倍活动',
      'catch_challenge': '🎯 捕捉挑战',
      'raid_boss': '⚔️ Boss战',
      'holiday': '🎉 节日活动',
      'migration': '🌍 迁徙活动',
      'catch_competition': '🏆 捕捉竞赛'
    };
    return labels[type] || type;
  }

  async openEventDetail(eventId) {
    // 触发打开活动详情的事件
    this.eventManager.emit('openEventDetail', { eventId });
  }
}

/**
 * 活动详情 UI 组件
 */
class EventDetailUI {
  constructor(container, eventManager) {
    this.container = container;
    this.eventManager = eventManager;
    this.event = null;
  }

  async render(eventId) {
    this.event = await this.eventManager.getEventDetails(eventId);
    
    if (!this.event) {
      this.container.innerHTML = '<p class="error">活动不存在</p>';
      return;
    }

    const timeRemaining = this.eventManager.getTimeRemaining(this.event);
    const timeDisplay = this.eventManager.formatTimeRemaining(timeRemaining);

    this.container.innerHTML = `
      <div class="event-detail">
        <div class="event-detail-header">
          <button class="back-btn">← 返回</button>
          <h2>${this.event.title}</h2>
        </div>
        
        <div class="event-banner-large" style="background-image: url('${this.event.banner_image || ''}')">
          <div class="event-time-overlay">
            <span class="time-label">剩余时间</span>
            <span class="time-value">${timeDisplay}</span>
          </div>
        </div>
        
        <div class="event-detail-content">
          <p class="event-description-full">${this.event.description || ''}</p>
          
          ${this.renderParticipationStatus()}
          ${this.renderTasks()}
          ${this.renderShop()}
          ${this.renderRewards()}
        </div>
      </div>
    `;

    this.bindEvents();
  }

  renderParticipationStatus() {
    const participation = this.event.participation;
    
    if (!participation) {
      return `
        <div class="participation-section">
          <button class="join-event-btn" data-event-id="${this.event.id}">
            🎮 立即参与活动
          </button>
        </div>
      `;
    }
    
    return `
      <div class="participation-section">
        <div class="participation-status">
          <span class="status-badge ${participation.status}">${this.getStatusLabel(participation.status)}</span>
          <span class="joined-time">参与时间: ${new Date(participation.joined_at).toLocaleString()}</span>
        </div>
      </div>
    `;
  }

  renderTasks() {
    const tasks = this.event.tasks || [];
    if (tasks.length === 0) return '';

    return `
      <div class="tasks-section">
        <h3>📋 活动任务</h3>
        <div class="tasks-list">
          ${tasks.map(task => this.renderTask(task)).join('')}
        </div>
      </div>
    `;
  }

  renderTask(task) {
    const userProgress = task.user_progress || {};
    const completedCount = task.user_completed_count || 0;
    const isCompleted = !task.is_repeatable && completedCount >= task.max_completions;

    return `
      <div class="task-item ${isCompleted ? 'completed' : ''}">
        <div class="task-info">
          <h4>${task.title}</h4>
          <p>${task.description || ''}</p>
          <div class="task-progress">
            <span>${completedCount}/${task.max_completions}</span>
          </div>
        </div>
        <div class="task-rewards">
          ${this.renderTaskRewards(task.rewards)}
        </div>
        ${!isCompleted ? `
          <button class="complete-task-btn" data-task-id="${task.id}">
            完成
          </button>
        ` : '<span class="completed-badge">✅ 已完成</span>'}
      </div>
    `;
  }

  renderTaskRewards(rewards) {
    if (!rewards || rewards.length === 0) return '';
    
    return rewards.map(reward => {
      switch (reward.type) {
        case 'coins':
          return `<span class="reward coins">💰 ${reward.amount} 精币</span>`;
        case 'stardust':
          return `<span class="reward stardust">⭐ ${reward.amount} 星尘</span>`;
        case 'item':
          return `<span class="reward item">🎁 ${reward.name || '道具'}</span>`;
        default:
          return `<span class="reward">${reward.type}</span>`;
      }
    }).join(' ');
  }

  renderShop() {
    const shop = this.event.shop || [];
    if (shop.length === 0) return '';

    return `
      <div class="shop-section">
        <h3>🛒 活动商店</h3>
        <div class="shop-list">
          ${shop.map(item => this.renderShopItem(item)).join('')}
        </div>
      </div>
    `;
  }

  renderShopItem(item) {
    const stockRemaining = item.total_stock ? item.total_stock - item.sold_count : null;
    const isOutOfStock = stockRemaining !== null && stockRemaining <= 0;

    return `
      <div class="shop-item ${isOutOfStock ? 'out-of-stock' : ''}">
        <div class="item-info">
          <h4>${item.item_name}</h4>
          <p class="item-cost">
            ${this.getCostIcon(item.cost_type)} ${item.cost_amount}
          </p>
          ${stockRemaining !== null ? `<p class="item-stock">库存: ${stockRemaining}</p>` : ''}
        </div>
        ${!isOutOfStock ? `
          <button class="purchase-btn" data-item-id="${item.id}">
            购买
          </button>
        ` : '<span class="out-of-stock-badge">已售罄</span>'}
      </div>
    `;
  }

  getCostIcon(costType) {
    const icons = {
      'coins': '💰',
      'stardust': '⭐',
      'event_points': '🎫'
    };
    return icons[costType] || '💎';
  }

  renderRewards() {
    const rewards = this.event.rewards || [];
    if (rewards.length === 0) return '';

    const participation = this.event.participation;
    const canClaim = participation && !participation.rewards_claimed && participation.status === 'completed';

    return `
      <div class="rewards-section">
        <h3>🎁 活动奖励</h3>
        <div class="rewards-list">
          ${rewards.map(reward => this.renderTaskRewards([reward])).join('')}
        </div>
        ${canClaim ? `
          <button class="claim-rewards-btn" data-event-id="${this.event.id}">
            领取奖励
          </button>
        ` : ''}
      </div>
    `;
  }

  getStatusLabel(status) {
    const labels = {
      'active': '进行中',
      'completed': '已完成',
      'abandoned': '已放弃'
    };
    return labels[status] || status;
  }

  bindEvents() {
    // 返回按钮
    this.container.querySelector('.back-btn')?.addEventListener('click', () => {
      this.eventManager.emit('closeEventDetail');
    });

    // 参与活动按钮
    this.container.querySelector('.join-event-btn')?.addEventListener('click', async (e) => {
      const eventId = e.target.dataset.eventId;
      try {
        await this.eventManager.joinEvent(eventId);
        await this.render(eventId);
      } catch (error) {
        alert('参与活动失败: ' + error.message);
      }
    });

    // 完成任务按钮
    this.container.querySelectorAll('.complete-task-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const taskId = e.target.dataset.taskId;
        try {
          await this.eventManager.completeTask(this.event.id, taskId);
          await this.render(this.event.id);
        } catch (error) {
          alert('完成任务失败: ' + error.message);
        }
      });
    });

    // 商店购买按钮
    this.container.querySelectorAll('.purchase-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const itemId = e.target.dataset.itemId;
        try {
          const result = await this.eventManager.purchaseFromShop(this.event.id, itemId);
          alert(`购买成功: ${result.item}`);
          await this.render(this.event.id);
        } catch (error) {
          alert('购买失败: ' + error.message);
        }
      });
    });

    // 领取奖励按钮
    this.container.querySelector('.claim-rewards-btn')?.addEventListener('click', async (e) => {
      const eventId = e.target.dataset.eventId;
      try {
        await this.eventManager.claimRewards(eventId);
        alert('奖励领取成功！');
        await this.render(eventId);
      } catch (error) {
        alert('领取奖励失败: ' + error.message);
      }
    });
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EventManager, EventListUI, EventDetailUI };
}
