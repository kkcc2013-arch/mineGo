# REQ-00048: 精灵好友系统与社交互动增强

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00048 |
| 标题 | 精灵好友系统与社交互动增强 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | social-service、user-service、gateway、game-client、pokemon-service、reward-service |
| 创建时间 | 2026-06-09 10:00 |

## 需求描述

mineGo 作为一个基于位置的游戏，社交互动是提升用户粘性和留存率的关键因素。当前系统已支持精灵交易（REQ-00018），但缺少完整的社交好友系统，导致玩家之间难以建立长期社交关系。

本需求实现完整的精灵好友系统，包括：
- 好友关系管理（添加、删除、好友列表）
- 好友互动功能（赠送道具、赠送精灵糖果、友情点）
- 好友在线状态与实时互动
- 好友排行榜系统
- 好友活动日志与互动记录

**核心价值：**
- 提升用户留存率 40%+
- 增强社交互动，建立玩家社区
- 促进道具流通，活跃游戏经济

## 技术方案

### 1. 数据库设计

```sql
-- 好友关系表
CREATE TABLE friends (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    friend_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, accepted, blocked
    friendship_level INTEGER DEFAULT 1, -- 友情等级 1-5
    friendship_points INTEGER DEFAULT 0, -- 友情点数
    last_interaction_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, friend_user_id)
);

-- 好友请求表
CREATE TABLE friend_requests (
    id SERIAL PRIMARY KEY,
    from_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    to_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    message TEXT,
    status VARCHAR(20) DEFAULT 'pending', -- pending, accepted, rejected, expired
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 days'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(from_user_id, to_user_id)
);

-- 好友互动记录表
CREATE TABLE friend_interactions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    friend_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    interaction_type VARCHAR(50) NOT NULL, -- gift_item, gift_candy, raid_together, battle_together, trade
    metadata JSONB, -- 互动详情
    friendship_points_earned INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_friend_time (user_id, friend_user_id, created_at DESC)
);

-- 好友礼物表
CREATE TABLE friend_gifts (
    id SERIAL PRIMARY KEY,
    from_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    to_user_id VARCHAR(36) NOT NULL REFERENCES users(id),
    gift_type VARCHAR(50) NOT NULL, -- item, candy, stardust
    gift_id VARCHAR(36), -- 道具ID或精灵ID
    quantity INTEGER DEFAULT 1,
    status VARCHAR(20) DEFAULT 'pending', -- pending, claimed, expired
    expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
    claimed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_to_user_status (to_user_id, status)
);

-- 好友排行榜表（物化视图）
CREATE MATERIALIZED VIEW friend_leaderboard AS
SELECT 
    u.id AS user_id,
    u.username,
    u.avatar_url,
    u.level,
    COUNT(DISTINCT f.friend_user_id) AS friend_count,
    SUM(f.friendship_points) AS total_friendship_points,
    MAX(f.last_interaction_at) AS last_active,
    CURRENT_TIMESTAMP AS updated_at
FROM users u
LEFT JOIN friends f ON (f.user_id = u.id OR f.friend_user_id = u.id) AND f.status = 'accepted'
GROUP BY u.id, u.username, u.avatar_url, u.level;

CREATE UNIQUE INDEX idx_leaderboard_user ON friend_leaderboard(user_id);
CREATE INDEX idx_leaderboard_points ON friend_leaderboard(total_friendship_points DESC);

-- 刷新策略：每小时全量刷新，实时性要求不高
```

### 2. 后端服务实现

#### social-service 好友服务核心模块

