// backend/services/social-service/src/voice/roomManager.js
// REQ-00116: 语音房间管理器

'use strict';

const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../../../shared/logger');
const { getPool } = require('../../../shared/db');
const bcrypt = require('bcrypt');

const logger = createLogger('voice-room');

/**
 * 语音房间管理器
 * 处理房间的创建、查询、配置等操作
 */
class VoiceRoomManager {
  constructor() {
    this.defaultConfig = {
      bitrate: 64000,
      codec: 'opus',
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true
    };
  }

  /**
   * 创建语音房间
   */
  async createRoom(options) {
    const {
      name,
      creatorId,
      roomType = 'temporary',
      guildId = null,
      maxMembers = 10,
      password = null,
      persistent = false
    } = options;

    const pool = getPool();
    const roomId = uuidv4();

    // 如果有密码，进行哈希
    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    // 确定房间持久化状态
    const isPersistent = persistent || roomType === 'guild';

    // 创建房间
    const result = await pool.query(
      `INSERT INTO voice_rooms (
        id, name, creator_id, guild_id, room_type, 
        max_members, password_hash, persistent, config
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        roomId,
        name || `Voice Room ${roomId.slice(0, 8)}`,
        creatorId,
        guildId,
        roomType,
        maxMembers,
        passwordHash,
        isPersistent,
        this.defaultConfig
      ]
    );

    const room = result.rows[0];

    logger.info('Voice room created', {
      roomId,
      roomType,
      creatorId,
      maxMembers,
      hasPassword: !!passwordHash
    });

    return {
      id: room.id,
      name: room.name,
      creatorId: room.creator_id,
      roomType: room.room_type,
      maxMembers: room.max_members,
      hasPassword: !!passwordHash,
      persistent: room.persistent,
      createdAt: room.created_at
    };
  }

  /**
   * 获取房间信息
   */
  async getRoom(roomId) {
    const pool = getPool();

    const result = await pool.query(
      `SELECT r.*, 
        COUNT(m.id) as member_count
       FROM voice_rooms r
       LEFT JOIN voice_room_members m ON r.id = m.room_id AND m.left_at IS NULL
       WHERE r.id = $1 AND r.status = 'active'
       GROUP BY r.id`,
      [roomId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const room = result.rows[0];

    return {
      id: room.id,
      name: room.name,
      creatorId: room.creator_id,
      guildId: room.guild_id,
      roomType: room.room_type,
      memberCount: parseInt(room.member_count) || 0,
      maxMembers: room.max_members,
      hasPassword: !!room.password_hash,
      persistent: room.persistent,
      config: room.config,
      createdAt: room.created_at
    };
  }

  /**
   * 加入房间
   */
  async joinRoom(roomId, userId, password = null) {
    const pool = getPool();

    // 获取房间
    const roomResult = await pool.query(
      'SELECT * FROM voice_rooms WHERE id = $1 AND status = $2',
      [roomId, 'active']
    );

    if (roomResult.rows.length === 0) {
      return { success: false, error: 'Room not found' };
    }

    const room = roomResult.rows[0];

    // 验证密码
    if (room.password_hash) {
      if (!password) {
        return { success: false, error: 'Password required' };
      }
      
      const validPassword = await bcrypt.compare(password, room.password_hash);
      if (!validPassword) {
        return { success: false, error: 'Invalid password' };
      }
    }

    // 检查容量
    const memberCountResult = await pool.query(
      'SELECT COUNT(*) FROM voice_room_members WHERE room_id = $1 AND left_at IS NULL',
      [roomId]
    );

    const currentMembers = parseInt(memberCountResult.rows[0].count);
    if (currentMembers >= room.max_members) {
      return { success: false, error: 'Room is full' };
    }

    // 确定角色
    let role = 'member';
    if (currentMembers === 0) {
      role = 'host';
    }

    // 检查用户是否已在房间中
    const existingMember = await pool.query(
      'SELECT * FROM voice_room_members WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL',
      [roomId, userId]
    );

    if (existingMember.rows.length > 0) {
      // 用户已在房间中，返回当前角色
      return { 
        success: true, 
        role: existingMember.rows[0].role,
        message: 'Already in room'
      };
    }

    // 添加成员
    await pool.query(
      `INSERT INTO voice_room_members (room_id, user_id, role)
       VALUES ($1, $2, $3)`,
      [roomId, userId, role]
    );

    // 更新房间统计
    await pool.query(
      `UPDATE voice_rooms 
       SET total_joins = total_joins + 1,
           peak_members = GREATEST(peak_members, $1)
       WHERE id = $2`,
      [currentMembers + 1, roomId]
    );

    logger.info('User joined voice room', { userId, roomId, role });

    return { 
      success: true, 
      role,
      roomId
    };
  }

  /**
   * 离开房间
   */
  async leaveRoom(roomId, userId) {
    const pool = getPool();

    // 更新成员状态
    const result = await pool.query(
      `UPDATE voice_room_members 
       SET left_at = NOW()
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL
       RETURNING role`,
      [roomId, userId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'Not in room' };
    }

    const leftMember = result.rows[0];

    // 如果房主离开，转让房主
    if (leftMember.role === 'host') {
      // 获取下一个成员
      const nextMember = await pool.query(
        `SELECT user_id FROM voice_room_members 
         WHERE room_id = $1 AND left_at IS NULL
         ORDER BY joined_at ASC
         LIMIT 1`,
        [roomId]
      );

      if (nextMember.rows.length > 0) {
        const newHostId = nextMember.rows[0].user_id;
        
        await pool.query(
          `UPDATE voice_room_members SET role = 'host' 
           WHERE room_id = $1 AND user_id = $2`,
          [roomId, newHostId]
        );

        await pool.query(
          'UPDATE voice_rooms SET creator_id = $1 WHERE id = $2',
          [newHostId, roomId]
        );

        logger.info('Host transferred', { roomId, newHostId });
      }
    }

    // 检查房间是否需要关闭
    const remainingMembers = await pool.query(
      'SELECT COUNT(*) FROM voice_room_members WHERE room_id = $1 AND left_at IS NULL',
      [roomId]
    );

    const count = parseInt(remainingMembers.rows[0].count);
    
    // 如果是临时房间且没有成员，关闭房间
    const roomInfo = await pool.query(
      'SELECT room_type FROM voice_rooms WHERE id = $1',
      [roomId]
    );

    if (count === 0 && roomInfo.rows[0]?.room_type === 'temporary') {
      await pool.query(
        'UPDATE voice_rooms SET status = $1, closed_at = NOW() WHERE id = $2',
        ['closed', roomId]
      );

      logger.info('Temporary room closed', { roomId });
    }

    return { success: true };
  }

  /**
   * 踢出成员
   */
  async kickMember(roomId, requesterId, targetUserId, reason = '') {
    const pool = getPool();

    // 检查请求者权限
    const requesterResult = await pool.query(
      `SELECT role FROM voice_room_members 
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, requesterId]
    );

