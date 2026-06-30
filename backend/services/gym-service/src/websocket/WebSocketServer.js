/**
 * WebSocket 服务端 - 实时对战连接管理
 * REQ-00262: 实时对战 WebSocket 连接系统
 * 
 * 功能：
 * - WebSocket 连接管理
 * - JWT 认证
 * - 房间/战斗实例管理
 * - 心跳检测
 * - 断线重连
 * - Prometheus 指标收集
 */

const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { logger, metrics } = require('../../../shared');
const { BattleRoomManager } = require('./BattleRoomManager');
const { HeartbeatManager } = require('./HeartbeatManager');

class WebSocketServer {
  constructor(options = {}) {
    this.port = options.port || process.env.WS_PORT || 8080;
    this.server = null;
    this.clients = new Map(); // userId -> WebSocket
    this.roomManager = new BattleRoomManager(this);
    this.heartbeatManager = new HeartbeatManager(this);
    this.jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
    
    // 配置
    this.maxConnections = parseInt(process.env.WS_MAX_CONNECTIONS) || 10000;
    this.connectionTimeout = parseInt(process.env.WS_CONNECTION_TIMEOUT_MS) || 10000;
    
    // Prometheus 指标 - 使用 metrics 模块提供的封装函数
    this.setupMetrics();
    
    // 连接统计
    this.stats = {
      totalConnections: 0,
      totalMessages: 0,
      totalErrors: 0,
      startTime: Date.now()
    };
  }

  setupMetrics() {
    // 使用 metrics 模块的 gauge/counter/histogram 函数，自动处理 registry
    this.metrics = {
      connectionsTotal: metrics.gauge('ws_connections_total', 'Total active WebSocket connections'),
      roomsTotal: metrics.gauge('ws_rooms_total', 'Total active battle rooms'),
      messagesReceived: metrics.counter('ws_messages_received_total', 'Total messages received', ['type']),
      messagesSent: metrics.counter('ws_messages_sent_total', 'Total messages sent', ['type']),
      latency: metrics.histogram('ws_message_latency_ms', 'WebSocket message latency', [], [1, 5, 10, 25, 50, 100, 200, 500, 1000]),
      errors: metrics.counter('ws_errors_total', 'Total WebSocket errors', ['type']),
      reconnections: metrics.counter('ws_reconnections_total', 'Total successful reconnections')
    };
  }

  start() {
    this.server = new WebSocket.Server({ 
      port: this.port,
      perMessageDeflate: {
        zlibDeflateOptions: { level: 3 },
        threshold: 1024 // 大于 1KB 才压缩
      },
      maxPayload: 1024 * 1024, // 1MB 最大消息大小
      clientTracking: true
    });

    // 连接事件
    this.server.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // 错误处理
    this.server.on('error', (error) => {
      logger.error({ error: error.message }, 'WebSocket server error');
      this.metrics.errors.inc({ type: 'server_error' });
    });

    // 启动心跳检测
    this.heartbeatManager.start();

    // 定期更新指标
    this.startMetricsUpdater();

    logger.info({ port: this.port }, 'WebSocket server started');
  }

  startMetricsUpdater() {
    this.metricsInterval = setInterval(() => {
      this.metrics.connectionsTotal.set(this.clients.size);
      this.metrics.roomsTotal.set(this.roomManager.getRoomCount());
    }, 5000);
  }

