# REQ-00168: 分布式追踪与请求链路可视化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00168 |
| 标题 | 分布式追踪与请求链路可视化系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-13 21:00 |

## 需求描述

在微服务架构中，单个请求可能跨越多个服务，当出现性能问题或错误时，难以快速定位问题源头。本需求旨在实现完整的分布式追踪系统，通过 OpenTelemetry 标准采集追踪数据，提供请求链路的可视化展示，帮助开发者快速定位性能瓶颈和故障根因。

### 核心目标
1. **全链路追踪**：覆盖从 API 网关到所有微服务的完整请求链路
2. **可视化展示**：提供直观的链路拓扑图和时间线视图
3. **性能分析**：自动识别慢服务和性能瓶颈
4. **故障定位**：快速定位错误发生的具体服务和方法
5. **采样策略**：智能采样降低存储成本，保证关键请求 100% 追踪

## 技术方案

### 1. OpenTelemetry SDK 集成

```javascript
// backend/shared/tracing/index.js
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { SimpleSpanProcessor, BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { ZipkinExporter } = require('@opentelemetry/exporter-zipkin');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { B3Propagator, B3InjectEncoding } = require('@opentelemetry/propagator-b3');
const { CompositePropagator, W3CTraceContextPropagator } = require('@opentelemetry/core');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');
const { RedisInstrumentation } = require('@opentelemetry/instrumentation-redis-4');
const { KafkaJsInstrumentation } = require('@opentelemetry/instrumentation-kafkajs');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');

class TracingManager {
  constructor(config) {
    this.config = {
      serviceName: config.serviceName,
      environment: process.env.NODE_ENV || 'development',
      sampleRate: config.sampleRate || 0.1, // 10% 采样率
      exporterType: config.exporterType || 'jaeger', // jaeger | zipkin | otlp
      jaegerEndpoint: config.jaegerEndpoint || 'http://jaeger:14268/api/traces',
      otlpEndpoint: config.otlpEndpoint || 'grpc://tempo:4317',
      ...config
    };
    this.provider = null;
    this.tracer = null;
  }

  async initialize() {
    // 创建资源标识
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.SERVICE_VERSION || '1.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment,
      [SemanticResourceAttributes.SERVICE_INSTANCE_ID]: process.env.HOSTNAME || 'unknown'
    });

    // 创建 TracerProvider
    this.provider = new NodeTracerProvider({
      resource,
      sampler: this.createSampler()
    });

    // 添加导出器
    this.addExporters();

    // 注册自动埋点
    this.registerInstrumentations();

    // 设置传播器（支持 B3 和 W3C 格式）
    this.provider.register({
      propagator: new CompositePropagator({
        propagators: [
          new B3Propagator({ injectEncoding: B3InjectEncoding.MULTI_HEADER }),
          new W3CTraceContextPropagator()
        ]
      })
    });

    this.tracer = this.provider.getTracer(this.config.serviceName);

    console.log(`[Tracing] Initialized for ${this.config.serviceName}, sampleRate: ${this.config.sampleRate}`);
    return this;
  }

  createSampler() {
    const { ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler } = require('@opentelemetry/core');

    return new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(this.config.sampleRate),
      remoteParentSampled: new AlwaysOnSampler(),
      remoteParentNotSampled: new TraceIdRatioBasedSampler(0),
      localParentSampled: new AlwaysOnSampler(),
      localParentNotSampled: new TraceIdRatioBasedSampler(0)
    });
  }

  addExporters() {
    let exporter;

    switch (this.config.exporterType) {
      case 'jaeger':
        exporter = new JaegerExporter({
          endpoint: this.config.jaegerEndpoint,
        });
        break;
      case 'zipkin':
        exporter = new ZipkinExporter({
          url: this.config.zipkinUrl || 'http://zipkin:9411/api/v2/spans',
        });
        break;
      case 'otlp':
        exporter = new OTLPTraceExporter({
          url: this.config.otlpEndpoint,
        });
        break;
      default:
        exporter = new JaegerExporter({
          endpoint: this.config.jaegerEndpoint,
        });
    }

    // 使用 BatchSpanProcessor 提升性能
    this.provider.addSpanProcessor(
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 30000
      })
    );
  }

  registerInstrumentations() {
    registerInstrumentations({
      tracerProvider: this.provider,
      instrumentations: [
        new HttpInstrumentation({
          requestHook: (span, request) => {
            span.setAttribute('http.request.body.size', request.headers['content-length'] || 0);
          },
          responseHook: (span, response) => {
            span.setAttribute('http.response.body.size', response.headers['content-length'] || 0);
          }
        }),
        new ExpressInstrumentation({
          requestHook: (span, request) => {
            span.setAttribute('express.route', request.route?.path || 'unknown');
            span.setAttribute('express.params', JSON.stringify(request.params));
          }
        }),
        new PgInstrumentation({
          enhancedDatabaseReporting: true,
          requestHook: (span, query) => {
            // 脱敏 SQL 查询
            const sanitizedQuery = this.sanitizeSQL(query.text);
            span.setAttribute('db.statement', sanitizedQuery);
            span.setAttribute('db.table', this.extractTableFromSQL(query.text));
          }
        }),
        new RedisInstrumentation({
          enhancedDatabaseReporting: true
        }),
        new KafkaJsInstrumentation()
      ]
    });
  }

  sanitizeSQL(sql) {
    // 移除敏感信息（密码、token等）
    return sql
      .replace(/password\s*=\s*'[^']*'/gi, "password='***'")
      .replace(/token\s*=\s*'[^']*'/gi, "token='***'")
      .replace(/api_key\s*=\s*'[^']*'/gi, "api_key='***'");
  }

  extractTableFromSQL(sql) {
    const match = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    return match ? match[1] : 'unknown';
  }

  getTracer() {
    return this.tracer;
  }

  // 手动创建 Span
  startSpan(name, options = {}) {
    return this.tracer.startSpan(name, options);
  }

  // 强制采样（用于关键请求）
  forceSample(ctx) {
    const span = this.tracer.startSpan('force-sample', { parent: ctx });
    span.setAttribute('sampling.priority', 1);
    return span;
  }

  async shutdown() {
    await this.provider.shutdown();
    console.log('[Tracing] Provider shutdown complete');
  }
}

// 中间件：自动创建 Span
function tracingMiddleware(tracerManager) {
  return async (req, res, next) => {
    const spanName = `${req.method} ${req.route?.path || req.path}`;
    const span = tracerManager.startSpan(spanName, {
      attributes: {
        'http.method': req.method,
        'http.url': req.originalUrl,
        'http.host': req.hostname,
        'http.scheme': req.protocol,
        'http.user_agent': req.get('user-agent'),
        'user.id': req.user?.id || 'anonymous'
      }
    });

    // 将 span 存储到请求上下文
    req.span = span;
    req.tracer = tracerManager.getTracer();

    // 监听响应完成
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.setStatus({
        code: res.statusCode < 400 ? 0 : 2, // OK or ERROR
        message: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : undefined
      });
      span.end();
    });

    // 监听错误
    res.on('error', (err) => {
      span.recordException(err);
      span.setStatus({ code: 2, message: err.message });
      span.end();
    });

    next();
  };
}

module.exports = {
  TracingManager,
  tracingMiddleware
};
```

