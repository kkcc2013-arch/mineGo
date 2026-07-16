# REQ-00552：WebSocket 连接池自适应伸缩与资源优化系统

- **编号**：REQ-00552
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/websocket、gateway、infrastructure/monitoring、backend/jobs
- **创建时间**：2026-07-16 15:00
- **依赖需求**：REQ-00511（WebSocket连接池管理，已完成）

## 1. 背景与问题

mineGo 已实现 WebSocket 连接池管理（REQ-00511），支持消息批处理和连接状态跟踪。但在高并发场景下，仍存在以下性能问题：

### 1.1 当前问题

1. **连接池大小固定**：
   - 当前 maxConnections 固定为 10000，无法根据系统负载动态调整
   - 低峰期资源浪费，高峰期可能拒绝连接

```javascript
// 当前配置 - 固定值
this.config = {
  maxConnections: options.maxConnections || 10000,
  maxConnectionsPerUser: 5
};
```

2. **内存使用不优**：
   - 每个连接创建独立的 ConnectionInfo 对象，内存开销大
   - 无对象池复用机制，GC 压力高

3. **CPU 资源调度缺失**：
   - 心跳检测、消息发送在单个定时器中串行执行
   - 无优先级调度，高负载时延迟增加

4. **带宽利用不充分**：
   - 消息聚合粒度固定，未考虑网络状况
   - 缺少带宽自适应的消息队列管理

### 1.2 影响范围

- 高峰期（20:00-22:00）：连接拒绝率 5%-10%
- 低峰期：连接池利用率仅 20%-30%
- 内存占用：每 1000 连接约 50MB

## 2. 目标

1. **自适应连接池伸缩**：根据负载动态调整最大连接数，提升资源利用率 30%
2. **内存优化**：连接对象池化，减少 40% 内存占用
3. **CPU 调度优化**：优先级任务调度，降低 50% 高负载延迟
4. **带宽自适应**：动态调整消息聚合策略，提升 20% 带宽效率

## 3. 范围

### 包含
- 自适应连接池伸缩算法
- 连接对象池（Object Pool）
- 优先级任务调度器
- 带宽自适应消息队列
- 资源使用监控与告警
- Prometheus 指标集成

### 不包含
- WebSocket 消息内容优化（已有）
- 连接认证机制（已有）
- 分布式连接状态存储（已有）

## 4. 详细需求

### 4.1 自适应连接池伸缩

