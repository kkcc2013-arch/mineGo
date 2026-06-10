/**
 * 精灵羁绊服务 - REQ-00067
 * 
 * 实现精灵与训练师之间的深度互动养成系统
 */

const { getRedis } = require('../../../shared/redis');
const { getPool } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { EventEmitter } = require('events');

const logger = createLogger('friendship-service');

class FriendshipService extends EventEmitter {
  constructor(config = {}) {
    super();
    this.db = config.db || getPool();
    this.redis = config.redis || getRedis();
    
    // 羁绊等级配置（11级：0-10）
    this.FRIENDSHIP_LEVELS = [
      { level: 0, min: 0, max: 25, name: '陌生人', nameEn: 'Stranger' },
      { level: 1, min: 26, max: 50, name: '认识', nameEn: 'Acquaintance' },
      { level: 2, min: 51, max: 75, name: '友好', nameEn: 'Friendly' },
      { level: 3, min: 76, max: 100, name: '熟悉', nameEn: 'Familiar' },
      { level: 4, min: 101, max: 125, name: '信任', nameEn: 'Trusting' },
      { level: 5, min: 126, max: 150, name: '亲密', nameEn: 'Close' },
      { level: 6, min: 151, max: 175, name: '挚友', nameEn: 'Best Friend' },
      { level: 7, min: 176, max: 200, name: '魂友', nameEn: 'Soul Friend' },
      { level: 8, min: 201, max: 225, name: '生死之交', nameEn: 'Lifelong Bond' },
      { level: 9, min: 226, max: 250, name: '心灵相通', nameEn: 'Kindred Spirit' },
      { level: 10, min: 251, max: 255, name: '灵魂羁绊', nameEn: 'Soul Bond' }
    ];
    
    // 互动类型配置
    this.INTERACTION_TYPES = {
      feed: {
        friendshipGain: 15,
        moodEffect: 'happy',
        moodDuration: 120,
        cooldown: 60, // 分钟
        resourceRequired: { type: 'berry' },
        description: '喂食精灵，提升羁绊'
      },
      play: {
        friendshipGain: 10,
        moodEffect: 'excited',
        moodDuration: 90,
        cooldown: 120,
        resourceRequired: { type: 'toy' },
        description: '与精灵游玩，提升羁绊'
      },
      pet: {
        friendshipGain: 5,
        moodEffect: 'happy',
        moodDuration: 60,
        cooldown: 30,
        resourceRequired: null,
        description: '抚摸精灵，提升羁绊'
      },
      train: {
        friendshipGain: 20,
        moodEffect: 'tired',
        moodDuration: 30,
        cooldown: 180,
        resourceRequired: null,
        description: '训练精灵，提升羁绊'
      },
      walk: {
        friendshipGain: 12,
        moodEffect: 'excited',
        moodDuration: 150,
        cooldown: 240,
        resourceRequired: null,
        locationRequired: true,
        description: '带精灵散步，提升羁绊'
      }
    };
    
    // 心情效果配置
    this.MOOD_EFFECTS = {
      happy: { friendshipMultiplier: 1.2, battleBonus: { critRate: 0.05, evasionRate: 0 } },
      excited: { friendshipMultiplier: 1.3, battleBonus: { critRate: 0, evasionRate: 0.05 } },
      neutral: { friendshipMultiplier: 1.0, battleBonus: { critRate: 0, evasionRate: 0 } },
      sad: { friendshipMultiplier: 0.8, battleBonus: { critRate: 0, evasionRate: 0 } },
      tired: { friendshipMultiplier: 0.9, battleBonus: { critRate: -0.05, evasionRate: 0 } }
    };
  }

