# REQ-00076: 精灵成就系统与里程碑奖励

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00076 |
| 标题 | 精灵成就系统与里程碑奖励 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | implemented |
| 涉及服务 | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-10 02:15 |

## 需求描述

为 mineGo 游戏引入完整的精灵成就系统（Achievement System），玩家通过完成特定挑战和里程碑获得成就徽章与奖励。该系统需要支持：

1. **多维度成就定义**：捕捉、培育、战斗、社交、探索等 5 大类成就
2. **里程碑奖励机制**：达成成就后自动发放奖励（道具、金币、称号、专属精灵）
3. **成就进度追踪**：实时展示成就完成进度，支持进度条和计数器
4. **隐藏成就系统**：部分成就需特定条件触发，增加游戏探索乐趣
5. **成就展示系统**：玩家可展示已获成就，社交分享功能
6. **成就排行榜**：全服成就点数排名

## 技术方案

### 1. 数据库设计

```sql
-- 成就定义表
CREATE TABLE achievements (
    id SERIAL PRIMARY KEY,
    achievement_id VARCHAR(50) UNIQUE NOT NULL, -- 'catch_master_100'
    category VARCHAR(30) NOT NULL, -- 'catch', 'breed', 'battle', 'social', 'explore'
    name JSONB NOT NULL, -- {"zh": "捕捉大师", "en": "Catch Master"}
    description JSONB NOT NULL,
    icon_url VARCHAR(500),
    rarity VARCHAR(20) NOT NULL, -- 'common', 'rare', 'epic', 'legendary'
    points INTEGER NOT NULL DEFAULT 10,
    is_hidden BOOLEAN DEFAULT FALSE,
    trigger_conditions JSONB NOT NULL, -- {"type": "catch_count", "target": 100, "filters": {...}}
    rewards JSONB NOT NULL, -- {"coins": 1000, "items": [...], "title": "catcher_100"}
    prerequisite_achievement_id VARCHAR(50), -- 前置成就
    created_at TIMESTAMP DEFAULT NOW()
);

-- 用户成就表
CREATE TABLE user_achievements (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    achievement_id VARCHAR(50) NOT NULL,
    progress INTEGER DEFAULT 0, -- 当前进度值
    target INTEGER NOT NULL, -- 目标值
    completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP,
    rewards_claimed BOOLEAN DEFAULT FALSE,
    rewards_claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, achievement_id)
);

-- 成就进度快照（用于快速查询）
CREATE TABLE achievement_progress_snapshots (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) UNIQUE NOT NULL,
    category_progress JSONB NOT NULL, -- {"catch": 450, "battle": 120, ...}
    total_points INTEGER DEFAULT 0,
    achievements_completed INTEGER DEFAULT 0,
    last_updated TIMESTAMP DEFAULT NOW()
);

-- 成就触发事件日志
CREATE TABLE achievement_events (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    event_type VARCHAR(50) NOT NULL, -- 'catch', 'battle_win', 'trade', ...
    event_data JSONB,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 称号表
CREATE TABLE user_titles (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL,
    title_id VARCHAR(50) NOT NULL,
    source_achievement_id VARCHAR(50),
    is_active BOOLEAN DEFAULT FALSE,
    unlocked_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, title_id)
);

-- 索引
CREATE INDEX idx_user_achievements_user ON user_achievements(user_id);
CREATE INDEX idx_user_achievements_completed ON user_achievements(completed) WHERE completed = TRUE;
CREATE INDEX idx_achievement_progress_user ON achievement_progress_snapshots(user_id);
CREATE INDEX idx_achievement_events_user ON achievement_events(user_id, processed);
CREATE INDEX idx_achievements_category ON achievements(category);
CREATE INDEX idx_achievements_hidden ON achievements(is_hidden);
```

### 2. 成就服务核心模块

