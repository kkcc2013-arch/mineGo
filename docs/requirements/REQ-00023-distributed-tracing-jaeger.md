# REQ-00023：分布式链路追踪与 Jaeger 集成

- **编号**：REQ-00023
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring
- **创建时间**：2026-06-05 15:00
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标集成）

## 1. 背景与问题

当前 mineGo 项目已实现结构化日志和 Prometheus 指标监控，但缺少分布式链路追踪能力：

**问题现状**：
1. **跨服务调用难以追踪**：用户请求从 Gateway 路由到多个微服务，当出现性能问题时，无法快速定位哪个服务是瓶颈
2. **错误根因分析困难**：当捕获失败或支付异常时，虽然有 traceId，但无法看到完整的调用链路和耗时分布
3. **缺少可视化分析**：无法直观看到服务依赖关系、调用拓扑和性能热点
4. **缺少上下文传递**：当前 traceId 仅在响应中返回，未在服务间传递，无法形成完整追踪链

**代码证据**：
- `backend/shared/response.js` 中有 `traceId` 字段，但仅用于响应
- `backend/shared/logger.js` 中从请求头提取 `x-trace-id`，但未在服务调用时传递
- Gateway 到各微服务的请求未携带追踪上下文
- 缺少 OpenTelemetry、Jaeger 或 Zipkin 集成

**影响**：
- 生产环境故障排查时间延长 3-5 倍
- 性能瓶颈定位依赖日志人工分析，效率低
- 无法实现 SLA 监控（如 P95 延迟分布到各服务）

## 2. 目标

建立完整的分布式链路追踪体系，实现：

1. **端到端追踪**：从用户请求到 Gateway，再到各微服务的完整调用链
2. **性能分析**：精确识别各服务的耗时占比，快速定位性能瓶颈
3. **错误追踪**：自动关联错误日志与调用链，快速定位根因
4. **可视化拓扑**：通过 Jaeger UI 查看服务依赖关系和调用频率
5. **SLA 监控**：基于追踪数据实现各服务的延迟百分位监控

## 3. 范围

**包含**：
- OpenTelemetry SDK 集成到所有微服务
- Jaeger 部署到 K8s 集群（All-in-One 模式）
- Gateway 自动创建 root span，服务间自动传递追踪上下文
- 日志与追踪关联（traceId 自动注入日志）
- Prometheus 从 Jaeger 导出追踪指标
- Grafana 链路追踪仪表板

**不包含**：
- 前端浏览器追踪（后续需求）
- 追踪数据持久化到 Elasticsearch/Cassandra（先用内存存储）
- 追踪采样策略优化（初期全量采集，后续按流量调整）

## 4. 详细需求

### 4.1 OpenTelemetry SDK 集成

创建 `backend/shared/tracing.js` 模块：

```javascript
// 初始化 OpenTelemetry
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

function initTracing(serviceName) {
  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
  });

  const jaegerExporter = new JaegerExporter({
    endpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger-collector:14268/api/traces',
  });

  provider.addSpanProcessor(new BatchSpanProcessor(jaegerExporter));
  provider.register();

  return provider;
}
```

### 4.2 Express 中间件集成

创建 `backend/shared/tracingMiddleware.js`：

```javascript
// 自动为每个请求创建 span
const { context, trace } = require('@opentelemetry/api');

function tracingMiddleware(serviceName) {
  return (req, res, next) => {
    const tracer = trace.getTracer(serviceName);
    const spanName = `${req.method} ${req.route?.path || req.path}`;
    
    const span = tracer.startSpan(spanName, {
      attributes: {
        'http.method': req.method,
        'http.url': req.originalUrl,
        'http.target': req.path,
        'http.host': req.get('host'),
        'http.scheme': req.protocol,
        'http.user_agent': req.get('user-agent'),
      },
    });

    // 从上游提取追踪上下文
    const traceParent = req.get('traceparent');
    if (traceParent) {
      // W3C Trace Context 格式解析
      span.setAttribute('traceparent', traceParent);
    }

    context.with(trace.setSpan(context.active(), span), () => {
      res.on('finish', () => {
        span.setAttributes({
          'http.status_code': res.statusCode,
          'http.response_size': res.get('content-length'),
        });
        
        if (res.statusCode >= 400) {
          span.setStatus({ code: 2, message: `HTTP ${res.statusCode}` });
        }
        
        span.end();
      });

      next();
    });
  };
}
```

### 4.3 服务间调用传播

在 `backend/gateway/src/index.js` 中，代理请求时传递追踪上下文：

```javascript
const { context, trace, propagation } = require('@opentelemetry/api');

// 在代理中间件中
app.use('/api', async (req, res) => {
  const span = trace.getSpan(context.active());
  
  // 注入追踪上下文到请求头
  const headers = { ...req.headers };
  propagation.inject(context.active(), headers);
  
  // 转发请求到下游服务
  const response = await axios({
    method: req.method,
    url: `http://${targetService}${req.path}`,
    headers,
    data: req.body,
  });
});
```

### 4.4 数据库追踪

在 `backend/shared/db.js` 中集成 PostgreSQL 追踪：

```javascript
const { trace } = require('@opentelemetry/api');

async function query(sql, params) {
  const span = trace.getSpan(context.active());
  if (span) {
    span.addEvent('db.query', {
      'db.system': 'postgresql',
      'db.statement': sql,
      'db.operation': sql.split(' ')[0].toUpperCase(),
    });
  }
  
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    if (span) {
      span.addEvent('db.result', { 'db.rows_affected': result.rowCount });
    }
    return result;
  } finally {
    if (span) {
      span.addEvent('db.duration', { 'db.duration_ms': Date.now() - start });
    }
  }
}
```

### 4.5 Redis 追踪

在 `backend/shared/redis.js` 中集成 Redis 追踪：

```javascript
const { trace } = require('@opentelemetry/api');

