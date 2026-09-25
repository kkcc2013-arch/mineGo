// 技能冷却计算（REQ-00112 冷却回合 / REQ-00299 冷却优化 / REQ-00311 智能加速）
//
// 有效冷却 = 基础冷却 × 模式倍率 × 天气系数 × (1 - 总缩减)
//   总缩减 = 1 - Π(1 - 各项缩减)，再按战斗模式上限截断：
//     熟练度：0-100 → 0-15%（REQ-00299）
//     连击加速：本场第 3 次连击起每次 -2%，最多 10%（REQ-00299）
//     速度：每 10 点速度 -2%，最多 20%（REQ-00311）
//     装备：宝石/符文/神器累加，上限 30%（REQ-00311）
//   天气：技能属性受当前天气加成时冷却 ×0.9（REQ-00311）
//   模式：PVE / PVP / RAID / TOURNAMENT 四种策略（REQ-00299），锦标赛禁用装备与熟练度保证公平
// 回合制战斗把毫秒冷却换算为回合：floor(ms / 1000)，技能可用回合 readyTurn = 使用回合 + 冷却回合 + 1
'use strict';

const { isWeatherBoosted } = require('./damage');

const TURN_MS = 1000;

const MODE_STRATEGIES = {
  PVE: { baseMultiplier: 1.0, maxReduction: 0.5, equipment: true, mastery: true, description: '道馆/练习：标准冷却' },
  PVP: { baseMultiplier: 1.1, maxReduction: 0.3, equipment: true, mastery: true, description: '玩家对战：冷却略长，缩减上限 30%' },
  RAID: { baseMultiplier: 0.9, maxReduction: 0.5, equipment: true, mastery: true, description: '团战：冷却缩短 10%，鼓励输出' },
  TOURNAMENT: { baseMultiplier: 1.0, maxReduction: 0.2, equipment: false, mastery: false, description: '联赛/锦标赛：禁用装备与熟练度，缩减上限 20%' },
};

