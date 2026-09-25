/**
 * 精灵专项特训路由（REQ-00612，挂载在 /pokemon，经网关 /v1/pokemon/*，均需 JWT）
 *
 *   GET  /pokemon/special-training/facilities           训练场地（解锁条件、加成、费用）
 *   GET  /pokemon/special-training/queue                训练队列（已用/上限、每日次数、剩余时间）
 *   GET  /pokemon/special-training/items                训练道具与持有数量
 *   POST /pokemon/special-training/items/buy            商店购买 { itemId, quantity }（金币）
 *   POST /pokemon/special-training/items/use            使用加速道具 { itemId, trainingId }
 *   GET  /pokemon/special-training/achievements         训练成就
 *   GET  /pokemon/:id/training                          属性等级/熟练度/当前训练/历史
 *   POST /pokemon/:id/training/start                    开始特训 { trainingType, facilityId?, useGoldenApple?, useAccelerator? }
 *   POST /pokemon/:id/training/:trainingId/complete     完成特训（属性提升、成就发放）
 *   POST /pokemon/:id/training/:trainingId/cancel       取消（不退还）
 *   POST /pokemon/:id/skill/:skillId/train              技能熟练度训练 { dimension: power|accuracy|critical_chance, useManual? }
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const st = require('../specialTrainingService');
const { route, ok, uuidOnly } = require('../growth/common');

const router = express.Router();
const uid = (req) => req.user.sub;

router.get('/special-training/facilities', requireAuth, route(async (req, res) => ok(res, await st.facilities(uid(req)))));
router.get('/special-training/queue', requireAuth, route(async (req, res) => ok(res, await st.queue(uid(req)))));
router.get('/special-training/items', requireAuth, route(async (req, res) => ok(res, await st.items(uid(req)))));
router.post('/special-training/items/buy', requireAuth, route(async (req, res) => ok(res, await st.buy(uid(req), req.body || {}), '购买成功')));
router.post('/special-training/items/use', requireAuth, route(async (req, res) => ok(res, await st.useItem(uid(req), req.body || {}))));
router.get('/special-training/achievements', requireAuth, route(async (req, res) => ok(res, await st.achievements(uid(req)))));

router.get('/:id/training', uuidOnly, requireAuth, route(async (req, res) => ok(res, await st.status(req.params.id, uid(req)))));
router.post('/:id/training/start', uuidOnly, requireAuth, route(async (req, res) => ok(res, await st.start(req.params.id, uid(req), req.body || {}), '开始特训')));
router.post('/:id/training/:trainingId/complete', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await st.complete(req.params.id, req.params.trainingId, uid(req)), '特训完成')));
router.post('/:id/training/:trainingId/cancel', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await st.cancel(req.params.id, req.params.trainingId, uid(req)), '已取消特训')));
router.post('/:id/skill/:skillId/train', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await st.trainSkill(req.params.id, req.params.skillId, uid(req), req.body || {}))));

module.exports = router;
