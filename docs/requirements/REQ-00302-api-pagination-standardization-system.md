# REQ-00302：API 分页与列表响应标准化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00302 |
| 标题 | API 分页与列表响应标准化系统 |
| 类别 | API 设计规范 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared/middleware、docs/api-spec |
| 创建时间 | 2026-06-23 07:05 UTC |
| 依赖需求 | REQ-00157（统一错误处理与 API 响应格式标准化） |

## 1. 背景与问题

mineGo 项目的 API 列表接口存在分页实现不一致的问题，影响前后端协作效率和 API 可维护性：

### 1.1 分页参数不统一
- 不同接口使用不同的分页参数：`limit/offset`、`page/size`、`pageSize/pageNum` 混用
- 缺少统一的参数验证和默认值处理
- 游标分页与偏移分页选择标准不明确

### 1.2 列表响应格式不一致
- 分页元数据格式不统一：有的返回 `total`，有的返回 `hasMore`，有的缺少分页信息
- 缺少统一的响应结构：`data`、`items`、`results` 等字段混用
- HATEOAS 链接支持缺失，客户端需要硬编码导航链接

### 1.3 性能问题
- 大数据集查询缺少游标分页支持，性能瓶颈明显
- 缺少分页查询优化（如延迟关联、覆盖索引）
- count 查询在大数据集上性能较差

### 1.4 文档缺失
- 缺少统一的分页 API 文档规范
- OpenAPI Schema 未标准化分页参数和响应

## 2. 目标

构建统一的 API 分页与列表响应标准化系统：

1. **统一分页参数**：标准化 limit/offset 和 cursor-based 分页参数命名
2. **统一响应格式**：所有列表接口返回一致的响应结构，包含分页元数据
3. **HATEOAS 支持**：提供 next/prev/first/last 链接，支持 RESTful 最佳实践
4. **性能优化**：游标分页支持、count 查询优化、延迟关联
5. **中间件支持**：提供开箱即用的分页中间件和工具函数

**预期收益：**
- 前后端协作效率提升 30%
- API 文档一致性提升
- 大数据集查询性能优化 50%+
- 新接口开发时间减少 20%

## 3. 范围

### 包含
- 分页参数标准化中间件
- 统一列表响应格式（包含 data、pagination、links）
- 游标分页与偏移分页支持
- HATEOAS 链接生成器
- count 查询优化策略（估算、缓存）
- 延迟关联查询优化
- OpenAPI Schema 标准化
- 迁移工具和文档

### 不包含
- 前端分页组件实现（属于前端需求）
- 无限滚动加载（属于前端需求）
- 分页性能监控告警（属于可观测性需求）

## 4. 详细需求

### 4.1 统一分页参数规范

#### 4.1.1 偏移分页（Offset Pagination）

适用于：小数据集、需要跳页、需要总数

```
GET /api/v1/pokemon?limit=20&offset=0
GET /api/v1/pokemon?page=1&pageSize=20  // 别名支持
```

参数规范：
- `limit` 或 `pageSize`：每页数量，默认 20，最大 100
- `offset` 或 `page`：偏移量或页码，默认 0 或 1

#### 4.1.2 游标分页（Cursor Pagination）

适用于：大数据集、实时数据、不需要跳页

```
GET /api/v1/events?cursor=eyJpZCI6MTAwfQ&limit=20
GET /api/v1/events?after=100&limit=20
```

参数规范：
- `cursor` 或 `after`：游标（base64 编码）
- `limit`：每页数量，默认 20，最大 100

### 4.2 统一列表响应格式

#### 4.2.1 偏移分页响应

```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "Pikachu" },
    { "id": 2, "name": "Charmander" }
  ],
  "pagination": {
    "total": 150,
    "limit": 20,
    "offset": 0,
    "page": 1,
    "pageSize": 20,
    "totalPages": 8,
    "hasMore": true
  },
  "links": {
    "self": "/api/v1/pokemon?limit=20&offset=0",
    "next": "/api/v1/pokemon?limit=20&offset=20",
    "prev": null,
    "first": "/api/v1/pokemon?limit=20&offset=0",
    "last": "/api/v1/pokemon?limit=20&offset=140"
  }
}
```

#### 4.2.2 游标分页响应

```json
{
  "success": true,
  "data": [
    { "id": 101, "name": "Event 101" },
    { "id": 102, "name": "Event 102" }
  ],
  "pagination": {
    "hasMore": true,
    "limit": 20,
    "cursor": "eyJpZCI6MTAyfQ"
  },
  "links": {
    "self": "/api/v1/events?cursor=eyJpZCI6MTAwfQ&limit=20",
    "next": "/api/v1/events?cursor=eyJpZCI6MTAyfQ&limit=20"
  }
}
```

