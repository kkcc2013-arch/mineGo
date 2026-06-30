/**
 * REQ-00399: 缓存预热器
 */
const logger = require('./logger');

class CacheWarmer {
  constructor(redisClient) {
    this.redis = redisClient;
    this.cacheKeys = [];
  }
  
  addKey(key, loader) {
    this.cacheKeys.push({ key, loader });
  }
  
  async warm() {
    for (const { key, loader } of this.cacheKeys) {
      try {
        const data = await loader();
        if (data) {
          logger.info({ module: 'CacheWarmer', key, msg: 'Cache warmed' });
        }
      } catch (error) {
        logger.error({ module: 'CacheWarmer', key, error: error.message, msg: 'Failed to warm cache' });
      }
    }
  }
}

async function warmCache(redisClient, keys) {
  const warmer = new CacheWarmer(redisClient);
  keys.forEach(k => warmer.addKey(k.key, k.loader));
  return warmer.warm();
}

module.exports = {
  CacheWarmer,
  warmCache
};