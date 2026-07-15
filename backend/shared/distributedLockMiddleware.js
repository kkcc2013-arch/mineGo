/**
 * DistributedLock Express Middleware
 * 
 * 为 Express 路由提供分布式锁保护
 * 
 * @module backend/shared/distributedLockMiddleware
 */

'use strict';

const { getDistributedLock } = require('./distributedLock');

let logger = null;
function getLogger() {
  if (!logger) {
    try {
      logger = require('./logger').createLogger('lock-middleware');
    } catch (e) {
      logger = {
        info: (obj, msg) => console.log(`[INFO] ${msg}`, obj),
        warn: (obj, msg) => console.warn(`[WARN] ${msg}`, obj),
        error: (obj, msg) => console.error(`[ERROR] ${msg}`, obj)
      };
    }
  }
  return logger;
}

/**
 * 分布式锁中间件工厂
 * @param {string} resourceKey - 资源键表达式（如 'pokemon:req.params.id'）
 * @param {number} ttl - 锁的过期时间（毫秒）
 * @param {Object} [options] - 额外选项
 * @param {boolean} [options.autoExtend] - 是否自动续期
 * @param {number} [options.maxRetries] - 最大重试次数（仅用于 retryOnLock 中间件）
 * @returns {Function} Express 中间件
 */
function lockMiddleware(resourceKey, ttl, options = {}) {
  const log = getLogger();
  const lock = getDistributedLock();
  
  return async (req, res, next) => {
    // 解析资源键
    const resource = _parseResourceKey(resourceKey, req);
    
    try {
      // 尝试获取锁
      const lockObj = await lock.acquire(resource, ttl, options);
      
      // 将锁对象附加到请求
      req.lock = lockObj;
      
      // 监听响应完成事件，自动释放锁
      const originalEnd = res.end;
      res.end = function(...args) {
        // 释放锁
        lock.release(lockObj).catch(err => {
          log.error({ err, resource }, 'Failed to release lock on response end');
        });
        
        return originalEnd.apply(this, args);
      };
      
      next();
    } catch (err) {
      log.error({ err, resource }, 'Failed to acquire lock');
      
      if (err.message.includes('Failed to acquire lock')) {
        return res.status(409).json({
          success: false,
          error: 'Resource is currently locked, please retry later',
          code: 'RESOURCE_LOCKED',
          resource
        });
      }
      
      next(err);
    }
  };
}

/**
 * 自动重试中间件（针对锁冲突）
 * @param {number} [maxRetries=3] - 最大重试次数
 * @param {number} [baseDelay=100] - 基础延迟（毫秒）
 * @returns {Function} Express 中间件
 */
function retryOnLockMiddleware(maxRetries = 3, baseDelay = 100) {
  return async (req, res, next) => {
    let attempts = 0;
    let lastError = null;
    
    const attemptRequest = async () => {
      return new Promise((resolve, reject) => {
        const handleFinish = () => {
          res.removeListener('finish', handleFinish);
          res.removeListener('error', handleError);
          resolve();
        };
        
        const handleError = (err) => {
          res.removeListener('finish', handleFinish);
          res.removeListener('error', handleError);
          reject(err);
        };
        
        res.once('finish', handleFinish);
        res.once('error', handleError);
        
        next();
      });
    };
    
    while (attempts <= maxRetries) {
      try {
        return await attemptRequest();
      } catch (err) {
        if (err?.code === 'RESOURCE_LOCKED' && attempts < maxRetries) {
          attempts++;
          // 指数退避
          const delay = baseDelay * Math.pow(2, attempts - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          lastError = err;
          break;
        }
      }
    }
    
    if (lastError) {
      next(lastError);
    }
  };
}

/**
 * 带锁执行的控制器包装器
 * @param {string} resourceKey - 资源键表达式
 * @param {number} ttl - 锁的过期时间（毫秒）
 * @param {Function} handler - 控制器函数
 * @param {Object} [options] - 额外选项
 * @returns {Function} Express 控制器
 */
function withLockHandler(resourceKey, ttl, handler, options = {}) {
  const lock = getDistributedLock();
  
  return async (req, res, next) => {
    const resource = _parseResourceKey(resourceKey, req);
    
    try {
      const result = await lock.withLock(resource, ttl, async (lockObj) => {
        req.lock = lockObj;
        return handler(req, res, next);
      }, options);
      
      return result;
    } catch (err) {
      if (err.message?.includes('Failed to acquire lock')) {
        return res.status(409).json({
          success: false,
          error: 'Resource is currently locked, please retry later',
          code: 'RESOURCE_LOCKED',
          resource
        });
      }
      
      next(err);
    }
  };
}

/**
 * 解析资源键表达式
 * @private
 */
function _parseResourceKey(resourceKey, req) {
  return resourceKey
    .replace(/req\.params\.(\w+)/g, (_, key) => req.params[key] || '')
    .replace(/req\.body\.(\w+)/g, (_, key) => req.body?.[key] || '')
    .replace(/req\.query\.(\w+)/g, (_, key) => req.query[key] || '')
    .replace(/req\.user\.(\w+)/g, (_, key) => req.user?.[key] || '')
    .replace(/:/g, ':'); // 保留分隔符
}

/**
 * 预定义的锁资源键模板
 */
const LockResources = {
  // 精灵相关
  POKEMON_CATCH: 'pokemon:catch:req.params.pokemonId',
  POKEMON_TRADE: 'pokemon:trade:req.body.pokemonId',
  POKEMON_RELEASE: 'pokemon:release:req.body.pokemonId',
  POKIONE_DETAIL: 'pokemon:detail:req.params.pokemonId',
  
  // 道馆相关
  GYM_CLAIM: 'gym:claim:req.params.gymId',
  GYM_BATTLE: 'gym:battle:req.params.gymId',
  GYM_DEPOSIT: 'gym:deposit:req.params.gymId',
  
  // 交易相关
  TRADE_EXECUTE: 'trade:execute:req.params.tradeId',
  
  // 支付相关
  PAYMENT_CALLBACK: 'payment:callback:req.body.orderId',
  
  // 奖励相关
  REWARD_CLAIM: 'reward:claim:req.params.rewardId',
  EVENT_REWARD: 'event:reward:req.body.eventId:req.user.id',
  
  // 用户相关
  USER_SETTINGS: 'user:settings:req.user.id',
  USER_DEVICE: 'user:device:req.user.id:req.body.deviceId'
};

/**
 * 默认 TTL 配置（毫秒）
 */
const DefaultTTL = {
  SHORT: 5000,    // 5 秒 - 快速操作
  MEDIUM: 15000,  // 15 秒 - 普通操作
  LONG: 30000,    // 30 秒 - 复杂操作
  EXTENDED: 60000 // 60 秒 - 长时间操作
};

module.exports = {
  lockMiddleware,
  retryOnLockMiddleware,
  withLockHandler,
  LockResources,
  DefaultTTL
};