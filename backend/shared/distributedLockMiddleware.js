/**
 * 分布式锁 Express 中间件
 * 
 * 提供便捷的分布式锁集成到 Express 路由
 * 
 * @module distributedLockMiddleware
 */

const { getDistributedLock } = require('./distributedLock');
const { createLogger } = require('./logger');

const logger = createLogger('lock-middleware');

/**
 * 分布式锁中间件工厂
 * @param {string} resourceKey - 资源键表达式（如 'pokemon:req.params.id'）
 * @param {number} ttl - 锁的过期时间（毫秒）
 * @param {Object} options - 额外选项
 * @param {boolean} options.autoExtend - 是否自动续期
 * @param {number} options.extendInterval - 续期间隔
 * @param {number} options.maxExtendCount - 最大续期次数
 * @param {Function} options.resourceExtractor - 自定义资源提取函数
 * @returns {Function} Express 中间件
 */
function lockMiddleware(resourceKey, ttl, options = {}) {
  const lock = getDistributedLock();
  const {
    autoExtend = false,
    extendInterval,
    maxExtendCount,
    resourceExtractor
  } = options;
  
  return async (req, res, next) => {
    let resource;
    
    try {
      // 解析资源键
      if (resourceExtractor) {
        resource = await resourceExtractor(req);
      } else {
        resource = resourceKey
          .replace(/req\.params\.(\w+)/g, (_, key) => req.params[key])
          .replace(/req\.body\.(\w+)/g, (_, key) => req.body[key])
          .replace(/req\.query\.(\w+)/g, (_, key) => req.query[key])
          .replace(/req\.user\.(\w+)/g, (_, key) => req.user?.[key]);
      }
      
      if (!resource) {
        logger.warn({ resourceKey }, 'Failed to extract resource from request');
        return res.status(400).json({
          success: false,
          error: 'Invalid resource identifier',
          code: 'INVALID_RESOURCE'
        });
      }
      
      // 尝试获取锁
      const lockObj = await lock.acquire(resource, ttl, {
        autoExtend,
        extendInterval,
        maxExtendCount
      });
      
      // 将锁对象附加到请求
      req.distributedLock = lockObj;
      
      // 监听响应完成事件，自动释放锁
      const originalEnd = res.end;
      res.end = async function(...args) {
        try {
          await lock.release(lockObj);
        } catch (err) {
          logger.error({ 
            err, 
            resource 
          }, 'Failed to release lock on response end');
        }
        originalEnd.apply(this, args);
      };
      
      // 也监听 finish 事件作为备份
      res.on('finish', async () => {
        try {
          // 检查锁是否仍然活跃
          if (lock.activeLocksMap?.has(lockObj.lockId)) {
            await lock.release(lockObj);
          }
        } catch (err) {
          // 忽略已释放的锁错误
        }
      });
      
      next();
    } catch (err) {
      logger.error({ 
        err, 
        resource,
        resourceKey 
      }, 'Failed to acquire lock');
      
      if (err.message.includes('Failed to acquire lock')) {
        return res.status(409).json({
          success: false,
          error: 'Resource is currently locked, please retry later',
          code: 'RESOURCE_LOCKED',
          retryAfter: Math.ceil(ttl / 1000)
        });
      }
      
      next(err);
    }
  };
}

/**
 * 自动重试中间件（针对锁冲突）
 * @param {number} maxRetries - 最大重试次数
 * @param {number} retryDelay - 重试延迟（毫秒）
 * @param {Function} shouldRetry - 判断是否应该重试的函数
 * @returns {Function} Express 中间件
 */
function retryOnLockMiddleware(maxRetries = 3, retryDelay = 100, shouldRetry = null) {
  return (req, res, next) => {
    let attempts = 0;
    const originalJson = res.json.bind(res);
    let lastError = null;
    
    const attemptRequest = async () => {
      attempts++;
      
      return new Promise((resolve, reject) => {
        const mockRes = {
          ...res,
          json: (data) => {
            // 检查是否是锁冲突错误
            if (data?.code === 'RESOURCE_LOCKED') {
              lastError = data;
              resolve({ shouldRetry: true, data });
            } else {
              originalJson(data);
              resolve({ shouldRetry: false, data });
            }
          },
          status: (code) => {
            mockRes.statusCode = code;
            return mockRes;
          },
          send: (data) => {
            originalJson(data);
            resolve({ shouldRetry: false, data });
          },
          end: (data) => {
            if (data) {
              originalJson(data);
            }
            resolve({ shouldRetry: false, data });
          }
        };
        
        try {
          next();
        } catch (err) {
          reject(err);
        }
      });
    };
    
    const executeWithRetry = async () => {
      const result = await attemptRequest();
      
      if (result.shouldRetry && attempts < maxRetries) {
        // 检查自定义重试条件
        if (shouldRetry && !shouldRetry(result.data, attempts)) {
          originalJson(result.data);
          return;
        }
        
        // 等待后重试
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempts));
        
        logger.info({
          attempts,
          maxRetries,
          delay: retryDelay * attempts
        }, 'Retrying request due to lock conflict');
        
        return executeWithRetry();
      }
      
      if (result.shouldRetry && attempts >= maxRetries) {
        // 达到最大重试次数
        originalJson({
          success: false,
          error: 'Resource is still locked after maximum retries',
          code: 'RESOURCE_LOCKED_MAX_RETRIES',
          attempts
        });
      }
    };
    
    executeWithRetry().catch(err => {
      logger.error({ err }, 'Retry middleware error');
      next(err);
    });
  };
}

