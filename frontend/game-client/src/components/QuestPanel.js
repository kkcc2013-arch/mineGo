// frontend/game-client/src/components/QuestPanel.js
// 精灵日常任务系统 - 前端面板组件
'use strict';

import { api } from '../api/client.js';
import { store } from '../game/GameStore.js';

/**
 * QuestPanel - 任务面板组件
 * 
 * 功能：
 * - 显示每日任务列表
 * - 任务进度追踪
 * - 奖励领取
 * - 连击信息展示
 */
class QuestPanel {
  constructor(container) {
    this.container = container || document.getElementById('quest-panel');
    this.quests = [];
    this.streak = { current_streak: 0, multiplier: 1.0 };
    this.loading = false;
    this.refreshTimer = null;
    
    this.init();
  }

  /**
   * 初始化
   */
  async init() {
    await this.loadData();
    this.render();
    this.startAutoRefresh();
  }

  /**
   * 加载数据
   */
  async loadData() {
    this.loading = true;
    this.render();

    try {
      // 并行加载任务和连击信息
      const [questsRes, streakRes] = await Promise.all([
        api.get('/quests'),
        api.get('/quests/streak'),
      ]);

      this.quests = questsRes.data || [];
      this.streak = streakRes.data || { current_streak: 0, multiplier: 1.0 };
      
      // 更新 store
      store.set({ quests: this.quests, questStreak: this.streak });
    } catch (error) {
      console.error('[QuestPanel] Failed to load data:', error);
      this.showError('加载任务失败，请稍后重试');
    } finally {
      this.loading = false;
      this.render();
    }
  }

  /**
   * 领取奖励
   */
  async claimReward(questId) {
    try {
      const result = await api.post(`/quests/${questId}/claim`);
      
      // 显示奖励动画
      this.showRewardAnimation(result.data);
      
      // 重新加载数据
      await this.loadData();
      
      // 通知用户
      store.addNotification(`🎁 奖励已领取！倍率: ${result.data.multiplier}x`, 'success');
    } catch (error) {
      console.error('[QuestPanel] Failed to claim reward:', error);
      this.showError('领取奖励失败');
    }
  }

