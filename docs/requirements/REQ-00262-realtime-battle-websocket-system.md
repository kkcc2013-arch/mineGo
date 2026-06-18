# REQ-00262: 实时对战 WebSocket 连接系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00262 |
| 标题 | 实时对战 WebSocket 连接系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gym-service、social-service、gateway、game-client、infrastructure/k8s |
| 创建时间 | 2026-06-18 18:00 |

## 需求描述

为 mineGo 游戏实现实时对战 WebSocket 连接系统，支持玩家之间的实时 PVP 对战、道馆战斗、团队战斗等实时交互场景。系统需提供低延迟的双向通信能力，支持断线重连、心跳检测、负载均衡和连接状态管理。

### 核心功能
1. **WebSocket 连接管理** - 建立和维护长连接
2. **房间/战斗实例管理** - 支持多个独立对战房间
3. **实时消息广播** - 战斗动作、状态同步
4. **断线重连机制** - 网络波动自动恢复
5. **心跳检测** - 连接活性监控
6. **连接池管理** - 资源优化和负载均衡

## 技术方案

### 1. WebSocket 服务端实现

```javascript
// backend/services/gym-service/src/websocket/WebSocketServer.js
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { logger, metrics } = require('../../../shared');
const { BattleRoomManager } = require('./BattleRoomManager');
const { HeartbeatManager } = require('./HeartbeatManager');

class WebSocketServer {
  constructor(options = {}) {
    this.port = options.port || 8080;
    this.server = null;
    this.clients = new Map(); // userId -> WebSocket
    this.roomManager = new BattleRoomManager();
    this.heartbeatManager = new HeartbeatManager(this);
    
    this.metrics = {
      connectionsTotal: new metrics.Gauge({
        name: 'ws_connections_total',
        help: 'Total active WebSocket connections'
      }),
      messagesReceived: new metrics.Counter({
        name: 'ws_messages_received_total',
        help: 'Total messages received',
        labelNames: ['type']
      }),
      messagesSent: new metrics.Counter({
        name: 'ws_messages_sent_total',
        help: 'Total messages sent',
        labelNames: ['type']
      }),
      latency: new metrics.Histogram({
        name: 'ws_message_latency_ms',
        help: 'WebSocket message latency',
        buckets: [10, 50, 100, 200, 500, 1000]
      })
    };
  }

  start() {
    this.server = new WebSocket.Server({ 
      port: this.port,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 3 },
        threshold: 1024
      }
    });

    this.server.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.heartbeatManager.start();
    logger.info(`WebSocket server started on port ${this.port}`);
  }

  async handleConnection(ws, req) {
    const startTime = Date.now();
    
    try {
      // JWT 认证
      const token = this.extractToken(req);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const userId = decoded.userId;
      
      // 关闭旧连接（单设备限制）
      if (this.clients.has(userId)) {
        const oldWs = this.clients.get(userId);
        oldWs.close(1000, 'New connection established');
      }
      
      // 注册新连接
      ws.userId = userId;
      ws.connectionId = uuidv4();
      ws.isAlive = true;
      ws.lastPong = Date.now();
      
      this.clients.set(userId, ws);
      this.metrics.connectionsTotal.set(this.clients.size);
      
      logger.info({ userId, connectionId: ws.connectionId }, 'WebSocket connected');
      
      // 设置事件处理器
      this.setupEventHandlers(ws);
      
      // 发送欢迎消息
      this.sendMessage(ws, {
        type: 'CONNECTION_ESTABLISHED',
        payload: {
          connectionId: ws.connectionId,
          serverTime: Date.now()
        }
      });
      
      metrics.timing('ws_connection_setup_ms', Date.now() - startTime);
      
    } catch (error) {
      logger.error({ error: error.message }, 'WebSocket connection failed');
      ws.close(4001, 'Authentication failed');
    }
  }

  setupEventHandlers(ws) {
    ws.on('message', (data) => {
      this.handleMessage(ws, data);
    });

    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPong = Date.now();
    });

    ws.on('close', (code, reason) => {
      this.handleDisconnect(ws, code, reason);
    });

    ws.on('error', (error) => {
      logger.error({ userId: ws.userId, error: error.message }, 'WebSocket error');
    });
  }

  async handleMessage(ws, data) {
    const startTime = Date.now();
    
    try {
      const message = JSON.parse(data.toString());
      this.metrics.messagesReceived.inc({ type: message.type });
      
      switch (message.type) {
        case 'JOIN_BATTLE':
          await this.roomManager.joinRoom(ws, message.payload);
          break;
          
        case 'LEAVE_BATTLE':
          await this.roomManager.leaveRoom(ws, message.payload);
          break;
          
        case 'BATTLE_ACTION':
          await this.roomManager.handleBattleAction(ws, message.payload);
          break;
          
        case 'HEARTBEAT':
          this.handleHeartbeat(ws, message.payload);
          break;
          
        case 'RECONNECT':
          await this.handleReconnect(ws, message.payload);
          break;
          
        default:
          logger.warn({ type: message.type }, 'Unknown message type');
      }
      
      this.metrics.latency.observe(Date.now() - startTime);
      
    } catch (error) {
      logger.error({ userId: ws.userId, error: error.message }, 'Message handling failed');
      this.sendMessage(ws, {
        type: 'ERROR',
        payload: { message: error.message }
      });
    }
  }

  handleDisconnect(ws, code, reason) {
    this.clients.delete(ws.userId);
    this.metrics.connectionsTotal.set(this.clients.size);
    
    // 通知战斗房间
    this.roomManager.handleDisconnect(ws);
    
    logger.info({ 
      userId: ws.userId, 
      code, 
      reason: reason.toString() 
    }, 'WebSocket disconnected');
  }

  async handleReconnect(ws, payload) {
    const { roomId, sessionId } = payload;
    
    const room = this.roomManager.getRoom(roomId);
    if (!room) {
      throw new Error('Room not found');
    }
    
    // 验证会话
    const session = room.getSession(sessionId);
    if (!session || session.userId !== ws.userId) {
      throw new Error('Invalid session');
    }
    
    // 恢复会话
    await room.reconnectPlayer(ws, sessionId);
    
    this.sendMessage(ws, {
      type: 'RECONNECT_SUCCESS',
      payload: {
        roomId,
        gameState: room.getGameState(),
        players: room.getPlayers()
      }
    });
  }

  handleHeartbeat(ws, payload) {
    ws.isAlive = true;
    ws.lastPong = Date.now();
    
    this.sendMessage(ws, {
      type: 'HEARTBEAT_ACK',
      payload: {
        serverTime: Date.now(),
        clientTime: payload.clientTime
      }
    });
  }

  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      const data = JSON.stringify(message);
      ws.send(data);
      this.metrics.messagesSent.inc({ type: message.type });
    }
  }

  broadcast(roomId, message, excludeUserId = null) {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;
    
    for (const [userId] of room.players) {
      if (excludeUserId && userId === excludeUserId) continue;
      
      const ws = this.clients.get(userId);
      if (ws) {
        this.sendMessage(ws, message);
      }
    }
  }

  extractToken(req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    return url.searchParams.get('token') || 
           req.headers['sec-websocket-protocol'];
  }

  getStats() {
    return {
      connections: this.clients.size,
      rooms: this.roomManager.getRoomCount(),
      uptime: process.uptime()
    };
  }
}

module.exports = { WebSocketServer };
```

