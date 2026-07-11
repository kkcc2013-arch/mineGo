// shared/CDCAdapter.js - 变更数据捕获适配器
'use strict';

/**
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 
 * 变更数据捕获 (CDC) 适配器
 * 监听 PostgreSQL WAL 日志变更，捕获 INSERT/UPDATE/DELETE 操作
 * 
 * 特性：
 * - 基于 PostgreSQL logical replication 机制
 * - 支持 Debezium 协议
 * - 过滤非必要表和操作
 * - 实时推送变更事件到 Kafka
 */

const { createLogger } = require('./logger');
const EventEmitter = require('events');
const PgLogicalDecoder = require('./PgLogicalDecoder');
const KafkaProducer = require('./BusinessEventProducer').instance;

const logger = createLogger('cdc-adapter');

/**
 * CDC 适配器配置
 */
const DEFAULT_CONFIG = {
  // PostgreSQL 连接配置
  postgres: {
    host: process.env.PG_HOST || 'localhost',
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DATABASE || 'minego',
    user: process.env.PG_USER || 'minego_user',
    password: process.env.PG_PASSWORD || '',
    
    // Logical replication 配置
    replicationSlot: 'minego_cache_cdc_slot',
    publicationName: 'minego_cache_publication'
  },
  
  // 监听的表列表（仅核心业务表）
  monitoredTables: [
    'pokemon', 'users', 'gyms', 'raid_battles', 'catch_records',
    'friendships', 'trades', 'items', 'achievements', 'quests',
    'pokemon_inventory', 'gym_defenders', 'user_stats'
  ],
  
  // Kafka 主题配置
  kafkaTopic: 'minego.cdc.events',
  
  // 性能配置
  pollIntervalMs: 100,      // 每 100ms 检查一次 WAL
  maxBatchSize: 1000,       // 单次最大处理 1000 条变更
  debounceMs: 50            // 防震荡延迟 50ms
};

/**
 * CDC 事件结构
 * 
 * @typedef {Object} CDCEvent
 * @property {string} table - 表名
 * @property {string} operation - INSERT/UPDATE/DELETE
 * @property {Object} before - 变更前数据（仅 UPDATE/DELETE）
 * @property {Object} after - 变更后数据（仅 INSERT/UPDATE）
 * @property {Object} key - 主键 { field: value }
 * @property {Date} timestamp - 变更时间戳
 * @property {string} source - 数据源信息
 */

