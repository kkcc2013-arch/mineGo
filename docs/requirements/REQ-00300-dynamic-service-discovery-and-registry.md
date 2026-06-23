# REQ-00300：动态服务注册发现与健康感知路由系统

- **编号**：REQ-00300
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/serviceRegistry.js、infrastructure/k8s
- **创建时间**：2026-06-23 06:00
- **依赖需求**：REQ-00061（服务健康仪表板）、REQ-00105（分布式锁服务）

## 1. 背景与问题

当前 mineGo 微服务架构中存在以下问题：

**服务发现缺失**：
- 各微服务地址硬编码在环境变量或配置文件中
- 新服务上线需要手动更新所有依赖方的配置
- 服务实例变更（扩缩容、故障转移）无法自动感知

**健康感知不足**：
- Gateway 路由转发不感知下游服务健康状态
- 故障实例仍接收流量，导致请求失败
- 缺少服务实例权重与熔断联动机制

**扩展性受限**：
- 新增微服务需要修改 Gateway 路由配置
- 服务间依赖关系不透明，耦合度高
- 无法实现灰度发布和流量分割的自动路由

当前代码中，服务调用使用硬编码地址：
```javascript
// backend/shared/ApiClient.js
const SERVICE_URLS = {
  'user-service': process.env.USER_SERVICE_URL || 'http://localhost:3001',
  'pokemon-service': process.env.POKEMON_SERVICE_URL || 'http://localhost:3002',
  // ... 硬编码的服务地址
};
```

## 2. 目标

1. **动态服务注册**：服务实例启动时自动注册到注册中心
2. **健康感知路由**：Gateway 根据服务健康状态动态路由请求
3. **自动故障转移**：故障实例自动摘除，恢复后自动注册
4. **灰度发布支持**：基于服务版本和权重的智能路由
5. **服务依赖可视化**：自动生成服务调用拓扑图

## 3. 范围

**包含**：
- 基于 Redis 的轻量级服务注册中心实现
- 服务注册与健康检查 SDK
- Gateway 动态路由中间件
- 服务实例权重管理
- 健康状态监控与告警
- 服务依赖关系追踪

**不包含**：
- 外部服务发现组件（Consul、etcd、Nacos）集成
- 跨数据中心的服务发现
- 服务网格（Service Mesh）实现

## 4. 详细需求

### 4.1 服务注册中心

**数据结构（Redis）**：
```javascript
// 服务实例信息
{
  serviceId: 'user-service-instance-1',
  serviceName: 'user-service',
  host: '192.168.1.100',
  port: 3001,
  version: '1.2.3',
  metadata: {
    zone: 'us-west-1',
    weight: 100,
    tags: ['stable', 'production']
  },
  healthStatus: 'healthy',
  lastHeartbeat: 1719123456789,
  registeredAt: 1719123456000
}

// Redis 存储结构
// 服务实例列表: service:registry:{serviceName} -> SET of instanceIds
// 实例详情: service:instance:{instanceId} -> HASH
// 健康状态: service:health:{serviceName} -> ZSET (score = lastHeartbeat)
```

**核心接口**：
- `register(serviceInfo)` - 服务注册
- `deregister(instanceId)` - 服务注销
- `heartbeat(instanceId)` - 心跳续约
- `discover(serviceName, filters)` - 服务发现
- `updateHealth(instanceId, status)` - 更新健康状态

### 4.2 服务注册 SDK

**实现位置**：`backend/shared/ServiceRegistry.js`

