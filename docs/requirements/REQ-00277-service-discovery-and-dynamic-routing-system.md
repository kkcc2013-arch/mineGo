# REQ-00277：服务发现与动态路由系统

- **编号**：REQ-00277
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway, backend/shared, 所有微服务, k8s/01-services
- **创建时间**：2026-06-22 02:00
- **依赖需求**：REQ-00044 (API 版本管理)

## 1. 背景与问题

当前 mineGo 微服务间通信存在以下问题：

1. **URL 硬编码**：服务间调用使用环境变量或硬编码 URL（如 `http://localhost:8082`），不利于动态扩缩容和多环境部署
2. **调用方式不一致**：部分服务使用 `ApiClient`（catch-service），部分直接使用 `fetch`，缺乏统一的服务调用抽象
3. **缺乏服务发现**：在 Kubernetes 环境中，服务发现依赖 DNS，但缺少客户端负载均衡和健康感知
4. **容错能力不足**：服务下线或不可用时，调用方无法自动切换到健康实例
5. **无法感知服务拓扑**：服务间依赖关系不透明，影响故障定位和容量规划

```javascript
// 当前问题示例：catch-service 直接硬编码调用
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:8082';
const response = await fetch(`${LOCATION_SERVICE_URL}/cache/wild/${wildId}`, { ... });
```

这种模式在多副本、跨区域部署场景下会导致：
- 负载不均衡（只调用固定实例）
- 故障无法自动转移
- 扩容后流量分配不均

## 2. 目标

建立统一的服务发现与动态路由系统，实现：

1. **自动服务发现**：服务启动自动注册，下线自动注销
2. **客户端负载均衡**：支持轮询、加权、最少连接等策略
3. **健康感知路由**：自动剔除不健康实例，故障自动转移
4. **透明调用**：服务调用通过服务名，无需关心实际地址
5. **可观测性**：服务拓扑可视化，调用链路追踪集成

预期收益：
- 提升系统可扩展性：支持动态扩缩容，新实例自动纳入负载
- 提高可用性：单实例故障自动转移，减少服务中断
- 简化配置：消除硬编码 URL，降低运维复杂度
- 增强可观测性：服务依赖关系透明化

## 3. 范围

### 包含

1. **服务注册中心客户端**：
   - 支持 Kubernetes原生服务发现作为首选
   - 支持 Consul 作为可选注册中心（混合云场景）
   - 服务实例注册、心跳、注销

2. **服务发现客户端 SDK**：
   - 统一的服务发现接口 `ServiceDiscovery`
   - 与现有 `ApiClient` 集成
   - 支持缓存与预取

3. **负载均衡策略**：
   - 轮询（Round Robin）
   - 加权轮询（Weighted Round Robin）
   - 最少连接（Least Connections）
   - 一致性哈希（Consistent Hash，用于会话粘性）

4. **健康检查集成**：
   - 主动健康探测
   - 被动故障检测（基于调用失败率）
   - 自动熔断与恢复

5. **服务网格准备**：
   - 支持 Istio/Linkerd 兼容的服务发现接口
   - 便于未来平滑迁移到 Service Mesh

### 不包含

- 完整的服务网格实现（如 sidecar 代理）
- 全局配置中心（已有 ConfigCenter.js）
- API 网关层面的路由（gateway 已有路由功能）
- 跨数据中心的服务发现（初期仅支持单集群）

## 4. 详细需求

### 4.1 服务注册客户端

```javascript
// backend/shared/ServiceRegistry.js
class ServiceRegistry {
  constructor(options) {
    this.serviceName = options.serviceName;
    this.instanceId = options.instanceId || generateInstanceId();
    this.host = options.host;
    this.port = options.port;
    this.metadata = options.metadata || {};
    this.heartbeatInterval = options.heartbeatInterval || 10000;
    this.registryClient = null; // Consul client or K8s API
  }

  async register();
  async deregister();
  async sendHeartbeat();
  async updateMetadata(metadata);
}
```

**注册信息包含**：
- 服务名、实例 ID、地址、端口
- 元数据：版本、权重、区域、标签
- 健康检查端点

### 4.2 服务发现客户端 SDK

```javascript
// backend/shared/ServiceDiscovery.js
class ServiceDiscovery {
  constructor(options) {
    this.cache = new Map(); // serviceName -> Instance[]
    this.cacheTTL = options.cacheTTL || 30000;
    this.loadBalancer = new LoadBalancer(options.loadBalanceStrategy);
  }

  // 获取单个实例（负载均衡）
  async getInstance(serviceName);

  // 获取所有实例
  async getInstances(serviceName);

  // 订阅服务变更
  subscribe(serviceName, callback);

  // 手动刷新缓存
  async refresh(serviceName);
}
```

### 4.3 与 ApiClient 集成

扩展现有 `ApiClient` 支持服务发现：

```javascript
// backend/shared/ApiClient.js 扩展
class ApiClient {
  constructor(targetService, options = {}) {
    // 如果传入 serviceName，使用服务发现
    if (options.useDiscovery) {
      this.discovery = ServiceDiscovery.getInstance();
      this.loadBalancer = new LoadBalancer(options.loadBalanceStrategy);
    }
    // 否则使用传统 baseUrl
  }

  async request(method, path, data) {
    if (this.discovery) {
      const instance = await this.discovery.getInstance(this.targetService);
      const baseUrl = `http://${instance.host}:${instance.port}`;
      // 使用动态地址发起请求
    }
    // ...
  }
}
```

### 4.4 负载均衡策略

```javascript
// backend/shared/LoadBalancer.js
class LoadBalancer {
  constructor(strategy = 'roundRobin') {
    this.strategy = strategy;
    this.counters = new Map();
  }

