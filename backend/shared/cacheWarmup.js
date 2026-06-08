/**
 * 缓存预热服务
 * 
 * REQ-00039: 热点数据缓存预热系统
 * 
 * 功能：
 * 1. 服务启动时自动预热热点数据
 * 2. 定时后台刷新
 * 3. 预热状态追踪与监控
 * 4. 手动触发预热 API
 */

const { query } = require('./db');
const { createLogger } = require('./logger');
const metrics = require('./metrics');
const { getEnabledConfigs, getConfig, getConfigNames } = require('./cacheWarmupConfig');

const logger = createLogger('cache-warmup');

// Redis 客户端（延迟初始化）
let redisClient = null;

// 预热状态
const warmupStatus = {
  lastWarmup: null,
  warmupCount: 0,
  failedCount: 0,
  itemsLoaded: 0,
  isWarming: false,
  itemsByType: {},
  errors: [],
};

// 定时器引用
const refreshTimers = new Map();

// Prometheus 指标
let cacheWarmupTotal = null;
let cacheWarmupItems = null;
let cacheWarmupDuration = null;
let cacheWarmupStatus = null;

/**
 * 初始化预热服务
 * @param {Object} options - 配置选项
 * @param {Object} options.redis - Redis 客户端实例
 */
async function initialize(options = {}) {
  const { redis } = options;
  
  if (redis) {
    redisClient = redis;
  }
  
  // 初始化 Prometheus 指标
  initMetrics();
  
  logger.info('Starting cache warmup initialization...');
  warmupStatus.isWarming = true;
  
  const startTime = Date.now();
  
  try {
    // 按优先级排序执行预热
    const configs = getEnabledConfigs();

    for (const { name, config } of configs) {
      const configStartTime = Date.now();
      try {
        const count = await warmupData(name, config);
        const duration = Date.now() - configStartTime;
        
        warmupStatus.itemsByType[name] = count;
        
        logger.info({ 
          name, 
          count, 
          duration: `${duration}ms`,
          priority: config.priority 
        }, 'Warmup completed');
        
        recordMetric('success', name, count, duration);
      } catch (err) {
        warmupStatus.failedCount++;
        warmupStatus.errors.push({
          name,
          error: err.message,
          time: new Date().toISOString(),
        });
        
        logger.error({ name, err: err.message }, 'Warmup failed');
        recordMetric('error', name, 0, Date.now() - configStartTime);
      }
    }

    warmupStatus.lastWarmup = new Date().toISOString();
    warmupStatus.warmupCount++;
    warmupStatus.isWarming = false;
    
    // 启动定时刷新
    startBackgroundRefresh();
    
    const totalDuration = Date.now() - startTime;
    logger.info({ 
      totalItems: warmupStatus.itemsLoaded,
      totalDuration: `${totalDuration}ms`,
      configCount: configs.length 
    }, 'Cache warmup initialization completed');
    
    return {
      success: true,
      itemsLoaded: warmupStatus.itemsLoaded,
      duration: totalDuration,
    };
  } catch (err) {
    warmupStatus.isWarming = false;
    logger.error({ err }, 'Cache warmup initialization failed');
    throw err;
  }
}

/**
 * 初始化 Prometheus 指标
 */
