# REQ-00086: 精灵特性系统与隐藏能力激活机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00086 |
| 标题 | 精灵特性系统与隐藏能力激活机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、catch-service、gym-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-10 12:00 |

## 需求描述

实现完整的精灵特性（Ability）系统，包括普通特性、隐藏特性（Hidden Ability）及其激活机制。精灵特性是对战中重要的策略要素，每个精灵最多拥有 3 个特性槽位（1-2 个普通特性 + 1 个隐藏特性），特性会在战斗中自动触发或在特定条件下激活。

### 核心功能
1. **特性数据管理**：定义 300+ 种特性，包括特性效果、触发条件、优先级
2. **精灵特性分配**：捕捉时随机分配特性（含隐藏特性概率）
3. **特性药水系统**：通过道具切换精灵的普通特性
4. **隐藏特性激活**：特殊道具或培育条件解锁隐藏特性
5. **战斗系统集成**：特性在战斗中自动触发

### 特性类型分类
- **被动特性**：永久生效，如"威吓"（出场时降低对手攻击）
- **触发特性**：条件触发，如"猛火"（HP<1/3时火系技能威力提升）
- **环境特性**：影响环境，如"日照"（出场时天气变为晴天）
- **免疫特性**：免疫特定状态，如"漂浮"（免疫地面系技能）
- **转换特性"：改变属性，如"变色"（根据技能改变自身属性）

## 技术方案

### 1. 数据库设计

