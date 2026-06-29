/**
 * REQ-00086: 捕捉时特性分配集成模块
 * 在精灵被成功捕捉时自动分配特性
 */

const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

class AbilityIntegration {
  constructor() {
    this.abilityService = null;
    this.loadAttempted = false;
  }

  /**
   * 确保特性服务已加载
   */
  async ensureAbilityService() {
    if (this.abilityService) {
      return true;
    }
    
    if (this.loadAttempted) {
      return false;
    }
    
    this.loadAttempted = true;
    
    try {
      const AbilityService = require('../../pokemon-service/src/abilityService');
      this.abilityService = new AbilityService();
      logger.info('AbilityService loaded for catch integration');
      return true;
    } catch (error) {
      logger.warn('AbilityService not available for catch integration', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * 为新捕捉的精灵分配特性
   * 
   * @param {number} playerPokemonId - 玩家精灵实例ID
   * @param {string} speciesId - 精灵种类ID
   * @param {Object} options - 分配选项
   * @param {boolean} options.isEventSpawn - 是否为活动刷新（增加隐藏特性概率）
   * @param {boolean} options.forceHidden - 是否强制分配隐藏特性
   * @param {number} options.hiddenChanceOverride - 自定义隐藏特性概率
   * @returns {Promise<Array>} 分配的特性列表
   */
  async assignAbilitiesOnCatch(playerPokemonId, speciesId, options = {}) {
    const { isEventSpawn = false, forceHidden = false, hiddenChanceOverride } = options;
    
    // 计算隐藏特性概率
    let hiddenChance = hiddenChanceOverride ?? 0.01; // 默认 1%
    
    if (isEventSpawn) {
      hiddenChance = 0.05; // 活动刷新 5%
    }
    
    if (forceHidden) {
      hiddenChance = 1.0; // 强制 100%
    }
    
    if (!await this.ensureAbilityService()) {
      logger.warn('Cannot assign abilities: AbilityService not available', {
        playerPokemonId,
        speciesId
      });
      return [];
    }
    
    try {
      const abilities = await this.abilityService.assignAbilitiesToPokemon(
        playerPokemonId,
        speciesId,
        { hiddenChance, forceHidden }
      );
      
      // 记录指标
      if (abilities.length > 0) {
        metrics.gauge('catch_ability_assigned', 1, {
          species: speciesId,
          has_hidden: abilities.some(a => a.isHidden).toString()
        });
      }
      
      logger.info('Abilities assigned on catch', {
        playerPokemonId,
        speciesId,
        abilities: abilities.map(a => a.id),
        hasHidden: abilities.some(a => a.isHidden)
      });
      
      return abilities;
    } catch (error) {
      logger.error('Failed to assign abilities on catch', {
        playerPokemonId,
        speciesId,
        error: error.message
      });
      
      // 特性分配失败不应该阻止捕捉成功
      return [];
    }
  }

  /**
   * 获取精灵种类的特性信息（用于预览）
   * 
   * @param {string} speciesId - 精灵种类ID
   * @returns {Promise<Object>} 特性信息
   */
  async getSpeciesAbilityInfo(speciesId) {
    if (!await this.ensureAbilityService()) {
      return null;
    }
    
    try {
      const abilities = await this.abilityService.getPokemonAbilities(speciesId);
      
      return {
        normal: abilities.normal.map(a => ({
          id: a.id,
          nameZh: a.nameZh,
          nameEn: a.nameEn,
          description: a.description,
          probability: a.probability
        })),
        hidden: abilities.hidden ? {
          id: abilities.hidden.id,
          nameZh: abilities.hidden.nameZh,
          nameEn: abilities.hidden.nameEn,
          description: abilities.hidden.description,
          chance: '1%' // 默认隐藏特性概率
        } : null
      };
    } catch (error) {
      logger.error('Failed to get species ability info', {
        speciesId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * 检查精灵是否有隐藏特性
   * 
   * @param {number} playerPokemonId - 玩家精灵实例ID
   * @returns {Promise<boolean>}
   */
  async hasHiddenAbility(playerPokemonId) {
    if (!await this.ensureAbilityService()) {
      return false;
    }
    
    try {
      const abilities = await this.abilityService.getPlayerPokemonAbilities(playerPokemonId);
      return abilities.some(a => a.isHidden && a.unlockedAt);
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取精灵的激活特性
   * 
   * @param {number} playerPokemonId - 玩家精灵实例ID
   * @returns {Promise<Object|null>}
   */
  async getActiveAbility(playerPokemonId) {
    if (!await this.ensureAbilityService()) {
      return null;
    }
    
    try {
      return await this.abilityService.getActiveAbility(playerPokemonId);
    } catch (error) {
      return null;
    }
  }
}

// 单例实例
let instance = null;

function getAbilityIntegration() {
  if (!instance) {
    instance = new AbilityIntegration();
  }
  return instance;
}

module.exports = {
  AbilityIntegration,
  getAbilityIntegration
};
