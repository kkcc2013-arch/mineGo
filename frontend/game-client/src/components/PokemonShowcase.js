/**
 * REQ-00055: 精灵收藏展示系统
 * 前端组件
 * 
 * 创建时间: 2026-06-09 20:30
 */

'use strict';

// ============================================================
// 收藏管理组件
// ============================================================

class FavoriteManager {
  constructor(container, options = {}) {
    this.container = container;
    this.maxFavorites = options.maxFavorites || 6;
    this.favorites = [];
    this.onUpdate = options.onUpdate || (() => {});
    
    this.init();
  }
  
  async init() {
    await this.loadFavorites();
    this.render();
  }
  
  async loadFavorites() {
    try {
      const response = await fetch('/api/pokemon/favorites', {
        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
      });
      
      if (!response.ok) throw new Error('Failed to load favorites');
      
      const data = await response.json();
      this.favorites = data.favorites || [];
    } catch (err) {
      console.error('Load favorites error:', err);
      this.favorites = [];
    }
  }
  
  render() {
    const html = `
      <div class="favorite-manager">
        <div class="favorite-header">
          <h3>My Showcase</h3>
          <span class="favorite-count">${this.favorites.length}/${this.maxFavorites}</span>
        </div>
        
        <div class="favorite-grid">
          ${this.favorites.map((fav, index) => this.renderFavoriteSlot(fav, index)).join('')}
          ${this.renderEmptySlots()}
        </div>
        
        <div class="favorite-actions">
          <button class="btn-manage" onclick="favoriteManager.openSelector()">
            Manage Favorites
          </button>
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    this.bindEvents();
  }
  
  renderFavoriteSlot(favorite, index) {
    return `
      <div class="favorite-slot filled" 
           data-pokemon-id="${favorite.pokemon_id}" 
           data-order="${index}"
           draggable="true">
        <div class="pokemon-card ${favorite.is_shiny ? 'shiny' : ''}">
          <div class="pokemon-image">
            <img src="/assets/pokemon/${favorite.species.toLowerCase()}.png" 
                 alt="${favorite.species}"
                 onerror="this.src='/assets/pokemon/default.png'">
            ${favorite.is_shiny ? '<span class="shiny-badge">✨</span>' : ''}
          </div>
          <div class="pokemon-info">
            <div class="pokemon-name">${favorite.species}</div>
            <div class="pokemon-stats">
              <span class="level">Lv.${favorite.level}</span>
              <span class="iv">IV: ${favorite.iv_total}%</span>
            </div>
            <div class="social-stats">
              <span class="likes">❤️ ${favorite.like_count || 0}</span>
              <span class="comments">💬 ${favorite.comment_count || 0}</span>
            </div>
          </div>
          <button class="btn-remove" onclick="favoriteManager.removeFavorite('${favorite.pokemon_id}')">
            ×
          </button>
        </div>
      </div>
    `;
  }
  
  renderEmptySlots() {
    const emptyCount = this.maxFavorites - this.favorites.length;
    let html = '';
    
    for (let i = 0; i < emptyCount; i++) {
      html += `
        <div class="favorite-slot empty" data-order="${this.favorites.length + i}">
          <div class="empty-slot" onclick="favoriteManager.openSelector()">
            <span class="plus-icon">+</span>
            <span class="slot-label">Add Pokemon</span>
          </div>
        </div>
      `;
    }
    
    return html;
  }
  
  bindEvents() {
    // 拖拽排序
    const slots = this.container.querySelectorAll('.favorite-slot.filled');
    
    slots.forEach(slot => {
      slot.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', slot.dataset.pokemonId);
        slot.classList.add('dragging');
      });
      
      slot.addEventListener('dragend', () => {
        slot.classList.remove('dragging');
      });
      
      slot.addEventListener('dragover', (e) => {
        e.preventDefault();
        slot.classList.add('drag-over');
      });
      
      slot.addEventListener('dragleave', () => {
        slot.classList.remove('drag-over');
      });
      
      slot.addEventListener('drop', (e) => {
        e.preventDefault();
        slot.classList.remove('drag-over');
        this.handleDrop(e, slot);
      });
    });
  }
  
  async handleDrop(e, targetSlot) {
    const pokemonId = e.dataTransfer.getData('text/plain');
    const newOrder = parseInt(targetSlot.dataset.order);
    
    // 计算新的排序
    const orders = this.favorites.map((fav, index) => {
      if (fav.pokemon_id === pokemonId) {
        return { pokemonId: fav.pokemon_id, displayOrder: newOrder };
      }
      return { pokemonId: fav.pokemon_id, displayOrder: index };
    });
    
    await this.reorderFavorites(orders);
  }
  
  async addFavorite(pokemonId, displayOrder = 0) {
    if (this.favorites.length >= this.maxFavorites) {
      alert(`Maximum ${this.maxFavorites} favorites allowed`);
      return false;
    }
    
    try {
      const response = await fetch('/api/pokemon/favorites', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ pokemonId, displayOrder })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error);
      }
      
      await this.loadFavorites();
      this.render();
      this.onUpdate(this.favorites);
      
      return true;
    } catch (err) {
      console.error('Add favorite error:', err);
      alert(err.message);
      return false;
    }
  }
  
  async removeFavorite(pokemonId) {
    if (!confirm('Remove from favorites?')) return;
    
    try {
      const response = await fetch(`/api/pokemon/favorites/${pokemonId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
      });
      
