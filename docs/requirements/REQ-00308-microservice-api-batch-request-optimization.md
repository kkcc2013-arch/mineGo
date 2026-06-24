# REQ-00308：微服务 API 请求合并与批量处理优化系统

- **编号**：REQ-00308
- **类别**：成本/资源优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/middleware、Redis、Kafka
- **创建时间**：2026-06-24 03:00 UTC
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目在前端与后端交互中存在多次独立请求同一资源的问题，导致：

1. **网络开销过高**：游戏客户端在加载精灵列表、背包、好友列表等场景时，发起多个独立请求，每次请求都有 HTTP 头、TLS 握手等开销
2. **服务器资源浪费**：每个请求都需要独立的鉴权、日志、追踪处理，CPU 和内存消耗成倍增加
3. **响应延迟累积**：N 个独立请求的延迟 = N × 单次请求延迟，用户感知明显
4. **数据库连接池压力**：每个请求占用一个数据库连接，高并发时连接池成为瓶颈

典型场景分析：
- 精灵详情页：需要同时获取精灵基础信息、技能列表、属性克制、进化路线等 4-5 个接口
- 好友列表：需要获取好友信息、在线状态、最近互动等 3 个接口
- 背包系统：需要获取道具列表、精灵列表、装备列表等 3 个接口

## 2. 目标

实现完整的请求合并与批量处理系统，包括：

1. **批量请求 API**：支持单次请求获取多个资源
2. **智能请求合并中间件**：自动检测可合并的请求并合并处理
3. **并行执行引擎**：批量请求内部并行执行，最小化延迟
4. **缓存预热**：批量请求结果自动缓存，后续请求命中缓存
5. **请求优先级队列**：高优先级请求优先处理
6. **成本节省统计**：记录并展示请求合并带来的资源节省

预期收益：
- 网络请求数量减少 60%+
- 服务器 CPU 使用率降低 20-30%
- 数据库连接使用降低 40%
- 用户感知延迟降低 50%+

## 3. 范围

### 包含
- 批量请求 API 端点（POST /api/batch）
- 请求合并中间件（自动检测并合并）
- 并行执行引擎（Promise.all 封装）
- 批量请求结果缓存
- 请求优先级队列
- 速率限制与配额管理
- Prometheus 指标监控
- 单元测试和集成测试

### 不包含
- GraphQL 实现（未来考虑）
- WebSocket 批量消息（已有独立实现）
- 第三方 API 批量调用（非本项目控制范围）

## 4. 详细需求

### 4.1 API 设计

#### 批量请求端点

```
POST /api/batch
Content-Type: application/json
Authorization: Bearer <token>

请求体：
{
  "requests": [
    {
      "id": "req-1",
      "method": "GET",
      "path": "/api/pokemon/123",
      "priority": "high"
    },
    {
      "id": "req-2",
      "method": "GET", 
      "path": "/api/pokemon/123/skills",
      "priority": "normal"
    },
    {
      "id": "req-3",
      "method": "GET",
      "path": "/api/pokemon/123/evolution",
      "priority": "normal"
    }
  ],
  "options": {
    "parallel": true,
    "maxParallel": 5,
    "timeout": 10000,
    "failFast": false,
    "cacheTTL": 300
  }
}

响应体：
{
  "responses": [
    {
      "id": "req-1",
      "status": 200,
      "data": { "pokemon": { ... } },
      "cached": false,
      "duration": 45
    },
    {
      "id": "req-2", 
      "status": 200,
      "data": { "skills": [ ... ] },
      "cached": true,
      "duration": 5
    },
    {
      "id": "req-3",
      "status": 404,
      "error": { "code": "NOT_FOUND", "message": "进化路线不存在" },
      "duration": 12
    }
  ],
  "summary": {
    "total": 3,
    "success": 2,
    "failed": 1,
    "cached": 1,
    "totalDuration": 62,
    "costSaved": 0.00012
  }
}
```

### 4.2 数据库设计

