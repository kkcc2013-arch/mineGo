/**
 * REQ-00046: 精灵培育系统 - 前端组件
 * 游戏客户端培育界面
 */

class BreedingCenter {
  constructor(gameClient) {
    this.gameClient = gameClient;
    this.container = null;
    this.centerData = null;
    this.selectedPokemon1 = null;
    this.selectedPokemon2 = null;
    this.refreshInterval = null;
  }

  /**
   * 初始化培育中心界面
   */
  async init() {
    // 创建容器
    this.container = document.createElement('div');
    this.container.id = 'breeding-center';
    this.container.className = 'breeding-center-container';
    
    // 加载培育中心数据
    await this.loadCenterData();
    
    // 渲染界面
    this.render();
    
    // 启动自动刷新（每分钟检查一次培育状态）
    this.refreshInterval = setInterval(() => {
      this.refreshStatus();
    }, 60000);

    return this.container;
  }

  /**
   * 加载培育中心数据
   */
  async loadCenterData() {
    try {
      const response = await this.gameClient.api.get('/breeding/center');
      this.centerData = response.data.data;
    } catch (error) {
      console.error('加载培育中心失败:', error);
      this.showError('无法加载培育中心数据');
    }
  }

  /**
   * 渲染界面
   */
  render() {
    if (!this.centerData) {
      this.container.innerHTML = '<div class="loading">加载中...</div>';
      return;
    }

    const { center, pairs } = this.centerData;

    this.container.innerHTML = `
      <div class="breeding-header">
        <h2>🥚 培育中心</h2>
        <div class="center-info">
          <span class="slots">槽位: ${pairs.filter(p => p.status !== 'cancelled').length}/${center.slots}</span>
          <button class="upgrade-btn" onclick="breedingCenter.upgradeCenter()">升级</button>
        </div>
      </div>
      
      <div class="breeding-slots">
        ${this.renderSlots(pairs, center.slots)}
      </div>
      
      <div class="breeding-actions">
        <button class="primary-btn" onclick="breedingCenter.showPokemonSelector()">
          开始培育
        </button>
        <button class="secondary-btn" onclick="breedingCenter.viewStats()">
          查看统计
        </button>
      </div>
      
      <div class="hatching-incubators">
        <h3>🔥 孵化器</h3>
        ${this.renderHatchingIncubators()}
      </div>
    `;

    this.attachEventListeners();
  }

  /**
   * 渲染培育槽位
   */
  renderSlots(pairs, maxSlots) {
    let html = '';
    
    for (let i = 0; i < maxSlots; i++) {
      const pair = pairs.find(p => p.slot_index === i);
      
      if (pair) {
        html += this.renderActiveSlot(pair);
      } else {
        html += this.renderEmptySlot(i);
      }
    }
    
    return html;
  }

  /**
   * 渲染活跃的培育槽
   */
  renderActiveSlot(pair) {
    const now = new Date();
    const readyAt = new Date(pair.ready_at);
    const isReady = pair.status === 'ready' || now >= readyAt;
    const timeRemaining = Math.max(0, readyAt - now);
    
    return `
      <div class="breeding-slot active ${isReady ? 'ready' : ''}" data-pair-id="${pair.id}">
        <div class="parents">
          <div class="parent">
            <img src="/assets/pokemon/${pair.parent1_species_id}.png" alt="${pair.parent1_name}">
            <span>${pair.parent1_name}</span>
          </div>
          <div class="heart">❤️</div>
          <div class="parent">
            <img src="/assets/pokemon/${pair.parent2_species_id}.png" alt="${pair.parent2_name}">
            <span>${pair.parent2_name}</span>
          </div>
        </div>
        
        ${isReady ? `
          <div class="egg-ready">
            <div class="egg-icon">🥚</div>
            <button class="collect-btn" onclick="breedingCenter.collectEgg('${pair.id}')">
              收集蛋
            </button>
          </div>
        ` : `
          <div class="progress">
            <div class="progress-bar" style="width: ${this.calculateProgress(pair)}%"></div>
            <span class="time-remaining">${this.formatTime(timeRemaining)}</span>
          </div>
        `}
        
        <button class="cancel-btn" onclick="breedingCenter.cancelBreeding('${pair.id}')">
          取消
        </button>
      </div>
    `;
  }

  /**
   * 渲染空槽位
   */
  renderEmptySlot(index) {
    return `
      <div class="breeding-slot empty" data-slot="${index}">
        <div class="empty-icon">➕</div>
        <span>空槽位 ${index + 1}</span>
      </div>
    `;
  }

