/**
 * 精灵经验历史与成长轨迹（REQ-00230）+ 经验道具/加成/转移/统计（REQ-00216）
 *
 * 数据来自 shared/pokemonExperience.js 写入的 pokemon_exp_history / pokemon_growth_stats / pokemon_milestones。
 * 查询结果按精灵缓存 60 秒；缓存键带"版本号"，每次经验变化 INCR 版本号即可整体失效（无需 SCAN 删键）。
 */
'use strict';

const { query, transaction } = require('../../../../shared/db');
const { getRedis, getJSON, setJSON } = require('../../../../shared/redis');
const { consumeItem } = require('../../../../shared/inventory');
const { gameDate, addDays } = require('../../../../shared/gameTime');
const engine = require('../../../../shared/ExperienceEngine');
const { grantPokemonExperience, multiplierContext, addMilestone } = require('../../../../shared/pokemonExperience');
const { GrowthError, lockOwnedPokemon, assertIdle, assertUuid, toPositiveInt } = require('./common');

const CACHE_TTL = 60;

const EXP_ITEMS = Object.freeze({ EXP_CANDY_S: 1000, EXP_CANDY_M: 5000, EXP_CANDY_L: 20000 });
const BOOST_ITEMS = Object.freeze({
  LUCKY_EGG: { boostType: 'lucky_egg', multiplier: 2.0, minutes: 30 },
  EXP_CARD_24H: { boostType: 'exp_card', multiplier: 1.5, minutes: 24 * 60 },
  EXP_CARD_PERMANENT: { boostType: 'exp_card_permanent', multiplier: 1.1, minutes: null },
});

// ───────────────────────── 缓存 ─────────────────────────
async function cacheVersion(pokemonId) {
  try { return Number(await getRedis().get(`growth:ver:${pokemonId}`)) || 0; } catch { return 0; }
}
async function bumpCache(pokemonId) {
  try { await getRedis().incr(`growth:ver:${pokemonId}`); } catch { /* 缓存不可用时忽略 */ }
}
async function cached(pokemonId, kind, fn) {
  const key = `growth:${pokemonId}:${await cacheVersion(pokemonId)}:${kind}`;
  try {
    const hit = await getJSON(key);
    if (hit) return { ...hit, cached: true };
  } catch { /* ignore */ }
  const value = await fn();
  try { await setJSON(key, value, CACHE_TTL); } catch { /* ignore */ }
  return value;
}

async function ownedPokemon(pokemonId, userId) {
  return lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
}

// ───────────────────────── 概要 ─────────────────────────
async function summary(pokemonId, userId) {
  const p = await ownedPokemon(pokemonId, userId);
  const { rows: [u] } = await query('SELECT level FROM users WHERE id = $1', [userId]);
  const level = Number(p.level || 1);
  const exp = Number(p.experience || 0);
  const cur = engine.expForLevel(level, p.growth_rate);
  const next = level < engine.MAX_LEVEL ? engine.expForLevel(level + 1, p.growth_rate) : cur;
  return {
    pokemonId: p.id,
    speciesId: Number(p.species_id),
    speciesName: p.species_name,
    level,
    experience: exp,
    growthRate: p.growth_rate,
    levelCap: engine.levelCap(u ? u.level : 1),
    currentLevelExp: cur,
    nextLevelExp: next,
    expToNextLevel: Math.max(0, next - exp),
    progressPercent: next > cur ? Math.min(100, Math.round(((exp - cur) / (next - cur)) * 1000) / 10) : 100,
    cp: p.cp,
    friendship: Number(p.friendship ?? 70),
    awakeningStage: Number(p.awakening_stage || 0),
  };
}

// ───────────────────────── 经验历史 ─────────────────────────
async function history(pokemonId, userId, { limit = 20, before } = {}) {
  await ownedPokemon(pokemonId, userId);
  const lim = Math.min(100, Math.max(1, Number(limit) || 20));
  const params = [pokemonId, lim];
  let cond = '';
  if (before) {
    const d = new Date(before);
    if (Number.isNaN(d.getTime())) throw new GrowthError('INVALID_PARAM', 'before 必须是时间', 400);
    params.push(d.toISOString());
    cond = 'AND gained_at < $3';
  }
  const { rows } = await query(
    `SELECT id, exp_amount AS "expAmount", base_amount AS "baseAmount", multiplier::float AS multiplier,
            source_type AS "sourceType", source_id AS "sourceId", level_before AS "levelBefore", level_after AS "levelAfter",
            exp_before AS "expBefore", exp_after AS "expAfter", gained_at AS "gainedAt",
            location_lat AS lat, location_lng AS lng, location_name AS "locationName", metadata
       FROM pokemon_exp_history WHERE pokemon_instance_id = $1 ${cond}
      ORDER BY gained_at DESC, id DESC LIMIT $2`, params);
  return { items: rows, nextCursor: rows.length === lim ? rows[rows.length - 1].gainedAt : null };
}

