/**
 * REQ-00048: 精灵好友系统与社交互动增强
 * 好友服务核心模块
 * 
 * 功能：
 * - 好友关系管理（添加、删除、好友列表）
 * - 好友互动功能（赠送道具、糖果、友情点）
 * - 好友在线状态与实时互动
 * - 好友排行榜系统
 * - 好友活动日志与互动记录
 */

'use strict';

const { query, transaction } = require('../../../shared/db');
const EventBus = require('../../../shared/EventBus');
const { createLogger } = require('../../../shared/logger');
const redis = require('../../../shared/redis');
const { incrementCounter, observeHistogram } = require('../../../shared/metrics');

const logger = createLogger('friend-service');

// 配置常量
const CONFIG = {
  MAX_FRIENDS: 400,                    // 最大好友数量
  MAX_PENDING_REQUESTS: 50,            // 最大待处理请求数
  MAX_DAILY_GIFTS: 50,                 // 每日最大礼物数
  REQUEST_EXPIRE_DAYS: 7,              // 好友请求过期天数
  GIFT_EXPIRE_DAYS: 30,                // 礼物过期天数
  ONLINE_THRESHOLD_MINUTES: 5,         // 在线状态阈值（分钟）
  AWAY_THRESHOLD_MINUTES: 60,          // 离开状态阈值（分钟）
  FRIENDSHIP_LEVEL_THRESHOLDS: [0, 100, 500, 1000, 2000, 5000], // 友情等级阈值
  FRIENDSHIP_POINTS: {
    gift_received: 10,
    raid_together: 50,
    battle_together: 30,
    trade: 100,
    exchange_gift: 20
  }
};

// 错误类型
const ERRORS = {
  USER_NOT_FOUND: { code: 2001, message: '用户不存在', status: 404 },
  ALREADY_FRIENDS: { code: 2002, message: '已经是好友了', status: 400 },
  FRIEND_LIMIT_REACHED: { code: 2003, message: '好友数量已达上限', status: 400 },
  PENDING_REQUEST_LIMIT: { code: 2004, message: '待处理请求已达上限', status: 400 },
  REQUEST_NOT_FOUND: { code: 2005, message: '好友请求不存在', status: 404 },
  NOT_FRIENDS: { code: 2006, message: '不是好友关系', status: 400 },
  INSUFFICIENT_ITEM: { code: 2007, message: '道具数量不足', status: 400 },
  INSUFFICIENT_CANDY: { code: 2008, message: '糖果数量不足', status: 400 },
  DAILY_GIFT_LIMIT: { code: 2009, message: '今日礼物已达上限', status: 400 },
  GIFT_NOT_FOUND: { code: 2010, message: '礼物不存在或已领取', status: 404 },
  INVALID_FRIEND_CODE: { code: 2011, message: '无效的好友码', status: 400 },
  CANNOT_ADD_SELF: { code: 2012, message: '不能添加自己为好友', status: 400 }
};

/**
 * 好友服务类
 */
class FriendService {
  constructor() {
    this.config = CONFIG;
    this.errors = ERRORS;
  }

