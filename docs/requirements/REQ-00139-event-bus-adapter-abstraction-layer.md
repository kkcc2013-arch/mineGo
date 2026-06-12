# REQ-00139：事件总线适配器抽象层

- **编号**：REQ-00139
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/EventBusAdapter.js、backend/shared/adapters/、所有微服务、EventBus.js
- **创建时间**：2026-06-12 02:00
- **依赖需求**：REQ-00013（事件驱动架构与服务解耦）

## 1. 背景与问题

当前 mineGo 项目的 EventBus 直接绑定 Kafka 实现，所有服务通过 `backend/shared/EventBus.js` 与 Kafka 交互。这带来以下问题：

1. **开发环境依赖重**：本地开发需要启动 Kafka，增加开发成本和调试复杂度
2. **难以切换消息系统**：如果未来需要迁移到 RabbitMQ、NATS 或云服务（如 AWS SQS/SNS），需要修改所有服务的事件发布/订阅代码
3. **测试隔离困难**：单元测试和集成测试难以使用内存队列进行快速验证
4. **多环境适配缺失**：不同部署环境（K8s、云函数、边缘计算）可能需要不同的消息系统

代码现状：`EventBus.js` 中直接使用 `kafkajs` 库，没有适配器抽象层。

## 2. 目标

1. 引入事件总线适配器抽象层，定义统一的 `IEventBusAdapter` 接口
2. 实现 KafkaAdapter（保留现有功能）、MemoryAdapter（开发/测试）、RedisStreamAdapter（轻量替代方案）
3. 通过配置动态选择适配器，支持环境切换无需修改代码
4. 保持向后兼容，现有 EventBus API 不变，内部切换到适配器架构

## 3. 范围

- **包含**：
  - 定义 IEventBusAdapter 接口（publish、subscribe、unsubscribe、healthCheck）
  - 实现 KafkaAdapter（封装现有 kafkajs 逻辑）
  - 实现 MemoryAdapter（用于开发/测试，基于内存队列）
  - 实现 RedisStreamAdapter（基于 Redis Streams，作为轻量替代）
  - EventBus 改造为使用适配器模式
  - 配置驱动适配器选择（EVENT_BUS_ADAPTER=kafka|memory|redis）
  - 单元测试覆盖三种适配器

- **不包含**：
  - RabbitMQ/NATS 适配器（后续需求）
  - 事件 schema 验证（已有 REQ-00080）
  - 事件溯源机制（后续需求）

## 4. 详细需求

### 4.1 IEventBusAdapter 接口定义

```javascript
// backend/shared/adapters/IEventBusAdapter.js
/**
 * @interface IEventBusAdapter
 */
class IEventBusAdapter {
  // 连接
  async connect() {}
  async disconnect() {}
  
  // 发布事件
  async publish(topic, event, options = {}) {}
  
  // 订阅主题
  async subscribe(topic, handler, options = {}) {}
  async unsubscribe(topic) {}
  
  // 健康检查
  async healthCheck() {}
  
  // 获取指标
  getMetrics() {}
}
```

### 4.2 KafkaAdapter 实现

- 封装现有 EventBus 的 Kafka 逻辑
- 支持所有现有功能（DLQ、重试、metrics）
- 保持与现有代码完全兼容

### 4.3 MemoryAdapter 实现

- 基于 Node.js EventEmitter 或内存队列
- 支持异步消息投递模拟
- 支持基本重试和错误处理
- 用于单元测试和本地开发

### 4.4 RedisStreamAdapter 实现

- 使用 Redis XADD/XREAD 实现消息流
- 支持消费者组模式
- 适用于无 Kafka 的轻量部署场景

### 4.5 EventBus 改造

```javascript
// backend/shared/EventBus.js 改造
const { KafkaAdapter } = require('./adapters/KafkaAdapter');
const { MemoryAdapter } = require('./adapters/MemoryAdapter');
const { RedisStreamAdapter } = require('./adapters/RedisStreamAdapter');

function createEventBus(config = {}) {
  const adapterType = config.adapter || process.env.EVENT_BUS_ADAPTER || 'kafka';
  
  const adapters = {
    kafka: () => new KafkaAdapter(config),
    memory: () => new MemoryAdapter(config),
    redis: () => new RedisStreamAdapter(config),
  };
  
  const adapter = adapters[adapterType]();
  return new EventBus(adapter, config);
}
```

### 4.6 配置支持

环境变量：
- `EVENT_BUS_ADAPTER`：kafka | memory | redis
- `EVENT_BUS_ADAPTER_OPTIONS`：JSON 格式的适配器特定配置

服务配置文件支持：
```yaml
eventBus:
  adapter: kafka
  kafka:
    brokers: ["kafka:9092"]
  redis:
    url: "redis://redis:6379"
```

## 5. 验收标准（可测试）

- [ ] IEventBusAdapter 接口定义完整，包含 connect/disconnect/publish/subscribe/healthCheck
- [ ] KafkaAdapter 实现并通过现有集成测试，功能与原 EventBus 一致
- [ ] MemoryAdapter 实现并通过单元测试，支持基本发布订阅和重试
- [ ] RedisStreamAdapter 实现并通过单元测试，支持消费者组
- [ ] EventBus 使用适配器模式改造，API 保持向后兼容
- [ ] 通过 `EVENT_BUS_ADAPTER=memory` 环境变量，所有服务可使用内存队列运行
- [ ] 配置文档更新，说明适配器选择方式
- [ ] 单元测试覆盖率 > 80%

## 6. 工作量估算

**M（Medium）**：约 3-4 小时

- IEventBusAdapter 接口：0.5h
- KafkaAdapter 封装：1h
- MemoryAdapter 实现：1h
- RedisStreamAdapter 实现：1h
- EventBus 改造与测试：0.5h

## 7. 优先级理由

P1 级别：事件总线是微服务通信的核心基础设施，抽象层设计直接影响：
1. 开发效率（本地开发无需 Kafka）
2. 测试速度（内存队列测试快 10x）
3. 未来扩展性（可平滑迁移到其他消息系统）
4. 多环境部署灵活性

这是"项目可用"的关键解耦需求，对可扩展性维度贡献显著。