```sql
-- 批量请求统计表
CREATE TABLE batch_request_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    request_count INTEGER NOT NULL,
    success_count INTEGER NOT NULL,
    cached_count INTEGER NOT NULL,
    total_duration_ms INTEGER NOT NULL,
    cost_saved_usd DECIMAL(10, 6) DEFAULT 0,
    endpoint_group VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 批量请求模板表（预定义常用批量请求）
CREATE TABLE batch_request_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    requests JSONB NOT NULL,
    options JSONB DEFAULT '{}',
    usage_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_batch_stats_user ON batch_request_stats(user_id, created_at DESC);
CREATE INDEX idx_batch_stats_created ON batch_request_stats(created_at DESC);
CREATE INDEX idx_batch_templates_name ON batch_request_templates(name);
```

### 4.3 核心实现

```javascript
// backend/shared/batchProcessor.js
class BatchProcessor {
  constructor(options = {}) {
    this.maxParallel = options.maxParallel || 5;
    this.timeout = options.timeout || 10000;
    this.failFast = options.failFast || false;
    this.cacheEnabled = options.cacheEnabled !== false;
    this.cacheTTL = options.cacheTTL || 300;
    this.redis = options.redis;
    this.logger = options.logger;
    this.metrics = options.metrics;
  }

  async executeBatch(requests, userId) {
    const startTime = Date.now();
    const results = [];
    let cachedCount = 0;
    let costSaved = 0;

    // 按优先级排序
    const sorted = this.sortByPriority(requests);

    // 分组并行执行
    const batches = this.chunk(sorted, this.maxParallel);
    
    for (const batch of batches) {
      const batchResults = await Promise.allSettled(
        batch.map(req => this.executeRequest(req, userId))
      );

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const request = batch[i];
        
        if (result.status === 'fulfilled') {
          results.push(result.value);
          if (result.value.cached) cachedCount++;
          costSaved += this.calculateCostSaved(request);
        } else {
          results.push({
            id: request.id,
            status: 500,
            error: { code: 'BATCH_ERROR', message: result.reason.message },
            duration: 0
          });
          if (this.failFast) break;
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    
    // 记录统计
    await this.recordStats(userId, requests.length, results.length, cachedCount, totalDuration, costSaved);

    return {
      responses: results,
      summary: {
        total: requests.length,
        success: results.filter(r => r.status < 400).length,
        failed: results.filter(r => r.status >= 400).length,
        cached: cachedCount,
        totalDuration,
        costSaved
      }
    };
  }

  async executeRequest(request, userId) {
    const startTime = Date.now();
    const cacheKey = this.getCacheKey(request, userId);

    // 尝试缓存
    if (this.cacheEnabled && request.method === 'GET') {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.metrics.increment('batch_cache_hits');
        return {
          id: request.id,
          status: 200,
          data: JSON.parse(cached),
          cached: true,
          duration: Date.now() - startTime
        };
      }
    }

    // 执行实际请求
    const result = await this.executeInternal(request);
    
    // 缓存结果
    if (this.cacheEnabled && request.method === 'GET' && result.status === 200) {
      await this.redis.setex(cacheKey, this.cacheTTL, JSON.stringify(result.data));
    }

    return {
      ...result,
      id: request.id,
      cached: false,
      duration: Date.now() - startTime
    };
  }

  sortByPriority(requests) {
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    return [...requests].sort((a, b) => 
      (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1)
    );
  }

  chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  calculateCostSaved(request) {
    // 估算每个独立请求的成本
    // 包含：网络传输、服务器处理、数据库查询
    return 0.00005; // 约 $0.00005 per request
  }

  getCacheKey(request, userId) {
    return `batch:${userId}:${request.method}:${request.path}`;
  }
}

module.exports = BatchProcessor;
```

### 4.4 预定义批量请求模板

