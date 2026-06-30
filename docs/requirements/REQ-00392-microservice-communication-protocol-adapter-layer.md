# REQ-00392：微服务通信协议适配层与多协议统一网关系统

- **编号**：REQ-00392
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/ProtocolAdapter.js、backend/shared/ProtocolRouter.js、backend/shared/adapters/
- **创建时间**：2026-06-30 18:00 UTC
- **依赖需求**：REQ-00300（动态服务注册发现）、REQ-00319（依赖注入容器）

## 1. 背景与问题

mineGo 微服务架构当前主要使用 HTTP/REST 协议进行服务间通信，随着业务发展和技术演进，暴露出以下问题：

### 1.1 协议耦合严重
- 所有服务间调用强制使用 HTTP/REST，无法针对不同场景选择最优协议
- 高频低延迟场景（如实时战斗、位置同步）HTTP 开销过大
- 批量操作和流式数据处理效率低

### 1.2 协议迁移成本高
- 若需引入 gRPC、GraphQL 或 WebSocket，需修改每个微服务的调用代码
- 缺乏协议抽象层，协议变更影响面广
- 新协议集成需要大量重复开发

### 1.3 混合协议场景支持不足
- 部分服务已支持 WebSocket（如 gym-service 实时战斗），但调用方式不统一
- 前端需要针对不同协议使用不同的客户端 SDK
- 协议间无法无缝切换和降级

### 1.4 协议级监控缺失
- 无法统一监控不同协议的性能指标
- 协议级别的错误追踪和告警机制缺失
- 难以评估协议优化效果

## 2. 目标

构建统一的微服务通信协议适配层，实现：

1. **多协议支持**：透明支持 HTTP/REST、gRPC、GraphQL、WebSocket 四种协议
2. **协议智能路由**：根据场景自动选择最优协议（如实时场景用 WebSocket，批量查询用 gRPC）
3. **协议平滑迁移**：通过配置切换协议，无需修改业务代码
4. **协议降级机制**：当主协议故障时自动降级到备用协议
5. **统一监控面板**：协议级别的性能指标、错误率、流量分布监控

**预期收益：**
- 高频调用延迟降低 40%（gRPC 替代 HTTP）
- 批量操作吞吐量提升 3 倍
- 协议迁移成本降低 80%
- 系统可用性提升 5%（协议降级）

## 3. 范围

### 包含
- ProtocolAdapter 抽象接口：统一的服务调用接口
- 多协议适配器实现：HttpAdapter、GrpcAdapter、GraphqlAdapter、WebSocketAdapter
- ProtocolRouter 路由器：根据场景智能选择协议
- 协议配置管理：声明式协议配置，支持热更新
- 协议降级策略：自动降级与手动切换
- 协议级监控指标：延迟、吞吐量、错误率
- 客户端统一 SDK：前端使用统一接口调用后端服务

### 不包含
- 自定义协议实现
- 跨数据中心的长连接管理
- 消息队列协议（Kafka 已有独立实现）

## 4. 详细需求

### 4.1 ProtocolAdapter 抽象接口

```javascript
// backend/shared/ProtocolAdapter.js

/**
 * 协议适配器抽象接口
 */
class ProtocolAdapter {
  constructor(config) {
    this.protocol = config.protocol; // 'http' | 'grpc' | 'graphql' | 'websocket'
    this.config = config;
    this.isConnected = false;
  }

  /**
   * 初始化连接
   */
  async connect() {
    throw new Error('Method not implemented');
  }

  /**
   * 发送请求
   * @param {Object} request - 请求对象
   * @param {string} request.service - 服务名称
   * @param {string} request.method - 方法名称
   * @param {Object} request.data - 请求数据
   * @param {Object} request.options - 协议特定选项
   */
  async send(request) {
    throw new Error('Method not implemented');
  }

  /**
   * 批量发送请求
   */
  async sendBatch(requests) {
    throw new Error('Method not implemented');
  }

  /**
   * 订阅事件流（仅 WebSocket 支持）
   */
  async subscribe(event, handler) {
    throw new Error('Method not implemented');
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    throw new Error('Method not implemented');
  }

  /**
   * 关闭连接
   */
  async disconnect() {
    throw new Error('Method not implemented');
  }
}

module.exports = ProtocolAdapter;
```

