// backend/shared/questService.js - 精灵日常任务系统服务
'use strict';

const { query, transaction } = require('./db');
const { getRedis, setJSON, getJSON, delKey } = require('./redis');
const { createLogger } = require('./logger');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const logger = createLogger('quest-service');

// ============================================================
// 任务池配置
// ============================================================

const QUEST_POOLS = {
  daily: { count: 3, refreshHour: 0 }, // 每日 0 点刷新
  weekly: { count: 5, refreshDay: 1 },  // 每周一刷新
};

// 连击倍率配置
const STREAK_MULTIPLIERS = [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5];

// 任务类型映射
const OBJECTIVE_TYPES = {
  catch_pokemon: ['catch', 'special'],
  win_gym_battle: ['battle'],
  win_raid: ['battle'],
  gym_battle: ['battle'],
  trade_pokemon: ['social'],
  send_gift: ['social'],
  add_friend: ['social'],
  visit_pokestop: ['explore'],
  pokestop_streak: ['special'],
  hatch_egg: ['explore', 'breed'],
  evolve_pokemon: ['evolve'],
  start_breeding: ['breed'],
};

// ============================================================
// QuestService 类
// ============================================================

class QuestService extends EventEmitter {
  constructor() {
    super();
    this.cachePrefix = 'quests:';
    this.cacheTTL = 300; // 5 分钟
  }

  // --------------------------------------------------------
  // 公共方法
  // --------------------------------------------------------

