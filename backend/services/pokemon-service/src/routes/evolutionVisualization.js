/**
 * 进化路径可视化路由（REQ-00355，挂载在 /pokemon，经网关 /v1/pokemon/*）
 *
 *   GET  /pokemon/species/:speciesId/evolution-chain?lang=zh|en|ja   家族进化树（节点/边/布局/多语言条件/隐藏路径提示）
 *   GET  /pokemon/species/:speciesId/pre-evolutions                  反向追溯前身链
 *   POST /pokemon/batch-evolution-chains { speciesIds: [...] }       批量进化树（≤20）
 *   GET  /pokemon/evolution-types?lang=                              支持的进化类型
 *   GET  /pokemon/:id/evolution-preview/:targetSpeciesId             精灵进化前后属性对比（需登录）
 *   GET  /pokemon/my/:id/evolution-preview?targetSpeciesId=          同上（兼容旧路径）
 *   GET  /pokemon/:id/recommended-evolution                          推荐进化路径（需登录）
 *   POST /pokemon/evolve { pokemonId, targetSpeciesId }              执行进化（委托 evolutionService）
 * 进化树接口在服务内是可选登录：带 token 时按玩家图鉴显示已发现的隐藏路径（经网关访问必带 token）。
 */
'use strict';

const express = require('express');
const { requireAuth, optionalAuth } = require('../../../../shared/auth');
const viz = require('../evolutionVisualizationService');
const evolutionService = require('../evolutionService');
const { route, ok, uuidOnly } = require('../growth/common');

const router = express.Router();
const langOf = (req) => req.query.lang || req.headers['x-language'] || req.headers['accept-language'];

router.get('/species/:speciesId/evolution-chain', optionalAuth, route(async (req, res) =>
  ok(res, await viz.getChain(req.params.speciesId, { userId: req.user && req.user.sub, lang: langOf(req) }))));
router.get('/species/:speciesId/pre-evolutions', route(async (req, res) => ok(res, await viz.getPreEvolutions(req.params.speciesId))));
router.post('/batch-evolution-chains', optionalAuth, route(async (req, res) =>
  ok(res, await viz.getChains((req.body || {}).speciesIds, { userId: req.user && req.user.sub, lang: langOf(req) }))));
router.get('/evolution-types', route(async (req, res) => ok(res, viz.evolutionTypes(langOf(req)))));

router.get('/:id/evolution-preview/:targetSpeciesId', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await viz.getPreview(req.params.id, req.user.sub, req.params.targetSpeciesId))));
router.get('/my/:id/evolution-preview', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await viz.getPreview(req.params.id, req.user.sub, req.query.targetSpeciesId))));
router.get('/:id/recommended-evolution', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await viz.getRecommended(req.params.id, req.user.sub))));
router.post('/evolve', requireAuth, route(async (req, res) => {
  const body = req.body || {};
  ok(res, await evolutionService.evolve(body.pokemonId, req.user.sub, { targetSpeciesId: body.targetSpeciesId }), '进化成功！');
}));

module.exports = router;
