/**
 * REQ-00076: Achievement Routes
 * Created: 2026-06-27 05:00 UTC
 */

'use strict';

const express = require('express');
const router = express.Router();
const { achievementService, ACHIEVEMENT_CATEGORIES } = require('../achievementService');
const { requireAuth, successResp, AppError } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('achievement-routes');

/**
 * GET /achievements/my - 获取用户成就列表
 */
router.get('/my', requireAuth, async (req, res, next) => {
  try {
    const { category, include_hidden, include_completed } = req.query;
    
    // 验证类别
    if (category && !Object.values(ACHIEVEMENT_CATEGORIES).includes(category)) {
      throw new AppError('INVALID_REQUEST', 'Invalid category', 400);
    }
    
    const achievements = await achievementService.getUserAchievements(req.user.id, {
      category,
      includeHidden: include_hidden === 'true',
      includeCompleted: include_completed !== 'false'
    });
    
    res.json(successResp(achievements));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /achievements/my/progress - 获取成就进度概览
 */
router.get('/my/progress', requireAuth, async (req, res, next) => {
  try {
    const overview = await achievementService.getProgressOverview(req.user.id);
    res.json(successResp(overview));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /achievements/:achievementId - 获取成就详情
 */
router.get('/:achievementId', requireAuth, async (req, res, next) => {
  try {
    const achievements = await achievementService.getUserAchievements(req.user.id);
    const achievement = achievements.find(a => a.achievement_id === req.params.achievementId);
    
    if (!achievement) {
      throw new AppError('NOT_FOUND', 'Achievement not found', 404);
    }
    
    res.json(successResp(achievement));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /achievements/:achievementId/claim - 领取成就奖励
 */
router.post('/:achievementId/claim', requireAuth, async (req, res, next) => {
  try {
    const rewards = await achievementService.claimRewards(req.user.id, req.params.achievementId);
    
    logger.info({ userId: req.user.id, achievementId: req.params.achievementId }, 'Rewards claimed');
    
    res.json(successResp({ rewards }));
  } catch (err) {
    if (err.message === 'Achievement not completed') {
      next(new AppError('INVALID_REQUEST', err.message, 400));
    } else if (err.message === 'Rewards already claimed') {
      next(new AppError('INVALID_REQUEST', err.message, 400));
    } else {
      next(err);
    }
  }
});

/**
 * GET /achievements/leaderboard - 获取成就排行榜
 */
router.get('/leaderboard', async (req, res, next) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    
    const leaderboard = await achievementService.getLeaderboard(
      parseInt(limit),
      parseInt(offset)
    );
    
    res.json(successResp(leaderboard));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /achievements/titles - 获取用户称号列表
 */
router.get('/titles', requireAuth, async (req, res, next) => {
  try {
    const titles = await achievementService.getUserTitles(req.user.id);
    res.json(successResp(titles));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /achievements/titles/:titleId/activate - 设置激活称号
 */
router.post('/titles/:titleId/activate', requireAuth, async (req, res, next) => {
  try {
    await achievementService.setActiveTitle(req.user.id, req.params.titleId);
    res.json(successResp({ message: 'Title activated' }));
  } catch (err) {
    if (err.message === 'Title not found') {
      next(new AppError('NOT_FOUND', err.message, 404));
    } else {
      next(err);
    }
  }
});

/**
 * GET /achievements/categories - 获取成就类别列表
 */
router.get('/categories', (req, res) => {
  const categories = Object.values(ACHIEVEMENT_CATEGORIES).map(cat => ({
    id: cat,
    name: {
      zh: cat === 'catch' ? '捕捉' : cat === 'breed' ? '培育' : cat === 'battle' ? '战斗' : cat === 'social' ? '社交' : '探索',
      en: cat.charAt(0).toUpperCase() + cat.slice(1)
    }
  }));
  
  res.json(successResp(categories));
});

module.exports = router;