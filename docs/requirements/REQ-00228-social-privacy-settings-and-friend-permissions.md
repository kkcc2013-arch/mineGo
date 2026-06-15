# REQ-00228: 游戏社交隐私设置与好友权限管理系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00228 |
| 标题 | 游戏社交隐私设置与好友权限管理系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、user-service、gateway、game-client、database/migrations |
| 创建时间 | 2026-06-15 19:00 |

## 需求描述

### 背景
当前社交系统缺乏细粒度的隐私控制，玩家无法精确控制谁能看到自己的在线状态、精灵信息、位置等敏感数据。好友权限过于简单，无法实现分层信任管理。需要构建完整的隐私设置系统，让玩家能够精确控制自己的社交数据可见性和好友权限。

### 目标
1. 实现多层次隐私设置系统（公开/好友/私密/自定义分组）
2. 构建好友权限分级管理（普通好友/密友/家人）
3. 提供细粒度数据可见性控制（在线状态、精灵信息、位置、战绩）
4. 支持好友申请审批流程与黑名单管理
5. 实现隐私设置实时生效与跨设备同步

## 技术方案

### 1. 数据库 Schema 设计

```sql
-- 隐私设置表
CREATE TABLE privacy_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- 整体可见性级别
  profile_visibility VARCHAR(20) DEFAULT 'public', -- public/friends/private/custom
  online_status_visibility VARCHAR(20) DEFAULT 'friends',
  location_visibility VARCHAR(20) DEFAULT 'close_friends',
  
  -- 精灵信息可见性
  pokemon_collection_visibility VARCHAR(20) DEFAULT 'friends',
  pokemon_stats_visibility VARCHAR(20) DEFAULT 'friends',
  pokemon_shinies_visibility VARCHAR(20) DEFAULT 'close_friends',
  
  -- 社交数据可见性
  friend_list_visibility VARCHAR(20) DEFAULT 'friends',
  battle_history_visibility VARCHAR(20) DEFAULT 'friends',
  achievements_visibility VARCHAR(20) DEFAULT 'public',
  
  -- 其他设置
  allow_friend_requests BOOLEAN DEFAULT true,
  allow_trade_requests BOOLEAN DEFAULT true,
  allow_battle_requests BOOLEAN DEFAULT true,
  allow_location_sharing BOOLEAN DEFAULT false,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(user_id)
);

-- 好友分组表
CREATE TABLE friend_groups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  permission_level VARCHAR(20) NOT NULL, -- regular/close_friends/family
  color VARCHAR(7) DEFAULT '#4CAF50',
  icon VARCHAR(50),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(user_id, name)
);

-- 好友关系扩展表
CREATE TABLE friend_permissions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- 好友分组
  group_id INTEGER REFERENCES friend_groups(id) ON DELETE SET NULL,
  permission_level VARCHAR(20) DEFAULT 'regular',
  
  -- 自定义权限覆盖
  can_see_online_status BOOLEAN DEFAULT true,
  can_see_location BOOLEAN DEFAULT false,
  can_see_pokemon_collection BOOLEAN DEFAULT true,
  can_see_battle_history BOOLEAN DEFAULT true,
  can_send_trade_requests BOOLEAN DEFAULT true,
  can_send_battle_requests BOOLEAN DEFAULT true,
  can_invite_to_gym BOOLEAN DEFAULT true,
  
  -- 备注与标签
  nickname VARCHAR(50),
  notes TEXT,
  tags TEXT[],
  
  -- 互动统计
  interaction_count INTEGER DEFAULT 0,
  last_interaction_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(user_id, friend_id)
);

-- 黑名单表
CREATE TABLE blocked_users (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(200),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(user_id, blocked_user_id),
  CHECK (user_id != blocked_user_id)
);

-- 好友申请表
CREATE TABLE friend_requests (
  id SERIAL PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- pending/accepted/rejected/ignored/expired
  expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
  
  -- 审批信息
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  UNIQUE(from_user_id, to_user_id)
);

-- 索引
CREATE INDEX idx_privacy_settings_user ON privacy_settings(user_id);
CREATE INDEX idx_friend_permissions_user ON friend_permissions(user_id);
CREATE INDEX idx_friend_permissions_friend ON friend_permissions(friend_id);
CREATE INDEX idx_friend_permissions_group ON friend_permissions(group_id);
CREATE INDEX idx_blocked_users_user ON blocked_users(user_id);
CREATE INDEX idx_blocked_users_blocked ON blocked_users(blocked_user_id);
CREATE INDEX idx_friend_requests_to ON friend_requests(to_user_id, status);
CREATE INDEX idx_friend_requests_from ON friend_requests(from_user_id, status);
```