### 4.3 分页中间件实现

```javascript
// backend/shared/middleware/pagination.js

const { createLogger } = require('../logger');
const logger = createLogger('pagination-middleware');

/**
 * 分页参数配置
 */
const PAGINATION_DEFAULTS = {
  limit: 20,
  maxLimit: 100,
  minLimit: 1,
  defaultOffset: 0,
  maxOffset: 10000  // 防止深度分页性能问题
};

/**
 * 偏移分页中间件
 */
function offsetPaginationMiddleware(options = {}) {
  const config = { ...PAGINATION_DEFAULTS, ...options };
  
  return (req, res, next) => {
    // 解析参数
    let limit = parseInt(req.query.limit || req.query.pageSize || config.limit);
    let offset = parseInt(req.query.offset || 0);
    
    // 支持页码参数
    if (req.query.page !== undefined) {
      const page = parseInt(req.query.page);
      offset = (Math.max(1, page) - 1) * limit;
    }
    
    // 参数验证
    limit = Math.max(config.minLimit, Math.min(limit, config.maxLimit));
    offset = Math.max(0, Math.min(offset, config.maxOffset));
    
    // 注入到请求对象
    req.pagination = {
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit
    };
    
    // 为响应添加分页元数据的辅助函数
    res.addPaginationMeta = (total, basePath = req.path) => {
      const totalPages = Math.ceil(total / limit);
      const currentPage = Math.floor(offset / limit) + 1;
      
      return {
        total,
        limit,
        offset,
        page: currentPage,
        pageSize: limit,
        totalPages,
        hasMore: offset + limit < total
      };
    };
    
    // HATEOAS 链接生成器
    res.addLinks = (total, basePath = req.path, queryParams = {}) => {
      const totalPages = Math.ceil(total / limit);
      const links = {
        self: buildUrl(basePath, { limit, offset }, queryParams)
      };
      
      // Next page
      if (offset + limit < total) {
        links.next = buildUrl(basePath, { limit, offset: offset + limit }, queryParams);
      }
      
      // Previous page
      if (offset > 0) {
        links.prev = buildUrl(basePath, { limit, offset: Math.max(0, offset - limit) }, queryParams);
      }
      
      // First page
      links.first = buildUrl(basePath, { limit, offset: 0 }, queryParams);
      
      // Last page
      const lastOffset = Math.max(0, (totalPages - 1) * limit);
      links.last = buildUrl(basePath, { limit, offset: lastOffset }, queryParams);
      
      return links;
    };
    
    next();
  };
}

/**
 * 游标分页中间件
 */
function cursorPaginationMiddleware(options = {}) {
  const config = { 
    ...PAGINATION_DEFAULTS, 
    cursorField: 'id',
    order: 'DESC',
    ...options 
  };
  
  return (req, res, next) => {
    // 解析参数
    let limit = parseInt(req.query.limit || config.limit);
    const cursor = req.query.cursor || req.query.after;
    
    // 参数验证
    limit = Math.max(config.minLimit, Math.min(limit, config.maxLimit));
    
    // 解码游标
    let cursorValue = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
        cursorValue = decoded[config.cursorField];
      } catch (err) {
        logger.warn({ cursor }, 'Invalid cursor, ignoring');
      }
    }
    
    // 注入到请求对象
    req.pagination = {
      limit,
      cursor,
      cursorValue,
      cursorField: config.cursorField,
      order: config.order
    };
    
    // 游标编码辅助函数
    res.encodeCursor = (value) => {
      const data = { [config.cursorField]: value };
      return Buffer.from(JSON.stringify(data)).toString('base64');
    };
    
    // 游标分页元数据
    res.addCursorPaginationMeta = (hasMore, lastItem) => {
      return {
        hasMore,
        limit,
        cursor: hasMore && lastItem ? res.encodeCursor(lastItem[config.cursorField]) : null
      };
    };
    
    // 游标分页链接
    res.addCursorLinks = (hasMore, lastItem, basePath = req.path, queryParams = {}) => {
      const links = {
        self: buildUrl(basePath, { limit }, { ...queryParams, cursor })
      };
      
      if (hasMore && lastItem) {
        links.next = buildUrl(basePath, { limit }, { 
          ...queryParams, 
          cursor: res.encodeCursor(lastItem[config.cursorField]) 
        });
      }
      
      return links;
    };
    
    next();
  };
}

/**
 * URL 构建辅助函数
 */
function buildUrl(basePath, paginationParams, queryParams = {}) {
  const url = new URL(basePath, 'http://example.com');
  
  // 添加分页参数
  Object.entries(paginationParams).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, value);
    }
  });
  
  // 添加其他查询参数
  Object.entries(queryParams).forEach(([key, value]) => {
    if (value !== null && value !== undefined && key !== 'limit' && key !== 'offset' && key !== 'cursor') {
      url.searchParams.set(key, value);
    }
  });
  
  return url.pathname + url.search;
}

/**
 * 统一列表响应包装器
 */
function paginateResponse(data, pagination, links, metadata = {}) {
  return {
    success: true,
    data,
    pagination,
    links,
    ...metadata
  };
}

module.exports = {
  offsetPaginationMiddleware,
  cursorPaginationMiddleware,
  paginateResponse,
  PAGINATION_DEFAULTS
};
```