      if (!response.ok) throw new Error('Failed to remove');
      
      await this.loadFavorites();
      this.render();
      this.onUpdate(this.favorites);
    } catch (err) {
      console.error('Remove favorite error:', err);
      alert(err.message);
    }
  }
  
  async reorderFavorites(orders) {
    try {
      const response = await fetch('/api/pokemon/favorites/reorder', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ orders })
      });
      
      if (!response.ok) throw new Error('Failed to reorder');
      
      await this.loadFavorites();
      this.render();
      this.onUpdate(this.favorites);
    } catch (err) {
      console.error('Reorder error:', err);
      alert(err.message);
    }
  }
  
  openSelector() {
    // 打开精灵选择器
    const selector = new PokemonSelector({
      onSelect: (pokemonId) => {
        this.addFavorite(pokemonId);
      },
      excludeIds: this.favorites.map(f => f.pokemon_id)
    });
    selector.show();
  }
}

// ============================================================
// 展示页面组件
// ============================================================

class ShowcasePage {
  constructor(container, userId, options = {}) {
    this.container = container;
    this.userId = userId;
    this.isOwner = options.isOwner || false;
    this.data = null;
    
    this.init();
  }
  
  async init() {
    await this.loadShowcase();
    this.render();
  }
  
  async loadShowcase() {
    try {
      const response = await fetch(`/api/pokemon/users/${this.userId}/showcase`, {
        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
      });
      
      if (!response.ok) throw new Error('Failed to load showcase');
      
      this.data = await response.json();
    } catch (err) {
      console.error('Load showcase error:', err);
      this.data = null;
    }
  }
  
