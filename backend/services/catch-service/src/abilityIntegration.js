/**
 * REQ-00086 & REQ-00607: 捕捉时特性分配集成模块
 * 在精灵被成功捕捉时自动分配特性
 * 已重构：使用 ServiceClient 调用 pokemon-service API
 */

const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');
const ServiceClient = require('../../../shared/ServiceClient');

class AbilityIntegration {
  constructor(options = {}) {
    this.serviceClient = options.serviceClient || new ServiceClient({
      serviceName: 'catch-service'
    });
    this.initialized = false;
  }

  /**
   * 初始化服务客户端
   */
  async initialize() {
    if (this.initialized) {
      return true;
    }
    
    try {
      // 注册到服务发现
      if (process.env.SERVICE_DISCOVERY_ENABLED === 'true') {
        const { ServiceDiscoveryClient } = require('../../../shared/serviceDiscovery/ServiceDiscoveryClient');
        const discoveryClient = new ServiceDiscoveryClient();
        
        await discoveryClient.register('catch-service', {
          host: process.env.SERVICE_HOST || 'localhost',
          port: parseInt(process.env.SERVICE_PORT || '3003'),
          version: process.env.SERVICE_VERSION || '1.0.0'
        });
        
        logger.info('Catch-service registered to service discovery');
      }
      
      this.initialized = true;
      return true;
      
    } catch (error) {
      logger.warn('Failed to initialize ability integration', {
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
    
    try {
      // 调用 pokemon-service 内部 API
      const result = await this.serviceClient.post(
        'pokemon-service',
        '/internal/ability/assign',
        {
          playerPokemonId,
          speciesId,
          isEventSpawn,
          forceHidden,
          hiddenChanceOverride
        },
        {
          timeout: 5000,
          maxRetries: 2
        }
      );
      
      // 记录指标
      if (result) {
        metrics.gauge('catch_ability_assigned', 1, {
          species: speciesId,
          has_hidden: result.hidden ? 'true' : 'false'
        });
      }
      
      logger.info('Abilities assigned on catch via ServiceClient', {
        playerPokemonId,
        speciesId,
        abilityId: result.abilityId,
        hidden: result.hidden
      });
      
      // 转换为兼容格式
      return [{
        id: result.abilityId,
        slot: result.slot,
        isHidden: result.hidden,
        assignedAt: result.assignedAt
      }];
      
    } catch (error) {
      logger.error('Failed to assign abilities on catch', {
        playerPokemonId,
        speciesId,
        error: error.message
      });
      
      // 特性分配失败不应该阻止捕捉成功
      // 降级返回空数组
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
    try {
      const result = await this.serviceClient.get(
        'pokemon-service',
        `/internal/ability/info/${speciesId}`,
        { timeout: 3000 }
      );
      
      return result;
      
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
    try {
      const result = await this.serviceClient.get(
        'pokemon-service',
        `/internal/ability/check-hidden/${playerPokemonId}`,
        { timeout: 3000 }
      );
      
      return result.hasHidden;
      
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
    try {
      return await this.serviceClient.get(
        'pokemon-service',
        `/internal/ability/active/${playerPokemonId}`,
        { timeout: 3000 }
      );
      
    } catch (error) {
      return null;
    }
  }
}

// 单例实例
let instance = null;

function getAbilityIntegration(options = {}) {
  if (!instance) {
    instance = new AbilityIntegration(options);
  }
  return instance;
}

module.exports = {
  AbilityIntegration,
  getAbilityIntegration
};