```sql
-- 特性定义表
CREATE TABLE abilities (
    id VARCHAR(50) PRIMARY KEY,
    name_en VARCHAR(100) NOT NULL,
    name_zh VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    type VARCHAR(20) NOT NULL CHECK (type IN ('passive', 'trigger', 'environment', 'immunity', 'transformation')),
    trigger_condition JSONB, -- 触发条件配置
    effect_config JSONB NOT NULL, -- 特性效果配置
    priority INTEGER DEFAULT 0,
    is_hidden BOOLEAN DEFAULT FALSE,
    introduced_generation INTEGER,
    meta_data JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 精灵特性映射表（定义每个精灵可选特性）
CREATE TABLE pokemon_abilities (
    id SERIAL PRIMARY KEY,
    pokemon_species_id VARCHAR(50) NOT NULL,
    ability_id VARCHAR(50) NOT NULL REFERENCES abilities(id),
    slot INTEGER NOT NULL CHECK (slot IN (1, 2, 3)), -- 1,2=普通特性, 3=隐藏特性
    probability DECIMAL(5, 4) DEFAULT 1.0, -- 该槽位的特性概率（总和为1）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(pokemon_species_id, ability_id)
);

CREATE INDEX idx_pokemon_abilities_species ON pokemon_abilities(pokemon_species_id);
CREATE INDEX idx_pokemon_abilities_ability ON pokemon_abilities(ability_id);

-- 玩家精灵实例特性表
CREATE TABLE player_pokemon_abilities (
    id SERIAL PRIMARY KEY,
    player_pokemon_id INTEGER NOT NULL REFERENCES player_pokemon(id) ON DELETE CASCADE,
    ability_id VARCHAR(50) NOT NULL REFERENCES abilities(id),
    slot INTEGER NOT NULL CHECK (slot IN (1, 2, 3)),
    is_active BOOLEAN DEFAULT TRUE, -- 当前激活的特性（普通特性中选一个激活）
    is_hidden BOOLEAN DEFAULT FALSE,
    unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_pokemon_id, slot)
);

CREATE INDEX idx_player_pokemon_abilities_pokemon ON player_pokemon_abilities(player_pokemon_id);

-- 特性触发日志（用于分析和调试）
CREATE TABLE ability_trigger_logs (
    id SERIAL PRIMARY KEY,
    battle_id VARCHAR(50),
    player_pokemon_id INTEGER NOT NULL,
    ability_id VARCHAR(50) NOT NULL,
    trigger_type VARCHAR(50) NOT NULL,
    trigger_context JSONB NOT NULL,
    effect_result JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ability_trigger_logs_battle ON ability_trigger_logs(battle_id);
CREATE INDEX idx_ability_trigger_logs_ability ON ability_trigger_logs(ability_id, created_at);

-- 特性药水/道具表
CREATE TABLE ability_items (
    id VARCHAR(50) PRIMARY KEY,
    name_en VARCHAR(100) NOT NULL,
    name_zh VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    item_type VARCHAR(50) NOT NULL CHECK (item_type IN ('ability_capsule', 'ability_patch', 'hidden_ability_unlock')),
    effect_config JSONB NOT NULL,
    rarity VARCHAR(20) DEFAULT 'rare',
    obtained_from JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 2. 特性服务核心模块

```javascript
// backend/services/pokemon-service/src/abilityService.js

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../shared/logger');
const { metrics } = require('../../shared/metrics');

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
      metrics.gauge('pokemon_ability_cache_size', this.abilityCache.size);
    } catch (error) {
      logger.error('Failed to load ability cache', { error: error.message });
    }
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
      // 随机选择一个普通特性激活
      const randomIndex = Math.random() < 0.5 ? 0 : Math.min(1, abilities.normal.length - 1);
      const selectedAbility = abilities.normal[randomIndex];
      
      // 插入所有普通特性，但只激活一个
      for (let i = 0; i < abilities.normal.length; i++) {
        await this.db.query(`
          INSERT INTO player_pokemon_abilities 
          (player_pokemon_id, ability_id, slot, is_active, is_hidden)
          VALUES ($1, $2, $3, $4, FALSE)
        `, [playerPokemonId, abilities.normal[i].id, i + 1, i === randomIndex]);
        
        if (i === randomIndex) {
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
        (player_pokemon_id, ability_id, slot, is_active, is_hidden)
        VALUES ($1, $2, 3, FALSE, $3)
      `, [playerPokemonId, abilities.hidden.id, hasHidden]);
      
      if (hasHidden) {
        assignedAbilities.push({
          ...abilities.hidden,
          isActive: false,
          isHidden: true,
          unlocked: true
        });
      }
    }
    
    metrics.increment('pokemon_abilities_assigned', {
      species: speciesId,
      has_hidden: assignedAbilities.some(a => a.isHidden)
    });
    
    return assignedAbilities;
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
      
      metrics.increment('pokemon_ability_switched');
      
      return {
        success: true,
        newAbility: {
          id: target.ability_id,
          ...ability
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
    
    metrics.increment('pokemon_hidden_ability_unlocked');
    
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
   * 检查特性触发条件
   */
  checkTriggerCondition(ability, context) {
    const triggerCondition = ability.trigger_condition;
    
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
    
    switch (effectConfig.type) {
      case 'stat_boost':
        effects.push({
          type: 'stat_modifier',
          target: effectConfig.target || 'self',
          stat: effectConfig.stat,
          multiplier: effectConfig.multiplier,
          duration: effectConfig.duration || 'permanent'
        });
        break;
        
      case 'weather_change':
        effects.push({
          type: 'weather',
          weather: effectConfig.weather,
          duration: effectConfig.duration || 5
        });
        break;
        
      case 'damage_modifier':
        effects.push({
          type: 'damage_multiplier',
          multiplier: effectConfig.multiplier,
          conditions: effectConfig.conditions
        });
        break;
        
      case 'immunity':
        effects.push({
          type: 'immune',
          to: effectConfig.immuneTo
        });
        break;
        
      case 'status_immunity':
        effects.push({
          type: 'status_immune',
          statuses: effectConfig.statuses
        });
        break;
        
      case 'type_change':
        effects.push({
          type: 'type_change',
          newType: effectConfig.newType,
          condition: effectConfig.condition
        });
        break;
        
      case 'heal':
        effects.push({
          type: 'heal',
          amount: effectConfig.amount,
          trigger: effectConfig.trigger
        });
        break;
        
      case 'reduce_damage':
        effects.push({
          type: 'damage_reduction',
          percentage: effectConfig.percentage,
          conditions: effectConfig.conditions
        });
        break;
    }
    
    // 记录特性触发
    this.logAbilityTrigger(battle.id, context.pokemonId, abilityId, effectConfig.type, context, effects);
    
    return effects;
  }

  /**
   * 注册特性触发处理器
   */
  registerTriggerHandlers() {
    // 出场时触发的特性
    this.triggerHandlers.set('on_enter', [
      'intimidate', 'pressure', 'drizzle', 'drought', 'sandstream', 'snow_warning'
    ]);
    
    // 回合开始时触发的特性
    this.triggerHandlers.set('on_turn_start', [
      'speed_boost', 'moody', 'harvest', 'pickup'
    ]);
    
    // 受到攻击时触发的特性
    this.triggerHandlers.set('on_hit', [
      'static', 'flame_body', 'poison_point', 'rough_skin', 'iron_barbs', 'cute_charm'
    ]);
    
    // HP低于阈值时触发的特性
    this.triggerHandlers.set('on_low_hp', [
      'blaze', 'torrent', 'overgrow', 'swarm', 'guts'
    ]);
    
    // 使用技能时触发的特性
    this.triggerHandlers.set('on_move', [
      'protean', 'libero', 'sheer_force', 'tough_claws', 'iron_fist'
    ]);
  }

  /**
   * 获取特定触发时机应检查的特性
   */
  getAbilitiesForTrigger(triggerType) {
    return this.triggerHandlers.get(triggerType) || [];
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
   * 使用特性药水
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
        // 切换普通特性
        const switchResult = await this.switchAbility(playerPokemonId, 2);
        return {
          success: true,
          message: 'Ability switched successfully',
          newAbility: switchResult.newAbility
        };
        
      case 'ability_patch':
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
}

module.exports = AbilityService;
```

### 3. 战斗系统集成

```javascript
// backend/services/gym-service/src/abilityBattleIntegration.js

const AbilityService = require('../../pokemon-service/src/abilityService');
const logger = require('../../shared/logger');

class AbilityBattleIntegration {
  constructor(battleEngine) {
    this.battleEngine = battleEngine;
    this.abilityService = new AbilityService();
  }

  /**
   * 战斗开始时处理特性
   */
  async onBattleStart(battle) {
    const effects = [];
    
    for (const participant of battle.participants) {
      const pokemon = participant.pokemon;
      const activeAbility = await this.getActiveAbility(pokemon.id);
      
      if (!activeAbility) continue;
      
      // 检查出场触发特性
      const triggerAbilities = this.abilityService.getAbilitiesForTrigger('on_enter');
      
      if (triggerAbilities.includes(activeAbility.id)) {
        const abilityEffects = this.abilityService.applyAbilityEffect(
          activeAbility.id,
          { pokemonId: pokemon.id, ...pokemon },
          battle
        );
        
        effects.push({
          pokemon: pokemon.id,
          ability: activeAbility.id,
          effects: abilityEffects
        });
        
        // 处理特性效果
        await this.processAbilityEffects(battle, abilityEffects, participant);
      }
    }
    
    return effects;
  }

  /**
   * 回合开始时处理特性
   */
  async onTurnStart(battle) {
    const effects = [];
    
    for (const participant of battle.participants) {
      const pokemon = participant.pokemon;
      const activeAbility = await this.getActiveAbility(pokemon.id);
      
      if (!activeAbility) continue;
      
      const triggerAbilities = this.abilityService.getAbilitiesForTrigger('on_turn_start');
      
      if (triggerAbilities.includes(activeAbility.id)) {
        const abilityEffects = this.abilityService.applyAbilityEffect(
          activeAbility.id,
          { pokemonId: pokemon.id, ...pokemon, turn: battle.currentTurn },
          battle
        );
        
        effects.push({
          pokemon: pokemon.id,
          ability: activeAbility.id,
          effects: abilityEffects
        });
        
        await this.processAbilityEffects(battle, abilityEffects, participant);
      }
    }
    
    return effects;
  }

  /**
   * 受到攻击时处理特性
   */
  async onHit(battle, attacker, defender, move) {
    const effects = [];
    
    // 处理防守方特性
    const defenderAbility = await this.getActiveAbility(defender.pokemon.id);
    
    if (defenderAbility) {
      const triggerAbilities = this.abilityService.getAbilitiesForTrigger('on_hit');
      
      if (triggerAbilities.includes(defenderAbility.id)) {
        const checkResult = this.abilityService.checkTriggerCondition(
          this.abilityService.abilityCache.get(defenderAbility.id),
          {
            currentHp: defender.pokemon.currentHp,
            maxHp: defender.pokemon.maxHp,
            lastMoveType: move.type,
            ...defender.pokemon
          }
        );
        
        if (checkResult.canTrigger) {
          const abilityEffects = this.abilityService.applyAbilityEffect(
            defenderAbility.id,
            { pokemonId: defender.pokemon.id, attackerId: attacker.pokemon.id, move },
            battle
          );
          
          effects.push({
            pokemon: defender.pokemon.id,
            ability: defenderAbility.id,
            effects: abilityEffects
          });
          
          // 对攻击方造成反伤或状态
          for (const effect of abilityEffects) {
            if (effect.type === 'damage') {
              const recoilDamage = Math.floor(attacker.pokemon.maxHp * effect.percentage);
              attacker.pokemon.currentHp = Math.max(0, attacker.pokemon.currentHp - recoilDamage);
            }
            
            if (effect.type === 'status') {
              attacker.pokemon.statusEffects.push(effect.status);
            }
          }
        }
      }
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
            source: 'ability'
          };
          logger.info('Weather changed by ability', {
            battle: battle.id,
            weather: effect.weather
          });
          break;
          
        case 'stat_modifier':
          const stat = effect.stat;
          const modifier = effect.multiplier;
          participant.pokemon.statModifiers[stat] = 
            (participant.pokemon.statModifiers[stat] || 1) * modifier;
          break;
          
        case 'immune':
          participant.pokemon.immunities = participant.pokemon.immunities || [];
          participant.pokemon.immunities.push(...effect.to);
          break;
          
        case 'type_change':
          participant.pokemon.currentType = effect.newType;
          break;
      }
    }
  }

  /**
   * 获取激活的特性
   */
  async getActiveAbility(pokemonId) {
    const result = await this.abilityService.db.query(`
      SELECT ppa.*, a.*
      FROM player_pokemon_abilities ppa
      JOIN abilities a ON ppa.ability_id = a.id
      WHERE ppa.player_pokemon_id = $1 AND ppa.is_active = TRUE
    `, [pokemonId]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return result.rows[0];
  }
}

module.exports = AbilityBattleIntegration;
```

### 4. API 路由

```javascript
// backend/services/pokemon-service/src/routes/abilities.js

const express = require('express');
const router = express.Router();
const AbilityService = require('../abilityService');
const { authenticate } = require('../../../shared/middleware/auth');
const { validateRequest } = require('../../../shared/middleware/validation');

const abilityService = new AbilityService();

/**
 * 获取特性列表
 * GET /api/pokemon/abilities
 */
router.get('/', async (req, res) => {
  try {
    const { type, is_hidden, limit = 50, offset = 0 } = req.query;
    
    let query = 'SELECT * FROM abilities WHERE 1=1';
    const params = [];
    
    if (type) {
      params.push(type);
      query += ` AND type = $${params.length}`;
    }
    
    if (is_hidden !== undefined) {
      params.push(is_hidden === 'true');
      query += ` AND is_hidden = $${params.length}`;
    }
    
    query += ` ORDER BY name_en LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await abilityService.db.query(query, params);
    
    res.json({
      success: true,
      data: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: result.rows.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取单个特性详情
 * GET /api/pokemon/abilities/:abilityId
 */
router.get('/:abilityId', async (req, res) => {
  try {
    const ability = abilityService.abilityCache.get(req.params.abilityId);
    
    if (!ability) {
      return res.status(404).json({ error: 'Ability not found' });
    }
    
    res.json({ success: true, data: ability });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取精灵的特性配置
 * GET /api/pokemon/:pokemonId/abilities
 */
router.get('/pokemon/:pokemonId', authenticate, async (req, res) => {
  try {
    const { pokemonId } = req.params;
    
    const abilities = await abilityService.db.query(`
      SELECT ppa.*, a.name_en, a.name_zh, a.type, a.description, a.is_hidden
      FROM player_pokemon_abilities ppa
      JOIN abilities a ON ppa.ability_id = a.id
      WHERE ppa.player_pokemon_id = $1
      ORDER BY ppa.slot
    `, [pokemonId]);
    
    res.json({
      success: true,
      data: abilities.rows
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 切换精灵特性
 * POST /api/pokemon/:pokemonId/abilities/switch
 */
router.post('/pokemon/:pokemonId/abilities/switch', 
  authenticate,
  validateRequest({
    body: {
      targetSlot: { type: 'integer', required: true, enum: [1, 2] }
    }
  }),
  async (req, res) => {
    try {
      const { pokemonId } = req.params;
      const { targetSlot } = req.body;
      
      const result = await abilityService.switchAbility(pokemonId, targetSlot);
      
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

/**
 * 解锁隐藏特性
 * POST /api/pokemon/:pokemonId/abilities/unlock-hidden
 */
router.post('/pokemon/:pokemonId/abilities/unlock-hidden', 
  authenticate,
  async (req, res) => {
    try {
      const { pokemonId } = req.params;
      
      const result = await abilityService.unlockHiddenAbility(pokemonId);
      
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

/**
 * 使用特性道具
 * POST /api/pokemon/:pokemonId/abilities/use-item
 */
router.post('/pokemon/:pokemonId/abilities/use-item',
  authenticate,
  validateRequest({
    body: {
      itemId: { type: 'string', required: true }
    }
  }),
  async (req, res) => {
    try {
      const { pokemonId } = req.params;
      const { itemId } = req.body;
      const userId = req.user.id;
      
      const result = await abilityService.useAbilityItem(userId, pokemonId, itemId);
      
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

module.exports = router;
```

### 5. 前端组件

```javascript
// frontend/game-client/src/components/AbilityManager.js

import React, { useState, useEffect } from 'react';
import './AbilityManager.css';

const AbilityManager = ({ pokemonId, onClose }) => {
  const [abilities, setAbilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [selectedAbility, setSelectedAbility] = useState(null);

  useEffect(() => {
    fetchAbilities();
  }, [pokemonId]);

  const fetchAbilities = async () => {
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/abilities`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      const data = await response.json();
      
      if (data.success) {
        setAbilities(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch abilities:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSwitchAbility = async (targetSlot) => {
    if (switching) return;
    
    setSwitching(true);
    
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/abilities/switch`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ targetSlot })
      });
      
      const data = await response.json();
      
      if (data.success) {
        await fetchAbilities();
        // 显示成功提示
      } else {
        alert(data.error);
      }
    } catch (error) {
      console.error('Failed to switch ability:', error);
    } finally {
      setSwitching(false);
    }
  };

  const handleUnlockHidden = async () => {
    if (!confirm('确定要解锁隐藏特性吗？这需要消耗特性胶囊道具。')) {
      return;
    }
    
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/abilities/unlock-hidden`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      const data = await response.json();
      
      if (data.success) {
        await fetchAbilities();
        alert(`成功解锁隐藏特性：${data.ability.nameZh}`);
      } else {
        alert(data.error);
      }
    } catch (error) {
      console.error('Failed to unlock hidden ability:', error);
    }
  };

  if (loading) {
    return <div className="ability-manager loading">加载中...</div>;
  }

  const normalAbilities = abilities.filter(a => !a.is_hidden);
  const hiddenAbility = abilities.find(a => a.is_hidden);

  return (
    <div className="ability-manager">
      <div className="ability-manager-header">
        <h2>特性管理</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="ability-section">
        <h3>普通特性</h3>
        <div className="abilities-grid">
          {normalAbilities.map((ability, index) => (
            <div 
              key={ability.id}
              className={`ability-card ${ability.is_active ? 'active' : ''} ${selectedAbility === ability.id ? 'selected' : ''}`}
              onClick={() => setSelectedAbility(ability.id)}
            >
              <div className="ability-icon">
                <img src={`/assets/abilities/${ability.id}.png`} alt={ability.name_zh} />
              </div>
              <div className="ability-info">
                <h4>{ability.name_zh}</h4>
                <p className="ability-name-en">{ability.name_en}</p>
                <p className="ability-description">{ability.description}</p>
                {ability.is_active && <span className="active-badge">激活中</span>}
              </div>
              {!ability.is_active && normalAbilities.length > 1 && (
                <button 
                  className="switch-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSwitchAbility(ability.slot);
                  }}
                  disabled={switching}
                >
                  切换
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {hiddenAbility && (
        <div className="ability-section hidden-ability">
          <h3>隐藏特性</h3>
          <div className={`ability-card ${hiddenAbility.is_active ? 'active' : ''}`}>
            <div className="ability-icon">
              <img src={`/assets/abilities/${hiddenAbility.id}.png`} alt={hiddenAbility.name_zh} />
            </div>
            <div className="ability-info">
              <h4>{hiddenAbility.name_zh}</h4>
              <p className="ability-name-en">{hiddenAbility.name_en}</p>
              <p className="ability-description">{hiddenAbility.description}</p>
              {hiddenAbility.is_active ? (
                <span className="active-badge">激活中</span>
              ) : hiddenAbility.unlocked_at ? (
                <button 
                  className="activate-btn"
                  onClick={() => handleSwitchAbility(3)}
                  disabled={switching}
                >
                  激活
                </button>
              ) : (
                <button className="unlock-btn" onClick={handleUnlockHidden}>
                  解锁（需要特性胶囊）
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {selectedAbility && (
        <div className="ability-detail-panel">
          <AbilityDetail 
            abilityId={selectedAbility} 
            onClose={() => setSelectedAbility(null)} 
          />
        </div>
      )}
    </div>
  );
};

export default AbilityManager;
```

## 验收标准

- [ ] 数据库表创建完成，包含 abilities、pokemon_abilities、player_pokemon_abilities 等表
- [ ] 特性服务核心模块实现完成，支持特性分配、切换、解锁
- [ ] 300+ 种特性定义完成，包含各类触发类型
- [ ] 捕捉时正确分配特性，隐藏特性概率约为 1%
- [ ] 特性药水系统实现完成，支持特性切换和隐藏特性解锁
- [ ] 战斗系统集成完成，特性可在战斗中自动触发
- [ ] API 路由实现完成，支持特性查询、切换、解锁等操作
- [ ] 前端组件实现完成，支持特性管理和切换 UI
- [ ] 单元测试覆盖率达到 80% 以上
- [ ] Prometheus 指标监控特性使用情况

## 影响范围

- **数据库**：新增 5 张表（abilities、pokemon_abilities、player_pokemon_abilities、ability_trigger_logs、ability_items）
- **pokemon-service**：新增 abilityService.js 核心模块和 API 路由
- **catch-service**：集成特性分配逻辑
- **gym-service**：集成特性战斗触发逻辑
- **gateway**：新增特性相关 API 路由
- **game-client**：新增 AbilityManager 组件
- **测试**：新增单元测试和集成测试

## 参考

- Pokémon 官方特性列表：https://bulbapedia.bulbagarden.net/wiki/Ability
- Pokémon Showdown 特性实现：https://github.com/smogon/pokemon-showdown
- Pokémon 特性数据集：https://github.com/pokemaster99/pokemon-abilities-dataset
