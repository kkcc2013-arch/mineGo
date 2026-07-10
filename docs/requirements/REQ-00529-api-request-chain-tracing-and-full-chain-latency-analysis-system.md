# REQ-00529：API 请求链路追踪与全链路延迟分析系统

- **编号**：REQ-00529
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有后端服务、backend/shared/tracing、backend/shared/distributedTracing、infrastructure/monitoring、PostgreSQL
- **创建时间**：2026-07-10 08:00
- **依赖需求**：REQ-00502（性能分析框架）、REQ-00528（分布式追踪智能采样）

## 1. 背景与问题

当前项目已实现分布式追踪基础能力（OpenTelemetry 集成）和性能分析框架，但在请求链路追踪和延迟分析方面仍存在不足：

### 1.1 当前痛点
1. **TraceID 传播不完整**：部分内部调用缺少 TraceID 自动传播，导致链路断裂
2. **延迟分解不清晰**：无法清晰看到请求在各服务、数据库、外部 API 的耗时分布
3. **关键路径识别困难**：无法自动识别请求处理的最长路径（关键路径）
4. **服务拓扑缺失**：缺少基于实际调用的服务依赖拓扑图自动生成
5. **跨服务调用链不透明**：异步调用（Kafka、定时任务）的链路追踪不完整

### 1.2 实际场景
```javascript
// 用户捕捉精灵的请求链路：
// client -> gateway -> catch-service -> pokemon-service -> db
//                              -> location-service -> redis
//                              -> reward-service -> db
//                              -> kafka event

// 当前问题：无法看到每个环节的具体耗时
// - 网关转发耗时？
// - 数据库查询耗时？
// - Redis 缓存耗时？
// - 哪个服务是瓶颈？
```

## 2. 目标

建立完整的 API 请求链路追踪与全链路延迟分析系统，实现：

1. **TraceID 自动传播**：所有服务间调用自动传递 TraceID（HTTP、gRPC、Kafka）
2. **全链路延迟分解**：清晰展示请求在网关、服务、数据库、缓存的耗时分布
3. **关键路径识别**：自动识别请求处理的最长路径和瓶颈服务
4. **服务拓扑生成**：基于实际调用数据自动生成服务依赖拓扑图
5. **延迟热力图**：可视化展示不同时间段的延迟分布

**可量化目标**：
- 链路追踪完整率 ≥ 95%（无断裂链路）
- 延迟数据采集开销 < 2%
- 关键路径识别准确率 ≥ 85%

## 3. 范围

### 包含
- RequestChainTracer - 请求链路追踪器（TraceID 自动传播）
- LatencyAnalyzer - 延迟分析器（服务间、数据库、缓存、外部 API）
- CriticalPathFinder - 关键路径识别器
- ServiceTopologyGenerator - 服务拓扑图生成器
- LatencyHeatmap - 延迟热力图生成器
- TraceStorage - 追踪数据存储（PostgreSQL + TimescaleDB）
- Dashboard API - 可视化查询 API

### 不包含
- 日志聚合（已有日志系统）
- 指标采集（已有 Prometheus）
- 告警系统（已有告警管理）
- 前端可视化（由 Admin Dashboard 负责）

## 4. 详细需求

### 4.1 RequestChainTracer 请求链路追踪器

