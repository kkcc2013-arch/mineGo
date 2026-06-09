// backend/gateway/src/routes/v2/users.js
// REQ-00044: v2 版本用户路由 - 增强统计字段
'use strict';

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { createLogger } = require('@pmg/shared/logger');

const logger = createLogger('users-v2');
const router = express.Router();

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:8081';

/**
 * v2 新特性:
 * - profile: 响应增加 stats 字段
 * - 响应增加 achievements 字段
 * - 响应增加 lastActiveAt 字段
 */

// 用户资料 - 增强统计字段
router.get('/:id/profile',
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/users/' },
    on: {
      proxyReq: (proxyReq, req) => {
        // v2 请求增强统计
        proxyReq.setHeader('X-API-Version', '2');
        proxyReq.setHeader('X-Include-Stats', 'true');
        proxyReq.setHeader('X-Include-Achievements', 'true');
        
        logger.debug({
          path: req.path,
          version: 2,
        }, 'v2 user profile request');
      },
    },
  })
);

// 用户统计 - 新端点
router.get('/:id/stats',
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/users/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
      },
    },
  })
);

// 用户成就 - 新端点
router.get('/:id/achievements',
  createProxyMiddleware({
    target: USER_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/': '/users/' },
    on: {
      proxyReq: (proxyReq, req) => {
        proxyReq.setHeader('X-API-Version', '2');
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
