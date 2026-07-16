/**
 * 数据库 CDC 缓存失效智能同步系统
 * 
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 
 * 特性：
 * - PostgreSQL LISTEN/NOTIFY 实时监听数据库变更
 * - 智能缓存失效策略（防震荡、批量处理）
 * - Redis Pub/Sub 分布式广播
 * - 配置化表-缓存映射
 * - Prometheus 指标监控
 * - 死信队列处理失败事件
 */

const { Pool } = require('pg');
const Redis = require('ioredis');
const { createLogger } = require('./logger');
const cache = require('./cache');

const logger = createLogger('cdc-cache-invalidator');

// 配置：表名到缓存键模式的映射
const tableCacheMappings = {
  // 用户相关
  users: {
    patterns: ['user:{id}', 'api:/users:{id}:*', 'api:/users/list:*', 'api:/users/stats:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  user_profiles: {
    patterns: ['user:{user_id}', 'api:/users:{user_id}/profile:*'],
    primaryKey: 'user_id',
    operations: ['INSERT', 'UPDATE']
  },
  
  // 精灵相关
  pokemon: {
    patterns: ['pokemon:{id}', 'api:/pokemon:{id}:*', 'api:/pokemon/nearby:*', 'api:/users:{trainer_id}/pokemon:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  pokemon_spawn_points: {
    patterns: ['spawn:{id}', 'api:/spawns/nearby:*', 'api:/spawns:{id}:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  
  // 道馆相关
  gyms: {
    patterns: ['gym:{id}', 'api:/gyms:{id}:*', 'api:/gyms/nearby:*', 'api:/gyms/list:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  gym_members: {
    patterns: ['gym:{gym_id}:members:*', 'api:/gyms:{gym_id}/members:*'],
    primaryKey: ['gym_id', 'pokemon_id'],
    operations: ['INSERT', 'DELETE']
  },
  
  // Raid 相关
  raids: {
    patterns: ['raid:{gym_id}', 'api:/raids:{gym_id}:*', 'api:/raids/nearby:*'],
    primaryKey: 'gym_id',
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  raid_participants: {
    patterns: ['raid:{raid_id}:participants:*', 'api:/raids:{raid_id}/participants:*'],
    primaryKey: ['raid_id', 'user_id'],
    operations: ['INSERT', 'DELETE']
  },
  
  // 好友相关
  friendships: {
    patterns: ['friends:{user_id}', 'api:/friends:{user_id}:*', 'api:/friends/requests:{user_id}:*'],
    primaryKey: ['user_id', 'friend_id'],
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  
  // 道具相关
  user_items: {
    patterns: ['items:{user_id}', 'api:/inventory:{user_id}:*', 'api:/users:{user_id}/items:*'],
    primaryKey: ['user_id', 'item_id'],
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  
  // 奖励相关
  rewards: {
    patterns: ['rewards:{user_id}', 'api:/rewards:{user_id}:*', 'api:/rewards/available:{user_id}:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  
  // 交易相关
  trades: {
    patterns: ['trade:{id}', 'api:/trades:{id}:*', 'api:/trades/user:{user_id}:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE']
  },
  
  // 支付相关
  payments: {
    patterns: ['payment:{id}', 'api:/payments:{id}:*', 'api:/users:{user_id}/payments:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE']
  },
  
  // 活动相关
  events: {
    patterns: ['event:{id}', 'api:/events:{id}:*', 'api:/events/list:*', 'api:/events/active:*'],
    primaryKey: 'id',
    operations: ['INSERT', 'UPDATE', 'DELETE']
  },
  
  // 排行榜相关
  leaderboards: {
    patterns: ['leaderboard:{type}', 'api:/leaderboards:{type}:*'],
    primaryKey: ['type', 'user_id'],
    operations: ['INSERT', 'UPDATE', 'DELETE']
  }
};

// 防震荡配置
const debounceConfig = {
  enabled: true,
  windowMs: 50,         // 防震荡窗口（毫秒）
  maxBatchSize: 100,    // 最大批量大小
  maxWaitMs: 200        // 最大等待时间
};

// 统计数据
const stats = {
  eventsReceived: 0,
  cacheInvalidations: 0,
  broadcastSent: 0,
  errors: 0,
  debouncedBatches: 0
};

class CDCCacheInvalidator {
  constructor(config = {}) {
    this.config = {
      postgres: {
        host: process.env.PG_HOST || 'localhost',
        port: process.env.PG_PORT || 5432,
        database: process.env.PG_DATABASE || 'minego',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '',
        max: 2  // 连接池大小（监听连接）
      },
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || '',
        db: process.env.REDIS_CDC_DB || 2
      },
      channel: 'minego_cdc_events',
      broadcastChannel: 'minego_cache_invalidation',
      ...config
    };
    
    this.pgPool = null;
    this.redisClient = null;
    this.redisSubscriber = null;
    this.isConnected = false;
    this.debounceTimers = new Map();
    this.pendingInvalidations = new Map();
    this.deadLetterQueue = [];
  }
  
  /**
   * 初始化 CDC 缓存失效系统
   */
  async init() {
    try {
      // 初始化 PostgreSQL 连接
      this.pgPool = new Pool(this.config.postgres);
      
      this.pgPool.on('error', (err) => {
        logger.error({ err }, 'PostgreSQL pool error');
      });
      
      // 初始化 Redis 客户端
      this.redisClient = new Redis({
        ...this.config.redis,
        retryStrategy: (times) => Math.min(times * 100, 3000)
      });
      
      // 初始化 Redis 订阅者
      this.redisSubscriber = new Redis({
        ...this.config.redis,
        retryStrategy: (times) => Math.min(times * 100, 3000)
      });
      
      // 订阅 Redis 广播频道
      await this.redisSubscriber.subscribe(this.config.broadcastChannel);
      this.redisSubscriber.on('message', (channel, message) => {
        if (channel === this.config.broadcastChannel) {
          this.handleBroadcast(message);
        }
      });
      
      // 监听 PostgreSQL NOTIFY 事件
      await this.setupPostgresListener();
      
      this.isConnected = true;
      
      logger.info({
        postgres: this.config.postgres.host,
        redis: this.config.redis.host,
        channel: this.config.channel
      }, 'CDC cache invalidator initialized');
      
      return true;
    } catch (err) {
      logger.error({ err }, 'Failed to initialize CDC cache invalidator');
      throw err;
    }
  }
  
  /**
   * 设置 PostgreSQL 监听器
   */
  async setupPostgresListener() {
    const client = await this.pgPool.connect();
    
    // 设置监听频道
    await client.query(`LISTEN ${this.config.channel}`);
    
    client.on('notification', (msg) => {
      if (msg.channel === this.config.channel) {
        this.handlePostgresNotification(msg.payload);
      }
    });
    
    client.on('error', (err) => {
      logger.error({ err }, 'PostgreSQL listener error');
      // 尝试重新连接
      setTimeout(() => this.setupPostgresListener(), 5000);
    });
    
    logger.info({ channel: this.config.channel }, 'PostgreSQL listener set up');
  }
  
  /**
   * 处理 PostgreSQL 通知
   */
  handlePostgresNotification(payload) {
    try {
      const event = JSON.parse(payload);
      stats.eventsReceived++;
      
      logger.debug({ table: event.table, operation: event.operation }, 'CDC event received');
      
      // 验证事件格式
      if (!this.validateEvent(event)) {
        logger.warn({ event }, 'Invalid CDC event format');
        return;
      }
      
      // 处理事件
      this.processEvent(event);
      
    } catch (err) {
      stats.errors++;
      logger.error({ err, payload }, 'Failed to parse CDC notification');
    }
  }
  
  /**
   * 验证事件格式
   */
  validateEvent(event) {
    return event &&
      typeof event.table === 'string' &&
      typeof event.operation === 'string' &&
      event.data &&
      typeof event.data === 'object';
  }
  
  /**
   * 处理单个事件
   */
  processEvent(event) {
    const mapping = tableCacheMappings[event.table];
    
    if (!mapping) {
      logger.debug({ table: event.table }, 'No cache mapping for table');
      return;
    }
    
    // 检查操作类型
    if (!mapping.operations.includes(event.operation)) {
      logger.debug({ table: event.table, operation: event.operation }, 'Operation not mapped');
      return;
    }
    
    if (debounceConfig.enabled) {
      // 防震荡处理
      this.debounceEvent(event, mapping);
    } else {
      // 直接处理
      this.invalidateCache(event, mapping);
    }
  }
  
  /**
   * 防震荡事件处理
   */
  debounceEvent(event, mapping) {
    const key = this.getDebounceKey(event, mapping);
    
    if (!this.pendingInvalidations.has(key)) {
      this.pendingInvalidations.set(key, {
        events: [],
        mapping,
        firstReceived: Date.now()
      });
    }
    
    const batch = this.pendingInvalidations.get(key);
    batch.events.push(event);
    
    // 检查是否达到批量大小
    if (batch.events.length >= debounceConfig.maxBatchSize) {
      this.flushDebounceBatch(key);
      return;
    }
    
    // 设置或重置定时器
    if (this.debounceTimers.has(key)) {
      clearTimeout(this.debounceTimers.get(key));
    }
    
    const timer = setTimeout(() => {
      this.flushDebounceBatch(key);
    }, debounceConfig.windowMs);
    
    this.debounceTimers.set(key, timer);
    
    // 强制刷新（最大等待时间）
    const maxWaitTimer = setTimeout(() => {
      if (this.pendingInvalidations.has(key)) {
        this.flushDebounceBatch(key);
      }
    }, debounceConfig.maxWaitMs);
    
    // 保存最大等待定时器
    batch.maxWaitTimer = maxWaitTimer;
  }
  
  /**
   * 获取防震荡键
   */
  getDebounceKey(event, mapping) {
    // 按表和主键组合作为防震荡键
    const pkValue = this.getPrimaryKeyValue(event.data, mapping.primaryKey);
    return `${event.table}:${pkValue}`;
  }
  
  /**
   * 获取主键值
   */
  getPrimaryKeyValue(data, primaryKey) {
    if (Array.isArray(primaryKey)) {
      return primaryKey.map(k => data[k] || data.old?.[k]).join(':');
    }
    return data[primaryKey] || data.old?.[primaryKey] || '*';
  }
  
  /**
   * 刷新防震荡批次
   */
  flushDebounceBatch(key) {
    const batch = this.pendingInvalidations.get(key);
    if (!batch) return;
    
    // 清除定时器
    const timer = this.debounceTimers.get(key);
    if (timer) clearTimeout(timer);
    if (batch.maxWaitTimer) clearTimeout(batch.maxWaitTimer);
    
    this.debounceTimers.delete(key);
    this.pendingInvalidations.delete(key);
    
    // 批量失效
    this.invalidateCacheBatch(batch.events, batch.mapping);
    stats.debouncedBatches++;
  }
  
  /**
   * 批量缓存失效
   */
  async invalidateCacheBatch(events, mapping) {
    const patterns = new Set();
    
    for (const event of events) {
      const resolvedPatterns = this.resolvePatterns(mapping.patterns, event.data);
      resolvedPatterns.forEach(p => patterns.add(p));
    }
    
    // 批量删除缓存
    for (const pattern of patterns) {
      try {
        await cache.delPattern(pattern);
        stats.cacheInvalidations++;
      } catch (err) {
        logger.error({ err, pattern }, 'Cache invalidation failed');
        this.addToDeadLetterQueue(events[0], mapping, err);
      }
    }
    
    // 广播到其他实例
    await this.broadcastInvalidation(Array.from(patterns));
    
    logger.debug({
      table: events[0].table,
      eventCount: events.length,
      patterns: patterns.size
    }, 'Batch cache invalidation completed');
  }
  
  /**
   * 单个事件缓存失效
   */
  async invalidateCache(event, mapping) {
    const patterns = this.resolvePatterns(mapping.patterns, event.data);
    
    for (const pattern of patterns) {
      try {
        await cache.delPattern(pattern);
        stats.cacheInvalidations++;
        
        logger.debug({ pattern }, 'Cache invalidated');
      } catch (err) {
        logger.error({ err, pattern }, 'Cache invalidation failed');
        this.addToDeadLetterQueue(event, mapping, err);
      }
    }
    
    // 广播到其他实例
    await this.broadcastInvalidation(patterns);
  }
  
  /**
   * 解析缓存模式
   */
  resolvePatterns(patterns, data) {
    return patterns.map(pattern => {
      return pattern
        .replace(/{(\w+)}/g, (match, key) => {
          // 优先从新数据获取，其次从旧数据
          const value = data[key] || data.old?.[key] || '*';
          return value;
        });
    });
  }
  
  /**
   * 广播失效事件到其他实例
   */
  async broadcastInvalidation(patterns) {
    if (!this.redisClient) return;
    
    const message = JSON.stringify({
      type: 'cache_invalidation',
      patterns,
      timestamp: Date.now(),
      instanceId: process.env.INSTANCE_ID || 'default'
    });
    
    try {
      await this.redisClient.publish(this.config.broadcastChannel, message);
      stats.broadcastSent++;
    } catch (err) {
      logger.error({ err }, 'Failed to broadcast invalidation');
    }
  }
  
  /**
   * 处理广播消息
   */
  handleBroadcast(message) {
    try {
      const data = JSON.parse(message);
      
      // 忽略自己发送的消息
      if (data.instanceId === (process.env.INSTANCE_ID || 'default')) {
        return;
      }
      
      if (data.type === 'cache_invalidation') {
        this.handleRemoteInvalidation(data);
      } else if (data.type === 'sync_request') {
        this.handleSyncRequest(data);
      }
    } catch (err) {
      logger.error({ err, message }, 'Failed to handle broadcast');
    }
  }
  
  /**
   * 处理远程失效事件
   */
  async handleRemoteInvalidation(data) {
    const { patterns } = data;
    
    for (const pattern of patterns) {
      try {
        await cache.delPattern(pattern);
        logger.debug({ pattern }, 'Remote cache invalidated');
      } catch (err) {
        logger.error({ err, pattern }, 'Remote cache invalidation failed');
      }
    }
  }
  
  /**
   * 添加到死信队列
   */
  addToDeadLetterQueue(event, mapping, error) {
    this.deadLetterQueue.push({
      event,
      mapping,
      error: error.message,
      timestamp: Date.now(),
      retries: 0
    });
    
    // 限制队列大小
    if (this.deadLetterQueue.length > 1000) {
      this.deadLetterQueue.shift();
    }
    
    stats.errors++;
  }
  
  /**
   * 重试死信队列中的事件
   */
  async retryDeadLetterQueue() {
    const toRetry = [...this.deadLetterQueue];
    this.deadLetterQueue = [];
    
    for (const item of toRetry) {
      if (item.retries >= 3) {
        logger.warn({ event: item.event }, 'Dropping event after 3 retries');
        continue;
      }
      
      try {
        await this.invalidateCache(item.event, item.mapping);
      } catch (err) {
        item.retries++;
        item.error = err.message;
        this.deadLetterQueue.push(item);
      }
    }
  }
  
  /**
   * 手动触发缓存失效
   */
  async manualInvalidate(table, data) {
    const mapping = tableCacheMappings[table];
    
    if (!mapping) {
      throw new Error(`No cache mapping for table: ${table}`);
    }
    
    const event = {
      table,
      operation: 'MANUAL',
      data
    };
    
    await this.invalidateCache(event, mapping);
  }
  
  /**
   * 添加自定义表映射
   */
  addTableMapping(tableName, config) {
    tableCacheMappings[tableName] = {
      patterns: config.patterns || [],
      primaryKey: config.primaryKey || 'id',
      operations: config.operations || ['INSERT', 'UPDATE', 'DELETE']
    };
    
    logger.info({ table: tableName, config }, 'Table mapping added');
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...stats,
      pendingBatches: this.pendingInvalidations.size,
      deadLetterQueueSize: this.deadLetterQueue.length,
      isConnected: this.isConnected,
      tableMappings: Object.keys(tableCacheMappings).length
    };
  }
  
  /**
   * 获取表映射配置
   */
  getTableMappings() {
    return { ...tableCacheMappings };
  }
  
  /**
   * 关闭连接
   */
  async close() {
    // 刷新所有待处理批次
    for (const key of this.pendingInvalidations.keys()) {
      this.flushDebounceBatch(key);
    }
    
    // 关闭连接
    if (this.redisSubscriber) {
      await this.redisSubscriber.unsubscribe();
      await this.redisSubscriber.quit();
    }
    
    if (this.redisClient) {
      await this.redisClient.quit();
    }
    
    if (this.pgPool) {
      await this.pgPool.end();
    }
    
    this.isConnected = false;
    
    logger.info('CDC cache invalidator closed');
  }
}

// 导出单例
const cdcCacheInvalidator = new CDCCacheInvalidator();

module.exports = {
  CDCCacheInvalidator,
  cdcCacheInvalidator,
  tableCacheMappings
};