```javascript
// backend/shared/distributedTracing/RequestChainTracer.js

class RequestChainTracer {
  constructor(config) {
    this.traceContextHeader = 'X-Trace-Context';
    this.sampleRate = config.sampleRate || 1.0; // 采样率
    this.maxSpanDepth = config.maxSpanDepth || 50;
  }

  /**
   * 启动新的追踪
   */
  startTrace(operationName, metadata = {}) {
    const traceId = this._generateTraceId();
    const spanId = this._generateSpanId();
    
    const traceContext = {
      traceId,
      spanId,
      parentSpanId: null,
      sampled: Math.random() < this.sampleRate,
      baggage: metadata
    };

    return {
      context: traceContext,
      span: this._createSpan(operationName, traceContext),
      startTime: Date.now()
    };
  }

  /**
   * 从请求中提取追踪上下文
   */
  extractContext(headers) {
    const header = headers[this.traceContextHeader];
    if (!header) return null;

    const [traceId, spanId, parentSpanId, sampled] = header.split('-');
    return { traceId, spanId, parentSpanId, sampled: sampled === '1' };
  }

  /**
   * 注入追踪上下文到请求头
   */
  injectContext(traceContext, headers) {
    headers[this.traceContextHeader] = 
      `${traceContext.traceId}-${traceContext.spanId}-${traceContext.parentSpanId}-${traceContext.sampled ? '1' : '0'}`;
    return headers;
  }

  /**
   * 创建子 Span
   */
  createChildSpan(parentContext, operationName) {
    const childSpanId = this._generateSpanId();
    return {
      traceId: parentContext.traceId,
      spanId: childSpanId,
      parentSpanId: parentContext.spanId,
      operationName,
      startTime: Date.now(),
      tags: {},
      logs: []
    };
  }

  /**
   * 记录 Span 事件
   */
  logSpan(span, event, attributes = {}) {
    span.logs.push({
      timestamp: Date.now(),
      event,
      attributes
    });
  }

  /**
   * 结束 Span 并记录
   */
  async finishSpan(span, dbPool) {
    span.duration = Date.now() - span.startTime;
    span.endTime = Date.now();
    
    await this._saveSpan(span, dbPool);
  }

  /**
   * 自动追踪函数执行
   */
  async traceAsync(operationName, fn, context) {
    const span = this.createChildSpan(context, operationName);
    try {
      const result = await fn();
      span.status = 'ok';
      return result;
    } catch (error) {
      span.status = 'error';
      span.error = error.message;
      throw error;
    } finally {
      await this.finishSpan(span);
    }
  }
}

module.exports = RequestChainTracer;
```

### 4.2 LatencyAnalyzer 延迟分析器

