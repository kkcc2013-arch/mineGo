/**
 * Voice Routes - 语音聊天 API 路由
 * 提供语音房间管理、TURN 凭证等 API
 */

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const logger = require('../../../shared/logger');
const authMiddleware = require('../../../shared/middleware/auth');
const VoiceSignalingServer = require('./signalingServer');
const TURNServerManager = require('./turnServer');
const voiceMetrics = require('./voiceMetrics');

// 单例实例（由服务初始化时注入）
let signalingServer = null;
let turnServer = null;

/**
 * 设置实例（由服务启动时调用）
 */
function setInstances(signaling, turn) {
  signalingServer = signaling;
  turnServer = turn;
}

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
    body('persistent').optional().isBoolean(),
    body('guildId').optional().isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { name, maxMembers = 10, password, persistent = false, guildId } = req.body;
    const userId = req.user.id;

    try {
      const roomId = `voice-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      
      const room = await signalingServer.createRoom(roomId, userId, {
        name: name || `Voice Room`,
        maxMembers,
        password,
        persistent,
        guildId
      });

      logger.info('Voice room created via API', { roomId, userId });

      res.json({
        success: true,
        data: {
          roomId: room.id,
          name: room.name || name,
          creatorId: room.creatorId,
          maxMembers: room.maxMembers,
          hasPassword: !!password,
          persistent: room.persistent,
          createdAt: room.createdAt
        }
      });
    } catch (error) {
      logger.error('Failed to create voice room', { error: error.message, userId });
      res.status(500).json({
        success: false,
        error: 'Failed to create voice room'
      });
    }
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { roomId } = req.params;
    const room = signalingServer?.getRoom(roomId);

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
        creatorId: room.creatorId,
        memberCount: room.members.size,
        maxMembers: room.maxMembers,
        hasPassword: !!room.password,
        persistent: room.persistent,
        createdAt: room.createdAt,
        config: room.config
      }
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
    const room = signalingServer?.getUserRoom(userId);

    if (!room) {
      return res.json({
        success: true,
        data: null
      });
    }

    const member = Array.from(room.members.values())
      .find(m => m.userId === userId);

    res.json({
      success: true,
      data: {
        id: room.id,
        creatorId: room.creatorId,
        memberCount: room.members.size,
        maxMembers: room.maxMembers,
        role: member?.role || 'member',
        muted: member?.muted || false,
        deafened: member?.deafened || false,
        members: Array.from(room.members.values()).map(m => ({
          userId: m.userId,
          role: m.role,
          muted: m.muted,
          deafened: m.deafened
        }))
      }
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
    if (!turnServer) {
      return res.status(503).json({
        success: false,
        error: 'TURN server not configured'
      });
    }

    const userId = req.user.id;
    const credentials = turnServer.generateCredentials(userId);

    voiceMetrics.turnUsage.inc({ type: 'direct' });

    res.json({
      success: true,
      data: credentials
    });
  }
);

/**
 * 获取 ICE 服务器配置
 * GET /api/voice/ice-servers
 */
router.get('/ice-servers',
  authMiddleware,
  async (req, res) => {
    if (!turnServer) {
      return res.status(503).json({
        success: false,
        error: 'TURN server not configured'
      });
    }

    const userId = req.user.id;
    const config = turnServer.getICEServerConfig(userId);

    res.json({
      success: true,
      data: config
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { page = 1, limit = 20 } = req.query;
    
    // 获取所有活跃房间
    const rooms = Array.from(signalingServer?.rooms?.values() || [])
      .filter(room => room.members.size > 0 && !room.password) // 无密码的公共房间
      .map(room => ({
        id: room.id,
        creatorId: room.creatorId,
        memberCount: room.members.size,
        maxMembers: room.maxMembers,
        persistent: room.persistent,
        createdAt: room.createdAt
      }))
      .sort((a, b) => b.memberCount - a.memberCount) // 按人数排序
      .slice((page - 1) * limit, page * limit);

    res.json({
      success: true,
      data: {
        rooms,
        page,
        limit,
        total: rooms.length
      }
    });
  }
);

/**
 * 获取语音系统统计
 * GET /api/voice/stats
 */
router.get('/stats',
  authMiddleware,
  async (req, res) => {
    const rooms = Array.from(signalingServer?.rooms?.values() || []);
    
    let totalUsers = 0;
    let temporaryRooms = 0;
    let persistentRooms = 0;

    for (const room of rooms) {
      totalUsers += room.members.size;
      if (room.persistent) {
        persistentRooms++;
      } else {
        temporaryRooms++;
      }
    }

    res.json({
      success: true,
      data: {
        activeRooms: rooms.length,
        activeUsers: totalUsers,
        temporaryRooms,
        persistentRooms,
        turnServer: turnServer?.getStatus()
      }
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { roomId } = req.params;
    const userId = req.user.id;
    const room = signalingServer?.getRoom(roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // 检查权限（只有房主可以修改配置）
    if (room.creatorId !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only room host can modify config'
      });
    }

    const { bitrate, noiseSuppression, echoCancellation } = req.body;

    if (bitrate) room.config.bitrate = bitrate;
    if (noiseSuppression !== undefined) room.config.noiseSuppression = noiseSuppression;
    if (echoCancellation !== undefined) room.config.echoCancellation = echoCancellation;

    // 广播配置更新
    signalingServer?.broadcastToRoom(roomId, {
      type: 'config-updated',
      payload: { config: room.config }
    });

    res.json({
      success: true,
      data: { config: room.config }
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
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { roomId } = req.params;
    const { targetUserId, reason } = req.body;
    const userId = req.user.id;
    const room = signalingServer?.getRoom(roomId);

    if (!room) {
      return res.status(404).json({
        success: false,
        error: 'Room not found'
      });
    }

    // 检查权限
    if (room.creatorId !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only room host can kick members'
      });
    }

    // 找到目标成员
    const targetMember = Array.from(room.members.entries())
      .find(([socketId, member]) => member.userId === targetUserId);

    if (!targetMember) {
      return res.status(404).json({
        success: false,
        error: 'Target user not in room'
      });
    }

    const [targetSocketId] = targetMember;

    // 通知被踢出的用户
    const conn = signalingServer?.connections?.get(targetSocketId);
    if (conn?.ws) {
      conn.ws.send(JSON.stringify({
        type: 'kicked',
        payload: { reason: reason || 'Kicked by host' }
      }));
    }

    // 强制离开房间
    await signalingServer?.handleLeaveRoom(conn?.ws);

    logger.info('User kicked from voice room', { 
      roomId, 
      targetUserId, 
      byUserId: userId,
      reason 
    });

    res.json({
      success: true,
      message: 'Member kicked successfully'
    });
  }
);

/**
 * 健康检查
 * GET /api/voice/health
 */
router.get('/health', async (req, res) => {
  const status = {
    signaling: signalingServer?.wss ? 'healthy' : 'unhealthy',
    turn: turnServer ? 'healthy' : 'unhealthy',
    activeRooms: signalingServer?.rooms?.size || 0,
    activeConnections: signalingServer?.connections?.size || 0
  };

  const healthy = status.signaling === 'healthy';

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: status
  });
});

module.exports = { router, setInstances };
