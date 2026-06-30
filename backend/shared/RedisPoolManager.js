// shared/RedisPoolManager.js - Redis 连接池管理与健康监控系统
'use strict';

const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const logger = createLogger('redis-pool');
const {
  redisPoolTotalConnections,
  redisPoolIdleConnections,
  redisPoolActiveConnections,
  redisPoolWaitingRequests,
  redisPoolConnectionErrors,
  redisCommandDuration,
  redisCommandTotal,
  redisPoolAcquireDuration,
  redisHealthStatus,
  redisHealthLatency,
  redisLeakedConnections,
  redisLeakDetectionRuns,
} = require('./metrics');

// ============================================================
// 连接泄漏检测器
// ============================================================
class ConnectionLeakDetector {
  constructor(threshold = 60000, serviceName = 'unknown') {
    this.connections = new Map(); // connectionId -> { acquireTime, stack }
    this.threshold = threshold; // 60 秒
    this.serviceName = serviceName;
    this.leakCount = 0;
  }

  /**
   * 跟踪连接获取
   */
  trackAcquire(connectionId) {
    this.connections.set(connectionId, {
      acquireTime: Date.now(),
      stack: new Error('Acquire stack').stack,
    });
  }

  /**
   * 跟踪连接释放
   */
  trackRelease(connectionId) {
    this.connections.delete(connectionId);
  }

  /**
   * 检测泄漏连接
   */
  detectLeaks() {
    const now = Date.now();
    const leaks = [];

    for (const [id, info] of this.connections) {
      const duration = now - info.acquireTime;
      if (duration > this.threshold) {
        leaks.push({
          id,
          duration,
          stack: info.stack,
        });
      }
    }

    // 更新指标
    if (leaks.length > 0) {
      this.leakCount += leaks.length;
      redisLeakedConnections.inc({ pool: this.serviceName }, leaks.length);
    }

    return leaks;
  }

  /**
   * 获取当前跟踪的连接数
   */
  getTrackedCount() {
    return this.connections.size;
  }

  /**
   * 清除所有跟踪
   */
  clear() {
    this.connections.clear();
  }
}

// ============================================================
// 连接池健康检查器
// ============================================================
class HealthChecker {
  constructor(poolName, config = {}) {
    this.poolName = poolName;
    this.checkInterval = config.checkInterval || 5000; // 5 秒
    this.latencyThreshold = config.latencyThreshold || 100; // 100ms
    this.status = 'unknown'; // healthy | degraded | unhealthy
    this.latency = 0;
    this.lastCheck = null;
    this.timer = null;
  }

  /**
   * 执行健康检查
   */
  async check(client) {
    const start = Date.now();

    try {
      await client.ping();
      this.latency = Date.now() - start;
      this.lastCheck = new Date();

      // 更新状态
      if (this.latency < 50) {
        this.status = 'healthy';
      } else if (this.latency < this.latencyThreshold) {
        this.status = 'degraded';
      } else {
        this.status = 'unhealthy';
      }

      // 更新指标
      const statusValue = this.status === 'healthy' ? 1 : this.status === 'degraded' ? 0.5 : 0;
      redisHealthStatus.set({ pool: this.poolName }, statusValue);
      redisHealthLatency.observe({ pool: this.poolName }, this.latency / 1000);

      return {
        status: this.status,
        latency: this.latency,
        lastCheck: this.lastCheck,
      };
    } catch (error) {
      this.status = 'unhealthy';
      this.latency = -1;
      redisHealthStatus.set({ pool: this.poolName }, 0);
      redisPoolConnectionErrors.inc({ pool: this.poolName });

      return {
        status: 'unhealthy',
        error: error.message,
        lastCheck: new Date(),
      };
    }
  }

  /**
   * 启动定期健康检查
   */
  start(client) {
    if (this.timer) return;

    this.timer = setInterval(async () => {
      await this.check(client);
    }, this.checkInterval);
  }