### 4.2 HTTP 协议适配器

```javascript
// backend/shared/adapters/HttpAdapter.js

const ProtocolAdapter = require('../ProtocolAdapter');
const axios = require('axios');
const logger = require('../logger');
const metrics = require('../metrics');

class HttpAdapter extends ProtocolAdapter {
  constructor(config) {
    super({ protocol: 'http', ...config });
    this.httpClient = null;
  }

  async connect() {
    this.httpClient = axios.create({
      timeout: this.config.timeout || 10000,
      maxRedirects: 3,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'mineGo-Service/1.0'
      }
    });
    
    this.isConnected = true;
    logger.info('HTTP adapter connected');
  }

  async send(request) {
    const startTime = Date.now();
    const { service, method, data, options = {} } = request;
    
    try {
      const response = await this.httpClient.request({
        method: options.httpMethod || 'POST',
        url: `${options.baseUrl || this.config.baseUrl}/${service}/${method}`,
        data,
        headers: options.headers,
        params: options.query
      });
      
      const duration = Date.now() - startTime;
      metrics.timing('protocol.http.request_duration', duration, {
        service,
        method,
        status: 'success'
      });
      
      return response.data;
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.increment('protocol.http.request_error', 1, {
        service,
        method,
        error: error.code || 'unknown'
      });
      
      logger.error('HTTP request failed', {
        service,
        method,
        error: error.message,
        duration
      });
      
      throw error;
    }
  }

  async sendBatch(requests) {
    // HTTP 批量请求使用 Promise.all
    return Promise.all(requests.map(req => this.send(req)));
  }

  async healthCheck() {
    try {
      const response = await this.httpClient.get('/health');
      return { healthy: response.status === 200 };
    } catch {
      return { healthy: false };
    }
  }

  async disconnect() {
    this.isConnected = false;
    logger.info('HTTP adapter disconnected');
  }
}

module.exports = HttpAdapter;
```

### 4.3 gRPC 协议适配器

```javascript
// backend/shared/adapters/GrpcAdapter.js

const ProtocolAdapter = require('../ProtocolAdapter');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/grpc-js/load');
const logger = require('../logger');
const metrics = require('../metrics');

class GrpcAdapter extends ProtocolAdapter {
  constructor(config) {
    super({ protocol: 'grpc', ...config });
    this.clients = new Map(); // 服务名 -> gRPC 客户端
    this.protoCache = new Map(); // proto 文件缓存
  }

  async connect() {
    // 预加载 proto 文件
    const protoFiles = this.config.protoFiles || [];
    for (const protoPath of protoFiles) {
      await this.loadProto(protoPath);
    }
    
    this.isConnected = true;
    logger.info('gRPC adapter connected');
  }

  async loadProto(protoPath) {
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });
    
    const proto = grpc.loadPackageDefinition(packageDefinition);
    this.protoCache.set(protoPath, proto);
    return proto;
  }

  getClient(service, serviceAddress) {
    if (this.clients.has(service)) {
      return this.clients.get(service);
    }
    
    const proto = this.protoCache.get(`${service}.proto`);
    if (!proto) {
      throw new Error(`Proto file not loaded for service: ${service}`);
    }
    
    const ClientClass = proto[service];
    const client = new ClientClass(
      serviceAddress,
      grpc.credentials.createInsecure()
    );
    
    this.clients.set(service, client);
    return client;
  }

  async send(request) {
    const startTime = Date.now();
    const { service, method, data, options = {} } = request;
    
    try {
      const client = this.getClient(service, options.serviceAddress);
      
      const response = await new Promise((resolve, reject) => {
        client[method](data, (error, response) => {
          if (error) reject(error);
          else resolve(response);
        });
      });
      
      const duration = Date.now() - startTime;
      metrics.timing('protocol.grpc.request_duration', duration, {
        service,
        method,
        status: 'success'
      });
      
      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      metrics.increment('protocol.grpc.request_error', 1, {
        service,
        method,
        error: error.code || 'unknown'
      });
      
      logger.error('gRPC request failed', {
        service,
        method,
        error: error.message,
        duration
      });
      
      throw error;
    }
  }

  async sendBatch(requests) {
    // gRPC 支持流式批量请求
    // 使用 client-side streaming
    return Promise.all(requests.map(req => this.send(req)));
  }

  async healthCheck() {
    // gRPC 健康检查使用标准健康检查协议
    // 参考: https://github.com/grpc/grpc/blob/master/doc/health-checking.md
    const results = [];
    for (const [service, client] of this.clients) {
      try {
        await new Promise((resolve, reject) => {
          client.check({ service }, (err, resp) => {
            if (err) reject(err);
            else resolve(resp);
          });
        });
        results.push({ service, healthy: true });
      } catch {
        results.push({ service, healthy: false });
      }
    }
    return results;
  }

  async disconnect() {
    for (const [service, client] of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.isConnected = false;
    logger.info('gRPC adapter disconnected');
  }
}

module.exports = GrpcAdapter;
```

