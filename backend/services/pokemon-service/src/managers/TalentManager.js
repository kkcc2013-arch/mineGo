/**
 * 精灵天赋管理器
 * 实现天赋点分配、隐藏属性计算、天赋推荐等功能
 */

import db from '../db/index.js';
import logger from '../../../shared/logger.js';

// 隐藏属性基础值配置
const HIDDEN_ATTRIBUTES_BASE = {
  criticalRate: { base: 0.05, max: 0.30 },
  criticalDamage: { base: 1.5, max: 2.5 },
  accuracy: { base: 0.95, max: 1.0 },
  dodgeRate: { base: 0.05, max: 0.20 },
  penetration: { base: 0, max: 0.3 },
  fireResist: { base: 0, max: 0.5 },
  waterResist: { base: 0, max: 0.5 },
  electricResist: { base: 0, max: 0.5 },
  healingBoost: { base: 1.0, max: 1.5 },
  energyRegen: { base: 1.0, max: 1.5 }
};

// 天赋点获取配置
const TALENT_POINT_RULES = {
  levelUp: {
    intervals: [10, 20, 30, 40, 50],
    points: [1, 1, 2, 2, 3]
  },
  evolution: {
    points: 3
  }
};

class TalentManager {
  constructor() {
    this.talentDefinitions = new Map();
    this.talentTrees = new Map();
    this.loadDefinitions();
  }

  /**
   * 加载天赋定义和天赋树配置
   */
  async loadDefinitions() {
    try {
      // 加载天赋定义
      const defResult = await db.query('SELECT * FROM talent_definitions');
      for (const row of defResult.rows) {
        this.talentDefinitions.set(row.id, row);
      }

      // 加载天赋树定义
      const treeResult = await db.query('SELECT * FROM talent_tree_definitions');
      for (const row of treeResult.rows) {
        this.talentTrees.set(row.pokemon_type, row);
      }

      logger.info('Talent definitions loaded', {
        talents: this.talentDefinitions.size,
        trees: this.talentTrees.size
      });
    } catch (error) {
      logger.error('Failed to load talent definitions', { error });
    }
  }

  /**
   * 获取精灵的天赋树
   * @param {string} pokemonType 精灵类型
   * @returns {Object} 天赋树配置
   */
  getTalentTree(pokemonType) {
    return this.talentTrees.get(pokemonType) || this.talentTrees.get('default');
  }

  /**
   * 获取天赋定义
   * @param {string} talentId 天赋ID
   * @returns {Object|null} 天赋定义
   */
  getTalentDefinition(talentId) {
    return this.talentDefinitions.get(talentId);
  }

