# REQ-00110: 精灵背包容量管理与扩展系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00110 |
| 标题 | 精灵背包容量管理与扩展系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-11 11:00 |

## 需求描述

实现完整的精灵背包容量管理系统，包括初始容量限制、容量扩展机制、背包整理排序、过期预警通知等功能。该系统为玩家提供灵活的背包管理体验，同时为游戏经济系统提供消耗渠道。

### 核心目标
1. **容量限制**：初始 300 只精灵，最大 3000 只
2. **扩展机制**：金币/钻石购买、道具消耗、VIP 特权
3. **智能整理**：多种排序方式、批量操作、收藏标记
4. **预警机制**：容量预警、自动转箱、空间不足提醒
5. **数据治理**：不活跃精灵自动归档、批量转移

## 技术方案

### 1. 数据库设计

```sql
-- 背包容量配置表
CREATE TABLE bag_capacity_config (
    id SERIAL PRIMARY KEY,
    player_level_min INT NOT NULL,
    player_level_max INT,
    base_capacity INT NOT NULL DEFAULT 300,
    max_capacity INT NOT NULL DEFAULT 3000,
    expansion_unit INT NOT NULL DEFAULT 50,
    gold_cost_per_unit INT NOT NULL,
    diamond_cost_per_unit INT NOT NULL,
    vip_bonus_capacity JSONB DEFAULT '{}', -- {"vip1": 50, "vip2": 100, ...}
    created_at TIMESTAMP DEFAULT NOW()
);

-- 玩家背包容量表
CREATE TABLE player_bag_capacity (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    current_capacity INT NOT NULL DEFAULT 300,
    max_ever_purchased INT NOT NULL DEFAULT 0, -- 历史最大购买容量
    used_slots INT NOT NULL DEFAULT 0,
    bonus_capacity INT NOT NULL DEFAULT 0, -- VIP/活动赠送容量
    last_updated TIMESTAMP DEFAULT NOW(),
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 背包扩展历史表
CREATE TABLE bag_expansion_history (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    expansion_type VARCHAR(20) NOT NULL, -- 'gold', 'diamond', 'item', 'vip', 'event'
    units INT NOT NULL,
    capacity_before INT NOT NULL,
    capacity_after INT NOT NULL,
    cost_amount INT NOT NULL,
    cost_currency VARCHAR(20) NOT NULL,
    transaction_id VARCHAR(100),
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 背包预警配置表
CREATE TABLE bag_alert_config (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL UNIQUE,
    enable_alert BOOLEAN DEFAULT TRUE,
    alert_thresholds INT[] DEFAULT '{85, 90, 95, 99}', -- 容量百分比
    auto_transfer_to_storage BOOLEAN DEFAULT FALSE,
    auto_transfer_threshold INT DEFAULT 95,
    notification_method VARCHAR(20) DEFAULT 'push',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 精灵收藏标记表（扩展 pokemon 表）
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS is_favorited BOOLEAN DEFAULT FALSE;
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS favorite_at TIMESTAMP;
ALTER TABLE pokemon ADD COLUMN IF NOT EXISTS bag_sort_order INT DEFAULT 0;

-- 创建索引
CREATE INDEX idx_player_bag_capacity_user ON player_bag_capacity(user_id);
CREATE INDEX idx_bag_expansion_history_user ON bag_expansion_history(user_id, created_at DESC);
CREATE INDEX idx_pokemon_bag_sort ON pokemon(user_id, bag_sort_order);
CREATE INDEX idx_pokemon_favorited ON pokemon(user_id, is_favorited) WHERE is_favorited = TRUE;
```

### 2. 后端服务实现

#### 2.1 背包容量服务 (pokemon-service/src/bagCapacityService.js)

