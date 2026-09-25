/**
 * E07 精灵成长：传承规则（传承率、传承石、合并、衰减、IV 上限、CP 加成）单元测试
 *   node --test tests/unit/growth-inheritance.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../shared/inheritanceRules');
const { baseCp } = require('../../shared/pokemonStats');

test('亲密度等级与基础传承率分档', () => {
  assert.equal(rules.friendshipLevel(0), 1);
  assert.equal(rules.friendshipLevel(70), 14);
  assert.equal(rules.friendshipLevel(255), 50);
  assert.deepEqual([1, 10, 11, 20, 21, 30, 31, 40, 41, 50].map(rules.baseRate), [0.05, 0.05, 0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.5, 0.5]);
});

test('放生生成传承池：IV 为池值、CP 10%、传承石加成（上限 80%）、完美传承石 100%', () => {
  const p = { iv_attack: 15, iv_defense: 12, iv_hp: 9, cp: 1234, friendship: 255, level: 20 };
  const plain = rules.poolFromPokemon(p);
  assert.deepEqual({ a: plain.iv_attack_bonus, d: plain.iv_defense_bonus, h: plain.iv_hp_bonus, cp: plain.cp_base_bonus, r: plain.inheritance_rate, t: plain.inheritance_type },
    { a: 15, d: 12, h: 9, cp: 123, r: 0.5, t: 'normal' });
  assert.equal(rules.poolFromPokemon(p, 'LEGACY_STONE_NORMAL').inheritance_rate, 0.6);
  assert.equal(rules.poolFromPokemon(p, 'LEGACY_STONE_ADVANCED').inheritance_rate, 0.7);
  assert.equal(rules.poolFromPokemon({ ...p, friendship: 255 }, 'LEGACY_STONE_ADVANCED').inheritance_type, 'enhanced');
  const perfect = rules.poolFromPokemon({ ...p, friendship: 10 }, 'LEGACY_STONE_PERFECT');
  assert.equal(perfect.inheritance_rate, 1);
  assert.equal(perfect.inheritance_type, 'perfect');
  assert.equal(rules.poolFromPokemon({ ...p, friendship: 255 }, 'LEGACY_STONE_ADVANCED').inheritance_rate <= rules.MAX_RATE, true);
  assert.throws(() => rules.poolFromPokemon(p, 'ROCK'), /不是传承道具/);
});

test('同家族再次放生逐项取大', () => {
  const m = rules.mergePool(
    { iv_attack_bonus: '15', iv_defense_bonus: '3', iv_hp_bonus: '8', cp_base_bonus: 50, inheritance_rate: '0.5', inheritance_type: 'normal' },
    { iv_attack_bonus: 10, iv_defense_bonus: 14, iv_hp_bonus: 8, cp_base_bonus: 80, inheritance_rate: 0.6, inheritance_type: 'enhanced' });
  assert.deepEqual([m.iv_attack_bonus, m.iv_defense_bonus, m.iv_hp_bonus, m.cp_base_bonus, m.inheritance_rate, m.inheritance_type], [15, 14, 8, 80, 0.6, 'enhanced']);
  assert.equal(rules.mergePool(null, { a: 1 }).a, 1);
});

test('捕捉时加成：按传承率与线性衰减，IV 上限 15，30 天过期', () => {
  const now = new Date('2026-09-25T00:00:00Z');
  const pool = { iv_attack_bonus: 15, iv_defense_bonus: 10, iv_hp_bonus: 4, cp_base_bonus: 200, inheritance_rate: 0.5, refreshed_at: now };
  assert.deepEqual(rules.inheritanceBonus(pool, now), { ivAttack: 8, ivDefense: 5, ivHp: 2, cpBonus: 100, rate: 0.5, decay: 1 });
  const d15 = rules.inheritanceBonus(pool, new Date('2026-10-10T00:00:00Z'));
  assert.equal(d15.decay, 0.5);
  assert.deepEqual([d15.ivAttack, d15.cpBonus], [4, 50]);
  assert.deepEqual(rules.inheritanceBonus(pool, new Date('2026-10-26T00:00:00Z')), { ivAttack: 0, ivDefense: 0, ivHp: 0, cpBonus: 0, rate: 0, decay: 0 });
  assert.deepEqual(rules.applyBonus({ attack: 12, defense: 3, hp: 15 }, { ivAttack: 8, ivDefense: 5, ivHp: 2 }), { attack: 15, defense: 8, hp: 15 });
  const perfect = rules.inheritanceBonus({ ...pool, inheritance_rate: 1 }, now);
  assert.equal(perfect.ivAttack, 15, '完美传承全部属性');
});

test('CP 随 IV 提升按比例变化（与刷怪公式一致）', () => {
  const sp = { base_attack: 118, base_defense: 111, base_hp: 128 };
  assert.ok(baseCp(sp, { attack: 15, defense: 15, hp: 15 }) > baseCp(sp, { attack: 0, defense: 0, hp: 0 }));
  assert.equal(baseCp(sp, { iv_attack: 10, iv_defense: 10, iv_hp: 10 }), Math.floor((128 * Math.sqrt(121) * Math.sqrt(138)) / 10));
});
