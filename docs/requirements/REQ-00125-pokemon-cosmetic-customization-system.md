# REQ-00125: 精灵外观定制系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00125 |
| 标题 | 精灵外观定制系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service、user-service、reward-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-11 19:30 |

## 需求描述

为精灵增加外观定制功能，允许玩家为精灵穿戴帽子、饰品、贴纸等装饰物，提升个性化和玩家投入度。装饰物通过成就、活动、商店购买等方式获得。

### 核心目标

1. **个性化表达**：玩家可为每只精灵定制独特外观
2. **社交展示**：外观在 PVP、道馆战斗、收藏展示中可见
3. **商业化潜力**：部分装饰物通过付费获取，增加收入来源
4. **成就激励**：稀有装饰物作为游戏成就奖励
5. **活动限时**：节日/活动专属装饰物增加参与度

## 技术方案

### 1. 数据库设计

```sql
-- 数据库迁移文件
-- database/pending/20260611_193000__add_pokemon_cosmetic_system.sql

-- 1. 装饰物定义表
CREATE TABLE cosmetic_items (
    id VARCHAR(50) PRIMARY KEY,
    name JSONB NOT NULL,                    -- {"en": "Santa Hat", "zh": "圣诞帽", "ja": "サンタ帽"}
    description JSONB NOT NULL,             -- {"en": "...", "zh": "...", "ja": "..."}
    category VARCHAR(30) NOT NULL,          -- hat/glasses/accessory/sticker/aura/trail
    rarity VARCHAR(20) NOT NULL,            -- common/uncommon/rare/epic/legendary
    icon_url VARCHAR(500) NOT NULL,         -- 装饰物图标
    model_url VARCHAR(500),                 -- 3D 模型文件（可选）
    position_data JSONB NOT NULL,           -- {"offset": [0, 10, 5], "scale": 1.0, "rotation": [0, 0, 0]}
    animation_data JSONB,                   -- {"idle": "...", "active": "..."}
    available_from TIMESTAMP,               -- 限时装饰物开始时间
    available_until TIMESTAMP,              -- 限时装饰物结束时间
    source_type VARCHAR(30) NOT NULL,       -- shop/achievement/event/crafting/default
    source_id VARCHAR(100),                 -- 来源 ID（商店物品 ID/成就 ID/活动 ID）
    price_coins INT DEFAULT 0,              -- 金币价格
    price_gems INT DEFAULT 0,               -- 宝石价格（付费货币）
    is_stackable BOOLEAN DEFAULT FALSE,     -- 是否可叠加（贴纸类）
    max_equipped INT DEFAULT 1,             -- 同类最多装备数量
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cosmetic_items_category ON cosmetic_items(category);
CREATE INDEX idx_cosmetic_items_rarity ON cosmetic_items(rarity);
CREATE INDEX idx_cosmetic_items_source ON cosmetic_items(source_type, source_id);
CREATE INDEX idx_cosmetic_items_availability ON cosmetic_items(available_from, available_until);

-- 2. 用户装饰物库存表
CREATE TABLE user_cosmetics (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cosmetic_id VARCHAR(50) NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    quantity INT DEFAULT 1,                 -- 数量（可叠加装饰物）
    obtained_at TIMESTAMP DEFAULT NOW(),
    obtained_from VARCHAR(30) NOT NULL,     -- purchase/achievement/event/crafting/gift
    expires_at TIMESTAMP,                   -- 过期时间（限时装饰物）
    UNIQUE(user_id, cosmetic_id)
);

CREATE INDEX idx_user_cosmetics_user ON user_cosmetics(user_id);
CREATE INDEX idx_user_cosmetics_expires ON user_cosmetics(expires_at) WHERE expires_at IS NOT NULL;

-- 3. 精灵装备装饰物表
CREATE TABLE pokemon_cosmetics (
    id SERIAL PRIMARY KEY,
    pokemon_instance_id VARCHAR(50) NOT NULL REFERENCES pokemon_instances(id) ON DELETE CASCADE,
    cosmetic_id VARCHAR(50) NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    slot_position INT DEFAULT 0,            -- 装饰物槽位
    equipped_at TIMESTAMP DEFAULT NOW(),
    equipped_by VARCHAR(50) REFERENCES users(id),
    UNIQUE(pokemon_instance_id, cosmetic_id)
);

CREATE INDEX idx_pokemon_cosmetics_pokemon ON pokemon_cosmetics(pokemon_instance_id);
CREATE INDEX idx_pokemon_cosmetics_cosmetic ON pokemon_cosmetics(cosmetic_id);

-- 4. 装饰物组合方案表（预设搭配）
CREATE TABLE cosmetic_presets (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    preset_data JSONB NOT NULL,             -- {"cosmetic_id": slot_position, ...}
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cosmetic_presets_user ON cosmetic_presets(user_id);

-- 5. 装饰物统计表
CREATE TABLE cosmetic_statistics (
    cosmetic_id VARCHAR(50) PRIMARY KEY REFERENCES cosmetic_items(id) ON DELETE CASCADE,
    total_owned INT DEFAULT 0,              -- 总拥有人数
    total_equipped INT DEFAULT 0,           -- 当前装备数
    total_purchased INT DEFAULT 0,          -- 总购买次数
    total_revenue_coins BIGINT DEFAULT 0,   -- 金币收入
    total_revenue_gems BIGINT DEFAULT 0,    -- 宝石收入
    last_updated TIMESTAMP DEFAULT NOW()
);
```

