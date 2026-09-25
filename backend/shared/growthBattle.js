/**
 * 精灵成长系统接入战斗（E07 ↔ E11 gym-service 战斗引擎）
 *
 * 战斗引擎按 CP 反推攻防（等级、觉醒的攻防/HP 加成已体现在 CP 里，这里不重复计算），本模块补上 CP 之外的成长效果：
 *   - 疲劳（REQ-00172）：攻/防 × 疲劳战斗倍率（tired 0.85、exhausted 0.6）
 *   - 专项特训（REQ-00612）：攻/防 +训练%、能量上限 +训练值；技能熟练度（威力/命中/暴击维度）作用到对应招式
 *   - 羁绊技能（REQ-00151）：激活的羁绊技能作为额外蓄力技加入招式列表，威力按当前亲密度计算
 * 结算（在战斗结算事务内）：参战精灵扣体力（不足时扣到 0，不影响结算）、按胜负发放精灵经验（REQ-00216，来源 battle）。
 */
'use strict';

const staminaRules = require('./growth/staminaRules');
const trainingRules = require('./growth/specialTrainingRules');
const bondRules = require('./growth/bondSkillRules');
const engine = require('./ExperienceEngine');
const { grantPokemonExperience } = require('./pokemonExperience');

const BATTLE_ACTIVITY = Object.freeze({ gym: 'gym_battle', raid: 'team_battle', pvp: 'pvp_battle', league: 'pvp_battle', trainer: 'pvp_battle' });
const BATTLE_EXP = Object.freeze({ win: 150, lose: 60 });

const r2 = (v) => Math.round(v * 100) / 100;

/** 纯函数：由成长数据得到战斗修正 */
function modifiersFrom({ stamina, trainingLevels = {}, awakening = {}, mastery = {}, bond = null, friendship = 70, now = new Date() }) {
  const st = stamina ? staminaRules.status(stamina, now) : null;
  const fatigue = st ? st.effects.battleBonus : 1;
  const tb = trainingRules.attributeBonuses(trainingLevels);
  return {
    fatigueLevel: st ? st.fatigueLevel : 'fresh',
    attackMult: r2((1 + tb.attackPct) * fatigue),
    defenseMult: r2((1 + tb.defensePct) * fatigue),
    energyBonus: tb.energyCap,
    critBonus: r2(tb.critRate + (Number(awakening.critRate) || 0)),
    dodgeRate: r2(tb.dodgeRate + (Number(awakening.dodgeRate) || 0)),
    skillPowerMult: r2(1 + (Number(awakening.skillPowerPct) || 0)),
    mastery: Object.fromEntries(Object.entries(mastery).map(([moveId, m]) => [moveId, trainingRules.masteryBonuses(m)])),
    bondMove: bond ? bondMove(bond, friendship) : null,
  };
}

/** 羁绊技能 → 战斗引擎的招式结构（与 gym-service battle/stats.normalizeMove 一致） */
function bondMove(def, friendship) {
  const fx = bondRules.computeEffect(def, friendship);
  return {
    id: `BOND_${def.id}`,
    name: def.skill_name,
    type: String(def.type || 'normal').toLowerCase(),
    category: 'CHARGE',
    power: fx.power,
    energyGain: 0,
    energyCost: Math.max(0, Number(def.energy_cost) || 50),
    durationMs: 2500,
    cooldownMs: (Number(def.cooldown_turns) || 0) * 1000,
    accuracy: Number(def.accuracy) || 100,
    critPct: Math.round((Number(fx.additionalEffects.crit_bonus) || 0) * 100),
    effectType: null,
    effectChance: 0,
    bond: true,
  };
}

/** 把修正应用到战斗单位（招式按精灵复制，避免改到共享的技能表） */
function applyToCombatant(c, mods) {
  if (!c || !mods) return c;
  c.attack = Number((c.attack * mods.attackMult).toFixed(2));
  c.defense = Number((c.defense * mods.defenseMult).toFixed(2));
  c.maxEnergy = (Number(c.maxEnergy) || 100) + (mods.energyBonus || 0);
  c.moves = (c.moves || []).map((m) => {
    const mb = mods.mastery[m.id];
    const power = Math.round((Number(m.power) || 0) * mods.skillPowerMult * (1 + (mb ? mb.powerPct : 0)));
    return {
      ...m,
      power,
      accuracy: Math.min(100, (Number(m.accuracy) || 100) + (mb ? Math.round(mb.accuracyPct * 100) : 0)),
      critPct: (Number(m.critPct) || 0) + Math.round(((mb ? mb.critPct : 0) + mods.critBonus) * 100),
    };
  });
  if (mods.bondMove && !c.moves.some((m) => m.id === mods.bondMove.id)) c.moves.push({ ...mods.bondMove });
  c.growth = { fatigueLevel: mods.fatigueLevel, attackMult: mods.attackMult, defenseMult: mods.defenseMult, dodgeRate: mods.dodgeRate, bondMove: mods.bondMove ? mods.bondMove.id : null };
  return c;
}

/**
 * 读取一批精灵的成长数据并算出战斗修正
 * @param {{query: Function}} db
 * @param {string[]} pokemonIds
 * @returns {Promise<Map<string, object>>}
 */
