'use strict';

/**
 * 玩家资料与资料卡 API（REQ-00327 / REQ-00387）——网关 /v1/users/... → user-service /users/...
 *
 *   GET  /users/me/profile                     我的资料（完整数据 + 配置 + 访客统计）
 *   PUT  /users/me/profile                     自定义 {avatarFrameId, backgroundThemeId, signature, visibility, selectedBadges(≤6), selectedPokemon(≤3/5), statsLayout}
 *   GET  /users/me/profile/customization       头像框/背景主题（含解锁状态）
 *   GET  /users/me/profile/badges/available    可展示的成就徽章
 *   POST /users/me/profile/share               分享链接 + 二维码 + 卡片图片地址
 *   GET  /users/me/stats/summary               统计摘要
 *   GET  /users/leaderboard/collectors         收藏家积分排行（缓存 60 秒）
 *   GET  /users/:userId/profile                他人资料（隐私过滤：公开/好友/私密）
 *   GET  /users/:userId/profile/card(.svg)     资料卡图片（SVG；?format=json 返回 {svg, cardImageUrl}）
 *   GET  /users/:userId/stats                  他人统计（同隐私过滤）
 * 公开（无需登录，网关 /v1/profile-cards）：
 *   GET  /profile-cards/:code.svg              分享卡片图片；GET /profile-cards/:code 分享页数据（仅公开资料）
 */

const express = require('express');
const svc = require('../profile/profileService');
const { requireAuth, successResp } = require('../../../../shared/auth');

const router = express.Router();
const publicRouter = express.Router();

const uid = (req) => req.user.sub || req.user.id;
const lang = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const target = (req) => (req.params.userId === 'me' ? uid(req) : req.params.userId);

router.get('/me/profile', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.getProfile(uid(req), uid(req), { lang: lang(req) })))));
router.put('/me/profile', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.updateProfile(uid(req), req.body), '资料卡已更新'))));
router.get('/me/profile/customization', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.customization(uid(req), lang(req))))));
router.get('/me/profile/badges/available', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.availableBadges(uid(req), lang(req))))));
router.post('/me/profile/share', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.share(uid(req))))));
router.get('/me/stats/summary', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.statsSummary(uid(req), lang(req))))));
router.get('/leaderboard/collectors', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.collectorsLeaderboard({ limit: req.query.limit, lang: lang(req), userId: uid(req) })));
}));

const sendCard = wrap(async (req, res) => {
  const svg = await svc.cardSvg(uid(req), target(req), lang(req));
  if (req.query.format === 'json') return res.json(successResp({ svg, contentType: 'image/svg+xml' }));
  res.set('Content-Type', 'image/svg+xml; charset=utf-8').set('Cache-Control', 'private, max-age=60').send(svg);
});
router.get('/:userId/profile/card.svg', requireAuth, sendCard);
router.get('/:userId/profile/card', requireAuth, sendCard);

router.get('/:userId/profile', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.getProfile(uid(req), target(req), { lang: lang(req), source: req.query.src === 'qr' ? 'qr_code' : 'in_app', ip: req.ip })));
}));
router.get('/:userId/stats', requireAuth, wrap(async (req, res, next) => {
  if (!/^[0-9a-f-]{36}$/i.test(target(req))) return next();
  const p = await svc.getProfile(uid(req), target(req), { lang: lang(req), ip: req.ip });
  res.json(successResp({ audience: p.audience, restricted: !!p.restricted, player: p.player, stats: p.stats || null,
    achievements: p.achievements || null, pokedex: p.pokedex || null }));
}));

publicRouter.get('/:code.svg', wrap(async (req, res) => {
  const { svg } = await svc.byShareCode(req.params.code, { lang: lang(req), source: req.query.src === 'qr' ? 'qr_code' : 'share_link', ip: req.ip });
  res.set('Content-Type', 'image/svg+xml; charset=utf-8').set('Cache-Control', 'public, max-age=300').send(svg);
}));
publicRouter.get('/:code', wrap(async (req, res) => {
  const { profile } = await svc.byShareCode(req.params.code, { lang: lang(req), source: req.query.src === 'qr' ? 'qr_code' : 'share_link', ip: req.ip });
  res.json(successResp(profile));
}));

module.exports = router;
module.exports.publicRouter = publicRouter;
