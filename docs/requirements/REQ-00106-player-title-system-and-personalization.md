# REQ-00106: 玩家称号系统与个性化展示

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00106 |
| 标题 | 玩家称号系统与个性化展示 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | user-service、pokemon-service、social-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-11 05:30 |

## 需求描述

为玩家提供丰富的称号系统，让玩家可以通过完成成就、活动、里程碑等获得独特称号，并在游戏内展示。称号不仅是身份象征，还能提供微小的属性加成，增加玩家的成就感和社交展示价值。

### 核心功能
1. **称号解锁机制** - 通过成就、活动、特殊事件解锁称号
2. **称号展示** - 在玩家资料、排行榜、战斗中等展示称号
3. **称号属性加成** - 不同称号提供不同的小幅属性加成
4. **称号分类** - 按稀有度、类别、获取方式分类
5. **称号管理** - 激活/切换称号、预览效果

## 技术方案

### 1. 数据库设计

```sql
-- 称号定义表
CREATE TABLE title_definitions (
  title_id VARCHAR(50) PRIMARY KEY,
  name JSONB NOT NULL,           -- 多语言名称 {"zh": "精灵大师", "en": "Pokemon Master"}
  description JSONB NOT NULL,    -- 多语言描述
  category VARCHAR(30) NOT NULL, -- 分类：achievement/event/rank/special
  rarity VARCHAR(20) NOT NULL,   -- 稀有度：common/rare/epic/legendary/mythic
  icon_url TEXT,
  
  -- 属性加成
  stat_bonuses JSONB DEFAULT '{}', -- {"catch_rate": 0.05, "exp_bonus": 0.1}
  
  -- 获取条件
  unlock_type VARCHAR(30) NOT NULL, -- achievement/event/milestone/purchase
  unlock_criteria JSONB NOT NULL,   -- {"achievement_id": "ach_001"} 或 {"event_id": "evt_001"}
  
  -- 特效
  special_effects JSONB DEFAULT '{}', -- {"glow_color": "#FFD700", "particles": true}
  
  is_active BOOLEAN DEFAULT true,
  is_limited BOOLEAN DEFAULT false,
  available_until TIMESTAMP,
  display_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_title_definitions_category ON title_definitions(category);
CREATE INDEX idx_title_definitions_rarity ON title_definitions(rarity);
CREATE INDEX idx_title_definitions_unlock_type ON title_definitions(unlock_type);

-- 用户称号表
CREATE TABLE user_titles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id VARCHAR(50) NOT NULL REFERENCES title_definitions(title_id),
  
  source_type VARCHAR(30) NOT NULL,  -- achievement/event/purchase/gift
  source_id VARCHAR(100),             -- 来源ID（成就ID/活动ID等）
  
  is_active BOOLEAN DEFAULT false,    -- 当前激活的称号
  is_favorite BOOLEAN DEFAULT false,
  
  unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,               -- 限时称号过期时间
  
  UNIQUE(user_id, title_id)
);

CREATE INDEX idx_user_titles_user ON user_titles(user_id);
CREATE INDEX idx_user_titles_active ON user_titles(user_id, is_active) WHERE is_active = true;
CREATE INDEX idx_user_titles_expires ON user_titles(expires_at) WHERE expires_at IS NOT NULL;

-- 称号统计视图
CREATE VIEW user_title_stats AS
SELECT 
  u.id as user_id,
  COUNT(ut.id) as total_titles,
  COUNT(CASE WHEN td.rarity = 'legendary' THEN 1 END) as legendary_count,
  COUNT(CASE WHEN td.rarity = 'mythic' THEN 1 END) as mythic_count,
  ut_active.title_id as active_title_id
FROM users u
LEFT JOIN user_titles ut ON u.id = ut.user_id
LEFT JOIN title_definitions td ON ut.title_id = td.title_id
LEFT JOIN user_titles ut_active ON u.id = ut_active.user_id AND ut_active.is_active = true
GROUP BY u.id, ut_active.title_id;
```

### 2. 称号服务核心模块

