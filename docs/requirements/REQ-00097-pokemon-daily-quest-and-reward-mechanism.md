# REQ-00097: 精灵日常任务系统与任务奖励机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00097 |
| 标题 | 精灵日常任务系统与任务奖励机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | reward-service、user-service、pokemon-service、catch-service、social-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-10 17:00 |

## 需求描述

### 背景
当前 mineGo 游戏缺乏玩家日常目标系统，导致玩家日活跃度不足，缺乏留存激励。主流 LBS 游戏均具备完善的日常任务系统，通过每日刷新的任务目标引导玩家行为，提升留存率和游戏粘性。

### 目标
实现完整的精灵日常任务系统，包括：
1. **任务生成引擎** - 每日自动生成多样化任务
2. **进度追踪系统** - 实时追踪任务进度
3. **奖励发放机制** - 任务完成后发放奖励
4. **任务类型体系** - 覆盖捕捉、战斗、社交、探索等核心玩法
5. **连续完成奖励** - 鼓励每日登录的连击机制

### 核心功能

#### 1. 任务类型
| 类型 | 任务示例 | 难度 |
|------|----------|------|
| 捕捉任务 | 捕捉 5 只水属性精灵 | 简单/中等/困难 |
| 战斗任务 | 在道馆战斗中获胜 3 次 | 中等/困难 |
| 社交任务 | 与好友交换 1 只精灵 | 简单 |
| 探索任务 | 访问 3 个 PokéStop | 简单/中等 |
| 进化任务 | 进化 2 只精灵 | 中等 |
| 培育任务 | 孵化 1 个精灵蛋 | 困难 |
| 特殊任务 | 在雨天捕捉 3 只精灵 | 中等 |

#### 2. 任务池配置
- **日常任务池**：每日随机抽取 3 个任务
- **周常任务池**：每周刷新，更高奖励
- **限时任务池**：活动期间特殊任务

#### 3. 奖励体系
| 奖励类型 | 示例 | 用途 |
|----------|------|------|
| 精灵球 | Poké Ball x10 | 捕捉精灵 |
| 莓果 | Razz Berry x3 | 提高捕捉率 |
| 星尘 | 500-2000 Stardust | 通用货币 |
| 经验值 | 100-1000 XP | 玩家升级 |
| 稀有道具 | TM、Rare Candy | 进阶道具 |
| 精灵遭遇 | 特定精灵遭遇机会 | 稀有精灵 |

#### 4. 连击奖励
- 连续完成天数：1-7 天
- 连击倍率：1.0x → 1.2x → 1.4x → 1.6x → 1.8x → 2.0x → 2.5x
- 断签重置连击

## 技术方案

### 1. 数据库设计

