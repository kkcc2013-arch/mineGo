/**
 * 排行榜前端组件
 */

import { apiClient } from '../api/client';
import { a11yAnnouncer } from '../accessibility/announcer';

class Leaderboard {
  constructor(container) {
    this.container = container;
    this.currentType = 'catch_total';
    this.isLoading = false;
    this.data = null;
    this.myRank = null;
    this.init();
  }

  async init() {
    this.render();
    this.bindEvents();
    await this.loadLeaderboard();
  }

  render() {
    this.container.innerHTML = `
      <div class="leaderboard-container" role="region" aria-labelledby="leaderboard-title">
        <div class="leaderboard-header">
          <h2 id="leaderboard-title">🏆 排行榜</h2>
          <div class="leaderboard-tabs" role="tablist">
            <button class="tab-btn active" data-type="catch_total" role="tab" aria-selected="true">
              捕捉榜
            </button>
            <button class="tab-btn" data-type="battle_pvp" role="tab" aria-selected="false">
              PVP榜
            </button>
            <button class="tab-btn" data-type="pokedex_completion" role="tab" aria-selected="false">
              图鉴榜
            </button>
            <button class="tab-btn" data-type="shiny_collection" role="tab" aria-selected="false">
              闪光榜
            </button>
          </div>
        </div>
        
        <div class="my-rank-card" id="myRank" aria-live="polite"></div>
        
        <div class="leaderboard-content">
          <div class="top-three" id="topThree" aria-label="前三名"></div>
          <div class="rank-list" id="rankList" role="list"></div>
        </div>
        
        <div class="season-info" id="seasonInfo"></div>
        
        <div class="loading-overlay" id="loading" style="display: none;" aria-hidden="true">
          <div class="spinner"></div>
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        this.container.querySelectorAll('.tab-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        e.target.classList.add('active');
        e.target.setAttribute('aria-selected', 'true');
        this.currentType = e.target.dataset.type;
        await this.loadLeaderboard();
      });
    });
  }

  async loadLeaderboard() {
    if (this.isLoading) return;
    this.isLoading = true;
    this.showLoading(true);

    try {
      const response = await apiClient.get(`/leaderboard/${this.currentType}`, {
        params: { limit: 100, aroundMe: 'true' }
      });

      const { season, players } = response.data.data;
      this.data = { season, players };
      
      this.renderTopThree(players.slice(0, 3));
      this.renderRankList(players.slice(3));
      this.renderSeasonInfo(season);
      await this.renderMyRank();

      a11yAnnouncer.announce(`${this.getTypeLabel(this.currentType)}排行榜已加载`);
    } catch (error) {
      console.error('Load leaderboard error:', error);
      this.showError('加载排行榜失败');
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }

  getTypeLabel(type) {
    const labels = {
      catch_total: '捕捉榜',
      battle_pvp: 'PVP榜',
      pokedex_completion: '图鉴榜',
      shiny_collection: '闪光榜'
    };
    return labels[type] || type;
  }

  renderTopThree(topPlayers) {
    const container = document.getElementById('topThree');
    
    if (topPlayers.length === 0) {
      container.innerHTML = '<p class="no-data">暂无数据</p>';
      return;
    }

    const medals = ['🥇', '🥈', '🥉'];
    const positions = ['first', 'second', 'third'];
    const bgColors = ['#FFD700', '#C0C0C0', '#CD7F32'];

    container.innerHTML = topPlayers.map((player, index) => `
      <div class="top-player ${positions[index]}" 
           role="listitem"
           aria-label="${medals[index]} ${player.username} ${player.score}分">
        <div class="medal" style="background: ${bgColors[index]}">${medals[index]}</div>
        <img src="${player.avatar || '/assets/default-avatar.png'}" 
             class="avatar" 
             alt="${player.username}头像" />
        <div class="username">${player.username}</div>
        <div class="level">Lv.${player.level || 1}</div>
        <div class="score">${this.formatScore(player.score)}</div>
      </div>
    `).join('');
  }

  renderRankList(players) {
    const container = document.getElementById('rankList');
    
    if (players.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = players.map(player => `
      <div class="rank-row" 
           role="listitem"
           data-player-id="${player.playerId}"
           aria-label="第${player.rank}名 ${player.username}">
        <div class="rank">${player.rank}</div>
        <div class="player-info">
          <img src="${player.avatar || '/assets/default-avatar.png'}" 
               class="avatar-small" 
               alt="${player.username}头像" />
          <span class="username">${player.username}</span>
        </div>
        <div class="level">Lv.${player.level || 1}</div>
        <div class="score">${this.formatScore(player.score)}</div>
      </div>
    `).join('');
  }

  renderSeasonInfo(season) {
    const container = document.getElementById('seasonInfo');
    
    if (!season) {
      container.innerHTML = '';
      return;
    }

    const endTime = new Date(season.end_time);
    const remainingDays = Math.ceil((endTime - new Date()) / (1000 * 60 * 60 * 24));

    container.innerHTML = `
      <div class="season-name">${season.name}</div>
      <div class="season-remaining">
        剩余 ${remainingDays > 0 ? remainingDays : 0} 天
      </div>
    `;
  }

  async renderMyRank() {
    const container = document.getElementById('myRank');
    
    try {
      const response = await apiClient.get(`/leaderboard/${this.currentType}/rank`);
      const { season, rank, score } = response.data.data;
      this.myRank = { rank, score };

      if (rank === null) {
        container.innerHTML = '<p class="no-rank">你还未上榜，快去努力吧！💪</p>';
        return;
      }

      const topThreeEl = document.querySelector(`.top-player[data-player-id="${this.currentUserId}"]`);
      const isHighlight = rank <= 10;

      container.innerHTML = `
        <div class="my-rank-info ${isHighlight ? 'highlight' : ''}">
          <span class="label">我的排名</span>
          <span class="rank">#${rank}</span>
          <span class="score">${this.formatScore(score)}</span>
          ${rank <= 100 ? '<span class="badge">百强玩家</span>' : ''}
        </div>
      `;
    } catch (error) {
      console.error('Load my rank error:', error);
      container.innerHTML = '<p class="error">获取排名失败</p>';
    }
  }

  formatScore(score) {
    if (score >= 1000000) {
      return (score / 1000000).toFixed(1) + 'M';
    } else if (score >= 1000) {
      return (score / 1000).toFixed(1) + 'K';
    }
    return score.toString();
  }

  showLoading(show) {
    const loading = document.getElementById('loading');
    loading.style.display = show ? 'flex' : 'none';
    loading.setAttribute('aria-hidden', !show);
  }

  showError(message) {
    const content = document.querySelector('.leaderboard-content');
    content.innerHTML = `<p class="error" role="alert">${message}</p>`;
  }

  /**
   * 刷新排行榜
   */
  async refresh() {
    await this.loadLeaderboard();
  }

  /**
   * 销毁组件
   */
  destroy() {
    this.container.innerHTML = '';
  }
}

export { Leaderboard };
export default Leaderboard;