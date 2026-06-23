# REQ-00067: 精灵羁绊与互动养成系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00067 |
| 标题 | 精灵羁绊与互动养成系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | pokemon-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-09 22:30 |

## 需求描述

实现精灵与训练师之间的深度互动养成系统，通过日常互动行为（喂食、游玩、抚摸、训练等）提升精灵的羁绊值（Friendship/Bond Level）。高羁绊精灵在战斗中可获得额外增益（暴击率提升、闪避率提升、异常状态抵抗等），增强玩家与精灵的情感连接，提升游戏粘性和长期留存率。

### 核心功能
1. **羁绊等级系统**：10级羁绊系统（0-255数值映射），每级解锁不同增益效果
2. **互动行为系统**：多种互动方式（喂食、游玩、抚摸、训练、散步），每种行为消耗不同资源
3. **羁绊增益系统**：战斗中的羁绊加成效果，高羁绊精灵触发特殊战斗表现
4. **心情系统**：精灵心情状态影响羁绊获取效率和战斗表现
5. **互动历史记录**：记录训练师与精灵的互动历史和羁绊里程碑

### 业务价值
- 提升玩家留存率 25%+（通过情感连接机制）
- 增加日活跃用户互动时长 15%+
- 提供差异化养成体验，增强游戏深度

## 技术方案

### 1. 数据库设计

#### 1.1 精灵羁绊表（pokemon_friendship）
```sql
CREATE TABLE pokemon_friendship (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    friendship_value SMALLINT NOT NULL DEFAULT 0, -- 0-255 数值
    friendship_level SMALLINT NOT NULL DEFAULT 0, -- 0-10 等级
    mood VARCHAR(20) NOT NULL DEFAULT 'neutral', -- happy, neutral, sad, excited, tired
    mood_expiry TIMESTAMPTZ,
    last_interaction_at TIMESTAMPTZ,
    total_interactions INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pokemon_id, user_id)
);

-- 索引优化
CREATE INDEX idx_pokemon_friendship_user ON pokemon_friendship(user_id);
CREATE INDEX idx_pokemon_friendship_pokemon ON pokemon_friendship(pokemon_id);
CREATE INDEX idx_pokemon_friendship_level ON pokemon_friendship(friendship_level);
```

#### 1.2 互动记录表（friendship_interactions）
```sql
CREATE TABLE friendship_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    interaction_type VARCHAR(30) NOT NULL, -- feed, play, pet, train, walk
    friendship_gain SMALLINT NOT NULL,
    mood_change VARCHAR(20),
    resource_consumed JSONB, -- {"type": "berry", "id": "xxx", "quantity": 1}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引优化
CREATE INDEX idx_friendship_interactions_pokemon ON friendship_interactions(pokemon_id);
CREATE INDEX idx_friendship_interactions_user_time ON friendship_interactions(user_id, created_at DESC);
```

#### 1.3 羁绊里程碑表（friendship_milestones）
```sql
CREATE TABLE friendship_milestones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pokemon_id UUID NOT NULL REFERENCES pokemons(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    milestone_type VARCHAR(50) NOT NULL, -- level_up, total_interactions, battle_heroic
    milestone_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(pokemon_id, user_id, milestone_type)
);
```

#### 1.4 互动道具配置表（interaction_items）
```sql
CREATE TABLE interaction_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_type VARCHAR(30) NOT NULL, -- berry, toy, accessory
    name_i18n JSONB NOT NULL, -- {"en-US": "Oran Berry", "zh-CN": "橙橙果"}
    friendship_bonus SMALLINT NOT NULL DEFAULT 10,
    mood_effect VARCHAR(20), -- happy, excited
    mood_duration_minutes INTEGER DEFAULT 60,
    rarity VARCHAR(20) NOT NULL DEFAULT 'common',
    obtain_method VARCHAR(50), -- catch, raid, shop, quest
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 2. 后端服务实现

#### 2.1 核心羁绊服务（backend/services/pokemon-service/src/friendshipService.js）
```javascript
const { Pool } = require('pg');
const Redis = require('ioredis');
const { EventEmitter } = require('events');
const { metrics } = require('../../shared/metrics');