  render() {
    if (!this.data) {
      this.container.innerHTML = '<div class="error">Failed to load showcase</div>';
      return;
    }
    
    const { user, showcase, stats } = this.data;
    
    const html = `
      <div class="showcase-page">
        <div class="user-header">
          <div class="avatar">
            <img src="${user.avatar_url || '/assets/default-avatar.png'}" alt="Avatar">
          </div>
          <div class="user-info">
            <h2>${user.nickname}</h2>
            <div class="user-meta">
              <span class="level">Level ${user.level}</span>
              <span class="team team-${user.team}">${user.team}</span>
            </div>
          </div>
          <div class="stats-summary">
            <div class="stat">
              <span class="value">${stats.totalLikes}</span>
              <span class="label">Likes</span>
            </div>
            <div class="stat">
              <span class="value">${stats.totalViews}</span>
              <span class="label">Views</span>
            </div>
          </div>
        </div>
        
        <div class="showcase-grid">
          ${showcase.map(pokemon => this.renderPokemonCard(pokemon)).join('')}
          ${showcase.length === 0 ? '<div class="empty-showcase">No Pokemon showcased yet</div>' : ''}
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
    this.bindEvents();
  }
  
  renderPokemonCard(pokemon) {
    return `
      <div class="showcase-card ${pokemon.is_shiny ? 'shiny' : ''}" data-pokemon-id="${pokemon.pokemon_id}">
        <div class="card-image">
          <img src="/assets/pokemon/${pokemon.species.toLowerCase()}.png" 
               alt="${pokemon.species}"
               onerror="this.src='/assets/pokemon/default.png'">
          ${pokemon.is_shiny ? '<span class="shiny-badge">✨</span>' : ''}
        </div>
        
        <div class="card-body">
          <h4 class="pokemon-name">${pokemon.species}</h4>
          <div class="pokemon-stats">
            <span class="level">Lv.${pokemon.level}</span>
            <span class="iv">IV: ${pokemon.iv_total}%</span>
            <span class="cp">CP: ${pokemon.cp}</span>
          </div>
          
          <div class="social-stats">
            <span class="likes">❤️ ${pokemon.like_count || 0}</span>
            <span class="comments">💬 ${pokemon.comment_count || 0}</span>
            <span class="views">👁️ ${pokemon.view_count || 0}</span>
          </div>
        </div>
        
        ${!this.isOwner ? `
          <div class="card-actions">
            <button class="btn-like ${pokemon.isLikedByMe ? 'liked' : ''}" 
                    onclick="showcasePage.toggleLike('${pokemon.pokemon_id}')">
              ${pokemon.isLikedByMe ? '❤️ Liked' : '🤍 Like'}
            </button>
            <button class="btn-comment" onclick="showcasePage.openComments('${pokemon.pokemon_id}')">
              💬 Comment
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  bindEvents() {
    // 卡片点击查看详情
    this.container.querySelectorAll('.showcase-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (!e.target.closest('button')) {
          const pokemonId = card.dataset.pokemonId;
          this.showPokemonDetail(pokemonId);
        }
      });
    });
  }
  
  async toggleLike(pokemonId) {
    try {
      const card = this.container.querySelector(`[data-pokemon-id="${pokemonId}"]`);
      const btn = card.querySelector('.btn-like');
      const isLiked = btn.classList.contains('liked');
      
      const response = await fetch(`/api/pokemon/${pokemonId}/like`, {
        method: isLiked ? 'DELETE' : 'POST',
        headers: { 'Authorization': `Bearer ${getAuthToken()}` }
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error);
      }
      
      const result = await response.json();
      
      // 更新 UI
      if (isLiked) {
        btn.classList.remove('liked');
        btn.textContent = '🤍 Like';
      } else {
        btn.classList.add('liked');
        btn.textContent = '❤️ Liked';
        
        // 显示奖励提示
        if (result.reward) {
          this.showRewardToast(result.reward);
        }
      }
      
      // 更新点赞数
      const likesSpan = card.querySelector('.likes');
      likesSpan.textContent = `❤️ ${result.likeCount}`;
      
    } catch (err) {
      console.error('Toggle like error:', err);
      alert(err.message);
    }
  }
  
  openComments(pokemonId) {
    const modal = new CommentModal(pokemonId);
    modal.show();
  }
  
  showPokemonDetail(pokemonId) {
    // 跳转到精灵详情页
    window.location.href = `/pokemon/${pokemonId}`;
  }
  
  showRewardToast(reward) {
    const toast = document.createElement('div');
    toast.className = 'reward-toast';
    toast.innerHTML = `
      <div class="reward-content">
        <span>🎉 You earned:</span>
        <span class="coins">💰 ${reward.coins} coins</span>
        <span class="experience">⭐ ${reward.experience} XP</span>
      </div>
    `;
    
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }
}

// ============================================================
// 评语模态框
// ============================================================

class CommentModal {
  constructor(pokemonId) {
    this.pokemonId = pokemonId;
    this.comments = [];
    this.modal = null;
  }
  
  async show() {
    await this.loadComments();
    this.render();
    document.body.appendChild(this.modal);
  }
  
  async loadComments() {
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/comments`);
      const data = await response.json();
      this.comments = data.comments || [];
      this.total = data.total || 0;
    } catch (err) {
      console.error('Load comments error:', err);
      this.comments = [];
    }
  }
  
  render() {
    this.modal = document.createElement('div');
    this.modal.className = 'comment-modal-overlay';
    
    this.modal.innerHTML = `
      <div class="comment-modal">
        <div class="modal-header">
          <h3>Comments (${this.total})</h3>
          <button class="btn-close" onclick="this.closest('.comment-modal-overlay').remove()">×</button>
        </div>
        
        <div class="modal-body">
          <div class="comment-list">
            ${this.comments.length === 0 
              ? '<div class="no-comments">No comments yet. Be the first!</div>'
              : this.comments.map(c => this.renderComment(c)).join('')
            }
          </div>
        </div>
        
        <div class="modal-footer">
          <textarea class="comment-input" 
                    placeholder="Write a comment (max 200 chars)..." 
                    maxlength="200"
                    rows="3"></textarea>
          <button class="btn-submit" onclick="commentModal.submitComment()">Post Comment</button>
        </div>
      </div>
    `;
    
    // 绑定全局引用
    window.commentModal = this;
  }
  
  renderComment(comment) {
    return `
      <div class="comment-item">
        <div class="comment-avatar">
          <img src="${comment.avatar_url || '/assets/default-avatar.png'}" alt="${comment.nickname}">
        </div>
        <div class="comment-content">
          <div class="comment-header">
            <span class="author">${comment.nickname}</span>
            <span class="time">${this.formatTime(comment.created_at)}</span>
          </div>
          <div class="comment-text">${this.escapeHtml(comment.comment)}</div>
        </div>
      </div>
    `;
  }
  
  async submitComment() {
    const input = this.modal.querySelector('.comment-input');
    const comment = input.value.trim();
    
    if (!comment) {
      alert('Please enter a comment');
      return;
    }
    
    try {
      const response = await fetch(`/api/pokemon/${this.pokemonId}/comments`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${getAuthToken()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ comment })
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error);
      }
      
      const result = await response.json();
      
      // 清空输入
      input.value = '';
      
      // 重新加载评论
      await this.loadComments();
      this.modal.remove();
      this.show();
      
      // 显示奖励
      if (result.reward) {
        alert(`🎉 You earned ${result.reward.coins} coins and ${result.reward.experience} XP!`);
      }
      
    } catch (err) {
      console.error('Submit comment error:', err);
      alert(err.message);
    }
  }
  
  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  }
  
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// ============================================================
// 排行榜组件
// ============================================================

