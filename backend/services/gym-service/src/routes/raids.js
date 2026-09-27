// 团战路由（经网关 /v1/raids/* → gym-service /raids/*）
//   GET  /raids/nearby?lat&lng&radius     附近团战（PostGIS ST_DWithin）
//   POST /raids/spawn                     生成团战（管理员）
//   GET  /raids/:id                       团战详情（含 Boss 技能/弱点、我的参与情况）
//   POST /raids/:id/join                  加入（需在道馆 100 米内；可指定 pokemonIds，否则取 CP 最高 6 只）
//   POST /raids/:id/attack                攻击（body: { moveId, pokemonId? }，伤害服务端计算，按技能时长限频）
//   POST /raids/:id/switch                更换出战精灵
//   GET  /raids/:id/result                伤害排行与奖励
// WebSocket /ws/raid 的 ATTACK 消息走同一个 raid.attack()。
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const { handle, userId, requireAdminRole } = require('../battle/http');
const raid = require('../battle/raid');

const router = express.Router();

router.get('/raids/nearby', requireAuth, handle((req) => raid.nearby(req.query.lat, req.query.lng, req.query.radius)));
router.post('/raids/spawn', requireAuth, handle((req) => { requireAdminRole(req); return raid.spawn(req.body || {}); }));
router.get('/raids/:id', requireAuth, handle((req) => raid.getRaid(req.params.id, userId(req))));
router.post('/raids/:id/join', requireAuth, handle((req) => raid.join(userId(req), req.params.id, req.body || {})));
router.post('/raids/:id/attack', requireAuth, handle((req) => raid.attack(userId(req), req.params.id, { moveId: (req.body || {}).moveId, pokemonId: (req.body || {}).pokemonId })));
router.post('/raids/:id/switch', requireAuth, handle((req) => raid.switchPokemon(userId(req), req.params.id, (req.body || {}).pokemonId)));
router.get('/raids/:id/result', requireAuth, handle((req) => raid.result(req.params.id, userId(req))));

module.exports = router;