class FriendshipService extends EventEmitter {
  constructor(config = {}) {
    super();
    this.db = new Pool(config.database);
    this.redis = new Redis(config.redis);
    
    // 羁绊等级配置（10级）
    this.FRIENDSHIP_LEVELS = [
      { level: 0, min: 0, max: 25, name: '陌生人' },
      { level: 1, min: 26, max: 50, name: '认识' },
      { level: 2, min: 51, max: 75, name: '友好' },
      { level: 3, min: 76, max: 100, name: '熟悉' },
      { level: 4, min: 101, max: 125, name: '信任' },
      { level: 5, min: 126, max: 150, name: '亲密' },
      { level: 6, min: 151, max: 175, name: '挚友' },
      { level: 7, min: 176, max: 200, name: '魂友' },
      { level: 8, min: 201, max: 225, name: '生死之交' },
      { level: 9, min: 226, max: 250, name: '心灵相通' },
      { level: 10, min: 251, max: 255, name: '灵魂羁绊' }
    ];
    
    // 互动类型配置
    this.INTERACTION_TYPES = {
      feed: {
        friendshipGain: 15,
        moodEffect: 'happy',
        moodDuration: 120,
        cooldown: 60, // 1小时
        resourceRequired: { type: 'berry' }
      },
      play: {
        friendshipGain: 10,
        moodEffect: 'excited',
        moodDuration: 90,
        cooldown: 120, // 2小时
        resourceRequired: { type: 'toy' }
      },
      pet: {
        friendshipGain: 5,
        moodEffect: 'happy',
        moodDuration: 60,
        cooldown: 30, // 30分钟
        resourceRequired: null
      },
      train: {
        friendshipGain: 20,
        moodEffect: 'tired',
        moodDuration: 30,
        cooldown: 180, // 3小时
        resourceRequired: null
      },
      walk: {
        friendshipGain: 12,
        moodEffect: 'excited',
        moodDuration: 150,
        cooldown: 240, // 4小时
        resourceRequired: null,
        locationRequired: true
      }
    };
    
    // 心情系统
    this.MOOD_EFFECTS = {
      happy: { friendshipMultiplier: 1.2, battleBonus: { critRate: 0.05 } },
      excited: { friendshipMultiplier: 1.3, battleBonus: { evasionRate: 0.05 } },
      neutral: { friendshipMultiplier: 1.0, battleBonus: {} },
      sad: { friendshipMultiplier: 0.8, battleBonus: {} },
      tired: { friendshipMultiplier: 0.9, battleBonus: { critRate: -0.05 } }
    };
  }

