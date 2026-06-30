# REQ-00390: 精灵合并进化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00390 |
| 标题 | 精灵合并进化系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-30 17:00 |

## 需求描述

实现精灵合并进化系统，允许玩家将多只同类型精灵合并为更高级别或稀有形态的精灵。该系统通过消耗特定材料和精灵个体，提供一种全新的精灵获取途径，增加游戏策略深度和玩法多样性。

### 核心功能
1. **合并配方系统**：预定义的合并配方，指定所需精灵种类、数量、等级要求和产出结果
2. **材料消耗机制**：合并时消耗参与合并的精灵和可选的辅助材料
3. **成功率系统**：基于精灵品质、等级、幸运值计算合并成功率
4. **稀有变异机制**：小概率触发变异，产生超出预期的稀有精灵
5. **合并历史记录**：记录玩家的合并历史，支持统计分析

### 业务价值
- 提供精灵处理的新途径，增加游戏策略性
- 激励玩家收集和培育普通精灵
- 增强游戏内容的长期可玩性
- 创造新的社交话题和玩家互动

## 技术方案

### 1. 数据库设计

#### 1.1 合并配方表 (merge_recipes)
```sql
CREATE TABLE merge_recipes (
    id SERIAL PRIMARY KEY,
    recipe_code VARCHAR(50) UNIQUE NOT NULL,
    name_i18n JSONB NOT NULL,
    description_i18n JSONB,
    required_pokemon JSONB NOT NULL, -- [{pokemon_id: int, min_level: int, count: int}]
    required_items JSONB, -- [{item_id: int, count: int}]
    output_pokemon_id INTEGER NOT NULL,
    output_min_level INTEGER DEFAULT 1,
    output_level_variance INTEGER DEFAULT 5,
    base_success_rate DECIMAL(5,2) DEFAULT 70.00,
    variant_pokemon_id INTEGER, -- 变异产出
    variant_rate DECIMAL(5,2) DEFAULT 0.00,
    duration_seconds INTEGER DEFAULT 300,
    is_active BOOLEAN DEFAULT true,
    unlock_conditions JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_merge_recipes_active ON merge_recipes(is_active) WHERE is_active = true;
CREATE INDEX idx_merge_recipes_output ON merge_recipes(output_pokemon_id);
```

#### 1.2 合并记录表 (merge_records)
```sql
CREATE TABLE merge_records (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    recipe_id INTEGER REFERENCES merge_recipes(id),
    input_pokemon JSONB NOT NULL, -- [{pokemon_instance_id: int, pokemon_id: int, level: int}]
    input_items JSONB,
    output_pokemon_instance_id BIGINT,
    output_pokemon_id INTEGER,
    output_level INTEGER,
    is_variant BOOLEAN DEFAULT false,
    success BOOLEAN NOT NULL,
    lucky_bonus DECIMAL(5,2) DEFAULT 0.00,
    merged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_merge_records_user ON merge_records(user_id);
CREATE INDEX idx_merge_records_time ON merge_records(merged_at);
CREATE INDEX idx_merge_records_success ON merge_records(success);
```

#### 1.3 合并队列表 (merge_queue)
```sql
CREATE TABLE merge_queue (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    recipe_id INTEGER REFERENCES merge_recipes(id),
    input_pokemon_instance_ids BIGINT[] NOT NULL,
    input_item_ids INTEGER[],
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completes_at TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'pending', -- pending, completed, cancelled
    result_data JSONB,
    processed_at TIMESTAMP
);

CREATE INDEX idx_merge_queue_user_status ON merge_queue(user_id, status);
CREATE INDEX idx_merge_queue_completes ON merge_queue(completes_at) WHERE status = 'pending';
```

### 2. 后端实现