### 2. 战斗房间管理器

```javascript
// backend/services/gym-service/src/websocket/BattleRoomManager.js
const { v4: uuidv4 } = require('uuid');
const { logger } = require('../../../shared');
const { BattleEngine } = require('../battleEngine');

class BattleRoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> BattleRoom
    this.userRooms = new Map(); // userId -> roomId
    this.maxRooms = parseInt(process.env.MAX_BATTLE_ROOMS) || 1000;
    this.roomTimeout = parseInt(process.env.ROOM_TIMEOUT_MS) || 30 * 60 * 1000; // 30分钟
  }

  async joinRoom(ws, payload) {
    const { roomId, battleType } = payload;
    
    // 检查房间容量
    if (this.rooms.size >= this.maxRooms) {
      throw new Error('Maximum rooms reached');
    }
    
    // 获取或创建房间
    let room = this.rooms.get(roomId);
    if (!room) {
      room = this.createRoom(roomId, battleType);
    }
    
    // 检查玩家是否已在其他房间
    const existingRoomId = this.userRooms.get(ws.userId);
    if (existingRoomId && existingRoomId !== roomId) {
      await this.leaveRoom(ws, { roomId: existingRoomId });
    }
    
    // 加入房间
    const sessionId = await room.addPlayer(ws.userId, ws);
    this.userRooms.set(ws.userId, roomId);
    
    // 发送加入成功消息
    ws.send(JSON.stringify({
      type: 'JOINED_ROOM',
      payload: {
        roomId,
        sessionId,
        players: room.getPlayers(),
        gameState: room.getGameState()
      }
    }));
    
    // 广播给其他玩家
    this.broadcastToRoom(roomId, {
      type: 'PLAYER_JOINED',
      payload: {
        userId: ws.userId,
        playerInfo: room.getPlayerInfo(ws.userId)
      }
    }, ws.userId);
    
    logger.info({ roomId, userId: ws.userId }, 'Player joined room');
  }

  async leaveRoom(ws, payload) {
    const { roomId } = payload;
    const room = this.rooms.get(roomId);
    
    if (!room) {
      throw new Error('Room not found');
    }
    
    await room.removePlayer(ws.userId);
    this.userRooms.delete(ws.userId);
    
    // 广播离开消息
    this.broadcastToRoom(roomId, {
      type: 'PLAYER_LEFT',
      payload: { userId: ws.userId }
    });
    
    // 如果房间为空，删除房间
    if (room.isEmpty()) {
      this.rooms.delete(roomId);
      logger.info({ roomId }, 'Room deleted (empty)');
    }
    
    logger.info({ roomId, userId: ws.userId }, 'Player left room');
  }

  async handleBattleAction(ws, payload) {
    const roomId = this.userRooms.get(ws.userId);
    if (!roomId) {
      throw new Error('Player not in a room');
    }
    
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error('Room not found');
    }
    
    const result = await room.processAction(ws.userId, payload);
    
    // 广播战斗结果
    this.broadcastToRoom(roomId, {
      type: 'BATTLE_ACTION_RESULT',
      payload: result
    });
  }

  handleDisconnect(ws) {
    const roomId = this.userRooms.get(ws.userId);
    if (!roomId) return;
    
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    // 标记玩家为断线状态（保留5分钟重连时间）
    room.markDisconnected(ws.userId);
    
    // 广播断线事件
    this.broadcastToRoom(roomId, {
      type: 'PLAYER_DISCONNECTED',
      payload: { userId: ws.userId }
    }, ws.userId);
  }

  createRoom(roomId, battleType) {
    const room = new BattleRoom(roomId, battleType);
    this.rooms.set(roomId, room);
    
    // 设置房间超时
    setTimeout(() => {
      if (this.rooms.has(roomId)) {
        this.closeRoom(roomId, 'TIMEOUT');
      }
    }, this.roomTimeout);
    
    logger.info({ roomId, battleType }, 'Room created');
    return room;
  }

  closeRoom(roomId, reason) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    // 通知所有玩家
    this.broadcastToRoom(roomId, {
      type: 'ROOM_CLOSED',
      payload: { reason }
    });
    
    // 清理
    for (const userId of room.players.keys()) {
      this.userRooms.delete(userId);
    }
    
    this.rooms.delete(roomId);
    logger.info({ roomId, reason }, 'Room closed');
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  getRoomCount() {
    return this.rooms.size;
  }

  broadcastToRoom(roomId, message, excludeUserId = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    
    for (const [userId, player] of room.players) {
      if (excludeUserId && userId === excludeUserId) continue;
      
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN
        player.ws.send(JSON.stringify(message));
      }
    }
  }
}

class BattleRoom {
  constructor(roomId, battleType) {
    this.roomId = roomId;
    this.battleType = battleType;
    this.players = new Map();
    this.sessions = new Map();
    this.engine = new BattleEngine(battleType);
    this.state = 'WAITING';
    this.createdAt = Date.now();
  }

  async addPlayer(userId, ws) {
    const sessionId = uuidv4();
    
    this.players.set(userId, {
      ws,
      sessionId,
      connected: true,
      joinedAt: Date.now()
    });
    
    this.sessions.set(sessionId, { userId });
    
    return sessionId;
  }

  async removePlayer(userId) {
    this.players.delete(userId);
    
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  markDisconnected(userId) {
    const player = this.players.get(userId);
    if (player) {
      player.connected = false;
      player.ws = null;
      player.disconnectedAt = Date.now();
    }
  }

  async reconnectPlayer(ws, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    
    const player = this.players.get(session.userId);
    if (!player) throw new Error('Player not found');
    
    player.ws = ws;
    player.connected = true;
    player.sessionId = sessionId;
    
    delete player.disconnectedAt;
  }

  async processAction(userId, action) {
    return await this.engine.processAction(userId, action);
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId);
  }

  getPlayers() {
    return Array.from(this.players.entries()).map(([userId, player]) => ({
      userId,
      connected: player.connected,
      joinedAt: player.joinedAt
    }));
  }

  getPlayerInfo(userId) {
    const player = this.players.get(userId);
    return player ? {
      userId,
      connected: player.connected
    } : null;
  }

  getGameState() {
    return this.engine.getState();
  }

  isEmpty() {
    return this.players.size === 0;
  }
}

module.exports = { BattleRoomManager, BattleRoom };
```

