# REQ-00232: 数据库连接池健康检测与自动恢复系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00232 |
| 标题 | 数据库连接池健康检测与自动恢复系统 |
| 类别 | 性能优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | backend/shared、所有微服务、PostgreSQL、infrastructure/k8s |
| 创建时间 | 2026-06-15 21:00 |

## 需求描述

当前数据库连接池缺乏主动健康检测机制，连接泄漏、僵尸连接、网络抖动等问题可能导致连接池耗尽或性能下降。需要建立完善的连接健康检测与自动恢复系统：

1. **主动健康检测**：定期检测连接可用性，及时发现僵尸连接
2. **连接泄漏检测**：追踪连接借用与归还，识别未正确释放的连接
3. **自动恢复机制**：检测到异常连接时自动重建或丢弃
4. **连接池熔断**：当健康连接比例过低时触发熔断保护
5. **预警与诊断**：提供详细的连接池状态监控和告警

### 核心目标
- 连接池可用性 ≥ 99.95%
- 僵尸连接检测延迟 < 30 秒
- 连接泄漏识别准确率 ≥ 95%
- 自动恢复成功率 ≥ 99%
- 减少因连接问题导致的故障 80%

## 技术方案

### 1. 连接健康检测引擎

```javascript
// backend/shared/ConnectionHealthMonitor.js

const { EventEmitter } = require('events');
const logger = require('./logger');
const metrics = require('./metrics');

class ConnectionHealthMonitor extends EventEmitter {
  constructor(pool, options = {}) {
    super();
    this.pool = pool;
    this.options = {
      healthCheckInterval: options.healthCheckInterval || 30000, // 30秒
      healthCheckTimeout: options.healthCheckTimeout || 5000, // 5秒
      zombieThreshold: options.zombieThreshold || 60000, // 60秒未使用视为僵尸
      maxConsecutiveFailures: options.maxConsecutiveFailures || 3,
      recoveryDelay: options.recoveryDelay || 5000,
      ...options
    };
    
    this.healthStatus = new Map(); // 连接ID -> 健康状态
    this.consecutiveFailures = new Map(); // 连接ID -> 连续失败次数
    this.lastUsedTime = new Map(); // 连接ID -> 最后使用时间
    this.borrowTracker = new Map(); // 连接ID -> 借用信息
    
    this.stats = {
      totalChecks: 0,
      healthyConnections: 0,
      unhealthyConnections: 0,
      recoveredConnections: 0,
      zombieConnections: 0,
      leakedConnections: 0
    };
    
    this.isRunning = false;
    this.healthCheckTimer = null;
  }
  
  /**
   * 启动健康检测
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.healthCheckTimer = setInterval(
      () => this.performHealthCheck(),
      this.options.healthCheckInterval
    );
    
    // 监听连接池事件
    this.pool.on('acquire', (connection) => this.onConnectionAcquire(connection));
    this.pool.on('release', (connection) => this.onConnectionRelease(connection));
    this.pool.on('create', (connection) => this.onConnectionCreate(connection));
    this.pool.on('destroy', (connection) => this.onConnectionDestroy(connection));
    
    logger.info('Connection health monitor started', {
      interval: this.options.healthCheckInterval,
      poolSize: this.pool.totalCount,
      idleCount: this.pool.idleCount
    });
    
    this.emit('started');
  }
  
  /**
   * 停止健康检测
   */
  stop() {
    if (!this.isRunning) return;
    
    this.isRunning = false;
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    logger.info('Connection health monitor stopped');
    this.emit('stopped');
  }
  
  /**
   * 执行健康检测
   */
  async performHealthCheck() {
    const startTime = Date.now();
    this.stats.totalChecks++;
    
    try {
      // 获取所有空闲连接
      const idleConnections = await this.getIdleConnections();
      const results = [];
      
      // 并发检测（限制并发数）
      const batchSize = 10;
      for (let i = 0; i < idleConnections.length; i += batchSize) {
        const batch = idleConnections.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map(conn => this.checkConnectionHealth(conn))
        );
        results.push(...batchResults);
      }
      
      // 统计结果
      const healthy = results.filter(r => r.status === 'fulfilled' && r.value.healthy).length;
      const unhealthy = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.healthy)).length;
      
      this.stats.healthyConnections = healthy;
      this.stats.unhealthyConnections = unhealthy;
      
      // 更新指标
      const duration = Date.now() - startTime;
      metrics.observe('db_pool_health_check_duration_ms', duration);
      metrics.gauge('db_pool_healthy_connections', healthy);
      metrics.gauge('db_pool_unhealthy_connections', unhealthy);
      
      // 检查是否需要熔断
      const healthRatio = healthy / (healthy + unhealthy);
      if (healthRatio < 0.5) {
        this.emit('pool:unhealthy', { healthRatio, healthy, unhealthy });
        logger.error('Database pool health ratio too low', {
          healthRatio,
          healthy,
          unhealthy
        });
      }
      
      this.emit('health:check:complete', {
        healthy,
        unhealthy,
        duration,
        healthRatio
      });
      
    } catch (error) {
      logger.error('Health check failed', { error: error.message });
      this.emit('health:check:error', error);
    }
  }
  
  /**
   * 检测单个连接健康状态
   */
  async checkConnectionHealth(connection) {
    const connectionId = this.getConnectionId(connection);
    const startTime = Date.now();
    
    try {
      // 设置超时
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Health check timeout')), this.options.healthCheckTimeout);
      });
      
      // 执行简单查询
      const healthQuery = this.pool.$config.options.healthCheckQuery || 'SELECT 1';
      const healthPromise = connection.query(healthQuery);
      
      await Promise.race([healthPromise, timeoutPromise]);
      
      // 更新健康状态
      this.healthStatus.set(connectionId, {
        healthy: true,
        lastCheck: new Date(),
        responseTime: Date.now() - startTime
      });
      
      // 重置连续失败计数
      this.consecutiveFailures.delete(connectionId);
      
      // 检查是否为僵尸连接
      const lastUsed = this.lastUsedTime.get(connectionId);
      if (lastUsed && (Date.now() - lastUsed > this.options.zombieThreshold)) {
        this.stats.zombieConnections++;
        logger.warn('Zombie connection detected', {
          connectionId,
          lastUsed: new Date(lastUsed),
          idleTime: Date.now() - lastUsed
        });
        this.emit('connection:zombie', { connectionId, lastUsed });
      }
      
      return { connectionId, healthy: true, responseTime: Date.now() - startTime };
      
    } catch (error) {
      // 增加失败计数
      const failures = (this.consecutiveFailures.get(connectionId) || 0) + 1;
      this.consecutiveFailures.set(connectionId, failures);
      
      // 更新健康状态
      this.healthStatus.set(connectionId, {
        healthy: false,
        lastCheck: new Date(),
        error: error.message,
        consecutiveFailures: failures
      });
      
      logger.warn('Connection health check failed', {
        connectionId,
        error: error.message,
        consecutiveFailures: failures
      });
      
      // 尝试恢复
      if (failures >= this.options.maxConsecutiveFailures) {
        await this.recoverConnection(connection);
      }
      
      return { connectionId, healthy: false, error: error.message };
    }
  }
  
  /**
   * 恢复连接
   */
  async recoverConnection(connection) {
    const connectionId = this.getConnectionId(connection);
    
    try {
      logger.info('Attempting to recover connection', { connectionId });
      
      // 等待恢复延迟
      await new Promise(resolve => setTimeout(resolve, this.options.recoveryDelay));
      
      // 尝试销毁并重建连接
      await this.pool._destroy(connection);
      const newConnection = await this.pool._create();
      
      // 重置状态
      this.consecutiveFailures.delete(connectionId);
      this.healthStatus.delete(connectionId);
      
      this.stats.recoveredConnections++;
      
      logger.info('Connection recovered successfully', { connectionId });
      this.emit('connection:recovered', { connectionId });
      
      metrics.increment('db_pool_connections_recovered');
      
      return true;
      
    } catch (error) {
      logger.error('Connection recovery failed', {
        connectionId,
        error: error.message
      });
      
      this.emit('connection:recovery:failed', { connectionId, error });
      
      return false;
    }
  }
  
  /**
   * 连接借用时触发
   */
  onConnectionAcquire(connection) {
    const connectionId = this.getConnectionId(connection);
    this.lastUsedTime.set(connectionId, Date.now());
    
    // 追踪借用信息
    this.borrowTracker.set(connectionId, {
      borrowedAt: new Date(),
      stackTrace: new Error().stack,
      threadId: process.threadId
    });
    
    this.emit('connection:acquired', { connectionId });
  }
  
  /**
   * 连接归还时触发
   */
  onConnectionRelease(connection) {
    const connectionId = this.getConnectionId(connection);
    
    const borrowInfo = this.borrowTracker.get(connectionId);
    if (borrowInfo) {
      const holdTime = Date.now() - borrowInfo.borrowedAt.getTime();
      
      // 记录持有时间
      metrics.observe('db_connection_hold_time_ms', holdTime);
      
      // 检查是否为长时间持有（可能的泄漏）
      if (holdTime > 30000) { // 30秒
        logger.warn('Connection held for extended period', {
          connectionId,
          holdTime,
          stackTrace: borrowInfo.stackTrace
        });
        
        this.emit('connection:long:hold', {
          connectionId,
          holdTime,
          stackTrace: borrowInfo.stackTrace
        });
      }
      
      this.borrowTracker.delete(connectionId);
    }
    
    this.lastUsedTime.set(connectionId, Date.now());
    this.emit('connection:released', { connectionId });
  }
  
  /**
   * 连接创建时触发
   */
  onConnectionCreate(connection) {
    const connectionId = this.getConnectionId(connection);
    
    this.healthStatus.set(connectionId, {
      healthy: true,
      createdAt: new Date()
    });
    
    this.lastUsedTime.set(connectionId, Date.now());
    
    logger.debug('Connection created', { connectionId });
    this.emit('connection:created', { connectionId });
  }
  
  /**
   * 连接销毁时触发
   */
  onConnectionDestroy(connection) {
    const connectionId = this.getConnectionId(connection);
    
    this.healthStatus.delete(connectionId);
    this.lastUsedTime.delete(connectionId);
    this.consecutiveFailures.delete(connectionId);
    this.borrowTracker.delete(connectionId);
    
    logger.debug('Connection destroyed', { connectionId });
    this.emit('connection:destroyed', { connectionId });
  }
  
  /**
   * 检测连接泄漏
   */
  detectLeaks() {
    const now = Date.now();
    const leakThreshold = 60000; // 60秒未归还视为泄漏
    const leaks = [];
    
    for (const [connectionId, borrowInfo] of this.borrowTracker.entries()) {
      const holdTime = now - borrowInfo.borrowedAt.getTime();
      
      if (holdTime > leakThreshold) {
        this.stats.leakedConnections++;
        
        leaks.push({
          connectionId,
          borrowedAt: borrowInfo.borrowedAt,
          holdTime,
          stackTrace: borrowInfo.stackTrace
        });
        
        logger.error('Connection leak detected', {
          connectionId,
          borrowedAt: borrowInfo.borrowedAt,
          holdTime,
          stackTrace: borrowInfo.stackTrace
        });
      }
    }
    
    if (leaks.length > 0) {
      this.emit('leaks:detected', leaks);
      metrics.gauge('db_pool_leaked_connections', leaks.length);
    }
    
    return leaks;
  }
  
  /**
   * 获取连接池健康状态报告
   */
  getHealthReport() {
    const total = this.pool.totalCount;
    const idle = this.pool.idleCount;
    const waiting = this.pool.waitingCount;
    
    const healthyCount = Array.from(this.healthStatus.values())
      .filter(status => status.healthy).length;
    
    return {
      pool: {
        total,
        idle,
        active: total - idle,
        waiting,
        healthRatio: total > 0 ? healthyCount / total : 1
      },
      stats: this.stats,
      connections: {
        healthy: healthyCount,
        unhealthy: this.healthStatus.size - healthyCount,
        borrowed: this.borrowTracker.size,
        potentialLeaks: this.detectLeaks().length
      },
      lastCheck: new Date()
    };
  }
  
  /**
   * 获取连接ID
   */
  getConnectionId(connection) {
    return connection.processID || connection.id || `${connection.host}:${connection.port}`;
  }
  
  /**
   * 获取空闲连接列表
   */
  async getIdleConnections() {
    // 实现取决于连接池类型
    if (this.pool._pool && this.pool._pool._all) {
      return this.pool._pool._all.filter(conn => conn.idle);
    }
    return [];
  }
}

module.exports = ConnectionHealthMonitor;
```

