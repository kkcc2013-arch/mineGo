# REQ-00194：事件总线适配器抽象层

- **编号**：REQ-00194
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/EventBusAdapter.js、backend/shared/adapters/、所有微服务、gateway
- **创建时间**：2026-06-14 12:00
- **依赖需求**：REQ-00013（事件驱动架构）

## 1. 背景与问题

当前 mineGo 项目的 EventBus 直接依赖 Kafka 实现，存在以下问题：

1. **强耦合风险**：所有微服务直接使用 Kafka 客户端，切换消息队列需要修改所有服务代码
2. **缺乏抽象**：EventBus.js 内部耦合了 Kafka 特定逻辑（如 partition、offset 管理），难以适配其他消息队列
3. **测试困难**：单元测试和集成测试依赖真实 Kafka 实例，无法使用内存消息队列进行快速测试
4. **云服务商锁定**：无法灵活选择云服务商提供的消息队列服务（如 AWS SQS、Azure Service Bus、阿里云 RocketMQ）
5. **环境适配性差**：开发环境、测试环境、生产环境无法使用不同的消息队列实现

现有代码分析：
- `backend/shared/EventBus.js` 直接使用 `kafkajs` 库
- 所有服务通过 `getEventBus()` 获取单例实例
- 无法在运行时切换消息队列实现

## 2. 目标

建立统一的事件总线适配器抽象层，实现以下目标：

1. **解耦消息队列依赖**：通过接口抽象，支持多种消息队列实现（Kafka、RabbitMQ、Redis Streams、内存队列）
2. **提升测试效率**：提供内存消息队列实现，支持无依赖的快速单元测试
3. **增强环境适配性**：通过配置文件动态选择消息队列实现，适应不同部署环境
4. **保持向后兼容**：现有基于 EventBus 的代码无需修改，平滑迁移
5. **提供工厂模式**：统一的事件总线创建和管理机制

## 3. 范围

### 包含

- 定义 `IEventBusAdapter` 接口规范
- 实现适配器工厂 `EventBusAdapterFactory`
- 实现 Kafka 适配器 `KafkaAdapter`（包装现有 EventBus）
- 实现内存适配器 `InMemoryAdapter`（用于测试）
- 实现配置驱动的适配器选择机制
- 更新现有代码使用新的抽象层
- 编写单元测试和集成测试
- 更新文档和配置说明

### 不包含

- RabbitMQ、Redis Streams 等其他适配器实现（后续需求）
- 分布式事务支持（属于其他需求）
- 消息队列监控和管理界面

## 4. 详细需求

### 4.1 接口定义

创建 `backend/shared/adapters/IEventBusAdapter.js`：

```javascript
/**
 * IEventBusAdapter - 事件总线适配器接口
 * 所有消息队列适配器必须实现此接口
 */
class IEventBusAdapter {
  // 连接管理
  async connect() { throw new Error('Not implemented'); }
  async disconnect() { throw new Error('Not implemented'); }
  async healthCheck() { throw new Error('Not implemented'); }
  
  // 消息发布
  async publish(topic, event, options) { throw new Error('Not implemented'); }
  async publishBatch(topic, events, options) { throw new Error('Not implemented'); }
  
  // 消息订阅
  async subscribe(topic, handler, options) { throw new Error('Not implemented'); }
  async unsubscribe(topic) { throw new Error('Not implemented'); }
  
  // 死信队列
  async sendToDLQ(originalTopic, event, error, attempts) { throw new Error('Not implemented'); }
  
  // 指标
  getMetrics() { throw new Error('Not implemented'); }
}
```

### 4.2 适配器工厂

创建 `backend/shared/adapters/EventBusAdapterFactory.js`：

```javascript
class EventBusAdapterFactory {
  static create(config) {
    const adapterType = config.type || process.env.EVENT_BUS_ADAPTER || 'kafka';
    
    switch (adapterType) {
      case 'kafka':
        return new KafkaAdapter(config);
      case 'memory':
        return new InMemoryAdapter(config);
      case 'rabbitmq':
        throw new Error('RabbitMQ adapter not implemented yet');
      default:
        throw new Error(`Unknown adapter type: ${adapterType}`);
    }
  }
  
  static getAvailableAdapters() {
    return ['kafka', 'memory'];
  }
}
```

### 4.3 Kafka 适配器实现

创建 `backend/shared/adapters/KafkaAdapter.js`：

- 包装现有 `EventBus` 类
- 实现 `IEventBusAdapter` 接口
- 保持与现有代码的兼容性
- 支持 Kafka 特定配置（brokers、clientId、partition 等）

### 4.4 内存适配器实现

创建 `backend/shared/adapters/InMemoryAdapter.js`：

- 使用事件发射器实现内存消息队列
- 支持主题订阅和发布
- 支持死信队列模拟
- 支持消息持久化（可选）
- 适用于单元测试和本地开发

### 4.5 配置管理

创建 `backend/shared/config/eventBus.js`：

