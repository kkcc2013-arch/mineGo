/**
 * REQ-00228：隐私设置与好友权限 API（网关 /v1/privacy/* → social-service /privacy/*）
 */
'use strict';

const express = require('express');
const privacyService = require('../social/privacyService');
const friendService = require('../friendService');
const recommendationService = require('../social/recommendationService');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../../shared/auth');

const router = express.Router();
router.use(requireAuth);

const h = (fn, status = 200) => async (req, res, next) => {
  try { res.status(status).json(successResp(await fn(req, res))); } catch (err) { next(err); }
};
const uid = (req) => req.user.sub;

// 设置更新限流：每用户每分钟 10 次（进程内滑动窗口）
const hits = new Map();
function limitUpdates(req, res, next) {
  const now = Date.now();
  const arr = (hits.get(uid(req)) || []).filter((t) => now - t < 60000);
  if (arr.length >= 10) return next(new AppError(1006, '操作过于频繁，请稍后再试', 429));
  arr.push(now);
  hits.set(uid(req), arr);
  if (hits.size > 10000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k);
  return next();
}

router.get('/settings', h((req) => privacyService.getSettings(uid(req))));
router.patch('/settings', limitUpdates, h((req) => privacyService.updateSettings(uid(req), req.body, req)));
router.put('/settings', limitUpdates, h((req) => privacyService.updateSettings(uid(req), req.body, req)));

router.get('/check/:targetId/:dataType', h((req) => privacyService.checkVisibility(uid(req), req.params.targetId, req.params.dataType)));
router.post('/check/batch', h((req) => {
  const { targetIds, dataTypes } = req.body || {};
  return privacyService.batchCheck(uid(req), targetIds, dataTypes);
}));

router.get('/groups', h((req) => privacyService.listGroups(uid(req))));
router.post('/groups', h((req) => privacyService.createGroup(uid(req), req.body, req), 201));
router.patch('/groups/:groupId', h((req) => privacyService.updateGroup(uid(req), req.params.groupId, req.body, req)));
router.delete('/groups/:groupId', h((req) => privacyService.deleteGroup(uid(req), req.params.groupId, req)));

router.patch('/friends/:friendId/permissions', h((req) => privacyService.updateFriendPermissions(uid(req), req.params.friendId, req.body || {}, req)));
router.delete('/friends/:friendId', h(async (req) => {
  const r = await friendService.removeFriend(uid(req), req.params.friendId, { reason: 'privacy_center' });
  await recommendationService.invalidate([uid(req), req.params.friendId]);
  return r;
}));

router.get('/blocked', h((req) => privacyService.listBlocked(uid(req))));
router.post('/block/:userId', h(async (req) => {
  const r = await privacyService.block(uid(req), req.params.userId, req.body && req.body.reason, req);
  await recommendationService.invalidate([uid(req), req.params.userId]);
  return r;
}, 201));
router.delete('/block/:userId', h((req) => privacyService.unblock(uid(req), req.params.userId, req)));

// 好友申请审批（与 /v1/friends/request* 等价，便于隐私中心统一处理）
router.get('/friend-requests', h((req) => friendService.getPendingRequests(uid(req), { page: req.query.page, limit: req.query.limit })));
router.post('/friend-requests', h((req) => {
  const { toUserId, message } = req.body || {};
  if (!toUserId) throw new AppError(1001, 'toUserId 必填', 400);
  return friendService.sendFriendRequest(uid(req), toUserId, { message });
}, 201));
router.post('/friend-requests/:requestId/:action', h((req) => {
  const { requestId, action } = req.params;
  if (action === 'accept') return friendService.acceptFriendRequest(uid(req), requestId);
  if (action === 'reject') return friendService.rejectFriendRequest(uid(req), requestId);
  if (action === 'ignore') return friendService.rejectFriendRequest(uid(req), requestId, { ignore: true });
  throw new AppError(1001, 'action 必须是 accept/reject/ignore', 400);
}));

router.get('/audit-log', h((req) => privacyService.auditLog(uid(req), req.query.limit)));

router.use(errorHandler);

module.exports = router;
