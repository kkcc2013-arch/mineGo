/**
 * 分布式锁服务 - Redis Redlock 实现
 * 
 * 基于 Redlock 算法实现分布式锁，支持多 Redis 实例高可用
 * 
 * @module distributedLock
 * @see https://redis.io/topics/distlock
 */

const Redis = require('ioredis');
const crypto = require('crypto');
const { createLogger } = require('./logger');

const logger = createLogger('distributed-lock');

// ============================================================================
// Prometheus 指标定义
// ============================================================================

const metrics = {
  locksAcquired: null,
  locksReleased: null,
  locksFailed: null,
  locksExtended: null,
  lockWaitTime: null,
  lockHeldTime: null,
  activeLocks: null,
  deadlocksDetected: null
};

/**
 * 初始化 Prometheus 指标
 */
function initMetrics() {
  const promClient = require('prom-client');
  
  metrics.locksAcquired = new promClient.Counter({
    name: 'distributed_lock_acquired_total',
    help: 'Total number of distributed locks acquired',
    labelNames: ['resource_type']
  });

  metrics.locksReleased = new promClient.Counter({
    name: 'distributed_lock_released_total',
    help: 'Total number of distributed locks released',
    labelNames: ['resource_type']
  });

  metrics.locksFailed = new promClient.Counter({
    name: 'distributed_lock_failed_total',
    help: 'Total number of failed lock acquisitions',
    labelNames: ['resource_type']
  });

  metrics.locksExtended = new promClient.Counter({
    name: 'distributed_lock_extended_total',
    help: 'Total number of lock extensions',
    labelNames: ['resource_type']
  });

  metrics.lockWaitTime = new promClient.Histogram({
    name: 'distributed_lock_wait_time_ms',
    help: 'Time spent waiting to acquire a lock',
    labelNames: ['resource_type'],
    buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000]
  });

  metrics.lockHeldTime = new promClient.Histogram({
    name: 'distributed_lock_held_time_ms',
    help: 'Time a lock was held',
    labelNames: ['resource_type'],
    buckets: [100, 500, 1000, 2000, 5000, 10000, 30000, 60000]
  });

  metrics.activeLocks = new promClient.Gauge({
    name: 'distributed_lock_active_count',
    help: 'Number of currently active locks',
    labelNames: ['resource_type']
  });

  metrics.deadlocksDetected = new promClient.Counter({
    name: 'distributed_lock_deadlock_detected_total',
    help: 'Total number of deadlocks detected'
  });
}

// ============================================================================
// DistributedLock 类
// ============================================================================

/**
 * Redis Redlock 分布式锁实现
 */
class DistributedLock {
  /**
   * @param {Object} config - 配置选项
   * @param {string[]} config.servers - Redis 服务器列表 ['redis1:6379', 'redis2:6379', 'redis3:6379']
   * @param {number} config.retryCount - 获取锁失败重试次数
   * @param {number} config.retryDelay - 重试间隔（毫秒）
   * @param {number} config.clockDriftFactor - 时钟漂移因子
   */
  constructor(config = {}) {
    // 初始化指标（延迟初始化，避免循环依赖）
    if (!metrics.locksAcquired) {
      try {
        initMetrics();
      } catch (err) {
        logger.warn('Prometheus metrics not initialized');
      }
    }
    
    // Redis 服务器列表（建议至少 3 个）
    this.servers = config.servers || 
      process.env.REDIS_LOCK_SERVERS?.split(',') || 
      [process.env.REDIS_URL || 'localhost:6379'];
    
    // Redlock 参数
    this.retryCount = config.retryCount ?? 3;
    this.retryDelay = config.retryDelay ?? 200;
    this.clockDriftFactor = config.clockDriftFactor ?? 0.01;
    
    // 创建 Redis 连接池
    this.clients = this.servers.map(server => {
      const [host, port] = server.split(':');
      return new Redis({
        host: host || 'localhost',
        port: parseInt(port) || 6379,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        enableOfflineQueue: true,
        lazyConnect: true
      });
    });
    
    // 最小实例数（仲裁数）
    this.quorum = Math.floor(this.clients.length / 2) + 1;
    
    // 看门狗（自动续期）管理
    this.watchdogs = new Map();
    
    // 活跃锁追踪
    this.activeLocksMap = new Map();
    
    logger.info({
      servers: this.servers,
      quorum: this.quorum,
      retryCount: this.retryCount
    }, 'DistributedLock initialized');
  }

