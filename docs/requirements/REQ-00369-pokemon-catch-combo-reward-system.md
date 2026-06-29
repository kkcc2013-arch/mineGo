# REQ-00369: 精灵捕捉连击奖励系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00369 |
| 标题 | 精灵捕捉连击奖励系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | catch-service、reward-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-29 16:00 UTC |

## 需求描述

### 背景
当前精灵捕捉系统缺乏对连续成功捕捉行为的激励，玩家在捕捉失败后没有动力继续尝试，也无法获得额外的成就感。引入捕捉连击奖励系统可以：
1. 激励玩家持续尝试捕捉精灵
2. 提供额外的奖励和成就感
3. 增加游戏趣味性和留存率
4. 创建新的社交话题（分享高连击记录）

### 目标
- 实现捕捉连击计数与追踪机制
- 设计多层次连击奖励体系
- 提供连击中断保护机制
- 实现连击排行榜与社交分享功能
- 确保系统性能与数据一致性

## 技术方案

### 1. 连击计数系统

#### 1.1 数据模型设计

```sql
-- 捕捉连击记录表
CREATE TABLE catch_combos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    current_combo INT NOT NULL DEFAULT 0,
    max_combo INT NOT NULL DEFAULT 0,
    last_catch_time TIMESTAMP WITH TIME ZONE,
    last_pokemon_id UUID,
    combo_multiplier DECIMAL(5,2) DEFAULT 1.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id)
);

-- 连击历史记录表
CREATE TABLE catch_combo_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    combo_count INT NOT NULL,
    pokemon_ids UUID[] NOT NULL,
    total_rewards JSONB NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ended_at TIMESTAMP WITH TIME ZONE NOT NULL,
    end_reason VARCHAR(50) NOT NULL, -- 'failed', 'timeout', 'manual_reset'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 连击奖励配置表
CREATE TABLE catch_combo_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    combo_threshold INT NOT NULL UNIQUE, -- 连击次数阈值
    reward_type VARCHAR(50) NOT NULL, -- 'coins', 'items', 'experience', 'premium'
    reward_amount INT NOT NULL,
    bonus_multiplier DECIMAL(5,2) DEFAULT 1.0,
    special_rewards JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_catch_combos_user ON catch_combos(user_id);
CREATE INDEX idx_catch_combos_max ON catch_combos(max_combo DESC);
CREATE INDEX idx_catch_combo_history_user ON catch_combo_history(user_id);
CREATE INDEX idx_catch_combo_history_combo ON catch_combo_history(combo_count DESC);
```

#### 1.2 连击管理器（catch-service）

