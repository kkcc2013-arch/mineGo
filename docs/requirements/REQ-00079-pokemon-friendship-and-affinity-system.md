# REQ-00079: 精灵好感度系统与亲密度进化机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00079 |
| 标题 | 精灵好感度系统与亲密度进化机制 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、catch-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-10 11:00 |

## 需求描述

实现完整的精灵好感度（Friendship/Happiness）系统，支持玩家与精灵建立情感羁绊。高好感度的精灵在战斗中表现更出色，特定精灵需要达到高好感度才能进化。这是原版宝可梦游戏的核心机制之一，能极大增强玩家的养成乐趣和情感投入。

### 核心功能

1. **好感度数值系统**
   - 每只精灵拥有独立的好感度值（0-255）
   - 初始好感度根据捕获方式和精灵种类决定
   - 好感度分为多个等级：陌生(0-49)、一般(50-99)、友好(100-149)、亲密(150-199)、挚爱(200-255)

2. **好感度提升途径**
   - 战斗参与（胜利+1，失败+0）
   - 使用道具（营养剂、特定糖果）
   - 行走步数（每256步+1，上限每天10次）
   - 按摩/SPA服务（每日一次，+5-10）
   - 露营互动（+3-5每次）
   - 喂食精灵果（+2-5）

3. **好感度降低因素**
   - 精灵晕倒（-5）
   - 使用苦味药草（-5-10）
   - 交易转让（重置为初始值）
   - 长期闲置（每7天-1，下限50）

4. **亲密度进化**
   - 特定精灵需要高好感度才能进化（如吉利蛋、波克比、伊布等）
   - 进化触发条件检查
   - 进化动画与庆祝效果

5. **战斗加成**
   - 高好感度精灵暴击率提升（最高+10%）
   - 高好感度精灵回避率提升（最高+10%）
   - 高好感度精灵在危机时触发"坚持"效果（10%概率抵抗致命伤害保留1HP）

6. **互动反馈**
   - 精灵状态表情（根据好感度显示不同情绪）
   - 触摸反馈动画
   - 语音互动系统

## 技术方案

### 1. 数据库设计