### 3. 心跳管理器

```javascript
// backend/services/gym-service/src/websocket/HeartbeatManager.js
class HeartbeatManager {
  constructor(wsServer) {
    this.wsServer = wsServer;
    this.interval = parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 30000;
    this.timeout = parseInt(process.env.HEARTBEAT_TIMEOUT_MS) || 60000;
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => {
      this.checkConnections();
    }, this.interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  checkConnections() {
    const now = Date.now();
    
    for (const [userId, ws] of this.wsServer.clients) {
      if (!ws.isAlive || (now - ws.lastPong) > this.timeout) {
        // 连接已死，终止连接
        ws.terminate();
        this.wsServer.clients.delete(userId);
        continue;
      }
      
      // 发送 ping
      ws.isAlive = false;
      ws.ping();
    }
    
    this.wsServer.metrics.connectionsTotal.set(this.wsServer.clients.size);
  }
}

module.exports = { HeartbeatManager };
```

### 4. 客户端 WebSocket 管理器

```javascript
// frontend/game-client/src/network/WebSocketManager.js
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.url = process.env.WS_URL || 'wss://api.minego.com/ws';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.heartbeatInterval = null;
    this.messageHandlers = new Map();
    this.connectionState = 'DISCONNECTED';
    
    this.setupMessageHandlers();
  }

  connect(token) {
    return new Promise((resolve, reject) => {
      try {
        const url = `${this.url}?token=${token}`;
        this.ws = new WebSocket(url);
        
        this.ws.onopen = () => {
          this.connectionState = 'CONNECTED';
          this.reconnectAttempts = 0;
          this.startHeartbeat();
          console.log('WebSocket connected');
          resolve();
        };
        
        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
        
        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          reject(error);
        };
        
        this.ws.onclose = (event) => {
          this.handleDisconnect(event);
        };
        
      } catch (error) {
        reject(error);
      }
    });
  }

  setupMessageHandlers() {
    this.on('CONNECTION_ESTABLISHED', (data) => {
      this.connectionId = data.connectionId;
      console.log('Connection established:', this.connectionId);
    });
    
    this.on('HEARTBEAT_ACK', (data) => {
      const latency = Date.now() - data.clientTime;
      this.latency = latency;
    });
    
    this.on('JOINED_ROOM', (data) => {
      this.roomId = data.roomId;
      this.sessionId = data.sessionId;
      console.log('Joined room:', data);
    });
    
    this.on('PLAYER_JOINED', (data) => {
      console.log('Player joined:', data);
      // 触发 UI 更新
    });
    
    this.on('PLAYER_LEFT', (data) => {
      console.log('Player left:', data);
    });
    
    this.on('BATTLE_ACTION_RESULT', (data) => {
      console.log('Battle action:', data);
      // 更新战斗状态
    });
    
    this.on('RECONNECT_SUCCESS', (data) => {
      this.roomId = data.roomId;
      console.log('Reconnected successfully');
    });
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      const handler = this.messageHandlers.get(message.type);
      
      if (handler) {
        handler(message.payload);
      }
    } catch (error) {
      console.error('Message parse error:', error);
    }
  }

  on(type, handler) {
    this.messageHandlers.set(type, handler);
  }

  off(type) {
    this.messageHandlers.delete(type);
  }

  send(type, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      console.warn('WebSocket not connected');
    }
  }

  joinBattle(roomId, battleType) {
    this.send('JOIN_BATTLE', { roomId, battleType });
  }

  leaveBattle() {
    this.send('LEAVE_BATTLE', { roomId: this.roomId });
    this.roomId = null;
    this.sessionId = null;
  }

  sendBattleAction(action, data) {
    this.send('BATTLE_ACTION', {
      roomId: this.roomId,
      action,
      data
    });
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.send('HEARTBEAT', { clientTime: Date.now() });
    }, 25000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  handleDisconnect(event) {
    this.connectionState = 'DISCONNECTED';
    this.stopHeartbeat();
    
    console.log('WebSocket disconnected:', event.code, event.reason);
    
    // 自动重连
    if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnect();
    }
  }

  reconnect() {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      const token = localStorage.getItem('token');
      if (token) {
        this.connect(token).catch(console.error);
      }
    }, delay);
  }

  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.connectionState = 'DISCONNECTED';
  }

  getLatency() {
    return this.latency;
  }

  isConnected() {
    return this.connectionState === 'CONNECTED';
  }
}

export const wsManager = new WebSocketManager();
```

