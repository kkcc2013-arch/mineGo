'use strict';

const { BattleEngine } = require('../../services/gym-service/src/battleEngine');

function pokemon(overrides = {}) {
  return {
    id: 'player', species: 'Testmon', level: 50, types: ['normal'],
    attack: 100, defense: 100, special_attack: 100, special_defense: 100,
    speed: 100, max_hp: 500, current_hp: 500, moves: [], ...overrides
  };
}

function move(overrides = {}) {
  return {
    id: 'tackle', name: 'Tackle', type: 'normal', category: 'physical',
    power: 40, accuracy: 100, priority: 0, crit_rate: 0, ...overrides
  };
}

// Each scenario gets independent state, clock and random source. No global
// Math.random patch, network connection, or database is needed.
function context({ attacker = {}, defender = {}, random = () => 0.5, statusEngine = null } = {}) {
  let time = 1000;
  const dependencies = { random, now: () => time, statusEngine };
  const engine = new BattleEngine('battle', 'gym', 'user', 'opponent', dependencies);
  const player = pokemon(attacker);
  const opponent = pokemon({ id: 'opponent', ...defender });
  engine.attacker.team = [player];
  engine.attacker.currentPokemon = player;
  engine.defender.team = [opponent];
  engine.defender.currentPokemon = opponent;
  return { engine, player, opponent, dependencies, advance: milliseconds => { time += milliseconds; } };
}

function sequence(...values) {
  let index = 0;
  return () => values[index++ % values.length];
}

// Controlled status-service boundary for exercising the real battle engine's
// status lifecycle. Formula and turn logic always run in production modules.
function statusService(overrides = {}) {
  return {
    getPokemonStatuses: async () => [],
    getStatChanges: async () => ({}),
    calculateModifiedStats: stats => stats,
    onTurnStart: async () => [],
    onTurnEnd: async () => [],
    checkActionBlocked: async () => ({ blocked: false }),
    applyStatus: async () => ({ success: true, statusName: 'burn' }),
    removeStatus: async () => true,
    ...overrides
  };
}

module.exports = { pokemon, move, context, sequence, statusService };
