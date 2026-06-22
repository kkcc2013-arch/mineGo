# REQ-00290：WebSocket 连接池与消息批处理性能优化

- **编号**：REQ-00290
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gym-service、social-service、backend/shared/websocket
- **创建时间**：2026-06-22 10:00 UTC
- **依赖需求**：REQ-00262（实时战斗 WebSocket 系统）

## 1. 背景与问题

### 1.1 当前现状

mineGo 项目在以下场景使用 WebSocket 实时通信：
- **gym-service**：道馆战斗、Raids 实时同步
- **social-service**：语音聊天信令服务
- **NotificationManager**：WebSocket 推送插件

当前实现位于 `gym-service/src/websocket/`：
- `WebSocketServer.js`：WebSocket 服务器
- `BattleRoomManager.js`：战斗房间管理
- `HeartbeatManager.js`：心跳管理

### 1.2 存在的问题

1. **连接管理分散**：每个服务独立管理 WebSocket 连接，无统一连接池
   - 无法复用连接
   - 缺少连接状态集中监控
   - 不同服务连接策略不一致

2. **消息发送效率低**：
   - 每条消息独立发送，无批量处理
   - 高频战斗场景每秒数百条消息
   - 网络往返延迟累积

3. **内存占用高**：
   - 每个连接独立缓冲区
   - 无消息压缩优化
   - 历史消息未及时清理

4. **心跳开销大**：
   - 每个连接独立心跳（1秒间隔）
   - 大规模战斗时心跳包占用带宽
   - 服务器 CPU 开销高

### 1.3 性能影响分析

| 场景 | 当前延迟 | 连接数 | 消息吞吐量 | 优化目标 |
|------|---------|--------|-----------|---------|
| 10 人 Raid 战斗 | 50-100ms | 10 | 200 msg/s | 20-30ms |
| 50 人道馆战 | 100-200ms | 50 | 1000 msg/s | 40-50ms |
| 语音信令 | 30-80ms | 20 | 500 msg/s | 15-25ms |
| 全服推送 | 200-500ms | 1000+ | 10000 msg/s | 100-150ms |

## 2. 目标

1. **建立统一 WebSocket 连接池**：集中管理所有 WebSocket 连接
2. **实现消息批处理**：10ms 窗口内消息合并发送，减少网络往返
3. **降低延迟 40-60%**：通过批处理和连接复用
4. **减少内存占用 30%**：共享缓冲区和消息压缩
5. **统一心跳优化**：批量心跳检测，减少 CPU 和带宽开销

## 3. 范围

### 包含
- `backend/shared/websocket/ConnectionPool.js`：统一连接池管理器
- `backend/shared/websocket/MessageBatcher.js`：消息批处理器
- `backend/shared/websocket/HeartbeatOptimizer.js`：心跳优化器
- `backend/shared/websocket/CompressionMiddleware.js`：消息压缩中间件
- gym-service 集成改造
- social-service 集成改造
- Prometheus 性能指标
- 单元测试与压力测试

### 不包含
- WebSocket 协议修改
- 客户端改造（需单独需求）
- TURN 服务器优化（已在其他需求处理）

## 4. 详细需求

### 4.1 WebSocket 连接池管理器

**核心设计**：
```javascript
// backend/shared/websocket/ConnectionPool.js
class WebSocketConnectionPool {
  constructor(options = {}) {
    this.connections = new Map(); // userId -> Set<WebSocket>
    this.roomConnections = new Map(); // roomId -> Set<userId>
    this.config = {
      maxConnectionsPerUser: 5,
      maxConnectionsPerRoom: 100,
      heartbeatInterval: 30000, // 30秒（优化后）
      messageBatchWindow: 10, // 10ms 批处理窗口
      ...options
    };
  }

  // 注册连接
  register(userId, ws, metadata = {}) {
    // 检查连接数限制
    // 添加到用户连接集合
    // 发送欢迎消息
  }

  // 批量广播到房间
  broadcastToRoom(roomId, message, excludeUsers = []) {
    // 获取房间所有连接
    // 使用 MessageBatcher 批量发送
  }

  // 获取连接统计
  getStats() {
    return {
      totalConnections: this.connections.size,
      rooms: this.roomConnections.size,
      avgConnectionsPerUser: /* ... */
    };
  }
}
```