// ───────────────────────── 轨迹 / 来源 / 里程碑 ─────────────────────────
function clampDays(d, def = 30) {
  const n = Number(d) || def;
  return Math.min(365, Math.max(1, Math.trunc(n)));
}

async function trajectory(pokemonId, userId, { days } = {}) {
  const p = await ownedPokemon(pokemonId, userId);
  const n = clampDays(days);
  return cached(pokemonId, `traj:${n}`, async () => {
    const end = gameDate();
    const start = addDays(end, -(n - 1));
    const { rows } = await query(
      `SELECT stat_date::text AS date, total_exp_gained AS "expGained", cumulative_exp AS "cumulativeExp",
              current_level AS level, level_ups AS "levelUps", exp_sources AS sources
         FROM pokemon_growth_stats WHERE pokemon_instance_id = $1 AND stat_date BETWEEN $2 AND $3
        ORDER BY stat_date`, [pokemonId, start, end]);
    // 补齐没有经验的日子（累计值沿用前一天），前端直接画连续曲线
    const byDate = new Map(rows.map((r) => [r.date, r]));
    const { rows: [prev] } = await query(
      `SELECT cumulative_exp, current_level FROM pokemon_growth_stats
        WHERE pokemon_instance_id = $1 AND stat_date < $2 ORDER BY stat_date DESC LIMIT 1`, [pokemonId, start]);
    let cum = prev ? Number(prev.cumulative_exp) : 0;
    let lvl = prev ? Number(prev.current_level) : 1;
    const points = [];
    for (let i = 0; i < n; i++) {
      const date = addDays(start, i);
      const r = byDate.get(date);
      if (r) { cum = Number(r.cumulativeExp); lvl = Number(r.level); }
      points.push({ date, expGained: r ? Number(r.expGained) : 0, cumulativeExp: cum, level: lvl, levelUps: r ? Number(r.levelUps) : 0 });
    }
    const { rows: milestones } = await query(
      `SELECT milestone_type AS type, milestone_key AS key, milestone_name AS name, achieved_at AS "achievedAt"
         FROM pokemon_milestones WHERE pokemon_instance_id = $1 AND achieved_at >= $2::date ORDER BY achieved_at`,
      [pokemonId, start]);
    return { pokemonId, days: n, from: start, to: end, currentLevel: Number(p.level || 1), currentExp: Number(p.experience || 0), points, milestones };
  });
}

async function sources(pokemonId, userId, { days } = {}) {
  await ownedPokemon(pokemonId, userId);
  const n = clampDays(days, 365);
  return cached(pokemonId, `src:${n}`, async () => {
    const { rows } = await query(
      `SELECT source_type AS source, SUM(exp_amount)::bigint AS amount, COUNT(*)::int AS events
         FROM pokemon_exp_history
        WHERE pokemon_instance_id = $1 AND exp_amount > 0 AND gained_at >= NOW() - make_interval(days => $2)
        GROUP BY source_type`, [pokemonId, n]);
    const events = new Map(rows.map((r) => [r.source, r.events]));
    const list = engine.sourceBreakdown(rows.map((r) => ({ source: r.source, amount: Number(r.amount) })))
      .map((r) => ({ ...r, events: events.get(r.source) || 0 }));
    return { pokemonId, days: n, totalExp: list.reduce((a, r) => a + r.amount, 0), sources: list };
  });
}

async function milestones(pokemonId, userId) {
  await ownedPokemon(pokemonId, userId);
  const { rows } = await query(
    `SELECT milestone_type AS type, milestone_key AS key, milestone_name AS name, description,
            achieved_at AS "achievedAt", snapshot_data AS snapshot
       FROM pokemon_milestones WHERE pokemon_instance_id = $1 ORDER BY achieved_at DESC, id DESC`, [pokemonId]);
  return { pokemonId, total: rows.length, milestones: rows };
}