### 2. Pokemon-service 核心服务模块

```javascript
// backend/services/pokemon-service/src/cosmeticService.js

const { db } = require('../../../shared/db');
const cache = require('../../../shared/cache');
const metrics = require('../../../shared/metrics');
const EventBus = require('../../../shared/EventBus');

class CosmeticService {
  constructor() {
    this.CACHE_TTL = 3600; // 1 小时
    this.PREDEFINED_SLOTS = {
      hat: { max: 1, zIndex: 10 },
      glasses: { max: 1, zIndex: 9 },
      accessory: { max: 3, zIndex: 5 },
      sticker: { max: 5, zIndex: 3 },
      aura: { max: 1, zIndex: 1 },
      trail: { max: 1, zIndex: 2 }
    };
  }

  /**
   * 获取所有可用装饰物列表
   */
  async getAvailableCosmetics(options = {}) {
    const { category, rarity, userId } = options;
    const cacheKey = `cosmetics:list:${category || 'all'}:${rarity || 'all'}`;
    
    // 尝试缓存
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    let query = db('cosmetic_items')
      .where(function() {
        this.whereNull('available_from')
          .orWhere('available_from', '<=', new Date());
      })
      .where(function() {
        this.whereNull('available_until')
          .orWhere('available_until', '>=', new Date());
      });

    if (category) query = query.where('category', category);
    if (rarity) query = query.where('rarity', rarity);

    const cosmetics = await query.orderBy('rarity', 'desc');

    // 如果提供了用户 ID，附加用户拥有状态
    if (userId) {
      const userCosmetics = await db('user_cosmetics')
        .where('user_id', userId)
        .where(function() {
          this.whereNull('expires_at')
            .orWhere('expires_at', '>=', new Date());
        });

      const ownedMap = new Map(userCosmetics.map(uc => [uc.cosmetic_id, uc]));
      
      cosmetics.forEach(cosmetic => {
        const owned = ownedMap.get(cosmetic.id);
        cosmetic.owned = !!owned;
        cosmetic.quantity = owned?.quantity || 0;
        cosmetic.expires_at = owned?.expires_at;
      });
    }

    await cache.set(cacheKey, cosmetics, this.CACHE_TTL);
    return cosmetics;
  }

  /**
   * 为精灵装备装饰物
   */
  async equipCosmetic(pokemonInstanceId, cosmeticId, userId, slotPosition = 0) {
    return await db.transaction(async (trx) => {
      // 1. 验证精灵所有权
      const pokemon = await trx('pokemon_instances')
        .where({ id: pokemonInstanceId, user_id: userId })
        .first();

      if (!pokemon) {
        throw new Error('POKEMON_NOT_FOUND');
      }

      // 2. 验证装饰物拥有权
      const userCosmetic = await trx('user_cosmetics')
        .where({ user_id: userId, cosmetic_id: cosmeticId })
        .where(function() {
          this.whereNull('expires_at')
            .orWhere('expires_at', '>=', new Date());
        })
        .first();

      if (!userCosmetic || userCosmetic.quantity < 1) {
        throw new Error('COSMETIC_NOT_OWNED');
      }

      // 3. 获取装饰物信息
      const cosmetic = await trx('cosmetic_items').where('id', cosmeticId).first();
      if (!cosmetic) {
        throw new Error('COSMETIC_NOT_FOUND');
      }

      // 4. 检查槽位限制
      const slotConfig = this.PREDEFINED_SLOTS[cosmetic.category];
      if (!slotConfig) {
        throw new Error('INVALID_CATEGORY');
      }

      const existingEquipped = await trx('pokemon_cosmetics')
        .join('cosmetic_items', 'pokemon_cosmetics.cosmetic_id', 'cosmetic_items.id')
        .where('pokemon_cosmetics.pokemon_instance_id', pokemonInstanceId)
        .where('cosmetic_items.category', cosmetic.category);

      if (existingEquipped.length >= slotConfig.max) {
        throw new Error('SLOT_LIMIT_REACHED');
      }

      // 5. 检查是否已装备
      const alreadyEquipped = await trx('pokemon_cosmetics')
        .where({ pokemon_instance_id: pokemonInstanceId, cosmetic_id: cosmeticId })
        .first();

      if (alreadyEquipped) {
        throw new Error('ALREADY_EQUIPPED');
      }

      // 6. 装备装饰物
      await trx('pokemon_cosmetics').insert({
        pokemon_instance_id: pokemonInstanceId,
        cosmetic_id: cosmeticId,
        slot_position: slotPosition,
        equipped_at: new Date(),
        equipped_by: userId
      });

      // 7. 更新统计
      await trx('cosmetic_statistics')
        .where('cosmetic_id', cosmeticId)
        .increment('total_equipped', 1)
        .update({ last_updated: new Date() });

      // 8. 发布事件
      EventBus.publish('cosmetic.equipped', {
        userId,
        pokemonInstanceId,
        cosmeticId,
        category: cosmetic.category,
        timestamp: new Date()
      });

      // 9. 指标
      metrics.increment('cosmetics_equipped_total', 1, {
        category: cosmetic.category,
        rarity: cosmetic.rarity
      });

      return {
        success: true,
        cosmetic,
        slotPosition
      };
    });
  }

  /**
   * 卸下装饰物
   */
  async unequipCosmetic(pokemonInstanceId, cosmeticId, userId) {
    return await db.transaction(async (trx) => {
      // 验证精灵所有权
      const pokemon = await trx('pokemon_instances')
        .where({ id: pokemonInstanceId, user_id: userId })
        .first();

      if (!pokemon) {
        throw new Error('POKEMON_NOT_FOUND');
      }

      // 删除装备记录
      const deleted = await trx('pokemon_cosmetics')
        .where({ pokemon_instance_id: pokemonInstanceId, cosmetic_id: cosmeticId })
        .delete();

      if (deleted === 0) {
        throw new Error('COSMETIC_NOT_EQUIPPED');
      }

      // 更新统计
      await trx('cosmetic_statistics')
        .where('cosmetic_id', cosmeticId)
        .decrement('total_equipped', 1)
        .update({ last_updated: new Date() });

      // 发布事件
      EventBus.publish('cosmetic.unequipped', {
        userId,
        pokemonInstanceId,
        cosmeticId,
        timestamp: new Date()
      });

      return { success: true };
    });
  }

  /**
   * 获取精灵当前装备的所有装饰物
   */
  async getPokemonCosmetics(pokemonInstanceId) {
    const cacheKey = `pokemon:cosmetics:${pokemonInstanceId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const cosmetics = await db('pokemon_cosmetics')
      .join('cosmetic_items', 'pokemon_cosmetics.cosmetic_id', 'cosmetic_items.id')
      .where('pokemon_cosmetics.pokemon_instance_id', pokemonInstanceId)
      .select(
        'cosmetic_items.*',
        'pokemon_cosmetics.slot_position',
        'pokemon_cosmetics.equipped_at'
      )
      .orderBy('cosmetic_items.category');

    await cache.set(cacheKey, cosmetics, this.CACHE_TTL);
    return cosmetics;
  }

  /**
   * 批量获取多只精灵的装饰物（用于 PVP、道馆战斗）
   */
  async batchGetPokemonCosmetics(pokemonInstanceIds) {
    if (!pokemonInstanceIds || pokemonInstanceIds.length === 0) {
      return {};
    }

    const cosmetics = await db('pokemon_cosmetics')
      .join('cosmetic_items', 'pokemon_cosmetics.cosmetic_id', 'cosmetic_items.id')
      .whereIn('pokemon_cosmetics.pokemon_instance_id', pokemonInstanceIds)
      .select(
        'pokemon_cosmetics.pokemon_instance_id',
        'cosmetic_items.*',
        'pokemon_cosmetics.slot_position'
      );

    // 按 pokemon_instance_id 分组
    const result = {};
    pokemonInstanceIds.forEach(id => result[id] = []);
    cosmetics.forEach(cosmetic => {
      result[cosmetic.pokemon_instance_id].push(cosmetic);
    });

    return result;
  }

  /**
   * 购买装饰物
   */
  async purchaseCosmetic(cosmeticId, userId, currency = 'coins') {
    return await db.transaction(async (trx) => {
      // 1. 获取装饰物信息
      const cosmetic = await trx('cosmetic_items').where('id', cosmeticId).first();
      if (!cosmetic) {
        throw new Error('COSMETIC_NOT_FOUND');
      }

      // 2. 检查可用性
      const now = new Date();
      if (cosmetic.available_from && new Date(cosmetic.available_from) > now) {
        throw new Error('COSMETIC_NOT_AVAILABLE_YET');
      }
      if (cosmetic.available_until && new Date(cosmetic.available_until) < now) {
        throw new Error('COSMETIC_EXPIRED');
      }

      // 3. 检查来源是否为商店
      if (cosmetic.source_type !== 'shop') {
        throw new Error('COSMETIC_NOT_PURCHASABLE');
      }

      // 4. 获取用户余额
      const user = await trx('users').where('id', userId).first();
      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }

      const price = currency === 'gems' ? cosmetic.price_gems : cosmetic.price_coins;
      const balance = currency === 'gems' ? user.gems : user.coins;

      if (balance < price) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // 5. 扣款
      const balanceField = currency === 'gems' ? 'gems' : 'coins';
      await trx('users')
        .where('id', userId)
        .decrement(balanceField, price);

      // 6. 添加到用户库存
      const existing = await trx('user_cosmetics')
        .where({ user_id: userId, cosmetic_id: cosmeticId })
        .first();

      if (existing) {
        await trx('user_cosmetics')
          .where({ user_id: userId, cosmetic_id: cosmeticId })
          .increment('quantity', 1);
      } else {
        await trx('user_cosmetics').insert({
          user_id: userId,
          cosmetic_id: cosmeticId,
          quantity: 1,
          obtained_at: new Date(),
          obtained_from: 'purchase'
        });
      }

      // 7. 更新统计
      await trx('cosmetic_statistics')
        .where('cosmetic_id', cosmeticId)
        .increment('total_owned', 1)
        .increment('total_purchased', 1)
        .increment(currency === 'gems' ? 'total_revenue_gems' : 'total_revenue_coins', price)
        .update({ last_updated: new Date() });

      // 8. 发布事件
      EventBus.publish('cosmetic.purchased', {
        userId,
        cosmeticId,
        price,
        currency,
        timestamp: new Date()
      });

      // 9. 指标
      metrics.increment('cosmetics_purchased_total', 1, {
        rarity: cosmetic.rarity,
        category: cosmetic.category,
        currency
      });

      metrics.histogram('cosmetics_purchase_price', price, {
        rarity: cosmetic.rarity,
        currency
      });

      return {
        success: true,
        cosmetic,
        price,
        currency,
        newBalance: balance - price
      };
    });
  }

  /**
   * 赠送装饰物（管理员或系统奖励）
   */
  async giftCosmetic(cosmeticId, userId, expiresIn = null) {
    return await db.transaction(async (trx) => {
      const cosmetic = await trx('cosmetic_items').where('id', cosmeticId).first();
      if (!cosmetic) {
        throw new Error('COSMETIC_NOT_FOUND');
      }

      const expiresAt = expiresIn ? new Date(Date.now() + expiresIn) : null;

      const existing = await trx('user_cosmetics')
        .where({ user_id: userId, cosmetic_id: cosmeticId })
        .first();

      if (existing) {
        await trx('user_cosmetics')
          .where({ user_id: userId, cosmetic_id: cosmeticId })
          .increment('quantity', 1);
      } else {
        await trx('user_cosmetics').insert({
          user_id: userId,
          cosmetic_id: cosmeticId,
          quantity: 1,
          obtained_at: new Date(),
          obtained_from: 'gift',
          expires_at: expiresAt
        });
      }

      await trx('cosmetic_statistics')
        .where('cosmetic_id', cosmeticId)
        .increment('total_owned', 1)
        .update({ last_updated: new Date() });

      EventBus.publish('cosmetic.gifted', {
        userId,
        cosmeticId,
        expiresAt,
        timestamp: new Date()
      });

      return { success: true, cosmetic, expiresAt };
    });
  }

  /**
   * 创建/更新装饰物预设
   */
  async savePreset(userId, presetName, cosmeticsData) {
    const existing = await db('cosmetic_presets')
      .where({ user_id: userId, name: presetName })
      .first();

    if (existing) {
      await db('cosmetic_presets')
        .where({ id: existing.id })
        .update({
          preset_data: JSON.stringify(cosmeticsData),
          updated_at: new Date()
        });
      return { id: existing.id, updated: true };
    } else {
      const [preset] = await db('cosmetic_presets')
        .insert({
          user_id: userId,
          name: presetName,
          preset_data: JSON.stringify(cosmeticsData),
          created_at: new Date()
        })
        .returning('id');
      return { id: preset.id, updated: false };
    }
  }

  /**
   * 应用预设到精灵
   */
  async applyPreset(pokemonInstanceId, presetId, userId) {
    const preset = await db('cosmetic_presets')
      .where({ id: presetId, user_id: userId })
      .first();

    if (!preset) {
      throw new Error('PRESET_NOT_FOUND');
    }

    const cosmeticsData = preset.preset_data;

    // 先卸下所有现有装饰物
    await db('pokemon_cosmetics')
      .where('pokemon_instance_id', pokemonInstanceId)
      .delete();

    // 应用预设中的装饰物
    for (const [cosmeticId, slotPosition] of Object.entries(cosmeticsData)) {
      await this.equipCosmetic(pokemonInstanceId, cosmeticId, userId, slotPosition);
    }

    return { success: true, preset: preset.name };
  }

  /**
   * 获取装饰物统计
   */
  async getCosmeticStatistics(cosmeticId) {
    const stats = await db('cosmetic_statistics')
      .where('cosmetic_id', cosmeticId)
      .first();

    if (!stats) {
      return {
        total_owned: 0,
        total_equipped: 0,
        total_purchased: 0,
        total_revenue_coins: 0,
        total_revenue_gems: 0
      };
    }

    return stats;
  }

  /**
   * 批量清理过期装饰物（定时任务）
   */
  async cleanupExpiredCosmetics() {
    const expired = await db('user_cosmetics')
      .where('expires_at', '<', new Date())
      .delete()
      .returning(['user_id', 'cosmetic_id']);

    console.log(`[CosmeticService] Cleaned up ${expired.length} expired cosmetics`);

    // 发布清理事件
    expired.forEach(({ user_id, cosmetic_id }) => {
      EventBus.publish('cosmetic.expired', {
        userId: user_id,
        cosmeticId: cosmetic_id,
        timestamp: new Date()
      });
    });

    return expired.length;
  }
}

