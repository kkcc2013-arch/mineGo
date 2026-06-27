# REQ-00329: WebSocket 连接池与消息批处理性能优化

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00329 |
| 标题 | WebSocket 连接池与消息批处理性能优化 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gym-service、catch-service、gateway、backend/shared、game-client、infrastructure/k8s |
| 创建时间 | 2026-06-27 03:00 UTC |

## 需求描述

### 背景
当前 WebSocket 连接管理存在以下性能问题：
1. **连接管理效率低**：每个用户连接独立管理，缺乏连接池化机制
2. **消息发送频繁**：实时事件（捕捉、战斗、位置更新）逐条发送，网络开销大
3. **资源利用率不高**：高峰期连接数暴增导致服务器资源紧张
4. **缺乏背压控制**：消息堆积时缺乏流量控制，可能导致内存溢出

### 目标
实现 WebSocket 连接池化管理和消息批处理优化系统，提升并发能力和消息吞吐量：
- 连接复用率提升 50%+
- 消息吞吐量提升 3-5 倍
- 网络流量减少 40%+
- 支持背压控制和优雅降级

## 技术方案

### 1. WebSocket 连接池管理器

**文件：** `backend/shared/websocket/ConnectionPool.js`

```javascript
class WebSocketConnectionPool {
  constructor(options = {}) {
    this.maxConnectionsPerWorker = options.maxConnectionsPerWorker || 1000;
    this.connectionTimeout = options.connectionTimeout || 300000; // 5分钟
    this.heartbeatInterval = options.heartbeatInterval || 30000; // 30秒
    this.connections = new Map(); // userId -> Set<WebSocket>
    this.workerPools = new Map(); // workerId -> ConnectionPoolWorker
    this.loadBalancer = new ConnectionLoadBalancer();
  }

  /**
   * 注册新连接到连接池
   */
  registerConnection(ws, userId, metadata = {}) {
    // 1. 选择负载最低的 worker pool
    const workerPool = this.loadBalancer.selectWorkerPool(this.workerPools);
    
    // 2. 创建连接上下文
    const connectionContext = {
      ws,
      userId,
      workerPoolId: workerPool.id,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      metadata,
      messageQueue: [],
      isBatching: false
    };

    // 3. 添加到连接池
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId).add(connectionContext);
    workerPool.addConnection(connectionContext);

    // 4. 启动心跳检测
    this.startHeartbeat(connectionContext);

    // 5. 绑定事件处理
    this.bindConnectionEvents(connectionContext);

    return connectionContext;
  }

  /**
   * 获取用户的所有活跃连接
   */
  getUserConnections(userId) {
    return Array.from(this.connections.get(userId) || []);
  }

  /**
   * 批量向用户发送消息
   */
  async sendToUser(userId, messages, options = {}) {
    const connections = this.getUserConnections(userId);
    if (connections.length === 0) return;

    // 批处理优化
    const batch = this.createMessageBatch(messages, options);
    
    const sendPromises = connections.map(ctx => 
      this.sendBatch(ctx, batch)
    );

    await Promise.allSettled(sendPromises);
  }

  /**
   * 广播消息到频道
   */
  async broadcast(channel, message, options = {}) {
    const channelConnections = this.getChannelConnections(channel);
    
    // 按批次分片广播
    const batchSize = options.batchSize || 100;
    const batches = this.chunkArray(channelConnections, batchSize);

    for (const batch of batches) {
      await Promise.allSettled(
        batch.map(ctx => this.sendBatch(ctx, message))
      );
      
      // 批次间隔，避免网络拥塞
      if (options.throttleMs) {
        await this.sleep(options.throttleMs);
      }
    }
  }

  /**
   * 创建消息批次
   */
  createMessageBatch(messages, options = {}) {
    if (!Array.isArray(messages)) {
      messages = [messages];
    }

    return {
      id: this.generateBatchId(),
      messages,
      timestamp: Date.now(),
      compressed: options.compress || false,
      priority: options.priority || 'normal'
    };
  }

  /**
   * 发送批次消息
   */
  async sendBatch(ctx, batch) {
    // 检查连接状态
    if (ctx.ws.readyState !== WebSocket.OPEN) {
      this.handleDisconnectedConnection(ctx);
      return;
    }

    try {
      // 序列化消息
      let payload = JSON.stringify(batch);
      
      // 压缩大消息
      if (batch.compressed && payload.length > 1024) {
        payload = await this.compress(payload);
      }

      // 发送
      ctx.ws.send(payload);
      ctx.lastActivityAt = Date.now();

      // 更新指标
      this.metrics.recordMessageSent(batch.messages.length);

    } catch (error) {
      this.logger.error('Failed to send batch', {
        userId: ctx.userId,
        batchId: batch.id,
        error: error.message
      });
    }
  }

  /**
   * 心跳检测
   */
  startHeartbeat(ctx) {
    ctx.heartbeatTimer = setInterval(() => {
      if (Date.now() - ctx.lastActivityAt > this.connectionTimeout) {
        this.closeConnection(ctx, 'timeout');
        return;
      }

      if (ctx.ws.readyState === WebSocket.OPEN) {
        ctx.ws.ping();
      }
    }, this.heartbeatInterval);
  }

  /**
   * 清理断开连接
   */
  handleDisconnectedConnection(ctx) {
    clearInterval(ctx.heartbeatTimer);
    
    const userConnections = this.connections.get(ctx.userId);
    if (userConnections) {
      userConnections.delete(ctx);
      if (userConnections.size === 0) {
        this.connections.delete(ctx.userId);
      }
    }

    const workerPool = this.workerPools.get(ctx.workerPoolId);
    if (workerPool) {
      workerPool.removeConnection(ctx);
    }

    this.metrics.recordDisconnection(ctx.userId);
  }
}
```

