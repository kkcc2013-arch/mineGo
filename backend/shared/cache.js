/**
 * API 响应缓存模块 - 双层缓存架构（内存 + Redis）
 * 
 * REQ-00031: API 响应缓存层与缓存失效策略
 * 
 * 特性：
 * - L1 内存缓存：快速访问，1 分钟 TTL
 * - L2 Redis 缓存：分布式共享，可配置 TTL
 * - 自动回填：Redis 命中后回填内存缓存
 * - 模式匹配删除：支持通配符批量删除
 * - Prometheus 指标：命中率、延迟、大小监控
 */

const Redis = require('ioredis');
const { createLogger } = require('./logger');
const metrics = require('./metrics');

const logger = createLogger('cache');

// L1 内存缓存
const memoryCache = new Map();
const MEMORY_TTL = 60000; // 1 分钟
const MAX_MEMORY_SIZE = 1000;

// L2 Redis 客户端
let redisClient = null;
let isInitialized = false;

// 统计数据
const stats = {
  hits: { memory: 0, redis: 0 },
  misses: 0,
  sets: 0,
  deletes: 0
};

/**
 * 初始化缓存模块
 * @param {Object} redisConfig - Redis 配置
 */
function init(redisConfig = {}) {
  if (isInitialized) {
    logger.warn('Cache already initialized');
    return;
  }

  const defaultConfig = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD,
    db: process.env.REDIS_CACHE_DB || 1, // 使用独立的 DB
    retryStrategy: (times) => {
      if (times > 3) {
        logger.error('Redis connection failed after 3 retries');
        return null;
      }
      return Math.min(times * 100, 2000);
    }
  };

  const config = { ...defaultConfig, ...redisConfig };
  
  try {
    redisClient = new Redis(config);
    
    redisClient.on('connect', () => {
      logger.info({ config: { host: config.host, port: config.port } }, 'Redis cache connected');
    });
    
    redisClient.on('error', (err) => {
      logger.error({ err }, 'Redis cache error');
    });
    
    // 定期清理过期的内存缓存
    setInterval(cleanupMemoryCache, 30000);
    
    isInitialized = true;
    logger.info('Cache module initialized');
  } catch (err) {
    logger.error({ err }, 'Failed to initialize cache module');
    throw err;
  }
}

/**
 * 清理过期的内存缓存
 */
