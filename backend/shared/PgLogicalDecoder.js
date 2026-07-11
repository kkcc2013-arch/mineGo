// shared/PgLogicalDecoder.js - PostgreSQL Logical Replication Decoder
'use strict';

/**
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 
 * PostgreSQL Logical Replication Decoder
 * 解析 PostgreSQL WAL (Write-Ahead Log) 变更事件
 * 
 * 特性：
 * - 基于 pgoutput 协议解析变更
 * - 支持 INSERT/UPDATE/DELETE 操作
 * - 提取主键信息用于缓存失效
 * - 批量读取变更提高性能
 */

const { createLogger } = require('./logger');

const logger = createLogger('pg-logical-decoder');

/**
 * PostgreSQL Logical Decoder
 */
class PgLogicalDecoder {
  constructor(config) {
    this.config = {
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'minego',
      user: config.user || 'minego_user',
      password: config.password || ''
    };
    
    this.pool = null;
    this.isInitialized = false;
    
    logger.info({ config: this.config }, 'PgLogicalDecoder initialized');
  }
  
  /**
   * 初始化 PostgreSQL 连接池
   */
  async init() {
    if (this.isInitialized) {
      return;
    }
    
    const { Pool } = require('pg');
    
    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    
    this.pool.on('error', (err) => {
      logger.error({ err }, 'PostgreSQL pool error');
    });
    
    this.isInitialized = true;
    logger.info('PostgreSQL connection pool initialized');
  }
  
  /**
   * 从 replication slot 读取变更
   * 
   * 使用 pgoutput 协议解析 WAL 变更
   * 
   * @param {string} slotName - Replication slot 名称
   * @param {string|null} startLSN - 开始读取的 LSN（Log Sequence Number）
   * @param {number} maxBatchSize - 最大批量大小
   * @returns {Array} - 变更事件列表
   */
  async readChanges(slotName, startLSN, maxBatchSize) {
    if (!this.isInitialized) {
      await this.init();
    }
    
    const client = await this.pool.connect();
    
    try {
      // 使用 PostgreSQL logical replication 函数读取变更
      // 注意：这需要 replication 权限
      
      const query = `
        SELECT 
          lsn,
          data
        FROM pg_logical_slot_get_changes($1, $2, $3, 'include-timestamp', 'on', 'write-in-chunks', 'on')
        LIMIT $4
      `;
      
      const result = await client.query(query, [
        slotName,
        startLSN || null,
        maxBatchSize,
        maxBatchSize
      ]);
      
      // 解析 pgoutput 格式的变更数据
      const changes = [];
      
      for (const row of result.rows) {
        const parsedChanges = this.parsePgOutput(row.data, row.lsn);
        changes.push(...parsedChanges);
      }
      
      logger.debug({
        slotName,
        startLSN,
        changesCount: changes.length,
        lastLSN: changes.length > 0 ? changes[changes.length - 1].lsn : null
      }, 'Changes read from replication slot');
      
      return changes;
      
    } catch (error) {
      logger.error({ error, slotName }, 'Failed to read changes from replication slot');
      
      // 如果 replication slot 不存在或无法读取，返回空数组
      // 实际生产环境需要更严格的错误处理
      return [];
      
    } finally {
      client.release();
    }
  }
  
  /**
   * 解析 pgoutput 格式的变更数据
   * 
   * pgoutput 协议格式：
   * - B: Begin
   * - C: Commit
   * - I: Insert
   * - U: Update
   * - D: Delete
   * - R: Relation (表定义)
   * - Y: Type
   * 
   * @param {string} data - pgoutput 数据
   * @param {string} lsn - LSN
   * @returns {Array} - 解析后的变更事件
   */
  parsePgOutput(data, lsn) {
    const changes = [];
    
    // 简化解析：实际生产环境需要完整解析 pgoutput 二进制格式
    // 这里使用简化版本，通过监听数据库变更事件（通过触发器或 LISTEN/NOTIFY）
    
    // 模拟解析逻辑（实际需要解析二进制数据）
    // 生产环境建议使用 Debezium 或 pg-logical-replication 库
    
    try {
      const lines = data.split('\n');
      
      for (const line of lines) {
        if (line.startsWith('I:') || line.startsWith('U:') || line.startsWith('D:')) {
          const parts = line.split(':');
          const operation = parts[0];
          const table = parts[1];
          const keyJson = parts[2];
          const dataJson = parts[3];
          
          const change = {
            lsn,
            table,
            operation: operation === 'I' ? 'INSERT' : 
                       operation === 'U' ? 'UPDATE' : 'DELETE',
            key: JSON.parse(keyJson || '{}'),
            before: null,
            after: null
          };
          
          if (operation === 'I' || operation === 'U') {
            change.after = JSON.parse(dataJson || '{}');
          }
          if (operation === 'U' || operation === 'D') {
            change.before = JSON.parse(dataJson || '{}');
          }
          
          changes.push(change);
        }
      }
      
    } catch (error) {
      logger.error({ error, data }, 'Failed to parse pgoutput data');
    }
    
    return changes;
  }
  