### 2. 网关层追踪集成

```javascript
// backend/services/gateway/src/middleware/tracing.js
const { context, propagation, trace } = require('@opentelemetry/api');
const { TracingManager, tracingMiddleware } = require('../../../shared/tracing');

let tracingManager;

async function initTracing() {
  tracingManager = new TracingManager({
    serviceName: 'gateway',
    sampleRate: parseFloat(process.env.TRACE_SAMPLE_RATE || '0.1'),
    exporterType: process.env.TRACE_EXPORTER || 'jaeger',
    jaegerEndpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger:14268/api/traces'
  });

  await tracingManager.initialize();
  return tracingManager;
}

// 下游服务调用时传播追踪上下文
function propagateTraceHeaders(req) {
  const headers = {};
  propagation.inject(context.active(), headers);
  return {
    ...headers,
    'X-Trace-ID': req.span?.spanContext()?.traceId || 'unknown',
    'X-Request-ID': req.id
  };
}

// 强制采样标记（用于错误请求）
function markForSampling(req) {
  if (req.span) {
    req.span.setAttribute('sampling.priority', 1);
  }
}

module.exports = {
  initTracing,
  tracingMiddleware,
  propagateTraceHeaders,
  markForSampling,
  getTracer: () => tracingManager?.getTracer()
};
```

### 3. 微服务追踪配置

