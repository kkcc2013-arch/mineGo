# REQ-00518：API 超媒体链接（HATEOAS）与资源发现系统

- **编号**：REQ-00518
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/utils/ApiResponse.js、gateway/src/middleware、所有后端服务、game-client
- **创建时间**：2026-07-09 01:00
- **依赖需求**：REQ-00465（分页标准化）、REQ-00008（OpenAPI 文档）

## 1. 背景与问题

当前 mineGo API 响应格式已标准化（REQ-00465、api-guidelines.md），统一了 `success/data/meta` 结构和分页参数。但响应中缺少 **超媒体链接（HATEOAS）** 支持：

**痛点分析**：
1. **前端硬编码 URL**：game-client 需要手动拼接各资源 URL，如 `/api/v1/pokemon/${id}/evolve`、`/api/v1/gym/${id}/battle`
2. **资源关系不可发现**：返回精灵数据时，无法自动知道"该精灵可进化"、"所属道馆"、"可交易"等关联链接
3. **API 版本升级困难**：URL 结构变化时，前端需要逐处修改，无法自动适应
4. **不符合 RESTful 最佳实践**：HATEOAS 是 REST 架构的核心约束之一，当前实现仅为"REST-like"

**实际案例**：
```javascript
// 当前：前端硬编码
const pokemon = await fetch(`/api/v1/pokemon/${id}`);
// 想进化？需要前端知道进化 URL
const evolveUrl = `/api/v1/pokemon/${id}/evolve`;  // 硬编码

// 理想：API 响应包含可用操作
{
  "data": { "id": "p001", "name": "Pikachu" },
  "_links": {
    "self": { "href": "/api/v1/pokemon/p001" },
    "evolve": { "href": "/api/v1/pokemon/p001/evolve" },
    "trade": { "href": "/api/v1/trade?pokemon=p001" }
  }
}
```

## 2. 目标

为 mineGo API 添加 HATEOAS 超媒体链接支持，实现：
- API 响应自动包含 `_links` 字段，提供资源自描述
- 前端可通过链接动态发现可用操作，减少硬编码
- 支持 HAL（Hypertext Application Language）标准格式
- 支持资源级、集合级、操作级三类链接
- 提升 API 可发现性和客户端灵活性

## 3. 范围

- **包含**：
  - LinksBuilder 链接构建器（资源链接、分页链接、操作链接）
  - ApiResponse 扩展 `_links` 支持
  - LinkRegistry 链接注册中心（模板、条件判断）
  - HAL 格式序列化器
  - 前端 LinkNavigator 链接导航工具
  - 核心资源链接定义（Pokemon、Gym、User、Trade、Battle）
  - API 文档示例更新

- **不包含**：
  - 全量 API 改造（渐进式，优先核心资源）
  - 复杂条件链接（如权限判断链接可见性）的完整实现
  - 客户端自动表单提交（仅提供 URL 发现）

## 4. 详细需求

### 4.1 链接格式规范（HAL 标准）

```json
{
  "success": true,
  "data": { "id": "p001", "name": "Pikachu", "level": 25 },
  "_links": {
    "self": { "href": "/api/v1/pokemon/p001" },
    "collection": { "href": "/api/v1/pokemon" },
    "evolve": {
      "href": "/api/v1/pokemon/p001/evolve",
      "method": "POST",
      "title": "进化精灵"
    },
    "transfer": {
      "href": "/api/v1/pokemon/p001/transfer",
      "method": "DELETE",
      "title": "转移精灵"
    },
    "trainer": {
      "href": "/api/v1/users/u123",
      "title": "所属训练师"
    }
  },
  "_embedded": {
    "trainer": { "id": "u123", "name": "Ash" }
  },
  "meta": { "requestId": "req-001", "timestamp": "..." }
}
```

### 4.2 分页链接（列表资源）

```json
{
  "success": true,
  "data": [...],
  "_links": {
    "self": { "href": "/api/v1/pokemon?page=2&pageSize=20" },
    "first": { "href": "/api/v1/pokemon?page=1&pageSize=20" },
    "prev": { "href": "/api/v1/pokemon?page=1&pageSize=20" },
    "next": { "href": "/api/v1/pokemon?page=3&pageSize=20" },
    "last": { "href": "/api/v1/pokemon?page=8&pageSize=20" }
  },
  "meta": {
    "pagination": { "page": 2, "pageSize": 20, "total": 150 }
  }
}
```

