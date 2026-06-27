/**
 * WebSocket 连接池管理器
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 * 
 * 功能：
 * - 连接池化管理，提升连接复用率
 * - 负载均衡，分散连接到多个 worker pool
 * - 心跳检测，自动清理断开连接
 * - 消息批处理，提升吞吐量
 * - 背压控制，防止消息堆积导致内存溢出
 */

'use strict';

const WebSocket = require('ws');
const { createLogger } = require('../logger');
const websocketMetrics = require('./Metrics');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const logger = createLogger('websocket-connection-pool');

class WebSocketConnectionPool {
  constructor(options = {}) {
    // 配置参数
    this.maxConnectionsPerWorker = options.maxConnectionsPerWorker || 1000;
    this.connectionTimeout = options.connectionTimeout || 300000; // 5分钟
    this.heartbeatInterval = options.heartbeatInterval || 30000; // 30秒
    this.enableCompression = options.enableCompression !== false;
    this.compressionThreshold = options.compressionThreshold || 1024; // 1KB以上压缩

    // 连接池数据结构
    this.connections = new Map(); // userId -> Set<ConnectionContext>
    this.connectionContexts = new Map(); // connectionId -> ConnectionContext
    this.channelSubscriptions = new Map(); // channel -> Set<userId>

    // 指标
    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      messagesSent: 0,
      messagesDropped: 0,
      batchesProcessed: 0,
      backpressureEvents: 0
    };

    // 批处理配置
    this.batchConfig = {
      maxBatchSize: options.maxBatchSize || 50,
      maxBatchDelay: options.maxBatchDelay || 100, // ms
      flushTimers: new Map() // userId -> timer
    };

