# REQ-00201: API 契约版本协商与灰度兼容系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00201 |
| 标题 | API 契约版本协商与灰度兼容系统 |
| 类别 | API 设计规范 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、docs/api-spec |
| 创建时间 | 2026-06-14 16:00 |

## 需求描述

### 背景
随着 mineGo 项目 API 数量增长和业务迭代加速，API 版本管理面临以下挑战：
1. 客户端版本碎片化严重，需同时支持多个 API 版本
2. 缺乏统一的版本协商机制，客户端难以平滑升级
3. API 变更时缺乏灰度兼容策略，导致部分客户端功能异常
4. OpenAPI 文档版本管理混乱，难以追踪版本演进历史

### 目标
构建完整的 API 契约版本协商系统：
- 支持 URL 路径版本（/v1/、/v2/）和 Header 版本协商
- 实现 API 版本生命周期管理（开发、测试、稳定、废弃、下线）
- 提供灰度兼容层，自动处理不同版本间的请求/响应转换
- 建立 API 变更审计与影响分析能力

## 技术方案

### 1. 版本标识与路由设计

```javascript
// backend/shared/apiVersion/VersionRouter.js

class ApiVersionRouter {
  constructor() {
    this.versions = new Map(); // 版本注册表
    this.defaultVersion = 'v1';
    this.deprecatedVersions = new Set();
    this.versionLifecycle = {
      development: new Set(),  // 开发中
      testing: new Set(),      // 测试中
      stable: new Set(),       // 稳定版
      deprecated: new Set(),   // 已废弃
      sunset: new Set()        // 下线中
    };
  }

  /**
   * 注册 API 版本
   */
  registerVersion(version, config) {
    const versionInfo = {
      version,
      releasedAt: config.releasedAt || new Date().toISOString(),
      lifecycle: config.lifecycle || 'stable',
      sunsetDate: config.sunsetDate || null,
      deprecationMessage: config.deprecationMessage || null,
      breakingChanges: config.breakingChanges || [],
      backwardCompatibleWith: config.backwardCompatibleWith || [],
      routes: new Map(),
      middlewares: config.middlewares || []
    };
    
    this.versions.set(version, versionInfo);
    this.versionLifecycle[versionInfo.lifecycle].add(version);
    
    return versionInfo;
  }

  /**
   * 从请求中解析版本信息
   */
  parseVersion(req) {
    // 优先级：URL 路径 > Accept Header > 自定义 Header > 默认版本
    
    // 1. URL 路径版本 /v1/pokemon, /v2/pokemon
    const pathMatch = req.path.match(/^\/(v\d+)\/(.*)/);
    if (pathMatch) {
      return { version: pathMatch[1], path: pathMatch[2], source: 'url' };
    }
    
    // 2. Accept Header: application/vnd.minego.v1+json
    const acceptMatch = req.headers.accept?.match(/vnd\.minego\.(v\d+)\+json/);
    if (acceptMatch) {
      return { version: acceptMatch[1], path: req.path, source: 'accept-header' };
    }
    
    // 3. 自定义 Header: X-API-Version: v1
    const customVersion = req.headers['x-api-version'];
    if (customVersion && this.versions.has(customVersion)) {
      return { version: customVersion, path: req.path, source: 'custom-header' };
    }
    
    // 4. 默认版本
    return { version: this.defaultVersion, path: req.path, source: 'default' };
  }

  /**
   * 获取版本中间件
   */
  getVersionMiddleware(version) {
    const versionInfo = this.versions.get(version);
    if (!versionInfo) {
      return null;
    }
    
    return (req, res, next) => {
      // 注入版本信息到请求上下文
      req.apiVersion = versionInfo;
      res.setHeader('X-API-Version', version);
      res.setHeader('X-API-Lifecycle', versionInfo.lifecycle);
      
      // 处理废弃版本警告
      if (versionInfo.lifecycle === 'deprecated') {
        res.setHeader('Deprecation', 'true');
        res.setHeader('Sunset', versionInfo.sunsetDate || '');
        if (versionInfo.deprecationMessage) {
          res.setHeader('X-Deprecation-Message', versionInfo.deprecationMessage);
        }
      }
      
      next();
    };
  }

  /**
   * 检查版本兼容性
   */
  checkCompatibility(clientVersion, targetVersion) {
    const clientInfo = this.versions.get(clientVersion);
    const targetInfo = this.versions.get(targetVersion);
    
    if (!clientInfo || !targetInfo) {
      return { compatible: false, reason: 'unknown-version' };
    }
    
    // 检查向后兼容性
    if (targetInfo.backwardCompatibleWith.includes(clientVersion)) {
      return { compatible: true, mode: 'backward-compatible' };
    }
    
    // 检查是否存在破坏性变更
    if (clientInfo.breakingChanges.length > 0) {
      return { 
        compatible: false, 
        reason: 'breaking-changes',
        changes: clientInfo.breakingChanges 
      };
    }
    
    return { compatible: true, mode: 'forward-compatible' };
  }
}

module.exports = ApiVersionRouter;
```

