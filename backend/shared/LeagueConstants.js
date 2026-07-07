// REQ-00487: 精灵竞技联赛常量定义
'use strict';

const LEAGUE_LEVELS = {
  BRONZE: {
    name: '青铜联赛',
    minPoints: 0,
    maxPoints: 999,
    groups: ['I', 'II', 'III'],
    rewards: { seasonEnd: 100, promotion: 50 },
    icon: 'bronze_badge.png'
  },
  SILVER: {
    name: '白银联赛',
    minPoints: 1000,
    maxPoints: 1999,
    groups: ['I', 'II', 'III'],
    rewards: { seasonEnd: 200, promotion: 100 },
    icon: 'silver_badge.png'
  },
  GOLD: {
    name: '黄金联赛',
    minPoints: 2000,
    maxPoints: 2999,
    groups: ['I', 'II', 'III'],
    rewards: { seasonEnd: 300, promotion: 150 },
    icon: 'gold_badge.png'
  },
  PLATINUM: {
    name: '铂金联赛',
    minPoints: 3000,
    maxPoints: 3999,
    groups: ['I', 'II', 'III'],
    rewards: { seasonEnd: 500, promotion: 200 },
    icon: 'platinum_badge.png'
  },
  DIAMOND: {
    name: '钻石联赛',
    minPoints: 4000,
    maxPoints: 4999,
    groups: ['I', 'II', 'III'],
    rewards: { seasonEnd: 800, promotion: 300 },
    icon: 'diamond_badge.png'
  },
  MASTER: {
    name: '大师联赛',
    minPoints: 5000,
    maxPoints: null,
    groups: ['I'],
    rewards: { seasonEnd: 1000, promotion: 0 },
    icon: 'master_badge.png'
  }
};

const LEAGUE_ORDER = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'MASTER'];

const SEASON_CONFIG = {
  durationDays: 28,
  breakDays: 2,
  startTime: new Date('2026-07-01T00:00:00Z'),
  autoRotate: true
};

const SEASON_REWARDS = {
  BRONZE: {
    coins: 100,
    items: ['basic_potion'],
    badge: 'bronze_season_badge'
  },
  SILVER: {
    coins: 200,
    items: ['super_potion', 'revive'],
    badge: 'silver_season_badge'
  },
  GOLD: {
    coins: 300,
    items: ['rare_candy', 'golden_berries'],
    badge: 'gold_season_badge'
  },
  PLATINUM: {
    coins: 500,
    items: ['legendary_candy', 'master_ball_fragment'],
    badge: 'platinum_season_badge'
  },
  DIAMOND: {
    coins: 800,
    items: ['exclusive_skin', 'master_ball'],
    badge: 'diamond_season_badge'
  },
  MASTER: {
    coins: 1000,
    items: ['legendary_encounter_ticket', 'exclusive_avatar'],
    badge: 'master_season_badge'
  }
};

const MATCHMAKING_CONFIG = {
  ratingRange: 200,        // 真实评分差范围
  groupRange: 1,           // 分组范围
  matchTimeout: 300000,    // 匹配超时 5分钟
  minMatchInterval: 300000 // 最小匹配间隔 5分钟
};

module.exports = {
  LEAGUE_LEVELS,
  LEAGUE_ORDER,
  SEASON_CONFIG,
  SEASON_REWARDS,
  MATCHMAKING_CONFIG
};
