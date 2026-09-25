/**
 * REQ-00048 / REQ-00228 / REQ-00388：好友系统 API（网关 /v1/friends/* → social-service /friends/*）
 * 全部接口需要登录（网关 authMiddleware + 服务内 requireAuth），响应统一为 { code: 0, data }。
 */
'use strict';

const express = require('express');
const friendService = require('../friendService');
const privacyService = require('../social/privacyService');
const recommendationService = require('../social/recommendationService');
const activityService = require('../social/activityService');
const jointMissionService = require('../social/jointMissionService');
const socialEvents = require('../../../../shared/social/socialEvents');
const levels = require('../../../../shared/social/friendshipLevels');
const { query } = require('../../../../shared/db');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../../shared/auth');
const { isUuid } = require('../../../../shared/social/relationship');

const router = express.Router();
router.use(requireAuth);

const h = (fn, status = 200) => async (req, res, next) => {
  try {
    const data = await fn(req, res);
    res.status(status).json(successResp(data));
  } catch (err) { next(err); }
};
const uid = (req) => req.user.sub;
const friendParam = (req) => {
  if (!isUuid(req.params.friendId)) throw new AppError(1001, 'friendId 必须是有效的用户 ID', 400);
  return req.params.friendId;
};

// ── 列表 / 好友码 / 搜索 ──────────────────────────────────────
router.get('/', h((req) => friendService.getFriendList(uid(req), {
  page: req.query.page, limit: req.query.limit, sortBy: req.query.sortBy,
  groupId: req.query.groupId, favorite: req.query.favorite,
})));

router.get('/my-code', h((req) => friendService.getFriendCode(uid(req))));

router.get('/code/:code', h(async (req) => {
  const u = await friendService.findUserByFriendCode(req.params.code);
  return { id: u.id, nickname: u.nickname, avatar_url: u.avatar_url, level: u.level, team: u.team };
}));

router.get('/search', h((req) => friendService.searchUsers(uid(req), req.query.q, req.query.limit)));

router.get('/levels', h(async () => ({
  friendship: levels.FRIENDSHIP_LEVELS,
  intimacy: (await query('SELECT level, min_points, max_points, level_name, benefits FROM intimacy_levels ORDER BY level')).rows,
  interactionPoints: levels.INTERACTION_POINTS,
})));

// ── 好友请求 ───────────────────────────────────────────────────
router.get('/requests/pending', h((req) => friendService.getPendingRequests(uid(req), { page: req.query.page, limit: req.query.limit })));
router.get('/requests/sent', h((req) => friendService.getSentRequests(uid(req))));

router.post('/request', h((req) => {
  const { toUserId, message, source } = req.body || {};
  if (!toUserId) throw new AppError(1001, 'toUserId 必填', 400);
  return friendService.sendFriendRequest(uid(req), toUserId, { message, source });
}, 201));

router.post('/add-by-code', h((req) => {
  const { friendCode, message } = req.body || {};
  if (!friendCode) throw new AppError(1001, 'friendCode 必填', 400);
  return friendService.addFriendByCode(uid(req), friendCode, message);
}, 201));

// 旧接口兼容：POST /friends/add { friendCode }（好友码或用户 ID）
router.post('/add', h((req) => {
  const { friendCode, message } = req.body || {};
  if (!friendCode) throw new AppError(1001, 'friendCode 必填', 400);
  if (isUuid(friendCode)) return friendService.sendFriendRequest(uid(req), friendCode, { message, source: 'code' });
  return friendService.addFriendByCode(uid(req), friendCode, message);
}, 201));

router.post('/request/:requestId/accept', h((req) => friendService.acceptFriendRequest(uid(req), req.params.requestId)));
router.post('/request/:requestId/reject', h((req) => friendService.rejectFriendRequest(uid(req), req.params.requestId,
  { notes: req.body && req.body.notes })));
router.post('/request/:requestId/ignore', h((req) => friendService.rejectFriendRequest(uid(req), req.params.requestId, { ignore: true })));
router.delete('/request/:requestId', h((req) => friendService.cancelFriendRequest(uid(req), req.params.requestId)));

// ── 礼物 ───────────────────────────────────────────────────────
router.get('/gifts/pending', h((req) => friendService.getPendingGifts(uid(req), { page: req.query.page, limit: req.query.limit })));
router.get('/gifts', h(async (req) => (await friendService.getPendingGifts(uid(req), { limit: 50 })).gifts));
router.get('/gifts/sent', h((req) => friendService.getSentGifts(uid(req), { limit: req.query.limit })));
router.get('/gifts/types', h(() => friendService.getGiftTypes()));
router.post('/gifts/claim-all', h((req) => friendService.claimAllGifts(uid(req))));
router.post('/gifts/:giftId/claim', h((req) => friendService.claimGift(uid(req), req.params.giftId)));
router.post('/gifts/:giftId/open', h((req) => friendService.claimGift(uid(req), req.params.giftId)));