```javascript
// backend/shared/websocket/AdaptiveConnectionPool.js

'use strict';

const { logger, metrics } = require('../index');

/**
 * 自适应连接池伸缩控制器
 */
class AdaptiveConnectionPool {
  constructor(options = {}) {
    this.config = {
      // 基础配置
      minConnections: options.minConnections || 1000,
      maxConnections: options.maxConnections || 20000,
      initialMaxConnections: options.initialMaxConnections || 5000,
      
      // 伸缩参数
      scaleUpThreshold: options.scaleUpThreshold || 0.8, // 利用率 > 80% 扩容
      scaleDownThreshold: options.scaleDownThreshold || 0.3, // 利用率 < 30% 缩容
      scaleUpStep: options.scaleUpStep || 1000, // 每次扩容步长
      scaleDownStep: options.scaleDownStep || 500, // 每次缩容步长
      scaleCooldown: options.scaleCooldown || 300000, // 伸缩冷却时间（5分钟）
      
      // 资源限制
      maxMemoryUsage: options.maxMemoryUsage || 0.8, // 最大内存使用率
      maxCpuUsage: options.maxCpuUsage || 0.7, // 最大CPU使用率
      
      // 监控周期
      monitorInterval: options.monitorInterval || 60000 // 1分钟
    };
    
    // 当前状态
    this.state = {
      currentMax: this.config.initialMaxConnections,
      currentConnections: 0,
      utilization: 0,
      lastScaleTime: 0,
      lastScaleDirection: null,
      scaleHistory: [],
      resourcePressure: 0 // 0-100 资源压力指数
    };
    
    // 资源监控
    this.resourceMonitor = {
      memoryUsage: 0,
      cpuUsage: 0,
      networkBandwidth: 0
    };
    
    this._startMonitoring();
    this._setupMetrics();
    
    logger.info('Adaptive connection pool initialized', {
      min: this.config.minConnections,
      max: this.config.maxConnections,
      initial: this.state.currentMax
    });
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      poolMaxConnections: metrics.gauge('ws_adaptive_pool_max', 'Current max connections limit'),
      poolUtilization: metrics.gauge('ws_adaptive_pool_utilization', 'Pool utilization ratio'),
      scaleEvents: metrics.counter('ws_adaptive_scale_events_total', 'Scale events', ['direction']),
      resourcePressure: metrics.gauge('ws_adaptive_resource_pressure', 'Resource pressure index (0-100)'),
      memoryUsage: metrics.gauge('ws_adaptive_memory_usage', 'System memory usage ratio'),
      cpuUsage: metrics.gauge('ws_adaptive_cpu_usage', 'System CPU usage ratio')
    };
  }

  /**
   * 启动资源监控
   */
  _startMonitoring() {
    this._monitorTask = setInterval(() => {
      this._monitorResources();
      this._evaluateScaling();
    }, this.config.monitorInterval);
  }

  /**
   * 监控系统资源
   */
  _monitorResources() {
    const memUsage = process.memoryUsage();
    const totalMemory = require('os').totalmem();
    const freeMemory = require('os').freemem();
    
    // 计算内存使用率
    this.resourceMonitor.memoryUsage = memUsage.heapUsed / totalMemory;
    
    // 计算 CPU 使用率（简化）
    const cpuUsage = process.cpuUsage();
    this.resourceMonitor.cpuUsage = (cpuUsage.user + cpuUsage.system) / 1000000 / this.config.monitorInterval;
    
    // 计算资源压力指数
    this.state.resourcePressure = Math.min(100,
      this.resourceMonitor.memoryUsage * 50 +
      this.resourceMonitor.cpuUsage * 50
    );
    
    // 更新指标
    this.metrics.memoryUsage.set(this.resourceMonitor.memoryUsage);
    this.metrics.cpuUsage.set(this.resourceMonitor.cpuUsage);
    this.metrics.resourcePressure.set(this.state.resourcePressure);
  }

  /**
   * 评估是否需要伸缩
   */
  _evaluateScaling() {
    const { currentConnections, currentMax, lastScaleTime } = this.state;
    const now = Date.now();
    
    // 冷却期内不执行伸缩
    if (now - lastScaleTime < this.config.scaleCooldown) {
      return;
    }
    
    // 计算利用率
    const utilization = currentConnections / currentMax;
    this.state.utilization = utilization;
    
    // 更新指标
    this.metrics.poolUtilization.set(utilization);
    this.metrics.poolMaxConnections.set(currentMax);
    
    // 资源压力过大时，暂停扩容
    if (this.state.resourcePressure > 80) {
      logger.warn('Resource pressure high, scaling paused', {
        pressure: this.state.resourcePressure,
        utilization
      });
      return;
    }
    
    // 扩容判断
    if (utilization > this.config.scaleUpThreshold && currentMax < this.config.maxConnections) {
      this._scaleUp();
    }
    // 缩容判断
    else if (utilization < this.config.scaleDownThreshold && currentMax > this.config.minConnections) {
      this._scaleDown();
    }
  }

  /**
   * 扩容连接池
   */
  _scaleUp() {
    const oldMax = this.state.currentMax;
    const newMax = Math.min(
      this.config.maxConnections,
      oldMax + this.config.scaleUpStep
    );
    
    this.state.currentMax = newMax;
    this.state.lastScaleTime = Date.now();
    this.state.lastScaleDirection = 'up';
    
    this._recordScaleEvent('up', oldMax, newMax);
    
    logger.info('Connection pool scaled up', {
      from: oldMax,
      to: newMax,
      utilization: this.state.utilization
    });
    
    this.metrics.scaleEvents.inc({ direction: 'up' });
    this.metrics.poolMaxConnections.set(newMax);
  }

  /**
   * 缩容连接池
   */
  _scaleDown() {
    const oldMax = this.state.currentMax;
    const newMax = Math.max(
      this.config.minConnections,
      oldMax - this.config.scaleDownStep
    );
    
    this.state.currentMax = newMax;
    this.state.lastScaleTime = Date.now();
    this.state.lastScaleDirection = 'down';
    
    this._recordScaleEvent('down', oldMax, newMax);
    
    logger.info('Connection pool scaled down', {
      from: oldMax,
      to: newMax,
      utilization: this.state.utilization
    });
    
    this.metrics.scaleEvents.inc({ direction: 'down' });
    this.metrics.poolMaxConnections.set(newMax);
  }

  /**
   * 记录伸缩事件
   */
  _recordScaleEvent(direction, from, to) {
    this.state.scaleHistory.push({
      direction,
      from,
      to,
      utilization: this.state.utilization,
      resourcePressure: this.state.resourcePressure,
      timestamp: Date.now()
    });
    
    // 保留最近100条记录
    if (this.state.scaleHistory.length > 100) {
      this.state.scaleHistory.shift();
    }
  }

  /**
   * 更新当前连接数
   */
  updateCurrentConnections(count) {
    this.state.currentConnections = count;
  }

  /**
   * 检查是否允许新连接
   */
  canAcceptConnection() {
    return this.state.currentConnections < this.state.currentMax;
  }

  /**
   * 获取当前最大连接数
   */
  getCurrentMax() {
    return this.state.currentMax;
  }

  /**
   * 获取状态信息
   */
  getStatus() {
    return {
      ...this.state,
      resourceMonitor: this.resourceMonitor,
      config: this.config
    };
  }

  /**
   * 关闭控制器
   */
  close() {
    if (this._monitorTask) {
      clearInterval(this._monitorTask);
    }
    logger.info('Adaptive connection pool closed');
  }
}

module.exports = AdaptiveConnectionPool;
```

