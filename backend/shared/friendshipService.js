/**
 * REQ-00079: 精灵好感度服务
 * 实现好感度数值系统、互动机制、亲密度进化
 */

const { logger, metrics } = require('./logger');
const { getDb } = require('./db');
const redis = require('./redis');

class FriendshipService {
  constructor() {
    this.db = null;
    
    // 好感度等级定义
    this.FRIENDSHIP_LEVELS = {
      stranger: { min: 0, max: 49, label: '陌生', emoji: '😐' },
      normal: { min: 50, max: 99, label: '一般', emoji: '🙂' },
      friendly: { min: 100, max: 149, label: '友好', emoji: '😊' },
      close: { min: 150, max: 199, label: '亲密', emoji: '😍' },
      beloved: { min: 200, max: 255, label: '挚爱', emoji: '🥰' }
    };
    
    // 初始好感度配置
    this.BASE_FRIENDSHIP = {
      caught_wild: 50,
      caught_friend_ball: 150,
      hatched: 120,
      traded: 50,
      gift: 100
    };
  }

  /**
   * 获取数据库连接
   */
  getDatabase() {
    if (!this.db) {
      this.db = getDb();
    }
    return this.db;
  }

  /**
   * 获取精灵好感度
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @returns {Promise<Object>} 好感度数据
   */
  async getFriendship(pokemonInstanceId) {
    const cacheKey = `friendship:${pokemonInstanceId}`;
    
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      // Redis 缓存失败不影响主流程
    }
    
    const db = this.getDatabase();
    const result = await db.query(
      `SELECT pf.*, pi.species_id
       FROM pokemon_friendship pf
       JOIN pokemon_instances pi ON pf.pokemon_instance_id = pi.id
       WHERE pf.pokemon_instance_id = $1`,
      [pokemonInstanceId]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    const friendship = this.enrichFriendshipData(result.rows[0]);
    
    // 缓存 5 分钟
    try {
      await redis.setex(cacheKey, 300, JSON.stringify(friendship));
    } catch (err) {
      // 忽略缓存错误
    }
    
    return friendship;
  }

  /**
   * 初始化精灵好感度
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {string} caughtWith - 捕获方式
   * @returns {Promise<Object>} 好感度数据
   */
  async initializeFriendship(pokemonInstanceId, caughtWith = 'caught_wild') {
    const initialValue = this.BASE_FRIENDSHIP[caughtWith] || 50;
    const level = this.calculateFriendshipLevel(initialValue);
    const db = this.getDatabase();
    
    const result = await db.query(
      `INSERT INTO pokemon_friendship 
       (pokemon_instance_id, friendship_value, friendship_level, first_obtained_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (pokemon_instance_id) DO UPDATE
       SET friendship_value = $2, friendship_level = $3
       RETURNING *`,
      [pokemonInstanceId, initialValue, level]
    );
    
    metrics.increment('friendship.initialized');
    logger.info('Friendship initialized', { pokemonInstanceId, initialValue, caughtWith });
    
    return this.enrichFriendshipData(result.rows[0]);
  }