### 4.3 LinksBuilder 链接构建器

```javascript
// backend/shared/utils/LinksBuilder.js
class LinksBuilder {
  constructor(baseUrl = '/api/v1') {
    this.baseUrl = baseUrl;
    this.registry = new LinkRegistry();
  }

  // 资源链接
  resourceLink(resourceType, id) {
    return { href: `${this.baseUrl}/${resourceType}/${id}` };
  }

  // 操作链接（带条件和模板）
  actionLink(resourceType, id, action, options = {}) {
    const template = this.registry.getActionTemplate(resourceType, action);
    if (!template) return null;

    // 条件判断（如精灵是否可进化）
    if (template.condition && !template.condition(options.entity)) {
      return null;
    }

    return {
      href: template.href.replace('{id}', id),
      method: template.method,
      title: template.title,
      templated: template.templated
    };
  }

  // 分页链接
  paginationLinks(baseUrl, page, pageSize, totalPages) {
    const links = {
      self: { href: `${baseUrl}?page=${page}&pageSize=${pageSize}` },
      first: { href: `${baseUrl}?page=1&pageSize=${pageSize}` },
      last: { href: `${baseUrl}?page=${totalPages}&pageSize=${pageSize}` }
    };
    if (page > 1) links.prev = { href: `${baseUrl}?page=${page-1}&pageSize=${pageSize}` };
    if (page < totalPages) links.next = { href: `${baseUrl}?page=${page+1}&pageSize=${pageSize}` };
    return links;
  }

  // 构建完整链接对象
  build(options) {
    const links = {};
    if (options.self) links.self = this.resourceLink(options.type, options.id);
    if (options.collection) links.collection = { href: `${this.baseUrl}/${options.type}` };
    if (options.actions) {
      options.actions.forEach(action => {
        const link = this.actionLink(options.type, options.id, action, options);
        if (link) links[action] = link;
      });
    }
    return links;
  }
}
```

### 4.4 LinkRegistry 链接注册中心

```javascript
// backend/shared/registry/LinkRegistry.js
class LinkRegistry {
  constructor() {
    this.templates = {
      pokemon: {
        self: { href: '/pokemon/{id}', method: 'GET', title: '精灵详情' },
        collection: { href: '/pokemon', method: 'GET', title: '精灵列表' },
        evolve: {
          href: '/pokemon/{id}/evolve',
          method: 'POST',
          title: '进化精灵',
          condition: (entity) => entity.canEvolve && entity.candy >= entity.evolutionCost
        },
        transfer: { href: '/pokemon/{id}/transfer', method: 'DELETE', title: '转移精灵' },
        powerUp: {
          href: '/pokemon/{id}/powerUp',
          method: 'POST',
          title: '强化精灵',
          condition: (entity) => entity.stardust >= entity.powerUpCost
        },
        setFavorite: { href: '/pokemon/{id}/favorite', method: 'PUT', title: '设为收藏' }
      },
      gym: {
        self: { href: '/gym/{id}', method: 'GET', title: '道馆详情' },
        battle: { href: '/gym/{id}/battle', method: 'POST', title: '挑战道馆' },
        defend: { href: '/gym/{id}/defend', method: 'PUT', title: '防守道馆' }
      },
      user: {
        self: { href: '/users/{id}', method: 'GET', title: '用户详情' },
        profile: { href: '/users/{id}/profile', method: 'GET', title: '用户资料' },
        inventory: { href: '/users/{id}/inventory', method: 'GET', title: '道具背包' },
        friends: { href: '/users/{id}/friends', method: 'GET', title: '好友列表' }
      },
      trade: {
        self: { href: '/trade/{id}', method: 'GET', title: '交易详情' },
        accept: { href: '/trade/{id}/accept', method: 'POST', title: '接受交易' },
        cancel: { href: '/trade/{id}/cancel', method: 'DELETE', title: '取消交易' }
      }
    };
  }

  getActionTemplate(resourceType, action) {
    return this.templates[resourceType]?.[action];
  }

  getAvailableActions(resourceType, entity) {
    const templates = this.templates[resourceType] || {};
    return Object.entries(templates)
      .filter(([action, template]) => {
        if (!template.condition) return true;
        return template.condition(entity);
      })
      .map(([action]) => action);
  }
}
```

### 4.5 ApiResponse 扩展