  async handleConnection(ws, req) {
    const startTime = Date.now();
    const clientIp = this.getClientIp(req);
    
    // 检查连接数上限
    if (this.clients.size >= this.maxConnections) {
      ws.close(1013, 'Server at capacity');
      logger.warn({ clientIp }, 'Connection rejected: max capacity reached');
      return;
    }
    
    try {
      // JWT 认证
      const token = this.extractToken(req);
      if (!token) {
        ws.close(4001, 'Missing authentication token');
        return;
      }

      const decoded = await this.verifyToken(token);
      const userId = decoded.userId || decoded.sub;
      
      if (!userId) {
        ws.close(4001, 'Invalid token: missing userId');
        return;
      }
      
      // 关闭旧连接（单设备限制）
      if (this.clients.has(userId)) {
        const oldWs = this.clients.get(userId);
        if (oldWs.readyState === WebSocket.OPEN) {
          oldWs.close(1000, 'New connection established');
        }
        this.clients.delete(userId);
      }
      
      // 注册新连接
      ws.userId = userId;
      ws.connectionId = uuidv4();
      ws.isAlive = true;
      ws.lastPong = Date.now();
      ws.connectedAt = Date.now();
      ws.clientIp = clientIp;
      ws.userAgent = req.headers['user-agent'];
      
      this.clients.set(userId, ws);
      this.stats.totalConnections++;
      
      logger.info({ 
        userId, 
        connectionId: ws.connectionId,
        clientIp,
        totalConnections: this.clients.size 
      }, 'WebSocket connected');
      
      // 设置事件处理器
      this.setupEventHandlers(ws);
      
      // 发送欢迎消息
      this.sendMessage(ws, {
        type: 'CONNECTION_ESTABLISHED',
        payload: {
          connectionId: ws.connectionId,
          serverTime: Date.now(),
          reconnectWindow: 300000 // 5 分钟重连窗口
        }
      });
      
      // 记录连接延迟
      const setupTime = Date.now() - startTime;
      this.metrics.latency.observe(setupTime);
      
    } catch (error) {
      this.stats.totalErrors++;
      this.metrics.errors.inc({ type: 'connection_error' });
      
      logger.error({ error: error.message, clientIp }, 'WebSocket connection failed');
      
      if (error.name === 'TokenExpiredError') {
        ws.close(4002, 'Token expired');
      } else if (error.name === 'JsonWebTokenError') {
        ws.close(4001, 'Invalid token');
      } else {
        ws.close(4000, 'Authentication failed');
      }
    }
  }

