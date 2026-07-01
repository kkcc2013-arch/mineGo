/**
 * 精灵天赋系统 - 精灵服务
 * REQ-00408：精灵天赋系统与隐藏属性解锁机制
 */

const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const Redis = require('ioredis');
const logger = require('../shared/logger');
const { metrics } = require('../shared/metrics');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20
});

const redis = new Redis(process.env.REDIS_URL);

/**
 * 天赋管理器
 */
class TalentManager {
  constructor() {
    this.talentDefinitions = new Map();
    this.talentTrees = new Map();
    this.recommendations = new Map();
    this.initialized = false;
  }

  /**
   * 初始化天赋定义缓存
   */
  async initialize() {
    if (this.initialized) return;

    try {
      // 加载天赋定义
      const { rows: talents } = await db.query('SELECT * FROM talent_definitions');
      for (const talent of talents) {
        this.talentDefinitions.set(talent.id, talent);
      }

      // 加载天赋树定义
      const { rows: trees } = await db.query('SELECT * FROM talent_tree_definitions');
      for (const tree of trees) {
        this.talentTrees.set(tree.pokemon_type, tree);
      }

      // 加载推荐配置
      const { rows: recs } = await db.query('SELECT * FROM talent_recommendations');
      for (const rec of recs) {
        const key = `${rec.pokemon_type}:${rec.style}`;
        this.recommendations.set(key, rec);
      }

      this.initialized = true;
      logger.info({
        talents: this.talentDefinitions.size,
        trees: this.talentTrees.size,
        recommendations: this.recommendations.size
      }, 'TalentManager 初始化完成');
    } catch (error) {
      logger.error({ error: error.message }, 'TalentManager 初始化失败');
      throw error;
    }
  }

  /**
   * 验证天赋分配
   */
  async validateTalentAllocation(pokemonId, talentId, points = 1) {
    await this.initialize();

    // 获取精灵当前配置
    const { rows } = await db.query(
      'SELECT * FROM pokemon_talent_config WHERE pokemon_id = $1',
      [pokemonId]
    );

    if (rows.length === 0) {
      return { valid: false, reason: 'pokemon_not_found' };
    }

    const config = rows[0];
    const talentDef = this.talentDefinitions.get(talentId);

    if (!talentDef) {
      return { valid: false, reason: 'talent_not_found' };
    }

    // 检查天赋点是否足够
    const currentLevel = config.allocated_talents[talentId] || 0;
    const newLevel = currentLevel + points;

    if (newLevel > talentDef.max_level) {
      return { valid: false, reason: 'max_level_reached' };
    }

    // 检查消耗
    const cost = points * talentDef.cost_per_level;
    if (config.used_points + cost > config.total_points) {
      return { valid: false, reason: 'insufficient_points' };
    }

    // 检查前置天赋
    if (talentDef.prerequisites && talentDef.prerequisites.length > 0) {
      for (const prereq of talentDef.prerequisites) {
        const prereqLevel = config.allocated_talents[prereq] || 0;
        if (prereqLevel === 0) {
          return { valid: false, reason: 'prerequisite_not_met', prerequisite: prereq };
        }
      }
    }

    // 检查解锁条件
    if (talentDef.unlock_condition) {
      const { rows: pokemon } = await db.query(
        'SELECT level, evolution_stage FROM pokemon WHERE id = $1',
        [pokemonId]
      );
      
      if (pokemon.length === 0) {
        return { valid: false, reason: 'pokemon_not_found' };
      }

      const p = pokemon[0];
      if (talentDef.unlock_condition.level && p.level < talentDef.unlock_condition.level) {
        return { valid: false, reason: 'level_not_met' };
      }
      if (talentDef.unlock_condition.evolution && p.evolution_stage < talentDef.unlock_condition.evolution) {
        return { valid: false, reason: 'evolution_not_met' };
      }
    }

    // 检查精灵类型是否适用
    if (talentDef.pokemon_types && talentDef.pokemon_types.length > 0) {
      const { rows: typeCheck } = await db.query(
        `SELECT pt.type_name FROM pokemon_types pt
         JOIN pokemon p ON p.id = $1
         WHERE pt.pokemon_id = p.species_id`,
        [pokemonId]
      );
      
      const types = typeCheck.map(t => t.type_name);
      const applicable = talentDef.pokemon_types.some(t => types.includes(t));
      if (!applicable) {
        return { valid: false, reason: 'type_not_applicable' };
      }
    }

    return { valid: true, currentLevel, newLevel, cost };
  }

