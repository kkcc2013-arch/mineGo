/**
 * REQ-00086: 精灵特性服务
 * 实现特性分配、切换、解锁和战斗触发逻辑
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

class AbilityService {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.redis = new Redis(process.env.REDIS_URL);
    this.abilityCache = new Map();
    this.triggerHandlers = new Map();
    
    this.loadAbilityCache();
    this.registerTriggerHandlers();
  }

  /**
   * 加载特性缓存
   */
  async loadAbilityCache() {
    try {
      const result = await this.db.query('SELECT * FROM abilities');
      
      for (const ability of result.rows) {
        this.abilityCache.set(ability.id, ability);
      }
      
      logger.info('Ability cache loaded', { count: this.abilityCache.size });
      if (metrics && metrics.gauge) {
        metrics.gauge('pokemon_ability_cache_size', this.abilityCache.size);
      }
    } catch (error) {
      logger.error('Failed to load ability cache', { error: error.message });
    }
  }

  /**
   * 获取特性定义
   */
  getAbility(abilityId) {
    return this.abilityCache.get(abilityId);
  }

  /**
   * 获取所有特性
   */
  getAllAbilities() {
    return Array.from(this.abilityCache.values());
  }

  /**
   * 获取精灵可选特性
   */
  async getPokemonAbilities(speciesId) {
    const cacheKey = `pokemon_abilities:${speciesId}`;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    const result = await this.db.query(`
      SELECT pa.*, a.name_en, a.name_zh, a.type, a.description, a.is_hidden
      FROM pokemon_abilities pa
      JOIN abilities a ON pa.ability_id = a.id
      WHERE pa.pokemon_species_id = $1
      ORDER BY pa.slot
    `, [speciesId]);
    
    const abilities = {
      normal: [],
      hidden: null
    };
    
    for (const row of result.rows) {
      const ability = {
        id: row.ability_id,
        nameEn: row.name_en,
        nameZh: row.name_zh,
        type: row.type,
        description: row.description,
        slot: row.slot,
        probability: row.probability
      };
      
      if (row.is_hidden || row.slot === 3) {
        abilities.hidden = ability;
      } else {
        abilities.normal.push(ability);
      }
    }
    
    await this.redis.setex(cacheKey, 3600, JSON.stringify(abilities));
    return abilities;
  }

  /**
   * 为新捕捉的精灵分配特性
   */
  async assignAbilitiesToPokemon(playerPokemonId, speciesId, options = {}) {
    const { forceHidden = false, hiddenChance = 0.01 } = options;
    const abilities = await this.getPokemonAbilities(speciesId);
    
    const assignedAbilities = [];
    
    // 分配普通特性
    if (abilities.normal.length > 0) {
      // 根据概率随机选择一个普通特性激活
      let selectedIndex = 0;
      if (abilities.normal.length > 1) {
        const rand = Math.random();
        let cumulative = 0;
        for (let i = 0; i < abilities.normal.length; i++) {
          cumulative += abilities.normal[i].probability;
          if (rand < cumulative) {
            selectedIndex = i;
            break;
          }
        }
      }
      
      // 插入所有普通特性，但只激活一个
      for (let i = 0; i < abilities.normal.length; i++) {
        await this.db.query(`
          INSERT INTO player_pokemon_abilities 
          (player_pokemon_id, ability_id, slot, is_active, is_hidden)
          VALUES ($1, $2, $3, $4, FALSE)
        `, [playerPokemonId, abilities.normal[i].id, i + 1, i === selectedIndex]);
        
        if (i === selectedIndex) {
          assignedAbilities.push({
            ...abilities.normal[i],
            isActive: true
          });
        }
      }
    }
    
    // 分配隐藏特性（小概率或强制）
    if (abilities.hidden) {
      const hasHidden = forceHidden || Math.random() < hiddenChance;
      
      await this.db.query(`
        INSERT INTO player_pokemon_abilities 
        (player_pokemon_id, ability_id, slot, is_active, is_hidden, unlocked_at)
        VALUES ($1, $2, 3, FALSE, TRUE, $3)
      `, [playerPokemonId, abilities.hidden.id, hasHidden ? new Date() : null]);
      
      if (hasHidden) {
        assignedAbilities.push({
          ...abilities.hidden,
          isActive: false,
          isHidden: true,
          unlocked: true
        });
      }
    }
    
    logger.info('Abilities assigned', {
      playerPokemonId,
      speciesId,
      abilities: assignedAbilities.map(a => a.id)
    });
    
    return assignedAbilities;
  }

  /**
   * 获取玩家精灵的特性列表
   */
  async getPlayerPokemonAbilities(playerPokemonId) {
    const result = await this.db.query(`
      SELECT ppa.*, a.name_en, a.name_zh, a.type, a.description, a.effect_config
      FROM player_pokemon_abilities ppa
      JOIN abilities a ON ppa.ability_id = a.id
      WHERE ppa.player_pokemon_id = $1
      ORDER BY ppa.slot
    `, [playerPokemonId]);
    
    return result.rows.map(row => ({
      id: row.ability_id,
      nameEn: row.name_en,
      nameZh: row.name_zh,
      type: row.type,
      description: row.description,
      effectConfig: row.effect_config,
      slot: row.slot,
      isActive: row.is_active,
      isHidden: row.is_hidden,
      unlockedAt: row.unlocked_at
    }));
  }

  /**
   * 获取激活的特性
   */
  async getActiveAbility(playerPokemonId) {
    const result = await this.db.query(`
      SELECT ppa.*, a.name_en, a.name_zh, a.type, a.description, a.effect_config, a.trigger_condition
      FROM player_pokemon_abilities ppa
      JOIN abilities a ON ppa.ability_id = a.id
      WHERE ppa.player_pokemon_id = $1 AND ppa.is_active = TRUE
    `, [playerPokemonId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const row = result.rows[0];
    return {
      id: row.ability_id,
      nameEn: row.name_en,
      nameZh: row.name_zh,
      type: row.type,
      description: row.description,
      effectConfig: row.effect_config,
      triggerCondition: row.trigger_condition,
      isHidden: row.is_hidden
    };
  }

  /**
   * 切换精灵的普通特性
   */
  async switchAbility(playerPokemonId, targetSlot) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前激活的特性
      const currentResult = await client.query(`
        SELECT * FROM player_pokemon_abilities
        WHERE player_pokemon_id = $1 AND is_active = TRUE AND is_hidden = FALSE
      `, [playerPokemonId]);
      
      if (currentResult.rows.length === 0) {
        throw new Error('No active ability found');
      }
      
      const current = currentResult.rows[0];
      
      // 检查目标槽位是否存在
      const targetResult = await client.query(`
        SELECT * FROM player_pokemon_abilities
        WHERE player_pokemon_id = $1 AND slot = $2 AND is_hidden = FALSE
        FOR UPDATE
      `, [playerPokemonId, targetSlot]);
      
      if (targetResult.rows.length === 0) {
        throw new Error(`Target slot ${targetSlot} not found`);
      }
      
      const target = targetResult.rows[0];
      
      if (current.slot === targetSlot) {
        throw new Error('Target ability is already active');
      }
      
      // 切换激活状态
      await client.query(`
        UPDATE player_pokemon_abilities
        SET is_active = FALSE
        WHERE player_pokemon_id = $1 AND is_hidden = FALSE
      `, [playerPokemonId]);
      
      await client.query(`
        UPDATE player_pokemon_abilities
        SET is_active = TRUE
        WHERE id = $1
      `, [target.id]);
      
      await client.query('COMMIT');
      
      const ability = this.abilityCache.get(target.ability_id);
      
      logger.info('Ability switched', {
        playerPokemonId,
        fromAbility: current.ability_id,
        toAbility: target.ability_id
      });
      
      return {
        success: true,
        newAbility: {
          id: target.ability_id,
          nameEn: ability?.name_en,
          nameZh: ability?.name_zh
        }
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 解锁隐藏特性
   */
  async unlockHiddenAbility(playerPokemonId) {
    const result = await this.db.query(`
      SELECT ppa.*, a.name_en, a.name_zh
      FROM player_pokemon_abilities ppa
      JOIN abilities a ON ppa.ability_id = a.id
      WHERE ppa.player_pokemon_id = $1 AND ppa.is_hidden = TRUE
    `, [playerPokemonId]);
    
    if (result.rows.length === 0) {
      throw new Error('No hidden ability found for this Pokemon');
    }
    
    const hiddenAbility = result.rows[0];
    
    if (hiddenAbility.unlocked_at) {
      throw new Error('Hidden ability already unlocked');
    }
    
    await this.db.query(`
      UPDATE player_pokemon_abilities
      SET unlocked_at = CURRENT_TIMESTAMP, is_active = TRUE
      WHERE id = $1
    `, [hiddenAbility.id]);
    
    // 停用普通特性
    await this.db.query(`
      UPDATE player_pokemon_abilities
      SET is_active = FALSE
      WHERE player_pokemon_id = $1 AND is_hidden = FALSE
    `, [playerPokemonId]);
    
    logger.info('Hidden ability unlocked', {
      playerPokemonId,
      abilityId: hiddenAbility.ability_id
    });
    
    return {
      success: true,
      ability: {
        id: hiddenAbility.ability_id,
        nameEn: hiddenAbility.name_en,
        nameZh: hiddenAbility.name_zh,
        isHidden: true
      }
    };
  }

  /**
   * 激活隐藏特性
   */
  async activateHiddenAbility(playerPokemonId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 检查隐藏特性是否已解锁
      const hiddenResult = await client.query(`
        SELECT * FROM player_pokemon_abilities
        WHERE player_pokemon_id = $1 AND is_hidden = TRUE AND unlocked_at IS NOT NULL
        FOR UPDATE
      `, [playerPokemonId]);
      
      if (hiddenResult.rows.length === 0) {
        throw new Error('Hidden ability not unlocked');
      }
      
      const hidden = hiddenResult.rows[0];
      
      // 停用普通特性
      await client.query(`
        UPDATE player_pokemon_abilities
        SET is_active = FALSE
        WHERE player_pokemon_id = $1 AND is_hidden = FALSE
      `, [playerPokemonId]);
      
      // 激活隐藏特性
      await client.query(`
        UPDATE player_pokemon_abilities
        SET is_active = TRUE
        WHERE id = $1
      `, [hidden.id]);
      
      await client.query('COMMIT');
      
      const ability = this.abilityCache.get(hidden.ability_id);
      
      logger.info('Hidden ability activated', {
        playerPokemonId,
        abilityId: hidden.ability_id
      });
      
      return {
        success: true,
        ability: {
          id: hidden.ability_id,
          nameEn: ability?.name_en,
          nameZh: ability?.name_zh
        }
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 检查特性触发条件
   */
  checkTriggerCondition(ability, context) {
    const triggerCondition = ability.triggerCondition || ability.trigger_condition;
    
    if (!triggerCondition || ability.type === 'passive') {
      return { canTrigger: true, reason: 'passive' };
    }
    
    switch (triggerCondition.type) {
      case 'hp_threshold':
        const hpPercent = context.currentHp / context.maxHp;
        return {
          canTrigger: hpPercent <= triggerCondition.threshold,
          reason: hpPercent <= triggerCondition.threshold ? 'hp_below_threshold' : 'hp_above_threshold'
        };
        
      case 'has_status':
        return {
          canTrigger: context.statusEffects && context.statusEffects.length > 0,
          reason: 'has_status'
        };
        
      case 'status_condition':
        return {
          canTrigger: context.statusEffects?.includes(triggerCondition.status),
          reason: triggerCondition.status
        };
        
      case 'weather':
        return {
          canTrigger: context.weather === triggerCondition.weather,
          reason: triggerCondition.weather
        };
        
      case 'terrain':
        return {
          canTrigger: context.terrain === triggerCondition.terrain,
          reason: triggerCondition.terrain
        };
        
      case 'move_type':
        return {
          canTrigger: context.lastMoveType === triggerCondition.moveType,
          reason: triggerCondition.moveType
        };
        
      case 'stat_stage':
        const statValue = context.statStages?.[triggerCondition.stat] || 0;
        return {
          canTrigger: statValue <= triggerCondition.threshold,
          reason: `stat_${triggerCondition.stat}_${statValue}`
        };
        
      default:
        // 检查 trigger 字段
        if (triggerCondition.trigger) {
          return {
            canTrigger: context.triggerType === triggerCondition.trigger,
            reason: triggerCondition.trigger
          };
        }
        return { canTrigger: false, reason: 'unknown_condition' };
    }
  }

  /**
   * 应用特性效果
   */
  applyAbilityEffect(abilityId, context, battle) {
    const ability = this.abilityCache.get(abilityId);
    
    if (!ability) {
      throw new Error(`Ability ${abilityId} not found`);
    }
    
    const effectConfig = ability.effect_config;
    const effects = [];
    
    if (!effectConfig || !effectConfig.type) {
      return effects;
    }
    
    switch (effectConfig.type) {
      case 'stat_boost':
        effects.push({
          type: 'stat_modifier',
          target: effectConfig.target || 'self',
          stat: effectConfig.stat,
          stage: effectConfig.stage,
          multiplier: effectConfig.multiplier,
          duration: effectConfig.duration || 'permanent'
        });
        break;
        
      case 'stat_multiplier':
        effects.push({
          type: 'stat_multiplier',
          stat: effectConfig.stat,
          multiplier: effectConfig.multiplier
        });
        break;
        
      case 'weather_change':
        effects.push({
          type: 'weather',
          weather: effectConfig.weather,
          duration: effectConfig.duration || 5
        });
        break;
        
      case 'terrain_change':
        effects.push({
          type: 'terrain',
          terrain: effectConfig.terrain,
          duration: effectConfig.duration || 5
        });
        break;
        
      case 'damage_modifier':
        effects.push({
          type: 'damage_multiplier',
          multiplier: effectConfig.multiplier,
          moveType: effectConfig.move_type,
          conditions: effectConfig.conditions
        });
        break;
        
      case 'immune':
        effects.push({
          type: 'immune',
          to: effectConfig.to
        });
        break;
        
      case 'absorb':
        effects.push({
          type: 'absorb',
          from: effectConfig.from,
          healPercent: effectConfig.heal_percent
        });
        break;
        
      case 'status_inflict':
        effects.push({
          type: 'status_inflict',
          status: effectConfig.status,
          chance: effectConfig.chance
        });
        break;
        
      case 'recoil_damage':
        effects.push({
          type: 'recoil_damage',
          percent: effectConfig.percent
        });
        break;
        
      case 'heal':
        effects.push({
          type: 'heal',
          percent: effectConfig.percent
        });
        break;
        
      case 'type_change':
        effects.push({
          type: 'type_change',
          source: effectConfig.source
        });
        break;
        
      case 'cure_status':
        effects.push({
          type: 'cure_status',
          chance: effectConfig.chance || 100
        });
        break;
    }
    
    // 记录特性触发
    if (battle && battle.id) {
      this.logAbilityTrigger(battle.id, context.pokemonId, abilityId, effectConfig.type, context, effects);
    }
    
    return effects;
  }

  /**
   * 注册特性触发处理器
   */
  registerTriggerHandlers() {
    // 出场时触发的特性
    this.triggerHandlers.set('on_enter', [
      'intimidate', 'pressure', 'drizzle', 'drought', 'sandstream', 'snow_warning',
      'electric_terrain', 'intimidate'
    ]);
    
    // 回合开始时触发的特性
    this.triggerHandlers.set('on_turn_start', [
      'speed_boost', 'moody', 'harvest', 'pickup'
    ]);
    
    // 回合结束时触发的特性
    this.triggerHandlers.set('on_turn_end', [
      'speed_boost', 'moody', 'rain_dish', 'solar_power', 'shed_skin'
    ]);
    
    // 受到攻击时触发的特性
    this.triggerHandlers.set('on_hit', [
      'static', 'flame_body', 'poison_point', 'rough_skin', 'iron_barbs',
      'cute_charm', 'effect_spore', 'color_change'
    ]);
    
    // HP低于阈值时触发的特性
    this.triggerHandlers.set('on_low_hp', [
      'blaze', 'torrent', 'overgrow', 'swarm', 'guts'
    ]);
    
    // 使用技能时触发的特性
    this.triggerHandlers.set('on_move', [
      'protean', 'libero', 'sheer_force', 'tough_claws', 'iron_fist'
    ]);
    
    // 切换出场时触发的特性
    this.triggerHandlers.set('on_switch_out', [
      'regenerator', 'natural_cure'
    ]);
  }

  /**
   * 获取特定触发时机应检查的特性
   */
  getAbilitiesForTrigger(triggerType) {
    return this.triggerHandlers.get(triggerType) || [];
  }

  /**
   * 检查特性是否应在某时机触发
   */
  shouldTriggerAt(abilityId, triggerType) {
    const abilities = this.triggerHandlers.get(triggerType) || [];
    return abilities.includes(abilityId);
  }

  /**
   * 记录特性触发日志
   */
  async logAbilityTrigger(battleId, pokemonId, abilityId, triggerType, context, effects) {
    try {
      await this.db.query(`
        INSERT INTO ability_trigger_logs
        (battle_id, player_pokemon_id, ability_id, trigger_type, trigger_context, effect_result)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [battleId, pokemonId, abilityId, triggerType, JSON.stringify(context), JSON.stringify(effects)]);
    } catch (error) {
      logger.error('Failed to log ability trigger', { error: error.message });
    }
  }

  /**
   * 使用特性道具
   */
  async useAbilityItem(userId, playerPokemonId, itemId) {
    const itemResult = await this.db.query(`
      SELECT * FROM ability_items WHERE id = $1
    `, [itemId]);
    
    if (itemResult.rows.length === 0) {
      throw new Error('Item not found');
    }
    
    const item = itemResult.rows[0];
    
    switch (item.item_type) {
      case 'ability_capsule':
        // 切换普通特性（切换到另一个普通特性）
        const abilities = await this.getPlayerPokemonAbilities(playerPokemonId);
        const normalAbilities = abilities.filter(a => !a.isHidden);
        
        if (normalAbilities.length < 2) {
          throw new Error('This Pokemon only has one normal ability');
        }
        
        const currentActive = normalAbilities.find(a => a.isActive);
        const targetAbility = normalAbilities.find(a => !a.isActive);
        
        if (!targetAbility) {
          throw new Error('No alternative ability to switch to');
        }
        
        const switchResult = await this.switchAbility(playerPokemonId, targetAbility.slot);
        return {
          success: true,
          message: 'Ability switched successfully',
          newAbility: switchResult.newAbility
        };
        
      case 'ability_patch':
      case 'hidden_ability_unlock':
        // 解锁隐藏特性
        const unlockResult = await this.unlockHiddenAbility(playerPokemonId);
        return {
          success: true,
          message: 'Hidden ability unlocked',
          ability: unlockResult.ability
        };
        
      default:
        throw new Error(`Unknown item type: ${item.item_type}`);
    }
  }

  /**
   * 获取特性统计
   */
  async getAbilityStats() {
    const result = await this.db.query(`
      SELECT * FROM ability_stats
      ORDER BY active_count DESC
    `);
    
    return result.rows;
  }

  /**
   * 关闭连接
   */
  async close() {
    await this.db.end();
    await this.redis.quit();
  }
}

module.exports = AbilityService;
