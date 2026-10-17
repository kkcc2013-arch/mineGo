'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BattleEngine } = require('../../services/gym-service/src/battleEngine');
const { context, move, pokemon, sequence, statusService } = require('./context');

function scenario(given, when, then, run) {
  test(`Given ${given}; When ${when}; Then ${then}`, run);
}

const matchups = [
  ['normal', 'ghost', 0], ['fire', 'grass', 2], ['water', 'fire', 2],
  ['electric', 'ground', 0], ['grass', 'water', 2], ['ice', 'dragon', 2],
  ['fighting', 'normal', 2], ['poison', 'steel', 0], ['ground', 'flying', 0],
  ['flying', 'fighting', 2], ['psychic', 'dark', 0], ['bug', 'psychic', 2],
  ['rock', 'flying', 2], ['ghost', 'normal', 0], ['dragon', 'fairy', 0],
  ['dark', 'psychic', 2], ['steel', 'fairy', 2], ['fairy', 'dragon', 2],
  ['fire', 'water', 0.5], ['water', 'grass', 0.5], ['normal', 'normal', 1]
];
for (const [type, defenderType, effectiveness] of matchups) {
  scenario(`${type} attack against ${defenderType}`, 'executing an attack', `effectiveness is ${effectiveness} and HP matches the action log`, async () => {
    const { engine, player, opponent } = context({ attacker: { types: [type] }, defender: { types: [defenderType] } });
    const result = await engine.executeAttack(player, opponent, move({ type }), true);
    assert.equal(result.actions[0].effectiveness, effectiveness);
    assert.equal(opponent.current_hp, 500 - result.damage);
    if (effectiveness === 0) assert.equal(result.damage, 0);
    else assert.ok(result.damage > 0);
  });
}

for (const [name, attacker, defender, skill, first] of [
  ['faster player', { speed: 200 }, {}, {}, 'attacker'],
  ['faster defender', {}, { speed: 200 }, {}, 'defender'],
  ['priority beats speed', { speed: 1 }, {}, { priority: 1 }, 'attacker'],
  ['negative priority', { speed: 200 }, {}, { priority: -1 }, 'defender'],
  ['paralysis slows player', { speed: 150, status: 'paralyze' }, {}, {}, 'defender'],
  ['paralysis slows defender', {}, { speed: 150, status: 'paralyze' }, {}, 'attacker'],
  ['speed buff', { modifiedStats: { speed: 200, attack: 100 } }, {}, {}, 'attacker']
]) {
  scenario(name, 'executing a complete turn', `${first} attacks first and replay is recorded`, async () => {
    const { engine } = context({ attacker, defender });
    const result = await engine.executeTurn(move(skill));
    assert.equal(result.actions[0].attacker, first);
    assert.equal(result.actions.filter(a => a.type === 'attack').length, 2);
    assert.equal(result.battleEnded, false);
    assert.equal(engine.replay.length, 1);
    assert.equal(result.timestamp, 1000);
  });
}

for (const [status, roll, prevented] of [
  ['sleep', 0.5, true], ['paralyze', 0.8, true], ['paralyze', 0.5, false],
  ['freeze', 0.5, true], ['freeze', 0.1, false], ['confusion', 0.1, true],
  ['confusion', 0.5, false], ['unknown', 0.5, false]
]) {
  scenario(`legacy ${status} and random roll ${roll}`, 'executing an attack', prevented ? 'the attack is blocked' : 'the attack proceeds', async () => {
    const { engine, player, opponent } = context({ attacker: { status }, random: () => roll });
    const result = await engine.executeAttack(player, opponent, move(), true);
    assert.equal(result.actions[0].type, prevented ? 'status_prevent' : 'attack');
    if (prevented) assert.equal(opponent.current_hp, 500);
    if (status === 'confusion' && prevented) assert.equal(player.current_hp, 460);
  });
}

scenario('confusion and one remaining HP', 'self damage occurs', 'HP is clamped to zero', async () => {
  const { engine, player, opponent } = context({ attacker: { status: 'confusion', current_hp: 1 }, random: () => 0.1 });
  await engine.executeAttack(player, opponent, move(), true);
  assert.equal(player.current_hp, 0);
});

