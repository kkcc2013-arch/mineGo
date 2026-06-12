# REQ-00148: 分布式追踪与请求链路可视化系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00148 |
| 标题 | 分布式追踪与请求链路可视化系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-12 08:00 |

## 背景与价值

当前 mineGo 已具备结构化日志（REQ-00002）和 Prometheus 指标监控，但在排查跨服务问题时仍面临困难：
- 用户报告"捕捉失败"，但无法快速定位是哪个服务的哪一步出错
- 微服务调用链涉及 3-5 个服务，日志散落各处，需要手动关联 trace-id
- 性能瓶颈分析缺乏端到端的请求耗时分解

OpenTelemetry 是云原生可观测性的标准，集成后可实现：
- **自动链路追踪**：每个请求自动生成 trace，跨服务传递
- **耗时分析**：精确到每个服务、每个数据库查询的耗时
- **错误定位**：一键查看完整调用链和失败节点
- **性能优化**：识别慢服务和慢查询

## 技术方案

### 1. OpenTelemetry SDK 集成

```javascript
// backend/shared/tracing.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');

let sdk = null;

async function initTracing(serviceName, serviceVersion = '1.0.0') {
  if (sdk) return sdk;
  
  const traceExporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://tempo:4317',
  });
  
  const metricExporter = new OTLPMetricExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://tempo:4317',
  });
  
  sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
      [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development',
    }),
    traceExporter,
    metricExporter,
    spanProcessors: [
      new BatchSpanProcessor(traceExporter, {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
      }),
    ],
  });
  
  await sdk.start();
  console.log(`[Tracing] OpenTelemetry initialized for ${serviceName}`);
  return sdk;
}

// 自动关闭
process.on('SIGTERM', async () => {
  if (sdk) {
    await sdk.shutdown();
    console.log('[Tracing] OpenTelemetry SDK shutdown complete');
  }
});

module.exports = { initTracing };
```

### 2. Express 中间件自动追踪

```javascript
// backend/shared/tracingMiddleware.js
const { trace, context, propagation } = require('@opentelemetry/api');
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions');

const tracer = trace.getTracer('mineGo-http', '1.0.0');

function tracingMiddleware(serviceName) {
  return async (req, res, next) => {
    // 从请求头提取 trace context（跨服务传递）
    const ctx = propagation.extract(context.active(), req.headers);
    
    // 创建 span
    const spanName = `${req.method} ${req.route?.path || req.path}`;
    const span = tracer.startSpan(spanName, {
      kind: trace.SpanKind.SERVER,
      attributes: {
        [SemanticAttributes.HTTP_METHOD]: req.method,
        [SemanticAttributes.HTTP_URL]: req.originalUrl,
        [SemanticAttributes.HTTP_ROUTE]: req.route?.path,
        [SemanticAttributes.HTTP_TARGET]: req.path,
        'http.request.headers': JSON.stringify(req.headers),
        'user.id': req.user?.id,
        'service.name': serviceName,
      },
    }, ctx);
    
    // 设置 trace context 到 request
    req.span = span;
    req.traceId = span.spanContext().traceId;
    
    // 设置响应头（便于前端调试）
    res.setHeader('X-Trace-Id', span.spanContext().traceId);
    
    // 响应结束时结束 span
    res.on('finish', () => {
      span.setAttributes({
        [SemanticAttributes.HTTP_STATUS_CODE]: res.statusCode,
        'http.response.size': res.get('content-length') || 0,
      });
      
      if (res.statusCode >= 400) {
        span.setStatus({ code: trace.SpanStatusCode.ERROR });
      }
      
      span.end();
    });
    
    // 在 trace context 中执行后续中间件
    await context.with(trace.setSpan(context.active(), span), next);
  };
}

// 数据库查询追踪
function traceDbQuery(operation, table, queryFn) {
  const span = tracer.startSpan(`db.${operation}`, {
    kind: trace.SpanKind.CLIENT,
    attributes: {
      [SemanticAttributes.DB_SYSTEM]: 'postgresql',
      [SemanticAttributes.DB_OPERATION]: operation,
      [SemanticAttributes.DB_SQL_TABLE]: table,
    },
  });
  
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await queryFn();
      span.setAttributes({
        'db.rows_affected': result.rowCount || result.length || 0,
      });
      span.setStatus({ code: trace.SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: trace.SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

// HTTP 客户端追踪（服务间调用）
async function tracedFetch(url, options = {}) {
  const span = tracer.startSpan(`http ${options.method || 'GET'} ${url}`, {
    kind: trace.SpanKind.CLIENT,
    attributes: {
      [SemanticAttributes.HTTP_URL]: url,
      [SemanticAttributes.HTTP_METHOD]: options.method || 'GET',
    },
  });
  
  // 注入 trace context 到请求头
  const headers = { ...options.headers };
  propagation.inject(context.active(), headers);
  
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const response = await fetch(url, { ...options, headers });
      span.setAttributes({
        [SemanticAttributes.HTTP_STATUS_CODE]: response.status,
      });
      span.setStatus({ 
        code: response.status < 400 ? trace.SpanStatusCode.OK : trace.SpanStatusCode.ERROR 
      });
      return response;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: trace.SpanStatusCode.ERROR, message: error.message });
      throw error;
    } finally {
      span.end();
    }
  });
}

module.exports = { tracingMiddleware, traceDbQuery, tracedFetch };
```

