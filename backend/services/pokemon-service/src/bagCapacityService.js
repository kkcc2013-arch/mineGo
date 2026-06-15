/**
 * Bag Capacity Service - 精灵背包容量管理服务
 * REQ-00110: 精灵背包容量管理与扩展系统
 * 
 * 功能:
 * - 背包容量查询与管理
 * - 容量扩展（金币/钻石）
 * - 容量预警
 * - 批量操作
 */

'use strict';

const { query, transaction, getPool } = require('../../../shared/db');
const cache = require('../../../shared/cache');
const metrics = require('../../../shared/metrics');
const logger = require('../../../shared/logger');

class BagCapacityService {
  constructor() {
    this.CACHE_TTL = 300; // 5 分钟缓存
    this.CACHE_PREFIX = 'bag_capacity:';
    this.DEFAULT_CAPACITY = 300;
    this.MAX_CAPACITY = 3000;
    this.EXPANSION_UNIT = 50;
  }

  /**
   * 获取玩家背包容量信息
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 容量信息对象
   */
  async getBagCapacity(userId) {
    const cacheKey = `${this.CACHE_PREFIX}${userId}`;
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    try {
      const result = await query(`
        SELECT 
          pbc.*,
          u.level as player_level,
          u.vip_level,
          (SELECT COUNT(*) FROM pokemon WHERE user_id = pbc.user_id AND is_released = FALSE AND storage_status = 'bag') as actual_pokemon_count
        FROM player_bag_capacity pbc
        JOIN users u ON u.id = pbc.user_id
        WHERE pbc.user_id = $1
      `, [userId]);

      if (result.rows.length === 0) {
        return await this.initializeBagCapacity(userId);
      }

      const data = result.rows[0];
      const capacityInfo = {
        currentCapacity: data.current_capacity,
        usedSlots: parseInt(data.actual_pokemon_count) || data.used_slots,
        freeSlots: data.current_capacity - (parseInt(data.actual_pokemon_count) || data.used_slots),
        maxPurchased: data.max_ever_purchased,
        bonusCapacity: data.bonus_capacity,
        utilizationRate: ((parseInt(data.actual_pokemon_count) || data.used_slots) / data.current_capacity) * 100,
        canExpand: data.current_capacity < this.getMaxCapacityByLevel(data.player_level),
        vipBonus: this.getVipBonus(data.vip_level),
        playerLevel: data.player_level
      };

      await cache.set(cacheKey, capacityInfo, this.CACHE_TTL);
      return capacityInfo;
    } catch (error) {
      logger.error('[BagCapacityService] getBagCapacity error:', error);
      throw error;
    }
  }