**功能要求**：
- 支持按用户、房间分组管理连接
- 连接数限制与过载保护
- 连接状态监控（活跃/空闲/断开）
- 自动重连支持
- 连接生命周期事件

### 4.2 消息批处理器

```javascript
// backend/shared/websocket/MessageBatcher.js
class MessageBatcher {
  constructor(pool, options = {}) {
    this.pool = pool;
    this.batchWindow = options.batchWindow || 10; // 10ms
    this.maxBatchSize = options.maxBatchSize || 100;
    this.pendingMessages = new Map(); // userId -> Message[]
    this.flushTimer = null;
  }

  // 添加消息到批处理队列
  addMessage(userId, message) {
    if (!this.pendingMessages.has(userId)) {
      this.pendingMessages.set(userId, []);
    }
    const batch = this.pendingMessages.get(userId);
    batch.push(message);
    
    // 立即刷新条件
    if (batch.length >= this.maxBatchSize) {
      this.flushUser(userId);
    }
  }

  // 批量发送
  flushUser(userId) {
    const messages = this.pendingMessages.get(userId);
    if (!messages || messages.length === 0) return;
    
    const batchMessage = {
      type: 'batch',
      timestamp: Date.now(),
      messages: messages
    };
    
    const ws = this.pool.getConnection(userId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(batchMessage));
    }
    
    this.pendingMessages.set(userId, []);
  }

  // 定时刷新所有待发送消息
  startFlushLoop() {
    this.flushTimer = setInterval(() => {
      for (const userId of this.pendingMessages.keys()) {
        this.flushUser(userId);
      }
    }, this.batchWindow);
  }
}
```

**性能指标**：
- 批处理窗口：10ms（可配置）
- 单批次最大消息数：100
- 延迟降低：40-60%
- 吞吐量提升：200-300%

### 4.3 心跳优化器

```javascript
// backend/shared/websocket/HeartbeatOptimizer.js
class HeartbeatOptimizer {
  constructor(pool) {
    this.pool = pool;
    this.heartbeatGroups = new Map(); // 按时间槽分组
    this.slotCount = 10; // 将心跳分散到 10 个时间槽
    this.slotInterval = 3000; // 每 3 秒检查一个槽
  }

  // 注册时分配到时间槽
  assignSlot(userId) {
    const slot = userId.hashCode() % this.slotCount;
    if (!this.heartbeatGroups.has(slot)) {
      this.heartbeatGroups.set(slot, new Set());
    }
    this.heartbeatGroups.get(slot).add(userId);
    return slot;
  }

  // 分批次发送心跳
  startStaggeredHeartbeat() {
    let currentSlot = 0;
    setInterval(() => {
      this.checkSlot(currentSlot);
      currentSlot = (currentSlot + 1) % this.slotCount;
    }, this.slotInterval);
  }

  checkSlot(slot) {
    const users = this.heartbeatGroups.get(slot);
    if (!users) return;
    
    // 批量发送心跳
    const pingMessage = JSON.stringify({ type: 'ping', ts: Date.now() });
    for (const userId of users) {
      const ws = this.pool.getConnection(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(pingMessage);
      }
    }
  }
}
```

**优化效果**：
- 心跳峰值带宽降低 90%
- 服务器 CPU 开销降低 80%
- 连接超时检测时间：30 秒（原 1 秒独立心跳）

### 4.4 消息压缩中间件

```javascript
// backend/shared/websocket/CompressionMiddleware.js
class CompressionMiddleware {
  constructor(options = {}) {
    this.threshold = options.threshold || 256; // 256 字节以上压缩
    this.level = options.level || 6; // 压缩级别
  }

  async compress(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    if (data.length < this.threshold) {
      return { compressed: false, data };
    }
    
    const compressed = await zlib.deflateSync(Buffer.from(data));
    return {
      compressed: true,
      data: compressed.toString('base64'),
      originalSize: data.length,
      compressedSize: compressed.length
    };
  }

  async decompress(data) {
    if (!data.compressed) {
      return data.data;
    }
    const buffer = Buffer.from(data.data, 'base64');
    const decompressed = await zlib.inflateSync(buffer);
    return decompressed.toString();
  }
}
```

