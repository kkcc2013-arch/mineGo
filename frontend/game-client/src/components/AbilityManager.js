/**
 * REQ-00086: 精灵特性管理前端组件
 * 实现特性查看、切换、解锁的 UI 界面
 */

class AbilityManager {
  constructor(options = {}) {
    this.pokemonId = options.pokemonId;
    this.container = options.container || document.body;
    this.onClose = options.onClose || (() => {});
    this.apiBase = options.apiBase || '/api/pokemon';
    this.token = localStorage.getItem('token');
    
    this.abilities = [];
    this.loading = false;
    this.switching = false;
    
    this.init();
  }

  async init() {
    this.render();
    await this.fetchAbilities();
  }

  render() {
    this.container.innerHTML = `
      <div class="ability-manager" id="ability-manager">
        <div class="ability-manager-header">
          <h2>特性管理</h2>
          <button class="close-btn" id="ability-close-btn">×</button>
        </div>
        <div class="ability-manager-content" id="ability-content">
          <div class="loading">加载中...</div>
        </div>
      </div>
    `;

    // Bind events
    document.getElementById('ability-close-btn').addEventListener('click', () => {
      this.onClose();
    });

    this.addStyles();
  }

  addStyles() {
    if (document.getElementById('ability-manager-styles')) return;

    const styles = document.createElement('style');
    styles.id = 'ability-manager-styles';
    styles.textContent = `
      .ability-manager {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 90%;
        max-width: 600px;
        max-height: 80vh;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
        z-index: 10000;
        overflow: hidden;
      }

      .ability-manager-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.05);
      }

      .ability-manager-header h2 {
        margin: 0;
        color: #fff;
        font-size: 20px;
      }

      .close-btn {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
        font-size: 20px;
        cursor: pointer;
        transition: all 0.2s;
      }

      .close-btn:hover {
        background: rgba(255, 255, 255, 0.2);
      }

      .ability-manager-content {
        padding: 20px;
        max-height: calc(80vh - 80px);
        overflow-y: auto;
      }

      .loading {
        text-align: center;
        color: #fff;
        padding: 40px;
      }

      .ability-section {
        margin-bottom: 24px;
      }

      .ability-section h3 {
        color: #4fc3f7;
        font-size: 16px;
        margin-bottom: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .ability-section.hidden-ability h3 {
        color: #ffd54f;
      }

      .ability-card {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 12px;
        padding: 16px;
        margin-bottom: 12px;
        border: 2px solid transparent;
        transition: all 0.2s;
        cursor: pointer;
        position: relative;
      }

      .ability-card:hover {
        background: rgba(255, 255, 255, 0.1);
        border-color: rgba(79, 195, 247, 0.3);
      }

      .ability-card.active {
        border-color: #4fc3f7;
        background: rgba(79, 195, 247, 0.1);
      }

      .ability-card.hidden {
        border-color: #ffd54f;
        background: rgba(255, 213, 79, 0.05);
      }

      .ability-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 8px;
      }

      .ability-name {
        color: #fff;
        font-size: 18px;
        font-weight: bold;
      }

      .ability-name-en {
        color: rgba(255, 255, 255, 0.5);
        font-size: 12px;
        margin-left: 8px;
      }

      .ability-type-badge {
        padding: 4px 12px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: bold;
        text-transform: uppercase;
      }

      .ability-type-badge.passive { background: #4caf50; }
      .ability-type-badge.trigger { background: #ff9800; }
      .ability-type-badge.environment { background: #2196f3; }
      .ability-type-badge.immunity { background: #9c27b0; }
      .ability-type-badge.transformation { background: #e91e63; }

      .ability-description {
        color: rgba(255, 255, 255, 0.7);
        font-size: 14px;
        line-height: 1.5;
        margin-bottom: 12px;
      }

      .active-badge {
        position: absolute;
        top: 12px;
        right: 12px;
        background: #4fc3f7;
        color: #fff;
        padding: 4px 12px;
        border-radius: 12px;
        font-size: 11px;
        font-weight: bold;
      }

      .ability-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }

      .switch-btn, .activate-btn, .unlock-btn {
        flex: 1;
        padding: 10px;
        border-radius: 8px;
        border: none;
        font-size: 14px;
        font-weight: bold;
        cursor: pointer;
        transition: all 0.2s;
      }

      .switch-btn {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .switch-btn:hover {
        background: rgba(255, 255, 255, 0.2);
      }

      .switch-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .activate-btn {
        background: #4caf50;
        color: #fff;
      }

      .activate-btn:hover {
        background: #45a049;
      }

      .unlock-btn {
        background: #ffd54f;
        color: #333;
      }

      .unlock-btn:hover {
        background: #ffca28;
      }

      .error-message {
        background: rgba(244, 67, 54, 0.1);
        border: 1px solid #f44336;
        color: #f44336;
        padding: 12px;
        border-radius: 8px;
        margin-top: 12px;
        text-align: center;
      }

      .success-message {
        background: rgba(76, 175, 80, 0.1);
        border: 1px solid #4caf50;
        color: #4caf50;
        padding: 12px;
        border-radius: 8px;
        margin-top: 12px;
        text-align: center;
      }
    `;

    document.head.appendChild(styles);
  }

