// backend/services/social-service/src/trade/stardust.js
// 精灵交易星尘消耗计算模块

'use strict';

/**
 * 稀有度系数映射
 */
const RARITY_MULTIPLIERS = {
  COMMON: 1.0,
  UNCOMMON: 1.5,
  RARE: 2.0,
  EPIC: 3.0,
  LEGENDARY: 5.0
};

/**
 * 好友等级折扣映射
 */
const FRIEND_LEVEL_DISCOUNTS = {
  GOOD: 0.9,    // 9折
  GREAT: 0.8,   // 8折
  ULTRA: 0.7,   // 7折
  BEST: 0.6     // 6折
};

/**
 * 基础星尘消耗（近距离交易）
 */
const BASE_STARDUST_COST = 100;

/**
 * 远程交易倍率
 */
const REMOTE_TRADE_MULTIPLIER = 3;

/**
 * 计算交易星尘消耗
 * @param {Object} pokemon1 - 发起方精灵
 * @param {Object} pokemon2 - 接收方精灵
 * @param {string} friendLevel - 好友等级
 * @param {boolean} isRemote - 是否远程交易
 * @returns {number} 星尘消耗
 */
function calculateStardustCost(pokemon1, pokemon2, friendLevel, isRemote = false) {
  // 基础消耗
  let cost = BASE_STARDUST_COST;

  // 稀有度系数（取两个精灵的平均值）
  const rarity1 = RARITY_MULTIPLIERS[pokemon1.rarity] || 1.0;
  const rarity2 = RARITY_MULTIPLIERS[pokemon2.rarity] || 1.0;
  const rarityMultiplier = (rarity1 + rarity2) / 2;
  cost *= rarityMultiplier;

  // CP 差异系数（差异越大，消耗越高）
  const cpDiff = Math.abs((pokemon1.cp || 0) - (pokemon2.cp || 0));
  const cpMultiplier = 1 + (cpDiff / 1000);
  cost *= cpMultiplier;

  // 好友等级折扣
  const discount = FRIEND_LEVEL_DISCOUNTS[friendLevel] || 1.0;
  cost *= discount;

  // 远程交易倍率
  if (isRemote) {
    cost *= REMOTE_TRADE_MULTIPLIER;
  }

  // 最低 100 星尘
  return Math.max(100, Math.floor(cost));
}

/**
 * 计算精灵价值（用于防作弊）
 * @param {Object} pokemon - 精灵实例
 * @returns {number} 精灵价值分数
 */
function calculatePokemonValue(pokemon) {
  let value = 0;

  // 基础价值（CP）
  value += (pokemon.cp || 0) * 1;

  // 稀有度价值
  const rarityValues = {
    COMMON: 100,
    UNCOMMON: 300,
    RARE: 1000,
    EPIC: 5000,
    LEGENDARY: 20000
  };
  value += rarityValues[pokemon.rarity] || 0;

  // IV 价值
  if (pokemon.iv_attack !== undefined && pokemon.iv_defense !== undefined && pokemon.iv_hp !== undefined) {
    const totalIV = (pokemon.iv_attack || 0) + (pokemon.iv_defense || 0) + (pokemon.iv_hp || 0);
    value += totalIV * 50;
  }

  // 幸运精灵加成
  if (pokemon.is_lucky) {
    value *= 1.5;
  }

  // 闪光精灵加成
  if (pokemon.is_shiny) {
    value *= 2;
  }

  return Math.floor(value);
}

/**
 * 获取稀有度系数
 * @param {string} rarity - 稀有度
 * @returns {number} 系数
 */
function getRarityMultiplier(rarity) {
  return RARITY_MULTIPLIERS[rarity] || 1.0;
}

/**
 * 获取好友等级折扣
 * @param {string} level - 好友等级
 * @returns {number} 折扣系数
 */
function getFriendLevelDiscount(level) {
  return FRIEND_LEVEL_DISCOUNTS[level] || 1.0;
}

module.exports = {
  calculateStardustCost,
  calculatePokemonValue,
  getRarityMultiplier,
  getFriendLevelDiscount,
  RARITY_MULTIPLIERS,
  FRIEND_LEVEL_DISCOUNTS,
  BASE_STARDUST_COST,
  REMOTE_TRADE_MULTIPLIER
};