function initMetrics() {
  const promClient = require('prom-client');
  const registry = metrics.register;
  
  try {
    cacheWarmupTotal = new promClient.Counter({
      name: 'minego_cache_warmup_total',
      help: 'Total number of cache warmup operations',
      labelNames: ['name', 'status'],
      registers: [registry],
    });
    
    cacheWarmupItems = new promClient.Gauge({
      name: 'minego_cache_warmup_items_loaded',
      help: 'Number of items loaded during warmup',
      labelNames: ['name'],
      registers: [registry],
    });
    
    cacheWarmupDuration = new promClient.Histogram({
      name: 'minego_cache_warmup_duration_seconds',
      help: 'Duration of cache warmup operations',
      labelNames: ['name'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [registry],
    });
    
    cacheWarmupStatus = new promClient.Gauge({
      name: 'minego_cache_warmup_status',
      help: 'Cache warmup status (1=warming, 0=idle)',
      registers: [registry],
    });
    
    logger.debug('Warmup metrics initialized');
  } catch (err) {
    // 指标可能已存在，忽略错误
    logger.debug({ err: err.message }, 'Metrics may already exist');
  }
}

/**
 * 预热单个数据集
 * @param {string} name - 数据集名称
 * @param {object} config - 数据集配置
 * @returns {Promise<number>} 加载的数据条数
 */
async function warmupData(name, config) {
  const { preloadQuery, cacheKeyTemplate, aggregateKey, ttl } = config;
  
  logger.debug({ name, query: preloadQuery.substring(0, 100) }, 'Starting warmup query');
  
  const { rows } = await query(preloadQuery);
  
  if (!rows || rows.length === 0) {
    logger.warn({ name }, 'No data found for warmup');
    return 0;
  }
  
  let loadedCount = 0;
  
  // 如果有聚合键，存储完整列表
  if (aggregateKey && redisClient) {
    await setCacheValue(aggregateKey, rows, ttl);
    loadedCount++;
  }
  
  // 为每条数据创建独立缓存键
  for (const row of rows) {
    const cacheKey = generateCacheKey(cacheKeyTemplate, row);
    
    if (cacheKey && redisClient) {
      await setCacheValue(cacheKey, row, ttl);
      loadedCount++;
    }
  }
  
  warmupStatus.itemsLoaded += loadedCount;
  
  return loadedCount;
}

/**
 * 生成缓存键
 * @param {string} template - 缓存键模板
 * @param {object} row - 数据行
 * @returns {string|null}
 */
function generateCacheKey(template, row) {
  if (!template) return null;
  
  // 替换模板中的占位符 {field}
  return template.replace(/\{(\w+)\}/g, (match, field) => {
    return row[field] !== undefined ? row[field] : match;
  });
}

/**
 * 设置缓存值
 * @param {string} key - 缓存键
 * @param {any} value - 缓存值
 * @param {number} ttlSeconds - TTL（秒）
 */
async function setCacheValue(key, value, ttlSeconds) {
  if (!redisClient) {
    logger.debug({ key }, 'Redis client not available, skipping cache set');
    return;
  }
  
  try {
    const jsonValue = JSON.stringify(value);
    await redisClient.setex(key, ttlSeconds, jsonValue);
    
    logger.debug({ key, ttl: ttlSeconds, size: jsonValue.length }, 'Cache value set');
  } catch (err) {
    logger.error({ key, err: err.message }, 'Failed to set cache value');
    throw err;
  }
}

/**
 * 启动后台刷新任务
 */
function startBackgroundRefresh() {
  const configs = getEnabledConfigs();
  
  for (const { name, config } of configs) {
    if (!config.refreshInterval) continue;
    
    // 清除已存在的定时器
    if (refreshTimers.has(name)) {
      clearInterval(refreshTimers.get(name));
    }
    
    // 创建新的定时刷新任务
    const timer = setInterval(async () => {
      if (warmupStatus.isWarming) {
        logger.debug({ name }, 'Skipping refresh, warmup in progress');
        return;
      }
      
      logger.debug({ name }, 'Starting background refresh');
      
      try {
        const count = await warmupData(name, config);
        logger.info({ name, count }, 'Background refresh completed');
        recordMetric('refresh', name, count, 0);
      } catch (err) {
        logger.error({ name, err: err.message }, 'Background refresh failed');
        recordMetric('refresh_error', name, 0, 0);
      }
    }, config.refreshInterval);
    
    refreshTimers.set(name, timer);
    
    logger.info({ 
      name, 
      interval: `${config.refreshInterval / 1000}s` 
    }, 'Background refresh scheduled');
  }
}

/**
 * 获取预热状态
 * @returns {object}
 */
function getStatus() {
  return {
    ...warmupStatus,
    configCount: getConfigNames().length,
    enabledCount: getEnabledConfigs().length,
    activeRefreshers: refreshTimers.size,
    redisConnected: redisClient !== null,
  };
}

/**
 * 手动触发预热
 * @param {string|null} dataName - 数据集名称，null 表示预热所有
 * @returns {Promise<object>}
 */
async function triggerWarmup(dataName = null) {
  if (warmupStatus.isWarming) {
    throw new Error('Warmup already in progress');
  }
  
  warmupStatus.isWarming = true;
  cacheWarmupStatus?.set(1);
  
  const results = {};
  const startTime = Date.now();
  
  try {
    if (dataName) {
      const config = getConfig(dataName);
      if (!config) {
        throw new Error(`Unknown data: ${dataName}`);
      }
      if (!config.enabled) {
        throw new Error(`Data disabled: ${dataName}`);
      }
      
      const count = await warmupData(dataName, config);
      results[dataName] = { count, success: true };
    } else {
      // 预热所有启用的数据集
      const configs = getEnabledConfigs();
      
      for (const { name, config } of configs) {
        try {
          const count = await warmupData(name, config);
          results[name] = { count, success: true };
        } catch (err) {
          results[name] = { count: 0, success: false, error: err.message };
        }
      }
    }
    
    warmupStatus.lastWarmup = new Date().toISOString();
    warmupStatus.warmupCount++;
    
    const duration = Date.now() - startTime;
    
    return {
      success: true,
      duration: `${duration}ms`,
      results,
    };
  } finally {
    warmupStatus.isWarming = false;
    cacheWarmupStatus?.set(0);
  }
}

/**
 * 停止指定数据集的刷新
 * @param {string} name - 数据集名称
 */
function stopRefresh(name) {
  if (refreshTimers.has(name)) {
    clearInterval(refreshTimers.get(name));
    refreshTimers.delete(name);
    logger.info({ name }, 'Background refresh stopped');
  }
}

/**
 * 清理资源
 */
function shutdown() {
  for (const timer of refreshTimers.values()) {
    clearInterval(timer);
  }
  refreshTimers.clear();
  
  logger.info('Cache warmup service shutdown');
}

/**
 * 记录 Prometheus 指标
 */
function recordMetric(status, name, count, durationMs) {
  try {
    if (cacheWarmupTotal) {
      cacheWarmupTotal.inc({ name, status });
    }
    
    if (cacheWarmupItems && count > 0) {
      cacheWarmupItems.set({ name }, count);
    }
    
    if (cacheWarmupDuration && durationMs > 0) {
      cacheWarmupDuration.observe({ name }, durationMs / 1000);
    }
  } catch (err) {
    logger.debug({ err: err.message }, 'Failed to record metric');
  }
}

/**
 * 重置统计信息
 */
function resetStats() {
  warmupStatus.itemsLoaded = 0;
  warmupStatus.warmupCount = 0;
  warmupStatus.failedCount = 0;
  warmupStatus.errors = [];
  warmupStatus.itemsByType = {};
  logger.info('Warmup stats reset');
}

module.exports = {
  initialize,
  getStatus,
  triggerWarmup,
  stopRefresh,
  shutdown,
  resetStats,
  warmupData,
};
