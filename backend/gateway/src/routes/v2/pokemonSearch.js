/**
 * REQ-00498: 精灵搜索 v2 路由
 * 支持模糊搜索、类型筛选、CP范围筛选
 */

'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('pokemon-search-v2');
const router = express.Router();

const POKEMON_SERVICE_URL = process.env.POKEMON_SERVICE_URL || 'http://pokemon-service:8083';

/**
 * GET /pokemon/search
 * 精灵搜索（模糊匹配、类型筛选、CP范围筛选）
 * Query params:
 * - term: 搜索词（精灵名称）
 * - types: 类型筛选（逗号分隔）
 * - minCp: 最小 CP
 * - maxCp: 最大 CP
 * - limit: 返回数量限制
 * - sort: 排序方式
 */
router.get('/search',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/search': '/search' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
        proxyReq.setHeader('X-Request-ID', req.headers['x-request-id'] || '');
        proxyReq.setHeader('X-User-ID', req.user?.id || '');
        
        logger.info({
          path: req.path,
          query: req.query,
          userId: req.user?.id
        }, 'Pokemon search request');
      },
      proxyRes: (proxyRes, req) => {
        logger.debug({
          statusCode: proxyRes.statusCode,
          path: req.path
        }, 'Pokemon search response');
      }
    }
  })
);

/**
 * GET /pokemon/stats
 * 精灵统计（总数、高CP数量、传说数量、类型分布）
 */
router.get('/stats',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/stats': '/stats' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
      }
    }
  })
);

/**
 * GET /pokemon/types
 * 类型分布统计
 */
router.get('/types',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/types': '/types' }
  })
);

/**
 * POST /pokemon/cache/invalidate
 * 失效用户精灵缓存（内部接口）
 */
router.post('/cache/invalidate',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/cache/invalidate': '/cache/invalidate' }
  })
);

/**
 * GET /pokemon/cache/stats
 * 缓存命中率统计
 */
router.get('/cache/stats',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/cache/stats': '/cache/stats' }
  })
);

module.exports = router;