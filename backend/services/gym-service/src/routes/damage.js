/**
 * REQ-00146: 伤害计算路由
 * 创建时间: 2026-06-15 22:12
 * 
 * 提供伤害模拟计算和属性克制查询 API
 */

const express = require('express');
const router = express.Router();
const { calculateDamage, estimateAverageDamage, WEATHER_BOOST_MAP } = require('../../../shared/damageCalculator');
const { TYPE_CHART, getTypeMultiplier, getAllTypes, isValidType } = require('../../../shared/typeChart');
const { requireAuth, successResp, AppError } = require('../../../shared/auth');
const { query } = require('../../../shared/db');
const logger = require('../../../shared/logger');

/**
 * POST /gym/damage/simulate - 伤害模拟计算
 * 
 * 请求体:
 * {
 *   attacker: {
 *     species_id: number,
 *     attack: number,
 *     fast_move?: string,
 *     charged_move?: string
 *   },
 *   defender: {
 *     species_id: number,
 *     defense: number
 *   },
 *   weather?: string
 * }
 */
router.post('/simulate', requireAuth, async (req, res, next) => {
  try {
    const { attacker, defender, weather } = req.body;
    
    // 参数验证
    if (!attacker || !defender) {
      throw new AppError(3001, '缺少攻击者或防御者参数', 400);
    }
    
    if (!attacker.species_id || !attacker.attack) {
      throw new AppError(3002, '攻击者参数不完整', 400);
    }
    
    if (!defender.species_id || !defender.defense) {
      throw new AppError(3003, '防御者参数不完整', 400);
    }

    // 获取攻击者精灵数据
    const { rows: attackerRows } = await query(
      'SELECT id, name, type1, type2 FROM pokemon_species WHERE id = $1',
      [attacker.species_id]
    );
    
    if (attackerRows.length === 0) {
      throw new AppError(3004, '攻击者精灵不存在', 404);
    }
    const attackerSpecies = attackerRows[0];

    // 获取防御者精灵数据
    const { rows: defenderRows } = await query(
      'SELECT id, name, type1, type2 FROM pokemon_species WHERE id = $1',
      [defender.species_id]
    );
    
    if (defenderRows.length === 0) {
      throw new AppError(3005, '防御者精灵不存在', 404);
    }
    const defenderSpecies = defenderRows[0];

    // 获取快速技能数据
    let moveName = attacker.fast_move || 'tackle';
    const { rows: moveRows } = await query(
      'SELECT name, type, power, energy_cost, duration_ms FROM moves WHERE name = $1',
      [moveName]
    );
    
    let moveData = moveRows[0];
    if (!moveData) {
      // 默认技能
      moveData = { name: 'tackle', type: 'normal', power: 35, energy_cost: 0, duration_ms: 500 };
    }

    // 计算伤害
    const damageResult = calculateDamage({
      power: moveData.power,
      attack: attacker.attack,
      defense: defender.defense,
      attackType: moveData.type,
      attackerType1: attackerSpecies.type1,
      attackerType2: attackerSpecies.type2,
      defenderType1: defenderSpecies.type1,
      defenderType2: defenderSpecies.type2,
      weatherBoost: weather || null
    });

    // 估算平均伤害
    const averageDamage = estimateAverageDamage({
      power: moveData.power,
      attack: attacker.attack,
      defense: defender.defense,
      attackType: moveData.type,
      attackerType1: attackerSpecies.type1,
      attackerType2: attackerSpecies.type2,
      defenderType1: defenderSpecies.type1,
      defenderType2: defenderSpecies.type2,
      weatherBoost: weather || null
    });

    logger.info('Damage simulation completed', {
      userId: req.user?.id,
      attacker: attackerSpecies.name,
      defender: defenderSpecies.name,
      move: moveData.name,
      damage: damageResult.damage
    });

    res.json(successResp({
      attacker: {
        species_id: attackerSpecies.id,
        name: attackerSpecies.name,
        types: [attackerSpecies.type1, attackerSpecies.type2].filter(Boolean)
      },
      defender: {
        species_id: defenderSpecies.id,
        name: defenderSpecies.name,
        types: [defenderSpecies.type1, defenderSpecies.type2].filter(Boolean)
      },
      move: {
        name: moveData.name,
        type: moveData.type,
        power: moveData.power
      },
      damage: damageResult.damage,
      damageMultiplier: damageResult.typeMultiplier,
      effectiveness: damageResult.effectiveness,
      isImmune: damageResult.isImmune,
      hasStab: damageResult.stab > 1,
      weatherBoosted: damageResult.weatherMultiplier > 1,
      averageDamage,
      breakdown: damageResult.breakdown
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /gym/damage/typechart - 获取属性克制表
 */
router.get('/typechart', async (req, res, next) => {
  try {
    res.json(successResp({
      types: getAllTypes(),
      chart: TYPE_CHART,
      totalTypes: Object.keys(TYPE_CHART).length
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /gym/damage/effectiveness - 查询特定属性克制关系
 * 
 * 查询参数:
 * - attackType: 攻击属性
 * - defenderType1: 防御者主属性
 * - defenderType2: 防御者副属性(可选)
 */
router.get('/effectiveness', async (req, res, next) => {
  try {
    const { attackType, defenderType1, defenderType2 } = req.query;
    
    if (!attackType || !defenderType1) {
      throw new AppError(3006, '缺少必要参数', 400);
    }
    
    if (!isValidType(attackType)) {
      throw new AppError(3007, `无效的攻击属性: ${attackType}`, 400);
    }
    
    if (!isValidType(defenderType1)) {
      throw new AppError(3008, `无效的防御属性: ${defenderType1}`, 400);
    }
    
    if (defenderType2 && !isValidType(defenderType2)) {
      throw new AppError(3009, `无效的防御属性: ${defenderType2}`, 400);
    }
    
    const multiplier = getTypeMultiplier(attackType, defenderType1, defenderType2 || null);
    
    res.json(successResp({
      attackType,
      defenderType1,
      defenderType2: defenderType2 || null,
      multiplier,
      description: getEffectivenessDescription(multiplier)
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /gym/damage/weather - 获取天气加成信息
 */
router.get('/weather', async (req, res, next) => {
  try {
    res.json(successResp({
      weatherBoosts: WEATHER_BOOST_MAP,
      description: '天气会提升特定属性技能的伤害 20%'
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * 辅助函数: 获取效果描述
 */
function getEffectivenessDescription(multiplier) {
  if (multiplier === 0) return '免疫 - 无效果';
  if (multiplier >= 4) return '极度有效 - 4倍伤害';
  if (multiplier >= 2) return '效果拔群 - 2倍伤害';
  if (multiplier > 1) return '效果不错';
  if (multiplier === 1) return '正常伤害';
  if (multiplier >= 0.5) return '效果不佳 - 0.5倍伤害';
  if (multiplier > 0) return '几乎无效';
  return '未知';
}

module.exports = router;
