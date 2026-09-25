'use strict';

/**
 * REQ-00106: 称号 API（网关 /v1/users/... → user-service /users/...）
 *
 *   GET  /users/titles?category=&rarity=         称号目录（含是否已拥有）
 *   GET  /users/titles/leaderboard               称号收集排行
 *   GET  /users/titles/:titleId                  称号详情
 *   GET  /users/me/titles                        我的称号（?includeExpired=true 含已过期）
 *   GET  /users/me/titles/active                 当前佩戴
 *   GET  /users/me/titles/stats                  统计（按稀有度）
 *   GET  /users/me/titles/bonuses                当前加成
 *   PUT|POST /users/me/titles/:titleId/activate  佩戴（每人最多一个）
 *   DELETE /users/me/titles/active               取下
 *   PUT  /users/me/titles/:titleId/favorite      收藏 {isFavorite}
 *   POST /users/me/profile/title {titleId|null}  资料卡展示称号（REQ-00327 别名）
 *   GET  /users/:userId/titles, /users/:userId/titles/active  他人的称号
 *   管理员：POST /users/titles/grant {userId, titleId}，POST /users/titles/process-expired
 * 玩家不能自行解锁称号（原 POST /users/me/titles/:id/unlock 已移除）：称号只由成就/活动/管理员发放。
 */

const express = require('express');
const db = require('../../../../shared/db');
const titles = require('../../../../shared/titles');
const profileCache = require('../../../../shared/profileCache');
const { UUID_RE } = require('../../../../shared/notificationCenter');
const { requireAuth, requireAdmin, successResp } = require('../../../../shared/auth');

const router = express.Router();

const uid = (req) => req.user.sub || req.user.id;
const lang = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const TITLE_ID = /^[a-z0-9_]{2,50}$/;

function bad(msg) { const e = new Error(msg); e.statusCode = 400; return e; }

// 称号目录（含是否已拥有）
router.get('/titles', requireAuth, wrap(async (req, res) => {
  const { category, rarity } = req.query;
  res.json(successResp(await titles.catalog({ lang: lang(req), category, rarity, userId: uid(req) }, db)));
}));

// 称号收集排行榜
router.get('/titles/leaderboard', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await titles.leaderboard({ limit: req.query.limit, lang: lang(req) }, db)));
}));

// 管理员发放称号
router.post('/titles/grant', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { userId, titleId } = req.body || {};
  if (!UUID_RE.test(String(userId || '')) || !TITLE_ID.test(String(titleId || ''))) throw bad('userId / titleId 无效');
  const r = await titles.grant(userId, titleId, { sourceType: 'admin', sourceId: uid(req) }, db);
  await profileCache.bump(userId);
  res.json(successResp(r));
}));

// 管理员触发限时称号过期处理
router.post('/titles/process-expired', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json(successResp(await titles.expireTitles(db)));
}));

// 称号详情
router.get('/titles/:titleId', requireAuth, wrap(async (req, res) => {
  if (!TITLE_ID.test(req.params.titleId)) throw bad('titleId 无效');
  const t = await titles.getDefinition(req.params.titleId, lang(req), db);
  if (!t) { const e = new Error('称号不存在'); e.statusCode = 404; throw e; }
  res.json(successResp(t));
}));

// 我的称号
router.get('/me/titles', requireAuth, wrap(async (req, res) => {
  const { category, rarity, includeExpired } = req.query;
  res.json(successResp(await titles.listUserTitles(uid(req), { lang: lang(req), category, rarity, includeExpired: includeExpired === 'true' }, db)));
}));

// 当前佩戴的称号
router.get('/me/titles/active', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await titles.getActiveTitle(uid(req), lang(req), db)));
}));

// 我的称号统计（按稀有度）
router.get('/me/titles/stats', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await titles.stats(uid(req), db)));
}));

// 当前称号属性加成
router.get('/me/titles/bonuses', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await titles.getStatBonuses(uid(req), db)));
}));

const activate = wrap(async (req, res) => {
  if (!TITLE_ID.test(req.params.titleId)) throw bad('titleId 无效');
  const r = await titles.activate(uid(req), req.params.titleId, db);
  await profileCache.bump(uid(req));
  res.json(successResp({ ...r, title: await titles.getActiveTitle(uid(req), lang(req), db) }, '称号已佩戴'));
});
// 佩戴称号
router.put('/me/titles/:titleId/activate', requireAuth, activate);
// 佩戴称号（POST 兼容）
router.post('/me/titles/:titleId/activate', requireAuth, activate);

// 取下称号
router.delete('/me/titles/active', requireAuth, wrap(async (req, res) => {
  const r = await titles.activate(uid(req), null, db);
  await profileCache.bump(uid(req));
  res.json(successResp(r, '称号已取下'));
}));

// 收藏/取消收藏称号
router.put('/me/titles/:titleId/favorite', requireAuth, wrap(async (req, res) => {
  if (!TITLE_ID.test(req.params.titleId)) throw bad('titleId 无效');
  const fav = req.body && req.body.isFavorite !== undefined ? !!req.body.isFavorite : true;
  res.json(successResp(await titles.setFavorite(uid(req), req.params.titleId, fav, db)));
}));

// REQ-00327: POST /users/me/profile/title —— 设置资料卡展示称号
router.post('/me/profile/title', requireAuth, wrap(async (req, res) => {
  const titleId = req.body && req.body.titleId;
  if (titleId !== null && titleId !== undefined && !TITLE_ID.test(String(titleId))) throw bad('titleId 无效');
  const r = await titles.activate(uid(req), titleId || null, db);
  await profileCache.bump(uid(req));
  res.json(successResp({ ...r, title: await titles.getActiveTitle(uid(req), lang(req), db) }));
}));

// 玩家的称号
router.get('/:userId/titles', requireAuth, wrap(async (req, res, next) => {
  if (!UUID_RE.test(req.params.userId)) return next();
  res.json(successResp(await titles.listUserTitles(req.params.userId, { lang: lang(req) }, db)));
}));

// 玩家当前佩戴的称号
router.get('/:userId/titles/active', requireAuth, wrap(async (req, res, next) => {
  if (!UUID_RE.test(req.params.userId)) return next();
  res.json(successResp(await titles.getActiveTitle(req.params.userId, lang(req), db)));
}));

module.exports = router;
