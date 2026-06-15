'use strict';

/**
 * 称号服务 - 管理玩家称号的解锁、激活、查询
 * REQ-00106: 玩家称号系统与个性化展示
 */

const { db } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');
const { metrics } = require('../../../shared/metrics');
const { getJSON, setJSON, del, keys } = require('../../../shared/redis');

const logger = createLogger('title-service');

class TitleService {
  constructor() {
    this.titleDefinitions = new Map();
    this.initialized = false;
  }

  /**
   * 初始化称号定义缓存
   */
  async initialize() {
    try {
      const titles = await db('title_definitions')
        .where({ is_active: true })
        .orderBy('display_order', 'asc');
      
      this.titleDefinitions.clear();
      for (const title of titles) {
        this.titleDefinitions.set(title.title_id, {
          ...title,
          name: typeof title.name === 'string' ? JSON.parse(title.name) : title.name,
          description: typeof title.description === 'string' ? JSON.parse(title.description) : title.description,
          stat_bonuses: typeof title.stat_bonuses === 'string' ? JSON.parse(title.stat_bonuses) : title.stat_bonuses,
          special_effects: typeof title.special_effects === 'string' ? JSON.parse(title.special_effects) : title.special_effects,
          unlock_criteria: typeof title.unlock_criteria === 'string' ? JSON.parse(title.unlock_criteria) : title.unlock_criteria
        });
      }
      
      this.initialized = true;
      logger.info(`Loaded ${this.titleDefinitions.size} title definitions`);
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to initialize title definitions');
      throw error;
    }
  }

  /**
   * 解锁称号
   */
  async unlockTitle(userId, titleId, sourceType, sourceId = null) {
    const title = this.titleDefinitions.get(titleId);
    if (!title) {
      throw new Error(`Title ${titleId} not found`);
    }

    // 检查是否已解锁
    const existing = await db('user_titles')
      .where({ user_id: userId, title_id: titleId })
      .first();

    if (existing) {
      logger.info({ userId, titleId }, 'Title already unlocked');
      return { alreadyUnlocked: true, title };
    }

    // 检查限时称号是否已过期
    if (title.is_limited && title.available_until) {
      if (new Date() > new Date(title.available_until)) {
        throw new Error('Title is no longer available');
      }
    }

    // 解锁称号
    const [userTitle] = await db('user_titles')
      .insert({
        user_id: userId,
        title_id: titleId,
        source_type: sourceType,
        source_id: sourceId,
        expires_at: title.is_limited ? this.calculateExpiry(title) : null
      })
      .returning('*');

    // 发布称号解锁事件
    await this.publishTitleUnlocked(userId, title);

    // 记录指标
    if (metrics && metrics.increment) {
      metrics.increment('titles_unlocked_total', { 
        rarity: title.rarity, 
        category: title.category,
        source_type: sourceType
      });
    }

    logger.info({ userId, titleId, rarity: title.rarity }, 'Title unlocked');

    return { alreadyUnlocked: false, title, userTitle };
  }

  /**
   * 设置激活称号
   */
  async setActiveTitle(userId, titleId) {
    // 验证用户拥有该称号
    const userTitle = await db('user_titles')
      .where({ user_id: userId, title_id: titleId })
      .first();

    if (!userTitle) {
      throw new Error('Title not owned by user');
    }

    // 检查是否已过期
    if (userTitle.expires_at && new Date() > new Date(userTitle.expires_at)) {
      throw new Error('Title has expired');
    }

    // 使用事务更新
    await db.transaction(async (trx) => {
      // 取消所有激活称号
      await trx('user_titles')
        .where({ user_id: userId })
        .update({ is_active: false });

      // 激活指定称号
      await trx('user_titles')
        .where({ user_id: userId, title_id: titleId })
        .update({ is_active: true });
    });

    // 清除用户称号缓存
    await del(`user:active_title:${userId}`);
    await del(`user:stat_bonuses:${userId}`);

    const title = this.titleDefinitions.get(titleId);
    logger.info({ userId, titleId }, 'Active title set');

    // 记录指标
    if (metrics && metrics.increment) {
      metrics.increment('titles_activated_total');
    }

    return title;
  }