class CDCAdapter extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isRunning = false;
    this.decoder = null;
    this.lastProcessedLSN = null;
    
    // 变更事件缓冲（用于防震荡）
    this.eventBuffer = new Map();
    this.debounceTimer = null;
    
    // 统计数据
    this.stats = {
      totalChanges: 0,
      insertCount: 0,
      updateCount: 0,
      deleteCount: 0,
      errorCount: 0,
      lastEventTime: null,
      avgProcessingDelayMs: 0
    };
    
    logger.info({ config: this.config }, 'CDC Adapter initialized');
  }
  
  /**
   * 启动 CDC 监听
   */
  async start() {
    if (this.isRunning) {
      logger.warn('CDC Adapter already running');
      return;
    }
    
    try {
      // 创建 logical replication slot 和 publication
      await this.setupReplicationSlot();
      
      // 初始化 logical decoder
      this.decoder = new PgLogicalDecoder(this.config.postgres);
      
      // 开始监听 WAL 变更
      this.isRunning = true;
      this.pollLoop();
      
      logger.info('CDC Adapter started successfully');
      this.emit('started');
      
    } catch (error) {
      logger.error({ error }, 'Failed to start CDC Adapter');
      this.isRunning = false;
      throw error;
    }
  }
  
  /**
   * 设置 replication slot 和 publication
   */
  async setupReplicationSlot() {
    const { replicationSlot, publicationName, monitoredTables } = this.config;
    
    // 使用 PostgreSQL 客户端执行配置 SQL
    const client = await this.getPgClient();
    
    try {
      // 创建 publication（如果不存在）
      const publicationExists = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_publication WHERE pubname = $1
        )
      `, [publicationName]);
      
      if (!publicationExists.rows[0].exists) {
        logger.info({ publicationName, tables: monitoredTables }, 'Creating publication');
        
        await client.query(`
          CREATE PUBLICATION ${publicationName} FOR TABLE ${monitoredTables.map(t => `public.${t}`).join(', ')}
        `);
      }
      
      // 创建 replication slot（如果不存在）
      const slotExists = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_replication_slots WHERE slot_name = $1
        )
      `, [replicationSlot]);
      
      if (!slotExists.rows[0].exists) {
        logger.info({ replicationSlot }, 'Creating replication slot');
        
        await client.query(`
          SELECT pg_create_logical_replication_slot($1, 'pgoutput')
        `, [replicationSlot]);
      }
      
      logger.info('Replication slot and publication setup complete');
      
    } finally {
      client.release();
    }
  }
  
  /**
   * 轮询 WAL 变更
   */
  async pollLoop() {
    while (this.isRunning) {
      try {
        const startTime = Date.now();
        
        // 从 WAL 读取变更
        const changes = await this.decoder.readChanges(
          this.config.postgres.replicationSlot,
          this.lastProcessedLSN,
          this.config.maxBatchSize
        );
        
        if (changes.length > 0) {
          // 处理变更事件
          await this.processChanges(changes);
          
          // 更新 LSN（Log Sequence Number）
          this.lastProcessedLSN = changes[changes.length - 1].lsn;
          
          // 更新统计
          this.stats.totalChanges += changes.length;
          this.stats.lastEventTime = new Date();
          
          const processingDelay = Date.now() - startTime;
          this.stats.avgProcessingDelayMs = 
            (this.stats.avgProcessingDelayMs + processingDelay) / 2;
          
          logger.debug({
            changesCount: changes.length,
            processingDelayMs: processingDelay,
            lsn: this.lastProcessedLSN
          }, 'WAL changes processed');
        }
        
        // 等待下一次轮询
        await this.sleep(this.config.pollIntervalMs);
        
      } catch (error) {
        logger.error({ error }, 'Error in poll loop');
        this.stats.errorCount++;
        
        // 等待更长时间后重试
        await this.sleep(1000);
      }
    }
  }
  
  /**
   * 处理变更事件
   */
  async processChanges(changes) {
    // 按表和主键分组（用于防震荡）
    const groupedChanges = this.groupChangesByPrimaryKey(changes);
    
    // 添加到事件缓冲
    for (const [key, changeEvents] of groupedChanges) {
      this.eventBuffer.set(key, changeEvents);
    }
    
    // 启动防震荡计时器
    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.flushBufferedEvents();
      }, this.config.debounceMs);
    }
  }
  
  /**
   * 按表和主键分组变更
   */
  groupChangesByPrimaryKey(changes) {
    const grouped = new Map();
    
    for (const change of changes) {
      const key = `${change.table}:${change.key.id || change.key.user_id || 'unknown'}`;
      
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      
      grouped.get(key).push(change);
    }
    
    return grouped;
  }
  
  /**
   * 刷新缓冲的事件（防震荡后发送）
   */
  async flushBufferedEvents() {
    if (this.eventBuffer.size === 0) {
      this.debounceTimer = null;
      return;
    }
    
    const eventsToFlush = Array.from(this.eventBuffer.values());
    this.eventBuffer.clear();
    this.debounceTimer = null;
    
    // 转换为 CDC 事件格式
    const cdcEvents = eventsToFlush.map(group => {
      // 对于同一主键的多条变更，只保留最后一条
      const latestChange = group[group.length - 1];
      
      return {
        table: latestChange.table,
        operation: latestChange.operation,
        before: latestChange.before,
        after: latestChange.after,
        key: latestChange.key,
        timestamp: new Date(),
        source: {
          name: 'minego-postgres',
          lsn: latestChange.lsn,
          replicationSlot: this.config.postgres.replicationSlot
        }
      };
    });
    
    // 发送到 Kafka
    try {
      await this.sendToKafka(cdcEvents);
      
      // 发送本地事件（供缓存失效引擎监听）
      for (const event of cdcEvents) {
        this.emit('change', event);
        
        // 更新统计
        if (event.operation === 'INSERT') this.stats.insertCount++;
        if (event.operation === 'UPDATE') this.stats.updateCount++;
        if (event.operation === 'DELETE') this.stats.deleteCount++;
      }
      
      logger.info({
        eventCount: cdcEvents.length,
        tables: [...new Set(cdcEvents.map(e => e.table))]
      }, 'CDC events flushed');
      
    } catch (error) {
      logger.error({ error, eventCount: cdcEvents.length }, 'Failed to flush CDC events');
      this.stats.errorCount++;
    }
  }
  
  /**
   * 发送 CDC 事件到 Kafka
   */
  async sendToKafka(events) {
    if (!KafkaProducer) {
      logger.warn('Kafka producer not available, skipping Kafka publishing');
      return;
    }
    
    const messages = events.map(event => ({
      key: `${event.table}:${event.key.id || event.key.user_id}`,
      value: JSON.stringify(event),
      headers: {
        'cdc-table': event.table,
        'cdc-operation': event.operation,
        'cdc-timestamp': event.timestamp.toISOString()
      }
    }));
    
    await KafkaProducer.sendBatch(this.config.kafkaTopic, messages);
    
    logger.debug({ topic: this.config.kafkaTopic, messageCount: messages.length }, 'CDC events sent to Kafka');
  }
  
  /**
   * 停止 CDC 监听
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    this.isRunning = false;
    
    // 清理防震荡计时器
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    
    // 刷新剩余缓冲事件
    if (this.eventBuffer.size > 0) {
      await this.flushBufferedEvents();
    }
    
    // 关闭 decoder
    if (this.decoder) {
      await this.decoder.close();
      this.decoder = null;
    }
    
    logger.info('CDC Adapter stopped');
    this.emit('stopped');
  }
  
  /**
   * 获取统计数据
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      bufferSize: this.eventBuffer.size,
      lastProcessedLSN: this.lastProcessedLSN
    };
  }
  
  /**
   * 获取 PostgreSQL 客户端
   */
  async getPgClient() {
    const { Pool } = require('pg');
    const pool = new Pool({
      host: this.config.postgres.host,
      port: this.config.postgres.port,
      database: this.config.postgres.database,
      user: this.config.postgres.user,
      password: this.config.postgres.password
    });
    
    return pool.connect();
  }
  
  /**
   * Sleep 工具函数
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 单例实例
let instance = null;

/**
 * 获取 CDC 适配器单例
 */
function getInstance(config = {}) {
  if (!instance) {
    instance = new CDCAdapter(config);
  }
  return instance;
}

module.exports = {
  CDCAdapter,
  getInstance,
  DEFAULT_CONFIG
};