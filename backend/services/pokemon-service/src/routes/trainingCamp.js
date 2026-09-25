/**
 * 训练营路由（REQ-00370，挂载在 /pokemon/training-camp，经网关 /v1/pokemon/training-camp/*，均需 JWT）
 *
 *   GET  /camps                         我的训练营（自动开通三类）：等级、容量、进行中的训练与进度、升级费用
 *   GET  /camps/:campId/courses         课程（时长、费用、解锁等级、预期奖励）
 *   POST /camps/:campId/upgrade         升级训练营（金币，扩容）
 *   POST /start                         开始训练 { campId, courseId, pokemonId, slotIndex? }
 *   GET  /slots/:slotId                 训练进度（精确到分钟）
 *   POST /slots/:slotId/boost           使用加速道具 { itemId: TRAINING_TIMER_HALF | TRAINING_TIMER_INSTANT | TRAINING_EXP_DOUBLE }
 *   POST /slots/:slotId/complete        领取奖励（经验/亲密度/技能）
 *   POST /slots/:slotId/cancel          取消训练（费用不退）
 *   GET  /history                       训练报告
 * 原挂在 /training（网关未代理，外部不可达），且 /training/admin/process-completed 任何登录用户都能触发，已改为服务内定时任务。
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const camp = require('../trainingCampService');
const { route, ok } = require('../growth/common');

const router = express.Router();
router.use(requireAuth);
const uid = (req) => req.user.sub;

router.get('/camps', route(async (req, res) => ok(res, await camp.getCamps(uid(req)))));
router.get('/camps/:campId/courses', route(async (req, res) => ok(res, await camp.getCourses(uid(req), req.params.campId))));
router.post('/camps/:campId/upgrade', route(async (req, res) => ok(res, await camp.upgrade(uid(req), req.params.campId), '训练营已升级')));
router.post('/start', route(async (req, res) => ok(res, await camp.start(uid(req), req.body || {}), '开始训练')));
router.get('/slots/:slotId', route(async (req, res) => ok(res, await camp.getSlot(uid(req), req.params.slotId))));
router.post('/slots/:slotId/boost', route(async (req, res) => ok(res, await camp.boost(uid(req), req.params.slotId, (req.body || {}).itemId))));
router.post('/slots/:slotId/complete', route(async (req, res) => ok(res, await camp.complete(uid(req), req.params.slotId), '训练完成')));
router.post('/slots/:slotId/cancel', route(async (req, res) => ok(res, await camp.cancel(uid(req), req.params.slotId), '已取消训练')));
router.get('/history', route(async (req, res) => ok(res, await camp.history(uid(req), req.query))));

module.exports = router;