```javascript
class ServiceRegistry {
  constructor(config) {
    this.redisClient = config.redisClient;
    this.instanceId = this.generateInstanceId();
    this.serviceName = config.serviceName;
    this.port = config.port;
    this.heartbeatInterval = 10000; // 10秒
    this.ttl = 30000; // 30秒过期
  }

  async register() {
    const instanceInfo = {
      serviceId: this.instanceId,
      serviceName: this.serviceName,
      host: this.getHost(),
      port: this.port,
      version: process.env.SERVICE_VERSION || '1.0.0',
      metadata: this.getMetadata(),
      healthStatus: 'healthy',
      lastHeartbeat: Date.now(),
      registeredAt: Date.now()
    };

    await this.redisClient.multi()
      .sadd(`service:registry:${this.serviceName}`, this.instanceId)
      .hset(`service:instance:${this.instanceId}`, instanceInfo)
      .zadd(`service:health:${this.serviceName}`, Date.now(), this.instanceId)
      .expire(`service:instance:${this.instanceId}`, this.ttl)
      .exec();

    this.startHeartbeat();
  }

  async heartbeat() {
    const now = Date.now();
    await this.redisClient.multi()
      .hset(`service:instance:${this.instanceId}`, 'lastHeartbeat', now)
      .zadd(`service:health:${this.serviceName}`, now, this.instanceId)
      .expire(`service:instance:${this.instanceId}`, this.ttl)
      .exec();
  }

  async deregister() {
    await this.redisClient.multi()
      .srem(`service:registry:${this.serviceName}`, this.instanceId)
      .del(`service:instance:${this.instanceId}`)
      .zrem(`service:health:${this.serviceName}`, this.instanceId)
      .exec();
    
    clearInterval(this.heartbeatTimer);
  }
}
```

### 4.3 健康检查机制

**心跳检查**：
- 服务实例每 10 秒发送心跳
- 超过 30 秒未心跳标记为 `unhealthy`
- 超过 60 秒自动注销

**主动健康探测**：
- 注册中心定期对实例进行 HTTP 健康检查
- 检查 `/health` 端点响应时间和状态码
- 更新实例健康评分

```javascript
class HealthChecker {
  async checkInstance(instanceId) {
    const instance = await this.getInstance(instanceId);
    try {
      const response = await axios.get(`http://${instance.host}:${instance.port}/health`, {
        timeout: 5000
      });
      
      const healthScore = this.calculateHealthScore(response);
      await this.updateInstanceHealth(instanceId, healthScore);
    } catch (error) {
      await this.markUnhealthy(instanceId);
    }
  }

  calculateHealthScore(response) {
    let score = 100;
    if (response.status !== 200) score -= 50;
    if (response.data.status !== 'healthy') score -= 30;
    if (response.config.responseTime > 1000) score -= 20;
    return Math.max(0, score);
  }
}
```

### 4.4 Gateway 动态路由

**实现位置**：`backend/services/gateway/middleware/ServiceDiscoveryMiddleware.js`

```javascript
class ServiceDiscoveryMiddleware {
  async resolveService(serviceName, req) {
    // 1. 发现健康实例
    const instances = await this.registry.discover(serviceName, {
      healthStatus: 'healthy',
      minHealthScore: 50
    });

    if (instances.length === 0) {
      throw new ServiceUnavailableError(`No healthy instances for ${serviceName}`);
    }

    // 2. 负载均衡选择实例
    const instance = this.loadBalancer.select(instances, {
      strategy: 'weighted-round-robin',
      metadata: req.headers['x-service-version'] // 灰度版本
    });

    // 3. 记录路由决策
    this.trackRoute(serviceName, instance);

    return instance;
  }

  async proxyRequest(req, res, next) {
    const serviceName = this.extractServiceName(req.path);
    const instance = await this.resolveService(serviceName, req);
    
    req.targetInstance = instance;
    next();
  }
}
```

### 4.5 负载均衡策略

**支持的策略**：
1. **轮询（Round Robin）**：依次选择实例
2. **加权轮询（Weighted Round Robin）**：根据权重分配
3. **最少连接（Least Connections）**：选择当前连接数最少的实例
4. **健康评分优先（Health Score）**：优先选择健康评分高的实例
5. **区域亲和（Zone Affinity）**：优先选择同区域实例

```javascript
class LoadBalancer {
  select(instances, options = {}) {
    const strategy = options.strategy || 'weighted-round-robin';
    
    switch (strategy) {
      case 'weighted-round-robin':
        return this.weightedRoundRobin(instances);
      case 'least-connections':
        return this.leastConnections(instances);
      case 'health-score':
        return this.highestHealthScore(instances);
      default:
        return instances[0];
    }
  }