  /**
   * 获取分布式锁
   * @param {string} resource - 资源标识（如 'pokemon:12345'）
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Object} options - 额外选项
   * @param {boolean} options.autoExtend - 是否自动续期（看门狗）
   * @param {number} options.extendInterval - 续期间隔（毫秒）
   * @param {number} options.maxExtendCount - 最大续期次数（防止无限持有）
   * @returns {Promise<Lock>} 锁对象
   */
  async acquire(resource, ttl, options = {}) {
    const {
      autoExtend = false,
      extendInterval = Math.floor(ttl / 3),
      maxExtendCount = 10
    } = options;
    
    const lockId = crypto.randomBytes(16).toString('hex');
    const key = `lock:${resource}`;
    const startTime = Date.now();
    const resourceType = this._extractResourceType(resource);
    
    let attempts = 0;
    let lastError = null;
    
    // 连接所有 Redis 客户端
    await this._ensureConnections();
    
    while (attempts <= this.retryCount) {
      try {
        // 尝试在所有 Redis 实例上获取锁
        const results = await Promise.allSettled(
          this.clients.map(client => 
            client.set(key, lockId, 'PX', ttl, 'NX')
          )
        );
        
        // 统计成功数量
        const successes = results.filter(r => 
          r.status === 'fulfilled' && r.value === 'OK'
        ).length;
        
        // 计算获取锁的耗时
        const acquisitionTime = Date.now() - startTime;
        
        // 检查是否达到仲裁数
        if (successes >= this.quorum && acquisitionTime < ttl) {
          // 计算锁的实际有效时间（考虑时钟漂移）
          const validityTime = ttl - acquisitionTime - Math.ceil(ttl * this.clockDriftFactor);
          
          if (validityTime > 0) {
            const lock = {
              resource,
              lockId,
              key,
              ttl,
              validityTime,
              acquiredAt: Date.now(),
              autoExtend,
              extendCount: 0,
              maxExtendCount,
              resourceType
            };
            
            // 启动看门狗（自动续期）
            if (autoExtend) {
              this._startWatchdog(lock, extendInterval);
            }
            
            // 追踪活跃锁
            this.activeLocksMap.set(lockId, lock);
            
            // 更新指标
            this._recordMetric('acquired', resourceType);
            this._recordMetric('waitTime', resourceType, acquisitionTime);
            if (metrics.activeLocks) {
              metrics.activeLocks.inc({ resource_type: resourceType });
            }
            
            logger.info({
              resource,
              lockId,
              ttl,
              successes,
              quorum: this.quorum,
              acquisitionTime
            }, 'Lock acquired successfully');
            
            return lock;
          }
        }
        
        // 未达到仲裁数，释放已获取的锁
        await this._releaseInternal(key, lockId);
        
        lastError = new Error(
          `Failed to acquire lock: only ${successes}/${this.clients.length} instances granted`
        );
        
      } catch (err) {
        lastError = err;
        logger.error({ err, resource, lockId }, 'Error during lock acquisition');
      }
      
      attempts++;
      
      if (attempts <= this.retryCount) {
        // 等待一段时间后重试
        await this._sleep(this.retryDelay);
      }
    }
    
    // 获取锁失败
    this._recordMetric('failed', resourceType);
    
    logger.warn({
      resource,
      lockId,
      attempts,
      lastError: lastError?.message
    }, 'Failed to acquire lock after retries');
    
    throw lastError || new Error('Failed to acquire lock');
  }

