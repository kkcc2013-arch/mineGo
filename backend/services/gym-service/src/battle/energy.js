// 技能能量（REQ-00112）
//   - 能量上限与个体值关联：100 + round(个体值总和 / 45 * 20)，即 100~120
//   - 快速技能回复 energy_delta，蓄力技能消耗 max(energy_cost, -energy_delta)
//   - 每回合开始按 energy_regen_rules（默认 standard）自动回复：基础值 + 低血量加成 + 状态修正
'use strict';

const DEFAULT_RULE = {
  rule_name: 'standard',
  base_regen: 10,
  hp_threshold_bonus: [{ threshold: 0.25, bonus: 5 }],
  status_effect_modifiers: { frozen: -10, paralyzed: -5 },
  item_modifiers: {},
};

// 战斗状态码 → energy_regen_rules 里的状态名
const STATUS_ALIAS = { STUN: 'paralyzed', FREEZE: 'frozen', BURN: 'burned', POISON: 'poisoned', CONFUSE: 'confused' };

function parseJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
  return v;
}

function normalizeRule(row) {
  if (!row) return { ...DEFAULT_RULE };
  return {
    rule_name: row.rule_name || 'standard',
    base_regen: Number(row.base_regen) || 0,
    hp_threshold_bonus: parseJson(row.hp_threshold_bonus, []),
    status_effect_modifiers: parseJson(row.status_effect_modifiers, {}),
    item_modifiers: parseJson(row.item_modifiers, {}),
  };
}

function maxEnergyFor(ivSum) {
  return 100 + Math.round(((Number(ivSum) || 0) / 45) * 20);
}

/** 本回合自动回复量 */
function regenAmount(combatant, rule = DEFAULT_RULE, items = []) {
  let amount = Number(rule.base_regen) || 0;
  const ratio = combatant.maxHp ? combatant.hp / combatant.maxHp : 1;
  // 取满足条件的最大加成（阈值越低加成通常越高）
  let hpBonus = 0;
  for (const t of rule.hp_threshold_bonus || []) {
    if (ratio <= Number(t.threshold)) hpBonus = Math.max(hpBonus, Number(t.bonus) || 0);
  }
  amount += hpBonus;
  if (combatant.status) {
    const key = STATUS_ALIAS[combatant.status.code] || String(combatant.status.code).toLowerCase();
    amount += Number((rule.status_effect_modifiers || {})[key]) || 0;
  }
  for (const it of items) amount += Number((rule.item_modifiers || {})[it]) || 0;
  return Math.max(0, amount);
}

function regenerate(combatant, rule, items) {
  const before = combatant.energy || 0;
  const add = regenAmount(combatant, rule, items);
  combatant.energy = Math.min(combatant.maxEnergy || 100, before + add);
  return combatant.energy - before;
}

/**
 * 技能是否可用（能量 + 冷却）
 * @returns {{ok:boolean, reason?:'ENERGY'|'COOLDOWN'|'UNKNOWN_MOVE', need?:number, have?:number, cooldownLeft?:number}}
 */
function checkMove(combatant, moveId, { turn, now } = {}) {
  const move = (combatant.moves || []).find((m) => m.id === moveId);
  if (!move) return { ok: false, reason: 'UNKNOWN_MOVE' };
  if (turn !== undefined) {
    const left = Math.max(0, ((combatant.readyTurn || {})[moveId] || 0) - turn);
    if (left > 0) return { ok: false, reason: 'COOLDOWN', cooldownLeft: left, move };
  }
  if (now !== undefined) {
    const leftMs = Math.max(0, ((combatant.readyAt || {})[moveId] || 0) - now);
    if (leftMs > 0) return { ok: false, reason: 'COOLDOWN', cooldownLeftMs: leftMs, move };
  }
  if (move.category === 'CHARGE' && (combatant.energy || 0) < move.energyCost) {
    return { ok: false, reason: 'ENERGY', need: move.energyCost, have: combatant.energy || 0, move };
  }
  return { ok: true, move };
}

/** 应用技能的能量变化，返回变化量 */
function applyMoveEnergy(combatant, move) {
  const before = combatant.energy || 0;
  if (move.category === 'CHARGE') combatant.energy = Math.max(0, before - move.energyCost);
  else combatant.energy = Math.min(combatant.maxEnergy || 100, before + (move.energyGain || 0));
  return combatant.energy - before;
}

module.exports = { DEFAULT_RULE, normalizeRule, maxEnergyFor, regenAmount, regenerate, checkMove, applyMoveEnergy, STATUS_ALIAS };