### 2. 契约兼容层实现

```javascript
// backend/shared/apiVersion/CompatibilityLayer.js

const createLogger = require('../logger').createLogger;
const logger = createLogger('compatibility-layer');

class CompatibilityLayer {
  constructor() {
    this.transformers = new Map(); // 版本间转换器
    this.adapters = new Map();     // 数据适配器
  }

  /**
   * 注册版本转换器
   * @param {string} fromVersion - 源版本
   * @param {string} toVersion - 目标版本
   * @param {Function} transformer - 转换函数
   */
  registerTransformer(fromVersion, toVersion, transformer) {
    const key = `${fromVersion}->${toVersion}`;
    this.transformers.set(key, transformer);
    logger.info({ fromVersion, toVersion }, 'Transformer registered');
  }

  /**
   * 请求数据转换（客户端版本 -> 服务端版本）
   */
  async transformRequest(req, targetVersion) {
    const clientVersion = req.apiVersion?.version || 'v1';
    
    if (clientVersion === targetVersion) {
      return req.body; // 无需转换
    }
    
    const key = `${clientVersion}->${targetVersion}`;
    const transformer = this.transformers.get(key);
    
    if (!transformer) {
      logger.warn({ 
        clientVersion, 
        targetVersion,
        path: req.path 
      }, 'No transformer found, passing through');
      return req.body;
    }
    
    try {
      const transformed = await transformer.transformRequest(req.body, req);
      logger.debug({
        clientVersion,
        targetVersion,
        path: req.path
      }, 'Request transformed');
      return transformed;
    } catch (err) {
      logger.error({ err, clientVersion, targetVersion }, 'Request transform failed');
      throw new Error(`Version compatibility error: ${err.message}`);
    }
  }

  /**
   * 响应数据转换（服务端版本 -> 客户端版本）
   */
  async transformResponse(data, clientVersion, serverVersion) {
    if (clientVersion === serverVersion) {
      return data;
    }
    
    const key = `${serverVersion}->${clientVersion}`;
    const transformer = this.transformers.get(key);
    
    if (!transformer) {
      return data; // 无法转换，返回原始数据
    }
    
    try {
      const transformed = await transformer.transformResponse(data);
      return transformed;
    } catch (err) {
      logger.error({ err, clientVersion, serverVersion }, 'Response transform failed');
      return data; // 转换失败时返回原始数据
    }
  }

  /**
   * 创建字段映射适配器
   */
  createFieldMapper(schemaV1, schemaV2, fieldMappings) {
    return {
      transformRequest: (data) => {
        const result = { ...data };
        for (const [oldField, newField] of Object.entries(fieldMappings)) {
          if (result[oldField] !== undefined) {
            result[newField] = result[oldField];
            delete result[oldField];
          }
        }
        return result;
      },
      transformResponse: (data) => {
        const result = { ...data };
        const reverseMappings = Object.fromEntries(
          Object.entries(fieldMappings).map(([k, v]) => [v, k])
        );
        for (const [newField, oldField] of Object.entries(reverseMappings)) {
          if (result[newField] !== undefined) {
            result[oldField] = result[newField];
            delete result[newField];
          }
        }
        return result;
      }
    };
  }

  /**
   * 创建字段废弃适配器
   */
  createDeprecationAdapter(deprecatedFields, replacements) {
    return {
      transformRequest: (data) => {
        const result = { ...data };
        for (const field of deprecatedFields) {
          if (result[field] !== undefined) {
            delete result[field];
          }
        }
        return result;
      },
      transformResponse: (data) => {
        const result = { ...data };
        for (const [oldField, newField] of Object.entries(replacements)) {
          if (result[newField] !== undefined) {
            result[oldField] = result[newField]; // 保持向后兼容
          }
        }
        return result;
      }
    };
  }
}

module.exports = CompatibilityLayer;
```

### 3. 版本生命周期管理