```sql
-- database/pending/20260610_170000__add_daily_quest_system.sql

-- 任务定义表
CREATE TABLE quest_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quest_type VARCHAR(50) NOT NULL, -- 'catch', 'battle', 'social', 'explore', 'evolve', 'breed', 'special'
    title_i18n_key VARCHAR(100) NOT NULL, -- 国际化 key
    description_i18n_key VARCHAR(100) NOT NULL,
    objective_type VARCHAR(50) NOT NULL, -- 'catch_pokemon', 'win_gym_battle', 'trade_pokemon', etc.
    objective_params JSONB DEFAULT '{}', -- {'type': 'water', 'count': 5}
    difficulty VARCHAR(20) NOT NULL DEFAULT 'medium', -- 'easy', 'medium', 'hard'
    reward_config JSONB NOT NULL, -- {'items': [...], 'stardust': 500, 'xp': 100}
    time_restriction JSONB, -- {'weather': 'rain', 'timeOfDay': 'night'}
    weight INTEGER DEFAULT 100, -- 抽取权重
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家任务表
CREATE TABLE player_quests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_definition_id UUID NOT NULL REFERENCES quest_definitions(id),
    quest_pool VARCHAR(20) NOT NULL, -- 'daily', 'weekly', 'limited_time'
    progress_current INTEGER DEFAULT 0,
    progress_target INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'in_progress', -- 'in_progress', 'completed', 'claimed'
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP,
    claimed_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_quest UNIQUE (user_id, quest_definition_id, assigned_at::date)
);

-- 任务完成历史
CREATE TABLE quest_completion_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_definition_id UUID NOT NULL,
    completed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    rewards_claimed JSONB NOT NULL,
    streak_day INTEGER, -- 连击天数
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 玩家连击记录
CREATE TABLE player_quest_streaks (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_streak INTEGER DEFAULT 0,
    longest_streak INTEGER DEFAULT 0,
    last_completion_date DATE,
    multiplier DECIMAL(3,2) DEFAULT 1.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_player_quests_user_status ON player_quests(user_id, status);
CREATE INDEX idx_player_quests_expires ON player_quests(expires_at) WHERE status = 'in_progress';
CREATE INDEX idx_quest_completion_user_date ON quest_completion_history(user_id, completed_at::date);
CREATE INDEX idx_quest_definitions_type ON quest_definitions(quest_type, is_active);

-- 种子数据：示例任务定义
INSERT INTO quest_definitions (quest_type, title_i18n_key, description_i18n_key, objective_type, objective_params, difficulty, reward_config, weight) VALUES
('catch', 'quest.catch_water.title', 'quest.catch_water.desc', 'catch_pokemon', '{"type": "water", "count": 5}', 'easy', '{"items": [{"type": "poke_ball", "count": 10}], "stardust": 500, "xp": 200}', 100),
('catch', 'quest.catch_rare.title', 'quest.catch_rare.desc', 'catch_pokemon', '{"rarity": "rare", "count": 3}', 'hard', '{"items": [{"type": "ultra_ball", "count": 5}, {"type": "rare_candy", "count": 1}], "stardust": 1000, "xp": 500}', 50),
('battle', 'quest.gym_battle.title', 'quest.gym_battle.desc', 'win_gym_battle', '{"count": 3}', 'medium', '{"items": [{"type": "revive", "count": 3}, {"type": "potion", "count": 5}], "stardust": 800, "xp": 400}', 80),
('social', 'quest.trade.title', 'quest.trade.desc', 'trade_pokemon', '{"count": 1}', 'easy', '{"items": [{"type": "poke_ball", "count": 5}], "stardust": 300, "xp": 150}', 100),
('explore', 'quest.pokestop.title', 'quest.pokestop.desc', 'visit_pokestop', '{"count": 3}', 'easy', '{"items": [{"type": "poke_ball", "count": 8}], "stardust": 400, "xp": 200}', 100),
('evolve', 'quest.evolve.title', 'quest.evolve.desc', 'evolve_pokemon', '{"count": 2}', 'medium', '{"items": [{"type": "razz_berry", "count": 3}], "stardust": 600, "xp": 300}', 90),
('breed', 'quest.hatch.title', 'quest.hatch.desc', 'hatch_egg', '{"count": 1}', 'hard', '{"items": [{"type": "incubator", "count": 1}, {"type": "rare_candy", "count": 3}], "stardust": 1500, "xp": 800}', 40),
('special', 'quest.weather.title', 'quest.weather.desc', 'catch_pokemon', '{"weather": "rain", "count": 3}', 'medium', '{"items": [{"type": "golden_razz_berry", "count": 1}], "stardust": 700, "xp": 350}', 60);
```

### 2. 后端服务实现