```javascript
// backend/shared/tracing/service-config.js
const SERVICE_TRACING_CONFIG = {
  'user-service': {
    sampleRate: 0.1,
    criticalOperations: ['login', 'register', 'password-reset']
  },
  'pokemon-service': {
    sampleRate: 0.05, // 数据量大，降低采样
    criticalOperations: ['evolve', 'trade', 'release']
  },
  'catch-service': {
    sampleRate: 0.08,
    criticalOperations: ['catch', 'escape']
  },
  'gym-service': {
    sampleRate: 0.1,
    criticalOperations: ['battle', 'claim']
  },
  'payment-service': {
    sampleRate: 1.0, // 支付请求 100% 追踪
    criticalOperations: ['create-order', 'payment-callback', 'refund']
  },
  'social-service': {
    sampleRate: 0.05,
    criticalOperations: ['pvp-duel', 'trade']
  },
  'location-service': {
    sampleRate: 0.03, // 位置查询最频繁
    criticalOperations: ['spawn-pokemon', 'update-location']
  },
  'reward-service': {
    sampleRate: 0.05,
    criticalOperations: ['claim-reward', 'daily-bonus']
  }
};

function getServiceTracingConfig(serviceName) {
  return SERVICE_TRACING_CONFIG[serviceName] || { sampleRate: 0.1, criticalOperations: [] };
}

module.exports = { SERVICE_TRACING_CONFIG, getServiceTracingConfig };
```

### 4. Jaeger 部署配置

```yaml
# infrastructure/k8s/monitoring/jaeger.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
      - name: jaeger
        image: jaegertracing/all-in-one:1.52
        ports:
        - containerPort: 16686
          name: ui
        - containerPort: 14268
          name: http
        - containerPort: 14250
          name: grpc
        - containerPort: 6831
          name: udp
          protocol: UDP
        env:
        - name: COLLECTOR_ZIPKIN_HOST_PORT
          value: ":9411"
        - name: SPAN_STORAGE_TYPE
          value: elasticsearch
        - name: ES_SERVER_URLS
          value: "http://elasticsearch:9200"
        - name: ES_INDEX_PREFIX
          value: "minego-traces"
        resources:
          requests:
            cpu: 200m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
  namespace: monitoring
spec:
  selector:
    app: jaeger
  ports:
  - name: ui
    port: 16686
    targetPort: 16686
  - name: http
    port: 14268
    targetPort: 14268
  - name: grpc
    port: 14250
    targetPort: 14250
  - name: udp
    port: 6831
    targetPort: 6831
    protocol: UDP
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: jaeger-ingress
  namespace: monitoring
  annotations:
    nginx.ingress.kubernetes.io/auth-type: basic
    nginx.ingress.kubernetes.io/auth-secret: jaeger-auth
    nginx.ingress.kubernetes.io/auth-realm: 'Authentication Required'
spec:
  rules:
  - host: jaeger.minego.internal
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: jaeger
            port:
              number: 16686
```

### 5. 追踪数据存储与索引优化