  /**
   * 显示奖励动画
   */
  showRewardAnimation(rewards) {
    const modal = document.createElement('div');
    modal.className = 'reward-modal';
    modal.innerHTML = `
      <div class="reward-content">
        <h2>🎉 任务完成！</h2>
        <div class="reward-items">
          ${rewards.rewards.items.map(item => `
            <div class="reward-item">
              <span class="item-icon">${this.getItemIcon(item.type)}</span>
              <span class="item-name">${item.type}</span>
              <span class="item-count">x${item.count}</span>
            </div>
          `).join('')}
          ${rewards.rewards.stardust > 0 ? `
            <div class="reward-item">
              <span class="item-icon">⭐</span>
              <span class="item-name">星尘</span>
              <span class="item-count">x${rewards.rewards.stardust}</span>
            </div>
          ` : ''}
          ${rewards.rewards.xp > 0 ? `
            <div class="reward-item">
              <span class="item-icon">✨</span>
              <span class="item-name">经验</span>
              <span class="item-count">+${rewards.rewards.xp}</span>
            </div>
          ` : ''}
        </div>
        <div class="streak-info">
          <span>🔥 连击: ${rewards.streak}天</span>
          <span>倍率: ${rewards.multiplier}x</span>
        </div>
        <button class="close-btn">确定</button>
      </div>
    `;

    document.body.appendChild(modal);
    
    modal.querySelector('.close-btn').addEventListener('click', () => {
      modal.remove();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
  }

  /**
   * 获取道具图标
   */
  getItemIcon(type) {
    const icons = {
      poke_ball: '🔴',
      great_ball: '🔵',
      ultra_ball: '🟡',
      master_ball: '🟣',
      razz_berry: '🫐',
      golden_razz_berry: '🍇',
      revive: '💚',
      potion: '❤️',
      rare_candy: '🍬',
      incubator: '🥚',
      tm: '💿',
    };
    return icons[type] || '📦';
  }

  /**
   * 获取任务图标
   */
  getQuestIcon(type) {
    const icons = {
      catch: '🎯',
      battle: '⚔️',
      social: '🤝',
      explore: '🗺️',
      evolve: '✨',
      breed: '🥚',
      special: '🌟',
    };
    return icons[type] || '📋';
  }

  /**
   * 获取难度样式
   */
  getDifficultyClass(difficulty) {
    return `difficulty-${difficulty}`;
  }

  /**
   * 获取任务标题
   */
  getQuestTitle(quest) {
    const titles = {
      'quest.catch_water.title': '捕捉水属性精灵',
      'quest.catch_fire.title': '捕捉火属性精灵',
      'quest.catch_rare.title': '捕捉稀有精灵',
      'quest.catch_total.title': '捕捉精灵',
      'quest.gym_battle.title': '道馆战斗',
      'quest.trade.title': '精灵交换',
      'quest.pokestop.title': '访问补给站',
      'quest.evolve.title': '精灵进化',
      'quest.hatch_egg.title': '孵化精灵蛋',
    };
    return titles[quest.title_i18n_key] || quest.title_i18n_key;
  }

  /**
   * 渲染
   */
  render() {
    if (!this.container) return;

    if (this.loading) {
      this.container.innerHTML = `
        <div class="quest-panel loading">
          <div class="loading-spinner"></div>
          <p>加载任务中...</p>
        </div>
      `;
      return;
    }

    this.container.innerHTML = `
      <div class="quest-panel">
        <div class="quest-header">
          <h2>📋 每日任务</h2>
          <div class="streak-badge">
            <span class="streak-flame">🔥</span>
            <span class="streak-count">${this.streak.current_streak}天</span>
            <span class="streak-multiplier">${this.streak.multiplier}x</span>
          </div>
        </div>

        <div class="quest-list">
          ${this.quests.length === 0 ? `
            <div class="no-quests">
              <p>暂无任务</p>
              <button class="refresh-btn" onclick="questPanel.loadData()">刷新</button>
            </div>
          ` : this.quests.map(quest => `
            <div class="quest-card ${quest.status} ${this.getDifficultyClass(quest.difficulty)}">
              <div class="quest-icon">${this.getQuestIcon(quest.quest_type)}</div>
              
              <div class="quest-content">
                <div class="quest-title">${this.getQuestTitle(quest)}</div>
                <div class="quest-progress">
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: ${(quest.progress_current / quest.progress_target) * 100}%"></div>
                  </div>
                  <span class="progress-text">${quest.progress_current}/${quest.progress_target}</span>
                </div>
                
                <div class="quest-rewards">
                  ${quest.reward_config?.items?.slice(0, 2).map(item => `
                    <span class="reward-badge">${this.getItemIcon(item.type)} x${item.count}</span>
                  `).join('') || ''}
                  ${quest.reward_config?.stardust ? `
                    <span class="reward-badge">⭐ ${quest.reward_config.stardust}</span>
                  ` : ''}
                </div>
              </div>

              ${quest.status === 'completed' ? `
                <button class="claim-btn" onclick="questPanel.claimReward('${quest.id}')">
                  领取奖励
                </button>
              ` : quest.status === 'claimed' ? `
                <div class="claimed-badge">✓ 已领取</div>
              ` : ''}
            </div>
          `).join('')}
        </div>

        <div class="quest-footer">
          <button class="refresh-btn" onclick="questPanel.loadData()">🔄 刷新</button>
          <div class="quest-info">
            任务每日 0:00 刷新 | 完成任务获得奖励倍率加成
          </div>
        </div>
      </div>
    `;
  }

  /**
   * 显示错误
   */
  showError(message) {
    store.addNotification(message, 'error');
  }

  /**
   * 开始自动刷新
   */
  startAutoRefresh() {
    // 每 5 分钟刷新一次
    this.refreshTimer = setInterval(() => {
      this.loadData();
    }, 5 * 60 * 1000);
  }

  /**
   * 停止自动刷新
   */
  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * 销毁
   */
  destroy() {
    this.stopAutoRefresh();
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}

// 导出单例
let questPanel = null;

/**
 * 初始化任务面板
 */
function initQuestPanel(container) {
  if (!questPanel) {
    questPanel = new QuestPanel(container);
  }
  return questPanel;
}

// 全局访问（用于 onclick）
window.questPanel = questPanel;

export { QuestPanel, initQuestPanel, questPanel };