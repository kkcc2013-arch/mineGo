# REQ-00465：API 响应分页标准化与性能优化系统

- **编号**：REQ-00465
- **类别**：API 设计规范
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/pagination、gateway、所有微服务
- **创建时间**：2026-07-06 17:00 UTC
- **依赖需求**：api-guidelines.md（已存在）、REQ-00257（API回归测试已完成）

## 1. 背景与问题

当前 mineGo 项目多个微服务的分页响应存在不一致问题：

1. **分页参数不统一**：各服务使用不同的分页参数命名（page/pageSize、offset/limit、cursor）
2. **响应格式不一致**：有的返回 total、有的返回 hasNext、有的缺少分页元数据
3. **性能问题**：大 offset 查询性能差（如 offset=10000），未使用 cursor-based pagination
4. **客户端适配困难**：前端需要针对不同服务编写不同的分页逻辑
5. **缺少分页最佳实践**：无明确的分页策略选择指南

**代码现状**：
- `pokemon-service` 使用 `page/pageSize` 参数
- `social-service` 使用 `offset/limit` 参数
- `gym-service` 部分接口缺少分页元数据
- 大数据量查询（精灵列表、好友列表）未使用游标分页

## 2. 目标

构建统一的 API 分页标准化系统：

1. **统一分页参数**：标准化分页参数命名和默认值
2. **统一响应格式**：所有分页响应包含相同的元数据结构
3. **智能分页策略**：根据数据量自动选择 offset-based 或 cursor-based 分页
4. **性能优化**：游标分页避免大 offset 性能问题
5. **分页中间件**：统一的分页参数解析和响应包装中间件

## 3. 范围

### 包含
- 分页参数标准化规范
- 分页响应元数据格式规范
- 统一分页中间件实现
- 游标分页（Cursor Pagination）实现
- 智能分页策略选择器
- 各微服务分页接口迁移
- 分页性能优化测试
- 文档更新

### 不包含
- API 响应格式规范（已存在 api-guidelines.md）
- API 回归测试（REQ-00257 已完成）
- 新增业务接口

## 4. 详细需求

### 4.1 分页参数标准化

**统一参数命名**：

| 参数名 | 类型 | 默认值 | 最大值 | 说明 |
|--------|------|--------|--------|------|
| `page` | integer | 1 | - | 页码（offset-based） |
| `pageSize` | integer | 20 | 100 | 每页数量 |
| `cursor` | string | - | - | 游标（cursor-based） |
| `direction` | string | 'next' | - | 游标方向（next/prev） |

**弃用参数**：
- `offset` → 使用 `page`
- `limit` → 使用 `pageSize`
- `size` → 使用 `pageSize`

### 4.2 分页响应元数据格式

```json
{
  "success": true,
  "data": [...],
  "meta": {
    "requestId": "req-xxx",
    "timestamp": "2026-07-06T17:00:00Z",
    "pagination": {
      "type": "offset | cursor",
      "page": 1,
      "pageSize": 20,
      "total": 1000,
      "totalPages": 50,
      "hasNext": true,
      "hasPrev": false,
      "nextCursor": "eyJpZCI6MjB9",
      "prevCursor": null
    }
  }
}
```

**元数据字段说明**：

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `type` | string | ✓ | 分页类型：offset 或 cursor |
| `page` | integer | ✓ (offset) | 当前页码 |
| `pageSize` | integer | ✓ | 每页数量 |
| `total` | integer | ○ | 总记录数（可选，大数据量时可不计算） |
| `totalPages` | integer | ○ | 总页数（可选） |
| `hasNext` | boolean | ✓ | 是否有下一页 |
| `hasPrev` | boolean | ✓ | 是否有上一页 |
| `nextCursor` | string | ✓ (cursor) | 下一页游标 |
| `prevCursor` | string | ✓ (cursor) | 上一页游标 |

### 4.3 分页中间件实现

创建 `backend/shared/pagination/PaginationMiddleware.js`：

