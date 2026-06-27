/**
 * REQ-00076: Achievement Service
 * Created: 2026-06-27 05:00 UTC
 */

'use strict';

const { query, transaction } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { produceEvent } = require('../../../shared/kafka');

const logger = createLogger('achievement-service');

// 成就类别
const ACHIEVEMENT_CATEGORIES = {
  CATCH: 'catch',
  BREED: 'breed',
  BATTLE: 'battle',
  SOCIAL: 'social',
  EXPLORE: 'explore'
};

// 稀有度
const ACHIEVEMENT_RARITIES = {
  COMMON: 'common',
  RARE: 'rare',
  EPIC: 'epic',
  LEGENDARY: 'legendary'
};

class AchievementService {
  constructor() {
    this.achievementCache = new Map();
    this.initialized = false;
  }

  /**
   * 初始化 - 加载成就定义到缓存
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      const { rows } = await query('SELECT * FROM achievements');
      
      for (const ach of rows) {
        this.achievementCache.set(ach.achievement_id, ach);
      }
      
      this.initialized = true;
      logger.info({ count: rows.length }, 'Achievement definitions loaded');
    } catch (error) {
      logger.error({ err: error }, 'Failed to load achievement definitions');
      throw error;
    }
  }

  /**
   * 处理成就触发事件
   */
  async processEvent(userId, eventType, eventData) {
    const startTime = Date.now();
    
    try {
      await this.initialize();
      
      // 记录事件
      await query(
        `INSERT INTO achievement_events (user_id, event_type, event_data, processed)
         VALUES ($1, $2, $3, false)
         RETURNING id`,
        [userId, eventType, JSON.stringify(eventData)]
      );
      
      // 获取相关成就
      const relevantAchievements = await this.getRelevantAchievements(userId, eventType);
      
      const results = [];
      for (const achievement of relevantAchievements) {
        const result = await this.updateProgress(userId, achievement, eventData);
        if (result.completed) {
          results.push(result);
        }
      }
      
      // 发布成就完成事件
      if (results.length > 0) {
        await this.publishAchievementCompleted(userId, results);
      }
      
      const duration = Date.now() - startTime;
      logger.info({ userId, eventType, duration, completedCount: results.length }, 'Achievement event processed');
      
      return results;
    } catch (error) {
      logger.error({ err: error, userId, eventType }, 'Failed to process achievement event');
      throw error;
    }
  }

  /**
   * 获取相关成就
   */
  async getRelevantAchievements(userId, eventType) {
    const { rows } = await query(
      `SELECT * FROM achievements
       WHERE trigger_conditions->>'type' = $1
       AND NOT EXISTS (
         SELECT 1 FROM user_achievements
         WHERE user_achievements.user_id = $2
         AND user_achievements.achievement_id = achievements.achievement_id
         AND completed = true
       )`,
      [eventType, userId]
    );
    
    return rows;
  }

  /**
   * 更新成就进度
   */
  async updateProgress(userId, achievement, eventData) {
    const { achievement_id, trigger_conditions } = achievement;
    
    try {
      // 获取或创建用户成就记录
      let { rows: [userAch] } = await query(
        `SELECT * FROM user_achievements
         WHERE user_id = $1 AND achievement_id = $2`,
        [userId, achievement_id]
      );
      
      if (!userAch) {
        const targetValue = this.calculateTarget(trigger_conditions);
        await query(
          `INSERT INTO user_achievements (user_id, achievement_id, target, progress)
           VALUES ($1, $2, $3, 0)
           RETURNING *`,
          [userId, achievement_id, targetValue]
        );
        userAch = { progress: 0, target: targetValue, completed: false };
      }
      
      if (userAch.completed) {
        return { achievement_id, completed: true, alreadyCompleted: true };
      }
      
      // 检查过滤器
      if (trigger_conditions.filters && !this.matchesFilters(eventData, trigger_conditions.filters)) {
        return { achievement_id, progress: userAch.progress, target: userAch.target, completed: false };
      }
      
      // 计算新进度
      const progressIncrement = this.calculateProgress(trigger_conditions, eventData);
      const newProgress = Math.min(userAch.progress + progressIncrement, userAch.target);
      const isCompleted = newProgress >= userAch.target;
      
      // 更新进度
      await query(
        `UPDATE user_achievements
         SET progress = $1, completed = $2, completed_at = $3, updated_at = NOW()
         WHERE user_id = $4 AND achievement_id = $5`,
        [newProgress, isCompleted, isCompleted ? new Date() : null, userId, achievement_id]
      );
      
      // 更新快照
      await this.updateSnapshot(userId, achievement.points, achievement.category, isCompleted);
      
      if (isCompleted && !userAch.completed) {
        logger.info({ userId, achievementId: achievement_id, points: achievement.points }, 'Achievement unlocked');
        
        return {
          achievement_id,
          name: achievement.name,
          points: achievement.points,
          rewards: achievement.rewards,
          rarity: achievement.rarity,
          completed: true
        };
      }
      
      return { achievement_id, progress: newProgress, target: userAch.target, completed: false };
    } catch (error) {
      logger.error({ err: error, userId, achievementId: achievement_id }, 'Failed to update achievement progress');
      throw error;
    }
  }