```javascript
// backend/shared/apiVersion/VersionLifecycleManager.js

const { query } = require('../db');
const { getRedis } = require('../redis');
const createLogger = require('../logger').createLogger;
const logger = createLogger('version-lifecycle');

class VersionLifecycleManager {
  constructor() {
    this.lifecycleStages = [
      'development',
      'testing', 
      'stable',
      'deprecated',
      'sunset'
    ];
    
    this.transitions = {
      development: ['testing'],
      testing: ['stable', 'development'],
      stable: ['deprecated'],
      deprecated: ['sunset'],
      sunset: [] // 终态，不可逆转
    };
  }

  /**
   * 获取版本详情
   */
  async getVersionInfo(version) {
    const result = await query(`
      SELECT 
        version, lifecycle, released_at, sunset_date,
        deprecation_message, breaking_changes,
        backward_compatible_with, metadata
      FROM api_versions
      WHERE version = $1
    `, [version]);
    
    return result.rows[0] || null;
  }

  /**
   * 获取所有活跃版本
   */
  async getActiveVersions() {
    const result = await query(`
      SELECT version, lifecycle, released_at, sunset_date
      FROM api_versions
      WHERE lifecycle NOT IN ('sunset')
      ORDER BY released_at DESC
    `);
    
    return result.rows;
  }

  /**
   * 升级版本生命周期
   */
  async promoteVersion(version, newLifecycle, options = {}) {
    const current = await this.getVersionInfo(version);
    if (!current) {
      throw new Error(`Version ${version} not found`);
    }
    
    // 验证状态转换合法性
    if (!this.transitions[current.lifecycle].includes(newLifecycle)) {
      throw new Error(
        `Invalid lifecycle transition: ${current.lifecycle} -> ${newLifecycle}`
      );
    }
    
    await query(`
      UPDATE api_versions 
      SET 
        lifecycle = $2,
        sunset_date = COALESCE($3, sunset_date),
        deprecation_message = COALESCE($4, deprecation_message),
        updated_at = NOW()
      WHERE version = $1
    `, [
      version, 
      newLifecycle, 
      options.sunsetDate,
      options.deprecationMessage
    ]);
    
    // 记录变更历史
    await query(`
      INSERT INTO api_version_history (version, from_lifecycle, to_lifecycle, reason, changed_by)
      VALUES ($1, $2, $3, $4, $5)
    `, [version, current.lifecycle, newLifecycle, options.reason, options.changedBy]);
    
    // 清除缓存
    const redis = getRedis();
    await redis.del(`api:version:${version}`);
    await redis.del('api:versions:active');
    
    logger.info({
      version,
      from: current.lifecycle,
      to: newLifecycle,
      reason: options.reason
    }, 'Version lifecycle changed');
    
    return { version, oldLifecycle: current.lifecycle, newLifecycle };
  }

  /**
   * 废弃版本
   */
  async deprecateVersion(version, options = {}) {
    const sunsetDate = options.sunsetDate || this.calculateSunsetDate(180); // 默认 180 天后下线
    
    return this.promoteVersion(version, 'deprecated', {
      ...options,
      sunsetDate,
      deprecationMessage: options.message || 
        `API version ${version} is deprecated and will be sunset on ${sunsetDate}`
    });
  }

  /**
   * 计算下线日期
   */
  calculateSunsetDate(daysFromNow) {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    return date.toISOString().split('T')[0];
  }

  /**
   * 获取版本使用统计
   */
  async getVersionUsageStats(version, timeRange = '7d') {
    const redis = getRedis();
    const now = Date.now();
    const interval = this.parseTimeRange(timeRange);
    
    // 从 Redis 获取计数
    const key = `api:version:usage:${version}`;
    const requests = await redis.get(`${key}:requests`) || 0;
    const uniqueClients = await redis.scard(`${key}:clients`) || 0;
    
    // 从数据库获取详细统计
    const result = await query(`
      SELECT 
        date_trunc('day', timestamp) as day,
        count(*) as request_count,
        count(distinct user_id) as unique_users
      FROM api_request_logs
      WHERE api_version = $1
        AND timestamp > NOW() - INTERVAL '${interval}'
      GROUP BY date_trunc('day', timestamp)
      ORDER BY day DESC
    `, [version]);
    
    return {
      version,
      totalRequests: parseInt(requests),
      uniqueClients,
      dailyStats: result.rows
    };
  }

  /**
   * 发布版本废弃通知
   */
  async notifyDeprecation(version) {
    const versionInfo = await this.getVersionInfo(version);
    if (!versionInfo || versionInfo.lifecycle !== 'deprecated') {
      return;
    }
    
    // TODO: 集成通知系统，向开发者发送废弃提醒
    
    logger.info({ version, sunsetDate: versionInfo.sunset_date }, 'Deprecation notification sent');
  }

  parseTimeRange(range) {
    const units = { d: 'days', w: 'weeks', M: 'months' };
    const match = range.match(/^(\d+)([dwM])$/);
    if (!match) return '7 days';
    return `${match[1]} ${units[match[2]]}`;
  }
}

module.exports = VersionLifecycleManager;
```