```javascript
// backend/shared/distributedTracing/LatencyAnalyzer.js

class LatencyAnalyzer {
  constructor(dbPool) {
    this.pool = dbPool;
    this.latencyThresholds = {
      fast: 100,     // < 100ms 为快
      normal: 500,   // 100-500ms 为正常
      slow: 1000,    // 500-1000ms 为慢
      verySlow: 3000 // > 3s 为非常慢
    };
  }

  /**
   * 分析请求全链路延迟
   */
  async analyzeTraceLatency(traceId) {
    const spans = await this._getTraceSpans(traceId);
    
    const analysis = {
      traceId,
      totalDuration: 0,
      breakdown: {
        gateway: 0,
        services: {},
        database: 0,
        cache: 0,
        external: 0,
        network: 0
      },
      services: [],
      databases: [],
      caches: [],
      externalCalls: [],
      bottlenecks: []
    };

    // 计算总耗时
    const rootSpan = spans.find(s => !s.parentSpanId);
    if (rootSpan) {
      analysis.totalDuration = rootSpan.duration;
    }

    // 分类统计各层耗时
    for (const span of spans) {
      this._categorizeSpan(span, analysis);
    }

    // 识别瓶颈
    analysis.bottlenecks = this._identifyBottlenecks(analysis);

    return analysis;
  }

  /**
   * 分类 Span
   */
  _categorizeSpan(span, analysis) {
    const { operationName, tags, duration } = span;

    // 数据库查询
    if (operationName.includes('db.') || operationName.includes('query')) {
      analysis.breakdown.database += duration;
      analysis.databases.push({
        query: tags.query || operationName,
        duration,
        table: tags.table,
        rows: tags.rowsAffected
      });
    }
    // 缓存操作
    else if (operationName.includes('cache.') || operationName.includes('redis')) {
      analysis.breakdown.cache += duration;
      analysis.caches.push({
        operation: operationName,
        duration,
        key: tags.cacheKey,
        hit: tags.cacheHit
      });
    }
    // 外部 API 调用
    else if (operationName.includes('http.') || operationName.includes('external.')) {
      analysis.breakdown.external += duration;
      analysis.externalCalls.push({
        url: tags.url,
        method: tags.method,
        duration,
        statusCode: tags.statusCode
      });
    }
    // 服务间调用
    else if (operationName.includes('service.')) {
      const serviceName = tags.service || 'unknown';
      if (!analysis.breakdown.services[serviceName]) {
        analysis.breakdown.services[serviceName] = 0;
      }
      analysis.breakdown.services[serviceName] += duration;
      analysis.services.push({
        service: serviceName,
        operation: operationName,
        duration,
        status: span.status
      });
    }
    // 网关层
    else if (operationName.includes('gateway.')) {
      analysis.breakdown.gateway += duration;
    }
  }

  /**
   * 识别瓶颈
   */
  _identifyBottlenecks(analysis) {
    const bottlenecks = [];
    const total = analysis.totalDuration || 1;

    // 数据库瓶颈
    if (analysis.breakdown.database > total * 0.3) {
      bottlenecks.push({
        type: 'database',
        severity: 'high',
        duration: analysis.breakdown.database,
        percentage: (analysis.breakdown.database / total * 100).toFixed(1),
        recommendation: '数据库查询耗时过高，建议优化查询或增加索引'
      });
    }

    // 缓存瓶颈
    const cacheMissRate = this._calculateCacheMissRate(analysis.caches);
    if (cacheMissRate > 0.3) {
      bottlenecks.push({
        type: 'cache',
        severity: 'medium',
        cacheMissRate,
        recommendation: '缓存命中率低，建议调整缓存策略'
      });
    }

    // 外部调用瓶颈
    if (analysis.breakdown.external > total * 0.2) {
      bottlenecks.push({
        type: 'external',
        severity: 'high',
        duration: analysis.breakdown.external,
        percentage: (analysis.breakdown.external / total * 100).toFixed(1),
        recommendation: '外部 API 调用耗时过高，建议增加超时控制或降级策略'
      });
    }

    return bottlenecks;
  }

  /**
   * 获取延迟分布统计
   */
  async getLatencyDistribution(serviceName, timeRange = '1h') {
    const result = await this.pool.query(`
      SELECT 
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration) as p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY duration) as p90,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY duration) as p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY duration) as p99,
        AVG(duration) as avg,
        MIN(duration) as min,
        MAX(duration) as max,
        COUNT(*) as total_requests
      FROM trace_spans
      WHERE operation_name LIKE $1
        AND start_time > NOW() - INTERVAL '${timeRange}'
    `, [`service.${serviceName}%`]);

    return result.rows[0];
  }
}

module.exports = LatencyAnalyzer;
```

### 4.3 CriticalPathFinder 关键路径识别器

