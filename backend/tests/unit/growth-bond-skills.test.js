/**
 * E07 精灵成长：羁绊技能规则（解锁、安全公式求值、威力随亲密度）单元测试
 *   node --test tests/unit/growth-bond-skills.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/bondSkillRules');

const def = (slot, power, formula, extra = {}) => ({ id: slot, slot, skill_name: `s${slot}`, type: 'electric', power, pp: 10,
  unlock_friendship_level: rules.SLOT_THRESHOLDS[slot], friendship_bonus_formula: formula, ...extra });

test('羁绊等级 = 亲密度×100/255，槽位 20/50/90 解锁', () => {
  assert.equal(rules.bondLevel(0), 0);
  assert.equal(rules.bondLevel(51), 20);
  assert.equal(rules.bondLevel(255), 100);
  assert.equal(rules.bondLevel(999), 100);
  assert.equal(rules.friendshipForBondLevel(20), 51);
  assert.equal(rules.friendshipForBondLevel(50), 128);
  assert.equal(rules.friendshipForBondLevel(90), 230);

  const s1 = def(1, 65, null);
  const s2 = def(2, 0, null);
  const s3 = def(3, 120, null);
  assert.equal(rules.skillStatus(s1, 50, null).isUnlocked, false, '羁绊等级 19 不能学 1 槽');
  assert.equal(rules.skillStatus(s1, 51, null).isUnlocked, true, '羁绊等级 20 可学 1 槽');
  assert.equal(rules.skillStatus(s2, 127, null).isUnlocked, false);
  assert.equal(rules.skillStatus(s2, 128, null).isUnlocked, true, '羁绊等级 50 可学 2 槽');
  assert.equal(rules.skillStatus(s3, 229, null).isUnlocked, false);
  assert.equal(rules.skillStatus(s3, 230, null).isUnlocked, true, '羁绊等级 90 可学 3 槽');
  assert.equal(rules.skillStatus(s3, 200, null).friendshipGap, 30);
});

test('安全表达式求值：四则、括号、函数、变量；拒绝未知标识符', () => {
  const v = { friendship: 200, bond_level: 78 };
  assert.equal(rules.evaluate('65 + floor(friendship * 0.5)', v), 165);
  assert.equal(rules.evaluate('(1 + 2) * 3 - 4 / 2', v), 7);
  assert.equal(rules.evaluate('max(10, min(bond_level, 50))', v), 50);
  assert.equal(rules.evaluate('-5 + 10', v), 5);
  assert.equal(rules.evaluate('true', v), true);
  assert.throws(() => rules.evaluate('process.exit(1)', v), /未知变量|语法/);
  assert.throws(() => rules.evaluate('friendship; 1', v), /语法/);
  assert.throws(() => rules.evaluate('constructor', v), /未知变量/);
  assert.deepEqual(rules.splitTop('120, crit_bonus: max(1, friendship / 255)'), ['120', 'crit_bonus: max(1, friendship / 255)']);
});

test('威力随亲密度提升；附加效果与辅助技能效果值', () => {
  const zap = def(1, 65, '65 + floor(friendship * 0.5)');
  assert.equal(rules.computeEffect(zap, 0).power, 65);
  assert.equal(rules.computeEffect(zap, 100).power, 115);
  assert.equal(rules.computeEffect(zap, 255).power, 192);

  const shield = def(2, 0, 'floor(friendship * 10)', { effect_type: 'shield' });
  const e = rules.computeEffect(shield, 128);
  assert.equal(e.power, 0);
  assert.equal(e.effectValue, 1280);
  assert.equal(e.effectType, 'shield');

  const bolt = def(3, 120, '120, crit_bonus: friendship / 255');
  const b = rules.computeEffect(bolt, 255);
  assert.equal(b.power, 120);
  assert.equal(b.additionalEffects.crit_bonus, 1);
  const storm = rules.computeEffect(def(3, 150, '150, ignore_resistance: true'), 230);
  assert.equal(storm.additionalEffects.ignore_resistance, true);
  const guard = rules.computeEffect(def(2, 0, 'shield_hp: floor(friendship * 8)'), 100);
  assert.equal(guard.additionalEffects.shield_hp, 800);
  assert.equal(guard.effectValue, null);
  assert.equal(rules.computeEffect(def(1, 50, null), 200).power, 50, '无公式时为基础威力');
});
