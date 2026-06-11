# REQ-00105：分布式锁服务与 Redis Redlock 实现

- **编号**：REQ-00105
- **类别**：容灾/高可用
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared/distributedLock.js、所有微服务、Redis
- **创建时间**：2026-06-11 05:15
- **依赖需求**：REQ-00070（Redis 内存优化）、REQ-00088（Redis 连接池管理）

## 1. 背景与问题

当前 mineGo 项目缺少分布式锁服务，在多实例部署环境下存在严重的并发问题：

### 1.1 已识别的并发竞态条件

1. **精灵捕捉竞态**（catch-service）
   - 同一野生精灵可能被多个玩家同时捕捉
   - 当前依赖数据库唯一约束，但无法保证原子性操作
   - 可能导致精灵数据不一致

2. **道馆占领竞态**（gym-service）
   - 多个玩家可能同时占领同一道馆
   - 当前缺乏互斥机制，可能导致道馆状态混乱
   - 影响游戏公平性

3. **精灵交易竞态**（social-service）
   - REQ-00018 中实现了简单的 `lockTrade()` 但缺乏分布式支持
   - 同一精灵可能被用于多次交易
   - 交易过程中精灵状态不一致

4. **支付订单处理**（payment-service）
   - 回调处理缺乏幂等性保护
   - 同一订单可能被处理多次
   - 虽有 idempotencyKey，但多实例可能同时处理

5. **活动奖励发放**（reward-service）
   - 同一活动奖励可能被重复发放
   - 缺乏全局互斥保护

### 1.2 当前方案的局限性

- 数据库行锁（`SELECT ... FOR UPDATE`）仅适用于单数据库场景
- 无超时机制，锁可能永久持有
- 无自动续期功能，长任务可能提前释放锁
- 缺乏锁的可观测性（无法监控锁竞争情况）

## 2. 目标

实现生产级分布式锁服务，基于 Redis Redlock 算法，确保：

1. **高可用性**：支持多 Redis 实例，容忍单点故障
2. **安全性**：避免死锁，自动过期释放
3. **公平性**：先进先出队列，避免饥饿
4. **可观测性**：完整的 Prometheus 指标监控
5. **易用性**：简洁的 API 设计，支持自动续期

预期收益：
- 消除 100% 的并发竞态问题
- 避免数据不一致导致的玩家投诉
- 提升系统稳定性和可靠性

## 3. 范围

### 包含

- Redis Redlock 分布式锁核心实现
- 自动续期（看门狗）机制
- 多种锁模式（互斥锁、读写锁、可重入锁）
- 死锁检测与告警
- Prometheus 指标监控
- 完整的单元测试和集成测试

### 不包含

- ZooKeeper 分布式锁（Redis 已满足需求）
- 数据库分布式锁（性能较低）
- 分布式事务协调（由 REQ-00096 覆盖）

## 4. 详细需求

### 4.1 Redis Redlock 核心实现

