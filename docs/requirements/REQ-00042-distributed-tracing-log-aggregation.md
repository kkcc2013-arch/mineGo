# REQ-00042：分布式追踪与日志聚合平台集成

- **编号**：REQ-00042
- **类别**：可观测性/监控
- **优先级**：P0
- **状态**：new
- **涉及服务/模块**：gateway, user-service, catch-service, pokemon-service, gym-service, shared/tracing, shared/logger
- **创建时间**：2026-07-16 12:00
- **依赖需求**：REQ-00040 (Redis缓存层)

## 1. 背景与问题

当前项目有基础的 metrics.js、tracing.js 和 logger.js 模块，但缺乏完整的分布式追踪与日志聚合方案：

1. **日志分散**：各服务日志独立输出到 stdout，缺乏统一收集和查询能力
2. **追踪断链**：跨服务调用缺乏完整的 Trace ID 传递和链路可视化
3. **告警缺失**：异常日志、性能瓶颈无法实时告警，依赖人工巡检
4. **排查困难**：生产环境问题定位需要逐个服务查看日志，效率低下

当前 `shared/tracing.js` 只有基础的 OpenTelemetry SDK 初始化代码，未集成导出到后端（如 Jaeger/Tempo），`shared/logger.js` 只输出到控制台。

## 2. 目标

构建完整的分布式可观测性体系，实现：
- 所有服务日志统一聚合到中心化存储（Loki）
- 全链路追踪可视化（Jaeger/Tempo + Grafana）
- 基于日志和追踪的实时告警（AlertManager）
- 平均问题定位时间从 30 分钟降低到 5 分钟以内

## 3. 范围

**包含**：
- OpenTelemetry SDK 完整集成（Trace + Metrics + Logs）
- 日志输出适配器（输出 JSON 结构化日志，包含 trace_id）
- Jaeger/Tempo 后端部署配置
- Loki 日志聚合部署配置
- Grafana Dashboard 模板（服务拓扑、错误率、延迟分布）
- AlertManager 规则（错误率突增、P99 延迟超阈值）

**不包含**：
- 自定义业务指标 Dashboard（后续需求）
- APM 付费方案（如 Datadog、New Relic）
- 日志脱敏与合规（REQ-00016 已覆盖）

## 4. 详细需求

### 4.1 日志改造

**文件**：`backend/shared/logger.js`

```javascript
// 扩展 logger.js，支持结构化日志和 trace 关联
const { trace, context } = require('@opentelemetry/api');

function createLogger(serviceName) {
  return {
    info(message, meta = {}) {
      const span = trace.getSpan(context.active());
      const traceId = span?.spanContext()?.traceId;
      console.log(JSON.stringify({
        level: 'info',
        service: serviceName,
        message,
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        ...meta
      }));
    },
    error(message, error, meta = {}) {
      const span = trace.getSpan(context.active());
      const traceId = span?.spanContext()?.traceId;
      console.error(JSON.stringify({
        level: 'error',
        service: serviceName,
        message,
        error: { message: error.message, stack: error.stack },
        trace_id: traceId,
        timestamp: new Date().toISOString(),
        ...meta
      }));
    }
  };
}
```

**要求**：
- 所有服务统一使用 `createLogger(serviceName)` 创建 logger
- 日志格式为 JSON Lines，包含 `trace_id`、`service`、`level`、`timestamp`
- 错误日志包含完整堆栈信息

### 4.2 OpenTelemetry 完整集成

**文件**：`backend/shared/tracing.js`（重构）

```javascript
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

function initTelemetry(serviceName) {
  const sdk = new NodeSDK({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    }),
    traceExporter: new JaegerExporter({
      endpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger:14268/api/traces',
    }),
    instrumentations: [
      // 自动埋点：HTTP、Express、PostgreSQL、Redis、Kafka
      require('@opentelemetry/instrumentation-http'),
      require('@opentelemetry/instrumentation-express'),
      require('@opentelemetry/instrumentation-pg'),
      require('@opentelemetry/instrumentation-redis-4'),
      require('@opentelemetry/instrumentation-kafkajs'),
    ],
  });
  
  sdk.start();
  return sdk;
}
```

