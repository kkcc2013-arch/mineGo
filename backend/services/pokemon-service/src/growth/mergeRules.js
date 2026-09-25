/**
 * 精灵合并进化规则（REQ-00390，纯函数，随机数可注入）
 *
 * - 配方：若干只指定物种（数量、最低等级）+ 可选道具 → 产出物种（等级 = 最低等级 + 0~浮动），另有小概率变异产出
 * - 参与精灵：必须属于玩家、空闲（不在训练/培育/驻守道馆）、非收藏、未锁定，且恰好满足配方（多选/少选/物种不符都拒绝）
 * - 成功率 = 基础成功率 + 品质加成（平均 IV 百分比 × 10%）+ 等级加成（平均超出最低等级的级数 × 0.5%，最多 +10%）
 *           + 幸运符（+15%），上限 95%
 * - 成功：按变异率决定产出物种；后代 IV = 参与精灵平均 IV + 1（上限 15）；失败：参与精灵照样消耗
 */
'use strict';

const MAX_SUCCESS = 95;
const LUCKY_CHARM_BONUS = 15;

function r2(v) { return Math.round(v * 100) / 100; }

/** 选择的精灵是否恰好满足配方 */
function validateSelection(recipe, pokemons) {
  const errors = [];
  const req = (recipe.required_pokemon || []).map((r) => ({ species: Number(r.species_id ?? r.pokemon_id), count: Number(r.count) || 1, minLevel: Number(r.min_level) || 1 }));
  const need = req.reduce((a, r) => a + r.count, 0);
  if (pokemons.length !== need) errors.push(`需要 ${need} 只精灵，选择了 ${pokemons.length} 只`);
  const ids = new Set();
  for (const p of pokemons) {
    if (ids.has(p.id)) errors.push('同一只精灵不能重复选择');
    ids.add(p.id);
    if (p.is_favorite || p.is_favorited) errors.push(`${p.nickname || p.species_name || p.id} 已收藏，不能参与合并`);
    if (p.is_locked) errors.push(`${p.nickname || p.species_name || p.id} 已锁定，不能参与合并`);
    if (p.occupied_by || p.defending_gym_id) errors.push(`${p.nickname || p.species_name || p.id} 正在忙碌，不能参与合并`);
  }
  for (const r of req) {
    const ok = pokemons.filter((p) => Number(p.species_id) === r.species && (Number(p.level) || 1) >= r.minLevel);
    const any = pokemons.filter((p) => Number(p.species_id) === r.species);
    if (any.length !== r.count) errors.push(`需要物种 ${r.species} ×${r.count}（选择了 ${any.length}）`);
    else if (ok.length !== r.count) errors.push(`物种 ${r.species} 需要等级 ≥ ${r.minLevel}`);
  }
  const allowed = new Set(req.map((r) => r.species));
  if (pokemons.some((p) => !allowed.has(Number(p.species_id)))) errors.push('选择了配方不需要的物种');
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

function successRate(recipe, pokemons, { luckyCharm = false } = {}) {
  const base = Number(recipe.base_success_rate) || 0;
  const n = pokemons.length || 1;
  const ivPct = pokemons.reduce((a, p) => a + ((Number(p.iv_attack) || 0) + (Number(p.iv_defense) || 0) + (Number(p.iv_hp) || 0)) / 45, 0) / n;
  const minLv = Math.min(...(recipe.required_pokemon || [{ min_level: 1 }]).map((r) => Number(r.min_level) || 1));
  const lvOver = pokemons.reduce((a, p) => a + Math.max(0, (Number(p.level) || 1) - minLv), 0) / n;
  const quality = r2(ivPct * 10);
  const level = r2(Math.min(10, lvOver * 0.5));
  const lucky = luckyCharm ? LUCKY_CHARM_BONUS : 0;
  return { base, quality, level, lucky, total: r2(Math.min(MAX_SUCCESS, base + quality + level + lucky)) };
}

function roll(ratePct, variantRatePct, rand = Math.random) {
  const success = rand() * 100 < ratePct;
  const variant = success && Number(variantRatePct) > 0 && rand() * 100 < Number(variantRatePct);
  return { success, variant };
}

function outputStats(recipe, pokemons, rand = Math.random) {
  const n = pokemons.length || 1;
  const avg = (k) => pokemons.reduce((a, p) => a + (Number(p[k]) || 0), 0) / n;
  const variance = Math.max(0, Number(recipe.output_level_variance) || 0);
  return {
    level: Math.max(1, (Number(recipe.output_min_level) || 1) + Math.floor(rand() * (variance + 1))),
    ivs: {
      attack: Math.min(15, Math.round(avg('iv_attack')) + 1),
      defense: Math.min(15, Math.round(avg('iv_defense')) + 1),
      hp: Math.min(15, Math.round(avg('iv_hp')) + 1),
    },
  };
}

/** 配方是否可用（解锁条件 + 玩家现有精灵是否够） */
function availability(recipe, ownedBySpecies = {}, trainerLevel = 1) {
  const need = (recipe.unlock_conditions && recipe.unlock_conditions.trainer_level) || 1;
  const locked = Number(trainerLevel) < need;
  const missing = (recipe.required_pokemon || []).map((r) => ({ speciesId: Number(r.species_id), need: Number(r.count), have: Number(ownedBySpecies[r.species_id] || 0) }))
    .filter((m) => m.have < m.need);
  return { locked, lockedReason: locked ? `需要训练师等级 ${need}` : null, missing, ready: !locked && missing.length === 0 };
}

module.exports = { MAX_SUCCESS, LUCKY_CHARM_BONUS, validateSelection, successRate, roll, outputStats, availability };
