/**
 * 训练营规则（REQ-00370，纯函数）
 *
 * - 三类训练营：experience（经验）、skill（学技能）、friendship（亲密度）；每营独立等级与槽位容量
 * - 课程费用：free / gold(=users.coins) / stardust / premium(=users.premium_coins)，开始时扣除，取消不退
 * - 奖励 = 基础 + 每级加成 ×（训练营等级 − 1），再乘评级倍率；评级由开始训练时（扣除训练体力后）的疲劳等级决定：
 *   fresh→excellent ×1.2、normal→good ×1.1、tired→normal ×1.0、exhausted→poor ×0.8（体力系统联动，结果确定可验证）
 * - 加速道具：TRAINING_TIMER_HALF 剩余时间减半、TRAINING_TIMER_INSTANT 立即完成、TRAINING_EXP_DOUBLE 经验翻倍（每个槽位各限一次）
 * - 升级费用：1000 × 2^当前等级 金币；满级 max_level
 */
'use strict';

const COST_CURRENCY = Object.freeze({ gold: 'coins', coins: 'coins', stardust: 'stardust', premium: 'premium_coins' });

const RATINGS = Object.freeze({
  fresh: { rating: 'excellent', multiplier: 1.2 },
  normal: { rating: 'good', multiplier: 1.1 },
  tired: { rating: 'normal', multiplier: 1.0 },
  exhausted: { rating: 'poor', multiplier: 0.8 },
});

const BOOSTS = Object.freeze({
  TRAINING_TIMER_HALF: { kind: 'time', factor: 0.5, name: '剩余时间减半' },
  TRAINING_TIMER_INSTANT: { kind: 'time', factor: 0, name: '立即完成' },
  TRAINING_EXP_DOUBLE: { kind: 'exp', factor: 2, name: '经验翻倍' },
});

function costOf(course) {
  const type = String(course.cost_type || 'free');
  if (type === 'free' || !(Number(course.cost_amount) > 0)) return null;
  const currency = COST_CURRENCY[type];
  if (!currency) throw new Error(`未知的费用类型 ${type}`);
  return { currency, amount: Number(course.cost_amount) };
}

function ratingFor(fatigueLevel) {
  return RATINGS[fatigueLevel] || RATINGS.normal;
}

/** 预期奖励（开始训练时锁定） */
function expectedRewards(course, campLevel, ratingMultiplier = 1) {
  const lv = Math.max(1, Number(campLevel) || 1) - 1;
  const exp = (Number(course.exp_reward) || 0) + (Number(course.exp_reward_per_level) || 0) * lv;
  const friendship = (Number(course.friendship_reward) || 0) + (Number(course.friendship_reward_per_level) || 0) * lv;
  return {
    exp: Math.floor(exp * ratingMultiplier),
    friendship: Math.floor(friendship * ratingMultiplier),
  };
}

function progress(startedAt, endsAt, now = new Date()) {
  const s = new Date(startedAt).getTime();
  const e = new Date(endsAt).getTime();
  const n = now.getTime();
  const pct = e > s ? Math.min(100, Math.max(0, ((n - s) / (e - s)) * 100)) : 100;
  return { percent: Math.round(pct * 100) / 100, remainingMinutes: Math.max(0, Math.ceil((e - n) / 60000)), ready: n >= e };
}

/** 使用加速道具后的新结束时间 */
function boostedEnd(endsAt, boost, now = new Date()) {
  if (boost.kind !== 'time') return new Date(endsAt);
  const remain = Math.max(0, new Date(endsAt).getTime() - now.getTime());
  return new Date(now.getTime() + Math.floor(remain * boost.factor));
}

function upgradeCost(level) {
  return 1000 * 2 ** Math.max(1, Number(level) || 1);
}

/** 课程是否可用于该精灵/训练营 */
function courseCheck(course, { campLevel, pokemonLevel }) {
  if (Number(campLevel) < Number(course.required_camp_level || 1)) return `需要训练营等级 ${course.required_camp_level}`;
  if (course.min_pokemon_level && Number(pokemonLevel) < Number(course.min_pokemon_level)) return `精灵等级需 ≥ ${course.min_pokemon_level}`;
  if (course.max_pokemon_level && Number(pokemonLevel) > Number(course.max_pokemon_level)) return `精灵等级需 ≤ ${course.max_pokemon_level}`;
  return null;
}

/** 技能营：从可学技能中挑一个还没学会的（按招式 ID 排序后取随机数对应的那个，便于测试注入） */
function pickNewMove(learnset, learnedFast = [], learnedCharge = [], rand = Math.random()) {
  const known = new Set([...(learnedFast || []), ...(learnedCharge || [])]);
  const candidates = learnset.filter((m) => !known.has(m.move_id)).sort((a, b) => String(a.move_id).localeCompare(String(b.move_id)));
  if (!candidates.length) return null;
  return candidates[Math.min(candidates.length - 1, Math.floor(rand * candidates.length))];
}

module.exports = { COST_CURRENCY, RATINGS, BOOSTS, costOf, ratingFor, expectedRewards, progress, boostedEnd, upgradeCost, courseCheck, pickNewMove };