  /**
   * 发送好友请求
   * @param {string} fromUserId - 发送方用户ID
   * @param {string} toUserId - 接收方用户ID
   * @param {string} message - 附言
   * @returns {Promise<Object>} 请求结果
   */
  async sendFriendRequest(fromUserId, toUserId, message = '') {
    const startTime = Date.now();

    try {
      // 不能添加自己
      if (fromUserId === toUserId) {
        throw ERRORS.CANNOT_ADD_SELF;
      }

      // 验证用户存在
      const users = await query(`
        SELECT id, username FROM users 
        WHERE id = ANY($1::uuid[])
      `, [[fromUserId, toUserId]]);

      if (users.rows.length < 2) {
        throw ERRORS.USER_NOT_FOUND;
      }

      // 检查是否已是好友或有待处理请求
      const existing = await query(`
        SELECT * FROM friends 
        WHERE (user_id = $1 AND friend_user_id = $2)
           OR (user_id = $2 AND friend_user_id = $1)
      `, [fromUserId, toUserId]);

      if (existing.rows.length > 0) {
        throw ERRORS.ALREADY_FRIENDS;
      }

      // 检查是否已有请求
      const existingRequest = await query(`
        SELECT * FROM friend_requests
        WHERE ((from_user_id = $1 AND to_user_id = $2)
           OR (from_user_id = $2 AND to_user_id = $1))
          AND status = 'pending'
      `, [fromUserId, toUserId]);

      if (existingRequest.rows.length > 0) {
        throw ERRORS.ALREADY_FRIENDS;
      }

      // 检查接收方好友数量
      const toUserCount = await this.getFriendCount(toUserId);
      if (toUserCount >= this.config.MAX_FRIENDS) {
        throw ERRORS.FRIEND_LIMIT_REACHED;
      }

      // 检查发送方待处理请求数
      const pendingCount = await query(`
        SELECT COUNT(*)::int as count FROM friend_requests
        WHERE from_user_id = $1 AND status = 'pending'
      `, [fromUserId]);

      if (pendingCount.rows[0].count >= this.config.MAX_PENDING_REQUESTS) {
        throw ERRORS.PENDING_REQUEST_LIMIT;
      }

      // 创建好友请求
      const result = await query(`
        INSERT INTO friend_requests (from_user_id, to_user_id, message, status, expires_at)
        VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP + INTERVAL '${this.config.REQUEST_EXPIRE_DAYS} days')
        RETURNING *
      `, [fromUserId, toUserId, message]);

      const request = result.rows[0];

      // 发布事件
      await this.publishEvent('FRIEND_REQUEST_SENT', {
        requestId: request.id,
        fromUserId,
        toUserId,
        timestamp: new Date().toISOString()
      });

      // 指标
      incrementCounter('friend_requests_sent_total', 1, { status: 'success' });
      observeHistogram('friend_request_duration_seconds', (Date.now() - startTime) / 1000);

      logger.info({ fromUserId, toUserId, requestId: request.id }, 'Friend request sent');

      return {
        success: true,
        requestId: request.id,
        message: '好友请求已发送'
      };
    } catch (error) {
      incrementCounter('friend_requests_sent_total', 1, { status: 'error' });
      logger.error({ error, fromUserId, toUserId }, 'Failed to send friend request');
      throw error;
    }
  }

  /**
   * 接受好友请求
   * @param {string} userId - 当前用户ID
   * @param {number} requestId - 请求ID
   * @returns {Promise<Object>} 结果
   */
  async acceptFriendRequest(userId, requestId) {
    return await transaction(async (client) => {
      // 获取请求
      const requestResult = await client.query(`
        SELECT * FROM friend_requests
        WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
      `, [requestId, userId]);

      if (requestResult.rows.length === 0) {
        throw ERRORS.REQUEST_NOT_FOUND;
      }

      const request = requestResult.rows[0];

      // 更新请求状态
      await client.query(`
        UPDATE friend_requests SET status = 'accepted'
        WHERE id = $1
      `, [requestId]);

      // 创建双向好友关系
      await client.query(`
        INSERT INTO friends (user_id, friend_user_id, status, friendship_level, friendship_points)
        VALUES 
          ($1, $2, 'accepted', 1, 0),
          ($2, $1, 'accepted', 1, 0)
        ON CONFLICT (user_id, friend_user_id) DO UPDATE SET status = 'accepted'
      `, [request.from_user_id, request.to_user_id]);

      // 发布事件
      await this.publishEvent('FRIEND_REQUEST_ACCEPTED', {
        requestId,
        fromUserId: request.from_user_id,
        toUserId: request.to_user_id,
        timestamp: new Date().toISOString()
      });

      incrementCounter('friends_added_total', 1);
      logger.info({ requestId, fromUserId: request.from_user_id, toUserId: userId }, 'Friend request accepted');

      return {
        success: true,
        friendshipLevel: 1,
        message: '已成为好友'
      };
    });
  }

