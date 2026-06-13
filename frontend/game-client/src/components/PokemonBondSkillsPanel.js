/**
 * 精灵羁绊技能面板组件 - REQ-00151
 * 
 * 展示精灵可学习和已学习的羁绊技能
 */

class PokemonBondSkillsPanel {
  constructor(options = {}) {
    this.container = options.container || document.body;
    this.pokemonId = options.pokemonId;
    this.onLearn = options.onLearn;
    this.onForget = options.onForget;
    this.onActivate = options.onActivate;
    
    this.data = null;
    this.loading = false;
    
    // 亲密度等级名称
    this.FRIENDSHIP_LEVELS = {
      26: '认识',
      76: '熟悉',
      151: '挚友'
    };
    
    // 属性颜色
    this.TYPE_COLORS = {
      normal: '#A8A878',
      fire: '#F08030',
      water: '#6890F0',
      electric: '#F8D030',
      grass: '#78C850',
      ice: '#98D8D8',
      fighting: '#C03028',
      poison: '#A040A0',
      ground: '#E0C068',
      flying: '#A890F0',
      psychic: '#F85888',
      bug: '#A8B820',
      rock: '#B8A038',
      ghost: '#705898',
      dragon: '#7038F8',
      dark: '#705848',
      steel: '#B8B8D0',
      fairy: '#EE99AC'
    };
  }

