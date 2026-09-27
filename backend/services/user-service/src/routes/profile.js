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

// 我的资料（完整数据、配置、访客统计）
router.get('/me/profile', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.getProfile(uid(req), uid(req), { lang: lang(req) })))));
// 自定义资料卡（头像框、背景、签名、可见性、徽章、精选精灵、统计布局）
router.put('/me/profile', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.updateProfile(uid(req), req.body), '资料卡已更新'))));
// 可选头像框与资料背景（含解锁状态）
router.get('/me/profile/customization', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.customization(uid(req), lang(req))))));
// 可展示的成就徽章
router.get('/me/profile/badges/available', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.availableBadges(uid(req), lang(req))))));
// 生成资料卡分享链接、二维码与卡片图片地址
router.post('/me/profile/share', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.share(uid(req))))));
// 我的统计摘要
router.get('/me/stats/summary', requireAuth, wrap(async (req, res) => res.json(successResp(await svc.statsSummary(uid(req), lang(req))))));
// 收藏家积分排行榜
router.get('/leaderboard/collectors', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.collectorsLeaderboard({ limit: req.query.limit, lang: lang(req), userId: uid(req) })));
}));

const sendCard = wrap(async (req, res) => {
  const svg = await svc.cardSvg(uid(req), target(req), lang(req));
  if (req.query.format === 'json') return res.json(successResp({ svg, contentType: 'image/svg+xml' }));
  res.set('Content-Type', 'image/svg+xml; charset=utf-8').set('Cache-Control', 'private, max-age=60').send(svg);
});
// 资料卡图片（SVG）
router.get('/:userId/profile/card.svg', requireAuth, sendCard);
// 资料卡图片（SVG；?format=json 返回字符串）
router.get('/:userId/profile/card', requireAuth, sendCard);

// 玩家资料（按公开/好友/私密过滤）
router.get('/:userId/profile', requireAuth, wrap(async (req, res) => {
  res.json(successResp(await svc.getProfile(uid(req), target(req), { lang: lang(req), source: req.query.src === 'qr' ? 'qr_code' : 'in_app', ip: req.ip })));
}));
// 玩家统计（按隐私过滤）
router.get('/:userId/stats', requireAuth, wrap(async (req, res, next) => {
  if (!/^[0-9a-f-]{36}$/i.test(target(req))) return next();
  const p = await svc.getProfile(uid(req), target(req), { lang: lang(req), ip: req.ip });
  res.json(successResp({ audience: p.audience, restricted: !!p.restricted, player: p.player, stats: p.stats || null,
    achievements: p.achievements || null, pokedex: p.pokedex || null }));
}));

// 分享卡片图片（公开资料，无需登录）
publicRouter.get('/:code.svg', wrap(async (req, res) => {
  const { svg } = await svc.byShareCode(req.params.code, { lang: lang(req), source: req.query.src === 'qr' ? 'qr_code' : 'share_link', ip: req.ip });
  res.set('Content-Type', 'image/svg+xml; charset=utf-8').set('Cache-Control', 'public, max-age=300').send(svg);
}));
// 分享页资料数据（公开资料，无需登录）
publicRouter.get('/:code', wrap(async (req, res) => {
  const { profile } = await svc.byShareCode(req.params.code, { lang: lang(req), source: req.query.src === 'qr' ? 'qr_code' : 'share_link', ip: req.ip });
  res.json(successResp(profile));
}));

module.exports = router;
module.exports.publicRouter = publicRouter;
