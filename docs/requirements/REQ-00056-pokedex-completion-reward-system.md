# REQ-00056: 精灵图鉴完成度奖励系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00056 |
| 标题 | 精灵图鉴完成度奖励系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-09 17:00 |

## 需求描述

实现完整的精灵图鉴完成度奖励系统，鼓励玩家收集更多精灵，提升游戏粘性和长期留存率。系统根据玩家图鉴完成度（已捕获/已见过）提供阶段性奖励、成就和特殊权益。

### 核心功能

1. **图鉴完成度追踪**
   - 已见过精灵数量（Seen）
   - 已捕获精灵数量（Caught）
   - 按地区/世代分类统计
   - 按属性分类统计
   - 完成度百分比计算

2. **阶段性奖励系统**
   - 10% 完成度奖励：基础道具包
   - 25% 完成度奖励：稀有精灵蛋
   - 50% 完成度奖励：大师球 × 3
   - 75% 完成度奖励：闪光精灵遭遇券
   - 100% 完成度奖励：特殊称号 + 闪光图鉴解锁

3. **图鉴成就系统**
   - "初学者"：捕获 10 种精灵
   - "收藏家"：捕获 50 种精灵
   - "专家"：捕获 100 种精灵
   - "大师"：捕获 200 种精灵
   - "传奇"：完成图鉴 100%

4. **特殊权益**
   - 图鉴完成度影响捕捉概率加成
   - 解锁特殊商店物品
   - 解锁特殊任务线
   - 社交展示徽章

5. **稀有度追踪**
   - 每种精灵的捕获次数
   - 闪光精灵捕获统计
   - 传说精灵捕获统计

## 技术方案

### 1. 数据库设计

```sql
-- 图鉴完成度记录表
CREATE TABLE pokedex_progress (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pokemon_species_id INTEGER NOT NULL,
    seen BOOLEAN DEFAULT FALSE,
    caught BOOLEAN DEFAULT FALSE,
    catch_count INTEGER DEFAULT 0,
    shiny_caught BOOLEAN DEFAULT FALSE,
    first_seen_at TIMESTAMP,
    first_caught_at TIMESTAMP,
    last_seen_at TIMESTAMP,
    last_caught_at TIMESTAMP,
    UNIQUE(user_id, pokemon_species_id)
);

-- 图鉴里程碑奖励表
CREATE TABLE pokedex_milestones (
    id SERIAL PRIMARY KEY,
    milestone_type VARCHAR(20) CHECK (milestone_type IN ('percentage', 'count', 'category')),
    threshold INTEGER NOT NULL,
    category VARCHAR(50), -- 'kanto', 'johto', 'legendary', etc.
    reward_type VARCHAR(50) NOT NULL,
    reward_data JSONB NOT NULL,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    is_repeatable BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户里程碑领取记录
CREATE TABLE user_milestone_claims (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone_id INTEGER NOT NULL REFERENCES pokedex_milestones(id),
    claimed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, milestone_id)
);

-- 图鉴成就表
CREATE TABLE pokedex_achievements (
    id SERIAL PRIMARY KEY,
    achievement_key VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    requirement_type VARCHAR(50) NOT NULL,
    requirement_value INTEGER NOT NULL,
    reward_type VARCHAR(50),
    reward_data JSONB,
    badge_icon VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 用户图鉴成就解锁记录
CREATE TABLE user_pokedex_achievements (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id INTEGER NOT NULL REFERENCES pokedex_achievements(id),
    unlocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, achievement_id)
);

-- 图鉴统计缓存表
CREATE TABLE pokedex_stats_cache (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    total_species INTEGER DEFAULT 0,
    seen_count INTEGER DEFAULT 0,
    caught_count INTEGER DEFAULT 0,
    shiny_count INTEGER DEFAULT 0,
    legendary_count INTEGER DEFAULT 0,
    completion_percentage DECIMAL(5,2) DEFAULT 0.00,
    region_stats JSONB DEFAULT '{}',
    type_stats JSONB DEFAULT '{}',
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建索引
CREATE INDEX idx_pokedex_progress_user ON pokedex_progress(user_id);
CREATE INDEX idx_pokedex_progress_species ON pokedex_progress(pokemon_species_id);
CREATE INDEX idx_pokedex_progress_caught ON pokedex_progress(user_id, caught) WHERE caught = TRUE;
CREATE INDEX idx_pokedex_stats_cache_updated ON pokedex_stats_cache(last_updated);
```

