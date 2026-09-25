/**
 * REQ-00377 精灵数据可见性 + REQ-00326 精灵好友互动（网关 /v1/pokemon/* → pokemon-service /pokemon/*）
 * 在其他 /pokemon 子路由之前挂载，静态路径优先于 /:pokemonId 参数路径。
 */
'use strict';

const express = require('express');
const privacy = require('../services/pokemonPrivacyService');
const friends = require('../services/pokemonFriendService');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../../shared/auth');

const router = express.Router();

const h = (fn, status = 200) => [requireAuth, async (req, res, next) => {
  try { res.status(status).json(successResp(await fn(req, res))); } catch (err) { next(err); }
}];
const uid = (req) => req.user.sub;

// ── 精灵隐私（REQ-00377） ────────────────────────────────────────
router.get('/privacy/defaults', ...h((req) => privacy.getDefaults(uid(req))));
router.put('/privacy/defaults', ...h((req) => privacy.updateDefaults(uid(req), req.body || {})));
router.post('/privacy/batch', ...h((req) => {
  const b = req.body || {};
  return privacy.batchUpdate(uid(req), b.pokemon_ids || b.pokemonIds, b.settings);
}));
router.get('/users/:userId/collection', ...h((req) => privacy.getUserCollection(uid(req), req.params.userId, {
  limit: req.query.limit, offset: req.query.offset,
})));

// ── 精灵好友（REQ-00326） ────────────────────────────────────────
router.get('/friendships/requests', ...h((req) => friends.pendingRequests(uid(req))));
router.put('/friendships/:friendshipId/status', ...h((req) => {
  const { action } = req.body || {};
  if (!action) throw new AppError(1001, 'action 必填', 400);
  return friends.respond(uid(req), req.params.friendshipId, action);
}));
router.post('/friendships/:friendshipId/interact', ...h((req) => {
  const { type, data } = req.body || {};
  if (!type) throw new AppError(1001, 'type 必填', 400);
  return friends.interact(uid(req), req.params.friendshipId, type, data);
}));
router.get('/friendships/:friendshipId/keepsakes', ...h((req) => friends.keepsakes(uid(req), req.params.friendshipId)));
router.get('/friendships/:friendshipId', ...h((req) => friends.detail(uid(req), req.params.friendshipId)));

router.post('/:pokemonId/friend-request', ...h((req) => {
  const { friendPokemonId, message } = req.body || {};
  if (!friendPokemonId) throw new AppError(1001, 'friendPokemonId 必填', 400);
  return friends.sendRequest(uid(req), req.params.pokemonId, friendPokemonId, message);
}, 201));
router.get('/:pokemonId/friends', ...h((req) => friends.list(uid(req), req.params.pokemonId, {
  page: req.query.page, limit: req.query.limit, sortBy: req.query.sortBy,
})));

router.get('/:pokemonId/visibility', ...h((req) => privacy.getVisibility(uid(req), req.params.pokemonId)));
router.get('/:pokemonId/privacy', ...h((req) => privacy.getPokemonPrivacy(uid(req), req.params.pokemonId)));
router.put('/:pokemonId/privacy', ...h((req) => privacy.updatePokemonPrivacy(uid(req), req.params.pokemonId, req.body || {})));

router.use(errorHandler);

module.exports = router;
