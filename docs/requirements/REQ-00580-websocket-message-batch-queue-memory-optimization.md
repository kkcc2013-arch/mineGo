# REQ-00580：WebSocket 消息批处理队列内存优化

- **编号**：REQ-00580
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/websocket/MessageBatchQueue.js, WebSocketConnectionPool.js, gateway, gym-service, catch-service
- **创建时间**：2026-07-16 19:00
- **依赖需求**：REQ-00329（WebSocket连接池）、REQ-00577（堆内存管理）

## 1. 背景与问题

### 当前痛点

mineGo 的 WebSocket 连接池管理器（`backend/shared/websocket/ConnectionPool.js`）已实现消息批处理机制，但在高并发场景下仍存在内存优化空间：

1. **消息队列内存碎片化**
   - 每个连接上下文创建独立 `messageQueue: []` 数组
   - 高峰期每 worker 承载 1000 个连接，产生 1000 个独立队列对象
   - 数组动态扩容导致频繁内存分配，触发 Young Generation GC

2. **批次对象频繁创建**
   - `createMessageBatch()` 每次创建新批次对象，无对象池复用
   - 批次 ID 使用 `Math.random()` 生成，缺乏预分配机制
   - 压缩缓冲区临时分配，增加 GC 压力

3. **背压控制不够精细**
   - 当前仅在连接层面检查状态，未实现队列容量限制
   - 消息堆积时可能导致 Node.js 堆内存耗尽
   - 缺乏基于内存使用率的动态批次大小调整

### 代码证据

```javascript
// backend/shared/websocket/ConnectionPool.js:38-47
const connectionContext = {
  id: connectionId,
  // ...
  messageQueue: [],  // 每连接独立数组
  isBatching: false,
  // ...
};

// backend/shared/websocket/ConnectionPool.js:237-247
createMessageBatch(messages, options = {}) {
  return {
    id: this.generateBatchId(),  // 每次生成新 ID
    messages,
    timestamp: Date.now(),
    compressed: options.compress || false,
    priority: options.priority || 'normal'
  };
}
```

## 2. 目标

1. **降低内存分配频率**：通过共享队列池和对象复用，减少 40% 的队列相关内存分配
2. **优化背压控制**：实现基于内存使用率的动态批次大小调整，防止 OOM
3. **减少 GC 停顿**：将 WebSocket 相关 GC 停顿从平均 30ms 降至 < 10ms
4. **提升吞吐量**：在同等内存预算下，提升 20% 的消息处理吞吐量

## 3. 范围

### 包含

- **共享消息队列池**：实现 `SharedMessageQueuePool`，为多连接提供共享队列缓冲区
- **批次对象池**：为 `MessageBatch` 对象实现对象池复用
- **内存感知批处理**：根据当前堆内存使用动态调整批次大小和发送频率
- **背压阈值控制**：当队列大小超过阈值时触发背压事件，拒绝新消息入队
- **Prometheus 指标增强**：添加队列内存使用、批次复用率等指标

### 不包含

- WebSocket 连接池负载均衡（已由 REQ-00329 实现）
- 前端消息队列优化（属于 game-client）
- Redis 发布订阅优化（已由其他需求覆盖）

## 4. 详细需求

### 4.1 共享消息队列池（SharedMessageQueuePool）

```javascript
// backend/shared/websocket/SharedMessageQueuePool.js
class SharedMessageQueuePool {
  constructor(options = {}) {
    this.poolSize = options.poolSize || 100;  // 预分配队列数量
    this.maxQueueLength = options.maxQueueLength || 100;
    this.queues = new Array(this.poolSize);
    this.freeList = [];
    
    // 预分配队列缓冲区
    for (let i = 0; i < this.poolSize; i++) {
      this.queues[i] = new Array(this.maxQueueLength);
      this.freeList.push(i);
    }
  }
  
  acquire() {
    if (this.freeList.length === 0) return null;
    return { queueId: this.freeList.pop(), queue: this.queues[queueId] };
  }
  
  release(queueId) {
    this.freeList.push(queueId);
  }
}
```

### 4.2 批次对象池（BatchObjectPool）

```javascript
// backend/shared/websocket/BatchObjectPool.js
class BatchObjectPool {
  constructor() {
    this.pool = [];
    this.maxSize = 100;
  }
  
  acquire() {
    const batch = this.pool.pop() || this.createBatch();
    batch.timestamp = Date.now();
    return batch;
  }
  
  release(batch) {
    batch.messages.length = 0;
    batch.compressed = false;
    batch.priority = 'normal';
    if (this.pool.length < this.maxSize) {
      this.pool.push(batch);
    }
  }
  
  createBatch() {
    return {
      id: null,  // 使用预分配 ID
      messages: [],
      timestamp: 0,
      compressed: false,
      priority: 'normal'
    };
  }
}
```