for (const [accuracy, roll, expected] of [[0, 0, 'miss'], [50, 0.5, 'miss'], [50, 0.49, 'attack'], [100, 0.99, 'attack'], [undefined, 0.5, 'attack'], [null, 0.5, 'attack']]) {
  scenario(`accuracy ${accuracy} and roll ${roll}`, 'executing an attack', `the outcome is ${expected}`, async () => {
    const { engine, player, opponent } = context({ random: () => roll });
    const result = await engine.executeAttack(player, opponent, move({ accuracy }), false);
    assert.equal(result.actions[0].type, expected);
  });
}

for (const [chance, roll, applies] of [[0, 0, false], [1, 0.5, true], [0.5, 0.5, false], [undefined, 0.05, true]]) {
  scenario(`secondary status chance ${chance}`, 'attacking with burn', applies ? 'burn is applied and logged' : 'burn is not applied', async () => {
    const { engine, player, opponent } = context({ random: () => roll });
    const result = await engine.executeAttack(player, opponent, move({ status_effect: 'burn', status_chance: chance }), true);
    assert.equal(result.actions.some(a => a.type === 'status_apply'), applies);
    assert.equal(opponent.status === 'burn', applies);
  });
}

for (const status of ['burn', 'poison', 'toxic']) {
  scenario(`player has ${status}`, 'two complete turns execute', 'residual damage follows the status rule', async () => {
    const { engine, player } = context({ attacker: { status, max_hp: 160 } });
    const first = await engine.executeTurn(move());
    const second = await engine.executeTurn(move());
    assert.equal(first.statusEffects[0].damage, status === 'toxic' ? 10 : 20);
    assert.equal(second.statusEffects[0].damage, 20);
    assert.ok(player.current_hp > 0);
  });
}

scenario('defender has toxic', 'a full turn executes', 'defender residual damage is attributed correctly', async () => {
  const { engine } = context({ defender: { status: 'toxic', max_hp: 160 } });
  const result = await engine.executeTurn(move());
  assert.equal(result.statusEffects[0].pokemon, 'defender');
  assert.equal(result.statusEffects[0].damage, 10);
});

scenario('player has burn and insufficient HP', 'residual damage occurs', 'HP does not become negative', async () => {
  const { engine, player, opponent } = context({ attacker: { status: 'burn', current_hp: 1 } });
  await engine.processTurnEndStatusEffects(player, opponent, { statusEffects: [] });
  assert.equal(player.current_hp, 0);
});

scenario('fainted player with burn', 'turn-end effects execute', 'no extra residual damage is recorded', async () => {
  const { engine, player, opponent } = context({ attacker: { status: 'burn', current_hp: 0 } });
  const result = { statusEffects: [] };
  await engine.processTurnEndStatusEffects(player, opponent, result);
  assert.equal(result.statusEffects.length, 0);
});

for (const side of ['attacker', 'defender']) {
  scenario(`${side} can knock out the opponent on its first action`, 'a turn executes', 'the fainted opponent cannot retaliate', async () => {
    const playerFirst = side === 'attacker';
    const { engine, player, opponent } = context({
      attacker: { speed: playerFirst ? 200 : 1, current_hp: playerFirst ? 500 : 1 },
      defender: { current_hp: playerFirst ? 1 : 500 }
    });
    const result = await engine.executeTurn(move());
    assert.equal(result.actions.filter(a => a.type === 'attack').length, 1);
    assert.equal(result.battleEnded, true);
    assert.equal(result.result, playerFirst ? 'win' : 'lose');
    assert.equal(playerFirst ? opponent.current_hp : player.current_hp, 0);
  });
}

for (const side of ['attacker', 'defender']) {
  scenario(`${side} faints with a healthy reserve`, 'the turn ends', 'the reserve enters with a fresh toxic counter', async () => {
    const { engine } = context({
      attacker: { speed: side === 'defender' ? 200 : 1, current_hp: side === 'attacker' ? 1 : 500 },
      defender: { current_hp: side === 'defender' ? 1 : 500 }
    });
    const reserve = pokemon({ id: 'reserve', status: 'toxic' });
    engine[side].team.push(reserve);
    engine.toxicTurns[side] = 4;
    const result = await engine.executeTurn(move());
    assert.equal(result.battleEnded, false);
    assert.equal(engine[side].currentPokemon.id, 'reserve');
    assert.equal(engine.toxicTurns[side], 0);
  });
}

scenario('player is missing', 'executing a turn', 'the engine rejects invalid battle data', async () => {
  const { engine } = context();
  engine.attacker.currentPokemon = null;
  await assert.rejects(engine.executeTurn(move()), /当前精灵不存在/);
});

