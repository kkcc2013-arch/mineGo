/**
 * 缓存失效引擎
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 
 * 功能：
 * - 监听 CDC 变更事件
 * - 根据配置规则匹配缓存键
 * - 智能失效缓存（删除或更新）
 * - 支持多实例分布式环境
 * - 监控失效成功率与延迟
 */

const { createLogger } = require('../logger');
const Redis = require('ioredis');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');

const logger = createLogger('cache-invalidation-engine');

/**
 * 缓存失效规则配置
 * 
 * 配置示例（YAML 格式）：
 * tables:
 *   users:
 *     primaryKey: id
 *     cacheKeys:
 *       - pattern: "user:{id}"
 *         type: "exact"  # exact: 精确匹配, prefix: 前缀匹配, regex: 正则匹配
 *       - pattern: "user:{id}:*"
 *         type: "prefix"
 *   pokemon:
 *     primaryKey: id
 *     cacheKeys:
 *       - pattern: "pokemon:{id}"
 *         type: "exact"
 *       - pattern: "pokemon:nearby:*"
 *         type: "prefix"
 *         invalidateOn: ["insert", "delete"]  # 仅特定操作失效
 *   gyms:
 *     primaryKey: id
 *     cacheKeys:
 *       - pattern: "gym:{id}"
 *         type: "exact"
 *       - pattern: "gyms:nearby:*"
 *         type: "prefix"
 *       - pattern: "raid:*"
 *         type: "prefix"
 *         invalidateOn: ["insert", "update", "delete"]
 */

/**
 * 缓存失效引擎
 */
class CacheInvalidationEngine extends EventEmitter {
  constructor(cacheModule, cdcAdapter, config = {}) {
    super();
    
    this.cacheModule = cacheModule;
    this.cdcAdapter = cdcAdapter;
    this.config = {
      configPath: config.configPath || path.join(__dirname, '../config/cache-invalidation.yml'),
      enableMetrics: config.enableMetrics !== false,
      maxRetries: config.maxRetries || 3,
      retryDelayMs: config.retryDelayMs || 100,
      ...config
    };
    
    this.invalidationRules = new Map();
    this.redisClient = null;
    this.isInitialized = false;
    
    // 统计数据
    this.metrics = {
      totalChanges: 0,
      invalidatedKeys: 0,
      failedInvalidations: 0,
      averageLatencyMs: 0
    };
  }
  
  /**
   * 初始化引擎
   */
  async initialize() {
    try {
      // 加载失效规则配置
      await this.loadInvalidationRules();
      
      // 初始化 Redis 客户端（用于分布式缓存失效）
      this.redisClient = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_CACHE_DB || 1
      });
      
      // 监听 CDC 变更事件
      this.cdcAdapter.on('change', (event) => {
        this.handleDatabaseChange(event);
      });
      
