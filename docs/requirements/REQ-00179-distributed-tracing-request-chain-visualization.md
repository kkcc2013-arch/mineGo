# REQ-00179: 分布式追踪与请求链路可视化系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00179 |
| 标题 | 分布式追踪与请求链路可视化系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-14 03:00 |

## 需求描述

### 背景
当前 mineGo 采用微服务架构，单个用户请求可能穿越多个微服务（如 gateway → user-service → pokemon-service → database）。当出现性能问题或错误时，缺乏端到端的请求链路追踪能力，导致故障定位困难、根因分析耗时长。

### 目标
构建完整的分布式追踪系统，实现：
1. **全链路追踪**：从客户端请求入口到数据库访问的完整调用链
2. **可视化展示**：通过 Jaeger/Grafana Tempo 展示请求拓扑和耗时分布
3. **性能分析**：识别慢调用、热点服务和性能瓶颈
4. **错误关联**：跨服务的错误传播路径追踪

## 技术方案

### 1. 追踪 SDK 集成

```javascript
// backend/shared/tracing/index.js
const opentelemetry = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

class TracingManager {
  constructor(serviceName, config = {}) {
    this.serviceName = serviceName;
    this.config = {
      jaegerEndpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger-collector:14268/api/traces',
      sampleRate: parseFloat(process.env.TRACE_SAMPLE_RATE) || 0.1,
      ...config
    };
    this.provider = null;
    this.tracer = null;
  }

  async initialize() {
    const resource = new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: this.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.SERVICE_VERSION || '1.0.0',
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development'
    });

    this.provider = new NodeTracerProvider({ resource });

    const jaegerExporter = new JaegerExporter({
      endpoint: this.config.jaegerEndpoint
    });

    this.provider.addSpanProcessor(
      new BatchSpanProcessor(jaegerExporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000
      })
    );

    await this.provider.register();
    this.tracer = opentelemetry.trace.getTracer(this.serviceName);
    
    console.log(`[Tracing] Initialized for ${this.serviceName}`);
    return this;
  }

  // 创建子 span
  startSpan(name, parentSpan = null, attributes = {}) {
    const context = parentSpan 
      ? opentelemetry.trace.setSpan(opentelemetry.context.active(), parentSpan)
      : opentelemetry.context.active();
    
    return this.tracer.startSpan(name, { attributes }, context);
  }

  // 注入追踪头到 HTTP 请求
  injectTraceContext(carrier) {
    opentelemetry.propagation.inject(opentelemetry.context.active(), carrier);
  }

  // 从 HTTP 请求提取追踪上下文
  extractTraceContext(carrier) {
    return opentelemetry.propagation.extract(opentelemetry.context.active(), carrier);
  }

  async shutdown() {
    await this.provider?.shutdown();
  }
}

module.exports = { TracingManager, opentelemetry };
```

### 2. Gateway 追踪中间件

```javascript
// backend/services/gateway/src/middleware/tracingMiddleware.js
const { TracingManager, opentelemetry } = require('../../../shared/tracing');
const { v4: uuidv4 } = require('uuid');

class TracingMiddleware {
  constructor(tracingManager) {
    this.tracing = tracingManager;
  }

  middleware() {
    return async (req, res, next) => {
      const startTime = Date.now();
      const traceId = req.headers['x-trace-id'] || uuidv4();
      const parentSpanContext = this.tracing.extractTraceContext(req.headers);

      // 创建根 span
      const span = this.tracing.startSpan(
        `HTTP ${req.method} ${req.path}`,
        null,
        {
          'http.method': req.method,
          'http.url': req.originalUrl,
          'http.route': req.route?.path || req.path,
          'http.request_id': traceId,
          'user.id': req.user?.id || 'anonymous',
          'http.user_agent': req.headers['user-agent']
        }
      );

      // 设置响应头
      res.setHeader('x-trace-id', traceId);

      // 存储到请求上下文
      req.traceContext = {
        traceId,
        span,
        startTime
      };

      // 响应完成时结束 span
      res.on('finish', () => {
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response_size': res.get('content-length') || 0
        });
        
        if (res.statusCode >= 400) {
          span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR });
        }

        span.end();
        
        // 记录请求耗时
        const duration = Date.now() - startTime;
        req.log?.info({
          traceId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration
        }, 'Request completed');
      });

      next();
    };
  }

  // 向下游服务传递追踪上下文
  propagateContext(axiosConfig) {
    const span = opentelemetry.trace.getActiveSpan();
    if (span) {
      const headers = {};
      this.tracing.injectTraceContext(headers);
      axiosConfig.headers = { ...axiosConfig.headers, ...headers };
    }
    return axiosConfig;
  }
}

module.exports = { TracingMiddleware };
```