```javascript
// backend/services/social-service/src/friendService.js

const { db } = require('../../../shared/db');
const { EventBus, EVENTS } = require('../../../shared/EventBus');
const { metrics, startTimer } = require('../../../shared/metrics');
const redis = require('../../../shared/redis');

class FriendService {
  constructor() {
    this.maxFriends = 400; // 最大好友数量
    this.maxPendingRequests = 50; // 最大待处理请求
    this.maxDailyGifts = 50; // 每日最大礼物数
    this.friendshipLevelThresholds = [0, 100, 500, 1000, 2000, 5000];
  }

  /**
   * 发送好友请求
   */
  async sendFriendRequest(fromUserId, toUserId, message = '') {
    const timer = startTimer('friend_request_duration_seconds');
    
    try {
      // 验证用户存在
      const [fromUser, toUser] = await Promise.all([
        db('users').where({ id: fromUserId }).first(),
        db('users').where({ id: toUserId }).first()
      ]);
      
      if (!fromUser || !toUser) {
        throw new Error('USER_NOT_FOUND');
      }
      
      // 检查是否已是好友
      const existingFriendship = await db('friends')
        .where(function() {
          this.where({ user_id: fromUserId, friend_user_id: toUserId })
            .orWhere({ user_id: toUserId, friend_user_id: fromUserId });
        })
        .whereIn('status', ['accepted', 'pending'])
        .first();
      
      if (existingFriendship) {
        throw new Error('ALREADY_FRIENDS');
      }
      
      // 检查接收方好友数量
      const toUserFriendCount = await this.getFriendCount(toUserId);
      if (toUserFriendCount >= this.maxFriends) {
        throw new Error('FRIEND_LIMIT_REACHED');
      }
      
      // 检查发送方待处理请求数
      const pendingCount = await db('friend_requests')
        .where({ from_user_id: fromUserId, status: 'pending' })
        .count('* as count')
        .first();
      
      if (pendingCount.count >= this.maxPendingRequests) {
        throw new Error('PENDING_REQUEST_LIMIT');
      }
      
      // 创建好友请求
      const [request] = await db('friend_requests')
        .insert({
          from_user_id: fromUserId,
          to_user_id: toUserId,
          message,
          status: 'pending'
        })
        .returning('*');
      
      // 发布事件
      await EventBus.publish(EVENTS.FRIEND_REQUEST_SENT, {
        requestId: request.id,
        fromUserId,
        toUserId,
        timestamp: new Date().toISOString()
      });
      
      metrics.increment('friend_requests_sent', 1);
      timer();
      
      return request;
    } catch (error) {
      timer({ error: true });
      throw error;
    }
  }

  /**
   * 接受好友请求
   */
  async acceptFriendRequest(userId, requestId) {
    const trx = await db.transaction();
    
    try {
      // 获取请求
      const request = await trx('friend_requests')
        .where({ id: requestId, to_user_id: userId, status: 'pending' })
        .first();
      
      if (!request) {
        throw new Error('REQUEST_NOT_FOUND');
      }
      
      // 更新请求状态
      await trx('friend_requests')
        .where({ id: requestId })
        .update({ status: 'accepted' });
      
      // 创建双向好友关系
      await trx('friends').insert([
        {
          user_id: request.from_user_id,
          friend_user_id: request.to_user_id,
          status: 'accepted',
          friendship_level: 1,
          friendship_points: 0
        },
        {
          user_id: request.to_user_id,
          friend_user_id: request.from_user_id,
          status: 'accepted',
          friendship_level: 1,
          friendship_points: 0
        }
      ]);
      
      await trx.commit();
      
      // 发布事件
      await EventBus.publish(EVENTS.FRIEND_REQUEST_ACCEPTED, {
        requestId,
        fromUserId: request.from_user_id,
        toUserId: request.to_user_id,
        timestamp: new Date().toISOString()
      });
      
      // 发送通知给双方
      await this.sendFriendNotification(request.from_user_id, 'friend_accepted', {
        friendId: userId
      });
      
      metrics.increment('friends_added', 1);
      
      return { success: true, friendshipLevel: 1 };
    } catch (error) {
      await trx.rollback();
      throw error;
    }
  }

  /**
   * 获取好友列表
   */
  async getFriendList(userId, options = {}) {
    const { page = 1, limit = 50, sortBy = 'last_interaction' } = options;
    const offset = (page - 1) * limit;
    
    let query = db('friends as f')
      .join('users as u', 'f.friend_user_id', 'u.id')
      .where('f.user_id', userId)
      .where('f.status', 'accepted')
      .select(
        'u.id',
        'u.username',
        'u.avatar_url',
        'u.level',
        'f.friendship_level',
        'f.friendship_points',
        'f.last_interaction_at',
        // 检查在线状态
        db.raw(`
          CASE 
            WHEN u.last_active_at > NOW() - INTERVAL '5 minutes' THEN 'online'
            WHEN u.last_active_at > NOW() - INTERVAL '1 hour' THEN 'away'
            ELSE 'offline'
          END as online_status
        `)
      );
    
    // 排序
    if (sortBy === 'last_interaction') {
      query.orderBy('f.last_interaction_at', 'desc');
    } else if (sortBy === 'friendship_level') {
      query.orderBy('f.friendship_level', 'desc');
    } else if (sortBy === 'name') {
      query.orderBy('u.username', 'asc');
    }
    
    const friends = await query.limit(limit).offset(offset);
    const total = await db('friends')
      .where({ user_id: userId, status: 'accepted' })
      .count('* as count')
      .first();
    
    return {
      friends,
      pagination: {
        page,
        limit,
        total: total.count,
        totalPages: Math.ceil(total.count / limit)
      }
    };
  }

  /**
   * 赠送礼物给好友
   */
  async sendGift(fromUserId, toUserId, giftData) {
    const { giftType, giftId, quantity = 1 } = giftData;
    
    // 验证好友关系
    const friendship = await db('friends')
      .where({ user_id: fromUserId, friend_user_id: toUserId, status: 'accepted' })
      .first();
    
    if (!friendship) {
      throw new Error('NOT_FRIENDS');
    }
    
    // 检查每日礼物限制
    const todayGifts = await this.getTodayGiftCount(fromUserId);
    if (todayGifts >= this.maxDailyGifts) {
      throw new Error('DAILY_GIFT_LIMIT');
    }
    
    // 根据礼物类型验证库存
    if (giftType === 'item') {
      const inventory = await db('user_inventory')
        .where({ user_id: fromUserId, item_id: giftId })
        .first();
      if (!inventory || inventory.quantity < quantity) {
        throw new Error('INSUFFICIENT_ITEM');
      }
      // 扣减库存
      await db('user_inventory')
        .where({ user_id: fromUserId, item_id: giftId })
        .decrement('quantity', quantity);
    } else if (giftType === 'candy') {
      // 精灵糖果赠送逻辑
      const candy = await db('pokemon_candies')
        .where({ user_id: fromUserId, pokemon_species_id: giftId })
        .first();
      if (!candy || candy.quantity < quantity) {
        throw new Error('INSUFFICIENT_CANDY');
      }
      await db('pokemon_candies')
        .where({ user_id: fromUserId, pokemon_species_id: giftId })
        .decrement('quantity', quantity);
    }
    
    // 创建礼物记录
    const [gift] = await db('friend_gifts').insert({
      from_user_id: fromUserId,
      to_user_id: toUserId,
      gift_type: giftType,
      gift_id: giftId,
      quantity,
      status: 'pending'
    }).returning('*');
    
    // 发送通知
    await this.sendFriendNotification(toUserId, 'gift_received', {
      giftId: gift.id,
      fromUserId,
      giftType
    });
    
    metrics.increment('gifts_sent', 1);
    
    return gift;
  }

  /**
   * 领取好友礼物
   */
  async claimGift(userId, giftId) {
    const trx = await db.transaction();
    
    try {
      const gift = await trx('friend_gifts')
        .where({ id: giftId, to_user_id: userId, status: 'pending' })
        .first();
      
      if (!gift) {
        throw new Error('GIFT_NOT_FOUND');
      }
      
      // 添加到用户背包
      if (gift.gift_type === 'item') {
        await trx('user_inventory')
          .insert({
            user_id: userId,
            item_id: gift.gift_id,
            quantity: gift.quantity
          })
          .onConflict(['user_id', 'item_id'])
          .merge({ quantity: db.raw('user_inventory.quantity + ?', [gift.quantity]) });
      } else if (gift.gift_type === 'candy') {
        await trx('pokemon_candies')
          .insert({
            user_id: userId,
            pokemon_species_id: gift.gift_id,
            quantity: gift.quantity
          })
          .onConflict(['user_id', 'pokemon_species_id'])
          .merge({ quantity: db.raw('pokemon_candies.quantity + ?', [gift.quantity]) });
      }
      
      // 更新礼物状态
      await trx('friend_gifts')
        .where({ id: giftId })
        .update({ status: 'claimed', claimed_at: new Date() });
      
      // 增加友情点数
      const pointsEarned = this.calculateFriendshipPoints('gift_received', gift);
      await this.addFriendshipPoints(gift.from_user_id, userId, pointsEarned);
      
      await trx.commit();
      
      metrics.increment('gifts_claimed', 1);
      
      return { success: true, pointsEarned };
    } catch (error) {
      await trx.rollback();
      throw error;
    }
  }

  /**
   * 添加友情点数
   */
  async addFriendshipPoints(userId, friendId, points) {
    await db('friends')
      .where(function() {
        this.where({ user_id: userId, friend_user_id: friendId })
          .orWhere({ user_id: friendId, friend_user_id: userId });
      })
      .where('status', 'accepted')
      .increment('friendship_points', points)
      .update({ last_interaction_at: new Date() });
    
    // 检查是否升级
    await this.checkFriendshipLevelUp(userId, friendId);
    
    // 记录互动
    await db('friend_interactions').insert({
      user_id: userId,
      friend_user_id: friendId,
      interaction_type: 'friendship_points',
      friendship_points_earned: points
    });
  }

  /**
   * 检查友情等级提升
   */
  async checkFriendshipLevelUp(userId, friendId) {
    const friendships = await db('friends')
      .where(function() {
        this.where({ user_id: userId, friend_user_id: friendId })
          .orWhere({ user_id: friendId, friend_user_id: userId });
      })
      .where('status', 'accepted');
    
    for (const friendship of friendships) {
      const newLevel = this.calculateFriendshipLevel(friendship.friendship_points);
      if (newLevel > friendship.friendship_level) {
        await db('friends')
          .where({ id: friendship.id })
          .update({ friendship_level: newLevel });
        
        // 发布升级事件
        await EventBus.publish(EVENTS.FRIENDSHIP_LEVEL_UP, {
          userId: friendship.user_id,
          friendId: friendship.friend_user_id,
          newLevel
        });
      }
    }
  }

  /**
   * 计算友情等级
   */
  calculateFriendshipLevel(points) {
    for (let i = this.friendshipLevelThresholds.length - 1; i >= 0; i--) {
      if (points >= this.friendshipLevelThresholds[i]) {
        return i + 1;
      }
    }
    return 1;
  }

  /**
   * 计算友情点数
   */
  calculateFriendshipPoints(interactionType, metadata = {}) {
    const pointMap = {
      'gift_received': 10,
      'raid_together': 50,
      'battle_together': 30,
      'trade': 100,
      'exchange_gift': 20
    };
    return pointMap[interactionType] || 0;
  }

  /**
   * 获取好友排行榜
   */
  async getFriendLeaderboard(userId, type = 'friendship', limit = 10) {
    const cacheKey = `friend_leaderboard:${userId}:${type}`;
    const cached = await redis.get(cacheKey);
    
    if (cached) {
      return JSON.parse(cached);
    }
    
    let query = db('friends as f')
      .join('users as u', 'f.friend_user_id', 'u.id')
      .where('f.user_id', userId)
      .where('f.status', 'accepted');
    
    if (type === 'friendship') {
      query = query
        .select('u.id', 'u.username', 'u.avatar_url', 'f.friendship_level', 'f.friendship_points')
        .orderBy('f.friendship_points', 'desc');
    } else if (type === 'level') {
      query = query
        .select('u.id', 'u.username', 'u.avatar_url', 'u.level')
        .orderBy('u.level', 'desc');
    }
    
    const leaderboard = await query.limit(limit);
    
    // 缓存5分钟
    await redis.setex(cacheKey, 300, JSON.stringify(leaderboard));
    
    return leaderboard;
  }

  /**
   * 搜索用户添加好友
   */
  async searchUsers(userId, query, limit = 20) {
    return db('users')
      .where('id', '!=', userId)
      .where('username', 'ilike', `%${query}%`)
      .select('id', 'username', 'avatar_url', 'level')
      .limit(limit);
  }

  /**
   * 通过好友码添加好友
   */
  async addFriendByCode(userId, friendCode) {
    const targetUser = await db('users')
      .where({ friend_code: friendCode.toUpperCase() })
      .first();
    
    if (!targetUser) {
      throw new Error('INVALID_FRIEND_CODE');
    }
    
    return this.sendFriendRequest(userId, targetUser.id, '通过好友码添加');
  }

  /**
   * 获取待处理的好友请求
   */
  async getPendingRequests(userId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    
    const requests = await db('friend_requests as fr')
      .join('users as u', 'fr.from_user_id', 'u.id')
      .where('fr.to_user_id', userId)
      .where('fr.status', 'pending')
      .where('fr.expires_at', '>', new Date())
      .select(
        'fr.id',
        'fr.message',
        'fr.created_at',
        'u.id as from_user_id',
        'u.username',
        'u.avatar_url',
        'u.level'
      )
      .orderBy('fr.created_at', 'desc')
      .limit(limit)
      .offset(offset);
    
    return requests;
  }

  /**
   * 发送好友通知
   */
  async sendFriendNotification(userId, type, data) {
    // 通过WebSocket发送实时通知
    await EventBus.publish(EVENTS.NOTIFICATION_SEND, {
      userId,
      type: `friend_${type}`,
      data,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 获取今日礼物数量
   */
  async getTodayGiftCount(userId) {
    const result = await db('friend_gifts')
      .where('from_user_id', userId)
      .where('created_at', '>=', db.raw('CURRENT_DATE'))
      .count('* as count')
      .first();
    return result.count;
  }

  /**
   * 获取好友数量
   */
  async getFriendCount(userId) {
    const result = await db('friends')
      .where({ user_id: userId, status: 'accepted' })
      .count('* as count')
      .first();
    return result.count;
  }

  /**
   * 删除好友
   */
  async removeFriend(userId, friendId) {
    const trx = await db.transaction();
    
    try {
      // 删除双向好友关系
      await trx('friends')
        .where(function() {
          this.where({ user_id: userId, friend_user_id: friendId })
            .orWhere({ user_id: friendId, friend_user_id: userId });
        })
        .del();
      
      await trx.commit();
      
      metrics.increment('friends_removed', 1);
      
      return { success: true };
    } catch (error) {
      await trx.rollback();
      throw error;
    }
  }
}

module.exports = new FriendService();
```

