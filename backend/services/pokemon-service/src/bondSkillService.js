/**
 * 羁绊技能服务（REQ-00151）
 *
 * 在原实现基础上修正：
 *   - 解锁按羁绊等级（0~100，= 亲密度 ×100/255）1/2/3 槽 20/50/90，与需求一致（原阈值 26/76/151 为亲密度原值）
 *   - 激活前校验精灵归属（原实现先把任意精灵的技能全部取消激活再校验）；最多激活 1 个
 *   - 威力/效果用安全表达式求值（原正则解析对 "floor(friendship * 10)" 等公式返回错误结果）
 *   - 新增战斗使用：校验已学习且激活、PP 充足，扣 PP、记录使用统计，返回按当前亲密度计算的效果
 *   - "按任意亲密度计算效果"的调试接口改为只按精灵真实亲密度计算
 * 规则见 growth/bondSkillRules.js。
 */
'use strict';

const { query, transaction } = require('../../../shared/db');
const { getJSON, setJSON, getRedis } = require('../../../shared/redis');
const rules = require('./growth/bondSkillRules');
const { GrowthError, lockOwnedPokemon, assertUuid } = require('./growth/common');

const SPECIES_CACHE_TTL = 3600;

function parseId(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new GrowthError('INVALID_PARAM', `无效的 ${field}`, 400);
  return n;
}

function present(def) {
  return {
    id: def.id,
    slot: def.slot,
    name: def.skill_name,
    nameEn: def.skill_name_en,
    type: def.type,
    power: def.power,
    accuracy: def.accuracy,
    pp: def.pp,
    effectDescription: def.effect_description,
    effectType: def.effect_type,
    unlockBondLevel: def.unlock_friendship_level,
    formula: def.friendship_bonus_formula,
    energyCost: def.energy_cost,
    cooldownTurns: def.cooldown_turns,
  };
}

async function definitionsFor(speciesId) {
  const key = `bond-skills:species:v2:${speciesId}`;
  try { const hit = await getJSON(key); if (hit) return hit; } catch { /* ignore */ }
  const { rows } = await query(
    `SELECT * FROM bond_skill_definitions WHERE pokemon_species_id = $1 AND is_active = TRUE ORDER BY slot`, [speciesId]);
  try { await setJSON(key, rows, SPECIES_CACHE_TTL); } catch { /* ignore */ }
  return rows;
}

async function available(speciesId) {
  const id = parseId(speciesId, 'speciesId');
  const defs = await definitionsFor(id);
  return { speciesId: id, totalSkills: defs.length, slotThresholds: rules.SLOT_THRESHOLDS, skills: defs.map(present) };
}

async function learnedFor(db, pokemonId) {
  const { rows } = await db.query(
    `SELECT pbs.bond_skill_id, pbs.is_active, pbs.current_pp, pbs.times_used, pbs.learned_at, d.*
       FROM pokemon_bond_skills pbs JOIN bond_skill_definitions d ON d.id = pbs.bond_skill_id
      WHERE pbs.pokemon_instance_id = $1 ORDER BY d.slot`, [pokemonId]);
  return rows;
}

async function getPokemonBondSkills(pokemonId, userId) {
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const friendship = Number(p.friendship ?? 70);
  const defs = await definitionsFor(p.species_id);
  const learned = await learnedFor({ query }, pokemonId);
  const byId = new Map(learned.map((l) => [l.bond_skill_id, l]));
  const skills = defs.map((d) => {
    const l = byId.get(d.id);
    return {
      ...present(d),
      ...rules.skillStatus(d, friendship, l),
      isActive: !!(l && l.is_active),
      currentPp: l ? l.current_pp : null,
      timesUsed: l ? l.times_used : 0,
      effect: rules.computeEffect(d, friendship),
    };
  });
  // 进化前学会、当前物种没有的技能也列出（仍可使用）
  const extra = learned.filter((l) => !defs.some((d) => d.id === l.bond_skill_id)).map((l) => ({
    ...present(l), isUnlocked: true, isLearned: true, inherited: true, isActive: l.is_active, currentPp: l.current_pp,
    timesUsed: l.times_used, effect: rules.computeEffect(l, friendship),
  }));
  const active = [...skills, ...extra].find((s) => s.isActive) || null;
  return {
    pokemonId: p.id,
    speciesId: Number(p.species_id),
    friendship,
    bondLevel: rules.bondLevel(friendship),
    slotThresholds: rules.SLOT_THRESHOLDS,
    maxSlots: 3,
    learnedCount: learned.length,
    activeSkill: active ? { id: active.id, name: active.name, power: active.effect.power } : null,
    skills: [...skills, ...extra],
  };
}