### 4.2 连接对象池

```javascript
// backend/shared/websocket/ConnectionObjectPool.js

'use strict';

const { logger, metrics } = require('../index');

/**
 * 连接对象池 - 复用 ConnectionInfo 对象
 */
class ConnectionObjectPool {
  constructor(options = {}) {
    this.config = {
      initialSize: options.initialSize || 100,
      maxSize: options.maxSize || 10000,
      growthFactor: options.growthFactor || 2,
      shrinkThreshold: options.shrinkThreshold || 0.2,
      cleanupInterval: options.cleanupInterval || 300000 // 5分钟
    };
    
    // 对象池
    this.pool = [];
    this.inUse = new Set();
    
    // 统计
    this.stats = {
      created: 0,
      reused: 0,
      returned: 0,
      dropped: 0,
      peakUsage: 0
    };
    
    // 初始化对象池
    this._initializePool();
    this._startCleanup();
    this._setupMetrics();
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      poolSize: metrics.gauge('ws_objpool_size', 'Object pool total size'),
      poolInUse: metrics.gauge('ws_objpool_in_use', 'Objects in use'),
      objectsCreated: metrics.counter('ws_objpool_created_total', 'Objects created'),
      objectsReused: metrics.counter('ws_objpool_reused_total', 'Objects reused')
    };
  }

  /**
   * 初始化对象池
   */
  _initializePool() {
    for (let i = 0; i < this.config.initialSize; i++) {
      this.pool.push(this._createObject());
      this.stats.created++;
    }
    
    logger.info('Connection object pool initialized', { size: this.pool.length });
  }

  /**
   * 创建新的连接对象
   */
  _createObject() {
    return {
      connectionId: null,
      ws: null,
      userId: null,
      deviceId: null,
      metadata: {},
      connectedAt: null,
      lastActivityAt: null,
      lastHeartbeatAt: null,
      bytesReceived: 0,
      bytesSent: 0,
      messagesReceived: 0,
      messagesSent: 0,
      state: 'idle'
    };
  }

  /**
   * 重置连接对象
   */
  _resetObject(obj) {
    obj.connectionId = null;
    obj.ws = null;
    obj.userId = null;
    obj.deviceId = null;
    obj.metadata = {};
    obj.connectedAt = null;
    obj.lastActivityAt = null;
    obj.lastHeartbeatAt = null;
    obj.bytesReceived = 0;
    obj.bytesSent = 0;
    obj.messagesReceived = 0;
    obj.messagesSent = 0;
    obj.state = 'idle';
    return obj;
  }

  /**
   * 获取连接对象
   */
  acquire() {
    let obj;
    
    if (this.pool.length > 0) {
      obj = this.pool.pop();
      this.stats.reused++;
      this.metrics.objectsReused.inc();
    } else {
      // 池为空，创建新对象
      obj = this._createObject();
      this.stats.created++;
      this.metrics.objectsCreated.inc();
    }
    
    this.inUse.add(obj);
    obj.state = 'active';
    
    // 更新峰值使用量
    if (this.inUse.size > this.stats.peakUsage) {
      this.stats.peakUsage = this.inUse.size;
    }
    
    this._updateMetrics();
    
    return obj;
  }

  /**
   * 归还连接对象
   */
  release(obj) {
    if (!this.inUse.has(obj)) {
      return;
    }
    
    this.inUse.delete(obj);
    this._resetObject(obj);
    
    // 检查是否需要丢弃（池已满）
    if (this.pool.length < this.config.maxSize) {
      this.pool.push(obj);
    } else {
      this.stats.dropped++;
    }
    
    this.stats.returned++;
    this._updateMetrics();
  }

  /**
   * 更新指标
   */
  _updateMetrics() {
    this.metrics.poolSize.set(this.pool.length + this.inUse.size);
    this.metrics.poolInUse.set(this.inUse.size);
  }

  /**
   * 启动清理任务
   */
  _startCleanup() {
    this._cleanupTask = setInterval(() => {
      this._shrinkIfNeeded();
    }, this.config.cleanupInterval);
  }

  /**
   * 按需收缩对象池
   */
  _shrinkIfNeeded() {
    const usageRatio = this.inUse.size / (this.pool.length + this.inUse.size);
    
    if (usageRatio < this.config.shrinkThreshold && this.pool.length > this.config.initialSize) {
      const shrinkCount = Math.floor(this.pool.length * 0.3);
      this.pool.splice(0, shrinkCount);
      logger.debug('Object pool shrunk', { removed: shrinkCount, remaining: this.pool.length });
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      poolSize: this.pool.length,
      inUse: this.inUse.size,
      ...this.stats
    };
  }

  /**
   * 关闭对象池
   */
  close() {
    if (this._cleanupTask) {
      clearInterval(this._cleanupTask);
    }
    this.pool = [];
    this.inUse.clear();
    logger.info('Connection object pool closed');
  }
}

module.exports = ConnectionObjectPool;
```

