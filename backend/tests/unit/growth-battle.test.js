/**
 * E07 精灵成长接入战斗（shared/growthBattle.js 纯函数）：疲劳/特训/熟练度/羁绊技能作用到 E11 战斗单位
 *   node --test tests/unit/growth-battle.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gb = require('../../shared/growthBattle');

const now = new Date('2026-09-25T10:00:00Z');
const combatant = () => ({
  attack: 200, defense: 100, maxEnergy: 110,
  moves: [
    { id: 'EMBER', category: 'FAST', power: 10, accuracy: 100, critPct: 0 },
    { id: 'FLAMETHROWER', category: 'CHARGE', power: 90, accuracy: 95, critPct: 5 },
  ],
});

test('无成长数据时不改变战斗单位', () => {
  const m = gb.modifiersFrom({ stamina: { max_stamina: 100, current_stamina: 100, last_stamina_update: now }, now });
  const c = gb.applyToCombatant(combatant(), m);
  assert.deepEqual([c.attack, c.defense, c.maxEnergy, c.moves[1].power, c.moves.length], [200, 100, 110, 90, 2]);
  assert.equal(c.growth.fatigueLevel, 'fresh');
  assert.equal(gb.applyToCombatant(null, m), null);
  const c2 = combatant();
  assert.equal(gb.applyToCombatant(c2, undefined), c2, '没有修正时原样返回');
});

test('疲劳与特训属性、熟练度、觉醒技能加成', () => {
  const m = gb.modifiersFrom({
    stamina: { max_stamina: 100, current_stamina: 30, last_stamina_update: now },
    trainingLevels: { attack: 25, defense: 10, energy: 4, critical: 10 },
    awakening: { skillPowerPct: 0.1, critRate: 0.03 },
    mastery: { FLAMETHROWER: { power: 2, accuracy: 3, critical_chance: 1 } },
    now,
  });
  assert.equal(m.fatigueLevel, 'tired');
  assert.equal(m.attackMult, Math.round(1.5 * 0.85 * 100) / 100);
  assert.equal(m.defenseMult, Math.round(1.2 * 0.85 * 100) / 100);
  const shared = combatant();
  const movesBefore = shared.moves;
  const c = gb.applyToCombatant(shared, m);
  assert.equal(c.maxEnergy, 130);
  assert.equal(c.moves[1].power, Math.round(90 * 1.1 * 1.1));
  assert.equal(c.moves[1].accuracy, 100, '命中上限 100');
  assert.equal(c.moves[1].critPct, 5 + Math.round((0.03 + 0.05 + 0.03) * 100));
  assert.equal(movesBefore[1].power, 90, '不修改共享技能表对象');
});

test('激活的羁绊技能作为额外蓄力技，威力随亲密度', () => {
  const def = { id: 1, skill_name: '羁绊电击', type: 'electric', power: 65, accuracy: 100, energy_cost: 20, cooldown_turns: 0, friendship_bonus_formula: '65 + floor(friendship * 0.5)' };
  const low = gb.bondMove(def, 60);
  const high = gb.bondMove(def, 255);
  assert.equal(low.id, 'BOND_1');
  assert.equal(low.category, 'CHARGE');
  assert.equal(low.power, 95);
  assert.equal(high.power, 192);
  const m = gb.modifiersFrom({ bond: def, friendship: 255, now });
  const c = gb.applyToCombatant(combatant(), m);
  assert.equal(c.moves.length, 3);
  assert.equal(c.moves[2].power, 192);
  assert.equal(c.growth.bondMove, 'BOND_1');
});

test('战斗类型 → 体力活动', () => {
  assert.equal(gb.BATTLE_ACTIVITY.gym, 'gym_battle');
  assert.equal(gb.BATTLE_ACTIVITY.league, 'pvp_battle');
  assert.equal(gb.BATTLE_EXP.win > gb.BATTLE_EXP.lose, true);
});
