/**
 * IdempotencyMiddleware.js - 通用 API 幂等性中间件
 * 
 * 功能：
 * - 防止重复请求导致的数据不一致
 * - 支持多种 Key 生成策略
 * - Redis 缓存幂等性结果
 * - 提供监控指标
 * 
 * 使用方式：
 * app.post('/api/catch', idempotency({ ttl: 86400 }), catchHandler);
 */

'use strict';

const crypto = require('crypto');
const { getRedis } = require('./redis');
const logger = require('./logger');

// ============================================================================
// 幂等性配置
// ============================================================================

/**
 * 需要幂等性保护的接口配置
 */
const IDEMPOTENCY_CONFIG = {
  // 精灵捕捉
  'POST /api/catch': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+location+pokemon',
    description: '防止重复捕捉同一只精灵'
  },

  // 物品使用
  'POST /api/inventory/use': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+itemId+timestamp',
    description: '防止重复使用物品'
  },

  // 道馆战斗
  'POST /api/gym/battle': {
    enabled: true,
    ttl: 3600,
    keyStrategy: 'user+gymId+timestamp',
    description: '防止重复战斗'
  },

  // 好友操作
  'POST /api/friend/add': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+friendId',
    description: '防止重复添加好友'
  },

  // 支付创建
  'POST /api/payment/create': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'custom',
    description: '支付幂等性'
  },

  // 奖励领取
  'POST /api/reward/claim': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+rewardId',
    description: '防止重复领取奖励'
  },

  // 精灵进化
  'POST /api/pokemon/evolve': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+pokemonId',
    description: '防止重复进化'
  },

  // 交易发起
  'POST /api/trade/create': {
    enabled: true,
    ttl: 86400,
    keyStrategy: 'user+tradeId',
    description: '防止重复交易'
  }
};

/**
 * Key 生成策略
 */
const KEY_STRATEGIES = {
  // 默认：用户 + 方法 + 路径 + 请求体哈希
  'default': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const bodyHash = hashBody(req.body);
    return `${prefix}:${userId}:${req.method}:${req.path}:${bodyHash}`;
  },

  // 用户 + 位置 + 精灵（用于捕捉）
  'user+location+pokemon': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { locationId, pokemonId, spawnId } = req.body;
    return `${prefix}:${userId}:catch:${spawnId || pokemonId || locationId}`;
  },

  // 用户 + 物品ID + 时间戳（精确到分钟）
  'user+itemId+timestamp': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { itemId } = req.body;
    const timestamp = Math.floor(Date.now() / 60000);
    return `${prefix}:${userId}:use:${itemId}:${timestamp}`;
  },

  // 用户 + 道馆ID + 时间戳（用于战斗）
  'user+gymId+timestamp': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { gymId } = req.body;
    const timestamp = Math.floor(Date.now() / 60000);
    return `${prefix}:${userId}:battle:${gymId}:${timestamp}`;
  },

  // 用户 + 好友ID
  'user+friendId': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { friendId } = req.body;
    return `${prefix}:${userId}:friend:${friendId}`;
  },

  // 用户 + 奖励ID
  'user+rewardId': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { rewardId, questId } = req.body;
    return `${prefix}:${userId}:reward:${rewardId || questId}`;
  },

  // 用户 + 精灵ID
  'user+pokemonId': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { pokemonId } = req.body;
    return `${prefix}:${userId}:pokemon:${pokemonId}`;
  },

  // 用户 + 交易ID
  'user+tradeId': (req, prefix) => {
    const userId = req.user?.id || 'anonymous';
    const { tradeId, targetUserId, offeredPokemonId } = req.body;
    return `${prefix}:${userId}:trade:${tradeId || `${targetUserId}-${offeredPokemonId}`}`;
  },

  // 自定义（使用客户端提供的 key）
  'custom': (req, prefix) => {
    const key = req.headers['x-idempotency-key'] || req.body?.idempotencyKey;
    if (!key) {
      throw new Error('Missing idempotency key for custom strategy');
    }
    return `${prefix}:custom:${key}`;
  }
};

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 计算请求体哈希
 */
function hashBody(body) {
  if (!body || Object.keys(body).length === 0) {
    return 'empty';
  }
  
  // 过滤掉 idempotencyKey，避免影响哈希
  const filteredBody = { ...body };
  delete filteredBody.idempotencyKey;
  
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(filteredBody))
    .digest('hex')
    .substring(0, 16);
}

/**
 * 获取接口配置
 */
