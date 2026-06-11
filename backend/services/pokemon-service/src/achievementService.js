/**
 * REQ-00076: 精灵成就系统与里程碑奖励
 * 成就服务核心模块
 */

'use strict';

const { db } = require('../../shared/db');
const { createLogger } = require('../../shared/logger');
const { metrics } = require('../../shared/metrics');

const logger = createLogger('achievement-service');

class AchievementService {
  constructor() {
    this.achievementDefinitions = new Map();
    this.initialized = false;
  }

  /**
   * 加载成就定义到内存
   */
  async loadDefinitions() {
    try {
      const achievements = await db('achievements').select('*');
      this.achievementDefinitions.clear();
      
      for (const ach of achievements) {
        this.achievementDefinitions.set(ach.achievement_id, {
          ...ach,
          name: typeof ach.name === 'string' ? JSON.parse(ach.name) : ach.name,
          description: typeof ach.description === 'string' ? JSON.parse(ach.description) : ach.description,
          trigger_conditions: typeof ach.trigger_conditions === 'string' ? JSON.parse(ach.trigger_conditions) : ach.trigger_conditions,
          rewards: typeof ach.rewards === 'string' ? JSON.parse(ach.rewards) : ach.rewards
        });
      }
      
      this.initialized = true;
      logger.info(`Loaded ${this.achievementDefinitions.size} achievement definitions`);
    } catch (error) {
      logger.error({ error }, 'Failed to load achievement definitions');
      throw error;
    }
  }

  /**
   * 处理成就触发事件
   * @param {number} userId - 用户ID
   * @param {string} eventType - 事件类型
   * @param {Object} eventData - 事件数据
   * @returns {Array} 完成的成就列表
   */
  async processEvent(userId, eventType, eventData) {
    const startTime = Date.now();
    
    try {
      if (!this.initialized) {
        await this.loadDefinitions();
      }

      // 记录事件
      await db('achievement_events').insert({
        user_id: userId,
        event_type: eventType,
        event_data: JSON.stringify(eventData),
        processed: false
      });

      // 获取用户相关成就
      const relevantAchievements = await this.getRelevantAchievements(userId, eventType);
      
      const results = [];
      for (const achievement of relevantAchievements) {
        const result = await this.updateProgress(userId, achievement, eventData);
        if (result.completed) {
          results.push(result);
        }
      }

      // 发布成就完成事件（通过 EventBus）
      if (results.length > 0) {
        await this.publishAchievementCompleted(userId, results);
      }

      const duration = Date.now() - startTime;
      metrics.histogram('achievement_process_duration_ms', duration);
      metrics.increment('achievement_events_processed_total');

      return results;
    } catch (error) {
      metrics.increment('achievement_process_errors_total');
      logger.error({ error, userId, eventType }, 'Failed to process achievement event');
      throw error;
    }
  }

  /**
   * 获取相关成就
   */
  async getRelevantAchievements(userId, eventType) {
    const achievements = [];
    
    for (const [achievementId, achievement] of this.achievementDefinitions) {
      const conditions = achievement.trigger_conditions;
      
      // 检查事件类型是否匹配
      if (conditions.type !== eventType && conditions.type !== eventType.replace('_count', '')) {
        continue;
      }
      
      // 检查用户是否已完成
      const userAch = await db('user_achievements')
        .where({ user_id: userId, achievement_id: achievementId })
        .first();
      
      if (userAch && userAch.completed) {
        continue; // 已完成，跳过
      }
      
      // 检查前置成就
      if (achievement.prerequisite_achievement_id) {
        const prereq = await db('user_achievements')
          .where({ user_id: userId, achievement_id: achievement.prerequisite_achievement_id, completed: true })
          .first();
        
        if (!prereq) {
          continue; // 前置成就未完成
        }
      }
      
      achievements.push(achievement);
    }
    
    return achievements;
  }