### 3. API 路由设计

```javascript
// backend/services/social-service/src/routes/friends.js

const express = require('express');
const router = express.Router();
const friendService = require('../friendService');
const { authenticate } = require('../../../../shared/middleware/auth');
const { rateLimit } = require('../../../../shared/middleware/rateLimit');

// 获取好友列表
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { page, limit, sortBy } = req.query;
    const result = await friendService.getFriendList(req.userId, { page, limit, sortBy });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 发送好友请求
router.post('/request', authenticate, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const { toUserId, message } = req.body;
    const result = await friendService.sendFriendRequest(req.userId, toUserId, message);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// 接受好友请求
router.post('/request/:requestId/accept', authenticate, async (req, res, next) => {
  try {
    const result = await friendService.acceptFriendRequest(req.userId, req.params.requestId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 拒绝好友请求
router.post('/request/:requestId/reject', authenticate, async (req, res, next) => {
  try {
    const result = await friendService.rejectFriendRequest(req.userId, req.params.requestId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 获取待处理请求
router.get('/requests/pending', authenticate, async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const result = await friendService.getPendingRequests(req.userId, page, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 删除好友
router.delete('/:friendId', authenticate, async (req, res, next) => {
  try {
    await friendService.removeFriend(req.userId, req.params.friendId);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// 搜索用户
router.get('/search', authenticate, async (req, res, next) => {
  try {
    const { q, limit } = req.query;
    const result = await friendService.searchUsers(req.userId, q, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 通过好友码添加
router.post('/add-by-code', authenticate, async (req, res, next) => {
  try {
    const { friendCode } = req.body;
    const result = await friendService.addFriendByCode(req.userId, friendCode);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// 赠送礼物
router.post('/:friendId/gift', authenticate, rateLimit({ windowMs: 86400000, max: 50 }), async (req, res, next) => {
  try {
    const { giftType, giftId, quantity } = req.body;
    const result = await friendService.sendGift(req.userId, req.params.friendId, {
      giftType, giftId, quantity
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// 获取待领取礼物
router.get('/gifts/pending', authenticate, async (req, res, next) => {
  try {
    const { page, limit } = req.query;
    const result = await friendService.getPendingGifts(req.userId, page, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 领取礼物
router.post('/gifts/:giftId/claim', authenticate, async (req, res, next) => {
  try {
    const result = await friendService.claimGift(req.userId, req.params.giftId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 获取好友排行榜
router.get('/leaderboard', authenticate, async (req, res, next) => {
  try {
    const { type, limit } = req.query;
    const result = await friendService.getFriendLeaderboard(req.userId, type, limit);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 获取好友详情
router.get('/:friendId', authenticate, async (req, res, next) => {
  try {
    const result = await friendService.getFriendDetail(req.userId, req.params.friendId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

### 4. 前端实现

```javascript
// frontend/game-client/src/components/FriendSystem.js

