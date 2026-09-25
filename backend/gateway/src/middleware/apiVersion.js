// backend/gateway/src/middleware/apiVersion.js
// REQ-00044: API 版本管理与向后兼容策略
'use strict';

const { createLogger } = require('@pmg/shared/logger');
const metrics = require('@pmg/shared/metrics');

const logger = createLogger('api-version');

/**
 * API 版本配置
 */
const API_VERSIONS = {
  1: {
    version: 1,
    released: '2026-06-01',
    deprecated: null,      // 未废弃
    sunset: null,          // 无下线日期
    status: 'active',      // active | deprecated | sunset
    changes: [
      { type: 'initial', description: '初始版本' }
    ],
  },
  2: {
    version: 2,
    released: '2026-06-09',
    deprecated: null,
    sunset: null,
    status: 'active',
    changes: [
      { type: 'added', path: '/api/v2/catch/nearby', description: '新增稀有度过滤参数 rarity' },
      { type: 'changed', path: '/api/v2/users/:id/profile', description: '响应增加 stats 字段' },
      { type: 'changed', path: '/api/v2/pokemon', description: '响应增加 moves 字段' },
      { type: 'added', path: '/api/v2/gyms/:id/raid', description: '新增 Raid 详细信息端点' },
      { type: 'optimized', path: '/api/v2/map/nearby', description: '性能优化，响应减少 40%' },
    ],
  },
};

const CURRENT_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];
const DEPRECATED_VERSIONS = [];
const MIN_SUPPORTED_VERSION = 1;
const MAX_SUPPORTED_VERSION = 2;

// 废弃周期配置（6 个月）
const DEPRECATION_PERIOD_DAYS = 180;

/**
 * 从 URL 路径提取版本号
 * @param {string} path - URL 路径
 * @returns {number|null} 版本号
 */
function extractVersionFromPath(path) {
  // /api/vN/... 与旧前缀 /vN/...
  const match = path.match(/^\/(?:api\/)?v(\d+)(\/|$)/);
  return match ? parseInt(match[1], 10) : null;
}

// REQ-00201: 版本注册表（生命周期 development → testing → stable → deprecated → sunset），
// 初始值来自 API_VERSIONS，网关启动后由 api_versions 表覆盖并定期刷新（见 index.js）
const { VersionRegistry } = require('@pmg/shared/apiStandards/versioning');
let versionRegistry = null;
function getVersionRegistry(opts = {}) {
  if (!versionRegistry) {
    const seed = {};
    for (const [v, info] of Object.entries(API_VERSIONS)) {
      seed[v] = { status: info.status === 'active' ? 'stable' : info.status, released: info.released, deprecated: info.deprecated, sunset: info.sunset, successor: Number(v) < MAX_SUPPORTED_VERSION ? Number(v) + 1 : null, description: (info.changes[0] || {}).description, changes: info.changes };
    }
    versionRegistry = new VersionRegistry({ versions: seed, currentVersion: CURRENT_VERSION, ...opts });
  } else if (opts.query && !versionRegistry.query) {
    versionRegistry.query = opts.query;
    versionRegistry.logger = opts.logger || versionRegistry.logger;
  }
  return versionRegistry;
}

function versionError(res, status, code, message, data, extraHeaders = {}) {
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  const name = status === 410 ? 'API_SUNSET' : 'API_VERSION_UNSUPPORTED';
  return res.status(status).json({
    success: false,
    code,
    message,
    data,
    error: { code, name, message, details: data },
  });
}

/**
 * API 版本中间件
 *
 * 支持：
 * - URL 路径版本控制: /api/v1/users, /api/v2/users（旧前缀 /v1/... 视为 v1）
 * - Header 版本协商: Accept-Version: 2 / X-API-Version: 2 / Accept: application/vnd.minego.v2+json
 * - 默认版本回退（当前稳定版）
 * - 生命周期：deprecated → Deprecation/Sunset/Link(successor-version) 响应头；sunset → 410 Gone
 */
