/**
 * 羁绊技能服务 - REQ-00151
 * 
 * 实现精灵羁绊技能解锁、学习、使用机制
 */

const { getRedis } = require('../../../shared/redis');
const { getPool } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { EventEmitter } = require('events');

const logger = createLogger('bond-skill-service');

class BondSkillService extends EventEmitter {
  constructor(config = {}) {
    super();
    this.db = config.db || getPool();
    this.redis = config.redis || getRedis();
    
    // 亲密度等级阈值（对应羁绊技能槽位解锁）
    this.UNLOCK_THRESHOLDS = {
      slot1: 26,   // 认识等级
      slot2: 76,   // 熟悉等级
      slot3: 151   // 挚友等级
    };
    
    // 最大激活羁绊技能数
    this.MAX_ACTIVE_BOND_SKILLS = 1;
  }

  /**
   * 获取精灵可用的羁绊技能列表
   * @param {number} speciesId - 精灵种类ID
   * @returns {Promise<Array>} 羁绊技能列表
   */
  async getAvailableBondSkills(speciesId) {
    const cacheKey = `bond-skills:species:${speciesId}`;
    
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      logger.debug({ speciesId }, 'Cache miss for bond skills');
    }
    
    const result = await this.db.query(`
      SELECT 
        id, pokemon_species_id, slot, skill_name, skill_name_en,
        type, power, accuracy, pp, effect_description, effect_type,
        unlock_friendship_level, friendship_bonus_formula,
        energy_cost, cooldown_turns
      FROM bond_skill_definitions
      WHERE pokemon_species_id = $1 AND is_active = true
      ORDER BY slot ASC
    `, [speciesId]);
    
    const skills = result.rows;
    
    // 缓存1小时
    await this.redis.setex(cacheKey, 3600, JSON.stringify(skills));
    
