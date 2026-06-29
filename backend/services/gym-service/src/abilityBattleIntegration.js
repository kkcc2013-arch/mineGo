/**
 * REQ-00086: 特性战斗集成模块
 * 在战斗中自动触发和计算特性效果
 */

const logger = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');

class AbilityBattleIntegration {
  constructor(battleEngine) {
    this.battleEngine = battleEngine;
    this.abilityService = null;
    this.abilityCache = new Map();
    
    // 延迟加载 AbilityService 以避免循环依赖
    this.loadAbilityService();
  }

  /**
   * 延迟加载特性服务
   */
  loadAbilityService() {
    try {
      // 尝试从 pokemon-service 加载
      const AbilityService = require('../../pokemon-service/src/abilityService');
      this.abilityService = new AbilityService();
    } catch (error) {
      logger.warn('AbilityService not loaded yet, will retry on first use');
    }
  }

  /**
   * 确保特性服务已加载
   */
  async ensureAbilityService() {
    if (!this.abilityService) {
      try {
        const AbilityService = require('../../pokemon-service/src/abilityService');
        this.abilityService = new AbilityService();
      } catch (error) {
        logger.error('Failed to load AbilityService', { error: error.message });
        return false;
      }
    }
    return true;
  }

  /**
   * 战斗开始时处理特性
   * 检查并触发出场特性（如威吓、降雨、日照等）
   */
  async onBattleStart(battle) {
    const effects = [];
    
    if (!await this.ensureAbilityService()) {
      return effects;
    }
    
    for (const participant of battle.participants) {
      const pokemon = participant.pokemon;
      const activeAbility = await this.getActiveAbility(pokemon.id);
      
      if (!activeAbility) continue;
      
      // 检查出场触发特性
      if (this.abilityService.shouldTriggerAt(activeAbility.id, 'on_enter')) {
        const checkResult = this.abilityService.checkTriggerCondition(
          { ...activeAbility, triggerCondition: activeAbility.triggerCondition },
          {
            pokemonId: pokemon.id,
            currentHp: pokemon.currentHp,
            maxHp: pokemon.maxHp,
            ...pokemon
          }
        );
        
        if (checkResult.canTrigger) {
          const abilityEffects = this.abilityService.applyAbilityEffect(
            activeAbility.id,
            { pokemonId: pokemon.id, ...pokemon },
            battle
          );
          
          effects.push({
            pokemonId: pokemon.id,
            abilityId: activeAbility.id,
            abilityName: activeAbility.nameZh,
            effects: abilityEffects
          });
          
          // 处理特性效果
          await this.processAbilityEffects(battle, abilityEffects, participant);
          
          metrics.gauge('gym_ability_triggered', 1, { 
            ability: activeAbility.id, 
            trigger: 'on_enter' 
          });
        }
      }
    }
    
    return effects;
  }

  /**
   * 回合开始时处理特性
   */
  async onTurnStart(battle) {
    const effects = [];
    
    if (!await this.ensureAbilityService()) {
      return effects;
    }
    
    for (const participant of battle.participants) {
      const pokemon = participant.pokemon;
      const activeAbility = await this.getActiveAbility(pokemon.id);
      
      if (!activeAbility) continue;
      
      if (this.abilityService.shouldTriggerAt(activeAbility.id, 'on_turn_start')) {
        const abilityEffects = this.abilityService.applyAbilityEffect(
          activeAbility.id,
          { pokemonId: pokemon.id, turn: battle.currentTurn, ...pokemon },
          battle
        );
        
        effects.push({
          pokemonId: pokemon.id,
          abilityId: activeAbility.id,
          abilityName: activeAbility.nameZh,
          effects: abilityEffects
        });
        
        await this.processAbilityEffects(battle, abilityEffects, participant);
        
        metrics.gauge('gym_ability_triggered', 1, { 
          ability: activeAbility.id, 
          trigger: 'on_turn_start' 
        });
      }
    }
    
    return effects;
  }

