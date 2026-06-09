# REQ-00044: API 版本管理与向后兼容策略

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00044 |
| 标题 | API 版本管理与向后兼容策略 |
| 类别 | API 设计规范 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、docs/api-spec |
| 创建时间 | 2026-06-09 03:00 |
| 依赖需求 | REQ-00008 (OpenAPI 文档与 API 设计规范统一) |

## 1. 背景与问题

当前 mineGo 项目已有 9 个微服务，暴露了大量 API 端点，但存在以下问题：

1. **缺少版本管理**: 所有 API 都在 `/api/` 路径下，没有版本区分，一旦发布无法修改
2. **向后兼容无保障**: 修改字段名、删除字段、改变响应结构都会破坏现有客户端
3. **废弃流程不明确**: 旧 API 没有明确的废弃通知和下线流程
4. **客户端适配困难**: 前端和移动端无法平滑迁移到新版本 API

### 当前风险
- 修改 API 可能导致 game-client 功能异常
- 无法安全地进行 API 演进和优化
- 缺少 API 变更的审计和通知机制

## 2. 目标

建立完整的 API 版本管理体系，实现：

1. **URL 路径版本控制**: `/api/v1/`, `/api/v2/` 明确区分
2. **向后兼容保障**: 新版本不破坏旧版本客户端
3. **废弃流程自动化**: 6 个月废弃周期，自动告警和下线
4. **版本协商机制**: 客户端可通过 Header 指定版本
5. **变更日志自动化**: 自动生成 API 变更文档

## 3. 范围

### 包含
- URL 路径版本控制中间件
- 版本路由注册系统
- 废弃 API 检测和告警
- 版本协商 Header 处理
- API 变更日志生成
- 版本迁移指南文档

### 不包含
- 数据库 schema 版本管理 (已有 REQ-00007)
- gRPC 版本管理 (当前仅 REST API)
- GraphQL 版本管理 (未使用)

## 4. 详细需求

### 4.1 URL 路径版本控制

```javascript
// backend/gateway/src/middleware/apiVersion.js

/**
 * API Version Middleware
 * 
 * Supports:
 * - URL path versioning: /api/v1/users, /api/v2/users
 * - Header version negotiation: Accept-Version: 2
 * - Default version fallback
 * - Deprecation warnings
 */

const API_VERSIONS = {
  1: {
    released: '2026-06-01',
    deprecated: null,      // Not deprecated
    sunset: null,          // No sunset date
    changes: [],
  },
  2: {
    released: '2026-06-09',
    deprecated: null,
    sunset: null,
    changes: [
      { type: 'added', path: '/api/v2/catch/nearby', description: '新增稀有度过滤参数' },
      { type: 'changed', path: '/api/v2/user/profile', description: '响应增加 stats 字段' },
    ],
  },
};

const CURRENT_VERSION = 2;
const SUPPORTED_VERSIONS = [1, 2];
const DEPRECATED_VERSIONS = []; // Versions pending deprecation

function apiVersionMiddleware(req, res, next) {
  // 1. Extract version from URL path
  const pathVersion = extractVersionFromPath(req.path);
  
  // 2. Check header version negotiation
  const headerVersion = parseInt(req.headers['accept-version'] || 0);
  
  // 3. Determine effective version
  let version = pathVersion || headerVersion || CURRENT_VERSION;
  
  // 4. Validate version
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return res.status(400).json({
      error: 'Unsupported API version',
      supportedVersions: SUPPORTED_VERSIONS,
      currentVersion: CURRENT_VERSION,
    });
  }
  
  // 5. Check deprecation
  const versionInfo = API_VERSIONS[version];
  if (versionInfo.deprecated) {
    res.setHeader('X-API-Deprecated', 'true');
    res.setHeader('X-API-Sunset', versionInfo.sunset);
    res.setHeader('X-API-Migration-Guide', `https://docs.minego.com/api/migration/v${version}-to-v${version + 1}`);
  }
  
  // 6. Set version context
  req.apiVersion = version;
  res.setHeader('X-API-Version', version);
  
  next();
}
```

### 4.2 版本路由注册

```javascript
// backend/gateway/src/routes/versioned.js

/**
 * Versioned Route Registration
 * 
 * Example:
 * registerVersionedRoute(app, {
 *   'GET /users': {
 *     v1: userRoutesV1.getUsers,
 *     v2: userRoutesV2.getUsers,
 *   },
 *   'POST /catch': {
 *     v1: catchRoutesV1.catchPokemon,
 *     v2: catchRoutesV2.catchPokemon,
 *   },
 * });
 */

function registerVersionedRoute(app, routes) {
  for (const [methodPath, handlers] of Object.entries(routes)) {
    const [method, path] = methodPath.split(' ');
    const methodLower = method.toLowerCase();
    
    for (const [version, handler] of Object.entries(handlers)) {
      const versionNum = parseInt(version.replace('v', ''));
      const versionedPath = `/api/v${versionNum}${path}`;
      
      app[methodLower](versionedPath, handler);
      
      // Register alias for current version
      if (versionNum === CURRENT_VERSION) {
        app[methodLower](`/api${path}`, handler);
      }
    }
  }
}
```

### 4.3 废弃 API 检测

```javascript
// backend/shared/deprecationTracker.js

class DeprecationTracker {
  constructor() {
    this.deprecatedEndpoints = new Map();
    this.usageStats = new Map();
  }
  
  /**
   * Mark endpoint as deprecated
   */
  deprecate(endpoint, options = {}) {
    const record = {
      endpoint,
      deprecatedAt: new Date(),
      sunsetAt: options.sunsetAt || new Date(Date.now() + 180 * 24 * 60 * 60 * 1000), // 6 months
      migrationGuide: options.migrationGuide,
      replacement: options.replacement,
      reason: options.reason,
      usageCount: 0,
    };
    
    this.deprecatedEndpoints.set(endpoint, record);
    this._saveDeprecationRecord(record);
  }
  
