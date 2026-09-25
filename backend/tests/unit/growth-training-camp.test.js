/**
 * E07 精灵成长：训练营规则单元测试
 *   node --test tests/unit/growth-training-camp.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/trainingCampRules');

const course = (extra) => ({ id: 1, exp_reward: 300, exp_reward_per_level: 50, friendship_reward: 15, friendship_reward_per_level: 3,
  required_camp_level: 2, cost_type: 'gold', cost_amount: 500, duration_minutes: 60, ...extra });

test('费用：gold→coins、premium→premium_coins、free 无费用', () => {
  assert.deepEqual(rules.costOf(course()), { currency: 'coins', amount: 500 });
  assert.deepEqual(rules.costOf(course({ cost_type: 'premium', cost_amount: 50 })), { currency: 'premium_coins', amount: 50 });
  assert.deepEqual(rules.costOf(course({ cost_type: 'stardust', cost_amount: 400 })), { currency: 'stardust', amount: 400 });
  assert.equal(rules.costOf(course({ cost_type: 'free', cost_amount: 0 })), null);
  assert.throws(() => rules.costOf(course({ cost_type: 'diamonds' })), /未知的费用类型/);
});

test('奖励随训练营等级与评级（由疲劳等级决定）', () => {
  assert.deepEqual(rules.expectedRewards(course(), 1, 1), { exp: 300, friendship: 15 });
  assert.deepEqual(rules.expectedRewards(course(), 3, 1), { exp: 400, friendship: 21 });
  assert.deepEqual(rules.ratingFor('fresh'), { rating: 'excellent', multiplier: 1.2 });
  assert.deepEqual(rules.ratingFor('exhausted'), { rating: 'poor', multiplier: 0.8 });
  assert.deepEqual(rules.expectedRewards(course(), 1, rules.ratingFor('fresh').multiplier), { exp: 360, friendship: 18 });
  assert.equal(rules.ratingFor('unknown').rating, 'good');
});

test('进度精确到分钟、加速道具', () => {
  const start = new Date('2026-09-25T10:00:00Z');
  const end = new Date('2026-09-25T11:00:00Z');
  assert.deepEqual(rules.progress(start, end, new Date('2026-09-25T10:15:00Z')), { percent: 25, remainingMinutes: 45, ready: false });
  assert.deepEqual(rules.progress(start, end, new Date('2026-09-25T11:00:00Z')), { percent: 100, remainingMinutes: 0, ready: true });
  assert.equal(rules.progress(start, end, new Date('2026-09-25T10:59:01Z')).remainingMinutes, 1, '不足一分钟按一分钟');
  const now = new Date('2026-09-25T10:20:00Z');
  assert.equal(rules.boostedEnd(end, rules.BOOSTS.TRAINING_TIMER_HALF, now).toISOString(), '2026-09-25T10:40:00.000Z');
  assert.equal(rules.boostedEnd(end, rules.BOOSTS.TRAINING_TIMER_INSTANT, now).toISOString(), now.toISOString());
  assert.equal(rules.boostedEnd(end, rules.BOOSTS.TRAINING_EXP_DOUBLE, now).toISOString(), end.toISOString(), '经验券不改时间');
});

test('课程可用性与升级费用', () => {
  assert.match(rules.courseCheck(course(), { campLevel: 1, pokemonLevel: 5 }), /训练营等级 2/);
  assert.equal(rules.courseCheck(course(), { campLevel: 2, pokemonLevel: 5 }), null);
  assert.match(rules.courseCheck(course({ max_pokemon_level: 10 }), { campLevel: 5, pokemonLevel: 11 }), /≤ 10/);
  assert.match(rules.courseCheck(course({ min_pokemon_level: 20 }), { campLevel: 5, pokemonLevel: 11 }), /≥ 20/);
  assert.equal(rules.upgradeCost(1), 2000);
  assert.equal(rules.upgradeCost(3), 8000);
});

test('技能营：只学还没学会的招式', () => {
  const learnset = [{ move_id: 'TACKLE' }, { move_id: 'VINE_WHIP' }, { move_id: 'SOLAR_BEAM' }];
  assert.equal(rules.pickNewMove(learnset, ['TACKLE'], ['SOLAR_BEAM'], 0.99).move_id, 'VINE_WHIP');
  assert.equal(rules.pickNewMove(learnset, ['TACKLE', 'VINE_WHIP'], ['SOLAR_BEAM']), null);
  assert.equal(rules.pickNewMove(learnset, null, null, 0).move_id, 'SOLAR_BEAM', '按招式 ID 排序后取第一个');
});
