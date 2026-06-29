# REQ-00368：API 内容协商与媒体类型管理系统

- **编号**：REQ-00368
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/middleware/contentNegotiation.js、docs/api-spec
- **创建时间**：2026-06-29 15:00 UTC
- **依赖需求**：REQ-00307（API 参数验证与响应格式一致性）、REQ-00302（API 分页标准化）

## 1. 背景与问题

当前 mineGo API 仅支持 JSON 响应格式，缺乏完整的内容协商（Content Negotiation）机制：

1. **Accept Header 未处理**：客户端发送 `Accept: application/json` 或其他媒体类型时，服务端未正确解析和响应，始终返回 JSON，无法支持未来可能需要的其他格式（如 Protobuf 用于高性能场景）。

2. **Content-Type 验证不完整**：POST/PUT 请求的 `Content-Type` 头未强制验证，可能接受非 JSON 内容导致解析错误，影响 API 安全性。

3. **媒体类型版本管理缺失**：API 演进时需要支持多版本响应格式（如 `application/vnd.minego.pokemon.v1+json`），当前缺乏版本协商机制。

4. **国际化响应格式需求**：部分客户端可能需要不同编码或压缩格式，当前响应头 `Content-Type` 缺少 `charset` 参数。

## 2. 目标

建立完整的 HTTP 内容协商体系，支持：

- 标准 Accept Header 解析与最佳匹配响应格式选择
- Content-Type 强制验证与拒绝非法格式
- 媒体类型注册表与自定义媒体类型管理
- Vary Header 正确设置（缓存优化）
- 406 Not Acceptable / 415 Unsupported Media Type 标准响应

为未来支持 Protobuf、MessagePack 等高性能序列化格式奠定基础。

## 3. 范围

- **包含**：
  - Accept Header 解析中间件
  - Content-Type 验证中间件
  - 媒体类型注册表与优先级管理
  - Vary Header 自动设置
  - 标准 HTTP 错误响应（406/415）
  - 自定义媒体类型命名规范文档
  - 单元测试覆盖

- **不包含**：
  - Protobuf/MessagePack 实际序列化实现（后续需求）
  - API 版本号路由切换（已由 REQ-00307 部分覆盖）
  - 响应压缩（已由现有 gzip 中间件处理）

## 4. 详细需求

### 4.1 Accept Header 解析中间件

```javascript
// backend/shared/middleware/contentNegotiation.js

/**
 * Accept Header 解析与媒体类型选择
 * 
 * 支持格式：
 * - application/json (默认)
 * - application/vnd.minego.{resource}.v{version}+json (自定义媒体类型)
 * 
 * RFC 7231 compliant: 支持权重 q 参数
 */

const MEDIA_TYPES = {
  'application/json': { priority: 1.0, serializer: 'json', charset: 'utf-8' },
  'application/vnd.minego.pokemon.v1+json': { priority: 1.1, serializer: 'json', charset: 'utf-8' },
  'application/vnd.minego.user.v1+json': { priority: 1.1, serializer: 'json', charset: 'utf-8' },
  'application/vnd.minego.catch.v1+json': { priority: 1.1, serializer: 'json', charset: 'utf-8' },
  '*/*': { priority: 0.1, fallback: 'application/json' }
};

function parseAcceptHeader(accept) {
  if (!accept) return [{ type: 'application/json', q: 1.0 }];
  
  return accept.split(',')
    .map(item => {
      const [type, ...params] = item.trim().split(';');
      const qParam = params.find(p => p.startsWith('q='));
      const q = qParam ? parseFloat(qParam.substring(2)) : 1.0;
      return { type: type.trim(), q };
    })
    .sort((a, b) => b.q - a.q);
}

function selectMediaType(acceptTypes) {
  for (const { type, q } of acceptTypes) {
    if (q <= 0) continue;
    
    const registered = MEDIA_TYPES[type];
    if (registered) {
      return { 
        contentType: type, 
        serializer: registered.serializer,
        charset: registered.charset
      };
    }
    
    // 通配符匹配
    if (type === '*/*') {
      return { 
        contentType: 'application/json', 
        serializer: 'json',
        charset: 'utf-8'
      };
    }
    
    // 类型通配符 application/*
    if (type.endsWith('/*')) {
      const baseType = type.replace('/*', '/json');
      if (MEDIA_TYPES[baseType]) {
        return { contentType: baseType, serializer: 'json', charset: 'utf-8' };
      }
    }
  }
  
  return null; // 无匹配
}

function contentNegotiationMiddleware(options = {}) {
  const defaultType = options.defaultType || 'application/json';
  const supportedTypes = options.supportedTypes || Object.keys(MEDIA_TYPES);
  
  return async (req, res, next) => {
    const acceptHeader = req.headers['accept'];
    const acceptTypes = parseAcceptHeader(acceptHeader);
    const selected = selectMediaType(acceptTypes);
    
    if (!selected) {
      // 406 Not Acceptable
      return res.status(406).json({
        success: false,
        error: {
          code: 'G1-000-406',
          message: 'Not Acceptable: No supported media type found',
          messageKey: 'error.media.not_acceptable',
          details: {
            accept: acceptHeader,
            supported: supportedTypes
          },
          requestId: req.requestId,
          docUrl: 'https://docs.minego.app/errors/G1-000-406',
          retryable: false,
          severity: 'warning'
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // 存储协商结果供后续使用
    req.negotiatedMediaType = selected;
    
    // 设置 Vary header 优化缓存
    res.setHeader('Vary', 'Accept');
    
    // 设置响应 Content-Type
    res.setHeader('Content-Type', `${selected.contentType}; charset=${selected.charset}`);
    
    next();
  };
}
```