```javascript
// backend/shared/distributedTracing/CriticalPathFinder.js

class CriticalPathFinder {
  constructor(dbPool) {
    this.pool = dbPool;
  }

  /**
   * 识别请求的关键路径
   */
  async findCriticalPath(traceId) {
    const spans = await this._getTraceSpans(traceId);
    
    // 构建 Span 树
    const spanTree = this._buildSpanTree(spans);
    
    // 找到最长路径
    const criticalPath = this._findLongestPath(spanTree);
    
    // 分析关键路径上的瓶颈
    const bottlenecks = this._analyzePathBottlenecks(criticalPath);

    return {
      traceId,
      criticalPath,
      totalDuration: criticalPath.reduce((sum, span) => sum + span.duration, 0),
      bottlenecks,
      recommendations: this._generateRecommendations(bottlenecks)
    };
  }

  /**
   * 构建 Span 树
   */
  _buildSpanTree(spans) {
    const spanMap = new Map();
    const rootSpans = [];

    // 创建 Span 映射
    for (const span of spans) {
      spanMap.set(span.spanId, { ...span, children: [] });
    }

    // 构建树结构
    for (const span of spans) {
      const node = spanMap.get(span.spanId);
      if (span.parentSpanId) {
        const parent = spanMap.get(span.parentSpanId);
        if (parent) {
          parent.children.push(node);
        }
      } else {
        rootSpans.push(node);
      }
    }

    return rootSpans;
  }

  /**
   * 找到最长路径
   */
  _findLongestPath(spanTree) {
    let longestPath = [];

    const traverse = (node, currentPath) => {
      currentPath.push(node);

      if (node.children.length === 0) {
        // 叶子节点，计算路径总耗时
        if (currentPath.length > longestPath.length) {
          longestPath = [...currentPath];
        }
      } else {
        // 按耗时排序子节点，优先遍历耗时最长的
        node.children.sort((a, b) => b.duration - a.duration);
        for (const child of node.children) {
          traverse(child, [...currentPath]);
        }
      }
    };

    for (const root of spanTree) {
      traverse(root, []);
    }

    return longestPath;
  }

  /**
   * 分析路径瓶颈
   */
  _analyzePathBottlenecks(path) {
    const bottlenecks = [];
    const totalDuration = path.reduce((sum, span) => sum + span.duration, 0);

    for (const span of path) {
      // 如果单个 Span 占总耗时的 20% 以上，认为是瓶颈
      if (span.duration > totalDuration * 0.2) {
        bottlenecks.push({
          spanId: span.spanId,
          operation: span.operationName,
          duration: span.duration,
          percentage: (span.duration / totalDuration * 100).toFixed(1),
          type: this._classifySpanType(span.operationName),
          suggestion: this._getOptimizationSuggestion(span)
        });
      }
    }

    return bottlenecks;
  }

  /**
   * 生成优化建议
   */
  _generateRecommendations(bottlenecks) {
    const recommendations = [];

    for (const bottleneck of bottlenecks) {
      recommendations.push({
        priority: bottleneck.percentage > 40 ? 'high' : 'medium',
        target: bottleneck.operation,
        action: bottleneck.suggestion,
        estimatedImprovement: `可减少 ${Math.round(bottleneck.duration * 0.3)}ms`
      });
    }

    return recommendations;
  }
}

module.exports = CriticalPathFinder;
```

### 4.4 ServiceTopologyGenerator 服务拓扑生成器

```javascript
// backend/shared/distributedTracing/ServiceTopologyGenerator.js

class ServiceTopologyGenerator {
  constructor(dbPool) {
    this.pool = dbPool;
  }

  /**
   * 生成服务拓扑图
   */
  async generateTopology(timeRange = '24h') {
    // 查询所有服务间调用关系
    const calls = await this.pool.query(`
      SELECT 
        tags->>'service' as source_service,
        tags->>'target_service' as target_service,
        COUNT(*) as call_count,
        AVG(duration) as avg_duration,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration) as p95_duration,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count
      FROM trace_spans
      WHERE operation_name LIKE 'service.%'
        AND start_time > NOW() - INTERVAL '${timeRange}'
      GROUP BY tags->>'service', tags->>'target_service'
    `);

    // 构建节点和边
    const nodes = new Set();
    const edges = [];

    for (const call of calls.rows) {
      if (call.source_service && call.target_service) {
        nodes.add(call.source_service);
        nodes.add(call.target_service);

        edges.push({
          source: call.source_service,
          target: call.target_service,
          metrics: {
            callCount: parseInt(call.call_count),
            avgDuration: parseFloat(call.avg_duration),
            p95Duration: parseFloat(call.p95_duration),
            errorCount: parseInt(call.error_count),
            errorRate: (parseInt(call.error_count) / parseInt(call.call_count) * 100).toFixed(2)
          }
        });
      }
    }

    // 生成拓扑数据
    const topology = {
      nodes: Array.from(nodes).map(name => ({
        id: name,
        label: name,
        type: this._getServiceType(name)
      })),
      edges,
      metadata: {
        generatedAt: new Date().toISOString(),
        timeRange,
        totalServices: nodes.size,
        totalEdges: edges.length
      }
    };

    return topology;
  }

  /**
   * 获取服务类型
   */
  _getServiceType(serviceName) {
    if (serviceName.includes('gateway')) return 'gateway';
    if (serviceName.includes('service')) return 'microservice';
    if (serviceName.includes('database')) return 'database';
    if (serviceName.includes('cache')) return 'cache';
    return 'unknown';
  }

  /**
   * 导出为 Graphviz DOT 格式
   */
  exportToDot(topology) {
    const lines = ['digraph ServiceTopology {'];
    lines.push('  rankdir=LR;');
    lines.push('  node [shape=box];');
    
    for (const node of topology.nodes) {
      lines.push(`  "${node.id}" [label="${node.label}"];`);
    }

    for (const edge of topology.edges) {
      const label = `${edge.metrics.callCount} calls\\n${edge.metrics.avgDuration}ms avg`;
      lines.push(`  "${edge.source}" -> "${edge.target}" [label="${label}"];`);
    }

    lines.push('}');
    return lines.join('\n');
  }

  /**
   * 导出为 Cytoscape.js 格式
   */
  exportToCytoscape(topology) {
    return {
      elements: {
        nodes: topology.nodes.map(n => ({
          data: { id: n.id, label: n.label, type: n.type }
        })),
        edges: topology.edges.map((e, i) => ({
          data: {
            id: `edge-${i}`,
            source: e.source,
            target: e.target,
            ...e.metrics
          }
        }))
      }
    };
  }
}

module.exports = ServiceTopologyGenerator;
```