### 4. 网关集成中间件

```javascript
// backend/gateway/src/middleware/apiVersionMiddleware.js

const ApiVersionRouter = require('../../../shared/apiVersion/VersionRouter');
const CompatibilityLayer = require('../../../shared/apiVersion/CompatibilityLayer');
const createLogger = require('../../../shared/logger').createLogger;

const logger = createLogger('api-version-middleware');
const versionRouter = new ApiVersionRouter();
const compatibilityLayer = new CompatibilityLayer();

// 初始化版本配置
function initializeVersions() {
  // 注册 v1 版本
  versionRouter.registerVersion('v1', {
    lifecycle: 'stable',
    releasedAt: '2026-01-01',
    backwardCompatibleWith: []
  });
  
  // 注册 v2 版本
  versionRouter.registerVersion('v2', {
    lifecycle: 'stable',
    releasedAt: '2026-06-01',
    backwardCompatibleWith: ['v1'],
    breakingChanges: [
      {
        field: 'pokemon.abilities',
        change: 'array of objects to array of strings',
        migration: 'abilities.map(a => a.name)'
      }
    ]
  });
  
  // 注册 v1 -> v2 转换器
  compatibilityLayer.registerTransformer('v1', 'v2', {
    transformRequest: (data) => {
      // v1 客户端发送 abilities: ["名称"], v2 需要对象数组
      if (data.abilities && Array.isArray(data.abilities)) {
        data.abilities = data.abilities.map(name => ({ name, unlocked: true }));
      }
      return data;
    },
    transformResponse: (data) => {
      // v2 服务端返回对象数组，v1 客户端需要字符串数组
      if (data.abilities && Array.isArray(data.abilities)) {
        data.abilities = data.abilities.map(a => a.name);
      }
      return data;
    }
  });
}

/**
 * API 版本协商中间件
 */
function apiVersionMiddleware(req, res, next) {
  const { version, path, source } = versionRouter.parseVersion(req);
  const versionInfo = versionRouter.versions.get(version);
  
  if (!versionInfo) {
    return res.status(400).json({
      error: 'INVALID_API_VERSION',
      message: `API version '${version}' is not supported`,
      supportedVersions: Array.from(versionRouter.versions.keys())
    });
  }
  
  // 检查版本是否已下线
  if (versionInfo.lifecycle === 'sunset') {
    return res.status(410).json({
      error: 'API_VERSION_SUNSET',
      message: `API version ${version} has been sunset and is no longer available`,
      recommendedVersion: versionRouter.defaultVersion,
      migrationGuide: `https://docs.minego.dev/api/migration/${version}-to-${versionRouter.defaultVersion}`
    });
  }
  
  // 注入版本信息
  req.apiVersion = { version, ...versionInfo, source, originalPath: path };
  
  // 设置响应头
  res.setHeader('X-API-Version', version);
  res.setHeader('X-API-Lifecycle', versionInfo.lifecycle);
  
  if (versionInfo.lifecycle === 'deprecated') {
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', versionInfo.sunsetDate || '');
    res.setHeader('Link', `<https://docs.minego.dev/api/v2>; rel="successor-version"`);
  }
  
  // 应用版本中间件
  const middleware = versionRouter.getVersionMiddleware(version);
  if (middleware) {
    middleware(req, res, next);
  } else {
    next();
  }
}

/**
 * 版本兼容转换中间件
 */
function compatibilityMiddleware(targetVersion = 'v2') {
  return async (req, res, next) => {
    const clientVersion = req.apiVersion?.version;
    
    if (clientVersion === targetVersion) {
      return next();
    }
    
    // 保存原始方法
    const originalJson = res.json.bind(res);
    
    // 拦截响应
    res.json = async (data) => {
      try {
        const transformed = await compatibilityLayer.transformResponse(
          data, 
          clientVersion, 
          targetVersion
        );
        return originalJson(transformed);
      } catch (err) {
        logger.error({ err, clientVersion, targetVersion }, 'Response transformation failed');
        return originalJson(data);
      }
    };
    
    // 转换请求
    try {
      req.body = await compatibilityLayer.transformRequest(req, targetVersion);
      next();
    } catch (err) {
      res.status(400).json({
        error: 'VERSION_COMPATIBILITY_ERROR',
        message: err.message
      });
    }
  };
}

