/**
 * 精灵觉醒服务（REQ-00245）
 *
 * 条件检查 → 觉醒（事务：锁精灵、复核条件、原子扣材料/糖果/星尘、按权重抽潜能、写 pokemon_awakenings、
 * 更新 pokemon_instances.awakening_stage/awakening_bonuses 并按比例同步 CP、记里程碑）→ 重洗（消耗递增）。
 * 觉醒材料是 items（AWAKENING_SHARD/STONE/ESSENCE），库存走 player_inventory；训练营完成时掉落觉醒碎片。
 * 规则见 growth/awakeningRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { consumeItem } = require('../../../shared/inventory');
const { addMilestone } = require('../../../shared/pokemonExperience');
const rules = require('./growth/awakeningRules');
const { GrowthError, lockOwnedPokemon, assertIdle, candyOf, spendCandy, spendCurrency } = require('./growth/common');

function lang2(lang) {
  const l = String(lang || 'zh').toLowerCase();
  return l.startsWith('en') ? 'en' : (l.startsWith('ja') ? 'ja' : 'zh');
}

function presentPotential(p, lang) {
  const l = lang2(lang);
  return {
    id: p.id, key: p.name_key, name: p[`name_${l}`] || p.name_zh, description: p[`description_${l}`] || p.description_zh,
    type: p.potential_type, rarity: p.rarity, effect: p.effect_config,
  };
}

async function configFor(db, speciesId, stage) {
  const { rows } = await db.query(
    `SELECT * FROM awakening_configs WHERE awakening_stage = $2 AND (pokemon_species_id = $1 OR pokemon_species_id IS NULL)
      ORDER BY pokemon_species_id NULLS LAST LIMIT 1`, [speciesId, stage]);
  return rules.stageConfig(stage, rows[0] || null);
}

async function potentialPool(db, stage) {
  const { rows } = await db.query('SELECT * FROM potentials WHERE min_stage <= $1 AND is_active ORDER BY id', [stage]);
  return rows;
}

async function contextFor(db, p, cfg) {
  const codes = (cfg.required_materials || []).map((m) => m.item_id);
  const items = {};
  if (codes.length) {
    const { rows } = await db.query(
      'SELECT item_id, SUM(quantity)::int AS q FROM player_inventory WHERE user_id = $1 AND item_id = ANY($2::text[]) GROUP BY item_id',
      [p.user_id, codes]);
    for (const r of rows) items[r.item_id] = r.q;
  }
  const { rows: [u] } = await db.query('SELECT stardust FROM users WHERE id = $1', [p.user_id]);
  return {
    level: Number(p.level || 1), friendship: Number(p.friendship ?? 70), battles: 0,
    items, candy: await candyOf(db, p.user_id, p.species_id), stardust: u ? Number(u.stardust) : 0,
  };
}

async function stagesOf(db, pokemonId) {
  const { rows } = await db.query('SELECT * FROM pokemon_awakenings WHERE pokemon_instance_id = $1 ORDER BY awakening_stage', [pokemonId]);
  return rows;
}

async function getStatus(pokemonId, userId, { lang } = {}) {
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const stage = Number(p.awakening_stage || 0);
  const stages = await stagesOf({ query }, pokemonId);
  let next = null;
  if (stage < rules.MAX_STAGE) {
    const cfg = await configFor({ query }, p.species_id, stage + 1);
    const ctx = await contextFor({ query }, p, cfg);
    next = { stage: stage + 1, ...rules.checkRequirements(cfg, ctx), potentials: { guaranteed: cfg.guaranteed_potentials, max: cfg.max_potentials }, unlocksSkill: !!cfg.skill_unlock };
  }
  return {
    pokemonId: p.id,
    stage,
    maxStage: rules.MAX_STAGE,
    bonuses: p.awakening_bonuses || {},
    aura: rules.AURAS[stage],
    awakeningSkill: rules.awakeningSkill(stage, p.type1),
    stages: stages.map((s) => ({
      stage: s.awakening_stage, awakenedAt: s.awakening_date, rerolls: s.rolled_attempts,
      potentials: (s.activated_potentials || []).map((x) => presentPotential(x, lang)),
      nextRerollCost: rules.rerollCost(s.rolled_attempts),
    })),
    next,
  };
}

async function spendMaterials(client, userId, speciesId, materials, candy, stardust) {
  for (const m of materials || []) {
    if (!(await consumeItem(client, userId, m.item_id, m.count))) throw new GrowthError('INSUFFICIENT_MATERIALS', `觉醒材料不足：${m.item_id} ×${m.count}`, 400);
  }
  if (candy && !(await spendCandy(client, userId, speciesId, candy))) throw new GrowthError('INSUFFICIENT_CANDY', `糖果不足（需要 ${candy}）`, 400);
  if (stardust && !(await spendCurrency(client, userId, 'stardust', stardust))) throw new GrowthError('INSUFFICIENT_STARDUST', `星尘不足（需要 ${stardust}）`, 400);
}

/** 重新汇总加成并按比例同步 CP */
async function applyBonuses(client, p) {
  const stages = await stagesOf(client, p.id);
  const bonuses = rules.sumBonuses(stages);
  const oldFactor = rules.cpFactor(p.awakening_bonuses || {});
  const newFactor = rules.cpFactor(bonuses);
  const cp = Math.max(10, Math.round(Number(p.cp) * (newFactor / oldFactor)));
  await client.query(
    'UPDATE pokemon_instances SET awakening_bonuses = $2, cp = $3, updated_at = NOW() WHERE id = $1',
    [p.id, JSON.stringify(bonuses), cp]);
  return { bonuses, cpBefore: Number(p.cp), cpAfter: cp };
}

