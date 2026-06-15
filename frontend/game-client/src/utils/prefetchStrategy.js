// frontend/game-client/src/utils/prefetchStrategy.js
// Intelligent prefetch strategy based on user behavior
'use strict';

import { lazyLoader } from './lazyLoad.js';

/**
 * 智能预加载策略
 * 根据用户行为预测可能需要的模块并提前加载
 */
class PrefetchStrategy {
  constructor() {
    this.userBehavior = [];
    this.maxBehaviorRecords = 50;
    this.prefetchRules = this.initRules();
    this.enabled = true;
    this.lastPrefetchTime = 0;
    this.minPrefetchInterval = 1000; // 最小预加载间隔
  }

  /**
   * 初始化预加载规则
   */
  initRules() {
    return [
      // 规则1：用户进入地图后，预加载捕捉和道馆
      {
        trigger: 'map:enter',
        prefetch: [
          { chunk: 'catch', importFn: () => import('../game/CatchEngine.js') },
          { chunk: 'gym-detail', importFn: () => import('../components/GymDetail.js') }
        ],
        delay: 2000
      },

      // 规则2：用户查看精灵详情时，预加载 3D 查看器
      {
        trigger: 'pokemon:detail',
        prefetch: [
          { chunk: 'pokemon-3d-viewer', importFn: () => import('../3d/Pokemon3DViewer.js') }
        ],
        delay: 500
      },

      // 规则3：用户开始战斗时，预加载音效和战斗特效
      {
        trigger: 'battle:start',
        prefetch: [
          { chunk: 'audio', importFn: () => import('../audio/AudioPlayer.js') },
          { chunk: 'battle-effects', importFn: () => import('../effects/BattleEffects.js') }
        ],
        delay: 0
      },

      // 规则4：用户打开社交页时，预加载聊天和交易
      {
        trigger: 'social:enter',
        prefetch: [
          { chunk: 'chat', importFn: () => import('../components/ChatPanel.js') },
          { chunk: 'trading', importFn: () => import('../components/TradingModal.js') }
        ],
        delay: 1000
      },

      // 规则5：用户接近道馆时，预加载战斗系统
      {
        trigger: 'gym:nearby',
        prefetch: [
          { chunk: 'gym-battle', importFn: () => import('../components/GymBattle.js') }
        ],
        delay: 0
      },

      // 规则6：用户查看图鉴时，预加载排行榜
      {
        trigger: 'pokedex:open',
        prefetch: [
          { chunk: 'leaderboard', importFn: () => import('../components/LeaderboardPanel.js') }
        ],
        delay: 2000
      },

      // 规则7：用户进入商店时，预加载支付相关模块
      {
        trigger: 'shop:enter',
        prefetch: [
          { chunk: 'payment', importFn: () => import('../components/PaymentModal.js') }
        ],
        delay: 1500
      },

      // 规则8：用户捕获成功后，预加载精灵详情
      {
        trigger: 'catch:success',
        prefetch: [
          { chunk: 'pokemon-detail', importFn: () => import('../components/PokemonDetail.js') }
        ],
        delay: 1000
      },

      // 规则9：用户连接 WiFi 时，预加载所有模块
      {
        trigger: 'network:wifi',
        prefetch: 'all',
        delay: 5000
      },

      // 规则10：用户打开设置时，预加载帮助文档
      {
        trigger: 'settings:open',
        prefetch: [
          { chunk: 'help', importFn: () => import('../components/HelpPanel.js') }
        ],
        delay: 2000
      }
    ];
  }

  /**
   * 记录用户行为
   */
  recordBehavior(event, metadata = {}) {
    const behavior = {
      event,
      metadata,
      timestamp: Date.now()
    };

    this.userBehavior.push(behavior);

    // 保留最近的行为记录
    if (this.userBehavior.length > this.maxBehaviorRecords) {
      this.userBehavior.shift();
    }

    // 触发预加载检查
    this.checkPrefetch(behavior);

    // 分析用户模式
    this.analyzeUserPattern();
  }