### 4.3 优先级任务调度器

```javascript
// backend/shared/websocket/PriorityTaskScheduler.js

'use strict';

const { logger, metrics } = require('../index');

/**
 * 优先级任务调度器 - CPU 资源优化
 */
class PriorityTaskScheduler {
  constructor(options = {}) {
    this.config = {
      maxConcurrent: options.maxConcurrent || 10,
      queueLimit: options.queueLimit || 1000,
      priorityLevels: options.priorityLevels || {
        critical: 0,  // 心跳响应、认证
        high: 1,      // 战斗消息
        normal: 2,    // 常规消息
        low: 3        // 统计、日志
      },
      scheduleInterval: options.scheduleInterval || 10, // 10ms 调度周期
      timeSlice: options.timeSlice || 5 // 每个任务时间片（ms）
    };
    
    // 优先级队列
    this.queues = {
      critical: [],
      high: [],
      normal: [],
      low: []
    };
    
    // 执行状态
    this.running = false;
    this.currentTasks = 0;
    
    // 统计
    this.stats = {
      totalScheduled: 0,
      totalExecuted: 0,
      totalDropped: 0,
      avgWaitTime: 0,
      avgExecuteTime: 0
    };
    
    this._setupMetrics();
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      queueLength: metrics.gauge('ws_scheduler_queue_length', 'Queue length', ['priority']),
      tasksExecuted: metrics.counter('ws_scheduler_tasks_total', 'Tasks executed', ['priority']),
      waitTime: metrics.histogram('ws_scheduler_wait_time_ms', 'Task wait time', [], [1, 5, 10, 50, 100]),
      executeTime: metrics.histogram('ws_scheduler_exec_time_ms', 'Task execute time', [], [0.1, 0.5, 1, 5, 10]),
      activeTasks: metrics.gauge('ws_scheduler_active_tasks', 'Currently active tasks')
    };
  }

  /**
   * 调度任务
   * @param {Function} task 任务函数
   * @param {string} priority 优先级
   */
  schedule(task, priority = 'normal') {
    if (!this.queues[priority]) {
      logger.warn('Invalid priority level', { priority });
      return false;
    }
    
    // 检查队列限制
    const totalQueued = Object.values(this.queues).reduce((sum, q) => sum + q.length, 0);
    if (totalQueued >= this.config.queueLimit) {
      this.stats.totalDropped++;
      logger.warn('Task queue full, task dropped');
      return false;
    }
    
    const taskEntry = {
      task,
      priority,
      scheduledAt: Date.now(),
      id: `${priority}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    
    this.queues[priority].push(taskEntry);
    this.stats.totalScheduled++;
    
    this._updateQueueMetrics();
    
    // 启动调度器
    if (!this.running) {
      this._startScheduler();
    }
    
    return true;
  }

  /**
   * 启动调度器
   */
  _startScheduler() {
    this.running = true;
    this._scheduleLoop();
  }

  /**
   * 调度循环
   */
  async _scheduleLoop() {
    while (this.running) {
      // 检查并发限制
      if (this.currentTasks >= this.config.maxConcurrent) {
        await this._sleep(this.config.scheduleInterval);
        continue;
      }
      
      // 从最高优先级开始选择任务
      const taskEntry = this._selectNextTask();
      
      if (!taskEntry) {
        await this._sleep(this.config.scheduleInterval);
        continue;
      }
      
      // 异步执行任务
      this._executeTask(taskEntry);
      
      await this._sleep(this.config.scheduleInterval);
    }
  }

  /**
   * 选择下一个任务
   */
  _selectNextTask() {
    // 按优先级顺序检查队列
    for (const priority of ['critical', 'high', 'normal', 'low']) {
      const queue = this.queues[priority];
      if (queue.length > 0) {
        return queue.shift();
      }
    }
    return null;
  }

  /**
   * 执行任务
   */
  async _executeTask(taskEntry) {
    const { task, priority, scheduledAt } = taskEntry;
    
    this.currentTasks++;
    this.metrics.activeTasks.set(this.currentTasks);
    
    const startTime = Date.now();
    const waitTime = startTime - scheduledAt;
    
    try {
      // 执行任务（带超时）
      await this._executeWithTimeout(task, this.config.timeSlice);
      
      const executeTime = Date.now() - startTime;
      
      // 更新统计
      this.stats.totalExecuted++;
      this.stats.avgWaitTime = (this.stats.avgWaitTime * 0.9 + waitTime * 0.1);
      this.stats.avgExecuteTime = (this.stats.avgExecuteTime * 0.9 + executeTime * 0.1);
      
      // 更新指标
      this.metrics.tasksExecuted.inc({ priority });
      this.metrics.waitTime.observe(waitTime);
      this.metrics.executeTime.observe(executeTime);
      
    } catch (error) {
      logger.warn('Task execution failed', { error: error.message, priority });
    } finally {
      this.currentTasks--;
      this.metrics.activeTasks.set(this.currentTasks);
      this._updateQueueMetrics();
    }
  }

  /**
   * 带超时执行
   */
  async _executeWithTimeout(task, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Task timeout'));
      }, timeout);
      
      Promise.resolve()
        .then(() => task())
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * 更新队列指标
   */
  _updateQueueMetrics() {
    for (const [priority, queue] of Object.entries(this.queues)) {
      this.metrics.queueLength.set(queue.length, { priority });
    }
  }

  /**
   * 休眠
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      running: this.running,
      currentTasks: this.currentTasks,
      queues: Object.fromEntries(
        Object.entries(this.queues).map(([p, q]) => [p, q.length])
      ),
      stats: this.stats
    };
  }

  /**
   * 关闭调度器
   */
  async close() {
    this.running = false;
    
    // 等待所有任务完成
    while (this.currentTasks > 0) {
      await this._sleep(10);
    }
    
    logger.info('Priority task scheduler closed');
  }
}