async function geoadd(key, longitude, latitude, member) {
  const span = trace.getSpan(context.active());
  if (span) {
    span.addEvent('redis.command', {
      'db.system': 'redis',
      'db.operation': 'GEOADD',
      'db.key': key,
    });
  }
  
  return await redis.geoadd(key, longitude, latitude, member);
}
```

### 4.6 Kafka 追踪

在事件发布和消费时传递追踪上下文：

```javascript
const { trace, propagation } = require('@opentelemetry/api');

// 发布事件时注入追踪上下文
function publishEvent(topic, event) {
  const span = trace.getSpan(context.active());
  const headers = {};
  
  if (span) {
    propagation.inject(context.active(), headers);
    span.addEvent('kafka.produce', { 'messaging.destination': topic });
  }
  
  producer.send({
    topic,
    messages: [{ value: JSON.stringify(event), headers }],
  });
}

// 消费事件时提取追踪上下文
async function consumeEvent(message) {
  const headers = message.headers || {};
  const parentContext = propagation.extract(context.active(), headers);
  
  const tracer = trace.getTracer('mineGo');
  const span = tracer.startSpan('kafka.consume', {
    attributes: {
      'messaging.system': 'kafka',
      'messaging.destination': message.topic,
    },
  }, parentContext);
  
  // 处理消息...
  span.end();
}
```

### 4.7 Jaeger K8s 部署

创建 `infrastructure/k8s/monitoring/jaeger.yaml`：

```yaml
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
        - containerPort: 16686  # UI
          name: ui
        - containerPort: 14268  # HTTP collector
          name: collector
        - containerPort: 6831   # UDP agent
          name: agent
        env:
        - name: COLLECTOR_ZIPKIN_HOST_PORT
          value: ":9411"
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
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
  - name: collector
    port: 14268
    targetPort: 14268
  - name: agent
    port: 6831
    protocol: UDP
    targetPort: 6831
```

### 4.8 环境变量配置

在 `infrastructure/k8s/base/00-namespace-config.yaml` 中添加：

```yaml
data:
  JAEGER_ENDPOINT: "http://jaeger-collector.monitoring.svc.cluster.local:14268/api/traces"
  JAEGER_AGENT_HOST: "jaeger-agent.monitoring.svc.cluster.local"
  JAEGER_AGENT_PORT: "6831"
```

### 4.9 日志关联

在 `backend/shared/logger.js` 中自动注入 traceId：

```javascript
const { context, trace } = require('@opentelemetry/api');

function formatLogMessage(level, message, meta = {}) {
  const span = trace.getSpan(context.active());
  
  const logEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    service: process.env.SERVICE_NAME,
    ...meta,
  };
  
  // 自动注入追踪信息
  if (span) {
    const spanContext = span.spanContext();
    logEntry.traceId = spanContext.traceId;
    logEntry.spanId = spanContext.spanId;
  }
  
  return JSON.stringify(logEntry);
}
```

### 4.10 Grafana 仪表板

创建 `infrastructure/k8s/monitoring/grafana-dashboards/tracing.json`：

- 服务调用拓扑图
- P50/P95/P99 延迟分布（按服务）
- 错误率追踪（按服务和端点）
- 热点请求 Top 10
- 服务依赖关系图

## 5. 验收标准（可测试）

- [ ] **追踪链路完整性**：从 Gateway 到任意微服务的请求，在 Jaeger UI 中能看到完整的 span 链路
- [ ] **性能数据准确**：每个 span 记录的耗时与实际一致（误差 < 5ms）
- [ ] **日志关联**：所有日志自动包含 traceId，可在 Jaeger 中通过 traceId 查到对应日志
- [ ] **服务间传播**：Gateway 调用下游服务时，追踪上下文正确传播（span 的 parent 正确）
- [ ] **数据库追踪**：所有 SQL 查询自动生成子 span，包含 SQL 语句和执行时间
- [ ] **Redis 追踪**：所有 Redis 命令自动生成子 span
- [ ] **Kafka 追踪**：事件发布和消费形成完整追踪链
- [ ] **Jaeger UI 可访问**：通过 Ingress 访问 Jaeger UI，能查看所有服务的追踪数据
- [ ] **错误追踪**：HTTP 4xx/5xx 错误自动标记在 span 上，能在 UI 中筛选错误请求
- [ ] **性能影响**：追踪开销 < 5% CPU 和 < 10ms 延迟增加

## 6. 工作量估算

**L（Large）** - 需要：
- 集成 OpenTelemetry 到 9 个微服务（每个 30 分钟）
- 创建和测试共享追踪模块（2 小时）
- 部署和配置 Jaeger 到 K8s（1 小时）
- 创建 Grafana 仪表板（1 小时）
- 编写单元测试和集成测试（2 小时）
- 文档编写（1 小时）

总计：约 10 小时

## 7. 优先级理由

**P1（高优先级）**：
1. **影响生产故障排查效率**：当前缺乏链路追踪，故障定位时间延长 3-5 倍
2. **可观测性体系关键一环**：已有日志和指标，缺追踪，形成完整可观测性三角
3. **支撑性能优化**：REQ-00001（Redis GEO 缓存）、REQ-00013（事件驱动）等优化的效果需要追踪数据验证
4. **生产就绪必需**：分布式系统的生产环境必备能力
5. **依赖需求已完成**：REQ-00002 已实现日志和指标，追踪是自然延伸

相比 P0（核心功能、安全）略低，但对生产环境同样重要，应为 P1。
