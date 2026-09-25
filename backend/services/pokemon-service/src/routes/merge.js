/**
 * 精灵合并进化路由（REQ-00390，挂载在 /pokemon/merge，经网关 /v1/pokemon/merge/*，均需 JWT）
 *
 *   GET  /recipes?lang=       合并配方（多语言、解锁条件、玩家当前是否凑得齐）
 *   POST /preview             合并预览 { recipeId, pokemonIds, useLuckyCharm? }：校验、成功率构成、消耗清单
 *   POST /execute             执行合并 { recipeId, pokemonIds, useLuckyCharm? }：成功产出（可能变异），失败同样消耗精灵
 *   GET  /history             合并历史
 *   GET  /stats               合并统计
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const merge = require('../mergeService');
const { route, ok } = require('../growth/common');

const router = express.Router();
router.use(requireAuth);
const uid = (req) => req.user.sub;
const langOf = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];

router.get('/recipes', route(async (req, res) => ok(res, await merge.recipes(uid(req), { lang: langOf(req) }))));
router.post('/preview', route(async (req, res) => ok(res, await merge.preview(uid(req), { ...(req.body || {}), lang: langOf(req) }))));
router.post('/execute', route(async (req, res) => {
  const r = await merge.execute(uid(req), { ...(req.body || {}), lang: langOf(req) });
  ok(res, r, r.success ? (r.isVariant ? '合并成功，发生了稀有变异！' : '合并成功！') : '合并失败，参与的精灵已消耗');
}));
router.get('/history', route(async (req, res) => ok(res, await merge.history(uid(req), req.query))));
router.get('/stats', route(async (req, res) => ok(res, await merge.stats(uid(req)))));

module.exports = router;
