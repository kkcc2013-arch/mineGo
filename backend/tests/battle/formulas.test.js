'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateDamage, calculateTypeEffectiveness, determineTurnOrder } = require('../../services/gym-service/src/battleFormulas');
const { pokemon, move, sequence } = require('./context');

const damageCases = [
  ['neutral physical hit', {}, {}, {}, [0.5, 0], 23],
  ['maximum damage roll', {}, {}, {}, [0.5, 1], 28],
  ['critical hit', {}, {}, { crit_rate: 1 }, [0, 1], 42],
  ['critical rate zero', {}, {}, { crit_rate: 0 }, [0, 1], 28],
  ['critical rate boundary', {}, {}, { crit_rate: 0.5 }, [0.5, 1], 28],
  ['STAB', { types: ['fire'] }, {}, { type: 'fire' }, [0.5, 1], 28],
  ['STAB and weakness', { types: ['fire'] }, { types: ['grass'] }, { type: 'fire' }, [0.5, 1], 57],
  ['double weakness', { types: ['fire'] }, { types: ['grass', 'ice'] }, { type: 'fire' }, [0.5, 1], 114],
  ['resistance', { types: ['water'] }, { types: ['fire'] }, { type: 'fire' }, [0.5, 1], 9],
  ['normal immunity', {}, { types: ['ghost'] }, {}, [0, 1], 0],
  ['electric immunity', {}, { types: ['ground'] }, { type: 'electric' }, [0, 1], 0],
  ['dual type immunity', {}, { types: ['water', 'ground'] }, { type: 'electric' }, [0, 1], 0],
  ['zero power', {}, {}, { power: 0 }, [0, 1], 0],
  ['burn physical', { status: 'burn' }, {}, {}, [0.5, 1], 15],
  ['burn statuses list', { statuses: [{ code: 'burn' }] }, {}, {}, [0.5, 1], 15],
  ['burn does not weaken special moves', { status: 'burn' }, {}, { category: 'special' }, [0.5, 1], 28],
  ['special attack uses special defense', { special_attack: 200 }, { special_defense: 200 }, { category: 'special' }, [0.5, 1], 28],
  ['attack buff', { modifiedStats: { attack: 200 } }, {}, {}, [0.5, 1], 55],
  ['defense buff', {}, { modifiedStats: { defense: 200 } }, {}, [0.5, 1], 15],
  ['combined buff and burn', { modifiedStats: { attack: 200 }, status: 'burn' }, {}, {}, [0.5, 1], 28],
  ['level one', { level: 1 }, {}, {}, [0.5, 1], 4],
  ['minimum non-immune damage', { attack: 1, types: [] }, { defense: 1e6 }, {}, [0.5, 0], 1],
  ['unknown move type', {}, {}, { type: 'unknown' }, [0.5, 1], 19],
  ['empty defender types', {}, { types: [] }, {}, [0.5, 1], 28],
  ['missing attacker type', { types: undefined }, {}, {}, [0.5, 1], 19],
  ['missing defender type', {}, { types: undefined }, {}, [0.5, 1], 28]
];

for (const [name, attacker, defender, skill, rolls, expected] of damageCases) {
  test(`Given ${name}; When damage is calculated; Then damage is ${expected}`, () => {
    const result = calculateDamage(pokemon(attacker), pokemon(defender), move(skill), sequence(...rolls));
    assert.equal(result.damage, expected);
  });
}

test('Given missing attributes; When calculating damage; Then defaults are finite', () => {
  assert.equal(calculateDamage({}, {}, {}, () => 1).damage, 19);
  assert.equal(calculateDamage(undefined, undefined, undefined, () => 1).damage, 19);
});

for (const value of [undefined, null, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER, 0, -100]) {
  test(`Given invalid or extreme stats ${String(value)}; When attacking; Then damage stays finite and nonnegative`, () => {
    const result = calculateDamage(pokemon({ level: value, attack: value }), pokemon({ defense: value }), move({ power: value }), () => 1);
    assert.ok(Number.isSafeInteger(result.damage));
    assert.ok(result.damage >= 0);
  });
}

test('Given omitted critical rate; When rolling below base probability; Then a critical is recorded', () => {
  assert.equal(calculateDamage({}, {}, {}, sequence(0, 1)).isCrit, true);
});

test('Given empty type arrays; When checking effectiveness; Then it is neutral', () => {
  assert.deepEqual(calculateTypeEffectiveness(), { multiplier: 1, log: [] });
});

test('Given unknown types; When checking effectiveness; Then unknown entries are neutral', () => {
  assert.deepEqual(calculateTypeEffectiveness(['unknown'], ['unknown']), { multiplier: 1, log: [] });
});

for (const type of ['constructor', '__proto__', 'toString']) {
  test(`Given prototype property ${type} as a type; When calculating damage; Then unknown types remain neutral`, () => {
    assert.deepEqual(calculateTypeEffectiveness([type], [type]), { multiplier: 1, log: [] });
    assert.deepEqual(calculateTypeEffectiveness(['normal'], [type]), { multiplier: 1, log: [] });
    assert.ok(Number.isFinite(calculateDamage({}, { types: [type] }, { type }, () => 0.5).damage));
  });
}

test('Given two attack types; When checking a dual defender; Then factors and log are accumulated', () => {
  const result = calculateTypeEffectiveness(['fire', 'water'], ['grass', 'rock']);
  assert.equal(result.multiplier, 1);
  assert.equal(result.log.length, 4);
});

const orderCases = [
  ['faster player', { speed: 200 }, {}, {}, {}, 0.5, 'attacker'],
  ['faster defender', {}, { speed: 200 }, {}, {}, 0.5, 'defender'],
  ['player priority', { speed: 1 }, {}, { priority: 1 }, {}, 0.5, 'attacker'],
  ['defender priority', {}, { speed: 1 }, {}, { priority: 1 }, 0.5, 'defender'],
  ['negative priority', {}, {}, { priority: -1 }, {}, 0.5, 'defender'],
  ['speed tie player', {}, {}, {}, {}, 0.49, 'attacker'],
  ['speed tie defender', {}, {}, {}, {}, 0.5, 'defender'],
  ['paralyzed player', { speed: 150, status: 'paralyze' }, {}, {}, {}, 0.5, 'defender'],
  ['paralyzed defender', {}, { speed: 150, status: 'paralyze' }, {}, {}, 0.5, 'attacker'],
  ['status-list paralysis', { speed: 150, statuses: [{ code: 'paralysis' }] }, {}, {}, {}, 0.5, 'defender'],
  ['defender status-list paralysis', {}, { speed: 150, statuses: [{ code: 'paralysis' }] }, {}, {}, 0.5, 'attacker'],
  ['speed buff', { modifiedStats: { speed: 300 } }, {}, {}, {}, 0.5, 'attacker'],
  ['zero speed', { speed: 0 }, {}, {}, {}, 0.5, 'defender']
];
for (const [name, attacker, defender, playerMove, opponentMove, roll, expected] of orderCases) {
  test(`Given ${name}; When ordering the turn; Then ${expected} acts first`, () => {
    assert.equal(determineTurnOrder(pokemon(attacker), pokemon(defender), playerMove, opponentMove, () => roll), expected);
  });
}

test('Given absent speed and moves; When ordering the turn; Then defaults permit a tie', () => {
  assert.equal(determineTurnOrder(undefined, undefined, undefined, undefined, () => 0), 'attacker');
});