  /**
   * 检查是否需要预加载
   */
  checkPrefetch(behavior) {
    if (!this.enabled) return;

    const now = Date.now();

    // 检查最小预加载间隔
    if (now - this.lastPrefetchTime < this.minPrefetchInterval) {
      return;
    }

    for (const rule of this.prefetchRules) {
      if (rule.trigger === behavior.event) {
        this.lastPrefetchTime = now;
        this.schedulePrefetch(rule);
      }
    }
  }

  /**
   * 调度预加载
   */
  schedulePrefetch(rule) {
    if (rule.delay > 0) {
      setTimeout(() => this.executePrefetch(rule), rule.delay);
    } else {
      this.executePrefetch(rule);
    }
  }

  /**
   * 执行预加载
   */
  executePrefetch(rule) {
    if (rule.prefetch === 'all') {
      // 预加载所有规则
      this.prefetchRules.forEach(r => {
        if (r.prefetch !== 'all') {
          this.prefetchChunks(r.prefetch);
        }
      });
    } else {
      this.prefetchChunks(rule.prefetch);
    }
  }

  /**
   * 预加载一组 chunk
   */
  prefetchChunks(chunks) {
    chunks.forEach(({ chunk, importFn }) => {
      lazyLoader.prefetch(chunk, importFn);
    });
  }

  /**
   * 分析用户行为模式
   */
  analyzeUserPattern() {
    if (this.userBehavior.length < 5) return;

    // 分析最近 10 次行为
    const recentBehaviors = this.userBehavior.slice(-10);
    const behaviorCounts = {};

    recentBehaviors.forEach(b => {
      behaviorCounts[b.event] = (behaviorCounts[b.event] || 0) + 1;
    });

    // 找出频繁行为
    Object.entries(behaviorCounts).forEach(([event, count]) => {
      if (count >= 3) {
        // 用户频繁执行某操作，预加载相关模块
        const rule = this.prefetchRules.find(r => r.trigger === event);
        if (rule && rule.prefetch !== 'all') {
          this.prefetchChunks(rule.prefetch);
        }
      }
    });
  }

  /**
   * 基于时间预测预加载
   */
  timeBasedPrefetch() {
    const hour = new Date().getHours();

    // 晚高峰（18:00-22:00），预加载社交模块
    if (hour >= 18 && hour < 22) {
      lazyLoader.prefetch('chat', () => import('../components/ChatPanel.js'));
      lazyLoader.prefetch('social', () => import('../components/SocialPanel.js'));
    }

    // 周末预加载更多模块
    const day = new Date().getDay();
    if (day === 0 || day === 6) {
      lazyLoader.prefetch('leaderboard', () => import('../components/LeaderboardPanel.js'));
      lazyLoader.prefetch('shop', () => import('../components/ShopPanel.js'));
    }
  }

  /**
   * 基于网络状况调整策略
   */
  adjustForNetwork() {
    if ('connection' in navigator) {
      const connection = navigator.connection;

      // 慢速网络，禁用预加载
      if (connection.effectiveType === '2g' || connection.effectiveType === 'slow-2g') {
        this.enabled = false;
        console.log('[PrefetchStrategy] Disabled due to slow network');
      }

      // WiFi 网络，积极预加载
      if (connection.type === 'wifi') {
        this.recordBehavior('network:wifi');
      }
    }
  }

  /**
   * 启用/禁用预加载
   */
  setEnabled(enabled) {
    this.enabled = enabled;
  }

  /**
   * 获取用户行为统计
   */
  getBehaviorStats() {
    const stats = {
      total: this.userBehavior.length,
      eventCounts: {},
      recentEvents: this.userBehavior.slice(-10)
    };

    this.userBehavior.forEach(b => {
      stats.eventCounts[b.event] = (stats.eventCounts[b.event] || 0) + 1;
    });

    return stats;
  }

  /**
   * 清除行为记录
   */
  clearBehaviorHistory() {
    this.userBehavior = [];
  }
}

// 导出单例
export const prefetchStrategy = new PrefetchStrategy();

// 自动初始化网络检测
prefetchStrategy.adjustForNetwork();

// 监听网络变化
if ('connection' in navigator) {
  navigator.connection.addEventListener('change', () => {
    prefetchStrategy.adjustForNetwork();
  });
}
