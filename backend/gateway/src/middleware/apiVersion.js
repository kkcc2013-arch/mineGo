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
  const match = path.match(/^\/api\/v(\d+)(\/|$)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * API 版本中间件
 * 
 * 支持：
 * - URL 路径版本控制: /api/v1/users, /api/v2/users
 * - Header 版本协商: Accept-Version: 2
 * - 默认版本回退
 * - 废弃告警
 */
function apiVersionMiddleware(req, res, next) {
  const startTime = Date.now();
  
  // 1. 从 URL 路径提取版本
  const pathVersion = extractVersionFromPath(req.path);
  
  // 2. 检查 Header 版本协商
  const headerVersion = parseInt(req.headers['accept-version'] || 0, 10);
  
  // 3. 确定有效版本（优先级：URL > Header > 当前版本）
  let requestedVersion = pathVersion || headerVersion || CURRENT_VERSION;
  
  // 4. 验证版本是否支持
  if (requestedVersion < MIN_SUPPORTED_VERSION || requestedVersion > MAX_SUPPORTED_VERSION) {
    // 记录不支持的版本请求
    metrics.apiVersionUnsupportedRequests?.inc({ version: requestedVersion });
    
    return res.status(400).json({
      code: 1010,
      message: '不支持的 API 版本',
      data: {
        requestedVersion,
        supportedVersions: SUPPORTED_VERSIONS,
        currentVersion: CURRENT_VERSION,
        hint: `使用 /api/v${CURRENT_VERSION}/ 前缀或设置 Accept-Version: ${CURRENT_VERSION} Header`,
      },
    });
  }
  
  // 5. 检查版本是否已废弃
  const versionInfo = API_VERSIONS[requestedVersion];
  
  if (versionInfo.status === 'deprecated' || versionInfo.deprecated) {
    // 设置废弃响应头
    res.setHeader('X-API-Deprecated', 'true');
    res.setHeader('X-API-Deprecated-At', versionInfo.deprecated);
    res.setHeader('X-API-Sunset', versionInfo.sunset);
    res.setHeader('X-API-Replacement', `/api/v${requestedVersion + 1}/`);
    res.setHeader('X-API-Migration-Guide', `https://docs.minego.com/api/migration/v${requestedVersion}-to-v${requestedVersion + 1}`);
    
    // 记录废弃版本使用
    metrics.apiDeprecatedVersionUsage?.inc({ version: requestedVersion });
    logger.warn({
      version: requestedVersion,
      path: req.path,
      clientId: req.headers['x-client-id'],
      deprecatedAt: versionInfo.deprecated,
      sunsetAt: versionInfo.sunset,
    }, 'Deprecated API version used');
  }
  
  // 6. 设置版本上下文
  req.apiVersion = requestedVersion;
  req.versionInfo = versionInfo;
  
  // 7. 设置响应头
  res.setHeader('X-API-Version', requestedVersion);
  res.setHeader('X-API-Supported-Versions', SUPPORTED_VERSIONS.join(', '));
  
  // 8. 记录版本使用指标
  metrics.apiVersionRequests?.inc({ version: requestedVersion, method: req.method });
  
  // 9. 如果请求的是旧版本但路径没有版本前缀，添加警告
  if (!pathVersion && headerVersion && headerVersion < CURRENT_VERSION) {
    res.setHeader('X-API-Warning', `Using older version ${headerVersion} via header. Consider upgrading to v${CURRENT_VERSION}`);
  }
  
  const elapsed = Date.now() - startTime;
  if (elapsed > 5) {
    logger.debug({ elapsed, version: requestedVersion }, 'API version resolution');
  }
  
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
        method: methodUpper = method.toUpperCase(),
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