```javascript
/**
 * 统一分页中间件
 * 自动解析分页参数并注入到请求对象
 */
class PaginationMiddleware {
  constructor(options = {}) {
    this.defaultPageSize = options.defaultPageSize || 20;
    this.maxPageSize = options.maxPageSize || 100;
    this.cursorThreshold = options.cursorThreshold || 1000;
  }

  /**
   * 解析分页参数
   */
  parsePaginationParams(req, res, next) {
    const { page, pageSize, cursor, direction } = req.query;
    
    // 验证参数
    const parsed = {
      page: Math.max(1, parseInt(page) || 1),
      pageSize: Math.min(this.maxPageSize, Math.max(1, parseInt(pageSize) || this.defaultPageSize)),
      cursor: cursor || null,
      direction: direction === 'prev' ? 'prev' : 'next'
    };
    
    req.pagination = parsed;
    next();
  }

  /**
   * 包装分页响应
   */
  wrapPaginatedResponse(req, res, next) {
    const originalJson = res.json.bind(res);
    
    res.json = (data) => {
      if (req.pagination && data.success && Array.isArray(data.data)) {
        data.meta.pagination = this.buildPaginationMeta(req, data.data);
      }
      return originalJson(data);
    };
    
    next();
  }

  /**
   * 构建分页元数据
   */
  buildPaginationMeta(req, items) {
    const { page, pageSize, cursor, total } = req.pagination;
    
    if (cursor) {
      return {
        type: 'cursor',
        pageSize,
        hasNext: items.length === pageSize,
        hasPrev: cursor !== null,
        nextCursor: items.length > 0 ? this.encodeCursor(items[items.length - 1]) : null,
        prevCursor: cursor ? this.encodeCursor(items[0]) : null
      };
    } else {
      const totalPages = total ? Math.ceil(total / pageSize) : null;
      return {
        type: 'offset',
        page,
        pageSize,
        total: total || null,
        totalPages,
        hasNext: totalPages ? page < totalPages : items.length === pageSize,
        hasPrev: page > 1
      };
    }
  }

  /**
   * 编码游标
   */
  encodeCursor(item) {
    return Buffer.from(JSON.stringify({ id: item.id, createdAt: item.createdAt })).toString('base64');
  }

  /**
   * 解码游标
   */
  decodeCursor(cursor) {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64').toString());
    } catch {
      return null;
    }
  }
}

module.exports = PaginationMiddleware;
```

### 4.4 游标分页实现

创建 `backend/shared/pagination/CursorPaginator.js`：

```javascript
/**
 * 游标分页器
 * 用于大数据量查询，避免 offset 性能问题
 */
class CursorPaginator {
  constructor(db, tableName, options = {}) {
    this.db = db;
    this.tableName = tableName;
    this.cursorField = options.cursorField || 'id';
    this.orderField = options.orderField || 'createdAt';
    this.orderDirection = options.orderDirection || 'DESC';
  }

  /**
   * 游标查询
   */
  async query(cursor, pageSize, direction = 'next') {
    const cursorData = this.decodeCursor(cursor);
    
    let query = this.db(this.tableName)
      .select('*')
      .limit(pageSize + 1);  // 多取一条判断 hasNext
    
    if (cursorData) {
      if (direction === 'next') {
        query = query.where(this.orderField, '<', cursorData[this.orderField])
          .orWhere(function() {
            this.where(this.orderField, '=', cursorData[this.orderField])
              .where(this.cursorField, '>', cursorData[this.cursorField]);
          });
      } else {
        query = query.where(this.orderField, '>', cursorData[this.orderField])
          .orWhere(function() {
            this.where(this.orderField, '=', cursorData[this.orderField])
              .where(this.cursorField, '<', cursorData[this.cursorField]);
          });
      }
    }
    
    query = query.orderBy(this.orderField, direction === 'next' ? 'desc' : 'asc')
      .orderBy(this.cursorField, direction === 'next' ? 'asc' : 'desc');
    
    const items = await query;
    
    // 移除多取的一条
    const hasNext = items.length > pageSize;
    if (hasNext) items.pop();
    
    return {
      items,
      hasNext,
      nextCursor: hasNext ? this.encodeCursor(items[items.length - 1]) : null
    };
  }

  encodeCursor(item) {
    return Buffer.from(JSON.stringify({
      [this.cursorField]: item[this.cursorField],
      [this.orderField]: item[this.orderField]
    })).toString('base64');
  }

  decodeCursor(cursor) {
    try {
      return JSON.parse(Buffer.from(cursor, 'base64').toString());
    } catch {
      return null;
    }
  }
}

module.exports = CursorPaginator;
```

