/**
 * REQ-00086 & REQ-00607: 特性战斗集成模块
 * 在战斗中自动触发和计算特性效果
 * 已重构：使用 ServiceClient 调用 pokemon-service API
 */

const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');
const ServiceClient = require('../../../shared/ServiceClient');

class AbilityBattleIntegration {
  constructor(battleEngine, options = {}) {
    this.battleEngine = battleEngine;
    this.serviceClient = options.serviceClient || new ServiceClient({
      serviceName: 'gym-service'
    });
    this.abilityCache = new Map();
    this.cacheExpiry = 60000; // 缓存 1 分钟
  }

  /**
   * 战斗开始时处理特性
   * 检查并触发出场特性（如威吓、降雨、日照等）
   */
  async onBattleStart(battle) {
    const effects = [];
    
    for (const participant of battle.participants) {
      const pokemon = participant.pokemon;
      
      try {
        // 获取激活特性
        const activeAbility = await this.getActiveAbility(pokemon.id);
        
        if (!activeAbility) continue;
        
        // 检查出场触发特性
        if (activeAbility.triggers && activeAbility.triggers.includes('on_enter')) {
          const abilityEffects = await this.applyAbilityEffect(
            activeAbility.abilityId,
            { pokemonId: pokemon.id, ...pokemon },
            battle
          );
          
          if (abilityEffects && abilityEffects.length > 0) {
            effects.push({
              pokemonId: pokemon.id,
              abilityId: activeAbility.abilityId,
              abilityName: activeAbility.name,
              effects: abilityEffects
            });
            
            // 处理特性效果
            await this.processAbilityEffects(battle, abilityEffects, participant);
            
            metrics.gauge('gym_ability_triggered', 1, {
              ability: activeAbility.abilityId,
              trigger: 'on_enter'
            });
          }
        }
        
      } catch (error) {
        logger.error('Failed to process ability on battle start', {
          pokemonId: pokemon.id,
          error: error.message
        });
      }
    }
    
    return effects;
  }

