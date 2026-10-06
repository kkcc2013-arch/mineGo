'use strict';

// 属性克制表（基于 Pokemon 标准）
const TYPE_CHART = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
};

// Missing or invalid database attributes use the historical defaults. Bound inputs
// before multiplying so corrupted numeric data cannot produce Infinity or NaN.
function boundedNumber(value, fallback, minimum, maximum) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function calculateTypeEffectiveness(moveTypes = [], defenderTypes = []) {
  let multiplier = 1;
  const log = [];
  for (const moveType of moveTypes) {
    for (const defenderType of defenderTypes) {
      const chart = Object.hasOwn(TYPE_CHART, moveType) ? TYPE_CHART[moveType] : null;
      const factor = chart && Object.hasOwn(chart, defenderType) ? chart[defenderType] : undefined;
      if (factor !== undefined) {
        multiplier *= factor;
        log.push({ moveType, defenderType, multiplier: factor });
      }
    }
  }
  return { multiplier, log };
}

function calculateDamage(attacker = {}, defender = {}, move = {}, random = Math.random) {
  const level = boundedNumber(attacker.level, 50, 1, 100);
  const attackStats = attacker.modifiedStats || attacker;
  const defenseStats = defender.modifiedStats || defender;
  const physical = move.category === 'physical';
  let attack = boundedNumber(attackStats[physical ? 'attack' : 'special_attack'], 100, 1, 1e6);
  const defense = boundedNumber(defenseStats[physical ? 'defense' : 'special_defense'], 100, 1, 1e6);
  const hasBurn = attacker.status === 'burn' || attacker.statuses?.some(s => s.code === 'burn');
  if (physical && hasBurn) attack = Math.max(1, Math.floor(attack * 0.5));
  const power = boundedNumber(move.power, 40, 0, 1e6);
  let damage = Math.floor(((2 * level / 5 + 2) * power * attack / defense) / 50 + 2);
  const { multiplier: effectiveness } = calculateTypeEffectiveness([move.type], defender.types || ['normal']);
  damage = Math.floor(damage * effectiveness);
  if (attacker.types?.includes(move.type)) damage = Math.floor(damage * 1.5);
  const isCrit = random() < boundedNumber(move.crit_rate, 0.0625, 0, 1);
  if (isCrit) damage = Math.floor(damage * 1.5);
  damage = Math.floor(damage * (0.85 + random() * 0.15));
  // Immunity and non-damaging moves must not be forced to deal one HP.
  damage = effectiveness === 0 || power === 0 ? 0 : Math.max(1, damage);
  return {
    damage, effectiveness, isCrit,
    effectivenessText: effectiveness > 1 ? '效果拔群！' :
      effectiveness > 0 && effectiveness < 1 ? '效果不太好...' :
      effectiveness === 0 ? '没有效果...' : ''
  };
}

function determineTurnOrder(attacker = {}, defender = {}, attackerMove = {}, defenderMove = {}, random = Math.random) {
  const speed = pokemon => {
    const stats = pokemon.modifiedStats || pokemon;
    const paralyzed = pokemon.status === 'paralyze' || pokemon.statuses?.some(s => s.code === 'paralysis');
    return boundedNumber(stats.speed, 100, 0, 1e6) * (paralyzed ? 0.5 : 1);
  };
  const attackerPriority = attackerMove.priority || 0;
  const defenderPriority = defenderMove.priority || 0;
  if (attackerPriority !== defenderPriority) return attackerPriority > defenderPriority ? 'attacker' : 'defender';
  const attackerSpeed = speed(attacker);
  const defenderSpeed = speed(defender);
  if (attackerSpeed !== defenderSpeed) return attackerSpeed > defenderSpeed ? 'attacker' : 'defender';
  return random() < 0.5 ? 'attacker' : 'defender';
}

module.exports = { TYPE_CHART, calculateTypeEffectiveness, calculateDamage, determineTurnOrder };