### 3. 微服务追踪集成

```javascript
// backend/shared/tracing/serviceIntegration.js
const { TracingManager, opentelemetry } = require('./index');

class ServiceTracingIntegration {
  constructor(serviceName) {
    this.serviceName = serviceName;
    this.tracing = null;
  }

  async init() {
    this.tracing = await new TracingManager(this.serviceName).initialize();
    this.setupExpressMiddleware();
    this.setupDatabaseTracing();
    this.setupRedisTracing();
  }

  // Express 中间件集成
  setupExpressMiddleware() {
    return (req, res, next) => {
      const parentContext = this.tracing.extractTraceContext(req.headers);
      const span = this.tracing.startSpan(
        `${this.serviceName} - ${req.method} ${req.path}`,
        null,
        {
          'http.method': req.method,
          'http.route': req.route?.path,
          'service.name': this.serviceName
        }
      );

      req.span = span;
      
      res.on('finish', () => {
        span.setAttributes({ 'http.status_code': res.statusCode });
        span.end();
      });

      next();
    };
  }

  // 数据库调用追踪
  traceDatabaseCall(operation, table, callback) {
    const span = this.tracing.startSpan(
      `DB ${operation} ${table}`,
      opentelemetry.trace.getActiveSpan(),
      {
        'db.system': 'postgresql',
        'db.operation': operation,
        'db.table': table,
        'db.statement': operation
      }
    );

    try {
      const result = callback();
      if (result.then) {
        return result
          .then(data => {
            span.setStatus({ code: opentelemetry.SpanStatusCode.OK });
            return data;
          })
          .catch(err => {
            span.recordException(err);
            span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: err.message });
            throw err;
          })
          .finally(() => span.end());
      }
      span.end();
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: err.message });
      span.end();
      throw err;
    }
  }

  // Redis 调用追踪
  traceRedisCall(command, key, callback) {
    const span = this.tracing.startSpan(
      `Redis ${command}`,
      opentelemetry.trace.getActiveSpan(),
      {
        'db.system': 'redis',
        'db.operation': command,
        'db.statement': `${command} ${key}`
      }
    );

    try {
      const result = callback();
      if (result.then) {
        return result
          .then(data => {
            span.setAttributes({ 'redis.key': key });
            return data;
          })
          .catch(err => {
            span.recordException(err);
            throw err;
          })
          .finally(() => span.end());
      }
      span.end();
      return result;
    } catch (err) {
      span.recordException(err);
      span.end();
      throw err;
    }
  }
}

module.exports = { ServiceTracingIntegration };
```

### 4. K8s 部署配置

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
          name: collector
        env:
        - name: COLLECTOR_OTLP_ENABLED
          value: "true"
        - name: SPAN_STORAGE_TYPE
          value: elasticsearch
        - name: ES_SERVER_URLS
          value: http://elasticsearch:9200
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
  namespace: monitoring
spec:
  type: ClusterIP
  ports:
  - port: 16686
    targetPort: 16686
    name: ui
  - port: 14268
    targetPort: 14268
    name: collector
  selector:
    app: jaeger
---
# Grafana 数据源配置
apiVersion: 1
datasources:
- name: Jaeger
  type: jaeger
  url: http://jaeger.monitoring:16686
  access: proxy
  isDefault: false
```

### 5. 追踪数据查询与分析

```javascript
// backend/shared/tracing/traceAnalyzer.js
class TraceAnalyzer {
  constructor(jaegerApiUrl = 'http://jaeger:16686') {
    this.jaegerApiUrl = jaegerApiUrl;
  }

  // 查询慢请求
  async findSlowTraces(serviceName, minDurationMs, limit = 100) {
    const response = await fetch(
      `${this.jaegerApiUrl}/api/traces?service=${serviceName}&` +
      `minDuration=${minDurationMs * 1000}µs&limit=${limit}`
    );
    const data = await response.json();
    
    return data.data.map(trace => ({
      traceId: trace.traceID,
      duration: trace.spans.reduce((sum, s) => sum + (s.duration / 1000), 0),
      services: [...new Set(trace.spans.map(s => s.process.serviceName))],
      rootOperation: trace.spans.find(s => !s.references?.length)?.operationName
    }));
  }