```javascript
// backend/services/reward-service/src/questService.js

const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { logger, metrics } = require('../shared');

class QuestService {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.redis = new Redis(process.env.REDIS_URL);
    this.questPools = {
      daily: { count: 3, refreshHour: 0 }, // 每日 0 点刷新
      weekly: { count: 5, refreshDay: 1 },  // 每周一刷新
    };
  }

  /**
   * 为用户生成每日任务
   */
  async generateDailyQuests(userId) {
    const client = await this.db.connect();
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
        return existing.rows;
      }

      // 加权随机抽取任务
      const quests = await client.query(
        `SELECT * FROM quest_definitions 
         WHERE is_active = true 
         ORDER BY -LOG(RANDOM()) / weight 
         LIMIT 3`
      );

      const assignedQuests = [];
      for (const quest of quests.rows) {
        const expiresAt = new Date();
        expiresAt.setHours(23, 59, 59, 999);

        const result = await client.query(
          `INSERT INTO player_quests 
           (user_id, quest_definition_id, quest_pool, progress_target, expires_at)
           VALUES ($1, $2, 'daily', $3, $4)
           RETURNING *`,
          [userId, quest.id, quest.objective_params.count || 1, expiresAt]
        );

        assignedQuests.push({
          ...result.rows[0],
          definition: quest,
        });
      }

      await client.query('COMMIT');
      
      // 缓存任务列表
      await this.cacheUserQuests(userId, assignedQuests);
      
      metrics.questGenerated.inc({ type: 'daily' });
      logger.info('Daily quests generated', { userId, count: assignedQuests.length });

      return assignedQuests;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取用户当前任务
   */
  async getUserQuests(userId) {
    // 先查缓存
    const cached = await this.redis.get(`quests:${userId}`);
    if (cached) {
      return JSON.parse(cached);
    }

    const result = await this.db.query(
      `SELECT pq.*, qd.* 
       FROM player_quests pq
       JOIN quest_definitions qd ON pq.quest_definition_id = qd.id
       WHERE pq.user_id = $1 
       AND pq.status IN ('in_progress', 'completed')
       AND pq.expires_at > NOW()
       ORDER BY pq.assigned_at DESC`,
      [userId]
    );

    await this.cacheUserQuests(userId, result.rows);
    return result.rows;
  }

  /**
   * 更新任务进度
   */
  async updateProgress(userId, objectiveType, params = {}) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // 查找匹配的进行中任务
      const quests = await client.query(
        `SELECT pq.*, qd.objective_type, qd.objective_params
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
          metrics.questCompleted.inc({ type: quest.quest_pool });
          
          // 发布任务完成事件
          await this.publishQuestCompletedEvent(userId, quest);
        }
      }

      await client.query('COMMIT');

      // 更新缓存
      if (updatedQuests.length > 0) {
        await this.invalidateUserQuestsCache(userId);
      }

      return updatedQuests;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 领取任务奖励
   */
  async claimRewards(userId, questId) {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      // 获取任务信息
      const quest = await client.query(
        `SELECT pq.*, qd.reward_config, qd.title_i18n_key
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
      const streak = await this.updateStreak(userId);
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

      await this.invalidateUserQuestsCache(userId);

      logger.info('Quest rewards claimed', { userId, questId, rewards, multiplier });

      return { rewards, multiplier, streak: streak.current_streak };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 更新连击记录
   */
  async updateStreak(userId) {
    const client = await this.db.connect();
    try {
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
        return { current_streak: 1, multiplier: 1.2 };
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

      return { current_streak: newStreak, multiplier };
    } finally {
      client.release();
    }
  }

  /**
   * 计算连击倍率
   */
  calculateMultiplier(streak) {
    const multipliers = [1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.5];
    return multipliers[Math.min(streak - 1, multipliers.length - 1)];
  }

  /**
   * 发放奖励
   */
  async grantRewards(userId, rewardConfig, multiplier) {
    const rewards = {
      items: [],
      stardust: 0,
      xp: 0,
    };

    // 发放道具
    if (rewardConfig.items) {
      for (const item of rewardConfig.items) {
        const count = Math.ceil(item.count * multiplier);
        // 调用 inventory service 添加道具
        await this.addInventoryItem(userId, item.type, count);
        rewards.items.push({ type: item.type, count });
      }
    }

    // 发放星尘
    if (rewardConfig.stardust) {
      rewards.stardust = Math.ceil(rewardConfig.stardust * multiplier);
      await this.addStardust(userId, rewards.stardust);
    }

    // 发放经验
    if (rewardConfig.xp) {
      rewards.xp = Math.ceil(rewardConfig.xp * multiplier);
      await this.addExperience(userId, rewards.xp);
    }

    return rewards;
  }

  /**
   * 验证参数匹配
   */
  matchesObjectiveParams(objectiveParams, actualParams) {
    if (!objectiveParams || Object.keys(objectiveParams).length === 0) {
      return true;
    }

    for (const [key, value] of Object.entries(objectiveParams)) {
      if (key === 'count') continue;
      if (actualParams[key] !== value) {
        return false;
      }
    }

    return true;
  }

  /**
   * 缓存用户任务
   */
  async cacheUserQuests(userId, quests) {
    await this.redis.setex(
      `quests:${userId}`,
      300, // 5 分钟
      JSON.stringify(quests)
    );
  }

  /**
   * 清除缓存
   */
  async invalidateUserQuestsCache(userId) {
    await this.redis.del(`quests:${userId}`);
  }
}

module.exports = new QuestService();
```

### 3. API 路由设计

```javascript
// backend/services/reward-service/src/routes/quests.js

const express = require('express');
const router = express.Router();
const questService = require('../questService');
const { authenticate } = require('../../../shared/authMiddleware');
const Joi = require('joi');

/**
 * GET /api/quests
 * 获取当前任务列表
 */
router.get('/', authenticate, async (req, res) => {
  try {
    let quests = await questService.getUserQuests(req.user.id);
    
    // 如果没有任务，生成每日任务
    if (quests.length === 0) {
      quests = await questService.generateDailyQuests(req.user.id);
    }

    res.json({
      success: true,
      data: quests,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/quests/generate
 * 手动生成每日任务（开发/测试用）
 */
router.post('/generate', authenticate, async (req, res) => {
  try {
    const quests = await questService.generateDailyQuests(req.user.id);
    res.json({
      success: true,
      data: quests,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/quests/:questId/claim
 * 领取任务奖励
 */
router.post('/:questId/claim', authenticate, async (req, res) => {
  try {
    const result = await questService.claimRewards(req.user.id, req.params.questId);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/quests/streak
 * 获取连击信息
 */
router.get('/streak', authenticate, async (req, res) => {
  try {
    const result = await questService.db.query(
      `SELECT * FROM player_quest_streaks WHERE user_id = $1`,
      [req.user.id]
    );

    res.json({
      success: true,
      data: result.rows[0] || { current_streak: 0, multiplier: 1.0 },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/quests/progress
 * 内部接口：更新任务进度
 */
router.post('/progress', async (req, res) => {
  try {
    const schema = Joi.object({
      userId: Joi.string().uuid().required(),
      objectiveType: Joi.string().required(),
      params: Joi.object().default({}),
    });

    const { userId, objectiveType, params } = await schema.validateAsync(req.body);
    
    const updatedQuests = await questService.updateProgress(userId, objectiveType, params);
    
    res.json({
      success: true,
      data: updatedQuests,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
```

### 4. 前端组件

```javascript
// frontend/game-client/src/components/QuestPanel.js

import React, { useState, useEffect } from 'react';
import { useGameStore } from '../game/GameStore';
import './QuestPanel.css';

export function QuestPanel() {
  const { user } = useGameStore();
  const [quests, setQuests] = useState([]);
  const [streak, setStreak] = useState({ current_streak: 0, multiplier: 1.0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadQuests();
  }, []);

  const loadQuests = async () => {
    try {
      const response = await fetch('/api/quests', {
        headers: { 'Authorization': `Bearer ${user.token}` },
      });
      const data = await response.json();
      setQuests(data.data);
    } catch (error) {
      console.error('Failed to load quests:', error);
    } finally {
      setLoading(false);
    }
  };

  const claimReward = async (questId) => {
    try {
      const response = await fetch(`/api/quests/${questId}/claim`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${user.token}` },
      });
      const data = await response.json();
      
      if (data.success) {
        // 显示奖励动画
        showRewardAnimation(data.data);
        loadQuests();
      }
    } catch (error) {
      console.error('Failed to claim reward:', error);
    }
  };

  const showRewardAnimation = (rewards) => {
    // 实现奖励动画逻辑
    console.log('Rewards claimed:', rewards);
  };

  if (loading) {
    return <div className="quest-panel loading">Loading...</div>;
  }

  return (
    <div className="quest-panel">
      <div className="quest-header">
        <h2>Daily Quests</h2>
        <div className="streak-info">
          <span className="streak-count">🔥 {streak.current_streak} Day Streak</span>
          <span className="streak-multiplier">{streak.multiplier}x Multiplier</span>
        </div>
      </div>

      <div className="quest-list">
        {quests.map((quest) => (
          <div key={quest.id} className={`quest-card ${quest.status}`}>
            <div className="quest-icon">
              {getQuestIcon(quest.quest_type)}
            </div>
            
            <div className="quest-content">
              <h3>{quest.title_i18n_key}</h3>
              <p>{quest.description_i18n_key}</p>
              
              <div className="quest-progress">
                <div className="progress-bar">
                  <div 
                    className="progress-fill"
                    style={{ width: `${(quest.progress_current / quest.progress_target) * 100}%` }}
                  />
                </div>
                <span className="progress-text">
                  {quest.progress_current} / {quest.progress_target}
                </span>
              </div>

              <div className="quest-rewards">
                {quest.reward_config.items?.map((item, i) => (
                  <span key={i} className="reward-item">
                    {item.type} x{item.count}
                  </span>
                ))}
                {quest.reward_config.stardust > 0 && (
                  <span className="reward-item">⭐ {quest.reward_config.stardust}</span>
                )}
              </div>
            </div>

            {quest.status === 'completed' && (
              <button 
                className="claim-button"
                onClick={() => claimReward(quest.id)}
              >
                Claim!
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function getQuestIcon(type) {
  const icons = {
    catch: '🎯',
    battle: '⚔️',
    social: '🤝',
    explore: '🗺️',
    evolve: '✨',
    breed: '🥚',
    special: '🌟',
  };
  return icons[type] || '📋';
}
```

### 5. 事件集成

```javascript
// backend/services/catch-service/src/handlers/questEventHandler.js

const kafka = require('kafka-node');
const Producer = kafka.Producer;

const producer = new Producer(new kafka.KafkaClient({
  kafkaHost: process.env.KAFKA_BROKERS,
}));

/**
 * 精灵捕捉成功后触发任务进度更新
 */
async function onPokemonCaught(userId, pokemon) {
  const event = {
    type: 'quest_progress',
    userId,
    objectiveType: 'catch_pokemon',
    params: {
      type: pokemon.types[0],
      rarity: pokemon.rarity,
      weather: pokemon.weather,
    },
    timestamp: Date.now(),
  };

  await sendToKafka('quest-events', event);
}

/**
 * 发送到 Kafka
 */
function sendToKafka(topic, message) {
  return new Promise((resolve, reject) => {
    producer.send(
      [{ topic, messages: JSON.stringify(message) }],
      (err, data) => {
        if (err) reject(err);
        else resolve(data);
      }
    );
  });
}

module.exports = { onPokemonCaught };
```

### 6. Prometheus 指标

```javascript
// backend/shared/questMetrics.js

const client = require('prom-client');

module.exports = {
  questGenerated: new client.Counter({
    name: 'quest_generated_total',
    help: 'Total number of quests generated',
    labelNames: ['type'],
  }),

  questCompleted: new client.Counter({
    name: 'quest_completed_total',
    help: 'Total number of quests completed',
    labelNames: ['type', 'difficulty'],
  }),

  questClaimed: new client.Counter({
    name: 'quest_claimed_total',
    help: 'Total number of quest rewards claimed',
    labelNames: ['type'],
  }),

  questProgressLatency: new client.Histogram({
    name: 'quest_progress_update_latency_seconds',
    help: 'Quest progress update latency',
    buckets: [0.01, 0.05, 0.1, 0.5, 1.0],
  }),

  activeStreakGauge: new client.Gauge({
    name: 'quest_active_streak',
    help: 'Current active streak count',
  }),
};
```

## 验收标准

- [ ] 每日任务自动生成功能正常，每日 0 点刷新
- [ ] 任务类型覆盖捕捉、战斗、社交、探索、进化、培育、特殊 7 类
- [ ] 任务进度实时追踪，捕捉/战斗/交易等行为触发进度更新
- [ ] 任务完成状态正确识别，进度条 UI 显示准确
- [ ] 奖励领取功能正常，道具/星尘/经验正确发放
- [ ] 连击系统正常工作，连续完成天数正确计算
- [ ] 连击倍率正确应用，奖励金额按倍率增加
- [ ] 断签后连击正确重置
- [ ] 任务过期后自动清理
- [ ] 前端任务面板 UI 完整，显示任务列表/进度/奖励
- [ ] 单元测试覆盖率 > 80%
- [ ] API 压力测试：支持 1000 req/s
- [ ] Prometheus 指标正常暴露

## 影响范围

### 新增文件
- `database/pending/20260610_170000__add_daily_quest_system.sql`
- `backend/services/reward-service/src/questService.js`
- `backend/services/reward-service/src/routes/quests.js`
- `backend/services/reward-service/src/handlers/questEventHandler.js`
- `backend/shared/questMetrics.js`
- `frontend/game-client/src/components/QuestPanel.js`
- `frontend/game-client/src/components/QuestPanel.css`

### 修改文件
- `backend/services/reward-service/src/index.js` - 注册任务路由
- `backend/services/catch-service/src/handlers/catchHandler.js` - 集成任务进度事件
- `backend/services/gym-service/src/handlers/battleHandler.js` - 集成任务进度事件
- `backend/services/social-service/src/routes/trade.js` - 集成任务进度事件
- `backend/shared/metrics.js` - 注册任务相关指标

## 参考

- Pokémon GO Daily Task System Design
- Ingress Mission System
- 游戏任务系统设计最佳实践