### 2. 连接池熔断器

```javascript
// backend/shared/PoolCircuitBreaker.js

const { EventEmitter } = require('events');
const logger = require('./logger');

class PoolCircuitBreaker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      failureThreshold: options.failureThreshold || 5, // 连续失败次数阈值
      successThreshold: options.successThreshold || 3, // 半开状态成功次数阈值
      timeout: options.timeout || 30000, // 开路状态持续时间
      healthThreshold: options.healthThreshold || 0.5, // 健康连接比例阈值
      ...options
    };
    
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.openedAt = null;
    
    this.stats = {
      trips: 0,
      totalFailures: 0,
      totalSuccesses: 0
    };
  }
  
  /**
   * 记录成功
   */
  recordSuccess() {
    this.stats.totalSuccesses++;
    
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      
      if (this.successCount >= this.options.successThreshold) {
        this.close();
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }
  
  /**
   * 记录失败
   */
  recordFailure() {
    this.stats.totalFailures++;
    this.lastFailureTime = new Date();
    
    if (this.state === 'CLOSED') {
      this.failureCount++;
      
      if (this.failureCount >= this.options.failureThreshold) {
        this.trip();
      }
    } else if (this.state === 'HALF_OPEN') {
      this.trip();
    }
  }
  
  /**
   * 根据健康比例更新状态
   */
  updateByHealthRatio(healthRatio) {
    if (this.state === 'CLOSED' && healthRatio < this.options.healthThreshold) {
      this.trip();
    } else if (this.state === 'OPEN') {
      if (healthRatio > this.options.healthThreshold) {
        this.halfOpen();
      }
    }
  }
  
  /**
   * 触发熔断
   */
  trip() {
    const previousState = this.state;
    this.state = 'OPEN';
    this.openedAt = new Date();
    this.stats.trips++;
    this.successCount = 0;
    
    logger.error('Database pool circuit breaker tripped', {
      previousState,
      newState: this.state,
      failureCount: this.failureCount,
      totalTrips: this.stats.trips
    });
    
    this.emit('trip', {
      previousState,
      newState: this.state,
      failureCount: this.failureCount
    });
    
    // 设置自动恢复定时器
    setTimeout(() => {
      if (this.state === 'OPEN') {
        this.halfOpen();
      }
    }, this.options.timeout);
  }
  
  /**
   * 进入半开状态
   */
  halfOpen() {
    const previousState = this.state;
    this.state = 'HALF_OPEN';
    this.successCount = 0;
    
    logger.warn('Database pool circuit breaker entering half-open state', {
      previousState,
      newState: this.state
    });
    
    this.emit('half-open', {
      previousState,
      newState: this.state
    });
  }
  
  /**
   * 关闭熔断器
   */
  close() {
    const previousState = this.state;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    
    logger.info('Database pool circuit breaker closed', {
      previousState,
      newState: this.state,
      totalSuccesses: this.stats.totalSuccesses
    });
    
    this.emit('close', {
      previousState,
      newState: this.state
    });
  }
  
  /**
   * 检查是否允许请求
   */
  isAllowed() {
    if (this.state === 'CLOSED') {
      return true;
    }
    
    if (this.state === 'OPEN') {
      // 检查是否超过超时时间
      if (this.openedAt && (Date.now() - this.openedAt.getTime() > this.options.timeout)) {
        this.halfOpen();
        return true;
      }
      return false;
    }
    
    if (this.state === 'HALF_OPEN') {
      return true;
    }
    
    return false;
  }
  
  /**
   * 获取状态报告
   */
  getStatus() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      openedAt: this.openedAt,
      isAllowed: this.isAllowed(),
      stats: this.stats
    };
  }
}

module.exports = PoolCircuitBreaker;
```

