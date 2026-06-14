# REQ-00183: 精灵道具合成与配方系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00183 |
| 标题 | 精灵道具合成与配方系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、reward-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-14 04:30 |

## 需求描述

实现精灵道具合成系统，允许玩家使用基础材料合成高级道具、技能机器、进化石、特殊药剂等。系统支持配方发现、批量合成、合成成功率与暴击机制，为玩家提供更深度的资源管理与策略玩法。

### 核心功能
1. **配方管理**：定义道具合成配方，包含材料需求、合成时间、成功率、产出数量
2. **合成队列**：支持多道具并行合成，可查看合成进度与完成时间
3. **配方发现**：通过探索、任务、成就解锁新配方
4. **暴击系统**：合成时有概率获得双倍产出或稀有道具
5. **批量合成**：VIP玩家可批量合成同类型道具

## 技术方案

### 1. 数据库模型设计

```sql
-- 合成配方表
CREATE TABLE crafting_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipe_key VARCHAR(100) NOT NULL UNIQUE,
    name_i18n JSONB NOT NULL DEFAULT '{}',
    category VARCHAR(50) NOT NULL, -- consumable, tm, evolution_item, special
    required_items JSONB NOT NULL, -- [{"item_id": "potion_small", "quantity": 3}, ...]
    output_item_id VARCHAR(100) NOT NULL,
    output_quantity INT DEFAULT 1,
    crafting_time_seconds INT NOT NULL DEFAULT 60,
    success_rate DECIMAL(5,2) DEFAULT 100.00,
    crit_rate DECIMAL(5,2) DEFAULT 5.00, -- 暴击率
    crit_bonus TEXT DEFAULT 'double_output', -- double_output, rare_item, extra_quantity
    unlock_conditions JSONB, -- {"type": "achievement", "id": "craft_novice"}
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 玩家合成队列表
CREATE TABLE player_crafting_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id UUID NOT NULL REFERENCES crafting_recipes(id),
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, crafting, completed, failed
    started_at TIMESTAMP,
    completes_at TIMESTAMP,
    result JSONB, -- {"success": true, "items": [...], "crit": false}
    created_at TIMESTAMP DEFAULT NOW()
);

-- 玩家已解锁配方表
CREATE TABLE player_unlocked_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id UUID NOT NULL REFERENCES crafting_recipes(id),
    unlocked_at TIMESTAMP DEFAULT NOW(),
    unlock_source VARCHAR(50), -- tutorial, achievement, exploration, purchase
    UNIQUE(user_id, recipe_id)
);

-- 索引
CREATE INDEX idx_crafting_queue_user_status ON player_crafting_queue(user_id, status);
CREATE INDEX idx_crafting_queue_completes ON player_crafting_queue(completes_at) WHERE status = 'crafting';
CREATE INDEX idx_unlocked_recipes_user ON player_unlocked_recipes(user_id);
```

### 2. pokemon-service 合成服务实现