  /**
   * 拒绝好友请求
   * @param {string} userId - 当前用户ID
   * @param {number} requestId - 请求ID
   * @returns {Promise<Object>} 结果
   */
  async rejectFriendRequest(userId, requestId) {
    const result = await query(`
      UPDATE friend_requests SET status = 'rejected'
      WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
      RETURNING *
    `, [requestId, userId]);

    if (result.rows.length === 0) {
      throw ERRORS.REQUEST_NOT_FOUND;
    }

    logger.info({ requestId, userId }, 'Friend request rejected');

    return { success: true, message: '已拒绝请求' };
  }

  /**
   * 获取好友列表
   * @param {string} userId - 用户ID
   * @param {Object} options - 查询选项
   * @returns {Promise<Object>} 好友列表
   */
  async getFriendList(userId, options = {}) {
    const { page = 1, limit = 50, sortBy = 'last_interaction' } = options;
    const offset = (page - 1) * limit;

    // 排序逻辑
    let orderBy = 'f.last_interaction_at DESC NULLS LAST';
    if (sortBy === 'friendship_level') {
      orderBy = 'f.friendship_level DESC, f.friendship_points DESC';
    } else if (sortBy === 'name') {
      orderBy = 'u.username ASC';
    } else if (sortBy === 'level') {
      orderBy = 'u.level DESC';
    }

    // 查询好友列表
    const friendsResult = await query(`
      SELECT 
        u.id,
        u.username,
        u.avatar_url,
        u.level,
        u.team,
        f.friendship_level,
        f.friendship_points,
        f.last_interaction_at,
        f.created_at as friends_since,
        CASE 
          WHEN u.last_active_at > NOW() - INTERVAL '${this.config.ONLINE_THRESHOLD_MINUTES} minutes' THEN 'online'
          WHEN u.last_active_at > NOW() - INTERVAL '${this.config.AWAY_THRESHOLD_MINUTES} minutes' THEN 'away'
          ELSE 'offline'
        END as online_status,
        u.last_active_at
      FROM friends f
      JOIN users u ON f.friend_user_id = u.id
      WHERE f.user_id = $1 AND f.status = 'accepted'
      ORDER BY ${orderBy}
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    // 查询总数
    const countResult = await query(`
      SELECT COUNT(*)::int as count FROM friends
      WHERE user_id = $1 AND status = 'accepted'
    `, [userId]);

    // 查询未领取礼物数
    const giftsResult = await query(`
      SELECT from_user_id, COUNT(*)::int as count
      FROM friend_gifts
      WHERE to_user_id = $1 AND status = 'pending'
      GROUP BY from_user_id
    `, [userId]);

    const giftCounts = {};
    giftsResult.rows.forEach(g => {
      giftCounts[g.from_user_id] = g.count;
    });

    // 组装结果
    const friends = friendsResult.rows.map(f => ({
      ...f,
      pending_gifts: giftCounts[f.id] || 0
    }));

    return {
      friends,
      pagination: {
        page,
        limit,
        total: countResult.rows[0].count,
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    };
  }

  /**
   * 获取待处理的好友请求
   * @param {string} userId - 用户ID
   * @param {Object} options - 查询选项
   * @returns {Promise<Array>} 请求列表
   */
  async getPendingRequests(userId, options = {}) {
    const { page = 1, limit = 20 } = options;
    const offset = (page - 1) * limit;

    const result = await query(`
      SELECT 
        fr.id,
        fr.message,
        fr.created_at,
        fr.expires_at,
        u.id as from_user_id,
        u.username,
        u.avatar_url,
        u.level
      FROM friend_requests fr
      JOIN users u ON fr.from_user_id = u.id
      WHERE fr.to_user_id = $1 
        AND fr.status = 'pending'
        AND fr.expires_at > NOW()
      ORDER BY fr.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    return result.rows;
  }

  /**
   * 获取发送的请求
   * @param {string} userId - 用户ID
   * @returns {Promise<Array>} 请求列表
   */
  async getSentRequests(userId) {
    const result = await query(`
      SELECT 
        fr.id,
        fr.message,
        fr.status,
        fr.created_at,
        fr.expires_at,
        u.id as to_user_id,
        u.username,
        u.avatar_url,
        u.level
      FROM friend_requests fr
      JOIN users u ON fr.to_user_id = u.id
      WHERE fr.from_user_id = $1 AND fr.status = 'pending'
      ORDER BY fr.created_at DESC
    `, [userId]);

    return result.rows;
  }

  /**
   * 删除好友
   * @param {string} userId - 用户ID
   * @param {string} friendId - 好友ID
   * @returns {Promise<Object>} 结果
   */
  async removeFriend(userId, friendId) {
    return await transaction(async (client) => {
      // 删除双向好友关系
      const result = await client.query(`
        DELETE FROM friends
        WHERE (user_id = $1 AND friend_user_id = $2)
           OR (user_id = $2 AND friend_user_id = $1)
        RETURNING *
      `, [userId, friendId]);

      if (result.rows.length === 0) {
        throw ERRORS.NOT_FRIENDS;
      }

      // 发布事件
      await this.publishEvent('FRIEND_REMOVED', {
        userId,
        friendId,
        timestamp: new Date().toISOString()
      });

      incrementCounter('friends_removed_total', 1);
      logger.info({ userId, friendId }, 'Friend removed');

      return { success: true, message: '已删除好友' };
    });
  }

  /**
   * 发送礼物
   * @param {string} fromUserId - 发送方ID
   * @param {string} toUserId - 接收方ID
   * @param {Object} giftData - 礼物数据
   * @returns {Promise<Object>} 结果
   */
  async sendGift(fromUserId, toUserId, giftData) {
    const { giftType, giftId, quantity = 1, giftName } = giftData;

    // 验证好友关系
    const friendship = await query(`
      SELECT * FROM friends
      WHERE user_id = $1 AND friend_user_id = $2 AND status = 'accepted'
    `, [fromUserId, toUserId]);

    if (friendship.rows.length === 0) {
      throw ERRORS.NOT_FRIENDS;
    }

    // 检查每日礼物限制
    const todayGifts = await this.getTodayGiftCount(fromUserId);
    if (todayGifts >= this.config.MAX_DAILY_GIFTS) {
      throw ERRORS.DAILY_GIFT_LIMIT;
    }

    return await transaction(async (client) => {
      // 根据礼物类型验证并扣减
      if (giftType === 'item') {
        const inventory = await client.query(`
          SELECT * FROM user_inventory
          WHERE user_id = $1 AND item_id = $2
        `, [fromUserId, giftId]);

        if (inventory.rows.length === 0 || inventory.rows[0].quantity < quantity) {
          throw ERRORS.INSUFFICIENT_ITEM;
        }

        await client.query(`
          UPDATE user_inventory SET quantity = quantity - $3
          WHERE user_id = $1 AND item_id = $2
        `, [fromUserId, giftId, quantity]);
      } else if (giftType === 'candy') {
        const candy = await client.query(`
          SELECT * FROM pokemon_candies
          WHERE user_id = $1 AND pokemon_species_id = $2
        `, [fromUserId, giftId]);

        if (candy.rows.length === 0 || candy.rows[0].quantity < quantity) {
          throw ERRORS.INSUFFICIENT_CANDY;
        }

        await client.query(`
          UPDATE pokemon_candies SET quantity = quantity - $3
          WHERE user_id = $1 AND pokemon_species_id = $2
        `, [fromUserId, giftId, quantity]);
      } else if (giftType === 'stardust') {
        // 星尘验证（假设有 user_resources 表）
        await client.query(`
          UPDATE users SET stardust = stardust - $3
          WHERE id = $1 AND stardust >= $3
        `, [fromUserId, giftId, quantity]);
      }

      // 创建礼物记录
      const giftResult = await client.query(`
        INSERT INTO friend_gifts (from_user_id, to_user_id, gift_type, gift_id, gift_name, quantity, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        RETURNING *
      `, [fromUserId, toUserId, giftType, giftId, giftName, quantity]);

      // 发布事件
      await this.publishEvent('GIFT_SENT', {
        giftId: giftResult.rows[0].id,
        fromUserId,
        toUserId,
        giftType,
        timestamp: new Date().toISOString()
      });

      incrementCounter('gifts_sent_total', 1, { gift_type: giftType });
      logger.info({ fromUserId, toUserId, giftType }, 'Gift sent');

      return {
        success: true,
        giftId: giftResult.rows[0].id,
        message: '礼物已发送'
      };
    });
  }

  /**
   * 获取待领取礼物
   * @param {string} userId - 用户ID
   * @param {Object} options - 查询选项
   * @returns {Promise<Object>} 礼物列表
   */
  async getPendingGifts(userId, options = {}) {
    const { page = 1, limit = 20 } = options;
    const offset = (page - 1) * limit;

    const result = await query(`
      SELECT 
        fg.*,
        u.id as from_user_id,
        u.username as from_username,
        u.avatar_url as from_avatar
      FROM friend_gifts fg
      JOIN users u ON fg.from_user_id = u.id
      WHERE fg.to_user_id = $1 
        AND fg.status = 'pending'
        AND fg.expires_at > NOW()
      ORDER BY fg.created_at DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);

    const countResult = await query(`
      SELECT COUNT(*)::int as count FROM friend_gifts
      WHERE to_user_id = $1 AND status = 'pending' AND expires_at > NOW()
    `, [userId]);

    return {
      gifts: result.rows,
      pagination: {
        page,
        limit,
        total: countResult.rows[0].count,
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    };
  }

  /**
   * 领取礼物
   * @param {string} userId - 用户ID
   * @param {number} giftId - 礼物ID
   * @returns {Promise<Object>} 结果
   */
  async claimGift(userId, giftId) {
    return await transaction(async (client) => {
      // 获取礼物
      const giftResult = await client.query(`
        SELECT * FROM friend_gifts
        WHERE id = $1 AND to_user_id = $2 AND status = 'pending'
      `, [giftId, userId]);

      if (giftResult.rows.length === 0) {
        throw ERRORS.GIFT_NOT_FOUND;
      }

      const gift = giftResult.rows[0];

      // 添加到用户背包
      if (gift.gift_type === 'item') {
        await client.query(`
          INSERT INTO user_inventory (user_id, item_id, quantity)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, item_id) 
          DO UPDATE SET quantity = user_inventory.quantity + $3
        `, [userId, gift.gift_id, gift.quantity]);
      } else if (gift.gift_type === 'candy') {
        await client.query(`
          INSERT INTO pokemon_candies (user_id, pokemon_species_id, quantity)
          VALUES ($1, $2, $3)
          ON CONFLICT (user_id, pokemon_species_id)
          DO UPDATE SET quantity = pokemon_candies.quantity + $3
        `, [userId, gift.gift_id, gift.quantity]);
      } else if (gift.gift_type === 'stardust') {
        await client.query(`
          UPDATE users SET stardust = stardust + $2 WHERE id = $1
        `, [userId, gift.quantity]);
      }

      // 更新礼物状态
      await client.query(`
        UPDATE friend_gifts SET status = 'claimed', claimed_at = NOW()
        WHERE id = $1
      `, [giftId]);

      // 增加友情点数
      const pointsEarned = this.config.FRIENDSHIP_POINTS.gift_received;
      await this.addFriendshipPoints(gift.from_user_id, userId, pointsEarned, 'gift_received', client);

      // 发布事件
      await this.publishEvent('GIFT_CLAIMED', {
        giftId,
        userId,
        fromUserId: gift.from_user_id,
        giftType: gift.gift_type,
        timestamp: new Date().toISOString()
      });

      incrementCounter('gifts_claimed_total', 1);
      logger.info({ giftId, userId, fromUserId: gift.from_user_id }, 'Gift claimed');

      return {
        success: true,
        giftType: gift.gift_type,
        giftName: gift.gift_name,
        quantity: gift.quantity,
        pointsEarned
      };
    });
  }

  /**
   * 添加友情点数
   * @param {string} userId - 用户ID
   * @param {string} friendId - 好友ID
   * @param {number} points - 点数
   * @param {string} interactionType - 互动类型
   * @param {Object} client - 事务客户端
   */
  async addFriendshipPoints(userId, friendId, points, interactionType, client = null) {
    const executor = client || { query };

    // 更新双向友情点数
    await executor.query(`
      UPDATE friends SET 
        friendship_points = friendship_points + $3,
        last_interaction_at = NOW()
      WHERE (user_id = $1 AND friend_user_id = $2)
         OR (user_id = $2 AND friend_user_id = $1)
    `, [userId, friendId, points]);

    // 记录互动
    await executor.query(`
      INSERT INTO friend_interactions (user_id, friend_user_id, interaction_type, friendship_points_earned)
      VALUES ($1, $2, $3, $4)
    `, [userId, friendId, interactionType, points]);

    // 检查等级提升
    await this.checkFriendshipLevelUp(userId, friendId, client);

    incrementCounter('friendship_points_earned_total', points);
  }

  /**
   * 检查友情等级提升
   * @param {string} userId - 用户ID
   * @param {string} friendId - 好友ID
   * @param {Object} client - 事务客户端
   */
  async checkFriendshipLevelUp(userId, friendId, client = null) {
    const executor = client || { query };

    const result = await executor.query(`
      SELECT id, friendship_points, friendship_level FROM friends
      WHERE (user_id = $1 AND friend_user_id = $2)
         OR (user_id = $2 AND friend_user_id = $1)
    `, [userId, friendId]);

    for (const friendship of result.rows) {
      const newLevel = this.calculateFriendshipLevel(friendship.friendship_points);
      if (newLevel > friendship.friendship_level) {
        await executor.query(`
          UPDATE friends SET friendship_level = $1 WHERE id = $2
        `, [newLevel, friendship.id]);

        // 发布升级事件
        await this.publishEvent('FRIENDSHIP_LEVEL_UP', {
          userId: friendship.user_id,
          friendId: friendship.friend_user_id,
          newLevel,
          oldLevel: friendship.friendship_level
        });

        logger.info({
          userId: friendship.user_id,
          friendId: friendship.friend_user_id,
          newLevel
        }, 'Friendship level up');
      }
    }
  }

  /**
   * 计算友情等级
   * @param {number} points - 友情点数
   * @returns {number} 等级 1-5
   */
  calculateFriendshipLevel(points) {
    const thresholds = this.config.FRIENDSHIP_LEVEL_THRESHOLDS;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (points >= thresholds[i]) {
        return i + 1;
      }
    }
    return 1;
  }

  /**
   * 获取好友排行榜
   * @param {string} userId - 用户ID
   * @param {string} type - 排行类型 friendship/level
   * @param {number} limit - 数量
   * @returns {Promise<Array>} 排行榜
   */
  async getFriendLeaderboard(userId, type = 'friendship', limit = 10) {
    const cacheKey = `friend_leaderboard:${userId}:${type}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    let orderBy = 'f.friendship_points DESC';
    if (type === 'level') {
      orderBy = 'u.level DESC';
    }

    const result = await query(`
      SELECT 
        u.id,
        u.username,
        u.avatar_url,
        u.level,
        f.friendship_level,
        f.friendship_points
      FROM friends f
      JOIN users u ON f.friend_user_id = u.id
      WHERE f.user_id = $1 AND f.status = 'accepted'
      ORDER BY ${orderBy}
      LIMIT $2
    `, [userId, limit]);

    // 缓存5分钟
    await redis.setex(cacheKey, 300, JSON.stringify(result.rows));

    return result.rows;
  }

  /**
   * 搜索用户
   * @param {string} userId - 当前用户ID
   * @param {string} searchQuery - 搜索关键词
   * @param {number} limit - 数量
   * @returns {Promise<Array>} 用户列表
   */
  async searchUsers(userId, searchQuery, limit = 20) {
    const result = await query(`
      SELECT id, username, avatar_url, level, team
      FROM users
      WHERE id != $1
        AND username ILIKE $2
      ORDER BY level DESC
      LIMIT $3
    `, [userId, `%${searchQuery}%`, limit]);

    return result.rows;
  }

  /**
   * 通过好友码添加好友
   * @param {string} userId - 用户ID
   * @param {string} friendCode - 好友码
   * @returns {Promise<Object>} 结果
   */
  async addFriendByCode(userId, friendCode) {
    const result = await query(`
      SELECT id FROM users WHERE friend_code = $1
    `, [friendCode.toUpperCase()]);

    if (result.rows.length === 0) {
      throw ERRORS.INVALID_FRIEND_CODE;
    }

    const targetUserId = result.rows[0].id;
    return this.sendFriendRequest(userId, targetUserId, '通过好友码添加');
  }

  /**
   * 获取用户的好友码
   * @param {string} userId - 用户ID
   * @returns {Promise<string>} 好友码
   */
  async getFriendCode(userId) {
    const result = await query(`
      SELECT friend_code FROM users WHERE id = $1
    `, [userId]);

    return result.rows[0]?.friend_code;
  }

  /**
   * 获取好友数量
   * @param {string} userId - 用户ID
   * @returns {Promise<number>} 数量
   */
  async getFriendCount(userId) {
    const result = await query(`
      SELECT COUNT(*)::int as count FROM friends
      WHERE user_id = $1 AND status = 'accepted'
    `, [userId]);

    return result.rows[0].count;
  }

  /**
   * 获取今日礼物数量
   * @param {string} userId - 用户ID
   * @returns {Promise<number>} 数量
   */
  async getTodayGiftCount(userId) {
    const result = await query(`
      SELECT COUNT(*)::int as count FROM friend_gifts
      WHERE from_user_id = $1 AND created_at >= CURRENT_DATE
    `, [userId]);

    return result.rows[0].count;
  }

  /**
   * 更新用户在线状态
   * @param {string} userId - 用户ID
   */
  async updateUserActiveStatus(userId) {
    await query(`
      UPDATE users SET last_active_at = NOW() WHERE id = $1
    `, [userId]);
  }

  /**
   * 获取好友详情
   * @param {string} userId - 用户ID
   * @param {string} friendId - 好友ID
   * @returns {Promise<Object>} 详情
   */
  async getFriendDetail(userId, friendId) {
    const result = await query(`
      SELECT 
        u.id,
        u.username,
        u.avatar_url,
        u.level,
        u.team,
        u.friend_code,
        f.friendship_level,
        f.friendship_points,
        f.last_interaction_at,
        f.created_at as friends_since,
        CASE 
          WHEN u.last_active_at > NOW() - INTERVAL '${this.config.ONLINE_THRESHOLD_MINUTES} minutes' THEN 'online'
          WHEN u.last_active_at > NOW() - INTERVAL '${this.config.AWAY_THRESHOLD_MINUTES} minutes' THEN 'away'
          ELSE 'offline'
        END as online_status
      FROM friends f
      JOIN users u ON f.friend_user_id = u.id
      WHERE f.user_id = $1 AND f.friend_user_id = $2 AND f.status = 'accepted'
    `, [userId, friendId]);

    if (result.rows.length === 0) {
      throw ERRORS.NOT_FRIENDS;
    }

    // 获取互动统计
    const statsResult = await query(`
      SELECT 
        interaction_type,
        COUNT(*)::int as count
      FROM friend_interactions
      WHERE (user_id = $1 AND friend_user_id = $2)
         OR (user_id = $2 AND friend_user_id = $1)
      GROUP BY interaction_type
    `, [userId, friendId]);

    return {
      ...result.rows[0],
      interactions: statsResult.rows
    };
  }

  /**
   * 发布事件
   * @param {string} eventName - 事件名称
   * @param {Object} data - 事件数据
   */
  async publishEvent(eventName, data) {
    try {
      if (EventBus && EventBus.publish) {
        await EventBus.publish(eventName, data);
      }
    } catch (error) {
      logger.error({ error, eventName }, 'Failed to publish event');
    }
  }
}

// 导出单例
module.exports = new FriendService();
module.exports.FriendService = FriendService;
module.exports.CONFIG = CONFIG;
module.exports.ERRORS = ERRORS;