  /**
   * 获取精灵羁绊信息
   */
  async getFriendshipInfo(pokemonId, userId) {
    const cacheKey = `friendship:${pokemonId}:${userId}`;
    
    try {
      // 尝试从缓存获取
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        logger.debug({ pokemonId, userId }, 'Friendship info from cache');
        return JSON.parse(cached);
      }
      
      // 从数据库查询
      const result = await this.db.query(
        `SELECT pf.*, p.species_id, p.nickname, p.level as pokemon_level, p.is_shiny
         FROM pokemon_friendship pf
         JOIN pokemons p ON pf.pokemon_id = p.id
         WHERE pf.pokemon_id = $1 AND pf.user_id = $2`,
        [pokemonId, userId]
      );
      
      if (result.rows.length === 0) {
        // 创建初始羁绊记录
        return await this.initFriendship(pokemonId, userId);
      }
      
      const friendship = result.rows[0];
      
      // 检查心情是否过期
      if (friendship.mood_expiry && new Date(friendship.mood_expiry) < new Date()) {
        await this.resetMood(pokemonId, userId);
        friendship.mood = 'neutral';
        friendship.mood_expiry = null;
      }
      
      const levelConfig = this.getLevelConfig(friendship.friendship_value);
      
      const info = {
        ...friendship,
        levelName: levelConfig.name,
        levelNameEn: levelConfig.nameEn,
        nextLevel: levelConfig.level < 10 ? this.FRIENDSHIP_LEVELS[levelConfig.level + 1] : null,
        progressToNextLevel: this.calculateProgress(friendship.friendship_value, levelConfig),
        battleBonuses: this.calculateBattleBonuses(friendship.friendship_level, friendship.mood)
      };
      
      // 缓存5分钟
      await this.redis.setex(cacheKey, 300, JSON.stringify(info));
      
      return info;
    } catch (error) {
      logger.error({ err: error, pokemonId, userId }, 'Failed to get friendship info');
      throw error;
    }
  }

  /**
   * 初始化羁绊记录
   */
  async initFriendship(pokemonId, userId) {
    try {
      const result = await this.db.query(
        `INSERT INTO pokemon_friendship (pokemon_id, user_id, friendship_value, friendship_level)
         VALUES ($1, $2, 0, 0)
         ON CONFLICT (pokemon_id, user_id) DO UPDATE SET updated_at = NOW()
         RETURNING *`,
        [pokemonId, userId]
      );
      
      logger.info({ pokemonId, userId }, 'Friendship initialized');
      
      const friendship = result.rows[0];
      return {
        ...friendship,
        levelName: this.FRIENDSHIP_LEVELS[0].name,
        levelNameEn: this.FRIENDSHIP_LEVELS[0].nameEn,
        nextLevel: this.FRIENDSHIP_LEVELS[1],
        progressToNextLevel: 0,
        battleBonuses: {}
      };
    } catch (error) {
      logger.error({ err: error, pokemonId, userId }, 'Failed to initialize friendship');
      throw error;
    }
  }

  /**
   * 执行互动行为
   */
  async performInteraction(pokemonId, userId, interactionType, options = {}) {
    const config = this.INTERACTION_TYPES[interactionType];
    if (!config) {
      throw new Error(`Invalid interaction type: ${interactionType}`);
    }
    
    try {
      // 检查冷却时间
      const cooldownKey = `interaction_cooldown:${pokemonId}:${userId}:${interactionType}`;
      const lastInteraction = await this.redis.get(cooldownKey);
      if (lastInteraction) {
        const expiryTime = parseInt(lastInteraction);
        const remaining = expiryTime - Date.now();
        if (remaining > 0) {
          throw new Error(`Cooldown remaining: ${Math.ceil(remaining / 60000)} minutes`);
        }
      }
      
      // 检查资源消耗
      if (config.resourceRequired && options.resourceId) {
        await this.validateAndConsumeResource(userId, config.resourceRequired, options.resourceId);
      }
      
      // 检查位置要求
      if (config.locationRequired && !options.location) {
        throw new Error('Location is required for this interaction');
      }
      
      // 获取当前羁绊状态
      let friendship = await this.getFriendshipInfo(pokemonId, userId);
      const moodConfig = this.MOOD_EFFECTS[friendship.mood] || this.MOOD_EFFECTS.neutral;
      
      // 计算羁绊增益（心情加成）
      let friendshipGain = Math.floor(config.friendshipGain * moodConfig.friendshipMultiplier);
      
      // 稀有度加成（闪光精灵额外+5）
      if (friendship.is_shiny) {
        friendshipGain += 5;
      }
      
      // 更新羁绊值
      const newFriendshipValue = Math.min(255, friendship.friendship_value + friendshipGain);
      const newLevel = this.calculateLevel(newFriendshipValue);
      
      // 更新心情
      let newMood = config.moodEffect;
      let moodExpiry = new Date(Date.now() + config.moodDuration * 60000);
      
      const updateResult = await this.db.query(
        `UPDATE pokemon_friendship
         SET friendship_value = $1,
             friendship_level = $2,
             mood = $3,
             mood_expiry = $4,
             last_interaction_at = NOW(),
             total_interactions = total_interactions + 1,
             updated_at = NOW()
         WHERE pokemon_id = $5 AND user_id = $6
         RETURNING *`,
        [newFriendshipValue, newLevel, newMood, moodExpiry, pokemonId, userId]
      );
      
      // 记录互动历史
      await this.db.query(
        `INSERT INTO friendship_interactions (pokemon_id, user_id, interaction_type, friendship_gain, mood_change, resource_consumed)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [pokemonId, userId, interactionType, friendshipGain, newMood, options.resourceId ? JSON.stringify({ resourceId: options.resourceId }) : null]
      );
      
      // 设置冷却时间（存储过期时间戳）
      const expiryTime = Date.now() + config.cooldown * 60000;
      await this.redis.setex(cooldownKey, config.cooldown * 60, expiryTime.toString());
      
      // 清除缓存
      await this.redis.del(`friendship:${pokemonId}:${userId}`);
      
      // 检查等级提升里程碑
      if (newLevel > friendship.friendship_level) {
        await this.recordMilestone(pokemonId, userId, 'level_up', {
          previousLevel: friendship.friendship_level,
          newLevel: newLevel,
          friendshipValue: newFriendshipValue
        });
        
        this.emit('levelUp', {
          pokemonId,
          userId,
          newLevel,
          friendshipValue: newFriendshipValue
        });
        
        logger.info({ pokemonId, userId, newLevel }, 'Friendship level up');
      }
      
      return {
        success: true,
        friendshipGain,
        newFriendshipValue,
        newLevel,
        mood: newMood,
        moodDuration: config.moodDuration,
        levelUp: newLevel > friendship.friendship_level,
        levelName: this.FRIENDSHIP_LEVELS[newLevel].name
      };
    } catch (error) {
      logger.error({ err: error, pokemonId, userId, interactionType }, 'Interaction failed');
      throw error;
    }
  }

  /**
   * 计算战斗加成
   */
  calculateBattleBonuses(friendshipLevel, mood) {
    const levelConfig = this.FRIENDSHIP_LEVELS[friendshipLevel] || this.FRIENDSHIP_LEVELS[0];
    const moodConfig = this.MOOD_EFFECTS[mood] || this.MOOD_EFFECTS.neutral;
    
    const bonuses = {
      critRateBonus: 0,
      evasionRateBonus: 0,
      statusResistBonus: 0,
      expBonus: 0
    };
    
    // 羁绊等级加成
    if (friendshipLevel >= 3) {
      bonuses.critRateBonus += 0.02 * (friendshipLevel - 2);
    }
    if (friendshipLevel >= 5) {
      bonuses.evasionRateBonus += 0.01 * (friendshipLevel - 4);
    }
    if (friendshipLevel >= 7) {
      bonuses.statusResistBonus += 0.05 * (friendshipLevel - 6);
    }
    if (friendshipLevel >= 8) {
      bonuses.expBonus += 0.1 * (friendshipLevel - 7);
    }
    
    // 心情加成
    if (moodConfig.battleBonus.critRate) {
      bonuses.critRateBonus += moodConfig.battleBonus.critRate;
    }
    if (moodConfig.battleBonus.evasionRate) {
      bonuses.evasionRateBonus += moodConfig.battleBonus.evasionRate;
    }
    
    return bonuses;
  }

  /**
   * 重置心情
   */
  async resetMood(pokemonId, userId) {
    try {
      await this.db.query(
        `UPDATE pokemon_friendship
         SET mood = 'neutral', mood_expiry = NULL, updated_at = NOW()
         WHERE pokemon_id = $1 AND user_id = $2`,
        [pokemonId, userId]
      );
      
      await this.redis.del(`friendship:${pokemonId}:${userId}`);
    } catch (error) {
      logger.error({ err: error, pokemonId, userId }, 'Failed to reset mood');
    }
  }

  /**
   * 更新过期心情（定时任务）
   */
  async updateMoods() {
    try {
      const result = await this.db.query(
        `UPDATE pokemon_friendship
         SET mood = 'neutral', mood_expiry = NULL, updated_at = NOW()
         WHERE mood_expiry < NOW() AND mood != 'neutral'
         RETURNING pokemon_id, user_id`
      );
      
      // 清除缓存
      for (const row of result.rows) {
        await this.redis.del(`friendship:${row.pokemon_id}:${row.user_id}`);
      }
      
      logger.info({ count: result.rows.length }, 'Moods updated');
      return result.rows.length;
    } catch (error) {
      logger.error({ err: error }, 'Failed to update moods');
      throw error;
    }
  }

  /**
   * 获取羁绊排行榜
   */
  async getLeaderboard(limit = 100) {
    try {
      const result = await this.db.query(
        `SELECT pf.*, u.username, p.species_id, p.nickname, p.is_shiny
         FROM pokemon_friendship pf
         JOIN users u ON pf.user_id = u.id
         JOIN pokemons p ON pf.pokemon_id = p.id
         WHERE pf.friendship_level = 10
         ORDER BY pf.friendship_value DESC, pf.total_interactions DESC
         LIMIT $1`,
        [limit]
      );
      
      return result.rows.map((row, index) => ({
        rank: index + 1,
        ...row,
        levelName: this.FRIENDSHIP_LEVELS[10].name
      }));
    } catch (error) {
      logger.error({ err: error }, 'Failed to get leaderboard');
      throw error;
    }
  }

  /**
   * 获取互动历史
   */
  async getInteractionHistory(pokemonId, userId, limit = 50) {
    try {
      const result = await this.db.query(
        `SELECT fi.*, ii.name_i18n as item_name
         FROM friendship_interactions fi
         LEFT JOIN interaction_items ii ON fi.resource_consumed->>'resourceId' = ii.id::text
         WHERE fi.pokemon_id = $1 AND fi.user_id = $2
         ORDER BY fi.created_at DESC
         LIMIT $3`,
        [pokemonId, userId, limit]
      );
      
      return result.rows;
    } catch (error) {
      logger.error({ err: error, pokemonId, userId }, 'Failed to get interaction history');
      throw error;
    }
  }

  /**
   * 获取用户的羁绊列表
   */
  async getUserFriendships(userId, options = {}) {
    const { limit = 50, offset = 0, minLevel = 0 } = options;
    
    try {
      const result = await this.db.query(
        `SELECT pf.*, p.species_id, p.nickname, p.level as pokemon_level, p.is_shiny
         FROM pokemon_friendship pf
         JOIN pokemons p ON pf.pokemon_id = p.id
         WHERE pf.user_id = $1 AND pf.friendship_level >= $2
         ORDER BY pf.friendship_value DESC
         LIMIT $3 OFFSET $4`,
        [userId, minLevel, limit, offset]
      );
      
      return result.rows.map(row => ({
        ...row,
        levelName: this.FRIENDSHIP_LEVELS[row.friendship_level].name,
        battleBonuses: this.calculateBattleBonuses(row.friendship_level, row.mood)
      }));
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get user friendships');
      throw error;
    }
  }

  // 辅助方法
  getLevelConfig(friendshipValue) {
    for (let i = this.FRIENDSHIP_LEVELS.length - 1; i >= 0; i--) {
      const level = this.FRIENDSHIP_LEVELS[i];
      if (friendshipValue >= level.min) {
        return level;
      }
    }
    return this.FRIENDSHIP_LEVELS[0];
  }

  calculateLevel(friendshipValue) {
    return this.getLevelConfig(friendshipValue).level;
  }

  calculateProgress(friendshipValue, levelConfig) {
    if (levelConfig.level >= 10) return 100;
    const range = levelConfig.max - levelConfig.min;
    const progress = friendshipValue - levelConfig.min;
    return Math.floor((progress / range) * 100);
  }

  async validateAndConsumeResource(userId, resourceRequired, resourceId) {
    // 查询道具
    const itemResult = await this.db.query(
      'SELECT * FROM interaction_items WHERE id = $1',
      [resourceId]
    );
    
    if (itemResult.rows.length === 0) {
      throw new Error('Item not found');
    }
    
    const item = itemResult.rows[0];
    if (item.item_type !== resourceRequired.type) {
      throw new Error(`Invalid item type: expected ${resourceRequired.type}, got ${item.item_type}`);
    }
    
    // TODO: 检查用户背包并消耗道具
    // 这需要集成 inventory-service
  }

  async recordMilestone(pokemonId, userId, milestoneType, data) {
    try {
      await this.db.query(
        `INSERT INTO friendship_milestones (pokemon_id, user_id, milestone_type, milestone_data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (pokemon_id, user_id, milestone_type) DO NOTHING`,
        [pokemonId, userId, milestoneType, JSON.stringify(data)]
      );
    } catch (error) {
      logger.error({ err: error, pokemonId, userId, milestoneType }, 'Failed to record milestone');
    }
  }
}

module.exports = FriendshipService;