```javascript
// backend/services/user-service/src/titleService.js
'use strict';

const { db } = require('../../shared/db');
const { createLogger } = require('../../shared/logger');
const { metrics } = require('../../shared/metrics');
const { cache, getJSON, setJSON, del } = require('../../shared/redis');

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
      logger.error({ error }, 'Failed to initialize title definitions');
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

    metrics.increment('titles_unlocked_total', { 
      rarity: title.rarity, 
      category: title.category 
    });

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
        'user_titles.*',
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
      expiresAt: t.expires_at
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
   * 获取称号商店列表（可购买的称号）
   */
  async getShopTitles(options = {}) {
    const { page = 1, limit = 20 } = options;
    const offset = (page - 1) * limit;

    const titles = await db('title_definitions')
      .where({
        is_active: true,
        unlock_type: 'purchase'
      })
      .where(function() {
        this.whereNull('available_until')
            .orWhere('available_until', '>', db.fn.now());
      })
      .orderBy('display_order', 'asc')
      .limit(limit)
      .offset(offset);

    return titles.map(t => ({
      titleId: t.title_id,
      name: typeof t.name === 'string' ? JSON.parse(t.name) : t.name,
      description: typeof t.description === 'string' ? JSON.parse(t.description) : t.description,
      category: t.category,
      rarity: t.rarity,
      iconUrl: t.icon_url,
      price: t.unlock_criteria.price || 0,
      currency: t.unlock_criteria.currency || 'coins',
      isLimited: t.is_limited,
      availableUntil: t.available_until
    }));
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
    }

    return expiredTitles.length;
  }

  /**
   * 计算称号过期时间
   */
  calculateExpiry(title) {
    if (title.unlock_criteria.duration_days) {
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
      const { EventBus, EVENTS } = require('../../shared/EventBus');
      if (EventBus && EVENTS) {
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
   * 根据成就解锁称号
   */
  async unlockTitleByAchievement(userId, achievementId) {
    // 查找关联该成就的称号
    for (const [titleId, title] of this.titleDefinitions) {
      if (title.unlock_type === 'achievement' && 
          title.unlock_criteria.achievement_id === achievementId) {
        await this.unlockTitle(userId, titleId, 'achievement', achievementId);
      }
    }
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
}

module.exports = { TitleService: new TitleService() };
```

### 3. API 路由

```javascript
// backend/services/user-service/src/routes/titles.js
'use strict';

const { Router } = require('express');
const { TitleService } = require('../titleService');
const { requireAuth, AppError, successResp } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('user-service:titles');
const router = Router();

/**
 * GET /api/users/me/titles
 * 获取用户所有称号
 */
router.get('/me/titles', requireAuth, async (req, res, next) => {
  try {
    const titles = await TitleService.getUserTitles(req.user.id, req.query);
    res.json(successResp({ titles, total: titles.length }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/me/titles/active
 * 获取用户激活称号
 */
router.get('/me/titles/active', requireAuth, async (req, res, next) => {
  try {
    const title = await TitleService.getActiveTitle(req.user.id);
    res.json(successResp({ title }));
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/users/me/titles/:titleId/activate
 * 激活称号
 */
router.put('/me/titles/:titleId/activate', requireAuth, async (req, res, next) => {
  try {
    const title = await TitleService.setActiveTitle(req.user.id, req.params.titleId);
    res.json(successResp({ title, message: 'Title activated successfully' }));
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/users/me/titles/:titleId/favorite
 * 收藏/取消收藏称号
 */
router.put('/me/titles/:titleId/favorite', requireAuth, async (req, res, next) => {
  try {
    const { isFavorite } = req.body;
    
    await db('user_titles')
      .where({ user_id: req.user.id, title_id: req.params.titleId })
      .update({ is_favorite: isFavorite ?? true });
    
    res.json(successResp({ message: 'Favorite status updated' }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/:userId/titles
 * 获取其他用户称号（公开信息）
 */
router.get('/:userId/titles', async (req, res, next) => {
  try {
    const titles = await TitleService.getUserTitles(req.params.userId, {
      includeExpired: false
    });
    
    // 只返回公开信息
    const publicTitles = titles.map(t => ({
      titleId: t.titleId,
      name: t.name,
      category: t.category,
      rarity: t.rarity,
      iconUrl: t.iconUrl,
      isActive: t.isActive,
      unlockedAt: t.unlockedAt
    }));
    
    res.json(successResp({ titles: publicTitles }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/titles/shop
 * 获取称号商店
 */
router.get('/titles/shop', requireAuth, async (req, res, next) => {
  try {
    const titles = await TitleService.getShopTitles(req.query);
    res.json(successResp({ titles }));
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/titles/leaderboard
 * 获取称号排行榜
 */
router.get('/titles/leaderboard', async (req, res, next) => {
  try {
    const { limit = 100 } = req.query;
    const leaderboard = await TitleService.getTitleLeaderboard(parseInt(limit));
    res.json(successResp({ leaderboard }));
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

### 4. 称号定义种子数据

```sql
-- 种子数据
INSERT INTO title_definitions (title_id, name, description, category, rarity, icon_url, stat_bonuses, unlock_type, unlock_criteria, special_effects, display_order) VALUES

