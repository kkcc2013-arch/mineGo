/**
 * 状态效果引擎
 * REQ-00090: 精灵状态效果系统与战斗Buff/Debuff管理
 * 
 * 管理战斗中所有状态效果的施加、计算、驱散
 */
'use strict';

const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const metrics = require('../../../shared/metrics');

const logger = createLogger('StatusEffectEngine');

// 能力变化乘数表
const STAT_MULTIPLIERS = {
  '-6': 0.25, '-5': 0.29, '-4': 0.33, '-3': 0.40, '-2': 0.50, '-1': 0.67,
  '0': 1.00,
  '1': 1.50, '2': 2.00, '3': 2.50, '4': 3.00, '5': 3.50, '6': 4.00
};

// 命中/闪避乘数表
const ACC_EVA_MULTIPLIERS = {
  '-6': 0.33, '-5': 0.36, '-4': 0.43, '-3': 0.50, '-2': 0.60, '-1': 0.75,
  '0': 1.00,
  '1': 1.33, '2': 1.67, '3': 2.00, '4': 2.33, '5': 2.67, '6': 3.00
};

// 状态图标映射
const STATUS_ICONS = {
  burn: '🔥', paralysis: '⚡', freeze: '❄️', sleep: '💤', confusion: '😵',
  poison: '☠️', toxic: '☢️', flinch: '😰', attract: '💕', bound: '⛓️',
  curse_ghost: '👻', leech_seed: '🌱', protect: '🛡️', substitute: '🎭',
  charging: '⚡', recharging: '😴', sunny_day: '☀️', rain_dance: '🌧️',
  sandstorm: '🏜️', hail: '🌨️', electric_terrain: '⚡', grassy_terrain: '🌿',
  psychic_terrain: '🔮', misty_terrain: '🌫️'
};

class StatusEffectEngine {
  constructor(redisClient) {
    this.redis = redisClient;
    this.statusCache = new Map();
    this.mechanicsCache = new Map();
    this.immunityCache = new Map();
    this.initialized = false;
  }

  /**
   * 初始化状态效果定义缓存
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // 加载状态效果定义
      const { rows: statuses } = await query(`
        SELECT id, code, name, category, description, icon_url,
               max_stacks, duration_type, default_duration, 
               dispellable, priority, mutually_exclusive_with
        FROM status_effect_definitions
      `);

      for (const status of statuses) {
        this.statusCache.set(status.code, status);
        this.statusCache.set(`id_${status.id}`, status);
      }

      // 加载状态机制
      const { rows: mechanics } = await query(`
        SELECT m.id, m.status_id, m.mechanic_type, m.trigger_event,
               m.calculation_formula, m.conditions
        FROM status_effect_mechanics m
      `);

      for (const mechanic of mechanics) {
        const statusId = mechanic.status_id;
        if (!this.mechanicsCache.has(statusId)) {
          this.mechanicsCache.set(statusId, []);
        }
        this.mechanicsCache.get(statusId).push(mechanic);
      }

      // 加载属性免疫
      const { rows: typeImmunities } = await query(`
        SELECT tsi.type_id, tsi.status_id, tsi.immunity_type, sed.code as status_code
        FROM type_status_immunities tsi
        JOIN status_effect_definitions sed ON sed.id = tsi.status_id
      `);

      for (const immunity of typeImmunities) {
        const key = `type_${immunity.type_id}_${immunity.status_code}`;
        this.immunityCache.set(key, immunity.immunity_type);
      }

      // 加载特性免疫
      const { rows: abilityImmunities } = await query(`
        SELECT asi.ability_id, asi.status_id, asi.immunity_type, sed.code as status_code
        FROM ability_status_immunities asi
        JOIN status_effect_definitions sed ON sed.id = asi.status_id
      `);

      for (const immunity of abilityImmunities) {
        const key = `ability_${immunity.ability_id}_${immunity.status_code}`;
        this.immunityCache.set(key, immunity.immunity_type);
      }

      this.initialized = true;
      logger.info(`StatusEffectEngine initialized: ${statuses.length} statuses, ${mechanics.length} mechanics`);
    } catch (error) {
      logger.error({ error }, 'Failed to initialize StatusEffectEngine');
      throw error;
    }
  }

  /**
   * 获取状态效果定义
   */
  getStatusDefinition(code) {
    return this.statusCache.get(code);
  }

