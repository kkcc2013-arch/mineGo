/**
 * 连击系统 API 路由
 * @module routes/combos
 */

const express = require('express');
const router = express.Router();
const comboService = require('../src/comboService');
const { authenticate } = require('../../../shared/middleware/auth');
const { rateLimit } = require('../../../shared/middleware/rateLimit');
const logger = require('../../../shared/logger');

/**
 * 获取所有可用连击链
 * GET /api/v1/combos
 */
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { includeStats } = req.query;
    
    const combos = await comboService.getAvailableCombos(req.userId, {
      includeStats: includeStats === 'true'
    });
    
    res.json({
      success: true,
      data: combos,
      total: combos.length
    });
  } catch (error) {
    logger.error('Failed to get combos:', error);
    next(error);
  }
});

/**
 * 获取连击链详情
 * GET /api/v1/combos/:chainId
 */
router.get('/:chainId', authenticate, async (req, res, next) => {
  try {
    const { chainId } = req.params;
    
    const comboDetails = await comboService.getComboDetails(chainId, req.userId);
    
    res.json({
      success: true,
      data: comboDetails
    });
  } catch (error) {
    if (error.message === 'COMBO_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: 'Combo not found'
      });
    }
    logger.error('Failed to get combo details:', error);
    next(error);
  }
});

/**
 * 获取玩家连击统计
 * GET /api/v1/combos/my/stats
 */
router.get('/my/stats', authenticate, async (req, res, next) => {
  try {
    const stats = await comboService.getUserComboStats(req.userId);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Failed to get user combo stats:', error);
    next(error);
  }
});

/**
 * 获取连击排行榜
 * GET /api/v1/combos/leaderboard
 */
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const { chainId, battleType, period, limit } = req.query;
    
    const leaderboard = await comboService.getComboLeaderboard(chainId || 'all', {
      battleType: battleType || 'all',
      period: period || 'weekly',
      limit: parseInt(limit) || 100
    });
    
    res.json({
      success: true,
      data: leaderboard,
      filters: {
        chainId: chainId || 'all',
        battleType: battleType || 'all',
        period: period || 'weekly'
      }
    });
  } catch (error) {
    logger.error('Failed to get combo leaderboard:', error);
    next(error);
  }
});

/**
 * 练习连击模式
 * POST /api/v1/combos/:chainId/practice
 */
router.post('/:chainId/practice', authenticate, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const { chainId } = req.params;
    const { pokemonId } = req.body;
    
    if (!pokemonId) {
      return res.status(400).json({
        success: false,
        error: 'Pokemon ID is required'
      });
    }
    
    const practiceSession = await comboService.practiceCombo(
      req.userId,
      chainId,
      pokemonId
    );
    
    res.json({
      success: true,
      data: practiceSession
    });
  } catch (error) {
    if (error.message === 'COMBO_NOT_FOUND') {
      return res.status(404).json({
        success: false,
        error: 'Combo not found'
      });
    }
    if (error.message === 'LEVEL_TOO_LOW') {
      return res.status(403).json({
        success: false,
        error: 'Your level is too low for this combo'
      });
    }
    logger.error('Failed to start combo practice:', error);
    next(error);
  }
});

/**
 * 获取连击推荐
 * GET /api/v1/combos/recommendations
 */
router.get('/recommendations', authenticate, async (req, res, next) => {
  try {
    const recommendations = await comboService.getComboRecommendations(req.userId);
    
    res.json({
      success: true,
      data: recommendations
    });
  } catch (error) {
    logger.error('Failed to get combo recommendations:', error);
    next(error);
  }
});

/**
 * 刷新连击缓存（管理员）
 * POST /api/v1/combos/admin/refresh-cache
 */
router.post('/admin/refresh-cache', authenticate, async (req, res, next) => {
  try {
    // TODO: 添加管理员权限检查
    
    await comboService.refreshComboCache();
    
    res.json({
      success: true,
      message: 'Combo cache refreshed successfully'
    });
  } catch (error) {
    logger.error('Failed to refresh combo cache:', error);
    next(error);
  }
});

module.exports = router;