class LeaderboardPage {
  constructor(container) {
    this.container = container;
    this.leaderboard = [];
    this.init();
  }
  
  async init() {
    await this.loadLeaderboard();
    this.render();
  }
  
  async loadLeaderboard() {
    try {
      const response = await fetch('/api/pokemon/showcase/leaderboard?limit=100');
      const data = await response.json();
      this.leaderboard = data.leaderboard || [];
    } catch (err) {
      console.error('Load leaderboard error:', err);
      this.leaderboard = [];
    }
  }
  
  render() {
    const html = `
      <div class="leaderboard-page">
        <h2>🏆 Most Loved Pokemon</h2>
        
        <div class="leaderboard-list">
          ${this.leaderboard.map((item, index) => this.renderItem(item, index)).join('')}
        </div>
      </div>
    `;
    
    this.container.innerHTML = html;
  }
  
  renderItem(item, index) {
    const rankBadge = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${item.rank}`;
    
    return `
      <div class="leaderboard-item ${index < 3 ? 'top-three' : ''}">
        <div class="rank">${rankBadge}</div>
        <div class="pokemon-image">
          <img src="/assets/pokemon/${item.species.toLowerCase()}.png" 
               alt="${item.species}"
               onerror="this.src='/assets/pokemon/default.png'">
          ${item.is_shiny ? '<span class="shiny-badge">✨</span>' : ''}
        </div>
        <div class="pokemon-info">
          <div class="pokemon-name">${item.species}</div>
          <div class="owner">by ${item.owner_nickname}</div>
        </div>
        <div class="stats">
          <div class="likes">❤️ ${item.like_count}</div>
          <div class="comments">💬 ${item.comment_count}</div>
        </div>
      </div>
    `;
  }
}

// ============================================================
// CSS 样式
// ============================================================

const styles = `
.favorite-manager {
  background: #fff;
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
}

.favorite-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.favorite-count {
  color: #666;
  font-size: 14px;
}

.favorite-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.favorite-slot {
  aspect-ratio: 1;
  border-radius: 12px;
  background: #f5f5f5;
  border: 2px dashed #ddd;
}

.favorite-slot.filled {
  border: none;
  background: transparent;
}

.favorite-slot.drag-over {
  border-color: #4CAF50;
  background: #e8f5e9;
}

.pokemon-card {
  position: relative;
  background: white;
  border-radius: 12px;
  padding: 12px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  height: 100%;
  display: flex;
  flex-direction: column;
}

.pokemon-card.shiny {
  background: linear-gradient(135deg, #fff9c4 0%, #fff 100%);
  border: 2px solid #ffd700;
}

.pokemon-image {
  position: relative;
  text-align: center;
  flex: 1;
}

.pokemon-image img {
  width: 80%;
  max-height: 100px;
  object-fit: contain;
}

.shiny-badge {
  position: absolute;
  top: 0;
  right: 10px;
  font-size: 20px;
}

.pokemon-info {
  text-align: center;
  margin-top: 8px;
}

.pokemon-name {
  font-weight: bold;
  font-size: 14px;
}

.pokemon-stats, .social-stats {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 12px;
  color: #666;
}

.btn-remove {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(0,0,0,0.5);
  color: white;
  border: none;
  border-radius: 50%;
  width: 24px;
  height: 24px;
  cursor: pointer;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-slot {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #999;
}

.plus-icon {
  font-size: 32px;
  font-weight: bold;
}

.slot-label {
  font-size: 12px;
  margin-top: 4px;
}

.showcase-page {
  padding: 16px;
}

.user-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: white;
  border-radius: 12px;
  margin-bottom: 20px;
}

.avatar img {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  object-fit: cover;
}

.user-meta {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

.team {
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  text-transform: capitalize;
}

.team-mystic { background: #2196F3; color: white; }
.team-valor { background: #F44336; color: white; }
.team-instinct { background: #FFC107; color: black; }

.stats-summary {
  margin-left: auto;
  display: flex;
  gap: 24px;
}

.stats-summary .stat {
  text-align: center;
}

.stats-summary .value {
  display: block;
  font-size: 24px;
  font-weight: bold;
}

.stats-summary .label {
  font-size: 12px;
  color: #666;
}

.showcase-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.showcase-card {
  background: white;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
  cursor: pointer;
  transition: transform 0.2s;
}

.showcase-card:hover {
  transform: translateY(-4px);
}

.showcase-card.shiny {
  background: linear-gradient(135deg, #fff9c4 0%, #fff 100%);
  border: 2px solid #ffd700;
}

.card-image {
  position: relative;
  text-align: center;
  padding: 16px;
  background: #f5f5f5;
}

.card-image img {
  width: 60%;
  max-height: 120px;
  object-fit: contain;
}

.card-body {
  padding: 12px;
}

.card-actions {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #eee;
}

.btn-like, .btn-comment {
  flex: 1;
  padding: 8px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 12px;
  transition: background 0.2s;
}

.btn-like {
  background: #ffebee;
  color: #e91e63;
}

.btn-like.liked {
  background: #e91e63;
  color: white;
}

.btn-comment {
  background: #e3f2fd;
  color: #2196f3;
}

.comment-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.comment-modal {
  background: white;
  border-radius: 12px;
  width: 90%;
  max-width: 500px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px;
  border-bottom: 1px solid #eee;
}

.btn-close {
  background: none;
  border: none;
  font-size: 24px;
  cursor: pointer;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.comment-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.comment-item {
  display: flex;
  gap: 12px;
}

.comment-avatar img {
  width: 40px;
  height: 40px;
  border-radius: 50%;
}

.comment-header {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.comment-header .author {
  font-weight: bold;
}

.comment-header .time {
  color: #999;
}

.comment-text {
  margin-top: 4px;
  font-size: 14px;
}

.modal-footer {
  padding: 16px;
  border-top: 1px solid #eee;
}

.comment-input {
  width: 100%;
  padding: 8px;
  border: 1px solid #ddd;
  border-radius: 8px;
  resize: none;
  font-family: inherit;
}

.btn-submit {
  width: 100%;
  margin-top: 8px;
  padding: 12px;
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
}

.leaderboard-page {
  padding: 16px;
}

.leaderboard-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.leaderboard-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: white;
  border-radius: 12px;
  box-shadow: 0 2px 4px rgba(0,0,0,0.1);
}

.leaderboard-item.top-three {
  background: linear-gradient(135deg, #fff9c4 0%, #fff 100%);
  border: 2px solid #ffd700;
}

.leaderboard-item .rank {
  font-size: 20px;
  font-weight: bold;
  width: 40px;
  text-align: center;
}

.leaderboard-item .pokemon-image {
  width: 50px;
}

.leaderboard-item .pokemon-image img {
  width: 100%;
}

.reward-toast {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: #4CAF50;
  color: white;
  padding: 16px 24px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  animation: slideUp 0.3s ease;
}

.reward-content {
  display: flex;
  gap: 16px;
  align-items: center;
}

@keyframes slideUp {
  from {
    transform: translateX(-50%) translateY(100%);
    opacity: 0;
  }
  to {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }
}

.reward-toast.fade-out {
  animation: fadeOut 0.3s ease forwards;
}

@keyframes fadeOut {
  to {
    opacity: 0;
    transform: translateX(-50%) translateY(20px);
  }
}
`;

// 注入样式
const styleSheet = document.createElement('style');
styleSheet.textContent = styles;
document.head.appendChild(styleSheet);

// 导出
window.FavoriteManager = FavoriteManager;
window.ShowcasePage = ShowcasePage;
window.LeaderboardPage = LeaderboardPage;