    if (requesterResult.rows.length === 0) {
      return { success: false, error: 'Not in room' };
    }

    const requesterRole = requesterResult.rows[0].role;
    if (requesterRole !== 'host' && requesterRole !== 'admin') {
      return { success: false, error: 'No permission to kick' };
    }

    // 获取目标成员
    const targetResult = await pool.query(
      `SELECT role FROM voice_room_members 
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, targetUserId]
    );

    if (targetResult.rows.length === 0) {
      return { success: false, error: 'Target not in room' };
    }

    const targetRole = targetResult.rows[0].role;

    // 不能踢出房主或同级管理员
    if (targetRole === 'host') {
      return { success: false, error: 'Cannot kick host' };
    }
    if (targetRole === 'admin' && requesterRole === 'admin') {
      return { success: false, error: 'Cannot kick another admin' };
    }

    // 踢出成员
    await this.leaveRoom(roomId, targetUserId);

    logger.info('User kicked from voice room', {
      roomId,
      kickedBy: requesterId,
      targetUserId,
      reason
    });

    return { success: true };
  }

  /**
   * 更新房间配置
   */
  async updateConfig(roomId, userId, config) {
    const pool = getPool();

    // 检查权限
    const memberResult = await pool.query(
      `SELECT role FROM voice_room_members 
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId]
    );

    if (memberResult.rows.length === 0) {
      return { success: false, error: 'Not in room' };
    }

    const role = memberResult.rows[0].role;
    if (role !== 'host' && role !== 'admin') {
      return { success: false, error: 'No permission to update config' };
    }

    // 构建更新配置
    const currentConfigResult = await pool.query(
      'SELECT config FROM voice_rooms WHERE id = $1',
      [roomId]
    );

    const currentConfig = currentConfigResult.rows[0]?.config || {};
    const newConfig = { ...currentConfig };

    if (config.bitrate !== undefined) {
      newConfig.bitrate = Math.min(510000, Math.max(6000, config.bitrate));
    }
    if (config.noiseSuppression !== undefined) {
      newConfig.noiseSuppression = config.noiseSuppression;
    }
    if (config.echoCancellation !== undefined) {
      newConfig.echoCancellation = config.echoCancellation;
    }
    if (config.autoGainControl !== undefined) {
      newConfig.autoGainControl = config.autoGainControl;
    }

    // 更新配置
    await pool.query(
      'UPDATE voice_rooms SET config = $1 WHERE id = $2',
      [newConfig, roomId]
    );

    logger.info('Room config updated', { roomId, userId, newConfig });

    return { success: true, config: newConfig };
  }

  /**
   * 获取用户的当前房间
   */
  async getUserCurrentRoom(userId) {
    const pool = getPool();

    const result = await pool.query(
      `SELECT r.*, m.role, m.joined_at
       FROM voice_room_members m
       JOIN voice_rooms r ON m.room_id = r.id
       WHERE m.user_id = $1 AND m.left_at IS NULL AND r.status = 'active'`,
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const room = result.rows[0];
    return {
      id: room.id,
      name: room.name,
      roomType: room.room_type,
      role: room.role,
      joinedAt: room.joined_at
    };
  }

  /**
   * 获取公共房间列表
   */
  async getPublicRooms(page = 1, limit = 20) {
    const pool = getPool();

    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT r.id, r.name, r.room_type, r.creator_id, r.max_members,
        COUNT(m.id) as member_count,
        r.created_at
       FROM voice_rooms r
       LEFT JOIN voice_room_members m ON r.id = m.room_id AND m.left_at IS NULL
       WHERE r.status = 'active' AND r.password_hash IS NULL
       GROUP BY r.id
       ORDER BY member_count DESC, r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    return result.rows.map(room => ({
      id: room.id,
      name: room.name,
      roomType: room.room_type,
      creatorId: room.creator_id,
      memberCount: parseInt(room.member_count) || 0,
      maxMembers: room.max_members,
      createdAt: room.created_at
    }));
  }

  /**
   * 获取房间成员列表
   */
  async getRoomMembers(roomId) {
    const pool = getPool();

    const result = await pool.query(
      `SELECT user_id, role, muted, deafened, joined_at
       FROM voice_room_members
       WHERE room_id = $1 AND left_at IS NULL
       ORDER BY joined_at ASC`,
      [roomId]
    );

    return result.rows;
  }

  /**
   * 设置房间密码
   */
  async setRoomPassword(roomId, userId, password) {
    const pool = getPool();

    // 检查权限
    const memberResult = await pool.query(
      `SELECT role FROM voice_room_members 
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId]
    );

    if (memberResult.rows.length === 0 || memberResult.rows[0].role !== 'host') {
      return { success: false, error: 'Only host can set password' };
    }

    let passwordHash = null;
    if (password) {
      passwordHash = await bcrypt.hash(password, 10);
    }

    await pool.query(
      'UPDATE voice_rooms SET password_hash = $1 WHERE id = $2',
      [passwordHash, roomId]
    );

    logger.info('Room password updated', { roomId, userId, hasPassword: !!passwordHash });

    return { success: true };
  }

  /**
   * 自动创建战斗语音房间
   */
  async createBattleVoiceRoom(battleId, battleType = 'raid') {
    const pool = getPool();

    // 获取战斗参与者
    const battleResult = await pool.query(
      'SELECT * FROM battle_sessions WHERE id = $1',
      [battleId]
    );

    if (battleResult.rows.length === 0) {
      return null;
    }

    const battle = battleResult.rows[0];

    // 创建房间
    const room = await this.createRoom({
      name: `${battleType} Battle - ${battleId.slice(0, 8)}`,
      creatorId: battle.initiator_id,
      roomType: 'battle',
      maxMembers: battle.max_participants || 50,
      password: null,
      persistent: false
    });

    // 关联到战斗
    await pool.query(
      'UPDATE voice_rooms SET related_entity_id = $1, related_entity_type = $2 WHERE id = $3',
      [battleId, 'battle', room.id]
    );

    return room;
  }
}

// 单例模式
let roomManagerInstance = null;

function getVoiceRoomManager() {
  if (!roomManagerInstance) {
    roomManagerInstance = new VoiceRoomManager();
  }
  return roomManagerInstance;
}

module.exports = {
  VoiceRoomManager,
  getVoiceRoomManager
};