// ── 排行榜 / 在线状态 / 个人资料 ────────────────────────────────
router.get('/leaderboard', h((req) => friendService.getFriendLeaderboard(uid(req), req.query.type || 'friendship', req.query.limit)));
router.post('/update-status', h((req) => friendService.touchPresence(uid(req))));

router.put('/me/profile', h(async (req) => {
  const { birthday } = req.body || {};
  if (birthday !== null && birthday !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(birthday))) {
    throw new AppError(1001, 'birthday 格式为 YYYY-MM-DD', 400);
  }
  const { rows: [r] } = await query(
    "UPDATE users SET birthday = $2::date WHERE id = $1 RETURNING to_char(birthday, 'YYYY-MM-DD') AS birthday",
    [uid(req), birthday || null]);
  return r;
}));

// ── 推荐 / 提醒 / 动态 ─────────────────────────────────────────
router.get('/recommendations', h((req) => recommendationService.getRecommendations(uid(req), {
  limit: req.query.limit, refresh: req.query.refresh === 'true',
})));
router.post('/recommendations/:userId/dismiss', h((req) => {
  if (!isUuid(req.params.userId)) throw new AppError(1001, 'userId 无效', 400);
  return recommendationService.dismiss(uid(req), req.params.userId);
}));

router.get('/reminders', h((req) => activityService.listReminders(uid(req), {
  unreadOnly: req.query.unread === 'true', limit: req.query.limit,
})));
router.post('/reminders/read', h((req) => activityService.markRemindersRead(uid(req), req.body && req.body.ids)));

router.get('/activities', h((req) => activityService.getFeed(uid(req), { limit: req.query.limit, before: req.query.before })));
router.post('/activities/:activityId/like', h((req) => activityService.like(uid(req), req.params.activityId)));

// ── 联合任务 ───────────────────────────────────────────────────
router.get('/joint-missions/:progressId', h((req) => jointMissionService.get(uid(req), req.params.progressId)));
router.post('/joint-missions/:progressId/claim', h((req) => jointMissionService.claim(uid(req), req.params.progressId)));

// ── 单个好友 ───────────────────────────────────────────────────
router.get('/:friendId/joint-missions', h((req) => jointMissionService.list(uid(req), friendParam(req))));
router.post('/:friendId/joint-missions', h((req) => {
  const { missionId } = req.body || {};
  if (!missionId) throw new AppError(1001, 'missionId 必填', 400);
  return jointMissionService.start(uid(req), friendParam(req), missionId);
}, 201));

// 邀请好友（道馆 / 联合任务）：写提醒并实时推送
router.post('/:friendId/invite', h(async (req) => {
  const friendId = friendParam(req);
  const { type = 'gym', gymId, message } = req.body || {};
  if (type !== 'gym') throw new AppError(1001, 'type 目前仅支持 gym', 400);
  const { rows: [f] } = await query(`
    SELECT u.nickname FROM friends f JOIN users u ON u.id = f.user_id
     WHERE f.user_id = $1 AND f.friend_user_id = $2 AND f.status = 'accepted'`, [uid(req), friendId]);
  if (!f) throw new AppError(2006, '你们还不是好友', 400);
  let gymName = null;
  if (gymId) {
    if (!isUuid(gymId)) throw new AppError(1001, 'gymId 无效', 400);
    const { rows: [g] } = await query('SELECT name FROM gyms WHERE id = $1', [gymId]);
    if (!g) throw new AppError(4001, '道馆不存在', 404);
    gymName = g.name;
  }
  const reminder = await socialEvents.createReminder({ query }, {
    userId: friendId, type: 'gym_invite', relatedUserId: uid(req),
    content: { gymId: gymId || null, gymName, nickname: f.nickname, message: message ? String(message).slice(0, 100) : null },
  });
  await socialEvents.publish([friendId], 'gym_invite', { from: { id: uid(req), nickname: f.nickname }, gymId: gymId || null, gymName });
  return { success: true, reminderId: reminder && reminder.id };
}, 201));

router.post('/:friendId/gift', h((req) => {
  const b = req.body || {};
  return friendService.sendGift(uid(req), friendParam(req), {
    giftType: b.giftType, giftId: b.giftId, quantity: b.quantity, message: b.message,
    wrapping: b.wrapping, anonymous: b.anonymous,
  });
}, 201));

router.patch('/:friendId', h((req) => privacyService.updateFriendPermissions(uid(req), friendParam(req), req.body || {}, req)));
router.get('/:friendId', h((req) => friendService.getFriendDetail(uid(req), friendParam(req))));
router.delete('/:friendId', h(async (req) => {
  const friendId = friendParam(req);
  const r = await friendService.removeFriend(uid(req), friendId, { reason: 'remove' });
  await recommendationService.invalidate([uid(req), friendId]);
  return r;
}));

router.use(errorHandler);

module.exports = router;