```javascript
// backend/services/pokemon-service/src/craftingService.js

const { db } = require('../db');
const { v4: uuidv4 } = require('uuid');

class CraftingService {
  constructor() {
    this.maxQueueSlots = 3; // 默认合成队列槽位
    this.vipBonusSlots = 2;
  }

  /**
   * 获取玩家可用的合成配方列表
   */
  async getAvailableRecipes(userId) {
    const result = await db.query(`
      SELECT r.*, 
        CASE WHEN ur.id IS NOT NULL THEN true ELSE false END as is_unlocked,
        ur.unlock_source
      FROM crafting_recipes r
      LEFT JOIN player_unlocked_recipes ur ON r.id = ur.recipe_id AND ur.user_id = $1
      WHERE r.is_active = true
      ORDER BY r.category, r.name_i18n->>'en'
    `, [userId]);
    
    return result.rows;
  }

  /**
   * 检查配方解锁条件
   */
  async checkUnlockCondition(userId, recipe) {
    if (!recipe.unlock_conditions) return true;
    
    const conditions = recipe.unlock_conditions;
    
    switch (conditions.type) {
      case 'achievement': {
        const achResult = await db.query(
          'SELECT 1 FROM user_achievements WHERE user_id = $1 AND achievement_id = $2',
          [userId, conditions.id]
        );
        return achResult.rows.length > 0;
      }
      case 'level': {
        const userResult = await db.query(
          'SELECT level FROM users WHERE id = $1',
          [userId]
        );
        return userResult.rows[0]?.level >= conditions.value;
      }
      case 'item': {
        const hasItem = await this.inventoryService.hasItem(
          userId, 
          conditions.item_id, 
          conditions.quantity || 1
        );
        return hasItem;
      }
      default:
        return true;
    }
  }

  /**
   * 开始合成道具
   */
  async startCrafting(userId, recipeKey, quantity = 1) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取配方信息
      const recipeResult = await client.query(
        'SELECT * FROM crafting_recipes WHERE recipe_key = $1 AND is_active = true',
        [recipeKey]
      );
      
      if (recipeResult.rows.length === 0) {
        throw new Error('RECIPE_NOT_FOUND');
      }
      
      const recipe = recipeResult.rows[0];
      
      // 2. 检查配方是否已解锁
      const unlockedResult = await client.query(
        'SELECT 1 FROM player_unlocked_recipes WHERE user_id = $1 AND recipe_id = $2',
        [userId, recipe.id]
      );
      
      if (unlockedResult.rows.length === 0) {
        // 尝试检查是否满足解锁条件
        const canUnlock = await this.checkUnlockCondition(userId, recipe);
        if (!canUnlock) {
          throw new Error('RECIPE_LOCKED');
        }
        
        // 自动解锁
        await client.query(
          'INSERT INTO player_unlocked_recipes (user_id, recipe_id, unlock_source) VALUES ($1, $2, $3)',
          [userId, recipe.id, 'auto']
        );
      }
      
      // 3. 检查队列槽位
      const queueResult = await client.query(
        'SELECT COUNT(*) FROM player_crafting_queue WHERE user_id = $1 AND status IN ($2, $3)',
        [userId, 'pending', 'crafting']
      );
      
      const maxSlots = await this.getMaxQueueSlots(userId);
      if (parseInt(queueResult.rows[0].count) >= maxSlots) {
        throw new Error('QUEUE_FULL');
      }
      
      // 4. 检查并扣除材料
      for (const material of recipe.required_items) {
        const consumed = await this.inventoryService.consumeItem(
          userId,
          material.item_id,
          material.quantity * quantity,
          client
        );
        
        if (!consumed) {
          throw new Error(`INSUFFICIENT_MATERIAL:${material.item_id}`);
        }
      }
      
      // 5. 创建合成任务
      const craftingTime = recipe.crafting_time_seconds * quantity;
      const now = new Date();
      const completesAt = new Date(now.getTime() + craftingTime * 1000);
      
      const insertResult = await client.query(`
        INSERT INTO player_crafting_queue 
        (user_id, recipe_id, status, started_at, completes_at)
        VALUES ($1, $2, 'crafting', $3, $4)
        RETURNING *
      `, [userId, recipe.id, now, completesAt]);
      
      await client.query('COMMIT');
      
      return {
        success: true,
        queueItem: insertResult.rows[0],
        recipe: recipe,
        completesAt: completesAt.toISOString()
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 完成合成并领取奖励
   */
  async completeCrafting(userId, queueId) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取合成任务
      const queueResult = await client.query(`
        SELECT cq.*, cr.output_item_id, cr.output_quantity, cr.success_rate, 
               cr.crit_rate, cr.crit_bonus
        FROM player_crafting_queue cq
        JOIN crafting_recipes cr ON cq.recipe_id = cr.id
        WHERE cq.id = $1 AND cq.user_id = $2 AND cq.status = 'crafting'
      `, [queueId, userId]);
      
      if (queueResult.rows.length === 0) {
        throw new Error('CRAFTING_NOT_FOUND');
      }
      
      const task = queueResult.rows[0];
      
      // 2. 检查是否已完成
      if (new Date() < new Date(task.completes_at)) {
        throw new Error('CRAFTING_IN_PROGRESS');
      }
      
      // 3. 计算合成结果
      const isSuccess = Math.random() * 100 < task.success_rate;
      const isCrit = isSuccess && Math.random() * 100 < task.crit_rate;
      
      let resultItems = [];
      
      if (isSuccess) {
        let outputQuantity = task.output_quantity;
        let bonusType = null;
        
        if (isCrit) {
          switch (task.crit_bonus) {
            case 'double_output':
              outputQuantity *= 2;
              bonusType = 'double_output';
              break;
            case 'extra_quantity':
              outputQuantity += Math.ceil(task.output_quantity * 0.5);
              bonusType = 'extra_quantity';
              break;
            case 'rare_item':
              // 额外获得稀有物品
              resultItems.push({
                item_id: `${task.output_item_id}_rare`,
                quantity: 1,
                is_bonus: true
              });
              bonusType = 'rare_item';
              break;
          }
        }
        
        resultItems.push({
          item_id: task.output_item_id,
          quantity: outputQuantity,
          is_crit: isCrit,
          crit_type: bonusType
        });
        
        // 添加物品到背包
        for (const item of resultItems) {
          await this.inventoryService.addItem(userId, item.item_id, item.quantity, client);
        }
      }
      
      // 4. 更新任务状态
      await client.query(
        'UPDATE player_crafting_queue SET status = $1, result = $2 WHERE id = $3',
        [isSuccess ? 'completed' : 'failed', 
         JSON.stringify({ success: isSuccess, items: resultItems, crit: isCrit }),
         queueId]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        craftSuccess: isSuccess,
        isCrit: isCrit,
        items: resultItems,
        message: isSuccess ? 
          (isCrit ? 'crafting.crit_success' : 'crafting.success') : 
          'crafting.failed'
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取玩家最大队列槽位
   */
  async getMaxQueueSlots(userId) {
    const result = await db.query(
      'SELECT is_vip FROM users WHERE id = $1',
      [userId]
    );
    
    const isVip = result.rows[0]?.is_vip || false;
    return this.maxQueueSlots + (isVip ? this.vipBonusSlots : 0);
  }

  /**
   * 加速合成（使用道具）
   */
  async speedUpCrafting(userId, queueId, speedUpItemId) {
    const client = await db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取合成任务
      const queueResult = await client.query(
        'SELECT * FROM player_crafting_queue WHERE id = $1 AND user_id = $2 AND status = $3',
        [queueId, userId, 'crafting']
      );
      
      if (queueResult.rows.length === 0) {
        throw new Error('CRAFTING_NOT_FOUND');
      }
      
      // 2. 检查加速道具
      const speedUpItem = await this.inventoryService.getItem(speedUpItemId);
      if (!speedUpItem || speedUpItem.speed_up_seconds === undefined) {
        throw new Error('INVALID_SPEED_UP_ITEM');
      }
      
      // 3. 消耗加速道具
      const consumed = await this.inventoryService.consumeItem(
        userId, speedUpItemId, 1, client
      );
      
      if (!consumed) {
        throw new Error('INSUFFICIENT_SPEED_UP_ITEM');
      }
      
      // 4. 更新完成时间
      const task = queueResult.rows[0];
      const newCompletesAt = new Date(
        Math.max(new Date(), 
        new Date(task.completes_at) - speedUpItem.speed_up_seconds * 1000)
      );
      
      await client.query(
        'UPDATE player_crafting_queue SET completes_at = $1 WHERE id = $2',
        [newCompletesAt, queueId]
      );
      
      await client.query('COMMIT');
      
      return {
        success: true,
        newCompletesAt: newCompletesAt.toISOString()
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = new CraftingService();
```