### 2. 后端服务实现

#### pokemon-service/src/pokedexService.js

```javascript
const { db } = require('../shared/db');
const { EventBus, EVENTS } = require('../shared/EventBus');
const { achievements } = require('./pokedexAchievements');
const { milestones } = require('./pokedexMilestones');

class PokedexService {
  constructor() {
    this.TOTAL_SPECIES = 905; // 总精灵种类数
  }

  /**
   * 记录精灵见过
   */
  async recordSeen(userId, pokemonSpeciesId) {
    const existing = await db.query(
      `SELECT * FROM pokedex_progress WHERE user_id = $1 AND pokemon_species_id = $2`,
      [userId, pokemonSpeciesId]
    );

    if (existing.rows.length > 0) {
      await db.query(
        `UPDATE pokedex_progress 
         SET seen = TRUE, last_seen_at = CURRENT_TIMESTAMP 
         WHERE user_id = $1 AND pokemon_species_id = $2`,
        [userId, pokemonSpeciesId]
      );
    } else {
      await db.query(
        `INSERT INTO pokedex_progress (user_id, pokemon_species_id, seen, first_seen_at, last_seen_at)
         VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, pokemonSpeciesId]
      );
    }

    await this.updateStatsCache(userId);
    await this.checkMilestones(userId);
    await this.checkAchievements(userId);
  }

  /**
   * 记录精灵捕获
   */
  async recordCaught(userId, pokemonSpeciesId, isShiny = false) {
    const existing = await db.query(
      `SELECT * FROM pokedex_progress WHERE user_id = $1 AND pokemon_species_id = $2`,
      [userId, pokemonSpeciesId]
    );

    if (existing.rows.length > 0) {
      const updates = ['caught = TRUE', 'catch_count = catch_count + 1', 'last_caught_at = CURRENT_TIMESTAMP'];
      const values = [userId, pokemonSpeciesId];
      
      if (isShiny) {
        updates.push('shiny_caught = TRUE');
      }
      
      if (!existing.rows[0].first_caught_at) {
        updates.push('first_caught_at = CURRENT_TIMESTAMP');
      }

      await db.query(
        `UPDATE pokedex_progress SET ${updates.join(', ')} WHERE user_id = $1 AND pokemon_species_id = $2`,
        values
      );
    } else {
      await db.query(
        `INSERT INTO pokedex_progress 
         (user_id, pokemon_species_id, seen, caught, catch_count, shiny_caught, first_seen_at, first_caught_at, last_caught_at)
         VALUES ($1, $2, TRUE, TRUE, 1, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [userId, pokemonSpeciesId, isShiny]
      );
    }

    // 发布图鉴更新事件
    await EventBus.publish(EVENTS.POKEDEX_UPDATED, {
      userId,
      pokemonSpeciesId,
      isShiny,
      timestamp: new Date()
    });

    await this.updateStatsCache(userId);
    await this.checkMilestones(userId);
    await this.checkAchievements(userId);
  }

  /**
   * 获取图鉴进度
   */
  async getPokedexProgress(userId) {
    const stats = await db.query(
      `SELECT * FROM pokedex_stats_cache WHERE user_id = $1`,
      [userId]
    );

    if (stats.rows.length === 0) {
      await this.updateStatsCache(userId);
      return this.getPokedexProgress(userId);
    }

    return stats.rows[0];
  }

  /**
   * 获取详细进度列表
   */
  async getDetailedProgress(userId, filters = {}) {
    let query = `
      SELECT 
        pp.*,
        ps.name as species_name,
        ps.pokedex_number,
        ps.generation,
        ps.region,
        ps.types,
        ps.is_legendary,
        ps.is_mythical
      FROM pokedex_progress pp
      JOIN pokemon_species ps ON pp.pokemon_species_id = ps.id
      WHERE pp.user_id = $1
    `;
    
    const values = [userId];
    let paramCount = 2;

    if (filters.region) {
      query += ` AND ps.region = $${paramCount}`;
      values.push(filters.region);
      paramCount++;
    }

    if (filters.type) {
      query += ` AND $${paramCount} = ANY(ps.types)`;
      values.push(filters.type);
      paramCount++;
    }

    if (filters.caught !== undefined) {
      query += ` AND pp.caught = $${paramCount}`;
      values.push(filters.caught);
      paramCount++;
    }

    if (filters.shiny) {
      query += ` AND pp.shiny_caught = TRUE`;
    }

    query += ` ORDER BY ps.pokedex_number`;

    const result = await db.query(query, values);
    return result.rows;
  }

  /**
   * 更新统计缓存
   */
  async updateStatsCache(userId) {
    const stats = await db.query(`
      SELECT 
        COUNT(DISTINCT CASE WHEN seen THEN pokemon_species_id END) as seen_count,
        COUNT(DISTINCT CASE WHEN caught THEN pokemon_species_id END) as caught_count,
        COUNT(DISTINCT CASE WHEN shiny_caught THEN pokemon_species_id END) as shiny_count,
        COUNT(DISTINCT CASE WHEN caught AND ps.is_legendary THEN pokemon_species_id END) as legendary_count
      FROM pokedex_progress pp
      LEFT JOIN pokemon_species ps ON pp.pokemon_species_id = ps.id
      WHERE pp.user_id = $1
    `, [userId]);

    const regionStats = await db.query(`
      SELECT 
        ps.region,
        COUNT(DISTINCT CASE WHEN pp.caught THEN pp.pokemon_species_id END) as caught_count,
        COUNT(DISTINCT pp.pokemon_species_id) as total_in_region
      FROM pokemon_species ps
      LEFT JOIN pokedex_progress pp ON ps.id = pp.pokemon_species_id AND pp.user_id = $1
      GROUP BY ps.region
    `, [userId]);

    const typeStats = await db.query(`
      SELECT 
        unnest(ps.types) as type,
        COUNT(DISTINCT CASE WHEN pp.caught THEN pp.pokemon_species_id END) as caught_count,
        COUNT(DISTINCT ps.id) as total_of_type
      FROM pokemon_species ps
      LEFT JOIN pokedex_progress pp ON ps.id = pp.pokemon_species_id AND pp.user_id = $1
      GROUP BY unnest(ps.types)
    `, [userId]);

    const seen = parseInt(stats.rows[0].seen_count) || 0;
    const caught = parseInt(stats.rows[0].caught_count) || 0;
    const completion = (caught / this.TOTAL_SPECIES * 100).toFixed(2);

    await db.query(`
      INSERT INTO pokedex_stats_cache 
        (user_id, total_species, seen_count, caught_count, shiny_count, legendary_count, 
         completion_percentage, region_stats, type_stats, last_updated)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id) 
      DO UPDATE SET 
        total_species = EXCLUDED.total_species,
        seen_count = EXCLUDED.seen_count,
        caught_count = EXCLUDED.caught_count,
        shiny_count = EXCLUDED.shiny_count,
        legendary_count = EXCLUDED.legendary_count,
        completion_percentage = EXCLUDED.completion_percentage,
        region_stats = EXCLUDED.region_stats,
        type_stats = EXCLUDED.type_stats,
        last_updated = CURRENT_TIMESTAMP
    `, [
      userId,
      this.TOTAL_SPECIES,
      seen,
      caught,
      parseInt(stats.rows[0].shiny_count) || 0,
      parseInt(stats.rows[0].legendary_count) || 0,
      completion,
      JSON.stringify(regionStats.rows),
      JSON.stringify(typeStats.rows)
    ]);
  }

  /**
   * 检查里程碑奖励
   */
  async checkMilestones(userId) {
    const progress = await this.getPokedexProgress(userId);
    const completionPercent = parseFloat(progress.completion_percentage);

    // 获取未领取的里程碑
    const unclaimedMilestones = await db.query(`
      SELECT pm.* 
      FROM pokedex_milestones pm
      LEFT JOIN user_milestone_claims umc ON pm.id = umc.milestone_id AND umc.user_id = $1
      WHERE umc.id IS NULL 
        AND (
          (pm.milestone_type = 'percentage' AND $2 >= pm.threshold) OR
          (pm.milestone_type = 'count' AND $3 >= pm.threshold) OR
          (pm.milestone_type = 'category' AND $4::jsonb->pm.category->>'caught_count' >= pm.threshold)
        )
    `, [userId, completionPercent, progress.caught_count, progress.region_stats]);

    const rewards = [];

    for (const milestone of unclaimedMilestones.rows) {
      // 自动发放奖励
      await this.claimMilestone(userId, milestone.id);
      rewards.push({
        milestoneId: milestone.id,
        title: milestone.title,
        rewardType: milestone.reward_type,
        rewardData: milestone.reward_data
      });
    }

    return rewards;
  }

  /**
   * 领取里程碑奖励
   */
  async claimMilestone(userId, milestoneId) {
    const milestone = await db.query(
      'SELECT * FROM pokedex_milestones WHERE id = $1',
      [milestoneId]
    );

    if (milestone.rows.length === 0) {
      throw new Error('Milestone not found');
    }

    // 记录领取
    await db.query(
      `INSERT INTO user_milestone_claims (user_id, milestone_id) VALUES ($1, $2) 
       ON CONFLICT DO NOTHING`,
      [userId, milestoneId]
    );

    // 发放奖励（调用 reward-service）
    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      source: 'pokedex_milestone',
      sourceId: milestoneId,
      rewards: milestone.rows[0].reward_data
    });

    return milestone.rows[0];
  }

  /**
   * 检查成就解锁
   */
  async checkAchievements(userId) {
    const progress = await this.getPokedexProgress(userId);
    const unlockedAchievements = [];

    for (const achievement of achievements) {
      // 检查是否已解锁
      const existing = await db.query(
        `SELECT 1 FROM user_pokedex_achievements WHERE user_id = $1 AND achievement_id = $2`,
        [userId, achievement.id]
      );

      if (existing.rows.length > 0) continue;

      // 检查解锁条件
      let shouldUnlock = false;

      switch (achievement.requirement_type) {
        case 'caught_count':
          shouldUnlock = progress.caught_count >= achievement.requirement_value;
          break;
        case 'shiny_count':
          shouldUnlock = progress.shiny_count >= achievement.requirement_value;
          break;
        case 'legendary_count':
          shouldUnlock = progress.legendary_count >= achievement.requirement_value;
          break;
        case 'completion_percentage':
          shouldUnlock = parseFloat(progress.completion_percentage) >= achievement.requirement_value;
          break;
      }

      if (shouldUnlock) {
        await db.query(
          `INSERT INTO user_pokedex_achievements (user_id, achievement_id) VALUES ($1, $2)`,
          [userId, achievement.id]
        );

        // 发放成就奖励
        if (achievement.reward_data) {
          await EventBus.publish(EVENTS.REWARD_GRANT, {
            userId,
            source: 'pokedex_achievement',
            sourceId: achievement.id,
            rewards: achievement.reward_data
          });
        }

        unlockedAchievements.push(achievement);
      }
    }

    return unlockedAchievements;
  }

  /**
   * 获取用户成就列表
   */
  async getUserAchievements(userId) {
    const result = await db.query(`
      SELECT 
        pa.*,
        upa.unlocked_at
      FROM pokedex_achievements pa
      LEFT JOIN user_pokedex_achievements upa ON pa.id = upa.achievement_id AND upa.user_id = $1
      ORDER BY pa.requirement_value
    `, [userId]);

    return result.rows;
  }

  /**
   * 获取捕捉概率加成
   */
  async getCatchBonus(userId) {
    const progress = await this.getPokedexProgress(userId);
    
    // 每 10% 完成度增加 1% 捕捉概率
    const bonusPercent = Math.floor(parseFloat(progress.completion_percentage) / 10);
    
    return {
      bonusPercent,
      reason: `图鉴完成度 ${progress.completion_percentage}%`
    };
  }

  /**
   * 获取排行榜
   */
  async getLeaderboard(limit = 100, offset = 0) {
    const result = await db.query(`
      SELECT 
        psc.user_id,
        psc.caught_count,
        psc.completion_percentage,
        psc.shiny_count,
        u.username,
        u.avatar,
        RANK() OVER (ORDER BY psc.caught_count DESC, psc.shiny_count DESC) as rank
      FROM pokedex_stats_cache psc
      JOIN users u ON psc.user_id = u.id
      ORDER BY psc.caught_count DESC, psc.shiny_count DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return result.rows;
  }
}