### 4.2 Content-Type 验证中间件

```javascript
/**
 * Content-Type 验证中间件
 * 用于 POST/PUT/PATCH 请求
 */

function contentTypeValidationMiddleware(options = {}) {
  const allowedTypes = options.allowedTypes || ['application/json', 'application/vnd.minego.*+json'];
  
  return async (req, res, next) => {
    const method = req.method.toUpperCase();
    
    // 仅对有请求体的方法验证
    if (!['POST', 'PUT', 'PATCH'].includes(method)) {
      return next();
    }
    
    const contentType = req.headers['content-type'];
    
    if (!contentType) {
      // 415 Unsupported Media Type: 缺少 Content-Type
      return res.status(415).json({
        success: false,
        error: {
          code: 'G1-000-415',
          message: 'Unsupported Media Type: Content-Type header required',
          messageKey: 'error.media.content_type_required',
          details: {
            method,
            allowed: allowedTypes
          },
          requestId: req.requestId,
          docUrl: 'https://docs.minego.app/errors/G1-000-415',
          retryable: false,
          severity: 'warning'
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // 解析 Content-Type（忽略 charset 等参数）
    const [mediaType] = contentType.split(';');
    const normalizedType = mediaType.trim().toLowerCase();
    
    // 检查是否允许
    const isAllowed = allowedTypes.some(allowed => {
      if (allowed.endsWith('*')) {
        return normalizedType.startsWith(allowed.replace('*', ''));
      }
      return normalizedType === allowed.toLowerCase();
    });
    
    if (!isAllowed) {
      // 415 Unsupported Media Type
      return res.status(415).json({
        success: false,
        error: {
          code: 'G1-000-415',
          message: `Unsupported Media Type: ${mediaType} not supported`,
          messageKey: 'error.media.unsupported_content_type',
          details: {
            contentType: mediaType,
            allowed: allowedTypes
          },
          requestId: req.requestId,
          docUrl: 'https://docs.minego.app/errors/G1-000-415',
          retryable: false,
          severity: 'warning'
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // 验证请求体是否为有效 JSON
    if (normalizedType === 'application/json' || normalizedType.includes('+json')) {
      try {
        if (req.body && typeof req.body === 'object') {
          // Express body-parser 已解析，无需额外处理
          req.isJsonBody = true;
        }
      } catch (parseError) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'G1-000-400',
            message: 'Invalid JSON body',
            messageKey: 'error.media.invalid_json',
            details: {
              reason: parseError.message
            },
            requestId: req.requestId,
            retryable: false
          }
        });
      }
    }
    
    next();
  };
}
```

### 4.3 媒体类型注册表

```javascript
/**
 * 媒体类型注册表
 * 管理自定义媒体类型与版本
 */

const MediaTypeRegistry = {
  types: new Map(),
  
  register(config) {
    const { name, version, resource, serializer, charset, description } = config;
    const standardName = `application/vnd.minego.${resource}.v${version}+${serializer}`;
    
    this.types.set(standardName, {
      name: standardName,
      displayName: name,
      resource,
      version,
      serializer,
      charset: charset || 'utf-8',
      description,
      deprecated: false,
      createdAt: new Date().toISOString()
    });
    
    return standardName;
  },
  
  get(name) {
    return this.types.get(name);
  },
  
  listByResource(resource) {
    return Array.from(this.types.values())
      .filter(t => t.resource === resource)
      .sort((a, b) => b.version - a.version);
  },
  
  deprecate(name) {
    const type = this.types.get(name);
    if (type) {
      type.deprecated = true;
      type.deprecatedAt = new Date().toISOString();
    }
  },
  
  getActiveTypes() {
    return Array.from(this.types.values())
      .filter(t => !t.deprecated);
  }
};

// 初始化注册标准媒体类型
MediaTypeRegistry.register({
  name: 'Pokemon API v1',
  version: 1,
  resource: 'pokemon',
  serializer: 'json',
  description: 'Pokemon resource JSON format v1'
});

MediaTypeRegistry.register({
  name: 'User API v1',
  version: 1,
  resource: 'user',
  serializer: 'json',
  description: 'User resource JSON format v1'
});

MediaTypeRegistry.register({
  name: 'Catch API v1',
  version: 1,
  resource: 'catch',
  serializer: 'json',
  description: 'Catch resource JSON format v1'
});

MediaTypeRegistry.register({
  name: 'Gym API v1',
  version: 1,
  resource: 'gym',
  serializer: 'json',
  description: 'Gym resource JSON format v1'
});

module.exports = {
  contentNegotiationMiddleware,
  contentTypeValidationMiddleware,
  MediaTypeRegistry,
  parseAcceptHeader,
  selectMediaType,
  MEDIA_TYPES
};
```