/**
 * 并发控制中间件（限制同时处理的请求数）
 * @param {string} key - 并发控制键
 * @param {number} maxConcurrent - 最大并发数
 * @param {number} ttl - 锁过期时间（毫秒）
 * @returns {Function} Express 中间件
 */
function concurrencyLimitMiddleware(key, maxConcurrent = 10, ttl = 30000) {
  const lock = getDistributedLock();
  const counterKey = `concurrency:${key}`;
  
  return async (req, res, next) => {
    try {
      // 尝试获取并发计数锁
      const counterLock = await lock.tryAcquire(counterKey, ttl);
      
      if (counterLock) {
        // 设置计数器
        req.concurrencyLock = counterLock;
        
        // 监听响应完成，释放锁
        res.on('finish', async () => {
          try {
            await lock.release(counterLock);
          } catch (err) {
            logger.error({ err, key }, 'Failed to release concurrency lock');
          }
        });
        
        next();
      } else {
        // 达到并发限制
        return res.status(429).json({
          success: false,
          error: 'Too many concurrent requests',
          code: 'CONCURRENCY_LIMIT_EXCEEDED',
          maxConcurrent
        });
      }
    } catch (err) {
      logger.error({ err, key }, 'Concurrency limit middleware error');
      next(err);
    }
  };
}

/**
 * 资源锁定装饰器（用于包装路由处理函数）
 * @param {string} resourceKey - 资源键表达式
 * @param {number} ttl - 锁过期时间（毫秒）
 * @param {Object} options - 额外选项
 * @returns {Function} 装饰器函数
 */
function withResourceLock(resourceKey, ttl, options = {}) {
  return (handler) => {
    return async (req, res, next) => {
      const lock = getDistributedLock();
      let resource;
      
      try {
        // 解析资源键
        if (options.resourceExtractor) {
          resource = await options.resourceExtractor(req);
        } else {
          resource = resourceKey
            .replace(/req\.params\.(\w+)/g, (_, key) => req.params[key])
            .replace(/req\.body\.(\w+)/g, (_, key) => req.body[key])
            .replace(/req\.user\.(\w+)/g, (_, key) => req.user?.[key]);
        }
        
        // 使用 withLock 自动管理锁生命周期
        const result = await lock.withLock(
          resource,
          ttl,
          options,
          async () => {
            return handler(req, res, next);
          }
        );
        
        return result;
      } catch (err) {
        if (err.message.includes('Failed to acquire lock')) {
          return res.status(409).json({
            success: false,
            error: 'Resource is currently locked',
            code: 'RESOURCE_LOCKED'
          });
        }
        next(err);
      }
    };
  };
}

/**
 * 批量资源锁中间件
 * @param {string[]} resourceKeys - 资源键数组
 * @param {number} ttl - 锁过期时间（毫秒）
 * @param {Object} options - 额外选项
 * @returns {Function} Express 中间件
 */
function multiLockMiddleware(resourceKeys, ttl, options = {}) {
  const lock = getDistributedLock();
  
  return async (req, res, next) => {
    const locks = [];
    
    try {
      // 按顺序获取所有锁（避免死锁）
      for (const resourceKey of resourceKeys) {
        const resource = resourceKey
          .replace(/req\.params\.(\w+)/g, (_, key) => req.params[key])
          .replace(/req\.body\.(\w+)/g, (_, key) => req.body[key])
          .replace(/req\.user\.(\w+)/g, (_, key) => req.user?.[key]);
        
        const lockObj = await lock.acquire(resource, ttl, options);
        locks.push(lockObj);
      }
      
      // 将锁数组附加到请求
      req.distributedLocks = locks;
      
      // 监听响应完成，释放所有锁
      res.on('finish', async () => {
        for (const lockObj of locks.reverse()) { // 逆序释放
          try {
            await lock.release(lockObj);
          } catch (err) {
            logger.error({ 
              err, 
              resource: lockObj.resource 
            }, 'Failed to release lock');
          }
        }
      });
      
      next();
    } catch (err) {
      // 释放已获取的锁
      for (const lockObj of locks.reverse()) {
        try {
          await lock.release(lockObj);
        } catch (releaseErr) {
          // 忽略释放错误
        }
      }
      
      logger.error({ 
        err, 
        resourceKeys 
      }, 'Failed to acquire multi-lock');
      
      if (err.message.includes('Failed to acquire lock')) {
        return res.status(409).json({
          success: false,
          error: 'One or more resources are locked',
          code: 'MULTI_RESOURCE_LOCKED'
        });
      }
      
      next(err);
    }
  };
}

/**
 * 创建锁状态检查中间件
 * @param {string} resourceKey - 资源键表达式
 * @returns {Function} Express 中间件
 */
function checkLockStatusMiddleware(resourceKey) {
  const lock = getDistributedLock();
  
  return async (req, res, next) => {
    try {
      const resource = resourceKey
        .replace(/req\.params\.(\w+)/g, (_, key) => req.params[key])
        .replace(/req\.body\.(\w+)/g, (_, key) => req.body[key]);
      
      const isLocked = await lock.isLocked(resource);
      const ttl = isLocked ? await lock.getTTL(resource) : null;
      const holder = isLocked ? await lock.getHolder(resource) : null;
      
      req.lockStatus = {
        resource,
        isLocked,
        ttl,
        holder
      };
      
      next();
    } catch (err) {
      logger.error({ err, resourceKey }, 'Lock status check error');
      next(err);
    }
  };
}

module.exports = {
  lockMiddleware,
  retryOnLockMiddleware,
  concurrencyLimitMiddleware,
  withResourceLock,
  multiLockMiddleware,
  checkLockStatusMiddleware
};