module.exports = PriorityTaskScheduler;
```

### 4.4 带宽自适应消息队列

```javascript
// backend/shared/websocket/BandwidthAdaptiveQueue.js

'use strict';

const { logger, metrics } = require('../index');

/**
 * 带宽自适应消息队列
 */
class BandwidthAdaptiveQueue {
  constructor(options = {}) {
    this.config = {
      // 队列配置
      maxQueueSize: options.maxQueueSize || 10000,
      
      // 带宽检测
      bandwidthSampleWindow: options.bandwidthSampleWindow || 60000, // 1分钟
      lowBandwidthThreshold: options.lowBandwidthThreshold || 100000, // 100KB/s
      highBandwidthThreshold: options.highBandwidthThreshold || 1000000, // 1MB/s
      
      // 聚合配置
      minBatchSize: options.minBatchSize || 1,
      maxBatchSize: options.maxBatchSize || 50,
      minBatchTimeout: options.minBatchTimeout || 10, // 高带宽：10ms
      maxBatchTimeout: options.maxBatchTimeout || 100, // 低带宽：100ms
      
      // 压缩阈值
      compressThreshold: options.compressThreshold || 512
    };
    
    // 消息队列
    this.queue = [];
    
    // 带宽状态
    this.bandwidth = {
      current: 0,
      samples: [],
      lastSampleTime: Date.now(),
      lastBytesSent: 0
    };
    
    // 聚合策略
    this.strategy = {
      batchSize: this.config.minBatchSize,
      batchTimeout: this.config.minBatchTimeout,
      compressionEnabled: false
    };
    
    // 统计
    this.stats = {
      totalQueued: 0,
      totalSent: 0,
      totalBytes: 0,
      totalBatches: 0,
      avgBatchSize: 0
    };
    
    this._setupMetrics();
    this._startBandwidthMonitor();
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      bandwidth: metrics.gauge('ws_bandwidth_bytes_per_sec', 'Current bandwidth'),
      batchSize: metrics.gauge('ws_adaptive_batch_size', 'Current batch size'),
      queueLength: metrics.gauge('ws_adaptive_queue_length', 'Queue length'),
      batchTimeout: metrics.gauge('ws_adaptive_batch_timeout_ms', 'Batch timeout'),
      messagesSent: metrics.counter('ws_adaptive_messages_sent_total', 'Messages sent')
    };
  }

  /**
   * 入队消息
   */
  enqueue(message) {
    if (this.queue.length >= this.config.maxQueueSize) {
      logger.warn('Bandwidth adaptive queue full');
      return false;
    }
    
    this.queue.push({
      ...message,
      queuedAt: Date.now()
    });
    
    this.stats.totalQueued++;
    this.metrics.queueLength.set(this.queue.length);
    
    return true;
  }

  /**
   * 获取批次（根据带宽自适应）
   */
  getBatch() {
    if (this.queue.length === 0) {
      return null;
    }
    
    // 更新聚合策略
    this._updateStrategy();
    
    // 取出消息
    const batchSize = Math.min(this.queue.length, this.strategy.batchSize);
    const batch = this.queue.splice(0, batchSize);
    
    this.stats.totalSent += batch.length;
    this.stats.totalBatches++;
    this.stats.avgBatchSize = (this.stats.avgBatchSize * 0.9 + batch.length * 0.1);
    
    this.metrics.messagesSent.inc(batch.length);
    this.metrics.queueLength.set(this.queue.length);
    
    return {
      messages: batch,
      compressed: this.strategy.compressionEnabled,
      timestamp: Date.now()
    };
  }

  /**
   * 更新聚合策略
   */
  _updateStrategy() {
    const bandwidth = this.bandwidth.current;
    
    // 根据带宽调整批量大小
    if (bandwidth < this.config.lowBandwidthThreshold) {
      // 低带宽：大批量，长等待
      this.strategy.batchSize = this.config.maxBatchSize;
      this.strategy.batchTimeout = this.config.maxBatchTimeout;
      this.strategy.compressionEnabled = true;
    } else if (bandwidth > this.config.highBandwidthThreshold) {
      // 高带宽：小批量，短等待
      this.strategy.batchSize = this.config.minBatchSize;
      this.strategy.batchTimeout = this.config.minBatchTimeout;
      this.strategy.compressionEnabled = false;
    } else {
      // 中等带宽：线性插值
      const ratio = (bandwidth - this.config.lowBandwidthThreshold) / 
        (this.config.highBandwidthThreshold - this.config.lowBandwidthThreshold);
      
      this.strategy.batchSize = Math.round(
        this.config.maxBatchSize - ratio * (this.config.maxBatchSize - this.config.minBatchSize)
      );
      this.strategy.batchTimeout = Math.round(
        this.config.maxBatchTimeout - ratio * (this.config.maxBatchTimeout - this.config.minBatchTimeout)
      );
      this.strategy.compressionEnabled = ratio < 0.5;
    }
    
    this.metrics.batchSize.set(this.strategy.batchSize);
    this.metrics.batchTimeout.set(this.strategy.batchTimeout);
  }

  /**
   * 启动带宽监控
   */
  _startBandwidthMonitor() {
    this._monitorTask = setInterval(() => {
      this._monitorBandwidth();
    }, this.config.bandwidthSampleWindow);
  }

  /**
   * 监控带宽
   */
  _monitorBandwidth() {
    const now = Date.now();
    const elapsed = (now - this.bandwidth.lastSampleTime) / 1000; // 秒
    
    if (elapsed > 0) {
      // 计算带宽（简化：使用消息发送量估算）
      const bytesPerSec = this.stats.totalBytes / elapsed;
      
      this.bandwidth.samples.push(bytesPerSec);
      
      // 保留最近10个样本
      if (this.bandwidth.samples.length > 10) {
        this.bandwidth.samples.shift();
      }
      
      // 计算平均带宽
      this.bandwidth.current = this.bandwidth.samples.reduce((a, b) => a + b, 0) / this.bandwidth.samples.length;
      
      this.metrics.bandwidth.set(this.bandwidth.current);
      
      this.bandwidth.lastSampleTime = now;
    }
  }

  /**
   * 记录发送字节数
   */
  recordBytesSent(bytes) {
    this.stats.totalBytes += bytes;
  }

  /**
   * 获取当前策略
   */
  getCurrentStrategy() {
    return {
      ...this.strategy,
      bandwidth: this.bandwidth.current,
      queueLength: this.queue.length
    };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      bandwidth: this.bandwidth.current,
      strategy: this.strategy
    };
  }

  /**
   * 关闭队列
   */
  close() {
    if (this._monitorTask) {
      clearInterval(this._monitorTask);
    }
    logger.info('Bandwidth adaptive queue closed');
  }
}