  /**
   * 释放分布式锁
   * @param {Lock} lock - 锁对象
   */
  async release(lock) {
    if (!lock || !lock.lockId) {
      throw new Error('Invalid lock object');
    }
    
    // 停止看门狗
    this._stopWatchdog(lock);
    
    const startTime = Date.now();
    
    try {
      await this._releaseInternal(lock.key, lock.lockId);
      
      // 从活跃锁中移除
      this.activeLocksMap.delete(lock.lockId);
      
      // 更新指标
      const heldTime = Date.now() - lock.acquiredAt;
      this._recordMetric('released', lock.resourceType);
      this._recordMetric('heldTime', lock.resourceType, heldTime);
      if (metrics.activeLocks) {
        metrics.activeLocks.dec({ resource_type: lock.resourceType });
      }
      
      logger.info({
        resource: lock.resource,
        lockId: lock.lockId,
        heldTime
      }, 'Lock released successfully');
      
    } catch (err) {
      logger.error({ 
        err, 
        resource: lock.resource, 
        lockId: lock.lockId 
      }, 'Error releasing lock');
      throw err;
    }
  }

  /**
   * 内部释放锁实现（使用 Lua 脚本保证原子性）
   */
  async _releaseInternal(key, lockId) {
    // Lua 脚本：仅当锁的值匹配时才删除
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    
    await Promise.all(
      this.clients.map(client => client.eval(script, 1, key, lockId))
    );
  }

  /**
   * 续期锁（延长 TTL）
   * @param {Lock} lock - 锁对象
   * @param {number} ttl - 新的过期时间（毫秒）
   */
  async extend(lock, ttl) {
    if (!lock || !lock.lockId) {
      throw new Error('Invalid lock object');
    }
    
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    
    const results = await Promise.all(
      this.clients.map(client => client.eval(script, 1, lock.key, lock.lockId, ttl))
    );
    
    const successes = results.filter(r => r === 1).length;
    
    if (successes >= this.quorum) {
      lock.ttl = ttl;
      lock.extendCount++;
      
      this._recordMetric('extended', lock.resourceType);
      
      logger.debug({
        resource: lock.resource,
        lockId: lock.lockId,
        ttl,
        extendCount: lock.extendCount
      }, 'Lock extended successfully');
      
      return true;
    }
    
    // 续期失败，锁可能已被其他进程获取
    logger.warn({
      resource: lock.resource,
      lockId: lock.lockId
    }, 'Failed to extend lock');
    
    return false;
  }

  /**
   * 使用锁执行函数（自动获取和释放）
   * @param {string} resource - 资源标识
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Function} fn - 要执行的函数
   * @param {Object} options - 额外选项
   */
  async withLock(resource, ttl, fn, options = {}) {
    const lock = await this.acquire(resource, ttl, options);
    
    try {
      const result = await fn(lock);
      return result;
    } finally {
      await this.release(lock);
    }
  }

  /**
   * 尝试获取锁（非阻塞）
   * @param {string} resource - 资源标识
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Object} options - 额外选项
   * @returns {Promise<Lock|null>} 锁对象或 null
   */
  async tryAcquire(resource, ttl, options = {}) {
    try {
      return await this.acquire(resource, ttl, { ...options, retryCount: 0 });
    } catch (err) {
      return null;
    }
  }

  /**
   * 检查锁是否存在
   */
  async isLocked(resource) {
    const key = `lock:${resource}`;
    
    await this._ensureConnections();
    
    const results = await Promise.all(
      this.clients.map(client => client.exists(key))
    );
    
    const count = results.filter(r => r === 1).length;
    return count >= this.quorum;
  }

