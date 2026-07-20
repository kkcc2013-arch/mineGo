// backend/services/social-service/src/routes/voice.js
// REQ-00116: 语音聊天 API 路由

'use strict';

const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const authMiddleware = require('../../../../shared/middleware/auth');
const { getVoiceRoomManager } = require('../voice/roomManager');
const { getTURNServerManager } = require('../voice/turnServer');

/**
 * 创建语音房间
 * POST /api/voice/rooms
 */
router.post('/rooms',
  authMiddleware,
  [
    body('name').optional().isString().trim().isLength({ max: 100 }),
    body('roomType').optional().isIn(['temporary', 'guild', 'battle', 'friend']),
    body('maxMembers').optional().isInt({ min: 2, max: 50 }),
    body('password').optional().isString().isLength({ min: 4, max: 32 }),
    body('guildId').optional().isString(),
    body('persistent').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { name, roomType, maxMembers, password, guildId, persistent } = req.body;
    const userId = req.user.id;

    try {
      const roomManager = getVoiceRoomManager();
      const room = await roomManager.createRoom({
        name: name || `Voice Room ${Date.now()}`,
        creatorId: userId,
        roomType: roomType || 'temporary',
        maxMembers: maxMembers || 10,
        password,
        guildId,
        persistent
      });

      res.json({
        success: true,
        data: room
      });
    } catch (error) {
      console.error('Failed to create voice room:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to create room'
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
  [param('roomId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { roomId } = req.params;

    try {
      const roomManager = getVoiceRoomManager();
      const room = await roomManager.getRoom(roomId);

      if (!room) {
        return res.status(404).json({
          success: false,
          error: 'Room not found'
        });
      }

      res.json({
        success: true,
        data: room
      });
    } catch (error) {
      console.error('Failed to get voice room:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get room'
      });
    }
  }
);

/**
 * 加入语音房间
 * POST /api/voice/rooms/:roomId/join
 */
router.post('/rooms/:roomId/join',
  authMiddleware,
  [
    param('roomId').isUUID(),
    body('password').optional().isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { roomId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;

    try {
      const roomManager = getVoiceRoomManager();
      const turnManager = getTURNServerManager();
      
      const result = await roomManager.joinRoom(roomId, userId, password);

      if (!result.success) {
        return res.status(400).json({
          success: false,
          error: result.error
        });
      }

      // 生成 TURN 凭证
      const turnCredentials = await turnManager.generateCredentials(userId);

      res.json({
        success: true,
        data: {
          roomId,
          role: result.role,
          turnCredentials
        }
      });
    } catch (error) {
      console.error('Failed to join voice room:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to join room'
      });
    }
  }
);

/**
 * 离开语音房间
 * POST /api/voice/rooms/:roomId/leave
 */
router.post('/rooms/:roomId/leave',
  authMiddleware,
  [param('roomId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { roomId } = req.params;
    const userId = req.user.id;

    try {
      const roomManager = getVoiceRoomManager();
      const result = await roomManager.leaveRoom(roomId, userId);

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      console.error('Failed to leave voice room:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to leave room'
      });
    }
  }
);

/**
 * 踢出房间成员
 * POST /api/voice/rooms/:roomId/kick
 */
router.post('/rooms/:roomId/kick',
  authMiddleware,
  [
    param('roomId').isUUID(),
    body('targetUserId').isString().notEmpty(),
    body('reason').optional().isString()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { roomId } = req.params;
    const { targetUserId, reason } = req.body;
    const userId = req.user.id;

    try {
      const roomManager = getVoiceRoomManager();
      const result = await roomManager.kickMember(roomId, userId, targetUserId, reason);

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
    } catch (error) {
      console.error('Failed to kick member:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to kick member'
      });
    }
  }
);

/**
 * 设置房间密码
 * POST /api/voice/rooms/:roomId/password
 */
router.post('/rooms/:roomId/password',
  authMiddleware,
  [
    param('roomId').isUUID(),
    body('password').optional().isString().isLength({ min: 4, max: 32 })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { roomId } = req.params;
    const { password } = req.body;
    const userId = req.user.id;

    try {
      const roomManager = getVoiceRoomManager();
      const result = await roomManager.setRoomPassword(roomId, userId, password);

      if (!result.success) {
        return res.status(403).json({
          success: false,
          error: result.error
        });
      }

      res.json({
        success: true,
        message: 'Password updated'
      });
    } catch (error) {
      console.error('Failed to set room password:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to set password'
      });
    }
  }
);

/**
 * 更新房间配置
 * PATCH /api/voice/rooms/:roomId/config
 */
router.patch('/rooms/:roomId/config',
  authMiddleware,
  [
    param('roomId').isUUID(),
    body('bitrate').optional().isInt({ min: 6000, max: 510000 }),
    body('noiseSuppression').optional().isBoolean(),
    body('echoCancellation').optional().isBoolean(),
    body('autoGainControl').optional().isBoolean()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { roomId } = req.params;
    const userId = req.user.id;

    try {
      const roomManager = getVoiceRoomManager();
      const result = await roomManager.updateConfig(roomId, userId, req.body);

      if (!result.success) {
        return res.status(403).json({
          success: false,
          error: result.error
        });
      }

      res.json({
        success: true,
        data: result.config
      });
    } catch (error) {
      console.error('Failed to update room config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to update config'
      });
    }
  }
);

/**
 * 获取 TURN 服务器凭证
 * GET /api/voice/turn-credentials
 */
router.get('/turn-credentials',
  authMiddleware,
  async (req, res) => {
    try {
      const turnManager = getTURNServerManager();
      const credentials = await turnManager.generateCredentials(req.user.id);
      
      res.json({
        success: true,
        data: credentials
      });
    } catch (error) {
      console.error('Failed to get TURN credentials:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get credentials'
      });
    }
  }
);

/**
 * 获取用户当前语音房间
 * GET /api/voice/current-room
 */
router.get('/current-room',
  authMiddleware,
  async (req, res) => {
    try {
      const roomManager = getVoiceRoomManager();
      const room = await roomManager.getUserCurrentRoom(req.user.id);

      res.json({
        success: true,
        data: room || null
      });
    } catch (error) {
      console.error('Failed to get current room:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get current room'
      });
    }
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
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('roomType').optional().isIn(['temporary', 'guild', 'battle'])
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { page = 1, limit = 20 } = req.query;

    try {
      const roomManager = getVoiceRoomManager();
      const rooms = await roomManager.getPublicRooms(parseInt(page), parseInt(limit));

      res.json({
        success: true,
        data: rooms
      });
    } catch (error) {
      console.error('Failed to get public rooms:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get public rooms'
      });
    }
  }
);

/**
 * 获取房间成员列表
 * GET /api/voice/rooms/:roomId/members
 */
router.get('/rooms/:roomId/members',
  authMiddleware,
  [param('roomId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { roomId } = req.params;

    try {
      const roomManager = getVoiceRoomManager();
      const members = await roomManager.getRoomMembers(roomId);

      res.json({
        success: true,
        data: members
      });
    } catch (error) {
      console.error('Failed to get room members:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to get members'
      });
    }
  }
);

/**
 * TURN 服务器健康检查
 * GET /api/voice/turn-health
 */
router.get('/turn-health',
  authMiddleware,
  async (req, res) => {
    try {
      const turnManager = getTURNServerManager();
      const health = await turnManager.healthCheck();

      res.json({
        success: true,
        data: health
      });
    } catch (error) {
      console.error('TURN health check failed:', error);
      res.status(500).json({
        success: false,
        error: 'Health check failed'
      });
    }
  }
);

module.exports = router;