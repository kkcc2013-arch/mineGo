// backend/services/social-service/src/trade/antiCheat.js
// 精灵交易反作弊模块

'use strict';

const { query } = require('../../../../shared/db');
const { createLogger } = require('../../../../shared/logger');
const { calculatePokemonValue } = require('./stardust');

const logger = createLogger('trade-anti-cheat');

/**
 * 可疑交易严重级别
 */
const Severity = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
};

/**
 * 检测可疑交易
 * @param {Object} trade - 交易对象
 * @param {Object} pokemon1 - 发起方精灵
 * @param {Object} pokemon2 - 接收方精灵
 * @returns {Array} 可疑标志列表
 */
async function detectSuspiciousTrade(trade, pokemon1, pokemon2) {
  const flags = [];

  try {
    // 1. 价值严重不对等
    const value1 = calculatePokemonValue(pokemon1);
    const value2 = calculatePokemonValue(pokemon2);
    const valueDiff = Math.abs(value1 - value2);
    const valueRatio = Math.max(value1, value2) / Math.min(value1, value2) || 1;

    if (valueRatio > 10) {
      flags.push({
        type: 'VALUE_IMBALANCE',
        severity: valueRatio > 50 ? Severity.CRITICAL : Severity.HIGH,
        valueDiff,
        valueRatio: Math.round(valueRatio * 100) / 100,
        message: `精灵价值差异过大（${value1} vs ${value2}）`
      });
    }

    // 2. 频繁交易同一精灵
    const recentTrades1 = await getPokemonRecentTrades(pokemon1.id, 7);
    const recentTrades2 = await getPokemonRecentTrades(pokemon2.id, 7);

    if (recentTrades1 > 3 || recentTrades2 > 3) {
      flags.push({
        type: 'FREQUENT_POKEMON_TRADE',
        severity: Severity.HIGH,
        pokemon1Trades: recentTrades1,
        pokemon2Trades: recentTrades2,
        message: `精灵频繁交易（${Math.max(recentTrades1, recentTrades2)} 次/周）`
      });
    }

    // 3. 新账号大量交易
    const accountAge1 = await getAccountAge(trade.initiator_id);
    const accountAge2 = await getAccountAge(trade.receiver_id);
    const totalTrades1 = await getTotalTrades(trade.initiator_id);
    const totalTrades2 = await getTotalTrades(trade.receiver_id);

    if ((accountAge1 < 7 && totalTrades1 > 30) || (accountAge2 < 7 && totalTrades2 > 30)) {
      flags.push({
        type: 'NEW_ACCOUNT_SPAM',
        severity: Severity.HIGH,
        accountAge1,
        accountAge2,
        totalTrades1,
        totalTrades2,
        message: '新账号大量交易行为'
      });
    }

    // 4. 同一IP地址
    const sameIP = await checkSameIP(trade.initiator_id, trade.receiver_id);
    if (sameIP) {
      flags.push({
        type: 'SAME_IP',
        severity: Severity.MEDIUM,
        message: '交易双方使用相同IP地址'
      });
    }

    // 5. 短时间内频繁交易同一人
    const frequentPartner = await checkFrequentPartner(trade.initiator_id, trade.receiver_id);
    if (frequentPartner) {
      flags.push({
        type: 'FREQUENT_PARTNER',
        severity: Severity.MEDIUM,
        count: frequentPartner.count,
        message: `短时间内与同一好友交易 ${frequentPartner.count} 次`
      });
    }

    // 6. 传说精灵交易
    if (pokemon1.rarity === 'LEGENDARY' || pokemon2.rarity === 'LEGENDARY') {
      flags.push({
        type: 'LEGENDARY_TRADE',
        severity: Severity.LOW,
        message: '传说精灵交易，需人工审核'
      });
    }

    // 记录可疑交易
    if (flags.length > 0) {
      await recordSuspiciousTrade(trade.id, flags);
      
      logger.warn({
        tradeId: trade.id,
        flags: flags.length,
        types: flags.map(f => f.type)
      }, '可疑交易检测');
    }

    return flags;
  } catch (error) {
    logger.error({ error, tradeId: trade.id }, '反作弊检测失败');
    return [];
  }
}

