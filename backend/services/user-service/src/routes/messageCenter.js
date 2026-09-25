// backend/services/user-service/src/routes/messageCenter.js
// REQ-00099 / REQ-00261 / REQ-00425：消息中心 API（网关 /v1/notifications → user-service /notifications）
//
//   GET    /notifications?status=unread|read|all&category=&type=&page=&limit=&since=   列表（含分页、未读数）
//   GET    /notifications/unread-count                  未读数（总数 / 按分类 / 按类型）
//   GET    /notifications/categories                    分类（标签页）
//   GET    /notifications/preferences                   偏好（分类开关、免打扰、渠道、临时静音）
//   PATCH|PUT /notifications/preferences                更新偏好
//   POST   /notifications/batch-read {ids|all|category} 批量已读；POST /notifications/read-all 全部已读
//   POST   /notifications/batch-delete {ids}            批量删除；POST /notifications/clear-read 清空已读
//   GET    /notifications/stats                         我的消息统计
//   GET    /notifications/:id                           详情
//   PATCH|POST /notifications/:id/read                  标记已读
//   POST   /notifications/:id/click                     点击（深度链接跳转 + 打开率统计）
//   DELETE /notifications/:id                           删除
//   管理员：POST /notifications/admin/broadcast（系统公告），GET /notifications/admin/analytics（送达/打开率）
'use strict';

const { Router } = require('express');
const db = require('../../../../shared/db');
const center = require('../../../../shared/notificationCenter');
const policy = require('../../../../shared/notificationPolicy');
const pushProviders = require('../../../../shared/pushProviders');
const { requireAuth, requireAdmin, successResp } = require('../../../../shared/auth');

const router = Router();
router.use(requireAuth);

const uid = (req) => req.user.sub || req.user.id;
const lang = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/', wrap(async (req, res) => {
  const { status, category, type, page, limit, since } = req.query;
  res.json(successResp(await center.list(uid(req), { status, category, type, page, limit, since, lang: lang(req) }, db)));
}));

router.get('/unread-count', wrap(async (req, res) => {
  res.json(successResp(await center.unreadCount(uid(req), db)));
}));

router.get('/categories', (req, res) => {
  const l = require('../../../../shared/achievementRules').normalizeLang(lang(req));
  res.json(successResp(policy.CATEGORIES.map((c) => ({
    key: c, label: policy.CATEGORY_LABELS[c][l], icon: policy.CATEGORY_LABELS[c].icon, mandatory: policy.MANDATORY.has(c),
  }))));
});

router.get('/preferences', wrap(async (req, res) => {
  const prefs = await center.getPreferences(uid(req), db);
  res.json(successResp({ ...policy.preferencesView(prefs), pushProviders: pushProviders.status() }));
}));

const updatePrefs = wrap(async (req, res) => {
  const prefs = await center.updatePreferences(uid(req), req.body, db);
  res.json(successResp({ updated: true, ...policy.preferencesView(prefs) }));
});
router.patch('/preferences', updatePrefs);
router.put('/preferences', updatePrefs);

router.post('/batch-read', wrap(async (req, res) => {
  const { ids, all, category } = req.body || {};
  res.json(successResp(await center.batchRead(uid(req), { ids, all: all === true, category }, db)));
}));
router.post('/read-all', wrap(async (req, res) => {
  res.json(successResp(await center.batchRead(uid(req), { all: true }, db)));
}));
router.post('/batch-delete', wrap(async (req, res) => {
  res.json(successResp(await center.batchDelete(uid(req), (req.body || {}).ids, db)));
}));
router.post('/clear-read', wrap(async (req, res) => {
  res.json(successResp(await center.clearRead(uid(req), { before: (req.body || {}).before }, db)));
}));

router.get('/stats', wrap(async (req, res) => {
  res.json(successResp(await center.userStats(uid(req), db)));
}));

// ── 管理员 ────────────────────────────────────────────────────
router.post('/admin/broadcast', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title || typeof b.title !== 'string') { const e = new Error('title 必填'); e.statusCode = 400; throw e; }
  const created = await center.createBroadcast({
    type: 'system.announcement', category: b.category || 'system', priority: b.priority, title: b.title, body: b.body || '',
    params: { title: b.title, body: b.body || '', _i18n: b.i18n || undefined }, data: b.data, actionUrl: b.actionUrl,
    audience: b.audience, startsAt: b.startsAt, expiresAt: b.expiresAt, dedupeKey: b.dedupeKey, createdBy: uid(req),
  }, db);
  res.status(201).json(successResp(created));
}));
router.get('/admin/analytics', requireAdmin, wrap(async (req, res) => {
  res.json(successResp(await center.analytics({ days: req.query.days }, db)));
}));

// ── 单条 ──────────────────────────────────────────────────────
router.get('/:id', wrap(async (req, res, next) => {
  if (!center.UUID_RE.test(req.params.id)) return next(); // 让其他同前缀路由（device-token、logs…）处理
  const n = await center.getOne(uid(req), req.params.id, lang(req), db);
  if (!n) { const e = new Error('通知不存在'); e.statusCode = 404; throw e; }
  res.json(successResp(n));
}));
const markRead = wrap(async (req, res) => {
  res.json(successResp(await center.markRead(uid(req), req.params.id, db)));
});
router.patch('/:id/read', markRead);
router.post('/:id/read', markRead);
router.post('/:id/click', wrap(async (req, res) => {
  res.json(successResp(await center.markClicked(uid(req), req.params.id, db)));
}));
router.delete('/:id', wrap(async (req, res, next) => {
  if (!center.UUID_RE.test(req.params.id)) return next();
  res.json(successResp(await center.remove(uid(req), req.params.id, db)));
}));

module.exports = router;