```sql
-- database/pending/20260610_110000__add_friendship_system.sql

-- 精灵好感度表
CREATE TABLE pokemon_friendship (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    friendship_value INTEGER NOT NULL DEFAULT 50,
    friendship_level VARCHAR(20) NOT NULL DEFAULT 'normal',
    daily_walking_bonus INTEGER DEFAULT 0,
    last_walking_bonus_date DATE,
    daily_interaction_count INTEGER DEFAULT 0,
    last_interaction_date DATE,
    total_interactions INTEGER DEFAULT 0,
    days_with_trainer INTEGER DEFAULT 0,
    first_obtained_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_interaction_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT valid_friendship_value CHECK (friendship_value >= 0 AND friendship_value <= 255),
    CONSTRAINT valid_daily_walking_bonus CHECK (daily_walking_bonus >= 0 AND daily_walking_bonus <= 10),
    UNIQUE(pokemon_instance_id)
);

-- 好感度历史记录表
CREATE TABLE friendship_history (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id INTEGER NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    change_type VARCHAR(50) NOT NULL,
    change_amount INTEGER NOT NULL,
    before_value INTEGER NOT NULL,
    after_value INTEGER NOT NULL,
    source VARCHAR(100),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 亲密度进化规则表
CREATE TABLE friendship_evolution_rules (
    id SERIAL PRIMARY KEY,
    species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    evolution_species_id INTEGER NOT NULL REFERENCES pokemon_species(id),
    required_friendship INTEGER NOT NULL DEFAULT 220,
    time_condition VARCHAR(20), -- 'day', 'night', null
    additional_item_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 好感度互动配置表
CREATE TABLE friendship_interaction_config (
    id SERIAL PRIMARY KEY,
    interaction_type VARCHAR(50) NOT NULL UNIQUE,
    friendship_change INTEGER NOT NULL,
    daily_limit INTEGER DEFAULT NULL,
    cooldown_hours INTEGER DEFAULT 0,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 插入默认互动配置
INSERT INTO friendship_interaction_config (interaction_type, friendship_change, daily_limit, description) VALUES
('battle_win', 1, 20, '战斗胜利'),
('battle_loss', 0, NULL, '战斗失败'),
('faint', -5, NULL, '精灵晕倒'),
('walking', 1, 10, '行走步数奖励'),
('massage', 8, 1, '按摩服务'),
('camping', 4, 3, '露营互动'),
('feed_berry', 3, 5, '喂食精灵果'),
('feed_vitamin', 5, 3, '使用营养剂'),
('bitter_herb', -8, NULL, '使用苦味药草'),
('spa', 10, 1, 'SPA服务'),
('touch', 1, 10, '触摸互动');

-- 插入亲密度进化规则
INSERT INTO friendship_evolution_rules (species_id, evolution_species_id, required_friendship, time_condition) VALUES
((SELECT id FROM pokemon_species WHERE species_id = 113), (SELECT id FROM pokemon_species WHERE species_id = 242), 220, NULL), -- 吉利蛋 -> 幸福蛋
((SELECT id FROM pokemon_species WHERE species_id = 175), (SELECT id FROM pokemon_species WHERE species_id = 176), 220, 'day'), -- 波克比 -> 波克基古
((SELECT id FROM pokemon_species WHERE species_id = 176), (SELECT id FROM pokemon_species WHERE species_id = 468), 220, NULL), -- 波克基古 -> 波克基斯
((SELECT id FROM pokemon_species WHERE species_id = 133), (SELECT id FROM pokemon_species WHERE species_id = 196), 220, 'day'), -- 伊布 -> 太阳伊布
((SELECT id FROM pokemon_species WHERE species_id = 133), (SELECT id FROM pokemon_species WHERE species_id = 197), 220, 'night'), -- 伊布 -> 月亮伊布
((SELECT id FROM pokemon_species WHERE species_id = 183), (SELECT id FROM pokemon_species WHERE species_id = 184), 220, NULL), -- 玛力露 -> 玛力露丽
((SELECT id FROM pokemon_species WHERE species_id = 280), (SELECT id FROM pokemon_species WHERE species_id = 281), 220, NULL), -- 拉鲁拉丝 -> 奇鲁莉安
((SELECT id FROM pokemon_species WHERE species_id = 358), (SELECT id FROM pokemon_species WHERE species_id = 475), 220, 'night'), -- 艾路雷朵（需要男性）
((SELECT id FROM pokemon_species WHERE species_id = 406), (SELECT id FROM pokemon_species WHERE species_id = 407), 220, NULL); -- 含羞苞 -> 罗丝雷朵

-- 创建索引
CREATE INDEX idx_friendship_pokemon ON pokemon_friendship(pokemon_instance_id);
CREATE INDEX idx_friendship_level ON pokemon_friendship(friendship_level);
CREATE INDEX idx_friendship_history_pokemon ON friendship_history(pokemon_instance_id);
CREATE INDEX idx_friendship_history_created ON friendship_history(created_at DESC);
CREATE INDEX idx_evolution_rules_species ON friendship_evolution_rules(species_id);
```

### 2. 好感度服务核心模块

