# REQ-00116: 精灵团队实时语音聊天系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00116 |
| 标题 | 精灵团队实时语音聊天系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | gym-service、social-service、user-service、gateway、game-client、infrastructure/k8s |
| 创建时间 | 2026-06-11 16:00 |

## 需求描述

实现精灵团队实时语音聊天系统，允许玩家在团队战斗、Raid战、公会活动等场景中进行实时语音沟通，提升团队协作效率和游戏社交体验。

### 核心功能

1. **语音房间管理**
   - 支持创建临时语音房间（团队战斗自动创建）
   - 支持创建持久语音房间（公会语音频道）
   - 房间容量：2-50人可配置
   - 房间密码保护与权限控制

2. **语音通信功能**
   - 实时双向语音通信
   - 按住说话（Push-to-Talk）与语音激活模式
   - 降噪与回声消除
   - 音量调节与静音控制
   - 多人同时发言管理

3. **权限与角色系统**
   - 房主：管理房间、踢人、设置权限
   - 管理员：管理发言权限
   - 成员：正常发言
   - 观众：仅收听不发言

4. **场景集成**
   - 团队战斗（Raid）自动创建语音房间
   - 公会语音频道持久化
   - 好友私聊语音
   - 大厅语音聊天

## 技术方案

### 1. 后端架构

#### 1.1 语音信令服务 (Signaling Server)
```javascript
// backend/services/social-service/src/voice/signalingServer.js

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const Redis = require('ioredis');

class VoiceSignalingServer {
  constructor() {
    this.rooms = new Map(); // roomId -> room metadata
    this.connections = new Map(); // socketId -> { userId, roomId }
    this.redis = new Redis(process.env.REDIS_URL);
    this.wss = null;
  }

  /**
   * 初始化 WebSocket 服务器
   */
  initialize(server) {
    this.wss = new WebSocket.Server({ 
      server, 
      path: '/voice/signaling' 
    });

    this.wss.on('connection', (ws, req) => {
      const socketId = uuidv4();
      const userId = this.extractUserId(req);

      ws.socketId = socketId;
      ws.userId = userId;
      this.connections.set(socketId, { ws, userId, roomId: null });

      ws.on('message', (data) => {
        this.handleMessage(ws, JSON.parse(data));
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.handleDisconnect(ws);
      });
    });
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
      default:
        console.warn('Unknown message type:', type);
    }
  }

  /**
   * 加入语音房间
   */
  async handleJoinRoom(ws, { roomId, password }) {
    const { socketId, userId } = ws;
    
    // 验证房间存在性
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

    // 添加成员到房间
    const memberData = {
      socketId,
      userId,
      role: room.members.size === 0 ? 'host' : 'member',
      muted: false,
      deafened: false,
      joinedAt: Date.now()
    };

    room.members.set(socketId, memberData);
    this.connections.get(socketId).roomId = roomId;

    // 通知房间内其他成员
    this.broadcastToRoom(roomId, {
      type: 'user-joined',
      payload: { userId, socketId, role: memberData.role }
    }, socketId);

    // 发送房间信息给新成员
    ws.send(JSON.stringify({
      type: 'room-joined',
      payload: {
        roomId,
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
    await this.updateRoomCache(roomId, room);
    
    // 记录指标
    this.recordMetric('voice_room_joined', { roomId, userId });
  }

  /**
   * 处理 WebRTC Offer
   */
  handleOffer(ws, { targetSocketId, offer }) {
    const targetWs = this.connections.get(targetSocketId)?.ws;
    if (!targetWs) {
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
    if (!targetWs) {
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
    if (!targetWs) {
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
   * 创建语音房间
   */
  async createRoom(roomId, creatorId) {
    const room = {
      id: roomId,
      creatorId,
      createdAt: Date.now(),
      members: new Map(),
      maxMembers: 50,
      password: null,
      config: {
        bitrate: 64000, // 64kbps
        codec: 'opus',
        noiseSuppression: true,
        echoCancellation: true
      }
    };

    this.rooms.set(roomId, room);
    await this.redis.hset('voice:rooms', roomId, JSON.stringify({
      id: roomId,
      creatorId,
      createdAt: room.createdAt,
      memberCount: 0
    }));

    return room;
  }

  /**
   * 更新房间缓存
   */
  async updateRoomCache(roomId, room) {
    await this.redis.hset('voice:rooms', roomId, JSON.stringify({
      id: roomId,
      creatorId: room.creatorId,
      createdAt: room.createdAt,
      memberCount: room.members.size
    }));
  }

  /**
   * 处理断开连接
   */
  async handleDisconnect(ws) {
    const { socketId } = ws;
    const connection = this.connections.get(socketId);
    
    if (!connection) {
      return;
    }

    const { roomId, userId } = connection;
    
    if (roomId) {
      await this.handleLeaveRoom(ws);
    }

    this.connections.delete(socketId);
    this.recordMetric('voice_disconnected', { userId });
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
      return;
    }

    // 移除成员
    room.members.delete(socketId);
    connection.roomId = null;

    // 通知其他成员
    this.broadcastToRoom(roomId, {
      type: 'user-left',
      payload: { userId, socketId }
    });

    // 如果房间为空且是临时房间，删除房间
    if (room.members.size === 0 && !room.persistent) {
      this.rooms.delete(roomId);
      await this.redis.hdel('voice:rooms', roomId);
    } else {
      // 如果房主离开，转让房主
      if (room.members.size > 0 && room.creatorId === userId) {
        const newHost = room.members.values().next().value;
        newHost.role = 'host';
        room.creatorId = newHost.userId;
        
        this.broadcastToRoom(roomId, {
          type: 'host-changed',
          payload: { newHostId: newHost.userId }
        });
      }
      
      await this.updateRoomCache(roomId, room);
    }

    this.recordMetric('voice_room_left', { roomId, userId });
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
        payload: { userId: connection.userId, muted }
      });
    }
  }

  /**
   * 处理聋音（不听）
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
        payload: { userId: connection.userId, deafened }
      });
    }
  }

  /**
   * 提取用户 ID
   */
  extractUserId(req) {
    const token = req.headers['sec-websocket-protocol'];
    // 从 JWT token 中解析 userId
    // 实际实现需要验证 token
    return 'user-' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 记录指标
   */
  recordMetric(name, labels) {
    // 发送到 Prometheus
    if (global.metrics) {
      global.metrics.increment(name, labels);
    }
  }
}

module.exports = VoiceSignalingServer;
```

