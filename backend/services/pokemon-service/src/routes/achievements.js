/**
 * REQ-00076: 精灵成就系统与里程碑奖励
 * 成就 API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const achievementService = require('../achievementService');
const { db } = require('../../shared/db');
const { createLogger } = require('../../shared/logger');
const { metrics } = require('../../shared/metrics');

const logger = createLogger('achievement-routes');

/**
 * 认证中间件（简化版，实际应使用 shared/auth）
 */
function authenticate(req, res, next) {
  const userId = req.headers['x-user-id'] || req.user?.id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED'
    });
  }
  
  req.user = req.user || {};
  req.user.id = parseInt(userId);
  next();
}

/**
 * 限流中间件
 */
function rateLimiter(max, windowSeconds) {
  const requests = new Map();
  
  return (req, res, next) => {
    const userId = req.user?.id || req.ip;
    const key = `${userId}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
    const count = requests.get(key) || 0;
    
    if (count >= max) {
      return res.status(429).json({
        success: false,
        error: 'Too many requests',
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }
    
    requests.set(key, count + 1);
    
    // 清理过期记录
    if (requests.size > 10000) {
      const cutoff = Math.floor(Date.now() / (windowSeconds * 1000)) - 1;
      for (const [k] of requests) {
        if (parseInt(k.split(':')[1]) < cutoff) {
          requests.delete(k);
        }
      }
    }
    
    next();
  };
}

/**
 * GET /api/v2/achievements/my
 * 获取用户成就列表
 * 
 * Query params:
 * - category: 分类过滤 (catch/battle/breed/social/explore)
 * - include_hidden: 是否包含隐藏成就 (true/false)
 * - include_completed: 是否包含已完成成就 (true/false，默认 true)
 */
router.get('/my', authenticate, rateLimiter(100, 60), async (req, res) => {
  try {
    const startTime = Date.now();
    
    const { category, include_hidden, include_completed } = req.query;
    
    const achievements = await achievementService.getUserAchievements(req.user.id, {
      category,
      includeHidden: include_hidden === 'true',
      includeCompleted: include_completed !== 'false'
    });
    
    metrics.histogram('achievement_api_my_duration_ms', Date.now() - startTime);
    
    res.json({
      success: true,
      data: achievements,
      meta: {
        total: achievements.length,
        completed: achievements.filter(a => a.completed).length
      }
    });
  } catch (error) {
    logger.error({ error, userId: req.user.id }, 'Failed to get user achievements');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'ACHIEVEMENT_FETCH_ERROR'
    });
  }
});

/**
 * GET /api/v2/achievements/my/progress
 * 获取成就进度概览
 */
router.get('/my/progress', authenticate, rateLimiter(100, 60), async (req, res) => {
  try {
    const progress = await achievementService.getUserProgress(req.user.id);
    
    res.json({
      success: true,
      data: progress
    });
  } catch (error) {
    logger.error({ error, userId: req.user.id }, 'Failed to get achievement progress');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'PROGRESS_FETCH_ERROR'
    });
  }
});

/**
 * GET /api/v2/achievements/:achievementId
 * 获取单个成就详情
 */
router.get('/:achievementId', authenticate, rateLimiter(100, 60), async (req, res) => {
  try {
    const achievements = await achievementService.getUserAchievements(req.user.id);
    const achievement = achievements.find(a => a.achievement_id === req.params.achievementId);
    
    if (!achievement) {
      return res.status(404).json({
        success: false,
        error: 'Achievement not found',
        code: 'ACHIEVEMENT_NOT_FOUND'
      });
    }
    
    res.json({
      success: true,
      data: achievement
    });
  } catch (error) {
    logger.error({ error, userId: req.user.id, achievementId: req.params.achievementId }, 'Failed to get achievement');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'ACHIEVEMENT_FETCH_ERROR'
    });
  }
});

/**
 * POST /api/v2/achievements/:achievementId/claim
 * 领取成就奖励
 */
router.post('/:achievementId/claim', authenticate, rateLimiter(10, 60), async (req, res) => {
  try {
    const rewards = await achievementService.claimRewards(req.user.id, req.params.achievementId);
    
    metrics.increment('achievement_claim_api_requests_total');
    
    res.json({
      success: true,
      data: { rewards },
      message: 'Rewards claimed successfully'
    });
  } catch (error) {
    logger.error({ error, userId: req.user.id, achievementId: req.params.achievementId }, 'Failed to claim rewards');
    
    const statusCode = error.message.includes('not completed') ? 400 :
                       error.message.includes('already claimed') ? 409 :
                       error.message.includes('not found') ? 404 : 500;
    
    res.status(statusCode).json({
      success: false,
      error: error.message,
      code: 'CLAIM_ERROR'
    });
  }
});

/**
 * GET /api/v2/achievements/leaderboard/global
 * 获取成就排行榜
 */
router.get('/leaderboard/global', rateLimiter(50, 60), async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;
    
    const leaderboard = await achievementService.getLeaderboard(
      Math.min(parseInt(limit), 1000),
      parseInt(offset)
    );
    
    res.json({
      success: true,
      data: leaderboard,
      meta: {
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    logger.error({ error }, 'Failed to get leaderboard');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'LEADERBOARD_FETCH_ERROR'
    });
  }
});

/**
 * POST /api/v2/achievements/titles/:titleId/activate
 * 设置激活称号
 */
router.post('/titles/:titleId/activate', authenticate, rateLimiter(10, 60), async (req, res) => {
  try {
    await achievementService.setActiveTitle(req.user.id, req.params.titleId);
    
    res.json({
      success: true,
      message: 'Title activated successfully'
    });
  } catch (error) {
    logger.error({ error, userId: req.user.id, titleId: req.params.titleId }, 'Failed to set active title');
    
    res.status(error.message.includes('not owned') ? 403 : 500).json({
      success: false,
      error: error.message,
      code: 'TITLE_ACTIVATE_ERROR'
    });
  }
});

/**
 * GET /api/v2/achievements/titles
 * 获取用户称号列表
 */
router.get('/titles', authenticate, rateLimiter(100, 60), async (req, res) => {
  try {
    const titles = await achievementService.getUserTitles(req.user.id);
    
    res.json({
      success: true,
      data: titles
    });
  } catch (error) {
    logger.error({ error, userId: req.user.id }, 'Failed to get user titles');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'TITLES_FETCH_ERROR'
    });
  }
});

/**
 * POST /api/v2/achievements/event (内部 API)
 * 处理成就触发事件
 * 
 * 该端点供其他服务调用，用于触发成就进度更新
 */
router.post('/event', authenticate, rateLimiter(1000, 60), async (req, res) => {
  try {
    const { userId, eventType, eventData } = req.body;
    
    if (!userId || !eventType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userId, eventType',
        code: 'INVALID_REQUEST'
      });
    }
    
    const results = await achievementService.processEvent(userId, eventType, eventData || {});
    
    res.json({
      success: true,
      data: {
        achievementsCompleted: results.length,
        achievements: results
      }
    });
  } catch (error) {
    logger.error({ error, body: req.body }, 'Failed to process achievement event');
    res.status(500).json({
      success: false,
      error: error.message,
      code: 'EVENT_PROCESS_ERROR'
    });
  }
});

module.exports = router;