```javascript
// backend/services/pokemon-service/src/friendshipService.js

const { Pool } = require('pg');
const Redis = require('ioredis');
const { logger, metrics } = require('../../../shared');

class FriendshipService {
  constructor() {
    this.db = new Pool({ connectionString: process.env.DATABASE_URL });
    this.redis = new Redis(process.env.REDIS_URL);
    
    // 好感度等级定义
    this.FRIENDSHIP_LEVELS = {
      stranger: { min: 0, max: 49, label: '陌生', emoji: '😐' },
      normal: { min: 50, max: 99, label: '一般', emoji: '🙂' },
      friendly: { min: 100, max: 149, label: '友好', emoji: '😊' },
      close: { min: 150, max: 199, label: '亲密', emoji: '😍' },
      beloved: { min: 200, max: 255, label: '挚爱', emoji: '🥰' }
    };
    
    // 初始好感度配置
    this.BASE_FRIENDSHIP = {
      caught_wild: 50,
      caught_friend_ball: 150,
      hatched: 120,
      traded: 50,
      gift: 100
    };
  }

  /**
   * 获取精灵好感度
   */
  async getFriendship(pokemonInstanceId) {
    const cacheKey = `friendship:${pokemonInstanceId}`;
    const cached = await this.redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    const result = await this.db.query(
      `SELECT pf.*, pi.species_id, ps.name as species_name
       FROM pokemon_friendship pf
       JOIN pokemon_instances pi ON pf.pokemon_instance_id = pi.id
       JOIN pokemon_species ps ON pi.species_id = ps.id
       WHERE pf.pokemon_instance_id = $1`,
      [pokemonInstanceId]
    );
    
    if (result.rows.length === 0) {
      // 创建初始好感度记录
      return await this.initializeFriendship(pokemonInstanceId);
    }
    
    const friendship = this.enrichFriendshipData(result.rows[0]);
    await this.redis.setex(cacheKey, 300, JSON.stringify(friendship));
    
    return friendship;
  }

  /**
   * 初始化精灵好感度
   */
  async initializeFriendship(pokemonInstanceId, caughtWith = 'caught_wild') {
    const initialValue = this.BASE_FRIENDSHIP[caughtWith] || 50;
    const level = this.calculateFriendshipLevel(initialValue);
    
    const result = await this.db.query(
      `INSERT INTO pokemon_friendship 
       (pokemon_instance_id, friendship_value, friendship_level, first_obtained_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       RETURNING *`,
      [pokemonInstanceId, initialValue, level]
    );
    
    metrics.increment('friendship.initialized');
    logger.info('Friendship initialized', { pokemonInstanceId, initialValue });
    
    return this.enrichFriendshipData(result.rows[0]);
  }

  /**
   * 修改好感度
   */
  async modifyFriendship(pokemonInstanceId, change, source, metadata = {}) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前值
      const current = await client.query(
        'SELECT friendship_value FROM pokemon_friendship WHERE pokemon_instance_id = $1 FOR UPDATE',
        [pokemonInstanceId]
      );
      
      if (current.rows.length === 0) {
        throw new Error(`Friendship record not found for pokemon ${pokemonInstanceId}`);
      }
      
      const beforeValue = current.rows[0].friendship_value;
      const afterValue = Math.max(0, Math.min(255, beforeValue + change));
      const newLevel = this.calculateFriendshipLevel(afterValue);
      
      // 更新好感度
      await client.query(
        `UPDATE pokemon_friendship 
         SET friendship_value = $1, 
             friendship_level = $2,
             last_interaction_at = CURRENT_TIMESTAMP,
             total_interactions = total_interactions + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE pokemon_instance_id = $3`,
        [afterValue, newLevel, pokemonInstanceId]
      );
      
      // 记录历史
      await client.query(
        `INSERT INTO friendship_history 
         (pokemon_instance_id, change_type, change_amount, before_value, after_value, source, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [pokemonInstanceId, source, change, beforeValue, afterValue, source, metadata]
      );
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.redis.del(`friendship:${pokemonInstanceId}`);
      
      // 记录指标
      metrics.histogram('friendship.change', change, { source });
      
      if (newLevel !== this.calculateFriendshipLevel(beforeValue)) {
        metrics.increment(`friendship.level_up.${newLevel}`);
        logger.info('Friendship level changed', { 
          pokemonInstanceId, 
          from: this.calculateFriendshipLevel(beforeValue),
          to: newLevel 
        });
      }
      
      return {
        before: beforeValue,
        after: afterValue,
        change: afterValue - beforeValue,
        level: newLevel,
        levelUp: newLevel !== this.calculateFriendshipLevel(beforeValue)
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 处理行走步数奖励
   */
  async processWalkingBonus(pokemonInstanceId, steps) {
    const today = new Date().toISOString().split('T')[0];
    
    const result = await this.db.query(
      `SELECT daily_walking_bonus, last_walking_bonus_date 
       FROM pokemon_friendship 
       WHERE pokemon_instance_id = $1`,
      [pokemonInstanceId]
    );
    
    if (result.rows.length === 0) return null;
    
    const friendship = result.rows[0];
    
    // 检查是否需要重置每日计数
    if (friendship.last_walking_bonus_date !== today) {
      await this.db.query(
        `UPDATE pokemon_friendship 
         SET daily_walking_bonus = 0, last_walking_bonus_date = $1
         WHERE pokemon_instance_id = $2`,
        [today, pokemonInstanceId]
      );
      friendship.daily_walking_bonus = 0;
    }
    
    // 检查是否达到每日上限
    if (friendship.daily_walking_bonus >= 10) {
      return { bonus: false, reason: 'daily_limit_reached' };
    }
    
    // 每256步获得1点好感度
    const bonusCount = Math.floor(steps / 256);
    const actualBonus = Math.min(bonusCount, 10 - friendship.daily_walking_bonus);
    
    if (actualBonus > 0) {
      await this.modifyFriendship(pokemonInstanceId, actualBonus, 'walking', { steps });
      
      await this.db.query(
        `UPDATE pokemon_friendship 
         SET daily_walking_bonus = daily_walking_bonus + $1
         WHERE pokemon_instance_id = $2`,
        [actualBonus, pokemonInstanceId]
      );
    }
    
    return { bonus: true, amount: actualBonus };
  }

  /**
   * 检查亲密度进化
   */
  async checkFriendshipEvolution(pokemonInstanceId, userId) {
    const friendship = await this.getFriendship(pokemonInstanceId);
    
    const result = await this.db.query(
      `SELECT fer.*, ps.name as evolution_name
       FROM friendship_evolution_rules fer
       JOIN pokemon_species ps ON fer.evolution_species_id = ps.id
       WHERE fer.species_id = $1`,
      [friendship.species_id]
    );
    
    if (result.rows.length === 0) {
      return { canEvolve: false, reason: 'no_evolution_available' };
    }
    
    const rule = result.rows[0];
    
    // 检查好感度是否达标
    if (friendship.friendship_value < rule.required_friendship) {
      return { 
        canEvolve: false, 
        reason: 'friendship_too_low',
        current: friendship.friendship_value,
        required: rule.required_friendship
      };
    }
    
    // 检查时间条件
    if (rule.time_condition) {
      const hour = new Date().getHours();
      const isDay = hour >= 6 && hour < 18;
      
      if (rule.time_condition === 'day' && !isDay) {
        return { canEvolve: false, reason: 'not_daytime' };
      }
      if (rule.time_condition === 'night' && isDay) {
        return { canEvolve: false, reason: 'not_nighttime' };
      }
    }
    
    return {
      canEvolve: true,
      evolutionSpeciesId: rule.evolution_species_id,
      evolutionName: rule.evolution_name,
      requiredFriendship: rule.required_friendship,
      currentFriendship: friendship.friendship_value
    };
  }

  /**
   * 执行亲密度进化
   */
  async performFriendshipEvolution(pokemonInstanceId, userId) {
    const evolutionCheck = await this.checkFriendshipEvolution(pokemonInstanceId, userId);
    
    if (!evolutionCheck.canEvolve) {
      throw new Error(`Cannot evolve: ${evolutionCheck.reason}`);
    }
    
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 更新精灵物种
      await client.query(
        `UPDATE pokemon_instances 
         SET species_id = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [evolutionCheck.evolutionSpeciesId, pokemonInstanceId]
      );
      
      // 记录进化事件
      await client.query(
        `INSERT INTO pokemon_evolution_history 
         (pokemon_instance_id, from_species_id, to_species_id, evolution_type, user_id)
         VALUES ($1, $2, $3, 'friendship', $4)`,
        [pokemonInstanceId, evolutionCheck.currentSpeciesId, evolutionCheck.evolutionSpeciesId, userId]
      );
      
      await client.query('COMMIT');
      
      metrics.increment('friendship.evolution');
      logger.info('Friendship evolution completed', {
        pokemonInstanceId,
        newSpecies: evolutionCheck.evolutionName
      });
      
      return evolutionCheck;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 计算战斗加成
   */
  calculateBattleBonuses(friendshipValue) {
    const level = this.calculateFriendshipLevel(friendshipValue);
    
    let critBonus = 0;
    let evasionBonus = 0;
    let persistChance = 0;
    
    if (friendshipValue >= 200) {
      critBonus = 0.10;
      evasionBonus = 0.10;
      persistChance = 0.10;
    } else if (friendshipValue >= 150) {
      critBonus = 0.07;
      evasionBonus = 0.07;
      persistChance = 0.07;
    } else if (friendshipValue >= 100) {
      critBonus = 0.05;
      evasionBonus = 0.05;
      persistChance = 0.05;
    }
    
    return {
      critBonus,
      evasionBonus,
      persistChance,
      level
    };
  }

  /**
   * 计算好感度等级
   */
  calculateFriendshipLevel(value) {
    if (value >= 200) return 'beloved';
    if (value >= 150) return 'close';
    if (value >= 100) return 'friendly';
    if (value >= 50) return 'normal';
    return 'stranger';
  }

  /**
   * 丰富好感度数据
   */
  enrichFriendshipData(data) {
    const level = this.FRIENDSHIP_LEVELS[data.friendship_level];
    return {
      ...data,
      levelInfo: level,
      battleBonuses: this.calculateBattleBonuses(data.friendship_value),
      evolutionReady: data.friendship_value >= 220
    };
  }

  /**
   * 获取互动状态
   */
  async getInteractionStatus(pokemonInstanceId) {
    const today = new Date().toISOString().split('T')[0];
    
    const result = await this.db.query(
      `SELECT daily_interaction_count, last_interaction_date 
       FROM pokemon_friendship 
       WHERE pokemon_instance_id = $1`,
      [pokemonInstanceId]
    );
    
    if (result.rows.length === 0) return null;
    
    const data = result.rows[0];
    
    // 获取今日互动记录
    const interactions = await this.db.query(
      `SELECT change_type, COUNT(*) as count, SUM(change_amount) as total_change
       FROM friendship_history
       WHERE pokemon_instance_id = $1 AND DATE(created_at) = $2
       GROUP BY change_type`,
      [pokemonInstanceId, today]
    );
    
    return {
      dailyCount: data.last_interaction_date === today ? data.daily_interaction_count : 0,
      todayInteractions: interactions.rows
    };
  }
}

module.exports = new FriendshipService();
```

### 3. API 路由

```javascript
// backend/services/pokemon-service/src/routes/friendship.js

const express = require('express');
const router = express.Router();
const friendshipService = require('../friendshipService');
const { authenticate, validateRequest } = require('../../../shared/middleware');
const Joi = require('joi');

/**
 * 获取精灵好感度
 */
router.get('/:pokemonId/friendship', authenticate, async (req, res) => {
  try {
    const friendship = await friendshipService.getFriendship(req.params.pokemonId);
    res.json({
      success: true,
      data: friendship
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 与精灵互动
 */
router.post('/:pokemonId/interact', 
  authenticate,
  validateRequest({
    body: Joi.object({
      type: Joi.string().valid(
        'massage', 'camping', 'feed_berry', 'feed_vitamin', 'spa', 'touch'
      ).required(),
      itemId: Joi.number().optional()
    })
  }),
  async (req, res) => {
    try {
      const { type, itemId } = req.body;
      
      // 获取互动配置
      const config = await friendshipService.getInteractionConfig(type);
      
      if (!config || !config.is_active) {
        return res.status(400).json({ 
          success: false, 
          error: 'interaction_unavailable' 
        });
      }
      
      // 检查每日限制
      const status = await friendshipService.getInteractionStatus(req.params.pokemonId);
      if (config.daily_limit && status.dailyCount >= config.daily_limit) {
        return res.status(400).json({ 
          success: false, 
          error: 'daily_limit_reached' 
        });
      }
      
      // 执行互动
      const result = await friendshipService.modifyFriendship(
        req.params.pokemonId,
        config.friendship_change,
        type,
        { itemId, userId: req.user.id }
      );
      
      res.json({
        success: true,
        data: {
          ...result,
          interactionType: type,
          message: `好感度${result.change > 0 ? '提升' : '降低'}了 ${Math.abs(result.change)} 点！`
        }
      });
      
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/**
 * 检查亲密度进化
 */
router.get('/:pokemonId/evolution-check', authenticate, async (req, res) => {
  try {
    const result = await friendshipService.checkFriendshipEvolution(
      req.params.pokemonId,
      req.user.id
    );
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 执行亲密度进化
 */
router.post('/:pokemonId/evolve', authenticate, async (req, res) => {
  try {
    const result = await friendshipService.performFriendshipEvolution(
      req.params.pokemonId,
      req.user.id
    );
    
    res.json({
      success: true,
      data: {
        ...result,
        message: `恭喜！精灵进化成了 ${result.evolutionName}！`
      }
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * 获取互动历史
 */
router.get('/:pokemonId/history', authenticate, async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    
    const result = await friendshipService.db.query(
      `SELECT * FROM friendship_history
       WHERE pokemon_instance_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.pokemonId, limit, offset]
    );
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 4. 前端组件

```javascript
// frontend/game-client/src/components/FriendshipPanel.js

import React, { useState, useEffect } from 'react';
import './FriendshipPanel.css';

const FriendshipPanel = ({ pokemonId, onClose }) => {
  const [friendship, setFriendship] = useState(null);
  const [interactions, setInteractions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [interacting, setInteracting] = useState(false);

  useEffect(() => {
    fetchFriendship();
  }, [pokemonId]);

  const fetchFriendship = async () => {
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/friendship`);
      const data = await response.json();
      if (data.success) {
        setFriendship(data.data);
      }
    } catch (error) {
      console.error('Failed to fetch friendship:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleInteract = async (type) => {
    if (interacting) return;
    setInteracting(true);
    
    try {
      const response = await fetch(`/api/pokemon/${pokemonId}/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      
      const data = await response.json();
      
      if (data.success) {
        setFriendship(prev => ({
          ...prev,
          friendship_value: data.data.after,
          levelInfo: data.data.level
        }));
        
        // 显示动画效果
        showInteractionEffect(type, data.data);
      }
    } catch (error) {
      console.error('Interaction failed:', error);
    } finally {
      setInteracting(false);
    }
  };

  const showInteractionEffect = (type, result) => {
    // 创建浮动动画效果
    const effect = document.createElement('div');
    effect.className = `friendship-effect ${result.change > 0 ? 'positive' : 'negative'}`;
    effect.textContent = `${result.change > 0 ? '+' : ''}${result.change}`;
    document.querySelector('.friendship-value').appendChild(effect);
    
    setTimeout(() => effect.remove(), 2000);
  };

  if (loading) {
    return <div className="friendship-loading">加载中...</div>;
  }

  if (!friendship) {
    return <div className="friendship-error">无法获取好感度数据</div>;
  }

  const progressPercent = (friendship.friendship_value / 255) * 100;

  return (
    <div className="friendship-panel">
      <div className="friendship-header">
        <h2>好感度</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      
      <div className="friendship-display">
        <div className="friendship-emoji">
          {friendship.levelInfo?.emoji || '🙂'}
        </div>
        
        <div className="friendship-value">
          <span className="value">{friendship.friendship_value}</span>
          <span className="max">/ 255</span>
        </div>
        
        <div className="friendship-level">
          <span className={`level-badge ${friendship.friendship_level}`}>
            {friendship.levelInfo?.label || '一般'}
          </span>
        </div>
        
        <div className="friendship-progress">
          <div 
            className="progress-bar" 
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
      
      {friendship.evolutionReady && (
        <div className="evolution-ready">
          <span className="evolution-icon">✨</span>
          可已进行亲密度进化！
        </div>
      )}
      
      <div className="battle-bonuses">
        <h3>战斗加成</h3>
        <div className="bonus-grid">
          <div className="bonus-item">
            <span className="bonus-label">暴击率</span>
            <span className="bonus-value">
              +{(friendship.battleBonuses?.critBonus || 0) * 100}%
            </span>
          </div>
          <div className="bonus-item">
            <span className="bonus-label">回避率</span>
            <span className="bonus-value">
              +{(friendship.battleBonuses?.evasionBonus || 0) * 100}%
            </span>
          </div>
          <div className="bonus-item">
            <span className="bonus-label">坚持几率</span>
            <span className="bonus-value">
              {(friendship.battleBonuses?.persistChance || 0) * 100}%
            </span>
          </div>
        </div>
      </div>
      
      <div className="interactions-section">
        <h3>互动</h3>
        <div className="interaction-buttons">
          <button 
            className="interaction-btn"
            onClick={() => handleInteract('touch')}
            disabled={interacting}
          >
            <span className="icon">👆</span>
            抚摸
          </button>
          <button 
            className="interaction-btn"
            onClick={() => handleInteract('massage')}
            disabled={interacting}
          >
            <span className="icon">💆</span>
            按摩
          </button>
          <button 
            className="interaction-btn"
            onClick={() => handleInteract('camping')}
            disabled={interacting}
          >
            <span className="icon">🏕️</span>
            露营
          </button>
          <button 
            className="interaction-btn"
            onClick={() => handleInteract('spa')}
            disabled={interacting}
          >
            <span className="icon">🧖</span>
            SPA
          </button>
          <button 
            className="interaction-btn"
            onClick={() => handleInteract('feed_berry')}
            disabled={interacting}
          >
            <span className="icon">🫐</span>
            喂食
          </button>
        </div>
      </div>
      
      <div className="friendship-stats">
        <div className="stat-item">
          <span className="stat-label">相伴天数</span>
          <span className="stat-value">{friendship.days_with_trainer}</span>
        </div>
        <div className="stat-item">
          <span className="stat-label">互动次数</span>
          <span className="stat-value">{friendship.total_interactions}</span>
        </div>
      </div>
    </div>
  );
};

export default FriendshipPanel;
```

### 5. 单元测试

```javascript
// backend/tests/unit/friendship.test.js

const friendshipService = require('../../services/pokemon-service/src/friendshipService');
const { Pool } = require('pg');

jest.mock('pg');
jest.mock('ioredis');

describe('FriendshipService', () => {
  let mockDb;
  
  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      connect: jest.fn()
    };
    friendshipService.db = mockDb;
  });

  describe('calculateFriendshipLevel', () => {
    test('should return "stranger" for value 0-49', () => {
      expect(friendshipService.calculateFriendshipLevel(0)).toBe('stranger');
      expect(friendshipService.calculateFriendshipLevel(25)).toBe('stranger');
      expect(friendshipService.calculateFriendshipLevel(49)).toBe('stranger');
    });

    test('should return "normal" for value 50-99', () => {
      expect(friendshipService.calculateFriendshipLevel(50)).toBe('normal');
      expect(friendshipService.calculateFriendshipLevel(75)).toBe('normal');
      expect(friendshipService.calculateFriendshipLevel(99)).toBe('normal');
    });

    test('should return "friendly" for value 100-149', () => {
      expect(friendshipService.calculateFriendshipLevel(100)).toBe('friendly');
      expect(friendshipService.calculateFriendshipLevel(125)).toBe('friendly');
      expect(friendshipService.calculateFriendshipLevel(149)).toBe('friendly');
    });

    test('should return "close" for value 150-199', () => {
      expect(friendshipService.calculateFriendshipLevel(150)).toBe('close');
      expect(friendshipService.calculateFriendshipLevel(175)).toBe('close');
      expect(friendshipService.calculateFriendshipLevel(199)).toBe('close');
    });

    test('should return "beloved" for value 200-255', () => {
      expect(friendshipService.calculateFriendshipLevel(200)).toBe('beloved');
      expect(friendshipService.calculateFriendshipLevel(255)).toBe('beloved');
    });
  });

  describe('calculateBattleBonuses', () => {
    test('should return zero bonuses for low friendship', () => {
      const bonuses = friendshipService.calculateBattleBonuses(50);
      expect(bonuses.critBonus).toBe(0);
      expect(bonuses.evasionBonus).toBe(0);
      expect(bonuses.persistChance).toBe(0);
    });

    test('should return 5% bonuses for friendly level', () => {
      const bonuses = friendshipService.calculateBattleBonuses(100);
      expect(bonuses.critBonus).toBe(0.05);
      expect(bonuses.evasionBonus).toBe(0.05);
      expect(bonuses.persistChance).toBe(0.05);
    });

    test('should return 7% bonuses for close level', () => {
      const bonuses = friendshipService.calculateBattleBonuses(150);
      expect(bonuses.critBonus).toBe(0.07);
      expect(bonuses.evasionBonus).toBe(0.07);
      expect(bonuses.persistChance).toBe(0.07);
    });

    test('should return 10% bonuses for beloved level', () => {
      const bonuses = friendshipService.calculateBattleBonuses(220);
      expect(bonuses.critBonus).toBe(0.10);
      expect(bonuses.evasionBonus).toBe(0.10);
      expect(bonuses.persistChance).toBe(0.10);
    });
  });

  describe('modifyFriendship', () => {
    test('should increase friendship value', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ friendship_value: 100 }] })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({}),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      
      const result = await friendshipService.modifyFriendship(1, 10, 'massage');
      
      expect(result.before).toBe(100);
      expect(result.after).toBe(110);
      expect(result.change).toBe(10);
    });

    test('should not exceed 255', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ friendship_value: 250 }] })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({}),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      
      const result = await friendshipService.modifyFriendship(1, 20, 'spa');
      
      expect(result.after).toBe(255);
    });

    test('should not go below 0', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [{ friendship_value: 5 }] })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({}),
        release: jest.fn()
      };
      
      mockDb.connect.mockResolvedValue(mockClient);
      
      const result = await friendshipService.modifyFriendship(1, -10, 'faint');
      
      expect(result.after).toBe(0);
    });
  });

  describe('checkFriendshipEvolution', () => {
    test('should return canEvolve true when friendship is high enough', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ 
          friendship_value: 230,
          species_id: 133 
        }] })
        .mockResolvedValueOnce({ rows: [{ 
          evolution_species_id: 196,
          required_friendship: 220,
          time_condition: 'day',
          evolution_name: '太阳伊布'
        }] });
      
      const result = await friendshipService.checkFriendshipEvolution(1, 'user1');
      
      expect(result.canEvolve).toBe(true);
      expect(result.evolutionName).toBe('太阳伊布');
    });

    test('should return canEvolve false when friendship is too low', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ 
          friendship_value: 150,
          species_id: 133 
        }] })
        .mockResolvedValueOnce({ rows: [{ 
          evolution_species_id: 196,
          required_friendship: 220
        }] });
      
      const result = await friendshipService.checkFriendshipEvolution(1, 'user1');
      
      expect(result.canEvolve).toBe(false);
      expect(result.reason).toBe('friendship_too_low');
    });
  });
});
```

## 验收标准

- [ ] 精灵好感度数值系统正确实现（0-255范围）
- [ ] 好感度等级系统正确计算（陌生/一般/友好/亲密/挚爱）
- [ ] 好感度提升途径全部实现（战斗、道具、行走、按摩、露营、喂食）
- [ ] 好感度降低因素正确处理（晕倒、药草、交易、闲置）
- [ ] 亲密度进化规则正确配置（至少8种精灵）
- [ ] 战斗加成正确计算（暴击率、回避率、坚持几率）
- [ ] API 端点完整实现（好感度查询、互动、进化检查、进化执行）
- [ ] 前端组件正确展示好感度面板
- [ ] 单元测试覆盖率达到 80% 以上
- [ ] 数据库迁移脚本正确执行
- [ ] Prometheus 指标正确记录

## 影响范围

- **数据库**：新增 pokemon_friendship、friendship_history、friendship_evolution_rules、friendship_interaction_config 表
- **pokemon-service**：新增 friendshipService.js、routes/friendship.js
- **catch-service**：捕获时初始化好感度
- **reward-service**：新增友谊相关奖励
- **game-client**：新增 FriendshipPanel.js 组件
- **gateway**：路由转发配置

## 参考

- 宝可梦好感度机制: https://bulbapedia.bulbagarden.net/wiki/Friendship
- 亲密度进化列表: https://www.serebii.net/pokedex-swsh/friendship.shtml
- 好感度战斗加成: https://game8.co/games/pokemon-scarlet-violet/archives/393666