### 3. API 路由设计

```javascript
// backend/services/pokemon-service/src/routes/crafting.js

const express = require('express');
const router = express.Router();
const craftingService = require('../craftingService');
const { authMiddleware } = require('../middleware/auth');

/**
 * GET /crafting/recipes
 * 获取所有可用配方
 */
router.get('/recipes', authMiddleware, async (req, res) => {
  try {
    const recipes = await craftingService.getAvailableRecipes(req.user.id);
    res.json({ success: true, data: recipes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /crafting/start
 * 开始合成道具
 */
router.post('/start', authMiddleware, async (req, res) => {
  try {
    const { recipeKey, quantity = 1 } = req.body;
    const result = await craftingService.startCrafting(req.user.id, recipeKey, quantity);
    res.json(result);
  } catch (error) {
    const status = error.message.includes('NOT_FOUND') ? 404 : 
                   error.message.includes('INSUFFICIENT') ? 400 : 500;
    res.status(status).json({ success: false, error: error.message });
  }
});

/**
 * POST /crafting/complete/:queueId
 * 完成合成并领取奖励
 */
router.post('/complete/:queueId', authMiddleware, async (req, res) => {
  try {
    const result = await craftingService.completeCrafting(req.user.id, req.params.queueId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /crafting/queue
 * 获取玩家合成队列
 */
router.get('/queue', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT cq.*, cr.name_i18n, cr.output_item_id, cr.crafting_time_seconds
      FROM player_crafting_queue cq
      JOIN crafting_recipes cr ON cq.recipe_id = cr.id
      WHERE cq.user_id = $1 AND cq.status IN ('pending', 'crafting')
      ORDER BY cq.completes_at ASC
    `, [req.user.id]);
    
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /crafting/speed-up
 * 加速合成
 */