async function dailySeries(pokemonId, days) {
  const end = gameDate();
  const start = addDays(end, -(days - 1));
  const { rows } = await query(
    `SELECT stat_date::text AS date, total_exp_gained AS exp FROM pokemon_growth_stats
      WHERE pokemon_instance_id = $1 AND stat_date BETWEEN $2 AND $3`, [pokemonId, start, end]);
  const m = new Map(rows.map((r) => [r.date, Number(r.exp)]));
  return Array.from({ length: days }, (_, i) => m.get(addDays(start, i)) || 0);
}

async function prediction(pokemonId, userId) {
  const s = await summary(pokemonId, userId);
  return cached(pokemonId, 'pred', async () => {
    const series = await dailySeries(pokemonId, 14);
    const recent = series.slice(-7);
    const avg7 = recent.reduce((a, b) => a + b, 0) / 7;
    const avg14 = series.reduce((a, b) => a + b, 0) / 14;
    const avgDaily = Math.round(avg7 > 0 ? avg7 * 0.7 + avg14 * 0.3 : avg14);
    const levels = engine.predictLevels({ experience: s.experience, level: s.level, growthRate: s.growthRate, cap: s.levelCap }, avgDaily, 5);
    // 等级进化条件（evolution_level）的预计时间
    const { rows: [sp] } = await query('SELECT evolution_level, evolves_to FROM pokemon_species WHERE id = $1', [s.speciesId]);
    let evolution = null;
    if (sp && sp.evolves_to && sp.evolution_level) {
      const need = Math.max(0, engine.expForLevel(sp.evolution_level, s.growthRate) - s.experience);
      evolution = { targetSpeciesId: sp.evolves_to, requiredLevel: sp.evolution_level, expNeeded: need, days: avgDaily > 0 ? Math.ceil((need / avgDaily) * 10) / 10 : null };
    }
    return {
      pokemonId,
      level: s.level,
      levelCap: s.levelCap,
      experience: s.experience,
      avgDailyExp: avgDaily,
      nextLevel: levels[0] || null,
      levels,
      evolution,
      confidence: engine.predictionConfidence(series),
      basis: { days: 14, activeDays: series.filter((v) => v > 0).length },
    };
  });
}

async function report(pokemonId, userId, { period = 'week' } = {}) {
  const s = await summary(pokemonId, userId);
  const days = period === 'month' ? 30 : 7;
  return cached(pokemonId, `report:${days}`, async () => {
    const end = gameDate();
    const start = addDays(end, -(days - 1));
    const prevStart = addDays(start, -days);
    const agg = async (a, b) => (await query(
      `SELECT COALESCE(SUM(total_exp_gained),0)::bigint AS exp, COALESCE(SUM(level_ups),0)::int AS level_ups,
              COUNT(*) FILTER (WHERE total_exp_gained > 0)::int AS active_days
         FROM pokemon_growth_stats WHERE pokemon_instance_id = $1 AND stat_date BETWEEN $2 AND $3`, [pokemonId, a, b])).rows[0];
    const cur = await agg(start, end);
    const prev = await agg(prevStart, addDays(start, -1));
    const src = await query(
      `SELECT source_type AS source, SUM(exp_amount)::bigint AS amount FROM pokemon_exp_history
        WHERE pokemon_instance_id = $1 AND exp_amount > 0 AND gained_at >= $2::date GROUP BY source_type`, [pokemonId, start]);
    const { rows: ms } = await query(
      `SELECT milestone_name AS name, achieved_at AS "achievedAt" FROM pokemon_milestones
        WHERE pokemon_instance_id = $1 AND achieved_at >= $2::date ORDER BY achieved_at`, [pokemonId, start]);
    const curExp = Number(cur.exp);
    const prevExp = Number(prev.exp);
    const breakdown = engine.sourceBreakdown(src.rows.map((r) => ({ source: r.source, amount: Number(r.amount) })));
    return {
      pokemonId,
      period,
      from: start,
      to: end,
      totalExp: curExp,
      levelUps: cur.level_ups,
      activeDays: cur.active_days,
      level: s.level,
      topSource: breakdown[0] ? breakdown[0].source : null,
      sources: breakdown,
      milestones: ms,
      previousPeriodExp: prevExp,
      changePercent: prevExp > 0 ? Math.round(((curExp - prevExp) / prevExp) * 1000) / 10 : null,
      summary: `本${period === 'month' ? '月' : '周'}获得 ${curExp} 经验，升级 ${cur.level_ups} 次，活跃 ${cur.active_days} 天`,
    };
  });
}