### 4.5 数据库表结构

```sql
-- Trace spans 表
CREATE TABLE trace_spans (
  id BIGSERIAL PRIMARY KEY,
  trace_id VARCHAR(32) NOT NULL,
  span_id VARCHAR(16) NOT NULL,
  parent_span_id VARCHAR(16),
  operation_name VARCHAR(255) NOT NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP,
  duration INTEGER NOT NULL,
  status VARCHAR(20) DEFAULT 'ok',
  tags JSONB DEFAULT '{}',
  logs JSONB DEFAULT '[]',
  service_name VARCHAR(64),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_trace_spans_trace_id ON trace_spans(trace_id);
CREATE INDEX idx_trace_spans_operation ON trace_spans(operation_name);
CREATE INDEX idx_trace_spans_service ON trace_spans(service_name);
CREATE INDEX idx_trace_spans_time ON trace_spans(start_time);

-- 延迟统计表
CREATE TABLE latency_stats (
  id BIGSERIAL PRIMARY KEY,
  service_name VARCHAR(64) NOT NULL,
  endpoint VARCHAR(255),
  time_bucket TIMESTAMP NOT NULL,
  request_count INTEGER NOT NULL,
  avg_duration DECIMAL(10, 2),
  p50_duration DECIMAL(10, 2),
  p90_duration DECIMAL(10, 2),
  p95_duration DECIMAL(10, 2),
  p99_duration DECIMAL(10, 2),
  error_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_latency_stats_service ON latency_stats(service_name);
CREATE INDEX idx_latency_stats_time ON latency_stats(time_bucket);
```

## 5. 验收标准（可测试）

- [ ] TraceID 在所有服务间调用中正确传播（HTTP、Kafka）
- [ ] 延迟分析器能准确分解请求在各层的耗时
- [ ] 关键路径识别器能找到最长路径并识别瓶颈
- [ ] 服务拓扑生成器能正确生成服务依赖图
- [ ] 延迟热力图数据正确（按时间段分布）
- [ ] 数据库查询延迟正确记录（包含查询语句）
- [ ] Redis 缓存延迟正确记录（包含 key 和命中状态）
- [ ] 外部 API 调用延迟正确记录（包含 URL 和状态码）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 性能开销 < 2%（采样场景下）

## 6. 工作量估算

**L - 大工作量**

- RequestChainTracer: 3 小时
- LatencyAnalyzer: 4 小时
- CriticalPathFinder: 3 小时
- ServiceTopologyGenerator: 2 小时
- LatencyHeatmap: 2 小时
- 数据库设计与迁移: 2 小时
- Dashboard API: 3 小时
- 单元测试: 4 小时

总计约 23 小时，需 3 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **可观测性核心能力**：链路追踪是生产环境问题排查的基础设施
2. **性能优化基础**：无法度量就无法优化，延迟分析是性能优化的前提
3. **架构治理**：服务拓扑图是微服务架构治理的重要工具
4. **故障定位**：快速定位性能瓶颈和故障点，减少 MTTR
5. **成熟度提升**：完善可观测性体系，提升项目成熟度评分

此需求是生产环境运维和性能优化的必要保障。