const LIMITS = {
  masteryMax: 0.15,
  comboStep: 0.02,
  comboMax: 0.10,
  comboThreshold: 3,
  speedStep: 0.02,
  speedPer: 10,
  speedMax: 0.20,
  equipmentMax: 0.30,
  weatherFactor: 0.9,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function masteryReduction(mastery) {
  return (clamp(Number(mastery) || 0, 0, 100) / 100) * LIMITS.masteryMax;
}

function comboAcceleration(comboCount) {
  const n = Number(comboCount) || 0;
  if (n < LIMITS.comboThreshold) return 0;
  return Math.min(LIMITS.comboMax, (n - LIMITS.comboThreshold + 1) * LIMITS.comboStep);
}

function speedReduction(speed) {
  return Math.min(LIMITS.speedMax, Math.floor((Number(speed) || 0) / LIMITS.speedPer) * LIMITS.speedStep);
}

/** 装备缩减：只累加适用于该技能的装备，上限 30% */
function equipmentReduction(equipment, move) {
  let pct = 0;
  for (const e of equipment || []) {
    if (!e) continue;
    const appliesTo = String(e.applies_to || e.appliesTo || 'ALL').toUpperCase();
    if (appliesTo !== 'ALL' && appliesTo !== move.category) continue;
    const mt = e.move_type || e.moveType;
    if (mt && String(mt).toLowerCase() !== String(move.type).toLowerCase()) continue;
    pct += Number(e.reduction_pct || e.reductionPct) || 0;
  }
  return Math.min(LIMITS.equipmentMax, pct / 100);
}

/**
 * @param {object} move  规范化技能（cooldownMs, category, type）
 * @param {object} ctx   { mode, mastery, comboCount, speed, equipment, weather }
 */
function effectiveCooldown(move, ctx = {}) {
  const mode = MODE_STRATEGIES[ctx.mode] || MODE_STRATEGIES.PVE;
  const baseMs = Number(move.cooldownMs) || 0;
  const parts = {
    mastery: mode.mastery ? masteryReduction(ctx.mastery) : 0,
    combo: comboAcceleration(ctx.comboCount),
    speed: speedReduction(ctx.speed),
    equipment: mode.equipment ? equipmentReduction(ctx.equipment, move) : 0,
  };
  const combined = 1 - Object.values(parts).reduce((acc, r) => acc * (1 - r), 1);
  const reduction = Math.min(mode.maxReduction, combined);
  const weatherBoosted = isWeatherBoosted(move.type, ctx.weather);
  const weatherFactor = weatherBoosted ? LIMITS.weatherFactor : 1;
  const effectiveMs = Math.round(baseMs * mode.baseMultiplier * weatherFactor * (1 - reduction));
  return {
    baseMs,
    effectiveMs,
    turns: Math.floor(effectiveMs / TURN_MS),
    reduction: Number(reduction.toFixed(4)),
    capped: combined > mode.maxReduction,
    breakdown: {
      mastery: Number(parts.mastery.toFixed(4)),
      combo: Number(parts.combo.toFixed(4)),
      speed: Number(parts.speed.toFixed(4)),
      equipment: Number(parts.equipment.toFixed(4)),
      weatherFactor,
      modeMultiplier: mode.baseMultiplier,
      modeMaxReduction: mode.maxReduction,
    },
  };
}

/** 回合制：技能剩余冷却回合 */
function remainingTurns(combatant, moveId, currentTurn) {
  const ready = (combatant.readyTurn || {})[moveId] || 0;
  return Math.max(0, ready - currentTurn);
}

/** 实时（团战）：剩余毫秒 */
function remainingMs(combatant, moveId, now) {
  const ready = (combatant.readyAt || {})[moveId] || 0;
  return Math.max(0, ready - now);
}

/** 记录一次技能使用后的冷却 */
function startCooldown(combatant, move, { turn, now, ctx }) {
  const cd = effectiveCooldown(move, ctx);
  combatant.readyTurn = combatant.readyTurn || {};
  combatant.readyAt = combatant.readyAt || {};
  if (turn !== undefined) combatant.readyTurn[move.id] = turn + cd.turns + 1;
  if (now !== undefined) combatant.readyAt[move.id] = now + Math.max(cd.effectiveMs, move.durationMs || 0);
  return cd;
}

/** 连击奖励的冷却缩减：剩余冷却按百分比缩短 */
function reduceRemaining(combatant, pct, { turn, now } = {}) {
  const f = 1 - clamp(Number(pct) || 0, 0, 100) / 100;
  for (const id of Object.keys(combatant.readyTurn || {})) {
    const left = combatant.readyTurn[id] - (turn || 0);
    if (left > 0) combatant.readyTurn[id] = (turn || 0) + Math.floor(left * f);
  }
  for (const id of Object.keys(combatant.readyAt || {})) {
    const left = combatant.readyAt[id] - (now || 0);
    if (left > 0) combatant.readyAt[id] = (now || 0) + Math.floor(left * f);
  }
}

/**
 * 冷却预测与优化建议（REQ-00299「冷却预测系统」）
 * @returns {{ moves: Array, tips: string[] }}
 */
function predict(combatant, { turn = 0, ctx = {} } = {}) {
  const moves = (combatant.moves || []).map((m) => {
    const cd = effectiveCooldown(m, { ...ctx, mastery: (combatant.mastery || {})[m.id], speed: combatant.speed, equipment: combatant.equipment });
    const left = remainingTurns(combatant, m.id, turn);
    const energyShort = Math.max(0, (m.energyCost || 0) - (combatant.energy || 0));
    const gain = Math.max(1, (combatant.moves.find((x) => x.category === 'FAST') || {}).energyGain || 0) + 10;
    return {
      moveId: m.id, name: m.name, category: m.category,
      cooldownTurns: cd.turns, cooldownMs: cd.effectiveMs, baseCooldownMs: cd.baseMs, reduction: cd.reduction,
      readyInTurns: Math.max(left, energyShort > 0 ? Math.ceil(energyShort / gain) : 0),
      cooldownLeft: left, energyShort, breakdown: cd.breakdown,
    };
  });
  const tips = [];
  const mode = MODE_STRATEGIES[ctx.mode] || MODE_STRATEGIES.PVE;
  const charge = moves.filter((m) => m.category === 'CHARGE');
  for (const m of charge) {
    if (m.breakdown.equipment < LIMITS.equipmentMax && mode.equipment) {
      tips.push(`${m.name}：装备符文/神器最多可再减少 ${Math.round((LIMITS.equipmentMax - m.breakdown.equipment) * 100)}% 冷却`);
    }
    if (m.breakdown.mastery < LIMITS.masteryMax && mode.mastery) {
      tips.push(`${m.name}：继续使用提升熟练度，最多可减少 ${Math.round(LIMITS.masteryMax * 100)}% 冷却（当前 ${Math.round(m.breakdown.mastery * 100)}%）`);
    }
    if (m.energyShort > 0) tips.push(`${m.name}：还差 ${m.energyShort} 点能量，约 ${m.readyInTurns} 回合后可用，先用快速技能蓄能`);
  }
  if (!tips.length) tips.push('冷却配置已接近当前模式上限');
  return { mode: ctx.mode || 'PVE', maxReduction: mode.maxReduction, moves, tips: tips.slice(0, 6) };
}

module.exports = {
  MODE_STRATEGIES, LIMITS, TURN_MS,
  masteryReduction, comboAcceleration, speedReduction, equipmentReduction,
  effectiveCooldown, remainingTurns, remainingMs, startCooldown, reduceRemaining, predict,
};
