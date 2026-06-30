// backend/services/pokemon-service/src/bagUpgradeService.js
// REQ-00150: 背包容量扩展与购买系统
'use strict';

const { query, transaction } = require('../../../shared/db');
const { getRedis, setJSON, getJSON, delKey } = require('../../../shared/redis');
const { AppError, Errors } = require('../../../shared/errorHandler');
const EventBus = require('../../../shared/EventBus');

const CACHE_PREFIX = 'bag_upgrade:';
const CONFIG_CACHE_KEY = 'bag_upgrade_configs';
const CONFIG_CACHE_TTL = 300; // 5分钟

/**
 * 背包扩容服务
 */
class BagUpgradeService {
  constructor(logger = console) {
    this.logger = logger;
    this.metrics = this.initMetrics();
  }

  /**
   * 初始化 Prometheus 指标
   */
  initMetrics() {
    // 如果 Prometheus 可用，注册指标
    if (global.promRegistry) {
      const { Counter, Gauge } = require('prom-client');
      
      this.bagUpgradesPurchased = new Counter({
        name: 'minego_bag_upgrades_purchased_total',
        help: 'Total bag upgrades purchased',
        labelNames: ['category', 'method'],
        registers: [global.promRegistry]
      });
      
      this.bagUpgradeRevenue = new Counter({
        name: 'minego_bag_upgrade_revenue_total',
        help: 'Total revenue from bag upgrades',
        labelNames: ['currency'],
        registers: [global.promRegistry]
      });
      
      this.bagUpgradeErrors = new Counter({
        name: 'minego_bag_upgrade_errors_total',
        help: 'Total bag upgrade errors',
        labelNames: ['error_type'],
        registers: [global.promRegistry]
      });
    }
    
    return {
      incrementPurchase: (category, method) => {
        if (this.bagUpgradesPurchased) {
          this.bagUpgradesPurchased.increment({ category, method });
        }
      },
      recordRevenue: (currency, amount) => {
        if (this.bagUpgradeRevenue) {
          this.bagUpgradeRevenue.increment({ currency }, amount);
        }
      },
      recordError: (errorType) => {
        if (this.bagUpgradeErrors) {
          this.bagUpgradeErrors.increment({ error_type: errorType });
        }
      }
    };
  }

  /**
   * 获取所有扩容配置列表
   * @param {number} userId - 用户ID
   * @returns {Promise<Array>} 配置列表（包含已购买次数）
   */
  async getUpgradeConfigs(userId) {
    // 先检查缓存
    const cachedConfigs = await getJSON(CONFIG_CACHE_KEY);
    
    let configs;
    if (cachedConfigs) {
      configs = cachedConfigs;
    } else {
      // 从数据库获取配置
      const result = await query(`
        SELECT 
          upgrade_id, category, increment, gold_cost, gem_cost,
          required_level, max_upgrades, display_order, is_active
        FROM bag_upgrade_config 
        WHERE is_active = true 
        ORDER BY category, display_order
      `);
      
      configs = result.rows;
      
      // 缓存配置
      await setJSON(CONFIG_CACHE_KEY, configs, CONFIG_CACHE_TTL);
    }
    
    // 获取用户已购买记录
    const purchaseResult = await query(`
      SELECT upgrade_id, COUNT(*) as purchase_count
      FROM player_bag_upgrades
      WHERE user_id = $1
      GROUP BY upgrade_id
    `, [userId]);
    
    const purchaseMap = new Map(
      purchaseResult.rows.map(r => [r.upgrade_id, parseInt(r.purchase_count)])
    );
    
    // 获取用户当前容量
    const capacityResult = await query(`
      SELECT * FROM inventory_capacity WHERE user_id = $1
    `, [userId]);
    
    const currentCapacity = capacityResult.rows[0] || {};
    
    // 计算每个配置的可用状态
    return configs.map(config => {
      const purchased = purchaseMap.get(config.upgrade_id) || 0;
      const remaining = config.max_upgrades - purchased;
      
      // 计算购买后的新容量
      const categorySlotColumn = this.getCategoryColumn(config.category);
      const currentSlots = currentCapacity[categorySlotColumn] || this.getDefaultCapacity(config.category);
      
      return {
        ...config,
        purchased,
        remaining,
        available: remaining > 0,
        currentSlots,
        newSlots: currentSlots + config.increment * remaining,
        canPurchaseGold: config.gold_cost && remaining > 0,
        canPurchaseGem: config.gem_cost && remaining > 0
      };
    });
  }