```javascript
// backend/services/pokemon-service/src/achievementService.js

const { db } = require('../../shared/db');
const { EventBus, EVENTS } = require('../../shared/EventBus');
const { metrics } = require('../../shared/metrics');

class AchievementService {
  constructor() {
    this.achievementDefinitions = new Map();
    this.eventHandlers = new Map();
    this.loadDefinitions();
  }

  // 加载成就定义到内存
  async loadDefinitions() {
    const achievements = await db('achievements').select('*');
    for (const ach of achievements) {
      this.achievementDefinitions.set(ach.achievement_id, ach);
    }
  }

  // 处理成就触发事件
  async processEvent(userId, eventType, eventData) {
    const startTime = Date.now();
    
    try {
      // 记录事件
      await db('achievement_events').insert({
        user_id: userId,
        event_type: eventType,
        event_data: eventData,
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

      // 发布成就完成事件
      if (results.length > 0) {
        await EventBus.publish(EVENTS.ACHIEVEMENT_COMPLETED, {
          userId,
          achievements: results
        });
      }

      metrics.histogram('achievement_process_duration', Date.now() - startTime);
      metrics.increment('achievement_events_processed');

      return results;
    } catch (error) {
      metrics.increment('achievement_process_errors');
      throw error;
    }
  }

  // 获取相关成就
  async getRelevantAchievements(userId, eventType) {
    const query = db('achievements')
      .whereRaw("trigger_conditions->>'type' = ?", [eventType])
      .whereNotExists(function() {
        this.select('*')
          .from('user_achievements')
          .whereRaw('user_achievements.user_id = ?', [userId])
          .whereRaw('user_achievements.achievement_id = achievements.achievement_id')
          .where('completed', true);
      });

    return await query;
  }

  // 更新成就进度
  async updateProgress(userId, achievement, eventData) {
    const { achievement_id, trigger_conditions, target } = achievement;
    
    // 获取或创建用户成就记录
    let userAch = await db('user_achievements')
      .where({ user_id: userId, achievement_id })
      .first();

    if (!userAch) {
      const targetValue = this.calculateTarget(trigger_conditions);
      await db('user_achievements').insert({
        user_id: userId,
        achievement_id,
        target: targetValue,
        progress: 0
      });
      userAch = { progress: 0, target: targetValue };
    }

    // 计算新进度
    const progressIncrement = this.calculateProgress(trigger_conditions, eventData);
    const newProgress = Math.min(userAch.progress + progressIncrement, userAch.target);
    
    const isCompleted = newProgress >= userAch.target;

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
    await this.updateSnapshot(userId, achievement.points, isCompleted);

    if (isCompleted && !userAch.completed) {
      metrics.increment('achievements_unlocked', { category: achievement.category });
      
      return {
        achievement_id,
        name: achievement.name,
        points: achievement.points,
        rewards: achievement.rewards,
        completed: true
      };
    }

    return { achievement_id, progress: newProgress, target: userAch.target, completed: false };
  }

  // 计算进度增量
  calculateProgress(conditions, eventData) {
    switch (conditions.type) {
      case 'catch_count':
        return eventData.count || 1;
      case 'catch_species':
        return eventData.is_new_species ? 1 : 0;
      case 'battle_win':
        return eventData.win ? 1 : 0;
      case 'trade_count':
        return 1;
      case 'gym_conquer':
        return 1;
      case 'distance_traveled':
        return eventData.distance || 0;
      case 'pokemon_breed':
        return 1;
      default:
        return 1;
    }
  }

  // 计算目标值
  calculateTarget(conditions) {
    return conditions.target || 1;
  }

  // 更新进度快照
  async updateSnapshot(userId, points, isCompleted) {
    await db('achievement_progress_snapshots')
      .insert({
        user_id: userId,
        category_progress: {},
        total_points: points,
        achievements_completed: isCompleted ? 1 : 0
      })
      .onConflict('user_id')
      .merge({
        total_points: db.raw('total_points + ?', [points]),
        achievements_completed: db.raw('achievements_completed + ?', [isCompleted ? 1 : 0]),
        last_updated: db.fn.now()
      });
  }

  // 领取奖励
  async claimRewards(userId, achievementId) {
    const userAch = await db('user_achievements')
      .where({ user_id: userId, achievement_id: achievementId })
      .first();

    if (!userAch || !userAch.completed) {
      throw new Error('Achievement not completed');
    }

    if (userAch.rewards_claimed) {
      throw new Error('Rewards already claimed');
    }

    const achievement = this.achievementDefinitions.get(achievementId);
    const rewards = achievement.rewards;

    // 发放奖励
    await this.grantRewards(userId, rewards);

    // 标记已领取
    await db('user_achievements')
      .where({ user_id: userId, achievement_id: achievementId })
      .update({
        rewards_claimed: true,
        rewards_claimed_at: db.fn.now()
      });

    // 如果有称号，解锁称号
    if (rewards.title) {
      await db('user_titles').insert({
        user_id: userId,
        title_id: rewards.title,
        source_achievement_id: achievementId
      }).onConflict(['user_id', 'title_id']).ignore();
    }

    metrics.increment('achievement_rewards_claimed');

    return rewards;
  }

  // 发放奖励
  async grantRewards(userId, rewards) {
    // 调用奖励服务
    await EventBus.publish(EVENTS.REWARD_GRANT, {
      userId,
      rewards,
      source: 'achievement'
    });
  }

  // 获取用户成就列表
  async getUserAchievements(userId, options = {}) {
    const { category, includeHidden = false, includeCompleted = true } = options;

    let query = db('achievements')
      .leftJoin('user_achievements', function() {
        this.on('achievements.achievement_id', '=', 'user_achievements.achievement_id')
            .andOn('user_achievements.user_id', '=', db.raw('?', [userId]));
      })
      .select(
        'achievements.*',
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

    return await query.orderBy('achievements.points', 'desc');
  }

  // 获取成就排行榜
  async getLeaderboard(limit = 100, offset = 0) {
    return await db('achievement_progress_snapshots')
      .join('users', 'achievement_progress_snapshots.user_id', 'users.id')
      .select(
        'users.id',
        'users.username',
        'users.avatar_url',
        'achievement_progress_snapshots.total_points',
        'achievement_progress_snapshots.achievements_completed'
      )
      .orderBy('total_points', 'desc')
      .limit(limit)
      .offset(offset);
  }
}

module.exports = new AchievementService();
```

