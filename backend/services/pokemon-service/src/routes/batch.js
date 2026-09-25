/**
 * 精灵详情批量查询 API
 * REQ-00145 → REQ-00350 重写：
 *   原实现查询了不存在的列（pi.level/pi.hp/pi.shiny…，每次 500），且 Redis 缓存键未按用户隔离
 *   （任何人可按 id 读到别人缓存的精灵详情）。现由 PokemonBatchService 实现：按用户隔离的缓存、
 *   include 动态聚合、部分失败降级、单连接查询、Prometheus 指标。
 *
 * POST /pokemon/batch/details   { ids: uuid[<=100], include?: ['skills','equipment','effects','battle','history'],
 *                                 options?: { cacheStrategy?: 'prefer'|'bypass'|'only', timeout?: ms } }
 * GET  /pokemon/batch/metrics   预取准确率 / 请求合并统计（管理员）
 */
'use strict';

const express = require('express');
const { query, getClient } = require('../../../../shared/db');
const { getRedis } = require('../../../../shared/redis');
const { createLogger } = require('../../../../shared/logger');
const { requireAuth } = require('../../../../shared/auth');
const metrics = require('../../../../shared/metrics');
const { PokemonBatchService } = require('../services/PokemonBatchService');

const logger = createLogger('pokemon-batch');
const router = express.Router();

let service = null;
function getService() {
  if (!service) {
    let redis = null;
    try { redis = getRedis(); } catch { redis = null; }
    service = new PokemonBatchService({ query, getClient, redis, logger, register: metrics.register });
  }
  return service;
}

router.post('/details', requireAuth, express.json({ limit: '64kb' }), async (req, res, next) => {
  try {
    const { ids, include = [], options = {} } = req.body || {};
    const userId = req.user.sub || req.user.id;
    const out = await getService().getBatchDetails(ids, {
      userId,
      include,
      cacheStrategy: options.cacheStrategy || 'prefer',
      timeout: options.timeout || 5000,
    });
    res.json({ success: true, code: 0, message: 'ok', data: out });
  } catch (err) {
    next(err);
  }
});

router.get('/metrics', requireAuth, async (req, res, next) => {
  try {
    if (!(req.user.roles || []).includes('admin')) return res.status(403).json({ success: false, code: 1004, message: '权限不足' });
    return res.json({ success: true, code: 0, message: 'ok', data: await getService().prefetchStats() });
  } catch (err) {
    return next(err);
  }
});

router.getService = getService;
module.exports = router;
