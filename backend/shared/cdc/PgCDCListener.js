/**
 * PostgreSQL CDC 监听器 - 基于 LISTEN/NOTIFY 实现数据库变更捕获
 * 
 * REQ-00479: 数据库查询结果缓存自动失效策略系统
 * 
 * 特性：
 * - 监听 PostgreSQL NOTIFY 事件
 * - 解析变更事件 payload
 * - 发送到缓存失效中心
 * - 支持多种数据库表的监听
 */

const { Pool } = require('pg');
const { createLogger } = require('../logger');
const EventEmitter = require('events');

const logger = createLogger('pg-cdc-listener');

class PgCDCListener extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.config = {
      // PostgreSQL 连接配置
      host: config.host || process.env.PG_HOST || 'localhost',
      port: config.port || process.env.PG_PORT || 5432,
      database: config.database || process.env.PG_DATABASE || 'minego',
      user: config.user || process.env.PG_USER || 'postgres',
      password: config.password || process.env.PG_PASSWORD,
      
      // 监听的数据库表
      tables: config.tables || [
        'users', 'pokemon', 'catch_records', 'gyms', 
        'gyms_teams', 'raids', 'friends', 'items', 
        'inventory', 'reward_records', 'payments'
      ],
      
      // 通道名称前缀
      channelPrefix: config.channelPrefix || 'cdc_',
      
      // 重连延迟
      reconnectDelay: config.reconnectDelay || 5000,
      
      // 最大重连次数
      maxReconnectAttempts: config.maxReconnectAttempts || 10
    };
    
    this.pool = null;
    this.listenerClient = null;
    this.isListening = false;
    this.reconnectAttempts = 0;
    
    // 统计数据
    this.stats = {
      eventsReceived: 0,
      eventsProcessed: 0,
      parseErrors: 0,
      reconnects: 0
    };
  }
  
  /**
   * 启动 CDC 监听
   */
  async start() {
    try {
      // 创建连接池
      this.pool = new Pool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        max: 5
      });
      
      // 测试连接
      await this.pool.query('SELECT NOW()');
      
      logger.info({ 
        host: this.config.host,
        database: this.config.database 
      }, 'PostgreSQL pool connected');
      
      // 创建监听客户端（需要独立连接，LISTEN 会阻塞）
      await this.createListenerClient();
      
      // 订阅所有表的变更通知
      await this.subscribeToTables();
      
      this.isListening = true;
      
      logger.info({ 
        tables: this.config.tables.length 
      }, 'CDC listener started');
      
    } catch (error) {
      logger.error({ error }, 'Failed to start CDC listener');
      await this.handleReconnect();
    }
  }
  
  /**
   * 创建监听客户端
   */
  async createListenerClient() {
    this.listenerClient = await this.pool.connect();
    
    // 处理通知消息
    this.listenerClient.on('notification', (msg) => {
      this.handleNotification(msg);
    });
    
    // 处理连接错误
    this.listenerClient.on('error', async (error) => {
      logger.error({ error }, 'Listener client error');
      await this.handleReconnect();
    });
    
    logger.info('Listener client created');
  }
  
  /**
   * 订阅所有表的变更通知
   */
  async subscribeToTables() {
    for (const table of this.config.tables) {
      const channel = `${this.config.channelPrefix}${table}`;
      
      try {
        await this.listenerClient.query(`LISTEN ${channel}`);
        logger.info({ channel, table }, 'Subscribed to table channel');
      } catch (error) {
        logger.error({ error, channel, table }, 'Failed to subscribe to channel');
      }
    }
  }
  
  /**
   * 处理通知消息
   */
  handleNotification(msg) {
    this.stats.eventsReceived++;
    
    try {
      // 解析通道名获取表名
      const tableName = msg.channel.replace(this.config.channelPrefix, '');
      
      // 解析 payload
      const payload = this.parsePayload(msg.payload);
      
      if (!payload) {
        this.stats.parseErrors++;
        logger.warn({ 
          channel: msg.channel, 
          payload: msg.payload 
        }, 'Failed to parse notification payload');
        return;
      }
      
      // 构造变更事件
      const changeEvent = {
        table: tableName,
        operation: payload.operation,
        timestamp: payload.timestamp || Date.now(),
        data: payload.data || {},
        oldData: payload.oldData || null
      };
      
      // 发出变更事件
      this.emit('change', changeEvent);
      
      this.stats.eventsProcessed++;
      
      logger.debug({ 
        table: tableName,
        operation: payload.operation,
        processTime: Date.now() - changeEvent.timestamp 
      }, 'Change event processed');
      
    } catch (error) {
      this.stats.parseErrors++;
      logger.error({ error, payload: msg.payload }, 'Error handling notification');
    }
  }
  
  /**
   * 解析 payload
   */
  parsePayload(payload) {
    if (!payload) return null;
    
    try {
      // 支持 JSON 格式
      if (payload.startsWith('{')) {
        return JSON.parse(payload);
      }
      
      // 支持简单格式: "operation:timestamp:id"
      const parts = payload.split(':');
      if (parts.length >= 2) {
        return {
          operation: parts[0],
          timestamp: parseInt(parts[1]) || Date.now(),
          data: { id: parts[2] }
        };
      }
      
      return null;
      
    } catch (error) {
      logger.error({ error, payload }, 'Payload parse error');
      return null;
    }
  }
  
  /**
   * 处理重连
   */
  async handleReconnect() {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error('Max reconnect attempts reached, stopping listener');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }
    
    this.reconnectAttempts++;
    this.stats.reconnects++;
    
    logger.info({ 
      attempt: this.reconnectAttempts,
      delay: this.config.reconnectDelay 
    }, 'Attempting to reconnect');
    
    // 清理旧连接
    if (this.listenerClient) {
      try {
        this.listenerClient.release();
      } catch (e) {
        // 忽略错误
      }
    }
    
    // 延迟重连
    await this.sleep(this.config.reconnectDelay);
    
    try {
      await this.createListenerClient();
      await this.subscribeToTables();
      
      this.reconnectAttempts = 0;
      this.isListening = true;
      
      logger.info('Reconnected successfully');
      
    } catch (error) {
      logger.error({ error }, 'Reconnect failed');
      await this.handleReconnect();
    }
  }
  
  /**
   * 停止监听
   */
  async stop() {
    this.isListening = false;
    
    try {
      // 取消所有订阅
      for (const table of this.config.tables) {
        const channel = `${this.config.channelPrefix}${table}`;
        try {
          await this.listenerClient.query(`UNLISTEN ${channel}`);
        } catch (e) {
          // 忽略错误
        }
      }
      
      // 释放监听客户端
      if (this.listenerClient) {
        this.listenerClient.release();
      }
      
      // 关闭连接池
      if (this.pool) {
        await this.pool.end();
      }
      
      logger.info('CDC listener stopped');
      
    } catch (error) {
      logger.error({ error }, 'Error stopping listener');
    }
  }
  
  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      isListening: this.isListening,
      reconnectAttempts: this.reconnectAttempts,
      tables: this.config.tables.length
    };
  }
  
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = PgCDCListener;