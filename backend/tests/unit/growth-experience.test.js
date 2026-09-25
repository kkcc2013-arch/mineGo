/**
 * E07 精灵成长：经验公式（shared/ExperienceEngine.js）单元测试
 *   node --test tests/unit/growth-experience.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../../shared/ExperienceEngine');

test('成长曲线：1 级为 0、单调递增、各曲线快慢关系', () => {
  for (const rate of ['fast', 'medium_fast', 'medium_slow', 'slow', 'unknown']) {
    assert.equal(engine.expForLevel(1, rate), 0);
    let prev = 0;
    for (let l = 2; l <= 100; l++) {
      const v = engine.expForLevel(l, rate);
      assert.ok(v > prev, `${rate} L${l}`);
      prev = v;
    }
  }
  assert.equal(engine.expForLevel(10, 'medium_fast'), 1000);
  assert.equal(engine.expForLevel(10, 'fast'), 800);
  assert.equal(engine.expForLevel(10, 'slow'), 1250);
  assert.equal(engine.expForLevel(10, 'unknown'), 1000, '未知曲线按 medium_fast');
});

test('经验 → 等级，受训练师等级上限约束', () => {
  assert.equal(engine.levelFromExp(0), 1);
  assert.equal(engine.levelFromExp(999), 9);
  assert.equal(engine.levelFromExp(1000), 10);
  assert.equal(engine.levelFromExp(1_000_000), 100);
  assert.equal(engine.levelFromExp(1_000_000, 'medium_fast', 12), 12);
  assert.equal(engine.levelCap(1), 12);
  assert.equal(engine.levelCap(20), 50);
  assert.equal(engine.levelCap(50), 100);
  assert.equal(engine.maxExperience('medium_fast'), 1_000_000);
});

test('基础经验：等级差 +10%/级（最多 ×3）、稀有度系数', () => {
  assert.equal(engine.calculateBaseExperience({ baseExp: 100, rarity: 'COMMON', pokemonLevel: 10, opponentLevel: 10 }), 100);
  assert.equal(engine.calculateBaseExperience({ baseExp: 100, rarity: 'COMMON', pokemonLevel: 10, opponentLevel: 15 }), 150);
  assert.equal(engine.calculateBaseExperience({ baseExp: 100, rarity: 'COMMON', pokemonLevel: 20, opponentLevel: 5 }), 100, '对手更弱不减');
  assert.equal(engine.calculateBaseExperience({ baseExp: 100, rarity: 'COMMON', pokemonLevel: 1, opponentLevel: 90 }), 300, '上限 ×3');
  assert.equal(engine.calculateBaseExperience({ baseExp: 100, rarity: 'legendary' }), 300);
  assert.equal(engine.calculateBaseExperience({ baseExp: 100, rarity: 'EPIC', pokemonLevel: 1, opponentLevel: 6 }), 300);
  assert.equal(engine.catchBaseExperience({ rarity: 'RARE', trainerLevel: 11 }), 300);
  assert.equal(engine.catchBaseExperience({ rarity: 'COMMON', trainerLevel: 1 }), 100);
});

test('连击加成单调不减，最高 ×1.5', () => {
  assert.equal(engine.comboMultiplier(0), 1);
  assert.equal(engine.comboMultiplier(4), 1);
  assert.equal(engine.comboMultiplier(5), 1.1);
  assert.equal(engine.comboMultiplier(10), 1.25);
  assert.equal(engine.comboMultiplier(24), 1.25);
  assert.equal(engine.comboMultiplier(30), 1.3);
  assert.equal(engine.comboMultiplier(1000), 1.5);
  let prev = 0;
  for (let c = 0; c < 100; c++) { const m = engine.comboMultiplier(c); assert.ok(m >= prev, `combo ${c}`); prev = m; }
});

test('最终经验：各来源相乘（公会与个人 BUFF 叠加），疲劳降低', () => {
  const none = engine.calculateFinalExperience(1000, {});
  assert.deepEqual(none, { final: 1000, multiplier: 1, breakdown: [] });

  const all = engine.calculateFinalExperience(1000, {
    firstCatch: true, eventMultiplier: 1.5, luckyEgg: true, vip: true, guildBuff: 0.1, expCardMultiplier: 1.5,
  });
  // 2 × 1.5 × 2 × 1.5 × 1.25 × 1.1 = 12.375
  assert.equal(all.multiplier, 12.375);
  assert.equal(all.final, 12375);
  assert.deepEqual(all.breakdown.map((b) => b.source), ['first_catch', 'event', 'lucky_egg', 'exp_card', 'vip', 'guild']);

  const tired = engine.calculateFinalExperience(1000, { fatigueMultiplier: 0.8, combo: 12 });
  assert.equal(tired.final, 1000);
  assert.equal(engine.calculateFinalExperience(1000, { fatigueMultiplier: 0.8 }).final, 800);
});

test('经验转移按 80% 取整；等级倍率每级 +2%', () => {
  assert.equal(engine.transferAmount(1000), 800);
  assert.equal(engine.transferAmount(7), 5);
  assert.equal(engine.transferAmount(-5), 0);
  assert.equal(engine.levelMultiplier(1), 1);
  assert.equal(engine.levelMultiplier(26), 1.5);
});

test('升级预测与置信度', () => {
  const pred = engine.predictLevels({ experience: 900, level: 9, growthRate: 'medium_fast', cap: 12 }, 100, 5);
  assert.deepEqual(pred.map((p) => p.level), [10, 11, 12], '不超过等级上限');
  assert.equal(pred[0].expNeeded, 100);
  assert.equal(pred[0].days, 1);
  assert.equal(engine.predictLevels({ experience: 0, level: 1 }, 0, 1)[0].days, null, '没有经验来源时无法预测');

  assert.equal(engine.predictionConfidence([]), 0);
  assert.equal(engine.predictionConfidence([0, 0, 0]), 0);
  const steady = engine.predictionConfidence(Array(14).fill(500));
  const spiky = engine.predictionConfidence([5000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(steady, 1);
  assert.ok(spiky < 0.1 && spiky > 0, `spiky=${spiky}`);
});

test('来源占比合计 100%', () => {
  const list = engine.sourceBreakdown([{ source: 'catch', amount: 1 }, { source: 'item', amount: 1 }, { source: 'training_camp', amount: 1 }]);
  assert.equal(Math.round(list.reduce((a, r) => a + r.percentage, 0) * 10) / 10, 100);
  const two = engine.sourceBreakdown([{ source: 'catch', amount: 300 }, { source: 'item', amount: 100 }]);
  assert.deepEqual(two.map((r) => [r.source, r.percentage]), [['catch', 75], ['item', 25]]);
  assert.deepEqual(engine.sourceBreakdown([]), []);
});