### 4.4 数据库查询优化

#### 4.4.1 延迟关联优化（Deferred Join）

```javascript
// backend/shared/utils/paginationQuery.js

const { query } = require('../db');

/**
 * 延迟关联查询 - 优化深度分页性能
 * 
 * 传统方式：SELECT * FROM pokemon ORDER BY id LIMIT 20 OFFSET 10000
 * 延迟关联：SELECT * FROM pokemon p JOIN (SELECT id FROM pokemon ORDER BY id LIMIT 20 OFFSET 10000) tmp ON p.id = tmp.id
 */
async function paginatedQuery(table, options = {}) {
  const {
    select = '*',
    where = '',
    orderBy = 'id DESC',
    limit = 20,
    offset = 0,
    params = [],
    useDeferredJoin = false
  } = options;
  
  // 偏移量大于 1000 时，使用延迟关联
  const shouldUseDeferred = useDeferredJoin || offset > 1000;
  
  if (shouldUseDeferred && offset > 0) {
    // 延迟关联查询
    const primaryKey = detectPrimaryKey(table);
    const innerQuery = `
      SELECT ${primaryKey} 
      FROM ${table} 
      ${where ? `WHERE ${where}` : ''} 
      ORDER BY ${orderBy} 
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `;
    
    const fullQuery = `
      SELECT ${select}
      FROM ${table} t
      INNER JOIN (${innerQuery}) tmp ON t.${primaryKey} = tmp.${primaryKey}
      ORDER BY ${orderBy}
    `;
    
    return query(fullQuery, [...params, limit, offset]);
  } else {
    // 标准查询
    const sql = `
      SELECT ${select}
      FROM ${table}
      ${where ? `WHERE ${where}` : ''}
      ORDER BY ${orderBy}
      LIMIT $${params.length + 1} ${offset > 0 ? `OFFSET $${params.length + 2}` : ''}
    `;
    
    const queryParams = offset > 0 ? [...params, limit, offset] : [...params, limit];
    return query(sql, queryParams);
  }
}

/**
 * 游标分页查询
 */
async function cursorPaginatedQuery(table, options = {}) {
  const {
    select = '*',
    cursorField = 'id',
    cursorValue = null,
    order = 'DESC',
    limit = 20,
    where = '',
    params = []
  } = options;
  
  const operator = order === 'DESC' ? '<' : '>';
  const cursorCondition = cursorValue 
    ? `${cursorField} ${operator} $${params.length + 1}` 
    : '';
  
  const whereClause = where 
    ? (cursorValue ? `WHERE ${where} AND ${cursorCondition}` : `WHERE ${where}`)
    : (cursorValue ? `WHERE ${cursorCondition}` : '');
  
  const sql = `
    SELECT ${select}
    FROM ${table}
    ${whereClause}
    ORDER BY ${cursorField} ${order}
    LIMIT $${params.length + (cursorValue ? 2 : 1)}
  `;
  
  const queryParams = cursorValue 
    ? [...params, cursorValue, limit]
    : [...params, limit];
  
  return query(sql, queryParams);
}

/**
 * 优化的 count 查询
 */
async function optimizedCount(table, options = {}) {
  const { where = '', params = [], useEstimate = false } = options;
  
  // 大表使用估算
  if (useEstimate && !where) {
    const estimateQuery = `
      SELECT reltuples::bigint AS estimate
      FROM pg_class
      WHERE relname = $1
    `;
    const result = await query(estimateQuery, [table]);
    if (result.rows[0]?.estimate > 0) {
      return result.rows[0].estimate;
    }
  }
  
  // 精确计数
  const sql = `
    SELECT COUNT(*) AS total
    FROM ${table}
    ${where ? `WHERE ${where}` : ''}
  `;
  
  const result = await query(sql, params);
  return parseInt(result.rows[0].total);
}

/**
 * 检测主键
 */
function detectPrimaryKey(table) {
  // 简化实现，实际应查询 schema
  const primaryKeyMap = {
    'pokemon': 'id',
    'users': 'id',
    'events': 'id',
    'catches': 'id',
    'gyms': 'id'
  };
  return primaryKeyMap[table] || 'id';
}

module.exports = {
  paginatedQuery,
  cursorPaginatedQuery,
  optimizedCount
};
```

