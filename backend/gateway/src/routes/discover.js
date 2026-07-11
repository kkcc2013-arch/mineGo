/**
 * API 资源发现路由
 * REQ-00518: API 超媒体链接（HATEOAS）与资源发现系统
 * 
 * 提供资源发现端点，让客户端可以自动发现可用资源和操作
 */

'use strict';

const express = require('express');
const router = express.Router();
const ApiResponse = require('../../../shared/utils/ApiResponse');
const { defaultResourceDiscoverer } = require('../../../shared/utils/ResourceDiscoverer');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('discover-routes');

/**
 * GET /api/discover
 * 发现所有可用资源
 * 
 * 响应示例：
 * {
 *   "_links": {
 *     "self": { "href": "/api/discover" },
 *     "pokemon": { "href": "/api/v1/pokemon", "title": "Pokemon Collection" },
 *     "users": { "href": "/api/v1/users", "title": "User Collection" },
 *     ...
 *   },
 *   "_meta": {
 *     "api_version": "1.0.0",
 *     "documentation": "/api/docs",
 *     "server_time": "2026-07-11T08:00:00Z"
 *   }
 * }
 */
router.get('/', async (req, res) => {
  try {
    const discoveryResponse = await defaultResourceDiscoverer.discoverAll({
      apiVersion: process.env.API_VERSION || '1.0.0',
      skipCache: req.query.skipCache === 'true'
    });
    
    logger.info('Discovery request', {
      requestId: res.locals?.requestId,
      ip: req.ip
    });
    
    res.json(discoveryResponse);
  } catch (error) {
    logger.error('Discovery failed', {
      error: error.message,
      requestId: res.locals?.requestId
    });
    
    res.status(500).json({
      _links: {
        self: { href: '/api/discover' }
      },
      error: {
        code: 'DISCOVERY_ERROR',
        message: 'Failed to discover resources'
      }
    });
  }
});

/**
 * GET /api/discover/:resource
 * 发现单个资源的详细信息
 * 
 * 响应示例：
 * {
 *   "_links": {
 *     "self": { "href": "/api/v1/pokemon" },
 *     "catch": { "href": "/api/v1/pokemon/{id}/catch", "templated": true },
 *     ...
 *   },
 *   "name": "pokemon",
 *   "description": "Pokemon resources",
 *   "methods": ["GET", "POST", "PUT", "DELETE"],
 *   "actions": ["catch", "evolve", "battle", ...],
 *   "schema": { ... }
 * }
 */
router.get('/:resource', async (req, res) => {
  try {
    const { resource } = req.params;
    
    const resourceInfo = await defaultResourceDiscoverer.discoverResource(resource);
    
    if (!resourceInfo) {
      return res.status(404).json({
        _links: {
          self: { href: `/api/discover/${resource}` },
          parent: { href: '/api/discover' }
        },
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: `Resource '${resource}' not found`
        }
      });
    }
    
    logger.info('Resource discovery request', {
      resource,
      requestId: res.locals?.requestId
    });
    
    res.json(resourceInfo);
  } catch (error) {
    logger.error('Resource discovery failed', {
      error: error.message,
      requestId: res.locals?.requestId
    });
    
    res.status(500).json({
      _links: {
        self: { href: `/api/discover/${req.params.resource}` }
      },
      error: {
        code: 'DISCOVERY_ERROR',
        message: 'Failed to discover resource'
      }
    });
  }
});

/**
 * GET /api/discover/:resource/schema
 * 获取资源 Schema
 */
router.get('/:resource/schema', (req, res) => {
  try {
    const { resource } = req.params;
    
    const schema = defaultResourceDiscoverer.getResourceSchema(resource);
    
    if (!schema) {
      return res.status(404).json({
        error: {
          code: 'SCHEMA_NOT_FOUND',
          message: `Schema for resource '${resource}' not found`
        }
      });
    }
    
    res.json({
      _links: {
        self: { href: `/api/discover/${resource}/schema` },
        resource: { href: `/api/discover/${resource}` }
      },
      resource,
      schema,
      type: 'application/schema+json'
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'SCHEMA_ERROR',
        message: 'Failed to get resource schema'
      }
    });
  }
});

/**
 * GET /api/discover/:resource/actions
 * 获取资源可用操作
 */
router.get('/:resource/actions', (req, res) => {
  try {
    const { resource } = req.params;
    
    const actions = defaultResourceDiscoverer.getResourceActions(resource);
    const relationships = defaultResourceDiscoverer.getResourceRelationships(resource);
    
    res.json({
      _links: {
        self: { href: `/api/discover/${resource}/actions` },
        resource: { href: `/api/discover/${resource}` }
      },
      resource,
      actions,
      relationships
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'ACTIONS_ERROR',
        message: 'Failed to get resource actions'
      }
    });
  }
});

/**
 * GET /api/discover/health
 * 发现服务健康检查
 */
router.get('/health/check', (req, res) => {
  const stats = defaultResourceDiscoverer.getStats();
  
  res.json({
    status: 'healthy',
    ...stats
  });
});

/**
 * POST /api/discover/cache/clear
 * 清除发现缓存（管理员）
 */
router.post('/cache/clear', (req, res) => {
  try {
    // 检查管理员权限（简化版，实际应使用 auth 中间件）
    const adminToken = req.headers['x-admin-token'];
    if (adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Admin access required'
        }
      });
    }
    
    defaultResourceDiscoverer.clearCache();
    
    logger.info('Discovery cache cleared', {
      requestId: res.locals?.requestId,
      admin: true
    });
    
    res.json({
      success: true,
      message: 'Discovery cache cleared'
    });
  } catch (error) {
    res.status(500).json({
      error: {
        code: 'CACHE_CLEAR_ERROR',
        message: 'Failed to clear cache'
      }
    });
  }
});

module.exports = router;