```javascript
// backend/shared/tracing/trace-storage.js
const { Client } = require('@elastic/elasticsearch');

class TraceStorage {
  constructor(config) {
    this.client = new Client({
      node: config.elasticsearchUrl || 'http://elasticsearch:9200',
      indexPrefix: config.indexPrefix || 'minego-traces'
    });
  }

  async createIndexTemplate() {
    await this.client.indices.putIndexTemplate({
      name: 'traces-template',
      body: {
        index_patterns: [`${this.indexPrefix}-*`],
        template: {
          settings: {
            number_of_shards: 3,
            number_of_replicas: 1,
            'index.lifecycle.name': 'traces-policy',
            'index.lifecycle.rollover_alias': this.indexPrefix
          },
          mappings: {
            properties: {
              traceID: { type: 'keyword' },
              spanID: { type: 'keyword' },
              parentSpanID: { type: 'keyword' },
              operationName: { type: 'keyword' },
              serviceName: { type: 'keyword' },
              startTime: { type: 'date' },
              duration: { type: 'long' },
              tags: { type: 'object', enabled: false },
              logs: { type: 'object', enabled: false },
              'http.method': { type: 'keyword' },
              'http.url': { type: 'keyword' },
              'http.status_code': { type: 'integer' },
              'error': { type: 'boolean' },
              'user.id': { type: 'keyword' }
            }
          }
        }
      }
    });
  }

  async searchTraces(query) {
    const {
      serviceName,
      operationName,
      traceID,
      minDuration,
      maxDuration,
      startTime,
      endTime,
      error,
      userId,
      limit = 20
    } = query;

    const must = [];

    if (serviceName) {
      must.push({ term: { serviceName } });
    }
    if (operationName) {
      must.push({ wildcard: { operationName: `*${operationName}*` } });
    }
    if (traceID) {
      must.push({ term: { traceID } });
    }
    if (minDuration || maxDuration) {
      const range = {};
      if (minDuration) range.gte = minDuration;
      if (maxDuration) range.lte = maxDuration;
      must.push({ range: { duration } });
    }
    if (startTime || endTime) {
      const range = {};
      if (startTime) range.gte = startTime;
      if (endTime) range.lte = endTime;
      must.push({ range: { startTime: range } });
    }
    if (error !== undefined) {
      must.push({ term: { error } });
    }
    if (userId) {
      must.push({ term: { 'user.id': userId } });
    }

    const result = await this.client.search({
      index: `${this.indexPrefix}-*`,
      body: {
        query: { bool: { must } },
        size: limit,
        sort: [{ startTime: 'desc' }]
      }
    });

    return result.body.hits.hits.map(hit => hit._source);
  }

  async getTraceStatistics(serviceName, timeRange) {
    const result = await this.client.search({
      index: `${this.indexPrefix}-*`,
      body: {
        query: {
          bool: {
            must: [
              { term: { serviceName } },
              { range: { startTime: timeRange } }
            ]
          }
        },
        aggs: {
          avg_duration: { avg: { field: 'duration' } },
          max_duration: { max: { field: 'duration' } },
          min_duration: { min: { field: 'duration' } },
          p95_duration: {
            percentiles: { field: 'duration', percents: [95] }
          },
          error_rate: {
            filters: {
              filters: {
                errors: { term: { error: true } }
              }
            }
          },
          operations: {
            terms: { field: 'operationName', size: 20 }
          }
        }
      }
    });

    const aggs = result.body.aggregations;
    return {
      avgDuration: aggs.avg_duration.value,
      maxDuration: aggs.max_duration.value,
      minDuration: aggs.min_duration.value,
      p95Duration: aggs.p95_duration.values['95.0'],
      errorRate: aggs.error_rate.buckets.errors.doc_count / result.body.hits.total.value,
      topOperations: aggs.operations.buckets.map(b => ({
        operation: b.key,
        count: b.doc_count
      }))
    };
  }

  async getServiceDependencies(timeRange) {
    const result = await this.client.search({
      index: `${this.indexPrefix}-*`,
      body: {
        query: {
          range: { startTime: timeRange }
        },
        aggs: {
          services: {
            terms: { field: 'serviceName', size: 50 },
            aggs: {
              downstream: {
                terms: { field: 'peer.service', size: 20 }
              }
            }
          }
        }
      }
    });

    const dependencies = [];
    result.body.aggregations.services.buckets.forEach(service => {
      service.downstream.buckets.forEach(downstream => {
        dependencies.push({
          source: service.key,
          target: downstream.key,
          callCount: downstream.doc_count
        });
      });
    });

    return dependencies;
  }
}

module.exports = { TraceStorage };
```

### 6. 追踪查询 API