  /**
   * Track deprecated endpoint usage
   */
  trackUsage(endpoint, clientId) {
    if (this.deprecatedEndpoints.has(endpoint)) {
      const record = this.deprecatedEndpoints.get(endpoint);
      record.usageCount++;
      
      // Alert if usage is high
      if (record.usageCount % 100 === 0) {
        this._sendUsageAlert(endpoint, record);
      }
      
      // Log usage for analytics
      this._logUsage(endpoint, clientId);
    }
  }
  
  /**
   * Check if endpoint should be sunset
   */
  checkSunset() {
    const now = new Date();
    const toSunset = [];
    
    for (const [endpoint, record] of this.deprecatedEndpoints) {
      if (record.sunsetAt <= now) {
        toSunset.push({ endpoint, record });
      }
    }
    
    return toSunset;
  }
}
```

### 4.4 API 变更日志生成

```javascript
// scripts/generate-api-changelog.js

/**
 * Generate API changelog from OpenAPI spec diff
 */

async function generateChangelog(oldSpec, newSpec) {
  const changes = [];
  
  // Compare paths
  const oldPaths = Object.keys(oldSpec.paths);
  const newPaths = Object.keys(newSpec.paths);
  
  // Added endpoints
  for (const path of newPaths) {
    if (!oldPaths.includes(path)) {
      changes.push({
        type: 'added',
        path,
        methods: Object.keys(newSpec.paths[path]),
        impact: 'low',
      });
    }
  }
  
  // Removed endpoints
  for (const path of oldPaths) {
    if (!newPaths.includes(path)) {
      changes.push({
        type: 'removed',
        path,
        methods: Object.keys(oldSpec.paths[path]),
        impact: 'breaking',
      });
    }
  }
  
  // Modified endpoints
  for (const path of oldPaths.filter(p => newPaths.includes(p))) {
    const pathChanges = comparePath(oldSpec.paths[path], newSpec.paths[path]);
    changes.push(...pathChanges.map(c => ({ ...c, path })));
  }
  
  return generateChangelogMarkdown(changes);
}
```

### 4.5 版本迁移指南模板

```markdown
# API v1 → v2 迁移指南

## 变更概览

| 端点 | 变更类型 | 影响 |
|------|----------|------|
| GET /users | 响应结构变更 | 中 |
| POST /catch | 新增参数 | 低 |
| DELETE /pokemon/:id | 移除 | 高 |

## 详细变更

### GET /api/v2/users

**v1 响应:**
```json
{
  "id": "123",
  "username": "trainer",
  "email": "trainer@example.com"
}
```

**v2 响应:**
```json
{
  "id": "123",
  "username": "trainer",
  "email": "trainer@example.com",
  "stats": {
    "pokemonCaught": 150,
    "gymsVisited": 23
  }
}
```

**迁移步骤:**
1. 新增 `stats` 字段为可选，不影响现有代码
2. 如需使用统计数据，访问 `response.stats`

### POST /api/v2/catch

**新增参数:**
- `rarity` (可选): 过滤指定稀有度的精灵

**兼容性:** 完全向后兼容，旧客户端可忽略新参数

## 废弃时间线

- 2026-06-09: v2 发布，v1 进入维护模式
- 2026-12-09: v1 废弃，不再接受新功能
- 2027-06-09: v1 下线，返回 410 Gone
```

## 5. 验收标准（可测试）

- [ ] URL 路径版本控制中间件实现并集成
- [ ] 支持 `/api/v1/` 和 `/api/v2/` 路径
- [ ] Header 版本协商 `Accept-Version` 生效
- [ ] 废弃 API 自动添加 `X-API-Deprecated` 响应头
- [ ] 废弃 API 自动添加 `X-API-Sunset` 响应头
- [ ] 废弃 API 使用量统计和告警
- [ ] 版本路由注册系统实现
- [ ] 至少 3 个核心 API 支持多版本
- [ ] API 变更日志生成脚本实现
- [ ] v1 → v2 迁移指南文档编写
- [ ] 单元测试覆盖率 80% 以上

## 6. 工作量估算

**M (Medium)** - 约 2-3 天

理由:
- 版本控制中间件相对简单
- 需要为现有 API 创建 v2 版本
- 文档编写需要时间
- 测试覆盖多个场景

## 7. 优先级理由

**P1** - 高优先级

理由:
1. **API 演进基础**: 没有版本管理，API 无法安全演进
2. **生产安全**: 防止 API 变更导致客户端崩溃
3. **依赖 REQ-00008**: 已有 OpenAPI 规范，版本管理是自然延伸
4. **长期价值**: 为项目长期维护奠定基础

## 8. 影响范围

### 新增文件
- backend/gateway/src/middleware/apiVersion.js
- backend/gateway/src/routes/versioned.js
- backend/gateway/src/routes/v1/ (v1 版本路由)
- backend/gateway/src/routes/v2/ (v2 版本路由)
- backend/shared/deprecationTracker.js
- scripts/generate-api-changelog.js
- docs/api/migration/v1-to-v2.md
- backend/tests/unit/api-version.test.js

### 修改文件
- backend/gateway/src/index.js (集成版本中间件)
- docs/api-spec/openapi.yaml (添加版本信息)
- ARCHITECTURE.md (API 版本管理章节)

## 9. 参考

- [API Versioning Best Practices](https://www.postman.com/api-platform/api-versioning/)
- [Semantic Versioning for APIs](https://semver.org/)
- [Sunset Header RFC 8594](https://tools.ietf.org/html/rfc8594)
- REQ-00008: OpenAPI 文档与 API 设计规范统一
