# REQ-00013：事件驱动架构与服务解耦

- **编号**：REQ-00013
- **类别**：可扩展性/解耦
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：所有微服务、Kafka、backend/shared
- **创建时间**：2026-06-05 09:25
- **依赖需求**：REQ-00002（结构化日志）

## 1. 背景与问题

当前 mineGo 微服务之间存在紧耦合问题：

### 1.1 同步调用链过长

典型场景：用户捕捉精灵需要同步调用多个服务

```
game-client → gateway → catch-service → pokemon-service
                                    ↓
                              location-service
                                    ↓
                              user-service (更新背包)
                                    ↓
                              reward-service (发放奖励)
                                    ↓
                              social-service (推送通知)
```

**问题**：
1. **延迟累积**：每个服务串行等待，总延迟 = 各服务延迟之和
2. **故障传播**：任一服务失败导致整个链路失败
3. **难以扩展**：新增功能需要修改多个服务
4. **资源浪费**：核心服务（catch）等待非核心服务（social）

### 1.2 当前架构问题

```javascript
// catch-service/src/index.js (当前)
router.post('/catch', async (req, res) => {
  // 1. 验证位置
  const location = await locationService.verify(req.body.location);
  
  // 2. 捕捉逻辑
  const result = await catchPokemon(req.body);
  
  // 3. 更新用户背包（同步等待）
  await userService.addPokemon(req.user.id, result.pokemon);
  
  // 4. 发放奖励（同步等待）
  await rewardService.grant(req.user.id, 'catch', result);
  
  // 5. 推送通知（同步等待）
  await socialService.notify(req.user.id, 'catch_success', result);
  
  res.json(result);
});
```

**耦合度分析**：
- catch-service 直接依赖 4 个其他服务
- 修改任一服务接口需要修改 catch-service
- 无法独立测试和部署

## 2. 目标

通过事件驱动架构实现服务解耦：

1. **异步化非核心流程**：奖励、通知等异步处理，不阻塞核心捕捉逻辑
2. **事件总线**：使用 Kafka 作为事件总线，服务间通过事件通信
3. **最终一致性**：核心操作同步完成，辅助操作异步最终一致
4. **服务独立**：每个服务只关心自己的事件，不直接依赖其他服务
5. **易于扩展**：新增功能只需订阅事件，无需修改现有服务

## 3. 范围

### 包含
- Kafka 事件总线配置和部署
- 事件发布/订阅框架（EventBus 类）
- 核心场景事件化（捕捉、道馆战斗、社交）
- 事件处理器和重试机制
- 死信队列处理

### 不包含
- CQRS 架构改造（可在后续需求处理）
- 事件溯源（Event Sourcing）
- 分布式事务（Saga 模式）

## 4. 详细需求

### 4.1 事件总线框架

#### 4.1.1 EventBus 核心类
```javascript
// backend/shared/EventBus.js
const { Kafka } = require('kafkajs');

class EventBus {
  constructor(config) {
    this.kafka = new Kafka({
      brokers: config.brokers || ['localhost:9092'],
      clientId: config.clientId
    });
    this.producer = this.kafka.producer();
    this.consumers = new Map();
  }

  async connect() {
    await this.producer.connect();
  }

  // 发布事件
  async publish(topic, event) {
    const message = {
      key: event.id || `${Date.now()}`,
      value: JSON.stringify({
        ...event,
        timestamp: new Date().toISOString(),
        source: this.clientId
      })
    };

    await this.producer.send({ topic, messages: [message] });
    logger.info({ topic, eventId: event.id }, 'Event published');
  }

  // 订阅事件
  async subscribe(topic, handler, options = {}) {
    const consumer = this.kafka.consumer({
      groupId: options.groupId || `${this.clientId}-${topic}`,
      fromBeginning: options.fromBeginning || false
    });

    await consumer.connect();
    await consumer.subscribe({ topic });

    await consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const event = JSON.parse(message.value.toString());
          await handler(event);
        } catch (err) {
          logger.error({ err, topic }, 'Event handler failed');
          // 发送到死信队列
          await this.publish(`${topic}-dlq`, { originalEvent: event, error: err.message });
        }
      }
    });

    this.consumers.set(topic, consumer);
  }

  async disconnect() {
    await this.producer.disconnect();
    for (const consumer of this.consumers.values()) {
      await consumer.disconnect();
    }
  }
}

module.exports = { EventBus };
```

