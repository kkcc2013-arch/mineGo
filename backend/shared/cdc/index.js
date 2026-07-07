/**
 * REQ-00479: 数据库查询结果缓存自动失效策略系统
 * 
 * 初始化脚本 - 在应用启动时调用
 */

const { createLogger } = require('../logger');
const CacheInvalidationCenter = require('./CacheInvalidationCenter');

const logger = createLogger('cdc-init');

// 单例实例
let centerInstance = null;

/**
 * 初始化缓存失效中心
 */
async function initCacheInvalidation(config = {}) {
  if (centerInstance) {
    logger.warn('Cache invalidation center already initialized');
    return centerInstance;
  }
  
  try {
    centerInstance = new CacheInvalidationCenter({
      // CDC 配置
      cdc: {
        host: process.env.PG_HOST || 'localhost',
        port: process.env.PG_PORT || 5432,
        database: process.env.PG_DATABASE || 'minego',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD,
        tables: [
          'users', 'pokemon', 'catch_records', 'gyms',
          'gyms_teams', 'raids', 'friends', 'items',
          'inventory', 'reward_records', 'payments'
        ],
        channelPrefix: 'cdc_',
        reconnectDelay: 5000,
        maxReconnectAttempts: 10
      },
      
      // 重试队列配置
      retryQueue: {
        redis: {
          host: process.env.REDIS_HOST || 'localhost',
          port: process.env.REDIS_PORT || 6379,
          db: process.env.REDIS_QUEUE_DB || 2
        },
        maxRetries: 5,
        retryDelays: [1000, 5000, 15000, 60000, 300000],
        taskExpiry: 86400000
      },
      
      // 其他配置
      batchSize: 50,
      enabled: process.env.CDC_ENABLED !== 'false',
      
      ...config
    });
    
    // 启动服务
    await centerInstance.start();
    
    logger.info('Cache invalidation center initialized successfully');
    
    return centerInstance;
    
  } catch (error) {
    logger.error({ error }, 'Failed to initialize cache invalidation center');
    throw error;
  }
}

/**
 * 获取缓存失效中心实例
 */
function getCacheInvalidationCenter() {
  if (!centerInstance) {
    throw new Error('Cache invalidation center not initialized. Call initCacheInvalidation() first.');
  }
  return centerInstance;
}

/**
 * 关闭缓存失效中心
 */
async function closeCacheInvalidation() {
  if (centerInstance) {
    await centerInstance.stop();
    centerInstance = null;
    logger.info('Cache invalidation center closed');
  }
}

module.exports = {
  initCacheInvalidation,
  getCacheInvalidationCenter,
  closeCacheInvalidation,
  CacheInvalidationCenter
};