async function learn(pokemonId, skillId, userId) {
  const sid = parseId(skillId, 'skillId');
  return transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    const { rows: [def] } = await client.query(
      'SELECT * FROM bond_skill_definitions WHERE id = $1 AND pokemon_species_id = $2 AND is_active = TRUE', [sid, p.species_id]);
    if (!def) throw new GrowthError('BOND_SKILL_NOT_FOUND', '该精灵没有这个羁绊技能', 404);
    const friendship = Number(p.friendship ?? 70);
    const st = rules.skillStatus(def, friendship, null);
    if (!st.isUnlocked) {
      throw new GrowthError('FRIENDSHIP_TOO_LOW', `羁绊等级不足（需要 ${st.bondLevelRequired}，当前 ${st.bondLevelCurrent}）`, 400, st);
    }
    const learned = await learnedFor(client, pokemonId);
    if (learned.some((l) => l.bond_skill_id === sid)) throw new GrowthError('ALREADY_LEARNED', '已经学会该羁绊技能', 409);
    if (learned.some((l) => l.slot === def.slot)) throw new GrowthError('SLOT_OCCUPIED', `第 ${def.slot} 槽已有羁绊技能，请先遗忘`, 409);
    await client.query(
      `INSERT INTO pokemon_bond_skills (pokemon_instance_id, bond_skill_id, current_pp, is_active) VALUES ($1, $2, $3, FALSE)`,
      [pokemonId, sid, def.pp]);
    return { learned: true, skill: present(def), effect: rules.computeEffect(def, friendship) };
  });
}

async function forget(pokemonId, skillId, userId) {
  const sid = parseId(skillId, 'skillId');
  return transaction(async (client) => {
    await lockOwnedPokemon(client, pokemonId, userId);
    const { rowCount } = await client.query(
      'DELETE FROM pokemon_bond_skills WHERE pokemon_instance_id = $1 AND bond_skill_id = $2', [pokemonId, sid]);
    if (!rowCount) throw new GrowthError('NOT_LEARNED', '没有学会该羁绊技能', 404);
    return { forgotten: true, skillId: sid };
  });
}

async function activate(pokemonId, skillId, userId) {
  const sid = parseId(skillId, 'skillId');
  return transaction(async (client) => {
    await lockOwnedPokemon(client, pokemonId, userId);
    const { rows: [l] } = await client.query(
      'SELECT id FROM pokemon_bond_skills WHERE pokemon_instance_id = $1 AND bond_skill_id = $2', [pokemonId, sid]);
    if (!l) throw new GrowthError('NOT_LEARNED', '没有学会该羁绊技能', 404);
    await client.query('UPDATE pokemon_bond_skills SET is_active = (bond_skill_id = $2) WHERE pokemon_instance_id = $1', [pokemonId, sid]);
    return { activated: true, skillId: sid, maxActive: rules.MAX_ACTIVE };
  });
}