### 4.4 ProtocolRouter 智能路由器

```javascript
// backend/shared/ProtocolRouter.js

const logger = require('./logger');
const metrics = require('./metrics');

/**
 * 协议路由规则配置
 */
const DEFAULT_ROUTING_RULES = {
  // 服务级别协议配置
  services: {
    'gym-service': {
      default: 'websocket',
      fallback: 'http',
      methods: {
        'battle.sync': 'websocket',
        'battle.action': 'websocket',
        'battle.query': 'http'
      }
    },
    'pokemon-service': {
      default: 'http',
      fallback: 'grpc',
      methods: {
        'pokemon.batchQuery': 'grpc',
        'pokemon.query': 'http'
      }
    }
  },
  
  // 场景级别协议配置
  scenarios: {
    'realtime': {
      protocol: 'websocket',
      services: ['gym-service', 'catch-service']
    },
    'batch': {
      protocol: 'grpc',
      patterns: ['*.batch*', '*.bulk*']
    }
  },
  
  // 协议降级策略
  fallback: {
    enabled: true,
    order: ['grpc', 'http', 'websocket'], // 降级顺序
    conditions: {
      errorRate: 0.05, // 错误率超过 5% 触发降级
      latency: 2000 // 延迟超过 2 秒触发降级
    }
  }
};

class ProtocolRouter {
  constructor(config = {}) {
    this.rules = { ...DEFAULT_ROUTING_RULES, ...config.rules };
    this.adapters = new Map(); // protocol -> adapter
    this.protocolHealth = new Map(); // protocol -> { healthy, latency, errorRate }
    this.stats = new Map(); // protocol -> { requests, errors, totalLatency }
  }

  /**
   * 注册协议适配器
   */
  registerAdapter(protocol, adapter) {
    this.adapters.set(protocol, adapter);
    this.protocolHealth.set(protocol, { healthy: true, latency: 0, errorRate: 0 });
    this.stats.set(protocol, { requests: 0, errors: 0, totalLatency: 0 });
  }

  /**
   * 智能选择协议
   */
  selectProtocol(request) {
    const { service, method, options = {} } = request;
    
    // 1. 显式指定协议
    if (options.protocol) {
      return options.protocol;
    }
    
    // 2. 方法级别协议配置
    const serviceConfig = this.rules.services[service];
    if (serviceConfig && serviceConfig.methods && serviceConfig.methods[method]) {
      const preferred = serviceConfig.methods[method];
      if (this.isProtocolHealthy(preferred)) {
        return preferred;
      }
      // 降级到服务默认协议
      if (serviceConfig.fallback && this.isProtocolHealthy(serviceConfig.fallback)) {
        return serviceConfig.fallback;
      }
    }
    
    // 3. 服务级别默认协议
    if (serviceConfig && serviceConfig.default) {
      const preferred = serviceConfig.default;
      if (this.isProtocolHealthy(preferred)) {
        return preferred;
      }
      if (serviceConfig.fallback && this.isProtocolHealthy(serviceConfig.fallback)) {
        return serviceConfig.fallback;
      }
    }
    
    // 4. 场景匹配
    for (const [scenario, config] of Object.entries(this.rules.scenarios)) {
      if (this.matchScenario(request, scenario, config)) {
        if (this.isProtocolHealthy(config.protocol)) {
          return config.protocol;
        }
      }
    }
    
    // 5. 全局默认 HTTP
    return 'http';
  }

  /**
   * 发送请求（自动选择协议）
   */
  async send(request) {
    const protocol = this.selectProtocol(request);
    const adapter = this.adapters.get(protocol);
    
    if (!adapter) {
      throw new Error(`Protocol adapter not found: ${protocol}`);
    }
    
    const startTime = Date.now();
    
    try {
      const response = await adapter.send(request);
      this.recordSuccess(protocol, Date.now() - startTime);
      return response;
    } catch (error) {
      this.recordError(protocol, Date.now() - startTime);
      
      // 尝试降级
      if (this.rules.fallback.enabled) {
        const fallbackProtocol = this.getFallbackProtocol(protocol);
        if (fallbackProtocol) {
          logger.warn('Protocol fallback triggered', {
            from: protocol,
            to: fallbackProtocol,
            error: error.message
          });
          
          const fallbackAdapter = this.adapters.get(fallbackProtocol);
          return fallbackAdapter.send(request);
        }
      }
      
      throw error;
    }
  }

  /**
   * 检查协议健康状态
   */
  isProtocolHealthy(protocol) {
    const health = this.protocolHealth.get(protocol);
    if (!health) return false;
    
    return health.healthy && 
           health.errorRate < this.rules.fallback.conditions.errorRate &&
           health.latency < this.rules.fallback.conditions.latency;
  }

  /**
   * 获取降级协议
   */
  getFallbackProtocol(currentProtocol) {
    const order = this.rules.fallback.order;
    const currentIndex = order.indexOf(currentProtocol);
    
    for (let i = currentIndex + 1; i < order.length; i++) {
      const protocol = order[i];
      if (this.isProtocolHealthy(protocol)) {
        return protocol;
      }
    }
    
    return null;
  }

  /**
   * 场景匹配
   */
  matchScenario(request, scenario, config) {
    // 服务匹配
    if (config.services && !config.services.includes(request.service)) {
      return false;
    }
    
    // 方法模式匹配
    if (config.patterns) {
      for (const pattern of config.patterns) {
        if (this.matchPattern(request.method, pattern)) {
          return true;
        }
      }
      return false;
    }
    
    return true;
  }

  /**
   * 简单模式匹配
   */
  matchPattern(str, pattern) {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(str);
  }

  /**
   * 记录成功
   */
  recordSuccess(protocol, latency) {
    const stats = this.stats.get(protocol);
    stats.requests++;
    stats.totalLatency += latency;
    
    this.updateHealth(protocol);
  }

  /**
   * 记录错误
   */
  recordError(protocol, latency) {
    const stats = this.stats.get(protocol);
    stats.requests++;
    stats.errors++;
    stats.totalLatency += latency;
    
    this.updateHealth(protocol);
  }

  /**
   * 更新健康状态
   */
  updateHealth(protocol) {
    const stats = this.stats.get(protocol);
    const health = this.protocolHealth.get(protocol);
    
    health.errorRate = stats.errors / stats.requests;
    health.latency = stats.totalLatency / stats.requests;
    health.healthy = this.isProtocolHealthy(protocol);
    
    // 发布指标
    metrics.gauge('protocol.error_rate', health.errorRate, { protocol });
    metrics.gauge('protocol.latency', health.latency, { protocol });
  }

  /**
   * 获取协议统计
   */
  getStats() {
    const result = {};
    for (const [protocol, stats] of this.stats) {
      result[protocol] = {
        ...stats,
        avgLatency: stats.requests > 0 ? stats.totalLatency / stats.requests : 0,
        errorRate: stats.requests > 0 ? stats.errors / stats.requests : 0,
        health: this.protocolHealth.get(protocol)
      };
    }
    return result;
  }
}

module.exports = ProtocolRouter;
```