scenario('defender has no moves', 'AI selects a move', 'Struggle is available', () => {
  const { engine, player, opponent } = context();
  assert.equal(engine.selectDefenderMove(opponent, player).id, 'struggle');
});

scenario('AI has neutral and super-effective moves', 'a complete turn executes', 'AI chooses the super-effective move', async () => {
  const { engine } = context({ attacker: { types: ['grass'] }, defender: { moves: [move(), move({ id: 'flame', name: 'Flame', type: 'fire' })] } });
  const result = await engine.executeTurn(move());
  assert.equal(result.actions.find(a => a.attacker === 'defender').move, 'Flame');
});

scenario('status service blocks a move', 'executing an attack', 'blocking reason is logged without dealing damage', async () => {
  const service = statusService({ checkActionBlocked: async () => ({ blocked: true, statusCode: 'sleep', reason: 'sleep' }) });
  const { engine, player, opponent } = context({ statusEngine: service });
  const result = await engine.executeAttack(player, opponent, move(), true);
  assert.equal(result.actions[0].status, 'sleep');
  assert.equal(opponent.current_hp, 500);
});

scenario('status service grants immunity', 'secondary burn is attempted', 'no false application action is logged', async () => {
  const { engine, player, opponent } = context({ statusEngine: statusService({ applyStatus: async () => ({ success: false }) }) });
  const result = await engine.executeAttack(player, opponent, move({ status_effect: 'burn', status_chance: 1 }), true);
  assert.equal(result.actions.some(a => a.type === 'status_apply'), false);
});

scenario('status service accepts a defender status', 'secondary burn is applied', 'service receives target and source context', async () => {
  let args;
  const service = statusService({ applyStatus: async (...input) => { args = input; return { success: true, statusName: 'burn' }; } });
  const { engine, player, opponent } = context({ statusEngine: service, defender: { types: ['grass'], ability_id: 3 } });
  const result = await engine.executeAttack(player, opponent, move({ status_effect: 'burn', status_chance: 1 }), true);
  assert.equal(args[1], 'opponent');
  assert.equal(args[3].targetTypeId, 12);
  assert.equal(args[3].targetAbilityId, 3);
  assert.equal(args[3].sourcePokemonId, 'player');
  assert.equal(result.actions[1].pokemon, 'defender');
});

scenario('defender applies a status to player', 'secondary burn is applied', 'player is the status target', async () => {
  let target;
  const service = statusService({ applyStatus: async (battle, id) => { target = id; return { success: true }; } });
  const { engine, player, opponent } = context({ statusEngine: service });
  const result = await engine.executeAttack(opponent, player, move({ status_effect: 'burn', status_chance: 1 }), false);
  assert.equal(target, 'player');
  assert.equal(result.actions[1].pokemon, 'attacker');
});

scenario('frozen defender receives fire damage', 'executing an attack', 'freeze is removed through the status service', async () => {
  let removed;
  const service = statusService({ removeStatus: async (...args) => { removed = args; } });
  const { engine, player, opponent } = context({ statusEngine: service, defender: { status: 'freeze' } });
  const result = await engine.executeAttack(player, opponent, move({ type: 'fire' }), true);
  assert.deepEqual(removed, ['battle', 'opponent', 'freeze']);
  assert.equal(opponent.status, null);
  assert.equal(result.actions[1].type, 'status_clear');
});

scenario('turn-start poison knocks out player', 'a turn executes', 'no move runs and a losing replay is retained', async () => {
  const service = statusService({ onTurnStart: async (battle, id) => id === 'player' ? [{ type: 'damage', value: 500, statusCode: 'poison' }] : [] });
  const { engine } = context({ statusEngine: service });
  const result = await engine.executeTurn(move());
  assert.equal(result.result, 'lose');
  assert.equal(result.actions.length, 0);
  assert.equal(engine.replay.length, 1);
});

scenario('turn-end status knocks out defender', 'a turn executes', 'player wins through status damage', async () => {
  const service = statusService({ onTurnEnd: async (battle, id) => id === 'opponent' ? [{ type: 'damage', value: 500, statusCode: 'poison' }] : [] });
  const { engine } = context({ statusEngine: service });
  const result = await engine.executeTurn(move());
  assert.equal(result.result, 'win');
  assert.equal(result.statusEffects[0].pokemon, 'defender');
});

