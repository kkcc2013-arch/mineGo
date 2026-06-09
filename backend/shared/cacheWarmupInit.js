/**
 * 缓存预热初始化辅助函数
 * REQ-00039: 热点数据缓存预热系统
 * 
 * 提供简便的集成方式，供各微服务启动时调用
 */

const cache = require('./cache');
const cacheWarmup = require('./cacheWarmup');
const { createLogger } = require('./logger');

const logger = createLogger('cache-warmup-init');

/**
 * 初始化缓存并预热热点数据
 * 
 * 使用方式：
 * const { initCacheWithWarmup } = require('../../../shared/cacheWarmupInit');
 * 
 * async function startServer() {
 *   await initCacheWithWarmup();
 *   // ... 其他初始化
 *   app.listen(PORT, () => logger.info('Server started'));
 * }
 * 
 * @param {Object} options - 配置选项
 * @param {boolean} options.warmupOnStart - 是否在启动时预热（默认 true）
 * @param {Object} options.redisConfig - Redis 配置
 */
async function initCacheWithWarmup(options = {}) {
  const {
    warmupOnStart = true,
    redisConfig = {},
  } = options;

  try {
    // 1. 初始化缓存模块
    cache.init(redisConfig);
    logger.info('Cache module initialized');

    // 2. 设置 Redis 客户端到预热服务
    const redisClient = cache.getRedisClient();
    if (redisClient && warmupOnStart) {
      cacheWarmup.setRedisClient(redisClient);
      
      // 3. 非阻塞式预热（不等待完成）
      cacheWarmup.initialize().catch(err => {
        logger.error({ err: err.message }, 'Cache warmup failed, continuing without warm cache');
      });
      
      logger.info('Cache warmup started in background');
    }

    return {
      cache,
      cacheWarmup,
    };
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to initialize cache with warmup');
    throw err;
  }
}

/**
 * 关闭缓存和预热服务
 */
async function shutdownCache() {
  try {
    cacheWarmup.shutdown();
    await cache.close();
    logger.info('Cache and warmup service shutdown');
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to shutdown cache');
  }
}

module.exports = {
  initCacheWithWarmup,
  shutdownCache,
};