```javascript
// backend/services/catch-service/src/combo/CatchComboManager.js

const { v4: uuidv4 } = require('uuid');

class CatchComboManager {
  constructor({ db, redis, eventEmitter, rewardManager }) {
    this.db = db;
    this.redis = redis;
    this.eventEmitter = eventEmitter;
    this.rewardManager = rewardManager;
    this.comboTimeout = parseInt(process.env.COMBO_TIMEOUT_MINUTES) || 30;
  }

  /**
   * 处理捕捉成功，更新连击
   */
  async handleCatchSuccess(userId, pokemonId, catchData) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取当前连击状态
      const comboResult = await client.query(
        `SELECT * FROM catch_combos WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      
      let combo = comboResult.rows[0];
      const now = new Date();
      
      if (!combo) {
        // 创建新连击记录
        const insertResult = await client.query(
          `INSERT INTO catch_combos (user_id, current_combo, max_combo, last_catch_time, last_pokemon_id)
           VALUES ($1, 1, 1, $2, $3)
           RETURNING *`,
          [userId, now, pokemonId]
        );
        combo = insertResult.rows[0];
      } else {
        // 检查是否超时
        const lastCatchTime = new Date(combo.last_catch_time);
        const timeDiff = (now - lastCatchTime) / (1000 * 60); // 分钟
        
        let newCombo;
        if (timeDiff > this.comboTimeout) {
          // 超时，重置连击
          newCombo = 1;
        } else {
          // 增加连击
          newCombo = combo.current_combo + 1;
        }
        
        const maxCombo = Math.max(combo.max_combo, newCombo);
        
        const updateResult = await client.query(
          `UPDATE catch_combos 
           SET current_combo = $1, max_combo = $2, last_catch_time = $3, 
               last_pokemon_id = $4, updated_at = $5
           WHERE user_id = $6
           RETURNING *`,
          [newCombo, maxCombo, now, pokemonId, now, userId]
        );
        combo = updateResult.rows[0];
      }
      
      // 计算连击奖励
      const rewards = await this.calculateComboRewards(combo.current_combo);
      
      // 应用奖励
      if (Object.keys(rewards).length > 0) {
        await this.rewardManager.applyRewards(userId, rewards, 'catch_combo', client);
      }
      
      // 更新 Redis 缓存
      await this.updateComboCache(userId, combo);
      
      // 发布事件
      this.eventEmitter.emit('catch.combo.updated', {
        userId,
        comboCount: combo.current_combo,
        maxCombo: combo.max_combo,
        rewards,
        pokemonId
      });
      
      // 检查里程碑
      await this.checkMilestones(userId, combo.current_combo, client);
      
      await client.query('COMMIT');
      
      return {
        combo: combo.current_combo,
        maxCombo: combo.max_combo,
        rewards,
        isNewRecord: combo.current_combo === combo.max_combo
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 处理捕捉失败，中断连击
   */
  async handleCatchFailure(userId, reason = 'failed') {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      const comboResult = await client.query(
        `SELECT * FROM catch_combos WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      
      const combo = comboResult.rows[0];
      
      if (!combo || combo.current_combo === 0) {
        await client.query('COMMIT');
        return { broken: false };
      }
      
      // 保存连击历史
      await client.query(
        `INSERT INTO catch_combo_history 
         (user_id, combo_count, pokemon_ids, total_rewards, started_at, ended_at, end_reason)
         SELECT $1, $2, 
                ARRAY(SELECT pokemon_id FROM catches WHERE user_id = $1 AND created_at > $3),
                $4, $3, NOW(), $5`,
        [userId, combo.current_combo, combo.last_catch_time, '{}', reason]
      );
      
      // 重置连击
      await client.query(
        `UPDATE catch_combos 
         SET current_combo = 0, last_catch_time = NULL, last_pokemon_id = NULL, updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      
      // 清除缓存
      await this.clearComboCache(userId);
      
      // 发布事件
      this.eventEmitter.emit('catch.combo.broken', {
        userId,
        previousCombo: combo.current_combo,
        maxCombo: combo.max_combo,
        reason
      });
      
      await client.query('COMMIT');
      
      return {
        broken: true,
        previousCombo: combo.current_combo,
        reason
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 计算连击奖励
   */
  async calculateComboRewards(comboCount) {
    const rewards = {};
    
    // 基础奖励配置
    const rewardConfigs = await this.db.query(
      `SELECT * FROM catch_combo_rewards 
       WHERE combo_threshold <= $1 
       ORDER BY combo_threshold DESC 
       LIMIT 1`,
      [comboCount]
    );
    
    if (rewardConfigs.rows.length === 0) {
      return rewards;
    }
    
    const config = rewardConfigs.rows[0];
    
    // 计算奖励倍率
    const baseMultiplier = 1 + (comboCount * 0.1); // 每次连击增加10%
    const finalMultiplier = Math.min(baseMultiplier * config.bonus_multiplier, 5.0); // 最高5倍
    
    // 基础奖励
    switch (config.reward_type) {
      case 'coins':
        rewards.coins = Math.floor(config.reward_amount * finalMultiplier);
        break;
      case 'experience':
        rewards.experience = Math.floor(config.reward_amount * finalMultiplier);
        break;
      case 'items':
        rewards.items = config.special_rewards || [];
        break;
      case 'premium':
        rewards.premium = Math.floor(config.reward_amount * finalMultiplier);
        break;
    }
    
    // 里程碑奖励
    const milestoneRewards = this.getMilestoneRewards(comboCount);
    Object.assign(rewards, milestoneRewards);
    
    return rewards;
  }

  /**
   * 获取里程碑奖励
   */
  getMilestoneRewards(comboCount) {
    const milestones = {
      10: { specialItem: 'lucky_egg', amount: 1 },
      25: { specialItem: 'rare_candy', amount: 1 },
      50: { specialItem: 'golden_razz_berry', amount: 3 },
      100: { specialItem: 'master_ball_fragment', amount: 1 },
      200: { specialItem: 'legendary_lure', amount: 1 },
      500: { specialItem: 'shiny_charm', amount: 1 }
    };
    
    return milestones[comboCount] || {};
  }

  /**
   * 检查并触发里程碑
   */
  async checkMilestones(userId, comboCount, client) {
    const milestoneValues = [10, 25, 50, 100, 200, 500];
    
    if (milestoneValues.includes(comboCount)) {
      this.eventEmitter.emit('catch.combo.milestone', {
        userId,
        milestone: comboCount,
        timestamp: new Date()
      });
      
      // 发送通知
      // await this.notificationService.sendMilestoneNotification(userId, comboCount);
    }
  }

  /**
   * 更新 Redis 缓存
   */
  async updateComboCache(userId, combo) {
    const key = `catch:combo:${userId}`;
    await this.redis.hset(key, {
      current: combo.current_combo,
      max: combo.max_combo,
      lastCatch: combo.last_catch_time || '',
      lastPokemon: combo.last_pokemon_id || ''
    });
    await this.redis.expire(key, 86400); // 24小时过期
  }

  /**
   * 清除缓存
   */
  async clearComboCache(userId) {
    await this.redis.del(`catch:combo:${userId}`);
  }

  /**
   * 获取用户连击状态
   */
  async getComboStatus(userId) {
    // 先查缓存
    const cached = await this.redis.hgetall(`catch:combo:${userId}`);
    
    if (cached && cached.current) {
      return {
        currentCombo: parseInt(cached.current),
        maxCombo: parseInt(cached.max),
        lastCatchTime: cached.lastCatch || null,
        lastPokemonId: cached.lastPokemon || null
      };
    }
    
    // 查数据库
    const result = await this.db.query(
      `SELECT * FROM catch_combos WHERE user_id = $1`,
      [userId]
    );
    
    if (result.rows.length === 0) {
      return {
        currentCombo: 0,
        maxCombo: 0,
        lastCatchTime: null,
        lastPokemonId: null
      };
    }
    
    const combo = result.rows[0];
    
    // 更新缓存
    await this.updateComboCache(userId, combo);
    
    return {
      currentCombo: combo.current_combo,
      maxCombo: combo.max_combo,
      lastCatchTime: combo.last_catch_time,
      lastPokemonId: combo.last_pokemon_id
    };
  }

  /**
   * 获取连击排行榜
   */
  async getComboLeaderboard(limit = 100) {
    const cacheKey = 'catch:combo:leaderboard';
    
    // 尝试从缓存获取
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }
    
    // 查询数据库
    const result = await this.db.query(
      `SELECT cc.user_id, cc.max_combo, cc.current_combo, u.username, u.avatar
       FROM catch_combos cc
       JOIN users u ON cc.user_id = u.id
       ORDER BY cc.max_combo DESC
       LIMIT $1`,
      [limit]
    );
    
    const leaderboard = result.rows.map((row, index) => ({
      rank: index + 1,
      userId: row.user_id,
      username: row.username,
      avatar: row.avatar,
      maxCombo: row.max_combo,
      currentCombo: row.current_combo
    }));
    
    // 缓存5分钟
    await this.redis.setex(cacheKey, 300, JSON.stringify(leaderboard));
    
    return leaderboard;
  }

  /**
   * 使用连击保护道具
   */
  async useComboProtection(userId, itemId) {
    // 检查玩家是否有该道具
    const hasItem = await this.inventoryManager.hasItem(userId, itemId);
    
    if (!hasItem) {
      throw new Error('Insufficient items');
    }
    
    // 消耗道具
    await this.inventoryManager.consumeItem(userId, itemId, 1);
    
    // 设置保护状态（Redis）
    const protectionKey = `catch:combo:protection:${userId}`;
    await this.redis.setex(protectionKey, 3600, '1'); // 1小时保护
    
    this.eventEmitter.emit('catch.combo.protected', {
      userId,
      itemId,
      duration: 3600
    });
    
    return { protected: true, duration: 3600 };
  }
}

module.exports = CatchComboManager;
```

### 2. 连击奖励配置系统

```javascript
// backend/services/catch-service/src/combo/ComboRewardConfig.js

const DEFAULT_COMBO_REWARDS = [
  {
    combo_threshold: 5,
    reward_type: 'experience',
    reward_amount: 100,
    bonus_multiplier: 1.0
  },
  {
    combo_threshold: 10,
    reward_type: 'coins',
    reward_amount: 50,
    bonus_multiplier: 1.2,
    special_rewards: [{ item: 'lucky_egg', amount: 1 }]
  },
  {
    combo_threshold: 20,
    reward_type: 'coins',
    reward_amount: 100,
    bonus_multiplier: 1.5,
    special_rewards: [{ item: 'razz_berry', amount: 3 }]
  },
  {
    combo_threshold: 50,
    reward_type: 'coins',
    reward_amount: 500,
    bonus_multiplier: 2.0,
    special_rewards: [
      { item: 'golden_razz_berry', amount: 3 },
      { item: 'rare_candy', amount: 1 }
    ]
  },
  {
    combo_threshold: 100,
    reward_type: 'coins',
    reward_amount: 2000,
    bonus_multiplier: 3.0,
    special_rewards: [
      { item: 'master_ball_fragment', amount: 1 },
      { item: 'legendary_lure', amount: 1 }
    ]
  },
  {
    combo_threshold: 200,
    reward_type: 'premium',
    reward_amount: 100,
    bonus_multiplier: 3.5,
    special_rewards: [
      { item: 'shiny_charm', amount: 1 },
      { item: 'star_piece', amount: 5 }
    ]
  },
  {
    combo_threshold: 500,
    reward_type: 'premium',
    reward_amount: 500,
    bonus_multiplier: 4.0,
    special_rewards: [
      { item: 'master_ball', amount: 1 },
      { item: 'legendary_ticket', amount: 1 }
    ]
  }
];

class ComboRewardConfig {
  constructor(db) {
    this.db = db;
    this.configCache = null;
    this.cacheExpiry = 0;
  }

  async initialize() {
    // 检查是否已初始化
    const existing = await this.db.query(
      'SELECT COUNT(*) FROM catch_combo_rewards'
    );
    
    if (parseInt(existing.rows[0].count) > 0) {
      return;
    }
    
    // 插入默认配置
    for (const config of DEFAULT_COMBO_REWARDS) {
      await this.db.query(
        `INSERT INTO catch_combo_rewards 
         (combo_threshold, reward_type, reward_amount, bonus_multiplier, special_rewards)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          config.combo_threshold,
          config.reward_type,
          config.reward_amount,
          config.bonus_multiplier,
          JSON.stringify(config.special_rewards || [])
        ]
      );
    }
  }

  async getConfig() {
    const now = Date.now();
    
    if (this.configCache && now < this.cacheExpiry) {
      return this.configCache;
    }
    
    const result = await this.db.query(
      'SELECT * FROM catch_combo_rewards ORDER BY combo_threshold ASC'
    );
    
    this.configCache = result.rows;
    this.cacheExpiry = now + 60000; // 1分钟缓存
    
    return this.configCache;
  }

  async updateConfig(comboThreshold, updates) {
    const setClause = [];
    const values = [comboThreshold];
    let paramIndex = 2;
    
    if (updates.reward_type !== undefined) {
      setClause.push(`reward_type = $${paramIndex++}`);
      values.push(updates.reward_type);
    }
    
    if (updates.reward_amount !== undefined) {
      setClause.push(`reward_amount = $${paramIndex++}`);
      values.push(updates.reward_amount);
    }
    
    if (updates.bonus_multiplier !== undefined) {
      setClause.push(`bonus_multiplier = $${paramIndex++}`);
      values.push(updates.bonus_multiplier);
    }
    
    if (updates.special_rewards !== undefined) {
      setClause.push(`special_rewards = $${paramIndex++}`);
      values.push(JSON.stringify(updates.special_rewards));
    }
    
    if (setClause.length === 0) {
      return;
    }
    
    await this.db.query(
      `UPDATE catch_combo_rewards SET ${setClause.join(', ')} WHERE combo_threshold = $1`,
      values
    );
    
    // 清除缓存
    this.configCache = null;
  }
}

module.exports = ComboRewardConfig;
```

### 3. API 端点

```javascript
// backend/services/catch-service/src/routes/combo.js

const express = require('express');
const router = express.Router();
const { authenticate } = require('../../../shared/middleware/auth');
const CatchComboManager = require('../combo/CatchComboManager');

// 获取当前连击状态
router.get('/status', authenticate, async (req, res) => {
  try {
    const comboManager = req.app.locals.comboManager;
    const status = await comboManager.getComboStatus(req.user.id);
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Get combo status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取连击排行榜
router.get('/leaderboard', async (req, res) => {
  try {
    const comboManager = req.app.locals.comboManager;
    const limit = parseInt(req.query.limit) || 100;
    
    const leaderboard = await comboManager.getComboLeaderboard(limit);
    
    res.json({
      success: true,
      data: leaderboard
    });
  } catch (error) {
    console.error('Get combo leaderboard error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取连击历史
router.get('/history', authenticate, async (req, res) => {
  try {
    const { db } = req.app.locals;
    const limit = parseInt(req.query.limit) || 20;
    
    const result = await db.query(
      `SELECT * FROM catch_combo_history 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [req.user.id, limit]
    );
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Get combo history error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 使用连击保护道具
router.post('/protection', authenticate, async (req, res) => {
  try {
    const { itemId } = req.body;
    const comboManager = req.app.locals.comboManager;
    
    const result = await comboManager.useComboProtection(req.user.id, itemId);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Use combo protection error:', error);
    res.status(400).json({ error: error.message });
  }
});

// 手动重置连击
router.post('/reset', authenticate, async (req, res) => {
  try {
    const comboManager = req.app.locals.comboManager;
    
    const result = await comboManager.handleCatchFailure(req.user.id, 'manual_reset');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Reset combo error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

### 4. 前端集成

```javascript
// frontend/game-client/src/combo/ComboManager.js

import { EventEmitter } from 'events';

class ComboManager extends EventEmitter {
  constructor(api) {
    super();
    this.api = api;
    this.currentCombo = 0;
    this.maxCombo = 0;
    this.lastCatchTime = null;
    this.comboTimer = null;
    this.warningThreshold = 5 * 60 * 1000; // 5分钟警告
  }

  async init() {
    try {
      const response = await this.api.get('/catch/combo/status');
      if (response.success) {
        this.currentCombo = response.data.currentCombo;
        this.maxCombo = response.data.maxCombo;
        this.lastCatchTime = response.data.lastCatchTime;
        
        this.startComboTimer();
        this.emit('initialized', response.data);
      }
    } catch (error) {
      console.error('Failed to init combo:', error);
    }
  }

  startComboTimer() {
    if (this.comboTimer) {
      clearInterval(this.comboTimer);
    }
    
    this.comboTimer = setInterval(() => {
      if (!this.lastCatchTime) return;
      
      const elapsed = Date.now() - new Date(this.lastCatchTime).getTime();
      const remaining = (30 * 60 * 1000) - elapsed; // 30分钟超时
      
      if (remaining <= this.warningThreshold && remaining > 0) {
        this.emit('warning', {
          remainingMinutes: Math.ceil(remaining / 60000),
          currentCombo: this.currentCombo
        });
      }
      
      if (remaining <= 0) {
        this.emit('timeout', { currentCombo: this.currentCombo });
        this.resetCombo();
      }
    }, 60000); // 每分钟检查一次
  }

  async onCatchSuccess(pokemonId, rewards) {
    this.currentCombo++;
    if (this.currentCombo > this.maxCombo) {
      this.maxCombo = this.currentCombo;
      this.emit('newRecord', this.currentCombo);
    }
    this.lastCatchTime = new Date();
    
    this.emit('increment', {
      combo: this.currentCombo,
      maxCombo: this.maxCombo,
      pokemonId,
      rewards
    });
    
    // 检查里程碑
    this.checkMilestone(this.currentCombo);
    
    // 重启计时器
    this.startComboTimer();
  }

  onCatchFailure() {
    const previousCombo = this.currentCombo;
    this.resetCombo();
    
    this.emit('broken', {
      previousCombo,
      maxCombo: this.maxCombo
    });
  }

  resetCombo() {
    this.currentCombo = 0;
    this.lastCatchTime = null;
    
    if (this.comboTimer) {
      clearInterval(this.comboTimer);
      this.comboTimer = null;
    }
  }

  checkMilestone(combo) {
    const milestones = [10, 25, 50, 100, 200, 500];
    
    if (milestones.includes(combo)) {
      this.emit('milestone', { combo, milestone: combo });
    }
  }

  async useProtectionItem(itemId) {
    try {
      const response = await this.api.post('/catch/combo/protection', { itemId });
      
      if (response.success) {
        this.emit('protected', { itemId, duration: response.data.duration });
      }
      
      return response;
    } catch (error) {
      console.error('Failed to use protection item:', error);
      throw error;
    }
  }

  async getLeaderboard(limit = 100) {
    try {
      const response = await this.api.get(`/catch/combo/leaderboard?limit=${limit}`);
      return response.data;
    } catch (error) {
      console.error('Failed to get leaderboard:', error);
      return [];
    }
  }

  formatComboForDisplay(combo) {
    if (combo < 10) return `${combo}x`;
    if (combo < 50) return `${combo}x Combo!`;
    if (combo < 100) return `🔥 ${combo}x Super Combo!`;
    if (combo < 200) return `💥 ${combo}x Ultra Combo!`;
    return `🌟 ${combo}x LEGENDARY COMBO!`;
  }

  getComboColor(combo) {
    if (combo < 10) return '#FFFFFF';
    if (combo < 50) return '#4CAF50';
    if (combo < 100) return '#2196F3';
    if (combo < 200) return '#9C27B0';
    return '#FFD700';
  }
}

export default ComboManager;
```

### 5. UI 组件

```javascript
// frontend/game-client/src/components/ComboDisplay.js

import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import ComboManager from '../combo/ComboManager';

const ComboDisplay = ({ comboManager }) => {
  const [combo, setCombo] = useState(0);
  const [scaleAnim] = useState(new Animated.Value(1));
  const [colorAnim] = useState(new Animated.Value(0));

  useEffect(() => {
    const handleIncrement = ({ combo: newCombo }) => {
      setCombo(newCombo);
      
      // 动画效果
      Animated.sequence([
        Animated.timing(scaleAnim, {
          toValue: 1.3,
          duration: 150,
          useNativeDriver: true
        }),
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true
        })
      ]).start();
    };
    
    const handleBroken = () => {
      setCombo(0);
    };
    
    comboManager.on('increment', handleIncrement);
    comboManager.on('broken', handleBroken);
    
    return () => {
      comboManager.off('increment', handleIncrement);
      comboManager.off('broken', handleBroken);
    };
  }, [comboManager]);

  if (combo === 0) return null;

  const color = comboManager.getComboColor(combo);

  return (
    <Animated.View 
      style={[
        styles.container, 
        { transform: [{ scale: scaleAnim }] }
      ]}
    >
      <Text style={[styles.comboText, { color }]}>
        {comboManager.formatComboForDisplay(combo)}
      </Text>
      {combo >= 10 && (
        <Text style={styles.bonusText}>
          +{Math.floor(combo * 10)}% Bonus
        </Text>
      )}
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 100,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100
  },
  comboText: {
    fontSize: 28,
    fontWeight: 'bold',
    textShadowColor: 'rgba(0, 0, 0, 0.75)',
    textShadowOffset: { width: -1, height: 1 },
    textShadowRadius: 10
  },
  bonusText: {
    fontSize: 14,
    color: '#FFD700',
    marginTop: 5
  }
});

export default ComboDisplay;
```

## 验收标准

- [ ] 连击计数正确，捕捉成功时递增，失败时重置
- [ ] 连击超时机制生效（30分钟无捕捉自动重置）
- [ ] 连击奖励按配置正确发放
- [ ] 里程碑达成时触发特殊奖励和通知
- [ ] 连击排行榜实时更新且数据准确
- [ ] 连击保护道具功能正常
- [ ] 前端连击显示动画流畅
- [ ] 连击状态跨设备同步
- [ ] 连击历史记录完整保存
- [ ] 性能测试：10000并发捕捉请求响应时间 < 200ms
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试通过所有场景

## 影响范围

- catch-service: 添加连击管理器和相关路由
- reward-service: 集成连击奖励发放
- user-service: 用户统计数据更新
- gateway: 添加连击相关路由代理
- game-client: 添加连击 UI 和交互
- database/migrations: 新增连击相关表

## 参考

- Pokémon GO Catch Combo 机制
- 游戏设计模式：激励系统
- REQ-00010: GPS 伪造检测与反作弊系统
- REQ-00112: 精灵技能冷却与能量系统