### 2. 消息批处理队列

**文件：** `backend/shared/websocket/MessageBatchQueue.js`

```javascript
class MessageBatchQueue {
  constructor(options = {}) {
    this.maxBatchSize = options.maxBatchSize || 50; // 单批次最大消息数
    this.maxBatchDelay = options.maxBatchDelay || 100; // 最大批处理延迟(ms)
    this.maxQueueSize = options.maxQueueSize || 10000; // 队列最大容量
    this.enableBackpressure = options.enableBackpressure || true;
    
    this.queues = new Map(); // userId -> MessageQueue
    this.flushTimers = new Map(); // userId -> timer
  }

  /**
   * 添加消息到批处理队列
   */
  enqueue(userId, message, options = {}) {
    let queue = this.queues.get(userId);
    
    // 创建队列（如果不存在）
    if (!queue) {
      queue = this.createQueue(userId);
      this.queues.set(userId, queue);
    }

    // 背压控制
    if (this.enableBackpressure && queue.size >= this.maxQueueSize) {
      this.applyBackpressure(userId, queue);
      return { queued: false, reason: 'queue_full' };
    }

    // 添加消息
    queue.messages.push({
      ...message,
      enqueuedAt: Date.now(),
      priority: options.priority || 'normal'
    });

    queue.size++;

    // 触发批处理
    if (queue.size >= this.maxBatchSize) {
      this.flushQueue(userId);
    } else if (!this.flushTimers.has(userId)) {
      this.scheduleFlush(userId);
    }

    return { queued: true, queueSize: queue.size };
  }

  /**
   * 创建消息队列
   */
  createQueue(userId) {
    return {
      userId,
      messages: [],
      size: 0,
      createdAt: Date.now(),
      lastFlushAt: Date.now()
    };
  }

  /**
   * 调度队列刷新
   */
  scheduleFlush(userId) {
    const timer = setTimeout(() => {
      this.flushQueue(userId);
    }, this.maxBatchDelay);

    this.flushTimers.set(userId, timer);
  }

  /**
   * 刷新队列（批量发送）
   */
  async flushQueue(userId) {
    // 清除定时器
    const timer = this.flushTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(userId);
    }

    const queue = this.queues.get(userId);
    if (!queue || queue.size === 0) return;

    // 提取消息批次
    const batch = this.extractBatch(queue);

    // 发送到连接池
    await connectionPool.sendToUser(userId, batch.messages);

    // 更新队列状态
    queue.lastFlushAt = Date.now();

    // 移除空队列
    if (queue.size === 0) {
      this.queues.delete(userId);
    }

    // 记录指标
    this.metrics.recordBatchFlush(batch.messages.length);
  }

  /**
   * 提取批次消息
   */
  extractBatch(queue) {
    // 按优先级排序
    queue.messages.sort((a, b) => {
      const priorityOrder = { high: 0, normal: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

    // 提取最多 maxBatchSize 条消息
    const messages = queue.messages.splice(0, this.maxBatchSize);
    queue.size -= messages.length;

    return { messages };
  }

  /**
   * 应用背压控制
   */
  applyBackpressure(userId, queue) {
    // 1. 记录背压事件
    this.metrics.recordBackpressure(userId, queue.size);

    // 2. 降级策略：丢弃低优先级消息
    const droppedCount = this.dropLowPriorityMessages(queue);
    
    this.logger.warn('Backpressure applied', {
      userId,
      queueSize: queue.size,
      droppedCount
    });

    // 3. 发送背压通知
    connectionPool.sendToUser(userId, [{
      type: 'backpressure_warning',
      message: '消息发送过于频繁，部分消息已被丢弃',
      droppedCount
    }]);
  }

  /**
   * 丢弃低优先级消息
   */
  dropLowPriorityMessages(queue) {
    const initialSize = queue.size;
    
    queue.messages = queue.messages.filter(msg => msg.priority !== 'low');
    queue.size = queue.messages.length;
    
    return initialSize - queue.size;
  }
}
```

