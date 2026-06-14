// backend/shared/routes/quests.js - 任务系统 API 路由
'use strict';

const express = require('express');
const router = express.Router();
const { questService } = require('../questService');
const { requireAuth, AppError, successResp, errorHandler } = require('../auth');
const { createLogger } = require('../logger');
const Joi = require('joi');

const logger = createLogger('quest-routes');

/**
 * GET /api/quests
 * 获取当前任务列表
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    let quests = await questService.getUserQuests(userId);
    
    // 如果没有任务，生成每日任务
    if (quests.length === 0) {
      quests = await questService.generateDailyQuests(userId);
    }

    res.json(successResp(quests));
  } catch (error) {
    logger.error('Failed to get quests', { userId: req.user?.id, error: error.message });
    next(error);
  }
});

/**
 * POST /api/quests/generate
 * 手动生成每日任务
 */
router.post('/generate', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const quests = await questService.generateDailyQuests(userId);
    
    res.json(successResp(quests));
  } catch (error) {
    logger.error('Failed to generate quests', { userId: req.user?.id, error: error.message });
    next(error);
  }
});

/**
 * POST /api/quests/:questId/claim
 * 领取任务奖励
 */
router.post('/:questId/claim', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { questId } = req.params;
    
    const result = await questService.claimRewards(userId, questId);
    
    res.json(successResp(result));
  } catch (error) {
    logger.error('Failed to claim rewards', { 
      userId: req.user?.id, 
      questId: req.params.questId, 
      error: error.message 
    });
    next(error);
  }
});

/**
 * GET /api/quests/streak
 * 获取连击信息
 */
router.get('/streak', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const streak = await questService.getStreak(userId);
    
    res.json(successResp(streak));
  } catch (error) {
    logger.error('Failed to get streak', { userId: req.user?.id, error: error.message });
    next(error);
  }
});

/**
 * POST /api/quests/progress
 * 内部接口：更新任务进度
 */
router.post('/progress', async (req, res, next) => {
  try {
    const schema = Joi.object({
      userId: Joi.string().uuid().required(),
      objectiveType: Joi.string().required(),
      params: Joi.object().default({}),
    });

    const { userId, objectiveType, params } = await schema.validateAsync(req.body);
    
    const updatedQuests = await questService.updateProgress(userId, objectiveType, params);
    
    res.json(successResp(updatedQuests));
  } catch (error) {
    logger.error('Failed to update progress', { body: req.body, error: error.message });
    next(error);
  }
});

/**
 * GET /api/quests/history
 * 获取任务完成历史
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { limit = 20, offset = 0 } = req.query;
    
    const result = await questService.db?.query(
      `SELECT qch.*, qd.title_i18n_key, qd.quest_type, qd.difficulty
       FROM quest_completion_history qch
       JOIN quest_definitions qd ON qch.quest_definition_id = qd.id
       WHERE qch.user_id = $1
       ORDER BY qch.completed_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );

    res.json(successResp(result?.rows || []));
  } catch (error) {
    logger.error('Failed to get history', { userId: req.user?.id, error: error.message });
    next(error);
  }
});

/**
 * GET /api/quests/definitions
 * 获取所有任务定义（管理/调试用）
 */
router.get('/definitions', requireAuth, async (req, res, next) => {
  try {
    const { quest_type, is_active } = req.query;
    
    let queryStr = 'SELECT * FROM quest_definitions WHERE 1=1';
    const params = [];
    
    if (quest_type) {
      params.push(quest_type);
      queryStr += ` AND quest_type = $${params.length}`;
    }
    
    if (is_active !== undefined) {
      params.push(is_active === 'true');
      queryStr += ` AND is_active = $${params.length}`;
    }
    
    queryStr += ' ORDER BY quest_type, difficulty, weight DESC';
    
    const result = await questService.db?.query(queryStr, params);
    
    res.json(successResp(result?.rows || []));
  } catch (error) {
    logger.error('Failed to get definitions', { error: error.message });
    next(error);
  }
});

// 错误处理
router.use(errorHandler);

module.exports = router;