/**
 * REQ-00079: 精灵好感度面板组件
 * 显示好感度数值、等级、战斗加成，支持互动操作
 */

class FriendshipPanel {
  constructor(options = {}) {
    this.pokemonId = options.pokemonId;
    this.container = options.container || document.body;
    this.onClose = options.onClose || (() => {});
    this.onEvolution = options.onEvolution || (() => {});
    
    this.friendship = null;
    this.interactions = [];
    this.loading = true;
    this.interacting = false;
    
    this.element = null;
    this.init();
  }

  async init() {
    this.render();
    await this.fetchFriendship();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'friendship-panel-overlay';
    this.element.innerHTML = `
      <div class="friendship-panel">
        <div class="friendship-header">
          <h2>💕 好感度</h2>
          <button class="close-btn" aria-label="关闭">×</button>
        </div>
        
        <div class="friendship-content">
          <div class="friendship-loading">加载中...</div>
        </div>
      </div>
    `;
    
    this.element.querySelector('.close-btn').addEventListener('click', () => this.close());
    this.element.addEventListener('click', (e) => {
      if (e.target === this.element) this.close();
    });
    
    this.container.appendChild(this.element);
  }

  async fetchFriendship() {
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/friendship`, {
        headers: { 'X-User-Id': this.getUserId() }
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.friendship = data.data;
        this.renderContent();
      } else {
        this.renderError(data.message || '获取好感度失败');
      }
    } catch (error) {
      console.error('Failed to fetch friendship:', error);
      this.renderError('网络错误，请重试');
    } finally {
      this.loading = false;
    }
  }

  renderContent() {
    const content = this.element.querySelector('.friendship-content');
    const f = this.friendship;
    const progressPercent = (f.friendship_value / 255) * 100;
    
    content.innerHTML = `
      <div class="friendship-display">
        <div class="friendship-emoji">
          ${f.levelInfo?.emoji || '🙂'}
        </div>
        
        <div class="friendship-value-section">
          <div class="friendship-value">
            <span class="value">${f.friendship_value}</span>
            <span class="max">/ 255</span>
          </div>
          
          <div class="friendship-level">
            <span class="level-badge ${f.friendship_level}">
              ${f.levelInfo?.label || '一般'}
            </span>
          </div>
        </div>
        
        <div class="friendship-progress">
          <div class="progress-bar" style="width: ${progressPercent}%"></div>
          <div class="progress-markers">
            <span class="marker" style="left: 19.6%">50</span>
            <span class="marker" style="left: 39.2%">100</span>
            <span class="marker" style="left: 58.8%">150</span>
            <span class="marker" style="left: 78.4%">200</span>
          </div>
        </div>
      </div>
      
      ${f.evolutionReady ? `
        <div class="evolution-ready">
          <span class="evolution-icon">✨</span>
          <span>可进行亲密度进化！</span>
          <button class="evolve-btn">进化</button>
        </div>
      ` : ''}
      
      <div class="battle-bonuses">
        <h3>⚔️ 战斗加成</h3>
        <div class="bonus-grid">
          <div class="bonus-item">
            <span class="bonus-label">暴击率</span>
            <span class="bonus-value">+${((f.battleBonuses?.critBonus || 0) * 100).toFixed(0)}%</span>
          </div>
          <div class="bonus-item">
            <span class="bonus-label">回避率</span>
            <span class="bonus-value">+${((f.battleBonuses?.evasionBonus || 0) * 100).toFixed(0)}%</span>
          </div>
          <div class="bonus-item">
            <span class="bonus-label">坚持几率</span>
            <span class="bonus-value">${((f.battleBonuses?.persistChance || 0) * 100).toFixed(0)}%</span>
          </div>
        </div>
      </div>
      
      <div class="interactions-section">
        <h3>🎮 互动</h3>
        <div class="interaction-buttons">
          <button class="interaction-btn" data-type="touch">
            <span class="icon">👆</span>
            <span class="label">抚摸</span>
            <span class="hint">+1</span>
          </button>
          <button class="interaction-btn" data-type="massage">
            <span class="icon">💆</span>
            <span class="label">按摩</span>
            <span class="hint">+8</span>
          </button>
          <button class="interaction-btn" data-type="camping">
            <span class="icon">🏕️</span>
            <span class="label">露营</span>
            <span class="hint">+4</span>
          </button>
          <button class="interaction-btn" data-type="spa">
            <span class="icon">🧖</span>
            <span class="label">SPA</span>
            <span class="hint">+10</span>
          </button>
          <button class="interaction-btn" data-type="feed_berry">
            <span class="icon">🫐</span>
            <span class="label">喂食</span>
            <span class="hint">+3</span>
          </button>
        </div>
      </div>
      
      <div class="friendship-stats">
        <div class="stat-item">
          <span class="stat-label">相伴天数</span>
          <span class="stat-value">${f.days_with_trainer || 0}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">互动次数</span>
          <span class="stat-value">${f.total_interactions || 0}</span>
        </div>
      </div>
    `;
    
    // 绑定事件
    this.bindEvents();
  }

  bindEvents() {
    // 互动按钮
    const buttons = this.element.querySelectorAll('.interaction-btn');
    buttons.forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        this.handleInteract(type, btn);
      });
    });
    
    // 进化按钮
    const evolveBtn = this.element.querySelector('.evolve-btn');
    if (evolveBtn) {
      evolveBtn.addEventListener('click', () => this.handleEvolve());
    }
  }

  async handleInteract(type, btn) {
    if (this.interacting) return;
    this.interacting = true;
    
    btn.classList.add('loading');
    
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/interact`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': this.getUserId()
        },
        body: JSON.stringify({ type })
      });
      
      const data = await response.json();
      
      if (data.success) {
        // 更新好感度显示
        this.friendship.friendship_value = data.data.after;
        this.friendship.friendship_level = data.data.level;
        this.friendship.levelInfo = data.data.levelInfo;
        
        // 显示动画效果
        this.showInteractionEffect(data.data);
        
        // 重新渲染
        this.renderContent();
        
        // 显示成功消息
        this.showToast(data.data.message, 'success');
      } else {
        this.showToast(data.message || '互动失败', 'error');
      }
    } catch (error) {
      console.error('Interaction failed:', error);
      this.showToast('网络错误', 'error');
    } finally {
      this.interacting = false;
      btn.classList.remove('loading');
    }
  }

  async handleEvolve() {
    if (!confirm('确定要让这只精灵进化吗？')) return;
    
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/evolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': this.getUserId()
        }
      });
      
      const data = await response.json();
      
      if (data.success) {
        this.showToast(data.data.message, 'success');
        this.onEvolution(data.data);
        this.close();
      } else {
        this.showToast(data.message || '进化失败', 'error');
      }
    } catch (error) {
      console.error('Evolution failed:', error);
      this.showToast('网络错误', 'error');
    }
  }

  showInteractionEffect(result) {
    const valueEl = this.element.querySelector('.friendship-value .value');
    if (!valueEl) return;
    
    const effect = document.createElement('div');
    effect.className = `friendship-effect ${result.change > 0 ? 'positive' : 'negative'}`;
    effect.textContent = `${result.change > 0 ? '+' : ''}${result.change}`;
    valueEl.parentElement.appendChild(effect);
    
    // 添加升级动画
    if (result.levelUp) {
      this.showToast(`好感度提升至「${result.levelInfo.label}」！`, 'success');
    }
    
    setTimeout(() => effect.remove(), 2000);
  }

  renderError(message) {
    const content = this.element.querySelector('.friendship-content');
    content.innerHTML = `
      <div class="friendship-error">
        <span class="error-icon">😢</span>
        <p>${message}</p>
        <button class="retry-btn">重试</button>
      </div>
    `;
    
    content.querySelector('.retry-btn').addEventListener('click', () => {
      this.loading = true;
      this.fetchFriendship();
    });
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `friendship-toast ${type}`;
    toast.textContent = message;
    this.element.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  getUserId() {
    return localStorage.getItem('userId') || sessionStorage.getItem('userId') || 'anonymous';
  }

  close() {
    if (this.element) {
      this.element.classList.add('closing');
      setTimeout(() => {
        this.element.remove();
        this.onClose();
      }, 300);
    }
  }

  destroy() {
    this.close();
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FriendshipPanel;
}

// 全局注册
if (typeof window !== 'undefined') {
  window.FriendshipPanel = FriendshipPanel;
}
