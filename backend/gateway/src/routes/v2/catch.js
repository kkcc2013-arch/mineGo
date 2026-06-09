// backend/gateway/src/routes/v2/catch.js
// REQ-00044: v2 版本捕捉路由 - 新增稀有度过滤
'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createLogger } = require('@pmg/shared/logger');
const { requireVersion } = require('../../middleware/apiVersion');

const logger = createLogger('catch-v2');
const router = express.Router();

const CATCH_SERVICE_URL = process.env.CATCH_SERVICE_URL || 'http://localhost:8084';

/**
 * v2 新特性:
 * - nearby: 新增 rarity 参数过滤稀有度
 * - 响应增加 moveTypes 字段
 */

// 附近精灵 - 新增稀有度过滤
router.get('/nearby', 
  createProxyMiddleware({
    target: CATCH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/catch/' },
    on: {
      proxyReq: (proxyReq, req) => {
        // v2 特有的稀有度过滤逻辑
        const rarity = req.query.rarity;
        if (rarity) {
          // 将稀有度参数传递给下游服务
          proxyReq.setHeader('X-Filter-Rarity', rarity);
        }
        
        // 标记 API 版本
        proxyReq.setHeader('X-API-Version', '2');
        
        logger.debug({
          path: req.path,
          rarity,
          version: 2,
        }, 'v2 catch nearby request');
      },
    },
  })
);

// 捕捉精灵 - 增强响应
router.post('/',
  createProxyMiddleware({
    target: CATCH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/catch/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
      },
    },
  })
);

// 捕捉历史
router.get('/history',
  createProxyMiddleware({
    target: CATCH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/catch/' },
  })
);

module.exports = router;
