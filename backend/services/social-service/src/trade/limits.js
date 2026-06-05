// backend/services/social-service/src/trade/limits.js
// 精灵交易限制模块

'use strict';

const { query } = require('../../../shared/db');

/**
 * 交易限制配置
 */
const TradeLimits = {
  maxDailyTrades: 100,         // 每日最多 100 次交易
  minFriendLevel: 'GOOD',      // 最低好友等级
  minPokemonLevel: 10,         // 精灵最低等级
  cooldownBetweenTrades: 60000, // 同一人交易冷却 1 分钟
  maxRecentTrades: 5,          // 同一精灵最近 7 天最多交易 5 次
  maxNewAccountTrades: 50      // 新账号（<7天）最多交易 50 次
};

/**
 * 检查交易限制
 * @param {string} userId - 用户ID
 * @param {string} friendId - 好友ID
 * @param {Object} pokemon - 精灵实例
 * @returns {Object} { allowed: boolean, reason?: string, remaining?: number }
 */
async function checkTradeLimits(userId, friendId, pokemon) {
  // 1. 每日交易次数
  const dailyCheck = await checkDailyTradeLimit(userId);
  if (!dailyCheck.allowed) {
    return dailyCheck;
  }

  // 2. 好友等级检查
  const friendCheck = await checkFriendLevel(userId, friendId);
  if (!friendCheck.allowed) {
    return friendCheck;
  }

  // 3. 精灵等级检查
  if (pokemon.level && pokemon.level < TradeLimits.minPokemonLevel) {
    return {
      allowed: false,
      reason: `精灵等级不足（需要 ${TradeLimits.minPokemonLevel} 级）`
    };
  }

  // 4. 冷却时间检查
  const cooldownCheck = await checkTradeCooldown(userId, friendId);
  if (!cooldownCheck.allowed) {
    return cooldownCheck;
  }

  // 5. 新账号检查
  const newAccountCheck = await checkNewAccountLimit(userId);
  if (!newAccountCheck.allowed) {
    return newAccountCheck;
  }

  return { allowed: true };
}

/**
 * 检查每日交易限制
 */
async function checkDailyTradeLimit(userId) {
  const { rows: [result] } = await query(`
    SELECT COUNT(*)::int AS count
    FROM pokemon_trades
    WHERE initiator_id = $1
      AND created_at >= CURRENT_DATE
  `, [userId]);

  if (result.count >= TradeLimits.maxDailyTrades) {
    return {
      allowed: false,
      reason: `今日交易次数已达上限（${TradeLimits.maxDailyTrades} 次）`
    };
  }

  return { allowed: true, remaining: TradeLimits.maxDailyTrades - result.count };
}

/**
 * 检查好友等级
 */
async function checkFriendLevel(userId, friendId) {
  const [a, b] = userId < friendId ? [userId, friendId] : [friendId, userId];
  
  const { rows: [friendship] } = await query(`
    SELECT level FROM friendships WHERE user_a = $1 AND user_b = $2
  `, [a, b]);

  if (!friendship) {
    return { allowed: false, reason: '你们还不是好友' };
  }

  const levels = ['GOOD', 'GREAT', 'ULTRA', 'BEST'];
  const currentLevelIndex = levels.indexOf(friendship.level);
  const minLevelIndex = levels.indexOf(TradeLimits.minFriendLevel);

  if (currentLevelIndex < minLevelIndex) {
    return {
      allowed: false,
      reason: `好友等级不足（需要 ${TradeLimits.minFriendLevel}）`
    };
  }

  return { allowed: true };
}

/**
 * 检查交易冷却时间
 */
async function checkTradeCooldown(userId, friendId) {
  const { rows: [lastTrade] } = await query(`
    SELECT created_at
    FROM pokemon_trades
    WHERE (initiator_id = $1 AND receiver_id = $2)
       OR (initiator_id = $2 AND receiver_id = $1)
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId, friendId]);

  if (lastTrade) {
    const elapsed = Date.now() - new Date(lastTrade.created_at).getTime();
    if (elapsed < TradeLimits.cooldownBetweenTrades) {
      const remaining = TradeLimits.cooldownBetweenTrades - elapsed;
      return {
        allowed: false,
        reason: '交易冷却中',
        remaining: Math.ceil(remaining / 1000)
      };
    }
  }

  return { allowed: true };
}

/**
 * 检查新账号限制
 */
async function checkNewAccountLimit(userId) {
  const { rows: [user] } = await query(`
    SELECT created_at FROM users WHERE id = $1
  `, [userId]);

  if (!user) {
    return { allowed: false, reason: '用户不存在' };
  }

  const accountAge = Date.now() - new Date(user.created_at).getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  if (accountAge < sevenDays) {
    const { rows: [result] } = await query(`
      SELECT COUNT(*)::int AS count
      FROM pokemon_trades
      WHERE initiator_id = $1 OR receiver_id = $1
    `, [userId]);

    if (result.count >= TradeLimits.maxNewAccountTrades) {
      return {
        allowed: false,
        reason: `新账号交易次数已达上限（${TradeLimits.maxNewAccountTrades} 次）`
      };
    }
  }

  return { allowed: true };
}

/**
 * 检查精灵频繁交易
 */
async function checkPokemonFrequentTrade(pokemonId) {
  const { rows: [result] } = await query(`
    SELECT COUNT(*)::int AS count
    FROM pokemon_trades
    WHERE (offered_pokemon = $1 OR received_pokemon = $1)
      AND created_at >= NOW() - INTERVAL '7 days'
  `, [pokemonId]);

  if (result.count >= TradeLimits.maxRecentTrades) {
    return {
      allowed: false,
      reason: `精灵交易过于频繁（7 天内已交易 ${result.count} 次）`
    };
  }

  return { allowed: true };
}

module.exports = {
  TradeLimits,
  checkTradeLimits,
  checkDailyTradeLimit,
  checkFriendLevel,
  checkTradeCooldown,
  checkNewAccountLimit,
  checkPokemonFrequentTrade
};