  /**
   * 回合结束时处理特性
   */
  async onTurnEnd(battle) {
    const effects = [];
    
    if (!await this.ensureAbilityService()) {
      return effects;
    }
    
    for (const participant of battle.participants) {
      const pokemon = participant.pokemon;
      const activeAbility = await this.getActiveAbility(pokemon.id);
      
      if (!activeAbility) continue;
      
      if (this.abilityService.shouldTriggerAt(activeAbility.id, 'on_turn_end')) {
        const context = {
          pokemonId: pokemon.id,
          currentHp: pokemon.currentHp,
          maxHp: pokemon.maxHp,
          turn: battle.currentTurn,
          weather: battle.weather?.type,
          ...pokemon
        };
        
        const checkResult = this.abilityService.checkTriggerCondition(
          { ...activeAbility, triggerCondition: activeAbility.triggerCondition },
          context
        );
        
        if (checkResult.canTrigger) {
          const abilityEffects = this.abilityService.applyAbilityEffect(
            activeAbility.id,
            context,
            battle
          );
          
          effects.push({
            pokemonId: pokemon.id,
            abilityId: activeAbility.id,
            abilityName: activeAbility.nameZh,
            effects: abilityEffects
          });
          
          await this.processAbilityEffects(battle, abilityEffects, participant);
          
          metrics.gauge('gym_ability_triggered', 1, { 
            ability: activeAbility.id, 
            trigger: 'on_turn_end' 
          });
        }
      }
    }
    
    return effects;
  }

  /**
   * 受到攻击时处理特性
   */
  async onHit(battle, attacker, defender, move) {
    const effects = [];
    
    if (!await this.ensureAbilityService()) {
      return effects;
    }
    
    // 处理防守方特性（如静电、火焰之躯、粗糙皮肤等）
    const defenderAbility = await this.getActiveAbility(defender.pokemon.id);
    
    if (defenderAbility && this.abilityService.shouldTriggerAt(defenderAbility.id, 'on_hit')) {
      // 检查是否为接触类技能
      const isContactMove = move.category !== 'SPECIAL' && !move.nonContact;
      
      const context = {
        pokemonId: defender.pokemon.id,
        attackerId: attacker.pokemon.id,
        move,
        isContactMove,
        currentHp: defender.pokemon.currentHp,
        maxHp: defender.pokemon.maxHp,
        ...defender.pokemon
      };
      
      const checkResult = this.abilityService.checkTriggerCondition(
        { ...defenderAbility, triggerCondition: defenderAbility.triggerCondition },
        context
      );
      
      if (checkResult.canTrigger || isContactMove) {
        const abilityEffects = this.abilityService.applyAbilityEffect(
          defenderAbility.id,
          context,
          battle
        );
        
        effects.push({
          pokemonId: defender.pokemon.id,
          abilityId: defenderAbility.id,
          abilityName: defenderAbility.nameZh,
          effects: abilityEffects
        });
        
        // 对攻击方造成反伤或状态
        for (const effect of abilityEffects) {
          if (effect.type === 'recoil_damage') {
            const recoilDamage = Math.floor(attacker.pokemon.maxHp * (effect.percent / 100));
            attacker.pokemon.currentHp = Math.max(0, attacker.pokemon.currentHp - recoilDamage);
            
            logger.info('Ability recoil damage', {
              ability: defenderAbility.id,
              attackerId: attacker.pokemon.id,
              damage: recoilDamage
            });
          }
          
          if (effect.type === 'status_inflict') {
            const chance = effect.chance || 100;
            if (Math.random() * 100 < chance) {
              attacker.pokemon.statusEffects = attacker.pokemon.statusEffects || [];
              attacker.pokemon.statusEffects.push(effect.status);
              
              logger.info('Ability status inflicted', {
                ability: defenderAbility.id,
                attackerId: attacker.pokemon.id,
                status: effect.status
              });
            }
          }
        }
        
        metrics.gauge('gym_ability_triggered', 1, { 
          ability: defenderAbility.id, 
          trigger: 'on_hit' 
        });
      }
    }
    
    return effects;
  }