  // 分析服务依赖关系
  async getServiceDependencies(lookback = '24h') {
    const response = await fetch(
      `${this.jaegerApiUrl}/api/dependencies?lookback=${lookback}`
    );
    const data = await response.json();
    
    return data.data.map(dep => ({
      from: dep.parent,
      to: dep.child,
      callCount: dep.callCount
    }));
  }

  // 错误追踪分析
  async findErrorTraces(serviceName, limit = 50) {
    const response = await fetch(
      `${this.jaegerApiUrl}/api/traces?service=${serviceName}&tags={"error":"true"}&limit=${limit}`
    );
    const data = await response.json();
    
    return data.data.map(trace => ({
      traceId: trace.traceID,
      errorSpans: trace.spans.filter(s => s.tags?.some(t => t.key === 'error')),
      rootCause: trace.spans.find(s => s.tags?.some(t => t.key === 'error'))?.operationName
    }));
  }
}

module.exports = { TraceAnalyzer };
```

### 6. 采样策略配置

```javascript
// backend/shared/tracing/sampling.js
const opentelemetry = require('@opentelemetry/api');

class AdaptiveSampler {
  constructor(config = {}) {
    this.config = {
      defaultSampleRate: 0.1,        // 默认 10% 采样
      errorSampleRate: 1.0,          // 错误请求 100% 采样
      slowRequestSampleRate: 1.0,    // 慢请求 100% 采样
      slowThresholdMs: 1000,         // 慢请求阈值
      perServiceRates: {},           // 服务特定采样率
      ...config
    };
    this.requestCounts = new Map();
  }

  shouldSample(spanAttributes) {
    const { serviceName, httpStatusCode, duration } = spanAttributes;
    
    // 错误请求全部采样
    if (httpStatusCode >= 400) {
      return this.config.errorSampleRate === 1.0 || Math.random() < this.config.errorSampleRate;
    }

    // 慢请求全部采样
    if (duration > this.config.slowThresholdMs) {
      return this.config.slowRequestSampleRate === 1.0 || 
             Math.random() < this.config.slowRequestSampleRate;
    }

    // 使用服务特定采样率或默认采样率
    const sampleRate = this.config.perServiceRates[serviceName] || this.config.defaultSampleRate;
    return Math.random() < sampleRate;
  }

  // 动态调整采样率
  adjustSamplingRate(serviceName, errorRate, latency) {
    if (errorRate > 0.05 || latency > 500) {
      // 高错误率或高延迟时，增加采样率
      this.config.perServiceRates[serviceName] = Math.min(
        (this.config.perServiceRates[serviceName] || this.config.defaultSampleRate) * 2,
        0.5
      );
    } else {
      // 正常情况下降低采样率以节省存储
      this.config.perServiceRates[serviceName] = Math.max(
        (this.config.perServiceRates[serviceName] || this.config.defaultSampleRate) * 0.9,
        0.01
      );
    }
  }
}

module.exports = { AdaptiveSampler };
```

## 验收标准

- [ ] 所有微服务集成 OpenTelemetry SDK，追踪数据发送到 Jaeger
- [ ] Gateway 请求自动创建 root span，Trace ID 透传到响应头
- [ ] 数据库和 Redis 调用自动创建子 span
- [ ] Jaeger UI 可查询并展示完整请求链路
- [ ] Grafana 集成 Jaeger 数据源，支持从指标跳转到追踪
- [ ] 采样策略支持动态调整，错误请求 100% 采样
- [ ] 服务依赖拓扑图可在 Jaeger 中查看
- [ ] 单元测试覆盖追踪 SDK 核心功能

## 影响范围

- `backend/shared/tracing/` - 新增追踪 SDK 模块
- `backend/services/gateway/src/middleware/tracingMiddleware.js` - Gateway 追踪中间件
- 所有微服务 - 集成追踪 SDK
- `infrastructure/k8s/monitoring/jaeger.yaml` - Jaeger 部署配置
- `infrastructure/k8s/monitoring/grafana-datasources.yaml` - Grafana 数据源配置

## 参考

- [OpenTelemetry JavaScript SDK](https://opentelemetry.io/docs/instrumentation/js/)
- [Jaeger Architecture](https://www.jaegertracing.io/docs/latest/architecture/)
- [Distributed Tracing Best Practices](https://opentelemetry.io/docs/concepts/signals/traces/)
