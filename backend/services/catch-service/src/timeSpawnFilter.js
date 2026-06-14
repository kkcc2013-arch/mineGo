'use strict';

const timePeriodManager = require('../../../shared/TimePeriodManager');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('time-spawn-filter');

/**
 * 精灵时段刷新过滤器
 * REQ-00102: 精灵昼夜循环系统
 */
class TimeSpawnFilter {
  /**
   * 根据当前时段过滤可用精灵
   * @param {Array} pokemonList - 候选精灵列表
   * @param {string} periodId - 时段ID
   * @returns {Array} 过滤后的精灵列表（含刷新权重）
   */
  async filterByPeriod(pokemonList, periodId) {
    if (!pokemonList || pokemonList.length === 0) return [];
    
    // 批量获取刷新倍率
    const pokemonIds = pokemonList.map(p => p.id || p.pokemon_id);
    const multipliers = await timePeriodManager.getBatchSpawnMultipliers(pokemonIds, periodId);
    
    const filteredList = [];
    
    for (const pokemon of pokemonList) {
      const pokemonId = pokemon.id || pokemon.pokemon_id;
      const spawnConfig = multipliers.get(pokemonId) || { spawn_multiplier: 1.0, is_exclusive: false };
      
      // 如果是独占精灵，检查是否在正确时段
      if (spawnConfig.is_exclusive) {
        filteredList.push({
          ...pokemon,
          spawn_weight: (pokemon.spawn_weight || 1.0) * spawnConfig.spawn_multiplier,
          is_period_exclusive: true
        });
      } else {
        // 非独占精灵，应用刷新倍率
        const adjustedWeight = (pokemon.spawn_weight || 1.0) * spawnConfig.spawn_multiplier;
        
        if (adjustedWeight > 0) {
          filteredList.push({
            ...pokemon,
            spawn_weight: adjustedWeight,
            is_period_exclusive: false
          });
        }
      }
    }
    
    logger.debug({ 
      periodId, 
      input: pokemonList.length, 
      output: filteredList.length 
    }, 'Filtered pokemon by time period');
    
    return filteredList;
  }

  /**
   * 为精灵添加时段属性加成
   */
  async applyTimeBonuses(pokemon, periodId) {
    if (!pokemon || !pokemon.types || !Array.isArray(pokemon.types)) {
      return {
        ...pokemon,
        time_bonuses: {
          attack_multiplier: 1.0,
          defense_multiplier: 1.0,
          experience_multiplier: 1.0,
          period_id: periodId
        }
      };
    }
    
    let attackBonus = 1.0;
    let defenseBonus = 1.0;
    let speedBonus = 1.0;
    let expBonus = 1.0;
    
    for (const type of pokemon.types) {
      const bonus = await timePeriodManager.getTypeBonus(type.toLowerCase(), periodId);
      
      if (bonus.stat_bonus) {
        if (bonus.stat_bonus.attack) {
          attackBonus = Math.max(attackBonus, bonus.stat_bonus.attack);
        }
        if (bonus.stat_bonus.defense) {
          defenseBonus = Math.max(defenseBonus, bonus.stat_bonus.defense);
        }
        if (bonus.stat_bonus.speed) {
          speedBonus = Math.max(speedBonus, bonus.stat_bonus.speed);
        }
      }
      
      if (bonus.experience_bonus) {
        expBonus = Math.max(expBonus, bonus.experience_bonus);
      }
    }
    
    return {
      ...pokemon,
      time_bonuses: {
        attack_multiplier: attackBonus,
        defense_multiplier: defenseBonus,
        speed_multiplier: speedBonus,
        experience_multiplier: expBonus,
        period_id: periodId
      }
    };
  }

  /**
   * 检查精灵是否可以在当前时段出现
   */
  async canSpawnInPeriod(pokemonId, periodId) {
    const spawnConfig = await timePeriodManager.getPokemonSpawnMultiplier(pokemonId, periodId);
    
    // 如果是独占精灵，只有在正确时段才能出现
    if (spawnConfig.is_exclusive) {
      return true;
    }
    
    // 如果刷新倍率为 0，则不能出现
    return spawnConfig.spawn_multiplier > 0;
  }

  /**
   * 获取时段专属精灵列表
   */
  async getPeriodExclusivePokemon(periodId) {
    const specialPokemon = await timePeriodManager.getPeriodSpecialPokemon(periodId);
    return specialPokemon.filter(p => p.is_exclusive);
  }

  /**
   * 计算最终捕捉经验（含时段加成）
   */
  calculateCatchExperience(baseExperience, pokemon, periodId) {
    if (!pokemon.time_bonuses || pokemon.time_bonuses.period_id !== periodId) {
      return baseExperience;
    }
    
    return Math.floor(baseExperience * pokemon.time_bonuses.experience_multiplier);
  }

  /**
   * 应用时段属性加成到战斗属性
   */
  applyCombatBonuses(baseStats, pokemon, periodId) {
    if (!pokemon.time_bonuses || pokemon.time_bonuses.period_id !== periodId) {
      return baseStats;
    }
    
    return {
      attack: Math.floor(baseStats.attack * pokemon.time_bonuses.attack_multiplier),
      defense: Math.floor(baseStats.defense * pokemon.time_bonuses.defense_multiplier),
      speed: Math.floor((baseStats.speed || 100) * (pokemon.time_bonuses.speed_multiplier || 1.0))
    };
  }
}

module.exports = new TimeSpawnFilter();
