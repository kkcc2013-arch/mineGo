# REQ-00217：数据库查询请求合并与去重中间件

- **编号**：REQ-00217
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/QueryDeduplication.js、gateway、所有微服务、backend/shared/db.js
- **创建时间**：2026-06-15 00:05
- **依赖需求**：REQ-00084（数据库连接池监控与自适应扩缩容系统，已完成）

## 1. 背景与问题

当前 mineGo 项目在高并发场景下存在以下性能问题：

1. **请求风暴时数据库压力大**：当短时间内多个用户请求相同的精灵详情、地图数据或配置信息时，每个请求都会独立查询数据库，造成大量重复查询。例如热门精灵刷新时，可能瞬间有 100+ 用户同时查询同一区域地图数据。

2. **缓存穿透未完全解决**：当前缓存策略仅针对单个请求，缺乏请求级别的去重机制。在缓存失效瞬间，可能产生"惊群效应"，大量请求同时击穿缓存直达数据库。

3. **批量查询效率受限**：虽然已有 `batch.js` 支持批量查询，但每个批量请求仍然独立执行，未能充分利用数据库连接池的并发能力，也无法合并多个请求中重复的查询 ID。

4. **缺乏请求合并机制**：类似 GraphQL DataLoader 的请求合并能力缺失，无法将同一事件循环内的多个相同查询合并为单次数据库访问。

## 2. 目标

实现数据库查询请求合并与去重中间件，达成以下目标：

1. **请求去重**：在短时间窗口（如 50ms）内，将相同参数的查询请求合并为单次数据库查询，结果共享给所有等待者
2. **惊群防护**：缓存失效时，仅允许第一个请求执行查询，其他请求等待结果
3. **性能提升**：热门数据查询场景下，数据库 QPS 降低 50% 以上
4. **透明集成**：作为中间件或装饰器模式，无需修改业务代码即可生效

## 3. 范围

- **包含**：
  - QueryDeduplication 核心模块实现
  - 与现有 db.js 模块的集成
  - 请求合并窗口配置（可调节时间窗口大小）
  - Prometheus 指标：去重命中率、等待请求数、合并批次大小
  - 单元测试和集成测试
  - API 文档更新

- **不包含**：
  - 分布式环境下的跨实例去重（后续需求）
  - 写操作的去重（仅限读查询）
  - 事务操作的合并

## 4. 详细需求

### 4.1 核心模块设计

```javascript
// backend/shared/QueryDeduplication.js
class QueryDeduplication {
  constructor(options = {}) {
    this.windowMs = options.windowMs || 50; // 合并窗口时间
    this.maxBatchSize = options.maxBatchSize || 100; // 单批次最大合并数
    this.pendingQueries = new Map(); // 待执行的查询
    this.stats = {
      totalRequests: 0,
      deduplicated: 0,
      cacheHits: 0
    };
  }
}
```

### 4.2 请求合并机制

1. **查询指纹生成**：基于 SQL 文本和参数生成唯一键
   ```javascript
   generateKey(sql, params) {
     const paramsStr = JSON.stringify(params);
     return crypto.createHash('md5').update(sql + paramsStr).digest('hex');
   }
   ```

2. **合并窗口**：
   - 首次查询进入时，启动定时器等待后续相同查询
   - 窗口期内相同查询加入等待队列
   - 窗口结束时执行查询，结果分发给所有等待者

3. **结果缓存**：
   - 短期内存缓存（请求级别，TTL 5s）
   - 防止同一请求周期内重复查询

### 4.3 与 db.js 集成

```javascript
// 装饰 query 函数
const dedupQuery = new QueryDeduplication();

async function query(text, params) {
  // 先尝试去重中间件
  const dedupResult = await dedupQuery.execute(text, params);
  if (dedupResult !== null) {
    return dedupResult;
  }
  
  // 去重未命中，执行原逻辑
  return originalQuery(text, params);
}
```

### 4.4 配置选项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `QUERY_DEDUP_ENABLED` | true | 是否启用去重 |
| `QUERY_DEDUP_WINDOW_MS` | 50 | 合并窗口毫秒数 |
| `QUERY_DEDUP_MAX_BATCH` | 100 | 单批次最大合并数 |
| `QUERY_DEDUP_SHORT_TTL` | 5000 | 短期缓存 TTL（毫秒）|

### 4.5 Prometheus 指标

```
query_dedup_requests_total{status="hit|miss"}
query_dedup_pending_queries{service="xxx"}
query_dedup_batch_size_histogram
query_dedup_wait_time_ms{service="xxx"}
```

### 4.6 API 端点

- `GET /metrics/dedup`：获取去重统计信息
- `POST /admin/dedup/config`：动态调整配置（需要管理员权限）

## 5. 验收标准（可测试）

- [ ] 单元测试：相同查询在窗口期内被合并，结果共享
- [ ] 单元测试：不同查询独立执行，互不影响
- [ ] 集成测试：模拟 100 并发相同查询，数据库实际执行次数 ≤ 5
- [ ] 集成测试：缓存失效瞬间，仅 1 次数据库查询
- [ ] 性能测试：热门数据查询场景，数据库 QPS 降低 ≥ 50%
- [ ] 指标验证：Prometheus 指标正确上报
- [ ] 文档验证：API 文档更新，包含使用说明

## 6. 工作量估算

**L（Large）**

- 核心模块实现：4 小时
- 与 db.js 集成：2 小时
- 测试编写：3 小时
- 文档更新：1 小时
- 总计：10 小时

## 7. 优先级理由

P1 优先级理由：
1. **直接影响用户体验**：高并发场景下数据库压力大可能导致响应延迟甚至超时
2. **成本敏感**：减少数据库查询次数直接降低数据库负载和云资源成本
3. **基础能力**：为后续分布式缓存优化奠定基础
4. **已完成依赖**：REQ-00084（数据库连接池监控）已完成，具备监控能力
