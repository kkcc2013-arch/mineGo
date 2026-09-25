/**
 * 精灵培育与孵化路由（REQ-00276，挂载在 /pokemon/breeding，经网关 /v1/pokemon/breeding/*，均需 JWT）
 *
 *   GET  /center                    培育屋：槽位、进行中的培育与进度、精灵蛋与孵化进度
 *   POST /check                     配对检查 { motherId, fatherId, useDestinyKnot? }：蛋组、后代物种、时间、费用、遗传概率
 *   POST /start                     开始培育 { motherId, fatherId, useDestinyKnot? }
 *   POST /pairs/:pairId/collect     培育完成领取精灵蛋
 *   POST /pairs/:pairId/cancel      取消培育（不退星尘）
 *   GET  /eggs                      我的精灵蛋
 *   POST /eggs/:eggId/incubate      放入孵化器 { incubator: basic | INCUBATOR_SUPER | INCUBATOR_ULTRA }
 *   POST /eggs/:eggId/hatch         行走距离达标后孵化
 *   GET  /lineage/:pokemonId        血统追踪（最多 5 代）
 *   GET  /stats                     培育统计
 *   POST /upgrade                   培育屋扩容（金币）
 * 原挂在网关未代理的 /breeding，且 /breeding/hatch/update 直接信任客户端上报的步数，已删除；孵化进度改按服务端累计行走距离。
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const breeding = require('../breedingService');
const { route, ok } = require('../growth/common');

const router = express.Router();
router.use(requireAuth);
const uid = (req) => req.user.sub;

router.get('/center', route(async (req, res) => ok(res, await breeding.getCenter(uid(req)))));
router.post('/check', route(async (req, res) => ok(res, await breeding.check(uid(req), req.body || {}))));
router.post('/start', route(async (req, res) => ok(res, await breeding.start(uid(req), req.body || {}), '开始培育')));
router.post('/pairs/:pairId/collect', route(async (req, res) => ok(res, await breeding.collect(uid(req), req.params.pairId), '获得精灵蛋')));
router.post('/pairs/:pairId/cancel', route(async (req, res) => ok(res, await breeding.cancel(uid(req), req.params.pairId), '已取消培育')));
router.get('/eggs', route(async (req, res) => ok(res, await breeding.eggs(uid(req)))));
router.post('/eggs/:eggId/incubate', route(async (req, res) => ok(res, await breeding.incubate(uid(req), req.params.eggId, req.body || {}), '开始孵化')));
router.post('/eggs/:eggId/hatch', route(async (req, res) => ok(res, await breeding.hatch(uid(req), req.params.eggId), '孵化成功！')));
router.get('/lineage/:pokemonId', route(async (req, res) => ok(res, await breeding.lineage(uid(req), req.params.pokemonId, req.query))));
router.get('/stats', route(async (req, res) => ok(res, await breeding.stats(uid(req)))));
router.post('/upgrade', route(async (req, res) => ok(res, await breeding.upgrade(uid(req)), '培育屋已扩容')));

module.exports = router;