#### 1.2 TURN/STUN 服务器配置
```javascript
// backend/services/social-service/src/voice/turnServer.js

const coturn = require('coturn-admin');

class TURNServerManager {
  constructor() {
    this.config = {
      listeningPort: process.env.TURN_PORT || 3478,
      relayPortRange: '49152-65535',
      realm: process.env.TURN_REALM || 'minego.local',
      credentialsTTL: 86400 // 24 小时
    };
  }

  /**
   * 生成 TURN 凭证
   */
  generateCredentials(userId) {
    const timestamp = Math.floor(Date.now() / 1000) + this.config.credentialsTTL;
    const username = `${timestamp}:${userId}`;
    const password = this.generatePassword(username);
    
    return {
      username,
      password,
      ttl: this.config.credentialsTTL,
      uris: [
        `turn:${process.env.TURN_HOST}:${this.config.listeningPort}?transport=udp`,
        `turn:${process.env.TURN_HOST}:${this.config.listeningPort}?transport=tcp`,
        `turns:${process.env.TURN_HOST}:${this.config.listeningPort}?transport=tcp`
      ]
    };
  }

  /**
   * 生成密码
   */
  generatePassword(username) {
    const crypto = require('crypto');
    const secret = process.env.TURN_SECRET;
    return crypto
      .createHmac('sha1', secret)
      .update(username)
      .digest('base64');
  }

  /**
   * API 端点：获取 TURN 凭证
   */
  async getCredentials(req, res) {
    const userId = req.user.id;
    const credentials = this.generateCredentials(userId);
    
    res.json({
      success: true,
      data: credentials
    });
  }
}

module.exports = TURNServerManager;
```

