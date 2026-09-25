/**
 * 精灵传承路由（REQ-00361，挂载在 /pokemon，经网关 /v1/pokemon/*，均需 JWT）
 *
 *   POST /pokemon/:id/release-with-inheritance   放生并传承 { inherit = true, inheritanceItem? }（扩展 REQ-00240 放生）
 *   GET  /pokemon/inheritance/pool               我的传承池（含衰减后的当前加成）
 *   GET  /pokemon/inheritance/pool/:speciesId    某物种（按家族）的传承池
 *   GET  /pokemon/inheritance/records            传承记录（捕捉时自动继承产生）
 *   GET  /pokemon/inheritance/stats              传承统计
 *   POST /pokemon/inheritance/use-item           对已有传承池使用传承石 { speciesId, itemId }
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const inh = require('../inheritanceService');
const { route, ok, ID } = require('../growth/common');

const router = express.Router();
const uid = (req) => req.user.sub;

router.get('/inheritance/pool', requireAuth, route(async (req, res) => ok(res, await inh.pools(uid(req)))));
router.get('/inheritance/pool/:speciesId', requireAuth, route(async (req, res) => ok(res, await inh.poolFor(uid(req), req.params.speciesId))));
router.get('/inheritance/records', requireAuth, route(async (req, res) => ok(res, await inh.records(uid(req), req.query))));
router.get('/inheritance/stats', requireAuth, route(async (req, res) => ok(res, await inh.stats(uid(req)))));
router.post('/inheritance/use-item', requireAuth, route(async (req, res) => ok(res, await inh.useItem(uid(req), req.body || {}), '传承石已使用')));
router.post(`/${ID}/release-with-inheritance`, requireAuth, route(async (req, res) =>
  ok(res, await inh.releaseWithInheritance(req.params.id, uid(req), req.body || {}), '放生成功')));

module.exports = router;