-- 成就类称号
('novice_trainer', '{"zh": "新手训练师", "en": "Novice Trainer"}', '{"zh": "捕捉第一只精灵", "en": "Catch your first Pokemon"}', 'achievement', 'common', '/icons/titles/novice.png', '{}', 'achievement', '{"achievement_id": "first_catch"}', '{}', 1),

('pokemon_collector', '{"zh": "精灵收藏家", "en": "Pokemon Collector"}', '{"zh": "收集100种不同精灵", "en": "Collect 100 different Pokemon species"}', 'achievement', 'rare', '/icons/titles/collector.png', '{"exp_bonus": 0.05}', 'achievement', '{"achievement_id": "species_100"}', '{}', 10),

('gym_leader', '{"zh": "道馆馆主", "en": "Gym Leader"}', '{"zh": "征服10座道馆", "en": "Conquer 10 gyms"}', 'achievement', 'epic', '/icons/titles/gym_leader.png', '{"battle_power": 0.03}', 'achievement', '{"achievement_id": "gym_conqueror_10"}', '{"glow_color": "#4A90D9"}', 20),

('pokemon_master', '{"zh": "精灵大师", "en": "Pokemon Master"}', '{"zh": "完成所有成就", "en": "Complete all achievements"}', 'achievement', 'legendary', '/icons/titles/master.png', '{"catch_rate": 0.1, "exp_bonus": 0.1, "battle_power": 0.05}', 'achievement', '{"achievement_id": "all_achievements"}', '{"glow_color": "#FFD700", "particles": true}', 50),

-- 活动类称号
('summer_champion', '{"zh": "夏日冠军", "en": "Summer Champion"}', '{"zh": "夏季活动冠军", "en": "Summer event champion"}', 'event', 'epic', '/icons/titles/summer.png', '{"catch_rate": 0.05}', 'event', '{"event_id": "summer_2026"}', '{"glow_color": "#FFA500"}', 30),

-- 排名类称号
('top_100', '{"zh": "百强训练师", "en": "Top 100 Trainer"}', '{"zh": "排行榜前100名", "en": "Top 100 in leaderboard"}', 'rank', 'epic', '/icons/titles/top100.png', '{"exp_bonus": 0.08}', 'milestone', '{"rank_requirement": 100}', '{}', 25),

('champion', '{"zh": "冠军", "en": "Champion"}', '{"zh": "排行榜第一名", "en": "Rank #1 in leaderboard"}', 'rank', 'mythic', '/icons/titles/champion.png', '{"catch_rate": 0.15, "exp_bonus": 0.15, "battle_power": 0.1}', 'milestone', '{"rank_requirement": 1}', '{"glow_color": "#FF00FF", "particles": true, "aura": true}', 100);

-- 索引
CREATE INDEX idx_title_definitions_unlock_achievement ON title_definitions((unlock_criteria->>'achievement_id')) WHERE unlock_type = 'achievement';
```

### 5. 前端组件

```javascript
// frontend/game-client/src/components/TitleManager.js
'use strict';

