/**
 * REQ-00044: API 版本管理与向后兼容策略
 * 
 * 支持：
 * - URL 路径版本控制: /api/v1/users, /api/v2/users
 * - Header 版本协商: Accept-Version: 2
 * - 废弃 API 检测和告警
 * - 变更日志自动生成
 */

'use strict';

const { createLogger } = require('./logger');
const { versionDeprecationCounter, versionUsageCounter } = require('./apiMetrics');

const logger = createLogger('api-version');

// ============================================================
// 版本配置
// ============================================================

/**
 * API 版本定义
 */
const API_VERSIONS = {
  1: {
    released: '2026-06-01',
    deprecated: null,        // 未废弃
    sunset: null,            // 无下线日期
    deprecationPeriod: 180,  // 废弃周期（天）
    changes: [],
    description: '初始版本'
  },
  2: {
    released: '2026-06-22',
    deprecated: null,
    sunset: null,
    deprecationPeriod: 180,
    changes: [
      { 
        type: 'added', 
        path: '/api/v2/catch/nearby', 
        description: '新增稀有度过滤参数 rarity',
        date: '2026-06-22'
      },
      { 
        type: 'changed', 
        path: '/api/v2/users/profile', 
        description: '响应增加 stats 字段',
        date: '2026-06-22'
      },
      { 
        type: 'added', 
        path: '/api/v2/pokemon/batch', 
        description: '新增批量查询接口',
        date: '2026-06-22'
      }
    ],
    description: '性能优化版本，新增批量查询'
  }
};

const CURRENT_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];
const DEPRECATED_VERSIONS = []; // 待废弃版本

// 废弃告警阈值（使用率低于此值时可安全下线）
const DEPRECATION_THRESHOLD = 0.05; // 5%

// ============================================================
// 版本管理器
// ============================================================

class APIVersionManager {
  constructor(config = {}) {
    this.currentVersion = config.currentVersion || CURRENT_VERSION;
    this.supportedVersions = config.supportedVersions || SUPPORTED_VERSIONS;
    this.deprecatedVersions = config.deprecatedVersions || DEPRECATED_VERSIONS;
    this.defaultVersion = config.defaultVersion || this.currentVersion;
    this.versionUsage = new Map(); // 版本使用统计
    this.deprecationWarnings = new Map(); // 废弃告警缓存
  }

  /**
   * 获取版本信息
   */
  getVersionInfo(version) {
    return API_VERSIONS[version] || null;
  }

  /**
   * 获取所有版本信息
   */
  getAllVersions() {
    return Object.entries(API_VERSIONS).map(([v, info]) => ({
      version: parseInt(v),
      ...info,
      isCurrent: parseInt(v) === this.currentVersion,
      isDeprecated: this.isDeprecated(parseInt(v))
    }));
  }

  /**
   * 检查版本是否支持
   */
  isSupported(version) {
    return this.supportedVersions.includes(version);
  }

  /**
   * 检查版本是否废弃
   */
  isDeprecated(version) {
    const info = API_VERSIONS[version];
    return info && info.deprecated !== null;
  }

  /**
   * 检查版本是否已下线
   */
  isSunset(version) {
    const info = API_VERSIONS[version];
    if (!info || !info.sunset) return false;
    return new Date() >= new Date(info.sunset);
  }

  /**
   * 标记版本废弃
   */
  deprecateVersion(version, options = {}) {
    const info = API_VERSIONS[version];
    if (!info) {
      throw new Error(`Unknown API version: ${version}`);
    }

    const deprecationDate = options.deprecationDate || new Date().toISOString();
    const deprecationPeriod = options.deprecationPeriod || info.deprecationPeriod || 180;
    
    // 计算下线日期
    const sunsetDate = new Date(deprecationDate);
    sunsetDate.setDate(sunsetDate.getDate() + deprecationPeriod);

    info.deprecated = deprecationDate;
    info.sunset = sunsetDate.toISOString();

    if (!this.deprecatedVersions.includes(version)) {
      this.deprecatedVersions.push(version);
    }

    logger.warn({
      version,
      deprecated: deprecationDate,
      sunset: info.sunset
    }, 'API version deprecated');

    return info;
  }