  /**
   * 停止健康检查
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ============================================================
// Redis 连接池管理器
// ============================================================
class RedisPoolManager {
  constructor(config = {}) {
    this.pools = new Map(); // 连接池映射
    this.serviceName = config.serviceName || 'default';
    this.defaultConfig = {
      minConnections: config.minConnections || 2,
      maxConnections: config.maxConnections || 20,
      acquireTimeout: config.acquireTimeout || 5000,
      idleTimeout: config.idleTimeout || 30000,
      healthCheckInterval: config.healthCheckInterval || 5000,
      enableLeakDetection: config.enableLeakDetection !== false,
      leakDetectionThreshold: config.leakDetectionThreshold || 60000,
      enableMetrics: config.enableMetrics !== false,
    };
  }

  /**
   * 创建连接池
   */
  async createPool(poolName, redisConfig = {}) {
    if (this.pools.has(poolName)) {
      return this.pools.get(poolName);
    }

    const pool = {
      name: poolName,
      connections: [], // 可用连接
      activeConnections: new Map(), // 正在使用的连接
      waitingQueue: [], // 等待队列
      config: { ...this.defaultConfig, ...redisConfig },
      client: null, // 主 Redis 客户端
      healthChecker: null,
      leakDetector: null,
      metrics: {
        totalAcquired: 0,
        totalReleased: 0,
        totalErrors: 0,
        totalWaitTime: 0,
      },
    };

    // 创建 Redis 客户端
    pool.client = await this._createClient(pool.config);

    // 初始化健康检查器
    pool.healthChecker = new HealthChecker(poolName, {
      checkInterval: pool.config.healthCheckInterval,
      latencyThreshold: 100,
    });
    pool.healthChecker.start(pool.client);

    // 初始化泄漏检测器
    if (pool.config.enableLeakDetection) {
      pool.leakDetector = new ConnectionLeakDetector(
        pool.config.leakDetectionThreshold,
        this.serviceName
      );

      // 定期泄漏检测
      this._startLeakDetection(pool);
    }

    // 预热连接
    await this._warmupConnections(pool);

    this.pools.set(poolName, pool);
    return pool;
  }