### 5. Gateway WebSocket 路由集成

```javascript
// backend/services/gateway/src/routes/websocket.js
const http = require('http');
const { WebSocketServer } = require('ws');
const { createProxyServer } = require('http-proxy');

const setupWebSocketProxy = (app) => {
  const server = http.createServer(app);
  const wsProxy = createProxyServer({ 
    target: process.env.GYM_SERVICE_URL,
    ws: true 
  });
  
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    
    if (pathname === '/ws/battle') {
      wsProxy.ws(req, socket, head);
    }
  });
  
  return server;
};

module.exports = { setupWebSocketProxy };
```

### 6. 数据库迁移

```sql
-- database/migrations/20260618_create_battle_sessions.sql
CREATE TABLE battle_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id VARCHAR(100) NOT NULL,
  battle_type VARCHAR(50) NOT NULL,
  player1_id VARCHAR(100) NOT NULL,
  player2_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'active',
  game_state JSONB,
  result JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  
  INDEX idx_battle_sessions_room (room_id),
  INDEX idx_battle_sessions_player (player1_id, player2_id),
  INDEX idx_battle_sessions_status (status, created_at)
);

CREATE TABLE battle_events (
  id SERIAL PRIMARY KEY,
  session_id UUID REFERENCES battle_sessions(id),
  event_type VARCHAR(50) NOT NULL,
  player_id VARCHAR(100) NOT NULL,
  event_data JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_battle_events_session (session_id, created_at)
);

CREATE TABLE player_connection_history (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(100) NOT NULL,
  connection_id VARCHAR(100) NOT NULL,
  action VARCHAR(20) NOT NULL, -- 'connect', 'disconnect', 'reconnect'
  ip_address INET,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  
  INDEX idx_connection_history_user (user_id, created_at)
);
```