### 3. Jaeger/Grafana Tempo 部署配置

```yaml
# infrastructure/k8s/monitoring/tempo.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tempo
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tempo
  template:
    metadata:
      labels:
        app: tempo
    spec:
      containers:
      - name: tempo
        image: grafana/tempo:latest
        args:
          - "-config.file=/etc/tempo.yaml"
        ports:
          - containerPort: 4317  # OTLP gRPC
          - containerPort: 3200  # Tempo HTTP
        volumeMounts:
          - name: tempo-config
            mountPath: /etc/tempo.yaml
            subPath: tempo.yaml
          - name: tempo-data
            mountPath: /tmp/tempo
      volumes:
        - name: tempo-config
          configMap:
            name: tempo-config
        - name: tempo-data
          emptyDir: {}

---
apiVersion: v1
kind: ConfigMap
metadata:
  name: tempo-config
  namespace: monitoring
data:
  tempo.yaml: |
    server:
      http_listen_port: 3200
    
    distributor:
      receivers:
        otlp:
          protocols:
            grpc:
              endpoint: 0.0.0.0:4317
    
    ingester:
      trace_idle_period: 10s
      max_block_bytes: 1000000
      max_block_duration: 5m
    
    storage:
      trace:
        backend: local
        local:
          path: /tmp/tempo/blocks
    
    compactor:
      compaction:
        block_retention: 48h  # 保留 48 小时
```

### 4. Grafana 数据源配置

```yaml
# infrastructure/k8s/monitoring/grafana-datasources.yaml
apiVersion: 1
datasources:
  - name: Tempo
    type: tempo
    access: proxy
    url: http://tempo:3200
    isDefault: false
    jsonData:
      httpMethod: GET
      tracesToLogs:
        datasourceUid: 'loki'
        mappedTags:
          - key: 'service.name'
            value: 'service'
        mapTagNamesEnabled: true
        spanStartTimeShift: '-1h'
        spanEndTimeShift: '1h'
        filterByTraceID: true
        filterBySpanID: true
```

### 5. 服务初始化集成

```javascript
// backend/services/pokemon-service/src/index.js
const { initTracing } = require('../../../shared/tracing');
const { tracingMiddleware } = require('../../../shared/tracingMiddleware');

// 在服务启动时初始化 tracing（必须在其他模块之前）
await initTracing('pokemon-service', process.env.npm_package_version);

// Express app 中间件
app.use(tracingMiddleware('pokemon-service'));
```

### 6. 追踪查询 API

```javascript
// backend/gateway/src/routes/tracing.js
const express = require('express');
const router = express.Router();

// 查询 trace 详情
router.get('/traces/:traceId', async (req, res) => {
  const { traceId } = req.params;
  
  // 通过 Tempo API 查询
  const response = await fetch(`http://tempo:3200/api/traces/${traceId}`);
  
  if (!response.ok) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  
  const trace = await response.json();
  res.json(trace);
});

// 搜索 traces
router.get('/traces', async (req, res) => {
  const { service, operation, start, end, limit = 20 } = req.query;
  
  // 构建搜索查询
  const searchParams = new URLSearchParams({
    service,
    operation,
    start,
    end,
    limit,
  });
  
  const response = await fetch(`http://tempo:3200/api/search?${searchParams}`);
  const results = await response.json();
  
  res.json(results);
});