### 4.5 Prometheus 指标

```javascript
// 新增指标
const wsMetrics = {
  // 连接指标
  ws_connections_total: new Gauge({
    name: 'websocket_connections_total',
    help: 'Total active WebSocket connections'
  }),
  ws_connections_per_user: new Histogram({
    name: 'websocket_connections_per_user',
    help: 'Connections per user distribution',
    buckets: [1, 2, 3, 5, 10]
  }),
  
  // 消息指标
  ws_messages_sent_total: new Counter({
    name: 'websocket_messages_sent_total',
    help: 'Total messages sent',
    labelNames: ['type', 'room']
  }),
  ws_message_batch_size: new Histogram({
    name: 'websocket_message_batch_size',
    help: 'Message batch size distribution',
    buckets: [1, 5, 10, 20, 50, 100]
  }),
  
  // 性能指标
  ws_message_latency_ms: new Histogram({
    name: 'websocket_message_latency_ms',
    help: 'Message delivery latency',
    buckets: [5, 10, 20, 50, 100, 200]
  }),
  ws_bytes_sent: new Counter({
    name: 'websocket_bytes_sent',
    help: 'Total bytes sent',
    labelNames: ['compressed', 'room']
  }),
  
  // 心跳指标
  ws_heartbeat_latency_ms: new Histogram({
    name: 'websocket_heartbeat_latency_ms',
    help: 'Heartbeat response latency',
    buckets: [10, 50, 100, 200, 500, 1000]
  })
};
```

### 4.6 管理接口

```javascript
// 新增管理路由
// GET /admin/websocket/stats
// 获取连接池统计信息

// GET /admin/websocket/rooms/:roomId
// 获取房间连接详情

// POST /admin/websocket/broadcast
// 全服广播消息（管理用）

// DELETE /admin/websocket/connections/:connectionId
// 强制断开指定连接
```

## 5. 验收标准（可测试）

- [ ] 实现统一 WebSocket 连接池管理器，支持 10000+ 并发连接
- [ ] 实现消息批处理器，10ms 窗口内消息合并率 ≥ 80%
- [ ] 实现心跳优化器，心跳峰值 CPU 降低 ≥ 70%
- [ ] 实现消息压缩中间件，大消息压缩率 ≥ 50%
- [ ] gym-service 完成集成，战斗延迟降低 ≥ 40%（P95）
- [ ] social-service 完成集成，语音信令延迟降低 ≥ 30%（P95）
- [ ] 新增 15+ Prometheus 指标，覆盖连接、消息、性能维度
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 压力测试：支持 500 并发连接、5000 msg/s 吞吐量
- [ ] 管理接口可用，支持连接状态查询和强制断开

## 6. 工作量估算

**L（Large）**

**理由**：
- 需要实现 4 个核心组件
- 涉及 gym-service 和 social-service 两个微服务改造
- 需要完整的性能测试和优化
- 预计工作量：5-8 人天

## 7. 优先级理由

**P1 理由**：
1. **性能关键**：实时战斗体验直接影响用户留存
2. **可扩展性瓶颈**：当前架构难以支撑大规模并发
3. **基础设施**：为后续语音聊天、直播等功能奠定基础
4. **成本优化**：降低 CPU 和带宽消耗，减少服务器成本
5. **依赖关系**：REQ-00262 已实现基础 WebSocket 系统，本需求进行性能优化

---

## 附录：实施计划

### Phase 1：核心组件开发（2-3 天）
1. 实现 ConnectionPool 连接池管理器
2. 实现 MessageBatcher 消息批处理器
3. 实现 HeartbeatOptimizer 心跳优化器
4. 实现 CompressionMiddleware 压缩中间件
5. 编写单元测试

### Phase 2：服务集成（2-3 天）
1. gym-service 集成改造
2. social-service 集成改造
3. Prometheus 指标集成
4. 管理接口开发

### Phase 3：测试与优化（1-2 天）
1. 编写压力测试脚本
2. 性能基准测试
3. 瓶颈分析与优化
4. 文档编写