## 验收标准

- [ ] WebSocket 服务端成功启动并监听指定端口
- [ ] JWT 认证流程正常，拒绝无效 token 连接
- [ ] 玩家能成功加入/离开战斗房间
- [ ] 战斗动作能实时同步到所有房间玩家
- [ ] 心跳检测正常工作，断开连接能被及时检测
- [ ] 断线重连机制正常，5 分钟内能恢复战斗
- [ ] 连接数达到上限时拒绝新连接并返回错误
- [ ] 房间超时自动关闭并清理资源
- [ ] Prometheus 指标正常收集（连接数、消息数、延迟）
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 压力测试：支持 1000 并发连接
- [ ] 端到端测试：完整战斗流程无断连

## 影响范围

- **新增文件**：
  - `backend/services/gym-service/src/websocket/WebSocketServer.js`
  - `backend/services/gym-service/src/websocket/BattleRoomManager.js`
  - `backend/services/gym-service/src/websocket/HeartbeatManager.js`
  - `frontend/game-client/src/network/WebSocketManager.js`
  - `backend/services/gateway/src/routes/websocket.js`

- **修改文件**：
  - `backend/services/gym-service/src/index.js` - 添加 WebSocket 服务启动
  - `backend/services/gateway/src/index.js` - 添加 WebSocket 代理
  - `infrastructure/k8s/gym-service.yaml` - 配置端口和资源
  - `.env.example` - 添加 WebSocket 相关环境变量

- **数据库迁移**：
  - `database/migrations/20260618_create_battle_sessions.sql`

## 参考

- [WebSocket RFC 6455](https://datatracker.ietf.org/doc/html/rfc6455)
- [ws - Node.js WebSocket library](https://github.com/websockets/ws)
- [Real-time Gaming Architecture](https://www.evennia.com/)