  /**
   * 验证天赋分配是否有效
   * @param {number} pokemonId 精灵ID
   * @param {string} talentId 天赋ID
   * @param {number} points 分配点数
   * @returns {Object} 验证结果 { valid, reason }
   */
  async validateTalentAllocation(pokemonId, talentId, points = 1) {
    // 获取精灵信息
    const pokemonResult = await db.query(`
      SELECT p.*, ptc.allocated_talents, ptc.total_points, ptc.used_points
      FROM pokemon p
      LEFT JOIN pokemon_talent_config ptc ON p.id = ptc.pokemon_id
      WHERE p.id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return { valid: false, reason: 'Pokemon not found' };
    }

    const pokemon = pokemonResult.rows[0];
    const allocatedTalents = pokemon.allocated_talents || {};
    const usedPoints = pokemon.used_points || 0;
    const totalPoints = pokemon.total_points || 0;

    // 检查天赋点是否足够
    if (usedPoints + points > totalPoints) {
      return { valid: false, reason: 'Not enough talent points' };
    }

    // 获取天赋定义
    const talentDef = this.getTalentDefinition(talentId);
    if (!talentDef) {
      return { valid: false, reason: 'Talent not found' };
    }

    // 检查精灵类型是否匹配
    if (talentDef.pokemon_types.length > 0 && 
        !talentDef.pokemon_types.includes('all') &&
        !talentDef.pokemon_types.includes(pokemon.type)) {
      return { valid: false, reason: 'Talent not available for this Pokemon type' };
    }

    // 检查当前等级
    const currentLevel = allocatedTalents[talentId] || 0;
    if (currentLevel + points > talentDef.max_level) {
      return { valid: false, reason: `Talent max level (${talentDef.max_level}) reached` };
    }

    // 检查精灵等级是否满足解锁条件
    if (talentDef.unlock_condition?.level && pokemon.level < talentDef.unlock_condition.level) {
      return { valid: false, reason: `Requires Pokemon level ${talentDef.unlock_condition.level}` };
    }

    // 检查前置天赋
    for (const prereq of talentDef.prerequisites) {
      const [prereqId, prereqLevel] = prereq.split(':');
      const prereqCurrentLevel = allocatedTalents[prereqId] || 0;
      if (prereqCurrentLevel < parseInt(prereqLevel)) {
        const prereqDef = this.getTalentDefinition(prereqId);
        return { 
          valid: false, 
          reason: `Requires ${prereqDef?.name || prereqId} level ${prereqLevel}` 
        };
      }
    }

    return { valid: true };
  }

  /**
   * 分配天赋点
   * @param {number} pokemonId 精灵ID
   * @param {string} talentId 天赋ID
   * @param {number} points 分配点数
   * @returns {Object} 分配结果
   */
  async allocateTalentPoint(pokemonId, talentId, points = 1) {
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');

      // 获取当前配置
      const configResult = await client.query(`
        SELECT * FROM pokemon_talent_config WHERE pokemon_id = $1 FOR UPDATE
      `, [pokemonId]);

      let config = configResult.rows[0];
      const allocatedTalents = config?.allocated_talents || {};
      const usedPoints = config?.used_points || 0;
      const totalPoints = config?.total_points || 0;

      // 更新天赋分配
      const currentLevel = allocatedTalents[talentId] || 0;
      const newLevel = Math.min(currentLevel + points, this.getTalentDefinition(talentId)?.max_level || 3);
      allocatedTalents[talentId] = newLevel;

      // 计算隐藏属性
      const hiddenAttributes = this.calculateHiddenAttributes(allocatedTalents);

      // 更新或插入配置
      if (config) {
        await client.query(`
          UPDATE pokemon_talent_config 
          SET allocated_talents = $1, used_points = $2, hidden_attributes = $3, updated_at = CURRENT_TIMESTAMP
          WHERE pokemon_id = $4
        `, [JSON.stringify(allocatedTalents), usedPoints + (newLevel - currentLevel), JSON.stringify(hiddenAttributes), pokemonId]);
      } else {
        await client.query(`
          INSERT INTO pokemon_talent_config (pokemon_id, allocated_talents, used_points, hidden_attributes)
          VALUES ($1, $2, $3, $4)
        `, [pokemonId, JSON.stringify(allocatedTalents), newLevel, JSON.stringify(hiddenAttributes)]);
      }

      await client.query('COMMIT');

      logger.info('Talent allocated', { pokemonId, talentId, level: newLevel });

      return {
        success: true,
        talentId,
        level: newLevel,
        hiddenAttributes
      };

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to allocate talent', { error, pokemonId, talentId });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 重置精灵天赋
   * @param {number} pokemonId 精灵ID
   * @param {number} userId 用户ID
   * @returns {Object} 重置结果
   */
  async resetTalents(pokemonId, userId) {
    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // 获取当前配置
      const configResult = await client.query(`
        SELECT * FROM pokemon_talent_config WHERE pokemon_id = $1 FOR UPDATE
      `, [pokemonId]);

      if (!configResult.rows.length) {
        await client.query('ROLLBACK');
        return { success: false, reason: 'No talent config found' };
      }

      const config = configResult.rows[0];
      const refundedPoints = config.used_points;

      // 记录重置日志
      await client.query(`
        INSERT INTO talent_reset_logs (pokemon_id, user_id, previous_talents, previous_points, refunded_points, consumed_item)
        VALUES ($1, $2, $3, $4, $5, 'talent_reset_token')
      `, [pokemonId, userId, config.allocated_talents, config.used_points, refundedPoints]);

      // 重置配置
      const hiddenAttributes = this.calculateHiddenAttributes({});
      
      await client.query(`
        UPDATE pokemon_talent_config 
        SET allocated_talents = '{}', used_points = 0, hidden_attributes = $1, updated_at = CURRENT_TIMESTAMP
        WHERE pokemon_id = $2
      `, [JSON.stringify(hiddenAttributes), pokemonId]);

      await client.query('COMMIT');

      logger.info('Talents reset', { pokemonId, refundedPoints });

      return {
        success: true,
        refundedPoints
      };

    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to reset talents', { error, pokemonId });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 计算隐藏属性
   * @param {Object} allocatedTalents 已分配天赋 { "talent_id": level }
   * @returns {Object} 隐藏属性值
   */
  calculateHiddenAttributes(allocatedTalents) {
    const attributes = { ...Object.fromEntries(
      Object.entries(HIDDEN_ATTRIBUTES_BASE).map(([k, v]) => [k, v.base])
    )};

    for (const [talentId, level] of Object.entries(allocatedTalents)) {
      const talentDef = this.getTalentDefinition(talentId);
      if (!talentDef?.effects) continue;

      for (const [attr, config] of Object.entries(talentDef.effects)) {
        if (attr === 'skillDamageBonus') continue; // 技能伤害加成单独处理

        const baseValue = attributes[attr] || 0;
        const talentValue = config.base + config.perLevel * level;
        attributes[attr] = Math.min(baseValue + talentValue, HIDDEN_ATTRIBUTES_BASE[attr]?.max || 1);
      }
    }

    // 格式化输出
    return {
      criticalRate: Math.round((attributes.criticalRate || 0.05) * 100) / 100,
      criticalDamage: Math.round((attributes.criticalDamage || 1.5) * 100) / 100,
      accuracy: Math.round((attributes.accuracy || 0.95) * 100) / 100,
      dodgeRate: Math.round((attributes.dodgeRate || 0.05) * 100) / 100,
      penetration: Math.round((attributes.penetration || 0) * 100) / 100,
      resistances: {
        fire: Math.round((attributes.fireResist || 0) * 100) / 100,
        water: Math.round((attributes.waterResist || 0) * 100) / 100,
        electric: Math.round((attributes.electricResist || 0) * 100) / 100
      },
      healingBoost: Math.round((attributes.healingBoost || 1.0) * 100) / 100,
      energyRegen: Math.round((attributes.energyRegen || 1.0) * 100) / 100,
      skillDamageBonus: this.calculateSkillDamageBonus(allocatedTalents)
    };
  }

  /**
   * 计算技能伤害加成
   */
  calculateSkillDamageBonus(allocatedTalents) {
    const bonuses = {};
    
    for (const [talentId, level] of Object.entries(allocatedTalents)) {
      const talentDef = this.getTalentDefinition(talentId);
      if (!talentDef?.effects?.skillDamageBonus) continue;

      const config = talentDef.effects.skillDamageBonus;
      const bonus = config.base + config.perLevel * level;
      
      if (config.type === 'all') {
        bonuses.all = (bonuses.all || 0) + bonus;
      } else {
        bonuses[config.type] = (bonuses[config.type] || 0) + bonus;
      }
    }

    return bonuses;
  }

  /**
   * 获取天赋推荐配置
   * @param {number} pokemonId 精灵ID
   * @param {string} style 风格：attack/defense/balance
   * @returns {Object} 推荐配置
   */
  async getRecommendation(pokemonId, style = 'balance') {
    // 获取精灵信息
    const pokemonResult = await db.query(`
      SELECT p.*, ptc.total_points
      FROM pokemon p
      LEFT JOIN pokemon_talent_config ptc ON p.id = ptc.pokemon_id
      WHERE p.id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return null;
    }

    const pokemon = pokemonResult.rows[0];
    const talentTree = this.getTalentTree(pokemon.type);
    
    if (!talentTree) {
      return { error: 'No talent tree found' };
    }

    const totalPoints = pokemon.total_points || 10;
    
    // 根据风格生成推荐
    const recommendations = {
      attack: this.generateAttackRecommendation(talentTree, totalPoints),
      defense: this.generateDefenseRecommendation(talentTree, totalPoints),
      balance: this.generateBalanceRecommendation(talentTree, totalPoints)
    };

    return {
      style,
      recommendation: recommendations[style] || recommendations.balance,
      totalPoints,
      preview: this.previewAttributes(recommendations[style])
    };
  }