  /**
   * 为用户生成每日任务
   * @param {string} userId - 用户 ID
   * @returns {Promise<Array>} 生成的任务列表
   */
  async generateDailyQuests(userId) {
    const client = await transaction();
    try {
      await client.query('BEGIN');

      // 检查今日是否已生成
      const today = new Date().toISOString().split('T')[0];
      const existing = await client.query(
        `SELECT id FROM player_quests 
         WHERE user_id = $1 AND quest_pool = 'daily' 
         AND assigned_at::date = $2`,
        [userId, today]
      );

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        logger.debug('Daily quests already generated', { userId });
        return this.getUserQuests(userId);
      }

      // 加权随机抽取任务
      const availableQuests = await client.query(
        `SELECT * FROM quest_definitions 
         WHERE is_active = true 
         AND quest_type IN ('catch', 'battle', 'social', 'explore', 'evolve', 'special')
         ORDER BY -LOG(RANDOM()) / weight 
         LIMIT $1`,
        [QUEST_POOLS.daily.count]
      );

      if (availableQuests.rows.length === 0) {
        await client.query('ROLLBACK');
        throw new Error('No available quest definitions');
      }

      const assignedQuests = [];
      for (const quest of availableQuests.rows) {
        const targetCount = quest.objective_params?.count || 1;
        const expiresAt = new Date();
        expiresAt.setHours(23, 59, 59, 999);

        const result = await client.query(
          `INSERT INTO player_quests 
           (user_id, quest_definition_id, quest_pool, progress_target, expires_at)
           VALUES ($1, $2, 'daily', $3, $4)
           RETURNING *`,
          [userId, quest.id, targetCount, expiresAt]
        );

        assignedQuests.push({
          ...result.rows[0],
          definition: quest,
        });
      }

      await client.query('COMMIT');
      
      // 缓存任务列表
      await this.cacheUserQuests(userId, assignedQuests);
      
      // 发送事件
      this.emit('questsGenerated', { userId, quests: assignedQuests });
      
      logger.info('Daily quests generated', { userId, count: assignedQuests.length });

      return assignedQuests;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to generate daily quests', { userId, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取用户当前任务
   * @param {string} userId - 用户 ID
   * @returns {Promise<Array>} 任务列表
   */
  async getUserQuests(userId) {
    // 先查缓存
    const cached = await getJSON(`${this.cachePrefix}${userId}`);
    if (cached && cached.length > 0) {
      // 检查是否有已过期的任务
      const now = new Date();
      const validQuests = cached.filter(q => new Date(q.expires_at) > now);
      if (validQuests.length === cached.length) {
        return validQuests;
      }
    }

    const result = await query(
      `SELECT pq.*, qd.quest_type, qd.title_i18n_key, qd.description_i18n_key,
              qd.objective_type, qd.objective_params, qd.difficulty, qd.reward_config
       FROM player_quests pq
       JOIN quest_definitions qd ON pq.quest_definition_id = qd.id
       WHERE pq.user_id = $1 
       AND pq.status IN ('in_progress', 'completed')
       AND pq.expires_at > NOW()
       ORDER BY pq.quest_pool, pq.assigned_at DESC`,
      [userId]
    );

    const quests = result.rows;
    await this.cacheUserQuests(userId, quests);
    return quests;
  }

  /**
   * 更新任务进度
   * @param {string} userId - 用户 ID
   * @param {string} objectiveType - 目标类型
   * @param {Object} params - 参数（如精灵类型、稀有度等）
   * @returns {Promise<Array>} 更新后的任务列表
   */
  async updateProgress(userId, objectiveType, params = {}) {
    const client = await transaction();
    try {
      await client.query('BEGIN');

      // 查找匹配的进行中任务
      const quests = await client.query(
        `SELECT pq.*, qd.objective_type, qd.objective_params, qd.quest_type
         FROM player_quests pq
         JOIN quest_definitions qd ON pq.quest_definition_id = qd.id
         WHERE pq.user_id = $1 
         AND pq.status = 'in_progress'
         AND pq.expires_at > NOW()
         AND qd.objective_type = $2`,
        [userId, objectiveType]
      );

      const updatedQuests = [];

      for (const quest of quests.rows) {
        // 验证参数匹配（如属性类型、天气等）
        if (!this.matchesObjectiveParams(quest.objective_params, params)) {
          continue;
        }

        const newProgress = Math.min(
          quest.progress_current + 1,
          quest.progress_target
        );

        const status = newProgress >= quest.progress_target ? 'completed' : 'in_progress';
        const completedAt = status === 'completed' ? new Date() : null;

        await client.query(
          `UPDATE player_quests 
           SET progress_current = $1, status = $2, completed_at = $3
           WHERE id = $4`,
          [newProgress, status, completedAt, quest.id]
        );

        updatedQuests.push({
          ...quest,
          progress_current: newProgress,
          status,
        });

        if (status === 'completed') {
          // 发布任务完成事件
          this.emit('questCompleted', { userId, quest: { ...quest, status } });
        }
      }

      await client.query('COMMIT');

      // 更新缓存
      if (updatedQuests.length > 0) {
        await this.invalidateCache(userId);
      }

      return updatedQuests;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to update quest progress', { userId, objectiveType, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 领取任务奖励
   * @param {string} userId - 用户 ID
   * @param {string} questId - 任务 ID
   * @returns {Promise<Object>} 奖励信息
   */
  async claimRewards(userId, questId) {
    const client = await transaction();
    try {
      await client.query('BEGIN');

      // 获取任务信息
      const quest = await client.query(
        `SELECT pq.*, qd.reward_config, qd.title_i18n_key, qd.quest_type
         FROM player_quests pq
         JOIN quest_definitions qd ON pq.quest_definition_id = qd.id
         WHERE pq.id = $1 AND pq.user_id = $2 AND pq.status = 'completed'`,
        [questId, userId]
      );

      if (quest.rows.length === 0) {
        throw new Error('Quest not found or not completed');
      }

      const questData = quest.rows[0];

      // 计算连击倍率
      const streak = await this.updateStreak(client, userId);
      const multiplier = streak.multiplier;

      // 发放奖励（应用倍率）
      const rewards = await this.grantRewards(userId, questData.reward_config, multiplier);

      // 记录历史
      await client.query(
        `INSERT INTO quest_completion_history 
         (user_id, quest_definition_id, rewards_claimed, streak_day)
         VALUES ($1, $2, $3, $4)`,
        [userId, questData.quest_definition_id, JSON.stringify(rewards), streak.current_streak]
      );

      // 更新任务状态
      await client.query(
        `UPDATE player_quests SET status = 'claimed', claimed_at = NOW() WHERE id = $1`,
        [questId]
      );

      await client.query('COMMIT');

      await this.invalidateCache(userId);

      // 发送奖励领取事件
      this.emit('rewardsClaimed', { userId, questId, rewards, multiplier });

      logger.info('Quest rewards claimed', { userId, questId, rewards, multiplier });

      return { rewards, multiplier, streak: streak.current_streak };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to claim rewards', { userId, questId, error: error.message });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取玩家连击信息
   * @param {string} userId - 用户 ID
   * @returns {Promise<Object>} 连击信息
   */
  async getStreak(userId) {
    const result = await query(
      `SELECT * FROM player_quest_streaks WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return { current_streak: 0, longest_streak: 0, multiplier: 1.0 };
    }

    return result.rows[0];
  }

  // --------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------

  /**
   * 更新连击记录
   * @param {Object} client - 数据库客户端
   * @param {string} userId - 用户 ID
   * @returns {Promise<Object>} 连击信息
   */
  async updateStreak(client, userId) {
    const today = new Date().toISOString().split('T')[0];
    
    const streak = await client.query(
      `SELECT * FROM player_quest_streaks WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );

    if (streak.rows.length === 0) {
      // 创建新记录
      await client.query(
        `INSERT INTO player_quest_streaks 
         (user_id, current_streak, longest_streak, last_completion_date, multiplier)
         VALUES ($1, 1, 1, $2, 1.2)`,
        [userId, today]
      );
      return { current_streak: 1, longest_streak: 1, multiplier: 1.2 };
    }

    const streakData = streak.rows[0];
    const lastDate = new Date(streakData.last_completion_date);
    const todayDate = new Date(today);
    const dayDiff = Math.floor((todayDate - lastDate) / (1000 * 60 * 60 * 24));

    let newStreak, multiplier;

    if (dayDiff === 0) {
      // 同一天，不更新
      return streakData;
    } else if (dayDiff === 1) {
      // 连续
      newStreak = streakData.current_streak + 1;
      multiplier = this.calculateMultiplier(newStreak);
    } else {
      // 断签，重置
      newStreak = 1;
      multiplier = 1.0;
    }

    await client.query(
      `UPDATE player_quest_streaks 
       SET current_streak = $1, 
           longest_streak = GREATEST(longest_streak, $1),
           last_completion_date = $2,
           multiplier = $3,
           updated_at = NOW()
       WHERE user_id = $4`,
      [newStreak, today, multiplier, userId]
    );

    return { current_streak: newStreak, longest_streak: Math.max(streakData.longest_streak, newStreak), multiplier };
  }

  /**
   * 计算连击倍率
   * @param {number} streak - 连击天数
   * @returns {number} 倍率
   */
  calculateMultiplier(streak) {
    return STREAK_MULTIPLIERS[Math.min(streak - 1, STREAK_MULTIPLIERS.length - 1)];
  }

  /**
   * 发放奖励
   * @param {string} userId - 用户 ID
   * @param {Object} rewardConfig - 奖励配置
   * @param {number} multiplier - 倍率
   * @returns {Promise<Object>} 发放的奖励
   */
  async grantRewards(userId, rewardConfig, multiplier) {
    const rewards = {
      items: [],
      stardust: 0,
      xp: 0,
    };

    // 发放道具（需要与 inventory 服务集成）
    if (rewardConfig.items && Array.isArray(rewardConfig.items)) {
      for (const item of rewardConfig.items) {
        const count = Math.ceil(item.count * multiplier);
        rewards.items.push({ type: item.type, count });
        // TODO: 调用 inventory service 添加道具
      }
    }

    // 发放星尘
    if (rewardConfig.stardust) {
      rewards.stardust = Math.ceil(rewardConfig.stardust * multiplier);
      // TODO: 调用 user service 添加星尘
    }

    // 发放经验
    if (rewardConfig.xp) {
      rewards.xp = Math.ceil(rewardConfig.xp * multiplier);
      // TODO: 调用 user service 添加经验
    }

    return rewards;
  }

  /**
   * 验证参数匹配
   * @param {Object} objectiveParams - 任务目标参数
   * @param {Object} actualParams - 实际参数
   * @returns {boolean} 是否匹配
   */
  matchesObjectiveParams(objectiveParams, actualParams) {
    if (!objectiveParams || Object.keys(objectiveParams).length === 0) {
      return true;
    }

    for (const [key, value] of Object.entries(objectiveParams)) {
      if (key === 'count') continue;
      
      // 检查属性类型匹配
      if (key === 'type') {
        const actualTypes = actualParams.types || [actualParams.type];
        if (!actualTypes.includes(value)) {
          return false;
        }
        continue;
      }
      
      // 检查其他参数
      if (actualParams[key] !== value) {
        return false;
      }
    }

    return true;
  }

  /**
   * 缓存用户任务
   * @param {string} userId - 用户 ID
   * @param {Array} quests - 任务列表
   */
  async cacheUserQuests(userId, quests) {
    await setJSON(`${this.cachePrefix}${userId}`, quests, this.cacheTTL);
  }

  /**
   * 清除缓存
   * @param {string} userId - 用户 ID
   */
  async invalidateCache(userId) {
    await delKey(`${this.cachePrefix}${userId}`);
  }

  /**
   * 清理过期任务
   * @returns {Promise<number>} 清理的数量
   */
  async cleanupExpiredQuests() {
    const result = await query(
      `UPDATE player_quests 
       SET status = 'expired'
       WHERE status = 'in_progress' AND expires_at < NOW()
       RETURNING id`
    );

    logger.info('Expired quests cleaned up', { count: result.rows.length });
    return result.rows.length;
  }
}

// 导出单例
const questService = new QuestService();

module.exports = {
  QuestService,
  questService,
  QUEST_POOLS,
  STREAK_MULTIPLIERS,
  OBJECTIVE_TYPES,
};