### 4.5 智能分页策略选择器

创建 `backend/shared/pagination/PaginationStrategySelector.js`：

```javascript
/**
 * 智能分页策略选择器
 * 根据数据量和页码自动选择最优分页策略
 */
class PaginationStrategySelector {
  constructor(options = {}) {
    this.offsetThreshold = options.offsetThreshold || 1000;  // offset 超过此值使用游标
    this.totalEstimateThreshold = options.totalEstimateThreshold || 10000;  // total 超过此值不计算总数
  }

  /**
   * 选择分页策略
   */
  selectStrategy(paginationParams, estimatedTotal = null) {
    const { page, pageSize, cursor } = paginationParams;
    
    // 已指定游标，使用游标分页
    if (cursor) {
      return {
        type: 'cursor',
        calculateTotal: false,
        reason: 'Explicit cursor provided'
      };
    }
    
    // 页码超过阈值，建议使用游标分页
    const offset = (page - 1) * pageSize;
    if (offset > this.offsetThreshold) {
      return {
        type: 'cursor',
        calculateTotal: false,
        reason: `Offset ${offset} exceeds threshold ${this.offsetThreshold}`,
        suggestion: 'Use cursor-based pagination for better performance'
      };
    }
    
    // 数据量过大，不计算总数
    if (estimatedTotal && estimatedTotal > this.totalEstimateThreshold) {
      return {
        type: 'offset',
        calculateTotal: false,
        reason: `Estimated total ${estimatedTotal} exceeds threshold`,
        suggestion: 'Consider cursor-based pagination for large datasets'
      };
    }
    
    // 默认使用 offset 分页
    return {
      type: 'offset',
      calculateTotal: true,
      reason: 'Normal pagination scenario'
    };
  }

  /**
   * 估算数据量
   */
  async estimateTotal(db, tableName) {
    try {
      // 使用 EXPLAIN 估算行数
      const result = await db.raw(`EXPLAIN SELECT * FROM ${tableName}`);
      const plan = result.rows[0]['QUERY PLAN'];
      const match = plan.match(/rows=(\d+)/);
      return match ? parseInt(match[1]) : null;
    } catch {
      return null;
    }
  }
}

module.exports = PaginationStrategySelector;
```

### 4.6 服务迁移示例

**pokemon-service 迁移**：

```javascript
// 旧代码
router.get('/pokemon', async (req, res) => {
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 20;
  
  const pokemon = await db('pokemon_instances')
    .where('user_id', req.user.id)
    .offset(offset)
    .limit(limit);
  
  res.json({ success: true, data: pokemon });
});

// 新代码（使用分页中间件）
router.get('/pokemon', 
  paginationMiddleware.parsePaginationParams,
  paginationMiddleware.wrapPaginatedResponse,
  async (req, res) => {
    const { page, pageSize, cursor } = req.pagination;
    
    // 使用智能分页策略
    const strategy = strategySelector.selectStrategy(req.pagination);
    
    if (strategy.type === 'cursor') {
      const paginator = new CursorPaginator(db, 'pokemon_instances', {
        cursorField: 'id',
        orderField: 'caught_at',
        orderDirection: 'DESC'
      });
      
      const result = await paginator.query(cursor, pageSize);
      req.pagination.total = strategy.calculateTotal ? await countTotal() : null;
      
      res.json({ success: true, data: result.items });
    } else {
      const offset = (page - 1) * pageSize;
      const pokemon = await db('pokemon_instances')
        .where('user_id', req.user.id)
        .offset(offset)
        .limit(pageSize);
      
      req.pagination.total = strategy.calculateTotal 
        ? await db('pokemon_instances').where('user_id', req.user.id).count().first()
        : null;
      
      res.json({ success: true, data: pokemon });
    }
  }
);
```