### 3. 成就触发器集成

```javascript
// backend/shared/achievementTriggers.js

const achievementService = require('../services/pokemon-service/src/achievementService');

// 定义成就触发器映射
const ACHIEVEMENT_TRIGGERS = {
  // 捕捉类成就
  'pokemon.caught': {
    eventType: 'catch_count',
    extractData: (event) => ({
      count: 1,
      pokemon_id: event.pokemonId,
      species_id: event.speciesId,
      is_new_species: event.isNewSpecies,
      is_shiny: event.isShiny,
      rarity: event.rarity
    })
  },
  
  // 战斗类成就
  'battle.won': {
    eventType: 'battle_win',
    extractData: (event) => ({
      win: true,
      battle_type: event.battleType, // 'gym', 'pvp', 'raid'
      opponent_level: event.opponentLevel
    })
  },
  
  'gym.conquered': {
    eventType: 'gym_conquer',
    extractData: (event) => ({
      gym_id: event.gymId,
      gym_level: event.gymLevel
    })
  },
  
  // 社交类成就
  'trade.completed': {
    eventType: 'trade_count',
    extractData: (event) => ({
      trade_id: event.tradeId,
      partner_id: event.partnerId
    })
  },
  
  'friend.added': {
    eventType: 'friend_count',
    extractData: (event) => ({ count: 1 })
  },
  
  // 培育类成就
  'pokemon.bred': {
    eventType: 'pokemon_breed',
    extractData: (event) => ({
      species_id: event.speciesId,
      is_shiny: event.isShiny
    })
  },
  
  'egg.hatched': {
    eventType: 'egg_hatch',
    extractData: (event) => ({
      species_id: event.speciesId,
      distance: event.eggDistance
    })
  },
  
  // 探索类成就
  'location.distance': {
    eventType: 'distance_traveled',
    extractData: (event) => ({
      distance: event.distanceKm
    })
  },
  
  'pokestop.visited': {
    eventType: 'pokestop_visit',
    extractData: (event) => ({ count: 1 })
  }
};

// 初始化事件订阅
function initAchievementTriggers() {
  const { EventBus, EVENTS } = require('./EventBus');
  
  // 订阅所有相关事件
  Object.keys(ACHIEVEMENT_TRIGGERS).forEach(eventName => {
    EventBus.subscribe(eventName, async (event) => {
      const trigger = ACHIEVEMENT_TRIGGERS[eventName];
      const eventData = trigger.extractData(event);
      
      await achievementService.processEvent(
        event.userId,
        trigger.eventType,
        eventData
      );
    });
  });
}

module.exports = { initAchievementTriggers, ACHIEVEMENT_TRIGGERS };
```

### 4. API 路由

```javascript
// backend/services/pokemon-service/src/routes/achievements.js

const express = require('express');
const router = express.Router();
const achievementService = require('../achievementService');
const { authenticate } = require('../../shared/middleware/auth');
const { rateLimiter } = require('../../shared/middleware/rateLimiter');

// 获取用户成就列表
router.get('/my', authenticate, rateLimiter(100, 60), async (req, res) => {
  try {
    const { category, include_hidden, include_completed } = req.query;
    
    const achievements = await achievementService.getUserAchievements(req.user.id, {
      category,
      includeHidden: include_hidden === 'true',
      includeCompleted: include_completed !== 'false'
    });
    
    res.json({
      success: true,
      data: achievements
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取成就详情
router.get('/:achievementId', authenticate, async (req, res) => {
  try {
    const userAchievement = await achievementService.getUserAchievements(req.user.id);
    const achievement = userAchievement.find(a => a.achievement_id === req.params.achievementId);
    
    if (!achievement) {
      return res.status(404).json({ success: false, error: 'Achievement not found' });
    }
    
    res.json({ success: true, data: achievement });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 领取成就奖励
router.post('/:achievementId/claim', authenticate, rateLimiter(10, 60), async (req, res) => {
  try {
    const rewards = await achievementService.claimRewards(req.user.id, req.params.achievementId);
    
    res.json({
      success: true,
      data: { rewards }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// 获取成就排行榜
router.get('/leaderboard/global', rateLimiter(50, 60), async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    
    const leaderboard = await achievementService.getLeaderboard(
      parseInt(limit),
      parseInt(offset)
    );
    
    res.json({
      success: true,
      data: leaderboard
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取成就进度概览
router.get('/my/progress', authenticate, async (req, res) => {
  try {
    const snapshot = await db('achievement_progress_snapshots')
      .where({ user_id: req.user.id })
      .first();
    
    if (!snapshot) {
      return res.json({
        success: true,
        data: {
          total_points: 0,
          achievements_completed: 0,
          category_progress: {}
        }
      });
    }
    
    res.json({ success: true, data: snapshot });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 设置激活称号
router.post('/titles/:titleId/activate', authenticate, async (req, res) => {
  try {
    // 先取消所有激活称号
    await db('user_titles')
      .where({ user_id: req.user.id })
      .update({ is_active: false });
    
    // 激活指定称号
    await db('user_titles')
      .where({ user_id: req.user.id, title_id: req.params.titleId })
      .update({ is_active: true });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 5. 前端组件

```javascript
// frontend/game-client/src/components/AchievementPanel.js

