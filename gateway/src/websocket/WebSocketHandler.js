/**
 * WebSocket 处理器
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 * 
 * 功能：
 * - WebSocket 升级处理
 * - 连接池集成
 * - 消息批处理
 * - 频道订阅管理
 */

'use strict';

const WebSocket = require('ws');
const http = require('http');
const { WebSocketConnectionPool } = require('../../shared/websocket/ConnectionPool');
const { MessageBatchQueue } = require('../../shared/websocket/MessageBatchQueue');
const { createLogger } = require('../../shared/logger');
const { verifyToken } = require('../../shared/auth');
const { WebSocketMetricsRecorder } = require('../../shared/websocket/Metrics');

const logger = createLogger('websocket-handler');

class WebSocketHandler {
  constructor(server, options = {}) {
    this.server = server;
    this.options = options;

    // 初始化连接池
    this.connectionPool = new WebSocketConnectionPool({
      maxConnectionsPerWorker: options.maxConnections || 10000,
      connectionTimeout: options.connectionTimeout || 300000,
      heartbeatInterval: options.heartbeatInterval || 30000,
      enableCompression: options.enableCompression !== false
    });

    // 初始化消息队列
    this.messageQueue = new MessageBatchQueue({
      maxBatchSize: options.maxBatchSize || 50,
      maxBatchDelay: options.maxBatchDelay || 100,
      maxQueueSize: options.maxQueueSize || 10000,
      enableBackpressure: true
    }, this.connectionPool);

    // 指标记录器
    this.metricsRecorder = new WebSocketMetricsRecorder('gateway');

    // 创建 WebSocket 服务器
    this.wss = new WebSocket.Server({
      server,
      path: '/ws',
      perMessageDeflate: options.enableCompression !== false
    });

    // 绑定事件处理
    this.bindServerEvents();

    // 消息处理器映射
    this.messageHandlers = {
      'ping': this.handlePing.bind(this),
      'pong': this.handlePong.bind(this),
      'location_update': this.handleLocationUpdate.bind(this),
      'battle_action': this.handleBattleAction.bind(this),
      'subscribe': this.handleSubscribe.bind(this),
      'unsubscribe': this.handleUnsubscribe.bind(this),
      'chat_message': this.handleChatMessage.bind(this)
    };

    logger.info('WebSocket handler initialized', {
      maxConnections: options.maxConnections || 10000,
      enableCompression: options.enableCompression !== false
    });
  }