async function awaken(pokemonId, userId, { lang, rand } = {}) {
  return transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    assertIdle(p, '觉醒');
    const stage = Number(p.awakening_stage || 0) + 1;
    if (stage > rules.MAX_STAGE) throw new GrowthError('MAX_STAGE', '已达到最高觉醒阶段', 400);
    const cfg = await configFor(client, p.species_id, stage);
    const check = rules.checkRequirements(cfg, await contextFor(client, p, cfg));
    if (!check.met) {
      const miss = check.checks.filter((c) => !c.met).map((c) => `${c.label} ${c.current}/${c.required}`).join('，');
      throw new GrowthError('AWAKENING_CONDITIONS_NOT_MET', `觉醒条件未满足：${miss}`, 400, { checks: check.checks });
    }
    await spendMaterials(client, userId, p.species_id, cfg.required_materials, cfg.candy, cfg.stardust);
    const r = rand || Math.random;
    const drawn = rules.drawPotentials(await potentialPool(client, stage), rules.rollCount(cfg, r), r);
    await client.query(
      `INSERT INTO pokemon_awakenings (pokemon_instance_id, user_id, awakening_stage, activated_potentials, consumed_materials)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.id, userId, stage, JSON.stringify(drawn), JSON.stringify({ materials: cfg.required_materials, candy: cfg.candy, stardust: cfg.stardust })]);
    await client.query('UPDATE pokemon_instances SET awakening_stage = $2 WHERE id = $1', [p.id, stage]);
    const applied = await applyBonuses(client, p);
    await addMilestone(client, { id: p.id, user_id: userId }, 'awakening', `stage:${stage}`, `觉醒第 ${stage} 阶段`, { stage, cp: applied.cpAfter });
    return {
      pokemonId: p.id, stage, potentials: drawn.map((x) => presentPotential(x, lang)), ...applied,
      aura: rules.AURAS[stage], awakeningSkill: rules.awakeningSkill(stage, p.type1), skillUnlocked: !!cfg.skill_unlock,
    };
  });
}

async function reroll(pokemonId, userId, stageArg, { lang, rand } = {}) {
  const stage = Number(stageArg);
  if (!Number.isInteger(stage) || stage < 1 || stage > rules.MAX_STAGE) throw new GrowthError('INVALID_PARAM', '无效的觉醒阶段', 400);
  return transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    const { rows: [row] } = await client.query(
      'SELECT * FROM pokemon_awakenings WHERE pokemon_instance_id = $1 AND awakening_stage = $2 FOR UPDATE', [p.id, stage]);
    if (!row) throw new GrowthError('STAGE_NOT_AWAKENED', '该阶段尚未觉醒', 400);
    const cost = rules.rerollCost(row.rolled_attempts);
    await spendMaterials(client, userId, p.species_id, cost.items, 0, cost.stardust);
    const cfg = await configFor(client, p.species_id, stage);
    const r = rand || Math.random;
    const drawn = rules.drawPotentials(await potentialPool(client, stage), rules.rollCount(cfg, r), r);
    await client.query(
      'UPDATE pokemon_awakenings SET activated_potentials = $2, rolled_attempts = rolled_attempts + 1 WHERE id = $1',
      [row.id, JSON.stringify(drawn)]);
    const applied = await applyBonuses(client, p);
    return { pokemonId: p.id, stage, rerolls: row.rolled_attempts + 1, cost, nextCost: rules.rerollCost(row.rolled_attempts + 1), potentials: drawn.map((x) => presentPotential(x, lang)), ...applied };
  });
}

async function potentials({ lang } = {}) {
  const { rows } = await query('SELECT * FROM potentials WHERE is_active ORDER BY min_stage, id');
  return rows.map((p) => ({ ...presentPotential(p, lang), weight: p.weight, minStage: p.min_stage }));
}

module.exports = { getStatus, awaken, reroll, potentials };