### 3. 集成到数据库连接池

```javascript
// backend/shared/db.js（更新）

const { Pool } = require('pg');
const ConnectionHealthMonitor = require('./ConnectionHealthMonitor');
const PoolCircuitBreaker = require('./PoolCircuitBreaker');
const logger = require('./logger');
const metrics = require('./metrics');

class DatabasePool {
  constructor(config) {
    this.pool = new Pool({
      ...config,
      // 健康检查查询
      healthCheckQuery: 'SELECT 1 as health_check',
      // 连接超时
      connectionTimeoutMillis: config.connectionTimeoutMillis || 5000,
      // 空闲超时
      idleTimeoutMillis: config.idleTimeoutMillis || 30000,
      // 连接最大生命周期
      maxLifetimeSeconds: config.maxLifetimeSeconds || 1800
    });
    
    // 初始化健康监控器
    this.healthMonitor = new ConnectionHealthMonitor(this.pool, {
      healthCheckInterval: config.healthCheckInterval || 30000,
      healthCheckTimeout: config.healthCheckTimeout || 5000,
      zombieThreshold: config.zombieThreshold || 60000,
      maxConsecutiveFailures: config.maxConsecutiveFailures || 3
    });
    
    // 初始化熔断器
    this.circuitBreaker = new PoolCircuitBreaker({
      failureThreshold: config.circuitBreakerFailureThreshold || 5,
      successThreshold: config.circuitBreakerSuccessThreshold || 3,
      timeout: config.circuitBreakerTimeout || 30000,
      healthThreshold: config.circuitBreakerHealthThreshold || 0.5
    });
    
    // 绑定事件
    this.setupEventHandlers();
    
    // 启动监控
    this.healthMonitor.start();
    
    // 泄漏检测定时器
    this.leakDetectorTimer = setInterval(() => {
      this.healthMonitor.detectLeaks();
    }, 60000); // 每分钟检测一次
  }
  
  /**
   * 设置事件处理器
   */
  setupEventHandlers() {
    // 健康检查完成
    this.healthMonitor.on('health:check:complete', (data) => {
      this.circuitBreaker.updateByHealthRatio(data.healthRatio);
    });
    
    // 连接池不健康
    this.healthMonitor.on('pool:unhealthy', (data) => {
      logger.error('Database pool is unhealthy, consider scaling or investigation', data);
      metrics.increment('db_pool_unhealthy_events');
      
      // 触发告警
      this.emitAlert('pool_unhealthy', data);
    });
    
    // 熔断器触发
    this.circuitBreaker.on('trip', (data) => {
      logger.error('Circuit breaker tripped, database requests will be blocked', data);
      metrics.increment('db_circuit_breaker_trips');
      
      // 触发告警
      this.emitAlert('circuit_breaker_trip', data);
    });
    
    // 熔断器恢复
    this.circuitBreaker.on('close', (data) => {
      logger.info('Circuit breaker closed, database requests resumed', data);
      metrics.increment('db_circuit_breaker_recoveries');
    });
    
    // 连接泄漏
    this.healthMonitor.on('leaks:detected', (leaks) => {
      logger.error('Connection leaks detected', { count: leaks.length });
      metrics.increment('db_connection_leaks_detected');
      
      // 触发告警
      this.emitAlert('connection_leak', { leaks });
    });
    
    // 僵尸连接
    this.healthMonitor.on('connection:zombie', (data) => {
      logger.warn('Zombie connection detected', data);
      metrics.increment('db_zombie_connections_detected');
    });
  }
  
  /**
   * 获取连接（带熔断保护）
   */
  async acquire() {
    if (!this.circuitBreaker.isAllowed()) {
      const error = new Error('Database pool circuit breaker is open');
      error.code = 'POOL_CIRCUIT_BREAKER_OPEN';
      throw error;
    }
    
    try {
      const client = await this.pool.connect();
      this.circuitBreaker.recordSuccess();
      return client;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      throw error;
    }
  }
  
  /**
   * 执行查询（带熔断保护）
   */
  async query(sql, params) {
    if (!this.circuitBreaker.isAllowed()) {
      const error = new Error('Database pool circuit breaker is open');
      error.code = 'POOL_CIRCUIT_BREAKER_OPEN';
      throw error;
    }
    
    try {
      const result = await this.pool.query(sql, params);
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      throw error;
    }
  }
  
  /**
   * 获取健康报告
   */
  getHealthReport() {
    return {
      ...this.healthMonitor.getHealthReport(),
      circuitBreaker: this.circuitBreaker.getStatus()
    };
  }
  
  /**
   * 触发告警
   */
  emitAlert(type, data) {
    // 发送到告警系统（可集成 Prometheus Alertmanager、Slack 等）
    logger.error('Database pool alert', { type, data });
    
    // 触发 webhook
    if (process.env.DB_ALERT_WEBHOOK_URL) {
      fetch(process.env.DB_ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'database_pool_alert',
          alertType: type,
          data,
          timestamp: new Date().toISOString(),
          service: process.env.SERVICE_NAME
        })
      }).catch(err => logger.error('Failed to send alert webhook', { error: err.message }));
    }
  }
  
  /**
   * 优雅关闭
   */
  async shutdown() {
    this.healthMonitor.stop();
    clearInterval(this.leakDetectorTimer);
    await this.pool.end();
  }
}

// 创建单例
let dbPoolInstance = null;

function getDbPool(config) {
  if (!dbPoolInstance) {
    dbPoolInstance = new DatabasePool(config);
  }
  return dbPoolInstance;
}

module.exports = { DatabasePool, getDbPool };
```

