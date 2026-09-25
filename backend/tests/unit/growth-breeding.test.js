/**
 * E07 精灵成长：培育与遗传规则（配对、后代物种、IV 显隐性遗传、变异、技能/闪光、培育时间、孵化进度）单元测试
 *   node --test tests/unit/growth-breeding.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/breedingRules');

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const mon = (id, groups, familyRoot, extra = {}) => ({ id, groups, familyRoot, iv_attack: 10, iv_defense: 10, iv_hp: 10, ...extra });

test('配对规则：蛋组交集、未发现组、百变怪、同家族兜底', () => {
  assert.equal(rules.compatibility(mon('a', [1, 5], 1), mon('b', [1, 9], 4)).ok, true);
  assert.deepEqual(rules.compatibility(mon('a', [1, 5], 1), mon('b', [1, 9], 4)).sharedGroups, [1]);
  assert.equal(rules.compatibility(mon('a', [4], 39), mon('b', [7], 74)).ok, false);
  assert.equal(rules.compatibility(mon('a', [12], 150), mon('b', [13], 132)).ok, false, '未发现组不能培育');
  assert.equal(rules.compatibility(mon('a', [7], 74), mon('b', [13], 132)).reason, 'ditto');
  assert.equal(rules.compatibility(mon('a', [13], 132), mon('b', [13], 132)).ok, false, '两只百变怪不行');
  assert.equal(rules.compatibility(mon('a', [], 1), mon('b', [], 1)).ok, true, '未配蛋组时同家族可配');
  assert.equal(rules.compatibility(mon('a', [], 1), mon('b', [], 4)).ok, false);
  assert.equal(rules.compatibility(mon('a', [1], 1), mon('a', [1], 1)).ok, false, '不能与自己配对');
});

test('后代物种为母方（非百变怪一方）的家族根', () => {
  assert.equal(rules.offspringSpecies(mon('m', [1, 5], 1), mon('f', [1, 9], 4)), 1);
  assert.equal(rules.offspringSpecies(mon('m', [13], 132), mon('f', [11], 133)), 133);
});

test('IV 遗传：遗传→显性取高值；遗传→隐性随机一方；不遗传→随机', () => {
  const mother = { iv_attack: 15, iv_defense: 3, iv_hp: 8 };
  const father = { iv_attack: 2, iv_defense: 12, iv_hp: 8 };
  // 攻击：遗传(0.1<0.5) 显性(0.1<0.6)→15 母；防御：遗传 隐性(0.9) 取母(0.2<0.5)→3；HP：不遗传(0.7) 随机 0.5→8；无变异(0.9)；技能不继承；不闪光
  const g = rules.inheritGenes(mother, father, { rand: seq(0.1, 0.1, 0.1, 0.9, 0.2, 0.7, 0.5, 0.9, 0.9) });
  assert.deepEqual(g.ivs.attack, { value: 15, from: 'mother', expression: 'dominant' });
  assert.deepEqual(g.ivs.defense, { value: 3, from: 'mother', expression: 'recessive' });
  assert.deepEqual(g.ivs.hp, { value: 8, from: 'random', expression: 'random' });
  assert.equal(g.mutation, null);
  assert.equal(g.inheritanceRate, 0.5);
  assert.equal(rules.inheritGenes(mother, father, { destinyKnot: true, rand: seq(0.99) }).inheritanceRate, 0.8);
});

test('命运红线提高遗传率（统计）', () => {
  let rnd = 42;
  const lcg = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  const count = (knot) => {
    let inherited = 0;
    for (let i = 0; i < 2000; i++) {
      const g = rules.inheritGenes({ iv_attack: 15, iv_defense: 15, iv_hp: 15 }, { iv_attack: 15, iv_defense: 15, iv_hp: 15 }, { destinyKnot: knot, rand: lcg });
      inherited += rules.IV_KEYS.filter((k) => g.ivs[k].from !== 'random').length;
    }
    return inherited / 6000;
  };
  const base = count(false);
  const knot = count(true);
  assert.ok(base > 0.45 && base < 0.55, `base=${base}`);
  assert.ok(knot > 0.75 && knot < 0.85, `knot=${knot}`);
});

test('变异：随机一项 +3（上限 15）', () => {
  // 三项都不遗传随机 0.5→8；变异 0.01<0.05，选第 2 项(0.5→index 1)
  const g = rules.inheritGenes({ iv_attack: 0, iv_defense: 0, iv_hp: 0 }, { iv_attack: 0, iv_defense: 0, iv_hp: 0 }, { rand: seq(0.9, 0.5, 0.9, 0.5, 0.9, 0.5, 0.01, 0.5, 0.9, 0.9, 0.9) });
  assert.deepEqual(g.mutation, { stat: 'defense', before: 8, after: 11 });
  assert.equal(g.ivs.defense.mutated, true);
});

test('技能遗传只继承后代可学的招式；闪光父母提升闪光率', () => {
  const m = { iv_attack: 1, iv_defense: 1, iv_hp: 1, fast_move: 'VINE_WHIP', charge_move: 'HYPER_BEAM', is_shiny: true };
  const f = { iv_attack: 1, iv_defense: 1, iv_hp: 1, fast_move: 'TACKLE', charge_move: 'SLUDGE_BOMB' };
  const g = rules.inheritGenes(m, f, { learnset: ['VINE_WHIP', 'SLUDGE_BOMB'], rand: seq(0.9, 0.5, 0.9, 0.5, 0.9, 0.5, 0.9, 0.1, 0.0, 0.1, 0.0, 0.001) });
  assert.deepEqual(g.moves.fast, { move: 'VINE_WHIP', inherited: true });
  assert.deepEqual(g.moves.charge, { move: 'SLUDGE_BOMB', inherited: true }, 'HYPER_BEAM 不在可学表中');
  assert.equal(g.shinyRate, 1 / 64);
  assert.equal(g.shiny, true);
});

test('培育时间随稀有度与父母 IV、费用、孵化距离与进度', () => {
  const zero = { iv_attack: 0, iv_defense: 0, iv_hp: 0 };
  const perfect = { iv_attack: 15, iv_defense: 15, iv_hp: 15 };
  assert.equal(rules.breedingMinutes('COMMON', [zero, zero]), 30);
  assert.equal(rules.breedingMinutes('COMMON', [perfect, perfect]), 45);
  assert.equal(rules.breedingMinutes('RARE', [perfect, zero]), Math.round(30 * 2 * 1.25));
  assert.deepEqual(rules.breedingCost('EPIC'), { stardust: 1500 });
  assert.equal(rules.hatchKm('RARE'), 7);
  assert.deepEqual(rules.hatchProgress({ required_km: 2, distance_start_km: null }, 10), { walkedKm: 0, requiredKm: 2, percent: 0, ready: false, incubating: false });
  const p = rules.hatchProgress({ required_km: 5, distance_start_km: 10, speed_multiplier: 2 }, 12);
  assert.deepEqual(p, { walkedKm: 4, requiredKm: 5, percent: 80, ready: false, incubating: true });
  assert.equal(rules.hatchProgress({ required_km: 5, distance_start_km: 10, speed_multiplier: 2 }, 12.5).ready, true);
});
