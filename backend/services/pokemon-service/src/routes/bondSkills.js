/**
 * 羁绊技能路由（REQ-00151，挂载在 /）
 *
 *   GET    /pokemon-species/:speciesId/bond-skills/available     某物种的羁绊技能（公开，服务直连；网关未暴露 /v1/pokemon-species）
 *   GET    /pokemon/species/:speciesId/bond-skills               同上，经网关 /v1/pokemon/species/:id/bond-skills（需登录）
 *   GET    /pokemon/bond-skills/stats                            本人羁绊技能统计（/bond-skills/stats 为旧路径）
 *   GET    /pokemon/:id/bond-skills                              精灵的羁绊技能：解锁/学习/激活状态、当前威力
 *   POST   /pokemon/:id/bond-skills/:skillId/learn               学习（羁绊等级达标、槽位空闲）
 *   DELETE /pokemon/:id/bond-skills/:skillId                     遗忘（可重新学习）
 *   POST   /pokemon/:id/bond-skills/:skillId/activate            激活（最多 1 个，用于战斗）
 *   POST   /pokemon/:id/bond-skills/:skillId/use                 战斗中使用 { battleId? }：扣 PP，返回按亲密度计算的威力/效果
 *   GET    /pokemon/:id/bond-skills/:skillId/effect              按精灵真实亲密度计算效果（不扣 PP）
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const bond = require('../bondSkillService');
const { route, ok, uuidOnly } = require('../growth/common');

const router = express.Router();
const uid = (req) => req.user.sub;

router.get('/pokemon-species/:speciesId/bond-skills/available', route(async (req, res) => ok(res, await bond.available(req.params.speciesId))));
router.get('/pokemon/species/:speciesId/bond-skills', requireAuth, route(async (req, res) => ok(res, await bond.available(req.params.speciesId))));
router.get('/pokemon/bond-skills/stats', requireAuth, route(async (req, res) => ok(res, await bond.stats(uid(req)))));
router.get('/bond-skills/stats', requireAuth, route(async (req, res) => ok(res, await bond.stats(uid(req)))));

router.get('/pokemon/:id/bond-skills', uuidOnly, requireAuth, route(async (req, res) => ok(res, await bond.getPokemonBondSkills(req.params.id, uid(req)))));
router.post('/pokemon/:id/bond-skills/:skillId/learn', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await bond.learn(req.params.id, req.params.skillId, uid(req)), '学会了羁绊技能')));
router.delete('/pokemon/:id/bond-skills/:skillId', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await bond.forget(req.params.id, req.params.skillId, uid(req)), '已遗忘羁绊技能')));
router.post('/pokemon/:id/bond-skills/:skillId/activate', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await bond.activate(req.params.id, req.params.skillId, uid(req)), '羁绊技能已激活')));
router.post('/pokemon/:id/bond-skills/:skillId/use', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await bond.use(req.params.id, req.params.skillId, uid(req), req.body || {}))));
router.get('/pokemon/:id/bond-skills/:skillId/effect', uuidOnly, requireAuth, route(async (req, res) =>
  ok(res, await bond.effectOf(req.params.id, req.params.skillId, uid(req)))));

module.exports = router;