  select(instances, context = {}) {
    switch (this.strategy) {
      case 'roundRobin':
        return this.roundRobin(instances);
      case 'weightedRoundRobin':
        return this.weightedRoundRobin(instances);
      case 'leastConnections':
        return this.leastConnections(instances);
      case 'consistentHash':
        return this.consistentHash(instances, context.key);
      default:
        return instances[0];
    }
  }
}
```

### 4.5 Kubernetes 集成

在 K8s 环境，优先使用原生服务发现：

1. **Headless Service**：为每个微服务创建 headless service，获取 Pod IP 列表
2. **Endpoints API**：监控 Endpoints 变化，实时更新实例列表
3. **就绪探针**：与 K8s readiness probe 集成，确保仅路由到就绪实例

```yaml
# k8s/01-services/location-service-headless.yaml
apiVersion: v1
kind: Service
metadata:
  name: location-service-discovery
spec:
  type: ClusterIP
  clusterIP: None  # Headless
  selector:
    app: location-service
  ports:
  - port: 8082
    targetPort: 8082
```

### 4.6 健康检查与故障转移

1. **主动探测**：定期调用 `/health` 端点，更新实例健康状态
2. **被动检测**：基于调用失败率自动标记不健康实例
3. **熔断集成**：与现有 `CircuitBreaker.js` 集成
4. **自动恢复**：不健康实例恢复后自动重新纳入负载

### 4.7 配置项

```javascript
// config/service-discovery.js
module.exports = {
  enabled: process.env.SERVICE_DISCOVERY_ENABLED === 'true',
  
  // 注册中心类型: 'k8s' | 'consul' | 'static'
  registryType: process.env.REGISTRY_TYPE || 'k8s',
  
  // Consul 配置（可选）
  consul: {
    host: process.env.CONSUL_HOST || 'localhost',
    port: parseInt(process.env.CONSUL_PORT || '8500')
  },
  
  // 心跳间隔（毫秒）
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '10000'),
  
  // 实例缓存 TTL（毫秒）
  cacheTTL: parseInt(process.env.SERVICE_CACHE_TTL || '30000'),
  
  // 负载均衡策略
  loadBalanceStrategy: process.env.LB_STRATEGY || 'roundRobin',
  
  // 健康检查
  healthCheck: {
    enabled: true,
    interval: 15000,
    timeout: 5000,
    threshold: 3  // 连续失败次数
  },
  
  // 故障转移
  failover: {
    enabled: true,
    retryAttempts: 3,
    retryDelay: 1000
  }
};
```

### 4.8 与 ServiceFactory 集成

扩展现有 `ServiceFactory`，自动注册服务：

```javascript
// backend/shared/ServiceFactory.js 扩展
class ServiceFactory {
  static async createService(config) {
    // ... 现有初始化逻辑 ...
    
    // 服务注册
    if (opts.serviceDiscovery?.enabled) {
      const registry = new ServiceRegistry({
        serviceName: name,
        port: port,
        host: opts.serviceDiscovery.host || getLocalIP(),
        metadata: {
          version: process.env.npm_package_version || '1.0.0',
          region: process.env.REGION || 'default'
        }
      });
      
      await registry.register();
      
      // 优雅关闭时注销
      if (opts.gracefulShutdown) {
        process.on('SIGTERM', async () => {
          await registry.deregister();
        });
      }
    }
    
    return { app, server, logger, registry };
  }
}
```

## 5. 验收标准（可测试）

- [ ] **服务注册**：服务启动后自动注册到注册中心，可查询到实例信息
- [ ] **服务发现**：通过服务名获取实例列表，返回至少 1 个健康实例
- [ ] **负载均衡**：多实例场景下，请求按策略均衡分布（标准差 < 10%）
- [ ] **健康感知**：实例健康检查失败后，自动从负载池剔除，调用不再路由到该实例
- [ ] **故障转移**：单实例不可用时，自动切换到其他健康实例，请求成功率 > 99%
- [ ] **缓存机制**：服务实例列表缓存 TTL 内不重复查询注册中心
- [ ] **优雅关闭**：服务停止时自动注销，现有请求正常完成
- [ ] **ApiClient 集成**：现有使用 ApiClient 的服务无需修改调用代码，仅需启用服务发现
- [ ] **Kubernetes 兼容**：在 K8s 环境正确获取 Pod IP 列表，与 Service 无冲突
- [ ] **可观测性**：提供 `/services` 端点，展示当前已知的服务实例列表

## 6. 工作量估算

**L（Large）**

**理由**：
- 需要实现服务注册、发现、负载均衡、健康检查等多个核心模块
- 需要扩展现有 ApiClient 和 ServiceFactory
- 需要与 Kubernetes 集成测试
- 需要迁移现有硬编码调用的服务
- 预计 3-5 个工作日

## 7. 优先级理由

**P1（高优先级）**

1. **基础设施级别**：服务发现是微服务架构的基础能力，影响所有服务间通信
2. **可扩展性瓶颈**：当前硬编码 URL 限制了动态扩缩容能力，影响生产可用性
3. **可靠性风险**：缺少故障转移机制，单实例故障可能导致服务不可用
4. **技术债务**：服务间调用方式不一致，增加维护成本
5. **前置依赖**：后续的灰度发布、金丝雀发布等功能依赖服务发现能力

完成此需求后，系统可扩展性将从 13 分提升至 15 分（满分 15），支持真正的云原生动态调度。