### 3. 连接负载均衡器

**文件：** `backend/shared/websocket/ConnectionLoadBalancer.js`

```javascript
class ConnectionLoadBalancer {
  constructor() {
    this.workerPools = new Map();
    this.loadMetrics = new Map();
  }

  /**
   * 注册 worker pool
   */
  registerWorkerPool(workerPool) {
    this.workerPools.set(workerPool.id, workerPool);
    this.loadMetrics.set(workerPool.id, {
      connectionCount: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      messageRate: 0
    });
  }

  /**
   * 选择负载最低的 worker pool
   */
  selectWorkerPool() {
    let selectedPool = null;
    let lowestLoad = Infinity;

    for (const [id, pool] of this.workerPools) {
      const metrics = this.loadMetrics.get(id);
      const load = this.calculateLoad(metrics);

      if (load < lowestLoad) {
        lowestLoad = load;
        selectedPool = pool;
      }
    }

    return selectedPool || this.workerPools.values().next().value;
  }

  /**
   * 计算负载分数
   */
  calculateLoad(metrics) {
    const weights = {
      connectionCount: 0.4,
      cpuUsage: 0.3,
      memoryUsage: 0.2,
      messageRate: 0.1
    };

    return (
      metrics.connectionCount * weights.connectionCount +
      metrics.cpuUsage * weights.cpuUsage +
      metrics.memoryUsage * weights.memoryUsage +
      metrics.messageRate * weights.messageRate
    );
  }

  /**
   * 更新负载指标
   */
  updateMetrics(workerId, metrics) {
    this.loadMetrics.set(workerId, {
      ...this.loadMetrics.get(workerId),
      ...metrics
    });
  }
}
```

### 4. 网关集成

**文件：** `gateway/src/websocket/WebSocketHandler.js`