#### 2.1 合并服务核心类 (MergeService.js)
```javascript
// backend/services/pokemon/src/merge/MergeService.js
const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

class MergeService {
  constructor(config) {
    this.db = new Pool(config.database);
    this.redis = new Redis(config.redis);
    this.cache = new Map(); // 配方缓存
    this.loadRecipes();
  }

  /**
   * 加载所有激活的合并配方到缓存
   */
  async loadRecipes() {
    const result = await this.db.query(`
      SELECT * FROM merge_recipes WHERE is_active = true
    `);
    
    this.cache.clear();
    result.rows.forEach(recipe => {
      this.cache.set(recipe.recipe_code, recipe);
      this.cache.set(recipe.id, recipe);
    });
  }

  /**
   * 获取可用的合并配方列表
   * @param {number} userId - 用户ID
   * @param {number} pokemonId - 可选，筛选特定精灵的配方
   */
  async getAvailableRecipes(userId, pokemonId = null) {
    const cacheKey = `recipes:user:${userId}:${pokemonId || 'all'}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const recipes = [];
    for (const [id, recipe] of this.cache) {
      if (typeof id === 'number') {
        // 检查解锁条件
        const unlocked = await this.checkUnlockConditions(userId, recipe);
        if (unlocked) {
          if (!pokemonId || this.recipeUsesPokemon(recipe, pokemonId)) {
            recipes.push({
              id: recipe.id,
              recipe_code: recipe.recipe_code,
              name: recipe.name_i18n,
              description: recipe.description_i18n,
              required_pokemon: recipe.required_pokemon,
              required_items: recipe.required_items,
              output_pokemon_id: recipe.output_pokemon_id,
              base_success_rate: recipe.base_success_rate,
              duration_seconds: recipe.duration_seconds,
              has_variant: recipe.variant_pokemon_id !== null
            });
          }
        }
      }
    }

    await this.redis.setex(cacheKey, 300, JSON.stringify(recipes));
    return recipes;
  }

  /**
   * 检查配方是否使用指定精灵
   */
  recipeUsesPokemon(recipe, pokemonId) {
    return recipe.required_pokemon.some(req => req.pokemon_id === pokemonId);
  }

  /**
   * 检查用户是否满足配方解锁条件
   */
  async checkUnlockConditions(userId, recipe) {
    if (!recipe.unlock_conditions) return true;

    const conditions = recipe.unlock_conditions;
    
    // 检查玩家等级
    if (conditions.min_player_level) {
      const user = await this.db.query(
        'SELECT level FROM users WHERE id = $1',
        [userId]
      );
      if (!user.rows[0] || user.rows[0].level < conditions.min_player_level) {
        return false;
      }
    }

    // 检查图鉴完成度
    if (conditions.min_pokedex_count) {
      const pokedex = await this.db.query(
        'SELECT COUNT(DISTINCT pokemon_id) as count FROM user_pokedex WHERE user_id = $1',
        [userId]
      );
      if (pokedex.rows[0].count < conditions.min_pokedex_count) {
        return false;
      }
    }

    // 检查前置配方完成次数
    if (conditions.predecessor_recipe && conditions.predecessor_count) {
      const completed = await this.db.query(
        `SELECT COUNT(*) as count FROM merge_records 
         WHERE user_id = $1 AND recipe_id = $2 AND success = true`,
        [userId, conditions.predecessor_recipe]
      );
      if (completed.rows[0].count < conditions.predecessor_count) {
        return false;
      }
    }

    return true;
  }

  /**
   * 验证合并请求
   */
  async validateMergeRequest(userId, recipeId, pokemonInstanceIds, itemIds = []) {
    const recipe = this.cache.get(recipeId);
    if (!recipe) {
      throw new Error('INVALID_RECIPE');
    }

    // 获取参与合并的精灵实例
    const pokemonInstances = await this.db.query(
      `SELECT pi.id, pi.pokemon_id, pi.level, pi.is_favorite
       FROM pokemon_instances pi
       WHERE pi.id = ANY($1) AND pi.owner_id = $2`,
      [pokemonInstanceIds, userId]
    );

    if (pokemonInstances.rows.length !== pokemonInstanceIds.length) {
      throw new Error('INVALID_POKEMON_INSTANCES');
    }

    // 检查是否有收藏的精灵
    if (pokemonInstances.rows.some(p => p.is_favorite)) {
      throw new Error('CANNOT_MERGE_FAVORITE');
    }

    // 验证精灵要求
    const pokemonMap = new Map();
    pokemonInstances.rows.forEach(p => {
      pokemonMap.set(p.pokemon_id, (pokemonMap.get(p.pokemon_id) || 0) + 1);
    });

    for (const req of recipe.required_pokemon) {
      const available = pokemonMap.get(req.pokemon_id) || 0;
      if (available < req.count) {
        throw new Error(`INSUFFICIENT_POKEMON_${req.pokemon_id}`);
      }

      // 检查等级要求
      const matchingPokemon = pokemonInstances.rows.filter(
        p => p.pokemon_id === req.pokemon_id && p.level >= req.min_level
      );
      if (matchingPokemon.length < req.count) {
        throw new Error(`LEVEL_REQUIREMENT_NOT_MET_${req.pokemon_id}`);
      }
    }

    // 验证物品要求
    if (recipe.required_items && recipe.required_items.length > 0) {
      const items = await this.db.query(
        `SELECT item_id, quantity FROM user_items 
         WHERE user_id = $1 AND item_id = ANY($2)`,
        [userId, recipe.required_items.map(i => i.item_id)]
      );

      const itemMap = new Map(items.rows.map(i => [i.item_id, i.quantity]));
      
      for (const req of recipe.required_items) {
        const available = itemMap.get(req.item_id) || 0;
        if (available < req.count) {
          throw new Error(`INSUFFICIENT_ITEMS_${req.item_id}`);
        }
      }
    }

    return { recipe, pokemonInstances: pokemonInstances.rows };
  }

  /**
   * 执行合并操作
   */
  async performMerge(userId, recipeId, pokemonInstanceIds, itemIds = [], useLuckyBoost = false) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');

      // 验证请求
      const { recipe, pokemonInstances } = await this.validateMergeRequest(
        userId, recipeId, pokemonInstanceIds, itemIds
      );

      // 计算成功率
      let successRate = parseFloat(recipe.base_success_rate);
      
      // 精灵等级加成
      const avgLevel = pokemonInstances.reduce((sum, p) => sum + p.level, 0) / pokemonInstances.length;
      successRate += Math.min(avgLevel * 0.5, 15); // 最高 +15%

      // 幸运道具加成
      let luckyBonus = 0;
      if (useLuckyBoost) {
        // 扣除幸运道具
        const luckyItem = await client.query(
          `UPDATE user_items SET quantity = quantity - 1 
           WHERE user_id = $1 AND item_id = $2 AND quantity > 0
           RETURNING *`,
          [userId, 1001] // 假设 1001 是幸运道具ID
        );
        
        if (luckyItem.rows.length > 0) {
          luckyBonus = 10;
          successRate += luckyBonus;
        }
      }

      successRate = Math.min(successRate, 99);

      // 执行随机判定
      const roll = Math.random() * 100;
      const success = roll < successRate;

      // 判定是否变异
      let isVariant = false;
      if (success && recipe.variant_pokemon_id && recipe.variant_rate > 0) {
        isVariant = Math.random() * 100 < parseFloat(recipe.variant_rate);
      }

      // 删除参与合并的精灵
      await client.query(
        `DELETE FROM pokemon_instances WHERE id = ANY($1)`,
        [pokemonInstanceIds]
      );

      // 扣除物品
      if (recipe.required_items && recipe.required_items.length > 0) {
        for (const req of recipe.required_items) {
          await client.query(
            `UPDATE user_items SET quantity = quantity - $1 
             WHERE user_id = $2 AND item_id = $3`,
            [req.count, userId, req.item_id]
          );
        }
      }

      // 创建产出精灵（如果成功）
      let outputInstanceId = null;
      let outputPokemonId = null;
      let outputLevel = null;

      if (success) {
        outputPokemonId = isVariant ? recipe.variant_pokemon_id : recipe.output_pokemon_id;
        outputLevel = recipe.output_min_level + 
          Math.floor(Math.random() * recipe.output_level_variance);

        const insertResult = await client.query(
          `INSERT INTO pokemon_instances 
           (pokemon_id, owner_id, level, created_at, source)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 'merge')
           RETURNING id`,
          [outputPokemonId, userId, outputLevel]
        );

        outputInstanceId = insertResult.rows[0].id;

        // 更新图鉴
        await client.query(
          `INSERT INTO user_pokedex (user_id, pokemon_id, first_obtained_at, obtained_count)
           VALUES ($1, $2, CURRENT_TIMESTAMP, 1)
           ON CONFLICT (user_id, pokemon_id)
           DO UPDATE SET obtained_count = user_pokedex.obtained_count + 1`,
          [userId, outputPokemonId]
        );
      }

      // 记录合并历史
      await client.query(
        `INSERT INTO merge_records 
         (user_id, recipe_id, input_pokemon, input_items, output_pokemon_instance_id,
          output_pokemon_id, output_level, is_variant, success, lucky_bonus)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          userId,
          recipeId,
          JSON.stringify(pokemonInstances.map(p => ({
            pokemon_instance_id: p.id,
            pokemon_id: p.pokemon_id,
            level: p.level
          }))),
          JSON.stringify(recipe.required_items || []),
          outputInstanceId,
          outputPokemonId,
          outputLevel,
          isVariant,
          success,
          luckyBonus
        ]
      );

      // 发布合并事件
      await this.redis.publish('merge:completed', JSON.stringify({
        userId,
        recipeId,
        success,
        isVariant,
        outputPokemonId,
        timestamp: Date.now()
      }));

      await client.query('COMMIT');

      return {
        success,
        isVariant,
        outputInstanceId,
        outputPokemonId,
        outputLevel,
        successRate,
        luckyBonus
      };

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取用户合并历史
   */
  async getMergeHistory(userId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    
    const [records, totalResult] = await Promise.all([
      this.db.query(
        `SELECT mr.*, mr.name_i18n->>'en' as recipe_name
         FROM merge_records mr
         JOIN merge_recipes r ON mr.recipe_id = r.id
         WHERE mr.user_id = $1
         ORDER BY mr.merged_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
      ),
      this.db.query(
        'SELECT COUNT(*) as total FROM merge_records WHERE user_id = $1',
        [userId]
      )
    ]);

    return {
      records: records.rows,
      total: parseInt(totalResult.rows[0].total),
      page,
      totalPages: Math.ceil(totalResult.rows[0].total / limit)
    };
  }

  /**
   * 获取合并统计
   */
  async getMergeStatistics(userId) {
    const stats = await this.db.query(
      `SELECT 
         COUNT(*) as total_attempts,
         COUNT(*) FILTER (WHERE success = true) as successful,
         COUNT(*) FILTER (WHERE is_variant = true) as variants,
         AVG(lucky_bonus) as avg_lucky_bonus
       FROM merge_records 
       WHERE user_id = $1`,
      [userId]
    );

    const mostUsedRecipe = await this.db.query(
      `SELECT r.recipe_code, r.name_i18n, COUNT(*) as usage_count
       FROM merge_records mr
       JOIN merge_recipes r ON mr.recipe_id = r.id
       WHERE mr.user_id = $1
       GROUP BY r.recipe_code, r.name_i18n
       ORDER BY usage_count DESC
       LIMIT 5`,
      [userId]
    );

    return {
      ...stats.rows[0],
      mostUsedRecipes: mostUsedRecipe.rows
    };
  }
}

