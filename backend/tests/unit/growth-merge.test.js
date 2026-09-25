/**
 * E07 精灵成长：合并进化规则（选择校验、成功率、变异、产出属性、可用性）单元测试
 *   node --test tests/unit/growth-merge.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/mergeRules');

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const recipe = { required_pokemon: [{ species_id: 1, min_level: 5, count: 3 }], base_success_rate: 70, variant_rate: 5, output_min_level: 10, output_level_variance: 5 };
const bulb = (id, extra = {}) => ({ id, species_id: 1, level: 5, iv_attack: 9, iv_defense: 9, iv_hp: 9, ...extra });

test('选择校验：数量、物种、等级、收藏/锁定/忙碌、重复', () => {
  assert.deepEqual(rules.validateSelection(recipe, [bulb('a'), bulb('b'), bulb('c')]), { ok: true, errors: [] });
  assert.match(rules.validateSelection(recipe, [bulb('a'), bulb('b')]).errors.join(), /需要 3 只/);
  assert.match(rules.validateSelection(recipe, [bulb('a'), bulb('b'), bulb('c', { level: 4 })]).errors.join(), /等级 ≥ 5/);
  assert.match(rules.validateSelection(recipe, [bulb('a'), bulb('b'), bulb('c', { species_id: 4 })]).errors.join(), /不需要的物种/);
  assert.match(rules.validateSelection(recipe, [bulb('a'), bulb('b'), bulb('c', { is_favorite: true })]).errors.join(), /已收藏/);
  assert.match(rules.validateSelection(recipe, [bulb('a'), bulb('b'), bulb('c', { is_locked: true })]).errors.join(), /已锁定/);
  assert.match(rules.validateSelection(recipe, [bulb('a'), bulb('b'), bulb('c', { occupied_by: 'breeding' })]).errors.join(), /忙碌/);
  assert.match(rules.validateSelection(recipe, [bulb('a'), bulb('a'), bulb('c')]).errors.join(), /重复/);
});

test('成功率：基础 + 品质 + 等级（≤10）+ 幸运符，上限 95', () => {
  const r = rules.successRate(recipe, [bulb('a'), bulb('b'), bulb('c')]);
  assert.deepEqual(r, { base: 70, quality: 6, level: 0, lucky: 0, total: 76 });
  const hi = rules.successRate(recipe, [bulb('a', { level: 30, iv_attack: 15, iv_defense: 15, iv_hp: 15 }), bulb('b', { level: 30 }), bulb('c', { level: 30 })], { luckyCharm: true });
  assert.equal(hi.level, 10);
  assert.equal(hi.lucky, 15);
  assert.equal(hi.total, 95, '上限 95%');
});

test('成功/变异判定与产出属性', () => {
  assert.deepEqual(rules.roll(76, 5, seq(0.5, 0.01)), { success: true, variant: true });
  assert.deepEqual(rules.roll(76, 5, seq(0.5, 0.9)), { success: true, variant: false });
  assert.deepEqual(rules.roll(76, 5, seq(0.8)), { success: false, variant: false });
  assert.deepEqual(rules.roll(76, 0, seq(0.1, 0.0)), { success: true, variant: false }, '无变异配置');
  const out = rules.outputStats(recipe, [bulb('a', { iv_attack: 15 }), bulb('b', { iv_attack: 14 }), bulb('c', { iv_attack: 15, iv_hp: 2 })], seq(0.99));
  assert.deepEqual(out, { level: 15, ivs: { attack: 15, defense: 10, hp: 8 } });
  assert.equal(rules.outputStats(recipe, [bulb('a')], seq(0)).level, 10);
});

test('配方可用性：训练师等级解锁、精灵数量', () => {
  const birds = { required_pokemon: [{ species_id: 144, count: 1 }, { species_id: 145, count: 1 }], unlock_conditions: { trainer_level: 30 } };
  const a = rules.availability(birds, { 144: 1 }, 10);
  assert.equal(a.locked, true);
  assert.deepEqual(a.missing, [{ speciesId: 145, need: 1, have: 0 }]);
  assert.equal(rules.availability(birds, { 144: 1, 145: 2 }, 30).ready, true);
});
