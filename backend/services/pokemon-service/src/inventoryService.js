// backend/services/pokemon-service/src/inventoryService.js
// REQ-00047: 精灵道具与背包管理系统
// 核心背包服务

'use strict';

const { Pool } = require('pg');
const Redis = require('ioredis');
const { logger, metrics } = require('../../../shared');
const { EventBus } = require('../../../shared/EventBus');

/**
 * 背包服务类
 */
class InventoryService {
  constructor(config = {}) {
    this.db = config.db || new Pool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      database: process.env.DB_NAME || 'minego',
      user: process.env.DB_USER || 'minego_user',
      password: process.env.DB_PASSWORD || 'minego_pass'
    });
    
    this.redis = config.redis || new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD
    });
    
    this.eventBus = config.eventBus || EventBus;
    
    // 缓存配置
    this.cachePrefix = 'inventory:';
    this.cacheTTL = 300; // 5分钟
    
    // Prometheus 指标
    this.registerMetrics();
    
    // 道具效果处理器映射
    this.itemHandlers = new Map([
      ['pokeball', this.handlePokeball.bind(this)],
      ['potion', this.handlePotion.bind(this)],
      ['evolution', this.handleEvolution.bind(this)],
      ['boost', this.handleBoost.bind(this)],
      ['special', this.handleSpecial.bind(this)]
    ]);
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    this.metrics = {
      itemsAdded: metrics.counter(
        'inventory_items_added_total',
        'Total items added to inventory',
        ['user_id', 'item_id', 'category', 'source']
      ),
      itemsUsed: metrics.counter(
        'inventory_items_used_total',
        'Total items used from inventory',
        ['user_id', 'item_id', 'category']
      ),
      itemsDropped: metrics.counter(
        'inventory_items_dropped_total',
        'Total items dropped from inventory',
        ['user_id', 'item_id']
      ),
      cacheHits: metrics.counter(
        'inventory_cache_hits_total',
        'Inventory cache hit count'
      ),
      cacheMisses: metrics.counter(
        'inventory_cache_misses_total',
        'Inventory cache miss count'
      ),
      // REQ-00150: 背包扩容指标
      bagUpgradesPurchased: metrics.counter(
        'inventory_bag_upgrades_purchased_total',
        'Total bag upgrades purchased',
        ['user_id', 'category', 'method']
      ),
      bagUpgradeRevenue: metrics.counter(
        'inventory_bag_upgrade_revenue_total',
        'Total revenue from bag upgrades',
        ['currency', 'amount']
      )
    };
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
          this.metrics.cacheHits.inc();
          return JSON.parse(cached);
        }
      }
      
      this.metrics.cacheMisses.inc();
      
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
        base_capacity: 350,
        pokeball_slots: 100,
        potion_slots: 100,
        tm_slots: 50,
        evolution_slots: 50,
        special_slots: 50,
        total_used: totalItems
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
      if (this.eventBus) {
        await this.eventBus.publish('inventory.item.added', {
          userId,
          itemId,
          quantity: addedQuantity,
          category: item.category,
          source: options.source || 'unknown'
        });
      }
      
      // 记录指标
      this.metrics.itemsAdded.inc({ 
        user_id: userId, 
        item_id: itemId, 
        category: item.category,
        source: options.source || 'unknown' 
      }, addedQuantity);
      
      logger.info('Item added to inventory', {
        userId,
        itemId,
        quantity: addedQuantity,
        source: options.source
      });
      
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
      if (this.eventBus) {
        await this.eventBus.publish('inventory.item.used', {
          userId,
          itemId,
          category: item.category,
          pokemonId: context.pokemonId,
          effectResult
        });
      }
      
      // 记录指标
      this.metrics.itemsUsed.inc({ 
        user_id: userId, 
        item_id: itemId,
        category: item.category
      });
      
      logger.info('Item used', {
        userId,
        itemId,
        category: item.category,
        pokemonId: context.pokemonId
      });
      
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
      return {
        type: 'cp_boost',
        boost: effect.cp_boost,
        itemId: item.item_id
      };
    }
    
    if (effect.candy_multiplier || effect.catch_rate_multiplier) {
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
      
      this.metrics.itemsDropped.inc({ user_id: userId, item_id: itemId }, dropQuantity);
      
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

  /**
   * 获取激活的道具效果
   */
  async getActiveEffects(userId) {
    const keys = await this.redis.keys(`active_effect:${userId}:*`);
    const effects = [];
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (data) {
        const effect = JSON.parse(data);
        const itemId = key.split(':')[2];
        const ttl = await this.redis.ttl(key);
        
        effects.push({
          itemId,
          ...effect,
          remainingSeconds: ttl
        });
      }
    }
    
    return effects;
  }

  // ========== REQ-00150: 背包容量扩展与购买系统 ==========

  /**
   * 获取扩容配置列表
   */
  async getUpgradeConfigs(userId) {
    const cacheKey = `bag_upgrade_configs:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.metrics.cacheHits.inc();
      return JSON.parse(cached);
    }
    
    this.metrics.cacheMisses.inc();
    
    // 获取配置和玩家已购买记录
    const [configsResult, purchasesResult] = await Promise.all([
      this.db.query(`
        SELECT * FROM bag_upgrade_config 
        WHERE is_active = true 
        ORDER BY category, increment
      `),
      this.db.query(`
        SELECT upgrade_id, COUNT(*) as purchase_count
        FROM player_bag_upgrades
        WHERE user_id = $1
        GROUP BY upgrade_id
      `, [userId])
    ]);
    
    const purchaseMap = new Map(
      purchasesResult.rows.map(r => [r.upgrade_id, parseInt(r.purchase_count)])
    );
    
    // 计算每个配置的可用状态
    const result = configsResult.rows.map(config => ({
      upgrade_id: config.upgrade_id,
      category: config.category,
      increment: config.increment,
      gold_cost: config.gold_cost,
      gem_cost: config.gem_cost,
      required_level: config.required_level,
      max_upgrades: config.max_upgrades,
      purchased: purchaseMap.get(config.upgrade_id) || 0,
      available: (purchaseMap.get(config.upgrade_id) || 0) < config.max_upgrades
    }));
    
    await this.redis.setex(cacheKey, 300, JSON.stringify(result));
    return result;
  }

  /**
   * 购买背包扩容
   */
  async purchaseBagUpgrade(userId, upgradeId, method) {
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      // 1. 获取配置
      const configResult = await client.query(
        'SELECT * FROM bag_upgrade_config WHERE upgrade_id = $1 AND is_active = true',
        [upgradeId]
      );
      
      if (configResult.rows.length === 0) {
        throw new Error('Upgrade config not found');
      }
      
      const config = configResult.rows[0];
      
      // 2. 检查购买次数
      const purchaseCount = await client.query(
        'SELECT COUNT(*) FROM player_bag_upgrades WHERE user_id = $1 AND upgrade_id = $2',
        [userId, upgradeId]
      );
      
      if (parseInt(purchaseCount.rows[0].count) >= config.max_upgrades) {
        throw new Error('Maximum upgrades reached');
      }
      
      // 3. 确定价格
      const cost = method === 'gold' ? config.gold_cost : config.gem_cost;
      if (!cost) {
        throw new Error(`Cannot purchase with ${method}`);
      }
      
      // 4. 扣款（调用 user-service）
      const currencyField = method === 'gold' ? 'gold' : 'gems';
      const deductResult = await client.query(
        `UPDATE users SET ${currencyField} = ${currencyField} - $1 
         WHERE id = $2 AND ${currencyField} >= $1
         RETURNING ${currencyField}`,
        [cost, userId]
      );
      
      if (deductResult.rows.length === 0) {
        throw new Error('Insufficient balance');
      }
      
      // 5. 记录购买
      await client.query(
        'INSERT INTO player_bag_upgrades (user_id, upgrade_id, purchase_method, cost_amount) VALUES ($1, $2, $3, $4)',
        [userId, upgradeId, method, cost]
      );
      
      // 6. 更新容量
      const categoryField = `${config.category}_slots`;
      await client.query(
        `UPDATE inventory_capacity 
         SET ${categoryField} = ${categoryField} + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [config.increment, userId]
      );
      
      await client.query('COMMIT');
      
      // 清除缓存
      await this.redis.del(`${this.cachePrefix}${userId}`);
      await this.redis.del(`bag_upgrade_configs:${userId}`);
      
      // 发布事件
      if (this.eventBus) {
        await this.eventBus.publish('bag.upgrade.purchased', {
          userId,
          upgradeId,
          category: config.category,
          increment: config.increment,
          method,
          cost
        });
      }
      
      // 上报指标
      this.metrics.bagUpgradesPurchased.inc({ 
        user_id: userId.toString(), 
        category: config.category,
        method 
      });
      
      this.metrics.bagUpgradeRevenue.inc({
        currency: method,
        amount: cost
      });
      
      logger.info('Bag upgrade purchased', {
        userId,
        upgradeId,
        method,
        cost,
        category: config.category,
        increment: config.increment
      });
      
      return {
        success: true,
        category: config.category,
        increment: config.increment,
        cost,
        method,
        newBalance: deductResult.rows[0][currencyField]
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to purchase bag upgrade', {
        userId,
        upgradeId,
        method,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 赠送免费扩容（成就/活动奖励）
   */
  async grantFreeUpgrade(userId, upgradeId, reason) {
    const configResult = await this.db.query(
      'SELECT * FROM bag_upgrade_config WHERE upgrade_id = $1',
      [upgradeId]
    );
    
    if (configResult.rows.length === 0) {
      throw new Error('Upgrade config not found');
    }
    
    const config = configResult.rows[0];
    const client = await this.db.connect();
    
    try {
      await client.query('BEGIN');
      
      await client.query(
        'INSERT INTO player_bag_upgrades (user_id, upgrade_id, purchase_method, cost_amount) VALUES ($1, $2, $3, 0)',
        [userId, upgradeId, reason]
      );
      
      const categoryField = `${config.category}_slots`;
      await client.query(
        `UPDATE inventory_capacity 
         SET ${categoryField} = ${categoryField} + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [config.increment, userId]
      );
      
      await client.query('COMMIT');
      
      await this.redis.del(`${this.cachePrefix}${userId}`);
      
      logger.info('Free bag upgrade granted', {
        userId,
        upgradeId,
        reason,
        category: config.category,
        increment: config.increment
      });
      
      return { 
        success: true, 
        category: config.category,
        increment: config.increment,
        reason 
      };
      
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to grant free upgrade', {
        userId,
        upgradeId,
        reason,
        error: error.message
      });
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = { InventoryService };