  /**
   * 获取用户所有称号
   */
  async getUserTitles(userId, options = {}) {
    const { category, rarity, includeExpired = false } = options;

    let query = db('user_titles')
      .join('title_definitions', 'user_titles.title_id', 'title_definitions.title_id')
      .where('user_titles.user_id', userId)
      .select(
        'user_titles.title_id',
        'user_titles.is_active',
        'user_titles.is_favorite',
        'user_titles.unlocked_at',
        'user_titles.expires_at',
        'user_titles.source_type',
        'title_definitions.name',
        'title_definitions.description',
        'title_definitions.category',
        'title_definitions.rarity',
        'title_definitions.icon_url',
        'title_definitions.stat_bonuses',
        'title_definitions.special_effects'
      );

    if (category) {
      query = query.where('title_definitions.category', category);
    }

    if (rarity) {
      query = query.where('title_definitions.rarity', rarity);
    }

    if (!includeExpired) {
      query = query.where(function() {
        this.whereNull('user_titles.expires_at')
            .orWhere('user_titles.expires_at', '>', db.fn.now());
      });
    }

    const titles = await query.orderBy('user_titles.unlocked_at', 'desc');

    return titles.map(t => ({
      titleId: t.title_id,
      name: typeof t.name === 'string' ? JSON.parse(t.name) : t.name,
      description: typeof t.description === 'string' ? JSON.parse(t.description) : t.description,
      category: t.category,
      rarity: t.rarity,
      iconUrl: t.icon_url,
      statBonuses: typeof t.stat_bonuses === 'string' ? JSON.parse(t.stat_bonuses) : t.stat_bonuses,
      specialEffects: typeof t.special_effects === 'string' ? JSON.parse(t.special_effects) : t.special_effects,
      isActive: t.is_active,
      isFavorite: t.is_favorite,
      unlockedAt: t.unlocked_at,
      expiresAt: t.expires_at,
      sourceType: t.source_type
    }));
  }