  /**
   * 初始化玩家背包容量
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 初始容量信息
   */
  async initializeBagCapacity(userId) {
    try {
      const user = await query('SELECT level, vip_level FROM users WHERE id = $1', [userId]);
      if (user.rows.length === 0) {
        throw new Error('User not found');
      }

      const playerLevel = user.rows[0].level || 1;
      const vipLevel = user.rows[0].vip_level || 0;
      const baseCapacity = this.getBaseCapacity(playerLevel);
      const vipBonus = this.getVipBonus(vipLevel);
      const totalCapacity = baseCapacity + vipBonus;

      const result = await query(`
        INSERT INTO player_bag_capacity (user_id, current_capacity, bonus_capacity, used_slots)
        VALUES ($1, $2, $3, 0)
        ON CONFLICT (user_id) DO UPDATE 
        SET current_capacity = EXCLUDED.current_capacity,
            bonus_capacity = EXCLUDED.bonus_capacity,
            updated_at = NOW()
        RETURNING *
      `, [userId, totalCapacity, vipBonus]);

      const capacityInfo = {
        currentCapacity: result.rows[0].current_capacity,
        usedSlots: 0,
        freeSlots: result.rows[0].current_capacity,
        maxPurchased: 0,
        bonusCapacity: vipBonus,
        utilizationRate: 0,
        canExpand: true,
        vipBonus,
        playerLevel
      };

      // 创建默认预警配置
      await query(`
        INSERT INTO bag_alert_config (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);

      metrics.gauge('bag_capacity_initialized', totalCapacity, { userId: String(userId) });

      return capacityInfo;
    } catch (error) {
      logger.error('[BagCapacityService] initializeBagCapacity error:', error);
      throw error;
    }
  }

  /**
   * 扩展背包容量
   * @param {number} userId - 用户ID
   * @param {Object} options - 扩展选项
   * @returns {Promise<Object>} 扩展结果
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

      // 4. 计算新容量
      const maxCapacity = this.getMaxCapacityByLevel(capacityInfo.playerLevel);
      const newCapacity = Math.min(
        capacityInfo.currentCapacity + units * this.EXPANSION_UNIT,
        maxCapacity
      );
      
      const actualAdded = newCapacity - capacityInfo.currentCapacity;
      
      // 5. 更新容量
      await client.query(`
        UPDATE player_bag_capacity 
        SET current_capacity = $1, 
            max_ever_purchased = GREATEST(max_ever_purchased, $2),
            last_capacity_check = NOW(),
            updated_at = NOW()
        WHERE user_id = $3
      `, [newCapacity, newCapacity - capacityInfo.bonusCapacity, userId]);

      // 6. 记录历史
      await client.query(`
        INSERT INTO bag_expansion_history 
        (user_id, expansion_type, units, capacity_before, capacity_after, cost_amount, cost_currency)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [userId, method, units, capacityInfo.currentCapacity, newCapacity, cost.amount, cost.currency]);

      // 7. 清除缓存
      await cache.del(`${this.CACHE_PREFIX}${userId}`);

      // 8. 指标记录
      metrics.increment('bag_capacity_expanded', actualAdded, { method, userId: String(userId) });
      metrics.increment('bag_expansion_revenue', cost.amount, { currency: cost.currency, userId: String(userId) });

      logger.info('[BagCapacityService] Bag expanded', {
        userId,
        previousCapacity: capacityInfo.currentCapacity,
        newCapacity,
        method,
        cost: cost.amount
      });

      return {
        success: true,
        previousCapacity: capacityInfo.currentCapacity,
        newCapacity,
        unitsAdded: actualAdded,
        cost: cost.amount,
        currency: cost.currency
      };
    });
  }

  /**
   * 计算扩展成本
   * @param {number} userId - 用户ID
   * @param {number} units - 扩展单位数
   * @param {string} method - 支付方式
   * @returns {Promise<Object>} 成本信息
   */
  async calculateExpansionCost(userId, units, method) {
    try {
      const capacityInfo = await this.getBagCapacity(userId);
      
      // 获取配置
      const configResult = await query(`
        SELECT * FROM bag_capacity_config 
        WHERE player_level_min <= $1 
        AND (player_level_max IS NULL OR player_level_max >= $1)
        AND is_active = TRUE
        ORDER BY player_level_min DESC 
        LIMIT 1
      `, [capacityInfo.playerLevel]);
      
      const config = configResult.rows[0] || {
        gold_cost_per_unit: 200,
        diamond_cost_per_unit: 100
      };
      
      let baseCost;
      if (method === 'gold') {
        baseCost = (config.gold_cost_per_unit || 200) * units;
      } else if (method === 'diamond') {
        baseCost = (config.diamond_cost_per_unit || 100) * units;
      } else {
        throw new Error(`Invalid payment method: ${method}`);
      }

      // 阶梯价格（已购买越多越贵，最多 +50%）
      const multiplier = 1 + Math.min((capacityInfo.maxPurchased / 500) * 0.5, 0.5);
      
      return {
        amount: Math.floor(baseCost * multiplier),
        currency: method,
        baseCost,
        multiplier: multiplier.toFixed(2)
      };
    } catch (error) {
      logger.error('[BagCapacityService] calculateExpansionCost error:', error);
      throw error;
    }
  }

  /**
   * 检查背包是否已满
   * @param {number} userId - 用户ID
   * @param {number} additionalSlots - 额外需要的槽位
   * @returns {Promise<Object>} 检查结果
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
      utilizationRate: capacityInfo.utilizationRate,
      needSlots: Math.max(0, additionalSlots - capacityInfo.freeSlots),
      recommendation: this.getRecommendation(capacityInfo.utilizationRate)
    };
  }

  /**
   * 批量精灵转移/释放
   * @param {number} userId - 用户ID
   * @param {Array<number>} pokemonIds - 精灵ID列表
   * @param {string} action - 操作类型
   * @returns {Promise<Object>} 操作结果
   */
  async batchTransferPokemon(userId, pokemonIds, action) {
    return await transaction(async (client) => {
      // 1. 验证精灵归属
      const pokemonResult = await client.query(`
        SELECT id, species_id, is_favorited, cp
        FROM pokemon 
        WHERE id = ANY($1) AND user_id = $2 AND is_released = FALSE AND storage_status = 'bag'
      `, [pokemonIds, userId]);

      if (pokemonResult.rows.length !== pokemonIds.length) {
        const foundIds = pokemonResult.rows.map(p => p.id);
        const missingIds = pokemonIds.filter(id => !foundIds.includes(id));
        throw new Error(`Some pokemon not found or already released: ${missingIds.join(', ')}`);
      }

      // 2. 检查收藏精灵
      const favorited = pokemonResult.rows.filter(p => p.is_favorited);
      if (favorited.length > 0 && action === 'release') {
        throw new Error(`Cannot release favorited pokemon. Please unfavorite first: ${favorited.map(p => p.id).join(', ')}`);
      }

      // 3. 执行操作
      let candyReward = 0;
      
      if (action === 'release') {
        await client.query(`
          UPDATE pokemon 
          SET is_released = TRUE, released_at = NOW()
          WHERE id = ANY($1)
        `, [pokemonIds]);

        // 计算糖果奖励（基于CP）
        candyReward = pokemonResult.rows.reduce((sum, p) => {
          return sum + Math.max(1, Math.floor(p.cp / 100));
        }, 0);
        
        await client.query(`
          UPDATE users SET candy = COALESCE(candy, 0) + $1 WHERE id = $2
        `, [candyReward, userId]);

      } else if (action === 'transfer_to_storage') {
        await client.query(`
          UPDATE pokemon SET storage_status = 'storage' WHERE id = ANY($1)
        `, [pokemonIds]);
      }

      // 4. 清除缓存
      await cache.del(`${this.CACHE_PREFIX}${userId}`);

      metrics.increment(`pokemon_${action}`, pokemonIds.length, { userId: String(userId) });
      
      if (candyReward > 0) {
        metrics.increment('candy_earned_from_release', candyReward, { userId: String(userId) });
      }

      logger.info('[BagCapacityService] Batch transfer completed', {
        userId,
        action,
        count: pokemonIds.length,
        candyReward
      });

      return {
        success: true,
        affectedCount: pokemonIds.length,
        action,
        candyReward
      };
    });
  }

  /**
   * 设置收藏标记
   * @param {number} userId - 用户ID
   * @param {number} pokemonId - 精灵ID
   * @param {boolean} isFavorited - 是否收藏
   * @returns {Promise<Object>} 更新结果
   */
  async setFavorite(userId, pokemonId, isFavorited) {
    const result = await query(`
      UPDATE pokemon 
      SET is_favorited = $1, favorite_at = CASE WHEN $1 THEN NOW() ELSE NULL END
      WHERE id = $2 AND user_id = $3 AND is_released = FALSE
      RETURNING id, is_favorited, favorite_at
    `, [isFavorited, pokemonId, userId]);

    if (result.rows.length === 0) {
      throw new Error('Pokemon not found or already released');
    }

    metrics.increment('pokemon_favorite_toggle', 1, { 
      action: isFavorited ? 'add' : 'remove',
      userId: String(userId)
    });

    return result.rows[0];
  }

  /**
   * 获取扩展历史
   * @param {number} userId - 用户ID
   * @param {number} limit - 限制条数
   * @returns {Promise<Array>} 历史记录
   */
  async getExpansionHistory(userId, limit = 50) {
    const result = await query(`
      SELECT * FROM bag_expansion_history 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2
    `, [userId, limit]);

    return result.rows;
  }

  /**
   * 更新预警配置
   * @param {number} userId - 用户ID
   * @param {Object} config - 配置对象
   * @returns {Promise<Object>} 更新结果
   */
  async updateAlertConfig(userId, config) {
    const fields = [];
    const values = [userId];
    let paramCount = 1;

    if (config.enableAlert !== undefined) {
      fields.push(`enable_alert = $${++paramCount}`);
      values.push(config.enableAlert);
    }
    if (config.alertThresholds !== undefined) {
      fields.push(`alert_thresholds = $${++paramCount}`);
      values.push(config.alertThresholds);
    }
    if (config.autoTransferToStorage !== undefined) {
      fields.push(`auto_transfer_to_storage = $${++paramCount}`);
      values.push(config.autoTransferToStorage);
    }
    if (config.notificationMethod !== undefined) {
      fields.push(`notification_method = $${++paramCount}`);
      values.push(config.notificationMethod);
    }

    if (fields.length === 0) {
      throw new Error('No valid config fields provided');
    }

    fields.push('updated_at = NOW()');

    const result = await query(`
      INSERT INTO bag_alert_config (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO UPDATE SET ${fields.join(', ')}
      RETURNING *
    `, values);

    return result.rows[0];
  }

  // ==================== 私有方法 ====================

  /**
   * 处理支付
   */
  async processPayment(userId, cost, method, client) {
    const currencyField = method === 'gold' ? 'gold' : 'diamond';
    
    // 查询余额
    const balanceResult = await (client || { query }).query(`
      SELECT ${currencyField} as balance FROM users WHERE id = $1 FOR UPDATE
    `, [userId]);
    
    const balance = balanceResult.rows[0]?.balance || 0;
    
    if (balance < cost.amount) {
      return { success: false, balance, required: cost.amount };
    }

    // 扣除货币
    await (client || { query }).query(`
      UPDATE users SET ${currencyField} = ${currencyField} - $1 WHERE id = $2
    `, [cost.amount, userId]);

    return { success: true, balance: balance - cost.amount };
  }

  /**
   * 获取VIP加成
   */
  getVipBonus(vipLevel) {
    const bonuses = { 1: 50, 2: 100, 3: 150, 4: 200, 5: 300 };
    return bonuses[vipLevel] || 0;
  }

  /**
   * 获取基础容量
   */
  getBaseCapacity(playerLevel) {
    // 每升 5 级 +10 容量
    return this.DEFAULT_CAPACITY + Math.floor(playerLevel / 5) * 10;
  }

  /**
   * 获取最大容量（基于等级）
   */
  getMaxCapacityByLevel(playerLevel) {
    return Math.min(this.MAX_CAPACITY, 500 + Math.floor(playerLevel / 10) * 200);
  }

  /**
   * 获取建议
   */
  getRecommendation(utilizationRate) {
    if (utilizationRate >= 95) {
      return 'critical';
    } else if (utilizationRate >= 90) {
      return 'warning';
    } else if (utilizationRate >= 85) {
      return 'notice';
    }
    return 'normal';
  }
}

module.exports = new BagCapacityService();