基于 [Redlock 算法](https://redis.io/topics/distlock)，使用至少 3 个 Redis 实例确保高可用。

```javascript
// backend/shared/distributedLock.js

const Redis = require('ioredis');
const { createLogger } = require('./logger');
const { incrementCounter, observeHistogram, gauge } = require('./metrics');
const crypto = require('crypto');

const logger = createLogger('distributed-lock');

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
    // Redis 服务器列表（建议至少 3 个）
    this.servers = config.servers || 
      process.env.REDIS_LOCK_SERVERS?.split(',') || 
      [process.env.REDIS_URL || 'localhost:6379'];
    
    // Redlock 参数
    this.retryCount = config.retryCount || 3;
    this.retryDelay = config.retryDelay || 200;
    this.clockDriftFactor = config.clockDriftFactor || 0.01;
    
    // 创建 Redis 连接池
    this.clients = this.servers.map(server => {
      const [host, port] = server.split(':');
      return new Redis({
        host: host || 'localhost',
        port: parseInt(port) || 6379,
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        enableOfflineQueue: true,
      });
    });
    
    // 最小实例数
    this.quorum = Math.floor(this.clients.length / 2) + 1;
    
    // 看门狗（自动续期）管理
    this.watchdogs = new Map();
    
    // 指标
    this.metrics = {
      locksAcquired: new Map(),
      locksReleased: new Map(),
      lockWaitTime: new Map(),
      lockHeldTime: new Map(),
    };
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
      extendInterval = ttl / 3,
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
        const successes = results.filter(r => r.status === 'fulfilled' && r.value === 'OK').length;
        
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
              maxExtendCount
            };
            
            // 启动看门狗（自动续期）
            if (autoExtend) {
              this.startWatchdog(lock, extendInterval);
            }
            
            // 更新指标
            incrementCounter('distributed_lock_acquired_total', { resource });
            observeHistogram('distributed_lock_wait_time_ms', acquisitionTime, { resource });
            
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
        await this.releaseInternal(key, lockId);
        
        lastError = new Error(`Failed to acquire lock: only ${successes}/${this.clients.length} instances granted`);
        
      } catch (err) {
        lastError = err;
        logger.error({ err, resource, lockId }, 'Error during lock acquisition');
      }
      
      attempts++;
      
      if (attempts <= this.retryCount) {
        // 等待一段时间后重试
        await this.sleep(this.retryDelay);
      }
    }
    
    // 获取锁失败
    incrementCounter('distributed_lock_failed_total', { resource });
    
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
    this.stopWatchdog(lock);
    
    const startTime = Date.now();
    
    try {
      await this.releaseInternal(lock.key, lock.lockId);
      
      // 更新指标
      const heldTime = Date.now() - lock.acquiredAt;
      incrementCounter('distributed_lock_released_total', { resource: lock.resource });
      observeHistogram('distributed_lock_held_time_ms', heldTime, { resource: lock.resource });
      
      logger.info({
        resource: lock.resource,
        lockId: lock.lockId,
        heldTime
      }, 'Lock released successfully');
      
    } catch (err) {
      logger.error({ err, resource: lock.resource, lockId: lock.lockId }, 'Error releasing lock');
      throw err;
    }
  }

  /**
   * 内部释放锁实现（使用 Lua 脚本保证原子性）
   */
  async releaseInternal(key, lockId) {
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
      
      incrementCounter('distributed_lock_extended_total', { resource: lock.resource });
      
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
   * 启动看门狗（自动续期）
   */
  startWatchdog(lock, interval) {
    const timer = setInterval(async () => {
      try {
        // 检查是否超过最大续期次数
        if (lock.extendCount >= lock.maxExtendCount) {
          logger.warn({
            resource: lock.resource,
            lockId: lock.lockId,
            extendCount: lock.extendCount
          }, 'Max extend count reached, stopping watchdog');
          
          this.stopWatchdog(lock);
          return;
        }
        
        // 续期锁
        const success = await this.extend(lock, lock.ttl);
        
        if (!success) {
          logger.error({
            resource: lock.resource,
            lockId: lock.lockId
          }, 'Watchdog extend failed, stopping watchdog');
          
          this.stopWatchdog(lock);
        }
      } catch (err) {
        logger.error({ err, resource: lock.resource }, 'Watchdog error');
        this.stopWatchdog(lock);
      }
    }, interval);
    
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
  stopWatchdog(lock) {
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
    
    const results = await Promise.all(
      this.clients.map(client => client.pttl(key))
    );
    
    // 返回最小 TTL（最保守估计）
    const validTTLs = results.filter(ttl => ttl > 0);
    return validTTLs.length > 0 ? Math.min(...validTTLs) : -1;
  }

  /**
   * 睡眠函数
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 关闭所有 Redis 连接
   */
  async close() {
    await Promise.all(this.clients.map(client => client.quit()));
    
    // 停止所有看门狗
    for (const timer of this.watchdogs.values()) {
      clearInterval(timer);
    }
    this.watchdogs.clear();
    
    logger.info('DistributedLock closed');
  }
}

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

/**
 * 可重入锁实现
 */
class ReentrantLock {
  constructor(distributedLock) {
    this.lock = distributedLock;
    this.localLocks = new Map(); // 本地线程锁计数
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
}

// 单例实例
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

module.exports = {
  DistributedLock,
  ReadWriteLock,
  ReentrantLock,
  getDistributedLock
};
```

### 4.2 Express 中间件集成

```javascript
// backend/shared/distributedLockMiddleware.js

const { getDistributedLock } = require('./distributedLock');
const { createLogger } = require('./logger');

const logger = createLogger('lock-middleware');

/**
 * 分布式锁中间件工厂
 * @param {string} resourceKey - 资源键表达式（如 'pokemon:req.params.id'）
 * @param {number} ttl - 锁的过期时间（毫秒）
 * @param {Object} options - 额外选项
 */
function lockMiddleware(resourceKey, ttl, options = {}) {
  const lock = getDistributedLock();
  
  return async (req, res, next) => {
    // 解析资源键
    const resource = resourceKey
      .replace(/req\.params\.(\w+)/g, (_, key) => req.params[key])
      .replace(/req\.body\.(\w+)/g, (_, key) => req.body[key]);
    
    try {
      // 尝试获取锁
      const lockObj = await lock.acquire(resource, ttl, options);
      
      // 将锁对象附加到请求
      req.lock = lockObj;
      
      // 监听响应完成事件，自动释放锁
      res.on('finish', async () => {
        try {
          await lock.release(lockObj);
        } catch (err) {
          logger.error({ err, resource }, 'Failed to release lock on response finish');
        }
      });
      
      next();
    } catch (err) {
      logger.error({ err, resource }, 'Failed to acquire lock');
      
      if (err.message.includes('Failed to acquire lock')) {
        return res.status(409).json({
          success: false,
          error: 'Resource is currently locked, please retry later',
          code: 'RESOURCE_LOCKED'
        });
      }
      
      next(err);
    }
  };
}

/**
 * 自动重试中间件（针对锁冲突）
 */
function retryOnLockMiddleware(maxRetries = 3, retryDelay = 100) {
  return async (req, res, next) => {
    let attempts = 0;
    
    const attemptRequest = async () => {
      try {
        return await new Promise((resolve, reject) => {
          res.once('finish', resolve);
          res.once('error', reject);
          next();
        });
      } catch (err) {
        if (err.code === 'RESOURCE_LOCKED' && attempts < maxRetries) {
          attempts++;
          await new Promise(resolve => setTimeout(resolve, retryDelay * attempts));
          return attemptRequest();
        }
        throw err;
      }
    };
    
    await attemptRequest();
  };
}

module.exports = {
  lockMiddleware,
  retryOnLockMiddleware
};
```

### 4.3 具体业务场景集成示例

#### 4.3.1 精灵捕捉（catch-service）

```javascript
// backend/services/catch-service/src/index.js

const { getDistributedLock } = require('../../../shared/distributedLock');

// 捕捉野生精灵
router.post('/catch/:pokemonId', requireAuth, async (req, res) => {
  const lock = getDistributedLock();
  const { pokemonId } = req.params;
  const userId = req.user.sub;
  
  try {
    // 使用分布式锁保护捕捉操作
    await lock.withLock(
      `pokemon:catch:${pokemonId}`,
      10000, // 10 秒超时
      { autoExtend: true, maxExtendCount: 5 },
      async () => {
        // 检查精灵是否存在且未被捕捉
        const pokemon = await query(
          'SELECT * FROM wild_pokemon WHERE id = $1 AND status = $2',
          [pokemonId, 'active']
        );
        
        if (!pokemon) {
          throw new AppError(4001, '精灵不存在或已被捕捉', 404);
        }
        
        // 执行捕捉逻辑
        const result = await performCatch(userId, pokemon);
        
        return result;
      }
    );
    
    res.json(successResp({ caught: true }));
  } catch (err) {
    if (err.message.includes('Failed to acquire lock')) {
      return res.status(409).json({
        success: false,
        error: '精灵正在被其他玩家捕捉，请稍后重试',
        code: 'POKEMON_CATCH_IN_PROGRESS'
      });
    }
    
    next(err);
  }
});
```

#### 4.3.2 道馆占领（gym-service）

```javascript
// backend/services/gym-service/src/index.js

const { getDistributedLock } = require('../../../shared/distributedLock');

// 占领道馆
router.post('/gym/:gymId/claim', requireAuth, async (req, res) => {
  const lock = getDistributedLock();
  const { gymId } = req.params;
  const userId = req.user.sub;
  
  try {
    // 使用分布式锁保护占领操作
    await lock.withLock(
      `gym:claim:${gymId}`,
      15000, // 15 秒超时
      { autoExtend: true },
      async () => {
        // 检查道馆状态
        const gym = await query('SELECT * FROM gyms WHERE id = $1', [gymId]);
        
        if (gym.owner_id === userId) {
          throw new AppError(6001, '你已经占领了这个道馆', 400);
        }
        
        // 执行占领逻辑
        const result = await claimGym(userId, gym);
        
        return result;
      }
    );
    
    res.json(successResp({ claimed: true }));
  } catch (err) {
    if (err.message.includes('Failed to acquire lock')) {
      return res.status(409).json({
        success: false,
        error: '道馆正在被其他玩家占领，请稍后重试',
        code: 'GYM_CLAIM_IN_PROGRESS'
      });
    }
    
    next(err);
  }
});
```

#### 4.3.3 精灵交易（social-service）

```javascript
// backend/services/social-service/src/routes/trade.js

const { getDistributedLock } = require('../../../shared/distributedLock');

// 执行交易
router.post('/trade/:tradeId/execute', requireAuth, async (req, res) => {
  const lock = getDistributedLock();
  const { tradeId } = req.params;
  const userId = req.user.sub;
  
  try {
    // 获取交易信息
    const trade = await query('SELECT * FROM trades WHERE id = $1', [tradeId]);
    
    if (!trade) {
      throw new AppError(7001, '交易不存在', 404);
    }
    
    // 同时锁定两个精灵，避免交叉交易
    const pokemon1Lock = await lock.acquire(`pokemon:trade:${trade.pokemon1_id}`, 10000);
    const pokemon2Lock = await lock.acquire(`pokemon:trade:${trade.pokemon2_id}`, 10000);
    
    try {
      // 执行交易逻辑
      const result = await executeTrade(trade);
      
      res.json(successResp(result));
    } finally {
      // 释放锁（顺序不重要）
      await lock.release(pokemon2Lock);
      await lock.release(pokemon1Lock);
    }
  } catch (err) {
    if (err.message.includes('Failed to acquire lock')) {
      return res.status(409).json({
        success: false,
        error: '精灵正在参与其他交易，请稍后重试',
        code: 'POKEMON_TRADE_IN_PROGRESS'
      });
    }
    
    next(err);
  }
});
```

### 4.4 Prometheus 指标

```javascript
// backend/shared/distributedLockMetrics.js

const promClient = require('prom-client');

const lockMetrics = {
  // 锁获取成功次数
  locksAcquired: new promClient.Counter({
    name: 'distributed_lock_acquired_total',
    help: 'Total number of distributed locks acquired',
    labelNames: ['resource']
  }),

  // 锁释放次数
  locksReleased: new promClient.Counter({
    name: 'distributed_lock_released_total',
    help: 'Total number of distributed locks released',
    labelNames: ['resource']
  }),

  // 锁获取失败次数
  locksFailed: new promClient.Counter({
    name: 'distributed_lock_failed_total',
    help: 'Total number of failed lock acquisitions',
    labelNames: ['resource']
  }),

  // 锁续期次数
  locksExtended: new promClient.Counter({
    name: 'distributed_lock_extended_total',
    help: 'Total number of lock extensions',
    labelNames: ['resource']
  }),

  // 锁等待时间
  lockWaitTime: new promClient.Histogram({
    name: 'distributed_lock_wait_time_ms',
    help: 'Time spent waiting to acquire a lock',
    labelNames: ['resource'],
    buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000]
  }),

  // 锁持有时间
  lockHeldTime: new promClient.Histogram({
    name: 'distributed_lock_held_time_ms',
    help: 'Time a lock was held',
    labelNames: ['resource'],
    buckets: [100, 500, 1000, 2000, 5000, 10000, 30000, 60000]
  }),

  // 当前活跃锁数量
  activeLocks: new promClient.Gauge({
    name: 'distributed_lock_active_count',
    help: 'Number of currently active locks',
    labelNames: ['resource']
  }),

  // 死锁检测次数
  deadlocksDetected: new promClient.Counter({
    name: 'distributed_lock_deadlock_detected_total',
    help: 'Total number of deadlocks detected'
  })
};

module.exports = lockMetrics;
```

### 4.5 死锁检测与告警

```javascript
// backend/shared/deadlockDetector.js

const { getDistributedLock } = require('./distributedLock');
const { createLogger } = require('./logger');
const { incrementCounter } = require('./metrics');

const logger = createLogger('deadlock-detector');

class DeadlockDetector {
  constructor() {
    this.lock = getDistributedLock();
    this.lockWaitGraph = new Map();
    this.checkInterval = null;
  }

  /**
   * 启动死锁检测
   */
  start(intervalMs = 60000) {
    this.checkInterval = setInterval(() => {
      this.detectDeadlocks();
    }, intervalMs);
    
    logger.info({ intervalMs }, 'Deadlock detector started');
  }

  /**
   * 记录锁等待关系
   */
  recordWait(waiter, resource, holder) {
    if (!this.lockWaitGraph.has(waiter)) {
      this.lockWaitGraph.set(waiter, new Set());
    }
    this.lockWaitGraph.get(waiter).add(holder);
  }

  /**
   * 移除锁等待关系
   */
  removeWait(waiter, holder) {
    if (this.lockWaitGraph.has(waiter)) {
      this.lockWaitGraph.get(waiter).delete(holder);
    }
  }

  /**
   * 检测死锁（通过有向图环路检测）
   */
  detectDeadlocks() {
    const visited = new Set();
    const recursionStack = new Set();
    
    for (const node of this.lockWaitGraph.keys()) {
      if (this.hasCycle(node, visited, recursionStack)) {
        logger.error({
          waitGraph: Array.from(this.lockWaitGraph.entries()).map(([k, v]) => [k, Array.from(v)])
        }, 'Deadlock detected!');
        
        incrementCounter('distributed_lock_deadlock_detected_total');
        
        // 发送告警
        this.sendDeadlockAlert();
        
        return true;
      }
    }
    
    return false;
  }

  /**
   * DFS 检测环路
   */
  hasCycle(node, visited, recursionStack) {
    if (!visited.has(node)) {
      visited.add(node);
      recursionStack.add(node);
      
      const neighbors = this.lockWaitGraph.get(node) || new Set();
      
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor) && this.hasCycle(neighbor, visited, recursionStack)) {
          return true;
        } else if (recursionStack.has(neighbor)) {
          return true;
        }
      }
    }
    
    recursionStack.delete(node);
    return false;
  }

  /**
   * 发送死锁告警
   */
  async sendDeadlockAlert() {
    // 集成到告警系统
    const { sendAlert } = require('./alertManager');
    
    await sendAlert({
      severity: 'critical',
      type: 'deadlock',
      message: 'Deadlock detected in distributed lock system',
      details: {
        waitGraph: Array.from(this.lockWaitGraph.entries())
      }
    });
  }

  /**
   * 停止死锁检测
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    logger.info('Deadlock detector stopped');
  }
}

module.exports = new DeadlockDetector();
```

### 4.6 告警规则

更新 `infrastructure/k8s/monitoring/prometheus-rules.yml`：

```yaml
# 分布式锁告警规则
- alert: DistributedLockAcquireFailure
  expr: rate(distributed_lock_failed_total[5m]) > 5
  for: 5m
  labels:
    severity: warning
    priority: P1
  annotations:
    summary: "分布式锁获取失败率过高"
    description: "{{ $labels.resource }} 锁获取失败率 {{ $value }}/s，可能存在资源竞争"

- alert: DistributedLockLongWaitTime
  expr: histogram_quantile(0.95, rate(distributed_lock_wait_time_ms_bucket[5m])) > 5000
  for: 5m
  labels:
    severity: warning
    priority: P2
  annotations:
    summary: "分布式锁等待时间过长"
    description: "{{ $labels.resource }} 锁等待时间 P95 > 5s，影响用户体验"

- alert: DistributedLockHeldTooLong
  expr: histogram_quantile(0.99, rate(distributed_lock_held_time_ms_bucket[5m])) > 30000
  for: 5m
  labels:
    severity: warning
    priority: P1
  annotations:
    summary: "分布式锁持有时间过长"
    description: "{{ $labels.resource }} 锁持有时间 P99 > 30s，可能导致性能问题"

- alert: DistributedLockDeadlock
  expr: increase(distributed_lock_deadlock_detected_total[5m]) > 0
  for: 1m
  labels:
    severity: critical
    priority: P0
  annotations:
    summary: "检测到分布式锁死锁"
    description: "过去 5 分钟检测到死锁，需要立即处理"

- alert: DistributedLockTooManyActive
  expr: sum(distributed_lock_active_count) > 100
  for: 5m
  labels:
    severity: warning
    priority: P2
  annotations:
    summary: "活跃分布式锁数量过多"
    description: "当前活跃锁数量 {{ $value }}，可能影响系统性能"
```

## 5. 验收标准（可测试）

- [ ] 实现完整的 Redis Redlock 算法
- [ ] 支持多 Redis 实例（至少 3 个），容忍单点故障
- [ ] 实现自动续期（看门狗）机制
- [ ] 支持可重入锁和读写锁
- [ ] 实现锁超时自动释放
- [ ] 实现 `withLock` 便捷 API，自动获取和释放锁
- [ ] 实现死锁检测与告警
- [ ] 集成到至少 3 个关键业务场景（捕捉、道馆、交易）
- [ ] 新增 8 个 Prometheus 指标
- [ ] 新增 5 个告警规则
- [ ] 单元测试覆盖率 ≥ 85%
- [ ] 集成测试验证锁的正确性
- [ ] 压力测试验证高并发场景下的稳定性
- [ ] 文档完善，包含使用示例和最佳实践

## 6. 工作量估算

**L (Large)** - 需要实现完整的 Redlock 算法、多种锁模式、看门狗机制、死锁检测、告警集成，并改造多个业务场景。

## 7. 优先级理由

**P1 理由**：

1. **数据一致性保障**：分布式锁是保证多实例环境下数据一致性的关键基础设施，直接影响游戏公平性和数据完整性

2. **消除竞态条件**：当前多个关键业务场景（捕捉、道馆、交易）存在竞态条件风险，可能导致：
   - 同一精灵被多次捕捉
   - 同一道馆被多人同时占领
   - 交易数据不一致
   - 严重影响玩家体验和信任度

3. **系统稳定性提升**：缺乏分布式锁在高并发场景下可能导致数据损坏，属于生产环境的严重隐患

4. **依赖关系**：REQ-00070（Redis 内存优化）和 REQ-00088（Redis 连接池管理）为前置依赖，确保 Redis 基础设施稳定

5. **与其他需求协同**：
   - 与 REQ-00096（事务隔离级别控制）协同，共同保障数据一致性
   - 为 REQ-00104（精灵交换市场）提供并发保护基础

6. **生产就绪**：分布式锁是微服务架构的必备组件，当前缺失该组件意味着系统不具备生产就绪能力