### 4.7 性能对比测试

创建 `backend/tests/pagination-performance.test.js`：

```javascript
describe('Pagination Performance', () => {
  before(async () => {
    // 创建 10000 条测试数据
    await seedTestData(10000);
  });

  it('should compare offset vs cursor performance', async () => {
    // Offset 分页性能测试
    const offsetStart = Date.now();
    await db('pokemon_instances')
      .where('user_id', testUserId)
      .offset(9000)
      .limit(20);
    const offsetTime = Date.now() - offsetStart;

    // Cursor 分页性能测试
    const cursorStart = Date.now();
    const paginator = new CursorPaginator(db, 'pokemon_instances');
    await paginator.query(generateCursor(9000), 20);
    const cursorTime = Date.now() - cursorStart;

    // Cursor 分页应显著优于 offset
    expect(cursorTime).toBeLessThan(offsetTime * 0.5);
    
    console.log(`Offset: ${offsetTime}ms, Cursor: ${cursorTime}ms`);
  });
});
```

### 4.8 API 文档更新

更新 `docs/api-guidelines.md` 添加分页规范章节：

```markdown
## Pagination

### Parameter Naming

All paginated endpoints must use the following parameters:

- `page`: Page number (default: 1)
- `pageSize`: Items per page (default: 20, max: 100)
- `cursor`: Cursor token (for cursor-based pagination)

### Response Format

All paginated responses must include pagination metadata in `meta.pagination`:

```json
{
  "meta": {
    "pagination": {
      "type": "offset | cursor",
      "page": 1,
      "pageSize": 20,
      "total": 1000,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Strategy Selection

- Use **offset-based pagination** for small datasets (< 1000 items)
- Use **cursor-based pagination** for large datasets or deep pagination
- Cursor pagination is required when `offset > 1000`

### Examples

#### Offset Pagination

```bash
GET /api/pokemon?page=2&pageSize=20
```

#### Cursor Pagination

```bash
GET /api/pokemon?cursor=eyJpZCI6MjB9&pageSize=20
```
```

## 5. 验收标准（可测试）

- [ ] 分页参数标准化规范文档完成
- [ ] PaginationMiddleware 实现并通过单元测试
- [ ] CursorPaginator 实现并通过单元测试
- [ ] PaginationStrategySelector 实现并通过单元测试
- [ ] 至少 3 个微服务迁移到新分页系统
- [ ] 游标分页性能优于 offset 分页 50%+
- [ ] 所有分页响应包含统一的元数据结构
- [ ] API 文档更新完成
- [ ] 分页性能测试通过

## 6. 工作量估算

**L（Large）** - 约 10-15 小时

**理由：**
- 分页中间件开发（2-3h）
- 游标分页实现（2-3h）
- 智能策略选择器（1-2h）
- 各微服务迁移（3-4h）
- 性能测试和文档（2h）

## 7. 优先级理由

**P1 理由：**

1. **API 规范核心**：分页是 API 设计的基本规范，影响所有接口
2. **性能问题**：大 offset 查询性能问题影响用户体验
3. **客户端适配**：前端适配不一致增加开发成本
4. **生产就绪**：分页标准化是生产系统的基本要求

**不为 P0 的原因：**
- 当前分页功能可正常工作，只是不够统一
- 不属于阻塞性问题

## 8. 参考

- api-guidelines.md（API 响应格式规范）
- REQ-00257（API 回归测试已完成）
- GraphQL Cursor Connections Specification