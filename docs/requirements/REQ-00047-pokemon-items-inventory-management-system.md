# REQ-00047: 精灵道具与背包管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00047 |
| 标题 | 精灵道具与背包管理系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | pokemon-service, reward-service, catch-service, social-service, gateway, game-client |
| 创建时间 | 2026-06-09 09:00 |

## 需求描述

精灵道具与背包管理系统是游戏核心功能之一，用于管理玩家拥有的各类游戏道具。系统需要支持道具分类、数量管理、使用消耗、堆叠限制、过期机制、排序筛选等功能，并与现有的捕捉、奖励、交易等系统深度集成。

### 核心功能
1. **道具分类系统**：精灵球、药水、技能机器、进化石、特殊道具、装饰品
2. **背包容量管理**：基础容量 + 扩容道具，按类型分类限制
3. **道具使用系统**：消耗型道具、装备型道具、一次性道具
4. **道具获取途径**：捕捉奖励、道馆奖励、商店购买、任务奖励
5. **道具交易系统**：部分道具可交易，受距离和时间限制
6. **道具堆叠与合并**：同类道具自动堆叠，设置堆叠上限
7. **过期与清理**：活动道具有过期时间，自动清理过期道具
8. **快速访问栏**：常用道具快捷栏，战斗中快速使用

### 道具类型定义
- **精灵球类**：红球、蓝球、黄球、大师球等，捕捉成功率不同
- **药水类**：恢复HP、治愈异常状态、复活精灵
- **技能机器(TM/HM)**：学习新技能，一次性或可重复使用
- **进化石**：特定精灵进化道具
- **强化道具**：提升CP、个体值强化
- **特殊道具**：诱饵模块、幸运蛋、星尘加成卡
- **装饰品**：角色装扮、精灵装饰

## 技术方案

### 1. 数据库设计