  /**
   * 生成攻击型推荐
   */
  generateAttackRecommendation(talentTree, totalPoints) {
    const recommendation = {};
    let pointsUsed = 0;

    // 优先攻击天赋
    const attackTalents = talentTree.branches.attack || [];
    for (const talentId of attackTalents) {
      if (pointsUsed >= totalPoints) break;
      const def = this.getTalentDefinition(talentId);
      if (!def) continue;

      // 满级或尽可能高
      const maxPossible = Math.min(def.max_level, totalPoints - pointsUsed);
      if (maxPossible > 0) {
        recommendation[talentId] = maxPossible;
        pointsUsed += maxPossible;
      }
    }

    return recommendation;
  }

  /**
   * 生成防御型推荐
   */
  generateDefenseRecommendation(talentTree, totalPoints) {
    const recommendation = {};
    let pointsUsed = 0;

    const defenseTalents = talentTree.branches.defense || [];
    for (const talentId of defenseTalents) {
      if (pointsUsed >= totalPoints) break;
      const def = this.getTalentDefinition(talentId);
      if (!def) continue;

      const maxPossible = Math.min(def.max_level, totalPoints - pointsUsed);
      if (maxPossible > 0) {
        recommendation[talentId] = maxPossible;
        pointsUsed += maxPossible;
      }
    }

    return recommendation;
  }