```javascript
// 扩展 ApiResponse.js
class ApiResponse {
  // ... 现有方法

  /**
   * 带链接的成功响应
   */
  static withLinks(res, data, links, options = {}) {
    const response = {
      success: true,
      data,
      _links: links,
      meta: this._generateMeta(res, options)
    };
    return res.status(options.status || 200).json(response);
  }

  /**
   * 带链接的分页响应
   */
  static paginatedWithLinks(res, items, pagination, baseUrl, options = {}) {
    const { page, pageSize, total } = pagination;
    const totalPages = Math.ceil(total / pageSize);

    const linksBuilder = new LinksBuilder();
    const links = linksBuilder.paginationLinks(baseUrl, page, pageSize, totalPages);

    const response = {
      success: true,
      data: items,
      _links: links,
      meta: {
        ...this._generateMeta(res, options),
        pagination: { page, pageSize, total, totalPages, hasNext: page < totalPages }
      }
    };
    return res.status(200).json(response);
  }

  /**
   * HAL 格式响应（带嵌入资源）
   */
  static hal(res, data, links, embedded = {}, options = {}) {
    const response = {
      success: true,
      data,
      _links: links,
      _embedded: embedded,
      meta: this._generateMeta(res, options)
    };
    return res.status(options.status || 200).json(response);
  }
}
```

### 4.6 前端 LinkNavigator 工具

```javascript
// game-client/src/utils/LinkNavigator.js
class LinkNavigator {
  constructor(response) {
    this.links = response._links || {};
    this.data = response.data;
  }

  // 获取链接
  getLink(rel) {
    return this.links[rel]?.href;
  }

  // 获取所有可用操作
  getAvailableActions() {
    return Object.keys(this.links).filter(k => 
      k !== 'self' && k !== 'collection' && k !== 'first' && k !== 'last'
    );
  }

  // 构建请求（带方法）
  buildRequest(rel, body = null) {
    const link = this.links[rel];
    if (!link) throw new Error(`Link '${rel}' not found`);

    return {
      url: link.href,
      method: link.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null
    };
  }

  // 执行操作
  async execute(rel, body = null) {
    const req = this.buildRequest(rel, body);
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body
    });
    return response.json();
  }

  // 判断操作是否可用
  can(rel) {
    return !!this.links[rel];
  }
}

// 使用示例
const response = await fetch('/api/v1/pokemon/p001');
const navigator = new LinkNavigator(response);

// 动态发现可进化
if (navigator.can('evolve')) {
  await navigator.execute('evolve', { candy: 50 });
}
```

### 4.7 核心资源链接定义

优先为以下核心资源添加链接：
- Pokemon：self, collection, evolve, transfer, powerUp, setFavorite, trainer
- Gym：self, battle, defend, nearby
- User：self, profile, inventory, friends, achievements, pokemon
- Trade：self, accept, cancel, initiator, receiver
- Battle：self, result, replay

## 5. 验收标准（可测试）

- [ ] LinksBuilder 单元测试覆盖 ≥ 90%（链接构建、条件判断、分页链接）
- [ ] ApiResponse withLinks/paginatedWithLinks/hal 方法可用且格式符合 HAL 标准
- [ ] LinkRegistry 包含 Pokemon、Gym、User、Trade 链接模板定义
- [ ] 至少 3 个核心资源 API（Pokemon 详情、Pokemon 列表、Gym 详情）返回 `_links`
- [ ] 前端 LinkNavigator 工具可解析链接并执行操作
- [ ] api-guidelines.md 包含 HATEOAS 链接规范章节
- [ ] 集成测试验证链接导航流程（精灵详情 → 进化操作）

## 6. 工作量估算

**M（中等）**：
- LinksBuilder + LinkRegistry：约 3,000 行代码
- ApiResponse 扩展：约 500 行
- 前端 LinkNavigator：约 800 行
- 核心资源链接定义：约 1,000 行配置
- 测试代码：约 2,000 行
- 文档更新：约 500 行

预估 2-3 个工作日完成核心实现。

## 7. 优先级理由

**P1 理由**：
1. **API 设计核心**：HATEOAS 是 RESTful 架构的核心约束，影响 API 可发现性和客户端灵活性
2. **前端解耦**：减少前端硬编码 URL，降低 URL 变化时的维护成本
3. **下游依赖**：后续 API 版本管理、客户端 SDK 自动化生成可依赖此能力
4. **渐进实现**：可先支持核心资源，不影响现有 API 兼容性

对"项目可用"贡献：提升 API 规范成熟度，从"REST-like"迈向真正的 RESTful。