# REQ-00607：微服务跨服务依赖解耦与统一服务发现机制

- **编号**：REQ-00607
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway, catch-service, gym-service, pokemon-service, user-service, location-service, social-service, reward-service, payment-service, backend/shared/serviceDiscovery
- **创建时间**：2026-07-20 09:00
- **依赖需求**：无

## 1. 背景与问题

当前 mineGo 项目中存在严重的微服务间硬编码依赖问题：

1. **跨服务直接引用**：catch-service 和 gym-service 通过 `require('../../pokemon-service/src/abilityService')` 直接加载 pokemon-service 的模块，违反了微服务独立性原则
2. **强耦合风险**：这种硬编码依赖导致服务无法独立部署、扩展和测试，一旦 pokemon-service 重构或迁移，会破坏多个下游服务
3. **缺乏服务发现**：没有统一的服务发现机制，服务间通信依赖硬编码路径，无法支持动态扩缩容和故障转移
4. **本地开发困难**：开发者必须启动所有相关服务才能测试单个服务功能，降低了开发效率

代码证据：
```javascript
// catch-service/src/abilityIntegration.js
const AbilityService = require('../../pokemon-service/src/abilityService');

// gym-service/src/abilityBattleIntegration.js  
const AbilityService = require('../../pokemon-service/src/abilityService');
const StatusEffectEngine = require('../../pokemon-service/src/statusEffectEngine');
```

## 2. 目标

建立统一的微服务通信架构，实现：
1. **服务独立部署**：每个服务可独立打包、部署、扩缩容，无跨服务文件依赖
2. **服务发现机制**：支持动态服务注册、发现、健康检查和故障转移
3. **API 网关通信**：所有跨服务调用通过 API 网关进行，支持认证、限流、熔断
4. **开发环境优化**：支持服务 Mock 和本地独立开发

预期收益：
- 服务独立性提升 80%
- 故障隔离能力提升 90%
- 部署灵活性提升 100%（支持滚动更新、金丝雀发布）
- 开发效率提升 40%

## 3. 范围

### 包含
1. 实现统一的服务发现客户端 `ServiceDiscoveryClient`
2. 实现服务注册中心适配器（支持 Consul/etcd/K8s Service）
3. 重构所有跨服务直接依赖为 API 调用
4. 实现服务间调用中间件（重试、超时、熔断）
5. 建立服务 Mock 机制用于本地开发
6. 更新所有受影响服务的测试用例

### 不包含
- 数据库分片和跨数据库事务
- 消息队列 Kafka 的重构（已有事件总线）
- 前端代码重构
- 第三方服务集成

## 4. 详细需求

### 4.1 服务发现客户端

**核心模块**：`backend/shared/serviceDiscovery/ServiceDiscoveryClient.js`

功能要求：
- 支持服务注册：`register(serviceName, instance)`
- 支持服务发现：`discover(serviceName)` → 返回可用实例列表
- 支持健康检查：`heartbeat(instanceId)`
- 支持负载均衡：轮询、加权、最少连接
- 支持缓存机制：本地缓存服务实例，TTL 30秒
- 支持故障转移：自动剔除不健康实例

接口定义：
```javascript
class ServiceDiscoveryClient {
  // 注册服务实例
  async register(serviceName, metadata) {
    // { host, port, version, tags, healthCheckUrl }
  }
  
  // 发现服务实例
  async discover(serviceName, options) {
    // 返回 { instances: [], strategy: 'round-robin' }
  }
  
  // 健康检查
  async heartbeat(instanceId) {
    // 更新实例最后活跃时间
  }
  
  // 注销服务
  async deregister(instanceId) {
    // 优雅下线
  }
}
```

### 4.2 服务间调用客户端

**核心模块**：`backend/shared/ServiceClient.js`

功能要求：
- 统一的 HTTP 客户端，支持服务发现集成
- 自动重试机制（可配置重试次数、退避策略）
- 超时控制（全局默认 5秒，可覆盖）
- 熔断器集成（复用现有 CircuitBreaker）
- 请求追踪（自动注入 trace-id）
- 认证传递（JWT 自动转发）