  /**
   * 生成平衡型推荐
   */
  generateBalanceRecommendation(talentTree, totalPoints) {
    const recommendation = {};
    let pointsUsed = 0;

    // 均衡分配
    const allTalents = [
      ...(talentTree.branches.attack || []),
      ...(talentTree.branches.defense || []),
      ...(talentTree.branches.support || [])
    ];

    // 按优先级排序（基础属性优先）
    allTalents.sort((a, b) => {
      const defA = this.getTalentDefinition(a);
      const defB = this.getTalentDefinition(b);
      const priorityOrder = { attack: 1, defense: 1, support: 2, utility: 3 };
      return (priorityOrder[defA?.category] || 99) - (priorityOrder[defB?.category] || 99);
    });

    // 第一轮：每个天赋分配1点
    for (const talentId of allTalents) {
      if (pointsUsed >= totalPoints) break;
      const def = this.getTalentDefinition(talentId);
      if (!def || def.max_level < 1) continue;

      recommendation[talentId] = 1;
      pointsUsed += 1;
    }

    // 第二轮：补满主要天赋
    for (const talentId of allTalents) {
      if (pointsUsed >= totalPoints) break;
      const current = recommendation[talentId] || 0;
      const def = this.getTalentDefinition(talentId);
      if (!def || current >= def.max_level) continue;

      const toAdd = Math.min(def.max_level - current, totalPoints - pointsUsed);
      recommendation[talentId] = current + toAdd;
      pointsUsed += toAdd;
    }

    return recommendation;
  }

  /**
   * 预览天赋配置的隐藏属性
   */
  previewAttributes(allocatedTalents) {
    return this.calculateHiddenAttributes(allocatedTalents);
  }

  /**
   * 计算精灵升级获得的天赋点
   * @param {number} currentLevel 当前等级
   * @param {number} newLevel 新等级
   * @returns {number} 获得的天赋点
   */
  calculateLevelUpPoints(currentLevel, newLevel) {
    let points = 0;
    for (let i = 0; i < TALENT_POINT_RULES.levelUp.intervals.length; i++) {
      const threshold = TALENT_POINT_RULES.levelUp.intervals[i];
      if (currentLevel < threshold && newLevel >= threshold) {
        points += TALENT_POINT_RULES.levelUp.points[i];
      }
    }
    return points;
  }

  /**
   * 添加天赋点（升级/进化时调用）
   * @param {number} pokemonId 精灵ID
   * @param {string} source 来源：levelUp/evolution
   * @param {number} points 点数
   */
  async addTalentPoints(pokemonId, source, points) {
    const result = await db.query(`
      INSERT INTO pokemon_talent_config (pokemon_id, total_points, point_sources)
      VALUES ($1, $2, jsonb_build_array(jsonb_build_object('source', $3, 'points', $4, 'timestamp', EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))))
      ON CONFLICT (pokemon_id) DO UPDATE SET
        total_points = pokemon_talent_config.total_points + $2,
        point_sources = pokemon_talent_config.point_sources || jsonb_build_array(jsonb_build_object('source', $3, 'points', $4, 'timestamp', EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))),
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `, [pokemonId, points, source, points]);

    return result.rows[0];
  }

  /**
   * 获取精灵的完整天赋信息
   * @param {number} pokemonId 精灵ID
   * @returns {Object} 天赋信息
   */
  async getTalentInfo(pokemonId) {
    // 获取精灵信息
    const pokemonResult = await db.query(`
      SELECT p.*, ptc.*
      FROM pokemon p
      LEFT JOIN pokemon_talent_config ptc ON p.id = ptc.pokemon_id
      WHERE p.id = $1
    `, [pokemonId]);

    if (!pokemonResult.rows.length) {
      return null;
    }

    const pokemon = pokemonResult.rows[0];
    const talentTree = this.getTalentTree(pokemon.type);

    return {
      pokemonId,
      pokemonType: pokemon.type,
      level: pokemon.level,
      talentTree: talentTree?.branches || {},
      allocatedTalents: pokemon.allocated_talents || {},
      totalPoints: pokemon.total_points || 0,
      usedPoints: pokemon.used_points || 0,
      hiddenAttributes: pokemon.hidden_attributes || this.calculateHiddenAttributes({}),
      pointSources: pokemon.point_sources || []
    };
  }
}

export default new TalentManager();