router.post('/speed-up', authMiddleware, async (req, res) => {
  try {
    const { queueId, speedUpItemId } = req.body;
    const result = await craftingService.speedUpCrafting(req.user.id, queueId, speedUpItemId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 4. 前端合成界面组件

```javascript
// frontend/game-client/src/components/CraftingPanel.js

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './CraftingPanel.css';

export function CraftingPanel({ userId, onClose }) {
  const { t } = useTranslation();
  const [recipes, setRecipes] = useState([]);
  const [queue, setQueue] = useState([]);
  const [selectedRecipe, setSelectedRecipe] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadRecipes();
    loadQueue();
    
    // 定时刷新队列状态
    const interval = setInterval(loadQueue, 1000);
    return () => clearInterval(interval);
  }, [userId]);

  const loadRecipes = async () => {
    const response = await fetch('/api/pokemon/crafting/recipes', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    const data = await response.json();
    if (data.success) {
      setRecipes(data.data);
    }
  };

  const loadQueue = async () => {
    const response = await fetch('/api/pokemon/crafting/queue', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    const data = await response.json();
    if (data.success) {
      setQueue(data.data);
    }
  };

  const startCrafting = async (recipeKey, quantity = 1) => {
    setLoading(true);
    try {
      const response = await fetch('/api/pokemon/crafting/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({ recipeKey, quantity })
      });
      
      const data = await response.json();
      
      if (data.success) {
        await loadQueue();
        setSelectedRecipe(null);
      } else {
        alert(t(data.error));
      }
    } finally {
      setLoading(false);
    }
  };

  const completeCrafting = async (queueId) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/pokemon/crafting/complete/${queueId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      
      const data = await response.json();
      
      if (data.success) {
        if (data.isCrit) {
          // 显示暴击特效
          showCritAnimation(data.crit_type);
        }
        await loadQueue();
        await loadRecipes();
      }
    } finally {
      setLoading(false);
    }
  };

  const formatTimeRemaining = (completesAt) => {
    const remaining = new Date(completesAt) - new Date();
    if (remaining <= 0) return t('crafting.ready');
    
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="crafting-panel">
      <div className="crafting-header">
        <h2>{t('crafting.title')}</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      
      <div className="crafting-content">
        {/* 合成队列 */}
        <div className="crafting-queue">
          <h3>{t('crafting.queue')} ({queue.length}/3)</h3>
          {queue.map(item => (
            <div key={item.id} className="queue-item">
              <div className="item-info">
                <span className="item-name">{item.name_i18n?.[i18n.language] || item.name_i18n?.en}</span>
                <span className="item-time">{formatTimeRemaining(item.completes_at)}</span>
              </div>
              {new Date() >= new Date(item.completes_at) && (
                <button 
                  className="complete-btn"
                  onClick={() => completeCrafting(item.id)}
                  disabled={loading}
                >
                  {t('crafting.claim')}
                </button>
              )}
            </div>
          ))}
          {queue.length === 0 && (
            <p className="empty-queue">{t('crafting.empty_queue')}</p>
          )}
        </div>
        
        {/* 配方列表 */}
        <div className="recipe-list">
          <h3>{t('crafting.recipes')}</h3>
          <div className="recipe-categories">
            {['consumable', 'tm', 'evolution_item', 'special'].map(category => (
              <button key={category} className="category-btn">
                {t(`crafting.category.${category}`)}
              </button>
            ))}
          </div>
          
          <div className="recipes-grid">
            {recipes.map(recipe => (
              <div 
                key={recipe.id}
                className={`recipe-card ${recipe.is_unlocked ? '' : 'locked'}`}
                onClick={() => recipe.is_unlocked && setSelectedRecipe(recipe)}
              >
                <div className="recipe-icon">
                  <img src={`/assets/items/${recipe.output_item_id}.png`} alt="" />
                </div>
                <div className="recipe-name">
                  {recipe.name_i18n?.[i18n.language] || recipe.name_i18n?.en}
                </div>
                {!recipe.is_unlocked && (
                  <div className="lock-overlay">🔒</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      
      {/* 配方详情弹窗 */}
      {selectedRecipe && (
        <RecipeDetailModal
          recipe={selectedRecipe}
          onCraft={startCrafting}
          onClose={() => setSelectedRecipe(null)}
          loading={loading}
        />
      )}
    </div>
  );
}
```

### 5. 定时任务处理合成完成

```javascript
// backend/jobs/craftingCompletionJob.js

const { db } = require('../shared/db');
const EventEmitter = require('events');

class CraftingCompletionJob extends EventEmitter {
  constructor() {
    super();
    this.interval = null;
  }

  start() {
    // 每分钟检查一次
    this.interval = setInterval(() => this.processCompletedCrafting(), 60000);
    console.log('Crafting completion job started');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async processCompletedCrafting() {
    try {
      // 查找已完成但未处理的合成任务
      const result = await db.query(`
        SELECT cq.*, u.id as user_id
        FROM player_crafting_queue cq
        JOIN users u ON cq.user_id = u.id
        WHERE cq.status = 'crafting'
        AND cq.completes_at <= NOW()
        LIMIT 100
      `);

      for (const task of result.rows) {
        this.emit('craftingCompleted', {
          userId: task.user_id,
          queueId: task.id
        });

        // 发送推送通知
        // await pushNotificationService.send(task.user_id, {
        //   type: 'crafting_complete',
        //   title: 'crafting.notification.title',
        //   body: 'crafting.notification.body'
        // });
      }
    } catch (error) {
      console.error('Crafting completion job error:', error);
    }
  }
}

module.exports = new CraftingCompletionJob();
```

## 验收标准

- [ ] 玩家可以查看所有可用配方（含解锁状态）
- [ ] 玩家可以消耗材料开始合成道具
- [ ] 合成队列正确显示合成进度
- [ ] 合成完成后可领取产出物品
- [ ] 成功率和暴击系统正常工作
- [ ] VIP玩家可获得额外队列槽位
- [ ] 可使用加速道具缩短合成时间
- [ ] 配方解锁条件检查正确
- [ ] 前端界面响应流畅，支持多语言
- [ ] 单元测试覆盖率 ≥ 80%

## 影响范围

- 新增数据库表：`crafting_recipes`, `player_crafting_queue`, `player_unlocked_recipes`
- 新增服务：`craftingService.js`
- 新增路由：`/api/pokemon/crafting/*`
- 新增前端组件：`CraftingPanel.js`, `RecipeDetailModal.js`
- 修改背包系统：支持合成材料消耗和产出物品添加
- 新增定时任务：合成完成检查

## 参考

- [游戏道具系统设计最佳实践](https://game-design.org/crafting)
- [ Crafting 系统架构模式](https://microservices.io/patterns/data/saga.html)
- REQ-00047: 精灵道具与背包管理系统
