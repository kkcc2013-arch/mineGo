# API 响应格式标准化规范

## 概述

本文档定义 mineGo 项目统一的 API 响应格式标准，确保所有微服务返回一致的数据结构。

## 标准响应格式

### 成功响应

#### 单个资源

```json
{
  "success": true,
  "data": {
    "id": "abc123",
    "name": "Pikachu"
  },
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-06-30T12:00:00Z"
  }
}
```

#### 列表资源（带分页）- 新标准化格式

```json
{
  "success": true,
  "data": [
    { "id": "1", "name": "Pikachu" },
    { "id": "2", "name": "Charizard" }
  ],
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-07-06T12:00:00Z",
    "pagination": {
      "type": "offset",
      "page": 1,
      "pageSize": 20,
      "total": 150,
      "totalPages": 8,
      "hasNext": true,
      "hasPrev": false,
      "nextCursor": null,
      "prevCursor": null
    }
  }
}
```

#### 游标分页格式（大数据量）

```json
{
  "success": true,
  "data": [
    { "id": "1", "name": "Pikachu" },
    { "id": "2", "name": "Charizard" }
  ],
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-07-06T12:00:00Z",
    "pagination": {
      "type": "cursor",
      "pageSize": 20,
      "hasNext": true,
      "hasPrev": false,
      "nextCursor": "eyJpZCI6MjAsImNyZWF0ZWRBdCI6IjIwMjYtMDctMDYifQ==",
      "prevCursor": null
    }
  }
}
```

### 错误响应

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient coins to purchase this item",
    "details": {
      "required": 1000,
      "available": 500
    },
    "i18nKey": "errors.payment.insufficient_balance",
    "docUrl": "https://docs.minego.game/errors/INSUFFICIENT_BALANCE"
  },
  "meta": {
    "requestId": "req-12345",
    "timestamp": "2026-06-30T12:00:00Z"
  }
}
```

## HTTP 状态码规范

| 状态码 | 使用场景 | 示例 |
|--------|---------|------|
| 200 OK | 成功请求 | 查询、更新 |
| 201 Created | 创建成功 | 新建精灵、订单 |
| 204 No Content | 删除成功 | 删除好友 |
| 400 Bad Request | 验证失败 | 参数错误 |
| 401 Unauthorized | 认证失败 | Token 过期 |
| 402 Payment Required | 余额不足 | 购买道具 |
| 403 Forbidden | 权限不足 | 无权访问 |
| 404 Not Found | 资源不存在 | 精灵不存在 |
| 409 Conflict | 资源冲突 | 重复创建 |
| 429 Too Many Requests | 限流 | 请求过多 |
| 500 Internal Server Error | 服务器错误 | 系统故障 |

## 业务错误码体系

错误码格式：`{模块}_{动作}_{原因}`

### 示例

- `USER_AUTH_TOKEN_EXPIRED` - 用户认证令牌过期
- `POKEMON_QUERY_NOT_FOUND` - 精灵查询不存在
- `PAYMENT_CREATE_INSUFFICIENT_BALANCE` - 支付创建余额不足

## 使用示例

### 后端代码

```javascript
const ApiResponse = require('../shared/utils/ApiResponse');
const { AppError } = require('../shared/middleware/errorHandler');

// 成功响应
async function getPokemon(req, res) {
  const pokemon = await Pokemon.findById(req.params.id);
  return ApiResponse.success(res, pokemon);
}

// 分页响应
async function listPokemons(req, res) {
  const { page, limit } = req.query;
  const { items, total } = await Pokemon.findAllPaginated(page, limit);
  return ApiResponse.paginated(res, items, { page, limit, total });
}

// 错误处理
async function evolvePokemon(req, res) {
  const pokemon = await Pokemon.findById(req.params.id);
  if (!pokemon) {
    throw new AppError('POKEMON_QUERY_NOT_FOUND', { id: req.params.id });
  }
  if (pokemon.candy < pokemon.evolutionCost) {
    throw new AppError('POKEMON_VALIDATE_INSUFFICIENT_CANDY', {
      required: pokemon.evolutionCost,
      available: pokemon.candy
    });
  }
  // ... 进化逻辑
  return ApiResponse.success(res, evolvedPokemon);
}
```

### 前端代码

```javascript
// 处理响应
async function fetchPokemon(id) {
  const res = await fetch(`/api/v1/pokemon/${id}`);
  const data = await res.json();

  if (data.success) {
    return data.data; // 直接获取数据
  } else {
    // 使用 i18nKey 显示本地化错误
    const errorMsg = i18n.t(data.error.i18nKey, data.error.details);
    throw new Error(errorMsg);
  }
}
```

## 迁移指南

### 迁移前

```javascript
// 不一致的响应格式
res.json({ user: user }); // 直接对象
res.json({ success: true, data: { ... } }); // 混合格式
res.status(400).json({ error: 'error message' }); // 无错误码
```

### 迁移后

```javascript
const ApiResponse = require('../../../shared/utils/ApiResponse');

