/**
 * 排行榜前端组件
 * 
 * REQ-00074: 玩家排行榜系统
 */

import { apiClient } from '../api/client';

export class Leaderboard {
  constructor(container) {
    this.container = container;
    this.currentType = 'catch_total';
    this.isLoading = false;
    this.currentSeason = null;
    this.myRank = null;
    this.init();
  }

  async init() {
    this.render();
    await this.loadLeaderboard();
  }

  render() {
    this.container.innerHTML = `
      <div class="leaderboard-container">
        <div class="leaderboard-header">
          <h2>🏆 排行榜</h2>
          <div class="leaderboard-tabs">
            <button class="tab-btn active" data-type="catch_total">捕捉榜</button>
            <button class="tab-btn" data-type="battle_pvp">PVP榜</button>
            <button class="tab-btn" data-type="pokedex_completion">图鉴榜</button>
            <button class="tab-btn" data-type="shiny_collection">闪光榜</button>
          </div>
        </div>
        
        <div class="season-info" id="seasonInfo"></div>
        <div class="my-rank-card" id="myRank"></div>
        
        <div class="leaderboard-content">
          <div class="top-three" id="topThree"></div>
          <div class="rank-list" id="rankList"></div>
        </div>
        
        <div class="loading-overlay" id="loading" style="display: none;">
          <div class="spinner"></div>
        </div>
      </div>
    `;

    this.bindEvents();
  }

  bindEvents() {
    this.container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        this.container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        this.currentType = e.target.dataset.type;
        this.loadLeaderboard();
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

      const { season, players, totalPlayers } = response.data.data;
      this.currentSeason = season;
      
      this.renderSeasonInfo(season, totalPlayers);
      this.renderTopThree(players.slice(0, 3));
      this.renderRankList(players.slice(3));
      await this.renderMyRank();
    } catch (error) {
      console.error('Load leaderboard error:', error);
      this.showError('加载排行榜失败');
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }

  renderSeasonInfo(season, totalPlayers) {
    const container = document.getElementById('seasonInfo');
    
    if (!season) {
      container.innerHTML = '<p class="no-season">当前无进行中的赛季</p>';
      return;
    }

    const endTime = new Date(season.end_time);
    const remaining = this.formatTimeRemaining(endTime - new Date());

    container.innerHTML = `
      <div class="season-badge">
        <span class="season-name">${season.name}</span>
        <span class="season-remaining">剩余 ${remaining}</span>
        <span class="total-players">${totalPlayers} 人参与</span>
      </div>
    `;
  }

  renderTopThree(topPlayers) {
    const container = document.getElementById('topThree');
    
    if (topPlayers.length === 0) {
      container.innerHTML = '<p class="no-data">暂无数据</p>';
      return;
    }

    const medals = ['🥇', '🥈', '🥉'];
    const positions = ['first', 'second', 'third'];

    container.innerHTML = topPlayers.map((player, index) => `
      <div class="top-player ${positions[index]}" onclick="window.showPlayerProfile(${player.playerId})">
        <div class="medal">${medals[index]}</div>
        <img src="${player.avatar || '/assets/default-avatar.png'}" class="avatar" alt="${player.username}" />
        <div class="username">${this.escapeHtml(player.username)}</div>
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

    container.innerHTML = `
      <table class="rank-table">
        <thead>
          <tr>
            <th>排名</th>
            <th>玩家</th>
            <th>等级</th>
            <th>分数</th>
          </tr>
        </thead>
        <tbody>
          ${players.map(player => `
            <tr class="rank-row" data-player-id="${player.playerId}" onclick="window.showPlayerProfile(${player.playerId})">
              <td class="rank">${player.rank}</td>
              <td class="player-info">
                <img src="${player.avatar || '/assets/default-avatar.png'}" class="avatar-small" alt="${player.username}" />
                <span>${this.escapeHtml(player.username)}</span>
              </td>
              <td>Lv.${player.level || 1}</td>
              <td class="score">${this.formatScore(player.score)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  async renderMyRank() {
    const container = document.getElementById('myRank');
    
    try {
      const response = await apiClient.get(`/leaderboard/${this.currentType}/rank`);
      const { season, rank, score } = response.data.data;

      if (rank === null) {
        container.innerHTML = '<p class="no-rank">你还未上榜，快去努力吧！</p>';
        return;
      }

      this.myRank = { rank, score };

      container.innerHTML = `
        <div class="my-rank-info">
          <span class="label">我的排名</span>
          <span class="rank">#${rank}</span>
          <span class="score">${this.formatScore(score)}</span>
        </div>
      `;
    } catch (error) {
      console.error('Load my rank error:', error);
      container.innerHTML = '';
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

  formatTimeRemaining(ms) {
    if (ms < 0) return '已结束';
    
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    
    if (days > 0) {
      return `${days}天 ${hours}小时`;
    }
    return `${hours}小时`;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showLoading(show) {
    const loading = document.getElementById('loading');
    if (loading) {
      loading.style.display = show ? 'flex' : 'none';
    }
  }

  showError(message) {
    const content = document.querySelector('.leaderboard-content');
    if (content) {
      content.innerHTML = `<p class="error">${message}</p>`;
    }
  }

  /**
   * 切换排行榜类型
   */
  switchType(type) {
    if (this.currentType === type) return;
    
    this.currentType = type;
    
    // 更新 Tab 样式
    this.container.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });
    
    this.loadLeaderboard();
  }

  /**
   * 刷新排行榜
   */
  async refresh() {
    await this.loadLeaderboard();
  }
}

// 导出工厂函数
export function createLeaderboard(container) {
  return new Leaderboard(container);
}