### 4. Prometheus 指标定义

```javascript
// backend/shared/metrics.js（新增指标）

// 连接池健康指标
metrics.registerGauge('db_pool_healthy_connections', 'Number of healthy database connections');
metrics.registerGauge('db_pool_unhealthy_connections', 'Number of unhealthy database connections');
metrics.registerGauge('db_pool_leaked_connections', 'Number of leaked database connections');
metrics.registerCounter('db_pool_connections_recovered', 'Number of connections recovered');
metrics.registerCounter('db_zombie_connections_detected', 'Number of zombie connections detected');
metrics.registerCounter('db_connection_leaks_detected', 'Number of connection leaks detected');
metrics.registerCounter('db_circuit_breaker_trips', 'Number of circuit breaker trips');
metrics.registerCounter('db_circuit_breaker_recoveries', 'Number of circuit breaker recoveries');
metrics.registerCounter('db_pool_unhealthy_events', 'Number of pool unhealthy events');

// 直方图指标
metrics.registerHistogram('db_pool_health_check_duration_ms', 'Duration of health check operations', [10, 50, 100, 500, 1000]);
metrics.registerHistogram('db_connection_hold_time_ms', 'Time connections are held before release', [100, 500, 1000, 5000, 10000, 30000, 60000]);
```

### 5. 健康检查端点

