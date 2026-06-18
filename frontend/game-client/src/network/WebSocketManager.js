/**
 * WebSocket 管理器 - 客户端
 * REQ-00262: 实时对战 WebSocket 连接系统
 * 
 * 功能：
 * - WebSocket 连接管理
 * - 自动重连
 * - 心跳检测
 * - 消息路由
 * - 战斗房间管理
 */

class WebSocketManager {
  constructor() {
    this.ws = null;
    this.url = null;
    this.connectionId = null;
    this.roomId = null;
    this.sessionId = null;
    
    // 重连配置
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    
    // 心跳配置
    this.heartbeatInterval = 25000;
    this.heartbeatTimer = null;
    this.latency = 0;
    
    // 状态
    this.connectionState = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, CONNECTED, RECONNECTING
    this.isAuthenticated = false;
    
    // 消息处理器
    this.messageHandlers = new Map();
    this.eventListeners = new Map();
    
    // 设置默认消息处理器
    this.setupDefaultHandlers();
  }

  /**
   * 连接到 WebSocket 服务器
   */
  connect(url, token) {
    return new Promise((resolve, reject) => {
      if (this.connectionState === 'CONNECTED') {
        resolve();
        return;
      }
      
      this.connectionState = 'CONNECTING';
      this.url = url || this.url;
      
      try {
        const wsUrl = `${this.url}?token=${token}`;
        this.ws = new WebSocket(wsUrl);
        
        // 连接超时
        const connectTimeout = setTimeout(() => {
          if (this.connectionState === 'CONNECTING') {
            this.ws.close();
            reject(new Error('Connection timeout'));
          }
        }, 10000);
        
        this.ws.onopen = () => {
          clearTimeout(connectTimeout);
          this.connectionState = 'CONNECTED';
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          
          this.emit('connected');
          console.log('[WS] Connected');
          resolve();
        };
        
        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
        
        this.ws.onerror = (error) => {
          clearTimeout(connectTimeout);
          console.error('[WS] Error:', error);
          this.emit('error', error);
        };
        
        this.ws.onclose = (event) => {
          clearTimeout(connectTimeout);
          this.handleDisconnect(event);
        };
        
      } catch (error) {
        this.connectionState = 'DISCONNECTED';
        reject(error);
      }
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    this.stopHeartbeat();
    this.stopReconnect();
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    
    this.connectionState = 'DISCONNECTED';
    this.connectionId = null;
    this.roomId = null;
    this.sessionId = null;
    this.isAuthenticated = false;
    
    this.emit('disconnected');
    console.log('[WS] Disconnected');
  }

  /**
   * 设置默认消息处理器
   */
  setupDefaultHandlers() {
    // 连接建立
    this.on('CONNECTION_ESTABLISHED', (data) => {
      this.connectionId = data.connectionId;
      this.isAuthenticated = true;
      console.log('[WS] Connection established:', this.connectionId);
    });
    
    // 心跳响应
    this.on('HEARTBEAT_ACK', (data) => {
      this.latency = data.latency || (Date.now() - data.clientTime);
      this.emit('latency', this.latency);
    });
    
    // 加入房间
    this.on('JOINED_ROOM', (data) => {
      this.roomId = data.roomId;
      this.sessionId = data.sessionId;
      console.log('[WS] Joined room:', this.roomId);
      this.emit('room_joined', data);
    });
    
    // 离开房间
    this.on('PLAYER_LEFT', (data) => {
      if (data.userId === this.getCurrentUserId()) {
        this.roomId = null;
        this.sessionId = null;
      }
      this.emit('player_left', data);
    });
    
    // 玩家加入
    this.on('PLAYER_JOINED', (data) => {
      this.emit('player_joined', data);
    });
    
    // 玩家断线
    this.on('PLAYER_DISCONNECTED', (data) => {
      this.emit('player_disconnected', data);
    });
    
    // 玩家重连
    this.on('PLAYER_RECONNECTED', (data) => {
      this.emit('player_reconnected', data);
    });
    
    // 战斗开始
    this.on('BATTLE_STARTED', (data) => {
      console.log('[WS] Battle started');
      this.emit('battle_started', data);
    });
    
    // 战斗动作结果
    this.on('BATTLE_ACTION_RESULT', (data) => {
      this.emit('battle_action', data);
    });
    
    // 战斗结束
    this.on('BATTLE_ENDED', (data) => {
      console.log('[WS] Battle ended:', data.result);
      this.emit('battle_ended', data);
      this.roomId = null;
      this.sessionId = null;
    });
    
    // 重连成功
    this.on('RECONNECT_SUCCESS', (data) => {
      this.roomId = data.roomId;
      this.sessionId = data.sessionId;
      console.log('[WS] Reconnected successfully');
      this.emit('reconnected', data);
    });
    
    // 重连失败
    this.on('RECONNECT_FAILED', (data) => {
      console.log('[WS] Reconnect failed:', data.message);
      this.roomId = null;
      this.sessionId = null;
      this.emit('reconnect_failed', data);
    });
    
    // 房间关闭
    this.on('ROOM_CLOSED', (data) => {
      console.log('[WS] Room closed:', data.reason);
      this.roomId = null;
      this.sessionId = null;
      this.emit('room_closed', data);
    });
    
    // 服务器关闭
    this.on('SERVER_SHUTDOWN', (data) => {
      console.log('[WS] Server shutting down');
      this.disconnect();
      this.emit('server_shutdown', data);
    });
    
    // 错误
    this.on('ERROR', (data) => {
      console.error('[WS] Error:', data.message);
      this.emit('error', new Error(data.message));
    });
  }

  /**
   * 处理收到的消息
   */
  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      const { type, payload } = message;
      
      // 调用注册的处理器
      const handler = this.messageHandlers.get(type);
      if (handler) {
        handler(payload);
      }
      
      // 触发事件
      this.emit('message', { type, payload });
      
    } catch (error) {
      console.error('[WS] Message parse error:', error);
    }
  }

