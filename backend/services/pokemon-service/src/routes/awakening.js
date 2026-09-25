/**
 * 精灵觉醒 / 战斗档案 / 成长商店路由（挂载在 /pokemon，经网关 /v1/pokemon/*，均需 JWT）
 *
 * REQ-00245 觉醒：
 *   GET  /pokemon/awakening/potentials?lang=     潜能池（多语言）
 *   GET  /pokemon/:id/awakening?lang=            当前阶段、加成、光环、觉醒技能、下一阶段条件与材料满足情况
 *   POST /pokemon/:id/awakening/awaken           觉醒下一阶段（扣材料、按权重抽潜能、同步 CP）
 *   POST /pokemon/:id/awakening/reroll           重洗某阶段潜能 { stage }（消耗递增）
 * 战斗档案：
 *   GET  /pokemon/:id/battle-profile             合成觉醒/特训/疲劳/羁绊技能/熟练度后的战斗属性
 * 成长商店：
 *   GET  /pokemon/growth-shop/items?category=    成长类道具（价格、是否在售、持有数量）
 *   POST /pokemon/growth-shop/buy                金币购买 { itemId, quantity }
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const awakening = require('../awakeningService');
const battleProfile = require('../growth/battleProfile');
const shop = require('../growth/shop');
const { route, ok, uuidOnly } = require('../growth/common');

const router = express.Router();
const uid = (req) => req.user.sub;
const langOf = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];

router.get('/awakening/potentials', requireAuth, route(async (req, res) => ok(res, await awakening.potentials({ lang: langOf(req) }))));
router.get('/growth-shop/items', requireAuth, route(async (req, res) => ok(res, await shop.list(uid(req), req.query))));
router.post('/growth-shop/buy', requireAuth, route(async (req, res) => ok(res, await shop.buy(uid(req), req.body || {}), '购买成功')));

router.get('/:id/awakening', uuidOnly, requireAuth, route(async (req, res) => ok(res, await awakening.getStatus(req.params.id, uid(req), { lang: langOf(req) }))));
router.post('/:id/awakening/awaken', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await awakening.awaken(req.params.id, uid(req), { lang: langOf(req) }), '觉醒成功！')));
router.post('/:id/awakening/reroll', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await awakening.reroll(req.params.id, uid(req), (req.body || {}).stage, { lang: langOf(req) }), '潜能已重洗')));
router.get('/:id/battle-profile', uuidOnly, requireAuth, route(async (req, res) => ok(res, await battleProfile.profile(req.params.id, uid(req)))));

module.exports = router;