  /**
   * 获取精灵羁绊信息
   */
  async getFriendshipInfo(pokemonId, userId) {
    const cacheKey = `friendship:${pokemonId}:${userId}`;
    
    // 尝试从缓存获取
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    const result = await this.db.query(
      `SELECT pf.*, p.species_id, p.nickname, p.level as pokemon_level
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
    const levelConfig = this.getLevelConfig(friendship.friendship_value);
    
    const info = {
      ...friendship,
      levelName: levelConfig.name,
      nextLevel: levelConfig.level < 10 ? this.FRIENDSHIP_LEVELS[levelConfig.level + 1] : null,
      progressToNextLevel: this.calculateProgress(friendship.friendship_value, levelConfig),
      battleBonuses: this.calculateBattleBonuses(friendship.friendship_level, friendship.mood)
    };
    
    // 缓存5分钟
    await this.redis.setex(cacheKey, 300, JSON.stringify(info));
    
    return info;
  }

  /**
   * 初始化羁绊记录
   */
  async initFriendship(pokemonId, userId) {
    const result = await this.db.query(
      `INSERT INTO pokemon_friendship (pokemon_id, user_id, friendship_value, friendship_level)
       VALUES ($1, $2, 0, 0)
       ON CONFLICT (pokemon_id, user_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [pokemonId, userId]
    );
    
    metrics.increment('friendship.initialized');
    
    const friendship = result.rows[0];
    return {
      ...friendship,
      levelName: this.FRIENDSHIP_LEVELS[0].name,
      nextLevel: this.FRIENDSHIP_LEVELS[1],
      progressToNextLevel: 0,
      battleBonuses: {}
    };
  }

  /**
   * 执行互动行为
   */
  async performInteraction(pokemonId, userId, interactionType, options = {}) {
    const config = this.INTERACTION_TYPES[interactionType];
    if (!config) {
      throw new Error(`Invalid interaction type: ${interactionType}`);
    }
    
    // 检查冷却时间
    const cooldownKey = `interaction_cooldown:${pokemonId}:${userId}:${interactionType}`;
    const lastInteraction = await this.redis.get(cooldownKey);
    if (lastInteraction) {
      const remaining = parseInt(lastInteraction) - Date.now();
      if (remaining > 0) {
        throw new Error(`Cooldown remaining: ${Math.ceil(remaining / 60000)} minutes`);
      }
    }
    
    // 检查资源消耗
    if (config.resourceRequired) {
      await this.validateAndConsumeResource(userId, config.resourceRequired, options.resourceId);
    }
    
    // 获取当前羁绊状态
    let friendship = await this.getFriendshipInfo(pokemonId, userId);
    const moodConfig = this.MOOD_EFFECTS[friendship.mood] || this.MOOD_EFFECTS.neutral;
    
    // 计算羁绊增益（心情加成）
    let friendshipGain = Math.floor(config.friendshipGain * moodConfig.friendshipMultiplier);
    
    // 稀有度加成（闪光精灵额外+5）
    const pokemon = await this.db.query(
      'SELECT is_shiny FROM pokemons WHERE id = $1',
      [pokemonId]
    );
    if (pokemon.rows[0]?.is_shiny) {
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
      `INSERT INTO friendship_interactions (pokemon_id, user_id, interaction_type, friendship_gain, mood_change)
       VALUES ($1, $2, $3, $4, $5)`,
      [pokemonId, userId, interactionType, friendshipGain, newMood]
    );
    
    // 设置冷却时间
    await this.redis.setex(
      cooldownKey,
      config.cooldown * 60,
      (Date.now() + config.cooldown * 60000).toString()
    );
    
    // 清除缓存
    await this.redis.del(`friendship:${pokemonId}:${userId}`);
    
    // 检查等级提升里程碑
    if (newLevel > friendship.friendship_level) {
      await this.recordMilestone(pokemonId, userId, 'level_up', {
        previousLevel: friendship.friendship_level,
        newLevel: newLevel
      });
      
      this.emit('levelUp', {
        pokemonId,
        userId,
        newLevel,
        friendshipValue: newFriendshipValue
      });
      
      metrics.increment('friendship.level_up');
    }
    
    metrics.increment('friendship.interaction', { type: interactionType });
    
    return {
      success: true,
      friendshipGain,
      newFriendshipValue,
      newLevel,
      mood: newMood,
      moodDuration: config.moodDuration,
      levelUp: newLevel > friendship.friendship_level
    };
  }

  /**
   * 计算战斗加成
   */
  calculateBattleBonuses(friendshipLevel, mood) {
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
    const moodConfig = this.MOOD_EFFECTS[mood] || this.MOOD_EFFECTS.neutral;
    if (moodConfig.battleBonus.critRate) {
      bonuses.critRateBonus += moodConfig.battleBonus.critRate;
    }
    if (moodConfig.battleBonus.evasionRate) {
      bonuses.evasionRateBonus += moodConfig.battleBonus.evasionRate;
    }
    
    return bonuses;
  }

  /**
   * 更新心情（定时任务调用）
   */
  async updateMoods() {
    // 更新过期的心情为neutral
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
    
    return result.rows.length;
  }

  /**
   * 获取羁绊排行榜
   */
  async getLeaderboard(limit = 100) {
    const result = await this.db.query(
      `SELECT pf.*, u.username, p.species_id, p.nickname
       FROM pokemon_friendship pf
       JOIN users u ON pf.user_id = u.id
       JOIN pokemons p ON pf.pokemon_id = p.id
       WHERE pf.friendship_level = 10
       ORDER BY pf.friendship_value DESC, pf.total_interactions DESC
       LIMIT $1`,
      [limit]
    );
    
    return result.rows;
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
    // 从背包检查并消耗道具
    // 集成 inventoryService
  }

  async recordMilestone(pokemonId, userId, milestoneType, data) {
    await this.db.query(
      `INSERT INTO friendship_milestones (pokemon_id, user_id, milestone_type, milestone_data)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (pokemon_id, user_id, milestone_type) DO NOTHING`,
      [pokemonId, userId, milestoneType, JSON.stringify(data)]
    );
  }
}

module.exports = FriendshipService;
```

#### 2.2 API 路由（backend/services/pokemon-service/src/routes/friendship.js）
```javascript
const express = require('express');
const router = express.Router();
const FriendshipService = require('../friendshipService');
const { authenticate } = require('../../../../shared/middleware/auth');
const { validateRequest } = require('../../../../shared/middleware/validation');
const Joi = require('joi');

const friendshipService = new FriendshipService();

// 验证 schema
const interactionSchema = Joi.object({
  interactionType: Joi.string().valid('feed', 'play', 'pet', 'train', 'walk').required(),
  resourceId: Joi.string().uuid(),
  location: Joi.object({
    latitude: Joi.number().min(-90).max(90),
    longitude: Joi.number().min(-180).max(180)
  })
});

/**
 * GET /api/pokemon/:pokemonId/friendship
 * 获取精灵羁绊信息
 */
router.get('/:pokemonId/friendship', authenticate, async (req, res) => {
  try {
    const info = await friendshipService.getFriendshipInfo(
      req.params.pokemonId,
      req.user.id
    );
    res.json({ success: true, data: info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/pokemon/:pokemonId/friendship/interact
 * 执行互动行为
 */
router.post(
  '/:pokemonId/friendship/interact',
  authenticate,
  validateRequest(interactionSchema),
  async (req, res) => {
    try {
      const result = await friendshipService.performInteraction(
        req.params.pokemonId,
        req.user.id,
        req.body.interactionType,
        req.body
      );
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

/**
 * GET /api/pokemon/friendship/leaderboard
 * 获取羁绊排行榜
 */
router.get('/friendship/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const leaderboard = await friendshipService.getLeaderboard(limit);
    res.json({ success: true, data: leaderboard });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pokemon/friendship/interactions
 * 获取互动历史
 */
router.get('/:pokemonId/friendship/interactions', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await friendshipService.db.query(
      `SELECT * FROM friendship_interactions
       WHERE pokemon_id = $1 AND user_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [req.params.pokemonId, req.user.id, limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 3. 前端实现

#### 3.1 羁绊组件（frontend/game-client/src/components/FriendshipPanel.js）
```javascript
import React, { useState, useEffect } from 'react';
import './FriendshipPanel.css';

const FriendshipPanel = ({ pokemonId, onClose }) => {
  const [friendship, setFriendship] = useState(null);
  const [loading, setLoading] = useState(true);
  const [interacting, setInteracting] = useState(null);
  
  useEffect(() => {
    fetchFriendshipInfo();
  }, [pokemonId]);
  
  const fetchFriendshipInfo = async () => {
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/friendship`, {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      if (data.success) {
        setFriendship(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch friendship info:', error);
    } finally {
      setLoading(false);
    }
  };
  
  const performInteraction = async (type) => {
    setInteracting(type);
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/friendship/interact`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ interactionType: type })
      });
      const data = await response.json();
      
      if (data.success) {
        setFriendship(prev => ({
          ...prev,
          friendship_value: data.data.newFriendshipValue,
          friendship_level: data.data.newLevel,
          mood: data.data.mood
        }));
        
        if (data.data.levelUp) {
          // 显示等级提升动画
          showLevelUpAnimation(data.data.newLevel);
        }
      } else {
        alert(data.error);
      }
    } catch (error) {
      console.error('Interaction failed:', error);
    } finally {
      setInteracting(null);
    }
  };
  
  const showLevelUpAnimation = (level) => {
    // 等级提升特效
    const event = new CustomEvent('friendshipLevelUp', { detail: { level } });
    window.dispatchEvent(event);
  };
  
  const interactionIcons = {
    feed: '🍓',
    play: '🎾',
    pet: '✋',
    train: '💪',
    walk: '🚶'
  };
  
  const interactionLabels = {
    feed: '喂食',
    play: '游玩',
    pet: '抚摸',
    train: '训练',
    walk: '散步'
  };
  
  if (loading) {
    return <div className="friendship-panel loading">加载中...</div>;
  }
  
  if (!friendship) {
    return null;
  }
  
  return (
    <div className="friendship-panel">
      <div className="friendship-header">
        <h3>羁绊系统</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      
      <div className="friendship-level">
        <div className="level-badge">
          <span className="level-number">{friendship.friendship_level}</span>
          <span className="level-name">{friendship.levelName}</span>
        </div>
        
        <div className="progress-bar">
          <div 
            className="progress-fill"
            style={{ width: `${friendship.progressToNextLevel}%` }}
          />
          <span className="progress-text">
            {friendship.friendship_value}/255
          </span>
        </div>
      </div>
      
      <div className="mood-indicator">
        <span className="mood-label">心情:</span>
        <span className={`mood-value ${friendship.mood}`}>
          {getMoodEmoji(friendship.mood)} {friendship.mood}
        </span>
      </div>
      
      <div className="battle-bonuses">
        <h4>战斗加成</h4>
        {friendship.battleBonuses.critRateBonus > 0 && (
          <div className="bonus-item">
            <span>暴击率</span>
            <span className="bonus-value">+{(friendship.battleBonuses.critRateBonus * 100).toFixed(0)}%</span>
          </div>
        )}
        {friendship.battleBonuses.evasionRateBonus > 0 && (
          <div className="bonus-item">
            <span>闪避率</span>
            <span className="bonus-value">+{(friendship.battleBonuses.evasionRateBonus * 100).toFixed(0)}%</span>
          </div>
        )}
        {friendship.battleBonuses.statusResistBonus > 0 && (
          <div className="bonus-item">
            <span>状态抵抗</span>
            <span className="bonus-value">+{(friendship.battleBonuses.statusResistBonus * 100).toFixed(0)}%</span>
          </div>
        )}
        {friendship.battleBonuses.expBonus > 0 && (
          <div className="bonus-item">
            <span>经验加成</span>
            <span className="bonus-value">+{(friendship.battleBonuses.expBonus * 100).toFixed(0)}%</span>
          </div>
        )}
      </div>
      
      <div className="interactions">
        <h4>互动</h4>
        <div className="interaction-buttons">
          {Object.keys(interactionIcons).map(type => (
            <button
              key={type}
              className={`interaction-btn ${interacting === type ? 'active' : ''}`}
              onClick={() => performInteraction(type)}
              disabled={interacting !== null}
            >
              <span className="icon">{interactionIcons[type]}</span>
              <span className="label">{interactionLabels[type]}</span>
            </button>
          ))}
        </div>
      </div>
      
      <div className="interaction-stats">
        <span>总互动次数: {friendship.total_interactions}</span>
      </div>
    </div>
  );
};

const getMoodEmoji = (mood) => {
  const emojis = {
    happy: '😊',
    excited: '🎉',
    neutral: '😐',
    sad: '😢',
    tired: '😴'
  };
  return emojis[mood] || '😐';
};

export default FriendshipPanel;
```

### 4. 战斗系统集成

#### 4.1 战斗引擎集成（gym-service 集成）
```javascript
// backend/services/gym-service/src/battleEngine.js 中添加羁绊加成

async calculateEffectiveStats(pokemon, userId) {
  const baseStats = pokemon.stats;
  
  // 获取羁绊加成
  const friendshipResponse = await fetch(
    `http://pokemon-service:3003/api/pokemon/${pokemon.id}/friendship`,
    { headers: { 'X-User-Id': userId } }
  );
  
  if (friendshipResponse.ok) {
    const { data: friendship } = await friendshipResponse.json();
    const bonuses = friendship.battleBonuses;
    
    return {
      ...baseStats,
      critRate: baseStats.critRate + (bonuses.critRateBonus || 0),
      evasionRate: baseStats.evasionRate + (bonuses.evasionRateBonus || 0),
      statusResist: (bonuses.statusResistBonus || 0)
    };
  }
  
  return baseStats;
}
```

### 5. Prometheus 指标
```javascript
// backend/shared/metrics.js 添加
const friendshipMetrics = {
  friendshipInitialized: new Counter({
    name: 'friendship_initialized_total',
    help: 'Total number of friendships initialized'
  }),
  friendshipLevelUp: new Counter({
    name: 'friendship_level_up_total',
    help: 'Total number of friendship level ups'
  }),
  friendshipInteraction: new Counter({
    name: 'friendship_interaction_total',
    help: 'Total number of interactions performed',
    labelNames: ['type']
  })
};
```

## 验收标准

- [ ] 羁绊值范围 0-255，等级 0-10，映射关系正确
- [ ] 5种互动行为（feed、play、pet、train、walk）均能正常执行
- [ ] 互动冷却时间正确限制，相同互动在冷却期内无法重复执行
- [ ] 心情系统正确影响羁绊获取效率（心情倍率 0.8x-1.3x）
- [ ] 羁绊等级≥3时，战斗中暴击率加成生效
- [ ] 羁绊等级≥5时，战斗中闪避率加成生效
- [ ] 羁绊等级≥7时，状态抵抗加成生效
- [ ] 等级提升时正确记录里程碑并触发事件
- [ ] 互动历史记录可查询，支持分页
- [ ] 羁绊排行榜功能正常，显示Top 100
- [ ] 缓存策略正确，互动后缓存失效
- [ ] Prometheus 指标正确记录（初始化、等级提升、互动类型）
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 前端羁绊面板UI完整，支持响应式布局
- [ ] 等级提升动画效果正常触发

## 影响范围

### 新增文件
- `database/pending/20260609_223000__add_friendship_system.sql` - 数据库迁移（4个表）
- `backend/services/pokemon-service/src/friendshipService.js` - 核心羁绊服务
- `backend/services/pokemon-service/src/routes/friendship.js` - API 路由（4个端点）
- `frontend/game-client/src/components/FriendshipPanel.js` - 前端羁绊面板
- `frontend/game-client/src/components/FriendshipPanel.css` - 样式文件
- `backend/tests/unit/friendship.test.js` - 单元测试

### 修改文件
- `backend/services/pokemon-service/src/index.js` - 集成羁绊路由
- `backend/services/gym-service/src/battleEngine.js` - 战斗羁绊加成集成
- `backend/shared/metrics.js` - 添加羁绊相关指标
- `frontend/game-client/index.html` - 集成羁绊面板入口

## 参考

- [Pokémon Friendship Mechanics](https://bulbapedia.bulbagarden.net/wiki/Friendship)
- [Pokémon HeartGold/SoulSilver Friendship System](https://www.serebii.net/heartgoldsoulsilver/friendship.shtml)
- 游戏留存率提升最佳实践