  async fetchAbilities() {
    this.loading = true;

    try {
      const response = await fetch(`${this.apiBase}/${this.pokemonId}/abilities`, {
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      const data = await response.json();

      if (data.success) {
        this.abilities = data.data;
        this.renderAbilities();
      } else {
        this.showError(data.error || '获取特性失败');
      }
    } catch (error) {
      console.error('Failed to fetch abilities:', error);
      this.showError('网络错误，请稍后重试');
    } finally {
      this.loading = false;
    }
  }

  renderAbilities() {
    const content = document.getElementById('ability-content');
    const normalAbilities = this.abilities.filter(a => !a.is_hidden);
    const hiddenAbility = this.abilities.find(a => a.is_hidden);

    content.innerHTML = `
      <div class="ability-section">
        <h3>
          <span>🎯</span>
          <span>普通特性</span>
        </h3>
        ${normalAbilities.map(ability => this.renderAbilityCard(ability)).join('')}
      </div>

      ${hiddenAbility ? `
        <div class="ability-section hidden-ability">
          <h3>
            <span>⭐</span>
            <span>隐藏特性</span>
          </h3>
          ${this.renderAbilityCard(hiddenAbility)}
        </div>
      ` : ''}
    `;

    // Bind switch buttons
    content.querySelectorAll('.switch-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const slot = parseInt(e.target.dataset.slot);
        this.handleSwitchAbility(slot);
      });
    });