#### 1.3 API 路由
```javascript
// backend/services/social-service/src/routes/voice.js

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const authMiddleware = require('../../../shared/middleware/auth');
const VoiceRoomManager = require('../voice/roomManager');
const TURNServerManager = require('../voice/turnServer');

const voiceRoomManager = new VoiceRoomManager();
const turnServer = new TURNServerManager();

/**
 * 创建语音房间
 * POST /api/voice/rooms
 */
router.post('/rooms', 
  authMiddleware,
  [
    body('name').optional().isString().trim().isLength({ max: 100 }),
    body('maxMembers').optional().isInt({ min: 2, max: 50 }),
    body('password').optional().isString().isLength({ min: 4, max: 32 }),
    body('persistent').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, maxMembers = 10, password, persistent = false } = req.body;
    const userId = req.user.id;

    const room = await voiceRoomManager.createRoom({
      name: name || `Voice Room ${Date.now()}`,
      creatorId: userId,
      maxMembers,
      password,
      persistent
    });

    res.json({
      success: true,
      data: {
        roomId: room.id,
        name: room.name,
        maxMembers: room.maxMembers,
        hasPassword: !!password,
        createdAt: room.createdAt
      }
    });
  }
);

/**
 * 获取语音房间信息
 * GET /api/voice/rooms/:roomId
 */
router.get('/rooms/:roomId',
  authMiddleware,
  [param('roomId').isString().notEmpty()],
  async (req, res) => {
    const { roomId } = req.params;
    const room = await voiceRoomManager.getRoom(roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    res.json({
      success: true,
      data: {
        id: room.id,
        name: room.name,
        creatorId: room.creatorId,
        memberCount: room.members.size,
        maxMembers: room.maxMembers,
        hasPassword: !!room.password,
        persistent: room.persistent,
        createdAt: room.createdAt
      }
    });
  }
);

/**
 * 加入语音房间
 * POST /api/voice/rooms/:roomId/join
 */
router.post('/rooms/:roomId/join',
  authMiddleware,
  [
    param('roomId').isString().notEmpty(),
    body('password').optional().isString()
  ],
  async (req, res) => {
    const { roomId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;

    const result = await voiceRoomManager.joinRoom(roomId, userId, password);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      data: {
        roomId,
        role: result.role,
        turnCredentials: turnServer.generateCredentials(userId)
      }
    });
  }
);

/**
 * 踢出房间成员
 * POST /api/voice/rooms/:roomId/kick
 */
router.post('/rooms/:roomId/kick',
  authMiddleware,
  [
    param('roomId').isString().notEmpty(),
    body('targetUserId').isString().notEmpty(),
    body('reason').optional().isString()
  ],
  async (req, res) => {
    const { roomId } = req.params;
    const { targetUserId, reason } = req.body;
    const userId = req.user.id;

    const result = await voiceRoomManager.kickMember(roomId, userId, targetUserId, reason);

    if (!result.success) {
      return res.status(403).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Member kicked successfully'
    });
  }
);

/**
 * 获取 TURN 服务器凭证
 * GET /api/voice/turn-credentials
 */
router.get('/turn-credentials',
  authMiddleware,
  async (req, res) => {
    const credentials = turnServer.generateCredentials(req.user.id);
    
    res.json({
      success: true,
      data: credentials
    });
  }
);

/**
 * 获取用户当前语音房间
 * GET /api/voice/current-room
 */
router.get('/current-room',
  authMiddleware,
  async (req, res) => {
    const userId = req.user.id;
    const room = await voiceRoomManager.getUserCurrentRoom(userId);

    res.json({
      success: true,
      data: room || null
    });
  }
);

/**
 * 获取公共语音房间列表
 * GET /api/voice/public-rooms
 */
router.get('/public-rooms',
  authMiddleware,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 })
  ],
  async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const rooms = await voiceRoomManager.getPublicRooms(page, limit);

    res.json({
      success: true,
      data: rooms
    });
  }
);

/**
 * 设置房间配置
 * PATCH /api/voice/rooms/:roomId/config
 */
router.patch('/rooms/:roomId/config',
  authMiddleware,
  [
    param('roomId').isString().notEmpty(),
    body('bitrate').optional().isInt({ min: 6000, max: 510000 }),
    body('noiseSuppression').optional().isBoolean(),
    body('echoCancellation').optional().isBoolean()
  ],
  async (req, res) => {
    const { roomId } = req.params;
    const userId = req.user.id;

    const result = await voiceRoomManager.updateConfig(roomId, userId, req.body);

    if (!result.success) {
      return res.status(403).json({
        success: false,
        error: result.error
      });
    }

    res.json({
      success: true,
      message: 'Config updated successfully'
    });
  }
);

module.exports = router;
```