  weightedRoundRobin(instances) {
    const totalWeight = instances.reduce((sum, i) => sum + (i.metadata.weight || 100), 0);
    let random = Math.random() * totalWeight;
    
    for (const instance of instances) {
      random -= (instance.metadata.weight || 100);
      if (random <= 0) return instance;
    }
    
    return instances[0];
  }
}
```

### 4.6 服务依赖追踪

**自动追踪服务调用**：
```javascript
class DependencyTracker {
  async recordCall(sourceService, targetService, metadata) {
    await this.redisClient.hset(
      `service:dependencies:${sourceService}`,
      targetService,
      JSON.stringify({
        callCount: metadata.callCount,
        avgLatency: metadata.avgLatency,
        errorRate: metadata.errorRate,
        lastCall: Date.now()
      })
    );
  }

  async getDependencyGraph() {
    const services = await this.getAllServices();
    const graph = {};
    
    for (const service of services) {
      const deps = await this.redisClient.hgetall(`service:dependencies:${service}`);
      graph[service] = Object.keys(deps).map(dep => ({
        target: dep,
        ...JSON.parse(deps[dep])
      }));
    }
    
    return graph;
  }
}
```

### 4.7 灰度发布支持

**基于版本的路由**：
```javascript
class CanaryRouter {
  async route(req, serviceName) {
    const version = req.headers['x-service-version'];
    const canaryWeight = await this.getCanaryWeight(serviceName, version);
    
    if (Math.random() < canaryWeight) {
      return this.selectCanaryInstance(serviceName, version);
    } else {
      return this.selectStableInstance(serviceName);
    }
  }
}
```

## 5. 验收标准（可测试）

- [ ] 服务启动后 5 秒内完成注册到 Redis 注册中心
- [ ] 心跳续约每 10 秒执行一次，延迟不超过 1 秒
- [ ] 实例超过 30 秒无心跳自动标记为 unhealthy
- [ ] 实例超过 60 秒无心跳自动从注册中心移除
- [ ] Gateway 能在 100ms 内完成服务发现和实例选择
- [ ] 负载均衡器正确实现加权轮询算法，权重偏差不超过 5%
- [ ] 健康实例故障后，Gateway 在 10 秒内停止向其路由请求
- [ ] 服务依赖拓扑图能实时展示服务间调用关系
- [ ] 灰度发布流量分割精度达到配置值的 ±2%
- [ ] 所有 9 个微服务集成服务注册 SDK
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 集成测试验证故障转移和自动恢复

## 6. 工作量估算

**L（Large）**

**理由**：
- 需要实现服务注册中心核心逻辑（2-3 天）
- 开发 SDK 并集成到 9 个微服务（2-3 天）
- Gateway 动态路由中间件开发（2 天）
- 健康检查和负载均衡算法（2 天）
- 服务依赖追踪和可视化（1-2 天）
- 测试和文档编写（1-2 天）

**总计**：10-14 个工作日

## 7. 优先级理由

**P1 理由**：

1. **基础架构关键需求**：服务发现是微服务架构的核心基础设施，影响所有服务的通信和可靠性

2. **解决生产痛点**：当前硬编码服务地址导致扩缩容和故障转移困难，影响系统可用性

3. **支撑其他需求**：
   - REQ-00061（服务健康仪表板）需要实例级健康数据
   - REQ-00078（金丝雀发布）需要动态路由能力
   - REQ-00103（微服务依赖图）可复用依赖追踪模块

4. **收益明显**：实现后可显著提升系统的可扩展性和故障恢复能力

5. **风险可控**：使用 Redis 作为注册中心，无需引入新组件，学习成本低