// 统一格式
ApiResponse.success(res, user);
ApiResponse.paginated(res, items, { page, limit, total });
throw new AppError('VALIDATION_ERROR', details);
```

## 最佳实践

1. **始终使用 ApiResponse 工具类**，避免手动构造响应
2. **使用预定义的错误码**，不随意创建新错误码
3. **提供错误详情**，帮助前端调试和用户理解
4. **记录 requestId**，便于日志追踪和问题排查
5. **渐进式迁移**，优先迁移高频使用的 API

## 相关文档

- [ErrorCodes.js](../../backend/shared/errors/ErrorCodes.js) - 错误码定义
- [ApiResponse.js](../../backend/shared/utils/ApiResponse.js) - 响应工具类
- [errorHandler.js](../../backend/shared/middleware/errorHandler.js) - 错误处理中间件
- [OpenAPI 规范](../api-spec/openapi.yaml) - API 文档

## 分页规范（REQ-00465）

### 分页参数

所有分页接口必须使用以下标准化参数：

| 参数名 | 类型 | 默认值 | 最大值 | 说明 |
|--------|------|--------|--------|------|
| `page` | integer | 1 | - | 页码（offset-based）|
| `pageSize` | integer | 20 | 100 | 每页数量 |
| `cursor` | string | - | - | 游标（cursor-based）|
| `direction` | string | 'next' | - | 游标方向（next/prev）|

**弃用参数**（向后兼容但建议迁移）：
- `offset` → 使用 `page`
- `limit` → 使用 `pageSize`
- `size` → 使用 `pageSize`

### 分页响应元数据

所有分页响应必须在 `meta.pagination` 中包含以下字段：

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `type` | string | ✓ | 分页类型：offset 或 cursor |
| `page` | integer | ✓ (offset) | 当前页码 |
| `pageSize` | integer | ✓ | 每页数量 |
| `total` | integer | ○ | 总记录数（可选，大数据量时可不计算）|
| `totalPages` | integer | ○ | 总页数（可选）|
| `hasNext` | boolean | ✓ | 是否有下一页 |
| `hasPrev` | boolean | ✓ | 是否有上一页 |
| `nextCursor` | string | ✓ (cursor) | 下一页游标 |
| `prevCursor` | string | ✓ (cursor) | 上一页游标 |

### 分页策略选择

| 场景 | 推荐策略 | 说明 |
|------|----------|------|
| 小数据量（<1000条）| Offset 分页 | 支持跳页，用户体验好 |
| 大数据量（>1000条）| Cursor 分页 | 避免 offset 性能问题 |
| 深分页（offset>1000）| Cursor 分页 | 必须，否则性能下降 |
| 实时数据流 | Cursor 分页 | 避免数据遗漏/重复 |

### 使用示例

#### Offset 分页

```bash
# 请求
GET /api/v1/pokemon?page=2&pageSize=20

# 响应
{
  "success": true,
  "data": [...],
  "meta": {
    "pagination": {
      "type": "offset",
      "page": 2,
      "pageSize": 20,
      "total": 150,
      "totalPages": 8,
      "hasNext": true,
      "hasPrev": true
    }
  }
}
```

#### Cursor 分页

```bash
# 首次请求
GET /api/v1/pokemon?pageSize=20

# 后续请求
GET /api/v1/pokemon?cursor=eyJpZCI6MjB9&pageSize=20&direction=next

# 响应
{
  "success": true,
  "data": [...],
  "meta": {
    "pagination": {
      "type": "cursor",
      "pageSize": 20,
      "hasNext": true,
      "hasPrev": true,
      "nextCursor": "eyJpZCI6NDAsImNyZWF0ZWRBdCI6IjIwMjYtMDctMDYifQ==",
      "prevCursor": "eyJpZCI6MjAsImNyZWF0ZWRBdCI6IjIwMjYtMDctMDYifQ=="
    }
  }
}
```

### 性能对比

| 分页类型 | offset=100 | offset=10000 | 说明 |
|----------|------------|--------------|------|
| Offset | ~10ms | ~500ms | 性能随 offset 增大下降 |
| Cursor | ~10ms | ~10ms | 性能稳定，不受游标位置影响 |

### 实现参考

```javascript
const { createPaginationMiddleware, createCursorPaginator } = require('../shared/pagination');

// 使用分页中间件
const pagination = createPaginationMiddleware({
  defaultPageSize: 20,
  maxPageSize: 100
});

router.get('/pokemon',
  pagination.parseParams,
  pagination.wrapResponse,
  async (req, res) => {
    const { page, pageSize, cursor } = req.pagination;
    
    if (cursor) {
      const paginator = createCursorPaginator(db, 'pokemon_instances');
      const result = await paginator.query(cursor, pageSize);
      pagination.instance.setPaginationResult(req, result);
      res.json({ success: true, data: result.items });
    } else {
      const items = await db('pokemon_instances')
        .offset((page - 1) * pageSize)
        .limit(pageSize);
      const total = await db('pokemon_instances').count().first();
      
      pagination.instance.setPaginationResult(req, {
        items,
        total: total.count,
        type: 'offset'
      });
      
      res.json({ success: true, data: items });
    }
  }
);
```

---

**创建时间**：2026-06-30
**最后更新**：2026-07-06
**维护者**：mineGo 开发团队