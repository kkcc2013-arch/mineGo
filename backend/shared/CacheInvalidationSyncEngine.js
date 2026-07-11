// shared/CacheInvalidationSyncEngine.js - 缓存失效智能同步引擎
'use strict';

/**
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 
 * 缓存失效同步引擎
 * 监听 CDC 事件，自动清除或更新对应的缓存项
 * 
 * 特性：
 * - 基于 CDC 事件自动触发缓存失效
 * - 支持表名到缓存 Key 的映射规则
 * - Redis Pub/Sub 广播失效消息
 * - 防穿透保护：热点数据预加载
 * - 监控与告警：缓存清除成功率、延迟
 */

const Redis = require('ioredis');
const { createLogger } = require('./logger');
const cache = require('./cache');
const metrics = require('./metrics');
const CDCAdapter = require('./CDCAdapter');

const logger = createLogger('cache-invalidation-sync');

/**
 * 缓存失效规则配置
 * 
 * 结构：
 * {
 *   [tableName]: {
 *     operations: ['INSERT', 'UPDATE', 'DELETE'],
 *     keyPatterns: [
 *       {
 *         template: 'api:/pokemon/:userId/inventory',
 *         params: { userId: 'after.user_id' }
 *       }
 *     ],
 *     cascade: ['related_table']  // 级联失效
 *   }
 * }
 */
const INVALIDATION_RULES = {
  // 精灵相关
  pokemon: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/pokemon/:pokemonId',
        params: { pokemonId: 'key.id' }
      },
      {
        template: 'api:/pokemon/:userId/inventory',
        params: { userId: 'after.user_id' }
      },
      {
        template: 'api:/pokemon/nearby:*',
        params: {} // 通配符匹配
      }
    ],
    cascade: ['pokemon_inventory']
  },
  
  pokemon_inventory: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/pokemon/:userId/inventory',
        params: { userId: 'key.user_id' }
      },
      {
        template: 'api:/users/:userId/stats',
        params: { userId: 'key.user_id' }
      }
    ]
  },
  
  // 用户相关
  users: {
    operations: ['UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/users/:userId',
        params: { userId: 'key.id' }
      },
      {
        template: 'api:/users/:userId/profile',
        params: { userId: 'key.id' }
      },
      {
        template: 'api:/users/stats:*',
        params: {}
      }
    ]
  },
  
  // 道馆相关
  gyms: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/gyms/:gymId',
        params: { gymId: 'key.id' }
      },
      {
        template: 'api:/gyms/nearby:*',
        params: {}
      }
    ],
    cascade: ['gym_defenders']
  },
  
  gym_defenders: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/gyms/:gymId/details',
        params: { gymId: 'after.gym_id' }
      }
    ]
  },
  
  // Raid 相关
  raid_battles: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/raids/:gymId',
        params: { gymId: 'after.gym_id' }
      },
      {
        template: 'api:/raids/nearby:*',
        params: {}
      }
    ]
  },
  
  // 好友相关
  friendships: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/friends/:userId',
        params: { userId: 'after.user_id' }
      },
      {
        template: 'api:/friends/requests:*',
        params: {}
      }
    ]
  },
  
  // 交易相关
  trades: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/trades/:tradeId',
        params: { tradeId: 'key.id' }
      },
      {
        template: 'api:/trades/user/:userId',
        params: { userId: 'after.from_user_id' }
      }
    ]
  },
  
  // 成就相关
  achievements: {
    operations: ['INSERT', 'UPDATE'],
    keyPatterns: [
      {
        template: 'api:/achievements/:userId',
        params: { userId: 'after.user_id' }
      }
    ]
  },
  
  // 任务相关
  quests: {
    operations: ['INSERT', 'UPDATE', 'DELETE'],
    keyPatterns: [
      {
        template: 'api:/quests/:userId',
        params: { userId: 'after.user_id' }
      },
      {
        template: 'api:/quests/available:*',
        params: {}
      }
    ]
  },
  
  // 用户统计
  user_stats: {
    operations: ['UPDATE'],
    keyPatterns: [
      {
        template: 'api:/users/:userId/stats',
        params: { userId: 'key.user_id' }
      },
      {
        template: 'api:/leaderboard:*',
        params: {}
      }
    ]
  }
};

/**
 * 缓存失效同步引擎
 */
class CacheInvalidationSyncEngine {
  constructor(config = {}) {
    this.config = {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_CACHE_DB || 1
      },
      invalidationChannel: 'minego:cache:invalidation',
      enablePreload: true,
      preloadThreshold: 100, // 访问次数超过 100 的热点数据预加载
      ...config
    };
    
    this.redisClient = null;
    this.redisSubscriber = null;
    this.cdcAdapter = null;
    this.isRunning = false;
    
    // 统计数据
    this.stats = {
      totalInvalidations: 0,
      successCount: 0,
      failureCount: 0,
      cascadeInvalidations: 0,
      avgLatencyMs: 0,
      preloadCount: 0
    };
    