module.exports = MergeService;
```

#### 2.2 API 路由 (merge.routes.js)
```javascript
// backend/services/pokemon/src/routes/merge.routes.js
const express = require('express');
const router = express.Router();
const MergeService = require('../merge/MergeService');
const { authMiddleware } = require('../../../shared/auth');
const { rateLimitMiddleware } = require('../../../shared/middleware/rateLimit');

const mergeService = new MergeService(require('../../config'));

/**
 * 获取可用的合并配方
 */
router.get('/recipes', authMiddleware, async (req, res) => {
  try {
    const { pokemonId } = req.query;
    const recipes = await mergeService.getAvailableRecipes(
      req.user.id,
      pokemonId ? parseInt(pokemonId) : null
    );
    
    res.json({
      success: true,
      data: recipes
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 预览合并结果
 */
router.post('/preview', authMiddleware, async (req, res) => {
  try {
    const { recipeId, pokemonInstanceIds, itemIds } = req.body;
    
    const { recipe, pokemonInstances } = await mergeService.validateMergeRequest(
      req.user.id,
      recipeId,
      pokemonInstanceIds,
      itemIds
    );

    // 计算预览数据
    const avgLevel = pokemonInstances.reduce((sum, p) => sum + p.level, 0) / pokemonInstances.length;
    const estimatedSuccessRate = Math.min(
      parseFloat(recipe.base_success_rate) + Math.min(avgLevel * 0.5, 15),
      99
    );

    res.json({
      success: true,
      data: {
        recipe: {
          id: recipe.id,
          name: recipe.name_i18n,
          output_pokemon_id: recipe.output_pokemon_id,
          has_variant: recipe.variant_pokemon_id !== null
        },
        inputPokemon: pokemonInstances.map(p => ({
          id: p.id,
          pokemon_id: p.pokemon_id,
          level: p.level
        })),
        estimatedSuccessRate,
        duration: recipe.duration_seconds
      }
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 执行合并
 */
router.post('/execute', 
  authMiddleware, 
  rateLimitMiddleware({ windowMs: 60000, max: 10 }),
  async (req, res) => {
    try {
      const { recipeId, pokemonInstanceIds, itemIds, useLuckyBoost } = req.body;

      // 验证输入
      if (!Array.isArray(pokemonInstanceIds) || pokemonInstanceIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_INPUT'
        });
      }

      const result = await mergeService.performMerge(
        req.user.id,
        recipeId,
        pokemonInstanceIds,
        itemIds || [],
        useLuckyBoost || false
      );

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 获取合并历史
 */
router.get('/history', authMiddleware, async (req, res) => {
  try {
    const { page, limit } = req.query;
    const history = await mergeService.getMergeHistory(
      req.user.id,
      parseInt(page) || 1,
      parseInt(limit) || 20
    );
    
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取合并统计
 */
router.get('/statistics', authMiddleware, async (req, res) => {
  try {
    const stats = await mergeService.getMergeStatistics(req.user.id);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 3. 前端实现

#### 3.1 合并界面组件 (MergeCenter.jsx)
```jsx
// frontend/game-client/src/components/merge/MergeCenter.jsx
import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './MergeCenter.css';

const MergeCenter = ({ userId, onClose }) => {
  const { t } = useTranslation();
  const [recipes, setRecipes] = useState([]);
  const [selectedRecipe, setSelectedRecipe] = useState(null);
  const [selectedPokemon, setSelectedPokemon] = useState([]);
  const [userPokemon, setUserPokemon] = useState([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    loadRecipes();
    loadUserPokemon();
  }, [userId]);

  const loadRecipes = async () => {
    try {
      const response = await fetch('/api/pokemon/merge/recipes', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      if (data.success) {
        setRecipes(data.data);
      }
    } catch (error) {
      console.error('Failed to load recipes:', error);
    }
  };

  const loadUserPokemon = async () => {
    try {
      const response = await fetch('/api/pokemon/inventory', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      if (data.success) {
        setUserPokemon(data.data.filter(p => !p.is_favorite));
      }
      setLoading(false);
    } catch (error) {
      console.error('Failed to load pokemon:', error);
      setLoading(false);
    }
  };

  const handleSelectRecipe = (recipe) => {
    setSelectedRecipe(recipe);
    setSelectedPokemon([]);
    setResult(null);
  };

  const handleSelectPokemon = (pokemon) => {
    if (!selectedRecipe) return;

    const required = selectedRecipe.required_pokemon[0];
    const currentCount = selectedPokemon.filter(
      p => p.pokemon_id === required.pokemon_id
    ).length;

    if (selectedPokemon.find(p => p.id === pokemon.id)) {
      setSelectedPokemon(selectedPokemon.filter(p => p.id !== pokemon.id));
    } else if (currentCount < required.count) {
      setSelectedPokemon([...selectedPokemon, pokemon]);
    }
  };

  const canMerge = () => {
    if (!selectedRecipe) return false;
    
    for (const req of selectedRecipe.required_pokemon) {
      const count = selectedPokemon.filter(
        p => p.pokemon_id === req.pokemon_id && p.level >= req.min_level
      ).length;
      if (count < req.count) return false;
    }
    
    return true;
  };

  const handleMerge = async () => {
    if (!canMerge()) return;
    
    setMerging(true);
    setResult(null);

    try {
      const response = await fetch('/api/pokemon/merge/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify({
          recipeId: selectedRecipe.id,
          pokemonInstanceIds: selectedPokemon.map(p => p.id)
        })
      });

      const data = await response.json();
      
      if (data.success) {
        setResult(data.data);
        loadUserPokemon(); // 刷新用户精灵列表
        
        // 显示成功动画
        if (data.data.success) {
          showMergeSuccessAnimation(data.data);
        }
      }
    } catch (error) {
      console.error('Merge failed:', error);
    } finally {
      setMerging(false);
    }
  };

  const showMergeSuccessAnimation = (result) => {
    // 触发粒子效果
    const event = new CustomEvent('mergeSuccess', {
      detail: {
        isVariant: result.isVariant,
        pokemonId: result.outputPokemonId
      }
    });
    window.dispatchEvent(event);
  };

  if (loading) {
    return <div className="merge-center loading">{t('loading')}</div>;
  }

  return (
    <div className="merge-center">
      <div className="merge-header">
        <h2>{t('merge.title')}</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="merge-content">
        {/* 配方选择 */}
        <div className="recipes-section">
          <h3>{t('merge.selectRecipe')}</h3>
          <div className="recipes-grid">
            {recipes.map(recipe => (
              <div
                key={recipe.id}
                className={`recipe-card ${selectedRecipe?.id === recipe.id ? 'selected' : ''}`}
                onClick={() => handleSelectRecipe(recipe)}
              >
                <div className="recipe-icon">
                  <img 
                    src={`/assets/pokemon/${recipe.output_pokemon_id}.png`} 
                    alt={recipe.name.en}
                  />
                </div>
                <div className="recipe-name">{recipe.name.en}</div>
                <div className="recipe-rate">
                  {recipe.base_success_rate}% {t('merge.successRate')}
                </div>
                {recipe.has_variant && (
                  <div className="variant-badge">{t('merge.hasVariant')}</div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* 精灵选择 */}
        {selectedRecipe && (
          <div className="pokemon-selection-section">
            <h3>{t('merge.selectPokemon')}</h3>
            <div className="requirements-info">
              {selectedRecipe.required_pokemon.map((req, idx) => {
                const selected = selectedPokemon.filter(p => p.pokemon_id === req.pokemon_id);
                return (
                  <div key={idx} className="requirement">
                    <span>{t('merge.pokemonType', { id: req.pokemon_id })}</span>
                    <span>{selected.length} / {req.count}</span>
                    <span>({t('merge.minLevel')}: {req.min_level})</span>
                  </div>
                );
              })}
            </div>
            <div className="pokemon-grid">
              {userPokemon.map(pokemon => {
                const isRequired = selectedRecipe.required_pokemon.some(
                  req => req.pokemon_id === pokemon.pokemon_id
                );
                const meetsLevel = selectedRecipe.required_pokemon.some(
                  req => req.pokemon_id === pokemon.pokemon_id && 
                         pokemon.level >= req.min_level
                );
                
                return (
                  <div
                    key={pokemon.id}
                    className={`pokemon-card ${selectedPokemon.find(p => p.id === pokemon.id) ? 'selected' : ''} ${!isRequired ? 'disabled' : ''} ${!meetsLevel ? 'low-level' : ''}`}
                    onClick={() => handleSelectPokemon(pokemon)}
                  >
                    <img 
                      src={`/assets/pokemon/${pokemon.pokemon_id}.png`}
                      alt={`Pokemon ${pokemon.pokemon_id}`}
                    />
                    <div className="pokemon-level">Lv.{pokemon.level}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 合并按钮 */}
        {selectedRecipe && (
          <div className="merge-action">
            <button
              className="merge-btn"
              disabled={!canMerge() || merging}
              onClick={handleMerge}
            >
              {merging ? t('merge.merging') : t('merge.confirm')}
            </button>
          </div>
        )}

        {/* 合并结果 */}
        {result && (
          <div className={`merge-result ${result.success ? 'success' : 'fail'}`}>
            {result.success ? (
              <>
                <h3>{result.isVariant ? t('merge.variantSuccess') : t('merge.mergeSuccess')}</h3>
                <img 
                  src={`/assets/pokemon/${result.outputPokemonId}.png`}
                  alt="Result Pokemon"
                  className="result-pokemon"
                />
                <div className="result-level">Lv.{result.outputLevel}</div>
                <div className="result-rate">
                  {t('merge.actualRate')}: {result.successRate}%
                </div>
              </>
            ) : (
              <>
                <h3>{t('merge.mergeFailed')}</h3>
                <div className="fail-message">{t('merge.tryAgain')}</div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default MergeCenter;
```

#### 3.2 合并成功粒子效果 (MergeEffect.js)
```javascript
// frontend/game-client/src/effects/MergeEffect.js
import * as PIXI from 'pixi.js';

export class MergeEffect {
  constructor(app) {
    this.app = app;
    this.particles = [];
  }

  show(isVariant, pokemonId, x, y) {
    const particleCount = isVariant ? 100 : 50;
    const colors = isVariant 
      ? [0xFFD700, 0xFF69B4, 0x00FFFF] // 金色、粉色、青色
      : [0x4CAF50, 0x8BC34A, 0xCDDC39]; // 绿色系

    for (let i = 0; i < particleCount; i++) {
      const particle = new PIXI.Graphics();
      const color = colors[Math.floor(Math.random() * colors.length)];
      
      particle.beginFill(color);
      particle.drawCircle(0, 0, 3 + Math.random() * 5);
      particle.endFill();
      
      particle.x = x;
      particle.y = y;
      particle.alpha = 1;
      particle.scale.set(0.5 + Math.random() * 0.5);
      
      // 随机方向和速度
      const angle = Math.random() * Math.PI * 2;
      const speed = 2 + Math.random() * 4;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = Math.sin(angle) * speed;
      particle.life = 1;
      particle.decay = 0.01 + Math.random() * 0.02;
      
      this.app.stage.addChild(particle);
      this.particles.push(particle);
    }

    // 变异时添加光环效果
    if (isVariant) {
      this.addAuraEffect(x, y);
    }

    this.animate();
  }

  addAuraEffect(x, y) {
    const aura = new PIXI.Graphics();
    aura.lineStyle(3, 0xFFD700, 0.8);
    aura.drawCircle(0, 0, 0);
    aura.x = x;
    aura.y = y;
    aura.radius = 0;
    this.app.stage.addChild(aura);

    const expandAura = () => {
      aura.radius += 3;
      aura.clear();
      aura.lineStyle(3, 0xFFD700, 1 - aura.radius / 200);
      aura.drawCircle(0, 0, aura.radius);
      aura.alpha = 1 - aura.radius / 200;

      if (aura.radius < 200) {
        requestAnimationFrame(expandAura);
      } else {
        this.app.stage.removeChild(aura);
      }
    };
    expandAura();
  }

  animate() {
    const update = () => {
      let hasActiveParticles = false;

      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.1; // 重力
        p.life -= p.decay;
        p.alpha = p.life;
        p.scale.set(p.life);

        if (p.life <= 0) {
          this.app.stage.removeChild(p);
          this.particles.splice(i, 1);
        } else {
          hasActiveParticles = true;
        }
      }

      if (hasActiveParticles) {
        requestAnimationFrame(update);
      }
    };

    update();
  }
}
```

### 4. 测试用例

#### 4.1 单元测试 (merge.test.js)
```javascript
// backend/tests/unit/merge.test.js
const MergeService = require('../../services/pokemon/src/merge/MergeService');
const { Pool } = require('pg');
const Redis = require('ioredis');

jest.mock('pg');
jest.mock('ioredis');

describe('MergeService', () => {
  let mergeService;
  let mockDb;
  let mockRedis;

  beforeEach(() => {
    mockDb = {
      query: jest.fn(),
      connect: jest.fn()
    };
    mockRedis = {
      get: jest.fn(),
      setex: jest.fn(),
      publish: jest.fn()
    };

    Pool.mockImplementation(() => mockDb);
    Redis.mockImplementation(() => mockRedis);

    mergeService = new MergeService({
      database: {},
      redis: {}
    });
  });

  describe('validateMergeRequest', () => {
    it('should validate correct merge request', async () => {
      const recipe = {
        id: 1,
        required_pokemon: [{ pokemon_id: 25, count: 2, min_level: 10 }],
        required_items: null
      };
      
      mergeService.cache.set(1, recipe);

      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            { id: 101, pokemon_id: 25, level: 15, is_favorite: false },
            { id: 102, pokemon_id: 25, level: 12, is_favorite: false }
          ]
        });

      const result = await mergeService.validateMergeRequest(
        1, 1, [101, 102]
      );

      expect(result.recipe).toBeDefined();
      expect(result.pokemonInstances).toHaveLength(2);
    });

    it('should reject merge with favorite pokemon', async () => {
      const recipe = {
        id: 1,
        required_pokemon: [{ pokemon_id: 25, count: 1, min_level: 10 }]
      };
      
      mergeService.cache.set(1, recipe);

      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 101, pokemon_id: 25, level: 15, is_favorite: true }]
      });

      await expect(
        mergeService.validateMergeRequest(1, 1, [101])
      ).rejects.toThrow('CANNOT_MERGE_FAVORITE');
    });

    it('should reject insufficient pokemon count', async () => {
      const recipe = {
        id: 1,
        required_pokemon: [{ pokemon_id: 25, count: 3, min_level: 10 }]
      };
      
      mergeService.cache.set(1, recipe);

      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 101, pokemon_id: 25, level: 15, is_favorite: false },
          { id: 102, pokemon_id: 25, level: 12, is_favorite: false }
        ]
      });

      await expect(
        mergeService.validateMergeRequest(1, 1, [101, 102])
      ).rejects.toThrow('INSUFFICIENT_POKEMON_25');
    });
  });

  describe('performMerge', () => {
    it('should successfully merge pokemon', async () => {
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({
            rows: [
              { id: 101, pokemon_id: 25, level: 15, is_favorite: false },
              { id: 102, pokemon_id: 25, level: 12, is_favorite: false }
            ]
          }) // validate
          .mockResolvedValueOnce({ rows: [] }) // DELETE
          .mockResolvedValueOnce({ rows: [{ id: 201 }] }) // INSERT output
          .mockResolvedValueOnce({ rows: [] }) // pokedex
          .mockResolvedValueOnce({ rows: [] }), // record
        release: jest.fn()
      };

      mockDb.connect.mockResolvedValue(mockClient);

      const recipe = {
        id: 1,
        recipe_code: 'pikachu_merge',
        required_pokemon: [{ pokemon_id: 25, count: 2, min_level: 10 }],
        output_pokemon_id: 26,
        output_min_level: 1,
        output_level_variance: 5,
        base_success_rate: '70.00',
        variant_pokemon_id: null,
        required_items: null
      };
      
      mergeService.cache.set(1, recipe);
      mockRedis.publish = jest.fn();

      // Mock Math.random for predictable results
      const originalRandom = Math.random;
      Math.random = jest.fn()
        .mockReturnValueOnce(0.5) // success roll (50 < 70)
        .mockReturnValueOnce(0.5); // level calculation

      const result = await mergeService.performMerge(
        1, 1, [101, 102], [], false
      );

      expect(result.success).toBe(true);
      expect(result.outputPokemonId).toBe(26);

      Math.random = originalRandom;
    });
  });
});
```

## 验收标准

- [ ] 用户可以查看所有可用的合并配方
- [ ] 用户可以选择精灵进行合并预览
- [ ] 合并操作正确验证精灵等级、数量要求
- [ ] 合并成功时正确创建新精灵并删除参与精灵
- [ ] 合并失败时参与精灵被正确消耗
- [ ] 变异机制按配置概率触发
- [ ] 合并历史记录完整保存
- [ ] 合并统计数据准确展示
- [ ] 收藏的精灵无法参与合并
- [ ] 前端显示合并成功/失败动画效果
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] API 响应时间 < 500ms

## 影响范围

### 新增文件
- `backend/services/pokemon/src/merge/MergeService.js`
- `backend/services/pokemon/src/routes/merge.routes.js`
- `frontend/game-client/src/components/merge/MergeCenter.jsx`
- `frontend/game-client/src/effects/MergeEffect.js`
- `backend/tests/unit/merge.test.js`

### 数据库迁移
- `database/migrations/xxx_create_merge_tables.sql`

### 修改文件
- `backend/services/pokemon/src/index.js` - 注册合并路由
- `frontend/game-client/src/i18n/en.json` - 添加翻译键
- `frontend/game-client/src/i18n/zh-CN.json` - 添加翻译键

## 参考

- [宝可梦融合机制设计](https://bulbapedia.bulbagarden.net/wiki/Pokémon_fusion)
- [游戏概率系统设计模式](https://www.gamasutra.com/blogs/TylerGlaiel/20180417/316384/Probability_and_game_design.php)
- [React 粒子效果实现](https://pixijs.io/examples/#/demos-basic/container.js)
