/**
 * E07 精灵成长：专项特训规则（属性、场地、成功率、熟练度、队列、成就）单元测试
 *   node --test tests/unit/growth-special-training.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/specialTrainingRules');

test('特训计划：场地对口加成、费用、解锁条件、金苹果', () => {
  const basic = rules.plan('attack', 'basic', { trainerLevel: 1 });
  assert.deepEqual({ points: basic.points, coins: basic.cost.coins, item: basic.cost.item, candy: basic.cost.candy, locked: basic.locked },
    { points: 10, coins: 0, item: 'TRAIN_ENERGY_DRINK', candy: 100, locked: false });
  const gym = rules.plan('attack', 'strength_gym', { trainerLevel: 5 });
  assert.equal(gym.points, 15);
  assert.equal(gym.cost.coins, 500);
  assert.equal(rules.plan('defense', 'strength_gym', { trainerLevel: 5 }).points, 10, '非对口属性无加成');
  assert.equal(rules.plan('dodge', 'all_purpose_center', { trainerLevel: 30 }).points, 12, '综合训练中心全属性 ×1.2');
  assert.equal(rules.plan('critical', 'critical_dojo', { trainerLevel: 20 }).points, 20);
  const locked = rules.plan('attack', 'strength_gym', { trainerLevel: 4 });
  assert.equal(locked.locked, true);
  assert.match(locked.lockedReason, /训练师等级 5/);
  assert.equal(basic.successRate, 0.8);
  assert.equal(rules.plan('attack', 'basic', { goldenApple: true }).successRate, 1);
  assert.throws(() => rules.plan('charm', 'basic'), /未知的训练属性/);
  assert.throws(() => rules.plan('attack', 'moon'), /未知的训练场地/);
});

test('结算：成功全额、失败一半；属性等级上限', () => {
  assert.deepEqual(rules.resolve(15, 0.8, 0.5), { success: true, points: 15 });
  assert.deepEqual(rules.resolve(15, 0.8, 0.9), { success: false, points: 7 });
  assert.deepEqual(rules.resolve(15, 1, 0.9999), { success: true, points: 15 });
  const a = rules.applyPoints('attack', 5, 15);
  assert.deepEqual(a, { pointsBefore: 5, pointsAfter: 20, levelBefore: 0, levelAfter: 2, capped: false });
  const capped = rules.applyPoints('critical', 495, 20);
  assert.equal(capped.pointsAfter, 500);
  assert.equal(capped.levelAfter, 50);
  assert.equal(capped.capped, true);
  assert.equal(rules.levelOf('attack', 10_000), 100);
});

test('属性加成：攻防速每级 2%、暴击 0.5%、闪避 0.3%、能量 +5', () => {
  assert.deepEqual(rules.attributeBonuses({ attack: 25, defense: 10, speed: 0, critical: 10, dodge: 10, energy: 4 }),
    { attackPct: 0.5, defensePct: 0.2, speedPct: 0, critRate: 0.05, dodgeRate: 0.03, energyCap: 20 });
  assert.equal(rules.attributeBonuses({ attack: 999 }).attackPct, 2, '超过上限按上限');
});

test('队列与每日次数（VIP 扩容）、加速', () => {
  assert.equal(rules.queueCapacity(0), 3);
  assert.equal(rules.queueCapacity(1), 5);
  assert.equal(rules.queueCapacity(2), 6);
  assert.equal(rules.queueCapacity(3), 8);
  assert.equal(rules.dailyLimit(0), 10);
  assert.equal(rules.dailyLimit(2), 15);
  const now = new Date('2026-09-25T10:00:00Z');
  assert.equal(rules.acceleratedEnd(new Date('2026-09-25T10:50:00Z'), 60, now).toISOString(), now.toISOString(), '不早于现在');
  assert.equal(rules.acceleratedEnd(new Date('2026-09-25T12:00:00Z'), 60, now).toISOString(), '2026-09-25T11:00:00.000Z');
});

test('技能熟练度：维度升级、手册、特效解锁、满级', () => {
  const s1 = rules.masteryTrain({}, 'power');
  assert.equal(s1.power, 1);
  assert.equal(s1.mastery_exp, 5);
  assert.deepEqual(s1.unlockedEffects, []);
  const s2 = rules.masteryTrain({ power: 1, mastery_exp: 5 }, null, { manual: true });
  assert.equal(s2.mastery_exp, 25);
  assert.deepEqual(s2.unlockedEffects, ['概率追加状态异常', '提升异常触发概率']);
  assert.equal(rules.masteryTrain({ critical_chance: 5 }, 'critical_chance').maxed, true);
  assert.equal(rules.masteryTrain({ mastery_exp: 95 }, null, { manual: true }).mastery_exp, 100);
  assert.deepEqual(rules.masteryBonuses({ power: 4, accuracy: 5, critical_chance: 2, mastery_exp: 50 }),
    { powerPct: 0.2, accuracyPct: 0.1, critPct: 0.06, effects: ['概率追加状态异常', '提升异常触发概率', '追加属性下降效果'] });
  assert.throws(() => rules.masteryTrain({}, 'luck'), /未知的熟练度维度/);
});

test('训练成就：只返回新达成的', () => {
  const stats = { completedSessions: 1, levels: { attack: 50, defense: 30, speed: 30, critical: 30, dodge: 30, energy: 30 }, maxMasteryExp: 100, totalHours: 2 };
  assert.deepEqual(rules.newAchievements(stats).map((a) => a.id), ['first_training', 'attack_master', 'all_rounder', 'skill_expert']);
  assert.deepEqual(rules.newAchievements(stats, new Set(['first_training', 'attack_master'])).map((a) => a.id), ['all_rounder', 'skill_expert']);
  assert.deepEqual(rules.newAchievements({ completedSessions: 0, levels: {} }), []);
});
