/**
 * E07 精灵成长：体力/疲劳规则单元测试
 *   node --test tests/unit/growth-stamina.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../../services/pokemon-service/src/growth/staminaRules');

const now = new Date('2026-09-25T10:00:00Z');
const minsAgo = (m) => new Date(now.getTime() - m * 60000);

test('疲劳等级按体力百分比划分', () => {
  assert.equal(rules.fatigueLevel(100, 100), 'fresh');
  assert.equal(rules.fatigueLevel(80, 100), 'fresh');
  assert.equal(rules.fatigueLevel(79, 100), 'normal');
  assert.equal(rules.fatigueLevel(50, 100), 'normal');
  assert.equal(rules.fatigueLevel(49, 100), 'tired');
  assert.equal(rules.fatigueLevel(20, 100), 'tired');
  assert.equal(rules.fatigueLevel(19, 100), 'exhausted');
  assert.equal(rules.fatigueLevel(0, 100), 'exhausted');
  assert.equal(rules.fatigueLevel(60, 200), 'tired', '按最大体力的百分比');
});

test('自然恢复按整分钟惰性换算，不超过上限', () => {
  const e = rules.effectiveStamina({ max_stamina: 100, current_stamina: 40, last_stamina_update: minsAgo(10.5) }, now);
  assert.deepEqual({ current: e.current, recovered: e.recovered, wholeMinutes: e.wholeMinutes }, { current: 50, recovered: 10, wholeMinutes: 10 });
  const full = rules.effectiveStamina({ max_stamina: 100, current_stamina: 95, last_stamina_update: minsAgo(60) }, now);
  assert.equal(full.current, 100);
  assert.equal(full.recovered, 5);
  const future = rules.effectiveStamina({ max_stamina: 100, current_stamina: 30, last_stamina_update: new Date(now.getTime() + 60000) }, now);
  assert.equal(future.current, 30, '时钟偏差不会倒扣');
});

test('状态：效果、低体力标记、恢复满所需时间', () => {
  const s = rules.status({ max_stamina: 100, current_stamina: 10, last_stamina_update: now }, now);
  assert.equal(s.fatigueLevel, 'exhausted');
  assert.deepEqual(s.effects, { battleBonus: 0.6, catchBonus: 0.7, expBonus: 0.8 });
  assert.equal(s.isLowStamina, true);
  assert.equal(s.minutesToFull, 90);
  assert.equal(s.staminaPercentage, 10);
  const tired = rules.status({ max_stamina: 100, current_stamina: 30, last_stamina_update: now }, now);
  assert.equal(tired.effects.battleBonus, 0.85);
});

test('休息站额外恢复：5/分钟 × 站点倍率，最长 8 小时', () => {
  assert.equal(rules.restRecovery(10, 1), 50);
  assert.equal(rules.restRecovery(10, 1.5), 75);
  assert.equal(rules.restRecovery(10.9, 2), 100);
  assert.equal(rules.restRecovery(10000, 1), 8 * 60 * 5);
  assert.equal(rules.restRecovery(-5, 1), 0);
});

test('疲劳影响经验倍率', () => {
  assert.equal(rules.expMultiplier({ max_stamina: 100, current_stamina: 100, last_stamina_update: now }, now), 1);
  assert.equal(rules.expMultiplier({ max_stamina: 100, current_stamina: 25, last_stamina_update: now }, now), 0.95);
  assert.equal(rules.expMultiplier({ max_stamina: 100, current_stamina: 5, last_stamina_update: now }, now), 0.8);
  assert.equal(rules.expMultiplier({ max_stamina: 100, current_stamina: 5, last_stamina_update: minsAgo(100) }, now), 1, '恢复后不再疲劳');
});