    // Bind unlock button
    content.querySelectorAll('.unlock-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.handleUnlockHidden();
      });
    });

    // Bind activate button
    content.querySelectorAll('.activate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.handleActivateHidden();
      });
    });
  }

  renderAbilityCard(ability) {
    const typeClass = ability.type || 'passive';
    const cardClass = ability.is_hidden ? 'hidden' : '';
    const activeClass = ability.is_active ? 'active' : '';

    return `
      <div class="ability-card ${cardClass} ${activeClass}">
        ${ability.is_active ? '<span class="active-badge">激活中</span>' : ''}
        
        <div class="ability-header">
          <div>
            <span class="ability-name">${ability.name_zh || ability.nameZh}</span>
            <span class="ability-name-en">${ability.name_en || ability.nameEn}</span>
          </div>
          <span class="ability-type-badge ${typeClass}">${this.getTypeLabel(ability.type)}</span>
        </div>
        
        <div class="ability-description">
          ${ability.description}
        </div>

        ${!ability.is_active && !ability.is_hidden ? `
          <div class="ability-actions">
            <button class="switch-btn" data-slot="${ability.slot}" ${this.switching ? 'disabled' : ''}>
              切换为此特性
            </button>
          </div>
        ` : ''}

        ${ability.is_hidden && !ability.unlocked_at && !ability.is_active ? `
          <div class="ability-actions">
            <button class="unlock-btn" ${this.switching ? 'disabled' : ''}>
              解锁隐藏特性（需要特性胶囊）
            </button>
          </div>
        ` : ''}

        ${ability.is_hidden && ability.unlocked_at && !ability.is_active ? `
          <div class="ability-actions">
            <button class="activate-btn" ${this.switching ? 'disabled' : ''}>
              激活此特性
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  getTypeLabel(type) {
    const labels = {
      passive: '被动',
      trigger: '触发',
      environment: '环境',
      immunity: '免疫',
      transformation: '转换'
    };
    return labels[type] || type;
  }

  async handleSwitchAbility(targetSlot) {
    if (this.switching) return;

    this.switching = true;
    this.showMessage('正在切换特性...', 'loading');

    try {
      const response = await fetch(`${this.apiBase}/${this.pokemonId}/abilities/switch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ targetSlot })
      });

      const data = await response.json();

      if (data.success) {
        this.showMessage('特性切换成功！', 'success');
        await this.fetchAbilities();
      } else {
        this.showError(data.error || '切换失败');
      }
    } catch (error) {
      console.error('Failed to switch ability:', error);
      this.showError('网络错误，请稍后重试');
    } finally {
      this.switching = false;
    }
  }

  async handleUnlockHidden() {
    if (!confirm('确定要解锁隐藏特性吗？这需要消耗特性胶囊道具。')) {
      return;
    }

    this.switching = true;
    this.showMessage('正在解锁...', 'loading');

    try {
      const response = await fetch(`${this.apiBase}/${this.pokemonId}/abilities/unlock-hidden`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`
        }
      });

      const data = await response.json();

      if (data.success) {
        this.showMessage(`成功解锁隐藏特性：${data.ability.nameZh || data.ability.name_zh}`, 'success');
        await this.fetchAbilities();
      } else {
        this.showError(data.error || '解锁失败');
      }
    } catch (error) {
      console.error('Failed to unlock hidden ability:', error);
      this.showError('网络错误，请稍后重试');
    } finally {
      this.switching = false;
    }
  }

  async handleActivateHidden() {
    this.switching = true;
    this.showMessage('正在激活...', 'loading');

    try {
      const response = await fetch(`${this.apiBase}/${this.pokemonId}/abilities/switch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ targetSlot: 3 })
      });

      const data = await response.json();

      if (data.success) {
        this.showMessage('隐藏特性已激活！', 'success');
        await this.fetchAbilities();
      } else {
        this.showError(data.error || '激活失败');
      }
    } catch (error) {
      console.error('Failed to activate hidden ability:', error);
      this.showError('网络错误，请稍后重试');
    } finally {
      this.switching = false;
    }
  }

  showMessage(message, type = 'info') {
    const content = document.getElementById('ability-content');
    const existing = content.querySelector('.message');
    if (existing) existing.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${type}-message`;
    msgDiv.textContent = message;
    msgDiv.style.cssText = `
      padding: 12px;
      margin-top: 12px;
      border-radius: 8px;
      text-align: center;
      background: ${type === 'success' ? 'rgba(76, 175, 80, 0.1)' : 'rgba(33, 150, 243, 0.1)'};
      border: 1px solid ${type === 'success' ? '#4caf50' : '#2196f3'};
      color: ${type === 'success' ? '#4caf50' : '#2196f3'};
    `;

    content.insertBefore(msgDiv, content.firstChild);

    setTimeout(() => msgDiv.remove(), 3000);
  }

  showError(message) {
    const content = document.getElementById('ability-content');
    const existing = content.querySelector('.error-message');
    if (existing) existing.remove();

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    content.insertBefore(errorDiv, content.firstChild);

    setTimeout(() => errorDiv.remove(), 5000);
  }

  destroy() {
    const manager = document.getElementById('ability-manager');
    if (manager) {
      manager.remove();
    }
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AbilityManager;
} else {
  window.AbilityManager = AbilityManager;
}
