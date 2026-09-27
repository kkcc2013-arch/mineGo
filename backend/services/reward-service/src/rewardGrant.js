/**
 * 奖励入账（统一出口）
 *
 * 各处奖励配置格式不一：签到 { pokeballs, stardust, xp }、等级奖励 { pokeballs, greatballs, ... }、
 * 活动奖励 [{ type: 'stardust', amount: 100 }, ...]。这里归一化后在调用方的事务里一次性写入 users，
 * 经验变化会由数据库触发器换算训练师等级（database/migrations/20260925_020000__trainer_level_progression.sql）。
 */
'use strict';

// 奖励键 → users 列
const COLUMN_BY_KEY = {
  pokeballs: 'pokeball_count', pokeball: 'pokeball_count', poke_ball: 'pokeball_count',
  greatballs: 'greatball_count', greatball: 'greatball_count', great_ball: 'greatball_count',
  ultraballs: 'ultraball_count', ultraball: 'ultraball_count', ultra_ball: 'ultraball_count',
  masterballs: 'masterball_count', masterball: 'masterball_count', master_ball: 'masterball_count',
  stardust: 'stardust',
  coins: 'coins',
  premium_coins: 'premium_coins',
  xp: 'xp', exp: 'xp', experience: 'xp',
};
const MAX_PER_GRANT = 10_000_000;

/**
 * 归一化为 { 列名: 数量 }；未知类型放进 unsupported 由调用方记录
 * @param {object|Array} rewards
 */
function normalizeRewards(rewards) {
  const totals = {};
  const unsupported = [];
  const add = (key, amount) => {
    const col = COLUMN_BY_KEY[String(key || '').toLowerCase()];
    const n = Number(amount);
    if (!col || !Number.isFinite(n) || n <= 0) {
      unsupported.push({ key, amount });
      return;
    }
    totals[col] = Math.min((totals[col] || 0) + Math.floor(n), MAX_PER_GRANT);
  };
  if (Array.isArray(rewards)) {
    for (const r of rewards) {
      if (r && typeof r === 'object') add(r.type || r.item || r.key, r.amount ?? r.quantity ?? r.count);
    }
  } else if (rewards && typeof rewards === 'object') {
    for (const [k, v] of Object.entries(rewards)) add(k, v);
  }
  return { totals, unsupported };
}

/**
 * 在给定事务 client 中发放奖励，返回发放明细与发放后的等级/经验
 * @param {import('pg').PoolClient} client
 * @param {string} userId
 * @param {object|Array} rewards
 */
async function grantRewards(client, userId, rewards) {
  const { totals, unsupported } = normalizeRewards(rewards);
  const cols = Object.keys(totals);
  if (!cols.length) return { granted: {}, unsupported, level: null };
  const sets = cols.map((c, i) => `${c} = ${c} + $${i + 2}`).join(', ');
  const { rows } = await client.query(
    `UPDATE users SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING level, xp`,
    [userId, ...cols.map((c) => totals[c])],
  );
  if (!rows.length) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  return { granted: totals, unsupported, level: rows[0].level, xp: Number(rows[0].xp) };
}

module.exports = { grantRewards, normalizeRewards, COLUMN_BY_KEY };
