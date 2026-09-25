/**
 * E07 精灵成长：觉醒规则（条件、权重抽取、保底、加成、CP 同步、重洗费用）与战斗档案合成单元测试
 *   node --test tests/unit/growth-awakening.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/awakeningRules');
const { combine } = require('../../services/pokemon-service/src/growth/battleStats');

/** 可复现的伪随机序列 */
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('阶段配置：默认 5 阶段，按物种覆盖非空字段', () => {
  assert.equal(rules.stageConfig(1).required_level, 20);
  assert.equal(rules.stageConfig(6), null);
  const o = rules.stageConfig(1, { required_level: 15, candy: null });
  assert.equal(o.required_level, 15);
  assert.equal(o.candy, 50, 'NULL 字段沿用默认');
  assert.equal(rules.stageConfig(3).skill_unlock, true);
});

test('条件检查：等级/亲密度/材料/糖果/星尘逐项给出满足状态', () => {
  const cfg = rules.stageConfig(2);
  const ok = rules.checkRequirements(cfg, { level: 30, friendship: 180, items: { AWAKENING_SHARD: 20, AWAKENING_STONE: 1 }, candy: 100, stardust: 10000 });
  assert.equal(ok.met, true);
  const bad = rules.checkRequirements(cfg, { level: 29, friendship: 200, items: { AWAKENING_SHARD: 25 }, candy: 100, stardust: 0 });
  assert.equal(bad.met, false);
  assert.deepEqual(bad.checks.filter((c) => !c.met).map((c) => c.type), ['level', 'item:AWAKENING_STONE', 'stardust']);
});

test('潜能数量：保底 + 每个额外名额 30%，不超过上限', () => {
  const cfg = { guaranteed_potentials: 1, max_potentials: 3 };
  assert.equal(rules.rollCount(cfg, seq(0.99)), 1);
  assert.equal(rules.rollCount(cfg, seq(0.1, 0.99)), 2);
  assert.equal(rules.rollCount(cfg, seq(0.1, 0.1, 0.1)), 3);
  assert.equal(rules.rollCount({ guaranteed_potentials: 2, max_potentials: 2 }, seq(0)), 2);
});

test('按权重抽取且不重复；权重 0 不会被抽到', () => {
  const pool = [{ id: 1, weight: 100 }, { id: 2, weight: 100 }, { id: 3, weight: 0 }, { id: 4, weight: 50 }];
  const drawn = rules.drawPotentials(pool, 3, seq(0.0, 0.0, 0.0));
  assert.deepEqual(drawn.map((p) => p.id), [1, 2, 4]);
  assert.equal(new Set(drawn.map((p) => p.id)).size, 3);
  assert.equal(rules.drawPotentials(pool, 10, seq(0.5)).length, 3, '可抽的只有 3 个');
  // 统计：权重 100:50 → 约 2:1
  let a = 0; let rnd = 12345;
  const lcg = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  for (let i = 0; i < 3000; i++) if (rules.drawPotentials([{ id: 'a', weight: 100 }, { id: 'b', weight: 50 }], 1, lcg)[0].id === 'a') a++;
  assert.ok(a > 1800 && a < 2200, `a=${a}`);
});

test('加成累加与 CP 倍率、重洗费用递增、觉醒技能', () => {
  const stages = [
    { activated_potentials: [{ effect_config: { stat: 'attackPct', value: 0.05 } }, { effect_config: { stat: 'critRate', value: 0.03 } }] },
    { activated_potentials: [{ effect_config: { stat: 'attackPct', value: 0.1 } }, { effect_config: { effect: 'aura_heal', value: 0.03 } }] },
  ];
  const b = rules.sumBonuses(stages);
  assert.equal(b.attackPct, 0.15);
  assert.equal(b.critRate, 0.03);
  assert.equal(rules.cpFactor({}), 1);
  assert.ok(Math.abs(rules.cpFactor({ attackPct: 0.1, defensePct: 0.21, hpPct: 0 }) - 1.1 * 1.1) < 1e-9);
  assert.deepEqual(rules.rerollCost(0), { items: [{ item_id: 'AWAKENING_ESSENCE', count: 1 }], stardust: 1000 });
  assert.deepEqual(rules.rerollCost(2), { items: [{ item_id: 'AWAKENING_ESSENCE', count: 3 }], stardust: 3000 });
  assert.equal(rules.awakeningSkill(2, 'FIRE'), null);
  assert.equal(rules.awakeningSkill(3, 'FIRE').power, 120);
  assert.equal(rules.awakeningSkill(5, 'FIRE').power, 160);
  assert.equal(rules.AURAS[5], 'aura_rainbow');
});

test('战斗档案：觉醒/特训/等级/疲劳加成合成', () => {
  const species = { base_attack: 100, base_defense: 100, base_hp: 100 };
  const pokemon = { level: 1, iv_attack: 0, iv_defense: 0, iv_hp: 0 };
  const plain = combine({ pokemon, species });
  assert.deepEqual([plain.attack, plain.defense, plain.hp, plain.energyCap], [100, 100, 100, 100]);
  const s = combine({
    pokemon: { ...pokemon, level: 26 }, species,
    awakening: { attackPct: 0.1, hpPct: 0.2, critRate: 0.03 },
    training: { attackPct: 0.2, defensePct: 0.1, critRate: 0.05, dodgeRate: 0.03, energyCap: 20, speedPct: 0.1 },
    fatigue: { battleBonus: 0.85 },
  });
  assert.equal(s.attack, Math.round(100 * 1.5 * 1.1 * 1.2 * 0.85));
  assert.equal(s.defense, Math.round(100 * 1.5 * 1.1 * 0.85));
  assert.equal(s.hp, Math.round(100 * 1.5 * 1.2), 'HP 不受疲劳影响');
  assert.equal(s.critRate, 0.08);
  assert.equal(s.dodgeRate, 0.03);
  assert.equal(s.energyCap, 120);
  assert.equal(s.speedMultiplier, 0.935);
});
