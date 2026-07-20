/**
 * 数据库变更数据捕获 (CDC) 适配器
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 
 * 功能：
 * - 监听 PostgreSQL WAL (Write-Ahead Log) 变更事件
 * - 解析变更数据（INSERT/UPDATE/DELETE）
 * - 发送到缓存失效引擎
 * - 支持多实例分布式环境
 */

const { createLogger } = require('../logger');
const EventEmitter = require('events');
const Redis = require('ioredis');

const logger = createLogger('cdc-adapter');

/**
 * CDC 变更事件类型
 */
const ChangeEventType = {
  INSERT: 'insert',
  UPDATE: 'update',
  DELETE: 'delete',
  TRUNCATE: 'truncate'
};

/**
 * CDC 变更事件
 */
class ChangeEvent {
  constructor(data) {
    this.timestamp = data.timestamp || Date.now();
    this.table = data.table;
    this.schema = data.schema || 'public';
    this.operation = data.operation;
    this.before = data.before; // 变更前数据
    this.after = data.after;   // 变更后数据
    this.primaryKey = data.primaryKey;
    this.transactionId = data.transactionId;
  }
  
  /**
   * 获取变更的主键值
   */
  getPrimaryKeyValue() {
    if (this.operation === ChangeEventType.DELETE) {
      return this.primaryKey ? this.primaryKey.value : null;
    }
    return this.after ? this.primaryKey.fields.map(f => this.after[f]).join(':') : null;
  }
  
  /**
   * 获取变更影响的字段
   */
  getChangedFields() {
    if (this.operation === ChangeEventType.INSERT || this.operation === ChangeEventType.DELETE) {
      return Object.keys(this.after || this.before || {});
    }
    
    // UPDATE: 比较前后数据
    const changedFields = [];
    if (this.before && this.after) {
      for (const key of Object.keys(this.after)) {
        if (this.before[key] !== this.after[key]) {
          changedFields.push(key);
        }
      }
    }
    return changedFields;
  }
}

/**
 * PostgreSQL CDC 适配器（基于 LISTEN/NOTIFY）
 */
class PostgreSQLCDCAdapter extends EventEmitter {
  constructor(pgClient, config = {}) {
    super();
    this.pgClient = pgClient;
    this.config = {
      channel: config.channel || 'cache_invalidation',
      schema: config.schema || 'public',
      tables: config.tables || [], // 监听的表列表，空表示所有表
      pollInterval: config.pollInterval || 100, // 轮询间隔（毫秒）
      ...config
    };
    
    this.isRunning = false;
    this.notifyHandler = null;
    
    // Redis 用于广播变更事件（多实例环境）
    this.redisPublisher = null;
    this.redisSubscriber = null;
    this.redisChannel = 'cdc:changes';
    
    // 变更缓冲区（用于防震荡）
    this.changeBuffer = [];
    this.bufferTimer = null;
    this.debounceMs = config.debounceMs || 50;
  }
  
  /**
   * 初始化 CDC 适配器
   */
  async initialize() {
    try {
      // 初始化 Redis 连接（用于多实例广播）
      const redisConfig = {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD,
        db: process.env.REDIS_CDC_DB || 2
      };
      
      this.redisPublisher = new Redis(redisConfig);
      this.redisSubscriber = new Redis(redisConfig);
      
      // 监听 Redis 广播的变更事件
      this.redisSubscriber.subscribe(this.redisChannel, (err) => {
        if (err) {
          logger.error({ err }, 'Failed to subscribe to Redis channel');
        } else {
          logger.info({ channel: this.redisChannel }, 'Subscribed to Redis CDC channel');
        }
      });
      
      this.redisSubscriber.on('message', (channel, message) => {
        if (channel === this.redisChannel) {
          try {
            const event = JSON.parse(message);
            this.emit('change', new ChangeEvent(event));
          } catch (err) {
            logger.error({ err, message }, 'Failed to parse Redis CDC message');
          }
        }
      });
      
      logger.info('CDC adapter initialized');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize CDC adapter');
      throw err;
    }
  }
  
  /**
   * 启动监听数据库变更
   */
  async start() {
    if (this.isRunning) {
      logger.warn('CDC adapter is already running');
      return;
    }
    
    try {
      // 创建触发器函数
      await this.createTriggerFunction();
      
      // 为需要监听的表创建触发器
      await this.createTriggers();
      
      // 监听 PostgreSQL NOTIFY 通道
      await this.listenToChannel();
      
      this.isRunning = true;
      logger.info({ channel: this.config.channel }, 'CDC adapter started');
    } catch (err) {
      logger.error({ err }, 'Failed to start CDC adapter');
      throw err;
    }
  }
  
  /**
   * 创建触发器函数（用于发送 NOTIFY）
   */
  async createTriggerFunction() {
    const sql = `
      CREATE OR REPLACE FUNCTION notify_cache_invalidation()
      RETURNS TRIGGER AS $$
      DECLARE
        change_data JSONB;
        table_name TEXT;
        primary_key_value TEXT;
        primary_key_fields TEXT[];
      BEGIN
        -- 获取表名
        table_name := TG_TABLE_NAME;
        
        -- 根据表名获取主键字段（需要预先配置）
        primary_key_fields := ARRAY[]::TEXT[];
        
        -- 构建变更数据
        change_data := jsonb_build_object(
          'timestamp', EXTRACT(EPOCH FROM NOW()) * 1000,
          'table', table_name,
          'schema', TG_TABLE_SCHEMA,
          'operation', TG_OP,
          'transactionId', txid_current()
        );
        
        -- 根据 操作类型添加数据
        IF TG_OP = 'INSERT' THEN
          change_data := change_data || jsonb_build_object('after', row_to_json(NEW));
        ELSIF TG_OP = 'UPDATE' THEN
          change_data := change_data || jsonb_build_object(
            'before', row_to_json(OLD),
            'after', row_to_json(NEW)
          );
        ELSIF TG_OP = 'DELETE' THEN
          change_data := change_data || jsonb_build_object('before', row_to_json(OLD));
        END IF;
        
        -- 发送 NOTIFY
        PERFORM pg_notify('${this.config.channel}', change_data::TEXT);
        
        -- 返回结果
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        ELSE
          RETURN NEW;
        END IF;
      END;
      $$ LANGUAGE plpgsql;
    `;
    
    await this.pgClient.query(sql);
    logger.info('Trigger function created');
  }
  