import React, { useState, useEffect } from 'react';
import './AchievementPanel.css';

const AchievementPanel = ({ userId }) => {
  const [achievements, setAchievements] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [progress, setProgress] = useState({});

  const categories = [
    { id: 'all', name: '全部', icon: '🏆' },
    { id: 'catch', name: '捕捉', icon: '🎯' },
    { id: 'battle', name: '战斗', icon: '⚔️' },
    { id: 'breed', name: '培育', icon: '🥚' },
    { id: 'social', name: '社交', icon: '👥' },
    { id: 'explore', name: '探索', icon: '🗺️' }
  ];

  const rarityColors = {
    common: '#9e9e9e',
    rare: '#2196f3',
    epic: '#9c27b0',
    legendary: '#ff9800'
  };

  useEffect(() => {
    loadAchievements();
    loadProgress();
  }, [selectedCategory]);

  const loadAchievements = async () => {
    const params = new URLSearchParams();
    if (selectedCategory !== 'all') {
      params.append('category', selectedCategory);
    }
    
    const response = await fetch(`/api/achievements/my?${params}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    
    const data = await response.json();
    if (data.success) {
      setAchievements(data.data);
    }
  };

  const loadProgress = async () => {
    const response = await fetch('/api/achievements/my/progress', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    
    const data = await response.json();
    if (data.success) {
      setProgress(data.data);
    }
  };

  const claimReward = async (achievementId) => {
    try {
      const response = await fetch(`/api/achievements/${achievementId}/claim`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      
      const data = await response.json();
      if (data.success) {
        alert(`奖励已领取！\n${JSON.stringify(data.data.rewards, null, 2)}`);
        loadAchievements();
      }
    } catch (error) {
      console.error('Failed to claim reward:', error);
    }
  };

  const renderProgressBar = (current, target) => {
    const percentage = Math.min((current / target) * 100, 100);
    return (
      <div className="progress-bar">
        <div 
          className="progress-fill" 
          style={{ width: `${percentage}%` }}
        />
        <span className="progress-text">{current} / {target}</span>
      </div>
    );
  };

  return (
    <div className="achievement-panel">
      <div className="achievement-header">
        <h2>成就系统</h2>
        <div className="progress-summary">
          <div className="total-points">
            <span className="points-label">成就点数</span>
            <span className="points-value">{progress.total_points || 0}</span>
          </div>
          <div className="completed-count">
            <span className="count-label">已完成</span>
            <span className="count-value">{progress.achievements_completed || 0}</span>
          </div>
        </div>
      </div>

      <div className="category-tabs">
        {categories.map(cat => (
          <button
            key={cat.id}
            className={`category-tab ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id)}
          >
            <span className="category-icon">{cat.icon}</span>
            <span className="category-name">{cat.name}</span>
          </button>
        ))}
      </div>

      <div className="achievements-grid">
        {achievements.map(ach => (
          <div 
            key={ach.achievement_id}
            className={`achievement-card ${ach.completed ? 'completed' : ''} ${ach.is_hidden ? 'hidden' : ''}`}
          >
            <div 
              className="achievement-icon"
              style={{ borderColor: rarityColors[ach.rarity] }}
            >
              <img src={ach.icon_url} alt={ach.name.zh} />
              {ach.completed && <div className="completed-badge">✓</div>}
            </div>
            
            <div className="achievement-info">
              <h3 className="achievement-name">{ach.name.zh}</h3>
              <p className="achievement-desc">{ach.description.zh}</p>
              
              {!ach.completed && ach.progress !== null && (
                renderProgressBar(ach.progress, ach.target)
              )}
              
              <div className="achievement-meta">
                <span className="achievement-points">{ach.points} 点</span>
                <span className="achievement-rarity">{ach.rarity}</span>
              </div>
            </div>

            {ach.completed && !ach.rewards_claimed && (
              <button 
                className="claim-button"
                onClick={() => claimReward(ach.achievement_id)}
              >
                领取奖励
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default AchievementPanel;
```

### 6. 成就定义种子数据

```javascript
// database/seeds/achievements.js

module.exports = [
  // 捕捉类成就
  {
    achievement_id: 'first_catch',
    category: 'catch',
    name: { zh: '初次捕捉', en: 'First Catch' },
    description: { zh: '捕捉你的第一只精灵', en: 'Catch your first Pokémon' },
    rarity: 'common',
    points: 10,
    is_hidden: false,
    trigger_conditions: { type: 'catch_count', target: 1 },
    rewards: { coins: 100, items: [{ item_id: 'pokeball', count: 10 }] }
  },
  {
    achievement_id: 'catch_master_100',
    category: 'catch',
    name: { zh: '捕捉新手', en: 'Novice Catcher' },
    description: { zh: '捕捉 100 只精灵', en: 'Catch 100 Pokémon' },
    rarity: 'common',
    points: 50,
    is_hidden: false,
    trigger_conditions: { type: 'catch_count', target: 100 },
    rewards: { coins: 1000, title: 'catcher_100' },
    prerequisite_achievement_id: 'first_catch'
  },
  {
    achievement_id: 'catch_master_1000',
    category: 'catch',
    name: { zh: '捕捉大师', en: 'Catch Master' },
    description: { zh: '捕捉 1000 只精灵', en: 'Catch 1000 Pokémon' },
    rarity: 'epic',
    points: 200,
    is_hidden: false,
    trigger_conditions: { type: 'catch_count', target: 1000 },
    rewards: { coins: 10000, items: [{ item_id: 'lucky_egg', count: 5 }], title: 'catcher_1000' },
    prerequisite_achievement_id: 'catch_master_100'
  },
  {
    achievement_id: 'shiny_hunter',
    category: 'catch',
    name: { zh: '闪光猎人', en: 'Shiny Hunter' },
    description: { zh: '捕捉第一只闪光精灵', en: 'Catch your first shiny Pokémon' },
    rarity: 'rare',
    points: 100,
    is_hidden: false,
    trigger_conditions: { type: 'shiny_catch', target: 1, filters: { is_shiny: true } },
    rewards: { coins: 5000, title: 'shiny_hunter' }
  },
  {
    achievement_id: 'pokedex_151',
    category: 'catch',
    name: { zh: '图鉴收藏家', en: 'Pokédex Collector' },
    description: { zh: '收集 151 种精灵', en: 'Collect 151 Pokémon species' },
    rarity: 'legendary',
    points: 500,
    is_hidden: false,
    trigger_conditions: { type: 'catch_species', target: 151 },
    rewards: { coins: 50000, items: [{ item_id: 'master_ball', count: 1 }], title: 'pokedex_master' }
  },
  
  // 战斗类成就
  {
    achievement_id: 'first_battle',
    category: 'battle',
    name: { zh: '初次战斗', en: 'First Battle' },
    description: { zh: '赢得第一场战斗', en: 'Win your first battle' },
    rarity: 'common',
    points: 10,
    trigger_conditions: { type: 'battle_win', target: 1 },
    rewards: { coins: 100 }
  },
  {
    achievement_id: 'gym_conqueror_10',
    category: 'battle',
    name: { zh: '道馆挑战者', en: 'Gym Challenger' },
    description: { zh: '攻克 10 座道馆', en: 'Conquer 10 gyms' },
    rarity: 'rare',
    points: 100,
    trigger_conditions: { type: 'gym_conquer', target: 10 },
    rewards: { coins: 5000, items: [{ item_id: 'rare_candy', count: 5 }] }
  },
  {
    achievement_id: 'pvp_master',
    category: 'battle',
    name: { zh: '对战大师', en: 'PvP Master' },
    description: { zh: '赢得 100 场玩家对战', en: 'Win 100 PvP battles' },
    rarity: 'epic',
    points: 200,
    trigger_conditions: { type: 'battle_win', target: 100, filters: { battle_type: 'pvp' } },
    rewards: { coins: 10000, title: 'pvp_master' }
  },
  
  // 培育类成就
  {
    achievement_id: 'first_breed',
    category: 'breed',
    name: { zh: '培育新人', en: 'Novice Breeder' },
    description: { zh: '培育出第一只精灵', en: 'Breed your first Pokémon' },
    rarity: 'common',
    points: 20,
    trigger_conditions: { type: 'pokemon_breed', target: 1 },
    rewards: { coins: 200 }
  },
  {
    achievement_id: 'shiny_breeder',
    category: 'breed',
    name: { zh: '闪光培育师', en: 'Shiny Breeder' },
    description: { zh: '培育出一只闪光精灵', en: 'Breed a shiny Pokémon' },
    rarity: 'epic',
    points: 150,
    trigger_conditions: { type: 'pokemon_breed', target: 1, filters: { is_shiny: true } },
    rewards: { coins: 8000, title: 'shiny_breeder' }
  },
  
  // 社交类成就
  {
    achievement_id: 'first_trade',
    category: 'social',
    name: { zh: '首次交易', en: 'First Trade' },
    description: { zh: '完成第一次精灵交易', en: 'Complete your first trade' },
    rarity: 'common',
    points: 15,
    trigger_conditions: { type: 'trade_count', target: 1 },
    rewards: { coins: 150 }
  },
  {
    achievement_id: 'trade_master_100',
    category: 'social',
    name: { zh: '交易达人', en: 'Trade Master' },
    description: { zh: '完成 100 次交易', en: 'Complete 100 trades' },
    rarity: 'rare',
    points: 100,
    trigger_conditions: { type: 'trade_count', target: 100 },
    rewards: { coins: 5000, title: 'trade_master' }
  },
  
  // 探索类成就
  {
    achievement_id: 'walker_10km',
    category: 'explore',
    name: { zh: '步行者', en: 'Walker' },
    description: { zh: '累计行走 10 公里', en: 'Walk 10 kilometers' },
    rarity: 'common',
    points: 20,
    trigger_conditions: { type: 'distance_traveled', target: 10 },
    rewards: { coins: 300, items: [{ item_id: 'egg_incubator', count: 1 }] }
  },
  {
    achievement_id: 'explorer_1000km',
    category: 'explore',
    name: { zh: '探险家', en: 'Explorer' },
    description: { zh: '累计行走 1000 公里', en: 'Walk 1000 kilometers' },
    rarity: 'legendary',
    points: 300,
    trigger_conditions: { type: 'distance_traveled', target: 1000 },
    rewards: { coins: 20000, items: [{ item_id: 'super_incubator', count: 3 }], title: 'explorer' }
  },
  
  // 隐藏成就
  {
    achievement_id: 'lucky_encounter',
    category: 'catch',
    name: { zh: '幸运邂逅', en: 'Lucky Encounter' },
    description: { zh: '???', en: '???' },
    rarity: 'legendary',
    points: 200,
    is_hidden: true,
    trigger_conditions: { type: 'lucky_catch', target: 1 },
    rewards: { coins: 15000, items: [{ item_id: 'lucky_pendant', count: 1 }] }
  }
];
```

## 验收标准

- [ ] 数据库迁移成功，包含 5 个新表（achievements、user_achievements、achievement_progress_snapshots、achievement_events、user_titles）
- [ ] 成就定义管理功能可用，支持增删改查
- [ ] 成就触发器正确集成到现有事件系统（捕捉、战斗、交易、培育、探索）
- [ ] 用户成就列表 API 正常工作，支持分类过滤和进度查询
- [ ] 成就进度实时更新，进度条显示正确
- [ ] 成就完成时自动触发奖励发放
- [ ] 奖励领取功能正常，防止重复领取
- [ ] 成就排行榜 API 返回正确的排名数据
- [ ] 称号系统可用，支持激活/取消激活
- [ ] 隐藏成就不显示在列表中，直到被解锁
- [ ] 前端成就面板渲染正确，支持分类切换
- [ ] 成就点数和完成数量统计准确
- [ ] 单元测试覆盖核心逻辑（30+ 测试用例）
- [ ] 性能测试：成就查询 < 100ms，进度更新 < 50ms
- [ ] Prometheus 指标正确暴露（成就解锁数、处理延迟等）

## 影响范围

- `database/migrations/` - 新增迁移文件
- `backend/services/pokemon-service/src/achievementService.js` - 核心服务
- `backend/services/pokemon-service/src/routes/achievements.js` - API 路由
- `backend/shared/achievementTriggers.js` - 事件触发器
- `frontend/game-client/src/components/AchievementPanel.js` - 前端组件
- `frontend/game-client/src/components/AchievementPanel.css` - 样式文件
- `database/seeds/achievements.js` - 种子数据
- `backend/tests/unit/achievement.test.js` - 单元测试

## 参考

- [Steam Achievements API](https://partner.steamgames.com/doc/features/achievements)
- [Xbox Live Achievements](https://docs.microsoft.com/en-us/gaming/xbox-live/features/achievements/)
- [Pokemon GO Achievements](https://pokemongohub.net/guide/achievements/)
- 游戏成就系统设计最佳实践

## 实现记录（2026-09-24）

> E05「成就/称号/资料卡/收藏室」与 E13「消息中心与推送」统一实现：REQ-00076 / 00106 / 00327 / 00359 / 00387 / 00403 与 REQ-00099 / 00261 / 00425 共用同一套游戏事件 outbox、成就引擎与消息中心。
> 状态 `implemented`：代码已全部完成，**未做服务级验证**（2026-09-25 18:30 起规则）。此前迁移 `20260925_130000`、`20260925_131000` 曾在隔离 CI 栈（栈 8）的存量库上执行无失败，user-service 启动后事件消费者、消息分发器、WebSocket 均正常监听；之后新增的迁移 `20260925_132000`、`20260925_133000`、全部接口、前端界面只做了静态检查（`node --check`、`scripts/check-deps.js`、宿主机纯逻辑/内存替身单测），**待验证**。

**共用架构**

- 事件来源：业务表上的触发器把"发生了什么"写入 outbox 表 `achievement_events`（与业务同事务，业务回滚事件也不存在；触发器内部异常只 `RAISE WARNING`，不影响业务）并 `pg_notify('pmg_game_events')`。接入的表：`catch_sessions`（捕捉成功）、`pokestop_spins`、`trainer_level_ups`（升级，覆盖所有加经验路径）、`friendships`/`friends`、`friend_requests`、`friend_gifts`、`pokemon_trades`、`gym_battles`、`raid_participants`、`pvp_battles`、`egg_hatching`、`event_participations`；收藏室的展示/装饰/被点赞由 JS 在同事务写事件。
- 消费：`backend/shared/achievementEngine.js`，user-service 启动时 `LISTEN` 实时处理 + 10 秒兜底扫描 + 每小时清理；pokemon-service 查询成就前按需处理该玩家未处理事件。`FOR UPDATE SKIP LOCKED` 保证多消费者不重复处理；每个事件一个 SAVEPOINT，单事件失败不影响其他事件，失败 5 次后放弃并保留 `last_error`。
- 规则：`backend/shared/achievementRules.js`（事件 → 指标、过滤条件、奖励拆分、事件 → 消息、多语言，纯函数）。
- 消息：`backend/shared/notificationCenter.js`（生成/列表/未读/已读/删除/偏好/广播/分析/清理）、`notificationPolicy.js`（分类、偏好、免打扰、投递计划，纯函数）、`notificationRealtime.js`（`/ws/messages` 与 LISTEN 分发）、`pushProviders.js`（FCM/APNs）。
- 迁移：`database/migrations/20260925_130000__e05_achievement_title_core.sql`（成就/称号收敛 + outbox 触发器）、`20260925_131000__e13_notification_center.sql`（消息中心）、`20260925_132000__e05_collection_room.sql`（收藏室）、`20260925_133000__e05_player_profile.sql`（资料卡）。均 `IF NOT EXISTS`/`ON CONFLICT` 幂等，外键均按 `users.id UUID`；依赖的表（`achievements`、`title_definitions`、`trainer_level_ups`、`notification_templates`、E01 的 `privacy_settings`/`blocked_users` 等）都在更早的迁移中创建（已逐条核对）。
- 测试：单测 `cd backend && node --test tests/unit/achievementRules.test.js tests/unit/achievementEngine.test.js tests/unit/notificationPolicy.test.js tests/unit/notificationCenter.test.js tests/unit/profileRules.test.js tests/unit/collectionRoomRules.test.js tests/unit/securityNotifier.test.js`（53 例，已加入 `test:unit`，宿主机已运行通过；引擎与消息中心用 `tests/unit/helpers/fakeGameDb.js` 内存替身，不依赖数据库）；经网关冒烟 `BASE_URL=… node scripts/smoke-profile-notify.js`（约 97 项，**未运行**）；压测 `node scripts/bench-profile-notify.js`（**未运行**）；前端 `cd frontend/game-client && npx playwright test tests/e2e/profile-notify.spec.js`（Mock 接口，**未运行**）。
- 前端：`frontend/game-client/src/features/profileNotify.js` + `src/features/profile-notify/*`（由 `src/bootstrap/features.js` 注册一行）：底部导航「消息」🔔、「我的」页「成长与收藏」卡片（成就、称号、资料卡、我的收藏室、热门收藏室、收藏家排行、消息与通知设置）。

| 验收标准 | 结果 | 说明 |
|---|---|---|
| 数据库迁移成功，包含 5 个新表（achievements、user_achievements、achievement_progress_snapshots、achievement_events、user_titles） | ✅ | 5 张表已由早期迁移创建但互相冲突：V1 的 `user_achievements` 先建表，后续 `CREATE TABLE IF NOT EXISTS` 被跳过，外键仍指向旧表 `achievement_definitions`，新成就根本写不进去。迁移 `20260925_130000` 收敛：`achievements` 为唯一定义表（新增 `is_active`/`display_order`、分类扩展为 8 类），`user_achievements` 外键改指 `achievements(achievement_id)`，旧 V1 计数行按源数据（捕捉/图鉴/闪光/补给站/等级/行走/好友/团战/活动）回填新成就进度后删除；`achievement_events` 改造为 outbox（`processed_at/attempts/last_error/dedupe_key`、待处理部分索引）；快照表加排行索引 |
| 成就定义管理功能可用，支持增删改查 | ✅ | 管理员接口 `GET/POST /v1/achievements/admin/definitions`、`PUT/DELETE /v1/achievements/admin/definitions/:id`（删除 = 下线，保留玩家记录；校验分类/稀有度/触发类型必须是引擎认识的指标/目标值/三语名称），修改后引擎定义缓存立即失效；`POST /v1/achievements/admin/grant` 与 reward-service `POST /v1/rewards/achievements/check`（仅管理员）补发进度 |
| 成就触发器正确集成到现有事件系统（捕捉、战斗、交易、培育、探索） | ✅ | 由数据库触发器接入（见上"共用架构"），不依赖各服务记得调用：捕捉（含闪光/完美个体/新种类/夜间）、补给站（含 7 天连击）、升级、道馆战（胜利=攻克）、PvP 胜利、团战、交易（亮晶晶）、培育出蛋/孵化（完美个体）、好友、送礼、活动参与/完成、收藏室。catch-service / pokemon-service 补给站 / reward-service 中写旧计数 `catch_total`/`pokestop_spins` 的代码已删除。种子 62 个成就（5 大类 + 成长/收藏/活动） |
| 用户成就列表 API 正常工作，支持分类过滤和进度查询 | ✅ | `GET /v1/achievements/my?category=&status=completed|in_progress|claimable|locked`（进度、目标、百分比、奖励、是否可领取）、`GET /v1/achievements/:id`（含全服完成率）、`GET /v1/achievements/categories`；支持 `?lang=` / `X-Language`（中/英/日） |
| 成就进度实时更新，进度条显示正确 | ✅ | 触发器 `pg_notify` → user-service 消费者实时处理；查询接口先处理该玩家未处理事件，保证读到最新进度。进度 = 单条 upsert（累加类只升不降、绝对值类取最大，封顶 target）；前端进度条 `role=progressbar` |
| 成就完成时自动触发奖励发放 | ✅ | 完成即自动：解锁称号（`rewards.title` 或称号定义 `unlock_criteria.achievement_id`）、发放收藏室装饰（`rewards.decoration`）、生成"成就解锁/称号解锁/获得装饰"站内消息（实时推送）、刷新快照与收藏家积分；货币/道具/精灵球按需求第 7 条走"领取"（见下） |
| 奖励领取功能正常，防止重复领取 | ✅ | `POST /v1/achievements/:id/claim`、`POST /v1/achievements/claim-all`：`user_achievements` 行锁 + `rewards_claimed` 标记，同一事务内经 reward-service `rewardGrant.grantRewards`（货币/经验/精灵球）与 `shared/inventory.addItems`（道具）入账；未完成 400、已领 409。原种子里不存在的道具（孵化器、护符…）已换成已定义道具。冒烟用例 5 个并发领取只成功 1 个且只入账一次 |
| 成就排行榜 API 返回正确的排名数据 | ✅ | `GET /v1/achievements/leaderboard?limit=&offset=`：按点数、完成数排序，排除封禁用户，带玩家佩戴的称号与本人名次；Redis 缓存 60 秒 |
| 称号系统可用，支持激活/取消激活 | ✅ | 见 REQ-00106：`PUT /v1/users/me/titles/:id/activate`、`DELETE /v1/users/me/titles/active`；每人最多一个激活称号（部分唯一索引 + 行锁），并发佩戴只有一个生效 |
| 隐藏成就不显示在列表中，直到被解锁 | ✅ | 列表只返回 `hiddenLocked` 数量；未解锁的隐藏成就详情返回 404、不计入分类总数；新增 4 个隐藏成就（夜猫子、持之以恒、精灵大师、幸运邂逅/完美主义者的说明已改为可达成的条件） |
| 前端成就面板渲染正确，支持分类切换 | ✅ | `src/features/profile-notify/achievements.js`：总览（点数/完成度/排名/待领取）、分类标签页、状态筛选、进度条、领奖/一键领取、隐藏成就计数、排行榜入口 |
| 成就点数和完成数量统计准确 | ✅ | `GET /v1/achievements/my/progress`：实时按 `user_achievements` 统计点数、完成数、各分类进度、可领取数；`achievement_progress_snapshots` 由 SQL 函数 `achievement_refresh_snapshot` 在解锁后重算（排行榜读取） |
| 单元测试覆盖核心逻辑（30+ 测试用例） | ✅ | `tests/unit/achievementRules.test.js`（11）+ `tests/unit/achievementEngine.test.js`（9，内存替身覆盖完成只判定一次、前置成就、元成就、称号、消息、偏好过滤、SAVEPOINT 失败隔离与重试上限）共 20 个单测；冒烟 `smoke-profile-notify.js` 中成就相关约 20 项（升级/捕捉/补给站触发、并发领奖、隐藏、排行、多语言）。单测已在宿主机通过，冒烟未运行 |
| 性能测试：成就查询 < 100ms，进度更新 < 50ms | ⚠️ | 未实测。`scripts/bench-profile-notify.js` 输出 `/v1/achievements/my`、`/my/progress` 的 P50/P95/P99 与"事件 → 成就完成"延迟；Prometheus `minego_achievement_processing_seconds`（单次处理耗时）可直接观察进度更新耗时，并配置了 P95 > 50ms 的告警 |
| Prometheus 指标正确暴露（成就解锁数、处理延迟等） | ✅ | `minego_game_events_processed_total{type,status}`、`minego_achievements_unlocked_total{category,rarity}`、`minego_titles_unlocked_total`、`minego_achievement_processing_seconds`、`minego_game_event_lag_seconds`（注册到共享 registry，user-service / pokemon-service 的 `/metrics` 暴露）；告警 `infrastructure/monitoring/prometheus/profile_notify_alerts.yml`、仪表盘 `monitoring/grafana/dashboards/achievements-notifications.json`（未在生产环境验证） |

- 入口：pokemon-service `src/achievementService.js`、`src/routes/achievements.js`（挂载 `/achievements`，删除了重复挂载）；网关 `/v1/achievements/*`（鉴权）；引擎 `backend/shared/achievementEngine.js`（user-service `onReady` 启动消费者）
- 迁移：`database/migrations/20260925_130000__e05_achievement_title_core.sql`
- 测试：见上；`BASE_URL=… node scripts/smoke-profile-notify.js`（未运行，待验证）
- 偏差：文档中的 `achievementTriggers.js`（需要每个服务手工调用、从未被调用）改为数据库触发器 + outbox，已删除；原 `achievementService.js`（无法写入 `user_achievements`、测试是 knex 风格桩）与失效的 `tests/unit/achievement.test.js` 已替换；`user_id` 为 UUID
- 待验证：① 全新库 `reset-db` 后 `bootstrap-report.json` 无本批迁移失败；② 存量库上回填旧 V1 成就计数的结果；③ `smoke-profile-notify.js` 中升级/捕捉/补给站触发成就与消息、并发领奖；④ `bench-profile-notify.js` 的 P95