  /**
   * 使用技能时处理特性
   */
  async onMove(battle, attacker, defender, move) {
    const effects = [];
    
    if (!await this.ensureAbilityService()) {
      return effects;
    }
    
    const attackerAbility = await this.getActiveAbility(attacker.pokemon.id);
    
    if (!attackerAbility) {
      return effects;
    }
    
    // HP低于阈值时触发的特性（猛火、激流等）
    if (this.abilityService.shouldTriggerAt(attackerAbility.id, 'on_low_hp')) {
      const hpPercent = attacker.pokemon.currentHp / attacker.pokemon.maxHp;
      const ability = this.abilityService.getAbility(attackerAbility.id);
      
      if (ability?.triggerCondition?.type === 'hp_threshold') {
        if (hpPercent <= ability.triggerCondition.threshold) {
          const abilityEffects = this.abilityService.applyAbilityEffect(
            attackerAbility.id,
            {
              pokemonId: attacker.pokemon.id,
              currentHp: attacker.pokemon.currentHp,
              maxHp: attacker.pokemon.maxHp,
              moveType: move.type,
              ...attacker.pokemon
            },
            battle
          );
          
          effects.push({
            pokemonId: attacker.pokemon.id,
            abilityId: attackerAbility.id,
            abilityName: attackerAbility.nameZh,
            effects: abilityEffects
          });
          
          metrics.gauge('gym_ability_triggered', 1, { 
            ability: attackerAbility.id, 
            trigger: 'on_low_hp' 
          });
        }
      }
    }
    
    // 使用技能时触发的特性（变幻自如等）
    if (this.abilityService.shouldTriggerAt(attackerAbility.id, 'on_move')) {
      const abilityEffects = this.abilityService.applyAbilityEffect(
        attackerAbility.id,
        {
          pokemonId: attacker.pokemon.id,
          moveType: move.type,
          ...attacker.pokemon
        },
        battle
      );
      
      effects.push({
        pokemonId: attacker.pokemon.id,
        abilityId: attackerAbility.id,
        abilityName: attackerAbility.nameZh,
        effects: abilityEffects
      });
      
      // 处理属性变化
      for (const effect of abilityEffects) {
        if (effect.type === 'type_change' && effect.source === 'move') {
          attacker.pokemon.currentType = move.type;
          
          logger.info('Ability type change', {
            ability: attackerAbility.id,
            pokemonId: attacker.pokemon.id,
            newType: move.type
          });
        }
      }
      
      metrics.gauge('gym_ability_triggered', 1, { 
        ability: attackerAbility.id, 
        trigger: 'on_move' 
      });
    }
    
    return effects;
  }

  /**
   * 处理特性效果
   */
  async processAbilityEffects(battle, effects, participant) {
    for (const effect of effects) {
      switch (effect.type) {
        case 'weather':
          battle.weather = {
            type: effect.weather,
            duration: effect.duration,
            source: 'ability',
            startedTurn: battle.currentTurn
          };
          logger.info('Weather changed by ability', {
            battle: battle.id,
            weather: effect.weather
          });
          break;
          
        case 'terrain':
          battle.terrain = {
            type: effect.terrain,
            duration: effect.duration,
            source: 'ability'
          };
          logger.info('Terrain changed by ability', {
            battle: battle.id,
            terrain: effect.terrain
          });
          break;
          
        case 'stat_modifier':
        case 'stat_boost':
          const stat = effect.stat;
          const stage = effect.stage || 0;
          const multiplier = effect.multiplier || 1;
          
          participant.pokemon.statModifiers = participant.pokemon.statModifiers || {};
          participant.pokemon.statModifiers[stat] = 
            (participant.pokemon.statModifiers[stat] || 0) + stage;
          
          logger.info('Stat modified by ability', {
            pokemonId: participant.pokemon.id,
            stat,
            stage,
            multiplier
          });
          break;
          
        case 'immune':
          participant.pokemon.immunities = participant.pokemon.immunities || [];
          participant.pokemon.immunities.push(...effect.to);
          
          logger.info('Immunity added by ability', {
            pokemonId: participant.pokemon.id,
            immuneTo: effect.to
          });
          break;
          
        case 'absorb':
          participant.pokemon.absorbs = participant.pokemon.absorbs || [];
          participant.pokemon.absorbs.push({
            from: effect.from,
            healPercent: effect.healPercent
          });
          
          logger.info('Absorption added by ability', {
            pokemonId: participant.pokemon.id,
            from: effect.from
          });
          break;
          
        case 'heal':
          const healAmount = Math.floor(participant.pokemon.maxHp * (effect.percent / 100));
          participant.pokemon.currentHp = Math.min(
            participant.pokemon.maxHp,
            participant.pokemon.currentHp + healAmount
          );
          
          logger.info('Healed by ability', {
            pokemonId: participant.pokemon.id,
            amount: healAmount
          });
          break;
          
        case 'stat_multiplier':
          participant.pokemon.statMultipliers = participant.pokemon.statMultipliers || {};
          participant.pokemon.statMultipliers[effec.stat] = effect.multiplier;
          
          logger.info('Stat multiplier by ability', {
            pokemonId: participant.pokemon.id,
            stat: effect.stat,
            multiplier: effect.multiplier
          });
          break;
      }
    }
  }