  /**
   * 渲染孵化器
   */
  renderHatchingIncubators() {
    // 这里应该显示正在孵化的蛋
    // 实际实现需要从后端获取孵化数据
    return `
      <div class="incubator">
        <p>没有正在孵化的蛋</p>
        <p class="hint">培育获得的蛋会自动放入孵化器</p>
      </div>
    `;
  }

  /**
   * 显示精灵选择器
   */
  showPokemonSelector() {
    const modal = document.createElement('div');
    modal.className = 'modal pokemon-selector-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="modal-header">
          <h3>选择培育精灵</h3>
          <button class="close-btn" onclick="this.closest('.modal').remove()">✕</button>
        </div>
        
        <div class="modal-body">
          <div class="parent-selection">
            <div class="parent-slot" id="parent1-slot">
              <h4>父母 1</h4>
              <div class="selected-pokemon" onclick="breedingCenter.selectPokemon(1)">
                ${this.selectedPokemon1 ? `
                  <img src="/assets/pokemon/${this.selectedPokemon1.species_id}.png">
                  <span>${this.selectedPokemon1.nickname || this.selectedPokemon1.name}</span>
                ` : `
                  <div class="empty">点击选择</div>
                `}
              </div>
            </div>
            
            <div class="parent-slot" id="parent2-slot">
              <h4>父母 2</h4>
              <div class="selected-pokemon" onclick="breedingCenter.selectPokemon(2)">
                ${this.selectedPokemon2 ? `
                  <img src="/assets/pokemon/${this.selectedPokemon2.species_id}.png">
                  <span>${this.selectedPokemon2.nickname || this.selectedPokemon2.name}</span>
                ` : `
                  <div class="empty">点击选择</div>
                `}
              </div>
            </div>
          </div>
          
          <div class="breeding-preview" id="breeding-preview"></div>
          
          <div class="pokemon-list" id="pokemon-list">
            加载中...
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="primary-btn" onclick="breedingCenter.confirmBreeding()">
            开始培育
          </button>
          <button class="secondary-btn" onclick="this.closest('.modal').remove()">
            取消
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.loadPokemonList();
  }

  /**
   * 加载精灵列表
   */
  async loadPokemonList() {
    try {
      const response = await this.gameClient.api.get('/pokemon?userId=' + this.gameClient.userId);
      const pokemon = response.data.data.pokemon;

      const listEl = document.getElementById('pokemon-list');
      listEl.innerHTML = pokemon.map(p => `
        <div class="pokemon-item" onclick="breedingCenter.selectForBreeding('${p.id}')">
          <img src="/assets/pokemon/${p.species_id}.png">
          <div class="info">
            <span class="name">${p.nickname || p.name}</span>
            <span class="gender">${p.gender === 'male' ? '♂' : p.gender === 'female' ? '♀' : '?'}</span>
            <span class="cp">CP ${p.cp}</span>
          </div>
        </div>
      `).join('');
    } catch (error) {
      console.error('加载精灵列表失败:', error);
    }
  }

  /**
   * 选择精灵用于培育
   */
  async selectForBreeding(pokemonId) {
    const pokemon = this.centerData.availablePokemon.find(p => p.id === pokemonId);
    
    if (!this.selectedPokemon1) {
      this.selectedPokemon1 = pokemon;
      this.updatePokemonSelector();
    } else if (!this.selectedPokemon2) {
      this.selectedPokemon2 = pokemon;
      this.updatePokemonSelector();
      await this.checkBreedingCompatibility();
    }
  }

  /**
   * 检查培育兼容性
   */
  async checkBreedingCompatibility() {
    if (!this.selectedPokemon1 || !this.selectedPokemon2) {
      return;
    }

    try {
      const response = await this.gameClient.api.post('/breeding/check', {
        parent1Id: this.selectedPokemon1.id,
        parent2Id: this.selectedPokemon2.id
      });

      const previewEl = document.getElementById('breeding-preview');
      
      if (response.data.data.canBreed) {
        previewEl.innerHTML = `
          <div class="compatible">
            <span class="success">✅ 可以培育</span>
            <span class="time">预计时间: ${response.data.data.breedingTime} 小时</span>
          </div>
        `;
      } else {
        previewEl.innerHTML = `
          <div class="incompatible">
            <span class="error">❌ ${response.data.data.reason}</span>
          </div>
        `;
      }
    } catch (error) {
      console.error('检查兼容性失败:', error);
    }
  }

