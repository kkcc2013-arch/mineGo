/**
 * 精灵专项特训规则（REQ-00612，纯函数）
 *
 * 训练属性（每 10 训练点 = 1 级）：
 *   attack/defense/speed 上限 100 级，每级 +2%；critical 上限 50，每级暴击 +0.5%；dodge 上限 50，每级闪避 +0.3%；
 *   energy 上限 50，每级能量上限 +5
 * 一次特训 60 分钟：消耗对应训练道具 1 个 + 家族糖果 + 场地费用（金币/小时）+ 体力（special_training）；
 *   基础 10 点 × 场地加成（对口属性或综合训练中心）；成功率 80%（金苹果 +20%），失败只得一半训练点
 * 技能熟练度（每个招式）：威力 0~10（+5%/级）、命中 0~10（+2%/级）、暴击 0~5（+3%/级），
 *   熟练度经验 0~100，在 10/25/50/75/100 依次解锁特效
 * 队列：默认 3 个并行特训，VIP1/2/3 额外 +2/+3/+5；每只精灵完成后冷却 60 分钟；每日 10 次（VIP +5）
 */
'use strict';

const POINTS_PER_LEVEL = 10;
const BASE_POINTS = 10;
const SESSION_MINUTES = 60;
const BASE_SUCCESS = 0.8;
const GOLDEN_APPLE_BONUS = 0.2;
const COOLDOWN_MINUTES = 60;
const DAILY_LIMIT = 10;
const VIP_DAILY_BONUS = 5;

const ATTRIBUTES = Object.freeze({
  attack: { name: '攻击强化', maxLevel: 100, perLevel: 0.02, effect: 'attackPct', item: 'TRAIN_ENERGY_DRINK', candy: 100 },
  defense: { name: '防御强化', maxLevel: 100, perLevel: 0.02, effect: 'defensePct', item: 'TRAIN_PROTEIN_POWDER', candy: 100 },
  speed: { name: '速度强化', maxLevel: 100, perLevel: 0.02, effect: 'speedPct', item: 'TRAIN_AGILITY_PILL', candy: 100 },
  critical: { name: '暴击强化', maxLevel: 50, perLevel: 0.005, effect: 'critRate', item: 'TRAIN_CRITICAL_STONE', candy: 200 },
  dodge: { name: '闪避强化', maxLevel: 50, perLevel: 0.003, effect: 'dodgeRate', item: 'TRAIN_SWIFT_FEATHER', candy: 150 },
  energy: { name: '能量强化', maxLevel: 50, perLevel: 5, effect: 'energyCap', item: 'TRAIN_ENERGY_CORE', candy: 250 },
});

const FACILITIES = Object.freeze({
  basic: { name: '基础训练场', boostAttribute: null, multiplier: 1.0, trainerLevel: 1, coinsPerHour: 0 },
  strength_gym: { name: '力量训练场', boostAttribute: 'attack', multiplier: 1.5, trainerLevel: 5, coinsPerHour: 500 },
  agility_track: { name: '敏捷训练场', boostAttribute: 'speed', multiplier: 1.5, trainerLevel: 10, coinsPerHour: 800 },
  wisdom_academy: { name: '智慧学院', boostAttribute: 'energy', multiplier: 1.3, trainerLevel: 15, coinsPerHour: 1000 },
  critical_dojo: { name: '暴击道场', boostAttribute: 'critical', multiplier: 2.0, trainerLevel: 20, coinsPerHour: 1500 },
  all_purpose_center: { name: '综合训练中心', boostAttribute: 'all', multiplier: 1.2, trainerLevel: 25, coinsPerHour: 2000 },
});

const ACCELERATORS = Object.freeze({ TRAINING_ACCELERATOR_1H: 60, TRAINING_ACCELERATOR_8H: 480 });

const MASTERY = Object.freeze({
  power: { name: '威力强化', maxLevel: 10, perLevel: 0.05, cost: { candy: 10 } },
  accuracy: { name: '命中强化', maxLevel: 10, perLevel: 0.02, cost: { item: 'TRAIN_FOCUS_LENS', qty: 1 } },
  critical_chance: { name: '暴击强化', maxLevel: 5, perLevel: 0.03, cost: { item: 'TRAIN_CRITICAL_STONE', qty: 2 } },
});
const EFFECT_THRESHOLDS = Object.freeze([
  { exp: 10, effect: '概率追加状态异常' },
  { exp: 25, effect: '提升异常触发概率' },
  { exp: 50, effect: '追加属性下降效果' },
  { exp: 75, effect: '追加生命回复效果' },
  { exp: 100, effect: '无视部分防御' },
]);
const MASTERY_MANUAL_EXP = 20;
const MASTERY_EXP_PER_TRAIN = 5;

const ACHIEVEMENTS = Object.freeze([
  { id: 'first_training', name: '初出茅庐', test: (s) => s.completedSessions >= 1, reward: { candy: 1000 } },
  { id: 'attack_master', name: '攻击大师', test: (s) => (s.levels.attack || 0) >= 50, reward: { items: [{ type: 'TRAIN_CRITICAL_STONE', qty: 10 }] } },
  { id: 'all_rounder', name: '全能战士', test: (s) => Object.keys(ATTRIBUTES).every((a) => (s.levels[a] || 0) >= 30), reward: { items: [{ type: 'TRAIN_GOLDEN_APPLE', qty: 1 }] } },
  { id: 'skill_expert', name: '技能专家', test: (s) => (s.maxMasteryExp || 0) >= 100, reward: { items: [{ type: 'TRAIN_MASTERY_MANUAL', qty: 5 }] } },
  { id: 'training_addict', name: '训练狂人', test: (s) => (s.totalHours || 0) >= 1000, reward: { coins: 100000 } },
]);