### 4.2 事件定义

#### 4.2.1 标准事件格式
```javascript
// backend/shared/events/index.js
const EventTypes = {
  // 捕捉相关
  CATCH_SUCCESS: 'catch.success',
  CATCH_FAILED: 'catch.failed',
  
  // 道馆相关
  GYM_BATTLE_START: 'gym.battle.start',
  GYM_BATTLE_END: 'gym.battle.end',
  GYM_DEFEAT: 'gym.defeat',
  
  // 用户相关
  USER_LEVEL_UP: 'user.level.up',
  USER_ACHIEVEMENT: 'user.achievement',
  
  // 社交相关
  FRIEND_REQUEST: 'social.friend.request',
  FRIEND_ACCEPT: 'social.friend.accept',
  
  // 奖励相关
  REWARD_GRANT: 'reward.grant'
};

// 事件创建工厂
function createEvent(type, data, metadata = {}) {
  return {
    id: `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    data,
    metadata,
    timestamp: new Date().toISOString()
  };
}
```

### 4.3 捕捉场景事件化改造

#### 4.3.1 catch-service 重构
```javascript
// catch-service/src/index.js (重构后)
const { EventBus, createEvent, EventTypes } = require('../../../shared');

router.post('/catch', async (req, res) => {
  // 1. 验证位置（核心，同步）
  const location = await locationService.verify(req.body.location);
  
  // 2. 捕捉逻辑（核心，同步）
  const result = await catchPokemon(req.body);
  
  // 3. 发布捕捉成功事件（非核心，异步）
  if (result.success) {
    await eventBus.publish(EventTypes.CATCH_SUCCESS, createEvent(
      EventTypes.CATCH_SUCCESS,
      {
        userId: req.user.id,
        pokemon: result.pokemon,
        location: req.body.location,
        rewards: result.rewards
      }
    ));
  }
  
  // 立即返回，不等待后续处理
  res.json(result);
});
```

#### 4.3.2 事件处理器
```javascript
// user-service/src/handlers/catchHandler.js
async function handleCatchSuccess(event) {
  const { userId, pokemon } = event.data;
  
  // 添加精灵到背包
  await addPokemonToBag(userId, pokemon);
  
  logger.info({ userId, pokemonId: pokemon.id }, 'Pokemon added to bag');
}

// 注册处理器
eventBus.subscribe(EventTypes.CATCH_SUCCESS, handleCatchSuccess, {
  groupId: 'user-service-catch'
});
```

```javascript
// reward-service/src/handlers/catchHandler.js
async function handleCatchSuccess(event) {
  const { userId, rewards } = event.data;
  
  // 发放奖励
  await grantRewards(userId, rewards);
  
  logger.info({ userId, rewards }, 'Rewards granted');
}

eventBus.subscribe(EventTypes.CATCH_SUCCESS, handleCatchSuccess, {
  groupId: 'reward-service-catch'
});
```

```javascript
// social-service/src/handlers/catchHandler.js
async function handleCatchSuccess(event) {
  const { userId, pokemon } = event.data;
  
  // 推送通知
  await sendNotification(userId, {
    type: 'catch_success',
    title: '捕捉成功！',
    body: `你捕捉了一只 ${pokemon.name}！`
  });
}

eventBus.subscribe(EventTypes.CATCH_SUCCESS, handleCatchSuccess, {
  groupId: 'social-service-catch'
});
```

### 4.4 Kafka 配置

#### 4.4.1 Topic 配置
```yaml
# infrastructure/k8s/kafka/topics.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: catch.success
  namespace: minego
