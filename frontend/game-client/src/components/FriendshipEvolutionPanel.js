// game-client/src/components/FriendshipEvolutionPanel.js
'use strict';

/**
 * 精灵亲密度进化面板组件
 * REQ-00210: 精灵亲密度进化计算与提示系统
 */

class FriendshipEvolutionPanel {
  constructor(options) {
    this.container = options.container;
    this.pokemonId = options.pokemonId;
    this.api = options.api;
    this.state = {
      status: null,
      suggestions: [],
      history: [],
      loading: true,
      error: null
    };
  }

  async load() {
    try {
      this.setState({ loading: true });
      
      const [statusRes, progressRes] = await Promise.all([
        this.api.get(`/pokemon/${this.pokemonId}/friendship`),
        this.api.get(`/pokemon/${this.pokemonId}/friendship/evolution-progress`)
      ]);

      this.setState({
        status: statusRes.data,
        suggestions: progressRes.data.suggestions,
        loading: false
      });

      this.render();
    } catch (err) {
      console.error('Failed to load friendship data:', err);
      this.setState({ loading: false, error: err.message });
      this.render();
    }
  }

  async loadHistory() {
    try {
      const res = await this.api.get(`/pokemon/${this.pokemonId}/friendship/history?limit=10`);
      this.setState({ history: res.data.history });
      this.renderHistoryModal();
    } catch (err) {
      console.error('Failed to load history:', err);
      this.showError('加载历史记录失败');
    }
  }

  async showEvolutionPreview() {
    try {
      const res = await this.api.post(`/pokemon/${this.pokemonId}/friendship/evolution-preview`);
      this.renderEvolutionModal(res.data);
    } catch (err) {
      console.error('Failed to load preview:', err);
      this.showError('加载进化预览失败');
    }
  }

  setState(newState) {
    this.state = { ...this.state, ...newState };
  }

  showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'toast-error';
    errorEl.textContent = message;
    document.body.appendChild(errorEl);
    setTimeout(() => errorEl.remove(), 3000);
  }

  render() {
    const { status, suggestions, loading, error } = this.state;

    if (loading) {
      this.container.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>加载中...</p></div>';
      return;
    }

    if (error) {
      this.container.innerHTML = `<div class="error-message"><span class="icon">❌</span>${error}</div>`;
      return;
    }

    const progress = status?.evolutionProgress || {};
    const level = status?.friendshipLevel || { label: '未知', color: '#999' };

    this.container.innerHTML = `
      <div class="friendship-evolution-panel">
        <div class="friendship-header">
          <h3>💝 亲密度状态</h3>
          <div class="friendship-level-badge" style="background: ${level.color}">
            ${level.label}
          </div>
        </div>

        <div class="friendship-progress-section">
          <div class="progress-bar-container">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progress.percentage || 0}%"></div>
            </div>
            <div class="progress-text">
              <span class="current">${status?.friendship || 0}</span>
              <span class="separator">/</span>
              <span class="target">${progress.requiredFriendship || '-'}</span>
            </div>
          </div>
        </div>

        ${progress.hasEvolution ? `
          <div class="evolution-status ${progress.ready ? 'ready' : 'not-ready'}">
            <span class="status-icon">${progress.ready ? '✨' : '🔒'}</span>
            <div class="status-content">
              <span class="status-text">
                ${progress.ready ? '可进化为 ' + progress.targetSpecies : 
                  `距离进化还需 ${progress.needed} 亲密度`}
              </span>
              ${progress.timeRestriction ? `
                <div class="time-restriction ${progress.timeReady ? 'ready' : 'waiting'}">
                  <span class="time-icon">${progress.timeRestriction === 'day' ? '☀️' : '🌙'}</span>
                  <span>${progress.timeRestriction === 'day' ? '白天进化' : '夜晚进化'}</span>
                  ${!progress.timeReady ? '<span class="waiting-text">（时间未到）</span>' : ''}
                </div>
              ` : ''}
            </div>
          </div>
          
          <button class="btn btn-primary btn-evolution-preview" id="btn-preview">
            🔮 预览进化结果
          </button>
        ` : `
          <div class="no-evolution-notice">
            <span class="icon">ℹ️</span>
            <span>该精灵无法通过亲密度进化</span>
          </div>
        `}

        ${suggestions.suggestions?.length > 0 ? `
          <div class="suggestions-section">
            <h4>💡 提升建议</h4>
            <ul class="suggestion-list">
              ${suggestions.suggestions.map(s => `
                <li class="suggestion-item">
                  <span class="method">${s.description}</span>
                  <div class="suggestion-meta">
                    <span class="efficiency">${s.efficiency}</span>
                    <span class="time">${s.estimatedTime}</span>
                  </div>
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        <button class="btn btn-secondary btn-history" id="btn-history">
          📜 查看历史记录
        </button>
      </div>
    `;

    // 绑定事件
    this.bindEvents();
  }

  bindEvents() {
    const previewBtn = document.getElementById('btn-preview');
    if (previewBtn) {
      previewBtn.addEventListener('click', () => this.showEvolutionPreview());
    }

    const historyBtn = document.getElementById('btn-history');
    if (historyBtn) {
      historyBtn.addEventListener('click', () => this.loadHistory());
    }
  }

  renderEvolutionModal(data) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay evolution-modal-overlay';
    modal.innerHTML = `
      <div class="modal evolution-modal">
        <div class="modal-header">
          <h2>🔮 进化预览</h2>
          <button class="modal-close" id="modal-close">&times;</button>
        </div>
        
        <div class="evolution-comparison">
          <div class="pokemon-card current">
            <h3>${data.currentSpecies}</h3>
            <div class="cp-value">CP: ${data.currentCP}</div>
            <div class="types">
              ${data.typeChange.from.map(t => `<span class="type-badge type-${t.toLowerCase()}">${t}</span>`).join('')}
            </div>
          </div>
          
          <div class="evolution-arrow">→</div>
          
          <div class="pokemon-card target ${data.canEvolve ? 'glow' : 'locked'}">
            <h3>${data.targetSpecies}</h3>
            <div class="cp-value">
              CP: ~${data.estimatedCP} 
              <span class="cp-change positive">(+${data.cpChange})</span>
            </div>
            <div class="types">
              ${data.typeChange.to.map(t => `<span class="type-badge type-${t.toLowerCase()}">${t}</span>`).join('')}
            </div>
          </div>
        </div>

        ${data.canEvolve ? `
          <div class="evolution-actions">
            <button class="btn btn-success btn-evolve" id="btn-evolve">
              ✨ 确认进化
            </button>
          </div>
        ` : `
          <div class="evolution-locked">
            <span class="lock-icon">🔒</span>
            <span>进化条件未达成</span>
            ${data.timeRestriction && !data.currentTimeReady ? 
              `<span class="hint">需要等待${data.timeRestriction === 'day' ? '白天' : '夜晚'}</span>` : ''}
          </div>
        `}

        <div class="modal-footer">
          <button class="btn btn-secondary" id="btn-modal-close">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // 绑定关闭事件
    modal.querySelector('#modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#btn-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // 进化按钮
    const evolveBtn = modal.querySelector('#btn-evolve');
    if (evolveBtn) {
      evolveBtn.addEventListener('click', () => {
        alert('进化功能需要调用进化接口');
        modal.remove();
      });
    }
  }

  renderHistoryModal() {
    const { history } = this.state;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay history-modal-overlay';
    modal.innerHTML = `
      <div class="modal history-modal">
        <div class="modal-header">
          <h2>📜 亲密度历史</h2>
          <button class="modal-close" id="modal-close">&times;</button>
        </div>
        
        <ul class="history-list">
          ${history.length > 0 ? history.map(h => `
            <li class="history-item">
              <span class="change ${h.change_amount > 0 ? 'positive' : 'negative'}">
                ${h.change_amount > 0 ? '+' : ''}${h.change_amount}
              </span>
              <span class="source">${h.source_label}</span>
              <span class="values">${h.previous_value} → ${h.new_value}</span>
              <span class="time">${new Date(h.created_at).toLocaleString()}</span>
            </li>
          `).join('') : '<li class="history-empty">暂无历史记录</li>'}
        </ul>

        <div class="modal-footer">
          <button class="btn btn-secondary" id="btn-modal-close">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // 绑定关闭事件
    modal.querySelector('#modal-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#btn-modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FriendshipEvolutionPanel;
}

// 全局注册
if (typeof window !== 'undefined') {
  window.FriendshipEvolutionPanel = FriendshipEvolutionPanel;
}