/** 战斗中使用激活的羁绊技能：扣 PP、记录统计，返回按当前亲密度计算的效果 */
async function use(pokemonId, skillId, userId, { battleId } = {}) {
  const sid = parseId(skillId, 'skillId');
  return transaction(async (client) => {
    const p = await lockOwnedPokemon(client, pokemonId, userId);
    const { rows: [l] } = await client.query(
      `SELECT pbs.id, pbs.is_active, pbs.current_pp, d.* FROM pokemon_bond_skills pbs
         JOIN bond_skill_definitions d ON d.id = pbs.bond_skill_id
        WHERE pbs.pokemon_instance_id = $1 AND pbs.bond_skill_id = $2 FOR UPDATE OF pbs`, [pokemonId, sid]);
    if (!l) throw new GrowthError('NOT_LEARNED', '没有学会该羁绊技能', 404);
    if (!l.is_active) throw new GrowthError('NOT_ACTIVE', '羁绊技能未激活，战斗中只能使用已激活的羁绊技能', 400);
    if (!(Number(l.current_pp) > 0)) throw new GrowthError('NO_PP', 'PP 已用完（在休息站休息可恢复）', 400);
    const effect = rules.computeEffect(l, Number(p.friendship ?? 70));
    const { rows: [u] } = await client.query(
      `UPDATE pokemon_bond_skills SET current_pp = current_pp - 1, times_used = times_used + 1
        WHERE pokemon_instance_id = $1 AND bond_skill_id = $2 RETURNING current_pp`, [pokemonId, sid]);
    await client.query(
      `INSERT INTO bond_skill_usage_stats (user_id, pokemon_instance_id, bond_skill_id, battle_id, damage_dealt, effect_applied)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, pokemonId, sid, battleId ? String(battleId).slice(0, 50) : null, effect.power, effect.effectType]);
    return { ...effect, remainingPp: u.current_pp, battleId: battleId || null };
  });
}

/** 恢复精灵全部羁绊技能 PP（休息站休息结束时调用） */
async function restorePp(client, pokemonId) {
  await client.query(
    `UPDATE pokemon_bond_skills pbs SET current_pp = d.pp FROM bond_skill_definitions d
      WHERE d.id = pbs.bond_skill_id AND pbs.pokemon_instance_id = $1`, [pokemonId]);
}

async function effectOf(pokemonId, skillId, userId) {
  const sid = parseId(skillId, 'skillId');
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const { rows: [def] } = await query('SELECT * FROM bond_skill_definitions WHERE id = $1', [sid]);
  if (!def) throw new GrowthError('BOND_SKILL_NOT_FOUND', '羁绊技能不存在', 404);
  return rules.computeEffect(def, Number(p.friendship ?? 70));
}

async function stats(userId) {
  const { rows: [summary] } = await query(
    `SELECT COUNT(DISTINCT pbs.pokemon_instance_id)::int AS "pokemonWithBondSkills", COUNT(pbs.id)::int AS "totalSkillsLearned",
            COALESCE(SUM(pbs.times_used), 0)::int AS "totalTimesUsed"
       FROM pokemon_bond_skills pbs JOIN pokemon_instances pi ON pi.id = pbs.pokemon_instance_id WHERE pi.user_id = $1`, [userId]);
  const { rows: top } = await query(
    `SELECT d.id, d.skill_name AS name, d.type, COUNT(s.id)::int AS "usageCount", ROUND(AVG(s.damage_dealt))::int AS "avgPower"
       FROM bond_skill_usage_stats s JOIN bond_skill_definitions d ON d.id = s.bond_skill_id
      WHERE s.user_id = $1 GROUP BY d.id, d.skill_name, d.type ORDER BY "usageCount" DESC LIMIT 10`, [userId]);
  return { summary, topSkills: top };
}

/** 战斗档案用：精灵当前激活的羁绊技能效果 */
async function activeEffect(db, pokemon) {
  const { rows: [l] } = await db.query(
    `SELECT pbs.current_pp, d.* FROM pokemon_bond_skills pbs JOIN bond_skill_definitions d ON d.id = pbs.bond_skill_id
      WHERE pbs.pokemon_instance_id = $1 AND pbs.is_active`, [pokemon.id]);
  return l ? { ...rules.computeEffect(l, Number(pokemon.friendship ?? 70)), currentPp: l.current_pp } : null;
}

function invalidateSpecies(speciesId) {
  return getRedis().del(`bond-skills:species:v2:${speciesId}`).catch(() => {});
}

module.exports = { available, getPokemonBondSkills, learn, forget, activate, use, restorePp, effectOf, stats, activeEffect, invalidateSpecies, assertUuid };
