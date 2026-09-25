/**
 * 精灵进化路由（挂载在 /pokemon，经网关 /v1/pokemon/*，均需 JWT）
 *
 *   GET  /pokemon/:id/evolution/check      所有进化路径、条件满足情况、进化预览与推荐
 *   POST /pokemon/:id/evolution/execute    执行进化 { targetSpeciesId? }（多分支时必填）
 *   GET  /pokemon/evolution/history        本人进化历史（原 /evolution/history/:userId 可查任意用户，已收回）
 *   GET  /pokemon/evolution/items          进化道具及本人持有数量
 *
 * 实现见 ../evolutionService.js（唯一实现，index.js 的 /pokemon/my/:id/evolve 也委托它）。
 * 原 POST /:id/experience（任意加经验）与 POST /:id/friendship（任意加亲密度）是可刷数值的调试接口，已删除；
 * 经验改由 routes/growth.js 的道具/训练等正规来源发放。
 */
'use strict';

const express = require('express');
const { requireAuth } = require('../../../../shared/auth');
const { query } = require('../../../../shared/db');
const evolutionService = require('../evolutionService');
const { route, ok } = require('../growth/common');

const router = express.Router();

router.get('/evolution/history', requireAuth, route(async (req, res) => {
  ok(res, await evolutionService.getHistory(req.user.sub, req.query));
}));

router.get('/evolution/items', requireAuth, route(async (req, res) => {
  const { rows } = await query(
    `SELECT i.item_id AS "itemId", i.name_zh AS name, i.name_en AS "nameEn", i.description_zh AS description,
            COALESCE(pi.qty, 0)::int AS owned
       FROM items i
       LEFT JOIN (SELECT item_id, SUM(quantity) AS qty FROM player_inventory WHERE user_id = $1 GROUP BY item_id) pi
         ON pi.item_id = i.item_id
      WHERE i.category = 'evolution'
      ORDER BY i.item_id`, [req.user.sub]);
  ok(res, rows);
}));

router.get('/:id/evolution/check', requireAuth, route(async (req, res) => {
  ok(res, await evolutionService.checkEvolution(req.params.id, req.user.sub));
}));

router.post('/:id/evolution/execute', requireAuth, route(async (req, res) => {
  const body = req.body || {};
  const result = await evolutionService.evolve(req.params.id, req.user.sub, { targetSpeciesId: body.targetSpeciesId });
  ok(res, result, '进化成功！');
}));

module.exports = router;
