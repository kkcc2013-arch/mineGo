/**
 * REQ-00498: 精灵搜索 API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth, successResp, AppError } = require('../../../shared/auth');
const pokemonSearchService = require('../../../shared/pokemonSearchService');
const metrics = require('../../../shared/metrics');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('pokemon-search-routes');

/**
 * GET /pokemon/search
 * 精灵搜索（模糊匹配、类型筛选、CP范围筛选）
 */
router.get('/search', requireAuth, async (req, res, next) => {
  const startTime = Date.now();
  const { term, types, minCp, maxCp, limit, sort } = req.query;
  const userId = req.user.id;

  try {
    // 参数验证
    const limitNum = Math.min(parseInt(limit) || 50, 100);
    const typesArr = types ? types.split(',').map(t => t.trim()) : null;
    const minCpNum = minCp ? parseInt(minCp) : null;
    const maxCpNum = maxCp ? parseInt(maxCp) : null;

    // 执行搜索
    const pokemon = await pokemonSearchService.search(userId, term || '', {
      limit: limitNum,
      types: typesArr,
      minCp: minCpNum,
      maxCp: maxCpNum,
      sort: sort || 'cp'
    });

    const latency = Date.now() - startTime;
    pokemonSearchService.checkSlowQuery(latency, 'search');

    // 记录指标
    metrics.histogramTimer('pokemon_search_latency_ms', latency);

    logger.info({
      userId,
      term: term || '',
      hasFilter: !!(typesArr || minCpNum || maxCpNum),
      count: pokemon.length,
      latencyMs: latency
    }, 'Search completed');

    res.json(successResp({
      pokemon,
      count: pokemon.length,
      query: { term, types: typesArr, minCp: minCpNum, maxCp: maxCpNum },
      latencyMs: latency
    }));
  } catch (error) {
    logger.error({ error, userId, term }, 'Search failed');
    next(new AppError('Search failed', 500));
  }
});

/**
 * GET /pokemon
 * 精灵列表（分页、筛选、排序）
 */
router.get('/', requireAuth, async (req, res, next) => {
  const startTime = Date.now();
  const { page, pageSize, sort, type, minCp, maxCp } = req.query;
  const userId = req.user.id;

  try {
    // 参数验证
    const pageNum = Math.max(0, parseInt(page) || 0);
    const pageSizeNum = Math.min(parseInt(pageSize) || 20, 50);

    const result = await pokemonSearchService.getList(userId, {
      page: pageNum,
      pageSize: pageSizeNum,
      sort: sort || 'cp',
      type: type || null,
      minCp: minCp ? parseInt(minCp) : null,
      maxCp: maxCp ? parseInt(maxCp) : null
    });

    const latency = Date.now() - startTime;
    pokemonSearchService.checkSlowQuery(latency, 'list');

    metrics.histogramTimer('pokemon_list_latency_ms', latency);

    logger.debug({
      userId,
      sort: sort || 'cp',
      page: pageNum,
      cached: result.cached,
      total: result.total,
      latencyMs: latency
    }, 'List retrieved');

    res.json(successResp(result));
  } catch (error) {
    logger.error({ error, userId }, 'List query failed');
    next(new AppError('List query failed', 500));
  }
});

/**
 * GET /pokemon/stats
 * 精灵统计
 */
router.get('/stats', requireAuth, async (req, res, next) => {
  const userId = req.user.id;

  try {
    const stats = await pokemonSearchService.getStats(userId);
    
    logger.debug({ userId, stats }, 'Stats retrieved');
    
    res.json(successResp(stats));
  } catch (error) {
    logger.error({ error, userId }, 'Stats query failed');
    next(new AppError('Stats query failed', 500));
  }
});

/**
 * GET /pokemon/types
 * 获取用户精灵类型分布
 */
router.get('/types', requireAuth, async (req, res, next) => {
  const userId = req.user.id;

  try {
    const stats = await pokemonSearchService.getStats(userId);
    
    res.json(successResp({
      typeDistribution: stats.typeStats || [],
      totalPokemon: stats.total_pokemon || 0
    }));
  } catch (error) {
    logger.error({ error, userId }, 'Type stats query failed');
    next(new AppError('Type stats query failed', 500));
  }
});

/**
 * POST /pokemon/cache/invalidate
 * 失效用户精灵缓存（内部接口）
 */
router.post('/cache/invalidate', requireAuth, async (req, res, next) => {
  const userId = req.user.id;
  const { reason } = req.body;

  try {
    const deleted = await pokemonSearchService.invalidateUserCache(userId, reason || 'manual');
    
    logger.info({ userId, reason, deleted }, 'Cache invalidated');
    
    res.json(successResp({
      deletedKeys: deleted,
      userId,
      reason: reason || 'manual'
    }));
  } catch (error) {
    logger.error({ error, userId }, 'Cache invalidation failed');
    next(new AppError('Cache invalidation failed', 500));
  }
});

/**
 * GET /pokemon/cache/stats
 * 获取缓存命中率统计
 */
router.get('/cache/stats', requireAuth, async (req, res, next) => {
  try {
    const hitRate = await pokemonSearchService.cache.getCacheHitRate();
    
    res.json(successResp(hitRate));
  } catch (error) {
    logger.error({ error }, 'Cache stats query failed');
    next(new AppError('Cache stats query failed', 500));
  }
});

module.exports = router;