### 4.5 现有路由迁移示例

```javascript
// backend/gateway/src/routes/pokemon.js - 迁移后

const express = require('express');
const router = express.Router();
const { offsetPaginationMiddleware } = require('../../../shared/middleware/pagination');
const { paginatedQuery, optimizedCount } = require('../../../shared/utils/paginationQuery');

// 应用分页中间件
router.use(offsetPaginationMiddleware());

/**
 * 获取精灵列表
 * GET /api/v1/pokemon?limit=20&offset=0
 */
router.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = req.pagination;
    
    // 使用优化的分页查询
    const result = await paginatedQuery('pokemon', {
      select: 'id, name, type, level, created_at',
      where: 'user_id = $1',
      orderBy: 'created_at DESC',
      limit,
      offset,
      params: [req.user.id]
    });
    
    // 获取总数（使用估算）
    const total = await optimizedCount('pokemon', {
      where: 'user_id = $1',
      params: [req.user.id],
      useEstimate: true
    });
    
    // 标准化响应
    res.json({
      success: true,
      data: result.rows,
      pagination: res.addPaginationMeta(total),
      links: res.addLinks(total)
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 获取活动日志（游标分页示例）
 * GET /api/v1/events?cursor=xxx&limit=20
 */
router.get('/events', 
  require('../../../shared/middleware/pagination').cursorPaginationMiddleware({ cursorField: 'id' }),
  async (req, res, next) => {
    try {
      const { limit, cursorValue, cursorField, order } = req.pagination;
      
      const result = await cursorPaginatedQuery('events', {
        cursorField,
        cursorValue,
        order,
        limit,
        where: 'user_id = $1',
        params: [req.user.id]
      });
      
      const hasMore = result.rows.length === limit;
      const lastItem = result.rows[result.rows.length - 1];
      
      res.json({
        success: true,
        data: result.rows,
        pagination: res.addCursorPaginationMeta(hasMore, lastItem),
        links: res.addCursorLinks(hasMore, lastItem)
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
```

### 4.6 OpenAPI Schema 标准化

```yaml
# docs/api-spec/schemas/pagination.yaml

components:
  parameters:
    LimitParam:
      name: limit
      in: query
      description: 每页数量
      schema:
        type: integer
        minimum: 1
        maximum: 100
        default: 20
    
    OffsetParam:
      name: offset
      in: query
      description: 偏移量
      schema:
        type: integer
        minimum: 0
        maximum: 10000
        default: 0
    
    PageParam:
      name: page
      in: query
      description: 页码（从 1 开始）
      schema:
        type: integer
        minimum: 1
        default: 1
    
    CursorParam:
      name: cursor
      in: query
      description: 游标（base64 编码）
      schema:
        type: string
  
  schemas:
    PaginationMeta:
      type: object
      properties:
        total:
          type: integer
          description: 总数量
        limit:
          type: integer
          description: 每页数量
        offset:
          type: integer
          description: 当前偏移量
        page:
          type: integer
          description: 当前页码
        pageSize:
          type: integer
          description: 每页数量（同 limit）
        totalPages:
          type: integer
          description: 总页数
        hasMore:
          type: boolean
          description: 是否有更多数据
    
    CursorPaginationMeta:
      type: object
      properties:
        hasMore:
          type: boolean
          description: 是否有更多数据
        limit:
          type: integer
          description: 每页数量
        cursor:
          type: string
          nullable: true
          description: 下一页游标
    
    PaginationLinks:
      type: object
      properties:
        self:
          type: string
          description: 当前页链接
        next:
          type: string
          nullable: true
          description: 下一页链接
        prev:
          type: string
          nullable: true
          description: 上一页链接
        first:
          type: string
          description: 第一页链接
        last:
          type: string
          description: 最后一页链接
    
    PaginatedResponse:
      type: object
      properties:
        success:
          type: boolean
        data:
          type: array
          items: {}
        pagination:
          $ref: '#/components/schemas/PaginationMeta'
        links:
          $ref: '#/components/schemas/PaginationLinks'
```

