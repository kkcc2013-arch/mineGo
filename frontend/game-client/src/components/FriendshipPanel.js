/**
 * 精灵羁绊面板 - REQ-00067
 */

class FriendshipPanel {
  constructor(options = {}) {
    this.pokemonId = options.pokemonId;
    this.container = options.container || document.body;
    this.onClose = options.onClose;
    
    this.friendship = null;
    this.loading = true;
    this.interacting = null;
    
    this.interactionIcons = {
      feed: '🍓',
      play: '🎾',
      pet: '✋',
      train: '💪',
      walk: '🚶'
    };
    
    this.interactionLabels = {
      feed: '喂食',
      play: '游玩',
      pet: '抚摸',
      train: '训练',
      walk: '散步'
    };
    
    this.init();
  }
  
  async init() {
    this.render();
    await this.fetchFriendshipInfo();
    this.bindEvents();
  }
  
  render() {
    this.element = document.createElement('div');
    this.element.className = 'friendship-panel';
    this.element.innerHTML = `
      <div class="friendship-content">
        <div class="friendship-header">
          <h3>羁绊系统</h3>
          <button class="close-btn">×</button>
        </div>
        <div class="friendship-body">
          ${this.loading ? '<div class="loading">加载中...</div>' : this.renderContent()}
        </div>
      </div>
    `;
    
    this.container.appendChild(this.element);
  }
  
  renderContent() {
    if (!this.friendship) {
      return '<div class="error">无法加载羁绊信息</div>';
    }
    
    return `
      <div class="friendship-level">
        <div class="level-badge">
          <span class="level-number">${this.friendship.friendship_level}</span>
          <span class="level-name">${this.friendship.levelName}</span>
        </div>
        
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${this.friendship.progressToNextLevel}%"></div>
          <span class="progress-text">${this.friendship.friendship_value}/255</span>
        </div>
      </div>
      
      <div class="mood-indicator">
        <span class="mood-label">心情:</span>
        <span class="mood-value ${this.friendship.mood}">
          ${this.getMoodEmoji(this.friendship.mood)} ${this.friendship.mood}
        </span>
      </div>
      
      ${this.renderBattleBonuses()}
      
      <div class="interactions">
        <h4>互动</h4>
        <div class="interaction-buttons">
          ${Object.keys(this.interactionIcons).map(type => `
            <button class="interaction-btn" data-type="${type}">
              <span class="icon">${this.interactionIcons[type]}</span>
              <span class="label">${this.interactionLabels[type]}</span>
            </button>
          `).join('')}
        </div>
      </div>
      
      <div class="interaction-stats">
        <span>总互动次数: ${this.friendship.total_interactions}</span>
      </div>
    `;
  }
  
  renderBattleBonuses() {
    const bonuses = this.friendship.battleBonuses || {};
    const bonusItems = [];
    
    if (bonuses.critRateBonus > 0) {
      bonusItems.push(`
        <div class="bonus-item">
          <span>暴击率</span>
          <span class="bonus-value">+${(bonuses.critRateBonus * 100).toFixed(0)}%</span>
        </div>
      `);
    }
    
    if (bonuses.evasionRateBonus > 0) {
      bonusItems.push(`
        <div class="bonus-item">
          <span>闪避率</span>
          <span class="bonus-value">+${(bonuses.evasionRateBonus * 100).toFixed(0)}%</span>
        </div>
      `);
    }
    
    if (bonuses.statusResistBonus > 0) {
      bonusItems.push(`
        <div class="bonus-item">
          <span>状态抵抗</span>
          <span class="bonus-value">+${(bonuses.statusResistBonus * 100).toFixed(0)}%</span>
        </div>
      `);
    }
    
    if (bonuses.expBonus > 0) {
      bonusItems.push(`
        <div class="bonus-item">
          <span>经验加成</span>
          <span class="bonus-value">+${(bonuses.expBonus * 100).toFixed(0)}%</span>
        </div>
      `);
    }
    
    if (bonusItems.length === 0) {
      return '<div class="battle-bonuses empty"><p>提升羁绊等级解锁战斗加成</p></div>';
    }
    
    return `
      <div class="battle-bonuses">
        <h4>战斗加成</h4>
        ${bonusItems.join('')}
      </div>
    `;
  }
  
  async fetchFriendshipInfo() {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/pokemon/${this.pokemonId}/friendship`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-User-Id': localStorage.getItem('userId')
        }
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.friendship = data.data;
        this.loading = false;
        this.updateContent();
      } else {
        console.error('Failed to fetch friendship:', data.error);
        this.loading = false;
        this.updateContent();
      }
    } catch (error) {
      console.error('Failed to fetch friendship info:', error);
      this.loading = false;
      this.updateContent();
    }
  }
  
  updateContent() {
    const body = this.element.querySelector('.friendship-body');
    body.innerHTML = this.renderContent();
    this.bindInteractionButtons();
  }
  
  bindEvents() {
    // 关闭按钮
    this.element.querySelector('.close-btn').addEventListener('click', () => {
      this.close();
    });
    
    // 互动按钮
    this.bindInteractionButtons();
  }
  
  bindInteractionButtons() {
    const buttons = this.element.querySelectorAll('.interaction-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', async () => {
        const type = btn.dataset.type;
        await this.performInteraction(type);
      });
    });
  }
  
  async performInteraction(type) {
    if (this.interacting) return;
    
    this.interacting = type;
    const btn = this.element.querySelector(`.interaction-btn[data-type="${type}"]`);
    if (btn) {
      btn.classList.add('active');
      btn.disabled = true;
    }
    
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`/api/pokemon/${this.pokemonId}/friendship/interact`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-User-Id': localStorage.getItem('userId'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ interactionType: type })
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.friendship.friendship_value = data.data.newFriendshipValue;
        this.friendship.friendship_level = data.data.newLevel;
        this.friendship.mood = data.data.mood;
        this.friendship.total_interactions += 1;
        
        this.updateContent();
        
        if (data.data.levelUp) {
          this.showLevelUpAnimation(data.data.newLevel);
        }
        
        this.showToast(`羁绊值 +${data.data.friendshipGain}！`, 'success');
      } else {
        this.showToast(data.error, 'error');
      }
    } catch (error) {
      console.error('Interaction failed:', error);
      this.showToast('互动失败', 'error');
    } finally {
      this.interacting = null;
      if (btn) {
        btn.classList.remove('active');
        btn.disabled = false;
      }
    }
  }
  
  showLevelUpAnimation(level) {
    const overlay = document.createElement('div');
    overlay.className = 'level-up-overlay';
    overlay.innerHTML = `
      <div class="level-up-content">
        <div class="level-up-stars">⭐⭐⭐</div>
        <h2>羁绊等级提升！</h2>
        <div class="level-up-badge">
          <span class="level-number">${level}</span>
          <span class="level-name">${this.friendship.levelName}</span>
        </div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    setTimeout(() => {
      overlay.classList.add('fade-out');
      setTimeout(() => overlay.remove(), 500);
    }, 2000);
  }
  
  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
  
  getMoodEmoji(mood) {
    const emojis = {
      happy: '😊',
      excited: '🎉',
      neutral: '😐',
      sad: '😢',
      tired: '😴'
    };
    return emojis[mood] || '😐';
  }
  
  close() {
    this.element.classList.add('closing');
    setTimeout(() => {
      this.element.remove();
      if (this.onClose) {
        this.onClose();
      }
    }, 300);
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FriendshipPanel;
} else {
  window.FriendshipPanel = FriendshipPanel;
}
