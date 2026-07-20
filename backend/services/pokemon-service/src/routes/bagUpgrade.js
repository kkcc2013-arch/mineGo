// backend/services/pokemon-service/src/routes/bagUpgrade.js
// REQ-00150: 背包容量扩展与购买系统 - API 路由
'use strict';

const express = require('express');
const router = express.Router();
const { bagUpgradeService } = require('../bagUpgradeService');
const { requireAuth, requireAdmin, AppError, Errors, successResp } = require('../../../../shared/auth');
const { validateRequest } = require('../../../../shared/middleware/validation');

/**
 * GET /api/v1/inventory/upgrades
 * 获取背包扩容配置列表
 */
router.get('/upgrades', requireAuth, async (req, res, next) => {
  try {
    const configs = await bagUpgradeService.getUpgradeConfigs(req.user.id);
    
    // 添加用户余额信息
    const userBalance = {
      gold: req.user.gold || 0,
      gems: req.user.gems || 0,
      level: req.user.level || 1
    };
    
    successResp(res, {
      configs,
      balance: userBalance,
      stats: await bagUpgradeService.getUserUpgradeStats(req.user.id)
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/inventory/upgrades/:upgradeId
 * 获取单个扩容配置详情
 */
router.get('/upgrades/:upgradeId', requireAuth, async (req, res, next) => {
  try {
    const { upgradeId } = req.params;
    const config = await bagUpgradeService.getUpgradeConfig(upgradeId, req.user.id);
    
    if (!config) {
      throw Errors.notFound({ upgradeId });
    }
    
    successResp(res, config);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/inventory/upgrades/:upgradeId/purchase
 * 购买背包扩容
 * 
 * Body:
 * {
 *   "method": "gold" | "gem"
 * }
 */
router.post('/upgrades/:upgradeId/purchase', requireAuth, async (req, res, next) => {
  try {
    const { upgradeId } = req.params;
    const { method } = req.body;
    
    // 验证购买方式
    if (!['gold', 'gem'].includes(method)) {
      throw Errors.invalidRequest({ method }, { message: 'Invalid purchase method. Must be "gold" or "gem"' });
    }
    
    const result = await bagUpgradeService.purchaseBagUpgrade(
      req.user.id,
      upgradeId,
      method
    );
    
    successResp(res, result);
  } catch (error) {
    // 记录错误指标
    bagUpgradeService.metrics.recordError(error.code || 'unknown');
    next(error);
  }
});

/**
 * POST /api/v1/inventory/upgrades/:upgradeId/grant
 * 赠送免费扩容（管理员）
 * 
 * Body:
 * {
 *   "userId": number,
 *   "reason": "achievement" | "event" | "free" | "vip" | "admin"
 * }
 */
router.post('/upgrades/:upgradeId/grant', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { upgradeId } = req.params;
    const { userId, reason } = req.body;
    
    // 验证参数
    if (!userId || typeof userId !== 'number') {
      throw Errors.invalidRequest({ userId }, { message: 'userId is required and must be a number' });
    }
    
    if (!reason) {
      throw Errors.invalidRequest({ reason }, { message: 'reason is required' });
    }
    
    const result = await bagUpgradeService.grantFreeUpgrade(
      userId,
      upgradeId,
      reason,
      req.user.id // 操作管理员ID
    );
    
    successResp(res, result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/inventory/upgrades/history
 * 获取用户扩容购买历史
 */
router.get('/upgrades/history', requireAuth, async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const history = await bagUpgradeService.getUserUpgradeHistory(req.user.id, parseInt(limit));
    
    successResp(res, {
      history,
      total: history.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/inventory/upgrades/stats
 * 获取用户扩容统计信息
 */
router.get('/upgrades/stats', requireAuth, async (req, res, next) => {
  try {
    const stats = await bagUpgradeService.getUserUpgradeStats(req.user.id);
    successResp(res, stats);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/inventory/upgrades/batch-check
 * 批量检查用户是否可以购买多个配置
 * 
 * Body:
 * {
 *   "upgradeIds": ["base_50", "pokeball_20", ...]
 * }
 */
router.post('/upgrades/batch-check', requireAuth, async (req, res, next) => {
  try {
    const { upgradeIds } = req.body;
    
    if (!Array.isArray(upgradeIds) || upgradeIds.length === 0) {
      throw Errors.invalidRequest({ upgradeIds }, { message: 'upgradeIds must be a non-empty array' });
    }
    
    const results = await bagUpgradeService.checkBatchPurchaseAvailability(req.user.id, upgradeIds);
    
    successResp(res, results);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/admin/inventory/upgrades/stats
 * 管理员获取全平台扩容统计
 */
router.get('/admin/upgrades/stats', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(`
      SELECT 
        category,
        COUNT(*) as total_purchases,
        SUM(CASE WHEN purchase_method = 'gold' THEN cost_amount ELSE 0 END) as total_gold_revenue,
        SUM(CASE WHEN purchase_method = 'gem' THEN cost_amount ELSE 0 END) as total_gem_revenue,
        SUM(CASE WHEN purchase_method IN ('achievement', 'event', 'free', 'vip') THEN 1 ELSE 0 END) as free_grants
      FROM player_bag_upgrades pbu
      JOIN bag_upgrade_config buc ON pbu.upgrade_id = buc.upgrade_id
      GROUP BY category
      ORDER BY total_purchases DESC
    `);
    
    successResp(res, {
      stats: result.rows,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    next(error);
  }
});

// 导入 query 函数
const { query } = require('../../../../shared/db');

module.exports = router;