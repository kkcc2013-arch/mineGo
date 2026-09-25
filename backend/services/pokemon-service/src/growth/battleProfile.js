/**
 * 精灵战斗档案：把成长系统的各项加成合成为战斗属性（供战斗引擎/客户端使用）
 *
 *   有效攻击 = (种族攻击 + IV) × 等级倍率 × (1 + 觉醒攻击%) × (1 + 特训攻击%) × 疲劳战斗倍率
 *   防御、HP 同理（HP 不受疲劳影响）；暴击/闪避 = 特训 + 觉醒；能量上限 = 100 + 特训能量
 *   技能：激活的羁绊技能（威力随亲密度）、觉醒技能、招式熟练度加成
 */
'use strict';

const { query } = require('../../../../shared/db');
const staminaRules = require('./staminaRules');
const trainingRules = require('./specialTrainingRules');
const awakeningRules = require('./awakeningRules');
const { combine } = require('./battleStats');
const { lockOwnedPokemon } = require('./common');

async function profile(pokemonId, userId) {
  const p = await lockOwnedPokemon({ query }, pokemonId, userId, { lock: false });
  const stamina = staminaRules.status(p);
  const training = await require('../specialTrainingService').battleBonuses({ query }, p.id);
  const bond = await require('../bondSkillService').activeEffect({ query }, p);
  const { rows: mastery } = await query(
    'SELECT move_id, power, accuracy, critical_chance, mastery_exp FROM pokemon_skill_mastery WHERE pokemon_instance_id = $1', [p.id]);
  const mMap = new Map(mastery.map((m) => [m.move_id, trainingRules.masteryBonuses(m)]));
  const awakening = p.awakening_bonuses || {};
  const stats = combine({ pokemon: p, species: p, awakening, training: training.bonuses, fatigue: stamina.effects });
  return {
    pokemonId: p.id,
    speciesId: Number(p.species_id),
    name: p.nickname || p.species_name,
    types: [p.type1, p.type2].filter(Boolean),
    cp: p.cp,
    level: Number(p.level || 1),
    stats,
    stamina: { current: stamina.currentStamina, max: stamina.maxStamina, fatigueLevel: stamina.fatigueLevel, effects: stamina.effects },
    awakening: { stage: Number(p.awakening_stage || 0), bonuses: awakening, aura: awakeningRules.AURAS[Number(p.awakening_stage || 0)],
      skill: awakeningRules.awakeningSkill(Number(p.awakening_stage || 0), p.type1) },
    training: training,
    moves: {
      fast: p.fast_move ? { moveId: p.fast_move, mastery: mMap.get(p.fast_move) || null } : null,
      charge: p.charge_move ? { moveId: p.charge_move, mastery: mMap.get(p.charge_move) || null } : null,
    },
    bondSkill: bond,
    canBattle: !p.occupied_by && stamina.currentStamina > 0,
    busy: p.occupied_by || null,
  };
}

module.exports = { combine, profile };
