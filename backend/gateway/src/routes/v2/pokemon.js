// backend/gateway/src/routes/v2/pokemon.js
// REQ-00044: v2 版本精灵路由 - 增加技能字段
'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('pokemon-v2');
const router = express.Router();

const POKEMON_SERVICE_URL = process.env.POKEMON_SERVICE_URL || 'http://localhost:8083';

/**
 * v2 新特性:
 * - pokemon: 响应增加 moves 字段（已学技能）
 * - pokemon: 响应增加 potentialMoves 字段（可学技能）
 * - pokemon: 响应增加 iv 字段（个体值）
 */

// 用户精灵列表 - 增加技能信息
router.get('/',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/pokemon/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
        proxyReq.setHeader('X-Include-Moves', 'true');
        proxyReq.setHeader('X-Include-IV', 'true');
        
        logger.debug({
          path: req.path,
          version: 2,
        }, 'v2 pokemon list request');
      },
    },
  })
);

// 精灵详情 - 增加完整信息
router.get('/:id',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/pokemon/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
        proxyReq.setHeader('X-Include-Moves', 'true');
        proxyReq.setHeader('X-Include-IV', 'true');
        proxyReq.setHeader('X-Include-Potential-Moves', 'true');
      },
    },
  })
);

// 精灵图鉴 - 增加技能池信息
router.get('/pokedex',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/pokemon/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
        proxyReq.setHeader('X-Include-Move-Pool', 'true');
      },
    },
  })
);

// 学习技能 - 新端点
router.post('/:id/learn-move',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/pokemon/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
      },
    },
  })
);

// 遗忘技能 - 新端点
router.delete('/:id/moves/:moveId',
  createProxyMiddleware({
    target: POKEMON_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/pokemon/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
      },
    },
  })
);

module.exports = router;
