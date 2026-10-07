'use strict';

/**
 * 称号管理路由
 * REQ-00106: 玩家称号系统与个性化展示
 */

const { Router } = require('express');
const { TitleService } = require('../titleService');
const { requireAuth, requireAdmin, AppError, successResp } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('user-service:titles');
function createTitleRouter(TitleService) {
  const router = Router();

  /**
   * GET /api/users/me/titles
   * 获取当前用户所有称号
   */
  router.get('/me/titles', requireAuth, async (req, res, next) => {
    try {
      const { category, rarity, includeExpired } = req.query;

      const titles = await TitleService.getUserTitles(req.user.id, {
        category,
        rarity,
        includeExpired: includeExpired === 'true'
      });

      res.json(successResp({ titles, total: titles.length }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get user titles');
      next(error);
    }
  });

  /**
   * GET /api/users/me/titles/active
   * 获取当前用户激活的称号
   */
  router.get('/me/titles/active', requireAuth, async (req, res, next) => {
    try {
      const title = await TitleService.getActiveTitle(req.user.id);
      res.json(successResp({ title }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get active title');
      next(error);
    }
  });

  /**
   * GET /api/users/me/titles/stats
   * 获取当前用户称号统计
   */
  router.get('/me/titles/stats', requireAuth, async (req, res, next) => {
    try {
      const stats = await TitleService.getUserTitleStats(req.user.id);
      res.json(successResp({ stats }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get title stats');
      next(error);
    }
  });

  /**
   * PUT /api/users/me/titles/:titleId/activate
   * 激活称号
   */
  router.put('/me/titles/:titleId/activate', requireAuth, async (req, res, next) => {
    try {
      const { titleId } = req.params;
      const title = await TitleService.setActiveTitle(req.user.id, titleId);

      logger.info({ userId: req.user.id, titleId }, 'Title activated');

      res.json(successResp({
        title,
        message: 'Title activated successfully'
      }));
    } catch (error) {
      logger.error({ error: error.message, userId: req.user.id }, 'Failed to activate title');
      next(error);
    }
  });

  /**
   * PUT /api/users/me/titles/:titleId/favorite
   * 收藏/取消收藏称号
   */
  router.put('/me/titles/:titleId/favorite', requireAuth, async (req, res, next) => {
    try {
      const { titleId } = req.params;
      const { isFavorite = true } = req.body;

      const success = await TitleService.setFavorite(req.user.id, titleId, isFavorite);

      if (!success) {
        throw new AppError('TITLE_NOT_FOUND', 'Title not found', 404);
      }

      res.json(successResp({
        message: 'Favorite status updated',
        isFavorite
      }));
    } catch (error) {
      logger.error({ error: error.message, userId: req.user.id }, 'Failed to set favorite');
      next(error);
    }
  });

  /**
   * POST /api/users/me/titles/:titleId/unlock
   * 管理员手动授予称号；自动奖励由服务端触发
   */
  router.post('/me/titles/:titleId/unlock', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const { titleId } = req.params;
      const { sourceType = 'special', sourceId } = req.body;

      const result = await TitleService.unlockTitle(req.user.id, titleId, sourceType, sourceId);

      res.json(successResp({
        title: result.title,
        alreadyUnlocked: result.alreadyUnlocked,
        message: result.alreadyUnlocked ? 'Title already unlocked' : 'Title unlocked successfully'
      }));
    } catch (error) {
      logger.error({ error: error.message, userId: req.user.id }, 'Failed to unlock title');
      next(error);
    }
  });

  /**
   * GET /api/users/:userId/titles
   * 获取其他用户称号（公开信息）
   */
  router.get('/:userId/titles', async (req, res, next) => {
    try {
      const { userId } = req.params;

      const titles = await TitleService.getUserTitles(userId, {
        includeExpired: false
      });

      // 只返回公开信息
      const publicTitles = titles.map(t => ({
        titleId: t.titleId,
        name: t.name,
        category: t.category,
        rarity: t.rarity,
        iconUrl: t.iconUrl,
        isActive: t.isActive,
        unlockedAt: t.unlockedAt
      }));

      res.json(successResp({ titles: publicTitles, total: publicTitles.length }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get user titles');
      next(error);
    }
  });

  /**
   * GET /api/users/:userId/titles/active
   * 获取其他用户激活称号（公开信息）
   */
  router.get('/:userId/titles/active', async (req, res, next) => {
    try {
      const { userId } = req.params;

      const title = await TitleService.getActiveTitle(userId);

      if (!title) {
        return res.json(successResp({ title: null }));
      }

      // 只返回公开信息
      const publicTitle = {
        titleId: title.titleId,
        name: title.name,
        category: title.category,
        rarity: title.rarity,
        iconUrl: title.iconUrl,
        specialEffects: title.specialEffects
      };

      res.json(successResp({ title: publicTitle }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get active title');
      next(error);
    }
  });

  /**
   * GET /api/titles
   * 获取所有称号定义
   */
  router.get('/titles', async (req, res, next) => {
    try {
      const { category, rarity } = req.query;

      const titles = TitleService.getAllTitleDefinitions({ category, rarity });

      res.json(successResp({ titles, total: titles.length }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get title definitions');
      next(error);
    }
  });

  /**
   * GET /api/titles/:titleId
   * 获取单个称号定义
   */
  /**
   * GET /api/titles/leaderboard
   * 获取称号排行榜
   */
  router.get('/titles/leaderboard', async (req, res, next) => {
    try {
      const { limit = 100 } = req.query;
      const leaderboard = await TitleService.getTitleLeaderboard(Number(limit));


      res.json(successResp({ leaderboard }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get title leaderboard');
      next(error);
    }
  });

  router.get('/titles/shop', requireAuth, async (req, res, next) => {
    try { res.json(successResp({ titles: await TitleService.getShopTitles(req.query) })); }
    catch (err) { next(err); }
  });

  router.get('/titles/:titleId', async (req, res, next) => {
    try {
      const { titleId } = req.params;

      const title = TitleService.getTitleDefinition(titleId);

      if (!title) {
        throw new AppError('TITLE_NOT_FOUND', 'Title not found', 404);
      }

      res.json(successResp({ title }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to get title definition');
      next(error);
    }
  });

  /**
   * POST /api/titles/process-expired
   * 处理过期称号（管理员或定时任务）
   */
  router.post('/titles/process-expired', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const expiredCount = await TitleService.processExpiredTitles();

      res.json(successResp({
        message: 'Expired titles processed',
        expiredCount
      }));
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to process expired titles');
      next(error);
    }
  });

  return router;

}

module.exports = createTitleRouter(TitleService);
module.exports.createTitleRouter = createTitleRouter;
