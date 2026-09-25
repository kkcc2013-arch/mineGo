/**
 * 精灵觉醒规则（REQ-00245，纯函数）
 *
 * - 5 个觉醒阶段，每阶段有等级/亲密度/战斗次数/材料（觉醒碎片、觉醒石、觉醒精华 + 家族糖果 + 星尘）要求
 *   （awakening_configs 可按物种覆盖，pokemon_species_id 为 NULL 的是默认配置）
 * - 觉醒时按权重从潜能池抽取不重复的潜能：保底 guaranteed 个，之后每个额外名额 30% 概率，最多 max 个
 * - 重洗某阶段潜能：消耗递增（精华 ×(n+1)、星尘 1000×(n+1)）
 * - 属性类潜能累加为 awakening_bonuses（attackPct/defensePct/hpPct/critRate/…），CP 按
 *   (1+攻)×√(1+防)×√(1+HP) 的比例同步（与 CP 公式一致），觉醒第 3 阶段解锁觉醒技能，阶段决定光环外观
 */
'use strict';

const MAX_STAGE = 5;
const EXTRA_POTENTIAL_CHANCE = 0.3;

const DEFAULT_STAGES = Object.freeze({
  1: { required_level: 20, required_friendship: 150, required_battles: 0, required_materials: [{ item_id: 'AWAKENING_SHARD', count: 10 }], candy: 50, stardust: 5000, guaranteed_potentials: 1, max_potentials: 2 },
  2: { required_level: 30, required_friendship: 180, required_battles: 0, required_materials: [{ item_id: 'AWAKENING_SHARD', count: 20 }, { item_id: 'AWAKENING_STONE', count: 1 }], candy: 100, stardust: 10000, guaranteed_potentials: 1, max_potentials: 2 },
  3: { required_level: 40, required_friendship: 200, required_battles: 0, required_materials: [{ item_id: 'AWAKENING_SHARD', count: 30 }, { item_id: 'AWAKENING_STONE', count: 3 }], candy: 150, stardust: 20000, guaranteed_potentials: 1, max_potentials: 3, skill_unlock: true },
  4: { required_level: 50, required_friendship: 220, required_battles: 0, required_materials: [{ item_id: 'AWAKENING_STONE', count: 5 }, { item_id: 'AWAKENING_ESSENCE', count: 1 }], candy: 200, stardust: 40000, guaranteed_potentials: 2, max_potentials: 3 },
  5: { required_level: 60, required_friendship: 255, required_battles: 0, required_materials: [{ item_id: 'AWAKENING_STONE', count: 10 }, { item_id: 'AWAKENING_ESSENCE', count: 3 }], candy: 300, stardust: 80000, guaranteed_potentials: 2, max_potentials: 3 },
});

const AURAS = Object.freeze({ 0: null, 1: 'aura_green', 2: 'aura_blue', 3: 'aura_purple', 4: 'aura_gold', 5: 'aura_rainbow' });

function stageConfig(stage, override) {
  const base = DEFAULT_STAGES[stage];
  if (!base) return null;
  return override ? { ...base, ...Object.fromEntries(Object.entries(override).filter(([, v]) => v != null)) } : base;
}

/**
 * 条件检查
 * @param {object} cfg 阶段配置
 * @param {object} ctx { level, friendship, battles, items: {CODE: qty}, candy, stardust }
 */
function checkRequirements(cfg, ctx) {
  const checks = [];
  const add = (type, required, current, label) => checks.push({ type, required, current, met: current >= required, label });
  add('level', cfg.required_level, Number(ctx.level) || 1, '精灵等级');
  add('friendship', cfg.required_friendship, Number(ctx.friendship) || 0, '亲密度');
  if (cfg.required_battles) add('battles', cfg.required_battles, Number(ctx.battles) || 0, '战斗次数');
  for (const m of cfg.required_materials || []) add(`item:${m.item_id}`, m.count, Number((ctx.items || {})[m.item_id]) || 0, m.item_id);
  if (cfg.candy) add('candy', cfg.candy, Number(ctx.candy) || 0, '糖果');
  if (cfg.stardust) add('stardust', cfg.stardust, Number(ctx.stardust) || 0, '星尘');
  return { met: checks.every((c) => c.met), checks };
}

/** 抽取数量：保底 + 每个额外名额独立 30% */
function rollCount(cfg, rand = Math.random) {
  let n = cfg.guaranteed_potentials || 1;
  while (n < (cfg.max_potentials || n) && rand() < EXTRA_POTENTIAL_CHANCE) n++;
  return n;
}

/** 按权重抽取 n 个不重复潜能 */
function drawPotentials(pool, n, rand = Math.random) {
  const left = pool.filter((p) => Number(p.weight) > 0).slice();
  const out = [];
  while (out.length < n && left.length) {
    const total = left.reduce((a, p) => a + Number(p.weight), 0);
    let r = rand() * total;
    let idx = left.length - 1;
    for (let i = 0; i < left.length; i++) {
      r -= Number(left[i].weight);
      if (r < 0) { idx = i; break; }
    }
    out.push(left.splice(idx, 1)[0]);
  }
  return out;
}

/** 所有阶段的属性类潜能累加 */
function sumBonuses(stages) {
  const b = { attackPct: 0, defensePct: 0, hpPct: 0, critRate: 0, dodgeRate: 0, skillPowerPct: 0 };
  for (const st of stages) {
    for (const p of st.activated_potentials || []) {
      const e = p.effect_config || p.effect || {};
      if (e.stat && Object.prototype.hasOwnProperty.call(b, e.stat)) b[e.stat] = Math.round((b[e.stat] + Number(e.value || 0)) * 1000) / 1000;
    }
  }
  return b;
}

/** 觉醒加成对 CP 的倍率（与 CP 公式 A×√D×√H 一致） */
function cpFactor(bonuses = {}) {
  const a = 1 + (Number(bonuses.attackPct) || 0);
  const d = 1 + (Number(bonuses.defensePct) || 0);
  const h = 1 + (Number(bonuses.hpPct) || 0);
  return a * Math.sqrt(d) * Math.sqrt(h);
}

function rerollCost(attempts) {
  const n = Math.max(0, Number(attempts) || 0) + 1;
  return { items: [{ item_id: 'AWAKENING_ESSENCE', count: n }], stardust: 1000 * n };
}

function awakeningSkill(stage, type1) {
  if (stage < 3) return null;
  return { id: 'awakening_burst', name: '觉醒爆发', nameEn: 'Awakening Burst', type: type1 || 'NORMAL', power: 120 + (stage - 3) * 20, energyCost: 60 };
}

module.exports = { MAX_STAGE, DEFAULT_STAGES, AURAS, stageConfig, checkRequirements, rollCount, drawPotentials, sumBonuses, cpFactor, rerollCost, awakeningSkill };
