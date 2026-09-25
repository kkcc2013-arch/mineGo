/**
 * 精灵经验与成长轨迹路由（挂载在 /pokemon，经网关 /v1/pokemon/*，均需 JWT）
 *
 * REQ-00216 经验动态调整：
 *   GET  /pokemon/experience/boosts               当前生效的经验加成与综合倍率（活动/幸运蛋/经验卡/VIP/公会）
 *   POST /pokemon/experience/boosts               使用加成道具 { itemId: LUCKY_EGG | EXP_CARD_24H | EXP_CARD_PERMANENT }
 *   GET  /pokemon/experience/stats?period=day|week|month   本人经验日/周/月统计（每日序列 + 来源占比）
 *   POST /pokemon/:id/experience/use-item         使用经验糖果 { itemId: EXP_CANDY_S|M|L, quantity }
 *   POST /pokemon/:id/experience/transfer         经验转移 { targetPokemonId, amount }（目标获得 80%）
 * REQ-00230 经验历史与成长轨迹：
 *   GET  /pokemon/:id/growth                      等级/经验/升级进度概要（/pokemon/:id/stats 为兼容别名）
 *   GET  /pokemon/:id/exp-history?limit&before    经验获取记录（游标分页）
 *   GET  /pokemon/:id/growth/trajectory?days=30   每日经验与累计经验曲线 + 期间里程碑
 *   GET  /pokemon/:id/growth/sources?days=        经验来源占比
 *   GET  /pokemon/:id/growth/milestones           成长里程碑
 *   GET  /pokemon/:id/growth/prediction           升级/等级进化预测与置信度
 *   GET  /pokemon/:id/growth/report?period=week|month   周期成长报告
 * :id 只匹配 UUID（见 growth/common.js 的 ID），不会吞掉 /pokemon/release/stats 等其他模块路径。
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const tracker = require('../growth/growthTracker');
const { route, ok, ID } = require('../growth/common');

const router = express.Router();
const uid = (req) => req.user.sub;

router.get('/experience/boosts', requireAuth, route(async (req, res) => ok(res, await tracker.activeBoosts(uid(req)))));
router.post('/experience/boosts', requireAuth, route(async (req, res) => ok(res, await tracker.activateBoost(uid(req), req.body || {}), '经验加成已生效')));
router.get('/experience/stats', requireAuth, route(async (req, res) => ok(res, await tracker.userStats(uid(req), req.query))));

router.post(`/${ID}/experience/use-item`, requireAuth, route(async (req, res) => ok(res, await tracker.useExpItem(req.params.id, uid(req), req.body || {}))));
router.post(`/${ID}/experience/transfer`, requireAuth, route(async (req, res) => ok(res, await tracker.transfer(req.params.id, uid(req), req.body || {}))));

router.get(`/${ID}/growth`, requireAuth, route(async (req, res) => ok(res, await tracker.summary(req.params.id, uid(req)))));
router.get(`/${ID}/stats`, requireAuth, route(async (req, res) => ok(res, await tracker.summary(req.params.id, uid(req)))));
router.get(`/${ID}/exp-history`, requireAuth, route(async (req, res) => ok(res, await tracker.history(req.params.id, uid(req), req.query))));
router.get(`/${ID}/growth/trajectory`, requireAuth, route(async (req, res) => ok(res, await tracker.trajectory(req.params.id, uid(req), req.query))));
router.get(`/${ID}/growth/sources`, requireAuth, route(async (req, res) => ok(res, await tracker.sources(req.params.id, uid(req), req.query))));
router.get(`/${ID}/growth/milestones`, requireAuth, route(async (req, res) => ok(res, await tracker.milestones(req.params.id, uid(req)))));
router.get(`/${ID}/growth/prediction`, requireAuth, route(async (req, res) => ok(res, await tracker.prediction(req.params.id, uid(req)))));
router.get(`/${ID}/growth/report`, requireAuth, route(async (req, res) => ok(res, await tracker.report(req.params.id, uid(req), req.query))));

module.exports = router;
