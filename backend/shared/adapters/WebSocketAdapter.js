/**
 * WebSocket 协议适配器
 * 用于实时通信场景（战斗同步、位置更新等）
 */

const ProtocolAdapter = require('../ProtocolAdapter');
const WebSocket = require('ws');
const logger = require('../logger');
const EventEmitter = require('events');

class WebSocketAdapter extends ProtocolAdapter {
  constructor(config) {
    super({ protocol: 'websocket', ...config });
    this.connections = new Map(); // userId -> WebSocket connection
    this.subscriptions = new Map(); // event -> handlers
    this.eventEmitter = new EventEmitter();
    this.reconnectInterval = config.reconnectInterval || 5000;
    this.heartbeatInterval = config.heartbeatInterval || 30000;
    this.messageQueue = new Map(); // userId -> pending messages
  }

  /**
   * 初始化 WebSocket 适配器
   */
  async connect() {
    // WebSocket 适配器不需要预先建立连接
    // 连接按需创建，每个用户有独立的 WebSocket 连接
    this.isConnected = true;
    
    logger.info('WebSocket adapter initialized', {
      reconnectInterval: this.reconnectInterval,
      heartbeatInterval: this.heartbeatInterval
    });

    // 启动心跳检测
    this.startHeartbeat();
  }

  /**
   * 创建或获取用户连接
   */
  async createConnection(userId, url) {
    if (this.connections.has(userId)) {
      const existing = this.connections.get(userId);
      if (existing.ws.readyState === WebSocket.OPEN) {
        return existing;
      }
    }

    const ws = new WebSocket(url);
    const connection = {
      ws,
      userId,
      url,
      language: 'en',
      readyState: 'connecting',
      createdAt: Date.now(),
      lastActivity: Date.now()
    };

    ws.on('open', () => {
      connection.readyState = 'open';
      connection.lastActivity = Date.now();
      
      logger.info('WebSocket connection established', { userId, url });
      
      // 发送队列中的消息
      this.flushMessageQueue(userId);
      
      // 发送心跳
      this.sendHeartbeat(userId);
    });

    ws.on('message', (data) => {
      connection.lastActivity = Date.now();
      
      try {
        const message = JSON.parse(data.toString());
        this.handleMessage(userId, message);
      } catch (error) {
        logger.error('WebSocket message parse error', { 
          userId, 
          error: error.message 
        });
      }
    });

    ws.on('close', (code, reason) => {
      connection.readyState = 'closed';
      logger.warn('WebSocket connection closed', { 
        userId, 
        code, 
        reason: reason.toString() 
      });
      
      // 自动重连
      this.scheduleReconnect(userId, url);
    });

    ws.on('error', (error) => {
      connection.readyState = 'error';
      logger.error('WebSocket connection error', { 
        userId, 
        error: error.message 
      });
    });

    this.connections.set(userId, connection);
    return connection;
  }

  /**
   * 发送 WebSocket 消息
   */
  async send(request) {
    const startTime = Date.now();
    const { service, method, data, options = {} } = request;
    const userId = options.userId;

    if (!userId) {
      throw new Error('WebSocket request requires userId in options');
    }

    const connection = this.connections.get(userId);
    
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      // 连接不存在或未就绪，加入队列
      this.addToMessageQueue(userId, { service, method, data, options });
      
      // 尝试创建连接
      if (!connection) {
        const url = options.wsUrl || this.config.baseUrl;
        await this.createConnection(userId, url);
      }
      
      const duration = Date.now() - startTime;
      this.recordMetrics(service, method, duration, false);
      throw new Error('WebSocket connection not ready');
    }