  /**
   * 确认培育
   */
  async confirmBreeding() {
    if (!this.selectedPokemon1 || !this.selectedPokemon2) {
      alert('请选择两只精灵');
      return;
    }

    try {
      const response = await this.gameClient.api.post('/breeding/start', {
        parent1Id: this.selectedPokemon1.id,
        parent2Id: this.selectedPokemon2.id,
        slotIndex: this.findEmptySlot()
      });

      if (response.data.success) {
        alert('培育已开始！');
        document.querySelector('.pokemon-selector-modal').remove();
        await this.loadCenterData();
        this.render();
      }
    } catch (error) {
      alert('培育失败: ' + error.response?.data?.error || error.message);
    }
  }

  /**
   * 收集蛋
   */
  async collectEgg(pairId) {
    try {
      const response = await this.gameClient.api.post(`/breeding/collect/${pairId}`);
      
      if (response.data.success) {
        const pokemon = response.data.data.pokemon;
        alert(`获得精灵蛋！\n物种: ${pokemon.species_id}\n闪光: ${pokemon.is_shiny ? '是' : '否'}`);
        await this.loadCenterData();
        this.render();
      }
    } catch (error) {
      alert('收集失败: ' + error.response?.data?.error || error.message);
    }
  }

  /**
   * 取消培育
   */
  async cancelBreeding(pairId) {
    if (!confirm('确定要取消培育吗？')) {
      return;
    }

    try {
      const response = await this.gameClient.api.post(`/breeding/cancel/${pairId}`);
      
      if (response.data.success) {
        alert('培育已取消');
        await this.loadCenterData();
        this.render();
      }
    } catch (error) {
      alert('取消失败: ' + error.response?.data?.error || error.message);
    }
  }

  /**
   * 升级培育中心
   */
  async upgradeCenter() {
    if (!confirm('升级培育中心需要消耗资源，确定要升级吗？')) {
      return;
    }

    try {
      const response = await this.gameClient.api.post('/breeding/upgrade');
      
      if (response.data.success) {
        alert('升级成功！新槽位数: ' + response.data.data.slots);
        await this.loadCenterData();
        this.render();
      }
    } catch (error) {
      alert('升级失败: ' + error.response?.data?.error || error.message);
    }
  }

  /**
   * 查看统计
   */
  async viewStats() {
    try {
      const response = await this.gameClient.api.get('/breeding/stats');
      const stats = response.data.data;

      const modal = document.createElement('div');
      modal.className = 'modal stats-modal';
      modal.innerHTML = `
        <div class="modal-content">
          <div class="modal-header">
            <h3>培育统计</h3>
            <button class="close-btn" onclick="this.closest('.modal').remove()">✕</button>
          </div>
          
          <div class="modal-body">
            <div class="stat-item">
              <label>总培育次数</label>
              <span>${stats.total_breeds}</span>
            </div>
            <div class="stat-item">
              <label>已孵化蛋数</label>
              <span>${stats.total_eggs_hatched}</span>
            </div>
            <div class="stat-item">
              <label>完美个体值精灵</label>
              <span>${stats.perfect_iv_breeds}</span>
            </div>
            <div class="stat-item">
              <label>闪光精灵</label>
              <span>${stats.shiny_breeds}</span>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);
    } catch (error) {
      console.error('获取统计失败:', error);
    }
  }

  /**
   * 计算培育进度
   */
  calculateProgress(pair) {
    const now = new Date();
    const started = new Date(pair.started_at);
    const ready = new Date(pair.ready_at);
    
    const total = ready - started;
    const elapsed = now - started;
    
    return Math.min(100, (elapsed / total) * 100);
  }

  /**
   * 格式化剩余时间
   */
  formatTime(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    
    if (hours > 0) {
      return `${hours}小时${minutes}分钟`;
    }
    return `${minutes}分钟`;
  }

  /**
   * 查找空槽位
   */
  findEmptySlot() {
    const usedSlots = this.centerData.pairs.map(p => p.slot_index);
    for (let i = 0; i < this.centerData.center.slots; i++) {
      if (!usedSlots.includes(i)) {
        return i;
      }
    }
    return 0;
  }

  /**
   * 刷新状态
   */
  async refreshStatus() {
    await this.loadCenterData();
    this.render();
  }

  /**
   * 显示错误
   */
  showError(message) {
    this.container.innerHTML = `
      <div class="error">
        <p>${message}</p>
        <button onclick="breedingCenter.init()">重试</button>
      </div>
    `;
  }

  /**
   * 销毁
   */
  destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    if (this.container) {
      this.container.remove();
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BreedingCenter;
} else {
  window.BreedingCenter = BreedingCenter;
}