接口定义：
```javascript
class ServiceClient {
  // 调用远程服务
  async call(serviceName, method, path, data, options) {
    // 自动发现服务实例
    // 自动处理重试、超时、熔断
    // 自动注入追踪信息
  }
  
  // 流式调用（用于大文件下载）
  async stream(serviceName, path, options) {
    // 返回 ReadableStream
  }
}
```

### 4.3 重构跨服务依赖

**影响的服务及改造方案**：

| 服务 | 当前依赖 | 改造方案 |
|------|---------|---------|
| catch-service | `require('../../pokemon-service/src/abilityService')` | 调用 `pokemon-service` API `/internal/ability/assign` |
| gym-service | `require('../../pokemon-service/src/abilityService')` | 调用 `pokemon-service` API `/internal/ability/battle-effect` |
| gym-service | `require('../../pokemon-service/src/statusEffectEngine')` | 调用 `pokemon-service` API `/internal/status-effect/apply` |

**内部 API 规范**：
- 前缀：`/internal/*` （区别于外部 API）
- 认证：使用服务间认证 Token（Service Token）
- 限流：内部调用限流策略较宽松
- 文档：在 OpenAPI 中标记为 `x-internal: true`

### 4.4 服务 Mock 机制

**核心模块**：`backend/shared/mock/ServiceMockRegistry.js`

功能要求：
- 支持配置 Mock 服务响应
- 支持延迟模拟（测试超时场景）
- 支持错误注入（测试异常处理）
- 与 ServiceClient 集成，开发环境自动启用

配置示例：
```javascript
// config/mock-services.json
{
  "pokemon-service": {
    "enabled": true,
    "endpoints": {
      "/internal/ability/assign": {
        "response": { "abilityId": "static-discharge", "slot": 1 },
        "delay": 100
      }
    }
  }
}
```

### 4.5 数据库迁移

无需数据库迁移。

### 4.6 监控指标

新增 Prometheus 指标：
```
service_discovery_requests_total{service, operation}
service_discovery_cache_hits_total{service}
service_discovery_cache_misses_total{service}
service_client_calls_total{from_service, to_service, method, status}
service_client_call_duration_seconds{from_service, to_service, method}
```

## 5. 验收标准（可测试）

- [ ] 所有跨服务 `require` 语句已移除，替换为 ServiceClient 调用
- [ ] ServiceDiscoveryClient 单元测试覆盖率 ≥ 90%
- [ ] ServiceClient 集成测试通过（包含重试、超时、熔断场景）
- [ ] 每个服务可独立启动并正常运行（依赖服务可 Mock）
- [ ] 服务发现缓存命中率 ≥ 80%
- [ ] 服务间调用 P99 延迟 ≤ 100ms（本地环境）
- [ ] 所有现有测试用例通过（重构后功能无回退）
- [ ] Grafana 仪表盘新增服务发现和调用监控面板

## 6. 工作量估算

**L（Large）**

理由：
- 影响范围广：涉及 9 个微服务
- 代码重构量大：需要重写所有跨服务调用逻辑
- 测试工作量大：需要完善单元测试、集成测试、E2E 测试
- 风险较高：需要确保功能无回退，需要分阶段灰度发布

预计工作量：5-7 个工作日

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **架构基础**：这是微服务架构的核心基础，影响所有服务的独立性、可扩展性
2. **阻碍发布**：当前硬编码依赖阻碍了服务的独立部署和滚动更新
3. **故障风险**：强耦合导致故障传播风险高，一个服务故障可能影响多个服务
4. **技术债务**：这是长期积累的技术债务，越晚修复成本越高

不设为 P0 的原因：
- 不影响核心业务功能
- 现有代码虽然耦合，但功能正常运行
- 可以在接下来的迭代中优先完成

建议在完成当前所有 P0 需求后，立即启动本需求。