### 2. 前端实现

#### 2.1 语音客户端管理器
```javascript
// frontend/game-client/src/voice/VoiceClient.js

class VoiceClient {
  constructor() {
    this.localStream = null;
    this.peerConnections = new Map(); // socketId -> RTCPeerConnection
    this.audioElements = new Map(); // socketId -> HTMLAudioElement
    this.signalingSocket = null;
    this.currentRoom = null;
    this.muted = false;
    this.deafened = false;
    this.config = {
      iceServers: [],
      audioConstraints: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48000,
        channelCount: 1
      }
    };
  }

  /**
   * 初始化语音客户端
   */
  async initialize(token) {
    // 连接信令服务器
    this.signalingSocket = new WebSocket(
      `${process.env.VOICE_WS_URL}/voice/signaling`,
      token
    );

    this.signalingSocket.onopen = () => {
      console.log('Voice signaling connected');
    };

    this.signalingSocket.onmessage = (event) => {
      this.handleSignalingMessage(JSON.parse(event.data));
    };

    this.signalingSocket.onerror = (error) => {
      console.error('Voice signaling error:', error);
    };

    this.signalingSocket.onclose = () => {
      console.log('Voice signaling disconnected');
      this.cleanup();
    };

    // 获取 TURN 凭证
    const turnResponse = await fetch('/api/voice/turn-credentials', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const turnData = await turnResponse.json();
    
    if (turnData.success) {
      this.config.iceServers = [{
        urls: turnData.data.uris,
        username: turnData.data.username,
        credential: turnData.data.password
      }];
    }
  }

  /**
   * 获取本地音频流
   */
  async getLocalStream() {
    if (this.localStream) {
      return this.localStream;
    }

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: this.config.audioConstraints,
        video: false
      });

      // 添加音频分析器（用于音量可视化）
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(this.localStream);
      source.connect(analyser);
      analyser.fftSize = 256;
      
      this.analyser = analyser;
      
      return this.localStream;
    } catch (error) {
      console.error('Failed to get local stream:', error);
      throw error;
    }
  }

  /**
   * 加入语音房间
   */
  async joinRoom(roomId, password = null) {
    if (!this.signalingSocket || this.signalingSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Signaling not connected');
    }

    // 获取本地音频流
    await this.getLocalStream();

    // 发送加入房间请求
    this.signalingSocket.send(JSON.stringify({
      type: 'join-room',
      payload: { roomId, password }
    }));

    this.currentRoom = roomId;
  }

  /**
   * 离开语音房间
   */
  leaveRoom() {
    if (!this.currentRoom) {
      return;
    }

    this.signalingSocket.send(JSON.stringify({
      type: 'leave-room',
      payload: {}
    }));

    this.cleanup();
    this.currentRoom = null;
  }

  /**
   * 处理信令消息
   */
  handleSignalingMessage(message) {
    const { type, payload } = message;

    switch (type) {
      case 'room-joined':
        this.handleRoomJoined(payload);
        break;
      case 'user-joined':
        this.handleUserJoined(payload);
        break;
      case 'user-left':
        this.handleUserLeft(payload);
        break;
      case 'offer':
        this.handleOffer(payload);
        break;
      case 'answer':
        this.handleAnswer(payload);
        break;
      case 'ice-candidate':
        this.handleIceCandidate(payload);
        break;
      case 'user-mute-changed':
        this.handleUserMuteChanged(payload);
        break;
      case 'user-deafen-changed':
        this.handleUserDeafenChanged(payload);
        break;
      case 'error':
        console.error('Voice error:', payload);
        break;
    }
  }

  /**
   * 处理房间加入成功
   */
  handleRoomJoined(payload) {
    const { members } = payload;
    
    // 为房间内已存在的成员创建连接
    members.forEach(member => {
      if (member.socketId !== this.signalingSocket.socketId) {
        this.createPeerConnection(member.socketId, true);
      }
    });

    // 触发事件
    this.emit('room-joined', payload);
  }

  /**
   * 处理新用户加入
   */
  handleUserJoined(payload) {
    const { socketId, userId } = payload;
    
    // 新用户加入，等待对方创建 Offer
    // （作为后加入者，不需要主动创建 Offer）
    
    this.emit('user-joined', payload);
  }

  /**
   * 处理用户离开
   */
  handleUserLeft(payload) {
    const { socketId } = payload;
    
    this.closePeerConnection(socketId);
    this.emit('user-left', payload);
  }

  /**
   * 处理 WebRTC Offer
   */
  async handleOffer(payload) {
    const { sourceSocketId, offer } = payload;

    if (!this.peerConnections.has(sourceSocketId)) {
      this.createPeerConnection(sourceSocketId, false);
    }

    const pc = this.peerConnections.get(sourceSocketId);
    
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    this.signalingSocket.send(JSON.stringify({
      type: 'answer',
      payload: {
        targetSocketId: sourceSocketId,
        answer: answer
      }
    }));
  }

  /**
   * 处理 WebRTC Answer
   */
  async handleAnswer(payload) {
    const { sourceSocketId, answer } = payload;
    const pc = this.peerConnections.get(sourceSocketId);
    
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  /**
   * 处理 ICE Candidate
   */
  async handleIceCandidate(payload) {
    const { sourceSocketId, candidate } = payload;
    const pc = this.peerConnections.get(sourceSocketId);
    
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  /**
   * 创建 PeerConnection
   */
  async createPeerConnection(socketId, isInitiator) {
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers
    });

    // 添加本地音频轨道
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // 处理远程音频轨道
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      this.handleRemoteStream(socketId, remoteStream);
    };

    // 处理 ICE Candidate
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingSocket.send(JSON.stringify({
          type: 'ice-candidate',
          payload: {
            targetSocketId: socketId,
            candidate: event.candidate
          }
        }));
      }
    };

    // 处理连接状态变化
    pc.onconnectionstatechange = () => {
      console.log(`PeerConnection state: ${pc.connectionState}`);
      
      if (pc.connectionState === 'connected') {
        this.emit('peer-connected', { socketId });
      } else if (pc.connectionState === 'disconnected' || 
                 pc.connectionState === 'failed') {
        this.closePeerConnection(socketId);
      }
    };

    this.peerConnections.set(socketId, pc);

    // 如果是发起者，创建 Offer
    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      this.signalingSocket.send(JSON.stringify({
        type: 'offer',
        payload: {
          targetSocketId: socketId,
          offer: offer
        }
      }));
    }
  }

  /**
   * 处理远程音频流
   */
  handleRemoteStream(socketId, stream) {
    // 创建音频元素播放远程音频
    let audioElement = this.audioElements.get(socketId);
    
    if (!audioElement) {
      audioElement = new Audio();
      audioElement.autoplay = true;
      this.audioElements.set(socketId, audioElement);
    }

    audioElement.srcObject = stream;
    
    this.emit('remote-stream', { socketId, stream });
  }

  /**
   * 关闭 PeerConnection
   */
  closePeerConnection(socketId) {
    const pc = this.peerConnections.get(socketId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(socketId);
    }

    const audioElement = this.audioElements.get(socketId);
    if (audioElement) {
      audioElement.pause();
      audioElement.srcObject = null;
      this.audioElements.delete(socketId);
    }

    this.emit('peer-disconnected', { socketId });
  }

  /**
   * 设置静音
   */
  setMuted(muted) {
    this.muted = muted;
    
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !muted;
      });
    }

    if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify({
        type: 'mute',
        payload: { muted }
      }));
    }

    this.emit('mute-changed', { muted });
  }

  /**
   * 设置聋音
   */
  setDeafened(deafened) {
    this.deafened = deafened;
    
    // 静音所有远程音频
    this.audioElements.forEach(audio => {
      audio.muted = deafened;
    });

    if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify({
        type: 'deafen',
        payload: { deafened }
      }));
    }

    this.emit('deafen-changed', { deafened });
  }

  /**
   * 获取当前音量
   */
  getCurrentVolume() {
    if (!this.analyser) {
      return 0;
    }

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);
    
    const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    return average / 255; // 归一化到 0-1
  }

  /**
   * 清理资源
   */
  cleanup() {
    // 关闭所有 PeerConnection
    this.peerConnections.forEach((pc, socketId) => {
      this.closePeerConnection(socketId);
    });

    // 停止本地音频流
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    // 移除所有音频元素
    this.audioElements.forEach(audio => {
      audio.pause();
      audio.srcObject = null;
    });
    this.audioElements.clear();
  }

  /**
   * 断开连接
   */
  disconnect() {
    this.leaveRoom();
    
    if (this.signalingSocket) {
      this.signalingSocket.close();
      this.signalingSocket = null;
    }
  }

  /**
   * 事件发射器
   */
  emit(event, data) {
    if (this.eventListeners && this.eventListeners[event]) {
      this.eventListeners[event].forEach(callback => callback(data));
    }
  }

  on(event, callback) {
    if (!this.eventListeners) {
      this.eventListeners = {};
    }
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(callback);
  }
}

export default VoiceClient;
```

