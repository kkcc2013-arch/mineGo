/**
 * Bag Routes - 背包管理 API 路由
 * REQ-00110: 精灵背包容量管理与扩展系统
 * 
 * 路由:
 * - GET /bag/capacity - 获取背包容量信息
 * - GET /bag/check-full - 检查背包是否已满
 * - POST /bag/expand - 扩展背包容量
 * - GET /bag/expansion-cost - 获取扩展成本预览
 * - GET /bag/pokemon - 获取排序后的精灵列表
 * - POST /bag/batch-action - 批量操作
 * - PATCH /bag/pokemon/:id/favorite - 设置收藏标记
 * - POST /bag/sort-order - 更新排序顺序
 * - GET /bag/expansion-history - 获取扩展历史
 * - GET /bag/filter-options - 获取筛选选项
 * - PATCH /bag/alert-config - 更新预警配置
 */

'use strict';

const express = require('express');
const router = express.Router();
const bagCapacityService = require('../bagCapacityService');
const bagSortService = require('../bagSortService');
const { requireAuth } = require('../../../../shared/auth');
const logger = require('../../../../shared/logger');

// ═══════════════════════════════════════════════════════════
// 容量管理路由
// ═══════════════════════════════════════════════════════════

/**
 * GET /bag/capacity
 * 获取背包容量信息
 */
router.get('/capacity', requireAuth, async (req, res) => {
  try {
    const capacityInfo = await bagCapacityService.getBagCapacity(req.user.id);
    res.json({ success: true, data: capacityInfo });
  } catch (error) {
    logger.error('[BagRoutes] GET /capacity error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /bag/check-full
 * 检查背包是否已满
 * Query: additional - 额外需要的槽位
 */
router.get('/check-full', requireAuth, async (req, res) => {
  try {
    const additional = parseInt(req.query.additional) || 0;
    const result = await bagCapacityService.checkBagFull(req.user.id, additional);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] GET /check-full error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /bag/expand
 * 扩展背包容量
 * Body: { method: 'gold'|'diamond', units: number }
 */
router.post('/expand', requireAuth, async (req, res) => {
  try {
    const { method = 'gold', units = 1 } = req.body;

    // 验证参数
    if (!['gold', 'diamond'].includes(method)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid payment method. Must be "gold" or "diamond"' 
      });
    }

    if (!Number.isInteger(units) || units < 1 || units > 10) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid units. Must be integer between 1 and 10' 
      });
    }

    const result = await bagCapacityService.expandBagCapacity(req.user.id, { method, units });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] POST /expand error:', error);
    const statusCode = error.message.includes('Insufficient') ? 402 : 400;
    res.status(statusCode).json({ success: false, error: error.message });
  }
});

/**
 * GET /bag/expansion-cost
 * 获取扩展成本预览
 * Query: units, method
 */