function apiVersionMiddleware(req, res, next) {
  const registry = getVersionRegistry();
  const r = registry.resolve(req);
  const requestedVersion = r.version;
  const entry = registry.get(requestedVersion);
  const supported = registry.supported();
  const current = registry.current();

  // 1. 未知版本 / development 版本（未公开）
  const effective = entry ? registry.effectiveStatus(entry) : null;
  if (!entry || effective === 'development' || r.invalidHeader) {
    metrics.apiVersionUnsupportedRequests?.inc({ version: String(requestedVersion) });
    return versionError(res, 400, 1010, '不支持的 API 版本', {
      requestedVersion: r.invalidHeader ? (req.headers['accept-version'] || req.headers['x-api-version']) : requestedVersion,
      supportedVersions: supported,
      currentVersion: current,
      hint: `使用 /api/v${current}/ 前缀或设置 Accept-Version: ${current} Header`,
    });
  }

  // 2. 已下线版本 → 410 Gone
  if (effective === 'sunset') {
    metrics.apiVersionUnsupportedRequests?.inc({ version: String(requestedVersion) });
    const d = registry.describe(entry);
    return versionError(res, 410, 1014, `API v${requestedVersion} 已于 ${d.sunsetAt || '-'} 下线`, {
      requestedVersion,
      sunsetAt: d.sunsetAt,
      successorVersion: d.successor,
      migrationGuide: d.migrationGuide || `/api/version/${requestedVersion}/breaking-changes`,
      supportedVersions: supported,
    }, registry.deprecationHeaders(requestedVersion));
  }

  // 3. 已弃用版本：标准响应头 + 旧的 X-API-* 头（兼容）
  const legacyInfo = API_VERSIONS[requestedVersion] || { version: requestedVersion, status: effective, changes: [] };
  if (effective === 'deprecated') {
    const headers = registry.deprecationHeaders(requestedVersion);
    for (const [k, v] of Object.entries(headers)) {
      if (k === 'Link') {
        const prev = res.getHeader('Link');
        res.setHeader('Link', prev ? `${prev}, ${v}` : v);
      } else res.setHeader(k, v);
    }
    const d = registry.describe(entry);
    res.setHeader('X-API-Deprecated', 'true');
    if (d.deprecatedAt) res.setHeader('X-API-Deprecated-At', d.deprecatedAt);
    if (d.sunsetAt) res.setHeader('X-API-Sunset', d.sunsetAt);
    if (d.successor) res.setHeader('X-API-Replacement', `/api/v${d.successor}/`);
    res.setHeader('X-API-Migration-Guide', d.migrationGuide || `/api/version/${requestedVersion}/breaking-changes`);
    metrics.apiDeprecatedVersionUsage?.inc({ version: String(requestedVersion) });
  }

  // 4. 设置版本上下文
  req.apiVersion = requestedVersion;
  req.versionInfo = { ...legacyInfo, lifecycle: registry.describe(entry) };
  req.apiVersionSource = r.source;

  // 5. 响应头
  res.setHeader('X-API-Version', requestedVersion);
  res.setHeader('X-API-Supported-Versions', supported.join(', '));
  res.setHeader('X-API-Version-Source', r.source);
  if (r.conflict) {
    res.setHeader('X-API-Warning', `URL 版本 v${r.pathVersion} 与协商版本 v${r.mediaVersion || r.headerVersion} 不一致，以 URL 为准`);
  } else if (r.source !== 'path' && r.source !== 'default' && requestedVersion < current) {
    res.setHeader('X-API-Warning', `Using older version ${requestedVersion} via ${r.source}. Consider upgrading to v${current}`);
  }
  const vary = String(res.getHeader('Vary') || '');
  if (!/accept-version/i.test(vary)) res.setHeader('Vary', vary ? `${vary}, Accept-Version` : 'Accept-Version');

  // 6. 使用统计（Prometheus + api_version_usage 按天聚合）
  metrics.apiVersionRequests?.inc({ version: String(requestedVersion), method: req.method });
  registry.recordUsage(requestedVersion, `${req.method} ${req.path.replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, '/:id').replace(/\/\d+(?=\/|$)/g, '/:id')}`);

  next();
}

/**
 * 版本路由注册器
 * 
 * 用法示例:
 * registerVersionedRoute(app, {
 *   'GET /users': {
 *     v1: userRoutesV1.getUsers,
 *     v2: userRoutesV2.getUsers,
 *   },
 * });
 */
function registerVersionedRoute(app, routes) {
  for (const [methodPath, handlers] of Object.entries(routes)) {
    const [method, path] = methodPath.split(' ');
    const methodLower = method.toLowerCase();
    
    // 确保 path 不以 /api 开头
    const normalizedPath = path.startsWith('/api') ? path.replace(/^\/api/, '') : path;
    const apiPath = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
    
    for (const [versionKey, handler] of Object.entries(handlers)) {
      const versionNum = parseInt(versionKey.toString().replace('v', ''), 10);
      
      if (!SUPPORTED_VERSIONS.includes(versionNum)) {
        logger.warn({ version: versionNum, path: apiPath }, 'Skipping unsupported version');
        continue;
      }
      
      // 注册带版本号的路径
      const versionedPath = `/api/v${versionNum}${apiPath}`;
      app[methodLower](versionedPath, handler);
      
      // 为当前版本注册无版本前缀的别名
      if (versionNum === CURRENT_VERSION) {
        const aliasPath = `/api${apiPath}`;
        app[methodLower](aliasPath, handler);
      }
      
      logger.debug({
        method: method.toUpperCase(),
        path: apiPath,
        version: versionNum,
        registered: versionedPath,
      }, 'Versioned route registered');
    }
  }
}

