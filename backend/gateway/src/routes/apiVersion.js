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
  getVersionRegistry,
} = require('../middleware/apiVersion');
const { getDeprecationTracker } = require('@pmg/shared/deprecationTracker');

const logger = createLogger('api-version-routes');
const router = express.Router();

/**
 * GET /api/version
 * 获取 API 版本信息（REQ-00201：状态为生命周期 development/testing/stable/deprecated/sunset）
 */
router.get('/', (req, res) => {
  const registry = getVersionRegistry();
  res.json({
    success: true,
    code: 0,
    message: 'ok',
    data: {
      currentVersion: registry.current(),
      supportedVersions: registry.supported(),
      negotiation: {
        path: '/api/vN/...（旧前缀 /vN/... 等价）',
        headers: ['Accept-Version: N', 'X-API-Version: N', 'Accept: application/vnd.minego.vN+json'],
        precedence: 'URL > 媒体类型 > Accept-Version > X-API-Version > 默认（当前稳定版）',
      },
      versions: registry.list().map((v) => ({
        ...v,
        released: v.released || (API_VERSIONS[v.version] || {}).released || null,
        deprecated: v.deprecatedAt,
        sunset: v.sunsetAt,
        legacyStatus: (API_VERSIONS[v.version] || {}).status || null,
      })),
    },
  });
});

/**
 * GET /api/version/:version/breaking-changes
 * 破坏性变更与变更记录（api_changes）
 */
router.get('/:version(\\d+)/breaking-changes', async (req, res) => {
  const version = parseInt(req.params.version, 10);
  try {
    const rows = await getVersionRegistry().breakingChanges(version);
    const fallback = (API_VERSIONS[version] || {}).changes || [];
    const changes = rows.length ? rows : fallback.map((c) => ({ version, change_type: c.type, path: c.path || null, description: c.description, breaking_change: false }));
    res.json({ success: true, code: 0, message: 'ok', data: { version, total: changes.length, breaking: changes.filter((c) => c.breaking_change).length, changes } });
  } catch (err) {
    logger.error({ err }, 'Failed to load api_changes');
    res.status(500).json({ success: false, code: 9001, message: 'Failed to load changes' });
  }
});

/**
 * GET /api/version/:version/openapi.json
 * 按版本生成的 OpenAPI 文档：从 bundled.yaml 取出属于该版本的路径（/api/vN/、/vN/）
 */
router.get('/:version(\\d+)/openapi.json', (req, res) => {
  const version = parseInt(req.params.version, 10);
  try {
    const YAML = require('yamljs');
    const path = require('path');
    const doc = YAML.load(path.join(__dirname, '../../../../docs/api-spec/openapi/bundled.yaml'));
    const re = new RegExp(`^/(?:api/)?v${version}(/|$)`);
    const servers = (doc.servers || []).map((s) => ({ ...s }));
    const paths = {};
    for (const [p, item] of Object.entries(doc.paths || {})) {
      const full = servers.length && /\/v\d+\/?$/.test(servers[0].url || '') ? `${(servers[0].url.match(/\/v\d+/) || [''])[0]}${p}` : p;
      if (re.test(p) || re.test(full)) paths[p] = item;
    }
    const d = getVersionRegistry().describe(version);
    if (!d) return res.status(404).json({ success: false, code: 1005, message: `Version ${version} not found` });
    res.json({ ...doc, info: { ...(doc.info || {}), version: `${version}.0.0`, 'x-lifecycle': d.status, 'x-sunset': d.sunsetAt }, paths });
  } catch (err) {
    logger.error({ err }, 'Failed to build versioned OpenAPI');
    res.status(500).json({ success: false, code: 9001, message: 'OpenAPI 文档不可用' });
  }
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