module.exports = new CosmeticService();
```

### 3. API 路由

```javascript
// backend/services/pokemon-service/src/routes/cosmetics.js

const express = require('express');
const router = express.Router();
const cosmeticService = require('../cosmeticService');
const { authenticate, optionalAuth } = require('../../../shared/middleware/auth');
const { rateLimiter } = require('../../../shared/middleware/rateLimiter');
const Joi = require('joi');

// 验证 Schema
const equipSchema = Joi.object({
  cosmetic_id: Joi.string().required(),
  slot_position: Joi.number().min(0).max(10).default(0)
});

const purchaseSchema = Joi.object({
  cosmetic_id: Joi.string().required(),
  currency: Joi.string().valid('coins', 'gems').default('coins')
});

/**
 * GET /pokemon/cosmetics
 * 获取所有可用装饰物列表
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { category, rarity } = req.query;
    const cosmetics = await cosmeticService.getAvailableCosmetics({
      category,
      rarity,
      userId: req.user?.id
    });

    res.json({
      success: true,
      data: cosmetics,
      total: cosmetics.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /pokemon/cosmetics/:id
 * 获取装饰物详情
 */
router.get('/:id', async (req, res) => {
  try {
    const cosmetic = await db('cosmetic_items')
      .where('id', req.params.id)
      .first();

    if (!cosmetic) {
      return res.status(404).json({
        success: false,
        error: 'COSMETIC_NOT_FOUND'
      });
    }

    const stats = await cosmeticService.getCosmeticStatistics(req.params.id);

    res.json({
      success: true,
      data: { ...cosmetic, statistics: stats }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /pokemon/cosmetics/user/inventory
 * 获取用户装饰物库存
 */
router.get('/user/inventory', authenticate, async (req, res) => {
  try {
    const cosmetics = await db('user_cosmetics')
      .join('cosmetic_items', 'user_cosmetics.cosmetic_id', 'cosmetic_items.id')
      .where('user_cosmetics.user_id', req.user.id)
      .where(function() {
        this.whereNull('user_cosmetics.expires_at')
          .orWhere('user_cosmetics.expires_at', '>=', new Date());
      })
      .select(
        'cosmetic_items.*',
        'user_cosmetics.quantity',
        'user_cosmetics.obtained_at',
        'user_cosmetics.expires_at'
      )
      .orderBy('cosmetic_items.rarity', 'desc');

    res.json({
      success: true,
      data: cosmetics,
      total: cosmetics.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /pokemon/cosmetics/:id/purchase
 * 购买装饰物
 */
router.post('/:id/purchase', authenticate, rateLimiter('cosmetic-purchase', 10, 60), async (req, res) => {
  try {
    const { error, value } = purchaseSchema.validate({
      cosmetic_id: req.params.id,
      currency: req.body.currency
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const result = await cosmeticService.purchaseCosmetic(
      value.cosmetic_id,
      req.user.id,
      value.currency
    );

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    const statusCode = error.message === 'INSUFFICIENT_BALANCE' ? 402 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /pokemon/cosmetics/equip
 * 为精灵装备装饰物
 */
router.post('/equip', authenticate, async (req, res) => {
  try {
    const { error, value } = equipSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: error.details[0].message
      });
    }

    const { pokemon_instance_id } = req.body;
    const result = await cosmeticService.equipCosmetic(
      pokemon_instance_id,
      value.cosmetic_id,
      req.user.id,
      value.slot_position
    );

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    const statusCode = 
      error.message === 'POKEMON_NOT_FOUND' ? 404 :
      error.message === 'COSMETIC_NOT_OWNED' ? 403 : 400;
    
    res.status(statusCode).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /pokemon/cosmetics/unequip
 * 卸下装饰物
 */
router.delete('/unequip', authenticate, async (req, res) => {
  try {
    const { pokemon_instance_id, cosmetic_id } = req.body;

    const result = await cosmeticService.unequipCosmetic(
      pokemon_instance_id,
      cosmetic_id,
      req.user.id
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
});

/**
 * GET /pokemon/:pokemonId/cosmetics
 * 获取精灵当前装备的装饰物
 */
router.get('/pokemon/:pokemonId', async (req, res) => {
  try {
    const cosmetics = await cosmeticService.getPokemonCosmetics(req.params.pokemonId);

    res.json({
      success: true,
      data: cosmetics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /pokemon/cosmetics/presets
 * 创建装饰物预设
 */
router.post('/presets', authenticate, async (req, res) => {
  try {
    const { name, cosmetics } = req.body;

    if (!name || !cosmetics) {
      return res.status(400).json({
        success: false,
        error: 'NAME_AND_COSMETICS_REQUIRED'
      });
    }

    const result = await cosmeticService.savePreset(req.user.id, name, cosmetics);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /pokemon/cosmetics/presets
 * 获取用户所有预设
 */
router.get('/presets/list', authenticate, async (req, res) => {
  try {
    const presets = await db('cosmetic_presets')
      .where('user_id', req.user.id)
      .orderBy('created_at', 'desc');

    res.json({
      success: true,
      data: presets
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /pokemon/cosmetics/presets/:presetId/apply
 * 应用预设到精灵
 */
router.post('/presets/:presetId/apply', authenticate, async (req, res) => {
  try {
    const { pokemon_instance_id } = req.body;

    const result = await cosmeticService.applyPreset(
      pokemon_instance_id,
      req.params.presetId,
      req.user.id
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
});

/**
 * GET /pokemon/cosmetics/statistics/:id
 * 获取装饰物统计（管理员）
 */
router.get('/statistics/:id', authenticate, async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user.is_admin) {
      return res.status(403).json({
        success: false,
        error: 'ADMIN_ONLY'
      });
    }

    const stats = await cosmeticService.getCosmeticStatistics(req.params.id);

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

### 4. 前端组件

```javascript
// frontend/game-client/src/components/CosmeticPanel.js

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './CosmeticPanel.css';

const CosmeticPanel = ({ pokemonInstanceId, onClose }) => {
  const { t } = useTranslation();
  const [inventory, setInventory] = useState([]);
  const [equipped, setEquipped] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [presets, setPresets] = useState([]);

  const categories = [
    { id: 'all', label: t('cosmetics.all') },
    { id: 'hat', label: t('cosmetics.hat') },
    { id: 'glasses', label: t('cosmetics.glasses') },
    { id: 'accessory', label: t('cosmetics.accessory') },
    { id: 'sticker', label: t('cosmetics.sticker') },
    { id: 'aura', label: t('cosmetics.aura') },
    { id: 'trail', label: t('cosmetics.trail') }
  ];

  useEffect(() => {
    loadData();
  }, [pokemonInstanceId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [inventoryRes, equippedRes, presetsRes] = await Promise.all([
        fetch('/pokemon/cosmetics/user/inventory'),
        fetch(`/pokemon/cosmetics/pokemon/${pokemonInstanceId}`),
        fetch('/pokemon/cosmetics/presets/list')
      ]);

      const [inventoryData, equippedData, presetsData] = await Promise.all([
        inventoryRes.json(),
        equippedRes.json(),
        presetsRes.json()
      ]);

      if (inventoryData.success) setInventory(inventoryData.data);
      if (equippedData.success) setEquipped(equippedData.data);
      if (presetsData.success) setPresets(presetsData.data);
    } catch (error) {
      console.error('Failed to load cosmetics:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEquip = async (cosmeticId, slotPosition = 0) => {
    try {
      const res = await fetch('/pokemon/cosmetics/equip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pokemon_instance_id: pokemonInstanceId,
          cosmetic_id: cosmeticId,
          slot_position: slotPosition
        })
      });

      const data = await res.json();
      if (data.success) {
        loadData(); // 重新加载
      } else {
        alert(t(`errors.${data.error}`));
      }
    } catch (error) {
      console.error('Failed to equip:', error);
    }
  };

  const handleUnequip = async (cosmeticId) => {
    try {
      const res = await fetch('/pokemon/cosmetics/unequip', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pokemon_instance_id: pokemonInstanceId,
          cosmetic_id: cosmeticId
        })
      });

      const data = await res.json();
      if (data.success) {
        loadData();
      }
    } catch (error) {
      console.error('Failed to unequip:', error);
    }
  };

  const handleApplyPreset = async (presetId) => {
    try {
      const res = await fetch(`/pokemon/cosmetics/presets/${presetId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pokemon_instance_id: pokemonInstanceId })
      });

      const data = await res.json();
      if (data.success) {
        loadData();
      }
    } catch (error) {
      console.error('Failed to apply preset:', error);
    }
  };

  const handleSavePreset = async () => {
    const name = prompt(t('cosmetics.preset_name'));
    if (!name) return;

    const cosmeticsData = {};
    equipped.forEach(c => {
      cosmeticsData[c.id] = c.slot_position;
    });

    try {
      const res = await fetch('/pokemon/cosmetics/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cosmetics: cosmeticsData })
      });

      const data = await res.json();
      if (data.success) {
        loadData();
      }
    } catch (error) {
      console.error('Failed to save preset:', error);
    }
  };

  const filteredInventory = selectedCategory === 'all'
    ? inventory
    : inventory.filter(c => c.category === selectedCategory);

  const getRarityColor = (rarity) => {
    const colors = {
      common: '#9e9e9e',
      uncommon: '#4caf50',
      rare: '#2196f3',
      epic: '#9c27b0',
      legendary: '#ff9800'
    };
    return colors[rarity] || colors.common;
  };

  if (loading) {
    return <div className="cosmetic-panel loading">{t('loading')}</div>;
  }

  return (
    <div className="cosmetic-panel">
      <div className="panel-header">
        <h2>{t('cosmetics.title')}</h2>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      {/* 已装备区域 */}
      <div className="equipped-section">
        <h3>{t('cosmetics.equipped')}</h3>
        <div className="equipped-slots">
          {equipped.length === 0 ? (
            <p className="empty-hint">{t('cosmetics.no_equipped')}</p>
          ) : (
            equipped.map(cosmetic => (
              <div 
                key={cosmetic.id} 
                className="equipped-item"
                style={{ borderColor: getRarityColor(cosmetic.rarity) }}
              >
                <img src={cosmetic.icon_url} alt={cosmetic.name[t('language')]} />
                <span>{cosmetic.name[t('language')]}</span>
                <button 
                  className="unequip-btn"
                  onClick={() => handleUnequip(cosmetic.id)}
                >
                  {t('cosmetics.unequip')}
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 分类选择 */}
      <div className="category-tabs">
        {categories.map(cat => (
          <button
            key={cat.id}
            className={`category-tab ${selectedCategory === cat.id ? 'active' : ''}`}
            onClick={() => setSelectedCategory(cat.id)}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* 库存列表 */}
      <div className="inventory-section">
        <h3>{t('cosmetics.inventory')} ({filteredInventory.length})</h3>
        <div className="inventory-grid">
          {filteredInventory.map(cosmetic => (
            <div
              key={cosmetic.id}
              className="inventory-item"
              style={{ borderColor: getRarityColor(cosmetic.rarity) }}
              onClick={() => handleEquip(cosmetic.id)}
            >
              <img src={cosmetic.icon_url} alt={cosmetic.name[t('language')]} />
              <div className="item-info">
                <span className="item-name">{cosmetic.name[t('language')]}</span>
                <span className="item-quantity">×{cosmetic.quantity}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 预设区域 */}
      <div className="presets-section">
        <div className="presets-header">
          <h3>{t('cosmetics.presets')}</h3>
          <button onClick={handleSavePreset}>{t('cosmetics.save_preset')}</button>
        </div>
        <div className="presets-list">
          {presets.map(preset => (
            <button
              key={preset.id}
              className="preset-btn"
              onClick={() => handleApplyPreset(preset.id)}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CosmeticPanel;
```

### 5. Prometheus 指标

```javascript
// backend/services/pokemon-service/src/metrics/cosmetics.js

const promClient = require('prom-client');

const cosmeticsMetrics = {
  // 装饰物购买总数
  cosmeticsPurchasedTotal: new promClient.Counter({
    name: 'cosmetics_purchased_total',
    help: 'Total number of cosmetics purchased',
    labelNames: ['rarity', 'category', 'currency']
  }),

  // 装饰物装备总数
  cosmeticsEquippedTotal: new promClient.Counter({
    name: 'cosmetics_equipped_total',
    help: 'Total number of cosmetics equipped',
    labelNames: ['rarity', 'category']
  }),

  // 购买价格分布
  cosmeticsPurchasePrice: new promClient.Histogram({
    name: 'cosmetics_purchase_price',
    help: 'Distribution of cosmetics purchase prices',
    labelNames: ['rarity', 'currency'],
    buckets: [100, 500, 1000, 5000, 10000, 50000]
  }),

  // 用户库存大小
  cosmeticsInventorySize: new promClient.Gauge({
    name: 'cosmetics_inventory_size',
    help: 'Number of cosmetics in user inventory',
    labelNames: ['user_id']
  }),

  // 装饰物收入
  cosmeticsRevenueTotal: new promClient.Counter({
    name: 'cosmetics_revenue_total',
    help: 'Total revenue from cosmetics',
    labelNames: ['currency']
  })
};

module.exports = cosmeticsMetrics;
```

## 验收标准

- [ ] 数据库迁移成功执行（5 张表创建完成）
- [ ] GET /pokemon/cosmetics 返回装饰物列表（支持分类、稀有度过滤）
- [ ] GET /pokemon/cosmetics/user/inventory 返回用户库存
- [ ] POST /pokemon/cosmetics/:id/purchase 支持金币和宝石购买
- [ ] POST /pokemon/cosmetics/equip 成功装备装饰物到精灵
- [ ] DELETE /pokemon/cosmetics/unequip 成功卸下装饰物
- [ ] GET /pokemon/cosmetics/pokemon/:pokemonId 返回精灵装备列表
- [ ] POST /pokemon/cosmetics/presets 创建预设成功
- [ ] POST /pokemon/cosmetics/presets/:presetId/apply 应用预设成功
- [ ] 槽位限制生效（同类装饰物不超过 max 数量）
- [ ] 限时装饰物过期自动清理
- [ ] 前端 CosmeticPanel 组件正确展示和交互
- [ ] Prometheus 指标正确记录
- [ ] 单元测试覆盖率 ≥ 90%
- [ ] 集成测试验证完整购买流程

## 影响范围

### 新增文件
- database/pending/20260611_193000__add_pokemon_cosmetic_system.sql
- backend/services/pokemon-service/src/cosmeticService.js
- backend/services/pokemon-service/src/routes/cosmetics.js
- backend/services/pokemon-service/src/metrics/cosmetics.js
- frontend/game-client/src/components/CosmeticPanel.js
- frontend/game-client/src/components/CosmeticPanel.css
- backend/tests/unit/cosmetic-service.test.js

### 修改文件
- backend/services/pokemon-service/src/index.js（挂载路由）
- frontend/game-client/src/locales/en.json（国际化）
- frontend/game-client/src/locales/zh.json
- frontend/game-client/src/locales/ja.json

## 参考

- [Pokemon GO Avatar Customization](https://pokemongolive.com/post/avatar-customization/)
- [Free-to-Play Cosmetic Monetization Best Practices](https://www.gamedeveloper.com/business/free-to-play-cosmetic-monetization-best-practices)
- [GDPR Compliance for Virtual Goods](https://gdpr.eu/compliance/)
