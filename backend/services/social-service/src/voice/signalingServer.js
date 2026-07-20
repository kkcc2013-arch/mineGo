// backend/services/social-service/src/voice/signalingServer.js
// REQ-00116: 精灵团队实时语音聊天系统 - 信令服务器

'use strict';

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../../../../shared/logger');
const { getPool } = require('../../../../shared/db');

const logger = createLogger('voice-signaling');

/**
 * 语音信令服务器
 * 处理 WebRTC 信令交换和房间管理
 */
class VoiceSignalingServer {
  constructor() {
    this.rooms = new Map(); // roomId -> room metadata
    this.connections = new Map(); // socketId -> { ws, userId, roomId }
    this.userIdMap = new Map(); // userId -> socketId (一个用户可能多个连接)
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
      const socketId = uuidv4();
      const userId = this.extractUserId(req);

      ws.socketId = socketId;
      ws.userId = userId;
      ws.isAlive = true;

      this.connections.set(socketId, { 
        ws, 
        userId, 
        roomId: null,
        joinedAt: Date.now()
      });

      // 用户ID映射（支持多设备）
      if (!this.userIdMap.has(userId)) {
        this.userIdMap.set(userId, new Set());
      }
      this.userIdMap.get(userId).add(socketId);

      // 发送连接成功消息
      ws.send(JSON.stringify({
        type: 'connected',
        payload: { socketId }
      }));

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(ws, message);
        } catch (error) {
          logger.error('Failed to parse message:', error);
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
        logger.error('WebSocket error:', { socketId, error: error.message });
        this.handleDisconnect(ws);
      });

      // 心跳检测
      ws.on('pong', () => {
        ws.isAlive = true;
      });

      logger.info('Voice client connected', { socketId, userId });
    });

    // 心跳检测定时器
    this.heartbeatInterval = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    logger.info('Voice signaling server initialized');
  }

  /**
   * 处理信令消息
   */
  async handleMessage(ws, message) {
    const { type, payload } = message;

    switch (type) {
      case 'join-room':
        await this.handleJoinRoom(ws, payload);
        break;
      case 'leave-room':
        await this.handleLeaveRoom(ws);
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
      case 'speaking':
        this.handleSpeaking(ws, payload);
        break;
      case 'kick-user':
        await this.handleKickUser(ws, payload);
        break;
      default:
        logger.warn('Unknown message type:', type);
    }
  }

  /**
   * 加入语音房间
   */
  async handleJoinRoom(ws, { roomId, password }) {
    const { socketId, userId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection) {
      return;
    }

    // 如果已经在房间中，先离开
    if (connection.roomId) {
      await this.handleLeaveRoom(ws);
    }

    try {
      const pool = getPool();
      
      // 获取或创建房间
      let room = this.rooms.get(roomId);
      
      if (!room) {
        // 从数据库加载房间
        const roomResult = await pool.query(
          'SELECT * FROM voice_rooms WHERE id = $1 AND status = $2',
          [roomId, 'active']
        );

        if (roomResult.rows.length > 0) {
          const dbRoom = roomResult.rows[0];
          room = {
            id: dbRoom.id,
            name: dbRoom.name,
            creatorId: dbRoom.creator_id,
            guildId: dbRoom.guild_id,
            roomType: dbRoom.room_type,
            maxMembers: dbRoom.max_members,
            passwordHash: dbRoom.password_hash,
            persistent: dbRoom.persistent,
            config: dbRoom.config || {},
            members: new Map()
          };
          this.rooms.set(roomId, room);
        }
      }

      // 如果房间不存在，自动创建临时房间（用于战斗场景）
      if (!room) {
        room = await this.createRoom(roomId, userId, 'temporary');
      }

      // 验证房间密码
      if (room.passwordHash) {
        const bcrypt = require('bcrypt');
        if (!password || !await bcrypt.compare(password, room.passwordHash)) {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { code: 'INVALID_PASSWORD', message: '房间密码错误' }
          }));
          return;
        }
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
      let role = 'member';
      if (room.members.size === 0) {
        role = 'host';
      } else if (room.guildId) {
        // 公会房间检查权限
        // TODO: 检查用户在公会中的角色
      }

      // 添加成员到房间
      const memberData = {
        socketId,
        userId,
        role,
        muted: false,
        deafened: false,
        speaking: false,
        joinedAt: Date.now()
      };

      room.members.set(socketId, memberData);
      connection.roomId = roomId;

      // 保存到数据库
      await pool.query(
        `INSERT INTO voice_room_members (room_id, user_id, role, socket_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, user_id) WHERE left_at IS NULL
         DO UPDATE SET socket_id = $4, joined_at = NOW()`,
        [roomId, userId, role, socketId]
      );

      // 更新房间统计
      await pool.query(
        `UPDATE voice_rooms 
         SET total_joins = total_joins + 1,
             peak_members = GREATEST(peak_members, (SELECT COUNT(*) FROM voice_room_members WHERE room_id = $1 AND left_at IS NULL))
         WHERE id = $1`,
        [roomId]
      );

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
          roomName: room.name,
          roomType: room.roomType,
          members: Array.from(room.members.entries()).map(([id, data]) => ({
            socketId: id,
            userId: data.userId,
            role: data.role,
            muted: data.muted,
            deafened: data.deafened
          })),
          config: room.config,
          role
        }
      }));

      // 记录指标
      this.recordMetric('voice_room_joined', { roomId, roomType: room.roomType, userId });

      logger.info('User joined voice room', { userId, roomId, role });
    } catch (error) {
      logger.error('Failed to join room:', error);
      ws.send(JSON.stringify({
        type: 'error',
        payload: { code: 'JOIN_FAILED', message: '加入房间失败' }
      }));
    }
  }

  /**
   * 离开语音房间
   */
  async handleLeaveRoom(ws) {
    const { socketId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection || !connection.roomId) {
      return;
    }

    const { roomId, userId } = connection;
    const room = this.rooms.get(roomId);
    
    if (!room) {
      connection.roomId = null;
      return;
    }

    try {
      const pool = getPool();

      // 移除成员
      room.members.delete(socketId);
      connection.roomId = null;

      // 更新数据库
      await pool.query(
        'UPDATE voice_room_members SET left_at = NOW() WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
        [roomId, userId]
      );

      // 通知其他成员
      this.broadcastToRoom(roomId, {
        type: 'user-left',
        payload: { userId, socketId }
      });

      // 如果房间为空且是临时房间，关闭房间
      if (room.members.size === 0 && room.roomType === 'temporary') {
        this.rooms.delete(roomId);
        await pool.query(
          'UPDATE voice_rooms SET status = $1, closed_at = NOW() WHERE id = $2',
          ['closed', roomId]
        );
        logger.info('Voice room closed', { roomId });
      } else if (room.members.size > 0) {
        // 如果房主离开，转让房主
        const oldHostId = room.creatorId;
        if (room.creatorId === userId) {
          const newHost = room.members.values().next().value;
          if (newHost) {
            newHost.role = 'host';
            room.creatorId = newHost.userId;

            await pool.query(
              'UPDATE voice_room_members SET role = $1 WHERE room_id = $2 AND user_id = $3',
              ['host', roomId, newHost.userId]
            );

            this.broadcastToRoom(roomId, {
              type: 'host-changed',
              payload: { 
                oldHostId, 
                newHostId: newHost.userId,
                newHostSocketId: newHost.socketId
              }
            });
          }
        }
      }

      this.recordMetric('voice_room_left', { roomId, roomType: room.roomType, userId });
      logger.info('User left voice room', { userId, roomId });
    } catch (error) {
      logger.error('Failed to leave room:', error);
    }
  }

  /**
   * 创建语音房间
   */
  async createRoom(roomId, creatorId, roomType = 'temporary', options = {}) {
    const pool = getPool();
    const room = {
      id: roomId,
      name: options.name || `Voice Room ${roomId.slice(0, 8)}`,
      creatorId,
      guildId: options.guildId || null,
      roomType,
      maxMembers: options.maxMembers || 10,
      passwordHash: null,
      persistent: roomType === 'guild',
      config: {
        bitrate: 64000,
        codec: 'opus',
        noiseSuppression: true,
        echoCancellation: true,
        autoGainControl: true
      },
      members: new Map()
    };

    // 保存到数据库
    await pool.query(
      `INSERT INTO voice_rooms (id, name, creator_id, guild_id, room_type, max_members, persistent, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [room.id, room.name, room.creatorId, room.guildId, room.roomType, 
       room.maxMembers, room.persistent, room.config]
    );

    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * 处理 WebRTC Offer
   */
  handleOffer(ws, { targetSocketId, offer }) {
    const targetWs = this.connections.get(targetSocketId)?.ws;
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    targetWs.send(JSON.stringify({
      type: 'offer',
      payload: {
        sourceSocketId: ws.socketId,
        offer
      }
    }));
  }

  /**
   * 处理 WebRTC Answer
   */
  handleAnswer(ws, { targetSocketId, answer }) {
    const targetWs = this.connections.get(targetSocketId)?.ws;
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    targetWs.send(JSON.stringify({
      type: 'answer',
      payload: {
        sourceSocketId: ws.socketId,
        answer
      }
    }));
  }

  /**
   * 处理 ICE Candidate
   */
  handleIceCandidate(ws, { targetSocketId, candidate }) {
    const targetWs = this.connections.get(targetSocketId)?.ws;
    if (!targetWs || targetWs.readyState !== WebSocket.OPEN) {
      return;
    }

    targetWs.send(JSON.stringify({
      type: 'ice-candidate',
      payload: {
        sourceSocketId: ws.socketId,
        candidate
      }
    }));
  }

  /**
   * 处理静音
   */
  handleMute(ws, { muted }) {
    const { socketId } = ws;
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
        payload: { userId: connection.userId, socketId, muted }
      });
    }
  }

  /**
   * 处理聋音
   */
  handleDeafen(ws, { deafened }) {
    const { socketId } = ws;
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
        payload: { userId: connection.userId, socketId, deafened }
      });
    }
  }

  /**
   * 处理说话状态
   */
  handleSpeaking(ws, { speaking }) {
    const { socketId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection || !connection.roomId) {
      return;
    }

    const room = this.rooms.get(connection.roomId);
    if (!room) {
      return;
    }

    const member = room.members.get(socketId);
    if (member && member.speaking !== speaking) {
      member.speaking = speaking;
      
      this.broadcastToRoom(connection.roomId, {
        type: 'user-speaking-changed',
        payload: { userId: connection.userId, socketId, speaking }
      });
    }
  }

  /**
   * 踢出用户
   */
  async handleKickUser(ws, { targetUserId, reason }) {
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
    if (!member || (member.role !== 'host' && member.role !== 'admin')) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { code: 'PERMISSION_DENIED', message: '没有权限踢出用户' }
      }));
      return;
    }

    // 找到目标用户的所有连接
    const targetSocketIds = this.userIdMap.get(targetUserId);
    if (!targetSocketIds) {
      return;
    }

    for (const targetSocketId of targetSocketIds) {
      const targetConn = this.connections.get(targetSocketId);
      if (targetConn && targetConn.roomId === connection.roomId) {
        const targetWs = targetConn.ws;
        targetWs.send(JSON.stringify({
          type: 'kicked',
          payload: { reason, kickedBy: userId }
        }));
        
        await this.handleLeaveRoom(targetWs);
      }
    }

    logger.info('User kicked from voice room', { 
      targetUserId, 
      kickedBy: userId, 
      roomId: connection.roomId, 
      reason 
    });
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
    for (const [socketId, member] of room.members) {
      if (socketId === excludeSocketId) {
        continue;
      }

      const conn = this.connections.get(socketId);
      if (conn && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(messageStr);
      }
    }
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

    // 清理连接映射
    this.connections.delete(socketId);
    
    // 清理用户ID映射
    const userSockets = this.userIdMap.get(userId);
    if (userSockets) {
      userSockets.delete(socketId);
      if (userSockets.size === 0) {
        this.userIdMap.delete(userId);
      }
    }

    this.recordMetric('voice_disconnected', { userId });
    logger.info('Voice client disconnected', { socketId, userId });
  }

  /**
   * 提取用户 ID
   */
  extractUserId(req) {
    const token = req.headers['sec-websocket-protocol'];
    // TODO: 实际实现需要验证 JWT token
    // 这里暂时返回一个占位符
    return 'user-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 记录指标
   */
  recordMetric(name, labels) {
    if (global.metrics && global.metrics.increment) {
      global.metrics.increment(name, labels);
    }
  }

  /**
   * 获取房间统计信息
   */
  getStats() {
    return {
      totalConnections: this.connections.size,
      totalUsers: this.userIdMap.size,
      totalRooms: this.rooms.size,
      rooms: Array.from(this.rooms.entries()).map(([id, room]) => ({
        id,
        name: room.name,
        type: room.roomType,
        members: room.members.size,
        maxMembers: room.maxMembers
      }))
    };
  }

  /**
   * 关闭服务器
   */
  async close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // 关闭所有连接
    for (const [socketId, connection] of this.connections) {
      if (connection.ws.readyState === WebSocket.OPEN) {
        connection.ws.close(1001, 'Server shutting down');
      }
    }

    if (this.wss) {
      await new Promise((resolve) => {
        this.wss.close(resolve);
      });
    }

    logger.info('Voice signaling server closed');
  }
}

module.exports = VoiceSignalingServer;