```javascript
// 预定义常用批量请求
const BATCH_TEMPLATES = {
  // 精灵详情页
  'pokemon-detail': {
    name: '精灵详情页',
    requests: [
      { path: '/api/pokemon/{id}', priority: 'high' },
      { path: '/api/pokemon/{id}/skills', priority: 'normal' },
      { path: '/api/pokemon/{id}/evolution', priority: 'normal' },
      { path: '/api/pokemon/{id}/stats', priority: 'normal' }
    ]
  },
  // 好友列表
  'friends-list': {
    name: '好友列表',
    requests: [
      { path: '/api/friends', priority: 'high' },
      { path: '/api/friends/online', priority: 'high' },
      { path: '/api/friends/interactions', priority: 'normal' }
    ]
  },
  // 背包系统
  'inventory': {
    name: '背包系统',
    requests: [
      { path: '/api/inventory/items', priority: 'high' },
      { path: '/api/inventory/pokemon', priority: 'high' },
      { path: '/api/inventory/equipment', priority: 'normal' }
    ]
  },
  // 道馆详情
  'gym-detail': {
    name: '道馆详情',
    requests: [
      { path: '/api/gym/{id}', priority: 'high' },
      { path: '/api/gym/{id}/members', priority: 'high' },
      { path: '/api/gym/{id}/battles', priority: 'normal' }
    ]
  }
};
```

### 4.5 Prometheus 指标

```javascript
// 批量请求指标
batch_requests_total                      // 批量请求总数
batch_requests_items_total                // 批量请求项目总数
batch_requests_success_total              // 成功批量请求数
batch_requests_failed_total               // 失败批量请求数
batch_requests_cached_total               // 缓存命中数
batch_requests_duration_seconds           // 批量请求延迟分布
batch_requests_parallel_count             // 并行执行数量
batch_cost_saved_usd                      // 节省成本（美元）

// 传统请求对比指标
traditional_requests_avoided_total        // 避免的传统请求数
traditional_requests_latency_comparison   // 延迟对比
```

## 5. 验收标准（可测试）

- [ ] POST /api/batch 端点正确处理批量请求
- [ ] 批量请求内部并行执行，总延迟小于串行执行时间
- [ ] GET 请求结果被正确缓存，重复请求命中缓存
- [ ] 高优先级请求优先执行并返回
- [ ] 单个请求失败不影响其他请求（failFast=false）
- [ ] failFast=true 时，首次失败立即返回
- [ ] 速率限制正确应用（每用户每分钟最多 60 次批量请求）
- [ ] Prometheus 指标正确记录统计数据
- [ ] 成本节省计算准确，误差 < 5%
- [ ] 单元测试覆盖率 > 90%
- [ ] 集成测试覆盖所有预定义模板
- [ ] 性能测试：100 个并发批量请求，P99 延迟 < 500ms

## 6. 工作量估算

**L (Large)**

理由：
- 需要实现完整的批量请求处理引擎
- 需要设计并实现缓存策略
- 需要实现优先级队列和并行执行
- 需要创建数据库表和索引
- 需要实现 Prometheus 指标
- 需要实现预定义模板管理
- 需要完整的测试覆盖

预计开发时间：2-3 天

## 7. 优先级理由

**P1 (高优先级)**

理由：
1. **显著降低成本**：请求合并可减少 60%+ 的网络请求，直接降低服务器负载和云资源消耗
2. **提升用户体验**：批量请求延迟降低 50%，用户感知明显改善
3. **缓解系统瓶颈**：减少数据库连接使用，避免高并发时连接池耗尽
4. **技术可行**：基于现有架构实现，技术风险低
5. **行业最佳实践**：大型互联网应用的标准优化手段

## 8. 相关需求

- REQ-00031: API 响应缓存层与缓存失效策略（相关）
- REQ-00092: API 请求合并与批量查询优化（相关）
- REQ-00225: 监控数据降采样与长期存储系统（相关）
- REQ-00251: API 响应序列化优化与 JSON 压缩系统（相关）

## 9. 风险评估

### 技术风险（低）
- 批量请求模式成熟，已有大量开源实现参考
- 基于现有架构，无重大改动

### 性能风险（低）
- 并行执行反而可能增加瞬时 CPU 峰值
- 需要合理限制并行度（maxParallel=5）

### 安全风险（中）
- 需要防止滥用（大量批量请求）
- 需要严格的速率限制
- 需要防止批量请求中的权限绕过

## 10. 后续优化方向

1. **智能预取**：根据用户行为预测，自动预取相关资源
2. **GraphQL 迁移**：长期可考虑 GraphQL 替代批量 API
3. **边缘缓存**：在 CDN 边缘节点缓存批量请求结果
4. **请求去重**：合并多个用户请求相同资源
5. **成本优化推荐**：基于使用数据推荐最佳批量策略