#### 2.2 语音房间 UI 组件
```javascript
// frontend/game-client/src/components/VoiceRoom.js

import React, { useState, useEffect, useRef } from 'react';
import VoiceClient from '../voice/VoiceClient';
import './VoiceRoom.css';

function VoiceRoom({ roomId, onLeave }) {
  const [voiceClient] = useState(() => new VoiceClient());
  const [members, setMembers] = useState([]);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [connected, setConnected] = useState(false);
  const [volume, setVolume] = useState(0);
  const volumeCheckInterval = useRef(null);

  useEffect(() => {
    initializeVoice();
    
    return () => {
      voiceClient.disconnect();
      if (volumeCheckInterval.current) {
        clearInterval(volumeCheckInterval.current);
      }
    };
  }, []);

  const initializeVoice = async () => {
    const token = localStorage.getItem('token');
    
    // 监听事件
    voiceClient.on('room-joined', handleRoomJoined);
    voiceClient.on('user-joined', handleUserJoined);
    voiceClient.on('user-left', handleUserLeft);
    voiceClient.on('peer-connected', handlePeerConnected);
    voiceClient.on('peer-disconnected', handlePeerDisconnected);
    voiceClient.on('mute-changed', handleMuteChanged);

    try {
      await voiceClient.initialize(token);
      await voiceClient.joinRoom(roomId);
    } catch (error) {
      console.error('Failed to initialize voice:', error);
    }
  };

  const handleRoomJoined = (payload) => {
    setMembers(payload.members);
    setConnected(true);
    
    // 启动音量检测
    volumeCheckInterval.current = setInterval(() => {
      setVolume(voiceClient.getCurrentVolume());
    }, 100);
  };

  const handleUserJoined = (payload) => {
    setMembers(prev => [...prev, {
      socketId: payload.socketId,
      userId: payload.userId,
      role: payload.role
    }]);
  };

  const handleUserLeft = (payload) => {
    setMembers(prev => prev.filter(m => m.socketId !== payload.socketId));
  };

  const handlePeerConnected = (payload) => {
    console.log('Peer connected:', payload.socketId);
  };

  const handlePeerDisconnected = (payload) => {
    console.log('Peer disconnected:', payload.socketId);
  };

  const handleMuteChanged = (payload) => {
    // 更新成员静音状态
    setMembers(prev => prev.map(m => 
      m.userId === payload.userId ? { ...m, muted: payload.muted } : m
    ));
  };

  const toggleMute = () => {
    const newMuted = !muted;
    setMuted(newMuted);
    voiceClient.setMuted(newMuted);
  };

  const toggleDeafen = () => {
    const newDeafened = !deafened;
    setDeafened(newDeafened);
    voiceClient.setDeafened(newDeafened);
  };

  const handleLeave = () => {
    voiceClient.leaveRoom();
    if (onLeave) {
      onLeave();
    }
  };

  return (
    <div className="voice-room">
      <div className="voice-room-header">
        <h3>语音房间</h3>
        <span className="room-id">{roomId}</span>
      </div>

      <div className="voice-members">
        {members.map(member => (
          <div key={member.socketId} className="voice-member">
            <div className="member-avatar">
              <img 
                src={`/api/users/${member.userId}/avatar`} 
                alt={member.userId} 
              />
              {member.muted && <div className="muted-indicator">🔇</div>}
            </div>
            <div className="member-info">
              <span className="member-name">{member.userId}</span>
              <span className="member-role">{member.role}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="voice-controls">
        <button 
          className={`control-btn ${muted ? 'active' : ''}`}
          onClick={toggleMute}
        >
          {muted ? '🔇' : '🎤'}
        </button>
        
        <button 
          className={`control-btn ${deafened ? 'active' : ''}`}
          onClick={toggleDeafen}
        >
          {deafened ? '🔇' : '🔊'}
        </button>
        
        <button 
          className="control-btn leave-btn"
          onClick={handleLeave}
        >
          离开
        </button>
      </div>

      {volume > 0 && (
        <div className="volume-indicator">
          <div 
            className="volume-bar" 
            style={{ width: `${volume * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

export default VoiceRoom;
```

### 3. 数据库设计

```sql
-- database/pending/20260611_160000__add_voice_chat_tables.sql

-- 语音房间表
CREATE TABLE voice_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100),
  creator_id VARCHAR(50) NOT NULL,
  guild_id VARCHAR(50), -- 如果是公会房间
  max_members INTEGER DEFAULT 10,
  password_hash VARCHAR(255), -- 可选密码
  persistent BOOLEAN DEFAULT FALSE, -- 是否持久化
  config JSONB DEFAULT '{
    "bitrate": 64000,
    "codec": "opus",
    "noiseSuppression": true,
    "echoCancellation": true
  }'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  closed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_voice_rooms_creator ON voice_rooms(creator_id);