function levelOf(attribute, points) {
  const a = ATTRIBUTES[attribute];
  return Math.min(a.maxLevel, Math.floor(Math.max(0, Number(points) || 0) / POINTS_PER_LEVEL));
}

function facilityMultiplier(facilityId, attribute) {
  const f = FACILITIES[facilityId];
  if (!f) return 1;
  return f.boostAttribute === attribute || f.boostAttribute === 'all' ? f.multiplier : 1;
}

/** 一次特训的计划：费用、预期训练点、成功率 */
function plan(attribute, facilityId, { trainerLevel = 1, goldenApple = false } = {}) {
  const a = ATTRIBUTES[attribute];
  if (!a) throw new Error(`未知的训练属性 ${attribute}`);
  const f = FACILITIES[facilityId || 'basic'];
  if (!f) throw new Error(`未知的训练场地 ${facilityId}`);
  const locked = Number(trainerLevel) < f.trainerLevel;
  return {
    attribute,
    facilityId: facilityId || 'basic',
    locked,
    lockedReason: locked ? `需要训练师等级 ${f.trainerLevel}` : null,
    durationMinutes: SESSION_MINUTES,
    cost: { item: a.item, itemQty: 1, candy: a.candy, coins: Math.round((f.coinsPerHour * SESSION_MINUTES) / 60), goldenApple: goldenApple ? 1 : 0 },
    points: Math.round(BASE_POINTS * facilityMultiplier(facilityId, attribute)),
    successRate: Math.min(1, BASE_SUCCESS + (goldenApple ? GOLDEN_APPLE_BONUS : 0)),
  };
}

/** 结算：成功得全部训练点，失败得一半（rand 可注入） */
function resolve(expectedPoints, successRate, rand = Math.random()) {
  const success = rand < successRate;
  return { success, points: success ? expectedPoints : Math.floor(expectedPoints / 2) };
}

function applyPoints(attribute, currentPoints, gained) {
  const a = ATTRIBUTES[attribute];
  const cap = a.maxLevel * POINTS_PER_LEVEL;
  const before = Math.max(0, Number(currentPoints) || 0);
  const after = Math.min(cap, before + Math.max(0, gained));
  return { pointsBefore: before, pointsAfter: after, levelBefore: levelOf(attribute, before), levelAfter: levelOf(attribute, after), capped: before + gained > cap };
}

/** 属性等级 → 战斗加成 */
function attributeBonuses(levels = {}) {
  const out = { attackPct: 0, defensePct: 0, speedPct: 0, critRate: 0, dodgeRate: 0, energyCap: 0 };
  for (const [k, a] of Object.entries(ATTRIBUTES)) {
    const l = Math.min(a.maxLevel, Math.max(0, Number(levels[k]) || 0));
    out[a.effect] = Math.round(l * a.perLevel * 1000) / 1000;
  }
  return out;
}

function queueCapacity(vipLevel = 0) {
  const v = Number(vipLevel) || 0;
  return 3 + (v >= 3 ? 5 : v === 2 ? 3 : v === 1 ? 2 : 0);
}

function dailyLimit(vipLevel = 0) {
  return DAILY_LIMIT + (Number(vipLevel) > 0 ? VIP_DAILY_BONUS : 0);
}

function acceleratedEnd(endsAt, minutes, now = new Date()) {
  return new Date(Math.max(now.getTime(), new Date(endsAt).getTime() - minutes * 60000));
}

/** 技能熟练度训练：维度升级（或手册加熟练度经验） */
function masteryTrain(current, dimension, { manual = false } = {}) {
  const cur = { power: 0, accuracy: 0, critical_chance: 0, mastery_exp: 0, ...current };
  const next = { ...cur };
  if (manual) {
    next.mastery_exp = Math.min(100, cur.mastery_exp + MASTERY_MANUAL_EXP);
  } else {
    const d = MASTERY[dimension];
    if (!d) throw new Error(`未知的熟练度维度 ${dimension}`);
    if (cur[dimension] >= d.maxLevel) return { ...next, maxed: true };
    next[dimension] = cur[dimension] + 1;
    next.mastery_exp = Math.min(100, cur.mastery_exp + MASTERY_EXP_PER_TRAIN);
  }
  const unlocked = EFFECT_THRESHOLDS.filter((t) => cur.mastery_exp < t.exp && next.mastery_exp >= t.exp).map((t) => t.effect);
  return { ...next, maxed: false, unlockedEffects: unlocked };
}

function masteryBonuses(m = {}) {
  return {
    powerPct: Math.round((Number(m.power) || 0) * MASTERY.power.perLevel * 1000) / 1000,
    accuracyPct: Math.round((Number(m.accuracy) || 0) * MASTERY.accuracy.perLevel * 1000) / 1000,
    critPct: Math.round((Number(m.critical_chance) || 0) * MASTERY.critical_chance.perLevel * 1000) / 1000,
    effects: EFFECT_THRESHOLDS.filter((t) => (Number(m.mastery_exp) || 0) >= t.exp).map((t) => t.effect),
  };
}

/** 新达成的成就 */
function newAchievements(stats, achieved = new Set()) {
  return ACHIEVEMENTS.filter((a) => !achieved.has(a.id) && a.test(stats));
}

module.exports = {
  POINTS_PER_LEVEL, SESSION_MINUTES, COOLDOWN_MINUTES, ATTRIBUTES, FACILITIES, ACCELERATORS, MASTERY, EFFECT_THRESHOLDS, ACHIEVEMENTS,
  levelOf, facilityMultiplier, plan, resolve, applyPoints, attributeBonuses, queueCapacity, dailyLimit, acceleratedEnd,
  masteryTrain, masteryBonuses, newAchievements,
};