  /**
   * 关闭连接池
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isInitialized = false;
      
      logger.info('PostgreSQL connection pool closed');
    }
  }
}

/**
 * 使用数据库触发器简化 CDC 实现（替代方案）
 * 
 * 在核心业务表上创建触发器，通过 NOTIFY 机制推送变更事件
 */
async function setupTableTriggers(pool) {
  const client = await pool.connect();
  
  try {
    // 创建触发器函数
    await client.query(`
      CREATE OR REPLACE FUNCTION notify_cache_invalidation() RETURNS TRIGGER AS $$
      DECLARE
        payload TEXT;
        table_name TEXT;
        operation TEXT;
        key_data TEXT;
        after_data TEXT;
      BEGIN
        table_name := TG_TABLE_NAME;
        
        IF TG_OP = 'INSERT' THEN
          operation := 'INSERT';
          key_data := json_build_object('id', NEW.id)::TEXT;
          after_data := json_build_object(NEW)::TEXT;
          payload := 'I:' || table_name || ':' || key_data || ':' || after_data;
        ELSIF TG_OP = 'UPDATE' THEN
          operation := 'UPDATE';
          key_data := json_build_object('id', NEW.id)::TEXT;
          after_data := json_build_object(NEW)::TEXT;
          payload := 'U:' || table_name || ':' || key_data || ':' || after_data;
        ELSIF TG_OP = 'DELETE' THEN
          operation := 'DELETE';
          key_data := json_build_object('id', OLD.id)::TEXT;
          payload := 'D:' || table_name || ':' || key_data;
        END IF;
        
        -- 通过 NOTIFY 推送变更事件
        PERFORM pg_notify('minego_cdc_events', payload);
        
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    
    // 为核心业务表创建触发器
    const tables = ['pokemon', 'users', 'gyms', 'raid_battles', 'friendships', 'trades'];
    
    for (const table of tables) {
      await client.query(`
        DROP TRIGGER IF EXISTS ${table}_cdc_trigger ON ${table};
        CREATE TRIGGER ${table}_cdc_trigger
        AFTER INSERT OR UPDATE OR DELETE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION notify_cache_invalidation();
      `);
      
      logger.info({ table }, 'CDC trigger created');
    }
    
    logger.info('All CDC triggers setup complete');
    
  } finally {
    client.release();
  }
}

/**
 * 使用 LISTEN/NOTIFY 监听数据库变更（简化替代方案）
 */
class PgNotificationListener {
  constructor(pool) {
    this.pool = pool;
    this.client = null;
    this.isListening = false;
  }
  
  /**
   * 开始监听 NOTIFY 事件
   */
  async start(eventHandler) {
    if (this.isListening) {
      return;
    }
    
    this.client = await this.pool.connect();
    
    // 设置监听频道
    await this.client.query('LISTEN minego_cdc_events');
    
    // 处理通知事件
    this.client.on('notification', (msg) => {
      if (msg.channel === 'minego_cdc_events') {
        try {
          const changes = this.parseNotificationPayload(msg.payload);
          eventHandler(changes);
        } catch (error) {
          logger.error({ error, payload: msg.payload }, 'Failed to parse notification payload');
        }
      }
    });
    
    this.isListening = true;
    logger.info('Started listening for CDC notification events');
  }
  
  /**
   * 解析通知 payload
   */
  parseNotificationPayload(payload) {
    // 格式：I:table:key:data 或 U:table:key:data 或 D:table:key
    const parts = payload.split(':');
    const operation = parts[0];
    const table = parts[1];
    const key = JSON.parse(parts[2] || '{}');
    const data = parts[3] ? JSON.parse(parts[3]) : null;
    
    return [{
      table,
      operation: operation === 'I' ? 'INSERT' : 
                 operation === 'U' ? 'UPDATE' : 'DELETE',
      key,
      before: operation === 'U' ? data : null,
      after: operation === 'I' || operation === 'U' ? data : null,
      timestamp: new Date()
    }];
  }
  
  /**
   * 停止监听
   */
  async stop() {
    if (!this.isListening) {
      return;
    }
    
    await this.client.query('UNLISTEN minego_cdc_events');
    this.client.release();
    
    this.isListening = false;
    logger.info('Stopped listening for CDC notification events');
  }
}

module.exports = {
  PgLogicalDecoder,
  setupTableTriggers,
  PgNotificationListener
};