  /**
   * 更新成就进度
   */
  async updateProgress(userId, achievement, eventData) {
    const { achievement_id, trigger_conditions } = achievement;
    const target = trigger_conditions.target || 1;
    
    try {
      // 获取或创建用户成就记录
      let userAch = await db('user_achievements')
        .where({ user_id: userId, achievement_id })
        .first();

      if (!userAch) {
        await db('user_achievements').insert({
          user_id: userId,
          achievement_id,
          target,
          progress: 0,
          completed: false
        });
        userAch = { progress: 0, target, completed: false };
      }

      // 检查过滤条件
      if (trigger_conditions.filters && !this.matchesFilters(eventData, trigger_conditions.filters)) {
        return { achievement_id, progress: userAch.progress, target, completed: false };
      }

      // 计算进度增量
      const progressIncrement = this.calculateProgress(trigger_conditions.type, eventData);
      const newProgress = Math.min(userAch.progress + progressIncrement, target);
      const isCompleted = newProgress >= target && !userAch.completed;

      // 更新进度
      await db('user_achievements')
        .where({ user_id: userId, achievement_id })
        .update({
          progress: newProgress,
          completed: isCompleted,
          completed_at: isCompleted ? db.fn.now() : null,
          updated_at: db.fn.now()
        });

      // 更新快照
      if (progressIncrement > 0) {
        await this.updateSnapshot(userId, achievement.points, isCompleted, achievement.category, progressIncrement);
      }

      if (isCompleted) {
        metrics.increment('achievements_unlocked_total', { category: achievement.category, rarity: achievement.rarity });
        logger.info({ userId, achievementId: achievement_id, points: achievement.points }, 'Achievement unlocked');
        
        return {
          achievement_id,
          name: achievement.name,
          points: achievement.points,
          rewards: achievement.rewards,
          completed: true,
          is_hidden: achievement.is_hidden
        };
      }

      return { achievement_id, progress: newProgress, target, completed: false };
    } catch (error) {
      logger.error({ error, userId, achievement_id }, 'Failed to update achievement progress');
      throw error;
    }
  }