  /**
   * 创建 Redis 客户端
   */
  async _createClient(config) {
    const clusterNodes = process.env.REDIS_CLUSTER_NODES;
    let client;

    if (clusterNodes) {
      const nodes = clusterNodes.split(',').map((n) => {
        const [host, port] = n.split(':');
        return { host, port: parseInt(port || '6379') };
      });

      client = new Redis.Cluster(nodes, {
        redisOptions: { password: process.env.REDIS_PASSWORD },
        enableReadyCheck: true,
        scaleReads: config.scaleReads || 'slave',
        maxRedirections: 16,
        retryDelayOnFailover: 100,
        enableOfflineQueue: true,
      });
    } else {
      client = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        lazyConnect: false,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 10) return null; // 放弃重连
          const delay = Math.min(times * 1000, 30000);
          const jitter = Math.random() * 1000;
          return delay + jitter;
        },
        enableOfflineQueue: true,
        connectTimeout: 10000,
        commandTimeout: 5000,
      });
    }

    // 事件监听
    client.on('error', (err) => {
      logger.error({ pool: this.serviceName, error: err.message }, 'Redis pool error');
      redisPoolConnectionErrors.inc({ pool: this.serviceName });
    });

    client.on('close', () => {
      logger.warn({ pool: this.serviceName }, 'Connection closed');
    });

    client.on('reconnecting', () => {
      logger.info({ pool: this.serviceName }, 'Reconnecting');
    });

    return client;
  }

  /**
   * 预热连接
   */
  async _warmupConnections(pool) {
    // Redis 使用单一连接复用，不需要预热多个物理连接
    // 这里预热是指在 minConnections 范围内准备好连接
    for (let i = 0; i < pool.config.minConnections; i++) {
      pool.connections.push({
        id: uuidv4(),
        client: pool.client,
        createdAt: Date.now(),
        lastUsed: Date.now(),
      });
    }

    this._updateMetrics(pool);
  }

  /**
   * 获取连接
   */
  async acquire(poolName = 'default') {
    const pool = this.pools.get(poolName);
    if (!pool) {
      throw new Error(`Pool "${poolName}" not found`);
    }

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // 从等待队列中移除
        const index = pool.waitingQueue.findIndex((w) => w.reject === reject);
        if (index !== -1) {
          pool.waitingQueue.splice(index, 1);
        }

        reject(new Error(`Acquire timeout after ${pool.config.acquireTimeout}ms`));
      }, pool.config.acquireTimeout);

      // 尝试获取连接
      const tryAcquire = () => {
        // 从可用连接中获取
        let connection = pool.connections.pop();

        if (!connection && pool.activeConnections.size < pool.config.maxConnections) {
          // 创建新连接
          connection = {
            id: uuidv4(),
            client: pool.client,
            createdAt: Date.now(),
            lastUsed: Date.now(),
          };
        }

        if (connection) {
          clearTimeout(timeout);

          // 记录获取时间
          connection.acquiredAt = Date.now();
          pool.activeConnections.set(connection.id, connection);
          pool.metrics.totalAcquired++;

          // 泄漏检测
          if (pool.leakDetector) {
            pool.leakDetector.trackAcquire(connection.id);
          }

          // 更新指标
          const acquireTime = Date.now() - startTime;
          redisPoolAcquireDuration.observe({ pool: poolName }, acquireTime / 1000);
          this._updateMetrics(pool);

          resolve(connection);
          return true;
        }

        return false;
      };

      // 尝试立即获取
      if (!tryAcquire()) {
        // 加入等待队列
        pool.waitingQueue.push({
          resolve: (conn) => {
            clearTimeout(timeout);
            resolve(conn);
          },
          reject,
        });

        pool.metrics.totalWaitTime++;
        this._updateMetrics(pool);
      }
    });
  }

  /**
   * 释放连接
   */
  async release(connection, poolName = 'default') {
    const pool = this.pools.get(poolName);
    if (!pool) {
      logger.warn({ pool: poolName }, 'Pool not found, connection leaked');
      return;
    }

    // 从活跃连接中移除
    pool.activeConnections.delete(connection.id);

    // 泄漏检测
    if (pool.leakDetector) {
      pool.leakDetector.trackRelease(connection.id);
    }

    // 更新最后使用时间
    connection.lastUsed = Date.now();
    delete connection.acquiredAt;

    // 检查是否需要销毁连接
    if (pool.connections.length < pool.config.maxConnections) {
      pool.connections.push(connection);
    }

    pool.metrics.totalReleased++;
    this._updateMetrics(pool);

    // 处理等待队列
    if (pool.waitingQueue.length > 0) {
      const waiter = pool.waitingQueue.shift();
      connection.acquiredAt = Date.now();
      pool.activeConnections.set(connection.id, connection);

      if (pool.leakDetector) {
        pool.leakDetector.trackAcquire(connection.id);
      }

      waiter.resolve(connection);
    }
  }

  /**
   * 执行命令（自动管理连接）
   */
  async execute(poolName, command, ...args) {
    const pool = this.pools.get(poolName);
    if (!pool) {
      throw new Error(`Pool "${poolName}" not found`);
    }

    const startTime = Date.now();

    try {
      const result = await pool.client[command](...args);

      // 记录指标
      const duration = Date.now() - startTime;
      redisCommandDuration.observe({ pool: poolName, command }, duration / 1000);
      redisCommandTotal.inc({ pool: poolName, command, status: 'success' });

      return result;
    } catch (error) {
      pool.metrics.totalErrors++;
      redisCommandTotal.inc({ pool: poolName, command, status: 'error' });
      redisPoolConnectionErrors.inc({ pool: poolName });

      throw error;
    }
  }

  /**
   * 获取池状态
   */
  getPoolStats(poolName = 'default') {
    const pool = this.pools.get(poolName);
    if (!pool) {
      return null;
    }

    const health = pool.healthChecker
      ? {
          status: pool.healthChecker.status,
          latency: pool.healthChecker.latency,
          lastCheck: pool.healthChecker.lastCheck,
        }
      : null;

    return {
      name: poolName,
      total: pool.connections.length + pool.activeConnections.size,
      idle: pool.connections.length,
      active: pool.activeConnections.size,
      waiting: pool.waitingQueue.length,
      health,
      metrics: pool.metrics,
      leaks: pool.leakDetector ? pool.leakDetector.detectLeaks() : [],
    };
  }

  /**
   * 获取所有池状态
   */
  getAllPoolStats() {
    const stats = {};
    for (const [name] of this.pools) {
      stats[name] = this.getPoolStats(name);
    }
    return stats;
  }

  /**
   * 重置连接池
   */
  async resetPool(poolName = 'default') {
    const pool = this.pools.get(poolName);
    if (!pool) {
      throw new Error(`Pool "${poolName}" not found`);
    }

    // 清空连接
    pool.connections = [];
    pool.activeConnections.clear();
    pool.waitingQueue = [];

    // 重新预热
    await this._warmupConnections(pool);

    logger.info({ pool: poolName }, 'Pool reset completed');
  }

  /**
   * 健康检查
   */
  async healthCheck(poolName = 'default') {
    const pool = this.pools.get(poolName);
    if (!pool) {
      throw new Error(`Pool "${poolName}" not found`);
    }

    return pool.healthChecker.check(pool.client);
  }

  /**
   * 泄漏检测
   */
  detectLeaks(poolName = 'default') {
    const pool = this.pools.get(poolName);
    if (!pool || !pool.leakDetector) {
      return [];
    }

    return pool.leakDetector.detectLeaks();
  }

  /**
   * 启动定期泄漏检测
   */
  _startLeakDetection(pool) {
    const interval = setInterval(() => {
      const leaks = pool.leakDetector.detectLeaks();

      if (leaks.length > 0) {
        logger.warn({
          pool: pool.name,
          leakCount: leaks.length,
          leaks: leaks.map((l) => ({ id: l.id, duration: l.duration }))
        }, 'Detected potential leaks');
      }

      redisLeakDetectionRuns.inc({ pool: pool.name });
    }, 30000); // 每 30 秒检测一次

    pool.leakDetectionTimer = interval;
  }

  /**
   * 更新 Prometheus 指标
   */
  _updateMetrics(pool) {
    if (!pool.config.enableMetrics) return;

    redisPoolTotalConnections.set({ pool: pool.name }, pool.connections.length + pool.activeConnections.size);
    redisPoolIdleConnections.set({ pool: pool.name }, pool.connections.length);
    redisPoolActiveConnections.set({ pool: pool.name }, pool.activeConnections.size);
    redisPoolWaitingRequests.set({ pool: pool.name }, pool.waitingQueue.length);
  }

  /**
   * 关闭所有连接池
   */
  async close() {
    for (const [name, pool] of this.pools) {
      // 停止健康检查
      if (pool.healthChecker) {
        pool.healthChecker.stop();
      }

      // 停止泄漏检测
      if (pool.leakDetectionTimer) {
        clearInterval(pool.leakDetectionTimer);
      }

      // 关闭 Redis 客户端
      if (pool.client) {
        await pool.client.quit();
      }

      logger.info({ pool: name }, 'Pool closed');
    }

    this.pools.clear();
  }
}

// ============================================================
// 单例模式
// ============================================================
let poolManagerInstance = null;

/**
 * 获取连接池管理器实例
 */
function getPoolManager(config = {}) {
  if (!poolManagerInstance) {
    poolManagerInstance = new RedisPoolManager(config);
  }
  return poolManagerInstance;
}

/**
 * 初始化连接池
 */
async function initPool(poolName = 'default', config = {}) {
  const manager = getPoolManager(config);
  return manager.createPool(poolName, config);
}

module.exports = {
  RedisPoolManager,
  ConnectionLeakDetector,
  HealthChecker,
  getPoolManager,
  initPool,
};