  /**
   * 获取单个配置详情
   * @param {string} upgradeId - 配置ID
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 配置详情
   */
  async getUpgradeConfig(upgradeId, userId) {
    const configs = await this.getUpgradeConfigs(userId);
    return configs.find(c => c.upgrade_id === upgradeId);
  }

  /**
   * 购买背包扩容
   * @param {number} userId - 用户ID
   * @param {string} upgradeId - 配置ID
   * @param {string} method - 购买方式 ('gold' | 'gem')
   * @param {Object} options - 额外选项
   * @returns {Promise<Object>} 购买结果
   */
  async purchaseBagUpgrade(userId, upgradeId, method, options = {}) {
    // 验证购买方式
    if (!['gold', 'gem'].includes(method)) {
      throw Errors.invalidRequest({ method }, { message: 'Invalid purchase method, must be gold or gem' });
    }
    
    const result = await transaction(async (client) => {
      // 1. 获取配置
      const configResult = await client.query(
        `SELECT * FROM bag_upgrade_config WHERE upgrade_id = $1 AND is_active = true`,
        [upgradeId]
      );
      
      if (configResult.rows.length === 0) {
        throw Errors.notFound({ upgradeId }, { message: 'Upgrade config not found or inactive' });
      }
      
      const config = configResult.rows[0];
      
      // 2. 检查购买次数限制
      const purchaseCountResult = await client.query(
        `SELECT COUNT(*) as count FROM player_bag_upgrades WHERE user_id = $1 AND upgrade_id = $2`,
        [userId, upgradeId]
      );
      
      const currentPurchases = parseInt(purchaseCountResult.rows[0].count);
      
      if (currentPurchases >= config.max_upgrades) {
        throw Errors.validationError(
          { upgradeId, currentPurchases, max: config.max_upgrades },
          { message: 'Maximum upgrades reached for this configuration' }
        );
      }
      
      // 3. 确定价格
      const cost = method === 'gold' ? config.gold_cost : config.gem_cost;
      
      if (!cost || cost <= 0) {
        throw Errors.invalidRequest(
          { upgradeId, method },
          { message: `Cannot purchase this upgrade with ${method}` }
        );
      }
      
      // 4. 检查用户余额
      const balanceResult = await client.query(
        `SELECT gold, gems FROM users WHERE id = $1`,
        [userId]
      );
      
      if (balanceResult.rows.length === 0) {
        throw Errors.userNotFound({ userId });
      }
      
      const balance = balanceResult.rows[0];
      const userBalance = method === 'gold' ? balance.gold : balance.gems;
      
      if (userBalance < cost) {
        throw Errors.insufficientBalance(
          { method, required: cost, current: userBalance },
          { message: `Insufficient ${method} balance` }
        );
      }
      
      // 5. 检查用户等级要求
      const userResult = await client.query(
        `SELECT level FROM users WHERE id = $1`,
        [userId]
      );
      
      const userLevel = userResult.rows[0]?.level || 1;
      
      if (userLevel < config.required_level) {
        throw Errors.validationError(
          { requiredLevel: config.required_level, currentLevel: userLevel },
          { message: `Requires level ${config.required_level} to purchase` }
        );
      }
      
      // 6. 获取当前容量
      const categoryColumn = this.getCategoryColumn(config.category);
      const capacityResult = await client.query(
        `SELECT ${categoryColumn} as current_slots FROM inventory_capacity WHERE user_id = $1`,
        [userId]
      );
      
      const oldCapacity = parseInt(capacityResult.rows[0]?.current_slots) || this.getDefaultCapacity(config.category);
      
      // 7. 扣款
      const currencyColumn = method === 'gold' ? 'gold' : 'gems';
      await client.query(
        `UPDATE users SET ${currencyColumn} = ${currencyColumn} - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [cost, userId]
      );
      
      // 8. 记录购买
      const transactionId = `BAG-${upgradeId}-${userId}-${Date.now()}`;
      await client.query(
        `INSERT INTO player_bag_upgrades (user_id, upgrade_id, purchase_method, cost_amount, transaction_id) 
         VALUES ($1, $2, $3, $4, $5)`,
        [userId, upgradeId, method, cost, transactionId]
      );
      
      // 9. 更新容量
      await client.query(
        `UPDATE inventory_capacity 
         SET ${categoryColumn} = ${categoryColumn} + $1, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $2`,
        [config.increment, userId]
      );
      
      // 10. 记录审计日志
      await client.query(
        `INSERT INTO bag_upgrade_audit_log (user_id, upgrade_id, action, purchase_method, cost_amount, old_capacity, new_capacity, performed_by)
         VALUES ($1, $2, 'purchase', $3, $4, $5, $6, $1)`,
        [userId, upgradeId, method, cost, oldCapacity, oldCapacity + config.increment]
      );
      
      return {
        success: true,
        upgradeId,
        category: config.category,
        increment: config.increment,
        oldCapacity,
        newCapacity: oldCapacity + config.increment,
        method,
        cost,
        transactionId,
        purchasedCount: currentPurchases + 1,
        remainingUpgrades: config.max_upgrades - currentPurchases - 1
      };
    });
    
    // 清除缓存
    await this.clearUserCache(userId);
    
    // 发布事件
    await this.publishPurchaseEvent(userId, result);
    
    // 记录指标
    this.metrics.incrementPurchase(config.category, method);
    this.metrics.recordRevenue(method, cost);
    
    this.logger.info({
      module: 'BagUpgradeService',
      action: 'purchase',
      userId,
      upgradeId,
      method,
      cost,
      category: config.category
    }, 'Bag upgrade purchased successfully');
    
    return result;
  }

  /**
   * 赠送免费扩容（成就/活动/管理员）
   * @param {number} userId - 用户ID
   * @param {string} upgradeId - 配置ID
   * @param {string} reason - 赠送原因 ('achievement' | 'event' | 'free' | 'vip' | 'admin')
   * @param {number} performedBy - 操作人ID（管理员赠送时）
   * @returns {Promise<Object>} 赠送结果
   */
  async grantFreeUpgrade(userId, upgradeId, reason, performedBy = null) {
    // 验证赠送原因
    const validReasons = ['achievement', 'event', 'free', 'vip', 'admin'];
    if (!validReasons.includes(reason)) {
      throw Errors.invalidRequest({ reason }, { message: 'Invalid grant reason' });
    }
    
    const result = await transaction(async (client) => {
      // 1. 获取配置
      const configResult = await client.query(
        `SELECT * FROM bag_upgrade_config WHERE upgrade_id = $1`,
        [upgradeId]
      );
      
      if (configResult.rows.length === 0) {
        throw Errors.notFound({ upgradeId });
      }
      
      const config = configResult.rows[0];
      
      // 2. 检查购买次数（免费赠送也计入次数限制）
      const purchaseCountResult = await client.query(
        `SELECT COUNT(*) as count FROM player_bag_upgrades WHERE user_id = $1 AND upgrade_id = $2`,
        [userId, upgradeId]
      );
      
      const currentPurchases = parseInt(purchaseCountResult.rows[0].count);
      
      if (currentPurchases >= config.max_upgrades) {
        throw Errors.validationError(
          { upgradeId, currentPurchases, max: config.max_upgrades },
          { message: 'Maximum upgrades reached' }
        );
      }
      
      // 3. 获取当前容量
      const categoryColumn = this.getCategoryColumn(config.category);
      const capacityResult = await client.query(
        `SELECT ${categoryColumn} as current_slots FROM inventory_capacity WHERE user_id = $1`,
        [userId]
      );
      
      const oldCapacity = parseInt(capacityResult.rows[0]?.current_slots) || this.getDefaultCapacity(config.category);
      
      // 4. 记录赠送（cost_amount = 0）
      const transactionId = `GRANT-${upgradeId}-${userId}-${Date.now()}`;
      await client.query(
        `INSERT INTO player_bag_upgrades (user_id, upgrade_id, purchase_method, cost_amount, transaction_id) 
         VALUES ($1, $2, $3, 0, $4)`,
        [userId, upgradeId, reason, transactionId]
      );
      
      // 5. 更新容量
      await client.query(
        `UPDATE inventory_capacity 
         SET ${categoryColumn} = ${categoryColumn} + $1, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $2`,
        [config.increment, userId]
      );
      
      // 6. 记录审计日志
      await client.query(
        `INSERT INTO bag_upgrade_audit_log (user_id, upgrade_id, action, purchase_method, cost_amount, old_capacity, new_capacity, performed_by, notes)
         VALUES ($1, $2, 'grant', $3, 0, $4, $5, $6, $7)`,
        [userId, upgradeId, reason, oldCapacity, oldCapacity + config.increment, performedBy || userId, `Granted via ${reason}`]
      );
      
      return {
        success: true,
        upgradeId,
        category: config.category,
        increment: config.increment,
        oldCapacity,
        newCapacity: oldCapacity + config.increment,
        reason,
        transactionId,
        purchasedCount: currentPurchases + 1,
        remainingUpgrades: config.max_upgrades - currentPurchases - 1
      };
    });
    
    // 清除缓存
    await this.clearUserCache(userId);
    
    // 发布事件
    await EventBus.publish('bag.upgrade.granted', {
      userId,
      upgradeId,
      category: result.category,
      increment: result.increment,
      reason
    });
    
    this.logger.info({
      module: 'BagUpgradeService',
      action: 'grant',
      userId,
      upgradeId,
      reason,
      category: result.category
    }, 'Free bag upgrade granted');
    
    return result;
  }

  /**
   * 获取用户扩容统计
   * @param {number} userId - 用户ID
   * @returns {Promise<Object>} 统计信息
   */
  async getUserUpgradeStats(userId) {
    const result = await query(`
      SELECT 
        COUNT(*) as total_upgrades,
        SUM(CASE WHEN purchase_method = 'gold' THEN cost_amount ELSE 0 END) as total_gold_spent,
        SUM(CASE WHEN purchase_method = 'gem' THEN cost_amount ELSE 0 END) as total_gem_spent,
        SUM(CASE WHEN purchase_method IN ('achievement', 'event', 'free', 'vip', 'admin') THEN 1 ELSE 0 END) as free_upgrades,
        MAX(purchased_at) as last_upgrade_time
      FROM player_bag_upgrades
      WHERE user_id = $1
    `, [userId]);
    
    return result.rows[0] || {
      total_upgrades: 0,
      total_gold_spent: 0,
      total_gem_spent: 0,
      free_upgrades: 0,
      last_upgrade_time: null
    };
  }

  /**
   * 获取用户扩容历史
   * @param {number} userId - 用户ID
   * @param {number} limit - 返回条数
   * @returns {Promise<Array>} 购买历史
   */
  async getUserUpgradeHistory(userId, limit = 20) {
    const result = await query(`
      SELECT 
        pbu.*,
        buc.category,
        buc.increment
      FROM player_bag_upgrades pbu
      JOIN bag_upgrade_config buc ON pbu.upgrade_id = buc.upgrade_id
      WHERE pbu.user_id = $1
      ORDER BY pbu.purchased_at DESC
      LIMIT $2
    `, [userId, limit]);
    
    return result.rows;
  }

  /**
   * 发布购买事件
   */
  async publishPurchaseEvent(userId, purchaseResult) {
    await EventBus.publish('bag.upgrade.purchased', {
      userId,
      upgradeId: purchaseResult.upgradeId,
      category: purchaseResult.category,
      increment: purchaseResult.increment,
      method: purchaseResult.method,
      cost: purchaseResult.cost,
      transactionId: purchaseResult.transactionId,
      purchasedAt: new Date().toISOString()
    });
  }

  /**
   * 清除用户缓存
   */
  async clearUserCache(userId) {
    await delKey(`${CACHE_PREFIX}configs:${userId}`);
    await delKey(`inventory_capacity:${userId}`);
  }

  /**
   * 获取类别对应的数据库列名
   */
  getCategoryColumn(category) {
    const columnMap = {
      'base': 'max_items',
      'pokeball': 'pokeball_slots',
      'potion': 'potion_slots',
      'tm': 'tm_slots',
      'evolution': 'evolution_slots',
      'berry': 'berry_slots',
      'special': 'special_slots',
      'misc': 'misc_slots'
    };
    return columnMap[category] || 'max_items';
  }

  /**
   * 获取类别的默认容量
   */
  getDefaultCapacity(category) {
    const defaults = {
      'base': 350,
      'pokeball': 50,
      'potion': 50,
      'tm': 20,
      'evolution': 30,
      'berry': 50,
      'special': 20,
      'misc': 100
    };
    return defaults[category] || 50;
  }

  /**
   * 批量检查用户是否可以购买多个配置
   * @param {number} userId - 用户ID
   * @param {Array<string>} upgradeIds - 配置ID列表
   * @returns {Promise<Object>} 可购买状态
   */
  async checkBatchPurchaseAvailability(userId, upgradeIds) {
    const configs = await this.getUpgradeConfigs(userId);
    
    const results = {};
    for (const upgradeId of upgradeIds) {
      const config = configs.find(c => c.upgrade_id === upgradeId);
      results[upgradeId] = config ? {
        available: config.available,
        canPurchaseGold: config.canPurchaseGold,
        canPurchaseGem: config.canPurchaseGem,
        remaining: config.remaining,
        currentSlots: config.currentSlots
      } : { available: false, error: 'Config not found' };
    }
    
    return results;
  }
}

// 导出服务实例
const bagUpgradeService = new BagUpgradeService();

module.exports = {
  BagUpgradeService,
  bagUpgradeService
};