```javascript
// 所有微服务路由

router.get('/health/db', async (req, res) => {
  const db = getDbPool();
  const healthReport = db.getHealthReport();
  
  const statusCode = healthReport.pool.healthRatio >= 0.8 ? 200 : 
                     healthReport.pool.healthRatio >= 0.5 ? 503 : 503;
  
  res.status(statusCode).json({
    status: statusCode === 200 ? 'healthy' : 'unhealthy',
    ...healthReport
  });
});

router.get('/health/db/detailed', async (req, res) => {
  const db = getDbPool();
  const healthReport = db.getHealthReport();
  
  res.json(healthReport);
});
```

### 6. K8s 健康探针配置

```yaml
# infrastructure/k8s/base/deployment.yaml

livenessProbe:
  httpGet:
    path: /health/db
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 60
  timeoutSeconds: 10
  failureThreshold: 3

readinessProbe:
  httpGet:
    path: /health/db
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  timeoutSeconds: 5
  failureThreshold: 2
```

### 7. 监控告警规则

```yaml
# infrastructure/k8s/monitoring/alerts/database-pool.yml

groups:
  - name: database-pool-alerts
    rules:
      - alert: DatabasePoolUnhealthy
        expr: db_pool_health_ratio < 0.8
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool health ratio is low"
          description: "Database pool health ratio is {{ $value }} which is below 0.8"
      
      - alert: DatabasePoolCircuitBreakerOpen
        expr: increase(db_circuit_breaker_trips[5m]) > 0
        labels:
          severity: critical
        annotations:
          summary: "Database circuit breaker is open"
          description: "Circuit breaker tripped {{ $value }} times in the last 5 minutes"
      
      - alert: DatabaseConnectionLeaks
        expr: db_pool_leaked_connections > 0
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Database connection leaks detected"
          description: "{{ $value }} connection leaks detected"
      
      - alert: DatabaseZombieConnections
        expr: rate(db_zombie_connections_detected[5m]) > 0.1
        labels:
          severity: warning
        annotations:
          summary: "High rate of zombie connections detected"
          description: "Zombie connections detected at {{ $value }} per second"
      
      - alert: DatabasePoolRecoveryFailures
        expr: rate(db_pool_connections_recovered[10m]) / rate(db_pool_unhealthy_connections[10m]) < 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Low connection recovery rate"
          description: "Connection recovery rate is {{ $value | humanizePercentage }}"
```

