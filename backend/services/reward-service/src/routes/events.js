/**
 * REQ-00057: 游戏活动系统 API 路由
 */

const express = require('express');
const router = express.Router();
const eventService = require('../eventService');
const { requireAuth, successResp, errorResp } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('event-routes');

// Optional auth middleware (allows unauthenticated requests)
const optionalAuth = (req, res, next) => {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return next(); // Allow unauthenticated access
  }
  try {
    const { verifyAccess } = require('../../../../shared/auth');
    const payload = verifyAccess(header.slice(7));
    req.user = payload;
    next();
  } catch (err) {
    next(); // Still allow access on invalid token
  }
};

/**
 * GET /api/events
 * 获取所有活跃活动列表
 */
router.get('/', optionalAuth, async (req, res) => {
  try {
    const userId = req.user?.sub || null;
    
    if (userId) {
      const events = await eventService.getActiveEventsForUser(userId);
      res.json({ events });
    } else {
      const events = await eventService.getAllActiveEvents();
      res.json({ events });
    }
  } catch (error) {
    logger.error({ error }, 'Failed to get events');
    res.status(500).json({ error: 'Failed to get events' });
  }
});

/**
 * GET /api/events/:eventId
 * 获取活动详情
 */
router.get('/:eventId', optionalAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user?.sub || null;
    
    const event = await eventService.getEventWithDetails(parseInt(eventId), userId);
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json({ event });
  } catch (error) {
    logger.error({ error }, 'Failed to get event details');
    res.status(500).json({ error: 'Failed to get event details' });
  }
});

/**
 * POST /api/events
 * 创建新活动（管理员）
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    // TODO: 添加管理员权限检查
    
    const eventData = {
      ...req.body,
      createdBy: req.user.sub
    };
    
    const event = await eventService.createEvent(eventData);
    
    res.status(201).json({ event });
  } catch (error) {
    logger.error({ error }, 'Failed to create event');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/events/:eventId/join
 * 用户参与活动
 */
router.post('/:eventId/join', requireAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.sub;
    
    const participation = await eventService.joinEvent(parseInt(eventId), userId);
    
    res.json({ participation });
  } catch (error) {
    logger.error({ error }, 'Failed to join event');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/events/:eventId/claim
 * 领取活动奖励
 */
router.post('/:eventId/claim', requireAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.sub;
    
    const result = await eventService.claimEventRewards(parseInt(eventId), userId);
    
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to claim rewards');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/events/:eventId/tasks/:taskId/complete
 * 完成活动任务
 */
router.post('/:eventId/tasks/:taskId/complete', requireAuth, async (req, res) => {
  try {
    const { eventId, taskId } = req.params;
    const userId = req.user.sub;
    
    const result = await eventService.completeEventTask(
      parseInt(eventId),
      parseInt(taskId),
      userId
    );
    
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to complete task');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/events/:eventId/shop/:shopItemId/purchase
 * 活动商店购买
 */
router.post('/:eventId/shop/:shopItemId/purchase', requireAuth, async (req, res) => {
  try {
    const { eventId, shopItemId } = req.params;
    const { quantity = 1 } = req.body;
    const userId = req.user.sub;
    
    const result = await eventService.purchaseFromEventShop(
      parseInt(eventId),
      parseInt(shopItemId),
      userId,
      quantity
    );
    
    res.json(result);
  } catch (error) {
    logger.error({ error }, 'Failed to purchase from shop');
    res.status(400).json({ error: error.message });
  }
});

/**
 * GET /api/events/:eventId/leaderboard
 * 获取活动排行榜
 */
router.get('/:eventId/leaderboard', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    const leaderboard = await eventService.getEventLeaderboard(
      parseInt(eventId),
      parseInt(limit),
      parseInt(offset)
    );
    
    res.json({ leaderboard });
  } catch (error) {
    logger.error({ error }, 'Failed to get leaderboard');
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

/**
 * POST /api/events/:eventId/pause
 * 暂停活动（管理员）
 */
router.post('/:eventId/pause', requireAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    await eventService.pauseEvent(parseInt(eventId));
    
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to pause event');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/events/:eventId/resume
 * 恢复活动（管理员）
 */
router.post('/:eventId/resume', requireAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    await eventService.resumeEvent(parseInt(eventId));
    
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to resume event');
    res.status(400).json({ error: error.message });
  }
});

/**
 * POST /api/events/:eventId/cancel
 * 取消活动（管理员）
 */
router.post('/:eventId/cancel', requireAuth, async (req, res) => {
  try {
    const { eventId } = req.params;
    
    await eventService.cancelEvent(parseInt(eventId));
    
    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Failed to cancel event');
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