### 4.5 协议配置管理

```yaml
# config/protocols.yaml

# 默认协议配置
defaults:
  timeout: 10000
  retryAttempts: 3
  retryDelay: 1000

# 各协议配置
protocols:
  http:
    enabled: true
    baseUrl: http://gateway:8080
    timeout: 10000
    connectionPool:
      max: 100
      min: 10
    
  grpc:
    enabled: true
    protoPath: ./protos
    maxReceiveMessageLength: 4194304
    keepalive:
      timeMs: 30000
      timeoutMs: 10000
    
  graphql:
    enabled: true
    endpoint: http://gateway:8080/graphql
    introspection: false
    
  websocket:
    enabled: true
    reconnectInterval: 5000
    maxReconnectAttempts: 5
    pingInterval: 30000

# 服务协议映射
serviceProtocols:
  user-service:
    default: http
    fallback: grpc
    
  pokemon-service:
    default: http
    fallback: grpc
    methods:
      pokemon.batchQuery: grpc
      
  gym-service:
    default: websocket
    fallback: http
    methods:
      battle.query: http
      
  catch-service:
    default: http
    realtime: websocket

# 降级策略
fallback:
  enabled: true
  order: [grpc, http, websocket]
  conditions:
    errorRate: 0.05
    latency: 2000
    consecutiveErrors: 5
```

