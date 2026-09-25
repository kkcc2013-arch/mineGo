/**
 * 战斗属性合成（纯函数）：成长系统各项加成 → 战斗属性
 *
 *   有效攻击 = (种族攻击 + IV) × 等级倍率 × (1 + 觉醒攻击%) × (1 + 特训攻击%) × 疲劳战斗倍率
 *   防御同理；HP 不受疲劳影响；暴击/闪避 = 特训 + 觉醒；能量上限 = 100 + 特训能量；速度倍率 = (1 + 特训速度%) × 疲劳
 */
'use strict';

const { levelMultiplier } = require('../../../../shared/ExperienceEngine');

const r3 = (v) => Math.round(v * 1000) / 1000;

function combine({ pokemon, species, awakening = {}, training = {}, fatigue = { battleBonus: 1 } }) {
  const lm = levelMultiplier(pokemon.level || 1);
  const f = Number(fatigue.battleBonus) || 1;
  const stat = (base, iv, awPct, trPct, useFatigue) =>
    Math.round((Number(base) + Number(iv || 0)) * lm * (1 + (Number(awPct) || 0)) * (1 + (Number(trPct) || 0)) * (useFatigue ? f : 1));
  return {
    attack: stat(species.base_attack, pokemon.iv_attack, awakening.attackPct, training.attackPct, true),
    defense: stat(species.base_defense, pokemon.iv_defense, awakening.defensePct, training.defensePct, true),
    hp: stat(species.base_hp, pokemon.iv_hp, awakening.hpPct, 0, false),
    speedMultiplier: r3((1 + (Number(training.speedPct) || 0)) * f),
    critRate: r3((Number(training.critRate) || 0) + (Number(awakening.critRate) || 0)),
    dodgeRate: r3((Number(training.dodgeRate) || 0) + (Number(awakening.dodgeRate) || 0)),
    energyCap: 100 + (Number(training.energyCap) || 0),
    skillPowerMultiplier: r3(1 + (Number(awakening.skillPowerPct) || 0)),
    fatigueMultiplier: f,
    levelMultiplier: r3(lm),
  };
}

module.exports = { combine };