import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';

export function FriendList({ onClose }) {
  const [friends, setFriends] = useState([]);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [activeTab, setActiveTab] = useState('friends');
  const [loading, setLoading] = useState(true);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    loadFriends();
    loadPendingRequests();
    
    // 订阅好友事件
    const unsubscribe = subscribe('friend_', (event) => {
      if (event.type === 'friend_request_received') {
        loadPendingRequests();
      } else if (event.type === 'friend_accepted') {
        loadFriends();
      } else if (event.type === 'gift_received') {
        // 显示礼物通知
        showGiftNotification(event.data);
      }
    });
    
    return () => unsubscribe();
  }, []);

  const loadFriends = async () => {
    try {
      const response = await fetch('/api/social/friends', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      setFriends(data.friends);
    } catch (error) {
      console.error('Failed to load friends:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadPendingRequests = async () => {
    try {
      const response = await fetch('/api/social/friends/requests/pending', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      const data = await response.json();
      setPendingRequests(data);
    } catch (error) {
      console.error('Failed to load pending requests:', error);
    }
  };

  const acceptRequest = async (requestId) => {
    try {
      await fetch(`/api/social/friends/request/${requestId}/accept`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
      });
      loadFriends();
      loadPendingRequests();
    } catch (error) {
      console.error('Failed to accept request:', error);
    }
  };

  const sendGift = async (friendId) => {
    // 打开礼物选择界面
    // ...
  };

  const getOnlineStatusColor = (status) => {
    switch (status) {
      case 'online': return '#4CAF50';
      case 'away': return '#FFC107';
      default: return '#9E9E9E';
    }
  };

  if (loading) {
    return <div className="friend-list-loading">Loading...</div>;
  }

  return (
    <div className="friend-list-container">
      <div className="friend-list-header">
        <h2>Friends</h2>
        <button onClick={onClose} className="close-btn">×</button>
      </div>

      <div className="friend-tabs">
        <button
          className={activeTab === 'friends' ? 'active' : ''}
          onClick={() => setActiveTab('friends')}
        >
          Friends ({friends.length})
        </button>
        <button
          className={activeTab === 'requests' ? 'active' : ''}
          onClick={() => setActiveTab('requests')}
        >
          Requests {pendingRequests.length > 0 && `(${pendingRequests.length})`}
        </button>
        <button
          className={activeTab === 'add' ? 'active' : ''}
          onClick={() => setActiveTab('add')}
        >
          Add Friend
        </button>
      </div>

      {activeTab === 'friends' && (
        <div className="friends-grid">
          {friends.map(friend => (
            <div key={friend.id} className="friend-card">
              <div className="friend-avatar-container">
                <img src={friend.avatar_url} alt={friend.username} />
                <span
                  className="online-status"
                  style={{ backgroundColor: getOnlineStatusColor(friend.online_status) }}
                />
              </div>
              <div className="friend-info">
                <div className="friend-name">{friend.username}</div>
                <div className="friend-level">Lv. {friend.level}</div>
                <div className="friendship-level">
                  {'❤️'.repeat(friend.friendship_level)}
                  <span className="friendship-points">({friend.friendship_points})</span>
                </div>
              </div>
              <div className="friend-actions">
                <button onClick={() => sendGift(friend.id)} className="gift-btn">
                  🎁 Gift
                </button>
                <button onClick={() => openTrade(friend.id)} className="trade-btn">
                  🔄 Trade
                </button>
                <button onClick={() => viewProfile(friend.id)} className="profile-btn">
                  👤
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'requests' && (
        <div className="requests-list">
          {pendingRequests.length === 0 ? (
            <div className="no-requests">No pending requests</div>
          ) : (
            pendingRequests.map(request => (
              <div key={request.id} className="request-card">
                <img src={request.avatar_url} alt={request.username} />
                <div className="request-info">
                  <div className="request-name">{request.username}</div>
                  <div className="request-level">Lv. {request.level}</div>
                  {request.message && (
                    <div className="request-message">"{request.message}"</div>
                  )}
                </div>
                <div className="request-actions">
                  <button
                    onClick={() => acceptRequest(request.id)}
                    className="accept-btn"
                  >
                    ✓ Accept
                  </button>
                  <button
                    onClick={() => rejectRequest(request.id)}
                    className="reject-btn"
                  >
                    ✗ Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'add' && (
        <AddFriendPanel onFriendAdded={() => {
          loadFriends();
          setActiveTab('friends');
        }} />
      )}
    </div>
  );
}

function AddFriendPanel({ onFriendAdded }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [friendCode, setFriendCode] = useState('');

  const searchUsers = async (query) => {
    if (!query) {
      setSearchResults([]);
      return;
    }
    
    const response = await fetch(`/api/social/friends/search?q=${query}`, {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }
    });
    const data = await response.json();
    setSearchResults(data);
  };

  const sendRequest = async (toUserId) => {
    try {
      await fetch('/api/social/friends/request', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ toUserId })
      });
      alert('Friend request sent!');
    } catch (error) {
      alert('Failed to send request');
    }
  };

  const addByCode = async () => {
    try {
      await fetch('/api/social/friends/add-by-code', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ friendCode })
      });
      alert('Friend request sent!');
      setFriendCode('');
    } catch (error) {
      alert('Invalid friend code');
    }
  };

  return (
    <div className="add-friend-panel">
      <div className="search-section">
        <input
          type="text"
          placeholder="Search by username..."
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            searchUsers(e.target.value);
          }}
        />
        {searchResults.length > 0 && (
          <div className="search-results">
            {searchResults.map(user => (
              <div key={user.id} className="search-result-item">
                <img src={user.avatar_url} alt={user.username} />
                <span>{user.username} (Lv. {user.level})</span>
                <button onClick={() => sendRequest(user.id)}>Add</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="divider">OR</div>

      <div className="friend-code-section">
        <input
          type="text"
          placeholder="Enter friend code"
          value={friendCode}
          onChange={(e) => setFriendCode(e.target.value.toUpperCase())}
          maxLength={12}
        />
        <button onClick={addByCode}>Add by Code</button>
      </div>

      <div className="my-friend-code">
        <label>My Friend Code:</label>
        <div className="code-display">{localStorage.getItem('friendCode')}</div>
        <button onClick={() => navigator.clipboard.writeText(localStorage.getItem('friendCode'))}>
          📋 Copy
        </button>
      </div>
    </div>
  );
}
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics.js - 新增好友系统指标

// 好友系统指标
const friendRequestsSent = new Counter({
  name: 'friend_requests_sent_total',
  help: 'Total number of friend requests sent',
  labelNames: ['status']
});

const friendsAdded = new Counter({
  name: 'friends_added_total',
  help: 'Total number of friends added'
});

const giftsSent = new Counter({
  name: 'gifts_sent_total',
  help: 'Total number of gifts sent',
  labelNames: ['gift_type']
});

const friendshipPointsEarned = new Counter({
  name: 'friendship_points_earned_total',
  help: 'Total friendship points earned'
});

const friendListLatency = new Histogram({
  name: 'friend_list_request_duration_seconds',
  help: 'Friend list request latency',
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2]
});

module.exports = {
  // ... 现有指标
  friendRequestsSent,
  friendsAdded,
  giftsSent,
  friendshipPointsEarned,
  friendListLatency
};
```

## 验收标准

- [ ] 用户可以搜索并添加好友（用户名搜索、好友码）
- [ ] 好友请求可以通过/拒绝，7天后自动过期
- [ ] 好友列表正确显示在线状态（在线/离开/离线）
- [ ] 好友关系存储为双向关系
- [ ] 用户可以赠送道具、糖果给好友
- [ ] 每日礼物限制为50个
- [ ] 礼物有30天过期时间
- [ ] 友情点数系统正常工作（互动增加点数）
- [ ] 友情等级正确计算（1-5级）
- [ ] 友情等级提升时发送通知
- [ ] 好友排行榜正确排序
- [ ] 好友事件通过WebSocket实时推送
- [ ] 最大好友数量限制为400
- [ ] 最大待处理请求限制为50
- [ ] 单元测试覆盖核心逻辑（好友请求、礼物、友情点数）
- [ ] API响应时间 < 200ms (P95)
- [ ] 支持50万用户的好友关系存储

## 影响范围

- **新增文件**：
  - `backend/services/social-service/src/friendService.js` (好友服务核心)
  - `backend/services/social-service/src/routes/friends.js` (API路由)
  - `frontend/game-client/src/components/FriendSystem.js` (前端组件)
  - `frontend/game-client/src/styles/friend-system.css` (样式文件)
  - `database/pending/20260609_100000__add_friend_system_tables.sql` (数据库迁移)
  - `backend/tests/unit/friend-service.test.js` (单元测试)

- **修改文件**：
  - `backend/services/social-service/src/index.js` (集成好友路由)
  - `backend/shared/metrics.js` (新增好友系统指标)
  - `backend/shared/EventBus.js` (新增好友事件定义)
  - `backend/gateway/src/index.js` (路由代理)
  - `frontend/game-client/src/App.js` (集成好友组件)
  - `frontend/game-client/src/hooks/useWebSocket.js` (事件订阅)

- **依赖服务**：
  - user-service (用户信息查询)
  - pokemon-service (精灵糖果验证)
  - reward-service (道具库存验证)
  - Redis (好友状态缓存、排行榜缓存)
  - WebSocket (实时通知)

## 参考

- Pokemon GO 好友系统设计
- Pokemon GO 友情等级机制
- REQ-00018 精灵交易系统
- REQ-00026 游戏内实时推送通知系统
- [Social Gaming Best Practices](https://www.gamasutra.com/blogs/)