  /**
   * 获取锁的剩余 TTL
   */
  async getTTL(resource) {
    const key = `lock:${resource}`;
    
    await this._ensureConnections();
    
    const results = await Promise.all(
      this.clients.map(client => client.pttl(key))
    );
    
    // 返回最小 TTL（最保守估计）
    const validTTLs = results.filter(ttl => ttl > 0);
    return validTTLs.length > 0 ? Math.min(...validTTLs) : -1;
  }

  /**
   * 获取锁的持有者
   */
  async getHolder(resource) {
    const key = `lock:${resource}`;
    
    await this._ensureConnections();
    
    const results = await Promise.all(
      this.clients.map(client => client.get(key))
    );
    
    // 返回多数一致的值
    const counts = new Map();
    for (const value of results) {
      if (value) {
        counts.set(value, (counts.get(value) || 0) + 1);
      }
    }
    
    for (const [value, count] of counts) {
      if (count >= this.quorum) {
        return value;
      }
    }
    
    return null;
  }

  /**
   * 启动看门狗（自动续期）
   */
  _startWatchdog(lock, interval) {
    const timer = setInterval(async () => {
      try {
        // 检查是否超过最大续期次数
        if (lock.extendCount >= lock.maxExtendCount) {
          logger.warn({
            resource: lock.resource,
            lockId: lock.lockId,
            extendCount: lock.extendCount
          }, 'Max extend count reached, stopping watchdog');
          
          this._stopWatchdog(lock);
          return;
        }
        
        // 续期锁
        const success = await this.extend(lock, lock.ttl);
        
        if (!success) {
          logger.error({
            resource: lock.resource,
            lockId: lock.lockId
          }, 'Watchdog extend failed, stopping watchdog');
          
          this._stopWatchdog(lock);
        }
      } catch (err) {
        logger.error({ 
          err, 
          resource: lock.resource 
        }, 'Watchdog error');
        this._stopWatchdog(lock);
      }
    }, interval);
    
    // 防止阻止进程退出
    timer.unref();
    
    this.watchdogs.set(lock.lockId, timer);
    
    logger.debug({
      resource: lock.resource,
      lockId: lock.lockId,
      interval
    }, 'Watchdog started');
  }

  /**
   * 停止看门狗
   */
  _stopWatchdog(lock) {
    const timer = this.watchdogs.get(lock.lockId);
    
    if (timer) {
      clearInterval(timer);
      this.watchdogs.delete(lock.lockId);
      
      logger.debug({
        resource: lock.resource,
        lockId: lock.lockId
      }, 'Watchdog stopped');
    }
  }

  /**
   * 确保所有 Redis 客户端已连接
   */
  async _ensureConnections() {
    await Promise.all(
      this.clients.map(client => {
        if (client.status !== 'ready') {
          return client.connect().catch(() => {});
        }
        return Promise.resolve();
      })
    );
  }

  /**
   * 提取资源类型（用于指标标签）
   */
  _extractResourceType(resource) {
    const parts = resource.split(':');
    return parts[0] || 'unknown';
  }

  /**
   * 记录指标
   */
  _recordMetric(type, resourceType, value) {
    try {
      switch (type) {
        case 'acquired':
          metrics.locksAcquired?.inc({ resource_type: resourceType });
          break;
        case 'released':
          metrics.locksReleased?.inc({ resource_type: resourceType });
          break;
        case 'failed':
          metrics.locksFailed?.inc({ resource_type: resourceType });
          break;
        case 'extended':
          metrics.locksExtended?.inc({ resource_type: resourceType });
          break;
        case 'waitTime':
          metrics.lockWaitTime?.observe({ resource_type: resourceType }, value);
          break;
        case 'heldTime':
          metrics.lockHeldTime?.observe({ resource_type: resourceType }, value);
          break;
      }
    } catch (err) {
      // 忽略指标错误
    }
  }

