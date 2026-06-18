/**
 * Voice Signaling Server - WebRTC 信令服务器
 * 实现语音房间的信令交换、成员管理、ICE Candidate 转发
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../../shared/logger');
const metrics = require('../voiceMetrics');

class VoiceSignalingServer {
  constructor(options = {}) {
    this.rooms = new Map(); // roomId -> room metadata
    this.connections = new Map(); // socketId -> { ws, userId, roomId }
    this.userRooms = new Map(); // userId -> roomId (用户当前所在房间)
    this.redis = options.redis || null;
    this.wss = null;
    this.heartbeatInterval = null;
    
    this.config = {
      maxMembersPerRoom: options.maxMembersPerRoom || 50,
      defaultBitrate: options.defaultBitrate || 64000,
      idleTimeout: options.idleTimeout || 300000, // 5 分钟无活动断开
      ...options
    };
  }

  /**
   * 初始化 WebSocket 服务器
   */
  initialize(server) {
    this.wss = new WebSocket.Server({ 
      server, 
      path: '/voice/signaling',
      clientTracking: true
    });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      logger.error('Voice signaling server error', { error: error.message });
    });

    // 启动心跳检测
    this.startHeartbeat();

    logger.info('Voice signaling server initialized');
  }

  /**
   * 处理新连接
   */
  handleConnection(ws, req) {
    const socketId = uuidv4();
    const userId = this.extractUserId(req);

    ws.socketId = socketId;
    ws.userId = userId;
    ws.isAlive = true;
    ws.lastActivity = Date.now();

    this.connections.set(socketId, { ws, userId, roomId: null });

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data);
        this.handleMessage(ws, message);
        ws.lastActivity = Date.now();
      } catch (error) {
        logger.error('Failed to parse signaling message', { 
          socketId, 
          error: error.message 
        });
        ws.send(JSON.stringify({
          type: 'error',
          payload: { code: 'PARSE_ERROR', message: 'Invalid message format' }
        }));
      }
    });

    ws.on('close', () => {
      this.handleDisconnect(ws);
    });

    ws.on('error', (error) => {
      logger.error('WebSocket error', { socketId, error: error.message });
      this.handleDisconnect(ws);
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // 发送连接确认
    ws.send(JSON.stringify({
      type: 'connected',
      payload: { socketId }
    }));

    logger.info('Voice signaling connected', { socketId, userId });
    metrics.signalingMessages.inc({ type: 'connection' });
  }

  /**
   * 处理信令消息
   */
  handleMessage(ws, message) {
    const { type, payload } = message;

    switch (type) {
      case 'join-room':
        this.handleJoinRoom(ws, payload);
        break;
      case 'leave-room':
        this.handleLeaveRoom(ws);
        break;
      case 'offer':
        this.handleOffer(ws, payload);
        break;
      case 'answer':
        this.handleAnswer(ws, payload);
        break;
      case 'ice-candidate':
        this.handleIceCandidate(ws, payload);
        break;
      case 'mute':
        this.handleMute(ws, payload);
        break;
      case 'deafen':
        this.handleDeafen(ws, payload);
        break;
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      default:
        logger.warn('Unknown signaling message type', { type });
    }
  }

  /**
   * 加入语音房间
   */
  async handleJoinRoom(ws, { roomId, password }) {
    const { socketId, userId } = ws;
    
    // 检查用户是否已在其他房间
    const currentRoom = this.userRooms.get(userId);
    if (currentRoom && currentRoom !== roomId) {
      // 自动离开之前的房间
      await this.handleLeaveRoom(ws);
    }

    // 获取或创建房间
    let room = this.rooms.get(roomId);
    if (!room) {
      room = await this.createRoom(roomId, userId);
    }

    // 验证房间密码
    if (room.password && room.password !== password) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { code: 'INVALID_PASSWORD', message: '房间密码错误' }
      }));
      return;
    }

    // 验证房间容量
    if (room.members.size >= room.maxMembers) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { code: 'ROOM_FULL', message: '房间已满' }
      }));
      return;
    }

    // 确定成员角色
    const role = room.members.size === 0 ? 'host' : 'member';

    // 添加成员到房间
    const memberData = {
      socketId,
      userId,
      role,
      muted: false,
      deafened: false,
      joinedAt: Date.now()
    };

    room.members.set(socketId, memberData);
    this.connections.get(socketId).roomId = roomId;
    this.userRooms.set(userId, roomId);

    // 通知房间内其他成员
    this.broadcastToRoom(roomId, {
      type: 'user-joined',
      payload: { userId, socketId, role, muted: false, deafened: false }
    }, socketId);

    // 发送房间信息给新成员
    ws.send(JSON.stringify({
      type: 'room-joined',
      payload: {
        roomId,
        role,
        members: Array.from(room.members.entries()).map(([id, data]) => ({
          socketId: id,
          userId: data.userId,
          role: data.role,
          muted: data.muted,
          deafened: data.deafened
        })),
        config: room.config
      }
    }));

    // 更新 Redis 缓存
    if (this.redis) {
      await this.updateRoomCache(roomId, room);
    }
    
    // 记录指标
    metrics.activeVoiceRooms.set(
      { type: room.persistent ? 'persistent' : 'temporary' },
      this.countActiveRooms()
    );
    metrics.activeVoiceUsers.set(this.countActiveUsers());

    logger.info('User joined voice room', { roomId, userId, role });
  }

  /**
   * 处理 WebRTC Offer
   */
  handleOffer(ws, { targetSocketId, offer }) {
    const sourceSocketId = ws.socketId;
    const targetWs = this.connections.get(targetSocketId)?.ws;
    
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      logger.warn('Target not found for offer', { targetSocketId });
      return;
    }

    targetWs.send(JSON.stringify({
      type: 'offer',
      payload: {
        sourceSocketId,
        offer
      }
    }));

    metrics.signalingMessages.inc({ type: 'offer' });
  }

  /**
   * 处理 WebRTC Answer
   */
  handleAnswer(ws, { targetSocketId, answer }) {
    const sourceSocketId = ws.socketId;
    const targetWs = this.connections.get(targetSocketId)?.ws;
    
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      logger.warn('Target not found for answer', { targetSocketId });
      return;
    }

    targetWs.send(JSON.stringify({
      type: 'answer',
      payload: {
        sourceSocketId,
        answer
      }
    }));

    metrics.signalingMessages.inc({ type: 'answer' });
  }

  /**
   * 处理 ICE Candidate
   */
  handleIceCandidate(ws, { targetSocketId, candidate }) {
    const sourceSocketId = ws.socketId;
    const targetWs = this.connections.get(targetSocketId)?.ws;
    
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    targetWs.send(JSON.stringify({
      type: 'ice-candidate',
      payload: {
        sourceSocketId,
        candidate
      }
    }));

    metrics.signalingMessages.inc({ type: 'ice-candidate' });
  }

  /**
   * 广播消息到房间
   */
  broadcastToRoom(roomId, message, excludeSocketId = null) {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    const messageStr = JSON.stringify(message);
    let sentCount = 0;

    for (const [socketId, member] of room.members) {
      if (socketId === excludeSocketId) {
        continue;
      }

      const conn = this.connections.get(socketId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(messageStr);
        sentCount++;
      }
    }

    return sentCount;
  }

  /**
   * 创建语音房间
   */
  async createRoom(roomId, creatorId, options = {}) {
    const room = {
      id: roomId,
      creatorId,
      createdAt: Date.now(),
      members: new Map(),
      maxMembers: options.maxMembers || this.config.maxMembersPerRoom,
      password: options.password || null,
      persistent: options.persistent || false,
      config: {
        bitrate: options.bitrate || this.config.defaultBitrate,
        codec: 'opus',
        noiseSuppression: true,
        echoCancellation: true
      }
    };

    this.rooms.set(roomId, room);

    if (this.redis) {
      await this.redis.hset('voice:rooms', roomId, JSON.stringify({
        id: roomId,
        creatorId,
        createdAt: room.createdAt,
        memberCount: 0,
        persistent: room.persistent
      }));
    }

    metrics.roomsCreated.inc({ type: room.persistent ? 'persistent' : 'temporary' });
    logger.info('Voice room created', { roomId, creatorId });

    return room;
  }

  /**
   * 更新房间缓存
   */
  async updateRoomCache(roomId, room) {
    if (!this.redis) return;

    await this.redis.hset('voice:rooms', roomId, JSON.stringify({
      id: roomId,
      creatorId: room.creatorId,
      createdAt: room.createdAt,
      memberCount: room.members.size,
      persistent: room.persistent
    }));
  }

  /**
   * 处理断开连接
   */
  async handleDisconnect(ws) {
    const { socketId, userId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection) {
      return;
    }

    // 离开房间
    if (connection.roomId) {
      await this.handleLeaveRoom(ws);
    }

    this.connections.delete(socketId);
    this.userRooms.delete(userId);

    logger.info('Voice signaling disconnected', { socketId, userId });
  }

  /**
   * 离开语音房间
   */
  async handleLeaveRoom(ws) {
    const { socketId, userId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection || !connection.roomId) {
      return;
    }

    const { roomId } = connection;
    const room = this.rooms.get(roomId);
    
    if (!room) {
      connection.roomId = null;
      this.userRooms.delete(userId);
      return;
    }

    // 移除成员
    room.members.delete(socketId);
    connection.roomId = null;
    this.userRooms.delete(userId);

    // 通知其他成员
    this.broadcastToRoom(roomId, {
      type: 'user-left',
      payload: { userId, socketId }
    });

    // 如果房间为空且是临时房间，删除房间
    if (room.members.size === 0 && !room.persistent) {
      this.rooms.delete(roomId);
      if (this.redis) {
        await this.redis.hdel('voice:rooms', roomId);
      }
      logger.info('Voice room deleted', { roomId });
    } else if (room.members.size > 0) {
      // 如果房主离开，转让房主
      if (room.creatorId === userId) {
        const newHost = room.members.values().next().value;
        newHost.role = 'host';
        room.creatorId = newHost.userId;
        
        this.broadcastToRoom(roomId, {
          type: 'host-changed',
          payload: { newHostId: newHost.userId, newHostSocketId: newHost.socketId }
        });
        
        logger.info('Voice room host changed', { 
          roomId, 
          oldHost: userId, 
          newHost: newHost.userId 
        });
      }
      
      if (this.redis) {
        await this.updateRoomCache(roomId, room);
      }
    }

    // 更新指标
    metrics.activeVoiceRooms.set(
      { type: room.persistent ? 'persistent' : 'temporary' },
      this.countActiveRooms()
    );
    metrics.activeVoiceUsers.set(this.countActiveUsers());

    logger.info('User left voice room', { roomId, userId });
  }

  /**
   * 处理静音
   */
  handleMute(ws, { muted }) {
    const { socketId, userId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection || !connection.roomId) {
      return;
    }

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      return;
    }

    const member = room.members.get(socketId);
    if (member) {
      member.muted = muted;
      
      this.broadcastToRoom(connection.roomId, {
        type: 'user-mute-changed',
        payload: { userId, socketId, muted }
      });
    }
  }

  /**
   * 处理聋音（不听）
   */
  handleDeafen(ws, { deafened }) {
    const { socketId, userId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection || !connection.roomId) {
      return;
    }

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      return;
    }

    const member = room.members.get(socketId);
    if (member) {
      member.deafened = deafened;
      
      this.broadcastToRoom(connection.roomId, {
        type: 'user-deafen-changed',
        payload: { userId, socketId, deafened }
      });
    }
  }

  /**
   * 提取用户 ID（从 WebSocket 协议头或查询参数）
   */
  extractUserId(req) {
    // 从 sec-websocket-protocol 提取 token
    const protocol = req.headers['sec-websocket-protocol'];
    if (protocol) {
      // 实际实现需要验证 JWT
      // 这里简化处理
      try {
        const parts = protocol.split(',');
        for (const part of parts) {
          if (part.trim().startsWith('token=')) {
            return part.trim().substring(6);
          }
        }
      } catch (error) {
        logger.error('Failed to extract user ID from protocol', { error });
      }
    }

    // 从查询参数提取
    const url = new URL(req.url, `http://${req.headers.host}`);
    const userId = url.searchParams.get('userId');
    if (userId) {
      return userId;
    }

    // 生成临时 ID（实际应该拒绝连接）
    return `guest-${uuidv4().substring(0, 8)}`;
  }

  /**
   * 启动心跳检测
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      
      this.wss.clients.forEach((ws) => {
        // 检查连接是否存活
        if (!ws.isAlive) {
          logger.warn('Terminating dead connection', { socketId: ws.socketId });
          return ws.terminate();
        }

        // 检查空闲超时
        if (now - ws.lastActivity > this.config.idleTimeout) {
          logger.warn('Terminating idle connection', { socketId: ws.socketId });
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000); // 每 30 秒检测一次
  }

  /**
   * 统计活跃房间数
   */
  countActiveRooms() {
    let count = 0;
    for (const room of this.rooms.values()) {
      if (room.members.size > 0) {
        count++;
      }
    }
    return count;
  }

  /**
   * 统计活跃用户数
   */
  countActiveUsers() {
    let count = 0;
    for (const room of this.rooms.values()) {
      count += room.members.size;
    }
    return count;
  }

  /**
   * 获取房间信息
   */
  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /**
   * 获取用户当前房间
   */
  getUserRoom(userId) {
    const roomId = this.userRooms.get(userId);
    if (!roomId) return null;
    return this.rooms.get(roomId);
  }

  /**
   * 关闭服务器
   */
  async close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.wss) {
      // 关闭所有连接
      this.wss.clients.forEach((ws) => {
        ws.close(1001, 'Server shutting down');
      });
      
      await new Promise((resolve) => {
        this.wss.close(resolve);
      });
    }

    logger.info('Voice signaling server closed');
  }
}

module.exports = VoiceSignalingServer;
