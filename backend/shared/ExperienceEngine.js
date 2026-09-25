/**
 * 精灵经验值计算引擎（REQ-00216，纯函数，无 I/O）
 *
 * - 成长曲线：按 pokemon_species.growth_rate 计算"达到某等级所需的累计经验"，1 级为 0
 * - 等级上限：min(100, 2 × 训练师等级 + 10)，经验可继续累积（训练师升级后自动补升），累计上限为 100 级所需经验
 * - 基础经验：baseExp × 等级差系数（对手等级高于精灵时每级 +10%，最高 ×3）× 稀有度系数
 * - 连击：<5 ×1.0，<10 ×1.1，<25 ×1.25，之后每次 +1% 至 ×1.5（需求原公式在 20 次时从 1.25 跌到 1.2，已修正为单调）
 * - 首次捕获该物种 ×2
 * - 最终倍率各来源相乘（公会 BUFF 与个人 BUFF 可叠加）：活动、幸运蛋、经验卡、VIP、公会、疲劳
 * - 精灵等级倍率：每级 CP +2%（与进化的 CP 按比例缩放规则一致）
 */
'use strict';

const MAX_LEVEL = 100;
const TRANSFER_RATIO = 0.8;

const RARITY_MULTIPLIER = Object.freeze({
  COMMON: 1.0, UNCOMMON: 1.2, RARE: 1.5, EPIC: 2.0, LEGENDARY: 3.0,
});

const CURVES = Object.freeze({
  fast: (n) => Math.floor((4 * n ** 3) / 5),
  medium_fast: (n) => n ** 3,
  medium_slow: (n) => Math.max(0, Math.floor((6 / 5) * n ** 3 - 15 * n ** 2 + 100 * n - 140)),
  slow: (n) => Math.floor((5 * n ** 3) / 4),
});

function curveOf(growthRate) {
  return CURVES[growthRate] || CURVES.medium_fast;
}

function clampLevel(level) {
  const l = Math.trunc(Number(level) || 1);
  return Math.min(MAX_LEVEL, Math.max(1, l));
}

/** 达到 level 所需累计经验（1 级为 0；各曲线在 n ≥ 2 时单调递增） */
function expForLevel(level, growthRate = 'medium_fast') {
  const l = clampLevel(level);
  return l <= 1 ? 0 : curveOf(growthRate)(l);
}

/** 累计经验对应的等级（不超过 cap） */
function levelFromExp(exp, growthRate = 'medium_fast', cap = MAX_LEVEL) {
  const e = Math.max(0, Math.trunc(Number(exp) || 0));
  const max = clampLevel(cap);
  let level = 1;
  while (level < max && expForLevel(level + 1, growthRate) <= e) level++;
  return level;
}

/** 精灵等级上限（受训练师等级约束） */
function levelCap(trainerLevel) {
  const t = Math.max(1, Math.trunc(Number(trainerLevel) || 1));
  return Math.min(MAX_LEVEL, 2 * t + 10);
}

/** 累计经验上限（100 级所需），防止无限累积 */
function maxExperience(growthRate = 'medium_fast') {
  return expForLevel(MAX_LEVEL, growthRate);
}

/** 等级倍率：每级 CP +2% */
function levelMultiplier(level) {
  return 1 + 0.02 * (clampLevel(level) - 1);
}

/** 基础经验：考虑与对手的等级差、稀有度 */
function calculateBaseExperience({ baseExp = 100, rarity = 'COMMON', pokemonLevel = 1, opponentLevel = 1 } = {}) {
  const diff = Math.max(0, Math.trunc(Number(opponentLevel) || 0) - Math.trunc(Number(pokemonLevel) || 1));
  const levelBonus = Math.min(3, 1 + diff * 0.1);
  const rarityMult = RARITY_MULTIPLIER[String(rarity || 'COMMON').toUpperCase()] || 1.0;
  return Math.floor(Math.max(0, Number(baseExp) || 0) * levelBonus * rarityMult);
}

/** 捕捉时新精灵获得的基础经验：对手等级取训练师等级（训练师越强，新精灵起点越高） */
function catchBaseExperience({ rarity, trainerLevel = 1 } = {}) {
  return calculateBaseExperience({ baseExp: 100, rarity, pokemonLevel: 1, opponentLevel: trainerLevel });
}

/** 连击加成（单调不减） */
function comboMultiplier(comboCount) {
  const c = Math.max(0, Math.trunc(Number(comboCount) || 0));
  if (c < 5) return 1.0;
  if (c < 10) return 1.1;
  if (c < 25) return 1.25;
  return Math.min(1.5, 1 + c * 0.01);
}