```javascript
const connectionPool = new WebSocketConnectionPool({
  maxConnectionsPerWorker: 1000,
  connectionTimeout: 300000,
  heartbeatInterval: 30000
});

const messageQueue = new MessageBatchQueue({
  maxBatchSize: 50,
  maxBatchDelay: 100,
  maxQueueSize: 10000,
  enableBackpressure: true
});

/**
 * WebSocket 升级处理
 */
router.get('/ws', async (ctx) => {
  const userId = ctx.state.user.id;
  const metadata = {
    deviceId: ctx.headers['x-device-id'],
    platform: ctx.headers['x-platform'],
    version: ctx.headers['x-app-version']
  };

  // 注册连接
  const connectionCtx = connectionPool.registerConnection(
    ctx.websocket,
    userId,
    metadata
  );

  // 消息处理
  ctx.websocket.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleIncomingMessage(connectionCtx, message);
    } catch (error) {
      logger.error('Failed to parse WebSocket message', { error, userId });
    }
  });

  // 关闭处理
  ctx.websocket.on('close', () => {
    connectionPool.handleDisconnectedConnection(connectionCtx);
  });
});

/**
 * 处理传入消息
 */
function handleIncomingMessage(ctx, message) {
  switch (message.type) {
    case 'pong':
      ctx.lastActivityAt = Date.now();
      break;

    case 'location_update':
      // 位置更新：添加到批处理队列
      messageQueue.enqueue(ctx.userId, {
        type: 'location_update',
        data: message.data
      });
      break;

    case 'battle_action':
      // 战斗动作：高优先级，立即发送
      connectionPool.sendToUser(ctx.userId, [{
        type: 'battle_action',
        data: message.data
      }], { priority: 'high' });
      break;

    default:
      // 默认：添加到队列
      messageQueue.enqueue(ctx.userId, message);
  }
}
```

### 5. 游戏客户端集成

**文件：** `game-client/src/network/WebSocketManager.js`

```javascript
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.messageBuffer = [];
    this.flushInterval = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  /**
   * 连接 WebSocket
   */
  connect(token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_URL}/ws?token=${token}`);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.startBatchFlush();
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onclose = (event) => {
        this.handleDisconnect(event);
      };

      this.ws.onerror = (error) => {
        reject(error);
      };
    });
  }

  /**
   * 发送消息（支持批量）
   */
  send(message, options = {}) {
    // 高优先级消息立即发送
    if (options.priority === 'high') {
      this.ws.send(JSON.stringify(message));
      return;
    }

    // 添加到缓冲区
    this.messageBuffer.push(message);

    // 达到批量大小时立即刷新
    if (this.messageBuffer.length >= BATCH_SIZE) {
      this.flushBuffer();
    }
  }

  /**
   * 启动批量刷新
   */
  startBatchFlush() {
    this.flushInterval = setInterval(() => {
      if (this.messageBuffer.length > 0) {
        this.flushBuffer();
      }
    }, BATCH_DELAY);
  }

  /**
   * 刷新消息缓冲区
   */
  flushBuffer() {
    if (this.messageBuffer.length === 0) return;

    const batch = {
      id: this.generateBatchId(),
      messages: this.messageBuffer.splice(0),
      timestamp: Date.now()
    };

    this.ws.send(JSON.stringify(batch));
  }

  /**
   * 处理接收消息
   */
  handleMessage(data) {
    try {
      const batch = JSON.parse(data);

      // 批量处理消息
      if (batch.messages && Array.isArray(batch.messages)) {
        batch.messages.forEach(msg => {
          this.dispatchMessage(msg);
        });
      } else {
        // 单条消息
        this.dispatchMessage(batch);
      }
    } catch (error) {
      console.error('Failed to parse message', error);
    }
  }

  /**
   * 分发消息到处理器
   */
  dispatchMessage(message) {
    const handlers = {
      'catch_success': this.handleCatchSuccess,
      'battle_update': this.handleBattleUpdate,
      'location_update': this.handleLocationUpdate,
      'backpressure_warning': this.handleBackpressure
    };

    const handler = handlers[message.type];
    if (handler) {
      handler.call(this, message);
    }
  }

  /**
   * 处理背压警告
   */
  handleBackpressure(message) {
    console.warn('Server backpressure warning', message);
    
    // 降低发送频率
    this.adjustSendRate('decrease');
  }
}
```

### 6. Prometheus 指标

**文件：** `backend/shared/websocket/Metrics.js`

```javascript
const prometheus = require('prom-client');