module.exports = BandwidthAdaptiveQueue;
```

### 4.5 集成到 WebSocketConnectionPool

```javascript
// backend/shared/websocket/index.js 更新

'use strict';

const WebSocketConnectionPool = require('./WebSocketConnectionPool');
const WebSocketBatchSender = require('./WebSocketBatchSender');
const AdaptiveConnectionPool = require('./AdaptiveConnectionPool');
const ConnectionObjectPool = require('./ConnectionObjectPool');
const PriorityTaskScheduler = require('./PriorityTaskScheduler');
const BandwidthAdaptiveQueue = require('./BandwidthAdaptiveQueue');

/**
 * 创建优化后的 WebSocket 管理器
 */
function createOptimizedWebSocketManager(options = {}) {
  // 创建自适应连接池控制器
  const adaptivePool = new AdaptiveConnectionPool(options.adaptive);
  
  // 创建连接对象池
  const objectPool = new ConnectionObjectPool(options.objectPool);
  
  // 创建优先级调度器
  const scheduler = new PriorityTaskScheduler(options.scheduler);
  
  // 创建带宽自适应队列
  const bandwidthQueue = new BandwidthAdaptiveQueue(options.bandwidth);
  
  // 创建连接池（集成优化组件）
  const connectionPool = new WebSocketConnectionPool({
    ...options,
    getMaxConnections: () => adaptivePool.getCurrentMax(),
    acquireConnectionObject: () => objectPool.acquire(),
    releaseConnectionObject: (obj) => objectPool.release(obj),
    scheduleTask: (task, priority) => scheduler.schedule(task, priority),
    enqueueMessage: (msg) => bandwidthQueue.enqueue(msg)
  });
  
  // 创建批处理器
  const batchSender = new WebSocketBatchSender(options.batch);
  
  return {
    connectionPool,
    batchSender,
    adaptivePool,
    objectPool,
    scheduler,
    bandwidthQueue,
    
    // 聚合状态
    getStatus() {
      return {
        connectionPool: connectionPool.getStatus(),
        batchSender: batchSender.getStatus(),
        adaptivePool: adaptivePool.getStatus(),
        objectPool: objectPool.getStats(),
        scheduler: scheduler.getStatus(),
        bandwidthQueue: bandwidthQueue.getStats()
      };
    },
    
    // 关闭所有组件
    async close() {
      bandwidthQueue.close();
      await scheduler.close();
      objectPool.close();
      adaptivePool.close();
      batchSender.close();
      await connectionPool.close();
    }
  };
}