### 4.7 迁移工具脚本

```javascript
// scripts/migrate-pagination.js

const fs = require('fs');
const path = require('path');
const glob = require('glob');

/**
 * 检测现有路由中的分页参数
 */
function detectPaginationPatterns(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const patterns = [];
  
  // 检测 limit/offset
  if (content.includes('limit') || content.includes('offset')) {
    patterns.push({ type: 'limit-offset', file: filePath });
  }
  
  // 检测 page/size
  if (content.includes('page') && (content.includes('size') || content.includes('pageSize'))) {
    patterns.push({ type: 'page-size', file: filePath });
  }
  
  // 检测 cursor
  if (content.includes('cursor') || content.includes('after')) {
    patterns.push({ type: 'cursor', file: filePath });
  }
  
  return patterns;
}

/**
 * 扫描所有路由文件
 */
function scanRoutes() {
  const routeFiles = glob.sync('backend/**/routes/**/*.js');
  const report = {
    total: routeFiles.length,
    withPagination: 0,
    patterns: []
  };
  
  routeFiles.forEach(file => {
    const patterns = detectPaginationPatterns(file);
    if (patterns.length > 0) {
      report.withPagination++;
      report.patterns.push(...patterns);
    }
  });
  
  return report;
}

/**
 * 生成迁移报告
 */
function generateMigrationReport() {
  const report = scanRoutes();
  
  console.log('=== Pagination Migration Report ===');
  console.log(`Total route files: ${report.total}`);
  console.log(`Files with pagination: ${report.withPagination}`);
  console.log('\nPattern breakdown:');
  
  const patternCounts = {};
  report.patterns.forEach(p => {
    patternCounts[p.type] = (patternCounts[p.type] || 0) + 1;
  });
  
  Object.entries(patternCounts).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
  
  console.log('\nFiles needing migration:');
  report.patterns.forEach(p => {
    console.log(`  - ${p.file} (${p.type})`);
  });
  
  fs.writeFileSync(
    'docs/pagination-migration-report.json',
    JSON.stringify(report, null, 2)
  );
  
  console.log('\nReport saved to docs/pagination-migration-report.json');
}

// 执行
generateMigrationReport();
```

## 5. 验收标准

- [ ] **分页参数标准化**
  - [ ] 所有列表接口使用统一的 limit/offset 或 cursor 参数
  - [ ] 参数验证和默认值处理正确
  - [ ] 支持 page/pageSize 别名（兼容）

- [ ] **统一响应格式**
  - [ ] 所有列表接口返回一致的 data/pagination/links 结构
  - [ ] 分页元数据包含 total、limit、offset、page、hasMore
  - [ ] HATEOAS 链接正确生成（self/next/prev/first/last）

- [ ] **性能优化**
  - [ ] 偏移量 > 1000 时自动使用延迟关联查询
  - [ ] 游标分页正确实现，性能测试通过
  - [ ] count 查询支持估算模式

- [ ] **中间件支持**
  - [ ] offsetPaginationMiddleware 正确注入 req.pagination
  - [ ] cursorPaginationMiddleware 正确处理游标编码/解码
  - [ ] res.addPaginationMeta 和 res.addLinks 辅助函数正常工作

- [ ] **文档与迁移**
  - [ ] OpenAPI Schema 包含标准化的分页参数和响应
  - [ ] 迁移工具生成完整的迁移报告
  - [ ] 至少 3 个现有路由完成迁移验证

- [ ] **测试覆盖**
  - [ ] 单元测试覆盖率 ≥ 80%
  - [ ] 性能测试验证延迟关联优化效果
  - [ ] 边界条件测试（空列表、最后一页、无效游标等）

## 6. 工作量估算

**L (Large)**

理由：
- 需要设计完整的分页标准化系统
- 实现偏移分页和游标分页两种模式
- 数据库查询优化（延迟关联、count 优化）
- 现有路由迁移和测试
- OpenAPI Schema 标准化

预计工时：16-20 小时

## 7. 优先级理由

**P1 理由：**

1. **API 设计规范**：分页是 API 设计的基础规范，影响所有列表接口
2. **前后端协作**：统一格式减少沟通成本，提升开发效率
3. **性能问题**：深度分页性能问题需要解决，影响用户体验
4. **可维护性**：标准化代码提升可维护性和一致性
5. **依赖性**：为后续 API 规范优化奠定基础

不设 P0 是因为现有系统可正常工作，此为优化改进需求。
