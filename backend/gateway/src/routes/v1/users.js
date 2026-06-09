// backend/gateway/src/routes/v1/users.js
// REQ-00044: v1 版本用户路由 - 基础功能
'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('users-v1');
const router = express.Router();

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:8081';

/**
 * v1 特性:
 * - 基础用户资料
 * - 不包含 stats 和 achievements 字段
 */

// 用户资料
router.get('/:id/profile',
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/users/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '1');
        
        logger.debug({
          path: req.path,
          version: 1,
        }, 'v1 user profile request');
      },
    },
  })
);

// 用户列表
router.get('/',
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/users/' },
  })
);

// 更新用户
router.patch('/:id',
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/users/' },
  })
);

module.exports = router;