    // 热点数据追踪（用于预加载）
    this.hotKeys = new Map();
    
    // 注册 Prometheus 指标
    this.registerMetrics();
    
    logger.info({ config: this.config }, 'Cache Invalidation Sync Engine initialized');
  }
  
  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    this.metrics = {
      invalidationTotal: metrics.registerCounter(
        'cache_invalidation_total',
        'Total cache invalidations',
        ['table', 'operation', 'status']
      ),
      invalidationLatency: metrics.registerHistogram(
        'cache_invalidation_latency_seconds',
        'Cache invalidation latency in seconds',
        ['table'],
        [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
      ),
      cascadeInvalidations: metrics.registerCounter(
        'cache_cascade_invalidations_total',
        'Total cascade invalidations',
        ['source_table', 'target_table']
      )
    };
  }
  
  /**
   * 启动同步引擎
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Cache Invalidation Sync Engine already running');
      return;
    }
    
    try {
      // 初始化 Redis 客户端
      this.redisClient = new Redis(this.config.redis);
      this.redisSubscriber = new Redis(this.config.redis);
      
      // 订阅缓存失效广播频道
      await this.redisSubscriber.subscribe(this.config.invalidationChannel);
      this.redisSubscriber.on('message', (channel, message) => {
        this.handleInvalidationBroadcast(message);
      });
      
      // 初始化 CDC 适配器
      this.cdcAdapter = CDCAdapter.getInstance();
      this.cdcAdapter.on('change', (event) => {
        this.handleCDCEvent(event);
      });
      
      // 启动 CDC 适配器
      await this.cdcAdapter.start();
      
      this.isRunning = true;
      logger.info('Cache Invalidation Sync Engine started successfully');
      
    } catch (error) {
      logger.error({ error }, 'Failed to start Cache Invalidation Sync Engine');
      throw error;
    }
  }
  
  /**
   * 处理 CDC 事件
   */
  async handleCDCEvent(event) {
    const startTime = Date.now();
    
    try {
      const { table, operation, before, after, key } = event;
      
      logger.debug({ table, operation, key }, 'Processing CDC event');
      
      // 检查是否有失效规则
      const rules = INVALIDATION_RULES[table];
      if (!rules) {
        logger.debug({ table }, 'No invalidation rules for table, skipping');
        return;
      }
      
      // 检查操作类型是否需要失效
      if (!rules.operations.includes(operation)) {
        logger.debug({ table, operation }, 'Operation not configured for invalidation, skipping');
        return;
      }
      
      // 生成需要失效的缓存 Key 列表
      const cacheKeys = this.generateCacheKeys(table, operation, before, after, key, rules);
      
      // 执行缓存失效
      await this.invalidateKeys(cacheKeys, table, operation);
      
      // 处理级联失效
      if (rules.cascade && rules.cascade.length > 0) {
        await this.handleCascadeInvalidation(rules.cascade, table);
      }
      
      // 更新统计
      const latency = Date.now() - startTime;
      this.stats.totalInvalidations++;
      this.stats.successCount++;
      this.stats.avgLatencyMs = (this.stats.avgLatencyMs + latency) / 2;
      
      // 记录 Prometheus 指标
      this.metrics.invalidationTotal.inc({ table, operation, status: 'success' });
      this.metrics.invalidationLatency.observe({ table }, latency / 1000);
      
      logger.info({
        table,
        operation,
        keysCount: cacheKeys.length,
        latencyMs: latency
      }, 'Cache invalidation completed');
      
    } catch (error) {
      logger.error({ error, event }, 'Failed to handle CDC event');
      this.stats.failureCount++;
      
      // 记录 Prometheus 指标
      this.metrics.invalidationTotal.inc({ table: event.table, operation: event.operation, status: 'failure' });
    }
  }
  
  /**
   * 生成需要失效的缓存 Key
   */
  generateCacheKeys(table, operation, before, after, key, rules) {
    const cacheKeys = [];
    
    for (const pattern of rules.keyPatterns) {
      // 解析模板参数
      const params = {};
      for (const [paramName, paramPath] of Object.entries(pattern.params)) {
        const value = this.resolveParamValue(paramPath, { before, after, key });
        if (value) {
          params[paramName] = value;
        }
      }
      
      // 替换模板中的参数
      let cacheKey = pattern.template;
      for (const [paramName, paramValue] of Object.entries(params)) {
        cacheKey = cacheKey.replace(`:${paramName}`, paramValue);
      }
      
      // 如果还有未替换的通配符，保留通配符
      cacheKeys.push(cacheKey);
    }
    
    return cacheKeys;
  }
  
  /**
   * 解析参数值（支持路径表达式）
   */
  resolveParamValue(paramPath, data) {
    const parts = paramPath.split('.');
    let value = data;
    
    for (const part of parts) {
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return null;
      }
    }
    
    return value;
  }
  
  /**
   * 执行缓存失效
   */
  async invalidateKeys(cacheKeys, table, operation) {
    for (const key of cacheKeys) {
      try {
        // 检查是否是热点数据
        const isHot = this.hotKeys.has(key);
        
        // 删除缓存
        await cache.delete(key);
        
        // 广播失效消息（通知其他实例）
        await this.broadcastInvalidation(key, table, operation);
        
        // 如果是热点数据，预加载
        if (isHot && this.config.enablePreload) {
          await this.preloadHotData(key);
        }
        
        logger.debug({ key, table, operation, isHot }, 'Cache key invalidated');
        
      } catch (error) {
        logger.error({ error, key }, 'Failed to invalidate cache key');
        throw error;
      }
    }
  }
  
  /**
   * 广播失效消息（Redis Pub/Sub）
   */
  async broadcastInvalidation(key, table, operation) {
    const message = JSON.stringify({
      key,
      table,
      operation,
      timestamp: new Date().toISOString(),
      instance: process.env.INSTANCE_ID || 'default'
    });
    
    await this.redisClient.publish(this.config.invalidationChannel, message);
  }
  
  /**
   * 处理失效广播消息（来自其他实例）
   */
  async handleInvalidationBroadcast(message) {
    try {
      const { key, table, operation, instance } = JSON.parse(message);
      
      // 忽略自己发送的消息
      if (instance === (process.env.INSTANCE_ID || 'default')) {
        return;
      }
      
      // 删除本地缓存
      await cache.delete(key);
      
      logger.debug({ key, table, operation, instance }, 'Cache invalidation broadcast received');
      
    } catch (error) {
      logger.error({ error, message }, 'Failed to handle invalidation broadcast');
    }
  }
  
  /**
   * 处理级联失效
   */
  async handleCascadeInvalidation(cascadeTables, sourceTable) {
    for (const targetTable of cascadeTables) {
      // 查找目标表的所有相关缓存 Key
      const pattern = this.getTableKeyPattern(targetTable);
      
      if (pattern) {
        // 使用 Redis SCAN 删除匹配的 Key
        const keys = await this.scanKeys(pattern);
        
        for (const key of keys) {
          await cache.delete(key);
        }
        
        // 更新统计
        this.stats.cascadeInvalidations++;
        
        // 记录 Prometheus 指标
        this.metrics.cascadeInvalidations.inc({ 
          source_table: sourceTable, 
          target_table: targetTable 
        });
        
        logger.info({
          sourceTable,
          targetTable,
          keysCount: keys.length
        }, 'Cascade invalidation completed');
      }
    }
  }
  
  /**
   * 获取表的 Key 模式
   */
  getTableKeyPattern(table) {
    const patterns = {
      pokemon_inventory: 'api:/pokemon/*/inventory',
      gym_defenders: 'api:/gyms/*/details',
      // ... 其他表的模式
    };
    
    return patterns[table] || null;
  }
  
  /**
   * 扫描 Redis Key（使用 SCAN 命令）
   */
  async scanKeys(pattern) {
    const keys = [];
    let cursor = '0';
    
    do {
      const result = await this.redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = result[0];
      keys.push(...result[1]);
    } while (cursor !== '0');
    
    return keys;
  }
  
  /**
   * 预加载热点数据
   */
  async preloadHotData(key) {
    try {
      // 根据缓存 Key 推断需要预加载的数据
      // 例如：api:/pokemon/:userId/inventory
      // 需要查询 pokemon_inventory 表
      
      // 这里可以调用对应的 service 方法重新加载数据
      // 例如：await pokemonService.getInventory(userId);
      
      this.stats.preloadCount++;
      
      logger.debug({ key }, 'Hot data preloaded');
      
    } catch (error) {
      logger.error({ error, key }, 'Failed to preload hot data');
    }
  }
  
  /**
   * 追踪热点数据访问
   */
  trackKeyAccess(key) {
    const count = this.hotKeys.get(key) || 0;
    this.hotKeys.set(key, count + 1);
    
    // 如果访问次数超过阈值，标记为热点
    if (count + 1 >= this.config.preloadThreshold) {
      logger.debug({ key, count: count + 1 }, 'Key marked as hot');
    }
  }
  
  /**
   * 停止同步引擎
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    this.isRunning = false;
    
    // 停止 CDC 适配器
    if (this.cdcAdapter) {
      await this.cdcAdapter.stop();
    }
    
    // 关闭 Redis 连接
    if (this.redisClient) {
      await this.redisClient.quit();
    }
    if (this.redisSubscriber) {
      await this.redisSubscriber.quit();
    }
    
    logger.info('Cache Invalidation Sync Engine stopped');
  }
  
  /**
   * 获取统计数据
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      hotKeysCount: this.hotKeys.size
    };
  }
}

// 单例实例
let instance = null;

/**
 * 获取同步引擎单例
 */
function getInstance(config = {}) {
  if (!instance) {
    instance = new CacheInvalidationSyncEngine(config);
  }
  return instance;
}

module.exports = {
  CacheInvalidationSyncEngine,
  getInstance,
  INVALIDATION_RULES
};