const websocketMetrics = {
  // 连接数
  activeConnections: new prometheus.Gauge({
    name: 'websocket_active_connections',
    help: 'Number of active WebSocket connections',
    labelNames: ['service', 'worker_id']
  }),

  // 消息吞吐量
  messagesSent: new prometheus.Counter({
    name: 'websocket_messages_sent_total',
    help: 'Total number of messages sent',
    labelNames: ['service', 'message_type', 'batch']
  }),

  // 批处理效率
  batchSize: new prometheus.Histogram({
    name: 'websocket_batch_size',
    help: 'Distribution of message batch sizes',
    buckets: [1, 5, 10, 20, 50, 100]
  }),

  // 队列延迟
  queueDelay: new prometheus.Histogram({
    name: 'websocket_queue_delay_seconds',
    help: 'Time messages spend in queue before being sent',
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  }),

  // 背压事件
  backpressureEvents: new prometheus.Counter({
    name: 'websocket_backpressure_events_total',
    help: 'Total number of backpressure events',
    labelNames: ['service', 'user_id']
  }),

  // 连接池负载
  poolLoad: new prometheus.Gauge({
    name: 'websocket_pool_load',
    help: 'Load of WebSocket connection pools',
    labelNames: ['service', 'worker_id']
  })
};

module.exports = websocketMetrics;
```

## 验收标准

- [ ] WebSocket 连接池管理器实现完成，支持连接复用和负载均衡
- [ ] 消息批处理队列实现完成，支持优先级队列和背压控制
- [ ] 连接负载均衡器实现完成，支持多 worker pool 动态调度
- [ ] 网关集成完成，支持批量消息收发
- [ ] 游戏客户端集成完成，支持消息缓冲和批量发送
- [ ] Prometheus 指标暴露完成，监控连接数、吞吐量、批处理效率
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 性能测试验证：连接复用率提升 50%+
- [ ] 性能测试验证：消息吞吐量提升 3-5 倍
- [ ] 性能测试验证：网络流量减少 40%+
- [ ] 压力测试：支持 10000+ 并发连接
- [ ] 背压控制测试：队列满时优雅降级

## 影响范围

- **新建文件：**
  - `backend/shared/websocket/ConnectionPool.js`
  - `backend/shared/websocket/MessageBatchQueue.js`
  - `backend/shared/websocket/ConnectionLoadBalancer.js`
  - `backend/shared/websocket/Metrics.js`
  - `gateway/src/websocket/WebSocketHandler.js`
  - `game-client/src/network/WebSocketManager.js`
  - `backend/tests/unit/websocket/ConnectionPool.test.js`
  - `backend/tests/unit/websocket/MessageBatchQueue.test.js`
  - `backend/tests/load/websocket-benchmark.js`

- **修改文件：**
  - `gateway/src/index.js`（集成 WebSocket 处理器）
  - `infrastructure/k8s/base/deployment.yaml`（调整资源限制）
  - `backend/shared/index.js`（导出新模块）

## 参考

- [WebSocket RFC 6455](https://tools.ietf.org/html/rfc6455)
- [Node.js WebSocket Performance Best Practices](https://nodejs.org/en/docs/guides/websocket-performance/)
- [Backpressure in Reactive Streams](https://www.reactive-streams.org/)
- [Prometheus Metrics for WebSocket](https://prometheus.io/docs/practices/naming/)