  /**
   * 注册消息处理器
   */
  on(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  /**
   * 移除消息处理器
   */
  off(type) {
    this.messageHandlers.delete(type);
  }

  /**
   * 发送消息
   */
  send(type, payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] Cannot send: not connected');
      return false;
    }
    
    try {
      const message = JSON.stringify({ type, payload });
      this.ws.send(message);
      return true;
    } catch (error) {
      console.error('[WS] Send error:', error);
      return false;
    }
  }

  /**
   * 加入战斗房间
   */
  joinBattle(roomId, battleType, pokemonTeam = []) {
    return this.send('JOIN_BATTLE', { 
      roomId, 
      battleType,
      pokemonTeam 
    });
  }

  /**
   * 离开战斗房间
   */
  leaveBattle(reason = 'voluntary') {
    const result = this.send('LEAVE_BATTLE', { 
      roomId: this.roomId,
      reason 
    });
    this.roomId = null;
    this.sessionId = null;
    return result;
  }

  /**
   * 发送战斗动作
   */
  sendBattleAction(action, data = {}) {
    return this.send('BATTLE_ACTION', {
      action,
      data
    });
  }

  /**
   * 选择技能
   */
  selectMove(moveId) {
    return this.sendBattleAction('SELECT_MOVE', { moveId });
  }

  /**
   * 切换精灵
   */
  switchPokemon(pokemonId) {
    return this.sendBattleAction('SELECT_POKEMON', { pokemonId });
  }

  /**
   * 使用道具
   */
  useItem(itemId, targetId) {
    return this.sendBattleAction('USE_ITEM', { itemId, targetId });
  }

  /**
   * 逃跑
   */
  flee() {
    return this.sendBattleAction('FLEE', {});
  }

  /**
   * 准备就绪
   */
  ready() {
    return this.sendBattleAction('READY', {});
  }

  /**
   * 尝试重连
   */
  attemptReconnect(roomId, sessionId) {
    return this.send('RECONNECT', { roomId, sessionId });
  }

  /**
   * 启动心跳
   */
  startHeartbeat() {
    this.stopHeartbeat();
    
    this.heartbeatTimer = setInterval(() => {
      this.send('HEARTBEAT', { clientTime: Date.now() });
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
   * 处理断开连接
   */
  handleDisconnect(event) {
    const wasConnected = this.connectionState === 'CONNECTED';
    this.connectionState = 'DISCONNECTED';
    this.stopHeartbeat();
    
    console.log('[WS] Disconnected:', event.code, event.reason);
    
    this.emit('disconnected', { code: event.code, reason: event.reason });
    
    // 自动重连（非正常断开）
    if (wasConnected && 
        event.code !== 1000 && 
        this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  /**
   * 安排重连
   */
  scheduleReconnect() {
    this.connectionState = 'RECONNECTING';
    this.reconnectAttempts++;
    
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });
    
    this.reconnectTimer = setTimeout(() => {
      // 获取存储的 token
      const token = localStorage?.getItem('token');
      if (token) {
        this.connect(this.url, token)
          .then(() => {
            // 重连成功后，尝试恢复战斗会话
            if (this.roomId && this.sessionId) {
              this.attemptReconnect(this.roomId, this.sessionId);
            }
          })
          .catch(console.error);
      }
    }, delay);
  }

  /**
   * 停止重连
   */
  stopReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * 事件系统
   */
  addEventListener(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  removeEventListener(event, callback) {
    if (this.eventListeners.has(event)) {
      const callbacks = this.eventListeners.get(event);
      const index = callbacks.indexOf(callback);
      if (index !== -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  emit(event, data) {
    const callbacks = this.eventListeners.get(event);
    if (callbacks) {
      callbacks.forEach(cb => {
        try {
          cb(data);
        } catch (error) {
          console.error('[WS] Event callback error:', error);
        }
      });
    }
  }

  /**
   * 获取当前状态
   */
  getState() {
    return {
      connectionState: this.connectionState,
      isConnected: this.isConnected(),
      isAuthenticated: this.isAuthenticated,
      connectionId: this.connectionId,
      roomId: this.roomId,
      sessionId: this.sessionId,
      latency: this.latency,
      reconnectAttempts: this.reconnectAttempts
    };
  }

  /**
   * 是否已连接
   */
  isConnected() {
    return this.connectionState === 'CONNECTED' && 
           this.ws && 
           this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * 获取延迟
   */
  getLatency() {
    return this.latency;
  }

  /**
   * 获取当前用户 ID（需要从 token 解析）
   */
  getCurrentUserId() {
    // 这里需要从存储的 token 或用户状态获取
    return localStorage?.getItem('userId');
  }
}

// 导出单例
export const wsManager = new WebSocketManager();

// 也导出类，允许创建多个实例
export { WebSocketManager };