  /**
   * 获取用户激活称号
   */
  async getActiveTitle(userId) {
    // 尝试从缓存获取
    const cacheKey = `user:active_title:${userId}`;
    const cached = await getJSON(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await db('user_titles')
      .join('title_definitions', 'user_titles.title_id', 'title_definitions.title_id')
      .where({
        'user_titles.user_id': userId,
        'user_titles.is_active': true
      })
      .where(function() {
        this.whereNull('user_titles.expires_at')
            .orWhere('user_titles.expires_at', '>', db.fn.now());
      })
      .select(
        'user_titles.title_id',
        'title_definitions.*'
      )
      .first();

    if (!result) {
      return null;
    }

    const title = {
      titleId: result.title_id,
      name: typeof result.name === 'string' ? JSON.parse(result.name) : result.name,
      description: typeof result.description === 'string' ? JSON.parse(result.description) : result.description,
      category: result.category,
      rarity: result.rarity,
      iconUrl: result.icon_url,
      statBonuses: typeof result.stat_bonuses === 'string' ? JSON.parse(result.stat_bonuses) : result.stat_bonuses,
      specialEffects: typeof result.special_effects === 'string' ? JSON.parse(result.special_effects) : result.special_effects
    };

    // 缓存 5 分钟
    await setJSON(cacheKey, title, 300);

    return title;
  }

  /**
   * 获取用户属性加成
   */
  async getUserStatBonuses(userId) {
    const cacheKey = `user:stat_bonuses:${userId}`;
    const cached = await getJSON(cacheKey);
    if (cached) {
      return cached;
    }

    const activeTitle = await this.getActiveTitle(userId);
    if (!activeTitle || !activeTitle.statBonuses) {
      return {};
    }

    // 缓存 5 分钟
    await setJSON(cacheKey, activeTitle.statBonuses, 300);

    return activeTitle.statBonuses;
  }

  /**
   * 获取称号定义
   */
  getTitleDefinition(titleId) {
    return this.titleDefinitions.get(titleId);
  }

  /**
   * 获取所有称号定义
   */
  getAllTitleDefinitions(options = {}) {
    const { category, rarity } = options;
    let titles = Array.from(this.titleDefinitions.values());
    
    if (category) {
      titles = titles.filter(t => t.category === category);
    }
    
    if (rarity) {
      titles = titles.filter(t => t.rarity === rarity);
    }
    
    return titles.sort((a, b) => a.display_order - b.display_order);
  }

  /**
   * 根据成就解锁称号
   */
  async unlockTitleByAchievement(userId, achievementId) {
    const unlockedTitles = [];
    
    for (const [titleId, title] of this.titleDefinitions) {
      if (title.unlock_type === 'achievement' && 
          title.unlock_criteria.achievement_id === achievementId) {
        const result = await this.unlockTitle(userId, titleId, 'achievement', achievementId);
        if (!result.alreadyUnlocked) {
          unlockedTitles.push(result.title);
        }
      }
    }
    
    return unlockedTitles;
  }

  /**
   * 根据活动解锁称号
   */
  async unlockTitleByEvent(userId, eventId) {
    const unlockedTitles = [];
    
    for (const [titleId, title] of this.titleDefinitions) {
      if (title.unlock_type === 'event' && 
          title.unlock_criteria.event_id === eventId) {
        const result = await this.unlockTitle(userId, titleId, 'event', eventId);
        if (!result.alreadyUnlocked) {
          unlockedTitles.push(result.title);
        }
      }
    }
    
    return unlockedTitles;
  }

  /**
   * 根据排名解锁称号
   */
  async unlockTitleByRank(userId, rank) {
    const unlockedTitles = [];
    
    for (const [titleId, title] of this.titleDefinitions) {
      if (title.unlock_type === 'milestone' && 
          title.unlock_criteria.rank_requirement && 
          rank <= title.unlock_criteria.rank_requirement) {
        const result = await this.unlockTitle(userId, titleId, 'milestone', `rank_${rank}`);
        if (!result.alreadyUnlocked) {
          unlockedTitles.push(result.title);
        }
      }
    }
    
    return unlockedTitles;
  }

  /**
   * 收藏/取消收藏称号
   */
  async setFavorite(userId, titleId, isFavorite = true) {
    const result = await db('user_titles')
      .where({ user_id: userId, title_id: titleId })
      .update({ is_favorite: isFavorite })
      .returning('*');
    
    return result.length > 0;
  }

  /**
   * 检查并处理限时称号过期
   */
  async processExpiredTitles() {
    const expiredTitles = await db('user_titles')
      .where('expires_at', '<', db.fn.now())
      .where('is_active', true)
      .update({ is_active: false })
      .returning(['user_id', 'title_id']);

    for (const expired of expiredTitles) {
      await del(`user:active_title:${expired.user_id}`);
      await del(`user:stat_bonuses:${expired.user_id}`);
      logger.info({ userId: expired.user_id, titleId: expired.title_id }, 'Title expired');
      
      if (metrics && metrics.increment) {
        metrics.increment('titles_expired_total');
      }
    }

    return expiredTitles.length;
  }

  /**
   * 获取称号排行榜（按稀有度）
   */
  async getTitleLeaderboard(limit = 100) {
    const results = await db('user_title_stats')
      .join('users', 'user_title_stats.user_id', 'users.id')
      .select(
        'users.id as user_id',
        'users.username',
        'users.avatar_url',
        'user_title_stats.total_titles',
        'user_title_stats.legendary_count',
        'user_title_stats.mythic_count',
        'user_title_stats.active_title_id'
      )
      .orderBy('mythic_count', 'desc')
      .orderBy('legendary_count', 'desc')
      .orderBy('total_titles', 'desc')
      .limit(limit);

    return results.map((r, index) => ({
      rank: index + 1,
      ...r
    }));
  }

  /**
   * 获取称号统计
   */
  async getUserTitleStats(userId) {
    const stats = await db('user_title_stats')
      .where('user_id', userId)
      .first();
    
    return stats || {
      user_id: userId,
      total_titles: 0,
      legendary_count: 0,
      mythic_count: 0,
      active_title_id: null
    };
  }

  /**
   * 计算称号过期时间
   */
  calculateExpiry(title) {
    if (title.unlock_criteria && title.unlock_criteria.duration_days) {
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + title.unlock_criteria.duration_days);
      return expiry;
    }
    return title.available_until;
  }

  /**
   * 发布称号解锁事件
   */
  async publishTitleUnlocked(userId, title) {
    try {
      const { EventBus, EVENTS } = require('../../../shared/EventBus');
      if (EventBus && EVENTS && EVENTS.TITLE_UNLOCKED) {
        await EventBus.publish(EVENTS.TITLE_UNLOCKED, {
          userId,
          titleId: title.title_id,
          titleName: title.name,
          rarity: title.rarity
        });
      }
    } catch (error) {
      logger.debug('EventBus not available');
    }
  }

  /**
   * 重新加载称号定义
   */
  async reload() {
    await this.initialize();
  }
}

// 导出单例实例
module.exports = { TitleService: new TitleService() };