  /**
   * 获取激活的特性
   */
  async getActiveAbility(pokemonId) {
    // 尝试从缓存获取
    const cacheKey = `ability:${pokemonId}`;
    const cached = this.abilityCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.ability;
    }
    
    if (!await this.ensureAbilityService()) {
      return null;
    }
    
    try {
      const ability = await this.abilityService.getActiveAbility(pokemonId);
      
      // 缓存结果
      this.abilityCache.set(cacheKey, {
        ability,
        timestamp: Date.now()
      });
      
      return ability;
    } catch (error) {
      logger.error('Failed to get active ability', {
        pokemonId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * 计算特性对伤害的修正
   */
  calculateDamageModifier(attacker, defender, move, battle) {
    let multiplier = 1.0;
    
    // 检查防守方特性
    const defenderAbility = this.abilityCache.get(`ability:${defender.id}`)?.ability;
    
    if (defenderAbility) {
      // 免疫特性
      if (defenderAbility.effectConfig?.type === 'immune') {
        const immuneTo = defenderAbility.effectConfig.to || [];
        if (immuneTo.includes(move.type)) {
          return 0; // 完全免疫
        }
      }
      
      // 吸收特性
      if (defenderAbility.effectConfig?.type === 'absorb') {
        if (defenderAbility.effectConfig.from === move.type) {
          // 应该被吸收，返回负数表示治疗
          return -defenderAbility.effectConfig.healPercent / 100;
        }
      }
      
      // 多重鳞片（满HP时减伤）
      if (defenderAbility.id === 'multiscale') {
        if (defender.currentHp >= defender.maxHp) {
          multiplier *= 0.5;
        }
      }
    }
    
    // 检查攻击方特性
    const attackerAbility = this.abilityCache.get(`ability:${attacker.id}`)?.ability;
    
    if (attackerAbility) {
      // 强行（移除附加效果但提升威力）
      if (attackerAbility.id === 'sheer_force' && move.hasSecondaryEffect) {
        multiplier *= 1.3;
      }
      
      // 强硬（接触类技能增强）
      if (attackerAbility.id === 'tough_claws' && move.isContact) {
        multiplier *= 1.33;
      }
      
      // 铁拳（拳击类技能增强）
      if (attackerAbility.id === 'iron_fist' && move.isPunch) {
        multiplier *= 1.2;
      }
      
      // 属性增强特性（HP低于阈值时）
      const hpPercent = attacker.currentHp / attacker.maxHp;
      const typeBoosters = {
        'blaze': { type: 'fire', threshold: 0.333 },
        'torrent': { type: 'water', threshold: 0.333 },
        'overgrow': { type: 'grass', threshold: 0.333 },
        'swarm': { type: 'bug', threshold: 0.333 }
      };
      
      if (typeBoosters[attackerAbility.id]) {
        const boost = typeBoosters[attackerAbility.id];
        if (move.type === boost.type && hpPercent <= boost.threshold) {
          multiplier *= 1.5;
        }
      }
    }
    
    return multiplier;
  }

  /**
   * 清理过期缓存
   */
  cleanupCache() {
    const now = Date.now();
    for (const [key, value] of this.abilityCache.entries()) {
      if (now - value.timestamp > 60000) {
        this.abilityCache.delete(key);
      }
    }
  }
}

module.exports = AbilityBattleIntegration;