  /**
   * 加载羁绊技能数据
   */
  async load() {
    this.loading = true;
    this._render();
    
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/bond-skills`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      if (!response.ok) {
        throw new Error('Failed to load bond skills');
      }
      
      const result = await response.json();
      this.data = result.data;
      this.loading = false;
      
      this._render();
      
    } catch (error) {
      console.error('Failed to load bond skills:', error);
      this.loading = false;
      this._renderError(error.message);
    }
  }

  /**
   * 渲染组件
   */
  _render() {
    const html = `
      <div class="bond-skills-panel" id="bond-skills-panel-${this.pokemonId}">
        <div class="bond-skills-header">
          <h3>羁绊技能</h3>
          <div class="friendship-info">
            <span class="friendship-label">亲密度:</span>
            <span class="friendship-value">${this.data?.friendship || 0}</span>
            <div class="friendship-bar">
              <div class="friendship-fill" style="width: ${((this.data?.friendship || 0) / 255 * 100)}%"></div>
            </div>
          </div>
        </div>
        
        ${this.loading ? this._renderLoading() : this._renderSkills()}
        
        <button class="bond-skills-close" onclick="this.closest('.bond-skills-panel').remove()">关闭</button>
      </div>
    `;
    
    // 移除旧面板
    const oldPanel = document.getElementById(`bond-skills-panel-${this.pokemonId}`);
    if (oldPanel) oldPanel.remove();
    
    // 插入新面板
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    this.container.appendChild(wrapper.firstElementChild);
    
    // 绑定事件
    this._bindEvents();
  }

  /**
   * 渲染加载状态
   */
  _renderLoading() {
    return `
      <div class="bond-skills-loading">
        <div class="spinner"></div>
        <p>加载中...</p>
      </div>
    `;
  }

  /**
   * 渲染技能列表
   */
  _renderSkills() {
    if (!this.data || !this.data.skills || this.data.skills.length === 0) {
      return `
        <div class="bond-skills-empty">
          <p>该精灵暂无羁绊技能</p>
        </div>
      `;
    }
    
    const skillsHtml = this.data.skills.map(skill => this._renderSkillCard(skill)).join('');
    
    return `
      <div class="bond-skills-list">
        ${skillsHtml}
      </div>
      <div class="bond-skills-summary">
        <span>已学习: ${this.data.learnedCount}/${this.data.maxSlots}</span>
        ${this.data.activeSkill ? `<span class="active-badge">战斗中: ${this.data.activeSkill.skill_name}</span>` : ''}
      </div>
    `;
  }

  /**
   * 渲染单个技能卡片
   */
  _renderSkillCard(skill) {
    const typeColor = this.TYPE_COLORS[skill.type] || '#888';
    const isUnlocked = skill.isUnlocked;
    const isLearned = skill.isLearned;
    
    // 状态徽章
    let statusBadge = '';
    if (!isUnlocked) {
      statusBadge = `<span class="skill-status locked">🔒 未解锁</span>`;
    } else if (isLearned) {
      statusBadge = `<span class="skill-status learned">✓ 已学习</span>`;
    } else {
      statusBadge = `<span class="skill-status available">可学习</span>`;
    }
    
    // 进度条（亲密度不足时显示）
    let progressHtml = '';
    if (!isUnlocked && skill.friendshipGap > 0) {
      const progress = (skill.friendshipCurrent / skill.friendshipRequired * 100);
      progressHtml = `
        <div class="skill-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${progress}%"></div>
          </div>
          <span class="progress-text">还需 ${skill.friendshipGap} 亲密度</span>
        </div>
      `;
    }
    
    // 操作按钮
    let actionButton = '';
    if (!isUnlocked) {
      actionButton = `<button class="skill-btn disabled" disabled>亲密度不足</button>`;
    } else if (isLearned) {
      actionButton = `
        <div class="skill-actions">
          <button class="skill-btn activate" data-skill-id="${skill.id}">激活</button>
          <button class="skill-btn forget danger" data-skill-id="${skill.id}">遗忘</button>
        </div>
      `;
    } else {
      actionButton = `<button class="skill-btn learn primary" data-skill-id="${skill.id}">学习</button>`;
    }
    
    return `
      <div class="skill-card ${isLearned ? 'learned' : ''} ${!isUnlocked ? 'locked' : ''}" data-skill-id="${skill.id}">
        <div class="skill-header">
          <div class="skill-type-badge" style="background: ${typeColor}">${skill.type}</div>
          <div class="skill-slot">槽位 ${skill.slot}</div>
          ${statusBadge}
        </div>
        
        <div class="skill-body">
          <h4 class="skill-name">${skill.name}</h4>
          <p class="skill-name-en">${skill.nameEn || ''}</p>
          
          <div class="skill-stats">
            ${skill.power ? `<span class="stat">威力: ${skill.power}</span>` : ''}
            ${skill.accuracy ? `<span class="stat">命中: ${skill.accuracy}%</span>` : ''}
            <span class="stat">PP: ${skill.pp}</span>
            <span class="stat">能量: ${skill.energyCost}</span>
          </div>
          
          <p class="skill-effect">${skill.effectDescription || ''}</p>
          
          <div class="skill-unlock-info">
            <span class="unlock-level">解锁等级: ${this.FRIENDSHIP_LEVELS[skill.friendshipRequired] || skill.friendshipRequired}</span>
          </div>
          
          ${progressHtml}
        </div>
        
        <div class="skill-footer">
          ${actionButton}
          ${isLearned ? `<span class="times-used">使用次数: ${skill.timesUsed || 0}</span>` : ''}
        </div>
      </div>
    `;
  }

  /**
   * 渲染错误状态
   */
  _renderError(message) {
    const html = `
      <div class="bond-skills-panel error">
        <div class="error-message">
          <p>加载失败: ${message}</p>
          <button onclick="this.closest('.bond-skills-panel').remove()">关闭</button>
        </div>
      </div>
    `;
    
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    this.container.appendChild(wrapper.firstElementChild);
  }

  /**
   * 绑定事件
   */
  _bindEvents() {
    const panel = document.getElementById(`bond-skills-panel-${this.pokemonId}`);
    if (!panel) return;
    
    // 学习按钮
    panel.querySelectorAll('.skill-btn.learn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const skillId = e.target.dataset.skillId;
        await this._handleLearn(skillId);
      });
    });
    
    // 遗忘按钮
    panel.querySelectorAll('.skill-btn.forget').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const skillId = e.target.dataset.skillId;
        await this._handleForget(skillId);
      });
    });
    
    // 激活按钮
    panel.querySelectorAll('.skill-btn.activate').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const skillId = e.target.dataset.skillId;
        await this._handleActivate(skillId);
      });
    });
  }

  /**
   * 处理学习技能
   */
  async _handleLearn(skillId) {
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/bond-skills/${skillId}/learn`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        }
      });
      
      const result = await response.json();
      
      if (result.success) {
        this._showToast('success', `成功学习羁绊技能: ${result.data.skill.name}`);
        await this.load(); // 重新加载
        
        if (this.onLearn) {
          this.onLearn(skillId, result.data);
        }
      } else {
        this._showToast('error', result.message || '学习失败');
      }
      
    } catch (error) {
      this._showToast('error', '学习失败: ' + error.message);
    }
  }

  /**
   * 处理遗忘技能
   */
  async _handleForget(skillId) {
    if (!confirm('确定要遗忘这个羁绊技能吗？可以重新学习。')) {
      return;
    }
    
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/bond-skills/${skillId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      const result = await response.json();
      
      if (result.success) {
        this._showToast('success', '羁绊技能已遗忘');
        await this.load(); // 重新加载
        
        if (this.onForget) {
          this.onForget(skillId);
        }
      } else {
        this._showToast('error', result.message || '遗忘失败');
      }
      
    } catch (error) {
      this._showToast('error', '遗忘失败: ' + error.message);
    }
  }

  /**
   * 处理激活技能
   */
  async _handleActivate(skillId) {
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/bond-skills/${skillId}/activate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        }
      });
      
      const result = await response.json();
      
      if (result.success) {
        this._showToast('success', '羁绊技能已激活，将在战斗中使用');
        await this.load(); // 重新加载
        
        if (this.onActivate) {
          this.onActivate(skillId);
        }
      } else {
        this._showToast('error', result.message || '激活失败');
      }
      
    } catch (error) {
      this._showToast('error', '激活失败: ' + error.message);
    }
  }

  /**
   * 显示提示消息
   */
  _showToast(type, message) {
    const toast = document.createElement('div');
    toast.className = `bond-skills-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  /**
   * 显示面板
   */
  async show() {
    await this.load();
  }

  /**
   * 销毁组件
   */
  destroy() {
    const panel = document.getElementById(`bond-skills-panel-${this.pokemonId}`);
    if (panel) panel.remove();
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PokemonBondSkillsPanel };
}
