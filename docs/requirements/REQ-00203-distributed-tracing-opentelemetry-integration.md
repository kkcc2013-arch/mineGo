# REQ-00203：分布式追踪与 OpenTelemetry 集成系统

- **编号**：REQ-00203
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/tracing、infrastructure/k8s/monitoring
- **创建时间**：2026-06-14 17:00
- **依赖需求**：REQ-00002、REQ-00005

## 1. 背景与问题

当前 mineGo 项目已实现 Prometheus 指标监控和结构化日志系统（REQ-00002、REQ-00005），但缺乏端到端的分布式追踪能力：

### 现状痛点

1. **请求链路不可见**：用户发起的捕捉请求经过 gateway → location-service → catch-service → pokemon-service，无法追踪完整路径
2. **性能瓶颈定位困难**：当 P99 延迟飙升时，无法快速定位是哪个服务、哪个操作导致
3. **跨服务错误传播难追踪**：错误在服务间传播时，缺乏关联 ID，排查需要手动 grep 日志
4. **无 Trace ID 串联**：日志中缺少 trace_id，无法将同一请求的所有日志聚合

### 业务影响

- 故障排查平均耗时 30+ 分钟
- 性能优化缺乏数据支撑
- 用户投诉无法快速定位根因

## 2. 目标

1. **全链路追踪**：为每个请求生成 Trace ID，自动传播到所有下游服务
2. **性能可视化**：在 Grafana 中展示服务调用拓扑和延迟分布
3. **错误关联**：Trace ID 自动注入日志，实现日志与追踪关联
4. **标准兼容**：采用 OpenTelemetry 标准，支持 Jaeger/Tempo 后端

## 3. 范围

### 包含

- OpenTelemetry SDK 集成（Node.js）
- 自动埋点中间件（Express、Axios、Redis、PostgreSQL）
- Trace ID 注入日志系统
- Jaeger 部署配置（K8s）
- Grafana 追踪数据源配置
- 关键业务链路标注（捕捉、战斗、支付）

### 不包含

- 前端追踪（后续需求）
- 自定义采样策略优化（后续迭代）
- 追踪数据长期存储策略

## 4. 详细需求

### 4.1 OpenTelemetry SDK 封装

```javascript
// backend/shared/tracing/index.js
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

function initTracing(serviceName, config = {}) {
  const provider = new NodeTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.npm_package_version,
    }),
  });
  
  const jaegerExporter = new JaegerExporter({
    endpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger:14268/api/traces',
  });
  
  provider.addSpanProcessor(new BatchSpanProcessor(jaegerExporter));
  provider.register();
  
  return provider;
}
```

### 4.2 Express 自动埋点中间件

```javascript
// backend/shared/tracing/expressMiddleware.js
const { trace, context } = require('@opentelemetry/api');

function tracingMiddleware(serviceName) {
  const tracer = trace.getTracer(serviceName);
  
  return (req, res, next) => {
    const span = tracer.startSpan(`${req.method} ${req.route?.path || req.path}`, {
      attributes: {
        'http.method': req.method,
        'http.url': req.originalUrl,
        'http.route': req.route?.path,
        'user.id': req.user?.id,
      },
    });
    
    // 将 trace_id 注入请求对象
    req.traceId = span.spanContext().traceId;
    req.span = span;
    
    // 注入响应头
    res.setHeader('X-Trace-Id', req.traceId);
    
    res.on('finish', () => {
      span.setAttributes({
        'http.status_code': res.statusCode,
      });
      span.setStatus({ code: res.statusCode < 400 ? 0 : 2 });
      span.end();
    });
    
    next();
  };
}
```

### 4.3 日志 Trace ID 注入

```javascript
// backend/shared/logger.js 增强
const { trace, context } = require('@opentelemetry/api');

function injectTraceInfo(logData) {
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) {
    const ctx = activeSpan.spanContext();
    return {
      ...logData,
      trace_id: ctx.traceId,
      span_id: ctx.spanId,
    };
  }
  return logData;
}
```

### 4.4 关键业务链路标注

| 链路 | Span 名称 | 关键属性 |
|------|-----------|----------|
| 精灵捕捉 | `pokemon.catch` | pokemon_id, ball_type, capture_rate, location |
| 道馆战斗 | `gym.battle` | gym_id, attacker_id, defender_id, result |
| 支付流程 | `payment.process` | order_id, amount, currency, provider |
| 精灵交易 | `pokemon.trade` | trade_id, from_user, to_user, pokemon_ids |

### 4.5 K8s 部署配置

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
    spec:
      containers:
      - name: jaeger
        image: jaegertracing/all-in-one:1.52
        ports:
        - containerPort: 16686  # UI
        - containerPort: 14268  # Collector
        env:
        - name: COLLECTOR_OTLP_ENABLED
          value: "true"
```

### 4.6 环境变量配置

```bash
# .env.example 新增
JAEGER_ENDPOINT=http://jaeger:14268/api/traces
TRACE_SAMPLING_RATE=1.0  # 生产环境建议 0.1
ENABLE_TRACING=true
```

## 5. 验收标准（可测试）

- [ ] 所有 HTTP 请求自动生成 Trace ID 并在响应头返回
- [ ] 日志中包含 trace_id 字段，可通过 Trace ID 搜索相关日志
- [ ] 精灵捕捉流程可在 Jaeger 中查看完整链路（gateway → location → catch → pokemon）
- [ ] Grafana 可查询并展示追踪数据
- [ ] 单元测试覆盖埋点中间件
- [ ] 文档包含追踪使用指南和常见场景示例

## 6. 工作量估算

**L**（Large）

- 理由：需要集成 OpenTelemetry SDK 到 9 个微服务，配置 Jaeger 部署，实现自动埋点和手动标注，工作量较大

## 7. 优先级理由

1. **故障排查效率**：分布式追踪可将故障定位时间从 30+ 分钟降低到 5 分钟内
2. **可观测性闭环**：与已有 Prometheus 指标、结构化日志形成完整可观测性体系
3. **生产必备**：分布式追踪是生产环境微服务的必备能力
4. **依赖成熟**：OpenTelemetry 是行业标准，Jaeger 部署简单，风险可控