  /**
   * 记录版本使用
   */
  recordUsage(version, endpoint) {
    const key = `${version}:${endpoint}`;
    const count = this.versionUsage.get(key) || 0;
    this.versionUsage.set(key, count + 1);

    // Prometheus 指标
    versionUsageCounter.inc({ version: String(version), endpoint });

    // 检查废弃版本使用
    if (this.isDeprecated(version)) {
      versionDeprecationCounter.inc({ version: String(version), endpoint });
    }
  }

  /**
   * 获取版本使用统计
   */
  getUsageStats() {
    const stats = {};
    
    for (const [key, count] of this.versionUsage) {
      const [version, endpoint] = key.split(':');
      if (!stats[version]) {
        stats[version] = { total: 0, endpoints: {} };
      }
      stats[version].total += count;
      stats[version].endpoints[endpoint] = count;
    }

    return stats;
  }

  /**
   * 检查废弃版本是否可安全下线
   */
  canSafelySunset(version) {
    const stats = this.getUsageStats();
    const totalUsage = Object.values(stats).reduce((sum, s) => sum + s.total, 0);
    const versionUsage = stats[version]?.total || 0;

    if (totalUsage === 0) return true;

    const usageRate = versionUsage / totalUsage;
    return usageRate < DEPRECATION_THRESHOLD;
  }

  /**
   * 获取废弃告警
   */
  getDeprecationWarning(version) {
    const info = API_VERSIONS[version];
    if (!info || !info.deprecated) return null;

    const sunsetDate = new Date(info.sunset);
    const daysRemaining = Math.ceil((sunsetDate - new Date()) / (1000 * 60 * 60 * 24));

    return {
      version,
      deprecated: info.deprecated,
      sunset: info.sunset,
      daysRemaining: Math.max(0, daysRemaining),
      message: `API v${version} 已废弃，将于 ${info.sunset} 下线。请迁移到 v${this.currentVersion}。`,
      migrationGuide: `/docs/api/migration/v${version}-to-v${this.currentVersion}.md`
    };
  }

  /**
   * 添加变更记录
   */
  addChange(version, change) {
    const info = API_VERSIONS[version];
    if (!info) {
      throw new Error(`Unknown API version: ${version}`);
    }

    info.changes.push({
      ...change,
      date: change.date || new Date().toISOString().split('T')[0]
    });

    logger.info({ version, change }, 'API change recorded');
  }

  /**
   * 生成变更日志
   */
  generateChangelog(fromVersion, toVersion) {
    const changes = [];
    
    for (let v = fromVersion + 1; v <= toVersion; v++) {
      const info = API_VERSIONS[v];
      if (info && info.changes) {
        changes.push({
          version: v,
          released: info.released,
          description: info.description,
          changes: info.changes
        });
      }
    }

    return changes;
  }
}

// 单例实例
let versionManager = null;

function getVersionManager() {
  if (!versionManager) {
    versionManager = new APIVersionManager();
  }
  return versionManager;
}

// ============================================================
// 版本中间件
// ============================================================

/**
 * API 版本中间件
 * 
 * 用法：
 * app.use('/api', apiVersionMiddleware());
 * app.use('/api/v1', v1Routes);
 * app.use('/api/v2', v2Routes);
 */