      this.isInitialized = true;
      logger.info('Cache invalidation engine initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize cache invalidation engine');
      throw err;
    }
  }
  
  /**
   * 加载失效规则配置
   */
  async loadInvalidationRules() {
    try {
      // 尝试从文件加载
      const configExists = await fs.access(this.config.configPath).then(() => true).catch(() => false);
      
      if (configExists) {
        const yaml = require('js-yaml');
        const content = await fs.readFile(this.config.configPath, 'utf8');
        const config = yaml.load(content);
        this.parseInvalidationRules(config);
        logger.info({ path: this.config.configPath }, 'Invalidation rules loaded from file');
      } else {
        // 使用默认配置
        this.loadDefaultInvalidationRules();
        logger.info('Using default invalidation rules');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load invalidation rules file, using defaults');
      this.loadDefaultInvalidationRules();
    }
  }
  
  /**
   * 解析失效规则配置
   */
  parseInvalidationRules(config) {
    if (!config || !config.tables) {
      this.loadDefaultInvalidationRules();
      return;
    }
    
    this.invalidationRules.clear();
    
    for (const [tableName, tableConfig] of Object.entries(config.tables)) {
      this.invalidationRules.set(tableName, {
        primaryKey: tableConfig.primaryKey,
        cacheKeys: tableConfig.cacheKeys.map(rule => ({
          pattern: rule.pattern,
          type: rule.type || 'exact',
          invalidateOn: rule.invalidateOn || ['insert', 'update', 'delete']
        }))
      });
    }
  }
  
  /**
   * 加载默认失效规则
   */
  loadDefaultInvalidationRules() {
    this.invalidationRules = new Map([
      ['users', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'user:{id}', type: 'exact' },
          { pattern: 'user:{id}:*', type: 'prefix' }
        ]
      }],
      ['pokemon', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'pokemon:{id}', type: 'exact' },
          { pattern: 'pokemon:user:{userId}', type: 'exact' },
          { pattern: 'pokemon:nearby:*', type: 'prefix' }
        ]
      }],
      ['pokemon_species', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'species:{id}', type: 'exact' },
          { pattern: 'pokedex:*', type: 'prefix' }
        ]
      }],
      ['gyms', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'gym:{id}', type: 'exact' },
          { pattern: 'gyms:nearby:*', type: 'prefix' },
          { pattern: 'raid:{id}', type: 'exact' }
        ]
      }],
      ['items', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'item:{id}', type: 'exact' },
          { pattern: 'items:*', type: 'prefix' }
        ]
      }],
      ['user_items', {
        primaryKey: ['user_id', 'item_id'],
        cacheKeys: [
          { pattern: 'inventory:{userId}', type: 'exact' },
          { pattern: 'user:{userId}:items', type: 'exact' }
        ]
      }],
      ['friendships', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'friends:{userId}', type: 'exact' },
          { pattern: 'friend:*', type: 'prefix' }
        ]
      }],
      ['trades', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'trade:{id}', type: 'exact' },
          { pattern: 'trades:user:{userId}', type: 'exact' }
        ]
      }],
      ['marketplace_listings', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'listing:{id}', type: 'exact' },
          { pattern: 'marketplace:*', type: 'prefix' }
        ]
      }],
      ['catches', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'catch:{id}', type: 'exact' },
          { pattern: 'catches:user:{userId}', type: 'prefix' }
        ]
      }]
    ]);
  }
  
  /**
   * 处理数据库变更事件
   */
  async handleDatabaseChange(event) {
    const startTime = Date.now();
    
    try {
      this.metrics.totalChanges++;
      
      logger.debug({
        table: event.table,
        operation: event.operation,
        timestamp: event.timestamp
      }, 'Processing database change');
      
      // 查找失效规则
      const rules = this.invalidationRules.get(event.table);
      
      if (!rules) {
        logger.trace({ table: event.table }, 'No invalidation rules for table');
        return;
      }
      
      // 提取主键值
      const primaryKeyValue = this.extractPrimaryKeyValue(event, rules.primaryKey);
      
      if (!primaryKeyValue) {
        logger.warn({ table: event.table }, 'Failed to extract primary key value');
        return;
      }
      
      // 根据规则失效缓存
      const keysToInvalidate = this.generateCacheKeys(rules.cacheKeys, primaryKeyValue, event);
      
      for (const key of keysToInvalidate) {
        await this.invalidateCache(key, event.operation);
      }
      
      // 更新指标
      const latency = Date.now() - startTime;
      this.updateMetrics(latency, keysToInvalidate.length);
      
      logger.info({
        table: event.table,
        operation: event.operation,
        keysInvalidated: keysToInvalidate.length,
        latencyMs: latency
      }, 'Cache invalidation completed');
      
      // 发送事件
      this.emit('invalidation', {
        table: event.table,
        operation: event.operation,
        keys: keysToInvalidate,
        latency
      });
      
    } catch (err) {
      logger.error({ err, event }, 'Failed to handle database change');
      this.metrics.failedInvalidations++;
      this.emit('error', err);
    }
  }
  
  /**
   * 提取主键值
   */
  extractPrimaryKeyValue(event, primaryKey) {
    const data = event.operation === 'delete' ? event.before : event.after;
    
    if (!data) {
      return null;
    }
    
    // 支持复合主键
    if (Array.isArray(primaryKey)) {
      return primaryKey.map(f => data[f]).join(':');
    }
    
    return data[primaryKey];
  }
  
  /**
   * 生成需要失效的缓存键
   */
  generateCacheKeys(cacheKeyRules, primaryKeyValue, event) {
    const keys = [];
    
    for (const rule of cacheKeyRules) {
      // 检查操作类型是否匹配
      if (!rule.invalidateOn.includes(event.operation)) {
        continue;
      }
      
      // 替换占位符
      const pattern = rule.pattern.replace(/{id}/g, primaryKeyValue)
                                   .replace(/{userId}/g, event.after?.user_id || event.before?.user_id || '*');
      
      if (rule.type === 'exact') {
        keys.push(pattern);
      } else if (rule.type === 'prefix') {
        // 查找匹配前缀的所有键
        const matchedKeys = this.findKeysByPrefix(pattern);
        keys.push(...matchedKeys);
      } else if (rule.type === 'regex') {
        // 正则匹配（高级功能）
        const regex = new RegExp(pattern);
        const allKeys = this.getAllCacheKeys();
        const matchedKeys = allKeys.filter(k => regex.test(k));
        keys.push(...matchedKeys);
      }
    }
    
    return [...new Set(keys)]; // 去重
  }
  
  /**
   * 根据前缀查找缓存键
   */
  findKeysByPrefix(prefix) {
    const keys = [];
    
    // 从 Redis 查找
    if (this.redisClient) {
      // 使用 SCAN 避免阻塞
      const stream = this.redisClient.scanStream({
        match: prefix,
        count: 100
      });
      
      stream.on('data', (resultKeys) => {
        keys.push(...resultKeys);
      });
      
      // 注意：这里是同步方法，实际使用时需要 Promise 化
    }
    
    // 从内存缓存查找
    if (this.cacheModule && this.cacheModule.memoryCache) {
      for (const key of this.cacheModule.memoryCache.keys()) {
        if (key.startsWith(prefix.replace('*', ''))) {
          keys.push(key);
        }
      }
    }
    
    return keys;
  }
  
  /**
   * 获取所有缓存键
   */
  getAllCacheKeys() {
    const keys = [];
    
    // 从内存缓存获取
    if (this.cacheModule && this.cacheModule.memoryCache) {
      keys.push(...this.cacheModule.memoryCache.keys());
    }
    
    return keys;
  }
  
  /**
   * 失效缓存
   */
  async invalidateCache(key, operation) {
    let retries = 0;
    
    while (retries < this.config.maxRetries) {
      try {
        // 从内存缓存删除
        if (this.cacheModule && this.cacheModule.memoryCache) {
          this.cacheModule.memoryCache.delete(key);
        }
        
        // 从 Redis 缓存删除
        if (this.redisClient) {
          await this.redisClient.del(key);
        }
        
        this.metrics.invalidatedKeys++;
        
        logger.debug({ key, operation }, 'Cache key invalidated');
        return;
        
      } catch (err) {
        retries++;
        
        if (retries >= this.config.maxRetries) {
          logger.error({ err, key, retries }, 'Failed to invalidate cache after retries');
          this.metrics.failedInvalidations++;
          throw err;
        }
        
        // 延迟重试
        await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs * retries));
      }
    }
  }
  
  /**
   * 更新指标
   */
  updateMetrics(latency, keysCount) {
    // 使用指数移动平均更新平均延迟
    this.metrics.averageLatencyMs = this.metrics.averageLatencyMs * 0.9 + latency * 0.1;
  }
  
  /**
   * 获取指标
   */
  getMetrics() {
    return {
      ...this.metrics,
      rulesCount: this.invalidationRules.size,
      health: this.isInitialized ? 'healthy' : 'uninitialized'
    };
  }
  
  /**
   * 手动添加失效规则
   */
  addInvalidationRule(tableName, config) {
    this.invalidationRules.set(tableName, {
      primaryKey: config.primaryKey,
      cacheKeys: config.cacheKeys.map(rule => ({
        pattern: rule.pattern,
        type: rule.type || 'exact',
        invalidateOn: rule.invalidateOn || ['insert', 'update', 'delete']
      }))
    });
    
    logger.info({ tableName }, 'Invalidation rule added');
  }
  
  /**
   * 移除失效规则
   */
  removeInvalidationRule(tableName) {
    const removed = this.invalidationRules.delete(tableName);
    
    if (removed) {
      logger.info({ tableName }, 'Invalidation rule removed');
    }
    
    return removed;
  }
  
  /**
   * 重新加载配置
   */
  async reloadConfig() {
    await this.loadInvalidationRules();
    logger.info('Invalidation rules reloaded');
  }
  
  /**
   * 健康检查
   */
  async healthCheck() {
    return {
      status: this.isInitialized ? 'healthy' : 'uninitialized',
      rulesCount: this.invalidationRules.size,
      metrics: this.getMetrics(),
      redisConnected: this.redisClient && this.redisClient.status === 'ready'
    };
  }
}

module.exports = CacheInvalidationEngine;
