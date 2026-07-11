# REQ-00518：API 超媒体链接（HATEOAS）与资源发现系统

- **编号**：REQ-00518
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/utils/ApiResponse.js、gateway/src/middleware、所有后端服务、game-client
- **创建时间**：2026-07-09 01:00
- **依赖需求**：无

## 1. 背景与问题

当前 API 设计遵循 RESTful 规范，但缺乏 HATEOAS（Hypermedia as the Engine of Application State）支持：

**现有痛点：**
1. API 响应不包含资源链接，客户端需要硬编码 URL 路径
2. 缺乏资源发现机制，客户端需要预先知道所有端点
3. API 版本升级时，客户端需要手动更新所有 URL
4. 缺乏资源关联信息（如精灵资源的"捕捉"、"训练"等操作链接）
5. 不符合 Richardson 成熟度模型 Level 3（最高级 REST）

## 2. 目标

建立完整的 HATEOAS 支持，实现：
- API 响应自动包含资源链接（self、next、prev、related 等）
- 资源发现端点（/api/discover）
- 标准化的链接格式（HAL 规范）
- 客户端自动发现和导航能力
- API 版本兼容性提示

## 3. 范围

- **包含**：
  - ApiResponse 增强器（添加 HATEOAS 链接）
  - LinkBuilder 链接构建器
  - ResourceDiscoverer 资源发现器
  - HalFormatter HAL 格式化器
  - 客户端资源导航工具

- **不包含**：
  - API 版本管理（已有 apiVersionManager）
  - API 文档生成（已有 Swagger）
  - GraphQL 支持

## 4. 详细需求

### 4.1 ApiResponse 增强器

```javascript
class ApiResponseEnhancer {
  // 为响应添加标准链接
  enhanceWithLinks(response, resource, resourceId, links)
  
  // 标准链接模板
  standardLinks: {
    self: '/api/v1/{resource}/{id}',
    collection: '/api/v1/{resource}',
    next: '/api/v1/{resource}?page={page+1}',
    prev: '/api/v1/{resource}?page={page-1}',
    related: '/api/v1/{resource}/{id}/{relatedResource}'
  }
  
  // 自动推导关联链接
  inferRelatedLinks(resource, resourceId, relationships)
}
```

### 4.2 LinkBuilder 链接构建器

```javascript
class LinkBuilder {
  // 核心方法
  buildSelfLink(resource, id)
  buildCollectionLink(resource, query = {})
  buildPaginationLinks(baseUrl, page, totalPages)
  buildRelatedLink(resource, id, relatedResource)
  buildActionLink(resource, id, action)
  
  // 链接格式
  linkFormat: {
    href: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    title: string,
    templated: boolean,
    type: string
  }
}
```

### 4.3 HalFormatter HAL 格式化器

```javascript
class HalFormatter {
  // HAL 格式
  formatResource(data, links, embedded = {})
  formatCollection(items, links, pagination)
  
  // HAL 标准结构
  halStructure: {
    _links: {
      self: { href: '/api/v1/pokemon/123' },
      next: { href: '/api/v1/pokemon/124' },
      catch: { href: '/api/v1/pokemon/123/catch', method: 'POST' }
    },
    _embedded: {
      stats: { ... }
    }
  }
}
```

### 4.4 ResourceDiscoverer 资源发现器

```javascript
class ResourceDiscoverer {
  // 发现端点
  async discover(baseUrl)
  async getEndpoints(serviceUrl)
  async getResourceSchema(resourceType)
  
  // 缓存
  discoveryCache: new Map()
  cacheTTL: 3600  // 1 小时
  
  // 返回结构
  discoveryResponse: {
    _links: {
      self: { href: '/api/discover' },
      pokemon: { href: '/api/v1/pokemon', title: 'Pokemon Collection' },
      gyms: { href: '/api/v1/gyms', title: 'Gym Collection' },
      users: { href: '/api/v1/users', title: 'User Collection' }
    },
    _meta: {
      api_version: '1.0.0',
      documentation: '/api/docs',
      server_time: ISO8601
    }
  }
}
```

### 4.5 客户端资源导航

```javascript
class ResourceNavigator {
  // 导航方法
  async navigate(linkName)
  async followLink(link)
  async discoverResources(baseUrl)
  
  // 缓存链接
  linkCache: new Map()
}
```

## 5. 验收标准（可测试）

- [ ] 所有 API 响应包含 `_links` 字段
- [ ] 分页响应包含 `first/prev/next/last` 链接
- [ ] 资源包含可执行操作的链接（如精灵的 `catch` 链接）
- [ ] `/api/discover` 端点返回所有可用资源链接
- [ ] 链接格式符合 HAL 规范
- [ ] 客户端可通过链接导航，无需硬编码 URL
- [ ] 单元测试覆盖：LinkBuilder、HalFormatter、ResourceDiscoverer 各 10+ 用例
- [ ] 集成测试：完整资源发现和导航流程

## 6. 工作量估算

M（Medium）
- ApiResponse 增强需要修改所有路由
- LinkBuilder 需要了解各资源关系
- 需要与现有 API 版本管理集成
- 客户端需要更新以支持链接导航

## 7. 优先级理由

P1 级别：
- HATEOAS 是 RESTful API 成熟度的最高级别
- 对 API 可维护性和客户端开发效率贡献显著
- 减少客户端硬编码，提高 API 版本兼容性