### 4.3 内存感知批处理策略

```javascript
// backend/shared/websocket/MemoryAwareBatchStrategy.js
class MemoryAwareBatchStrategy {
  constructor() {
    this.heapThreshold = 0.75;  // 堆使用阈值
    this.minBatchSize = 10;
    this.maxBatchSize = 50;
  }
  
  determineBatchSize() {
    const heapStats = v8.getHeapStatistics();
    const heapUsage = heapStats.used_heap_size / heapStats.heap_size_limit;
    
    if (heapUsage > this.heapThreshold) {
      // 内存紧张时减小批次大小，加快释放
      return Math.max(5, Math.floor(this.maxBatchSize * (1 - heapUsage)));
    }
    
    // 正常情况下使用最大批次
    return this.maxBatchSize;
  }
  
  shouldTriggerFlush() {
    const heapStats = v8.getHeapStatistics();
    return heapStats.used_heap_size / heapStats.heap_size_limit > 0.85;
  }
}
```

### 4.4 背压阈值控制

```javascript
// backend/shared/websocket/BackpressureController.js
class BackpressureController {
  constructor(options = {}) {
    this.maxQueueMemoryBytes = options.maxQueueMemoryBytes || 50 * 1024 * 1024;  // 50MB
    this.currentQueueMemory = 0;
  }
  
  canEnqueue(messageSize) {
    return this.currentQueueMemory + messageSize < this.maxQueueMemoryBytes;
  }
  
  recordEnqueue(messageSize) {
    this.currentQueueMemory += messageSize;
  }
  
  recordDequeue(messageSize) {
    this.currentQueueMemory = Math.max(0, this.currentQueueMemory - messageSize);
  }
  
  getBackpressureStatus() {
    return {
      currentMemory: this.currentQueueMemory,
      maxMemory: this.maxQueueMemoryBytes,
      utilizationRatio: this.currentQueueMemory / this.maxQueueMemoryBytes,
      shouldReject: this.currentQueueMemory > this.maxQueueMemoryBytes * 0.9
    };
  }
}
```

### 4.5 Prometheus 指标增强

```javascript
// 新增指标
websocketMetrics.queueMemoryBytes = new Gauge({
  name: 'websocket_queue_memory_bytes',
  help: 'Current memory usage of WebSocket message queues',
  labelNames: ['service']
});

websocketMetrics.batchPoolSize = new Gauge({
  name: 'websocket_batch_pool_size',
  help: 'Size of batch object pool'
});

websocketMetrics.batchReuseRatio = new new Gauge({
  name: 'websocket_batch_reuse_ratio',
  help: 'Ratio of reused batches vs new allocations'
});

websocketMetrics.backpressureEvents = new Counter({
  name: 'websocket_backpressure_events_total',
  help: 'Number of backpressure events triggered',
  labelNames: ['service', 'action']
});
```

## 5. 验收标准（可测试）

- [ ] 实现 `SharedMessageQueuePool` 后，1000 连接场景下队列内存占用减少 30%
- [ ] 批次对象池复用率达到 80% 以上（通过 Prometheus 指标验证）
- [ ] 内存感知批处理策略在堆使用 > 75% 时自动降低批次大小
- [ ] 背压控制在队列内存超过阈值时触发拒绝，防止 OOM
- [ ] WebSocket 相关 GC 停顿平均值 < 10ms（通过 `nodejs_gc_duration_ms` 验证）
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 压测验证：在同等内存预算下消息吞吐量提升 20%

## 6. 工作量估算

**规模**：M（中等）

**理由**：
- 共享队列池设计与实现：2 天
- 批次对象池集成：1 天
- 内存感知策略 + 背压控制：2 天
- Prometheus 指标 + 测试：1 天
- 文档与压测验证：1 天

**总计**：7 人天

## 7. 优先级理由

**P1（高优先级）**

1. **直接影响实时性**：WebSocket 消息批处理是实时战斗体验的关键路径
2. **内存稳定性**：防止高峰期队列内存暴涨导致 OOM，影响生产稳定性
3. **技术栈统一**：与 REQ-00577（堆内存管理）和 REQ-00552（连接池优化）形成完整的 WebSocket 性能优化体系
4. **横向受益**：优化后 gateway、gym-service、catch-service 均可复用共享队列池

与项目"生产可用"目标直接相关，属于关键性能基础设施。