### 4.4 自定义媒体类型命名规范

```
mineGo 自定义媒体类型规范 (RFC 6838)

格式: application/vnd.minego.{resource}.v{version}+{suffix}

组成部分:
- vnd: vendor-specific (供应商特定)
- minego: 项目标识符
- {resource}: 资源类型 (pokemon/user/catch/gym/social/reward/payment)
- v{version}: 版本号 (v1/v2/...)
- +{suffix}: 结构后缀 (+json/+protobuf/+msgpack)

示例:
- application/vnd.minego.pokemon.v1+json
- application/vnd.minego.user.v2+json
- application/vnd.minego.catch.v1+protobuf

版本策略:
- 新增字段：保持向后兼容，使用同一版本
- 删除字段：创建新版本，旧版本标记 deprecated
- 结构变更：必须创建新版本

弃用流程:
1. 标记 deprecated，响应头添加 Warning: 299
2. 维持 90 天兼容期
3. 移除弃用版本，返回 415
```

### 4.5 Gateway 集成

```javascript
// gateway/src/index.js - 添加中间件

const { 
  contentNegotiationMiddleware,
  contentTypeValidationMiddleware 
} = require('../../shared/middleware/contentNegotiation');

// 全局 Content-Type 验证（POST/PUT/PATCH）
app.use(contentTypeValidationMiddleware({
  allowedTypes: [
    'application/json',
    'application/vnd.minego.*+json'
  ]
}));

// 全局 Accept Header 协商
app.use(contentNegotiationMiddleware({
  defaultType: 'application/json',
  supportedTypes: [
    'application/json',
    'application/vnd.minego.pokemon.v1+json',
    'application/vnd.minego.user.v1+json',
    'application/vnd.minego.catch.v1+json',
    'application/vnd.minego.gym.v1+json',
    'application/vnd.minego.social.v1+json',
    'application/vnd.minego.reward.v1+json',
    'application/vnd.minego.payment.v1+json'
  ]
}));
```

## 5. 验收标准（可测试）

- [ ] Accept Header 为空或缺失时，默认返回 `application/json; charset=utf-8`
- [ ] Accept Header 包含支持的媒体类型时，响应 Content-Type 正确匹配
- [ ] Accept Header 包含多个媒体类型时，按 q 值优先级正确选择
- [ ] Accept Header 仅包含不支持的类型时，返回 406 Not Acceptable
- [ ] POST/PUT 请求缺少 Content-Type 时，返回 415 Unsupported Media Type
- [ ] POST/PUT 请求 Content-Type 为非法格式时，返回 415
- [ ] Vary: Accept 响应头正确设置
- [ ] 响应 Content-Type 包含 charset 参数
- [ ] MediaTypeRegistry 支持注册/查询/弃用操作
- [ ] 单元测试覆盖率 ≥ 90%

## 6. 工作量估算

**M (Medium)** - 约 2-3 天

- 中间件开发：1 天
- 媒体类型注册表：0.5 天
- Gateway 集成：0.5 天
- 单元测试与文档：1 天

## 7. 优先级理由

P1 理由：

1. **HTTP 标准 compliance**：内容协商是 HTTP/1.1 (RFC 7231) 核心规范，缺失影响 API 专业性
2. **国际化需求**：正确设置 charset 支持多语言客户端
3. **API 演进基础**：为未来版本化响应格式奠定架构基础
4. **安全性**：Content-Type 验证防止恶意请求体注入
5. **缓存优化**：Vary Header 正确设置提升 CDN/浏览器缓存效率

## 8. 相关文档

- RFC 7231 Section 5.3 (Content Negotiation)
- RFC 6838 (Media Type Specifications)
- mineGo API 错误码文档 (docs/api/error-codes.md)