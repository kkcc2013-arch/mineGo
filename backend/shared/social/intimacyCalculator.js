/**
 * 精灵好友亲密度计算引擎与等级奖励（REQ-00326）——纯函数
 */
'use strict';

const LEVEL_THRESHOLDS = Object.freeze([0, 100, 300, 600, 1000, 1500, 2100, 2800, 3600, 4500, 5500]);
const MAX_LEVEL = 10;
const MAX_SCORE = 10000;

const LEVEL_MULTIPLIERS = Object.freeze({
  1: 1.0, 2: 1.1, 3: 1.2, 4: 1.3, 5: 1.5, 6: 1.7, 7: 2.0, 8: 2.5, 9: 3.0, 10: 4.0,
});

/** 互动类型：基础亲密度与冷却（秒） */
const INTERACTION_TYPES = Object.freeze({
  visit: { base: 10, cooldown: 3600, name: '拜访' },
  gift: { base: 20, cooldown: 86400, name: '送礼' },
  adventure: { base: 50, cooldown: 604800, name: '共同探险' },
  photo: { base: 5, cooldown: 7200, name: '合影' },
  training: { base: 30, cooldown: 43200, name: '训练' },
});

/** 等级奖励（达到该等级时为双方精灵各发一次） */
const FRIENDSHIP_REWARDS = Object.freeze({
  1: { type: 'badge', name: 'new_friends', title: '新朋友徽章' },
  2: { type: 'keepsake', itemId: 'friendship_ribbon', rarity: 'uncommon', title: '友谊丝带' },
  3: { type: 'boost', boostType: 'intimacy_gain', value: 1.1, days: 7, title: '亲密度获取 +10%' },
  4: { type: 'feature', feature: 'gift_premium_items', title: '解锁高级礼物' },
  5: { type: 'keepsake', itemId: 'friendship_medal', rarity: 'rare', title: '友谊奖章' },
  6: { type: 'boost', boostType: 'adventure_reward', value: 1.2, days: 7, title: '探险奖励 +20%' },
  7: { type: 'feature', feature: 'joint_training', title: '解锁联合训练' },
  8: { type: 'keepsake', itemId: 'friendship_crown', rarity: 'epic', title: '友谊王冠' },
  9: { type: 'boost', boostType: 'all_friendship_benefits', value: 1.3, days: 7, title: '全部友谊收益 +30%' },
  10: { type: 'special', feature: 'soul_bond', title: '灵魂羁绊', description: '解锁灵魂羁绊技能' },
});

class IntimacyCalculator {
  constructor(config = {}) {
    this.thresholds = config.thresholds || LEVEL_THRESHOLDS;
    this.levelMultipliers = config.levelMultipliers || LEVEL_MULTIPLIERS;
    this.interactionTypes = config.interactionTypes || INTERACTION_TYPES;
  }

  isValidType(type) {
    return Object.prototype.hasOwnProperty.call(this.interactionTypes, type);
  }

  cooldownSeconds(type) {
    return this.isValidType(type) ? this.interactionTypes[type].cooldown : 0;
  }

  /**
   * @param {string} type
   * @param {number} currentLevel 1-10
   * @param {object} bonuses { sameSpecies, compatibleType, crossRegion, eventActive, boost }
   */
  calculateGain(type, currentLevel, bonuses = {}) {
    if (!this.isValidType(type)) throw new Error(`unknown interaction type ${type}`);
    const base = this.interactionTypes[type].base;
    const levelMult = this.levelMultipliers[currentLevel] || 1.0;
    let total = base * levelMult;
    if (bonuses.sameSpecies) total *= 1.5;
    if (bonuses.compatibleType) total *= 1.2;
    if (bonuses.crossRegion) total *= 1.3;
    if (bonuses.eventActive) total *= 2.0;
    if (bonuses.boost && bonuses.boost > 1) total *= bonuses.boost;
    return Math.floor(total);
  }

  /** 当前分数对应的等级（1-10） */
  levelForScore(score) {
    let level = 1;
    for (let l = 1; l <= MAX_LEVEL; l++) {
      if (score >= this.thresholds[l - 1]) level = l;
    }
    return level;
  }

  canLevelUp(currentScore, currentLevel) {
    if (currentLevel >= MAX_LEVEL) return false;
    return currentScore >= this.thresholds[currentLevel];
  }

  /** 应用一次互动：返回新分数、新等级、跨过的等级列表 */
  applyGain(currentScore, currentLevel, gain) {
    const score = Math.min(MAX_SCORE, Math.max(0, currentScore + gain));
    const level = Math.max(currentLevel, this.levelForScore(score));
    const levelsGained = [];
    for (let l = currentLevel + 1; l <= level; l++) levelsGained.push(l);
    return { score, level, levelsGained };
  }

  /** 距下一次可互动的剩余秒数（0 表示可互动） */
  cooldownRemaining(type, lastAt, now = Date.now()) {
    if (!lastAt) return 0;
    const t = lastAt instanceof Date ? lastAt.getTime() : new Date(lastAt).getTime();
    const remain = Math.ceil((t + this.cooldownSeconds(type) * 1000 - now) / 1000);
    return Math.max(0, remain);
  }
}

/** 由已达等级推导生效中的亲密度加成倍数（3 级 ×1.1，9 级 ×1.3，取最高） */
function activeBoost(level) {
  if (level >= 9) return FRIENDSHIP_REWARDS[9].value;
  if (level >= 3) return FRIENDSHIP_REWARDS[3].value;
  return 1;
}

/** 两点间球面距离（公里） */
function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined || !Number.isFinite(Number(v)))) return null;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** 两只精灵之间的互动加成：同种、属性相合、跨区域（捕获地相距 ≥ 100km） */
function pairBonuses(a, b) {
  const typesA = [a.type1, a.type2].filter(Boolean);
  const typesB = [b.type1, b.type2].filter(Boolean);
  const dist = haversineKm(a.caught_lat, a.caught_lng, b.caught_lat, b.caught_lng);
  return {
    sameSpecies: a.species_id != null && a.species_id === b.species_id,
    compatibleType: typesA.some((t) => typesB.includes(t)),
    crossRegion: dist !== null && dist >= 100,
    distanceKm: dist === null ? null : Math.round(dist),
  };
}

module.exports = {
  IntimacyCalculator,
  LEVEL_THRESHOLDS,
  LEVEL_MULTIPLIERS,
  INTERACTION_TYPES,
  FRIENDSHIP_REWARDS,
  MAX_LEVEL,
  MAX_SCORE,
  activeBoost,
  haversineKm,
  pairBonuses,
};