    try {
      const message = {
        type: method,
        service,
        data,
        timestamp: Date.now(),
        language: connection.language
      };

      connection.ws.send(JSON.stringify(message));
      connection.lastActivity = Date.now();

      const duration = Date.now() - startTime;
      this.recordMetrics(service, method, duration, true);

      return { success: true, sent: true };
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordMetrics(service, method, duration, false);
      throw error;
    }
  }

  /**
   * 发送本地化消息
   */
  async sendLocalizedMessage(userId, messageType, data) {
    const connection = this.connections.get(userId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket connection not ready');
    }

    const language = connection.language || 'en';
    const localizedData = this.localizeData(data, language);

    const message = {
      type: messageType,
      ...localizedData,
      language,
      timestamp: Date.now()
    };

    connection.ws.send(JSON.stringify(message));
    connection.lastActivity = Date.now();

    return { success: true };
  }

  /**
   * 更新用户连接语言
   */
  async updateConnectionLanguage(userId, language) {
    const connection = this.connections.get(userId);
    if (connection) {
      connection.language = language;
      
      // 发送语言确认消息
      const confirmMessage = {
        type: 'language-updated',
        language,
        message: this.getLanguageSwitchMessage(language),
        timestamp: Date.now()
      };
      
      connection.ws.send(JSON.stringify(confirmMessage));
      
      logger.info('WebSocket language updated', { userId, language });
    }
  }

  /**
   * 批量发送（广播）
   */
  async sendBatch(requests) {
    const results = [];
    for (const request of requests) {
      try {
        const result = await this.send(request);
        results.push({ success: true, result });
      } catch (error) {
        results.push({ success: false, error });
      }
    }
    return results;
  }

  /**
   * 广播消息给所有连接
   */
  async broadcast(message) {
    const results = [];
    for (const [userId, connection] of this.connections) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        try {
          connection.ws.send(JSON.stringify({
            ...message,
            language: connection.language,
            timestamp: Date.now()
          }));
          results.push({ userId, success: true });
        } catch (error) {
          results.push({ userId, success: false, error: error.message });
        }
      }
    }
    return results;
  }

  /**
   * 订阅事件
   */
  async subscribe(event, handler) {
    if (!this.subscriptions.has(event)) {
      this.subscriptions.set(event, []);
    }
    this.subscriptions.get(event).push(handler);
    
    // 同时注册到 EventEmitter
    this.eventEmitter.on(event, handler);
    
    logger.info('WebSocket event subscribed', { event });
  }

  /**
   * 取消订阅
   */
  async unsubscribe(event, handler) {
    if (this.subscriptions.has(event)) {
      const handlers = this.subscriptions.get(event);
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
    
    this.eventEmitter.off(event, handler);
  }

  /**
   * 处理接收到的消息
   */
  handleMessage(userId, message) {
    const { type, data } = message;
    
    // 触发订阅的处理器
    if (this.subscriptions.has(type)) {
      for (const handler of this.subscriptions.get(type)) {
        try {
          handler(userId, data);
        } catch (error) {
          logger.error('WebSocket handler error', { 
            userId, 
            type, 
            error: error.message 
          });
        }
      }
    }
    
    // 触发 EventEmitter
    this.eventEmitter.emit(type, userId, data);
    
    // 处理特殊消息类型
    if (type === 'pong') {
      const connection = this.connections.get(userId);
      if (connection) {
        connection.lastActivity = Date.now();
      }
    }
    
    if (type === 'language-changed') {
      this.updateConnectionLanguage(userId, message.language);
    }
  }

  /**
   * 添加消息到队列
   */
  addToMessageQueue(userId, message) {
    if (!this.messageQueue.has(userId)) {
      this.messageQueue.set(userId, []);
    }
    this.messageQueue.get(userId).push(message);
  }

  /**
   * 发送队列中的消息
   */
  flushMessageQueue(userId) {
    const queue = this.messageQueue.get(userId);
    if (!queue || queue.length === 0) return;

    const connection = this.connections.get(userId);
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) return;

    for (const message of queue) {
      try {
        connection.ws.send(JSON.stringify({
          type: message.method,
          service: message.service,
          data: message.data,
          timestamp: Date.now()
        }));
      } catch (error) {
        logger.error('Failed to send queued message', { userId, error });
      }
    }

    this.messageQueue.set(userId, []);
  }

  /**
   * 计划重连
   */
  scheduleReconnect(userId, url) {
    setTimeout(() => {
      this.createConnection(userId, url).catch(error => {
        logger.error('WebSocket reconnect failed', { userId, error });
        // 继续尝试重连
        this.scheduleReconnect(userId, url);
      });
    }, this.reconnectInterval);
  }

  /**
   * 启动心跳检测
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      for (const [userId, connection] of this.connections) {
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }
    }, this.heartbeatInterval);
  }

  /**
   * 发送心跳
   */
  sendHeartbeat(userId) {
    const connection = this.connections.get(userId);
    if (connection && connection.ws.readyState === WebSocket.OPEN) {
      connection.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    }
  }

  /**
   * 本地化数据
   */
  localizeData(data, language) {
    // 简化实现：实际应该调用 i18n 服务
    return { ...data, language };
  }

  /**
   * 获取语言切换确认消息
   */
  getLanguageSwitchMessage(language) {
    const messages = {
      zh: '语言已切换为中文',
      en: 'Language switched to English',
      ja: '言語が日本語に切り替わりました'
    };
    return messages[language] || messages.en;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const results = {
      healthy: true,
      connections: 0,
      active: 0,
      details: []
    };

    for (const [userId, connection] of this.connections) {
      results.connections++;
      
      const isActive = connection.ws.readyState === WebSocket.OPEN &&
        Date.now() - connection.lastActivity < 60000; // 1分钟内有活动
      
      if (isActive) {
        results.active++;
      }

      results.details.push({
        userId,
        state: connection.ws.readyState,
        lastActivity: connection.lastActivity,
        language: connection.language
      });
    }

    return results;
  }

  /**
   * 断开所有连接
   */
  async disconnect() {
    // 清理心跳定时器
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // 关闭所有连接
    for (const [userId, connection] of this.connections) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close(1000, 'Server shutdown');
      }
    }

    this.connections.clear();
    this.subscriptions.clear();
    this.messageQueue.clear();
    this.isConnected = false;

    logger.info('WebSocket adapter disconnected');
  }

  /**
   * 获取连接统计
   */
  getConnectionStats() {
    const stats = {
      total: this.connections.size,
      open: 0,
      closed: 0,
      connecting: 0
    };

    for (const [_, connection] of this.connections) {
      switch (connection.ws.readyState) {
        case WebSocket.OPEN:
          stats.open++;
          break;
        case WebSocket.CLOSED:
          stats.closed++;
          break;
        case WebSocket.CONNECTING:
          stats.connecting++;
          break;
      }
    }

    return stats;
  }
}

module.exports = WebSocketAdapter;