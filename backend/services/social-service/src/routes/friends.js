/**
 * REQ-00048: 好友系统 API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const friendService = require('../friendService');
const { requireAuth } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const { successResp, AppError, errorHandler } = require('../../../shared/response');

const logger = createLogger('friend-routes');

/**
 * 获取好友列表
 * GET /friends
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { page = 1, limit = 50, sortBy = 'last_interaction' } = req.query;

    const result = await friendService.getFriendList(userId, {
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100),
      sortBy
    });

    res.json(successResp(result));
  } catch (error) {
    next(error);
  }
});

/**
 * 搜索用户
 * GET /friends/search
 */
router.get('/search', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { q: query, limit = 20 } = req.query;

    if (!query || query.length < 2) {
      throw new AppError(1001, '搜索关键词至少2个字符', 400);
    }

    const result = await friendService.searchUsers(userId, query, parseInt(limit));
    res.json(successResp(result));
  } catch (error) {
    next(error);
  }
});

/**
 * 获取待处理的好友请求
 * GET /friends/requests/pending
 */
router.get('/requests/pending', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { page = 1, limit = 20 } = req.query;

    const result = await friendService.getPendingRequests(userId, {
      page: parseInt(page),
      limit: parseInt(limit)
    });

    res.json(successResp(result));
  } catch (error) {
    next(error);
  }
});

/**
 * 获取发送的请求
 * GET /friends/requests/sent
 */
router.get('/requests/sent', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const result = await friendService.getSentRequests(userId);
    res.json(successResp(result));
  } catch (error) {
    next(error);
  }
});

/**
 * 获取待领取礼物
 * GET /friends/gifts/pending
 */
router.get('/gifts/pending', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { page = 1, limit = 20 } = req.query;

    const result = await friendService.getPendingGifts(userId, {
      page: parseInt(page),
      limit: parseInt(limit)
    });

    res.json(successResp(result));
  } catch (error) {
    next(error);
  }
});

/**
 * 获取好友排行榜
 * GET /friends/leaderboard
 */
router.get('/leaderboard', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { type = 'friendship', limit = 10 } = req.query;

    const result = await friendService.getFriendLeaderboard(userId, type, parseInt(limit));
    res.json(successResp(result));
  } catch (error) {
    next(error);
  }
});

/**
 * 获取我的好友码
 * GET /friends/my-code
 */
router.get('/my-code', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const friendCode = await friendService.getFriendCode(userId);
    res.json(successResp({ friendCode }));
  } catch (error) {
    next(error);
  }
});

/**
 * 获取好友详情
 * GET /friends/:friendId
 */
router.get('/:friendId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { friendId } = req.params;

    const result = await friendService.getFriendDetail(userId, friendId);
    res.json(successResp(result));
  } catch (error) {
    next(error);
  }
});

/**
 * 发送好友请求
 * POST /friends/request
 */
router.post('/request', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { toUserId, message } = req.body;

    if (!toUserId) {
      throw new AppError(1001, 'toUserId 必填', 400);
    }

    const result = await friendService.sendFriendRequest(userId, toUserId, message || '');
    res.status(201).json(result);
  } catch (error) {
    if (error.code) {
      // 已定义的错误
      next(error);
    } else {
      next(error);
    }
  }
});

/**
 * 通过好友码添加好友
 * POST /friends/add-by-code
 */
router.post('/add-by-code', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { friendCode } = req.body;

    if (!friendCode) {
      throw new AppError(1001, 'friendCode 必填', 400);
    }

    const result = await friendService.addFriendByCode(userId, friendCode);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * 接受好友请求
 * POST /friends/request/:requestId/accept
 */
router.post('/request/:requestId/accept', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { requestId } = req.params;

    const result = await friendService.acceptFriendRequest(userId, parseInt(requestId));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * 拒绝好友请求
 * POST /friends/request/:requestId/reject
 */
router.post('/request/:requestId/reject', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { requestId } = req.params;

    const result = await friendService.rejectFriendRequest(userId, parseInt(requestId));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * 删除好友
 * DELETE /friends/:friendId
 */
router.delete('/:friendId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { friendId } = req.params;

    const result = await friendService.removeFriend(userId, friendId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * 赠送礼物给好友
 * POST /friends/:friendId/gift
 */
router.post('/:friendId/gift', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { friendId } = req.params;
    const { giftType, giftId, quantity = 1, giftName } = req.body;

    if (!giftType || !giftId) {
      throw new AppError(1001, 'giftType 和 giftId 必填', 400);
    }

    const validGiftTypes = ['item', 'candy', 'stardust'];
    if (!validGiftTypes.includes(giftType)) {
      throw new AppError(1002, `giftType 必须是: ${validGiftTypes.join(', ')}`, 400);
    }

    const result = await friendService.sendGift(userId, friendId, {
      giftType,
      giftId,
      quantity: parseInt(quantity),
      giftName
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * 领取礼物
 * POST /friends/gifts/:giftId/claim
 */
router.post('/gifts/:giftId/claim', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { giftId } = req.params;

    const result = await friendService.claimGift(userId, parseInt(giftId));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * 批量领取礼物
 * POST /friends/gifts/claim-all
 */
router.post('/gifts/claim-all', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    
    // 获取所有待领取礼物
    const { gifts } = await friendService.getPendingGifts(userId, { limit: 100 });
    
    const results = [];
    const errors = [];

    for (const gift of gifts) {
      try {
        const result = await friendService.claimGift(userId, gift.id);
        results.push({ giftId: gift.id, ...result });
      } catch (error) {
        errors.push({ giftId: gift.id, error: error.message });
      }
    }

    res.json(successResp({
      claimed: results.length,
      failed: errors.length,
      results,
      errors
    }));
  } catch (error) {
    next(error);
  }
});

/**
 * 更新用户在线状态
 * POST /friends/update-status
 */
router.post('/update-status', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    await friendService.updateUserActiveStatus(userId);
    res.json(successResp({ message: '状态已更新' }));
  } catch (error) {
    next(error);
  }
});

// 错误处理
router.use(errorHandler);

module.exports = router;