  /**
   * 获取精灵的激活特性
   * 
   * @param {number} playerPokemonId - 玩家精灵实例ID
   * @returns {Promise<Object|null>}
   */
  async getActiveAbility(playerPokemonId) {
    // 检查缓存
    const cached = this.abilityCache.get(playerPokemonId);
    if (cached && cached.expiry > Date.now()) {
      return cached.data;
    }
    
    try {
      // 调用 pokemon-service 内部 API
      const result = await this.serviceClient.get(
        'pokemon-service',
        `/internal/ability/active/${playerPokemonId}`,
        { timeout: 3000, maxRetries: 1 }
      );
      
      // 缓存结果
      this.abilityCache.set(playerPokemonId, {
        data: result,
        expiry: Date.now() + this.cacheExpiry
      });
      
      return result;
      
    } catch (error) {
      logger.error('Failed to get active ability', {
        playerPokemonId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * 应用特性效果
   * 
   * @param {string} abilityId - 特性ID
   * @param {Object} sourcePokemon - 源精灵
   * @param {Object} battle - 战斗上下文
   * @returns {Promise<Array>} 效果列表
   */
  async applyAbilityEffect(abilityId, sourcePokemon, battle) {
    try {
      const result = await this.serviceClient.post(
        'pokemon-service',
        '/internal/ability/battle-effect',
        {
          abilityId,
          context: {
            sourceId: sourcePokemon.pokemonId,
            battleId: battle.id,
            turn: battle.currentTurn || 1
          }
        },
        { timeout: 3000 }
      );
      
      return [result];
      
    } catch (error) {
      logger.error('Failed to apply ability effect', {
        abilityId,
        sourcePokemon: sourcePokemon.pokemonId,
        error: error.message
      });
      return [];
    }
  }

  /**
   * 处理特性效果
   */
  async processAbilityEffects(battle, effects, sourceParticipant) {
    for (const effect of effects) {
      switch (effect.type) {
        case 'stat_change':
          await this.applyStatChange(battle, effect, sourceParticipant);
          break;
        
        case 'weather':
          await this.applyWeatherEffect(battle, effect);
          break;
        
        case 'terrain':
          await this.applyTerrainEffect(battle, effect);
          break;
        
        case 'status':
          await this.applyStatusEffect(battle, effect, sourceParticipant);
          break;
        
        default:
          logger.warn('Unknown ability effect type', { type: effect.type });
      }
    }
  }

  /**
   * 应用状态效果
   */
  async applyStatusEffect(battle, effect, sourceParticipant) {
    try {
      // 调用 pokemon-service 应用状态效果
      const result = await this.serviceClient.post(
        'pokemon-service',
        '/internal/status-effect/apply',
        {
          targetId: effect.targetId,
          effectId: effect.effect,
          sourceId: sourceParticipant.pokemon.id,
          battleId: battle.id
        },
        { timeout: 3000 }
      );
      
      if (result.applied) {
        logger.info('Status effect applied via ServiceClient', {
          effect: effect.effect,
          targetId: effect.targetId,
          battleId: battle.id
        });
        
        // 更新战斗状态
        if (!battle.statusEffects) {
          battle.statusEffects = [];
        }
        battle.statusEffects.push(result);
      }
      
    } catch (error) {
      logger.error('Failed to apply status effect', {
        effect: effect.effect,
        error: error.message
      });
    }
  }

  /**
   * 应用属性变化
   */
  async applyStatChange(battle, effect, sourceParticipant) {
    // 在战斗引擎中实现
    if (this.battleEngine && this.battleEngine.applyStatModifier) {
      await this.battleEngine.applyStatModifier(
        effect.targetId || sourceParticipant.pokemon.id,
        effect.stat,
        effect.modifier
      );
    }
  }

  /**
   * 应用天气效果
   */
  async applyWeatherEffect(battle, effect) {
    if (battle) {
      battle.weather = {
        type: effect.weather,
        turns: effect.duration || 5,
        source: 'ability'
      };
      
      logger.info('Weather effect applied', {
        weather: effect.weather,
        battleId: battle.id
      });
    }
  }

  /**
   * 应用场地效果
   */
  async applyTerrainEffect(battle, effect) {
    if (battle) {
      battle.terrain = {
        type: effect.terrain,
        turns: effect.duration || 5,
        source: 'ability'
      };
      
      logger.info('Terrain effect applied', {
        terrain: effect.terrain,
        battleId: battle.id
      });
    }
  }

  /**
   * 回合结束时处理特性
   */
  async onTurnEnd(battle) {
    const effects = [];
    
    for (const participant of battle.participants) {
      try {
        const activeAbility = await this.getActiveAbility(participant.pokemon.id);
        
        if (activeAbility && activeAbility.triggers && activeAbility.triggers.includes('on_turn_end')) {
          const abilityEffects = await this.applyAbilityEffect(
            activeAbility.abilityId,
            { pokemonId: participant.pokemon.id },
            battle
          );
          
          if (abilityEffects && abilityEffects.length > 0) {
            effects.push({
              pokemonId: participant.pokemon.id,
              abilityId: activeAbility.abilityId,
              effects: abilityEffects
            });
          }
        }
        
      } catch (error) {
        logger.error('Failed to process ability on turn end', {
          pokemonId: participant.pokemon.id,
          error: error.message
        });
      }
    }
    
    return effects;
  }

  /**
   * 战斗结束时处理特性
   */
  async onBattleEnd(battle, winner) {
    // 清理缓存
    for (const participant of battle.participants) {
      this.abilityCache.delete(participant.pokemon.id);
    }
    
    logger.info('Ability battle integration cleaned up', {
      battleId: battle.id
    });
  }

  /**
   * 清除缓存
   */
  clearCache(playerPokemonId) {
    if (playerPokemonId) {
      this.abilityCache.delete(playerPokemonId);
    } else {
      this.abilityCache.clear();
    }
  }
}

module.exports = AbilityBattleIntegration;