  /**
   * 绑定服务器事件
   */
  bindServerEvents() {
    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      logger.error('WebSocket server error', { error: error.message });
    });
  }

  /**
   * 处理新连接
   */
  async handleConnection(ws, req) {
    const startTime = Date.now();

    try {
      // 解析查询参数
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        logger.warn('Connection rejected: missing token');
        ws.close(4001, 'Authentication required');
        return;
      }

      // 验证令牌
      const user = await verifyToken(token);
      if (!user) {
        logger.warn('Connection rejected: invalid token');
        ws.close(4002, 'Invalid token');
        return;
      }

      const userId = user.id;

      // 提取元数据
      const metadata = {
        deviceId: req.headers['x-device-id'] || url.searchParams.get('device_id'),
        platform: req.headers['x-platform'] || url.searchParams.get('platform') || 'unknown',
        version: req.headers['x-app-version'] || url.searchParams.get('version') || '1.0.0',
        ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
      };

      // 注册连接到连接池
      const connectionCtx = this.connectionPool.registerConnection(ws, userId, metadata);

      // 绑定消息处理
      ws.on('message', (data) => {
        this.handleMessage(connectionCtx, data);
      });

      ws.on('close', (code, reason) => {
        this.handleDisconnect(connectionCtx, code, reason);
      });

      ws.on('error', (error) => {
        logger.error('WebSocket connection error', {
          userId,
          connectionId: connectionCtx.id,
          error: error.message
        });
      });

      // 发送连接成功消息
      this.sendWelcome(ws, connectionCtx);

      // 记录指标
      this.metricsRecorder.recordConnection();

      logger.info('WebSocket connection established', {
        userId,
        connectionId: connectionCtx.id,
        platform: metadata.platform,
        duration: Date.now() - startTime
      });

    } catch (error) {
      logger.error('Failed to handle connection', {
        error: error.message,
        stack: error.stack
      });

      ws.close(4500, 'Internal server error');
    }
  }

  /**
   * 处理消息
   */
  handleMessage(ctx, data) {
    const startTime = Date.now();

    try {
      const message = JSON.parse(data.toString());
      const handler = this.messageHandlers[message.type];

      if (handler) {
        handler(ctx, message);
      } else {
        // 默认处理：添加到批处理队列
        this.messageQueue.enqueue(ctx.userId, message);
      }

      // 记录指标
      this.metricsRecorder.recordMessageReceived(message.type || 'unknown');
      this.metricsRecorder.recordMessageSendLatency(Date.now() - startTime);

    } catch (error) {
      logger.error('Failed to handle message', {
        userId: ctx.userId,
        connectionId: ctx.id,
        error: error.message
      });
    }
  }

  /**
   * 处理断开连接
   */
  handleDisconnect(ctx, code, reason) {
    this.connectionPool.handleDisconnectedConnection(ctx);

    // 清理消息队列
    this.messageQueue.clearQueue(ctx.userId);

    // 记录指标
    const duration = Date.now() - ctx.connectedAt;
    this.metricsRecorder.recordDisconnection(ctx.metadata.platform, duration);

    logger.info('WebSocket disconnected', {
      userId: ctx.userId,
      connectionId: ctx.id,
      code,
      reason: reason.toString(),
      duration
    });
  }

  /**
   * 处理 Ping
   */
  handlePing(ctx, message) {
    ctx.ws.pong();
    ctx.lastActivityAt = Date.now();
  }

  /**
   * 处理 Pong
   */
  handlePong(ctx, message) {
    ctx.lastActivityAt = Date.now();
  }

  /**
   * 处理位置更新
   */
  handleLocationUpdate(ctx, message) {
    // 位置更新：批量发送
    this.messageQueue.enqueue(ctx.userId, {
      type: 'location_update',
      data: message.data,
      timestamp: Date.now()
    });
  }

  /**
   * 处理战斗动作（高优先级，立即发送）
   */
  handleBattleAction(ctx, message) {
    // 战斗动作：立即发送
    this.connectionPool.sendToUser(ctx.userId, [{
      type: 'battle_action',
      data: message.data,
      timestamp: Date.now()
    }], { priority: 'high', immediate: true });
  }

  /**
   * 处理频道订阅
   */
  handleSubscribe(ctx, message) {
    const channel = message.channel;
    if (!channel) {
      return;
    }

    this.connectionPool.subscribeChannel(ctx, channel);

    // 发送确认
    ctx.ws.send(JSON.stringify({
      type: 'subscribe_ack',
      channel,
      timestamp: Date.now()
    }));
  }

  /**
   * 处理取消订阅
   */
  handleUnsubscribe(ctx, message) {
    const channel = message.channel;
    if (!channel) {
      return;
    }

    this.connectionPool.unsubscribeChannel(ctx, channel);

    // 发送确认
    ctx.ws.send(JSON.stringify({
      type: 'unsubscribe_ack',
      channel,
      timestamp: Date.now()
    }));
  }

  /**
   * 处理聊天消息
   */
  handleChatMessage(ctx, message) {
    // 聊天消息：广播到频道
    if (message.channel) {
      this.connectionPool.broadcast(message.channel, {
        type: 'chat_message',
        userId: ctx.userId,
        username: ctx.metadata.username || 'Anonymous',
        content: message.content,
        timestamp: Date.now()
      });
    }
  }

  /**
   * 发送欢迎消息
   */
  sendWelcome(ws, ctx) {
    ws.send(JSON.stringify({
      type: 'welcome',
      connectionId: ctx.id,
      userId: ctx.userId,
      timestamp: Date.now(),
      serverTime: new Date().toISOString()
    }));
  }

  /**
   * 向用户发送消息
   */
  async sendToUser(userId, message, options = {}) {
    return await this.connectionPool.sendToUser(userId, message, options);
  }

  /**
   * 广播消息
   */
  async broadcast(channel, message, options = {}) {
    return await this.connectionPool.broadcast(channel, message, options);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      connectionPool: this.connectionPool.getStats(),
      messageQueue: this.messageQueue.getStats()
    };
  }

  /**
   * 关闭处理器
   */
  shutdown() {
    // 刷新所有队列
    this.messageQueue.flushAll();

    // 关闭所有连接
    this.wss.clients.forEach(ws => {
      ws.close(1001, 'Server shutting down');
    });

    // 关闭服务器
    this.wss.close(() => {
      logger.info('WebSocket server closed');
    });
  }
}

module.exports = { WebSocketHandler };