  /**
   * 检查是否匹配过滤条件
   */
  matchesFilters(eventData, filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (eventData[key] !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * 计算进度增量
   */
  calculateProgress(eventType, eventData) {
    switch (eventType) {
      case 'catch_count':
      case 'shiny_catch':
      case 'lucky_catch':
        return eventData.count || 1;
      
      case 'catch_species':
        return eventData.is_new_species ? 1 : 0;
      
      case 'battle_win':
      case 'gym_conquer':
        return 1;
      
      case 'trade_count':
      case 'friend_count':
      case 'pokemon_breed':
      case 'egg_hatch':
      case 'pokestop_visit':
        return 1;
      
      case 'distance_traveled':
        return eventData.distance || 0;
      
      case 'perfect_iv_breed':
        return eventData.is_perfect_iv ? 1 : 0;
      
      default:
        return eventData.count || 1;
    }
  }

  /**
   * 更新进度快照
   */
  async updateSnapshot(userId, points, isCompleted, category, progressIncrement) {
    try {
      const existing = await db('achievement_progress_snapshots')
        .where({ user_id: userId })
        .first();

      if (!existing) {
        await db('achievement_progress_snapshots').insert({
          user_id: userId,
          category_progress: JSON.stringify({ [category]: progressIncrement }),
          total_points: isCompleted ? points : 0,
          achievements_completed: isCompleted ? 1 : 0,
          last_updated: db.fn.now()
        });
      } else {
        const categoryProgress = typeof existing.category_progress === 'string' 
          ? JSON.parse(existing.category_progress) 
          : existing.category_progress;
        
        categoryProgress[category] = (categoryProgress[category] || 0) + progressIncrement;

        await db('achievement_progress_snapshots')
          .where({ user_id: userId })
          .update({
            category_progress: JSON.stringify(categoryProgress),
            total_points: existing.total_points + (isCompleted ? points : 0),
            achievements_completed: existing.achievements_completed + (isCompleted ? 1 : 0),
            last_updated: db.fn.now()
          });
      }
    } catch (error) {
      logger.error({ error, userId }, 'Failed to update achievement snapshot');
      // 不抛出错误，快照更新失败不影响主流程
    }
  }

  /**
   * 领取奖励
   */
  async claimRewards(userId, achievementId) {
    const userAch = await db('user_achievements')
      .where({ user_id: userId, achievement_id: achievementId })
      .first();

    if (!userAch) {
      throw new Error('Achievement not found');
    }

    if (!userAch.completed) {
      throw new Error('Achievement not completed');
    }

    if (userAch.rewards_claimed) {
      throw new Error('Rewards already claimed');
    }

    const achievement = this.achievementDefinitions.get(achievementId);
    if (!achievement) {
      throw new Error('Achievement definition not found');
    }

    const rewards = achievement.rewards;

    // 标记已领取
    await db('user_achievements')
      .where({ user_id: userId, achievement_id: achievementId })
      .update({
        rewards_claimed: true,
        rewards_claimed_at: db.fn.now()
      });

    // 如果有称号，解锁称号
    if (rewards.title) {
      await db('user_titles')
        .insert({
          user_id: userId,
          title_id: rewards.title,
          source_achievement_id: achievementId,
          is_active: false
        })
        .onConflict(['user_id', 'title_id'])
        .ignore();
    }

    metrics.increment('achievement_rewards_claimed_total');
    logger.info({ userId, achievementId, rewards }, 'Achievement rewards claimed');

    return rewards;
  }

  /**
   * 获取用户成就列表
   */
  async getUserAchievements(userId, options = {}) {
    const { category, includeHidden = false, includeCompleted = true } = options;

    let query = db('achievements')
      .leftJoin('user_achievements', function() {
        this.on('achievements.achievement_id', '=', 'user_achievements.achievement_id')
            .andOn('user_achievements.user_id', '=', db.raw('?', [userId]));
      })
      .select(
        'achievements.achievement_id',
        'achievements.category',
        'achievements.name',
        'achievements.description',
        'achievements.icon_url',
        'achievements.rarity',
        'achievements.points',
        'achievements.is_hidden',
        'user_achievements.progress',
        'user_achievements.target',
        'user_achievements.completed',
        'user_achievements.completed_at',
        'user_achievements.rewards_claimed'
      );

    if (category) {
      query = query.where('achievements.category', category);
    }

    if (!includeHidden) {
      query = query.where('achievements.is_hidden', false);
    }

    if (!includeCompleted) {
      query = query.where(function() {
        this.whereNull('user_achievements.completed')
            .orWhere('user_achievements.completed', false);
      });
    }

    const achievements = await query.orderBy('achievements.points', 'desc');

    // 解析 JSON 字段
    return achievements.map(ach => ({
      ...ach,
      name: typeof ach.name === 'string' ? JSON.parse(ach.name) : ach.name,
      description: typeof ach.description === 'string' ? JSON.parse(ach.description) : ach.description,
      progress: ach.progress || 0,
      target: ach.target || 1,
      completed: ach.completed || false
    }));
  }

  /**
   * 获取用户进度概览
   */
  async getUserProgress(userId) {
    const snapshot = await db('achievement_progress_snapshots')
      .where({ user_id: userId })
      .first();

    if (!snapshot) {
      return {
        total_points: 0,
        achievements_completed: 0,
        category_progress: {},
        last_updated: null
      };
    }

    return {
      total_points: snapshot.total_points,
      achievements_completed: snapshot.achievements_completed,
      category_progress: typeof snapshot.category_progress === 'string' 
        ? JSON.parse(snapshot.category_progress) 
        : snapshot.category_progress,
      last_updated: snapshot.last_updated
    };
  }

  /**
   * 获取成就排行榜
   */
  async getLeaderboard(limit = 100, offset = 0) {
    const leaderboard = await db('achievement_progress_snapshots')
      .join('users', 'achievement_progress_snapshots.user_id', 'users.id')
      .select(
        'users.id as user_id',
        'users.username',
        'users.avatar_url',
        'achievement_progress_snapshots.total_points',
        'achievement_progress_snapshots.achievements_completed'
      )
      .orderBy('total_points', 'desc')
      .limit(limit)
      .offset(offset);

    return leaderboard.map((entry, index) => ({
      ...entry,
      rank: offset + index + 1
    }));
  }

  /**
   * 发布成就完成事件
   */
  async publishAchievementCompleted(userId, achievements) {
    // 通过 EventBus 发布事件（如果存在）
    try {
      const { EventBus, EVENTS } = require('../../shared/EventBus');
      if (EventBus && EVENTS) {
        await EventBus.publish(EVENTS.ACHIEVEMENT_COMPLETED, {
          userId,
          achievements: achievements.map(a => ({
            achievement_id: a.achievement_id,
            name: a.name,
            points: a.points,
            rewards: a.rewards
          }))
        });
      }
    } catch (error) {
      // EventBus 可能不存在，忽略错误
      logger.debug('EventBus not available, skipping event publish');
    }
  }

  /**
   * 设置激活称号
   */
  async setActiveTitle(userId, titleId) {
    // 验证用户拥有该称号
    const title = await db('user_titles')
      .where({ user_id: userId, title_id: titleId })
      .first();

    if (!title) {
      throw new Error('Title not owned by user');
    }

    // 取消所有激活称号
    await db('user_titles')
      .where({ user_id: userId })
      .update({ is_active: false });

    // 激活指定称号
    await db('user_titles')
      .where({ user_id: userId, title_id: titleId })
      .update({ is_active: true });

    logger.info({ userId, titleId }, 'Active title set');
  }

  /**
   * 获取用户称号列表
   */
  async getUserTitles(userId) {
    return await db('user_titles')
      .where({ user_id: userId })
      .select('*')
      .orderBy('unlocked_at', 'desc');
  }
}

module.exports = new AchievementService();