  /**
   * 计算进度增量
   */
  calculateProgress(conditions, eventData) {
    switch (conditions.type) {
      case 'catch_count':
      case 'battle_win':
      case 'gym_conquer':
      case 'trade_count':
      case 'pokemon_breed':
      case 'egg_hatch':
      case 'pokestop_visit':
      case 'friend_count':
        return eventData.count || 1;
      case 'catch_species':
        return eventData.is_new_species ? 1 : 0;
      case 'distance_traveled':
        return eventData.distance || 0;
      case 'night_catch':
        return eventData.is_night ? 1 : 0;
      case 'lucky_catch':
        return eventData.is_lucky ? 1 : 0;
      default:
        return 1;
    }
  }

  /**
   * 计算目标值
   */
  calculateTarget(conditions) {
    return conditions.target || 1;
  }

  /**
   * 检查事件数据是否匹配过滤器
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
   * 更新进度快照
   */
  async updateSnapshot(userId, points, category, isCompleted) {
    try {
      const { rows: [existing] } = await query(
        `SELECT * FROM achievement_progress_snapshots WHERE user_id = $1`,
        [userId]
      );
      
      if (existing) {
        const categoryProgress = existing.category_progress || {};
        categoryProgress[category] = (categoryProgress[category] || 0) + 1;
        
        await query(
          `UPDATE achievement_progress_snapshots
           SET total_points = total_points + $1,
               achievements_completed = achievements_completed + $2,
               category_progress = $3,
               last_updated = NOW()
           WHERE user_id = $4`,
          [points, isCompleted ? 1 : 0, JSON.stringify(categoryProgress), userId]
        );
      } else {
        const categoryProgress = {};
        categoryProgress[category] = 1;
        
        await query(
          `INSERT INTO achievement_progress_snapshots (user_id, category_progress, total_points, achievements_completed)
           VALUES ($1, $2, $3, $4)`,
          [userId, JSON.stringify(categoryProgress), points, isCompleted ? 1 : 0]
        );
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to update achievement snapshot');
    }
  }

  /**
   * 发布成就完成事件
   */
  async publishAchievementCompleted(userId, achievements) {
    try {
      await produceEvent('achievement.completed', {
        userId,
        achievements: achievements.map(a => ({
          achievement_id: a.achievement_id,
          name: a.name,
          points: a.points,
          rewards: a.rewards
        })),
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to publish achievement event');
    }
  }

  /**
   * 领取奖励
   */
  async claimRewards(userId, achievementId) {
    const client = await (await require('../../../shared/db').getPool()).connect();
    
    try {
      await client.query('BEGIN');
      
      const { rows: [userAch] } = await client.query(
        `SELECT ua.*, a.rewards, a.name FROM user_achievements ua
         JOIN achievements a ON a.achievement_id = ua.achievement_id
         WHERE ua.user_id = $1 AND ua.achievement_id = $2
         FOR UPDATE`,
        [userId, achievementId]
      );
      
      if (!userAch) {
        throw new Error('Achievement not found');
      }
      
      if (!userAch.completed) {
        throw new Error('Achievement not completed');
      }
      
      if (userAch.rewards_claimed) {
        throw new Error('Rewards already claimed');
      }
      
      // 标记已领取
      await client.query(
        `UPDATE user_achievements
         SET rewards_claimed = true, rewards_claimed_at = NOW()
         WHERE user_id = $1 AND achievement_id = $2`,
        [userId, achievementId]
      );
      
      await client.query('COMMIT');
      
      // 解锁称号
      if (userAch.rewards.title) {
        await this.unlockTitle(userId, userAch.rewards.title, achievementId);
      }
      
      logger.info({ userId, achievementId, rewards: userAch.rewards }, 'Achievement rewards claimed');
      
      return userAch.rewards;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 解锁称号
   */
  async unlockTitle(userId, titleId, sourceAchievementId) {
    try {
      const titleNames = {
        'catcher_100': { zh: '捕捉新手', en: 'Novice Catcher', ja: '捕獲初心者' },
        'catcher_1000': { zh: '捕捉大师', en: 'Catch Master', ja: '捕獲マスター' },
        'shiny_hunter': { zh: '闪光猎人', en: 'Shiny Hunter', ja: '色違いハンター' },
        'pvp_expert': { zh: '对战达人', en: 'PvP Expert', ja: 'PvPエキスパート' },
        'shiny_breeder': { zh: '闪光培育师', en: 'Shiny Breeder', ja: '色違い育成師' },
        'trade_master': { zh: '交易达人', en: 'Trade Master', ja: '交換マスター' },
        'explorer': { zh: '探险家', en: 'Explorer', ja: '探検家' },
        'night_owl': { zh: '夜猫子', en: 'Night Owl', ja: '夜型人間' }
      };
      
      await query(
        `INSERT INTO user_titles (user_id, title_id, title_name, source_achievement_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, title_id) DO NOTHING`,
        [userId, titleId, JSON.stringify(titleNames[titleId] || { zh: titleId, en: titleId }), sourceAchievementId]
      );
    } catch (error) {
      logger.error({ err: error, userId, titleId }, 'Failed to unlock title');
    }
  }

  /**
   * 获取用户成就列表
   */
  async getUserAchievements(userId, options = {}) {
    const { category, includeHidden = false, includeCompleted = true } = options;
    
    let sql = `
      SELECT 
        a.*,
        ua.progress,
        ua.target,
        ua.completed,
        ua.completed_at,
        ua.rewards_claimed
      FROM achievements a
      LEFT JOIN user_achievements ua 
        ON a.achievement_id = ua.achievement_id 
        AND ua.user_id = $1
      WHERE 1=1
    `;
    
    const params = [userId];
    let paramIndex = 2;
    
    if (category) {
      sql += ` AND a.category = $${paramIndex++}`;
      params.push(category);
    }
    
    if (!includeHidden) {
      sql += ` AND a.is_hidden = false`;
    }
    
    if (!includeCompleted) {
      sql += ` AND (ua.completed IS NULL OR ua.completed = false)`;
    }
    
    sql += ` ORDER BY a.points DESC, a.category`;
    
    const { rows } = await query(sql, params);
    return rows;
  }

  /**
   * 获取成就进度概览
   */
  async getProgressOverview(userId) {
    const { rows: [snapshot] } = await query(
      `SELECT * FROM achievement_progress_snapshots WHERE user_id = $1`,
      [userId]
    );
    
    if (!snapshot) {
      return {
        total_points: 0,
        achievements_completed: 0,
        category_progress: {}
      };
    }
    
    return {
      total_points: snapshot.total_points,
      achievements_completed: snapshot.achievements_completed,
      category_progress: snapshot.category_progress
    };
  }

  /**
   * 获取成就排行榜
   */
  async getLeaderboard(limit = 100, offset = 0) {
    const { rows } = await query(
      `SELECT 
        aps.user_id,
        aps.total_points,
        aps.achievements_completed,
        u.username,
        u.avatar_url
       FROM achievement_progress_snapshots aps
       LEFT JOIN users u ON u.id = aps.user_id
       ORDER BY aps.total_points DESC, aps.achievements_completed DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    
    return rows;
  }

  /**
   * 设置激活称号
   */
  async setActiveTitle(userId, titleId) {
    await transaction(async (client) => {
      // 取消所有激活称号
      await client.query(
        `UPDATE user_titles SET is_active = false WHERE user_id = $1`,
        [userId]
      );
      
      // 激活指定称号
      const { rowCount } = await client.query(
        `UPDATE user_titles SET is_active = true WHERE user_id = $1 AND title_id = $2`,
        [userId, titleId]
      );
      
      if (rowCount === 0) {
        throw new Error('Title not found');
      }
    });
    
    logger.info({ userId, titleId }, 'Title activated');
  }

  /**
   * 获取用户称号列表
   */
  async getUserTitles(userId) {
    const { rows } = await query(
      `SELECT * FROM user_titles WHERE user_id = $1 ORDER BY unlocked_at DESC`,
      [userId]
    );
    
    return rows;
  }
}

// 单例导出
const achievementService = new AchievementService();

module.exports = {
  achievementService,
  ACHIEVEMENT_CATEGORIES,
  ACHIEVEMENT_RARITIES
};
