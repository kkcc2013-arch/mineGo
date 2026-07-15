/**
 * DistributedLock - Redis Redlock 分布式锁实现
 * 
 * 基于 Redlock 算法，提供生产级分布式锁服务。
 * 支持自动续期、可重入锁、读写锁等功能。
 * 
 * @module backend/shared/distributedLock
 * @see https://redis.io/topics/distlock
 */

'use strict';

const Redis = require('ioredis');
const crypto = require('crypto');

// 延迟加载依赖，避免循环引用
let logger = null;
let metrics = null;

function getLogger() {
  if (!logger) {
    try {
      logger = require('./logger').createLogger('distributed-lock');
    } catch (e) {
      logger = {
        info: (obj, msg) => console.log(`[INFO] ${msg}`, obj),
        warn: (obj, msg) => console.warn(`[WARN] ${msg}`, obj),
        error: (obj, msg) => console.error(`[ERROR] ${msg}`, obj),
        debug: (obj, msg) => process.env.DEBUG && console.log(`[DEBUG] ${msg}`, obj)
      };
    }
  }
  return logger;
}

function getMetrics() {
  if (!metrics) {
    try {
      metrics = require('./distributedLockMetrics');
    } catch (e) {
      // 返回空操作指标
      metrics = {
        locksAcquired: { inc: () => {} },
        locksReleased: { inc: () => {} },
        locksFailed: { inc: () => {} },
        locksExtended: { inc: () => {} },
        lockWaitTime: { observe: () => {} },
        lockHeldTime: { observe: () => {} },
        activeLocks: { inc: () => {}, dec: () => {} },
        deadlocksDetected: { inc: () => {} }
      };
    }
  }
  return metrics;
}

/**
 * 分布式锁类
 */
class DistributedLock {
  /**
   * @param {Object} config - 配置选项
   * @param {string[]} [config.servers] - Redis 服务器列表
   * @param {number} [config.retryCount] - 获取锁失败重试次数
   * @param {number} [config.retryDelay] - 重试间隔（毫秒）
   * @param {number} [config.clockDriftFactor] - 时钟漂移因子
   * @param {Object} [config.redisOptions] - Redis 连接选项
   */
  constructor(config = {}) {
    const log = getLogger();
    
    // Redis 服务器列表（建议至少 3 个）
    const servers = config.servers || 
      process.env.REDIS_LOCK_SERVERS?.split(',') || 
      [process.env.REDIS_URL || 'localhost:6379'];
    
    this.servers = servers;
    this.retryCount = config.retryCount ?? 3;
    this.retryDelay = config.retryDelay ?? 200;
    this.clockDriftFactor = config.clockDriftFactor ?? 0.01;
    
    // Redis 连接选项
    const redisOptions = config.redisOptions || {};
    
    // 创建 Redis 连接池
    this.clients = servers.map(server => {
      const [host, port] = server.split(':');
      return new Redis({
        host: host || 'localhost',
        port: parseInt(port) || 6379,
        password: redisOptions.password || process.env.REDIS_PASSWORD,
        db: redisOptions.db || 0,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        enableOfflineQueue: true,
        retryStrategy: (times) => {
          if (times > 10) {
            log.error({ server, times }, 'Redis connection failed after 10 retries');
            return null;
          }
          return Math.min(times * 100, 3000);
        }
      });
    });
    
    // 最小仲裁实例数
    this.quorum = Math.floor(this.clients.length / 2) + 1;
    
    // 看门狗（自动续期）管理
    this.watchdogs = new Map();
    
    // 本地锁追踪（用于可重入锁）
    this.localLocks = new Map();
    
    // 死锁检测
    this.lockWaitGraph = new Map();
    
    log.info({
      servers: this.servers,
      quorum: this.quorum,
      retryCount: this.retryCount
    }, 'DistributedLock initialized');
  }