/**
 * 版本检查中间件 - 用于需要特定版本的端点
 */
function requireVersion(minVersion) {
  return (req, res, next) => {
    if (req.apiVersion < minVersion) {
      return res.status(400).json({
        code: 1011,
        message: `此端点需要 API 版本 ${minVersion} 或更高`,
        data: {
          currentVersion: req.apiVersion,
          requiredVersion: minVersion,
          hint: `使用 /api/v${minVersion}/ 前缀或设置 Accept-Version: ${minVersion} Header`,
        },
      });
    }
    next();
  };
}

/**
 * 获取版本信息
 */
function getVersionInfo(version) {
  if (version === undefined) {
    return {
      currentVersion: CURRENT_VERSION,
      supportedVersions: SUPPORTED_VERSIONS,
      deprecatedVersions: DEPRECATED_VERSIONS,
      versions: API_VERSIONS,
    };
  }
  
  return API_VERSIONS[version] || null;
}

/**
 * 检查版本兼容性
 */
function checkVersionCompatibility(clientVersion) {
  if (!SUPPORTED_VERSIONS.includes(clientVersion)) {
    return {
      compatible: false,
      reason: 'unsupported',
      message: `版本 ${clientVersion} 不支持`,
      supportedVersions: SUPPORTED_VERSIONS,
    };
  }
  
  const info = API_VERSIONS[clientVersion];
  
  if (info.status === 'deprecated') {
    return {
      compatible: true,
      deprecated: true,
      reason: 'deprecated',
      message: `版本 ${clientVersion} 已废弃，将在 ${info.sunset} 下线`,
      sunsetAt: info.sunset,
      replacementVersion: clientVersion + 1,
      migrationGuide: `https://docs.minego.com/api/migration/v${clientVersion}-to-v${clientVersion + 1}`,
    };
  }
  
  return {
    compatible: true,
    deprecated: false,
    message: `版本 ${clientVersion} 正常支持`,
  };
}

/**
 * 获取所有版本的变更日志
 */
function getChangelog() {
  const changelog = [];
  
  for (const [version, info] of Object.entries(API_VERSIONS).sort((a, b) => b[0] - a[0])) {
    changelog.push({
      version: parseInt(version, 10),
      released: info.released,
      status: info.status,
      changes: info.changes,
      deprecated: info.deprecated,
      sunset: info.sunset,
    });
  }
  
  return changelog;
}

// 初始化版本相关的 Prometheus 指标
function initVersionMetrics() {
  // API 版本请求计数
  metrics.apiVersionRequests = metrics.register.getSingleMetric('api_version_requests_total') ||
    new metrics.client.Counter({
      name: 'api_version_requests_total',
      help: 'Total API requests by version',
      labelNames: ['version', 'method'],
    });
  
  // 不支持的版本请求计数
  metrics.apiVersionUnsupportedRequests = metrics.register.getSingleMetric('api_version_unsupported_requests_total') ||
    new metrics.client.Counter({
      name: 'api_version_unsupported_requests_total',
      help: 'Total requests with unsupported API versions',
      labelNames: ['version'],
    });
  
  // 废弃版本使用计数
  metrics.apiDeprecatedVersionUsage = metrics.register.getSingleMetric('api_deprecated_version_usage_total') ||
    new metrics.client.Counter({
      name: 'api_deprecated_version_usage_total',
      help: 'Total usage of deprecated API versions',
      labelNames: ['version'],
    });
}

// 模块加载时初始化指标
try {
  initVersionMetrics();
} catch (err) {
  logger.debug({ err }, 'Version metrics may already exist');
}

module.exports = {
  apiVersionMiddleware,
  getVersionRegistry,
  registerVersionedRoute,
  requireVersion,
  getVersionInfo,
  checkVersionCompatibility,
  getChangelog,
  extractVersionFromPath,
  API_VERSIONS,
  CURRENT_VERSION,
  SUPPORTED_VERSIONS,
  DEPRECATED_VERSIONS,
  MIN_SUPPORTED_VERSION,
  MAX_SUPPORTED_VERSION,
  DEPRECATION_PERIOD_DAYS,
};
