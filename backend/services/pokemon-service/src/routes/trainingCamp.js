// backend/services/pokemon-service/src/routes/trainingCamp.js
// REQ-00370: 精灵训练营系统 API 路由
'use strict';

const express = require('express');
const router = express.Router();
const trainingCampService = require('../trainingCampService');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('training-camp-routes');

/**
 * 获取玩家所有训练营信息
 * GET /api/pokemon/training/camps
 */
router.get('/camps', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    
    // 初始化训练营（如果是首次访问）
    await trainingCampService.initUserCamps(userId);
    
    const camps = await trainingCampService.getUserCamps(userId);
    
    res.json(successResp({ camps }));
    
  } catch (error) {
    logger.error('获取训练营失败', { error, userId: req.user?.id });
    next(new AppError(500, '获取训练营失败'));
  }
});

/**
 * 获取指定训练营的训练槽位
 * GET /api/pokemon/training/camps/:campId/slots
 */
router.get('/camps/:campId/slots', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const campId = parseInt(req.params.campId);
    
    const slots = await trainingCampService.getCampSlots(userId, campId);
    
    res.json(successResp({ slots }));
    
  } catch (error) {
    logger.error('获取训练槽位失败', { error, userId: req.user?.id, campId: req.params.campId });
    next(new AppError(500, '获取训练槽位失败'));
  }
});

/**
 * 获取训练营可用课程
 * GET /api/pokemon/training/camps/:campId/courses
 */
router.get('/camps/:campId/courses', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const campId = parseInt(req.params.campId);
    
    const courses = await trainingCampService.getAvailableCourses(userId, campId);
    
    res.json(successResp({ courses }));
    
  } catch (error) {
    logger.error('获取课程失败', { error, userId: req.user?.id, campId: req.params.campId });
    next(new AppError(500, '获取课程失败'));
  }
});

/**
 * 开始训练
 * POST /api/pokemon/training/start
 * Body: { campId, slotIndex, pokemonId, courseId }
 */
router.post('/start', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { campId, slotIndex, pokemonId, courseId } = req.body;
    
    if (!campId || !pokemonId || !courseId) {
      throw new AppError(400, '缺少必要参数');
    }
    
    const result = await trainingCampService.startTraining(
      userId,
      parseInt(campId),
      parseInt(slotIndex || 0),
      pokemonId,
      parseInt(courseId)
    );
    
    res.json(successResp(result, '训练已开始'));
    
  } catch (error) {
    logger.error('开始训练失败', { error, userId: req.user?.id, body: req.body });
    if (error instanceof AppError) {
      next(error);
    } else {
      next(new AppError(400, error.message));
    }
  }
});

/**
 * 完成训练并领取奖励
 * POST /api/pokemon/training/complete/:slotId
 */
router.post('/complete/:slotId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const slotId = req.params.slotId;
    
    const result = await trainingCampService.completeTraining(userId, slotId);
    
    res.json(successResp(result, '训练完成，奖励已领取'));
    
  } catch (error) {
    logger.error('完成训练失败', { error, userId: req.user?.id, slotId: req.params.slotId });
    if (error instanceof AppError) {
      next(error);
    } else {
      next(new AppError(400, error.message));
    }
  }
});

/**
 * 使用加速道具
 * POST /api/pokemon/training/boost/:slotId
 * Body: { boostType: 'time_50' | 'time_75' | 'instant' | 'exp_double' }
 */
router.post('/boost/:slotId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const slotId = req.params.slotId;
    const { boostType } = req.body;
    
    if (!boostType) {
      throw new AppError(400, '缺少加速类型');
    }
    
    const result = await trainingCampService.useBoost(userId, slotId, boostType);
    
    res.json(successResp(result, '加速成功'));
    
  } catch (error) {
    logger.error('使用加速失败', { error, userId: req.user?.id, slotId: req.params.slotId });
    if (error instanceof AppError) {
      next(error);
    } else {
      next(new AppError(400, error.message));
    }
  }
});

/**
 * 取消训练
 * POST /api/pokemon/training/cancel/:slotId
 */
router.post('/cancel/:slotId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const slotId = req.params.slotId;
    
    const result = await trainingCampService.cancelTraining(userId, slotId);
    
    res.json(successResp(result, '训练已取消'));
    
  } catch (error) {
    logger.error('取消训练失败', { error, userId: req.user?.id, slotId: req.params.slotId });
    if (error instanceof AppError) {
      next(error);
    } else {
      next(new AppError(400, error.message));
    }
  }
});

/**
 * 升级训练营
 * POST /api/pokemon/training/camps/:campId/upgrade
 */
router.post('/camps/:campId/upgrade', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const campId = parseInt(req.params.campId);
    
    const result = await trainingCampService.upgradeCamp(userId, campId);
    
    res.json(successResp(result, '训练营升级成功'));
    
  } catch (error) {
    logger.error('升级训练营失败', { error, userId: req.user?.id, campId: req.params.campId });
    if (error instanceof AppError) {
      next(error);
    } else {
      next(new AppError(400, error.message));
    }
  }
});

/**
 * 获取训练历史
 * GET /api/pokemon/training/history
 * Query: limit, offset
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;
    
    const history = await trainingCampService.getTrainingHistory(userId, limit, offset);
    
    res.json(successResp({ history }));
    
  } catch (error) {
    logger.error('获取训练历史失败', { error, userId: req.user?.id });
    next(new AppError(500, '获取训练历史失败'));
  }
});

/**
 * 获取训练槽位详情
 * GET /api/pokemon/training/slots/:slotId
 */
router.get('/slots/:slotId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const slotId = req.params.slotId;
    
    // 简单实现：通过遍历所有训练营查找槽位
    const camps = await trainingCampService.getUserCamps(userId);
    
    let slot = null;
    for (const camp of camps) {
      const found = camp.slots.find(s => s.id === slotId);
      if (found) {
        slot = found;
        break;
      }
    }
    
    if (!slot) {
      throw new AppError(404, '训练槽位不存在');
    }
    
    res.json(successResp({ slot }));
    
  } catch (error) {
    logger.error('获取训练槽位失败', { error, userId: req.user?.id, slotId: req.params.slotId });
    if (error instanceof AppError) {
      next(error);
    } else {
      next(new AppError(500, '获取训练槽位失败'));
    }
  }
});

/**
 * 管理员接口：处理已完成的训练
 * POST /api/pokemon/training/admin/process-completed
 */
router.post('/admin/process-completed', requireAuth, async (req, res, next) => {
  try {
    // TODO: 添加管理员权限检查
    
    const result = await trainingCampService.processCompletedTrainings();
    
    res.json(successResp({ processedCount: result.length }));
    
  } catch (error) {
    logger.error('处理已完成训练失败', { error });
    next(new AppError(500, '处理失败'));
  }
});

module.exports = router;