## 验收标准

- [ ] 连接健康监控器实现完成，包含主动健康检测、僵尸连接检测、泄漏检测
- [ ] 连接池熔断器实现完成，包含 CLOSED/OPEN/HALF_OPEN 三种状态转换
- [ ] 集成到 db.js，所有微服务自动启用健康监控和熔断保护
- [ ] 健康检查端点 `/health/db` 和 `/health/db/detailed` 实现完成
- [ ] Prometheus 指标暴露完成，包含健康比例、泄漏数、熔断次数等
- [ ] K8s 健康探针配置完成，包含 liveness 和 readiness 探针
- [ ] 告警规则配置完成，覆盖连接池不健康、熔断器触发、泄漏检测等场景
- [ ] 单元测试覆盖率 ≥ 80%，包含健康检测、熔断器、泄漏检测测试
- [ ] 集成测试完成，验证健康检测和自动恢复在真实环境中的表现
- [ ] 文档完成，包含配置说明、告警说明、故障排查指南

## 影响范围

- `backend/shared/ConnectionHealthMonitor.js`（新增）
- `backend/shared/PoolCircuitBreaker.js`（新增）
- `backend/shared/db.js`（更新）
- `backend/shared/metrics.js`（更新）
- 所有微服务的健康检查路由（更新）
- `infrastructure/k8s/base/deployment.yaml`（更新）
- `infrastructure/k8s/monitoring/alerts/database-pool.yml`（新增）
- `backend/tests/unit/ConnectionHealthMonitor.test.js`（新增）
- `backend/tests/unit/PoolCircuitBreaker.test.js`（新增）
- `backend/tests/integration/database-health.test.js`（新增）

## 参考

- [PostgreSQL Connection Pool Best Practices](https://www.postgresql.org/docs/current/libpq-connect.html)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Node.js pg Pool Documentation](https://node-postgres.com/apis/pool)
- [Prometheus Alerting Best Practices](https://prometheus.io/docs/practices/alerting/)
