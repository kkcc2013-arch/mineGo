// backend/services/pokemon-service/src/routes/inventory.js
// REQ-00047: 精灵道具与背包管理系统 - API 路由

'use strict';

const express = require('express');
const router = express.Router();
const { InventoryService } = require('../inventoryService');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../../shared/auth');
const { rateLimiter } = require('../../../../shared/middleware/rateLimit');
const { logger } = require('../../../../shared');
const metrics = require('../../../../shared/metrics');

const inventoryService = new InventoryService();

/**
 * GET /api/v1/inventory
 * 获取玩家背包
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const inventory = await inventoryService.getInventory(req.user.id);
    successResp(res, inventory);
  } catch (error) {
    logger.error('Failed to get inventory', { 
      userId: req.user.id, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * GET /api/v1/inventory/:itemId
 * 获取道具详情
 */
router.get('/:itemId', requireAuth, async (req, res, next) => {
  try {
    const { itemId } = req.params;
    const inventory = await inventoryService.getInventory(req.user.id);
    
    // 查找道具
    for (const category of Object.values(inventory.items)) {
      const item = category.find(i => i.itemId === itemId);
      if (item) {
        return successResp(res, item);
      }
    }
    
    throw new AppError(404, 'Item not found in inventory');
  } catch (error) {
    logger.error('Failed to get item', { 
      userId: req.user.id, 
      itemId: req.params.itemId, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/v1/inventory/use
 * 使用道具
 */
router.post('/use', requireAuth, rateLimiter({ windowMs: 1000, max: 10 }), async (req, res, next) => {
  try {
    const { itemId, pokemonId, context } = req.body;
    
    if (!itemId) {
      throw new AppError(400, 'itemId is required');
    }
    
    const result = await inventoryService.useItem(req.user.id, itemId, {
      pokemonId,
      userLevel: req.user.level,
      ...context
    });
    
    successResp(res, result);
  } catch (error) {
    logger.error('Failed to use item', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/v1/inventory/drop
 * 丢弃道具
 */
router.post('/drop', requireAuth, async (req, res, next) => {
  try {
    const { itemId, quantity } = req.body;
    
    if (!itemId) {
      throw new AppError(400, 'itemId is required');
    }
    
    const result = await inventoryService.dropItem(
      req.user.id, 
      itemId, 
      quantity || 1
    );
    
    successResp(res, result);
  } catch (error) {
    logger.error('Failed to drop item', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * PUT /api/v1/inventory/quick-slot
 * 设置快速访问栏
 */
router.put('/quick-slot', requireAuth, async (req, res, next) => {
  try {
    const { slotIndex, itemId } = req.body;
    
    if (slotIndex === undefined || slotIndex === null) {
      throw new AppError(400, 'slotIndex is required');
    }
    
    const result = await inventoryService.setQuickSlot(
      req.user.id, 
      slotIndex, 
      itemId
    );
    
    successResp(res, result);
  } catch (error) {
    logger.error('Failed to set quick slot', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * GET /api/v1/inventory/capacity
 * 获取背包容量信息
 */
router.get('/capacity/info', requireAuth, async (req, res, next) => {
  try {
    const inventory = await inventoryService.getInventory(req.user.id);
    successResp(res, {
      capacity: inventory.capacity,
      stats: inventory.stats
    });
  } catch (error) {
    logger.error('Failed to get capacity', { 
      userId: req.user.id, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * GET /api/v1/inventory/active-effects
 * 获取激活的道具效果
 */
router.get('/active-effects/list', requireAuth, async (req, res, next) => {
  try {
    const effects = await inventoryService.getActiveEffects(req.user.id);
    successResp(res, { effects });
  } catch (error) {
    logger.error('Failed to get active effects', { 
      userId: req.user.id, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/v1/inventory/add
 * 添加道具（内部接口，供其他服务调用）
 */
router.post('/add', requireAuth, async (req, res, next) => {
  try {
    const { itemId, quantity, source, expiresAt, metadata } = req.body;
    
    if (!itemId) {
      throw new AppError(400, 'itemId is required');
    }
    
    const result = await inventoryService.addItem(
      req.user.id, 
      itemId, 
      quantity || 1,
      { source, expiresAt, metadata }
    );
    
    successResp(res, result);
  } catch (error) {
    logger.error('Failed to add item', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/v1/inventory/bulk-add
 * 批量添加道具（内部接口）
 */
router.post('/bulk-add', requireAuth, async (req, res, next) => {
  try {
    const { items, source } = req.body;
    
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError(400, 'items array is required');
    }
    
    const results = [];
    for (const item of items) {
      const result = await inventoryService.addItem(
        req.user.id, 
        item.itemId, 
        item.quantity || 1,
        { source, expiresAt: item.expiresAt, metadata: item.metadata }
      );
      results.push(result);
    }
    
    successResp(res, { 
      success: true, 
      added: results.length,
      results 
    });
  } catch (error) {
    logger.error('Failed to bulk add items', { 
      userId: req.user.id, 
      body: req.body, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * GET /api/v1/inventory/items/list
 * 获取所有道具定义（公共数据）
 */
router.get('/items/list', async (req, res, next) => {
  try {
    const { category, rarity } = req.query;
    
    let query = 'SELECT * FROM items WHERE 1=1';
    const params = [];
    
    if (category) {
      params.push(category);
      query += ` AND category = $${params.length}`;
    }
    
    if (rarity) {
      params.push(rarity);
      query += ` AND rarity = $${params.length}`;
    }
    
    query += ' ORDER BY category, rarity DESC, name';
    
    const result = await inventoryService.db.query(query, params);
    successResp(res, { items: result.rows });
  } catch (error) {
    logger.error('Failed to list items', { error: error.message });
    next(error);
  }
});

/**
 * GET /api/v1/inventory/items/:itemId
 * 获取道具定义详情
 */
router.get('/items/detail/:itemId', async (req, res, next) => {
  try {
    const { itemId } = req.params;
    
    const result = await inventoryService.db.query(
      'SELECT * FROM items WHERE item_id = $1',
      [itemId]
    );
    
    if (result.rows.length === 0) {
      throw new AppError(404, 'Item not found');
    }
    
    successResp(res, result.rows[0]);
  } catch (error) {
    logger.error('Failed to get item detail', { 
      itemId: req.params.itemId, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/v1/inventory/cleanup
 * 清理过期道具（管理员接口）
 */
router.post('/cleanup', requireAuth, async (req, res, next) => {
  try {
    // 检查管理员权限
    if (req.user.role !== 'admin') {
      throw new AppError(403, 'Admin access required');
    }
    
    const cleanedCount = await inventoryService.cleanupExpiredItems();
    
    successResp(res, { 
      success: true, 
      cleanedCount,
      message: `Cleaned up ${cleanedCount} expired items`
    });
  } catch (error) {
    logger.error('Failed to cleanup expired items', { 
      userId: req.user.id, 
      error: error.message 
    });
    next(error);
  }
});

// ========== REQ-00150: 背包容量扩展与购买系统 ==========

/**
 * GET /api/v1/inventory/upgrades
 * 获取扩容配置列表
 */
router.get('/upgrades', requireAuth, async (req, res, next) => {
  try {
    const configs = await inventoryService.getUpgradeConfigs(req.user.id);
    successResp(res, configs);
  } catch (error) {
    logger.error('Failed to get upgrade configs', { 
      userId: req.user.id, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/v1/inventory/upgrades/:upgradeId/purchase
 * 购买背包扩容
 */
router.post('/upgrades/:upgradeId/purchase', requireAuth, rateLimiter({ windowMs: 60000, max: 5 }), async (req, res, next) => {
  try {
    const { upgradeId } = req.params;
    const { method } = req.body; // 'gold' | 'gem'
    
    if (!['gold', 'gem'].includes(method)) {
      throw new AppError(400, 'Invalid purchase method. Must be "gold" or "gem"');
    }
    
    const result = await inventoryService.purchaseBagUpgrade(
      req.user.id, 
      upgradeId, 
      method
    );
    
    successResp(res, result);
  } catch (error) {
    logger.error('Failed to purchase bag upgrade', { 
      userId: req.user.id, 
      upgradeId: req.params.upgradeId,
      method: req.body.method,
      error: error.message 
    });
    next(error);
  }
});

/**
 * POST /api/v1/inventory/upgrades/:upgradeId/grant
 * 赠送免费扩容（管理员）
 */
router.post('/upgrades/:upgradeId/grant', requireAuth, async (req, res, next) => {
  try {
    // 检查管理员权限
    if (req.user.role !== 'admin') {
      throw new AppError(403, 'Admin access required');
    }
    
    const { upgradeId } = req.params;
    const { userId, reason } = req.body;
    
    if (!userId || !reason) {
      throw new AppError(400, 'userId and reason are required');
    }
    
    const validReasons = ['achievement', 'event', 'free'];
    if (!validReasons.includes(reason)) {
      throw new AppError(400, `Invalid reason. Must be one of: ${validReasons.join(', ')}`);
    }
    
    const result = await inventoryService.grantFreeUpgrade(
      userId, 
      upgradeId, 
      reason
    );
    
    successResp(res, result);
  } catch (error) {
    logger.error('Failed to grant free upgrade', { 
      adminId: req.user.id, 
      upgradeId: req.params.upgradeId,
      targetUserId: req.body.userId,
      error: error.message 
    });
    next(error);
  }
});

// 错误处理中间件
router.use(errorHandler);

module.exports = router;