  /**
   * 分配天赋点
   */
  async allocateTalentPoint(pokemonId, talentId, points = 1) {
    const validation = await this.validateTalentAllocation(pokemonId, talentId, points);
    
    if (!validation.valid) {
      throw new Error(validation.reason);
    }

    const client = await db.connect();
    
    try {
      await client.query('BEGIN');

      // 获取当前配置
      const { rows } = await client.query(
        'SELECT * FROM pokemon_talent_config WHERE pokemon_id = $1 FOR UPDATE',
        [pokemonId]
      );

      const config = rows[0];
      const talentDef = this.talentDefinitions.get(talentId);
      const currentLevel = config.allocated_talents[talentId] || 0;
      const newLevel = currentLevel + points;
      const cost = points * talentDef.cost_per_level;

      // 更新配置
      const newAllocated = { ...config.allocated_talents };
      newAllocated[talentId] = newLevel;

      await client.query(
        `UPDATE pokemon_talent_config 
         SET allocated_talents = $1, used_points = $2, updated_at = CURRENT_TIMESTAMP
         WHERE pokemon_id = $3`,
        [JSON.stringify(newAllocated), config.used_points + cost, pokemonId]
      );

      // 重新计算隐藏属性
      const hiddenAttrs = await this._calculateHiddenAttributes(client, pokemonId, newAllocated);
      
      await client.query(
        `UPDATE pokemon_talent_config 
         SET hidden_attributes = $1 
         WHERE pokemon_id = $2`,
        [JSON.stringify(hiddenAttrs), pokemonId]
      );

      await client.query('COMMIT');

      // 清除缓存
      await redis.del(`pokemon:talent:${pokemonId}`);

      metrics.increment('talent_allocate_total', 1, { talent_id: talentId });

      logger.info({
        pokemonId,
        talentId,
        points,
        newLevel
      }, '天赋点分配成功');

      return {
        success: true,
        talentId,
        level: newLevel,
        hiddenAttributes: hiddenAttrs,
        remainingPoints: config.total_points - config.used_points - cost
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 计算隐藏属性
   */
  async _calculateHiddenAttributes(client, pokemonId, allocatedTalents) {
    const attrs = {
      criticalRate: 0.05,     // 基础暴击率 5%
      criticalDamage: 1.5,    // 基础暴击伤害 150%
      accuracy: 0.95,         // 基础命中率 95%
      dodgeRate: 0.05,        // 基础闪避率 5%
      penetration: 0,
      healingBoost: 1.0,
      energyRegen: 1.0
    };

    // 应用天赋效果
    for (const [talentId, level] of Object.entries(allocatedTalents)) {
      const talentDef = this.talentDefinitions.get(talentId);
      if (!talentDef) continue;

      const effects = talentDef.effects;
      if (!effects || !effects.valuePerLevel) continue;

      const value = effects.valuePerLevel[level - 1] || 0;

      switch (effects.type) {
        case 'attribute_boost':
          attrs[effects.attribute] = (attrs[effects.attribute] || 0) + value;
          break;
        case 'stat_boost':
          // 基础属性加成需要单独处理
          break;
        case 'cooldown_reduction':
          // 冷却缩减单独处理
          break;
      }
    }

    return attrs;
  }

  /**
   * 重置天赋
   */
  async resetTalents(pokemonId, userId, consumeItem = true) {
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // 检查重置道具
      if (consumeItem) {
        const { rows: itemCheck } = await client.query(
          `SELECT * FROM inventory 
           WHERE user_id = $1 AND item_id = 'talent_reset_token' AND quantity > 0`,
          [userId]
        );

        if (itemCheck.length === 0) {
          throw new Error('no_reset_token');
        }

        // 消耗道具
        await client.query(
          `UPDATE inventory SET quantity = quantity - 1 
           WHERE user_id = $1 AND item_id = 'talent_reset_token'`,
          [userId]
        );
      }

      // 获取当前配置
      const { rows } = await client.query(
        'SELECT * FROM pokemon_talent_config WHERE pokemon_id = $1 FOR UPDATE',
        [pokemonId]
      );

      if (rows.length === 0) {
        throw new Error('config_not_found');
      }

      const config = rows[0];
      const previousTalents = config.allocated_talents;
      const refundedPoints = config.used_points;

      // 记录重置历史
      await client.query(
        `INSERT INTO talent_reset_history 
         (pokemon_id, user_id, previous_talents, refunded_points, consumed_item_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [pokemonId, userId, JSON.stringify(previousTalents), refundedPoints, 'talent_reset_token']
      );

      // 重置配置
      await client.query(
        `UPDATE pokemon_talent_config 
         SET allocated_talents = '{}', used_points = 0, hidden_attributes = '{}', updated_at = CURRENT_TIMESTAMP
         WHERE pokemon_id = $1`,
        [pokemonId]
      );

      await client.query('COMMIT');

      // 清除缓存
      await redis.del(`pokemon:talent:${pokemonId}`);

      metrics.increment('talent_reset_total', 1);

      logger.info({
        pokemonId,
        userId,
        refundedPoints
      }, '天赋重置成功');

      return {
        success: true,
        refundedPoints,
        totalPoints: config.total_points
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取天赋推荐
   */
  async getRecommendation(pokemonId, style = 'balance') {
    await this.initialize();

    // 获取精灵类型
    const { rows } = await db.query(
      `SELECT species_id, p.level, p.evolution_stage
       FROM pokemon p WHERE p.id = $1`,
      [pokemonId]
    );

    if (rows.length === 0) {
      return null;
    }

    const pokemon = rows[0];
    
    // 获取精灵类型
    const { rows: typeRows } = await db.query(
      `SELECT string_agg(type_name, '_') as type_key
       FROM (
         SELECT DISTINCT pt.type_name
         FROM pokemon_types pt
         WHERE pt.pokemon_id = $1
         ORDER BY pt.type_name
       ) t`,
      [pokemon.species_id]
    );

    const typeKey = typeRows[0]?.type_key || 'unknown';
    
    // 查找推荐配置
    const key = `${typeKey}:${style}`;
    const recommendation = this.recommendations.get(key);

    if (!recommendation) {
      return null;
    }

    // 检查天赋是否可用
    const availableTalents = {};
    for (const talentId of Object.keys(recommendation.recommended_talents)) {
      const def = this.talentDefinitions.get(talentId);
      if (def) {
        // 检查解锁条件
        let unlocked = true;
        if (def.unlock_condition) {
          if (def.unlock_condition.level && pokemon.level < def.unlock_condition.level) {
            unlocked = false;
          }
          if (def.unlock_condition.evolution && pokemon.evolution_stage < def.unlock_condition.evolution) {
            unlocked = false;
          }
        }
        availableTalents[talentId] = {
          ...def,
          unlocked
        };
      }
    }

    return {
      style: recommendation.style,
      description: recommendation.description,
      descriptionI18n: recommendation.description_i18n,
      recommendedTalents: recommendation.recommended_talents,
      availableTalents
    };
  }

  /**
   * 获取精灵天赋配置
   */
  async getTalentConfig(pokemonId) {
    await this.initialize();

    // 先查缓存
    const cached = await redis.get(`pokemon:talent:${pokemonId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    const { rows } = await db.query(
      'SELECT * FROM pokemon_talent_config WHERE pokemon_id = $1',
      [pokemonId]
    );

    if (rows.length === 0) {
      return null;
    }

    const config = rows[0];

    // 组装天赋详情
    const talentDetails = {};
    for (const [talentId, level] of Object.entries(config.allocated_talents)) {
      const def = this.talentDefinitions.get(talentId);
      if (def) {
        talentDetails[talentId] = {
          ...def,
          currentLevel: level
        };
      }
    }

    const result = {
      pokemonId,
      totalPoints: config.total_points,
      usedPoints: config.used_points,
      remainingPoints: config.total_points - config.used_points,
      allocatedTalents: config.allocated_talents,
      hiddenAttributes: config.hidden_attributes,
      talentDetails,
      updatedAt: config.updated_at
    };

    // 缓存 5 分钟
    await redis.setex(`pokemon:talent:${pokemonId}`, 300, JSON.stringify(result));

    return result;
  }

  /**
   * 授予天赋点
   */
  async grantTalentPoints(pokemonId, source, points, details = {}) {
    const client = await db.connect();

    try {
      await client.query('BEGIN');

      // 记录获取
      await client.query(
        `INSERT INTO talent_point_records (pokemon_id, source_type, points, details)
         VALUES ($1, $2, $3, $4)`,
        [pokemonId, source, points, JSON.stringify(details)]
      );

      // 更新总点数
      const { rows } = await client.query(
        `UPDATE pokemon_talent_config 
         SET total_points = total_points + $1, updated_at = CURRENT_TIMESTAMP
         WHERE pokemon_id = $2
         RETURNING *`,
        [points, pokemonId]
      );

      await client.query('COMMIT');

      // 清除缓存
      await redis.del(`pokemon:talent:${pokemonId}`);

      logger.info({
        pokemonId,
        source,
        points,
        newTotal: rows[0].total_points
      }, '天赋点授予成功');

      return {
        success: true,
        totalPoints: rows[0].total_points
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

const talentManager = new TalentManager();

/**
 * API 路由
 */

// 获取精灵天赋配置
router.get('/:pokemonId/talent', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.id;

    // 验证精灵归属
    const { rows: ownerCheck } = await db.query(
      'SELECT owner_id FROM pokemon WHERE id = $1',
      [pokemonId]
    );

    if (ownerCheck.length === 0) {
      return res.status(404).json({ error: 'pokemon_not_found' });
    }

    if (ownerCheck[0].owner_id !== userId) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    const config = await talentManager.getTalentConfig(parseInt(pokemonId));
    
    if (!config) {
      // 初始化配置
      await db.query(
        `INSERT INTO pokemon_talent_config (pokemon_id, total_points, used_points, allocated_talents, hidden_attributes)
         VALUES ($1, 0, 0, '{}', '{}')
         ON CONFLICT (pokemon_id) DO NOTHING`,
        [pokemonId]
      );
      
      return res.json({
        pokemonId: parseInt(pokemonId),
        totalPoints: 0,
        usedPoints: 0,
        remainingPoints: 0,
        allocatedTalents: {},
        hiddenAttributes: {}
      });
    }

    res.json(config);
  } catch (error) {
    logger.error({ error: error.message }, '获取天赋配置失败');
    res.status(500).json({ error: 'internal_error' });
  }
});

// 分配天赋点
router.post('/:pokemonId/talent/allocate', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { talentId, points = 1 } = req.body;
    const userId = req.user.id;

    // 验证精灵归属
    const { rows: ownerCheck } = await db.query(
      'SELECT owner_id FROM pokemon WHERE id = $1',
      [pokemonId]
    );

    if (ownerCheck.length === 0) {
      return res.status(404).json({ error: 'pokemon_not_found' });
    }

    if (ownerCheck[0].owner_id !== userId) {
      return res.status(403).json({ error: 'not_authorized' });
    }

    // 初始化配置（如果不存在）
    await db.query(
      `INSERT INTO pokemon_talent_config (pokemon_id, total_points, used_points, allocated_talents, hidden_attributes)
       VALUES ($1, 0, 0, '{}', '{}')
       ON CONFLICT (pokemon_id) DO NOTHING`,
      [pokemonId]
    );

    const result = await talentManager.allocateTalentPoint(
      parseInt(pokemonId),
      talentId,
      points
    );

    res.json(result);
  } catch (error) {
    logger.error({ error: error.message }, '分配天赋点失败');
    
    if (error.message === 'insufficient_points') {
      return res.status(400).json({ error: 'insufficient_points' });
    }
    if (error.message.includes('prerequisite')) {
      return res.status(400).json({ error: error.message });
    }
    
    res.status(500).json({ error: 'internal_error' });
  }
});

// 重置天赋
router.post('/:pokemonId/talent/reset', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const userId = req.user.id;

    const result = await talentManager.resetTalents(parseInt(pokemonId), userId);
    res.json(result);
  } catch (error) {
    logger.error({ error: error.message }, '重置天赋失败');
    
    if (error.message === 'no_reset_token') {
      return res.status(400).json({ error: 'no_reset_token' });
    }
    
    res.status(500).json({ error: 'internal_error' });
  }
});

// 获取天赋推荐
router.get('/:pokemonId/talent/recommend', async (req, res) => {
  try {
    const { pokemonId } = req.params;
    const { style } = req.query;

    const recommendation = await talentManager.getRecommendation(
      parseInt(pokemonId),
      style || 'balance'
    );

    if (!recommendation) {
      return res.status(404).json({ error: 'no_recommendation' });
    }

    res.json(recommendation);
  } catch (error) {
    logger.error({ error: error.message }, '获取天赋推荐失败');
    res.status(500).json({ error: 'internal_error' });
  }
});

// 获取所有天赋定义
router.get('/talents', async (req, res) => {
  try {
    await talentManager.initialize();
    
    const talents = Array.from(talentManager.talentDefinitions.values());
    res.json({
      success: true,
      talents,
      total: talents.length
    });
  } catch (error) {
    logger.error({ error: error.message }, '获取天赋定义失败');
    res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
module.exports.TalentManager = TalentManager;
module.exports.talentManager = talentManager;