  setupEventHandlers(ws) {
    // 消息处理
    ws.on('message', (data) => {
      this.handleMessage(ws, data);
    });

    // 心跳响应
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPong = Date.now();
    });

    // 断开连接
    ws.on('close', (code, reason) => {
      this.handleDisconnect(ws, code, reason);
    });

    // 错误处理
    ws.on('error', (error) => {
      logger.error({ 
        userId: ws.userId, 
        error: error.message 
      }, 'WebSocket error');
      this.metrics.errors.inc({ type: 'client_error' });
    });
  }

  async handleMessage(ws, data) {
    const startTime = Date.now();
    
    // 消息大小检查
    if (data.length > 1024 * 1024) {
      this.sendMessage(ws, {
        type: 'ERROR',
        payload: { message: 'Message too large', code: 'MESSAGE_TOO_LARGE' }
      });
      return;
    }
    
    try {
      const message = JSON.parse(data.toString());
      this.stats.totalMessages++;
      this.metrics.messagesReceived.inc({ type: message.type || 'unknown' });
      
      // 路由消息
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
          
        case 'PING':
          this.sendMessage(ws, { type: 'PONG', payload: { time: Date.now() } });
          break;
          
        default:
          logger.warn({ 
            userId: ws.userId, 
            type: message.type 
          }, 'Unknown message type');
          
          this.sendMessage(ws, {
            type: 'ERROR',
            payload: { message: 'Unknown message type', code: 'UNKNOWN_TYPE' }
          });
      }
      
      // 记录延迟
      this.metrics.latency.observe(Date.now() - startTime);
      
    } catch (error) {
      this.stats.totalErrors++;
      this.metrics.errors.inc({ type: 'message_error' });
      
      logger.error({ 
        userId: ws.userId, 
        error: error.message 
      }, 'Message handling failed');
      
      this.sendMessage(ws, {
        type: 'ERROR',
        payload: { 
          message: error.message,
          code: 'PROCESSING_ERROR'
        }
      });
    }
  }

  handleDisconnect(ws, code, reason) {
    this.clients.delete(ws.userId);
    
    // 通知战斗房间
    this.roomManager.handleDisconnect(ws);
    
    logger.info({ 
      userId: ws.userId, 
      connectionId: ws.connectionId,
      code, 
      reason: reason?.toString() || 'unknown',
      duration: Date.now() - ws.connectedAt
    }, 'WebSocket disconnected');
  }

  async handleReconnect(ws, payload) {
    const { roomId, sessionId } = payload;
    
    try {
      const room = this.roomManager.getRoom(roomId);
      if (!room) {
        throw new Error('Room not found or expired');
      }
      
      // 验证会话
      const session = room.getSession(sessionId);
      if (!session || session.userId !== ws.userId) {
        throw new Error('Invalid session');
      }
      
      // 恢复会话
      await room.reconnectPlayer(ws, sessionId);
      
      this.metrics.reconnections.inc();
      
      this.sendMessage(ws, {
        type: 'RECONNECT_SUCCESS',
        payload: {
          roomId,
          sessionId,
          gameState: room.getGameState(),
          players: room.getPlayers()
        }
      });
      
      // 通知其他玩家
      this.roomManager.broadcastToRoom(roomId, {
        type: 'PLAYER_RECONNECTED',
        payload: { userId: ws.userId }
      }, ws.userId);
      
      logger.info({ 
        userId: ws.userId, 
        roomId, 
        sessionId 
      }, 'Player reconnected');
      
    } catch (error) {
      this.sendMessage(ws, {
        type: 'RECONNECT_FAILED',
        payload: { 
          message: error.message,
          code: 'RECONNECT_ERROR'
        }
      });
    }
  }

  handleHeartbeat(ws, payload) {
    ws.isAlive = true;
    ws.lastPong = Date.now();
    
    const clientTime = payload?.clientTime || 0;
    const latency = clientTime ? Date.now() - clientTime : 0;
    
    this.sendMessage(ws, {
      type: 'HEARTBEAT_ACK',
      payload: {
        serverTime: Date.now(),
        clientTime,
        latency
      }
    });
  }

  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        const data = JSON.stringify(message);
        ws.send(data);
        this.metrics.messagesSent.inc({ type: message.type || 'unknown' });
      } catch (error) {
        logger.error({ 
          userId: ws.userId, 
          error: error.message 
        }, 'Failed to send message');
      }
    }
  }

  broadcastToRoom(roomId, message, excludeUserId = null) {
    this.roomManager.broadcastToRoom(roomId, message, excludeUserId);
  }

  broadcastToAll(message) {
    for (const [userId, ws] of this.clients) {
      this.sendMessage(ws, message);
    }
  }

  async verifyToken(token) {
    return new Promise((resolve, reject) => {
      jwt.verify(token, this.jwtSecret, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });
  }

  extractToken(req) {
    // 从 URL 参数获取
    const url = new URL(req.url, `http://${req.headers.host}`);
    const tokenFromUrl = url.searchParams.get('token');
    if (tokenFromUrl) return tokenFromUrl;
    
    // 从协议头获取
    const protocol = req.headers['sec-websocket-protocol'];
    if (protocol) {
      // 格式: "token, other-protocol"
      const parts = protocol.split(',').map(p => p.trim());
      if (parts[0] && parts[0] !== 'undefined') {
        return parts[0];
      }
    }
    
    // 从 Authorization 头获取
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) {
      return auth.substring(7);
    }
    
    return null;
  }

  getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           'unknown';
  }

  getStats() {
    return {
      connections: this.clients.size,
      rooms: this.roomManager.getRoomCount(),
      uptime: Math.floor((Date.now() - this.stats.startTime) / 1000),
      totalConnections: this.stats.totalConnections,
      totalMessages: this.stats.totalMessages,
      totalErrors: this.stats.totalErrors,
      memoryUsage: process.memoryUsage()
    };
  }

  // 优雅关闭
  async shutdown() {
    logger.info('WebSocket server shutting down...');
    
    // 停止心跳检测
    this.heartbeatManager.stop();
    
    // 停止指标更新
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
    
    // 通知所有客户端
    this.broadcastToAll({
      type: 'SERVER_SHUTDOWN',
      payload: { message: 'Server is shutting down' }
    });
    
    // 关闭所有连接
    for (const [userId, ws] of this.clients) {
      ws.close(1001, 'Server shutting down');
    }
    
    // 关闭服务器
    return new Promise((resolve) => {
      this.server.close(() => {
        logger.info('WebSocket server closed');
        resolve();
      });
    });
  }
}

module.exports = { WebSocketServer };