CREATE INDEX idx_voice_rooms_guild ON voice_rooms(guild_id);
CREATE INDEX idx_voice_rooms_active ON voice_rooms(closed_at) WHERE closed_at IS NULL;

-- 语音房间成员表
CREATE TABLE voice_room_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID REFERENCES voice_rooms(id) ON DELETE CASCADE,
  user_id VARCHAR(50) NOT NULL,
  role VARCHAR(20) DEFAULT 'member', -- host, admin, member
  socket_id VARCHAR(100),
  muted BOOLEAN DEFAULT FALSE,
  deafened BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  left_at TIMESTAMP WITH TIME ZONE,
  UNIQUE(room_id, user_id)
);

CREATE INDEX idx_voice_room_members_room ON voice_room_members(room_id);
CREATE INDEX idx_voice_room_members_user ON voice_room_members(user_id);

-- 语音聊天统计表
CREATE TABLE voice_chat_statistics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  room_id UUID REFERENCES voice_rooms(id),
  duration_seconds INTEGER, -- 通话时长
  bytes_sent BIGINT, -- 发送字节数
  bytes_received BIGINT, -- 接收字节数
  codec VARCHAR(20),
  average_bitrate INTEGER,
  packet_loss REAL, -- 丢包率
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  ended_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_voice_stats_user ON voice_chat_statistics(user_id);
CREATE INDEX idx_voice_stats_room ON voice_chat_statistics(room_id);