// ───────────────────────── 经验来源：道具 / 转移 ─────────────────────────
async function useExpItem(pokemonId, userId, { itemId, quantity = 1 }) {
  assertUuid(pokemonId);
  const perItem = EXP_ITEMS[itemId];
  if (!perItem) throw new GrowthError('INVALID_ITEM', `不是经验道具：${itemId}`, 400);
  const qty = toPositiveInt(quantity, 'quantity', { max: 99 });
  const result = await transaction(async (client) => {
    await lockOwnedPokemon(client, pokemonId, userId);
    if (!(await consumeItem(client, userId, itemId, qty))) {
      throw new GrowthError('INSUFFICIENT_ITEMS', `${itemId} 数量不足`, 400);
    }
    return grantPokemonExperience(client, {
      userId, pokemonId, baseAmount: perItem * qty, sourceType: 'item', sourceId: itemId,
      applyMultipliers: false, metadata: { itemId, quantity: qty },
    });
  });
  await bumpCache(pokemonId);
  return { ...result, itemId, quantity: qty };
}

async function transfer(pokemonId, userId, { targetPokemonId, amount }) {
  assertUuid(pokemonId);
  assertUuid(targetPokemonId, 'targetPokemonId');
  if (pokemonId === targetPokemonId) throw new GrowthError('INVALID_PARAM', '不能转移给自己', 400);
  const amt = toPositiveInt(amount, 'amount', { max: 10_000_000 });
  const received = engine.transferAmount(amt);
  if (!received) throw new GrowthError('INVALID_PARAM', '转移数量太少', 400);
  const result = await transaction(async (client) => {
    // 固定加锁顺序避免两只精灵互相转移时死锁
    const [a, b] = [pokemonId, targetPokemonId].sort();
    await client.query('SELECT 1 FROM pokemon_instances WHERE id = ANY($1::uuid[]) AND user_id = $2 ORDER BY id FOR UPDATE', [[a, b], userId]);
    const src = await lockOwnedPokemon(client, pokemonId, userId, { lock: false });
    const dst = await lockOwnedPokemon(client, targetPokemonId, userId, { lock: false });
    assertIdle(src, '转移经验');
    assertIdle(dst, '接收经验');
    if (Number(src.experience || 0) < amt) {
      throw new GrowthError('INSUFFICIENT_EXPERIENCE', `经验不足（当前 ${src.experience}）`, 400);
    }
    const out = await grantPokemonExperience(client, {
      userId, pokemonId, baseAmount: -amt, sourceType: 'transfer_out', sourceId: targetPokemonId, applyMultipliers: false,
      metadata: { targetPokemonId, amount: amt },
    });
    const inn = await grantPokemonExperience(client, {
      userId, pokemonId: targetPokemonId, baseAmount: received, sourceType: 'transfer_in', sourceId: pokemonId, applyMultipliers: false,
      metadata: { sourcePokemonId: pokemonId, amount: amt, ratio: engine.TRANSFER_RATIO },
    });
    return { source: out, target: inn, transferred: amt, received, ratio: engine.TRANSFER_RATIO };
  });
  await Promise.all([bumpCache(pokemonId), bumpCache(targetPokemonId)]);
  return result;
}

