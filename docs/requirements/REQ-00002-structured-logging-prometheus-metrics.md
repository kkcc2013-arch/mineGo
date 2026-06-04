# REQ-00002：结构化日志与 Prometheus 指标集成

- **编号**：REQ-00002
- **类别**：可观测性/监控
- **优先级**：P0
- **状态**：done
- **涉及服务/模块**：gateway、所有微服务、shared/logger.js、shared/metrics.js
- **创建时间**：2026-06-04 16:00
- **依赖需求**：无

## 1. 背景与问题

当前项目日志使用简单的 `console.log` 输出，缺少结构化格式，难以在生产环境中进行日志聚合、搜索和分析。代码分析：

```javascript
// 当前日志方式（各服务中）
console.log('[GW] %s %s %dms %d', req.method, req.path, dur, _res.statusCode);
console.error('[Raid WS] Message error', e);
```

**问题**：
1. 日志格式不统一，缺少时间戳、服务名、请求ID等关键信息
2. 无法与 ELK/Loki 等日志系统集成
3. 缺少 Prometheus 指标暴露端点（/metrics）
4. 无法监控 QPS、延迟分布、错误率等关键指标
5. 缺少分布式追踪能力，难以排查跨服务问题

## 2. 目标

1. 实现结构化 JSON 日志，包含时间戳、服务名、请求ID、级别、上下文
2. 集成 Prometheus 指标：QPS、延迟直方图、错误率、活跃连接数
3. 所有服务暴露 /metrics 端点供 Prometheus 抓取
4. 支持日志级别动态调整
5. 为后续 Jaeger 分布式追踪奠定基础

## 3. 范围

- **包含**：
  - 创建 shared/logger.js 结构化日志模块
  - 创建 shared/metrics.js Prometheus 指标模块
  - 所有服务集成日志和指标
  - Gateway 添加请求追踪中间件
  - 添加 /metrics 端点
  
- **不包含**：
  - ELK/Loki 部署配置
  - Prometheus Server 部署
  - Jaeger 分布式追踪完整实现（另立需求）
  - Grafana Dashboard 配置

## 4. 详细需求

### 4.1 结构化日志格式

```javascript
// shared/logger.js
const pino = require('pino');

module.exports = (serviceName) => pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// 输出示例
{
  "level": "info",
  "time": "2026-06-04T16:00:00.000Z",
  "service": "catch-service",
  "msg": "Catch attempt",
  "reqId": "gw-1234567890-abc123",
  "userId": "user-uuid",
  "wildId": "wild-uuid",
  "ballType": "GREAT_BALL",
  "catchRate": 0.35
}
```

### 4.2 Prometheus 指标定义

```javascript
// shared/metrics.js
const promClient = require('prom-client');

// 默认指标（CPU、内存、事件循环延迟）
promClient.collectDefaultMetrics();

// 自定义指标
module.exports = {
  httpRequestsTotal: new promClient.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['service', 'method', 'path', 'status'],
  }),
  
  httpRequestDuration: new promClient.Histogram({
    name: 'http_request_duration_ms',
    help: 'HTTP request duration in ms',
    labelNames: ['service', 'method', 'path'],
    buckets: [10, 25, 50, 100, 250, 500, 1000, 2500],
  }),
  
  dbQueryDuration: new promClient.Histogram({
    name: 'db_query_duration_ms',
    help: 'Database query duration in ms',
    labelNames: ['service', 'query'],
    buckets: [5, 10, 25, 50, 100, 250],
  }),
  
  activeWebsocketConnections: new promClient.Gauge({
    name: 'websocket_active_connections',
    help: 'Active WebSocket connections',
    labelNames: ['service', 'room'],
  }),
  
  cacheHitRate: new promClient.Counter({
    name: 'cache_hits_total',
    help: 'Cache hit/miss count',
    labelNames: ['service', 'cache', 'result'], // result: hit|miss
  }),
};
```

### 4.3 服务集成示例

```javascript
// 在每个服务中
const logger = require('../../../shared/logger')('catch-service');
const metrics = require('../../../shared/metrics');

// 请求中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.httpRequestsTotal.inc({
      service: 'catch-service',
      method: req.method,
      path: req.path,
      status: res.statusCode,
    });
    metrics.httpRequestDuration.observe({
      service: 'catch-service',
      method: req.method,
      path: req.path,
    }, duration);
  });
  next();
});

// /metrics 端点
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.send(await promClient.register.metrics());
});
```

### 4.4 Gateway 请求追踪

```javascript
// Gateway 添加请求ID和追踪头
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] || uuidv4();
  const spanId = uuidv4();
  req.headers['x-trace-id'] = traceId;
  req.headers['x-span-id'] = spanId;
  res.setHeader('X-Trace-Id', traceId);
  next();
});
```

## 5. 验收标准（可测试）

- [ ] 所有服务使用结构化 JSON 日志（非 console.log）
- [ ] 日志包含时间戳、服务名、级别、请求ID
- [ ] 所有服务暴露 /metrics 端点，返回 Prometheus 格式指标
- [ ] 指标包含 http_requests_total、http_request_duration_ms
- [ ] 指标包含 db_query_duration_ms（数据库查询延迟）
- [ ] Gateway 为每个请求生成唯一 Trace ID
- [ ] 日志级别可通过环境变量 LOG_LEVEL 调整
- [ ] 添加单元测试验证日志格式和指标记录

## 6. 工作量估算

**L（大型）**

理由：
- 需要创建 2 个共享模块（logger.js、metrics.js）
- 需要修改 9 个微服务 + Gateway
- 需要替换所有 console.log 调用
- 需要添加请求追踪中间件
- 测试覆盖所有服务

## 7. 优先级理由

**P0（最高优先级）**

理由：
1. 可观测性是生产环境运行的必备条件
2. 没有指标无法发现性能问题和异常
3. 没有结构化日志无法排查线上问题
4. 是后续告警、SLO、分布式追踪的基础
5. 当前成熟度评分仅 4/10，严重影响项目可用性