module.exports = {
  initializeVersions,
  apiVersionMiddleware,
  compatibilityMiddleware,
  versionRouter,
  compatibilityLayer
};
```

### 5. 数据库迁移

```sql
-- database/migrations/045_api_version_management.sql

-- API 版本表
CREATE TABLE api_versions (
  id SERIAL PRIMARY KEY,
  version VARCHAR(10) NOT NULL UNIQUE,
  lifecycle VARCHAR(20) NOT NULL DEFAULT 'development',
  released_at TIMESTAMP,
  sunset_date DATE,
  deprecation_message TEXT,
  breaking_changes JSONB DEFAULT '[]',
  backward_compatible_with TEXT[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- API 版本历史
CREATE TABLE api_version_history (
  id SERIAL PRIMARY KEY,
  version VARCHAR(10) NOT NULL,
  from_lifecycle VARCHAR(20) NOT NULL,
  to_lifecycle VARCHAR(20) NOT NULL,
  reason TEXT,
  changed_by VARCHAR(100),
  changed_at TIMESTAMP DEFAULT NOW()
);

-- API 请求日志（用于版本使用分析）
CREATE TABLE api_request_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(100),
  api_version VARCHAR(10) NOT NULL,
  api_path VARCHAR(255) NOT NULL,
  http_method VARCHAR(10) NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  user_agent VARCHAR(500),
  client_version VARCHAR(50),
  timestamp TIMESTAMP DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_api_versions_lifecycle ON api_versions(lifecycle);
CREATE INDEX idx_api_request_logs_version ON api_request_logs(api_version, timestamp);
CREATE INDEX idx_api_request_logs_user ON api_request_logs(user_id, timestamp);

-- 分区（按月）
CREATE TABLE api_request_logs_y2026m06 PARTITION OF api_request_logs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
```

### 6. 管理接口

```javascript
// backend/gateway/src/routes/apiVersionAdmin.js

const express = require('express');
const router = express.Router();
const VersionLifecycleManager = require('../../../shared/apiVersion/VersionLifecycleManager');

const lifecycleManager = new VersionLifecycleManager();

/**
 * 获取所有 API 版本
 */
router.get('/versions', async (req, res) => {
  const versions = await lifecycleManager.getActiveVersions();
  res.json({ versions });
});

/**
 * 获取版本详情
 */
router.get('/versions/:version', async (req, res) => {
  const version = await lifecycleManager.getVersionInfo(req.params.version);
  if (!version) {
    return res.status(404).json({ error: 'VERSION_NOT_FOUND' });
  }
  res.json(version);
});

/**
 * 获取版本使用统计
 */
router.get('/versions/:version/stats', async (req, res) => {
  const stats = await lifecycleManager.getVersionUsageStats(
    req.params.version,
    req.query.range || '7d'
  );
  res.json(stats);
});

/**
 * 废弃版本
 */
router.post('/versions/:version/deprecate', async (req, res) => {
  try {
    const result = await lifecycleManager.deprecateVersion(req.params.version, {
      sunsetDate: req.body.sunsetDate,
      message: req.body.message,
      reason: req.body.reason,
      changedBy: req.user?.id
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * 升级版本状态
 */
router.post('/versions/:version/promote', async (req, res) => {
  try {
    const result = await lifecycleManager.promoteVersion(
      req.params.version,
      req.body.lifecycle,
      {
        reason: req.body.reason,
        changedBy: req.user?.id
      }
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 支持 URL 路径版本标识（/v1/、/v2/）
- [ ] 支持 Accept Header 和自定义 Header 版本协商
- [ ] 版本生命周期管理（development → testing → stable → deprecated → sunset）
- [ ] 废弃版本自动添加 Deprecation 和 Sunset 响应头
- [ ] 下线版本返回 410 Gone 响应
- [ ] 版本间请求/响应数据自动转换
- [ ] 破坏性变更文档化并可查询
- [ ] 版本使用统计与监控
- [ ] 管理接口支持版本状态变更
- [ ] OpenAPI 文档按版本自动生成

## 影响范围

- **gateway**: 新增版本协商中间件、管理路由
- **所有微服务**: 适配版本化 API 路由
- **backend/shared**: 新增 apiVersion 模块
- **docs/api-spec**: 按版本组织 OpenAPI 文档
- **database/migrations**: 新增 API 版本管理表
- **game-client**: 更新 API 客户端支持版本协商

## 参考

- [API Versioning Best Practices](https://www.postman.com/api-platform/api-versioning/)
- [HTTP Deprecation Header RFC 8594](https://tools.ietf.org/html/rfc8594)
- [Semantic Versioning for APIs](https://semver.org/)
- [Stripe API Versioning](https://stripe.com/docs/api/versioning)