// ───────────────────────── 经验加成 ─────────────────────────
async function activateBoost(userId, { itemId }) {
  const cfg = BOOST_ITEMS[itemId];
  if (!cfg) throw new GrowthError('INVALID_ITEM', `不是经验加成道具：${itemId}`, 400);
  return transaction(async (client) => {
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (cfg.minutes == null) {
      const { rows: [has] } = await client.query(
        `SELECT 1 FROM pokemon_exp_boosts WHERE user_id = $1 AND boost_type = $2 AND expires_at IS NULL`, [userId, cfg.boostType]);
      if (has) throw new GrowthError('BOOST_ALREADY_ACTIVE', '永久经验卡已生效，不可叠加', 409);
    }
    if (!(await consumeItem(client, userId, itemId, 1))) throw new GrowthError('INSUFFICIENT_ITEMS', `${itemId} 数量不足`, 400);
    // 同类限时加成续期：从当前到期时间往后顺延
    const { rows: [active] } = cfg.minutes == null ? { rows: [] } : await client.query(
      `SELECT id, expires_at FROM pokemon_exp_boosts WHERE user_id = $1 AND boost_type = $2 AND expires_at > NOW()
        ORDER BY expires_at DESC LIMIT 1`, [userId, cfg.boostType]);
    let row;
    if (active) {
      ({ rows: [row] } = await client.query(
        `UPDATE pokemon_exp_boosts SET expires_at = expires_at + make_interval(mins => $2) WHERE id = $1 RETURNING *`,
        [active.id, cfg.minutes]));
    } else {
      ({ rows: [row] } = await client.query(
        `INSERT INTO pokemon_exp_boosts (user_id, boost_type, multiplier, item_id, expires_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE NOW() + make_interval(mins => $5::int) END) RETURNING *`,
        [userId, cfg.boostType, cfg.multiplier, itemId, cfg.minutes]));
    }
    return { boostType: row.boost_type, multiplier: Number(row.multiplier), expiresAt: row.expires_at, itemId };
  });
}

async function activeBoosts(userId) {
  const { rows } = await query(
    `SELECT boost_type AS "boostType", multiplier::float AS multiplier, item_id AS "itemId", expires_at AS "expiresAt"
       FROM pokemon_exp_boosts WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY expires_at NULLS FIRST`, [userId]);
  const { rows: [u] } = await query('SELECT vip_level FROM users WHERE id = $1', [userId]);
  const ctx = await multiplierContext({ query }, userId, { vip_level: u ? u.vip_level : 0, max_stamina: 100, current_stamina: 100 });
  const combined = engine.calculateFinalExperience(1000, ctx);
  return { boosts: rows, context: ctx, multiplier: combined.multiplier, breakdown: combined.breakdown };
}

async function userStats(userId, { period = 'week' } = {}) {
  const days = period === 'day' ? 1 : (period === 'month' ? 30 : 7);
  const end = gameDate();
  const start = addDays(end, -(days - 1));
  const { rows: daily } = await query(
    `SELECT stat_date::text AS date, SUM(total_exp_gained)::bigint AS exp, SUM(level_ups)::int AS "levelUps"
       FROM pokemon_growth_stats WHERE user_id = $1 AND stat_date BETWEEN $2 AND $3
      GROUP BY stat_date ORDER BY stat_date`, [userId, start, end]);
  const { rows: bySrc } = await query(
    `SELECT source_type AS source, SUM(exp_amount)::bigint AS amount, COUNT(*)::int AS events
       FROM pokemon_exp_history WHERE user_id = $1 AND exp_amount > 0 AND gained_at >= $2::date
      GROUP BY source_type`, [userId, start]);
  const map = new Map(daily.map((d) => [d.date, d]));
  const series = Array.from({ length: days }, (_, i) => {
    const date = addDays(start, i);
    const d = map.get(date);
    return { date, exp: d ? Number(d.exp) : 0, levelUps: d ? d.levelUps : 0 };
  });
  return {
    period,
    from: start,
    to: end,
    totalExp: series.reduce((a, d) => a + d.exp, 0),
    levelUps: series.reduce((a, d) => a + d.levelUps, 0),
    daily: series,
    sources: engine.sourceBreakdown(bySrc.map((r) => ({ source: r.source, amount: Number(r.amount) }))),
  };
}

/** 进化里程碑（注册到 evolutionService.onEvolved，在进化事务内执行） */
async function onEvolvedMilestone(client, evolved) {
  const p = evolved.pokemon;
  await addMilestone(client, { id: p.id, user_id: p.user_id }, 'evolution', `species:${evolved.toSpecies.id}`,
    `进化为${evolved.toSpecies.name_zh}`, { from: evolved.fromSpecies.id, to: evolved.toSpecies.id, cp: evolved.after.cp });
  bumpCache(p.id);
}

module.exports = {
  EXP_ITEMS,
  BOOST_ITEMS,
  summary,
  history,
  trajectory,
  sources,
  milestones,
  prediction,
  report,
  useExpItem,
  transfer,
  activateBoost,
  activeBoosts,
  userStats,
  bumpCache,
  onEvolvedMilestone,
};
