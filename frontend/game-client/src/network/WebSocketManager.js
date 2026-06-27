/**
 * WebSocket 管理器 - 游戏客户端
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 * 
 * 功能：
 * - WebSocket 连接管理
 * - 消息批处理缓冲
 * - 自动重连
 * - 心跳检测
 * - 消息分发
 */

class WebSocketManager {
  constructor(options = {}) {
    // 配置
    this.wsUrl = options.wsUrl || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    this.token = options.token || null;
    
    // 批处理配置
    this.batchSize = options.batchSize || 20;
    this.batchDelay = options.batchDelay || 50; // ms
    
    // 重连配置
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 3000;
    this.reconnectAttempts = 0;
    
    // 心跳配置
    this.heartbeatInterval = options.heartbeatInterval || 30000; // 30秒
    this.heartbeatTimer = null;
    
    // 连接状态
    this.ws = null;
    this.isConnected = false;
    this.connectionId = null;
    this.userId = null;
    
    // 消息缓冲
    this.messageBuffer = [];
    this.flushTimer = null;
    
    // 消息处理器映射
    this.messageHandlers = new Map();
    
    // 事件监听器
    this.eventListeners = {
      'connected': [],
      'disconnected': [],
      'error': [],
      'reconnecting': []
    };
    
    // 统计
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      batchesSent: 0,
      reconnects: 0
    };
    