function cleanupMemoryCache() {
  const now = Date.now();
  let cleaned = 0;
  
  for (const [key, entry] of memoryCache) {
    if (entry.expireAt < now) {
      memoryCache.delete(key);
      cleaned++;
    }
  }
  
  // 如果内存缓存超过最大大小，删除最旧的条目
  if (memoryCache.size > MAX_MEMORY_SIZE) {
    const entries = Array.from(memoryCache.entries());
    const toDelete = entries.slice(0, memoryCache.size - MAX_MEMORY_SIZE);
    
    for (const [key] of toDelete) {
      memoryCache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    logger.debug({ cleaned, remaining: memoryCache.size }, 'Memory cache cleaned');
  }
}

/**
 * 设置内存缓存
 * @param {string} key - 缓存键
 * @param {any} value - 缓存值
 * @param {number} ttl - 过期时间（毫秒）
 */
function setMemory(key, value, ttl) {
  memoryCache.set(key, {
    value,
    expireAt: Date.now() + ttl,
    size: JSON.stringify(value).length
  });
}

/**
 * 获取缓存值（双层查询）
 * @param {string} key - 缓存键
 * @returns {Promise<any>} 缓存值，未命中返回 null
 */
async function get(key) {
  const startTime = Date.now();
  
  // L1: 内存缓存
  const memEntry = memoryCache.get(key);
  if (memEntry && memEntry.expireAt > Date.now()) {
    stats.hits.memory++;
    recordMetric('hit', 'memory', startTime);
    logger.debug({ key, layer: 'memory' }, 'Cache hit');
    return memEntry.value;
  }
  
  // L2: Redis 缓存
  if (redisClient) {
    try {
      const redisValue = await redisClient.get(key);
      
      if (redisValue !== null) {
        const value = JSON.parse(redisValue);
        
        // 回填 L1
        const remainingTtl = await redisClient.ttl(key);
        const l1Ttl = Math.min(remainingTtl * 1000, MEMORY_TTL);
        setMemory(key, value, l1Ttl);
        
        stats.hits.redis++;
        recordMetric('hit', 'redis', startTime);
        logger.debug({ key, layer: 'redis' }, 'Cache hit');
        return value;
      }
    } catch (err) {
      logger.error({ err, key }, 'Redis get error');
    }
  }
  
  stats.misses++;
  recordMetric('miss', null, startTime);
  logger.debug({ key }, 'Cache miss');
  return null;
}

/**
 * 设置缓存值（强制要求 TTL）
 * REQ-00070: Redis 内存优化与自动 TTL 策略
 * 
 * @param {string} key - 缓存键
 * @param {any} value - 缓存值
 * @param {number} ttl - 过期时间（秒），必需参数
 * @param {Object} options - 额外选项
 * @param {boolean} options.allowNoTTL - 是否允许不设置 TTL（谨慎使用）
 * @param {string} options.category - 数据类别（用于 TTL 验证）
 */
async function set(key, value, ttl, options = {}) {
  const startTime = Date.now();
  
  // 强制 TTL 检查
  if (!ttl || ttl <= 0) {
    if (!options.allowNoTTL) {
      throw new Error(
        `Cache key "${key}" must have a valid TTL. ` +
        `Use setWithoutTTL() for keys that should persist indefinitely, ` +
        `or set allowNoTTL: true in options (not recommended).`
      );
    }
    
    logger.warn({ key, stack: new Error().stack }, 'Setting cache without TTL - use with caution');
    
    // 记录无 TTL 的 Key（用于监控）
    incrementCounter('cache_keys_without_ttl_total', { key_prefix: key.split(':')[0] });
  }
  
  try {
    const jsonValue = JSON.stringify(value);
    
    // 设置 L2 (Redis)
    if (redisClient) {
      if (ttl && ttl > 0) {
        await redisClient.setex(key, ttl, jsonValue);
      } else {
        await redisClient.set(key, jsonValue);
      }
    }
    
    // 设置 L1 (内存)
    const l1Ttl = ttl > 0 ? Math.min(ttl * 1000, MEMORY_TTL) : MEMORY_TTL;
    setMemory(key, value, l1Ttl);
    
    stats.sets++;
    recordMetric('set', null, startTime);
    
    logger.debug({ key, ttl, size: jsonValue.length }, 'Cache set');
  } catch (err) {
    logger.error({ err, key }, 'Cache set error');
    throw err;
  }
}

/**
 * 删除缓存
 * @param {string} key - 缓存键
 */
async function del(key) {
  const startTime = Date.now();
  
  try {
    // 删除 L1
    memoryCache.delete(key);
    
    // 删除 L2
    if (redisClient) {
      await redisClient.del(key);
    }
    
    stats.deletes++;
    recordMetric('delete', null, startTime);
    
    logger.debug({ key }, 'Cache deleted');
  } catch (err) {
    logger.error({ err, key }, 'Cache delete error');
  }
}

/**
 * 批量删除（支持模式匹配）
 * @param {string} pattern - 匹配模式（支持 * 通配符）
 */
async function delPattern(pattern) {
  const startTime = Date.now();
  let deleted = 0;
  
  try {
    // 删除 L1 内存缓存
    const regex = patternToRegex(pattern);
    for (const key of memoryCache.keys()) {
      if (regex.test(key)) {
        memoryCache.delete(key);
        deleted++;
      }
    }
    
    // 删除 L2 Redis 缓存
    if (redisClient) {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(...keys);
        deleted += keys.length;
      }
    }
    
    stats.deletes += deleted;
    recordMetric('delete', null, startTime);
    
    logger.info({ pattern, deleted }, 'Cache pattern deleted');
  } catch (err) {
    logger.error({ err, pattern }, 'Cache pattern delete error');
  }
}

/**
 * 将通配符模式转换为正则表达式
 * @param {string} pattern - 通配符模式
 * @returns {RegExp} 正则表达式
 */
function patternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * 检查缓存是否存在
 * @param {string} key - 缓存键
 * @returns {Promise<boolean>}
 */
async function exists(key) {
  // 检查 L1
  const memEntry = memoryCache.get(key);
  if (memEntry && memEntry.expireAt > Date.now()) {
    return true;
  }
  
  // 检查 L2
  if (redisClient) {
    try {
      const result = await redisClient.exists(key);
      return result === 1;
    } catch (err) {
      logger.error({ err, key }, 'Redis exists error');
      return false;
    }
  }
  
  return false;
}