module.exports = {
  WebSocketConnectionPool,
  WebSocketBatchSender,
  AdaptiveConnectionPool,
  ConnectionObjectPool,
  PriorityTaskScheduler,
  BandwidthAdaptiveQueue,
  createOptimizedWebSocketManager
};
```

## 5. 验收标准（可测试）

- [ ] 连接池利用率保持在 60%-90% 区间，减少 30% 资源浪费
- [ ] 内存占用降低 40%（对象池复用）
- [ ] 高负载下消息延迟降低 50%（优先级调度）
- [ ] 带宽利用率提升 20%（自适应聚合）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] Prometheus 指标完整（至少 15 个指标）
- [ ] 支持优雅降级（资源不足时自动保护）

## 6. 工作量估算

**L - 较大工作量**
- AdaptiveConnectionPool 实现：3 小时
- ConnectionObjectPool 实现：2 小时
- PriorityTaskScheduler 实现：3 小时
- BandwidthAdaptiveQueue 实现：2 小时
- 集成与测试：4 小时
- 文档与指标：2 小时

总计约 16 小时，需 2-3 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **性能瓶颈关键**：WebSocket 连接池是实时通信核心，优化直接影响用户体验
2. **资源成本显著**：固定池大小导致 30%-50% 资源浪费，云成本压力大
3. **高并发必需**：预计日活 10 万+用户，自适应伸缩是必要能力
4. **成熟度评分贡献**：直接提升"性能与可扩展"维度评分
5. **架构完备性**：补充现有 REQ-00511 的资源管理缺口

此需求是 WebSocket 性能优化系列的最后一块拼图，实现后连接池管理将达到生产级成熟度。