    console.log('[WebSocketManager] Initialized', {
      wsUrl: this.wsUrl,
      batchSize: this.batchSize,
      batchDelay: this.batchDelay
    });
  }

  /**
   * 连接 WebSocket
   */
  connect(token) {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        resolve();
        return;
      }

      this.token = token || this.token;
      const url = `${this.wsUrl}?token=${this.token}`;

      console.log('[WebSocketManager] Connecting...', { url: this.wsUrl });

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.onConnected();
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.onMessage(event.data);
      };

      this.ws.onclose = (event) => {
        this.onDisconnected(event);
      };

      this.ws.onerror = (error) => {
        console.error('[WebSocketManager] Connection error', error);
        this.emit('error', error);
        reject(error);
      };
    });
  }

  /**
   * 连接成功处理
   */
  onConnected() {
    this.isConnected = true;
    this.reconnectAttempts = 0;
    
    // 启动心跳
    this.startHeartbeat();
    
    // 启动批量刷新
    this.startBatchFlush();
    
    // 发送缓冲消息
    this.flushBuffer();
    
    console.log('[WebSocketManager] Connected');
    this.emit('connected');
  }

  /**
   * 断开连接处理
   */
  onDisconnected(event) {
    this.isConnected = false;
    this.stopHeartbeat();
    this.stopBatchFlush();
    
    console.log('[WebSocketManager] Disconnected', {
      code: event.code,
      reason: event.reason
    });
    
    this.emit('disconnected', {
      code: event.code,
      reason: event.reason
    });
    
    // 自动重连
    if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnect();
    }
  }

  /**
   * 自动重连
   */
  reconnect() {
    this.reconnectAttempts++;
    this.stats.reconnects++;
    
    console.log('[WebSocketManager] Reconnecting...', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts
    });
    
    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts
    });
    
    setTimeout(() => {
      this.connect(this.token).catch(error => {
        console.error('[WebSocketManager] Reconnect failed', error);
      });
    }, this.reconnectDelay * this.reconnectAttempts);
  }

  /**
   * 启动心跳
   */
  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' }, { immediate: true });
      }
    }, this.heartbeatInterval);
  }

  /**
   * 停止心跳
   */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 发送消息
   * @param {Object} message - 消息内容
   * @param {Object} options - 选项（immediate, priority）
   */
  send(message, options = {}) {
    if (!this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WebSocketManager] Not connected, message queued');
      this.messageBuffer.push(message);
      return;
    }

    // 立即发送
    if (options.immediate) {
      this.ws.send(JSON.stringify(message));
      this.stats.messagesSent++;
      return;
    }

    // 高优先级消息立即发送
    if (options.priority === 'high') {
      this.ws.send(JSON.stringify(message));
      this.stats.messagesSent++;
      return;
    }

    // 添加到缓冲区
    this.messageBuffer.push(message);

    // 达到批量大小时立即刷新
    if (this.messageBuffer.length >= this.batchSize) {
      this.flushBuffer();
    }
  }

  /**
   * 启动批量刷新
   */
  startBatchFlush() {
    this.flushTimer = setInterval(() => {
      if (this.messageBuffer.length > 0) {
        this.flushBuffer();
      }
    }, this.batchDelay);
  }

  /**
   * 停止批量刷新
   */
  stopBatchFlush() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * 刷新消息缓冲区
   */
  flushBuffer() {
    if (this.messageBuffer.length === 0 || !this.isConnected) {
      return;
    }

    const batch = {
      id: this.generateBatchId(),
      messages: this.messageBuffer.splice(0),
      timestamp: Date.now()
    };

    try {
      this.ws.send(JSON.stringify(batch));
      this.stats.batchesSent++;
      this.stats.messagesSent += batch.messages.length;
    } catch (error) {
      console.error('[WebSocketManager] Failed to flush buffer', error);
      // 将消息放回缓冲区
      this.messageBuffer.unshift(...batch.messages);
    }
  }

  /**
   * 处理接收消息
   */
  onMessage(data) {
    try {
      const batch = JSON.parse(data);

      // 批量处理消息
      if (batch.messages && Array.isArray(batch.messages)) {
        batch.messages.forEach(msg => {
          this.dispatchMessage(msg);
        });
        this.stats.messagesReceived += batch.messages.length;
      } else {
        // 单条消息
        this.dispatchMessage(batch);
        this.stats.messagesReceived++;
      }
    } catch (error) {
      console.error('[WebSocketManager] Failed to parse message', error);
    }
  }

  /**
   * 分发消息到处理器
   */
  dispatchMessage(message) {
    const handler = this.messageHandlers.get(message.type);
    
    if (handler) {
      handler(message);
    } else {
      console.warn('[WebSocketManager] No handler for message type', {
        type: message.type
      });
    }
  }

  /**
   * 注册消息处理器
   */
  on(messageType, handler) {
    this.messageHandlers.set(messageType, handler);
  }

  /**
   * 注销消息处理器
   */
  off(messageType) {
    this.messageHandlers.delete(messageType);
  }

  /**
   * 添加事件监听器
   */
  addEventListener(event, callback) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].push(callback);
    }
  }

  /**
   * 移除事件监听器
   */
  removeEventListener(event, callback) {
    if (this.eventListeners[event]) {
      const index = this.eventListeners[event].indexOf(callback);
      if (index !== -1) {
        this.eventListeners[event].splice(index, 1);
      }
    }
  }

  /**
   * 触发事件
   */
  emit(event, data) {
    const listeners = this.eventListeners[event];
    if (listeners) {
      listeners.forEach(callback => callback(data));
    }
  }

  /**
   * 订阅频道
   */
  subscribe(channel) {
    this.send({
      type: 'subscribe',
      channel
    }, { immediate: true });
  }

  /**
   * 取消订阅
   */
  unsubscribe(channel) {
    this.send({
      type: 'unsubscribe',
      channel
    }, { immediate: true });
  }

  /**
   * 发送位置更新
   */
  sendLocationUpdate(location) {
    this.send({
      type: 'location_update',
      data: location
    });
  }

  /**
   * 发送战斗动作
   */
  sendBattleAction(action) {
    this.send({
      type: 'battle_action',
      data: action
    }, { priority: 'high', immediate: true });
  }

  /**
   * 发送聊天消息
   */
  sendChatMessage(channel, content) {
    this.send({
      type: 'chat_message',
      channel,
      content
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.ws) {
      this.flushBuffer();
      this.stopHeartbeat();
      this.stopBatchFlush();
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
      this.isConnected = false;
    }
  }

  /**
   * 生成批次ID
   */
  generateBatchId() {
    return `batch_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      isConnected: this.isConnected,
      bufferSize: this.messageBuffer.length,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

// 导出（支持浏览器和 Node.js）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WebSocketManager };
} else {
  window.WebSocketManager = WebSocketManager;
}