```javascript
module.exports = {
  // 适配器类型：kafka | memory | rabbitmq
  adapter: process.env.EVENT_BUS_ADAPTER || 'kafka',
  
  // Kafka 配置
  kafka: {
    brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
    clientId: process.env.SERVICE_NAME || 'minego-service',
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
  },
  
  // 内存适配器配置
  memory: {
    maxListeners: 100,
    persistMessages: false,
  },
  
  // 通用配置
  common: {
    maxRetries: 3,
    retryDelay: 1000,
    dlqEnabled: true,
  },
};
```

### 4.6 更新现有代码

修改 `backend/shared/EventBusAdapter.js`（新文件）：

```javascript
const { EventBusAdapterFactory } = require('./adapters/EventBusAdapterFactory');
const config = require('./config/eventBus');

let adapterInstance = null;

function getEventBus(customConfig) {
  if (!adapterInstance) {
    adapterInstance = EventBusAdapterFactory.create(customConfig || config);
  }
  return adapterInstance;
}

module.exports = { getEventBus, EventBusAdapterFactory };
```

更新所有微服务的导入：

```javascript
// 旧代码
const { getEventBus } = require('../shared/EventBus');

// 新代码（保持向后兼容）
const { getEventBus } = require('../shared/EventBusAdapter');
```

### 4.7 环境变量支持

添加环境变量：

- `EVENT_BUS_ADAPTER`：适配器类型（kafka/memory/rabbitmq）
- `EVENT_BUS_DLQ_ENABLED`：是否启用死信队列
- `EVENT_BUS_MAX_RETRIES`：最大重试次数

### 4.8 测试要求

创建测试文件：

1. `backend/tests/unit/adapters/EventBusAdapterFactory.test.js`
   - 测试工厂创建不同适配器
   - 测试配置加载
   - 测试错误处理

2. `backend/tests/unit/adapters/InMemoryAdapter.test.js`
   - 测试连接/断开
   - 测试发布/订阅
   - 测试死信队列
   - 测试指标收集

3. `backend/tests/integration/eventBus.test.js`
   - 测试 Kafka 适配器（需要 Kafka 实例）
   - 测试适配器切换
   - 测试多服务事件传递

## 5. 验收标准（可测试）

- [ ] 创建 `IEventBusAdapter` 接口，包含所有必需方法定义
- [ ] 实现 `KafkaAdapter`，通过现有 EventBus 的所有测试
- [ ] 实现 `InMemoryAdapter`，支持完整的发布/订阅流程
- [ ] 创建 `EventBusAdapterFactory`，支持按配置创建适配器
- [ ] 通过环境变量 `EVENT_BUS_ADAPTER` 可切换适配器类型
- [ ] 现有所有微服务无需修改业务代码即可使用新抽象层
- [ ] 单元测试覆盖率 ≥ 90%（新代码）
- [ ] 集成测试验证 Kafka 和 Memory 适配器行为一致
- [ ] 更新 README.md 和 DEVELOPMENT.md，说明适配器配置方法
- [ ] 提供迁移指南，说明如何从旧 EventBus 迁移

## 6. 工作量估算

**L（Large）**

理由：
- 需要设计接口抽象层（2-3小时）
- 实现多个适配器（4-6小时）
- 更新所有微服务代码（2-3小时）
- 编写完整测试套件（3-4小时）
- 文档和迁移指南（1-2小时）
- 总计约 12-18 小时

## 7. 优先级理由

**P1**（高优先级）

1. **影响面广**：所有微服务都依赖事件总线，抽象层的建立将显著提升系统的可维护性和可测试性
2. **解决痛点**：当前测试环境依赖真实 Kafka，影响开发效率和 CI/CD 速度
3. **架构基础**：适配器抽象层是微服务架构的重要基础设施，越早建立越好
4. **降低风险**：避免云服务商锁定，提供技术选型的灵活性
5. **支持未来扩展**：为后续支持 RabbitMQ、Redis Streams 等消息队列奠定基础

## 8. 相关文件

- `backend/shared/EventBus.js` - 现有 EventBus 实现
- `backend/shared/events/index.js` - 事件类型定义
- `backend/tests/integration/eventBus.test.js` - 现有测试
- 各微服务的 `src/index.js` - 服务启动和 EventBus 初始化

## 9. 实施建议

### 分阶段实施

**阶段 1**：接口设计和工厂实现（1天）
- 定义 `IEventBusAdapter` 接口
- 实现 `EventBusAdapterFactory`
- 创建配置管理模块

**阶段 2**：适配器实现（2天）
- 实现 `KafkaAdapter`（包装现有 EventBus）
- 实现 `InMemoryAdapter`
- 编写单元测试

**阶段 3**：迁移和测试（2天）
- 更新所有微服务代码
- 运行集成测试
- 性能测试和验证

**阶段 4**：文档和发布（1天）
- 更新文档
- 编写迁移指南
- 代码审查和合并

### 风险控制

1. **向后兼容**：保留旧 EventBus 导出路径，渐进式迁移
2. **测试充分**：确保适配器行为一致性，避免生产事故
3. **回滚机制**：通过环境变量可快速切回 Kafka 适配器

## 10. 后续需求

完成本需求后，可继续实施：

- REQ-00195：RabbitMQ 适配器实现
- REQ-00196：Redis Streams 适配器实现
- REQ-00197：事件总线监控和管理界面
- REQ-00198：分布式事务支持