### 4.6 数据库迁移

```sql
-- database/migrations/20260630_protocol_stats.sql

-- 协议调用统计表
CREATE TABLE protocol_stats (
  id SERIAL PRIMARY KEY,
  protocol VARCHAR(20) NOT NULL,
  service VARCHAR(100) NOT NULL,
  method VARCHAR(100) NOT NULL,
  request_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  total_latency_ms BIGINT DEFAULT 0,
  avg_latency_ms DECIMAL(10,2),
  error_rate DECIMAL(5,4),
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(protocol, service, method, recorded_at)
);

CREATE INDEX idx_protocol_stats_protocol ON protocol_stats(protocol);
CREATE INDEX idx_protocol_stats_service ON protocol_stats(service);
CREATE INDEX idx_protocol_stats_recorded_at ON protocol_stats(recorded_at);

-- 协议降级事件表
CREATE TABLE protocol_fallback_events (
  id SERIAL PRIMARY KEY,
  from_protocol VARCHAR(20) NOT NULL,
  to_protocol VARCHAR(20) NOT NULL,
  service VARCHAR(100),
  method VARCHAR(100),
  reason TEXT,
  triggered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_fallback_events_triggered_at ON protocol_fallback_events(triggered_at);
```

## 5. 验收标准（可测试）

- [ ] 支持 HTTP/REST、gRPC、GraphQL、WebSocket 四种协议适配器
- [ ] 协议选择器根据服务、方法、场景智能选择协议
- [ ] 配置文件支持声明式协议配置，修改后热更新生效
- [ ] 协议降级机制：主协议错误率 > 5% 或延迟 > 2 秒时自动降级
- [ ] 协议统计面板展示各协议的请求数、错误率、平均延迟
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试覆盖协议切换和降级场景
- [ ] 性能测试：gRPC 批量查询比 HTTP 快 40% 以上
- [ ] 文档更新：开发者指南包含协议使用说明

## 6. 工作量估算

**L（Large）** - 5-7 个工作日

理由：
- 需要实现 4 个协议适配器
- ProtocolRouter 路由逻辑较复杂
- gRPC 需要定义 proto 文件
- 需要实现热更新和降级机制
- 测试工作量大

## 7. 优先级理由

**P1 理由：**

1. **性能优化关键**：实时战斗、位置同步等高频场景需要 WebSocket，批量查询需要 gRPC，HTTP 无法满足性能要求

2. **解耦核心需求**：当前协议耦合严重，阻碍技术演进和性能优化

3. **可扩展性基础**：为新协议（如 GraphQL 订阅、gRPC 流式）预留扩展能力

4. **容灾能力提升**：协议降级机制提升系统可用性

5. **依赖需求就绪**：REQ-00300（服务发现）和 REQ-00319（依赖注入）已创建，为本需求提供基础