function getRouteConfig(method, path) {
  const key = `${method} ${path}`;
  return IDEMPOTENCY_CONFIG[key] || null;
}

// ============================================================================
// 幂等性中间件类
// ============================================================================

class IdempotencyMiddleware {
  constructor(options = {}) {
    this.redis = null;
    this.ttl = options.ttl || 86400; // 默认 24 小时
    this.keyPrefix = options.keyPrefix || 'idempotency';
    this.keyStrategy = options.keyStrategy || 'default';
    this.enabled = options.enabled !== false;
    this.skipMethods = options.skipMethods || ['GET', 'HEAD', 'OPTIONS'];
    this.localCache = new Map(); // 本地内存缓存（LRU）
    this.localCacheMaxSize = options.localCacheMaxSize || 10000;
    
    // 监控指标
    this.metrics = {
      duplicateTotal: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0,
      checkDurationMs: []
    };
  }

  /**
   * 初始化 Redis 连接
   */
  async init() {
    if (!this.redis) {
      this.redis = getRedis();
    }
    return this;
  }

  /**
   * 生成幂等性 Key
   */
  generateKey(req) {
    const strategy = KEY_STRATEGIES[this.keyStrategy] || KEY_STRATEGIES['default'];
    return strategy(req, this.keyPrefix);
  }

  /**
   * 检查幂等性（带本地缓存）
   */
  async check(req) {
    const startTime = Date.now();
    
    try {
      await this.init();
      
      const key = this.generateKey(req);
      
      // 先检查本地缓存
      const localCached = this.localCache.get(key);
      if (localCached) {
        this.metrics.cacheHits++;
        return {
          isDuplicate: true,
          result: localCached.result,
          key,
          source: 'local'
        };
      }
      
      // 检查 Redis
      const cached = await this.redis.get(key);
      
      const duration = Date.now() - startTime;
      this.metrics.checkDurationMs.push(duration);
      if (this.metrics.checkDurationMs.length > 1000) {
        this.metrics.checkDurationMs.shift();
      }
      
      if (cached) {
        const result = JSON.parse(cached);
        
        // 写入本地缓存
        this._setLocalCache(key, result);
        
        this.metrics.cacheHits++;
        return {
          isDuplicate: true,
          result,
          key,
          source: 'redis'
        };
      }
      
      this.metrics.cacheMisses++;
      return { isDuplicate: false, key };
      
    } catch (error) {
      this.metrics.errors++;
      logger.error('Idempotency check failed', { error: error.message });
      
      // Redis 故障时降级：放行请求
      return { isDuplicate: false, key: null, error: error.message };
    }
  }

  /**
   * 保存幂等性结果
   */
  async save(key, result) {
    if (!key) return;
    
    try {
      await this.init();
      
      const resultWithTimestamp = {
        ...result,
        timestamp: new Date().toISOString()
      };
      
      // 写入 Redis
      await this.redis.setex(key, this.ttl, JSON.stringify(resultWithTimestamp));
      
      // 写入本地缓存
      this._setLocalCache(key, resultWithTimestamp);
      
    } catch (error) {
      this.metrics.errors++;
      logger.error('Idempotency save failed', { error: error.message, key });
    }
  }

  /**
   * 清除幂等性缓存
   */
  async clear(key) {
    if (!key) return;
    
    try {
      await this.init();
      await this.redis.del(key);
      this.localCache.delete(key);
    } catch (error) {
      logger.error('Idempotency clear failed', { error: error.message, key });
    }
  }

  /**
   * 设置本地缓存（LRU）
   */
  _setLocalCache(key, result) {
    if (this.localCache.size >= this.localCacheMaxSize) {
      // 删除最早的条目
      const firstKey = this.localCache.keys().next().value;
      this.localCache.delete(firstKey);
    }
    this.localCache.set(key, { result, cachedAt: Date.now() });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const durations = this.metrics.checkDurationMs;
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;
    
    const p95Duration = durations.length > 0
      ? durations.sort((a, b) => a - b)[Math.floor(durations.length * 0.95)]
      : 0;
    
    return {
      duplicateTotal: this.metrics.duplicateTotal,
      cacheHits: this.metrics.cacheHits,
      cacheMisses: this.metrics.cacheMisses,
      errors: this.metrics.errors,
      hitRate: this.metrics.cacheHits / (this.metrics.cacheHits + this.metrics.cacheMisses) || 0,
      avgCheckDurationMs: avgDuration.toFixed(2),
      p95CheckDurationMs: p95Duration,
      localCacheSize: this.localCache.size
    };
  }
}