function apiVersionMiddleware(options = {}) {
  const manager = getVersionManager();
  const headerName = options.headerName || 'accept-version';

  return (req, res, next) => {
    // 1. 从 URL 路径提取版本
    const pathVersion = extractVersionFromPath(req.path);

    // 2. 从 Header 获取版本协商
    const headerVersion = parseInt(req.headers[headerName] || 0);

    // 3. 确定有效版本
    let effectiveVersion = pathVersion || headerVersion || manager.defaultVersion;

    // 4. 验证版本支持
    if (!manager.isSupported(effectiveVersion)) {
      return res.status(400).json({
        code: 1044,
        message: `不支持的 API 版本: ${effectiveVersion}`,
        supportedVersions: manager.supportedVersions,
        currentVersion: manager.currentVersion
      });
    }

    // 5. 检查版本是否已下线
    if (manager.isSunset(effectiveVersion)) {
      return res.status(410).json({
        code: 1045,
        message: `API v${effectiveVersion} 已下线`,
        currentVersion: manager.currentVersion,
        migrationGuide: `/docs/api/migration/v${effectiveVersion}-to-v${manager.currentVersion}.md`
      });
    }

    // 6. 设置版本信息到请求对象
    req.apiVersion = effectiveVersion;
    req.versionInfo = manager.getVersionInfo(effectiveVersion);

    // 7. 添加废弃告警 Header
    if (manager.isDeprecated(effectiveVersion)) {
      const warning = manager.getDeprecationWarning(effectiveVersion);
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', warning.sunset);
      res.setHeader('Link', `<${warning.migrationGuide}>; rel="deprecation"`);
      
      // 响应体中添加告警
      res.once('finish', () => {
        logger.warn({
          version: effectiveVersion,
          path: req.path,
          daysRemaining: warning.daysRemaining
        }, 'Deprecated API version used');
      });
    }

    // 8. 记录使用统计
    manager.recordUsage(effectiveVersion, req.path);

    // 9. 设置响应 Header
    res.setHeader('API-Version', String(effectiveVersion));
    if (effectiveVersion < manager.currentVersion) {
      res.setHeader('API-Version-Latest', String(manager.currentVersion));
    }

    next();
  };
}

/**
 * 从路径提取版本号
 * /api/v1/users -> 1
 * /api/v2/catch/nearby -> 2
 * /api/users -> null
 */
function extractVersionFromPath(path) {
  const match = path.match(/\/api\/v(\d+)\//);
  return match ? parseInt(match[1]) : null;
}

// ============================================================
// 版本路由注册器
// ============================================================

/**
 * 版本化路由注册
 * 
 * 用法：
 * const versionedRoutes = new VersionedRoutes(app);
 * versionedRoutes.register(1, '/users', v1UserRoutes);
 * versionedRoutes.register(2, '/users', v2UserRoutes);
 */
class VersionedRoutes {
  constructor(app) {
    this.app = app;
    this.routes = new Map();
  }

  /**
   * 注册版本路由
   */
  register(version, path, router) {
    const versionPath = `/api/v${version}${path}`;
    this.app.use(versionPath, router);
    
    const key = `${version}:${path}`;
    this.routes.set(key, { version, path, router, registeredAt: new Date() });

    logger.info({ version, path: versionPath }, 'Versioned route registered');
    
    return this;
  }

  /**
   * 批量注册
   */
  registerAll(version, routes) {
    for (const [path, router] of Object.entries(routes)) {
      this.register(version, path, router);
    }
    return this;
  }

  /**
   * 获取已注册路由
   */
  getRegisteredRoutes() {
    return Array.from(this.routes.entries()).map(([key, info]) => ({
      key,
      ...info
    }));
  }
}

// ============================================================
// 版本协商辅助函数
// ============================================================

/**
 * 创建版本化响应适配器
 * 用于将数据适配到不同版本格式
 */
function createVersionAdapter(adapters) {
  return (req, res, next) => {
    const version = req.apiVersion;
    const adapter = adapters[version];

    if (!adapter) {
      return next(new Error(`No adapter for version ${version}`));
    }

    // 包装 res.json
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      try {
        const adaptedData = adapter(data, req);
        return originalJson(adaptedData);
      } catch (err) {
        logger.error({ err, version }, 'Version adapter error');
        return originalJson(data); // 失败时返回原始数据
      }
    };

    next();
  };
}

/**
 * 版本比较中间件
 * 要求最低版本
 */
function requireMinVersion(minVersion) {
  return (req, res, next) => {
    if (req.apiVersion < minVersion) {
      return res.status(400).json({
        code: 1046,
        message: `此功能需要 API v${minVersion} 或更高版本`,
        currentVersion: req.apiVersion,
        minVersion
      });
    }
    next();
  };
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  APIVersionManager,
  getVersionManager,
  apiVersionMiddleware,
  VersionedRoutes,
  createVersionAdapter,
  requireMinVersion,
  extractVersionFromPath,
  API_VERSIONS,
  CURRENT_VERSION,
  SUPPORTED_VERSIONS
};