  /**
   * 睡眠函数
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      servers: this.servers.length,
      quorum: this.quorum,
      activeLocks: this.activeLocksMap.size,
      activeWatchdogs: this.watchdogs.size
    };
  }

  /**
   * 关闭所有 Redis 连接
   */
  async close() {
    // 停止所有看门狗
    for (const timer of this.watchdogs.values()) {
      clearInterval(timer);
    }
    this.watchdogs.clear();
    this.activeLocksMap.clear();
    
    // 关闭所有 Redis 连接
    await Promise.all(
      this.clients.map(client => client.quit().catch(() => {}))
    );
    
    logger.info('DistributedLock closed');
  }
}

// ============================================================================
// ReadWriteLock 类
// ============================================================================

/**
 * 读写锁实现
 */
class ReadWriteLock {
  constructor(distributedLock) {
    this.lock = distributedLock;
  }

  /**
   * 获取读锁（共享锁）
   */
  async acquireRead(resource, ttl, options = {}) {
    const readLockKey = `${resource}:read`;
    const writeLockKey = `${resource}:write`;
    
    // 检查是否有写锁
    const hasWriteLock = await this.lock.isLocked(writeLockKey);
    
    if (hasWriteLock) {
      throw new Error('Resource is locked for writing');
    }
    
    return await this.lock.acquire(readLockKey, ttl, options);
  }

  /**
   * 获取写锁（排他锁）
   */
  async acquireWrite(resource, ttl, options = {}) {
    const readLockKey = `${resource}:read`;
    const writeLockKey = `${resource}:write`;
    
    // 检查是否有读锁或写锁
    const hasReadLock = await this.lock.isLocked(readLockKey);
    const hasWriteLock = await this.lock.isLocked(writeLockKey);
    
    if (hasReadLock || hasWriteLock) {
      throw new Error('Resource is already locked');
    }
    
    return await this.lock.acquire(writeLockKey, ttl, options);
  }

  /**
   * 释放读锁
   */
  async releaseRead(lock) {
    await this.lock.release(lock);
  }

  /**
   * 释放写锁
   */
  async releaseWrite(lock) {
    await this.lock.release(lock);
  }
}

// ============================================================================
// ReentrantLock 类
// ============================================================================

/**
 * 可重入锁实现
 */
class ReentrantLock {
  constructor(distributedLock) {
    this.lock = distributedLock;
    this.localLocks = new Map(); // 本地进程锁计数
  }

  /**
   * 获取可重入锁
   */
  async acquire(resource, ttl, options = {}) {
    const threadId = process.pid;
    const key = `${resource}:${threadId}`;
    
    // 检查是否已持有锁
    const localLock = this.localLocks.get(key);
    
    if (localLock) {
      // 重入，增加计数
      localLock.count++;
      return localLock.lock;
    }
    
    // 获取新锁
    const lock = await this.lock.acquire(resource, ttl, options);
    
    this.localLocks.set(key, { lock, count: 1 });
    
    return lock;
  }

  /**
   * 释放可重入锁
   */
  async release(lock) {
    const threadId = process.pid;
    const key = `${lock.resource}:${threadId}`;
    
    const localLock = this.localLocks.get(key);
    
    if (!localLock) {
      throw new Error('Lock not held by current process');
    }
    
    // 减少计数
    localLock.count--;
    
    if (localLock.count === 0) {
      // 计数为 0，释放锁
      this.localLocks.delete(key);
      await this.lock.release(lock);
    }
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let lockInstance = null;

/**
 * 获取分布式锁单例实例
 */
function getDistributedLock(config = {}) {
  if (!lockInstance) {
    lockInstance = new DistributedLock(config);
  }
  return lockInstance;
}

/**
 * 重置单例实例（用于测试）
 */
function resetDistributedLock() {
  if (lockInstance) {
    lockInstance.close().catch(() => {});
    lockInstance = null;
  }
}

// ============================================================================
// 模块导出
// ============================================================================

module.exports = {
  DistributedLock,
  ReadWriteLock,
  ReentrantLock,
  getDistributedLock,
  resetDistributedLock,
  metrics
};