scenario('status service modifies attack and defense', 'a full turn executes', 'stacked modifiers reach the real damage formula', async () => {
  const service = statusService({
    getStatChanges: async (battle, id) => id === 'player' ? { attack: 2 } : { defense: 1 },
    calculateModifiedStats: (stats, changes) => ({ ...stats, attack: stats.attack * (changes.attack ? 2 : 1), defense: stats.defense * (changes.defense ? 1.5 : 1) })
  });
  const { engine } = context({ statusEngine: service, attacker: { speed: 200 } });
  const result = await engine.executeTurn(move());
  assert.equal(result.actions[0].damage, 34);
});

scenario('status service expires a buff', 'two turns execute', 'the next turn uses freshly loaded stats', async () => {
  let buffsActive = true;
  const service = statusService({
    getStatChanges: async () => ({ attack: buffsActive ? 2 : 0 }),
    calculateModifiedStats: (stats, changes) => ({ ...stats, attack: stats.attack * (changes.attack ? 2 : 1) }),
    onTurnEnd: async () => { buffsActive = false; return [{ type: 'status_expired', statusCode: 'attack_up', statusName: 'Attack Up' }]; }
  });
  const { engine } = context({ statusEngine: service, attacker: { speed: 200 } });
  const first = await engine.executeTurn(move());
  const second = await engine.executeTurn(move());
  assert.ok(first.actions[0].damage > second.actions[0].damage);
  assert.equal(first.statusEffects[0].expired, true);
});

scenario('healing and leech seed effects', 'status results are applied', 'healing never exceeds max HP', () => {
  const { engine, player, opponent } = context({ attacker: { current_hp: 490 } });
  const turn = { statusEffects: [] };
  engine.applyEffectResult(opponent, player, { type: 'damage', value: 20, statusCode: 'leech_seed' }, turn, false);
  assert.equal(player.current_hp, 500);
  assert.equal(turn.statusEffects[1].heal, 10);
  engine.applyEffectResult(opponent, player, { type: 'heal', value: 100, statusCode: 'regen' }, turn, false);
  assert.equal(opponent.current_hp, 500);
  assert.equal(turn.statusEffects[2].heal, 20);
});

scenario('a battle is serialized after a turn', 'restoring and continuing', 'replay, clock and turn count survive', async () => {
  const { engine, dependencies, advance } = context();
  await engine.executeTurn(move());
  advance(100);
  const restored = BattleEngine.deserialize(engine.serialize(), dependencies);
  await restored.executeTurn(move());
  assert.equal(restored.replay.length, 2);
  assert.equal(restored.turn, 2);
  assert.equal(restored.getBattleResult().duration, 100);
});

scenario('older cached battle lacks toxic counters and replay', 'restoring', 'safe defaults are supplied', () => {
  const { engine, dependencies } = context();
  const saved = JSON.parse(engine.serialize());
  delete saved.toxicTurns;
  delete saved.replay;
  const restored = BattleEngine.deserialize(JSON.stringify(saved), dependencies);
  assert.deepEqual(restored.toxicTurns, { attacker: 0, defender: 0 });
  assert.deepEqual(restored.replay, []);
});

scenario('a winning battle and controlled clock', 'calculating rewards', 'bounded rewards and duration are deterministic', () => {
  const { engine, advance } = context({ random: () => 0.5 });
  engine.status = 'attacker_won';
  advance(3000);
  const result = engine.getBattleResult();
  assert.equal(result.duration, 3000);
  assert.deepEqual(result.rewards, { prestigeGained: 1250, experienceGained: 125, coinsGained: 20 });
});

scenario('a losing battle', 'calculating rewards', 'no rewards are issued', () => {
  const { engine } = context();
  engine.status = 'attacker_lost';
  assert.equal(engine.getBattleResult().rewards, null);
});

scenario('status service fails', 'executing a turn', 'the failure propagates instead of silently skipping statuses', async () => {
  const service = statusService({ getPokemonStatuses: async () => { throw new Error('status unavailable'); } });
  const { engine } = context({ statusEngine: service });
  await assert.rejects(engine.executeTurn(move()), /status unavailable/);
  assert.equal(engine.replay.length, 0);
});

scenario('critical and damage rolls vary in a controlled sequence', 'executing an attack', 'critical flag is included in the replay action', async () => {
  const { engine, player, opponent } = context({ random: sequence(0.5, 0, 1) });
  const result = await engine.executeAttack(player, opponent, move({ crit_rate: 1 }), true);
  assert.equal(result.actions[0].isCrit, true);
  assert.equal(result.damage, 42);
});
