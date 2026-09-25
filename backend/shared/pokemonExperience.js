/**
 * 精灵经验入账（统一出口，在调用方的事务 client 中执行）—— REQ-00216 / REQ-00230
 *
 * 所有精灵经验来源（捕捉、经验道具、训练营、特训、经验转移……）都调用 grantPokemonExperience：
 *   1. 锁定精灵行，读取训练师等级 → 等级上限
 *   2. 汇总倍率（活动 double_xp、幸运蛋、经验卡、VIP、公会经验 BUFF、疲劳），见 ExperienceEngine.calculateFinalExperience
 *   3. 更新经验/等级，升级时按等级倍率缩放 CP/HP
 *   4. 写 pokemon_exp_history、按游戏日汇总 pokemon_growth_stats、识别并记录里程碑
 * catch-service（捕捉时新精灵的起始经验）与 pokemon-service 共用本模块。
 */
'use strict';

const engine = require('./ExperienceEngine');
const { gameDate } = require('./gameTime');

const LEVEL_MILESTONES = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100];
const EXP_MILESTONES = [10_000, 100_000, 1_000_000];

// 疲劳对经验的影响（与体力系统的疲劳等级一致）；体力模块注册更精确的计算函数
let fatigueResolver = (pokemon) => {
  const max = Number(pokemon.max_stamina) || 100;
  const cur = Number(pokemon.current_stamina ?? max);
  const pct = max > 0 ? cur / max : 1;
  if (pct >= 0.5) return 1.0;
  if (pct >= 0.2) return 0.95;
  return 0.8;
};
function setFatigueResolver(fn) { fatigueResolver = fn; }

async function lockPokemon(client, pokemonId, userId) {
  await client.query('SELECT 1 FROM pokemon_instances WHERE id = $1 AND user_id = $2 FOR UPDATE', [pokemonId, userId]);
  const { rows: [p] } = await client.query(
    `SELECT pi.id, pi.user_id, pi.species_id, pi.cp, pi.hp_max, pi.hp_current, pi.level, pi.experience,
            pi.max_stamina, pi.current_stamina, pi.last_stamina_update,
            ps.rarity, ps.name_zh AS species_name, COALESCE(ps.growth_rate, 'medium_fast') AS growth_rate,
            u.level AS trainer_level, u.vip_level
       FROM pokemon_instances pi
       JOIN pokemon_species ps ON ps.id = pi.species_id
       JOIN users u ON u.id = pi.user_id
      WHERE pi.id = $1 AND pi.user_id = $2 AND COALESCE(pi.is_released, FALSE) = FALSE`,
    [pokemonId, userId]);
  if (!p) {
    const err = new Error('精灵不存在');
    err.httpStatus = 404;
    err.code = 'POKEMON_NOT_FOUND';
    throw err;
  }
  return p;
}

/** 当前生效的倍率上下文（不含连击/首捕，这两项由调用方提供） */
async function multiplierContext(client, userId, pokemon) {
  const ctx = {};
  const safe = async (fn) => { try { return await fn(); } catch (err) { if (err.code === '42P01' || err.code === '42703') return null; throw err; } };

  const ev = await safe(() => client.query(
    `SELECT MAX(COALESCE((event_config->>'xpMultiplier')::numeric, (event_config->>'multiplier')::numeric, 2.0)) AS m
       FROM events
      WHERE event_type = 'double_xp' AND status = 'active' AND start_time <= NOW() AND end_time > NOW()`));
  if (ev && ev.rows[0] && ev.rows[0].m) ctx.eventMultiplier = Number(ev.rows[0].m);

  const boosts = await safe(() => client.query(
    `SELECT boost_type, MAX(multiplier) AS m FROM pokemon_exp_boosts
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
      GROUP BY boost_type`, [userId]));
  if (boosts) {
    let card = 1;
    for (const b of boosts.rows) {
      if (b.boost_type === 'lucky_egg') ctx.luckyEgg = true;
      else card *= Number(b.m);
    }
    if (card > 1) ctx.expCardMultiplier = Math.round(card * 1000) / 1000;
  }

  if (Number(pokemon.vip_level) > 0) ctx.vip = true;

  const guild = await safe(() => client.query(
    `SELECT MAX(gb.buff_value) AS v FROM guild_members gm
       JOIN guild_buffs gb ON gb.guild_id = gm.guild_id
      WHERE gm.user_id = $1 AND gb.buff_type LIKE 'experience_bonus%' AND gb.expires_at > NOW()`, [userId]));
  if (guild && guild.rows[0] && Number(guild.rows[0].v) > 0) ctx.guildBuff = Number(guild.rows[0].v);

  const fatigue = fatigueResolver(pokemon);
  if (fatigue !== 1) ctx.fatigueMultiplier = fatigue;
  return ctx;
}

async function addMilestone(client, p, type, key, name, snapshot = {}) {
  const { rowCount } = await client.query(
    `INSERT INTO pokemon_milestones (pokemon_instance_id, user_id, milestone_type, milestone_key, milestone_name, snapshot_data)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (pokemon_instance_id, milestone_type, milestone_key) DO NOTHING`,
    [p.id, p.user_id, type, key, name, JSON.stringify(snapshot)]);
  return rowCount ? { type, key, name } : null;
}

/**
 * 发放精灵经验（负数表示扣除，仅经验转移使用）
 * @param {import('pg').PoolClient} client 事务 client
 * @param {object} args
 *   { userId, pokemonId, baseAmount, sourceType, sourceId, applyMultipliers=true, context={combo, firstCatch},
 *     metadata, location: {lat,lng,name} }
 */