```javascript
// backend/services/gateway/src/routes/traces.js
const express = require('express');
const router = express.Router();
const { TraceStorage } = require('../../../shared/tracing/trace-storage');

const traceStorage = new TraceStorage();

// 查询追踪列表
router.get('/traces', async (req, res, next) => {
  try {
    const traces = await traceStorage.searchTraces(req.query);
    res.json({ success: true, data: traces });
  } catch (error) {
    next(error);
  }
});

// 获取单个追踪详情
router.get('/traces/:traceId', async (req, res, next) => {
  try {
    const traces = await traceStorage.searchTraces({
      traceID: req.params.traceId,
      limit: 1000
    });

    if (traces.length === 0) {
      return res.status(404).json({ success: false, error: 'Trace not found' });
    }

    // 构建 span 树
    const spanMap = new Map();
    const rootSpans = [];

    traces.forEach(span => {
      spanMap.set(span.spanID, span);
    });

    traces.forEach(span => {
      if (span.parentSpanID && spanMap.has(span.parentSpanID)) {
        const parent = spanMap.get(span.parentSpanID);
        parent.children = parent.children || [];
        parent.children.push(span);
      } else {
        rootSpans.push(span);
      }
    });

    res.json({
      success: true,
      data: {
        traceId: req.params.traceId,
        spans: traces,
        spanTree: rootSpans
      }
    });
  } catch (error) {
    next(error);
  }
});

// 获取服务统计
router.get('/services/:serviceName/stats', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const stats = await traceStorage.getTraceStatistics(
      req.params.serviceName,
      { gte: from, lte: to }
    );
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});

// 获取服务依赖图
router.get('/dependencies', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const dependencies = await traceStorage.getServiceDependencies(
      { gte: from, lte: to }
    );
    res.json({ success: true, data: dependencies });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

### 7. Grafana 追踪可视化仪表板

```json
{
  "dashboard": {
    "title": "mineGo Distributed Tracing",
    "panels": [
      {
        "title": "Request Latency Distribution",
        "type": "heatmap",
        "datasource": "Elasticsearch",
        "targets": [
          {
            "query": {
              "size": 0,
              "aggs": {
                "services": {
                  "terms": { "field": "serviceName", "size": 20 },
                  "aggs": {
                    "latency_histogram": {
                      "histogram": { "field": "duration", "interval": 100 }
                    }
                  }
                }
              }
            }
          }
        ]
      },
      {
        "title": "Error Traces",
        "type": "table",
        "datasource": "Elasticsearch",
        "targets": [
          {
            "query": {
              "query": { "term": { "error": true } },
              "size": 100,
              "sort": [{ "startTime": "desc" }]
            }
          }
        ]
      },
      {
        "title": "Slow Traces (> 1s)",
        "type": "table",
        "datasource": "Elasticsearch",
        "targets": [
          {
            "query": {
              "query": { "range": { "duration": { "gte": 1000000 } } },
              "size": 50,
              "sort": [{ "duration": "desc" }]
            }
          }
        ]
      },
      {
        "title": "Service Dependency Graph",
        "type": "nodeGraph",
        "datasource": "Elasticsearch",
        "targets": [
          {
            "query": {
              "size": 0,
              "aggs": {
                "services": {
                  "terms": { "field": "serviceName", "size": 50 },
                  "aggs": {
                    "downstream": {
                      "terms": { "field": "peer.service", "size": 20 }
                    }
                  }
                }
              }
            }
          }
        ]
      }
    ]
  }
}
```

## 验收标准

- [ ] 所有微服务集成 OpenTelemetry SDK，自动上报追踪数据
- [ ] Jaeger 部署完成，可通过 Web UI 查询追踪
- [ ] 追踪数据存储到 Elasticsearch，支持 7 天数据保留
- [ ] 采样策略生效，普通请求 10% 采样，支付请求 100% 追踪
- [ ] API 网关正确传播追踪上下文到下游服务
- [ ] 错误请求自动标记为强制采样
- [ ] Grafana 仪表板展示追踪统计和依赖图
- [ ] 追踪查询 API 可按服务、时间、错误等条件过滤
- [ ] 服务依赖关系可视化展示
- [ ] 性能开销 < 5%，不影响正常业务请求

## 影响范围

- 新增文件：
  - `backend/shared/tracing/index.js` - 追踪管理器核心
  - `backend/shared/tracing/service-config.js` - 服务追踪配置
  - `backend/shared/tracing/trace-storage.js` - 追踪数据存储
  - `infrastructure/k8s/monitoring/jaeger.yaml` - Jaeger 部署配置
  - `infrastructure/k8s/monitoring/tracing-dashboard.json` - Grafana 仪表板

- 修改文件：
  - 所有微服务的入口文件 - 集成追踪初始化
  - `backend/services/gateway/src/index.js` - 添加追踪中间件
  - `backend/services/gateway/src/routes/traces.js` - 追踪查询 API
  - `infrastructure/k8s/monitoring/` - 监控配置更新

## 参考

- [OpenTelemetry 官方文档](https://opentelemetry.io/docs/)
- [Jaeger 分布式追踪系统](https://www.jaegertracing.io/docs/)
- [OpenTelemetry JavaScript SDK](https://github.com/open-telemetry/opentelemetry-js)
- [W3C Trace Context 规范](https://www.w3.org/TR/trace-context/)
- [Elasticsearch 追踪数据索引最佳实践](https://www.elastic.co/guide/en/elasticsearch/reference/current/trace-analyzation.html)