    return skills;
  }

  /**
   * 获取精灵已学习的羁绊技能
   * @param {string} pokemonInstanceId - 精灵实例ID
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 包含已学习和可学习的技能
   */
  async getPokemonBondSkills(pokemonInstanceId, userId) {
    // 获取精灵信息
    const pokemonResult = await this.db.query(`
      SELECT pi.id, pi.species_id, pi.user_id, pi.friendship
      FROM pokemon_instances pi
      WHERE pi.id = $1 AND pi.user_id = $2
    `, [pokemonInstanceId, userId]);
    
    if (pokemonResult.rows.length === 0) {
      throw new Error('Pokemon not found or not owned by user');
    }
    
    const pokemon = pokemonResult.rows[0];
    const friendship = pokemon.friendship || 0;
    
    // 获取该种类可用的羁绊技能
    const availableSkills = await this.getAvailableBondSkills(pokemon.species_id);
    
    // 获取已学习的技能
    const learnedResult = await this.db.query(`
      SELECT 
        pbs.id, pbs.bond_skill_id, pbs.learned_at, pbs.is_active,
        pbs.current_pp, pbs.times_used,
        bsd.skill_name, bsd.skill_name_en, bsd.type, bsd.power,
        bsd.accuracy, bsd.pp as max_pp, bsd.effect_description,
        bsd.effect_type, bsd.slot, bsd.energy_cost, bsd.cooldown_turns
      FROM pokemon_bond_skills pbs
      JOIN bond_skill_definitions bsd ON pbs.bond_skill_id = bsd.id
      WHERE pbs.pokemon_instance_id = $1
      ORDER BY bsd.slot ASC
    `, [pokemonInstanceId]);
    
    const learnedSkills = learnedResult.rows;
    
    // 标记每个技能的解锁状态
    const skillsWithStatus = availableSkills.map(skill => {
      const learned = learnedSkills.find(l => l.bond_skill_id === skill.id);
      const isUnlocked = friendship >= skill.unlock_friendship_level;
      
      return {
        ...skill,
        isUnlocked,
        isLearned: !!learned,
        learnedInfo: learned || null,
        friendshipRequired: skill.unlock_friendship_level,
        friendshipCurrent: friendship,
        friendshipGap: Math.max(0, skill.unlock_friendship_level - friendship)
      };
    });
    
    return {
      pokemonId: pokemonInstanceId,
      speciesId: pokemon.species_id,
      friendship,
      skills: skillsWithStatus,
      learnedCount: learnedSkills.length,
      maxSlots: 3,
      activeSkill: learnedSkills.find(s => s.is_active) || null
    };
  }

  /**
   * 学习羁绊技能
   * @param {string} pokemonInstanceId - 精灵实例ID
   * @param {number} bondSkillId - 羁绊技能ID
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 学习结果
   */
  async learnBondSkill(pokemonInstanceId, bondSkillId, userId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取精灵信息
      const pokemonResult = await client.query(`
        SELECT pi.id, pi.species_id, pi.user_id, pi.friendship
        FROM pokemon_instances pi
        WHERE pi.id = $1 AND pi.user_id = $2
        FOR UPDATE
      `, [pokemonInstanceId, userId]);
      
      if (pokemonResult.rows.length === 0) {
        throw new Error('Pokemon not found or not owned by user');
      }
      
      const pokemon = pokemonResult.rows[0];
      
      // 获取羁绊技能定义
      const skillResult = await client.query(`
        SELECT * FROM bond_skill_definitions
        WHERE id = $1 AND pokemon_species_id = $2 AND is_active = true
      `, [bondSkillId, pokemon.species_id]);
      
      if (skillResult.rows.length === 0) {
        throw new Error('Bond skill not found for this pokemon species');
      }
      
      const skill = skillResult.rows[0];
      
      // 检查亲密度是否达标
      if (pokemon.friendship < skill.unlock_friendship_level) {
        throw new Error(`Friendship level not enough. Required: ${skill.unlock_friendship_level}, Current: ${pokemon.friendship}`);
      }
      
      // 检查是否已学习
      const existingResult = await client.query(`
        SELECT id FROM pokemon_bond_skills
        WHERE pokemon_instance_id = $1 AND bond_skill_id = $2
      `, [pokemonInstanceId, bondSkillId]);
      
      if (existingResult.rows.length > 0) {
        throw new Error('Bond skill already learned');
      }
      
      // 学习技能
      const learnResult = await client.query(`
        INSERT INTO pokemon_bond_skills (
          pokemon_instance_id, bond_skill_id, current_pp, is_active
        ) VALUES ($1, $2, $3, false)
        RETURNING id, learned_at
      `, [pokemonInstanceId, bondSkillId, skill.pp]);
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this._invalidateCache(pokemonInstanceId);
      
      // 发送事件
      this.emit('bondSkillLearned', {
        userId,
        pokemonInstanceId,
        bondSkillId,
        skillName: skill.skill_name
      });
      
      logger.info({
        userId,
        pokemonInstanceId,
        bondSkillId,
        skillName: skill.skill_name
      }, 'Bond skill learned');
      
      return {
        success: true,
        learnedAt: learnResult.rows[0].learned_at,
        skill: {
          id: skill.id,
          name: skill.skill_name,
          nameEn: skill.skill_name_en,
          type: skill.type,
          power: skill.power,
          pp: skill.pp
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
   * 遗忘羁绊技能
   * @param {string} pokemonInstanceId - 精灵实例ID
   * @param {number} bondSkillId - 羁绊技能ID
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 遗忘结果
   */
  async forgetBondSkill(pokemonInstanceId, bondSkillId, userId) {
    const result = await this.db.query(`
      DELETE FROM pokemon_bond_skills
      WHERE pokemon_instance_id = $1 
        AND bond_skill_id = $2
        AND EXISTS (
          SELECT 1 FROM pokemon_instances 
          WHERE id = $1 AND user_id = $3
        )
      RETURNING id
    `, [pokemonInstanceId, bondSkillId, userId]);
    
    if (result.rows.length === 0) {
      throw new Error('Bond skill not found or not owned by user');
    }
    
    // 清除缓存
    await this._invalidateCache(pokemonInstanceId);
    
    logger.info({
      userId,
      pokemonInstanceId,
      bondSkillId
    }, 'Bond skill forgotten');
    
    return {
      success: true,
      message: 'Bond skill forgotten successfully'
    };
  }

  /**
   * 激活羁绊技能（用于战斗）
   * @param {string} pokemonInstanceId - 精灵实例ID
   * @param {number} bondSkillId - 羁绊技能ID
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 激活结果
   */
  async activateBondSkill(pokemonInstanceId, bondSkillId, userId) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 先取消所有已激活的技能
      await client.query(`
        UPDATE pokemon_bond_skills
        SET is_active = false
        WHERE pokemon_instance_id = $1
      `, [pokemonInstanceId]);
      
      // 激活指定技能
      const result = await client.query(`
        UPDATE pokemon_bond_skills
        SET is_active = true
        WHERE pokemon_instance_id = $1 
          AND bond_skill_id = $2
          AND EXISTS (
            SELECT 1 FROM pokemon_instances 
            WHERE id = $1 AND user_id = $3
          )
        RETURNING id
      `, [pokemonInstanceId, bondSkillId, userId]);
      
      if (result.rows.length === 0) {
        throw new Error('Bond skill not found or not learned');
      }
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this._invalidateCache(pokemonInstanceId);
      
      return {
        success: true,
        message: 'Bond skill activated'
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 计算羁绊技能实际效果
   * @param {string} pokemonInstanceId - 精灵实例ID
   * @param {number} bondSkillId - 羁绊技能ID
   * @param {number} friendship - 当前亲密度
   * @returns {Promise<Object>} 技能效果
   */
  async calculateBondSkillEffect(pokemonInstanceId, bondSkillId, friendship) {
    const skillResult = await this.db.query(`
      SELECT * FROM bond_skill_definitions WHERE id = $1
    `, [bondSkillId]);
    
    if (skillResult.rows.length === 0) {
      throw new Error('Bond skill not found');
    }
    
    const skill = skillResult.rows[0];
    
    // 解析羁绊加成公式
    let calculatedPower = skill.power;
    let additionalEffects = {};
    
    if (skill.friendship_bonus_formula) {
      const formula = skill.friendship_bonus_formula;
      
      // 简单公式解析
      if (formula.includes('friendship')) {
        // 计算基础数值
        const baseMatch = formula.match(/^(\d+)/);
        const bonusMatch = formula.match(/friendship\s*\*\s*([\d.]+)/);
        
        if (baseMatch && bonusMatch) {
          const base = parseInt(baseMatch[1]);
          const multiplier = parseFloat(bonusMatch[1]);
          calculatedPower = base + Math.floor(friendship * multiplier);
        }
      }
      
      // 解析额外效果
      if (formula.includes('crit_bonus')) {
        const critMatch = formula.match(/crit_bonus:\s*friendship\s*\/\s*(\d+)/);
        if (critMatch) {
          additionalEffects.critBonus = friendship / parseInt(critMatch[1]);
        }
      }
      
      if (formula.includes('ignore_resistance')) {
        additionalEffects.ignoreResistance = true;
      }
      
      if (formula.includes('shield_hp')) {
        const shieldMatch = formula.match(/shield_hp:\s*floor\(friendship\s*\*\s*(\d+)\)/);
        if (shieldMatch) {
          additionalEffects.shieldHp = Math.floor(friendship * parseInt(shieldMatch[1]));
        }
      }
    }
    
    return {
      skillId: skill.id,
      skillName: skill.skill_name,
      type: skill.type,
      effectType: skill.effect_type,
      calculatedPower,
      accuracy: skill.accuracy,
      pp: skill.pp,
      energyCost: skill.energy_cost,
      cooldownTurns: skill.cooldown_turns,
      additionalEffects,
      friendship
    };
  }

  /**
   * 记录羁绊技能使用
   * @param {Object} usageData - 使用数据
   */
  async recordSkillUsage(usageData) {
    const { userId, pokemonInstanceId, bondSkillId, battleId, damageDealt, effectApplied } = usageData;
    
    await this.db.query(`
      INSERT INTO bond_skill_usage_stats (
        user_id, pokemon_instance_id, bond_skill_id, battle_id,
        damage_dealt, effect_applied
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [userId, pokemonInstanceId, bondSkillId, battleId, damageDealt || 0, effectApplied]);
    
    // 更新使用次数
    await this.db.query(`
      UPDATE pokemon_bond_skills
      SET times_used = times_used + 1
      WHERE pokemon_instance_id = $1 AND bond_skill_id = $2
    `, [pokemonInstanceId, bondSkillId]);
  }

  /**
   * 获取羁绊技能统计
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 统计数据
   */
  async getBondSkillStats(userId) {
    const result = await this.db.query(`
      SELECT 
        COUNT(DISTINCT pbs.pokemon_instance_id) as pokemon_with_bond_skills,
        COUNT(pbs.id) as total_skills_learned,
        SUM(pbs.times_used) as total_times_used
      FROM pokemon_bond_skills pbs
      JOIN pokemon_instances pi ON pbs.pokemon_instance_id = pi.id
      WHERE pi.user_id = $1
    `, [userId]);
    
    const usageResult = await this.db.query(`
      SELECT 
        bsd.skill_name,
        bsd.type,
        COUNT(bsus.id) as usage_count,
        AVG(bsus.damage_dealt) as avg_damage
      FROM bond_skill_usage_stats bsus
      JOIN bond_skill_definitions bsd ON bsus.bond_skill_id = bsd.id
      WHERE bsus.user_id = $1
      GROUP BY bsd.id, bsd.skill_name, bsd.type
      ORDER BY usage_count DESC
      LIMIT 10
    `, [userId]);
    
    return {
      summary: result.rows[0],
      topSkills: usageResult.rows
    };
  }

  /**
   * 清除缓存
   */
  async _invalidateCache(pokemonInstanceId) {
    const pattern = `bond-skills:pokemon:${pokemonInstanceId}:*`;
    try {
      const keys = await this.redis.keys(pattern);
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (e) {
      logger.debug({ pokemonInstanceId }, 'Cache invalidation skipped');
    }
  }
}

// 导出单例
let instance = null;

function getBondSkillService(config = {}) {
  if (!instance) {
    instance = new BondSkillService(config);
  }
  return instance;
}

module.exports = {
  BondSkillService,
  getBondSkillService
};