module.exports = new PokedexService();
```

#### pokemon-service/src/routes/pokedex.js

```javascript
const express = require('express');
const router = express.Router();
const pokedexService = require('../pokedexService');
const { authenticate } = require('../../../shared/middleware/auth');

/**
 * GET /api/pokedex/progress
 * 获取图鉴完成度进度
 */
router.get('/progress', authenticate, async (req, res) => {
  try {
    const progress = await pokedexService.getPokedexProgress(req.user.id);
    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('Get pokedex progress error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/detailed
 * 获取详细图鉴列表
 */
router.get('/detailed', authenticate, async (req, res) => {
  try {
    const { region, type, caught, shiny } = req.query;
    const filters = { region, type, caught: caught === 'true', shiny: shiny === 'true' };
    
    const detailed = await pokedexService.getDetailedProgress(req.user.id, filters);
    res.json({
      success: true,
      data: detailed,
      count: detailed.length
    });
  } catch (error) {
    console.error('Get detailed pokedex error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/achievements
 * 获取图鉴成就列表
 */
router.get('/achievements', authenticate, async (req, res) => {
  try {
    const achievements = await pokedexService.getUserAchievements(req.user.id);
    res.json({
      success: true,
      data: achievements
    });
  } catch (error) {
    console.error('Get achievements error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/milestones
 * 获取可用里程碑奖励
 */
router.get('/milestones', authenticate, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        pm.*,
        CASE WHEN umc.id IS NOT NULL THEN TRUE ELSE FALSE END as claimed
      FROM pokedex_milestones pm
      LEFT JOIN user_milestone_claims umc ON pm.id = umc.milestone_id AND umc.user_id = $1
      ORDER BY pm.threshold
    `, [req.user.id]);

    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Get milestones error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pokedex/milestones/:milestoneId/claim
 * 手动领取里程碑奖励
 */
router.post('/milestones/:milestoneId/claim', authenticate, async (req, res) => {
  try {
    const milestone = await pokedexService.claimMilestone(req.user.id, req.params.milestoneId);
    res.json({
      success: true,
      data: milestone,
      message: '奖励已发放'
    });
  } catch (error) {
    console.error('Claim milestone error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/catch-bonus
 * 获取捕捉概率加成
 */
router.get('/catch-bonus', authenticate, async (req, res) => {
  try {
    const bonus = await pokedexService.getCatchBonus(req.user.id);
    res.json({
      success: true,
      data: bonus
    });
  } catch (error) {
    console.error('Get catch bonus error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/leaderboard
 * 获取图鉴排行榜
 */
router.get('/leaderboard', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    const leaderboard = await pokedexService.getLeaderboard(
      parseInt(limit),
      parseInt(offset)
    );
    
    res.json({
      success: true,
      data: leaderboard
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokedex/stats/:userId
 * 获取指定用户的图鉴统计
 */
router.get('/stats/:userId', async (req, res) => {
  try {
    const progress = await pokedexService.getPokedexProgress(parseInt(req.params.userId));
    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 3. 前端组件实现

#### game-client/src/components/PokedexProgress.js

```javascript
class PokedexProgress {
  constructor(container) {
    this.container = container;
    this.progress = null;
    this.achievements = [];
    this.milestones = [];
    this.init();
  }

  async init() {
    await this.loadProgress();
    this.render();
    this.bindEvents();
  }

  async loadProgress() {
    try {
      const [progressRes, achievementsRes, milestonesRes] = await Promise.all([
        fetch('/api/pokedex/progress', {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        }),
        fetch('/api/pokedex/achievements', {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        }),
        fetch('/api/pokedex/milestones', {
          headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
        })
      ]);

      this.progress = await progressRes.json();
      this.achievements = await achievementsRes.json();
      this.milestones = await milestonesRes.json();
    } catch (error) {
      console.error('Load pokedex progress error:', error);
    }
  }

  render() {
    const data = this.progress.data;
    const completionPercent = parseFloat(data.completion_percentage);
    
    this.container.innerHTML = `
      <div class="pokedex-progress-container">
        <div class="progress-header">
          <h2>📸 图鉴完成度</h2>
          <div class="completion-badge ${this.getBadgeClass(completionPercent)}">
            ${completionPercent.toFixed(1)}%
          </div>
        </div>

        <div class="progress-stats">
          <div class="stat-card">
            <div class="stat-icon">👁️</div>
            <div class="stat-content">
              <div class="stat-value">${data.seen_count}</div>
              <div class="stat-label">已见过</div>
            </div>
          </div>
          
          <div class="stat-card primary">
            <div class="stat-icon">🎯</div>
            <div class="stat-content">
              <div class="stat-value">${data.caught_count}</div>
              <div class="stat-label">已捕获</div>
            </div>
          </div>
          
          <div class="stat-card shiny">
            <div class="stat-icon">✨</div>
            <div class="stat-content">
              <div class="stat-value">${data.shiny_count}</div>
              <div class="stat-label">闪光精灵</div>
            </div>
          </div>
          
          <div class="stat-card legendary">
            <div class="stat-icon">⭐</div>
            <div class="stat-content">
              <div class="stat-value">${data.legendary_count}</div>
              <div class="stat-label">传说精灵</div>
            </div>
          </div>
        </div>

        <div class="progress-bar-container">
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${completionPercent}%"></div>
            <div class="progress-label">${data.caught_count} / ${data.total_species}</div>
          </div>
        </div>

        ${this.renderRegionStats(data.region_stats)}
        
        ${this.renderMilestones()}
        
        ${this.renderAchievements()}
      </div>
    `;
  }

  renderRegionStats(regionStats) {
    if (!regionStats || Object.keys(regionStats).length === 0) return '';

    const stats = typeof regionStats === 'string' ? JSON.parse(regionStats) : regionStats;
    
    return `
      <div class="region-stats">
        <h3>🌍 地区进度</h3>
        <div class="region-grid">
          ${stats.map(region => `
            <div class="region-card">
              <div class="region-name">${this.getRegionName(region.region)}</div>
              <div class="region-progress">
                <div class="mini-progress-bar">
                  <div class="mini-progress-fill" 
                       style="width: ${(region.caught_count / region.total_in_region * 100).toFixed(1)}%">
                  </div>
                </div>
                <div class="region-count">${region.caught_count}/${region.total_in_region}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  renderMilestones() {
    const unclaimed = this.milestones.data.filter(m => !m.claimed);
    const claimed = this.milestones.data.filter(m => m.claimed);

    return `
      <div class="milestones-section">
        <h3>🏆 里程碑奖励</h3>
        
        ${unclaimed.length > 0 ? `
          <div class="unclaimed-milestones">
            <h4>🎁 待领取奖励</h4>
            <div class="milestone-grid">
              ${unclaimed.map(m => `
                <div class="milestone-card unclaimed" data-milestone-id="${m.id}">
                  <div class="milestone-icon">${this.getMilestoneIcon(m.milestone_type)}</div>
                  <div class="milestone-info">
                    <div class="milestone-title">${m.title}</div>
                    <div class="milestone-desc">${m.description || ''}</div>
                    <div class="milestone-reward">
                      ${this.formatReward(m.reward_type, m.reward_data)}
                    </div>
                  </div>
                  <button class="claim-btn">领取</button>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <div class="claimed-milestones">
          <h4>✅ 已获得奖励</h4>
          <div class="milestone-grid">
            ${claimed.slice(0, 5).map(m => `
              <div class="milestone-card claimed">
                <div class="milestone-icon">${this.getMilestoneIcon(m.milestone_type)}</div>
                <div class="milestone-info">
                  <div class="milestone-title">${m.title}</div>
                </div>
                <div class="check-icon">✓</div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;
  }

  renderAchievements() {
    const unlocked = this.achievements.data.filter(a => a.unlocked_at);
    const locked = this.achievements.data.filter(a => !a.unlocked_at);

    return `
      <div class="achievements-section">
        <h3>🏅 图鉴成就</h3>
        
        <div class="achievements-grid">
          ${this.achievements.data.map(achievement => `
            <div class="achievement-card ${achievement.unlocked_at ? 'unlocked' : 'locked'}">
              <div class="achievement-badge">
                ${achievement.unlocked_at ? achievement.badge_icon : '🔒'}
              </div>
              <div class="achievement-info">
                <div class="achievement-name">${achievement.name}</div>
                <div class="achievement-desc">${achievement.description}</div>
                ${!achievement.unlocked_at ? `
                  <div class="achievement-progress">
                    进度: ${this.getAchievementProgress(achievement)}
                  </div>
                ` : `
                  <div class="achievement-date">
                    解锁于: ${new Date(achievement.unlocked_at).toLocaleDateString()}
                  </div>
                `}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  bindEvents() {
    // 领取里程碑奖励
    this.container.querySelectorAll('.claim-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const card = e.target.closest('.milestone-card');
        const milestoneId = card.dataset.milestoneId;
        await this.claimMilestone(milestoneId, card);
      });
    });
  }

  async claimMilestone(milestoneId, cardElement) {
    try {
      cardElement.querySelector('.claim-btn').textContent = '领取中...';
      cardElement.querySelector('.claim-btn').disabled = true;

      const response = await fetch(`/api/pokedex/milestones/${milestoneId}/claim`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });

      const result = await response.json();

      if (result.success) {
        // 显示奖励动画
        this.showRewardAnimation(result.data);
        
        // 刷新数据
        await this.loadProgress();
        this.render();
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Claim milestone error:', error);
      alert('领取失败: ' + error.message);
      cardElement.querySelector('.claim-btn').textContent = '领取';
      cardElement.querySelector('.claim-btn').disabled = false;
    }
  }

  showRewardAnimation(reward) {
    // 创建奖励弹窗
    const modal = document.createElement('div');
    modal.className = 'reward-modal';
    modal.innerHTML = `
      <div class="reward-content">
        <h2>🎉 恭喜获得奖励！</h2>
        <div class="reward-items">
          ${this.formatRewardDetails(reward.reward_data)}
        </div>
        <button class="close-btn">确定</button>
      </div>
    `;

    document.body.appendChild(modal);
    modal.querySelector('.close-btn').addEventListener('click', () => {
      modal.remove();
    });
  }

  getBadgeClass(percent) {
    if (percent >= 100) return 'legendary';
    if (percent >= 75) return 'master';
    if (percent >= 50) return 'expert';
    if (percent >= 25) return 'collector';
    return 'beginner';
  }

  getRegionName(region) {
    const names = {
      'kanto': '关都',
      'johto': '城都',
      'hoenn': '丰缘',
      'sinnoh': '神奥',
      'unova': '合众',
      'kalos': '卡洛斯',
      'alola': '阿罗拉',
      'galar': '伽勒尔'
    };
    return names[region] || region;
  }

  getMilestoneIcon(type) {
    const icons = {
      'percentage': '📊',
      'count': '🎯',
      'category': '🏷️'
    };
    return icons[type] || '🏆';
  }

  formatReward(type, data) {
    // 格式化奖励显示
    const rewards = [];
    if (data.items) {
      rewards.push(`${data.items.length} 件道具`);
    }
    if (data.pokemon_egg) {
      rewards.push('稀有精灵蛋');
    }
    if (data.master_balls) {
      rewards.push(`大师球 × ${data.master_balls}`);
    }
    return rewards.join(' + ');
  }

  formatRewardDetails(data) {
    // 详细奖励列表
    let html = '';
    if (data.items) {
      html += data.items.map(item => `
        <div class="reward-item">
          <span class="item-icon">🎁</span>
          <span class="item-name">${item.name}</span>
          <span class="item-count">×${item.count || 1}</span>
        </div>
      `).join('');
    }
    return html;
  }

  getAchievementProgress(achievement) {
    // 根据成就类型计算进度
    const progress = this.progress.data;
    let current = 0;
    
    switch (achievement.requirement_type) {
      case 'caught_count':
        current = progress.caught_count;
        break;
      case 'shiny_count':
        current = progress.shiny_count;
        break;
      case 'completion_percentage':
        current = parseFloat(progress.completion_percentage);
        break;
    }
    
    return `${current} / ${achievement.requirement_value}`;
  }
}

module.exports = PokedexProgress;
```

### 4. 事件集成

#### 集成到捕捉流程

```javascript
// catch-service/src/index.js
const pokedexService = require('../../../pokemon-service/src/pokedexService');

// 在捕捉成功后
router.post('/catch', async (req, res) => {
  // ... 捕捉逻辑
  
  // 记录到图鉴
  await pokedexService.recordSeen(req.user.id, pokemon.species_id);
  
  if (catchSuccess) {
    await pokedexService.recordCaught(req.user.id, pokemon.species_id, pokemon.is_shiny);
  }
  
  // ... 返回结果
});
```

### 5. Prometheus 指标

```javascript
// pokemon-service/src/metrics.js
const client = require('prom-client');

const pokedexMetrics = {
  pokedexProgressTotal: new client.Gauge({
    name: 'pokedex_progress_total',
    help: 'Total number of users with pokedex progress',
    labelNames: ['completion_range']
  }),

  pokedexMilestonesClaimed: new client.Counter({
    name: 'pokedex_milestones_claimed_total',
    help: 'Total milestones claimed',
    labelNames: ['milestone_type']
  }),

  pokedexAchievementsUnlocked: new client.Counter({
    name: 'pokedex_achievements_unlocked_total',
    help: 'Total achievements unlocked',
    labelNames: ['achievement_key']
  }),

  pokedexCacheUpdates: new client.Counter({
    name: 'pokedex_cache_updates_total',
    help: 'Total pokedex stats cache updates'
  })
};

module.exports = pokedexMetrics;
```

## 验收标准

- [ ] 图鉴进度正确记录见过和捕获的精灵
- [ ] 完成度百分比计算准确
- [ ] 按地区和属性分类统计正确
- [ ] 里程碑奖励在达到条件时自动发放
- [ ] 成就系统正确检测解锁条件
- [ ] 捕捉概率加成正确应用
- [ ] 排行榜数据准确更新
- [ ] 前端界面正确显示所有进度和奖励
- [ ] 里程碑奖励可以手动领取
- [ ] 成就徽章正确显示已解锁/未解锁状态
- [ ] 地区进度统计准确
- [ ] 闪光精灵和传说精灵单独统计
- [ ] 缓存更新机制工作正常
- [ ] Prometheus 指标正确暴露
- [ ] 单元测试覆盖率 ≥ 80%

## 影响范围

- **数据库**: 新增 6 张表（pokedex_progress、pokedex_milestones、user_milestone_claims、pokedex_achievements、user_pokedex_achievements、pokedex_stats_cache）
- **pokemon-service**: 新增 pokedexService.js，新增路由 pokedex.js
- **catch-service**: 集成图鉴记录逻辑
- **reward-service**: 接收图鉴奖励发放事件
- **game-client**: 新增 PokedexProgress 组件
- **API**: 新增 8 个图鉴相关端点
- **metrics**: 新增 4 个 Prometheus 指标

## 参考

- [宝可梦图鉴系统设计](https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9dex)
- [游戏成就系统最佳实践](https://www.gamasutra.com/blogs/JoshBycer/20180808/324835/Designing_Achievements_for_Game_Design.php)
- [进度追踪系统 UX 设计](https://www.nngroup.com/articles/progress-trackers/)
- REQ-00026: 游戏内实时推送通知系统（奖励通知）
- REQ-00019: 精灵技能学习与技能机器系统（精灵数据结构）