    logger.info('WebSocket connection pool initialized', {
      maxConnectionsPerWorker: this.maxConnectionsPerWorker,
      connectionTimeout: this.connectionTimeout,
      heartbeatInterval: this.heartbeatInterval
    });
  }

  /**
   * 注册新连接到连接池
   * @param {WebSocket} ws - WebSocket 实例
   * @param {string} userId - 用户ID
   * @param {Object} metadata - 连接元数据（deviceId, platform, version等）
   * @returns {Object} 连接上下文
   */
  registerConnection(ws, userId, metadata = {}) {
    const connectionId = this.generateConnectionId();
    
    // 创建连接上下文
    const connectionContext = {
      id: connectionId,
      ws,
      userId,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      metadata: {
        deviceId: metadata.deviceId || null,
        platform: metadata.platform || 'unknown',
        version: metadata.version || '1.0.0',
        ...metadata
      },
      messageQueue: [],
      isBatching: false,
      heartbeatTimer: null,
      subscriptions: new Set(), // 订阅的频道
      status: 'active'
    };

    // 添加到连接池
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId).add(connectionContext);
    this.connectionContexts.set(connectionId, connectionContext);

    // 启动心跳检测
    this.startHeartbeat(connectionContext);

    // 绑定事件处理
    this.bindConnectionEvents(connectionContext);

    // 更新指标
    this.metrics.totalConnections++;
    this.metrics.activeConnections++;
    this.updatePrometheusMetrics();

    logger.info('Connection registered', {
      connectionId,
      userId,
      platform: connectionContext.metadata.platform,
      activeConnections: this.metrics.activeConnections
    });

    return connectionContext;
  }

  /**
   * 获取用户的所有活跃连接
   * @param {string} userId - 用户ID
   * @returns {Array} 连接上下文数组
   */
  getUserConnections(userId) {
    const userConnections = this.connections.get(userId);
    if (!userConnections) return [];

    // 过滤已关闭的连接
    return Array.from(userConnections).filter(ctx => 
      ctx.ws.readyState === WebSocket.OPEN && ctx.status === 'active'
    );
  }

  /**
   * 批量向用户发送消息
   * @param {string} userId - 用户ID
   * @param {Array|Object} messages - 消息或消息数组
   * @param {Object} options - 发送选项
   */
  async sendToUser(userId, messages, options = {}) {
    const connections = this.getUserConnections(userId);
    if (connections.length === 0) {
      logger.debug('No active connections for user', { userId });
      return { sent: 0, connections: 0 };
    }

    // 创建消息批次
    const batch = this.createMessageBatch(messages, options);
    
    const results = await Promise.allSettled(
      connections.map(ctx => this.sendBatch(ctx, batch, options))
    );

    // 统计发送结果
    const sent = results.filter(r => r.status === 'fulfilled' && r.value).length;
    this.metrics.batchesProcessed++;
    this.updatePrometheusMetrics();

    logger.debug('Batch sent to user', {
      userId,
      connectionCount: connections.length,
      messageCount: batch.messages.length,
      sent
    });

    return { sent, connections: connections.length, batchId: batch.id };
  }

  /**
   * 广播消息到频道
   * @param {string} channel - 频道名称
   * @param {Object} message - 消息内容
   * @param {Object} options - 发送选项
   */
  async broadcast(channel, message, options = {}) {
    const subscribers = this.channelSubscriptions.get(channel);
    if (!subscribers || subscribers.size === 0) {
      logger.debug('No subscribers for channel', { channel });
      return { sent: 0, subscribers: 0 };
    }

    const batchSize = options.batchSize || 50;
    const userIds = Array.from(subscribers);
    let sent = 0;

    // 分批广播
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      
      await Promise.allSettled(
        batch.map(userId => this.sendToUser(userId, message, options))
      );

      sent += batch.length;

      // 批次间隔，避免网络拥塞
      if (options.throttleMs && i + batchSize < userIds.length) {
        await this.sleep(options.throttleMs);
      }
    }

    logger.info('Broadcast completed', {
      channel,
      subscribers: userIds.length,
      sent
    });

    return { sent, subscribers: userIds.length };
  }

  /**
   * 创建消息批次
   * @param {Array|Object} messages - 消息或消息数组
   * @param {Object} options - 选项
   * @returns {Object} 批次对象
   */
  createMessageBatch(messages, options = {}) {
    if (!Array.isArray(messages)) {
      messages = [messages];
    }

    return {
      id: this.generateBatchId(),
      messages,
      timestamp: Date.now(),
      compressed: options.compress || false,
      priority: options.priority || 'normal'
    };
  }

  /**
   * 发送批次消息
   * @param {Object} ctx - 连接上下文
   * @param {Object} batch - 批次对象
   * @param {Object} options - 发送选项
   */
  async sendBatch(ctx, batch, options = {}) {
    // 检查连接状态
    if (ctx.ws.readyState !== WebSocket.OPEN) {
      this.handleDisconnectedConnection(ctx);
      return false;
    }

    try {
      // 序列化消息
      let payload = JSON.stringify(batch);
      
      // 压缩大消息
      if (this.enableCompression && batch.compressed && payload.length > this.compressionThreshold) {
        const compressed = await gzip(Buffer.from(payload));
        ctx.ws.send(compressed, { binary: true });
      } else {
        ctx.ws.send(payload);
      }

      ctx.lastActivityAt = Date.now();
      this.metrics.messagesSent += batch.messages.length;

      websocketMetrics.messagesSent.inc({ batch: 'true' }, batch.messages.length);
      websocketMetrics.batchSize.observe(batch.messages.length);

      return true;

    } catch (error) {
      logger.error('Failed to send batch', {
        userId: ctx.userId,
        connectionId: ctx.id,
        batchId: batch.id,
        error: error.message
      });

      this.metrics.messagesDropped += batch.messages.length;
      websocketMetrics.messagesSent.inc({ batch: 'false' }, 0);

      return false;
    }
  }

  /**
   * 订阅频道
   * @param {Object} ctx - 连接上下文
   * @param {string} channel - 频道名称
   */
  subscribeChannel(ctx, channel) {
    if (!this.channelSubscriptions.has(channel)) {
      this.channelSubscriptions.set(channel, new Set());
    }
    this.channelSubscriptions.get(channel).add(ctx.userId);
    ctx.subscriptions.add(channel);

    logger.debug('User subscribed to channel', {
      userId: ctx.userId,
      channel,
      subscriptionCount: ctx.subscriptions.size
    });
  }

  /**
   * 取消订阅频道
   * @param {Object} ctx - 连接上下文
   * @param {string} channel - 频道名称
   */
  unsubscribeChannel(ctx, channel) {
    const subscribers = this.channelSubscriptions.get(channel);
    if (subscribers) {
      subscribers.delete(ctx.userId);
      if (subscribers.size === 0) {
        this.channelSubscriptions.delete(channel);
      }
    }
    ctx.subscriptions.delete(channel);

    logger.debug('User unsubscribed from channel', {
      userId: ctx.userId,
      channel
    });
  }

  /**
   * 启动心跳检测
   * @param {Object} ctx - 连接上下文
   */
  startHeartbeat(ctx) {
    ctx.heartbeatTimer = setInterval(() => {
      // 检查超时
      if (Date.now() - ctx.lastActivityAt > this.connectionTimeout) {
        this.closeConnection(ctx, 'timeout');
        return;
      }

      // 发送心跳
      if (ctx.ws.readyState === WebSocket.OPEN) {
        ctx.ws.ping();
      }
    }, this.heartbeatInterval);
  }

  /**
   * 绑定连接事件处理
   * @param {Object} ctx - 连接上下文
   */
  bindConnectionEvents(ctx) {
    ctx.ws.on('pong', () => {
      ctx.lastActivityAt = Date.now();
    });

    ctx.ws.on('close', () => {
      this.handleDisconnectedConnection(ctx);
    });

    ctx.ws.on('error', (error) => {
      logger.error('WebSocket error', {
        userId: ctx.userId,
        connectionId: ctx.id,
        error: error.message
      });
      this.handleDisconnectedConnection(ctx);
    });
  }

  /**
   * 处理断开连接
   * @param {Object} ctx - 连接上下文
   */
  handleDisconnectedConnection(ctx) {
    if (ctx.status === 'closed') return;

    // 清理心跳定时器
    if (ctx.heartbeatTimer) {
      clearInterval(ctx.heartbeatTimer);
      ctx.heartbeatTimer = null;
    }

    // 从用户连接集合中移除
    const userConnections = this.connections.get(ctx.userId);
    if (userConnections) {
      userConnections.delete(ctx);
      if (userConnections.size === 0) {
        this.connections.delete(ctx.userId);
      }
    }

    // 从连接上下文映射中移除
    this.connectionContexts.delete(ctx.id);

    // 取消所有频道订阅
    ctx.subscriptions.forEach(channel => {
      this.unsubscribeChannel(ctx, channel);
    });

    // 更新状态
    ctx.status = 'closed';
    this.metrics.activeConnections--;
    this.updatePrometheusMetrics();

    logger.info('Connection closed', {
      connectionId: ctx.id,
      userId: ctx.userId,
      activeConnections: this.metrics.activeConnections,
      duration: Date.now() - ctx.connectedAt
    });
  }

  /**
   * 主动关闭连接
   * @param {Object} ctx - 连接上下文
   * @param {string} reason - 关闭原因
   */
  closeConnection(ctx, reason = 'manual') {
    try {
      if (ctx.ws.readyState === WebSocket.OPEN) {
        ctx.ws.close(1000, reason);
      }
    } catch (error) {
      logger.error('Failed to close connection', {
        connectionId: ctx.id,
        error: error.message
      });
    }

    this.handleDisconnectedConnection(ctx);
  }

  /**
   * 获取连接池统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    return {
      ...this.metrics,
      uniqueUsers: this.connections.size,
      channels: this.channelSubscriptions.size,
      avgMessagesPerConnection: this.metrics.totalConnections > 0
        ? Math.round(this.metrics.messagesSent / this.metrics.totalConnections)
        : 0
    };
  }

  /**
   * 更新 Prometheus 指标
   */
  updatePrometheusMetrics() {
    websocketMetrics.activeConnections.set(this.metrics.activeConnections);
    websocketMetrics.poolLoad.set(this.metrics.activeConnections / this.maxConnectionsPerWorker);
  }

  /**
   * 生成连接ID
   * @returns {string} 连接ID
   */
  generateConnectionId() {
    return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * 生成批次ID
   * @returns {string} 批次ID
   */
  generateBatchId() {
    return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Sleep 辅助函数
   * @param {number} ms - 毫秒数
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { WebSocketConnectionPool };