export class TitleManager {
  constructor(api) {
    this.api = api;
    this.titles = [];
    this.activeTitle = null;
    this.statBonuses = {};
  }

  /**
   * 加载用户称号
   */
  async loadTitles() {
    const response = await this.api.get('/users/me/titles');
    this.titles = response.data.titles;
    
    // 找到激活称号
    this.activeTitle = this.titles.find(t => t.isActive) || null;
    
    if (this.activeTitle) {
      this.statBonuses = this.activeTitle.statBonuses || {};
    }
    
    return this.titles;
  }

  /**
   * 激活称号
   */
  async activateTitle(titleId) {
    const response = await this.api.put(`/users/me/titles/${titleId}/activate`);
    
    // 更新本地状态
    this.titles.forEach(t => t.isActive = false);
    const title = this.titles.find(t => t.titleId === titleId);
    if (title) {
      title.isActive = true;
      this.activeTitle = title;
      this.statBonuses = title.statBonuses || {};
    }
    
    return response.data;
  }

  /**
   * 获取称号显示名称
   */
  getTitleDisplayName(lang = 'zh') {
    if (!this.activeTitle) return '';
    return this.activeTitle.name[lang] || this.activeTitle.name['en'];
  }

  /**
   * 获取称号图标
   */
  getTitleIcon() {
    if (!this.activeTitle) return null;
    return this.activeTitle.iconUrl;
  }

  /**
   * 获取称号特效CSS类
   */
  getTitleEffectClass() {
    if (!this.activeTitle || !this.activeTitle.specialEffects) return '';
    
    const rarity = this.activeTitle.rarity;
    const effects = this.activeTitle.specialEffects;
    
    const classes = [`title-${rarity}`];
    
    if (effects.glowColor) {
      classes.push('title-glow');
    }
    if (effects.particles) {
      classes.push('title-particles');
    }
    if (effects.aura) {
      classes.push('title-aura');
    }
    
    return classes.join(' ');
  }

  /**
   * 获取属性加成文本
   */
  getStatBonusText(lang = 'zh') {
    const bonuses = [];
    const texts = {
      zh: {
        catch_rate: '捕捉率',
        exp_bonus: '经验加成',
        battle_power: '战斗力量'
      },
      en: {
        catch_rate: 'Catch Rate',
        exp_bonus: 'EXP Bonus',
        battle_power: 'Battle Power'
      }
    };

    for (const [stat, value] of Object.entries(this.statBonuses)) {
      const percentage = Math.round(value * 100);
      bonuses.push(`${texts[lang][stat] || stat} +${percentage}%`);
    }

    return bonuses;
  }

  /**
   * 渲染称号徽章
   */
  renderTitleBadge(container) {
    if (!this.activeTitle) return;

    const badge = document.createElement('div');
    badge.className = `title-badge ${this.getTitleEffectClass()}`;
    
    if (this.activeTitle.iconUrl) {
      badge.innerHTML = `
        <img src="${this.activeTitle.iconUrl}" alt="" class="title-icon" />
        <span class="title-name">${this.getTitleDisplayName()}</span>
      `;
    } else {
      badge.innerHTML = `
        <span class="title-name">${this.getTitleDisplayName()}</span>
      `;
    }

    container.appendChild(badge);
  }

  /**
   * 渲染称号选择器
   */
  renderTitleSelector(container) {
    const categories = this.groupByCategory();
    
    const selector = document.createElement('div');
    selector.className = 'title-selector';
    
    for (const [category, titles] of Object.entries(categories)) {
      const section = document.createElement('div');
      section.className = 'title-category';
      section.innerHTML = `
        <h3 class="category-title">${this.getCategoryName(category)}</h3>
        <div class="title-list"></div>
      `;
      
      const list = section.querySelector('.title-list');
      titles.forEach(title => {
        const item = this.createTitleItem(title);
        list.appendChild(item);
      });
      
      selector.appendChild(section);
    }
    
    container.appendChild(selector);
  }