// ============================================================================
// 中间件工厂函数
// ============================================================================

/**
 * 创建幂等性中间件
 * 
 * @param {Object} options - 配置选项
 * @param {number} options.ttl - 缓存时间（秒），默认 24 小时
 * @param {string} options.keyStrategy - Key 生成策略
 * @param {boolean} options.enabled - 是否启用
 * @returns {Function} Express 中间件
 */
function idempotency(options = {}) {
  const middleware = new IdempotencyMiddleware(options);
  
  return async (req, res, next) => {
    // 跳过不需要幂等性的方法
    if (middleware.skipMethods.includes(req.method)) {
      return next();
    }
    
    // 检查是否启用
    if (!middleware.enabled) {
      return next();
    }
    
    try {
      // 检查幂等性
      const checkResult = await middleware.check(req);
      
      if (checkResult.isDuplicate) {
        middleware.metrics.duplicateTotal++;
        
        logger.info('Duplicate request detected', {
          key: checkResult.key,
          path: req.path,
          method: req.method,
          source: checkResult.source
        });
        
        // 返回缓存的结果
        return res.status(200).json({
          ...checkResult.result,
          _idempotent: true,
          _cachedAt: checkResult.result.timestamp
        });
      }
      
      // 拦截 res.json 以缓存结果
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        // 只缓存成功响应
        if (res.statusCode >= 200 && res.statusCode < 300 && checkResult.key) {
          // 异步保存，不阻塞响应
          middleware.save(checkResult.key, body).catch(err => {
            logger.error('Failed to save idempotency result', { error: err.message });
          });
        }
        return originalJson(body);
      };
      
      next();
      
    } catch (error) {
      logger.error('Idempotency middleware error', { error: error.message });
      // 出错时放行请求
      next();
    }
  };
}

/**
 * 自动幂等性中间件（根据路由配置自动应用）
 */
function autoIdempotency() {
  const middlewareMap = new Map();
  
  return async (req, res, next) => {
    // 跳过不需要幂等性的方法
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }
    
    // 查找路由配置
    const config = getRouteConfig(req.method, req.path);
    
    if (!config || !config.enabled) {
      return next();
    }
    
    // 获取或创建中间件实例
    let middleware = middlewareMap.get(config.keyStrategy);
    if (!middleware) {
      middleware = new IdempotencyMiddleware({
        ttl: config.ttl,
        keyStrategy: config.keyStrategy
      });
      middlewareMap.set(config.keyStrategy, middleware);
    }
    
    try {
      const checkResult = await middleware.check(req);
      
      if (checkResult.isDuplicate) {
        middleware.metrics.duplicateTotal++;
        
        return res.status(200).json({
          ...checkResult.result,
          _idempotent: true,
          _cachedAt: checkResult.result.timestamp
        });
      }
      
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && checkResult.key) {
          middleware.save(checkResult.key, body).catch(() => {});
        }
        return originalJson(body);
      };
      
      next();
      
    } catch (error) {
      logger.error('Auto idempotency middleware error', { error: error.message });
      next();
    }
  };
}

// ============================================================================
// 管理员 API 辅助函数
// ============================================================================

/**
 * 查询用户的幂等性缓存
 */
async function getUserIdempotencyKeys(userId, pattern = '*') {
  const redis = getRedis();
  const keys = await redis.keys(`idempotency:${userId}:${pattern}`);
  return keys;
}

/**
 * 清除指定用户的所有幂等性缓存
 */
async function clearUserIdempotencyCache(userId) {
  const redis = getRedis();
  const keys = await redis.keys(`idempotency:${userId}:*`);
  
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  
  return keys.length;
}

/**
 * 批量清除过期缓存（Redis 会自动过期，此函数用于清理本地缓存）
 */
async function cleanupExpiredCache() {
  // 由调用方定期执行
  const redis = getRedis();
  const keys = await redis.keys('idempotency:*');
  
  let cleaned = 0;
  for (const key of keys) {
    const ttl = await redis.ttl(key);
    if (ttl === -1) { // 无过期时间
      await redis.del(key);
      cleaned++;
    }
  }
  
  return cleaned;
}

// ============================================================================
// 导出
// ============================================================================

module.exports = {
  IdempotencyMiddleware,
  idempotency,
  autoIdempotency,
  IDEMPOTENCY_CONFIG,
  KEY_STRATEGIES,
  getUserIdempotencyKeys,
  clearUserIdempotencyCache,
  cleanupExpiredCache,
  hashBody,
  getRouteConfig
};