/**
 * 最终经验
 * @param {number} baseExp
 * @param {object} ctx { combo, firstCatch, eventMultiplier, luckyEgg, expCardMultiplier, vip, guildBuff, fatigueMultiplier }
 * @returns {{ final: number, multiplier: number, breakdown: Array<{source: string, multiplier: number}> }}
 */
function calculateFinalExperience(baseExp, ctx = {}) {
  const breakdown = [];
  const push = (source, m) => {
    if (Number.isFinite(m) && m > 0 && m !== 1) breakdown.push({ source, multiplier: Math.round(m * 1000) / 1000 });
  };
  if (ctx.combo != null) push('combo', comboMultiplier(ctx.combo));
  if (ctx.firstCatch) push('first_catch', 2.0);
  if (ctx.eventMultiplier) push('event', Number(ctx.eventMultiplier));
  if (ctx.luckyEgg) push('lucky_egg', 2.0);
  if (ctx.expCardMultiplier) push('exp_card', Number(ctx.expCardMultiplier));
  if (ctx.vip) push('vip', 1.25);
  if (ctx.guildBuff) push('guild', 1 + Number(ctx.guildBuff));
  if (ctx.fatigueMultiplier != null) push('fatigue', Number(ctx.fatigueMultiplier));
  const multiplier = breakdown.reduce((m, b) => m * b.multiplier, 1);
  const final = Math.max(0, Math.floor(Math.max(0, Number(baseExp) || 0) * multiplier));
  return { final, multiplier: Math.round(multiplier * 1000) / 1000, breakdown };
}

/** 经验转移：目标获得 80%（向下取整） */
function transferAmount(amount) {
  return Math.floor(Math.max(0, Math.trunc(Number(amount) || 0)) * TRANSFER_RATIO);
}

/**
 * 升级预测
 * @param {object} p { experience, level, growthRate, cap }
 * @param {number} avgDailyExp 近期日均经验
 * @param {number} [levels=5] 预测接下来几级
 */
function predictLevels(p, avgDailyExp, levels = 5) {
  const out = [];
  const cap = clampLevel(p.cap || MAX_LEVEL);
  for (let l = clampLevel(p.level) + 1; l <= Math.min(cap, clampLevel(p.level) + levels); l++) {
    const need = Math.max(0, expForLevel(l, p.growthRate) - Math.trunc(Number(p.experience) || 0));
    out.push({ level: l, expNeeded: need, days: avgDailyExp > 0 ? Math.ceil((need / avgDailyExp) * 10) / 10 : null });
  }
  return out;
}

/**
 * 预测置信度 0~1：有经验的天数越多、日经验越稳定越高
 * @param {number[]} dailyExp 最近 N 天每日经验（含 0）
 */
function predictionConfidence(dailyExp) {
  const days = dailyExp.length;
  if (!days) return 0;
  const active = dailyExp.filter((v) => v > 0).length;
  if (!active) return 0;
  const mean = dailyExp.reduce((a, b) => a + b, 0) / days;
  const variance = dailyExp.reduce((a, b) => a + (b - mean) ** 2, 0) / days;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  const coverage = Math.min(1, active / 7);
  const stability = 1 / (1 + cv);
  return Math.round(coverage * stability * 100) / 100;
}

/** 来源占比（百分比保留 1 位小数，总和修正为 100） */
function sourceBreakdown(rows) {
  const total = rows.reduce((a, r) => a + Math.max(0, Number(r.amount) || 0), 0);
  if (!total) return rows.map((r) => ({ source: r.source, amount: 0, percentage: 0 }));
  const list = rows.map((r) => ({ source: r.source, amount: Number(r.amount) || 0, percentage: Math.round((Number(r.amount) / total) * 1000) / 10 }));
  const diff = Math.round((100 - list.reduce((a, r) => a + r.percentage, 0)) * 10) / 10;
  if (diff && list.length) {
    const top = list.reduce((a, b) => (b.amount > a.amount ? b : a));
    top.percentage = Math.round((top.percentage + diff) * 10) / 10;
  }
  return list.sort((a, b) => b.amount - a.amount);
}

module.exports = {
  MAX_LEVEL,
  TRANSFER_RATIO,
  RARITY_MULTIPLIER,
  expForLevel,
  levelFromExp,
  levelCap,
  maxExperience,
  levelMultiplier,
  calculateBaseExperience,
  catchBaseExperience,
  comboMultiplier,
  calculateFinalExperience,
  transferAmount,
  predictLevels,
  predictionConfidence,
  sourceBreakdown,
};