async function loadModifiers(db, pokemonIds) {
  const ids = [...new Set((pokemonIds || []).filter((id) => /^[0-9a-f-]{36}$/i.test(String(id))))];
  const out = new Map();
  if (!ids.length) return out;
  const safe = async (sql) => {
    try { return (await db.query(sql, [ids])).rows; } catch (err) { if (err.code === '42P01' || err.code === '42703') return []; throw err; }
  };
  const [base, train, mastery, bonds] = await Promise.all([
    safe(`SELECT id, max_stamina, current_stamina, last_stamina_update, awakening_bonuses, friendship FROM pokemon_instances WHERE id = ANY($1::uuid[])`),
    safe('SELECT pokemon_instance_id AS id, attribute, points FROM pokemon_training_attributes WHERE pokemon_instance_id = ANY($1::uuid[])'),
    safe('SELECT pokemon_instance_id AS id, move_id, power, accuracy, critical_chance FROM pokemon_skill_mastery WHERE pokemon_instance_id = ANY($1::uuid[])'),
    safe(`SELECT pbs.pokemon_instance_id AS pid, d.* FROM pokemon_bond_skills pbs JOIN bond_skill_definitions d ON d.id = pbs.bond_skill_id
           WHERE pbs.pokemon_instance_id = ANY($1::uuid[]) AND pbs.is_active AND COALESCE(pbs.current_pp, 1) > 0`),
  ]);
  for (const b of base) {
    const levels = {};
    for (const t of train.filter((x) => x.id === b.id)) levels[t.attribute] = trainingRules.levelOf(t.attribute, t.points);
    const m = {};
    for (const x of mastery.filter((y) => y.id === b.id)) m[x.move_id] = x;
    out.set(b.id, modifiersFrom({
      stamina: b, trainingLevels: levels, awakening: b.awakening_bonuses || {}, mastery: m,
      bond: bonds.find((x) => x.pid === b.id) || null, friendship: b.friendship ?? 70,
    }));
  }
  return out;
}

/** 体力按活动扣除；不足时扣到 0（战斗已经发生，不能因体力不足回滚结算） */
async function drainStamina(client, pokemonId, activityType, meta = {}) {
  const { rows: [cfg] } = await client.query('SELECT stamina_cost FROM stamina_config WHERE activity_type = $1', [activityType]);
  const cost = cfg ? Number(cfg.stamina_cost) : 0;
  if (!cost) return null;
  const { rows: [row] } = await client.query(
    'SELECT id, user_id, max_stamina, current_stamina, last_stamina_update FROM pokemon_instances WHERE id = $1 FOR UPDATE', [pokemonId]);
  if (!row) return null;
  const now = new Date();
  const eff = staminaRules.effectiveStamina(row, now);
  const after = Math.max(0, eff.current - cost);
  const anchor = eff.current >= eff.max ? now : new Date(new Date(row.last_stamina_update || now).getTime() + eff.wholeMinutes * 60000);
  await client.query(
    'UPDATE pokemon_instances SET current_stamina = $2, last_stamina_update = $3, fatigue_level = $4 WHERE id = $1',
    [pokemonId, after, anchor, staminaRules.fatigueLevel(after, eff.max)]);
  await client.query(
    `INSERT INTO stamina_history (user_id, pokemon_id, activity_type, stamina_change, stamina_before, stamina_after, source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'battle', $7)`,
    [row.user_id, pokemonId, activityType, after - eff.current, eff.current, after, JSON.stringify(meta)]);
  return { consumed: eff.current - after, staminaAfter: after };
}

/**
 * 战斗结算时的成长处理（每只精灵在保存点内执行，失败只跳过该精灵，不影响战斗结算）
 * @param {object} a { userId, pokemonIds, battleType, won, battleId, opponentLevel }
 */
async function settle(client, a) {
  const activity = BATTLE_ACTIVITY[a.battleType] || 'battle_turn';
  const results = [];
  for (const pokemonId of [...new Set(a.pokemonIds || [])]) {
    if (!/^[0-9a-f-]{36}$/i.test(String(pokemonId))) continue;
    await client.query('SAVEPOINT growth_battle');
    try {
      const stamina = await drainStamina(client, pokemonId, activity, { battleId: a.battleId, battleType: a.battleType });
      const { rows: [p] } = await client.query(
        'SELECT pi.level, ps.rarity FROM pokemon_instances pi JOIN pokemon_species ps ON ps.id = pi.species_id WHERE pi.id = $1', [pokemonId]);
      const base = engine.calculateBaseExperience({
        baseExp: a.won ? BATTLE_EXP.win : BATTLE_EXP.lose, rarity: p && p.rarity, pokemonLevel: p ? p.level : 1, opponentLevel: a.opponentLevel || (p ? p.level : 1),
      });
      const growth = base > 0 ? await grantPokemonExperience(client, {
        userId: a.userId, pokemonId, baseAmount: base, sourceType: 'battle', sourceId: a.battleId, metadata: { battleType: a.battleType, won: !!a.won },
      }) : null;
      await client.query('RELEASE SAVEPOINT growth_battle');
      results.push({ pokemonId, stamina, exp: growth ? growth.gainedExp : 0, levelUp: growth ? growth.levelUp : false });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT growth_battle');
      results.push({ pokemonId, error: err.message });
    }
  }
  return results;
}

module.exports = { BATTLE_ACTIVITY, BATTLE_EXP, modifiersFrom, bondMove, applyToCombatant, loadModifiers, drainStamina, settle };