```javascript
const { db } = require('@shared/db');
const cache = require('@shared/cache');
const metrics = require('@shared/metrics');
const { transaction } = require('@shared/db/transaction');

class BagCapacityService {
  constructor() {
    this.CACHE_TTL = 300; // 5 分钟缓存
    this.CACHE_PREFIX = 'bag_capacity:';
  }

  /**
   * 获取玩家背包容量信息
   */
  async getBagCapacity(userId) {
    const cacheKey = `${this.CACHE_PREFIX}${userId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const result = await db.query(`
      SELECT 
        pbc.*,
        u.level as player_level,
        u.vip_level,
        COUNT(p.id) as actual_pokemon_count
      FROM player_bag_capacity pbc
      JOIN users u ON u.id = pbc.user_id
      LEFT JOIN pokemon p ON p.user_id = pbc.user_id AND p.is_released = FALSE
      WHERE pbc.user_id = $1
      GROUP BY pbc.id, u.level, u.vip_level
    `, [userId]);

    if (result.rows.length === 0) {
      // 初始化背包容量
      return await this.initializeBagCapacity(userId);
    }

    const data = result.rows[0];
    const capacityInfo = {
      currentCapacity: data.current_capacity,
      usedSlots: data.actual_pokemon_count,
      freeSlots: data.current_capacity - data.actual_pokemon_count,
      maxPurchased: data.max_ever_purchased,
      bonusCapacity: data.bonus_capacity,
      utilizationRate: (data.actual_pokemon_count / data.current_capacity) * 100,
      canExpand: data.current_capacity < this.getMaxCapacity(data.player_level),
      vipBonus: this.getVipBonus(data.vip_level)
    };

    await cache.set(cacheKey, capacityInfo, this.CACHE_TTL);
    return capacityInfo;
  }

  /**
   * 初始化玩家背包容量
   */
  async initializeBagCapacity(userId) {
    const user = await db.query('SELECT level, vip_level FROM users WHERE id = $1', [userId]);
    if (user.rows.length === 0) throw new Error('User not found');

    const playerLevel = user.rows[0].level;
    const vipLevel = user.rows[0].vip_level;
    const baseCapacity = await this.getBaseCapacity(playerLevel);
    const vipBonus = this.getVipBonus(vipLevel);

    const result = await db.query(`
      INSERT INTO player_bag_capacity (user_id, current_capacity, bonus_capacity)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE 
      SET current_capacity = EXCLUDED.current_capacity,
          bonus_capacity = EXCLUDED.bonus_capacity
      RETURNING *
    `, [userId, baseCapacity + vipBonus, vipBonus]);

    metrics.gauge('bag_capacity_initialized', baseCapacity + vipBonus, { userId });

    return {
      currentCapacity: result.rows[0].current_capacity,
      usedSlots: 0,
      freeSlots: result.rows[0].current_capacity,
      maxPurchased: 0,
      bonusCapacity: vipBonus,
      utilizationRate: 0,
      canExpand: true,
      vipBonus
    };
  }

  /**
   * 扩展背包容量
   */
  async expandBagCapacity(userId, options) {
    const { method = 'gold', units = 1 } = options;
    
    return await transaction(async (client) => {
      // 1. 获取当前容量
      const capacityInfo = await this.getBagCapacity(userId);
      if (!capacityInfo.canExpand) {
        throw new Error('Maximum capacity reached');
      }

      // 2. 计算扩展成本
      const cost = await this.calculateExpansionCost(userId, units, method);
      
      // 3. 验证并扣除货币
      const paymentResult = await this.processPayment(userId, cost, method, client);
      if (!paymentResult.success) {
        throw new Error(`Insufficient ${method}: need ${cost.amount}, have ${paymentResult.balance}`);
      }

      // 4. 更新容量
      const newCapacity = Math.min(
        capacityInfo.currentCapacity + units * 50,
        await this.getMaxCapacity(userId)
      );
      
      await client.query(`
        UPDATE player_bag_capacity 
        SET current_capacity = $1, 
            max_ever_purchased = GREATEST(max_ever_purchased, $2),
            last_updated = NOW()
        WHERE user_id = $3
      `, [newCapacity, newCapacity - capacityInfo.bonusCapacity, userId]);

      // 5. 记录历史
      await client.query(`
        INSERT INTO bag_expansion_history 
        (user_id, expansion_type, units, capacity_before, capacity_after, cost_amount, cost_currency)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [userId, method, units, capacityInfo.currentCapacity, newCapacity, cost.amount, cost.currency]);

      // 6. 清除缓存
      await cache.del(`${this.CACHE_PREFIX}${userId}`);

      // 7. 指标记录
      metrics.increment('bag_capacity_expanded', units * 50, { method, userId });
      metrics.increment('bag_expansion_revenue', cost.amount, { currency: cost.currency });

      return {
        success: true,
        previousCapacity: capacityInfo.currentCapacity,
        newCapacity,
        unitsAdded: units * 50,
        cost: cost.amount,
        currency: cost.currency
      };
    });
  }

  /**
   * 计算扩展成本
   */
  async calculateExpansionCost(userId, units, method) {
    const capacityInfo = await this.getBagCapacity(userId);
    const config = await this.getCapacityConfig(capacityInfo.currentCapacity);
    
    let baseCost;
    if (method === 'gold') {
      baseCost = config.gold_cost_per_unit * units;
    } else if (method === 'diamond') {
      baseCost = config.diamond_cost_per_unit * units;
    } else {
      throw new Error(`Invalid payment method: ${method}`);
    }

    // 阶梯价格（已购买越多越贵）
    const multiplier = 1 + (capacityInfo.maxPurchased / 500) * 0.5;
    
    return {
      amount: Math.floor(baseCost * multiplier),
      currency: method
    };
  }

  /**
   * 检查背包是否已满
   */
  async checkBagFull(userId, additionalSlots = 0) {
    const capacityInfo = await this.getBagCapacity(userId);
    const willBeFull = capacityInfo.usedSlots + additionalSlots >= capacityInfo.currentCapacity;
    const isAlmostFull = capacityInfo.utilizationRate >= 90;

    return {
      isFull: capacityInfo.usedSlots >= capacityInfo.currentCapacity,
      willBeFull,
      isAlmostFull,
      availableSlots: capacityInfo.freeSlots,
      utilizationRate: capacityInfo.utilizationRate
    };
  }

  /**
   * 批量精灵转移/释放
   */
  async batchTransferPokemon(userId, pokemonIds, action) {
    return await transaction(async (client) => {
      // 1. 验证精灵归属
      const pokemonResult = await client.query(`
        SELECT id, species_id, is_favorited 
        FROM pokemon 
        WHERE id = ANY($1) AND user_id = $2 AND is_released = FALSE
      `, [pokemonIds, userId]);

      if (pokemonResult.rows.length !== pokemonIds.length) {
        throw new Error('Some pokemon not found or already released');
      }

      // 2. 检查收藏精灵
      const favorited = pokemonResult.rows.filter(p => p.is_favorited);
      if (favorited.length > 0 && action === 'release') {
        throw new Error(`Cannot release favorited pokemon: ${favorited.map(p => p.id).join(', ')}`);
      }

      // 3. 执行操作
      if (action === 'release') {
        await client.query(`
          UPDATE pokemon 
          SET is_released = TRUE, released_at = NOW()
          WHERE id = ANY($1)
        `, [pokemonIds]);

        // 奖励糖果
        const candyReward = pokemonIds.length * 1;
        await client.query(`
          UPDATE users SET candy = candy + $1 WHERE id = $2
        `, [candyReward, userId]);

      } else if (action === 'transfer_to_storage') {
        await client.query(`
          UPDATE pokemon SET storage_status = 'storage' WHERE id = ANY($1)
        `, [pokemonIds]);
      }

      // 4. 更新使用容量
      await client.query(`
        UPDATE player_bag_capacity 
        SET used_slots = used_slots - $1, last_updated = NOW()
        WHERE user_id = $2
      `, [pokemonIds.length, userId]);

      // 5. 清除缓存
      await cache.del(`${this.CACHE_PREFIX}${userId}`);

      metrics.increment(`pokemon_${action}`, pokemonIds.length, { userId });

      return {
        success: true,
        affectedCount: pokemonIds.length,
        action,
        candyReward: action === 'release' ? candyReward : 0
      };
    });
  }

  /**
   * 设置收藏标记
   */
  async setFavorite(userId, pokemonId, isFavorited) {
    const result = await db.query(`
      UPDATE pokemon 
      SET is_favorited = $1, favorite_at = CASE WHEN $1 THEN NOW() ELSE NULL END
      WHERE id = $2 AND user_id = $3
      RETURNING id, is_favorited
    `, [isFavorited, pokemonId, userId]);

    if (result.rows.length === 0) {
      throw new Error('Pokemon not found');
    }

    metrics.increment('pokemon_favorite_toggle', 1, { action: isFavorited ? 'add' : 'remove' });
    return result.rows[0];
  }

  /**
   * 获取背包容量配置
   */
  async getCapacityConfig(currentCapacity) {
    const result = await db.query(`
      SELECT * FROM bag_capacity_config 
      WHERE $1 >= base_capacity 
      ORDER BY base_capacity DESC 
      LIMIT 1
    `, [currentCapacity]);
    
    return result.rows[0] || {
      gold_cost_per_unit: 200,
      diamond_cost_per_unit: 100
    };
  }

  getVipBonus(vipLevel) {
    const bonuses = { 1: 50, 2: 100, 3: 150, 4: 200, 5: 300 };
    return bonuses[vipLevel] || 0;
  }

  async getBaseCapacity(playerLevel) {
    // 每升 5 级 +10 容量
    return 300 + Math.floor(playerLevel / 5) * 10;
  }

  async getMaxCapacity(userId) {
    const user = await db.query('SELECT level FROM users WHERE id = $1', [userId]);
    const playerLevel = user.rows[0]?.level || 1;
    return Math.min(3000, 500 + Math.floor(playerLevel / 10) * 200);
  }
}

module.exports = new BagCapacityService();
```

#### 2.2 背包排序服务 (pokemon-service/src/bagSortService.js)

```javascript
const { db } = require('@shared/db');

class BagSortService {
  /**
   * 获取排序后的精灵列表
   */
  async getSortedPokemonList(userId, options = {}) {
    const {
      sortBy = 'recent', // recent, cp, iv, name, species, favorite, level
      sortOrder = 'desc',
      page = 1,
      limit = 30,
      filters = {}
    } = options;

    const offset = (page - 1) * limit;
    let orderBy = this.buildOrderBy(sortBy, sortOrder);
    let whereClause = this.buildWhereClause(filters);

    const result = await db.query(`
      SELECT 
        p.*,
        s.name as species_name,
        s.types,
        s.pokedex_number,
        CASE WHEN p.is_favorited THEN 0 ELSE 1 END as favorite_sort
      FROM pokemon p
      JOIN species s ON s.id = p.species_id
      WHERE p.user_id = $1 AND p.is_released = FALSE ${whereClause}
      ORDER BY favorite_sort, ${orderBy}
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    // 获取总数
    const countResult = await db.query(`
      SELECT COUNT(*) FROM pokemon 
      WHERE user_id = $1 AND is_released = FALSE ${whereClause}
    `, [userId]);

    return {
      pokemon: result.rows,
      pagination: {
        page,
        limit,
        total: parseInt(countResult.rows[0].count),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    };
  }

  /**
   * 批量设置排序顺序
   */
  async updateSortOrder(userId, pokemonIds) {
    await db.query(`
      UPDATE pokemon SET bag_sort_order = s.row_num
      FROM UNNEST($1::int[]) WITH ORDINALITY AS s(pokemon_id, row_num)
      WHERE pokemon.id = s.pokemon_id AND pokemon.user_id = $2
    `, [pokemonIds, userId]);

    return { success: true, updated: pokemonIds.length };
  }

  buildOrderBy(sortBy, sortOrder) {
    const sortMap = {
      recent: `p.created_at ${sortOrder.toUpperCase()}`,
      cp: `p.cp ${sortOrder.toUpperCase()}`,
      iv: `((p.iv_attack + p.iv_defense + p.iv_stamina)::float / 45) ${sortOrder.toUpperCase()}`,
      name: `s.name ${sortOrder.toUpperCase()}`,
      species: `s.pokedex_number ${sortOrder.toUpperCase()}`,
      favorite: `p.is_favorited DESC, p.favorite_at ${sortOrder.toUpperCase()}`,
      level: `p.level ${sortOrder.toUpperCase()}`
    };
    return sortMap[sortBy] || sortMap.recent;
  }

  buildWhereClause(filters) {
    const conditions = [];
    
    if (filters.type) {
      conditions.push(`$${filters.type} = ANY(s.types)`);
    }
    if (filters.minCp) {
      conditions.push(`p.cp >= ${filters.minCp}`);
    }
    if (filters.maxCp) {
      conditions.push(`p.cp <= ${filters.maxCp}`);
    }
    if (filters.minIv) {
      conditions.push(`((p.iv_attack + p.iv_defense + p.iv_stamina)::float / 45) >= ${filters.minIv}`);
    }
    if (filters.isShiny !== undefined) {
      conditions.push(`p.is_shiny = ${filters.isShiny}`);
    }
    if (filters.isLegendary !== undefined) {
      conditions.push(`s.is_legendary = ${filters.isLegendary}`);
    }

    return conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : '';
  }
}

module.exports = new BagSortService();
```

#### 2.3 API 路由 (pokemon-service/src/routes/bag.js)

```javascript
const express = require('express');
const router = express.Router();
const bagCapacityService = require('../bagCapacityService');
const bagSortService = require('../bagSortService');
const authMiddleware = require('@shared/middleware/auth');
const { body, query, param, validationResult } = require('express-validator');

// 获取背包容量信息
router.get('/capacity', authMiddleware, async (req, res) => {
  try {
    const capacityInfo = await bagCapacityService.getBagCapacity(req.user.id);
    res.json({ success: true, data: capacityInfo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 检查背包是否已满
router.get('/check-full', authMiddleware, async (req, res) => {
  try {
    const { additional = 0 } = req.query;
    const result = await bagCapacityService.checkBagFull(req.user.id, parseInt(additional));
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 扩展背包容量
router.post('/expand', 
  authMiddleware,
  [
    body('method').isIn(['gold', 'diamond']),
    body('units').isInt({ min: 1, max: 10 })
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const result = await bagCapacityService.expandBagCapacity(req.user.id, req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 获取扩展成本预览
router.get('/expansion-cost', authMiddleware, async (req, res) => {
  try {
    const { units = 1, method = 'gold' } = req.query;
    const cost = await bagCapacityService.calculateExpansionCost(
      req.user.id, 
      parseInt(units), 
      method
    );
    res.json({ success: true, data: cost });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取排序后的精灵列表
router.get('/pokemon', authMiddleware, async (req, res) => {
  try {
    const result = await bagSortService.getSortedPokemonList(req.user.id, {
      sortBy: req.query.sortBy,
      sortOrder: req.query.sortOrder,
      page: parseInt(req.query.page) || 1,
      limit: parseInt(req.query.limit) || 30,
      filters: req.query.filters ? JSON.parse(req.query.filters) : {}
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 批量转移/释放精灵
router.post('/batch-action',
  authMiddleware,
  [
    body('pokemonIds').isArray({ min: 1, max: 100 }),
    body('action').isIn(['release', 'transfer_to_storage'])
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const result = await bagCapacityService.batchTransferPokemon(
        req.user.id,
        req.body.pokemonIds,
        req.body.action
      );
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 设置收藏标记
router.patch('/pokemon/:id/favorite',
  authMiddleware,
  [param('id').isInt(), body('isFavorited').isBoolean()],
  async (req, res) => {
    try {
      const result = await bagCapacityService.setFavorite(
        req.user.id,
        parseInt(req.params.id),
        req.body.isFavorited
      );
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 更新排序顺序
router.post('/sort-order',
  authMiddleware,
  [body('pokemonIds').isArray({ min: 1 })],
  async (req, res) => {
    try {
      const result = await bagSortService.updateSortOrder(req.user.id, req.body.pokemonIds);
      res.json({ success: true, data: result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// 获取扩展历史
router.get('/expansion-history', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM bag_expansion_history 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT 50
    `, [req.user.id]);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 3. 前端实现

#### 3.1 背包管理组件 (game-client/src/components/BagManagement.js)

```javascript
import React, { useState, useEffect, useCallback } from 'react';
import { useGameStore } from '../game/GameStore';
import './BagManagement.css';

export default function BagManagement() {
  const { user } = useGameStore();
  const [capacityInfo, setCapacityInfo] = useState(null);
  const [pokemon, setPokemon] = useState([]);
  const [sortBy, setSortBy] = useState('recent');
  const [selectedPokemon, setSelectedPokemon] = useState(new Set());
  const [showExpandModal, setShowExpandModal] = useState(false);
  const [loading, setLoading] = useState(false);

  // 获取容量信息
  const fetchCapacityInfo = useCallback(async () => {
    try {
      const response = await fetch('/api/pokemon/bag/capacity', {
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      const data = await response.json();
      if (data.success) setCapacityInfo(data.data);
    } catch (error) {
      console.error('Failed to fetch capacity info:', error);
    }
  }, [user.token]);

  // 获取精灵列表
  const fetchPokemon = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/pokemon/bag/pokemon?sortBy=${sortBy}&limit=100`,
        { headers: { 'Authorization': `Bearer ${user.token}` } }
      );
      const data = await response.json();
      if (data.success) setPokemon(data.data.pokemon);
    } catch (error) {
      console.error('Failed to fetch pokemon:', error);
    }
  }, [user.token, sortBy]);

  useEffect(() => {
    fetchCapacityInfo();
    fetchPokemon();
  }, [fetchCapacityInfo, fetchPokemon]);

  // 扩展背包
  const handleExpandBag = async (method, units) => {
    setLoading(true);
    try {
      const response = await fetch('/api/pokemon/bag/expand', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ method, units })
      });
      const data = await response.json();
      if (data.success) {
        setCapacityInfo(prev => ({
          ...prev,
          currentCapacity: data.data.newCapacity,
          freeSlots: data.data.newCapacity - prev.usedSlots
        }));
        setShowExpandModal(false);
      } else {
        alert(data.error);
      }
    } catch (error) {
      console.error('Failed to expand bag:', error);
    } finally {
      setLoading(false);
    }
  };

  // 批量释放
  const handleBatchRelease = async () => {
    if (selectedPokemon.size === 0) return;
    if (!confirm(`确定要释放 ${selectedPokemon.size} 只精灵吗？`)) return;

    setLoading(true);
    try {
      const response = await fetch('/api/pokemon/bag/batch-action', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          pokemonIds: Array.from(selectedPokemon),
          action: 'release'
        })
      });
      const data = await response.json();
      if (data.success) {
        setSelectedPokemon(new Set());
        fetchCapacityInfo();
        fetchPokemon();
        alert(`成功释放 ${data.data.affectedCount} 只精灵，获得 ${data.data.candyReward} 糖果`);
      }
    } catch (error) {
      console.error('Failed to release pokemon:', error);
    } finally {
      setLoading(false);
    }
  };

  // 切换收藏
  const toggleFavorite = async (pokemonId, currentStatus) => {
    try {
      const response = await fetch(`/api/pokemon/bag/pokemon/${pokemonId}/favorite`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${user.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ isFavorited: !currentStatus })
      });
      if (response.ok) {
        fetchPokemon();
      }
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    }
  };

  // 计算进度条颜色
  const getProgressColor = (utilization) => {
    if (utilization >= 95) return '#ff4444';
    if (utilization >= 85) return '#ffaa00';
    return '#44ff44';
  };

  if (!capacityInfo) return <div className="loading">加载中...</div>;

  return (
    <div className="bag-management">
      {/* 容量指示器 */}
      <div className="capacity-indicator">
        <div className="capacity-header">
          <h3>精灵背包</h3>
          <span className="capacity-text">
            {capacityInfo.usedSlots} / {capacityInfo.currentCapacity}
          </span>
        </div>
        
        <div className="capacity-bar">
          <div 
            className="capacity-fill"
            style={{
              width: `${capacityInfo.utilizationRate}%`,
              backgroundColor: getProgressColor(capacityInfo.utilizationRate)
            }}
          />
        </div>
        
        <div className="capacity-actions">
          <button 
            className="expand-btn"
            onClick={() => setShowExpandModal(true)}
            disabled={!capacityInfo.canExpand}
          >
            扩展背包 +50
          </button>
          
          {capacityInfo.utilizationRate >= 90 && (
            <div className="warning-banner">
              ⚠️ 背包空间不足！建议释放或扩展
            </div>
          )}
        </div>
      </div>

      {/* 排序选择 */}
      <div className="sort-controls">
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="recent">最近获得</option>
          <option value="cp">CP 值</option>
          <option value="iv">IV 值</option>
          <option value="name">名称</option>
          <option value="favorite">收藏优先</option>
        </select>

        {selectedPokemon.size > 0 && (
          <button className="batch-btn" onClick={handleBatchRelease}>
            释放选中 ({selectedPokemon.size})
          </button>
        )}
      </div>

      {/* 精灵列表 */}
      <div className="pokemon-grid">
        {pokemon.map(p => (
          <div 
            key={p.id} 
            className={`pokemon-card ${selectedPokemon.has(p.id) ? 'selected' : ''}`}
            onClick={() => {
              const newSelected = new Set(selectedPokemon);
              if (newSelected.has(p.id)) {
                newSelected.delete(p.id);
              } else {
                newSelected.add(p.id);
              }
              setSelectedPokemon(newSelected);
            }}
          >
            <div className="pokemon-sprite">
              <img src={`/sprites/${p.species_id}.png`} alt={p.species_name} />
              {p.is_shiny && <span className="shiny-badge">✨</span>}
            </div>
            
            <div className="pokemon-info">
              <div className="pokemon-name">
                {p.is_favorited && <span className="favorite-star">⭐</span>}
                {p.species_name}
              </div>
              <div className="pokemon-stats">
                <span>CP: {p.cp}</span>
                <span>IV: {((p.iv_attack + p.iv_defense + p.iv_stamina) / 45 * 100).toFixed(1)}%</span>
              </div>
            </div>

            <button 
              className="favorite-btn"
              onClick={(e) => {
                e.stopPropagation();
                toggleFavorite(p.id, p.is_favorited);
              }}
            >
              {p.is_favorited ? '💔' : '❤️'}
            </button>
          </div>
        ))}
      </div>

      {/* 扩展弹窗 */}
      {showExpandModal && (
        <ExpandBagModal
          currentCapacity={capacityInfo.currentCapacity}
          onExpand={handleExpandBag}
          onClose={() => setShowExpandModal(false)}
          loading={loading}
        />
      )}
    </div>
  );
}

// 扩展背包弹窗组件
function ExpandBagModal({ currentCapacity, onExpand, onClose, loading }) {
  const [units, setUnits] = useState(1);
  const [method, setMethod] = useState('gold');
  const [costPreview, setCostPreview] = useState(null);

  useEffect(() => {
    // 获取成本预览
    fetch(`/api/pokemon/bag/expansion-cost?units=${units}&method=${method}`)
      .then(res => res.json())
      .then(data => {
        if (data.success) setCostPreview(data.data);
      });
  }, [units, method]);

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <h3>扩展背包容量</h3>
        
        <div className="expand-info">
          <p>当前容量: {currentCapacity}</p>
          <p>扩展后: {currentCapacity + units * 50}</p>
        </div>

        <div className="unit-selector">
          <label>扩展单位:</label>
          {[1, 2, 3, 5, 10].map(u => (
            <button 
              key={u}
              className={units === u ? 'active' : ''}
              onClick={() => setUnits(u)}
            >
              +{u * 50}
            </button>
          ))}
        </div>

        <div className="method-selector">
          <label>支付方式:</label>
          <button 
            className={method === 'gold' ? 'active' : ''}
            onClick={() => setMethod('gold')}
          >
            💰 金币
          </button>
          <button 
            className={method === 'diamond' ? 'active' : ''}
            onClick={() => setMethod('diamond')}
          >
            💎 钻石
          </button>
        </div>

        {costPreview && (
          <div className="cost-preview">
            需要支付: {costPreview.amount} {costPreview.currency === 'gold' ? '金币' : '钻石'}
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button 
            className="confirm-btn"
            onClick={() => onExpand(method, units)}
            disabled={loading}
          >
            {loading ? '处理中...' : '确认扩展'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

### 4. 定时任务

#### 4.1 容量预警任务 (backend/jobs/bagAlertJob.js)

```javascript
const cron = require('node-cron');
const { db } = require('@shared/db');
const notificationManager = require('@shared/notification/NotificationManager');

class BagAlertJob {
  start() {
    // 每小时检查一次
    cron.schedule('0 * * * *', async () => {
      await this.checkBagAlerts();
    });
  }

  async checkBagAlerts() {
    // 获取需要预警的玩家
    const result = await db.query(`
      SELECT 
        pbc.user_id,
        pbc.current_capacity,
        COUNT(p.id) as pokemon_count,
        bac.alert_thresholds
      FROM player_bag_capacity pbc
      JOIN bag_alert_config bac ON bac.user_id = pbc.user_id
      JOIN pokemon p ON p.user_id = pbc.user_id AND p.is_released = FALSE
      WHERE bac.enable_alert = TRUE
      GROUP BY pbc.user_id, pbc.current_capacity, bac.alert_thresholds
      HAVING COUNT(p.id)::float / pbc.current_capacity >= 0.85
    `);

    for (const row of result.rows) {
      const utilization = (row.pokemon_count / row.current_capacity) * 100;
      
      // 检查是否达到某个阈值
      const threshold = row.alert_thresholds.find(t => utilization >= t);
      if (threshold) {
        await this.sendAlert(row.user_id, {
          utilization,
          threshold,
          currentCapacity: row.current_capacity,
          usedSlots: row.pokemon_count
        });
      }
    }
  }

  async sendAlert(userId, data) {
    await notificationManager.send(userId, {
      type: 'bag_capacity_alert',
      title: '背包空间告急',
      body: `您的背包已使用 ${data.utilization.toFixed(1)}%，建议释放或扩展`,
      data: {
        utilization: data.utilization,
        freeSlots: data.currentCapacity - data.usedSlots
      }
    });
  }
}

module.exports = new BagAlertJob();
```

## 验收标准

- [ ] 玩家初始背包容量为 300，最大可扩展至 3000
- [ ] 支持金币和钻石两种方式扩展背包
- [ ] 扩展成本采用阶梯定价（已购买越多越贵）
- [ ] 支持批量选择精灵进行释放或转移
- [ ] 收藏的精灵无法被释放（需要先取消收藏）
- [ ] 提供 7 种排序方式：最近获得、CP、IV、名称、种族、收藏优先、等级
- [ ] 支持按类型、CP范围、IV范围筛选精灵
- [ ] 背包使用率达到 85%/90%/95%/99% 时发送预警通知
- [ ] 前端显示容量进度条，颜色随使用率变化（绿→黄→红）
- [ ] 提供扩展成本预览功能
- [ ] VIP 玩家获得额外容量加成
- [ ] 所有 API 有完整的参数验证和错误处理
- [ ] 单元测试覆盖率达到 80% 以上

## 影响范围

### 新增文件
- `database/migrations/YYYYMMDD_HHMMSS__add_bag_capacity_system.sql` - 数据库迁移
- `backend/services/pokemon-service/src/bagCapacityService.js` - 容量管理服务
- `backend/services/pokemon-service/src/bagSortService.js` - 排序服务
- `backend/services/pokemon-service/src/routes/bag.js` - API 路由
- `backend/jobs/bagAlertJob.js` - 容量预警定时任务
- `frontend/game-client/src/components/BagManagement.js` - 前端组件
- `frontend/game-client/src/components/BagManagement.css` - 样式文件
- `backend/tests/unit/bag-capacity.test.js` - 单元测试

### 修改文件
- `backend/services/pokemon-service/src/index.js` - 集成背包路由
- `backend/gateway/src/index.js` - 添加背包相关路由代理
- `database/schema/pokemon.sql` - 添加收藏标记字段

## 参考

- Pokémon GO 背包管理系统设计
- 游戏经济学：货币消耗设计原则
- 用户体验：容量预警最佳实践