// 服务依赖图
router.get('/dependencies', async (req, res) => {
  // 从 Jaeger 或 Tempo 获取服务依赖关系
  const response = await fetch('http://tempo:3200/api/dependencies');
  const deps = await response.json();
  res.json(deps);
});

module.exports = router;
```

### 7. 关键路径追踪配置

```javascript
// backend/shared/criticalPathTracing.js
const { trace } = require('@opentelemetry/api');

const tracer = trace.getTracer('mineGo-critical-paths', '1.0.0');

// 定义关键路径
const CRITICAL_PATHS = {
  CATCH_POKEMON: {
    name: 'catch_pokemon_flow',
    steps: ['auth_check', 'location_verify', 'spawn_fetch', 'catch_attempt', 'db_save', 'event_publish'],
  },
  GYM_BATTLE: {
    name: 'gym_battle_flow',
    steps: ['auth_check', 'gym_fetch', 'team_load', 'battle_calc', 'xp_award', 'db_save'],
  },
  PAYMENT: {
    name: 'payment_flow',
    steps: ['auth_check', 'order_validate', 'payment_gateway', 'inventory_update', 'receipt_save'],
  },
};

function startCriticalPath(pathName, context = {}) {
  const path = CRITICAL_PATHS[pathName];
  if (!path) {
    console.warn(`Unknown critical path: ${pathName}`);
    return null;
  }
  
  const span = tracer.startSpan(path.name, {
    attributes: {
      'critical_path.name': pathName,
      'critical_path.steps': path.steps.join(','),
      ...context,
    },
  });
  
  return {
    span,
    currentStep: 0,
    steps: path.steps,
    
    nextStep(stepName, attributes = {}) {
      if (this.steps[this.currentStep] !== stepName) {
        this.span.addEvent('step_mismatch', {
          expected: this.steps[this.currentStep],
          actual: stepName,
        });
      }
      
      this.span.addEvent(`step:${stepName}`, {
        'step.index': this.currentStep,
        'step.name': stepName,
        ...attributes,
      });
      
      this.currentStep++;
    },
    
    end(success = true) {
      this.span.setStatus({ 
        code: success ? trace.SpanStatusCode.OK : trace.SpanStatusCode.ERROR 
      });
      this.span.end();
    },
  };
}

module.exports = { startCriticalPath, CRITICAL_PATHS };
```

## 验收标准

- [ ] `node --check backend/shared/tracing.js` 通过
- [ ] `node --check backend/shared/tracingMiddleware.js` 通过
- [ ] `node --check backend/shared/criticalPathTracing.js` 通过
- [ ] `node --check backend/gateway/src/routes/tracing.js` 通过
- [ ] `curl -sf http://localhost:3001/api/traces/test-trace-id` 返回 404 或有效 JSON
- [ ] Tempo 部署在 monitoring namespace 并运行正常
- [ ] Grafana 数据源配置包含 Tempo
- [ ] 所有微服务启动时初始化 OpenTelemetry SDK
- [ ] 请求响应头包含 X-Trace-Id
- [ ] 跨服务调用自动传递 trace context

## 影响范围

- **新增文件**:
  - `backend/shared/tracing.js` - OpenTelemetry SDK 初始化
  - `backend/shared/tracingMiddleware.js` - Express 中间件
  - `backend/shared/criticalPathTracing.js` - 关键路径追踪
  - `backend/gateway/src/routes/tracing.js` - 追踪查询 API
  - `infrastructure/k8s/monitoring/tempo.yaml` - Tempo 部署
  - `infrastructure/k8s/monitoring/grafana-datasources.yaml` - 数据源配置
  - `backend/tests/unit/tracing.test.js` - 单元测试

- **修改文件**:
  - 所有微服务的 `index.js`（添加 tracing 初始化）
  - 所有微服务的路由文件（添加 tracingMiddleware）

## 参考

- [OpenTelemetry JavaScript SDK](https://opentelemetry.io/docs/instrumentation/js/)
- [Grafana Tempo 文档](https://grafana.com/docs/tempo/latest/)
- [Jaeger Tracing](https://www.jaegertracing.io/)
- REQ-00002: 结构化日志与 Prometheus 指标集成
- REQ-00130: 实时业务事件流监控与分析系统