  /**
   * 获取分布式锁
   * @param {string} resource - 资源标识（如 'pokemon:12345'）
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Object} [options] - 额外选项
   * @param {boolean} [options.autoExtend] - 是否自动续期（看门狗）
   * @param {number} [options.extendInterval] - 续期间隔（毫秒）
   * @param {number} [options.maxExtendCount] - 最大续期次数
   * @returns {Promise<Lock>} 锁对象
   */
  async acquire(resource, ttl, options = {}) {
    const log = getLogger();
    const m = getMetrics();
    
    const {
      autoExtend = false,
      extendInterval = Math.floor(ttl / 3),
      maxExtendCount = 10
    } = options;
    
    const lockId = crypto.randomBytes(16).toString('hex');
    const key = `lock:${resource}`;
    const startTime = Date.now();
    
    let attempts = 0;
    let lastError = null;
    
    while (attempts <= this.retryCount) {
      try {
        // 尝试在所有 Redis 实例上获取锁
        const results = await Promise.allSettled(
          this.clients.map(client => 
            client.set(key, lockId, 'PX', ttl, 'NX')
          )
        );
        
        // 统计成功数量
        const successes = results.filter(
          r => r.status === 'fulfilled' && r.value === 'OK'
        ).length;
        
        // 计算获取锁的耗时
        const acquisitionTime = Date.now() - startTime;
        
        // 计算锁的有效时间（考虑时钟漂移）
        const validityTime = ttl - acquisitionTime - Math.ceil(ttl * this.clockDriftFactor);
        
        // 检查是否达到仲裁数且有效时间足够
        if (successes >= this.quorum && validityTime > 0) {
          const lock = {
            resource,
            lockId,
            key,
            ttl,
            validityTime,
            acquiredAt: Date.now(),
            autoExtend,
            extendCount: 0,
            maxExtendCount
          };
          
          // 启动看门狗（自动续期）
          if (autoExtend) {
            this._startWatchdog(lock, extendInterval);
          }
          
          // 更新指标
          m.locksAcquired.inc({ resource });
          m.lockWaitTime.observe({ resource }, acquisitionTime);
          m.activeLocks.inc({ resource });
          
          log.info({
            resource,
            lockId,
            ttl,
            successes,
            quorum: this.quorum,
            acquisitionTime,
            validityTime
          }, 'Lock acquired successfully');
          
          return lock;
        }
        
        // 未达到仲裁数，释放已获取的锁
        await this._releaseInternal(key, lockId);
        
        lastError = new Error(
          `Failed to acquire lock: only ${successes}/${this.clients.length} instances granted, need ${this.quorum}`
        );
        
      } catch (err) {
        lastError = err;
        log.error({ err, resource, lockId }, 'Error during lock acquisition');
      }
      
      attempts++;
      
      if (attempts <= this.retryCount) {
        // 添加随机抖动避免惊群效应
        const jitter = Math.random() * 0.1 * this.retryDelay;
        await this._sleep(this.retryDelay + jitter);
      }
    }
    
    // 获取锁失败
    m.locksFailed.inc({ resource });
    
    log.warn({
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
   * @returns {Promise<boolean>} 是否成功释放
   */
  async release(lock) {
    const log = getLogger();
    const m = getMetrics();
    
    if (!lock || !lock.lockId) {
      throw new Error('Invalid lock object');
    }
    
    // 停止看门狗
    this._stopWatchdog(lock);
    
    try {
      await this._releaseInternal(lock.key, lock.lockId);
      
      // 更新指标
      const heldTime = Date.now() - lock.acquiredAt;
      m.locksReleased.inc({ resource: lock.resource });
      m.lockHeldTime.observe({ resource: lock.resource }, heldTime);
      m.activeLocks.dec({ resource: lock.resource });
      
      log.info({
        resource: lock.resource,
        lockId: lock.lockId,
        heldTime
      }, 'Lock released successfully');
      
      return true;
    } catch (err) {
      log.error({ err, resource: lock.resource, lockId: lock.lockId }, 'Error releasing lock');
      throw err;
    }
  }

  /**
   * 内部释放锁实现（使用 Lua 脚本保证原子性）
   * @private
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
    
    await Promise.allSettled(
      this.clients.map(client => client.eval(script, 1, key, lockId))
    );
  }

  /**
   * 续期锁（延长 TTL）
   * @param {Lock} lock - 锁对象
   * @param {number} ttl - 新的过期时间（毫秒）
   * @returns {Promise<boolean>} 是否成功续期
   */
  async extend(lock, ttl) {
    const log = getLogger();
    const m = getMetrics();
    
    if (!lock || !lock.lockId) {
      throw new Error('Invalid lock object');
    }
    
    // Lua 脚本：仅当锁的值匹配时才续期
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    
    const results = await Promise.allSettled(
      this.clients.map(client => client.eval(script, 1, lock.key, lock.lockId, ttl))
    );
    
    const successes = results.filter(
      r => r.status === 'fulfilled' && r.value === 1
    ).length;
    
    if (successes >= this.quorum) {
      lock.ttl = ttl;
      lock.extendCount++;
      
      m.locksExtended.inc({ resource: lock.resource });
      
      log.debug({
        resource: lock.resource,
        lockId: lock.lockId,
        ttl,
        extendCount: lock.extendCount
      }, 'Lock extended successfully');
      
      return true;
    }
    
    log.warn({
      resource: lock.resource,
      lockId: lock.lockId,
      successes,
      quorum: this.quorum
    }, 'Failed to extend lock');
    
    return false;
  }

  /**
   * 启动看门狗（自动续期）
   * @private
   */
  _startWatchdog(lock, interval) {
    const log = getLogger();
    const m = getMetrics();
    
    const timer = setInterval(async () => {
      try {
        // 检查是否超过最大续期次数
        if (lock.extendCount >= lock.maxExtendCount) {
          log.warn({
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
          log.error({
            resource: lock.resource,
            lockId: lock.lockId
          }, 'Watchdog extend failed, stopping watchdog');
          
          this._stopWatchdog(lock);
        }
      } catch (err) {
        log.error({ err, resource: lock.resource }, 'Watchdog error');
        this._stopWatchdog(lock);
      }
    }, interval);
    
    // 允许进程退出时不等待定时器
    timer.unref();
    
    this.watchdogs.set(lock.lockId, timer);
    
    log.debug({
      resource: lock.resource,
      lockId: lock.lockId,
      interval
    }, 'Watchdog started');
  }

  /**
   * 停止看门狗
   * @private
   */
  _stopWatchdog(lock) {
    const timer = this.watchdogs.get(lock.lockId);
    
    if (timer) {
      clearInterval(timer);
      this.watchdogs.delete(lock.lockId);
      
      getLogger().debug({
        resource: lock.resource,
        lockId: lock.lockId
      }, 'Watchdog stopped');
    }
  }

  /**
   * 使用锁执行函数（自动获取和释放）
   * @param {string} resource - 资源标识
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Function} fn - 要执行的函数
   * @param {Object} [options] - 额外选项
   * @returns {Promise<any>} 函数执行结果
   */
  async withLock(resource, ttl, fn, options = {}) {
    const lock = await this.acquire(resource, ttl, options);
    
    try {
      return await fn(lock);
    } finally {
      await this.release(lock);
    }
  }

  /**
   * 尝试获取锁（非阻塞）
   * @param {string} resource - 资源标识
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Object} [options] - 额外选项
   * @returns {Promise<Lock|null>} 锁对象或 null
   */
  async tryAcquire(resource, ttl, options = {}) {
    try {
      return await this.acquire(resource, ttl, { ...options, retryCount: 0 });
    } catch {
      return null;
    }
  }

  /**
   * 检查锁是否存在
   * @param {string} resource - 资源标识
   * @returns {Promise<boolean>} 锁是否存在
   */
  async isLocked(resource) {
    const key = `lock:${resource}`;
    
    const results = await Promise.allSettled(
      this.clients.map(client => client.exists(key))
    );
    
    const count = results.filter(
      r => r.status === 'fulfilled' && r.value === 1
    ).length;
    
    return count >= this.quorum;
  }

  /**
   * 获取锁的剩余 TTL
   * @param {string} resource - 资源标识
   * @returns {Promise<number>} 剩余 TTL（毫秒），-1 表示不存在，-2 表示无过期时间
   */
  async getTTL(resource) {
    const key = `lock:${resource}`;
    
    const results = await Promise.allSettled(
      this.clients.map(client => client.pttl(key))
    );
    
    // 返回最小 TTL（最保守估计）
    const validTTLs = results
      .filter(r => r.status === 'fulfilled' && r.value > 0)
      .map(r => r.value);
    
    return validTTLs.length > 0 ? Math.min(...validTTLs) : -1;
  }

  /**
   * 睡眠函数
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 关闭所有 Redis 连接
   */
  async close() {
    const log = getLogger();
    
    // 停止所有看门狗
    for (const timer of this.watchdogs.values()) {
      clearInterval(timer);
    }
    this.watchdogs.clear();
    
    // 关闭所有 Redis 连接
    await Promise.allSettled(
      this.clients.map(client => client.quit())
    );
    
    log.info('DistributedLock closed');
  }

  /**
   * 获取健康状态
   * @returns {Promise<Object>} 健康状态
   */
  async getHealth() {
    const results = await Promise.allSettled(
      this.clients.map((client, i) => client.ping().then(() => ({ index: i, status: 'ok' })))
    );
    
    const healthy = results.filter(r => r.status === 'fulfilled').length;
    
    return {
      status: healthy >= this.quorum ? 'healthy' : 'unhealthy',
      servers: this.servers.length,
      healthy: healthy,
      quorum: this.quorum,
      details: results.map((r, i) => ({
        server: this.servers[i],
        status: r.status === 'fulfilled' ? 'ok' : 'error',
        error: r.status === 'rejected' ? r.reason?.message : null
      }))
    };
  }
}

/**
 * 读写锁实现
 */
class ReadWriteLock {
  /**
   * @param {DistributedLock} distributedLock
   */
  constructor(distributedLock) {
    this.lock = distributedLock;
  }

  /**
   * 获取读锁（共享锁）
   * @param {string} resource - 资源标识
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Object} [options] - 额外选项
   * @returns {Promise<Lock>}
   */
  async acquireRead(resource, ttl, options = {}) {
    const readLockKey = `lock:${resource}:read`;
    const writeLockKey = `lock:${resource}:write`;
    
    // 检查是否有写锁
    const hasWriteLock = await this.lock.isLocked(writeLockKey);
    
    if (hasWriteLock) {
      throw new Error('Resource is locked for writing');
    }
    
    return await this.lock.acquire(readLockKey, ttl, options);
  }

  /**
   * 获取写锁（排他锁）
   * @param {string} resource - 资源标识
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Object} [options] - 额外选项
   * @returns {Promise<Lock>}
   */
  async acquireWrite(resource, ttl, options = {}) {
    const readLockKey = `lock:${resource}:read`;
    const writeLockKey = `lock:${resource}:write`;
    
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
   * @param {Lock} lock
   */
  async releaseRead(lock) {
    await this.lock.release(lock);
  }

  /**
   * 释放写锁
   * @param {Lock} lock
   */
  async releaseWrite(lock) {
    await this.lock.release(lock);
  }

  /**
   * 使用读锁执行函数
   */
  async withReadLock(resource, ttl, fn, options = {}) {
    const lock = await this.acquireRead(resource, ttl, options);
    try {
      return await fn(lock);
    } finally {
      await this.releaseRead(lock);
    }
  }

  /**
   * 使用写锁执行函数
   */
  async withWriteLock(resource, ttl, fn, options = {}) {
    const lock = await this.acquireWrite(resource, ttl, options);
    try {
      return await fn(lock);
    } finally {
      await this.releaseWrite(lock);
    }
  }
}

/**
 * 可重入锁实现
 */
class ReentrantLock {
  /**
   * @param {DistributedLock} distributedLock
   */
  constructor(distributedLock) {
    this.lock = distributedLock;
    this.localLocks = new Map(); // 本地线程锁计数
  }

  /**
   * 获取可重入锁
   * @param {string} resource - 资源标识
   * @param {number} ttl - 锁的过期时间（毫秒）
   * @param {Object} [options] - 额外选项
   * @returns {Promise<Lock>}
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
   * @param {Lock} lock
   */
  async release(lock) {
    const threadId = process.pid;
    const key = `${lock.resource}:${threadId}`;
    
    const localLock = this.localLocks.get(key);
    
    if (!localLock) {
      throw new Error('Lock not held by current thread');
    }
    
    // 减少计数
    localLock.count--;
    
    if (localLock.count === 0) {
      // 计数为 0，释放锁
      this.localLocks.delete(key);
      await this.lock.release(lock);
    }
  }

  /**
   * 使用可重入锁执行函数
   */
  async withLock(resource, ttl, fn, options = {}) {
    const lock = await this.acquire(resource, ttl, options);
    try {
      return await fn(lock);
    } finally {
      await this.release(lock);
    }
  }

  /**
   * 获取当前持有锁的计数
   * @param {string} resource
   * @returns {number}
   */
  getHoldCount(resource) {
    const threadId = process.pid;
    const key = `${resource}:${threadId}`;
    const localLock = this.localLocks.get(key);
    return localLock ? localLock.count : 0;
  }
}

// 单例实例
let lockInstance = null;
let readWriteLockInstance = null;
let reentrantLockInstance = null;

/**
 * 获取分布式锁单例实例
 * @param {Object} [config] - 配置选项
 * @returns {DistributedLock}
 */
function getDistributedLock(config = {}) {
  if (!lockInstance) {
    lockInstance = new DistributedLock(config);
  }
  return lockInstance;
}

/**
 * 获取读写锁实例
 * @param {Object} [config] - 配置选项
 * @returns {ReadWriteLock}
 */
function getReadWriteLock(config = {}) {
  if (!readWriteLockInstance) {
    readWriteLockInstance = new ReadWriteLock(getDistributedLock(config));
  }
  return readWriteLockInstance;
}

/**
 * 获取可重入锁实例
 * @param {Object} [config] - 配置选项
 * @returns {ReentrantLock}
 */
function getReentrantLock(config = {}) {
  if (!reentrantLockInstance) {
    reentrantLockInstance = new ReentrantLock(getDistributedLock(config));
  }
  return reentrantLockInstance;
}

/**
 * 重置单例实例（用于测试）
 */
function resetInstances() {
  lockInstance = null;
  readWriteLockInstance = null;
  reentrantLockInstance = null;
}

module.exports = {
  DistributedLock,
  ReadWriteLock,
  ReentrantLock,
  getDistributedLock,
  getReadWriteLock,
  getReentrantLock,
  resetInstances
};