  /**
   * 检查是否可以施加状态效果
   */
  async canApplyStatus(target, statusCode, context = {}) {
    await this.initialize();
    
    const statusDef = this.statusCache.get(statusCode);
    if (!statusDef) {
      return { canApply: false, reason: '无效的状态效果' };
    }

    // 检查属性免疫
    if (target.type_id) {
      const typeImmunityKey = `type_${target.type_id}_${statusCode}`;
      if (this.immunityCache.has(typeImmunityKey)) {
        return { canApply: false, reason: `属性免疫${statusDef.name}` };
      }
    }

    // 检查特性免疫
    if (target.ability_id) {
      const abilityImmunityKey = `ability_${target.ability_id}_${statusCode}`;
      if (this.immunityCache.has(abilityImmunityKey)) {
        return { canApply: false, reason: `特性免疫${statusDef.name}` };
      }
    }

    // 检查薄雾场地免疫
    if (context.fieldEffect === 'misty_terrain' && statusDef.category === 'control') {
      return { canApply: false, reason: '薄雾场地免疫异常状态' };
    }

    // 检查电气场地睡眠免疫
    if (context.fieldEffect === 'electric_terrain' && statusCode === 'sleep') {
      return { canApply: false, reason: '电气场地免疫睡眠' };
    }

    // 检查已有状态
    const existingStatuses = await this.getPokemonStatuses(target.battle_id, target.instance_id);
    const existing = existingStatuses.find(s => s.code === statusCode);
    if (existing && statusDef.max_stacks === 1) {
      return { canApply: false, reason: '已存在该状态' };
    }

    // 检查互斥状态
    if (statusDef.mutually_exclusive_with?.length > 0) {
      for (const exclusiveId of statusDef.mutually_exclusive_with) {
        const exclusiveStatus = this.statusCache.get(`id_${exclusiveId}`);
        if (exclusiveStatus && existingStatuses.find(s => s.code === exclusiveStatus.code)) {
          return { canApply: false, reason: `与${exclusiveStatus.name}互斥` };
        }
      }
    }

    return { canApply: true };
  }

