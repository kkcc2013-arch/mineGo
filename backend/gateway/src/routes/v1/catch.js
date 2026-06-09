// backend/gateway/src/routes/v1/catch.js
// REQ-00044: v1 版本捕捉路由 - 保持兼容
'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('catch-v1');
const router = express.Router();

const CATCH_SERVICE_URL = process.env.CATCH_SERVICE_URL || 'http://localhost:8084';

/**
 * v1 特性:
 * - 基础功能
 * - 不包含稀有度过滤
 */

// 附近精灵
router.get('/nearby',
  createProxyMiddleware({
    target: CATCH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/catch/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '1');
        
        logger.debug({
          path: req.path,
          version: 1,
        }, 'v1 catch nearby request');
      },
    },
  })
);

// 捕捉精灵
router.post('/',
  createProxyMiddleware({
    target: CATCH_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/catch/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '1');
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