-- TURN 凭证表（用于记录和审计）
CREATE TABLE turn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(50) NOT NULL,
  username VARCHAR(100) NOT NULL,
  credential_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_turn_creds_user ON turn_credentials(user_id);
CREATE INDEX idx_turn_creds_expires ON turn_credentials(expires_at);

-- 评论
COMMENT ON TABLE voice_rooms IS '语音房间表';
COMMENT ON TABLE voice_room_members IS '语音房间成员表';
COMMENT ON TABLE voice_chat_statistics IS '语音聊天统计表';
COMMENT ON TABLE turn_credentials IS 'TURN服务器凭证表';
```

### 4. Prometheus 指标

```javascript
// backend/services/social-service/src/voiceMetrics.js

const client = require('prom-client');

const voiceMetrics = {
  // 活跃语音房间数
  activeVoiceRooms: new client.Gauge({
    name: 'voice_active_rooms',
    help: 'Number of active voice rooms',
    labelNames: ['type'] // temporary, persistent
  }),

  // 活跃语音用户数
  activeVoiceUsers: new client.Gauge({
    name: 'voice_active_users',
    help: 'Number of users in voice rooms'
  }),

  // 语音房间创建数
  roomsCreated: new client.Counter({
    name: 'voice_rooms_created_total',
    help: 'Total number of voice rooms created',
    labelNames: ['type']
  }),

  // 语音通话时长
  callDuration: new client.Histogram({
    name: 'voice_call_duration_seconds',
    help: 'Duration of voice calls in seconds',
    labelNames: ['room_type'],
    buckets: [60, 300, 600, 1800, 3600, 7200] // 1m, 5m, 10m, 30m, 1h, 2h
  }),

  // WebRTC 连接质量
  webrtcConnectionQuality: new client.Histogram({
    name: 'voice_webrtc_connection_quality',
    help: 'WebRTC connection quality score (0-100)',
    buckets: [20, 40, 60, 80, 100]
  }),

  // 丢包率
  packetLoss: new client.Histogram({
    name: 'voice_packet_loss_rate',
    help: 'Packet loss rate in voice calls',
    buckets: [0.01, 0.05, 0.1, 0.2, 0.5]
  }),

  // TURN 服务器使用量
  turnUsage: new client.Counter({
    name: 'voice_turn_usage_total',
    help: 'Total TURN server usage',
    labelNames: ['type'] // relay, direct
  }),

  // 信令消息数
  signalingMessages: new client.Counter({
    name: 'voice_signaling_messages_total',
    help: 'Total signaling messages',
    labelNames: ['type'] // offer, answer, ice-candidate
  })
};