**要求**：
- 支持 HTTP、Express、PostgreSQL、Redis、Kafka 自动埋点
- Trace 采样率可配置（开发环境 100%，生产环境 10%）
- 使用 Jaeger 作为 Trace 后端，支持 OTLP 协议

### 4.3 Kubernetes 部署配置

**文件**：`infrastructure/k8s/monitoring/`

新增以下资源：
- `jaeger-deployment.yaml`：Jaeger All-in-One 部署
- `loki-deployment.yaml`：Loki 日志聚合
- `promtail-daemonset.yaml`：日志采集代理
- `grafana-deployment.yaml`：可视化 Dashboard
- `alertmanager-config.yaml`：告警规则

**环境变量**：
- 所有服务新增 `JAEGER_ENDPOINT` 环境变量
- 所有服务日志输出到 stdout（Promtail 自动采集）

### 4.4 Grafana Dashboard 模板

**文件**：`infrastructure/dashboards/`

创建 3 个 Dashboard JSON：
- `service-topology.json`：服务调用拓扑图（基于 Trace 数据）
- `error-rate.json`：各服务错误率时序图（基于日志 level=error）
- `latency-p99.json`：P99 延迟分布热力图

### 4.5 AlertManager 规则

**文件**：`infrastructure/alertmanager/rules.yml`

```yaml
groups:
  - name: service-errors
    rules:
      - alert: HighErrorRate
        expr: rate({level="error"}[5m]) > 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "服务 {{ $labels.service }} 错误率过高"
          
      - alert: HighLatencyP99
        expr: histogram_quantile(0.99, rate(http_server_duration_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.service }} P99 延迟超过 2 秒"
```

## 5. 验收标准

- [ ] 所有微服务日志输出为 JSON 格式，包含 `trace_id` 字段
- [ ] Jaeger UI 能查看完整的跨服务调用链路（如 catch → user → pokemon）
- [ ] Grafana 能查询 Loki 中的日志，并按 `trace_id` 筛选
- [ ] 服务拓扑图能正确显示 9 个微服务之间的调用关系
- [ ] 错误率超过阈值时，AlertManager 触发告警（模拟测试）
- [ ] 本地开发环境一键启动监控栈（docker-compose up monitoring）

## 6. 工作量估算

**L (Large)**

- 理由：涉及 9 个服务的 logger 改造、OpenTelemetry SDK 集成、K8s 监控栈部署、Dashboard 配置、告警规则编写。预计 5-7 个工作日。

## 7. 优先级理由

**P0（最高）**

- 可观测性是生产环境运维的基础，当前缺乏完整的追踪和日志聚合能力，严重影响问题排查效率
- 在高并发场景下（如道馆战斗、精灵刷新），没有完整的调用链追踪，性能瓶颈无法定位
- 异常告警缺失会导致生产事故延迟发现，影响用户体验和留存率
- 属于"基础设施完备"的核心需求，必须优先实现

---

## 8. 技术依赖

- **OpenTelemetry SDK**：`@opentelemetry/sdk-node`, `@opentelemetry/exporter-jaeger`
- **自动埋点**：`@opentelemetry/instrumentation-http`, `@opentelemetry/instrumentation-express`, `@opentelemetry/instrumentation-pg`, `@opentelemetry/instrumentation-redis-4`
- **监控栈**：Jaeger 1.41+, Loki 2.9+, Grafana 10.2+, AlertManager 0.26+
- **日志采集**：Promtail 2.9+

## 9. 后续需求

- REQ-00043：自定义业务指标 Dashboard（DAU、留存率、付费转化）
- REQ-00044：日志脱敏与敏感数据过滤（GDPR 合规）
- REQ-00045：追踪数据采样策略动态调整