spec:
  partitions: 3
  replicas: 3
  config:
    retention.ms: 604800000  # 7 days
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: catch.success-dlq
  namespace: minego
spec:
  partitions: 1
  replicas: 3
  config:
    retention.ms: 2592000000  # 30 days
```

#### 4.4.2 Kafka 部署
```yaml
# infrastructure/k8s/kafka/kafka-cluster.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: minego-kafka
  namespace: minego
spec:
  kafka:
    version: 3.5.1
    replicas: 3
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
    storage:
      type: persistent-claim
      size: 10Gi
      class: standard
  zookeeper:
    replicas: 3
    storage:
      type: persistent-claim
      size: 5Gi
      class: standard
```

### 4.5 重试和死信处理

#### 4.5.1 重试策略
```javascript
// backend/shared/EventBus.js (扩展)
class EventBus {
  async subscribeWithRetry(topic, handler, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const retryDelay = options.retryDelay || 1000;

    await this.subscribe(topic, async (event) => {
      let lastError;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await handler(event);
          return; // 成功，退出
        } catch (err) {
          lastError = err;
          logger.warn({ attempt, maxRetries, err }, 'Event handler failed, retrying');
          
          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
          }
        }
      }
      
      // 所有重试失败，发送到死信队列
      await this.publish(`${topic}-dlq`, {
        originalEvent: event,
        error: lastError.message,
        attempts: maxRetries
      });
    });
  }
}
```

#### 4.5.2 死信队列监控
```javascript
// scripts/monitor-dlq.js
const { Kafka } = require('kafkajs');

async function monitorDLQ() {
  const kafka = new Kafka({ brokers: ['localhost:9092'] });
  const admin = kafka.admin();
  
  await admin.connect();
  
  const topics = await admin.listTopics();
  const dlqTopics = topics.filter(t => t.endsWith('-dlq'));
  
  for (const topic of dlqTopics) {
    const offsets = await admin.fetchTopicOffsets(topic);
    const messageCount = offsets.reduce((sum, o) => sum + parseInt(o.high), 0);
    
    if (messageCount > 0) {
      logger.error({ topic, messageCount }, 'Dead letter queue has messages!');
      // 发送告警
    }
  }
  
  await admin.disconnect();
}

// 每 5 分钟检查一次
setInterval(monitorDLQ, 300000);
```

## 5. 验收标准（可测试）

- [ ] Kafka 集群已部署并运行正常（3 节点）
- [ ] EventBus 类已实现并集成到所有服务
- [ ] 捕捉场景已事件化：catch-service 不再直接调用 user/reward/social 服务
- [ ] 事件处理器正常工作：精灵添加、奖励发放、通知推送
- [ ] 捕捉接口延迟降低 ≥ 50%（不等待非核心服务）
- [ ] 事件重试机制正常：失败事件自动重试 3 次
- [ ] 死信队列正常：重试失败的事件进入 DLQ
- [ ] DLQ 监控脚本运行正常，有消息时触发告警
- [ ] 单元测试覆盖率 ≥ 80%（EventBus）
- [ ] 集成测试验证事件流正常
- [ ] 服务可独立部署：修改 reward-service 不影响 catch-service

## 6. 工作量估算

**XL (Extra Large)**

- Kafka 集群部署和配置：1 天
- EventBus 框架实现：1 天
- 核心场景事件化改造：2 天
- 事件处理器实现：1 天
- 重试和死信处理：1 天
- 测试和验证：1 天

**总计：7 天**

## 7. 优先级理由

**P1** 理由：

1. **架构关键改进**：事件驱动是微服务架构的核心模式，直接影响系统可扩展性
2. **性能提升显著**：异步化非核心流程可大幅降低延迟（预计 50%+）
3. **降低耦合**：服务解耦后可独立开发、测试、部署，提升团队效率
4. **容错能力**：单个服务故障不影响核心流程，系统更健壮
5. **为未来铺路**：事件驱动是 CQRS、Event Sourcing 的基础

这是架构层面的重要改进，应优先实施。
