/**
 * REQ-00076: 精灵成就系统与里程碑奖励
 * 前端成就面板组件
 */

class AchievementPanel {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.options = {
      userId: options.userId,
      apiBaseUrl: options.apiBaseUrl || '/api/v2',
      onAchievementClick: options.onAchievementClick || null,
      onRewardClaim: options.onRewardClaim || null,
      ...options
    };
    
    this.achievements = [];
    this.progress = {};
    this.selectedCategory = 'all';
    this.loading = false;
    
    this.categories = [
      { id: 'all', name: '全部', icon: '🏆' },
      { id: 'catch', name: '捕捉', icon: '🎯' },
      { id: 'battle', name: '战斗', icon: '⚔️' },
      { id: 'breed', name: '培育', icon: '🥚' },
      { id: 'social', name: '社交', icon: '👥' },
      { id: 'explore', name: '探索', icon: '🗺️' }
    ];
    
    this.rarityColors = {
      common: '#9e9e9e',
      rare: '#2196f3',
      epic: '#9c27b0',
      legendary: '#ff9800'
    };
    
    this.rarityNames = {
      common: '普通',
      rare: '稀有',
      epic: '史诗',
      legendary: '传说'
    };
    
    this.init();
  }
  
  async init() {
    this.render();
    await this.loadProgress();
    await this.loadAchievements();
    this.bindEvents();
  }
  
  render() {
    this.container.innerHTML = `
      <div class="achievement-panel">
        <div class="achievement-header">
          <h2>成就系统</h2>
          <div class="progress-summary">
            <div class="stat-item total-points">
              <span class="stat-label">成就点数</span>
              <span class="stat-value" id="total-points">0</span>
            </div>
            <div class="stat-item completed-count">
              <span class="stat-label">已完成</span>
              <span class="stat-value" id="completed-count">0</span>
            </div>
          </div>
        </div>
        
        <div class="category-tabs" id="category-tabs">
          ${this.categories.map(cat => `
            <button class="category-tab ${cat.id === 'all' ? 'active' : ''}" data-category="${cat.id}">
              <span class="category-icon">${cat.icon}</span>
              <span class="category-name">${cat.name}</span>
            </button>
          `).join('')}
        </div>
        
        <div class="achievements-container">
          <div class="loading" id="loading" style="display: none;">
            <div class="spinner"></div>
            <span>加载中...</span>
          </div>
          
          <div class="achievements-grid" id="achievements-grid">
            <!-- 成就卡片将动态插入 -->
          </div>
        </div>
      </div>
    `;
    
    this.elements = {
      totalPoints: this.container.querySelector('#total-points'),
      completedCount: this.container.querySelector('#completed-count'),
      categoryTabs: this.container.querySelector('#category-tabs'),
      achievementsGrid: this.container.querySelector('#achievements-grid'),
      loading: this.container.querySelector('#loading')
    };
  }
  
  bindEvents() {
    // 分类标签点击
    this.elements.categoryTabs.addEventListener('click', async (e) => {
      const tab = e.target.closest('.category-tab');
      if (!tab) return;
      
      const category = tab.dataset.category;
      if (category === this.selectedCategory) return;
      
      // 更新激活状态
      this.container.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      this.selectedCategory = category;
      await this.loadAchievements();
    });
    
    // 成就卡片点击
    this.elements.achievementsGrid.addEventListener('click', async (e) => {
      const claimBtn = e.target.closest('.claim-button');
      if (claimBtn) {
        e.stopPropagation();
        await this.claimReward(claimBtn.dataset.achievementId);
        return;
      }
      
      const card = e.target.closest('.achievement-card');
      if (card && this.options.onAchievementClick) {
        const achievementId = card.dataset.achievementId;
        const achievement = this.achievements.find(a => a.achievement_id === achievementId);
        this.options.onAchievementClick(achievement);
      }
    });
  }
  
  async loadProgress() {
    try {
      const response = await fetch(`${this.options.apiBaseUrl}/achievements/my/progress`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'X-User-Id': this.options.userId
        }
      });
      
      const data = await response.json();
      if (data.success) {
        this.progress = data.data;
        this.updateProgressDisplay();
      }
    } catch (error) {
      console.error('Failed to load achievement progress:', error);
    }
  }
  
  async loadAchievements() {
    this.showLoading(true);
    
    try {
      const params = new URLSearchParams();
      if (this.selectedCategory !== 'all') {
        params.append('category', this.selectedCategory);
      }
      
      const response = await fetch(`${this.options.apiBaseUrl}/achievements/my?${params}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'X-User-Id': this.options.userId
        }
      });
      
      const data = await response.json();
      if (data.success) {
        this.achievements = data.data;
        this.renderAchievements();
      }
    } catch (error) {
      console.error('Failed to load achievements:', error);
      this.showError('加载成就失败，请稍后重试');
    } finally {
      this.showLoading(false);
    }
  }
  
  renderAchievements() {
    this.elements.achievementsGrid.innerHTML = this.achievements.map(ach => this.renderAchievementCard(ach)).join('');
  }
  
  renderAchievementCard(achievement) {
    const progressPercent = achievement.target > 0 ? Math.min((achievement.progress / achievement.target) * 100, 100) : 0;
    const rarityColor = this.rarityColors[achievement.rarity] || this.rarityColors.common;
    const rarityName = this.rarityNames[achievement.rarity] || achievement.rarity;
    
    const isHidden = achievement.is_hidden && !achievement.completed;
    const showProgress = !achievement.completed && achievement.progress !== null;
    
    return `
      <div class="achievement-card ${achievement.completed ? 'completed' : ''} ${isHidden ? 'hidden' : ''}" 
           data-achievement-id="${achievement.achievement_id}">
        <div class="achievement-icon" style="border-color: ${rarityColor}">
          ${achievement.icon_url 
            ? `<img src="${achievement.icon_url}" alt="${achievement.name.zh || achievement.name}" />` 
            : `<div class="icon-placeholder">${achievement.category.charAt(0).toUpperCase()}</div>`
          }
          ${achievement.completed ? '<div class="completed-badge">✓</div>' : ''}
        </div>
        
        <div class="achievement-info">
          <div class="achievement-header-row">
            <h3 class="achievement-name">${isHidden ? '???' : (achievement.name.zh || achievement.name)}</h3>
            <span class="achievement-rarity" style="color: ${rarityColor}">${rarityName}</span>
          </div>
          
          <p class="achievement-desc">${isHidden ? '???' : (achievement.description.zh || achievement.description)}</p>
          
          ${showProgress ? `
            <div class="progress-container">
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${progressPercent}%"></div>
              </div>
              <span class="progress-text">${achievement.progress} / ${achievement.target}</span>
            </div>
          ` : ''}
          
          <div class="achievement-meta">
            <span class="achievement-points">🏅 ${achievement.points} 点</span>
            <span class="achievement-category">${this.getCategoryName(achievement.category)}</span>
          </div>
        </div>
        
        ${achievement.completed && !achievement.rewards_claimed ? `
          <button class="claim-button" data-achievement-id="${achievement.achievement_id}">
            领取奖励
          </button>
        ` : ''}
        
        ${achievement.rewards_claimed ? `
          <div class="claimed-badge">已领取</div>
        ` : ''}
      </div>
    `;
  }
  
  async claimReward(achievementId) {
    try {
      const response = await fetch(`${this.options.apiBaseUrl}/achievements/${achievementId}/claim`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'X-User-Id': this.options.userId,
          'Content-Type': 'application/json'
        }
      });
      
      const data = await response.json();
      
      if (data.success) {
        alert(`奖励已领取！\n${this.formatRewards(data.data.rewards)}`);
        
        // 重新加载数据
        await this.loadProgress();
        await this.loadAchievements();
        
        if (this.options.onRewardClaim) {
          this.options.onRewardClaim(data.data.rewards);
        }
      } else {
        alert(`领取失败：${data.error}`);
      }
    } catch (error) {
      console.error('Failed to claim reward:', error);
      alert('领取奖励失败，请稍后重试');
    }
  }
  
  formatRewards(rewards) {
    const parts = [];
    
    if (rewards.coins) {
      parts.push(`💰 ${rewards.coins} 金币`);
    }
    
    if (rewards.items && rewards.items.length > 0) {
      parts.push(`📦 ${rewards.items.map(i => `${i.item_id} x${i.count}`).join(', ')}`);
    }
    
    if (rewards.title) {
      parts.push(`🏅 称号: ${rewards.title}`);
    }
    
    return parts.join('\n');
  }
  
  updateProgressDisplay() {
    this.elements.totalPoints.textContent = this.progress.total_points || 0;
    this.elements.completedCount.textContent = this.progress.achievements_completed || 0;
  }
  
  getCategoryName(categoryId) {
    const category = this.categories.find(c => c.id === categoryId);
    return category ? category.name : categoryId;
  }
  
  showLoading(show) {
    this.loading = show;
    this.elements.loading.style.display = show ? 'flex' : 'none';
    this.elements.achievementsGrid.style.opacity = show ? 0.5 : 1;
  }
  
  showError(message) {
    this.elements.achievementsGrid.innerHTML = `
      <div class="error-message">
        <span>❌ ${message}</span>
        <button onclick="location.reload()">重试</button>
      </div>
    `;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AchievementPanel;
} else {
  window.AchievementPanel = AchievementPanel;
}
