/**
 * 精灵体力路由（REQ-00172，挂载在 /pokemon，经网关 /v1/pokemon/*，均需 JWT）
 *
 *   GET  /pokemon/stamina/config                 活动消耗、恢复道具、疲劳等级
 *   POST /pokemon/stamina/batch                  批量查询 { pokemonIds: [...] }（≤200）
 *   GET  /pokemon/stamina/rest-stations?lat&lng&radius   附近休息站
 *   GET  /pokemon/:id/stamina                    当前体力（惰性换算自然恢复）、疲劳等级与效果、休息状态
 *   GET  /pokemon/:id/stamina/history            体力变化记录
 *   POST /pokemon/:id/stamina/consume            消耗体力 { activityType }（战斗等活动由对应服务调用）
 *   POST /pokemon/:id/stamina/use-item           使用恢复道具 { itemId }（有冷却）
 *   POST /pokemon/:id/stamina/rest               在休息站休息 { stationId }（需在 100 米内）
 *   POST /pokemon/:id/stamina/rest/end           结束休息并结算额外恢复
 * 原路由挂 /pokemon/config、/pokemon/items 等过于宽泛的路径且服务层 500，已整体替换。
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const stamina = require('../staminaService');
const { route, ok, uuidOnly } = require('../growth/common');

const router = express.Router();
const uid = (req) => req.user.sub;

router.get('/stamina/config', requireAuth, route(async (req, res) => ok(res, await stamina.config())));
router.post('/stamina/batch', requireAuth, route(async (req, res) => ok(res, await stamina.getBatch((req.body || {}).pokemonIds, uid(req)))));
router.get('/stamina/rest-stations', requireAuth, route(async (req, res) =>
  ok(res, await stamina.nearbyStations(req.query.lat, req.query.lng, req.query.radius))));

router.get('/:id/stamina', uuidOnly, requireAuth, route(async (req, res) => ok(res, await stamina.getStatus(req.params.id, uid(req)))));
router.get('/:id/stamina/history', uuidOnly, requireAuth, route(async (req, res) => ok(res, await stamina.history(req.params.id, uid(req), req.query))));
router.post('/:id/stamina/consume', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await stamina.consume(req.params.id, uid(req), (req.body || {}).activityType))));
router.post('/:id/stamina/use-item', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await stamina.useItem(req.params.id, uid(req), (req.body || {}).itemId), '体力已恢复')));
router.post('/:id/stamina/rest', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await stamina.startRest(req.params.id, uid(req), (req.body || {}).stationId), '开始休息')));
router.post('/:id/stamina/rest/end', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await stamina.endRest(req.params.id, uid(req)), '休息结束')));

module.exports = router;