  /**
   * 为需要监听的表创建触发器
   */
  async createTriggers() {
    const tables = this.config.tables.length > 0 ? this.config.tables : [
      'users', 'pokemon', 'pokemon_species', 'gyms', 'gym_membership',
      'items', 'user_items', 'friendships', 'trades', 'achievements',
      'raids', 'raid_participants', 'catches', 'marketplace_listings'
    ];
    
    for (const table of tables) {
      const triggerName = `cache_invalidation_${table}`;
      const sql = `
        DO $$
        BEGIN
          -- 删除已存在的触发器（如果有）
          IF EXISTS (
            SELECT 1 FROM pg_trigger WHERE tgname = '${triggerName}'
          ) THEN
            EXECUTE 'DROP TRIGGER ${triggerName} ON ${this.config.schema}.${table}';
          END IF;
          
          -- 创建新触发器
          EXECUTE 'CREATE TRIGGER ${triggerName}
            AFTER INSERT OR UPDATE OR DELETE ON ${this.config.schema}.${table}
            FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation()';
        END
        $$;
      `;
      
      try {
        await this.pgClient.query(sql);
        logger.debug({ table }, 'Trigger created');
      } catch (err) {
        logger.warn({ table, err: err.message }, 'Failed to create trigger (table may not exist)');
      }
    }
    
    logger.info({ tables }, 'Triggers created for tables');
  }
  
  /**
   * 监听 PostgreSQL NOTIFY 通道
   */
  async listenToChannel() {
    await this.pgClient.query(`LISTEN ${this.config.channel}`);
    
    this.notifyHandler = async (notification) => {
      if (notification.channel === this.config.channel) {
        try {
          const data = JSON.parse(notification.payload);
          const event = new ChangeEvent(data);
          
          // 添加到缓冲区（防震荡）
          this.bufferChange(event);
        } catch (err) {
          logger.error({ err, payload: notification.payload }, 'Failed to parse NOTIFY payload');
        }
      }
    };
    
    this.pgClient.on('notification', this.notifyHandler);
    logger.info({ channel: this.config.channel }, 'Listening to channel');
  }
  
  /**
   * 缓冲变更事件（防震荡机制）
   */
  bufferChange(event) {
    this.changeBuffer.push(event);
    
    // 如果没有定时器，启动一个
    if (!this.bufferTimer) {
      this.bufferTimer = setTimeout(() => {
        this.flushBuffer();
      }, this.debounceMs);
    }
  }
  
  /**
   * 刷新缓冲区
   */
  flushBuffer() {
    if (this.changeBuffer.length === 0) {
      this.bufferTimer = null;
      return;
    }
    
    // 取出所有变更事件
    const events = this.changeBuffer.splice(0);
    this.bufferTimer = null;
    
    // 合并相同表的变更（只保留最新的）
    const mergedEvents = this.mergeEvents(events);
    
    // 发送事件
    for (const event of mergedEvents) {
      this.emit('change', event);
      
      // 广播到其他实例
      this.broadcastChange(event);
    }
    
    logger.debug({ count: mergedEvents.length }, 'Changes flushed');
  }
  
  /**
   * 合并变更事件（相同表的变更只保留最新）
   */
  mergeEvents(events) {
    const merged = new Map();
    
    for (const event of events) {
      const key = `${event.schema}.${event.table}:${event.getPrimaryKeyValue()}`;
      
      if (merged.has(key)) {
        const existing = merged.get(key);
        // 保留最新的变更
        if (event.timestamp > existing.timestamp) {
          merged.set(key, event);
        }
      } else {
        merged.set(key, event);
      }
    }
    
    return Array.from(merged.values());
  }
  
  /**
   * 广播变更事件到其他实例
   */
  broadcastChange(event) {
    if (this.redisPublisher) {
      const message = JSON.stringify(event);
      this.redisPublisher.publish(this.redisChannel, message);
      logger.debug({ table: event.table, operation: event.operation }, 'Change broadcasted');
    }
  }
  
  /**
   * 停止监听
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    // 刷新剩余缓冲区
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer);
      this.flushBuffer();
    }
    
    // 停止监听 PostgreSQL 通道
    if (this.notifyHandler) {
      this.pgClient.removeListener('notification', this.notifyHandler);
      await this.pgClient.query(`UNLISTEN ${this.config.channel}`);
    }
    
    // 关闭 Redis 连接
    if (this.redisPublisher) {
      await this.redisPublisher.quit();
    }
    if (this.redisSubscriber) {
      await this.redisSubscriber.quit();
    }
    
    this.isRunning = false;
    logger.info('CDC adapter stopped');
  }
  
  /**
   * 健康检查
   */
  async healthCheck() {
    const health = {
      status: this.isRunning ? 'healthy' : 'stopped',
      channel: this.config.channel,
      bufferSize: this.changeBuffer.length,
      redisConnected: this.redisPublisher && this.redisPublisher.status === 'ready'
    };
    
    return health;
  }
}

module.exports = {
  ChangeEventType,
  ChangeEvent,
  PostgreSQLCDCAdapter
};
