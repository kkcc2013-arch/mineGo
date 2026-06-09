/**
 * REQ-00056: 精灵图鉴完成度奖励系统
 * 前端组件
 */

class PokedexProgress {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      apiBaseUrl: options.apiBaseUrl || '/api',
      onMilestoneClaimed: options.onMilestoneClaimed || null,
      onAchievementUnlocked: options.onAchievementUnlocked || null,
      ...options,
    };

    this.progress = null;
    this.achievements = [];
    this.milestones = [];
    this.regionStats = [];
    this.typeStats = [];

    this.init();
  }

  async init() {
    try {
      await this.loadAllData();
      this.render();
      this.bindEvents();
    } catch (error) {
      console.error('Failed to initialize PokedexProgress:', error);
      this.renderError(error);
    }
  }

  async loadAllData() {
    const headers = this.getAuthHeaders();

    const [progressRes, achievementsRes, milestonesRes, regionRes, typeRes] = await Promise.all([
      fetch(`${this.options.apiBaseUrl}/pokedex/progress`, { headers }),
      fetch(`${this.options.apiBaseUrl}/pokedex/achievements`, { headers }),
      fetch(`${this.options.apiBaseUrl}/pokedex/milestones`, { headers }),
      fetch(`${this.options.apiBaseUrl}/pokedex/region-stats`, { headers }),
      fetch(`${this.options.apiBaseUrl}/pokedex/type-stats`, { headers }),
    ]);

    this.progress = await progressRes.json();
    this.achievements = await achievementsRes.json();
    this.milestones = await milestonesRes.json();
    this.regionStats = await regionRes.json();
    this.typeStats = await typeRes.json();

    if (!this.progress.success) {
      throw new Error(this.progress.error || 'Failed to load progress');
    }
  }

  getAuthHeaders() {
    const token = localStorage.getItem('token');
    return {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : '',
    };
  }

  render() {
    const data = this.progress.data;
    const completionPercent = parseFloat(data.completion_percentage) || 0;

    this.container.innerHTML = `
      <div class="pokedex-progress-container">
        <!-- 头部 -->
        <div class="progress-header">
          <h2>📸 图鉴完成度</h2>
          <div class="completion-badge ${this.getBadgeClass(completionPercent)}">
            ${completionPercent.toFixed(1)}%
          </div>
        </div>

        <!-- 基础统计 -->
        <div class="progress-stats">
          <div class="stat-card">
            <div class="stat-icon">👁️</div>
            <div class="stat-content">
              <div class="stat-value">${data.seen_count || 0}</div>
              <div class="stat-label">已见过</div>
            </div>
          </div>

          <div class="stat-card primary">
            <div class="stat-icon">🎯</div>
            <div class="stat-content">
              <div class="stat-value">${data.caught_count || 0}</div>
              <div class="stat-label">已捕获</div>
            </div>
          </div>

          <div class="stat-card shiny">
            <div class="stat-icon">✨</div>
            <div class="stat-content">
              <div class="stat-value">${data.shiny_count || 0}</div>
              <div class="stat-label">闪光精灵</div>
            </div>
          </div>

          <div class="stat-card legendary">
            <div class="stat-icon">⭐</div>
            <div class="stat-content">
              <div class="stat-value">${data.legendary_count || 0}</div>
              <div class="stat-label">传说精灵</div>
            </div>
          </div>
        </div>

        <!-- 进度条 -->
        <div class="progress-bar-container">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${completionPercent}%"></div>
            <div class="progress-label">
              ${data.caught_count || 0} / ${data.total_species || 905}
            </div>
          </div>
        </div>

        <!-- 捕捉加成提示 -->
        ${
          completionPercent >= 10
            ? `
          <div class="catch-bonus-banner">
            <span class="bonus-icon">🎯</span>
            <span class="bonus-text">
              图鉴完成度加成：<strong>+${Math.floor(completionPercent / 10)}%</strong> 捕捉概率
            </span>
          </div>
        `
            : ''
        }

        <!-- 地区进度 -->
        ${this.renderRegionStats()}

        <!-- 里程碑奖励 -->
        ${this.renderMilestones()}

        <!-- 成就系统 -->
        ${this.renderAchievements()}
      </div>

      <style>${this.getStyles()}</style>
    `;
  }

  renderRegionStats() {
    const stats = this.regionStats.data || [];
    if (stats.length === 0) return '';

    return `
      <div class="region-stats-section">
        <h3>🌍 地区进度</h3>
        <div class="region-grid">
          ${stats
            .map((region) => {
              const percent = ((region.caught_count / region.total_in_region) * 100).toFixed(1);
              return `
              <div class="region-card">
                <div class="region-name">${this.getRegionName(region.region)}</div>
                <div class="region-progress">
                  <div class="mini-progress-bar">
                    <div class="mini-progress-fill" style="width: ${percent}%"></div>
                  </div>
                  <div class="region-count">${region.caught_count}/${region.total_in_region}</div>
                </div>
              </div>
            `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  renderMilestones() {
    const milestones = this.milestones.data || [];
    const unclaimed = milestones.filter((m) => !m.claimed);
    const claimed = milestones.filter((m) => m.claimed);

    return `
      <div class="milestones-section">
        <h3>🏆 里程碑奖励</h3>

        ${
          unclaimed.length > 0
            ? `
          <div class="unclaimed-milestones">
            <h4>🎁 待领取奖励 (${unclaimed.length})</h4>
            <div class="milestone-list">
              ${unclaimed
                .map((m) => `
                <div class="milestone-card unclaimed" data-milestone-id="${m.id}">
                  <div class="milestone-icon">${this.getMilestoneIcon(m.milestone_type)}</div>
                  <div class="milestone-info">
                    <div class="milestone-title">${m.title}</div>
                    <div class="milestone-desc">${m.description || ''}</div>
                    <div class="milestone-reward">
                      ${this.formatReward(m.reward_data)}
                    </div>
                  </div>
                  <button class="claim-btn">领取</button>
                </div>
              `)
                .join('')}
            </div>
          </div>
        `
            : ''
        }

        <div class="claimed-milestones">
          <h4>✅ 已获得奖励 (${claimed.length})</h4>
          ${
            claimed.length > 0
              ? `
            <div class="milestone-list compact">
              ${claimed
                .slice(0, 5)
                .map(
                  (m) => `
                <div class="milestone-card claimed">
                  <div class="milestone-icon">${this.getMilestoneIcon(m.milestone_type)}</div>
                  <div class="milestone-info">
                    <div class="milestone-title">${m.title}</div>
                  </div>
                  <div class="check-icon">✓</div>
                </div>
              `
                )
                .join('')}
            </div>
          `
              : '<div class="empty-message">暂无已获得奖励</div>'
          }
        </div>
      </div>
    `;
  }

  renderAchievements() {
    const achievements = this.achievements.data || [];
    const stats = this.achievements.stats || {};

    return `
      <div class="achievements-section">
        <h3>🏅 图鉴成就</h3>

        <div class="achievement-stats">
          <span>已解锁：${stats.unlocked || 0} / ${stats.total || 0}</span>
          <span>完成度：${stats.completionRate || 0}%</span>
        </div>

        <div class="achievements-grid">
          ${achievements
            .map((a) => {
              const isUnlocked = !!a.unlocked_at;
              return `
              <div class="achievement-card ${isUnlocked ? 'unlocked' : 'locked'}" data-rarity="${a.rarity}">
                <div class="achievement-badge">
                  ${isUnlocked ? this.getBadgeIcon(a.badge_icon) : '🔒'}
                </div>
                <div class="achievement-info">
                  <div class="achievement-name">${a.name}</div>
                  <div class="achievement-desc">${a.description}</div>
                  ${
                    !isUnlocked
                      ? `
                    <div class="achievement-progress">
                      进度: ${this.getAchievementProgress(a)}
                    </div>
                  `
                      : `
                    <div class="achievement-date">
                      解锁于: ${new Date(a.unlocked_at).toLocaleDateString()}
                    </div>
                  `
                  }
                </div>
                ${isUnlocked ? '<div class="unlocked-badge">✓</div>' : ''}
              </div>
            `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  bindEvents() {
    // 领取里程碑奖励
    this.container.querySelectorAll('.claim-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const card = e.target.closest('.milestone-card');
        const milestoneId = card.dataset.milestoneId;
        await this.claimMilestone(milestoneId, card);
      });
    });

    // 成就卡片点击
    this.container.querySelectorAll('.achievement-card').forEach((card) => {
      card.addEventListener('click', (e) => {
        const name = card.querySelector('.achievement-name').textContent;
        const desc = card.querySelector('.achievement-desc').textContent;
        // 可以展开详情或弹窗
        console.log('Achievement clicked:', name);
      });
    });
  }

  async claimMilestone(milestoneId, cardElement) {
    try {
      const btn = cardElement.querySelector('.claim-btn');
      btn.textContent = '领取中...';
      btn.disabled = true;

      const response = await fetch(
        `${this.options.apiBaseUrl}/pokedex/milestones/${milestoneId}/claim`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
        }
      );

      const result = await response.json();

      if (result.success) {
        // 显示奖励动画
        this.showRewardAnimation(result.data);

        // 触发回调
        if (this.options.onMilestoneClaimed) {
          this.options.onMilestoneClaimed(result.data);
        }

        // 刷新数据
        await this.loadAllData();
        this.render();
        this.bindEvents();
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Claim milestone error:', error);
      alert('领取失败: ' + error.message);

      const btn = cardElement.querySelector('.claim-btn');
      btn.textContent = '领取';
      btn.disabled = false;
    }
  }

  showRewardAnimation(reward) {
    const modal = document.createElement('div');
    modal.className = 'reward-modal';
    modal.innerHTML = `
      <div class="reward-overlay"></div>
      <div class="reward-content">
        <h2>🎉 恭喜获得奖励！</h2>
        <div class="reward-title">${reward.title}</div>
        <div class="reward-items">
          ${this.formatRewardDetails(reward.reward_data)}
        </div>
        <button class="close-btn">确定</button>
      </div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('.close-btn').addEventListener('click', () => {
      modal.remove();
    });

    modal.querySelector('.reward-overlay').addEventListener('click', () => {
      modal.remove();
    });
  }

  // 辅助方法
  getBadgeClass(percent) {
    if (percent >= 100) return 'legendary';
    if (percent >= 75) return 'master';
    if (percent >= 50) return 'expert';
    if (percent >= 25) return 'collector';
    return 'beginner';
  }

  getRegionName(region) {
    const names = {
      kanto: '关都',
      johto: '城都',
      hoenn: '丰缘',
      sinnoh: '神奥',
      unova: '合众',
      kalos: '卡洛斯',
      alola: '阿罗拉',
      galar: '伽勒尔',
      paldea: '帕底亚',
    };
    return names[region] || region;
  }

  getMilestoneIcon(type) {
    const icons = {
      percentage: '📊',
      count: '🎯',
      category: '🏷️',
      special: '⭐',
    };
    return icons[type] || '🏆';
  }

  getBadgeIcon(icon) {
    return icon || '🏅';
  }

  formatReward(rewardData) {
    if (!rewardData) return '奖励';

    const rewards = [];
    if (rewardData.items && Array.isArray(rewardData.items)) {
      rewards.push(`${rewardData.items.length} 件道具`);
    }
    if (rewardData.shiny_encounter_ticket) {
      rewards.push('闪光遭遇券');
    }
    if (rewardData.master_ball) {
      rewards.push(`大师球 × ${rewardData.master_ball}`);
    }
    if (rewardData.title) {
      rewards.push(`称号: ${rewardData.title}`);
    }
    if (rewardData.shiny_dex_unlock) {
      rewards.push('闪光图鉴解锁');
    }

    return rewards.join(' + ') || '奖励';
  }

  formatRewardDetails(rewardData) {
    if (!rewardData) return '';

    let html = '';

    if (rewardData.items && Array.isArray(rewardData.items)) {
      html += rewardData.items
        .map(
          (item) => `
        <div class="reward-item">
          <span class="item-icon">🎁</span>
          <span class="item-name">${item.type}</span>
          <span class="item-count">×${item.count || 1}</span>
        </div>
      `
        )
        .join('');
    }

    if (rewardData.shiny_encounter_ticket) {
      html += `
        <div class="reward-item special">
          <span class="item-icon">✨</span>
          <span class="item-name">闪光遭遇券</span>
          <span class="item-count">×${rewardData.shiny_encounter_ticket}</span>
        </div>
      `;
    }

    if (rewardData.title) {
      html += `
        <div class="reward-item special">
          <span class="item-icon">👑</span>
          <span class="item-name">称号: ${rewardData.title}</span>
        </div>
      `;
    }

    return html;
  }

  getAchievementProgress(achievement) {
    const progress = this.progress.data;
    let current = 0;

    switch (achievement.requirement_type) {
      case 'caught_count':
        current = progress.caught_count || 0;
        break;
      case 'seen_count':
        current = progress.seen_count || 0;
        break;
      case 'shiny_count':
        current = progress.shiny_count || 0;
        break;
      case 'legendary_count':
        current = progress.legendary_count || 0;
        break;
      case 'completion_percentage':
        current = parseFloat(progress.completion_percentage) || 0;
        break;
    }

    return `${current} / ${achievement.requirement_value}`;
  }

  getStyles() {
    return `
      .pokedex-progress-container {
        padding: 20px;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border-radius: 16px;
        color: white;
      }

      .progress-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 20px;
      }

      .progress-header h2 {
        margin: 0;
        font-size: 24px;
      }

      .completion-badge {
        padding: 8px 16px;
        border-radius: 20px;
        font-weight: bold;
        font-size: 18px;
      }

      .completion-badge.beginner { background: #95a5a6; }
      .completion-badge.collector { background: #3498db; }
      .completion-badge.expert { background: #2ecc71; }
      .completion-badge.master { background: #9b59b6; }
      .completion-badge.legendary { background: linear-gradient(45deg, #f39c12, #e74c3c); }

      .progress-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 12px;
        margin-bottom: 20px;
      }

      .stat-card {
        background: rgba(255,255,255,0.15);
        padding: 16px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .stat-card.primary { background: rgba(46, 204, 113, 0.3); }
      .stat-card.shiny { background: rgba(241, 196, 15, 0.3); }
      .stat-card.legendary { background: rgba(155, 89, 182, 0.3); }

      .stat-icon { font-size: 28px; }
      .stat-value { font-size: 24px; font-weight: bold; }
      .stat-label { font-size: 12px; opacity: 0.9; }

      .progress-bar-container { margin: 20px 0; }

      .progress-bar {
        height: 24px;
        background: rgba(255,255,255,0.2);
        border-radius: 12px;
        overflow: hidden;
        position: relative;
      }

      .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #2ecc71, #27ae60);
        transition: width 0.5s ease;
      }

      .progress-label {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        font-weight: bold;
        text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
      }

      .catch-bonus-banner {
        background: rgba(46, 204, 113, 0.3);
        padding: 12px 16px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 16px 0;
      }

      .region-stats-section,
      .milestones-section,
      .achievements-section {
        background: rgba(255,255,255,0.1);
        padding: 16px;
        border-radius: 12px;
        margin-top: 16px;
      }

      .region-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin-top: 12px;
      }

      .region-card {
        background: rgba(255,255,255,0.1);
        padding: 12px;
        border-radius: 8px;
      }

      .region-name { font-weight: bold; margin-bottom: 8px; }
      .region-progress { display: flex; align-items: center; gap: 8px; }

      .mini-progress-bar {
        flex: 1;
        height: 8px;
        background: rgba(255,255,255,0.2);
        border-radius: 4px;
        overflow: hidden;
      }

      .mini-progress-fill {
        height: 100%;
        background: #2ecc71;
        transition: width 0.3s ease;
      }

      .milestone-list { margin-top: 12px; }
      .milestone-card {
        background: rgba(255,255,255,0.15);
        padding: 12px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
      }

      .milestone-card.unclaimed {
        background: linear-gradient(135deg, rgba(241, 196, 15, 0.3), rgba(243, 156, 18, 0.3));
      }

      .milestone-icon { font-size: 32px; }
      .milestone-info { flex: 1; }
      .milestone-title { font-weight: bold; }
      .milestone-desc { font-size: 12px; opacity: 0.9; }
      .milestone-reward { font-size: 12px; color: #f39c12; margin-top: 4px; }

      .claim-btn {
        background: #f39c12;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: bold;
      }

      .claim-btn:hover { background: #e67e22; }
      .claim-btn:disabled { opacity: 0.6; cursor: not-allowed; }

      .achievements-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
        margin-top: 12px;
      }

      .achievement-card {
        background: rgba(255,255,255,0.1);
        padding: 12px;
        border-radius: 8px;
        position: relative;
      }

      .achievement-card.locked { opacity: 0.6; }

      .achievement-card.unlocked {
        background: linear-gradient(135deg, rgba(46, 204, 113, 0.3), rgba(39, 174, 96, 0.3));
      }

      .achievement-badge { font-size: 28px; text-align: center; margin-bottom: 8px; }
      .achievement-name { font-weight: bold; font-size: 14px; }
      .achievement-desc { font-size: 12px; opacity: 0.9; margin-top: 4px; }
      .achievement-progress { font-size: 11px; color: #f39c12; margin-top: 4px; }
      .achievement-date { font-size: 11px; opacity: 0.7; margin-top: 4px; }

      .unlocked-badge {
        position: absolute;
        top: 8px;
        right: 8px;
        background: #2ecc71;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
      }

      .reward-modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .reward-overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.7);
      }

      .reward-content {
        position: relative;
        background: white;
        color: #333;
        padding: 32px;
        border-radius: 16px;
        text-align: center;
        animation: slideIn 0.3s ease;
      }

      @keyframes slideIn {
        from { transform: translateY(-50px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }

      .reward-content h2 { margin: 0 0 16px; color: #e74c3c; }
      .reward-title { font-size: 18px; font-weight: bold; margin-bottom: 16px; }

      .reward-items { margin: 20px 0; }

      .reward-item {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 8px;
        background: #f5f5f5;
        border-radius: 6px;
        margin: 8px 0;
      }

      .reward-item.special { background: #fff3cd; }

      .close-btn {
        background: #3498db;
        color: white;
        border: none;
        padding: 12px 32px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 16px;
        margin-top: 16px;
      }

      .close-btn:hover { background: #2980b9; }

      @media (max-width: 768px) {
        .progress-stats { grid-template-columns: repeat(2, 1fr); }
        .achievements-grid { grid-template-columns: 1fr; }
        .region-grid { grid-template-columns: 1fr; }
      }
    `;
  }

  renderError(error) {
    this.container.innerHTML = `
      <div class="pokedex-error">
        <h3>⚠️ 加载失败</h3>
        <p>${error.message}</p>
        <button onclick="location.reload()">重试</button>
      </div>
    `;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PokedexProgress;
}

// 全局注册
if (typeof window !== 'undefined') {
  window.PokedexProgress = PokedexProgress;
}
