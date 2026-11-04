'use strict';

const { calculateDamage, estimateAverageDamage } = require('../../../shared/damageCalculator');

// Translate canonical catalog casing at the boundary; never rewrite stored move data.
function simulateDamage({ attackerSpecies, defenderSpecies, move, attack, defense, weather = null }) {
  const params = {
    power: move.power, attack, defense, attackType: move.type.toLowerCase(),
    attackerType1: attackerSpecies.type1.toLowerCase(),
    attackerType2: attackerSpecies.type2?.toLowerCase() ?? null,
    defenderType1: defenderSpecies.type1.toLowerCase(),
    defenderType2: defenderSpecies.type2?.toLowerCase() ?? null,
    isCharged: move.category === 'CHARGE', weatherBoost: weather
  };
  const result = calculateDamage(params);
  return {
    attacker: { species_id: attackerSpecies.id, name: attackerSpecies.name_en, types: [params.attackerType1,params.attackerType2].filter(Boolean) },
    defender: { species_id: defenderSpecies.id, name: defenderSpecies.name_en, types: [params.defenderType1,params.defenderType2].filter(Boolean) },
    move: { id: move.id, name: move.name_en, type: params.attackType, power: move.power, category: move.category },
    damage: result.damage, damageMultiplier: result.typeMultiplier,
    damage_multiplier: result.typeMultiplier, effectiveness: result.effectiveness,
    isImmune: result.isImmune, hasStab: result.stab > 1,
    weatherBoosted: result.weatherMultiplier > 1,
    averageDamage: estimateAverageDamage(params), breakdown: result.breakdown
  };
}

module.exports = { simulateDamage };