/**
 * 获取精灵最近交易次数
 */
async function getPokemonRecentTrades(pokemonId, days) {
  const { rows: [result] } = await query(`
    SELECT COUNT(*)::int AS count
    FROM pokemon_trades
    WHERE (offered_pokemon = $1 OR received_pokemon = $1)
      AND created_at >= NOW() - INTERVAL '${days} days'
  `, [pokemonId]);

  return result.count;
}

/**
 * 获取账号年龄（天数）
 */
async function getAccountAge(userId) {
  const { rows: [user] } = await query(`
    SELECT created_at FROM users WHERE id = $1
  `, [userId]);

  if (!user) return 0;
  
  return Math.floor((Date.now() - new Date(user.created_at).getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * 获取用户总交易次数
 */
async function getTotalTrades(userId) {
  const { rows: [result] } = await query(`
    SELECT COUNT(*)::int AS count
    FROM pokemon_trades
    WHERE initiator_id = $1 OR receiver_id = $1
  `, [userId]);

  return result.count;
}

/**
 * 检查是否使用相同IP
 */
async function checkSameIP(userId1, userId2) {
  // 检查最近24小时内是否有相同IP登录记录
  const { rows: [result] } = await query(`
    SELECT COUNT(*)::int AS count
    FROM user_sessions us1
    JOIN user_sessions us2 ON us1.ip_address = us2.ip_address
    WHERE us1.user_id = $1
      AND us2.user_id = $2
      AND us1.created_at >= NOW() - INTERVAL '24 hours'
      AND us2.created_at >= NOW() - INTERVAL '24 hours'
  `, [userId1, userId2]);

  return result.count > 0;
}

/**
 * 检查频繁交易伙伴
 */
async function checkFrequentPartner(userId1, userId2) {
  const { rows: [result] } = await query(`
    SELECT COUNT(*)::int AS count
    FROM pokemon_trades
    WHERE ((initiator_id = $1 AND receiver_id = $2)
       OR (initiator_id = $2 AND receiver_id = $1))
      AND created_at >= NOW() - INTERVAL '1 hour'
  `, [userId1, userId2]);

  return result.count >= 10 ? result : null;
}

/**
 * 记录可疑交易
 */
async function recordSuspiciousTrade(tradeId, flags) {
  try {
    await query(`
      INSERT INTO suspicious_trades (trade_id, flags, severity, created_at)
      VALUES ($1, $2, $3, NOW())
    `, [
      tradeId,
      JSON.stringify(flags),
      getHighestSeverity(flags)
    ]);
  } catch (error) {
    logger.error({ error, tradeId }, '记录可疑交易失败');
  }
}

/**
 * 获取最高严重级别
 */
function getHighestSeverity(flags) {
  const order = [Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL];
  let highest = Severity.LOW;
  
  for (const flag of flags) {
    if (order.indexOf(flag.severity) > order.indexOf(highest)) {
      highest = flag.severity;
    }
  }
  
  return highest;
}

/**
 * 获取用户可疑交易记录
 */
async function getUserSuspiciousTrades(userId, limit = 50) {
  const { rows } = await query(`
    SELECT st.*, pt.initiator_id, pt.receiver_id, pt.status
    FROM suspicious_trades st
    JOIN pokemon_trades pt ON pt.id = st.trade_id
    WHERE pt.initiator_id = $1 OR pt.receiver_id = $1
    ORDER BY st.created_at DESC
    LIMIT $2
  `, [userId, limit]);

  return rows;
}

module.exports = {
  detectSuspiciousTrade,
  Severity,
  getPokemonRecentTrades,
  getAccountAge,
  getTotalTrades,
  checkSameIP,
  checkFrequentPartner,
  recordSuspiciousTrade,
  getUserSuspiciousTrades
};
