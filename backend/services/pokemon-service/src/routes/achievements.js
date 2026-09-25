/**
 * REQ-00076: 成就系统 API（网关 /v1/achievements → pokemon-service /achievements）
 *
 *   GET  /achievements/categories              分类
 *   GET  /achievements/my?category=&status=    我的成就（隐藏成就解锁前不出现，只返回 hiddenLocked 数量）
 *   GET  /achievements/my/progress             总览：点数、完成数、分类进度、可领取数、排名、最近解锁
 *   GET  /achievements/leaderboard             成就点数排行榜（带激活称号）
 *   POST /achievements/claim-all               一键领取
 *   GET  /achievements/:achievementId          详情（含全服完成率）
 *   POST /achievements/:achievementId/claim    领取奖励（并发只成功一次）
 *   管理员：GET/POST /achievements/admin/definitions，PUT/DELETE /achievements/admin/definitions/:id，
 *           POST /achievements/admin/grant {userId, achievementId, amount}
 */
'use strict';

const express = require('express');
const svc = require('../achievementService');
const engine = require('../../../../shared/achievementEngine');
const { requireAuth, requireAdmin, successResp } = require('../../../../shared/auth');
const { UUID_RE } = require('../../../../shared/notificationCenter');

const router = express.Router();

const lang = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];
const uid = (req) => req.user.sub || req.user.id;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 成就分类
router.get('/categories', (req, res) => {
  const l = String(lang(req) || 'zh').slice(0, 2);
  res.json(successResp(svc.CATEGORY_LIST.map((c) => ({
    key: c, label: svc.CATEGORY_LABELS[c][l] || svc.CATEGORY_LABELS[c].zh, icon: svc.CATEGORY_LABELS[c].icon,
  }))));
});

// 我的成就（分类/状态筛选；隐藏成就解锁前只返回数量）
router.get('/my', requireAuth, wrap(async (req, res) => {
  const { category, status } = req.query;
  res.json(successResp(await svc.listForUser(uid(req), { category, status, lang: lang(req) })));
}));

// 成就总览（点数、完成数、分类进度、可领取数、排名、最近解锁）
router.get('/my/progress', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.overview(uid(req), lang(req))));
}));

// 成就点数排行榜
router.get('/leaderboard', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.leaderboard({ limit: req.query.limit, offset: req.query.offset, lang: lang(req), userId: uid(req) })));
}));

// 一键领取所有已完成成就的奖励
router.post('/claim-all', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.claimAll(uid(req))));
}));

// ── 管理员 ────────────────────────────────────────────────────
router.get('/admin/definitions', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json(successResp(await svc.adminList()));
}));
// 管理员：新建成就
router.post('/admin/definitions', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.status(201).json(successResp(await svc.adminCreate(req.body)));
}));
// 管理员：修改成就
router.put('/admin/definitions/:achievementId', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json(successResp(await svc.adminUpdate(req.params.achievementId, req.body)));
}));
// 管理员：下线成就
router.delete('/admin/definitions/:achievementId', requireAuth, requireAdmin, wrap(async (req, res) => {
  res.json(successResp(await svc.adminDeactivate(req.params.achievementId)));
}));
// 管理员：给玩家补发成就进度
router.post('/admin/grant', requireAuth, requireAdmin, wrap(async (req, res) => {
  const { userId, achievementId, amount } = req.body || {};
  if (!UUID_RE.test(String(userId || ''))) { const e = new Error('userId 无效'); e.statusCode = 400; throw e; }
  const r = await engine.grantProgress(String(userId || ''), String(achievementId || ''), Number(amount) || 1);
  if (!r) { const e = new Error('成就不存在'); e.statusCode = 404; throw e; }
  res.json(successResp(r));
}));

// 成就详情（含全服完成率）
router.get('/:achievementId', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.detail(uid(req), req.params.achievementId, lang(req))));
}));

// 领取成就奖励（并发只成功一次）
router.post('/:achievementId/claim', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.claim(uid(req), req.params.achievementId), '奖励已领取'));
}));

module.exports = router;