  /**
   * 施加状态效果
   */
  async applyStatus(battleId, targetId, statusCode, options = {}) {
    await this.initialize();
    
    const statusDef = this.statusCache.get(statusCode);
    if (!statusDef) {
      throw new Error(`Unknown status effect: ${statusCode}`);
    }

    const target = {
      battle_id: battleId,
      instance_id: targetId,
      type_id: options.targetTypeId,
      ability_id: options.targetAbilityId
    };

    // 检查是否可施加
    const checkResult = await this.canApplyStatus(target, statusCode, {
      fieldEffect: options.fieldEffect
    });

    if (!checkResult.canApply) {
      return { success: false, reason: checkResult.reason };
    }

    // 能力变化类状态特殊处理
    if (statusDef.category === 'stat_change') {
      return await this.applyStatChange(battleId, targetId, statusCode, options.stacks || 1);
    }

    // 计算持续时间
    let duration = statusDef.default_duration;
    if (statusCode === 'sleep') {
      duration = Math.floor(Math.random() * 3) + 1; // 1-3回合
    }
    if (statusCode === 'freeze') {
      duration = null; // 永久直到解除
    }

    // 创建状态记录
    const { rows } = await query(`
      INSERT INTO battle_pokemon_status 
        (battle_id, pokemon_instance_id, status_id, source_pokemon_id, source_move_id,
         current_stacks, remaining_turns, applied_at_turn, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      battleId, targetId, statusDef.id, options.sourcePokemonId, options.sourceMoveId,
      1, duration, options.currentTurn || 0, JSON.stringify(options.metadata || {})
    ]);

    const statusId = rows[0].id;

    // 缓存到Redis
    if (this.redis) {
      const cacheKey = `status:${battleId}:${targetId}:${statusCode}`;
      await this.redis.setex(cacheKey, 300, JSON.stringify({
        id: statusId,
        code: statusCode,
        remaining_turns: duration,
        metadata: options.metadata || {}
      }));
    }

    logger.info({
      battleId, targetId, statusCode, statusName: statusDef.name, duration
    }, 'Status applied');

    return {
      success: true,
      statusId,
      statusCode,
      statusName: statusDef.name,
      duration,
      icon: STATUS_ICONS[statusCode]
    };
  }

  /**
   * 应用能力变化
   */
  async applyStatChange(battleId, targetId, statusCode, stacks) {
    const statusDef = this.statusCache.get(statusCode);
    
    // 解析属性类型
    let statType = statusCode.replace('_up', '').replace('_down', '');
    if (statType === 'sp_attack') statType = 'sp_attack';
    if (statType === 'sp_defense') statType = 'sp_defense';
    if (statType === 'crit_rate') statType = 'crit_rate';
    
    const stageDelta = statusCode.includes('_up') ? stacks : -stacks;

    // 获取当前变化
    const { rows: existing } = await query(`
      SELECT stage FROM battle_stat_changes
      WHERE battle_id = $1 AND pokemon_instance_id = $2 AND stat_type = $3
    `, [battleId, targetId, statType]);

    const currentStage = existing[0]?.stage || 0;
    const newStage = Math.max(-6, Math.min(6, currentStage + stageDelta));
    const actualDelta = newStage - currentStage;

    if (actualDelta === 0) {
      return { success: false, reason: '能力已达极限' };
    }

    // 更新或创建记录
    await query(`
      INSERT INTO battle_stat_changes (battle_id, pokemon_instance_id, stat_type, stage, source_status_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (battle_id, pokemon_instance_id, stat_type)
      DO UPDATE SET stage = $4
    `, [battleId, targetId, statType, newStage, statusDef?.id]);

    return {
      success: true,
      statType,
      previousStage: currentStage,
      newStage,
      delta: actualDelta,
      message: this.getStatChangeMessage(statType, actualDelta)
    };
  }

  /**
   * 获取能力变化消息
   */
  getStatChangeMessage(statType, delta) {
    const statNames = {
      attack: '攻击', defense: '防御', sp_attack: '特攻', sp_defense: '特防',
      speed: '速度', accuracy: '命中', evasion: '闪避', crit_rate: '暴击'
    };

    const changeLevel = Math.abs(delta);
    const messages = {
      1: ['略微提升了', '略微下降了'],
      2: ['提升了', '下降了'],
      3: ['大幅提升了', '大幅下降了'],
      4: ['急剧提升了', '急剧下降了'],
      5: ['疯狂提升了', '疯狂下降了'],
      6: ['提升到了极限', '下降到了极限']
    };

    const level = Math.min(changeLevel, 6);
    const index = delta > 0 ? 0 : 1;

    return `${statNames[statType]}${messages[level][index]}！`;
  }

  /**
   * 处理回合开始事件
   */
  async onTurnStart(battleId, pokemonId, currentTurn, pokemonData) {
    await this.initialize();
    
    const results = [];
    const statuses = await this.getPokemonStatuses(battleId, pokemonId);

    for (const status of statuses) {
      const mechanics = this.mechanicsCache.get(status.status_id) || [];
      const turnStartMechanics = mechanics.filter(m => m.trigger_event === 'turn_start');

      for (const mechanic of turnStartMechanics) {
        const result = await this.executeMechanic(
          battleId, pokemonId, status, mechanic, pokemonData, currentTurn
        );
        if (result) results.push(result);
      }
    }

    return results;
  }

  /**
   * 处理回合结束事件
   */
  async onTurnEnd(battleId, pokemonId, currentTurn, pokemonData) {
    await this.initialize();
    
    const results = [];
    const statuses = await this.getPokemonStatuses(battleId, pokemonId);

    for (const status of statuses) {
      // 执行回合结束机制
      const mechanics = this.mechanicsCache.get(status.status_id) || [];
      const turnEndMechanics = mechanics.filter(m => m.trigger_event === 'turn_end');

      for (const mechanic of turnEndMechanics) {
        const result = await this.executeMechanic(
          battleId, pokemonId, status, mechanic, pokemonData, currentTurn
        );
        if (result) results.push(result);
      }

      // 减少持续时间
      if (status.remaining_turns !== null && status.remaining_turns > 0) {
        const newTurns = status.remaining_turns - 1;

        if (newTurns === 0) {
          await this.removeStatus(battleId, pokemonId, status.code);
          results.push({
            type: 'status_expired',
            statusCode: status.code,
            statusName: status.name
          });
        } else {
          await query(`
            UPDATE battle_pokemon_status SET remaining_turns = $1 WHERE id = $2
          `, [newTurns, status.id]);
        }
      }

      // 冰冻随机解除检查
      if (status.code === 'freeze' && Math.random() < 0.2) {
        await this.removeStatus(battleId, pokemonId, 'freeze');
        results.push({ type: 'status_expired', statusCode: 'freeze', statusName: '冰冻' });
      }
    }

    return results;
  }

  /**
   * 执行状态机制
   */
  async executeMechanic(battleId, pokemonId, status, mechanic, pokemonData, currentTurn) {
    if (!pokemonData) return null;

    const maxHp = pokemonData.max_hp || 100;
    const currentHp = pokemonData.current_hp || maxHp;
    let value = 0;

    switch (mechanic.mechanic_type) {
      case 'damage': {
        const formula = mechanic.calculation_formula;
        const stacks = status.metadata?.toxic_stacks || 1;
        
        // 替换公式变量
        let evalFormula = formula
          .replace(/MAX_HP/g, maxHp)
          .replace(/CURRENT_HP/g, currentHp)
          .replace(/STACKS/g, stacks);

        try {
          value = Math.floor(eval(evalFormula));
        } catch (e) {
          logger.error({ formula: evalFormula, error: e }, 'Invalid damage formula');
          value = Math.floor(maxHp / 8);
        }

        // 剧毒累积
        if (status.code === 'toxic') {
          await query(`
            UPDATE battle_pokemon_status 
            SET metadata = jsonb_set(metadata, '{toxic_stacks}', to_jsonb($1))
            WHERE id = $2
          `, [stacks + 1, status.id]);
        }

        return {
          type: 'damage',
          statusCode: status.code,
          statusName: status.name,
          value: Math.max(1, value),
          pokemonId
        };
      }

      case 'heal': {
        const formula = mechanic.calculation_formula;
        let evalFormula = formula.replace(/MAX_HP/g, maxHp).replace(/CURRENT_HP/g, currentHp);

        try {
          value = Math.floor(eval(evalFormula));
        } catch (e) {
          logger.error({ formula: evalFormula, error: e }, 'Invalid heal formula');
          value = Math.floor(maxHp / 16);
        }

        return {
          type: 'heal',
          statusCode: status.code,
          statusName: status.name,
          value: Math.min(value, maxHp - currentHp),
          pokemonId
        };
      }

      case 'action_block':
        return {
          type: 'action_block',
          statusCode: status.code,
          statusName: status.name,
          pokemonId
        };

      default:
        return null;
    }
  }

  /**
   * 检查行动是否被阻止
   */
  async checkActionBlocked(battleId, pokemonId, actionType) {
    await this.initialize();
    
    const statuses = await this.getPokemonStatuses(battleId, pokemonId);

    for (const status of statuses) {
      // 睡眠/冰冻完全阻止行动
      if (['sleep', 'freeze'].includes(status.code)) {
        return { blocked: true, reason: `${status.name}状态`, statusCode: status.code };
      }

      // 麻痹25%概率阻止
      if (status.code === 'paralysis') {
        if (Math.random() < 0.25) {
          return { blocked: true, reason: '麻痹发作', statusCode: 'paralysis' };
        }
      }

      // 混乱33%概率自伤
      if (status.code === 'confusion') {
        if (Math.random() < 0.33) {
          return { blocked: true, reason: '混乱', selfDamage: true, statusCode: 'confusion' };
        }
      }

      // 畏缩阻止当回合
      if (status.code === 'flinch') {
        await this.removeStatus(battleId, pokemonId, 'flinch');
        return { blocked: true, reason: '畏缩', statusCode: 'flinch' };
      }

      // 束缚阻止交换
      if (status.code === 'bound' && actionType === 'switch') {
        return { blocked: true, reason: '被束缚无法交换', statusCode: 'bound' };
      }

      // 扎根阻止交换
      if (status.code === 'ingrain' && actionType === 'switch') {
        return { blocked: true, reason: '扎根无法交换', statusCode: 'ingrain' };
      }
    }

    return { blocked: false };
  }

  /**
   * 移除状态效果
   */
  async removeStatus(battleId, pokemonId, statusCode) {
    const statusDef = this.statusCache.get(statusCode);
    if (!statusDef) return false;

    await query(`
      DELETE FROM battle_pokemon_status
      WHERE battle_id = $1 AND pokemon_instance_id = $2 AND status_id = $3
    `, [battleId, pokemonId, statusDef.id]);

    // 清除Redis缓存
    if (this.redis) {
      await this.redis.del(`status:${battleId}:${pokemonId}:${statusCode}`);
    }

    logger.info({ battleId, pokemonId, statusCode }, 'Status removed');

    return true;
  }

  /**
   * 驱散状态效果
   */
  async dispelStatuses(battleId, pokemonId, options = {}) {
    const { category, dispellableOnly = true } = options;
    const statuses = await this.getPokemonStatuses(battleId, pokemonId);
    const removed = [];

    for (const status of statuses) {
      // 检查是否可驱散
      if (dispellableOnly && !status.dispellable) continue;

      // 检查类别
      if (category && status.category !== category) continue;

      await this.removeStatus(battleId, pokemonId, status.code);
      removed.push({ code: status.code, name: status.name });
    }

    return removed;
  }

  /**
   * 获取精灵当前状态
   */
  async getPokemonStatuses(battleId, pokemonId) {
    // 先查Redis缓存
    if (this.redis) {
      const cacheKey = `statuses:${battleId}:${pokemonId}`;
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const { rows } = await query(`
      SELECT bps.id, bps.status_id, bps.remaining_turns, bps.current_stacks,
             bps.applied_at_turn, bps.metadata, bps.source_pokemon_id,
             sed.code, sed.name, sed.category, sed.dispellable, sed.priority
      FROM battle_pokemon_status bps
      JOIN status_effect_definitions sed ON sed.id = bps.status_id
      WHERE bps.battle_id = $1 AND bps.pokemon_instance_id = $2
      ORDER BY sed.priority DESC
    `, [battleId, pokemonId]);

    const result = rows.map(r => ({
      id: r.id,
      status_id: r.status_id,
      code: r.code,
      name: r.name,
      category: r.category,
      remaining_turns: r.remaining_turns,
      current_stacks: r.current_stacks,
      applied_at_turn: r.applied_at_turn,
      metadata: r.metadata || {},
      dispellable: r.dispellable,
      priority: r.priority,
      source_pokemon_id: r.source_pokemon_id,
      icon: STATUS_ICONS[r.code]
    }));

    // 缓存5秒
    if (this.redis) {
      await this.redis.setex(`statuses:${battleId}:${pokemonId}`, 5, JSON.stringify(result));
    }

    return result;
  }

  /**
   * 获取能力变化
   */
  async getStatChanges(battleId, pokemonId) {
    const { rows } = await query(`
      SELECT stat_type, stage FROM battle_stat_changes
      WHERE battle_id = $1 AND pokemon_instance_id = $2
    `, [battleId, pokemonId]);

    const result = {};
    for (const row of rows) {
      result[row.stat_type] = row.stage;
    }

    return result;
  }

  /**
   * 计算修正后的属性值
   */
  calculateModifiedStats(baseStats, statChanges) {
    const modified = { ...baseStats };

    for (const [stat, stage] of Object.entries(statChanges)) {
      if (stage === 0) continue;

      if (['accuracy', 'evasion'].includes(stat)) {
        modified[stat] = Math.floor((baseStats[stat] || 100) * ACC_EVA_MULTIPLIERS[stage.toString()]);
      } else if (stat !== 'crit_rate') {
        modified[stat] = Math.floor((baseStats[stat] || 100) * STAT_MULTIPLIERS[stage.toString()]);
      }
    }

    return modified;
  }

  /**
   * 获取场地效果
   */
  async getFieldEffect(battleId) {
    const { rows } = await query(`
      SELECT sed.code, sed.name, bps.remaining_turns
      FROM battle_pokemon_status bps
      JOIN status_effect_definitions sed ON sed.id = bps.status_id
      WHERE bps.battle_id = $1 AND sed.category = 'field'
      ORDER BY bps.applied_at_turn DESC
      LIMIT 1
    `, [battleId]);

    return rows[0] || null;
  }

  /**
   * 清除战斗所有状态
   */
  async clearBattleStatuses(battleId) {
    await query(`DELETE FROM battle_pokemon_status WHERE battle_id = $1`, [battleId]);
    await query(`DELETE FROM battle_stat_changes WHERE battle_id = $1`, [battleId]);

    if (this.redis) {
      const keys = await this.redis.keys(`status:${battleId}:*`);
      const keys2 = await this.redis.keys(`statuses:${battleId}:*`);
      if (keys.length > 0) await this.redis.del(...keys);
      if (keys2.length > 0) await this.redis.del(...keys2);
    }

    logger.info({ battleId }, 'Battle statuses cleared');
  }

  /**
   * 获取所有状态效果定义
   */
  async getAllDefinitions(category = null) {
    await this.initialize();

    const statuses = Array.from(this.statusCache.values())
      .filter(s => !s.code.startsWith('id_'))
      .filter(s => !category || s.category === category);

    return statuses.map(s => ({
      ...s,
      icon: STATUS_ICONS[s.code],
      mechanics: this.mechanicsCache.get(s.id) || []
    }));
  }
}

module.exports = StatusEffectEngine;