  /**
   * 修改好感度
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {number} change - 变化量
   * @param {string} source - 来源
   * @param {Object} metadata - 元数据
   * @returns {Promise<Object>} 修改结果
   */
  async modifyFriendship(pokemonInstanceId, change, source, metadata = {}) {
    const db = this.getDatabase();
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前值
      const current = await client.query(
        'SELECT friendship_value, friendship_level FROM pokemon_friendship WHERE pokemon_instance_id = $1 FOR UPDATE',
        [pokemonInstanceId]
      );
      
      if (current.rows.length === 0) {
        throw new Error(`Friendship record not found for pokemon ${pokemonInstanceId}`);
      }
      
      const beforeValue = current.rows[0].friendship_value;
      const beforeLevel = current.rows[0].friendship_level;
      const afterValue = Math.max(0, Math.min(255, beforeValue + change));
      const newLevel = this.calculateFriendshipLevel(afterValue);
      
      // 更新好感度
      await client.query(
        `UPDATE pokemon_friendship 
         SET friendship_value = $1, 
             friendship_level = $2,
             last_interaction_at = CURRENT_TIMESTAMP,
             total_interactions = total_interactions + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE pokemon_instance_id = $3`,
        [afterValue, newLevel, pokemonInstanceId]
      );
      
      // 记录历史
      await client.query(
        `INSERT INTO friendship_history 
         (pokemon_instance_id, change_type, change_amount, before_value, after_value, source, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [pokemonInstanceId, source, change, beforeValue, afterValue, source, JSON.stringify(metadata)]
      );
      
      await client.query('COMMIT');
      
      // 清除缓存
      try {
        await redis.del(`friendship:${pokemonInstanceId}`);
      } catch (err) {
        // 忽略
      }
      
      // 记录指标
      metrics.histogram('friendship.change', change, { source });
      
      const levelUp = newLevel !== beforeLevel;
      if (levelUp) {
        metrics.increment(`friendship.level_up.${newLevel}`);
        logger.info('Friendship level changed', { 
          pokemonInstanceId, 
          from: beforeLevel,
          to: newLevel,
          value: afterValue
        });
      }
      
      return {
        before: beforeValue,
        after: afterValue,
        change: afterValue - beforeValue,
        level: newLevel,
        levelUp,
        levelInfo: this.FRIENDSHIP_LEVELS[newLevel]
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 处理行走步数奖励
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {number} steps - 步数
   * @returns {Promise<Object>} 奖励结果
   */
  async processWalkingBonus(pokemonInstanceId, steps) {
    const today = new Date().toISOString().split('T')[0];
    const db = this.getDatabase();
    
    const result = await db.query(
      `SELECT daily_walking_bonus, last_walking_bonus_date 
       FROM pokemon_friendship 
       WHERE pokemon_instance_id = $1`,
      [pokemonInstanceId]
    );
    
    if (result.rows.length === 0) return null;
    
    const friendship = result.rows[0];
    
    // 检查是否需要重置每日计数
    let dailyBonus = friendship.daily_walking_bonus;
    if (friendship.last_walking_bonus_date?.toISOString().split('T')[0] !== today) {
      await db.query(
        `UPDATE pokemon_friendship 
         SET daily_walking_bonus = 0, last_walking_bonus_date = $1
         WHERE pokemon_instance_id = $2`,
        [today, pokemonInstanceId]
      );
      dailyBonus = 0;
    }
    
    // 检查是否达到每日上限
    if (dailyBonus >= 10) {
      return { bonus: false, reason: 'daily_limit_reached' };
    }
    
    // 每256步获得1点好感度
    const bonusCount = Math.floor(steps / 256);
    const actualBonus = Math.min(bonusCount, 10 - dailyBonus);
    
    if (actualBonus > 0) {
      await this.modifyFriendship(pokemonInstanceId, actualBonus, 'walking', { steps });
      
      await db.query(
        `UPDATE pokemon_friendship 
         SET daily_walking_bonus = daily_walking_bonus + $1
         WHERE pokemon_instance_id = $2`,
        [actualBonus, pokemonInstanceId]
      );
    }
    
    return { bonus: true, amount: actualBonus };
  }

  /**
   * 检查亲密度进化
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {string} userId - 用户ID
   * @returns {Promise<Object>} 进化检查结果
   */
  async checkFriendshipEvolution(pokemonInstanceId, userId) {
    const friendship = await this.getFriendship(pokemonInstanceId);
    
    if (!friendship) {
      return { canEvolve: false, reason: 'friendship_not_found' };
    }
    
    const db = this.getDatabase();
    const result = await db.query(
      `SELECT fer.*, 
              ps.species_id as evolution_species_code,
              ps.name as evolution_name
       FROM friendship_evolution_rules fer
       JOIN pokemon_species ps ON fer.evolution_species_id = ps.id
       WHERE fer.species_id = $1`,
      [friendship.species_id]
    );
    
    if (result.rows.length === 0) {
      return { canEvolve: false, reason: 'no_evolution_available' };
    }
    
    const rule = result.rows[0];
    
    // 检查好感度是否达标
    if (friendship.friendship_value < rule.required_friendship) {
      return { 
        canEvolve: false, 
        reason: 'friendship_too_low',
        current: friendship.friendship_value,
        required: rule.required_friendship
      };
    }
    
    // 检查时间条件
    if (rule.time_condition) {
      const hour = new Date().getHours();
      const isDay = hour >= 6 && hour < 18;
      
      if (rule.time_condition === 'day' && !isDay) {
        return { canEvolve: false, reason: 'not_daytime' };
      }
      if (rule.time_condition === 'night' && isDay) {
        return { canEvolve: false, reason: 'not_nighttime' };
      }
    }
    
    return {
      canEvolve: true,
      evolutionSpeciesId: rule.evolution_species_id,
      evolutionSpeciesCode: rule.evolution_species_code,
      evolutionName: rule.evolution_name,
      requiredFriendship: rule.required_friendship,
      currentFriendship: friendship.friendship_value,
      currentSpeciesId: friendship.species_id
    };
  }

  /**
   * 执行亲密度进化
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {string} userId - 用户ID
   * @returns {Promise<Object>} 进化结果
   */
  async performFriendshipEvolution(pokemonInstanceId, userId) {
    const evolutionCheck = await this.checkFriendshipEvolution(pokemonInstanceId, userId);
    
    if (!evolutionCheck.canEvolve) {
      throw new Error(`Cannot evolve: ${evolutionCheck.reason}`);
    }
    
    const db = this.getDatabase();
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 更新精灵物种
      await client.query(
        `UPDATE pokemon_instances 
         SET species_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [evolutionCheck.evolutionSpeciesId, pokemonInstanceId]
      );
      
      // 记录进化事件（如果表存在）
      try {
        await client.query(
          `INSERT INTO pokemon_evolution_history 
           (pokemon_instance_id, from_species_id, to_species_id, evolution_type, user_id, created_at)
           VALUES ($1, $2, $3, 'friendship', $4, CURRENT_TIMESTAMP)`,
          [pokemonInstanceId, evolutionCheck.currentSpeciesId, evolutionCheck.evolutionSpeciesId, userId]
        );
      } catch (err) {
        // 表可能不存在，忽略
      }
      
      await client.query('COMMIT');
      
      metrics.increment('friendship.evolution');
      logger.info('Friendship evolution completed', {
        pokemonInstanceId,
        userId,
        newSpecies: evolutionCheck.evolutionName
      });
      
      return {
        ...evolutionCheck,
        message: `恭喜！精灵进化成了 ${evolutionCheck.evolutionName}！`
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 计算战斗加成
   * @param {number} friendshipValue - 好感度值
   * @returns {Object} 战斗加成
   */
  calculateBattleBonuses(friendshipValue) {
    const level = this.calculateFriendshipLevel(friendshipValue);
    
    let critBonus = 0;
    let evasionBonus = 0;
    let persistChance = 0;
    
    if (friendshipValue >= 200) {
      critBonus = 0.10;
      evasionBonus = 0.10;
      persistChance = 0.10;
    } else if (friendshipValue >= 150) {
      critBonus = 0.07;
      evasionBonus = 0.07;
      persistChance = 0.07;
    } else if (friendshipValue >= 100) {
      critBonus = 0.05;
      evasionBonus = 0.05;
      persistChance = 0.05;
    }
    
    return {
      critBonus,
      evasionBonus,
      persistChance,
      level
    };
  }

  /**
   * 计算好感度等级
   * @param {number} value - 好感度值
   * @returns {string} 等级名称
   */
  calculateFriendshipLevel(value) {
    if (value >= 200) return 'beloved';
    if (value >= 150) return 'close';
    if (value >= 100) return 'friendly';
    if (value >= 50) return 'normal';
    return 'stranger';
  }

  /**
   * 丰富好感度数据
   * @param {Object} data - 原始数据
   * @returns {Object} 丰富后的数据
   */
  enrichFriendshipData(data) {
    const level = this.FRIENDSHIP_LEVELS[data.friendship_level] || this.FRIENDSHIP_LEVELS.normal;
    return {
      ...data,
      levelInfo: level,
      battleBonuses: this.calculateBattleBonuses(data.friendship_value),
      evolutionReady: data.friendship_value >= 220
    };
  }

  /**
   * 获取互动配置
   * @param {string} interactionType - 互动类型
   * @returns {Promise<Object|null>} 互动配置
   */
  async getInteractionConfig(interactionType) {
    const db = this.getDatabase();
    const result = await db.query(
      'SELECT * FROM friendship_interaction_config WHERE interaction_type = $1 AND is_active = TRUE',
      [interactionType]
    );
    
    return result.rows[0] || null;
  }

  /**
   * 获取互动状态
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @returns {Promise<Object>} 互动状态
   */
  async getInteractionStatus(pokemonInstanceId) {
    const today = new Date().toISOString().split('T')[0];
    const db = this.getDatabase();
    
    const result = await db.query(
      `SELECT daily_interaction_count, last_interaction_date 
       FROM pokemon_friendship 
       WHERE pokemon_instance_id = $1`,
      [pokemonInstanceId]
    );
    
    if (result.rows.length === 0) return null;
    
    const data = result.rows[0];
    
    // 获取今日互动记录
    const interactions = await db.query(
      `SELECT change_type, COUNT(*) as count, SUM(change_amount) as total_change
       FROM friendship_history
       WHERE pokemon_instance_id = $1 AND DATE(created_at) = $2
       GROUP BY change_type`,
      [pokemonInstanceId, today]
    );
    
    return {
      dailyCount: data.last_interaction_date?.toISOString().split('T')[0] === today 
        ? data.daily_interaction_count 
        : 0,
      todayInteractions: interactions.rows
    };
  }

  /**
   * 获取好感度历史
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {number} limit - 限制数量
   * @param {number} offset - 偏移量
   * @returns {Promise<Array>} 历史记录
   */
  async getFriendshipHistory(pokemonInstanceId, limit = 50, offset = 0) {
    const db = this.getDatabase();
    const result = await db.query(
      `SELECT * FROM friendship_history
       WHERE pokemon_instance_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [pokemonInstanceId, limit, offset]
    );
    
    return result.rows;
  }

  /**
   * 处理战斗结果
   * @param {number} pokemonInstanceId - 精灵实例ID
   * @param {boolean} won - 是否胜利
   * @param {boolean} fainted - 是否晕倒
   * @returns {Promise<Object|null>} 好感度变化结果
   */
  async processBattleResult(pokemonInstanceId, won, fainted) {
    if (fainted) {
      return await this.modifyFriendship(pokemonInstanceId, -5, 'faint', { won, fainted });
    }
    
    if (won) {
      return await this.modifyFriendship(pokemonInstanceId, 1, 'battle_win', {});
    }
    
    return null;
  }
}

// 导出单例
const friendshipService = new FriendshipService();
module.exports = friendshipService;