```sql
-- 道具定义表
CREATE TABLE items (
    id SERIAL PRIMARY KEY,
    item_id VARCHAR(50) UNIQUE NOT NULL,           -- 道具唯一标识 (POKE_BALL, SUPER_POTION)
    name VARCHAR(100) NOT NULL,                    -- 道具名称
    name_localized JSONB NOT NULL,                 -- 多语言名称 {"en": "Poké Ball", "zh": "精灵球"}
    description TEXT,                              -- 道具描述
    category VARCHAR(50) NOT NULL,                 -- 分类: pokeball, potion, tm, evolution, boost, special, cosmetic
    subcategory VARCHAR(50),                       -- 子分类
    rarity VARCHAR(20) DEFAULT 'common',           -- 稀有度: common, uncommon, rare, epic, legendary
    max_stack INTEGER DEFAULT 999,                 -- 单格最大堆叠数
    is_consumable BOOLEAN DEFAULT TRUE,            -- 是否消耗型
    is_tradable BOOLEAN DEFAULT TRUE,              -- 是否可交易
    is_droppable BOOLEAN DEFAULT TRUE,             -- 是否可丢弃
    expires_after_days INTEGER,                    -- 过期天数 (NULL 表示永不过期)
    effect_data JSONB,                             -- 效果数据 (成功率、恢复量等)
    use_requirements JSONB,                        -- 使用条件 (等级、精灵类型等)
    icon_url VARCHAR(500),                         -- 图标 URL
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX idx_items_category ON items(category);
CREATE INDEX idx_items_rarity ON items(rarity);

-- 玩家背包表
CREATE TABLE player_inventory (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id VARCHAR(50) NOT NULL REFERENCES items(item_id),
    quantity INTEGER NOT NULL DEFAULT 1,
    slot_index INTEGER,                            -- 背包格子索引
    acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP,                         -- 过期时间 (NULL 表示永不过期)
    metadata JSONB,                                -- 附加元数据 (来源、状态等)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT chk_quantity_positive CHECK (quantity > 0),
    CONSTRAINT unique_user_item_slot UNIQUE (user_id, item_id, slot_index)
);

-- 索引
CREATE INDEX idx_player_inventory_user ON player_inventory(user_id);
CREATE INDEX idx_player_inventory_item ON player_inventory(user_id, item_id);
CREATE INDEX idx_player_inventory_expires ON player_inventory(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_player_inventory_category ON player_inventory(user_id) INCLUDE (item_id, quantity);

-- 背包容量配置表
CREATE TABLE inventory_capacity (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    base_capacity INTEGER DEFAULT 350,             -- 基础容量
    pokeball_slots INTEGER DEFAULT 100,            -- 精灵球槽位
    potion_slots INTEGER DEFAULT 100,              -- 药水槽位
    tm_slots INTEGER DEFAULT 50,                   -- TM 槽位
    evolution_slots INTEGER DEFAULT 50,            -- 进化道具槽位
    special_slots INTEGER DEFAULT 50,              -- 特殊道具槽位
    total_used INTEGER DEFAULT 0,                  -- 已使用总量
    last_cleanup_at TIMESTAMP,                     -- 上次清理时间
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 道具使用记录表
CREATE TABLE item_usage_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id VARCHAR(50) NOT NULL REFERENCES items(item_id),
    pokemon_id INTEGER,                            -- 使用的精灵ID (如果有)
    action VARCHAR(50) NOT NULL,                   -- use, drop, trade, sell
    quantity INTEGER NOT NULL DEFAULT 1,
    source VARCHAR(100),                           -- 来源: catch, gym, shop, trade, quest
    context JSONB,                                 -- 使用上下文 (坐标、场景等)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_item_usage_user ON item_usage_logs(user_id, created_at DESC);
CREATE INDEX idx_item_usage_item ON item_usage_logs(item_id, created_at DESC);

-- 快速访问栏配置表
CREATE TABLE quick_access_slots (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0 AND slot_index < 8), -- 8个快捷栏位
    item_id VARCHAR(50) REFERENCES items(item_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT unique_user_quick_slot UNIQUE (user_id, slot_index)
);

-- 道具商店配置表
CREATE TABLE shop_items (
    id SERIAL PRIMARY KEY,
    item_id VARCHAR(50) NOT NULL REFERENCES items(item_id),
    price_coins INTEGER,                           -- 金币价格
    price_stardust INTEGER,                        -- 星尘价格
    bundle_quantity INTEGER DEFAULT 1,             -- 捆绑数量
    daily_limit INTEGER,                           -- 每日购买限制
    available_from TIMESTAMP,                      -- 上架时间
    available_until TIMESTAMP,                     -- 下架时间
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 种子数据：道具定义
INSERT INTO items (item_id, name, name_localized, description, category, rarity, max_stack, is_consumable, is_tradable, effect_data) VALUES
-- 精灵球类
('POKE_BALL', 'Poké Ball', '{"en": "Poké Ball", "zh": "精灵球", "ja": "モンスターボール"}', 'A basic Poké Ball for catching Pokémon.', 'pokeball', 'common', 999, true, true, '{"catch_rate": 1.0}'),
('GREAT_BALL', 'Great Ball', '{"en": "Great Ball", "zh": "超级球", "ja": "スーパーボール"}', 'A better Poké Ball with a higher catch rate.', 'pokeball', 'uncommon', 999, true, true, '{"catch_rate": 1.5}'),
('ULTRA_BALL', 'Ultra Ball', '{"en": "Ultra Ball", "zh": "高级球", "ja": "ハイパーボール"}', 'An ultra-high-performance Poké Ball.', 'pokeball', 'rare', 999, true, true, '{"catch_rate": 2.0}'),
('MASTER_BALL', 'Master Ball', '{"en": "Master Ball", "zh": "大师球", "ja": "マスターボール"}', 'A rare Ball that never fails to catch a Pokémon.', 'pokeball', 'legendary', 99, true, false, '{"catch_rate": 255.0}'),
('PREMIER_BALL', 'Premier Ball', '{"en": "Premier Ball", "zh": "纪念球", "ja": "プレミアボール"}', 'A special Ball only given out during raids.', 'pokeball', 'rare', 999, true, false, '{"catch_rate": 1.0, "raid_only": true}'),

-- 药水类
('POTION', 'Potion', '{"en": "Potion", "zh": "伤药", "ja": "キズぐすり"}', 'Restores 20 HP to a Pokémon.', 'potion', 'common', 999, true, true, '{"heal_hp": 20}'),
('SUPER_POTION', 'Super Potion', '{"en": "Super Potion", "zh": "好伤药", "ja": "いいキズぐすり"}', 'Restores 50 HP to a Pokémon.', 'potion', 'uncommon', 999, true, true, '{"heal_hp": 50}'),
('HYPER_POTION', 'Hyper Potion', '{"en": "Hyper Potion", "zh": "厉害伤药", "ja": "すごいキズぐすり"}', 'Restores 200 HP to a Pokémon.', 'potion', 'rare', 999, true, true, '{"heal_hp": 200}'),
('MAX_POTION', 'Max Potion', '{"en": "Max Potion", "zh": "全满药", "ja": "まんたんのくすり"}', 'Fully restores HP to a Pokémon.', 'potion', 'epic', 99, true, true, '{"heal_percent": 100}'),
('REVIVE', 'Revive', '{"en": "Revive", "zh": "复活药", "ja": "げんきのかたまり"}', 'Revives a fainted Pokémon with 50% HP.', 'potion', 'rare', 999, true, true, '{"revive_percent": 50}'),
('MAX_REVIVE', 'Max Revive', '{"en": "Max Revive", "zh": "全满复活药", "ja": "げんきのかたまり"}', 'Revives a fainted Pokémon with full HP.', 'potion', 'epic', 99, true, true, '{"revive_percent": 100}'),

-- 进化石
('SUN_STONE', 'Sun Stone', '{"en": "Sun Stone", "zh": "日之石", "ja": "たいようのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["SUNKERN", "GLOOM", "COTTONEE", "HELIOPTILE"]}'),
('MOON_STONE', 'Moon Stone', '{"en": "Moon Stone", "zh": "月之石", "ja": "つきのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["NIDORINA", "NIDORINO", "CLEFAIRY", "JIGGLYPUFF", "SKITTY", "MUNNA"]}'),
('FIRE_STONE', 'Fire Stone', '{"en": "Fire Stone", "zh": "火之石", "ja": "ほのおのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["VULPIX", "GROWLITHE", "EEVEE", "PANSEAR"]}'),
('WATER_STONE', 'Water Stone', '{"en": "Water Stone", "zh": "水之石", "ja": "みずのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["SHELLDER", "STARYU", "EEVEE", "LOMBRE", "PANPOUR"]}'),
('THUNDER_STONE', 'Thunder Stone', '{"en": "Thunder Stone", "zh": "雷之石", "ja": "かみなりのいし"}', 'Evolves certain Pokémon.', 'evolution', 'rare', 50, true, true, '{"evolution_items": ["PIKACHU", "EEVEE", "EELEKTRIK"]}'),
('KINGS_ROCK', 'King''s Rock', '{"en": "King''s Rock", "zh": "王者之证", "ja": "おうじゃのしるし"}', 'Evolves certain Pokémon when used with candy.', 'evolution', 'epic', 20, true, true, '{"evolution_items": ["SLOWPOKE", "POLIWHIRL"]}'),

-- 强化道具
('RARE_CANDY', 'Rare Candy', '{"en": "Rare Candy", "zh": "稀有糖果", "ja": "ふしぎなアメ"}', 'Increases a Pokémon''s CP by one level.', 'boost', 'epic', 99, true, true, '{"cp_boost": 1}'),
('SILVER_PINAP_BERRY', 'Silver Pinap Berry', '{"en": "Silver Pinap Berry", "zh": "银凤梨果", "ja": "ぎんのパイルのみ"}', 'Doubles candy and increases catch rate.', 'boost', 'rare', 99, true, true, '{"candy_multiplier": 2.0, "catch_rate_multiplier": 1.8}'),
('GOLDEN_RAZZ_BERRY', 'Golden Razz Berry', '{"en": "Golden Razz Berry", "zh": "金蔓莓果", "ja": "きんのズリのみ"}', 'Greatly increases catch rate.', 'boost', 'epic', 99, true, true, '{"catch_rate_multiplier": 2.5}'),

-- 特殊道具
('INCENSE', 'Incense', '{"en": "Incense", "zh": "熏香", "ja": "おこう"}', 'Attracts wild Pokémon to your location for 60 minutes.', 'special', 'rare', 99, true, false, '{"duration_minutes": 60, "spawn_rate_multiplier": 1.5}'),
('LUCKY_EGG', 'Lucky Egg', '{"en": "Lucky Egg", "zh": "幸运蛋", "ja": "しあわせタマゴ"}', 'Doubles XP for 30 minutes.', 'special', 'rare', 99, true, false, '{"duration_minutes": 30, "xp_multiplier": 2.0}'),
('LURE_MODULE', 'Lure Module', '{"en": "Lure Module", "zh": "诱饵模块", "ja": "ルアーモジュール"}', 'Attracts Pokémon to a PokéStop for 30 minutes.', 'special', 'uncommon', 99, true, false, '{"duration_minutes": 30, "radius_meters": 100}'),
('STAR_PIECE', 'Star Piece', '{"en": "Star Piece", "zh": "星之碎片", "ja": "ほしのかけら"}', 'Increases Stardust gain by 50% for 30 minutes.', 'special', 'rare', 99, true, false, '{"duration_minutes": 30, "stardust_multiplier": 1.5}');
```