/**
 * 获取缓存 TTL
 * @param {string} key - 缓存键
 * @returns {Promise<number>} 剩余秒数，-1 表示不存在，-2 表示无过期时间
 */
async function ttl(key) {
  // 检查 L1
  const memEntry = memoryCache.get(key);
  if (memEntry && memEntry.expireAt > Date.now()) {
    return Math.floor((memEntry.expireAt - Date.now()) / 1000);
  }
  
  // 检查 L2
  if (redisClient) {
    try {
      return await redisClient.ttl(key);
    } catch (err) {
      logger.error({ err, key }, 'Redis ttl error');
      return -1;
    }
  }
  
  return -1;
}

/**
 * 记录 Prometheus 指标
 * @param {string} operation - 操作类型
 * @param {string|null} layer - 缓存层
 * @param {number} startTime - 开始时间
 */
function recordMetric(operation, layer, startTime) {
  if (!metrics) return;
  
  const duration = (Date.now() - startTime) / 1000;
  
  try {
    if (operation === 'hit' && layer) {
      metrics.cacheHitsTotal?.inc({ layer });
      metrics.cacheLatency?.observe({ operation: 'get', layer }, duration);
    } else if (operation === 'miss') {
      metrics.cacheMissesTotal?.inc();
      metrics.cacheLatency?.observe({ operation: 'get', layer: 'none' }, duration);
    } else if (operation === 'set') {
      metrics.cacheLatency?.observe({ operation: 'set', layer: 'both' }, duration);
    } else if (operation === 'delete') {
      metrics.cacheLatency?.observe({ operation: 'delete', layer: 'both' }, duration);
    }
    
    // 更新缓存大小
    if (metrics.cacheSize) {
      let memorySize = 0;
      for (const entry of memoryCache.values()) {
        memorySize += entry.size || 0;
      }
      metrics.cacheSize.set({ layer: 'memory' }, memorySize);
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to record metrics');
  }
}

/**
 * 获取缓存统计信息
 * @returns {Object} 统计信息
 */
function getStats() {
  let memorySize = 0;
  for (const entry of memoryCache.values()) {
    memorySize += entry.size || 0;
  }
  
  return {
    memory: {
      size: memoryCache.size,
      bytes: memorySize,
      hits: stats.hits.memory
    },
    redis: {
      hits: stats.hits.redis
    },
    total: {
      hits: stats.hits.memory + stats.hits.redis,
      misses: stats.misses,
      sets: stats.sets,
      deletes: stats.deletes,
      hitRate: calculateHitRate()
    }
  };
}

/**
 * 计算命中率
 * @returns {number} 命中率（0-1）
 */
function calculateHitRate() {
  const total = stats.hits.memory + stats.hits.redis + stats.misses;
  if (total === 0) return 0;
  return (stats.hits.memory + stats.hits.redis) / total;
}

/**
 * 重置统计信息
 */
function resetStats() {
  stats.hits.memory = 0;
  stats.hits.redis = 0;
  stats.misses = 0;
  stats.sets = 0;
  stats.deletes = 0;
  logger.info('Cache stats reset');
}

/**
 * 清空所有缓存
 */
async function flush() {
  try {
    // 清空 L1
    memoryCache.clear();
    
    // 清空 L2（只清空 api: 前缀的键）
    if (redisClient) {
      const keys = await redisClient.keys('api:*');
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
    }
    
    logger.info('Cache flushed');
  } catch (err) {
    logger.error({ err }, 'Cache flush error');
  }
}

/**
 * 关闭缓存连接
 */
async function close() {
  try {
    memoryCache.clear();
    
    if (redisClient) {
      await redisClient.quit();
      redisClient = null;
    }
    
    isInitialized = false;
    logger.info('Cache module closed');
  } catch (err) {
    logger.error({ err }, 'Cache close error');
  }
}

module.exports = {
  init,
  get,
  set,
  del,
  delPattern,
  exists,
  ttl,
  getStats,
  resetStats,
  flush,
  close,
  // Cache Key Helpers
  CacheKeys: {
    stamina: (pokemonId) => `stamina:${pokemonId}`,
    pokemon: (pokemonId) => `pokemon:${pokemonId}`,
    user: (userId) => `user:${userId}`,
    battle: (battleId) => `battle:${battleId}`,
    session: (sessionId) => `session:${sessionId}`
  }
};