  /**
   * 创建称号项
   */
  createTitleItem(title) {
    const item = document.createElement('div');
    item.className = `title-item title-${title.rarity} ${title.isActive ? 'active' : ''}`;
    
    item.innerHTML = `
      <div class="title-icon-wrapper">
        ${title.iconUrl ? `<img src="${title.iconUrl}" alt="" />` : '<div class="placeholder-icon"></div>'}
      </div>
      <div class="title-info">
        <div class="title-name">${title.name.zh}</div>
        <div class="title-desc">${title.description.zh}</div>
        ${Object.keys(title.statBonuses || {}).length > 0 ? `
          <div class="title-bonuses">
            ${this.getStatBonusText().join(' | ')}
          </div>
        ` : ''}
      </div>
      <div class="title-actions">
        <button class="btn-activate" ${title.isActive ? 'disabled' : ''}>
          ${title.isActive ? '使用中' : '使用'}
        </button>
      </div>
    `;
    
    if (!title.isActive) {
      item.querySelector('.btn-activate').addEventListener('click', async () => {
        await this.activateTitle(title.titleId);
        // 刷新UI
        this.refreshTitleSelector();
      });
    }
    
    return item;
  }

  /**
   * 按类别分组
   */
  groupByCategory() {
    const groups = {};
    this.titles.forEach(title => {
      if (!groups[title.category]) {
        groups[title.category] = [];
      }
      groups[title.category].push(title);
    });
    return groups;
  }

  /**
   * 获取类别名称
   */
  getCategoryName(category) {
    const names = {
      achievement: '成就称号',
      event: '活动称号',
      rank: '排名称号',
      special: '特殊称号'
    };
    return names[category] || category;
  }
}
```

### 6. Prometheus 指标

```javascript
// 称号相关指标
const titleMetrics = {
  titlesUnlocked: new promClient.Counter({
    name: 'minego_titles_unlocked_total',
    help: 'Total titles unlocked',
    labelNames: ['rarity', 'category', 'source_type']
  }),

  titlesActivated: new promClient.Counter({
    name: 'minego_titles_activated_total',
    help: 'Total title activations'
  }),

  titleShopPurchases: new promClient.Counter({
    name: 'minego_title_shop_purchases_total',
    help: 'Total title purchases from shop',
    labelNames: ['title_id', 'rarity']
  }),

  titlesExpired: new promClient.Counter({
    name: 'minego_titles_expired_total',
    help: 'Total titles expired'
  }),

  titleLeaderboardViews: new promClient.Counter({
    name: 'minego_title_leaderboard_views_total',
    help: 'Total title leaderboard views'
  })
};
```

## 验收标准

- [ ] 数据库表创建成功，包含完整的索引和约束
- [ ] 称号服务核心模块实现，支持解锁/激活/查询
- [ ] 称号定义种子数据至少包含 20 个不同称号
- [ ] API 端点实现并通过测试（8+ 个端点）
- [ ] 前端称号管理组件实现
- [ ] 称号在玩家资料、排行榜中正确展示
- [ ] 属性加成功能正常工作
- [ ] 限时称号过期处理正确
- [ ] 与成就系统集成（完成成就自动解锁称号）
- [ ] Prometheus 指标正常上报
- [ ] 单元测试覆盖率 > 80%
- [ ] 性能测试：称号查询 < 50ms

## 影响范围

### 新增文件
- database/pending/20260611_053000__add_title_system.sql
- backend/services/user-service/src/titleService.js
- backend/services/user-service/src/routes/titles.js
- frontend/game-client/src/components/TitleManager.js
- frontend/game-client/src/components/TitleSelector.js
- frontend/game-client/src/styles/titles.css
- backend/tests/unit/title-service.test.js

### 修改文件
- backend/services/user-service/src/index.js (添加路由)
- backend/services/pokemon-service/src/achievementService.js (集成称号解锁)
- frontend/game-client/src/game/GameStore.js (添加称号状态)
- frontend/game-client/src/components/PlayerProfile.js (展示称号)
- frontend/game-client/src/components/Leaderboard.js (展示称号)

## 参考

- REQ-00076: 精灵成就系统与里程碑奖励（称号来源）
- REQ-00074: 玩家排行榜系统（称号展示）
- 原版 Pokemon GO 称号系统设计