### 2. 道具服务核心模块

```javascript
// backend/services/pokemon-service/src/inventoryService.js

const { Pool } = require('pg');
const Redis = require('ioredis');
const { logger, metrics } = require('../../shared');
const { EventBus } = require('../../shared/EventBus');

class InventoryService {
  constructor(config = {}) {
    this.db = config.db || new Pool();
    this.redis = config.redis || new Redis();
    this.eventBus = config.eventBus || EventBus;
    
    // 缓存配置
    this.cachePrefix = 'inventory:';
    this.cacheTTL = 300; // 5分钟
    
    // 道具效果处理器映射
    this.itemHandlers = new Map([
      ['pokeball', this.handlePokeball.bind(this)],
      ['potion', this.handlePotion.bind(this)],
      ['evolution', this.handleEvolution.bind(this)],
      ['boost', this.handleBoost.bind(this)],
      ['special', this.handleSpecial.bind(this)],
    ]);
  }

  /**
   * 获取玩家背包
   * @param {number} userId - 用户ID
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 背包数据
   */
  async getInventory(userId, options = {}) {
    const cacheKey = `${this.cachePrefix}${userId}`;
    
    try {
      // 尝试从缓存获取
      if (!options.skipCache) {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          metrics.increment('inventory.cache_hit');
          return JSON.parse(cached);
        }
      }
      
      metrics.increment('inventory.cache_miss');
      
      // 并行查询背包和容量
      const [inventoryResult, capacityResult, quickSlotsResult] = await Promise.all([
        this.db.query(`
          SELECT pi.*, i.name, i.name_localized, i.category, i.rarity, 
                 i.max_stack, i.icon_url, i.effect_data, i.is_consumable
          FROM player_inventory pi
          JOIN items i ON pi.item_id = i.item_id
          WHERE pi.user_id = $1 AND pi.quantity > 0
          ORDER BY i.category, i.rarity DESC, pi.acquired_at DESC
        `, [userId]),
        this.db.query(`
          SELECT * FROM inventory_capacity WHERE user_id = $1
        `, [userId]),
        this.db.query(`
          SELECT slot_index, item_id FROM quick_access_slots 
          WHERE user_id = $1 ORDER BY slot_index
        `, [userId])
      ]);
      
      // 按分类组织道具
      const categorizedItems = {
        pokeball: [],
        potion: [],
        tm: [],
        evolution: [],
        boost: [],
        special: [],
        cosmetic: []
      };
      
      let totalItems = 0;
      for (const row of inventoryResult.rows) {
        const item = {
          id: row.id,
          itemId: row.item_id,
          name: row.name,
          nameLocalized: row.name_localized,
          category: row.category,
          rarity: row.rarity,
          quantity: row.quantity,
          maxStack: row.max_stack,
          iconUrl: row.icon_url,
          effectData: row.effect_data,
          isConsumable: row.is_consumable,
          expiresAt: row.expires_at,
          metadata: row.metadata
        };
        
        if (categorizedItems[row.category]) {
          categorizedItems[row.category].push(item);
          totalItems += row.quantity;
        }
      }
      
      const capacity = capacityResult.rows[0] || {
        baseCapacity: 350,
        pokeballSlots: 100,
        potionSlots: 100,
        tmSlots: 50,
        evolutionSlots: 50,
        specialSlots: 50,
        totalUsed: totalItems
      };
      
      const quickSlots = quickSlotsResult.rows.reduce((acc, row) => {
        acc[row.slot_index] = row.item_id;
        return acc;
      }, {});
      
      const result = {
        items: categorizedItems,
        capacity,
        quickSlots,
        stats: {
          totalItems,
          totalSlots: capacity.base_capacity + 
            capacity.pokeball_slots + capacity.potion_slots + 
            capacity.tm_slots + capacity.evolution_slots + capacity.special_slots,
          usedSlots: totalItems
        }
      };
      
      // 写入缓存
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(result));
      
      return result;
      
    } catch (error) {
      logger.error('Failed to get inventory', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * 添加道具到背包
   * @param {number} userId - 用户ID
   * @param {string} itemId - 道具ID
   * @param {number} quantity - 数量
   * @param {Object} options - 选项
   * @returns {Promise<Object>} 添加结果
   */
  async addItem(userId, itemId, quantity = 1, options = {}) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取道具定义
      const itemDef = await client.query(`
        SELECT * FROM items WHERE item_id = $1
      `, [itemId]);
      
      if (itemDef.rows.length === 0) {
        throw new Error(`Item not found: ${itemId}`);
      }
      
      const item = itemDef.rows[0];
      
      // 检查背包容量
      const capacityCheck = await this.checkCapacity(userId, item.category, quantity, client);
      if (!capacityCheck.canAdd) {
        throw new Error(`Inventory full for category ${item.category}`);
      }
      
      // 计算过期时间
      let expiresAt = null;
      if (item.expires_after_days) {
        expiresAt = new Date(Date.now() + item.expires_after_days * 24 * 60 * 60 * 1000);
      } else if (options.expiresAt) {
        expiresAt = new Date(options.expiresAt);
      }
      
      // 查找现有道具堆叠
      const existingQuery = expiresAt 
        ? `SELECT * FROM player_inventory 
           WHERE user_id = $1 AND item_id = $2 AND quantity < $3
           ORDER BY quantity DESC, expires_at ASC NULLS LAST
           LIMIT 1`
        : `SELECT * FROM player_inventory 
           WHERE user_id = $1 AND item_id = $2 AND expires_at IS NULL AND quantity < $3
           ORDER BY quantity DESC
           LIMIT 1`;
      
      const existingResult = await client.query(existingQuery, 
        [userId, itemId, item.max_stack]);
      
      let addedQuantity = 0;
      let remaining = quantity;
      const updatedSlots = [];
      
      // 填充现有堆叠
      if (existingResult.rows.length > 0 && remaining > 0) {
        for (const slot of existingResult.rows) {
          const canAdd = Math.min(item.max_stack - slot.quantity, remaining);
          if (canAdd > 0) {
            await client.query(`
              UPDATE player_inventory 
              SET quantity = quantity + $1, updated_at = CURRENT_TIMESTAMP
              WHERE id = $2
            `, [canAdd, slot.id]);
            
            remaining -= canAdd;
            addedQuantity += canAdd;
            updatedSlots.push(slot.id);
          }
        }
      }
      
      // 创建新堆叠
      while (remaining > 0) {
        const stackQuantity = Math.min(item.max_stack, remaining);
        
        const insertResult = await client.query(`
          INSERT INTO player_inventory (user_id, item_id, quantity, expires_at, metadata)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING id
        `, [userId, itemId, stackQuantity, expiresAt, options.metadata || null]);
        
        remaining -= stackQuantity;
        addedQuantity += stackQuantity;
        updatedSlots.push(insertResult.rows[0].id);
      }
      
      // 更新容量使用
      await client.query(`
        INSERT INTO inventory_capacity (user_id, total_used)
        VALUES ($1, $2)
        ON CONFLICT (user_id) 
        DO UPDATE SET total_used = inventory_capacity.total_used + $2,
                      updated_at = CURRENT_TIMESTAMP
      `, [userId, addedQuantity]);
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.redis.del(`${this.cachePrefix}${userId}`);
      
      // 发布事件
      await this.eventBus.publish('inventory.item.added', {
        userId,
        itemId,
        quantity: addedQuantity,
        source: options.source || 'unknown'
      });
      
      metrics.increment('inventory.items_added', addedQuantity);
      
      return {
        success: true,
        itemId,
        quantityAdded: addedQuantity,
        updatedSlots
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to add item', { 
        userId, itemId, quantity, error: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 使用道具
   * @param {number} userId - 用户ID
   * @param {string} itemId - 道具ID
   * @param {Object} context - 使用上下文
   * @returns {Promise<Object>} 使用结果
   */
  async useItem(userId, itemId, context = {}) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取道具实例
      const itemInstance = await client.query(`
        SELECT pi.*, i.* 
        FROM player_inventory pi
        JOIN items i ON pi.item_id = i.item_id
        WHERE pi.user_id = $1 AND pi.item_id = $2 AND pi.quantity > 0
        ORDER BY pi.expires_at ASC NULLS LAST
        LIMIT 1
        FOR UPDATE
      `, [userId, itemId]);
      
      if (itemInstance.rows.length === 0) {
        throw new Error(`Item not in inventory: ${itemId}`);
      }
      
      const item = itemInstance.rows[0];
      
      // 检查过期
      if (item.expires_at && new Date(item.expires_at) < new Date()) {
        await client.query(`
          UPDATE player_inventory SET quantity = 0 
          WHERE id = $1
        `, [item.id]);
        await client.query('COMMIT');
        throw new Error('Item has expired');
      }
      
      // 验证使用条件
      const requirements = item.use_requirements || {};
      if (requirements.minLevel && context.userLevel < requirements.minLevel) {
        throw new Error(`Requires level ${requirements.minLevel}`);
      }
      
      // 执行道具效果
      const handler = this.itemHandlers.get(item.category);
      if (!handler) {
        throw new Error(`Unknown item category: ${item.category}`);
      }
      
      const effectResult = await handler.call(this, userId, item, context, client);
      
      // 消耗道具
      if (item.is_consumable) {
        await client.query(`
          UPDATE player_inventory 
          SET quantity = quantity - 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1
        `, [item.id]);
        
        // 更新容量
        await client.query(`
          UPDATE inventory_capacity 
          SET total_used = total_used - 1, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1
        `, [userId]);
      }
      
      // 记录使用日志
      await client.query(`
        INSERT INTO item_usage_logs (user_id, item_id, pokemon_id, action, quantity, context)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [userId, itemId, context.pokemonId, 'use', 1, JSON.stringify(context)]);
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.redis.del(`${this.cachePrefix}${userId}`);
      
      // 发布事件
      await this.eventBus.publish('inventory.item.used', {
        userId,
        itemId,
        category: item.category,
        pokemonId: context.pokemonId,
        effectResult
      });
      
      metrics.increment('inventory.items_used');
      
      return {
        success: true,
        itemId,
        quantityRemaining: item.quantity - (item.is_consumable ? 1 : 0),
        effect: effectResult
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to use item', { 
        userId, itemId, context, error: error.message 
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 处理精灵球使用
   */
  async handlePokeball(userId, item, context, client) {
    // 返回捕捉率加成，实际捕捉逻辑在 catch-service
    return {
      type: 'catch_bonus',
      catchRate: item.effect_data.catch_rate || 1.0,
      itemId: item.item_id
    };
  }

  /**
   * 处理药水使用
   */
  async handlePotion(userId, item, context, client) {
    if (!context.pokemonId) {
      throw new Error('Pokemon ID required for potion use');
    }
    
    // 查询精灵状态
    const pokemon = await client.query(`
      SELECT id, hp, max_hp, is_fainted FROM pokemon 
      WHERE id = $1 AND user_id = $2
    `, [context.pokemonId, userId]);
    
    if (pokemon.rows.length === 0) {
      throw new Error('Pokemon not found');
    }
    
    const pkm = pokemon.rows[0];
    const effect = item.effect_data;
    
    // 复活药水
    if (effect.revive_percent && pkm.is_fainted) {
      const healAmount = Math.floor(pkm.max_hp * effect.revive_percent / 100);
      await client.query(`
        UPDATE pokemon 
        SET hp = $1, is_fainted = false 
        WHERE id = $2
      `, [healAmount, context.pokemonId]);
      
      return { type: 'revive', healedHp: healAmount, maxHp: pkm.max_hp };
    }
    
    // 恢复HP
    if (pkm.is_fainted && !effect.revive_percent) {
      throw new Error('Pokemon is fainted, use revive item');
    }
    
    const healAmount = effect.heal_percent 
      ? Math.floor(pkm.max_hp * effect.heal_percent / 100)
      : effect.heal_hp;
    
    const newHp = Math.min(pkm.hp + healAmount, pkm.max_hp);
    const actualHeal = newHp - pkm.hp;
    
    await client.query(`
      UPDATE pokemon SET hp = $1 WHERE id = $2
    `, [newHp, context.pokemonId]);
    
    return { type: 'heal', healedHp: actualHeal, maxHp: pkm.max_hp };
  }

  /**
   * 处理进化石使用
   */
  async handleEvolution(userId, item, context, client) {
    if (!context.pokemonId) {
      throw new Error('Pokemon ID required for evolution item use');
    }
    
    // 进化逻辑在 pokemon-service 的 evolutionService
    return {
      type: 'evolution_item',
      itemId: item.item_id,
      applicableSpecies: item.effect_data.evolution_items || []
    };
  }

  /**
   * 处理强化道具使用
   */
  async handleBoost(userId, item, context, client) {
    const effect = item.effect_data;
    
    if (effect.cp_boost && context.pokemonId) {
      // 稀有糖果逻辑
      return {
        type: 'cp_boost',
        boost: effect.cp_boost,
        itemId: item.item_id
      };
    }
    
    if (effect.candy_multiplier || effect.catch_rate_multiplier) {
      // 浆果效果
      return {
        type: 'catch_boost',
        candyMultiplier: effect.candy_multiplier || 1.0,
        catchRateMultiplier: effect.catch_rate_multiplier || 1.0,
        itemId: item.item_id
      };
    }
    
    throw new Error('Unknown boost item effect');
  }

  /**
   * 处理特殊道具使用
   */
  async handleSpecial(userId, item, context, client) {
    const effect = item.effect_data;
    
    // 检查是否已在激活状态
    const activeKey = `active_effect:${userId}:${item.item_id}`;
    const active = await this.redis.get(activeKey);
    
    if (active) {
      throw new Error('Item effect already active');
    }
    
    // 设置激活状态
    const duration = (effect.duration_minutes || 30) * 60;
    await this.redis.setex(activeKey, duration, JSON.stringify({
      itemId: item.item_id,
      activatedAt: Date.now(),
      expiresAt: Date.now() + duration * 1000
    }));
    
    return {
      type: 'timed_effect',
      effect: item.item_id,
      durationMinutes: effect.duration_minutes,
      multipliers: {
        xp: effect.xp_multiplier,
        stardust: effect.stardust_multiplier,
        spawn: effect.spawn_rate_multiplier
      }
    };
  }

  /**
   * 检查背包容量
   */
  async checkCapacity(userId, category, quantity, client) {
    const capacityResult = await client.query(`
      SELECT * FROM inventory_capacity WHERE user_id = $1
    `, [userId]);
    
    const capacity = capacityResult.rows[0] || {
      base_capacity: 350,
      pokeball_slots: 100,
      potion_slots: 100,
      tm_slots: 50,
      evolution_slots: 50,
      special_slots: 50,
      total_used: 0
    };
    
    const categoryLimits = {
      pokeball: capacity.pokeball_slots,
      potion: capacity.potion_slots,
      tm: capacity.tm_slots,
      evolution: capacity.evolution_slots,
      boost: capacity.special_slots,
      special: capacity.special_slots,
      cosmetic: capacity.special_slots
    };
    
    const currentItems = await client.query(`
      SELECT COALESCE(SUM(quantity), 0) as total
      FROM player_inventory pi
      JOIN items i ON pi.item_id = i.item_id
      WHERE pi.user_id = $1 AND i.category = $2
    `, [userId, category]);
    
    const current = parseInt(currentItems.rows[0].total);
    const limit = categoryLimits[category] || capacity.base_capacity;
    
    return {
      canAdd: current + quantity <= limit,
      current,
      limit,
      remaining: limit - current
    };
  }

  /**
   * 丢弃道具
   */
  async dropItem(userId, itemId, quantity = 1) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 获取道具
      const item = await client.query(`
        SELECT pi.id, pi.quantity, i.is_droppable 
        FROM player_inventory pi
        JOIN items i ON pi.item_id = i.item_id
        WHERE pi.user_id = $1 AND pi.item_id = $2 AND pi.quantity > 0
        ORDER BY pi.expires_at ASC NULLS LAST
        LIMIT 1
        FOR UPDATE
      `, [userId, itemId]);
      
      if (item.rows.length === 0) {
        throw new Error('Item not found in inventory');
      }
      
      if (!item.rows[0].is_droppable) {
        throw new Error('Item cannot be dropped');
      }
      
      const dropQuantity = Math.min(quantity, item.rows[0].quantity);
      
      await client.query(`
        UPDATE player_inventory 
        SET quantity = quantity - $1, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [dropQuantity, item.rows[0].id]);
      
      await client.query(`
        UPDATE inventory_capacity 
        SET total_used = total_used - $1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $2
      `, [dropQuantity, userId]);
      
      await client.query(`
        INSERT INTO item_usage_logs (user_id, item_id, action, quantity)
        VALUES ($1, $2, $3, $4)
      `, [userId, itemId, 'drop', dropQuantity]);
      
      await client.query('COMMIT');
      
      await this.redis.del(`${this.cachePrefix}${userId}`);
      
      return { success: true, droppedQuantity: dropQuantity };
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 清理过期道具（定时任务）
   */
  async cleanupExpiredItems() {
    const result = await this.db.query(`
      UPDATE player_inventory 
      SET quantity = 0, updated_at = CURRENT_TIMESTAMP
      WHERE expires_at IS NOT NULL 
        AND expires_at < CURRENT_TIMESTAMP
        AND quantity > 0
      RETURNING user_id, item_id, quantity
    `);
    
    // 更新容量并发布事件
    for (const row of result.rows) {
      await this.db.query(`
        UPDATE inventory_capacity 
        SET total_used = GREATEST(total_used - $1, 0), 
            last_cleanup_at = CURRENT_TIMESTAMP
        WHERE user_id = $2
      `, [row.quantity, row.user_id]);
      
      await this.redis.del(`${this.cachePrefix}${row.user_id}`);
    }
    
    if (result.rows.length > 0) {
      logger.info('Cleaned up expired items', { 
        count: result.rows.length,
        totalQuantity: result.rows.reduce((sum, r) => sum + r.quantity, 0)
      });
    }
    
    metrics.gauge('inventory.expired_items_cleaned', result.rows.length);
    
    return result.rows.length;
  }

  /**
   * 设置快速访问栏
   */
  async setQuickSlot(userId, slotIndex, itemId) {
    if (slotIndex < 0 || slotIndex >= 8) {
      throw new Error('Invalid slot index');
    }
    
    // 验证道具存在
    if (itemId) {
      const item = await this.db.query(`
        SELECT 1 FROM player_inventory 
        WHERE user_id = $1 AND item_id = $2 AND quantity > 0
      `, [userId, itemId]);
      
      if (item.rows.length === 0) {
        throw new Error('Item not in inventory');
      }
    }
    
    await this.db.query(`
      INSERT INTO quick_access_slots (user_id, slot_index, item_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, slot_index) 
      DO UPDATE SET item_id = $3, updated_at = CURRENT_TIMESTAMP
    `, [userId, slotIndex, itemId]);
    
    await this.redis.del(`${this.cachePrefix}${userId}`);
    
    return { success: true };
  }
}

module.exports = { InventoryService };
```

### 3. API 路由设计

```javascript
// backend/services/pokemon-service/src/routes/inventory.js

const express = require('express');
const router = express.Router();
const { InventoryService } = require('../inventoryService');
const { authMiddleware } = require('../../../shared/middleware/auth');
const { rateLimiter } = require('../../../shared/middleware/rateLimit');
const { logger } = require('../../../shared');

const inventoryService = new InventoryService();

/**
 * GET /api/v1/inventory
 * 获取玩家背包
 */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const inventory = await inventoryService.getInventory(req.user.id);
    res.json({
      success: true,
      data: inventory
    });
  } catch (error) {
    logger.error('Failed to get inventory', { 
      userId: req.user.id, 
      error: error.message 
    });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get inventory' 
    });
  }
});

/**
 * GET /api/v1/inventory/:itemId
 * 获取道具详情
 */
router.get('/:itemId', authMiddleware, async (req, res) => {
  try {
    const { itemId } = req.params;
    const inventory = await inventoryService.getInventory(req.user.id);
    
    // 查找道具
    for (const category of Object.values(inventory.items)) {
      const item = category.find(i => i.itemId === itemId);
      if (item) {
        return res.json({ success: true, data: item });
      }
    }
    
    res.status(404).json({ 
      success: false, 
      error: 'Item not found in inventory' 
    });
  } catch (error) {
    logger.error('Failed to get item', { 
      userId: req.user.id, 
      itemId: req.params.itemId, 
      error: error.message 
    });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get item' 
    });
  }
});

/**
 * POST /api/v1/inventory/use
 * 使用道具
 */
router.post('/use', authMiddleware, rateLimiter({ windowMs: 1000, max: 10 }), async (req, res) => {
  try {
    const { itemId, pokemonId, context } = req.body;
    
    const result = await inventoryService.useItem(req.user.id, itemId, {
      pokemonId,
      userLevel: req.user.level,
      ...context
    });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to use item', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * POST /api/v1/inventory/drop
 * 丢弃道具
 */
router.post('/drop', authMiddleware, async (req, res) => {
  try {
    const { itemId, quantity } = req.body;
    
    const result = await inventoryService.dropItem(
      req.user.id, 
      itemId, 
      quantity || 1
    );
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to drop item', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * PUT /api/v1/inventory/quick-slot
 * 设置快速访问栏
 */
router.put('/quick-slot', authMiddleware, async (req, res) => {
  try {
    const { slotIndex, itemId } = req.body;
    
    const result = await inventoryService.setQuickSlot(
      req.user.id, 
      slotIndex, 
      itemId
    );
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to set quick slot', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * GET /api/v1/inventory/capacity
 * 获取背包容量信息
 */
router.get('/capacity', authMiddleware, async (req, res) => {
  try {
    const inventory = await inventoryService.getInventory(req.user.id);
    res.json({
      success: true,
      data: {
        capacity: inventory.capacity,
        stats: inventory.stats
      }
    });
  } catch (error) {
    logger.error('Failed to get capacity', { 
      userId: req.user.id, 
      error: error.message 
    });
    res.status(500).json({ 
      success: false, 
      error: 'Failed to get capacity' 
    });
  }
});

module.exports = router;
```

### 4. 与其他服务的集成

```javascript
// 在 catch-service 中集成道具系统
// backend/services/catch-service/src/index.js

// 使用精灵球捕捉
async function attemptCatch(userId, pokemon, pokeballItemId) {
  // 验证并消耗精灵球
  const useResult = await inventoryService.useItem(userId, pokeballItemId, {
    context: 'catch'
  });
  
  const catchRate = useResult.effect.catchRate;
  
  // 计算捕捉成功率
  const success = calculateCatchSuccess(pokemon, catchRate);
  
  if (success) {
    // 奖励道具
    await inventoryService.addItem(userId, 'POKE_BALL', 1, {
      source: 'catch_reward'
    });
  }
  
  return { success };
}

// 在 reward-service 中集成道具奖励
// backend/services/reward-service/src/index.js

async function grantRaidRewards(userId, raidLevel) {
  const rewards = [];
  
  // 根据副本等级奖励道具
  if (raidLevel >= 5) {
    rewards.push(
      inventoryService.addItem(userId, 'RARE_CANDY', 3, { source: 'raid' }),
      inventoryService.addItem(userId, 'GOLDEN_RAZZ_BERRY', 2, { source: 'raid' })
    );
  }
  
  rewards.push(
    inventoryService.addItem(userId, 'PREMIER_BALL', calculatePremierBalls(raidLevel), { 
      source: 'raid',
      expiresAt: Date.now() + 24 * 60 * 60 * 1000 // 24小时后过期
    })
  );
  
  await Promise.all(rewards);
}
```

### 5. 前端组件

```javascript
// frontend/game-client/src/components/Inventory.js

import React, { useState, useEffect } from 'react';
import { TouchableOpacity, View, Text, FlatList, Modal } from 'react-native';
import { useQuery, useMutation } from '@tanstack/react-query';
import { fetchInventory, useItem, dropItem } from '../api/inventory';
import { ItemDetail } from './ItemDetail';

const CATEGORY_ICONS = {
  pokeball: '🔴',
  potion: '💊',
  tm: '💿',
  evolution: '💎',
  boost: '⭐',
  special: '✨',
  cosmetic: '🎨'
};

const CATEGORY_NAMES = {
  pokeball: '精灵球',
  potion: '药水',
  tm: '技能机器',
  evolution: '进化石',
  boost: '强化道具',
  special: '特殊道具',
  cosmetic: '装饰品'
};

export function InventoryScreen() {
  const [selectedCategory, setSelectedCategory] = useState('pokeball');
  const [selectedItem, setSelectedItem] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  
  const { data: inventory, isLoading, refetch } = useQuery({
    queryKey: ['inventory'],
    queryFn: fetchInventory,
    staleTime: 30000
  });
  
  const useItemMutation = useMutation({
    mutationFn: ({ itemId, pokemonId }) => useItem(itemId, pokemonId),
    onSuccess: () => {
      refetch();
      setShowDetail(false);
    }
  });
  
  const dropItemMutation = useMutation({
    mutationFn: ({ itemId, quantity }) => dropItem(itemId, quantity),
    onSuccess: () => refetch()
  });
  
  if (isLoading) {
    return <LoadingSpinner />;
  }
  
  const items = inventory?.items?.[selectedCategory] || [];
  const capacity = inventory?.capacity || {};
  const stats = inventory?.stats || {};
  
  return (
    <View style={styles.container}>
      {/* 容量指示器 */}
      <View style={styles.capacityBar}>
        <Text style={styles.capacityText}>
          背包: {stats.totalItems} / {stats.totalSlots}
        </Text>
        <View style={styles.capacityProgress}>
          <View 
            style={[
              styles.capacityFill,
              { width: `${(stats.totalItems / stats.totalSlots) * 100}%` }
            ]} 
          />
        </View>
      </View>
      
      {/* 分类选择器 */}
      <View style={styles.categorySelector}>
        {Object.keys(CATEGORY_ICONS).map(category => (
          <TouchableOpacity
            key={category}
            style={[
              styles.categoryButton,
              selectedCategory === category && styles.categoryButtonActive
            ]}
            onPress={() => setSelectedCategory(category)}
          >
            <Text style={styles.categoryIcon}>
              {CATEGORY_ICONS[category]}
            </Text>
            <Text style={styles.categoryName}>
              {CATEGORY_NAMES[category]}
            </Text>
            <Text style={styles.categoryCount}>
              {inventory?.items?.[category]?.length || 0}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      
      {/* 道具列表 */}
      <FlatList
        data={items}
        keyExtractor={(item) => `${item.itemId}-${item.id}`}
        numColumns={2}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.itemCard}
            onPress={() => {
              setSelectedItem(item);
              setShowDetail(true);
            }}
          >
            <ItemImage 
              itemId={item.itemId} 
              iconUrl={item.iconUrl}
              rarity={item.rarity}
            />
            <Text style={styles.itemName}>
              {item.nameLocalized?.zh || item.name}
            </Text>
            <Text style={styles.itemQuantity}>x{item.quantity}</Text>
            {item.expiresAt && (
              <Text style={styles.expiryTimer}>
                {formatTimeRemaining(item.expiresAt)}
              </Text>
            )}
          </TouchableOpacity>
        )}
        style={styles.itemList}
      />
      
      {/* 快速访问栏 */}
      <QuickAccessBar 
        slots={inventory?.quickSlots}
        onSelectItem={(itemId) => {
          if (itemId) {
            const item = items.find(i => i.itemId === itemId);
            if (item) {
              setSelectedItem(item);
              setShowDetail(true);
            }
          }
        }}
      />
      
      {/* 道具详情弹窗 */}
      <Modal
        visible={showDetail}
        animationType="slide"
        transparent
        onRequestClose={() => setShowDetail(false)}
      >
        <ItemDetail
          item={selectedItem}
          onUse={(pokemonId) => {
            useItemMutation.mutate({
              itemId: selectedItem.itemId,
              pokemonId
            });
          }}
          onDrop={(quantity) => {
            dropItemMutation.mutate({
              itemId: selectedItem.itemId,
              quantity
            });
          }}
          onClose={() => setShowDetail(false)}
        />
      </Modal>
    </View>
  );
}

// 快速访问栏组件
function QuickAccessBar({ slots, onSelectItem }) {
  return (
    <View style={styles.quickAccessBar}>
      {[0, 1, 2, 3, 4, 5, 6, 7].map(index => (
        <TouchableOpacity
          key={index}
          style={styles.quickSlot}
          onPress={() => onSelectItem(slots?.[index])}
        >
          {slots?.[index] ? (
            <ItemImage itemId={slots[index]} size="small" />
          ) : (
            <Text style={styles.emptySlot}>+</Text>
          )}
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a2e'
  },
  capacityBar: {
    padding: 16,
    backgroundColor: '#16213e'
  },
  capacityText: {
    color: '#fff',
    fontSize: 14,
    marginBottom: 8
  },
  capacityProgress: {
    height: 8,
    backgroundColor: '#0f0f23',
    borderRadius: 4,
    overflow: 'hidden'
  },
  capacityFill: {
    height: '100%',
    backgroundColor: '#4CAF50'
  },
  categorySelector: {
    flexDirection: 'row',
    padding: 8,
    backgroundColor: '#16213e'
  },
  categoryButton: {
    flex: 1,
    alignItems: 'center',
    padding: 8,
    borderRadius: 8,
    margin: 2
  },
  categoryButtonActive: {
    backgroundColor: '#4a90d9'
  },
  categoryIcon: {
    fontSize: 24
  },
  categoryName: {
    color: '#fff',
    fontSize: 10,
    marginTop: 4
  },
  categoryCount: {
    color: '#aaa',
    fontSize: 10
  },
  itemList: {
    flex: 1,
    padding: 8
  },
  itemCard: {
    flex: 1,
    margin: 4,
    padding: 12,
    backgroundColor: '#16213e',
    borderRadius: 12,
    alignItems: 'center'
  },
  itemName: {
    color: '#fff',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center'
  },
  itemQuantity: {
    color: '#4CAF50',
    fontSize: 14,
    fontWeight: 'bold'
  },
  expiryTimer: {
    color: '#ff6b6b',
    fontSize: 10,
    marginTop: 4
  },
  quickAccessBar: {
    flexDirection: 'row',
    padding: 8,
    backgroundColor: '#16213e',
    borderTopWidth: 1,
    borderTopColor: '#333'
  },
  quickSlot: {
    flex: 1,
    height: 48,
    margin: 2,
    backgroundColor: '#0f0f23',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptySlot: {
    color: '#666',
    fontSize: 24
  }
});
```

## 验收标准

- [ ] 数据库表结构创建完成，包含 items、player_inventory 等表
- [ ] 道具种子数据包含至少 20 种基础道具（精灵球、药水、进化石等）
- [ ] 背包查询 API 返回按分类组织的道具列表
- [ ] 道具添加支持堆叠、过期时间、容量检查
- [ ] 道具使用支持 5 种类型（精灵球、药水、进化石、强化、特殊）
- [ ] 药水使用能正确恢复/复活精灵
- [ ] 特殊道具（熏香、幸运蛋）激活持续效果
- [ ] 道具丢弃功能正常工作
- [ ] 快速访问栏设置和读取正常
- [ ] 过期道具自动清理定时任务运行
- [ ] 与 catch-service 集成，消耗精灵球捕捉
- [ ] 与 reward-service 集成，奖励道具
- [ ] Redis 缓存正确失效
- [ ] 事件发布和订阅正常
- [ ] 单元测试覆盖核心逻辑（30+ 测试用例）
- [ ] API 文档更新
- [ ] 前端背包界面显示正常
- [ ] 容量限制和提示正常

## 影响范围

- **数据库**：新增 6 个表（items, player_inventory, inventory_capacity, item_usage_logs, quick_access_slots, shop_items）
- **后端服务**：
  - pokemon-service: 新增 inventoryService.js, routes/inventory.js
  - catch-service: 集成道具消耗逻辑
  - reward-service: 集成道具奖励逻辑
  - gateway: 新增路由代理
- **前端**：新增 InventoryScreen.js, ItemDetail.js, QuickAccessBar.js
- **缓存**：Redis 新增背包缓存键
- **事件**：新增 inventory.item.added, inventory.item.used 事件

## 参考

- [Pokémon GO Items](https://pokemon.fandom.com/wiki/Item)
- [游戏道具系统设计模式](https://www.gameprogrammingpatterns.com/)
- [PostgreSQL JSON 类型最佳实践](https://www.postgresql.org/docs/current/datatype-json.html)