router.get('/expansion-cost', requireAuth, async (req, res) => {
  try {
    const units = parseInt(req.query.units) || 1;
    const method = req.query.method || 'gold';

    const cost = await bagCapacityService.calculateExpansionCost(req.user.id, units, method);
    res.json({ success: true, data: cost });
  } catch (error) {
    logger.error('[BagRoutes] GET /expansion-cost error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /bag/expansion-history
 * 获取扩展历史
 * Query: limit
 */
router.get('/expansion-history', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const history = await bagCapacityService.getExpansionHistory(req.user.id, limit);
    res.json({ success: true, data: history });
  } catch (error) {
    logger.error('[BagRoutes] GET /expansion-history error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 精灵列表与排序路由
// ═══════════════════════════════════════════════════════════

/**
 * GET /bag/pokemon
 * 获取排序后的精灵列表
 * Query: sortBy, sortOrder, page, limit, storageStatus
 */
router.get('/pokemon', requireAuth, async (req, res) => {
  try {
    const options = {
      sortBy: req.query.sortBy || 'recent',
      sortOrder: req.query.sortOrder || 'desc',
      page: parseInt(req.query.page) || 1,
      limit: Math.min(parseInt(req.query.limit) || 30, 100),
      storageStatus: req.query.storageStatus || 'bag',
      filters: {}
    };

    // 解析筛选条件
    if (req.query.type) options.filters.type = req.query.type;
    if (req.query.minCp) options.filters.minCp = parseInt(req.query.minCp);
    if (req.query.maxCp) options.filters.maxCp = parseInt(req.query.maxCp);
    if (req.query.minIv) options.filters.minIv = parseFloat(req.query.minIv);
    if (req.query.maxIv) options.filters.maxIv = parseFloat(req.query.maxIv);
    if (req.query.isShiny !== undefined) options.filters.isShiny = req.query.isShiny === 'true';
    if (req.query.isFavorited !== undefined) options.filters.isFavorited = req.query.isFavorited === 'true';
    if (req.query.search) options.filters.search = req.query.search;

    const result = await bagSortService.getSortedPokemonList(req.user.id, options);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] GET /pokemon error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /bag/filter-options
 * 获取筛选选项
 */
router.get('/filter-options', requireAuth, async (req, res) => {
  try {
    const options = await bagSortService.getFilterOptions(req.user.id);
    res.json({ success: true, data: options });
  } catch (error) {
    logger.error('[BagRoutes] GET /filter-options error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /bag/sort-order
 * 更新排序顺序
 * Body: { pokemonIds: number[] }
 */
router.post('/sort-order', requireAuth, async (req, res) => {
  try {
    const { pokemonIds } = req.body;

    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'pokemonIds must be a non-empty array' 
      });
    }

    const result = await bagSortService.updateSortOrder(req.user.id, pokemonIds);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] POST /sort-order error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /bag/quick-sort
 * 快速排序（按规则重新排列）
 * Body: { sortBy: string, sortOrder: string }
 */
router.post('/quick-sort', requireAuth, async (req, res) => {
  try {
    const { sortBy = 'cp', sortOrder = 'desc' } = req.body;
    const result = await bagSortService.quickSort(req.user.id, sortBy, sortOrder);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] POST /quick-sort error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 批量操作路由
// ═══════════════════════════════════════════════════════════

/**
 * POST /bag/batch-action
 * 批量操作精灵
 * Body: { pokemonIds: number[], action: 'release'|'transfer_to_storage' }
 */
router.post('/batch-action', requireAuth, async (req, res) => {
  try {
    const { pokemonIds, action } = req.body;

    // 参数验证
    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'pokemonIds must be a non-empty array' 
      });
    }

    if (pokemonIds.length > 100) {
      return res.status(400).json({ 
        success: false, 
        error: 'Cannot process more than 100 pokemon at once' 
      });
    }

    if (!['release', 'transfer_to_storage'].includes(action)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid action. Must be "release" or "transfer_to_storage"' 
      });
    }

    const result = await bagCapacityService.batchTransferPokemon(req.user.id, pokemonIds, action);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] POST /batch-action error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /bag/pokemon/:id/favorite
 * 设置收藏标记
 * Body: { isFavorited: boolean }
 */
router.patch('/pokemon/:id/favorite', requireAuth, async (req, res) => {
  try {
    const pokemonId = parseInt(req.params.id);
    const { isFavorited } = req.body;

    if (isNaN(pokemonId)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid pokemon id' 
      });
    }

    if (typeof isFavorited !== 'boolean') {
      return res.status(400).json({ 
        success: false, 
        error: 'isFavorited must be a boolean' 
      });
    }

    const result = await bagCapacityService.setFavorite(req.user.id, pokemonId, isFavorited);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] PATCH /pokemon/:id/favorite error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

/**
 * POST /bag/transfer-from-storage
 * 从仓库移回背包
 * Body: { pokemonIds: number[] }
 */
router.post('/transfer-from-storage', requireAuth, async (req, res) => {
  try {
    const { pokemonIds } = req.body;

    if (!Array.isArray(pokemonIds) || pokemonIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'pokemonIds must be a non-empty array' 
      });
    }

    // 检查背包是否有足够空间
    const bagCheck = await bagCapacityService.checkBagFull(req.user.id, pokemonIds.length);
    if (bagCheck.willBeFull) {
      return res.status(400).json({ 
        success: false, 
        error: `Not enough space in bag. Need ${pokemonIds.length} slots, have ${bagCheck.availableSlots}` 
      });
    }

    const { query } = require('../../../../shared/db');
    const result = await query(`
      UPDATE pokemon 
      SET storage_status = 'bag'
      WHERE id = ANY($1) 
      AND user_id = $2 
      AND storage_status = 'storage'
      AND is_released = FALSE
    `, [pokemonIds, req.user.id]);

    res.json({ 
      success: true, 
      data: { 
        transferredCount: result.rowCount 
      } 
    });
  } catch (error) {
    logger.error('[BagRoutes] POST /transfer-from-storage error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// 预警配置路由
// ═══════════════════════════════════════════════════════════

/**
 * GET /bag/alert-config
 * 获取预警配置
 */
router.get('/alert-config', requireAuth, async (req, res) => {
  try {
    const { query } = require('../../../../shared/db');
    const result = await query(`
      SELECT * FROM bag_alert_config WHERE user_id = $1
    `, [req.user.id]);

    if (result.rows.length === 0) {
      // 返回默认配置
      res.json({ 
        success: true, 
        data: {
          enableAlert: true,
          alertThresholds: [85, 90, 95, 99],
          autoTransferToStorage: false,
          autoTransferThreshold: 95,
          notificationMethod: 'push'
        } 
      });
    } else {
      res.json({ success: true, data: result.rows[0] });
    }
  } catch (error) {
    logger.error('[BagRoutes] GET /alert-config error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /bag/alert-config
 * 更新预警配置
 * Body: { enableAlert?, alertThresholds?, autoTransferToStorage?, notificationMethod? }
 */
router.patch('/alert-config', requireAuth, async (req, res) => {
  try {
    const result = await bagCapacityService.updateAlertConfig(req.user.id, req.body);
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[BagRoutes] PATCH /alert-config error:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