module.exports = voiceMetrics;
```

### 5. K8s 部署配置

```yaml
# infrastructure/k8s/voice-service.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: voice-service
  namespace: minego
spec:
  replicas: 2
  selector:
    matchLabels:
      app: voice-service
  template:
    metadata:
      labels:
        app: voice-service
    spec:
      containers:
      - name: voice-service
        image: minego/voice-service:latest
        ports:
        - containerPort: 3000
          name: http
        - containerPort: 3478
          name: turn-udp
          protocol: UDP
        - containerPort: 3478
          name: turn-tcp
          protocol: TCP
        env:
        - name: NODE_ENV
          value: "production"
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: minego-secrets
              key: redis-url
        - name: TURN_SECRET
          valueFrom:
            secretKeyRef:
              name: minego-secrets
              key: turn-secret
        - name: TURN_HOST
          value: "turn.minego.com"
        - name: TURN_REALM
          value: "minego.com"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
---
apiVersion: v1
kind: Service
metadata:
  name: voice-service
  namespace: minego
spec:
  selector:
    app: voice-service
  ports:
  - name: http
    port: 80
    targetPort: 3000
  - name: turn-udp
    port: 3478
    targetPort: 3478
    protocol: UDP
  - name: turn-tcp
    port: 3478
    targetPort: 3478
    protocol: TCP
  type: LoadBalancer
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: voice-service-hpa
  namespace: minego
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: voice-service
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Pods
    pods:
      metric:
        name: voice_active_users
      target:
        type: AverageValue
        averageValue: 100
```

## 验收标准

- [ ] 用户可以创建临时和持久语音房间
- [ ] 语音房间支持密码保护
- [ ] 支持 2-50 人同时语音
- [ ] WebRTC P2P 连接成功率 > 95%
- [ ] TURN 服务器可用性 > 99.9%
- [ ] 语音延迟 < 150ms
- [ ] 支持静音和聋音功能
- [ ] 支持音量调节
- [ ] 支持降噪和回声消除
- [ ] 房主可以踢出成员
- [ ] 房主离开时自动转让权限
- [ ] 团队战斗自动创建语音房间
- [ ] 公会语音频道持久化
- [ ] 语音质量指标监控
- [ ] 单元测试覆盖率 > 80%
- [ ] 压力测试支持 1000 并发用户

## 影响范围

### 后端服务
- `backend/services/social-service/src/voice/` - 新增语音服务模块
- `backend/services/social-service/src/routes/voice.js` - 新增语音 API 路由
- `backend/services/gym-service/src/routes/battle.js` - 集成自动语音房间创建
- `backend/shared/voiceMetrics.js` - 新增语音指标

### 前端
- `frontend/game-client/src/voice/` - 新增语音客户端模块
- `frontend/game-client/src/components/VoiceRoom.js` - 新增语音房间组件
- `frontend/game-client/src/components/BattleScene.js` - 集成语音按钮

### 数据库
- `database/pending/20260611_160000__add_voice_chat_tables.sql` - 新增 4 张表

### 基础设施
- `infrastructure/k8s/voice-service.yaml` - 新增语音服务部署配置
- TURN 服务器部署和配置

## 参考

- [WebRTC API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)
- [coturn - TURN Server](https://github.com/coturn/coturn)
- [Discord Voice Architecture](https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users)
- [Opus Codec](https://opus-codec.org/)
