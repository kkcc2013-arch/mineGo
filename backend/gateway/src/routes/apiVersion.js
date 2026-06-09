// backend/gateway/src/routes/apiVersion.js
// REQ-00044: API 版本管理路由
'use strict';

const express = require('express');
const { createLogger } = require('@pmg/shared/logger');
const {
  getVersionInfo,
  checkVersionCompatibility,
  getChangelog,
  API_VERSIONS,
  CURRENT_VERSION,
  SUPPORTED_VERSIONS,
} = require('../middleware/apiVersion');
const { getDeprecationTracker } = require('@pmg/shared/deprecationTracker');

const logger = createLogger('api-version-routes');
const router = express.Router();

/**
 * GET /api/version
 * 获取 API 版本信息
 */
router.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      currentVersion: CURRENT_VERSION,
      supportedVersions: SUPPORTED_VERSIONS,
      versions: Object.keys(API_VERSIONS).map(v => ({
        version: parseInt(v, 10),
        status: API_VERSIONS[v].status,
        released: API_VERSIONS[v].released,
        deprecated: API_VERSIONS[v].deprecated,
        sunset: API_VERSIONS[v].sunset,
      })),
    },
  });
});

/**
 * GET /api/version/:version
 * 获取特定版本详情
 */
router.get('/:version', (req, res) => {
  const version = parseInt(req.params.version, 10);
  
  if (isNaN(version)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid version number',
    });
  }
  
  const info = getVersionInfo(version);
  
  if (!info) {
    return res.status(404).json({
      success: false,
      error: `Version ${version} not found`,
      supportedVersions: SUPPORTED_VERSIONS,
    });
  }
  
  res.json({
    success: true,
    data: info,
  });
});

/**
 * GET /api/version/:version/compatibility
 * 检查版本兼容性
 */
router.get('/:version/compatibility', (req, res) => {
  const version = parseInt(req.params.version, 10);
  
  if (isNaN(version)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid version number',
    });
  }
  
  const compatibility = checkVersionCompatibility(version);
  
  res.json({
    success: true,
    data: compatibility,
  });
});

/**
 * GET /api/version/changelog
 * 获取所有版本的变更日志
 */
router.get('/changelog/all', (req, res) => {
  const changelog = getChangelog();
  
  res.json({
    success: true,
    data: changelog,
  });
});

/**
 * GET /api/version/:version/changelog
 * 获取特定版本的变更日志
 */
router.get('/:version/changelog', (req, res) => {
  const version = parseInt(req.params.version, 10);
  
  if (isNaN(version)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid version number',
    });
  }
  
  const info = API_VERSIONS[version];
  
  if (!info) {
    return res.status(404).json({
      success: false,
      error: `Version ${version} not found`,
    });
  }
  
  res.json({
    success: true,
    data: {
      version,
      released: info.released,
      status: info.status,
      changes: info.changes,
    },
  });
});

/**
 * GET /api/deprecation/list
 * 获取所有废弃的端点
 */
router.get('/deprecation/list', async (req, res) => {
  try {
    const tracker = getDeprecationTracker();
    const deprecated = tracker.getAllDeprecated();
    
    res.json({
      success: true,
      data: {
        total: deprecated.length,
        endpoints: deprecated,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get deprecated endpoints');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve deprecated endpoints',
    });
  }
});

/**
 * GET /api/deprecation/upcoming
 * 获取即将下线的端点
 */
router.get('/deprecation/upcoming', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const tracker = getDeprecationTracker();
    const upcoming = tracker.getUpcomingSunsets(days);
    
    res.json({
      success: true,
      data: {
        withinDays: days,
        total: upcoming.length,
        endpoints: upcoming,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get upcoming sunsets');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve upcoming sunsets',
    });
  }
});

/**
 * GET /api/deprecation/usage/:endpoint
 * 获取废弃端点的使用统计
 */
router.get('/deprecation/usage/:endpoint(*)', async (req, res) => {
  try {
    const endpoint = decodeURIComponent(req.params.endpoint);
    const tracker = getDeprecationTracker();
    const usageStats = tracker.getUsageStats(endpoint);
    const endpointInfo = tracker.getEndpoint(endpoint);
    
    res.json({
      success: true,
      data: {
        endpoint,
        info: endpointInfo,
        usage: usageStats,
        totalClients: Object.keys(usageStats).length,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get usage stats');
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve usage statistics',
    });
  }
});

/**
 * POST /api/deprecation/mark
 * 标记端点为废弃（管理员操作）
 */
router.post('/deprecation/mark', async (req, res) => {
  try {
    const { endpoint, sunsetAt, replacement, reason, migrationGuide } = req.body;
    
    if (!endpoint) {
      return res.status(400).json({
        success: false,
        error: 'Endpoint is required',
      });
    }
    
    const tracker = getDeprecationTracker();
    const record = await tracker.deprecate(endpoint, {
      sunsetAt,
      replacement,
      reason,
      migrationGuide,
    });
    
    logger.info({
      endpoint,
      deprecatedAt: record.deprecatedAt,
      sunsetAt: record.sunsetAt,
    }, 'Endpoint marked as deprecated via API');
    
    res.json({
      success: true,
      data: record,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to mark endpoint as deprecated');
    res.status(500).json({
      success: false,
      error: 'Failed to mark endpoint as deprecated',
    });
  }
});

module.exports = router;