### 2. PrivacyService - 隐私设置服务

```javascript
// backend/services/social-service/src/services/PrivacyService.js

const { db } = require('../../../shared/db');
const { cache } = require('../../../shared/cache');
const { logger } = require('../../../shared/logger');
const { EventBus } = require('../../../shared/EventBus');

class PrivacyService {
  constructor() {
    this.CACHE_TTL = 300; // 5分钟缓存
    this.VISIBILITY_LEVELS = {
      public: 0,
      friends: 1,
      close_friends: 2,
      private: 3
    };
    
    // 默认隐私设置
    this.DEFAULT_PRIVACY = {
      profile_visibility: 'public',
      online_status_visibility: 'friends',
      location_visibility: 'close_friends',
      pokemon_collection_visibility: 'friends',
      pokemon_stats_visibility: 'friends',
      pokemon_shinies_visibility: 'close_friends',
      friend_list_visibility: 'friends',
      battle_history_visibility: 'friends',
      achievements_visibility: 'public',
      allow_friend_requests: true,
      allow_trade_requests: true,
      allow_battle_requests: true,
      allow_location_sharing: false
    };
  }

  /**
   * 获取用户隐私设置
   */
  async getPrivacySettings(userId) {
    const cacheKey = `privacy:${userId}`;
    
    const cached = await cache.get(cacheKey);
    if (cached) return cached;
    
    const result = await db.query(
      `SELECT * FROM privacy_settings WHERE user_id = $1`,
      [userId]
    );
    
    const settings = result.rows[0] || 
      { ...this.DEFAULT_PRIVACY, user_id: userId };
    
    await cache.set(cacheKey, settings, this.CACHE_TTL);
    return settings;
  }

  /**
   * 更新隐私设置
   */
  async updatePrivacySettings(userId, updates) {
    const allowedFields = [
      'profile_visibility', 'online_status_visibility', 'location_visibility',
      'pokemon_collection_visibility', 'pokemon_stats_visibility', 'pokemon_shinies_visibility',
      'friend_list_visibility', 'battle_history_visibility', 'achievements_visibility',
      'allow_friend_requests', 'allow_trade_requests', 'allow_battle_requests', 'allow_location_sharing'
    ];
    
    const setClauses = [];
    const values = [userId];
    let paramIndex = 2;
    
    for (const [field, value] of Object.entries(updates)) {
      if (!allowedFields.includes(field)) continue;
      
      setClauses.push(`${field} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
    
    if (setClauses.length === 0) {
      throw new Error('No valid fields to update');
    }
    
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    
    const query = `
      INSERT INTO privacy_settings (user_id, ${Object.keys(updates).filter(k => allowedFields.includes(k)).join(', ')})
      VALUES ($1, ${values.slice(2).map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id) DO UPDATE SET ${setClauses.join(', ')}
      RETURNING *
    `;
    
    const result = await db.query(query, values);
    const settings = result.rows[0];
    
    // 清除缓存
    await cache.del(`privacy:${userId}`);
    
    // 发布事件
    EventBus.emit('privacy.settings.updated', {
      userId,
      updates,
      timestamp: new Date()
    });
    
    logger.info('Privacy settings updated', { userId, updates });
    return settings;
  }

  /**
   * 检查数据可见性
   */
  async checkVisibility(viewerId, targetId, dataType) {
    // 查看者就是目标用户自己，始终可见
    if (viewerId === targetId) return true;
    
    const targetSettings = await this.getPrivacySettings(targetId);
    const visibilityField = this.getVisibilityField(dataType);
    const visibility = targetSettings[visibilityField];
    
    switch (visibility) {
      case 'public':
        return true;
        
      case 'private':
        return false;
        
      case 'friends':
        return await this.areFriends(viewerId, targetId);
        
      case 'close_friends':
        return await this.isCloseFriend(viewerId, targetId);
        
      default:
        return false;
    }
  }

  /**
   * 批量检查可见性
   */
  async batchCheckVisibility(viewerId, targetIds, dataType) {
    const results = {};
    
    // 获取所有目标用户的设置
    const settingsResult = await db.query(
      `SELECT user_id, ${this.getVisibilityField(dataType)} as visibility 
       FROM privacy_settings 
       WHERE user_id = ANY($1)`,
      [targetIds]
    );
    
    const settingsMap = new Map(
      settingsResult.rows.map(r => [r.user_id, r.visibility])
    );
    
    // 获取好友关系
    const friendsResult = await db.query(
      `SELECT friend_id, permission_level 
       FROM friend_permissions 
       WHERE user_id = $1 AND friend_id = ANY($2)`,
      [viewerId, targetIds]
    );
    
    const friendsMap = new Map(
      friendsResult.rows.map(r => [r.friend_id, r.permission_level])
    );
    
    for (const targetId of targetIds) {
      const visibility = settingsMap.get(targetId) || 'public';
      const friendLevel = friendsMap.get(targetId);
      
      switch (visibility) {
        case 'public':
          results[targetId] = true;
          break;
        case 'private':
          results[targetId] = false;
          break;
        case 'friends':
          results[targetId] = !!friendLevel;
          break;
        case 'close_friends':
          results[targetId] = friendLevel === 'close_friends' || friendLevel === 'family';
          break;
        default:
          results[targetId] = false;
      }
    }
    
    return results;
  }

  /**
   * 创建好友分组
   */
  async createFriendGroup(userId, name, permissionLevel, options = {}) {
    const result = await db.query(
      `INSERT INTO friend_groups (user_id, name, permission_level, color, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, name, permissionLevel, options.color, options.icon, options.sortOrder || 0]
    );
    
    const group = result.rows[0];
    
    EventBus.emit('friend.group.created', { userId, group });
    
    return group;
  }

  /**
   * 更新好友权限
   */
  async updateFriendPermission(userId, friendId, updates) {
    const allowedFields = [
      'group_id', 'permission_level', 'can_see_online_status',
      'can_see_location', 'can_see_pokemon_collection', 'can_see_battle_history',
      'can_send_trade_requests', 'can_send_battle_requests', 'can_invite_to_gym',
      'nickname', 'notes', 'tags'
    ];
    
    const setClauses = [];
    const values = [userId, friendId];
    let paramIndex = 3;
    
    for (const [field, value] of Object.entries(updates)) {
      if (!allowedFields.includes(field)) continue;
      
      setClauses.push(`${field} = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
    
    if (setClauses.length === 0) {
      return await this.getFriendPermission(userId, friendId);
    }
    
    setClauses.push('updated_at = CURRENT_TIMESTAMP');
    
    const query = `
      INSERT INTO friend_permissions (user_id, friend_id, ${Object.keys(updates).filter(k => allowedFields.includes(k)).join(', ')})
      VALUES ($1, $2, ${values.slice(3).map((_, i) => `$${i + 3}`).join(', ')})
      ON CONFLICT (user_id, friend_id) DO UPDATE SET ${setClauses.join(', ')}
      RETURNING *
    `;
    
    const result = await db.query(query, values);
    
    // 清除相关缓存
    await cache.del(`privacy:friend:${userId}:${friendId}`);
    
    return result.rows[0];
  }

  /**
   * 添加到黑名单
   */
  async blockUser(userId, blockedUserId, reason = null) {
    // 检查是否已存在
    const existing = await db.query(
      `SELECT id FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2`,
      [userId, blockedUserId]
    );
    
    if (existing.rows.length > 0) {
      throw new Error('User already blocked');
    }
    
    // 添加到黑名单
    await db.query(
      `INSERT INTO blocked_users (user_id, blocked_user_id, reason)
       VALUES ($1, $2, $3)`,
      [userId, blockedUserId, reason]
    );
    
    // 删除好友关系（如果存在）
    await db.query(
      `DELETE FROM friend_permissions 
       WHERE (user_id = $1 AND friend_id = $2) 
          OR (user_id = $2 AND friend_id = $1)`,
      [userId, blockedUserId]
    );
    
    // 删除待处理的好友申请
    await db.query(
      `DELETE FROM friend_requests 
       WHERE (from_user_id = $1 AND to_user_id = $2) 
          OR (from_user_id = $2 AND to_user_id = $1)`,
      [userId, blockedUserId]
    );
    
    // 清除缓存
    await cache.del(`privacy:blocked:${userId}`);
    await cache.del(`privacy:friends:${userId}`);
    
    EventBus.emit('user.blocked', { userId, blockedUserId, reason });
    
    logger.info('User blocked', { userId, blockedUserId, reason });
  }

  /**
   * 移出黑名单
   */
  async unblockUser(userId, blockedUserId) {
    await db.query(
      `DELETE FROM blocked_users WHERE user_id = $1 AND blocked_user_id = $2`,
      [userId, blockedUserId]
    );
    
    await cache.del(`privacy:blocked:${userId}`);
    
    EventBus.emit('user.unblocked', { userId, blockedUserId });
  }

  /**
   * 检查是否被屏蔽
   */
  async isBlocked(userId, targetUserId) {
    const cacheKey = `privacy:blocked:${userId}`;
    
    let blockedList = await cache.get(cacheKey);
    if (!blockedList) {
      const result = await db.query(
        `SELECT blocked_user_id FROM blocked_users WHERE user_id = $1`,
        [userId]
      );
      blockedList = new Set(result.rows.map(r => r.blocked_user_id));
      await cache.set(cacheKey, blockedList, this.CACHE_TTL);
    }
    
    return blockedList.has(targetUserId);
  }

  /**
   * 发送好友申请
   */
  async sendFriendRequest(fromUserId, toUserId, message = null) {
    // 检查目标用户是否允许好友申请
    const targetSettings = await this.getPrivacySettings(toUserId);
    if (!targetSettings.allow_friend_requests) {
      throw new Error('Target user does not accept friend requests');
    }
    
    // 检查是否被屏蔽
    if (await this.isBlocked(toUserId, fromUserId)) {
      throw new Error('Cannot send friend request to this user');
    }
    
    // 检查是否已是好友
    if (await this.areFriends(fromUserId, toUserId)) {
      throw new Error('Already friends');
    }
    
    // 检查是否有待处理的申请
    const existing = await db.query(
      `SELECT id, status FROM friend_requests 
       WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [fromUserId, toUserId]
    );
    
    if (existing.rows.length > 0) {
      throw new Error('Friend request already pending');
    }
    
    // 创建申请
    const result = await db.query(
      `INSERT INTO friend_requests (from_user_id, to_user_id, message, expires_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '7 days')
       RETURNING *`,
      [fromUserId, toUserId, message]
    );
    
    const request = result.rows[0];
    
    EventBus.emit('friend.request.sent', {
      requestId: request.id,
      fromUserId,
      toUserId,
      message
    });
    
    return request;
  }

  /**
   * 处理好友申请
   */
  async handleFriendRequest(requestId, action, reviewerNotes = null) {
    const requestResult = await db.query(
      `SELECT * FROM friend_requests WHERE id = $1 FOR UPDATE`,
      [requestId]
    );
    
    if (requestResult.rows.length === 0) {
      throw new Error('Friend request not found');
    }
    
    const request = requestResult.rows[0];
    
    if (request.status !== 'pending') {
      throw new Error(`Request already ${request.status}`);
    }
    
    const validActions = ['accept', 'reject', 'ignore'];
    if (!validActions.includes(action)) {
      throw new Error('Invalid action');
    }
    
    const statusMap = {
      accept: 'accepted',
      reject: 'rejected',
      ignore: 'ignored'
    };
    
    await db.query('BEGIN');
    
    try {
      // 更新申请状态
      await db.query(
        `UPDATE friend_requests 
         SET status = $1, reviewed_at = CURRENT_TIMESTAMP, review_notes = $2
         WHERE id = $3`,
        [statusMap[action], reviewerNotes, requestId]
      );
      
      // 如果接受，创建好友关系
      if (action === 'accept') {
        await this.createFriendRelationship(request.from_user_id, request.to_user_id);
      }
      
      await db.query('COMMIT');
      
      EventBus.emit(`friend.request.${action}`, {
        requestId,
        fromUserId: request.from_user_id,
        toUserId: request.to_user_id
      });
      
      return { success: true, action };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * 创建好友关系
   */
  async createFriendRelationship(userId1, userId2) {
    // 双向创建好友关系
    await db.query(
      `INSERT INTO friend_permissions (user_id, friend_id, permission_level)
       VALUES ($1, $2, 'regular'), ($2, $1, 'regular')
       ON CONFLICT DO NOTHING`,
      [userId1, userId2]
    );
    
    // 更新互动统计
    await db.query(
      `UPDATE friend_permissions 
       SET interaction_count = interaction_count + 1, last_interaction_at = CURRENT_TIMESTAMP
       WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
      [userId1, userId2]
    );
    
    EventBus.emit('friend.added', { userId: userId1, friendId: userId2 });
  }

  /**
   * 删除好友
   */
  async removeFriend(userId, friendId) {
    await db.query(
      `DELETE FROM friend_permissions 
       WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
      [userId, friendId]
    );
    
    await cache.del(`privacy:friends:${userId}`);
    await cache.del(`privacy:friends:${friendId}`);
    
    EventBus.emit('friend.removed', { userId, friendId });
  }

  // 辅助方法
  getVisibilityField(dataType) {
    const mapping = {
      'profile': 'profile_visibility',
      'online_status': 'online_status_visibility',
      'location': 'location_visibility',
      'pokemon_collection': 'pokemon_collection_visibility',
      'pokemon_stats': 'pokemon_stats_visibility',
      'pokemon_shinies': 'pokemon_shinies_visibility',
      'friend_list': 'friend_list_visibility',
      'battle_history': 'battle_history_visibility',
      'achievements': 'achievements_visibility'
    };
    return mapping[dataType] || 'profile_visibility';
  }

  async areFriends(userId1, userId2) {
    const result = await db.query(
      `SELECT 1 FROM friend_permissions WHERE user_id = $1 AND friend_id = $2`,
      [userId1, userId2]
    );
    return result.rows.length > 0;
  }

  async isCloseFriend(userId1, userId2) {
    const result = await db.query(
      `SELECT 1 FROM friend_permissions 
       WHERE user_id = $1 AND friend_id = $2 
       AND permission_level IN ('close_friends', 'family')`,
      [userId1, userId2]
    );
    return result.rows.length > 0;
  }

  async getFriendPermission(userId, friendId) {
    const result = await db.query(
      `SELECT * FROM friend_permissions WHERE user_id = $1 AND friend_id = $2`,
      [userId, friendId]
    );
    return result.rows[0];
  }
}

module.exports = { PrivacyService };
```

### 3. API 路由设计

```javascript
// backend/services/social-service/src/routes/privacy.js

const express = require('express');
const router = express.Router();
const { PrivacyService } = require('../services/PrivacyService');
const { auth } = require('../../../shared/middleware/auth');
const { validateRequest } = require('../../../shared/middleware/validation');
const { rateLimiter } = require('../../../shared/middleware/rateLimiter');

const privacyService = new PrivacyService();

// 获取隐私设置
router.get('/settings', auth, async (req, res) => {
  try {
    const settings = await privacyService.getPrivacySettings(req.user.id);
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新隐私设置
router.patch('/settings', 
  auth,
  rateLimiter({ windowMs: 60000, max: 10 }),
  validateRequest({
    body: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile_visibility: { enum: ['public', 'friends', 'close_friends', 'private'] },
        online_status_visibility: { enum: ['public', 'friends', 'close_friends', 'private'] },
        location_visibility: { enum: ['public', 'friends', 'close_friends', 'private'] },
        pokemon_collection_visibility: { enum: ['public', 'friends', 'close_friends', 'private'] },
        friend_list_visibility: { enum: ['public', 'friends', 'close_friends', 'private'] },
        allow_friend_requests: { type: 'boolean' },
        allow_trade_requests: { type: 'boolean' },
        allow_battle_requests: { type: 'boolean' }
      }
    }
  }),
  async (req, res) => {
    try {
      const settings = await privacyService.updatePrivacySettings(
        req.user.id,
        req.body
      );
      res.json({ success: true, data: settings });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 检查可见性
router.get('/check/:targetId/:dataType', auth, async (req, res) => {
  try {
    const { targetId, dataType } = req.params;
    const canView = await privacyService.checkVisibility(
      req.user.id,
      parseInt(targetId),
      dataType
    );
    res.json({ success: true, canView });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 好友分组管理
router.post('/groups', 
  auth,
  validateRequest({
    body: {
      type: 'object',
      required: ['name', 'permission_level'],
      properties: {
        name: { type: 'string', maxLength: 50 },
        permission_level: { enum: ['regular', 'close_friends', 'family'] },
        color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
        icon: { type: 'string' }
      }
    }
  }),
  async (req, res) => {
    try {
      const group = await privacyService.createFriendGroup(
        req.user.id,
        req.body.name,
        req.body.permission_level,
        req.body
      );
      res.status(201).json({ success: true, data: group });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 更新好友权限
router.patch('/friends/:friendId/permissions',
  auth,
  async (req, res) => {
    try {
      const permission = await privacyService.updateFriendPermission(
        req.user.id,
        parseInt(req.params.friendId),
        req.body
      );
      res.json({ success: true, data: permission });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 黑名单管理
router.post('/block/:userId',
  auth,
  rateLimiter({ windowMs: 3600000, max: 20 }),
  async (req, res) => {
    try {
      await privacyService.blockUser(
        req.user.id,
        parseInt(req.params.userId),
        req.body.reason
      );
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

router.delete('/block/:userId', auth, async (req, res) => {
  try {
    await privacyService.unblockUser(
      req.user.id,
      parseInt(req.params.userId)
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 好友申请
router.post('/friend-requests',
  auth,
  rateLimiter({ windowMs: 3600000, max: 30 }),
  validateRequest({
    body: {
      type: 'object',
      required: ['to_user_id'],
      properties: {
        to_user_id: { type: 'integer' },
        message: { type: 'string', maxLength: 200 }
      }
    }
  }),
  async (req, res) => {
    try {
      const request = await privacyService.sendFriendRequest(
        req.user.id,
        req.body.to_user_id,
        req.body.message
      );
      res.status(201).json({ success: true, data: request });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 处理好友申请
router.post('/friend-requests/:requestId/:action',
  auth,
  async (req, res) => {
    try {
      const result = await privacyService.handleFriendRequest(
        parseInt(req.params.requestId),
        req.params.action
      );
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
);

// 删除好友
router.delete('/friends/:friendId', auth, async (req, res) => {
  try {
    await privacyService.removeFriend(
      req.user.id,
      parseInt(req.params.friendId)
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

### 4. 前端隐私设置组件

```javascript
// frontend/game-client/src/components/PrivacySettings.js

import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import './PrivacySettings.css';

const VISIBILITY_OPTIONS = [
  { value: 'public', label: '所有人可见', icon: '🌍' },
  { value: 'friends', label: '仅好友可见', icon: '👥' },
  { value: 'close_friends', label: '仅密友可见', icon: '💚' },
  { value: 'private', label: '仅自己可见', icon: '🔒' }
];

const PRIVACY_CATEGORIES = [
  {
    key: 'profile_visibility',
    label: '个人资料',
    description: '谁可以查看您的个人资料',
    icon: '👤'
  },
  {
    key: 'online_status_visibility',
    label: '在线状态',
    description: '谁可以看到您的在线状态',
    icon: '🟢'
  },
  {
    key: 'location_visibility',
    label: '位置信息',
    description: '谁可以看到您的位置',
    icon: '📍'
  },
  {
    key: 'pokemon_collection_visibility',
    label: '精灵收藏',
    description: '谁可以查看您的精灵收藏',
    icon: '🎒'
  },
  {
    key: 'friend_list_visibility',
    label: '好友列表',
    description: '谁可以查看您的好友列表',
    icon: '👥'
  },
  {
    key: 'battle_history_visibility',
    label: '对战记录',
    description: '谁可以查看您的对战记录',
    icon: '⚔️'
  }
];

export function PrivacySettings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('visibility');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await api.get('/social/privacy/settings');
      setSettings(response.data);
    } catch (error) {
      console.error('Failed to load privacy settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const updateSetting = async (key, value) => {
    setSaving(true);
    try {
      const response = await api.patch('/social/privacy/settings', {
        [key]: value
      });
      setSettings(response.data);
    } catch (error) {
      console.error('Failed to update setting:', error);
    } finally {
      setSaving(false);
    }
  };

  const toggleBoolean = async (key) => {
    const newValue = !settings[key];
    await updateSetting(key, newValue);
  };

  if (loading) {
    return <div className="privacy-settings-loading">加载中...</div>;
  }

  return (
    <div className="privacy-settings">
      <h2>🔒 隐私设置</h2>
      
      <div className="privacy-tabs">
        <button 
          className={`tab ${activeTab === 'visibility' ? 'active' : ''}`}
          onClick={() => setActiveTab('visibility')}
        >
          可见性设置
        </button>
        <button 
          className={`tab ${activeTab === 'requests' ? 'active' : ''}`}
          onClick={() => setActiveTab('requests')}
        >
          请求权限
        </button>
      </div>

      {activeTab === 'visibility' && (
        <div className="visibility-settings">
          {PRIVACY_CATEGORIES.map(category => (
            <div key={category.key} className="privacy-category">
              <div className="category-header">
                <span className="category-icon">{category.icon}</span>
                <div className="category-info">
                  <h3>{category.label}</h3>
                  <p>{category.description}</p>
                </div>
              </div>
              
              <div className="visibility-options">
                {VISIBILITY_OPTIONS.map(option => (
                  <button
                    key={option.value}
                    className={`visibility-option ${
                      settings[category.key] === option.value ? 'selected' : ''
                    }`}
                    onClick={() => updateSetting(category.key, option.value)}
                    disabled={saving}
                  >
                    <span className="option-icon">{option.icon}</span>
                    <span className="option-label">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'requests' && (
        <div className="request-settings">
          <div className="request-item">
            <div className="request-info">
              <h3>👥 好友申请</h3>
              <p>允许其他玩家向您发送好友申请</p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.allow_friend_requests}
                onChange={() => toggleBoolean('allow_friend_requests')}
                disabled={saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="request-item">
            <div className="request-info">
              <h3>🔄 交易请求</h3>
              <p>允许好友向您发送精灵交易请求</p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.allow_trade_requests}
                onChange={() => toggleBoolean('allow_trade_requests')}
                disabled={saving}
              />
              <label className="toggle-slider"></label>
            </label>
          </div>

          <div className="request-item">
            <div className="request-info">
              <h3>⚔️ 对战邀请</h3>
              <p>允许好友向您发送对战邀请</p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.allow_battle_requests}
                onChange={() => toggleBoolean('allow_battle_requests')}
                disabled={saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="request-item">
            <div className="request-info">
              <h3>📍 位置分享</h3>
              <p>允许好友查看您的实时位置</p>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.allow_location_sharing}
                onChange={() => toggleBoolean('allow_location_sharing')}
                disabled={saving}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 5. 性能优化与缓存策略

```javascript
// 隐私检查中间件 - 在 Gateway 层进行快速过滤
class PrivacyMiddleware {
  constructor() {
    this.privacyService = new PrivacyService();
  }

  async checkProfileVisibility(req, res, next) {
    const viewerId = req.user?.id;
    const targetId = parseInt(req.params.userId);
    
    if (!viewerId || viewerId === targetId) {
      return next();
    }
    
    const canView = await this.privacyService.checkVisibility(
      viewerId,
      targetId,
      'profile'
    );
    
    if (!canView) {
      return res.status(403).json({
        error: 'PROFILE_HIDDEN',
        message: 'This profile is private'
      });
    }
    
    next();
  }
}
```

## 验收标准

- [ ] 用户可以设置 6 种数据类型的可见性（公开/好友/密友/私密）
- [ ] 好友分组功能可用，支持自定义分组名称、颜色、图标
- [ ] 好友权限分级管理功能正常（普通好友/密友/家人）
- [ ] 黑名单功能正常，屏蔽用户后自动解除好友关系
- [ ] 好友申请流程完整（发送/接受/拒绝/忽略）
- [ ] 隐私设置实时生效，无需刷新页面
- [ ] 批量可见性检查接口响应时间 < 100ms（100 个目标用户）
- [ ] 前端隐私设置界面直观易用
- [ ] 所有 API 接口有完整的单元测试覆盖
- [ ] 敏感操作有审计日志记录

## 影响范围

- **新增文件**：
  - `backend/services/social-service/src/services/PrivacyService.js`
  - `backend/services/social-service/src/routes/privacy.js`
  - `frontend/game-client/src/components/PrivacySettings.js`
  - `frontend/game-client/src/components/PrivacySettings.css`

- **数据库迁移**：
  - 新增 `privacy_settings` 表
  - 新增 `friend_groups` 表
  - 新增 `friend_permissions` 表
  - 新增 `blocked_users` 表
  - 新增 `friend_requests` 表

- **修改服务**：
  - `social-service`：新增隐私管理模块
  - `gateway`：新增隐私检查中间件
  - `user-service`：获取用户信息时增加隐私过滤

## 参考

- [GDPR 数据最小化原则](https://gdpr.eu/article-5-principles/)
- [社交平台隐私设计最佳实践](https://www.nngroup.com/articles/privacy-design-patterns/)
- [微信好友权限系统设计](https://www.uxdesign.cc/privacy-design-patterns)