async function grantPokemonExperience(client, args) {
  const { userId, pokemonId, sourceType, sourceId = null, metadata = {}, location = {} } = args;
  const base = Math.trunc(Number(args.baseAmount) || 0);
  if (!base) throw Object.assign(new Error('经验值必须不为 0'), { httpStatus: 400, code: 'INVALID_AMOUNT' });
  const p = await lockPokemon(client, pokemonId, userId);

  let calc = { final: base, multiplier: 1, breakdown: [] };
  if (base > 0 && args.applyMultipliers !== false) {
    const ctx = { ...(await multiplierContext(client, userId, p)), ...(args.context || {}) };
    calc = engine.calculateFinalExperience(base, ctx);
  }
  const growthRate = p.growth_rate;
  const cap = engine.levelCap(p.trainer_level);
  const oldExp = Math.max(0, Number(p.experience) || 0);
  const newExp = Math.min(engine.maxExperience(growthRate), Math.max(0, oldExp + calc.final));
  const gained = newExp - oldExp;
  const oldLevel = Math.max(1, Number(p.level) || 1);
  const naturalLevel = engine.levelFromExp(newExp, growthRate, engine.MAX_LEVEL);
  const newLevel = engine.levelFromExp(newExp, growthRate, cap);

  let cp = Number(p.cp);
  let hpMax = Number(p.hp_max);
  if (newLevel !== oldLevel) {
    const ratio = engine.levelMultiplier(newLevel) / engine.levelMultiplier(oldLevel);
    cp = Math.max(10, Math.round(cp * ratio));
    hpMax = Math.max(10, Math.round(hpMax * ratio));
  }
  await client.query(
    `UPDATE pokemon_instances
        SET experience = $2, level = $3, cp = $4, hp_max = $5,
            hp_current = LEAST(GREATEST(hp_current + ($5 - hp_max), 1), $5), updated_at = NOW()
      WHERE id = $1`, [p.id, newExp, newLevel, cp, hpMax]);

  const result = {
    pokemonId: p.id,
    baseAmount: base,
    gainedExp: gained,
    multiplier: calc.multiplier,
    breakdown: calc.breakdown,
    oldExperience: oldExp,
    newExperience: newExp,
    oldLevel,
    newLevel,
    levelUp: newLevel > oldLevel,
    levelCapped: naturalLevel > newLevel,
    levelCap: cap,
    cpBefore: Number(p.cp),
    cpAfter: cp,
    expToNextLevel: newLevel < engine.MAX_LEVEL ? Math.max(0, engine.expForLevel(newLevel + 1, growthRate) - newExp) : 0,
    milestones: [],
  };
  if (!gained && newLevel === oldLevel) return result;

  if (gained) {
    await client.query(
      `INSERT INTO pokemon_exp_history
         (pokemon_instance_id, user_id, exp_amount, base_amount, multiplier, source_type, source_id,
          level_before, level_after, exp_before, exp_after, location_lat, location_lng, location_name, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [p.id, userId, gained, base, calc.multiplier, sourceType, sourceId == null ? null : String(sourceId),
        oldLevel, newLevel, oldExp, newExp, location.lat ?? null, location.lng ?? null, location.name ?? null,
        JSON.stringify({ ...metadata, breakdown: calc.breakdown })]);

    const day = gameDate();
    const positive = Math.max(0, gained);
    await client.query(
      `INSERT INTO pokemon_growth_stats (pokemon_instance_id, user_id, stat_date, total_exp_gained, exp_sources,
                                         level_ups, cumulative_exp, current_level)
       VALUES ($1, $2, $3, $4::int, jsonb_build_object($5::text, $4::int), $6, $7, $8)
       ON CONFLICT (pokemon_instance_id, stat_date) DO UPDATE SET
         total_exp_gained = pokemon_growth_stats.total_exp_gained + EXCLUDED.total_exp_gained,
         exp_sources = pokemon_growth_stats.exp_sources ||
           jsonb_build_object($5::text, COALESCE((pokemon_growth_stats.exp_sources->>$5::text)::int, 0) + $4::int),
         level_ups = pokemon_growth_stats.level_ups + EXCLUDED.level_ups,
         cumulative_exp = EXCLUDED.cumulative_exp,
         current_level = EXCLUDED.current_level,
         updated_at = NOW()`,
      [p.id, userId, day, positive, sourceType, Math.max(0, newLevel - oldLevel), newExp, newLevel]);
  }

  const snap = { level: newLevel, experience: newExp, cp, speciesId: p.species_id };
  for (const l of LEVEL_MILESTONES) {
    if (oldLevel < l && newLevel >= l) {
      const m = await addMilestone(client, p, 'level_up', `level:${l}`, `达到 ${l} 级`, snap);
      if (m) result.milestones.push(m);
    }
  }
  for (const e of EXP_MILESTONES) {
    if (oldExp < e && newExp >= e) {
      const m = await addMilestone(client, p, 'exp_total', `exp:${e}`, `累计经验 ${e.toLocaleString('en-US')}`, snap);
      if (m) result.milestones.push(m);
    }
  }
  if (oldExp === 0 && gained > 0) {
    const m = await addMilestone(client, p, 'first_exp', 'first', '获得第一份经验', snap);
    if (m) result.milestones.push(m);
  }
  return result;
}

module.exports = { grantPokemonExperience, multiplierContext, addMilestone, setFatigueResolver, LEVEL_MILESTONES, EXP_MILESTONES };
