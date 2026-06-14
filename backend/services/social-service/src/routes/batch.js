// social-service/src/routes/batch.js
// REQ-00092: API 请求合并与批量查询优化 - 好友批量状态接口
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const { getRedis } = require('../../../shared/redis');

const logger = createLogger('social-batch');

// Prometheus metrics
const batchRequestTotal = new (require('prom-client').Counter)({
  name: 'social_batch_request_total',
  help: 'Total number of social batch API requests',
  labelNames: ['endpoint', 'status'],
});

const batchRequestSize = new (require('prom-client').Histogram)({
  name: 'social_batch_request_size',
  help: 'Distribution of social batch request sizes',
  buckets: [1, 5, 10, 20, 50, 100],
});

/**
 * POST /batch/friends/status
 * 批量获取好友在线状态和基本信息
 * 
 * Body: { friendIds: ['user1', 'user2', 'user3'] }
 * Response: { code: 0, data: { friends: [status1, status2, status3] } }
 */
router.post('/friends/status', requireAuth, async (req, res, next) => {
  const startTime = Date.now();
  
  try {
    const { friendIds } = req.body;
    const userId = req.user.sub;

    // 参数校验
    if (!Array.isArray(friendIds) || friendIds.length === 0) {
      throw new AppError(1001, 'friendIds 必须是非空数组', 400);
    }

    if (friendIds.length > 100) {
      throw new AppError(1002, '单次批量查询最多 100 条', 400);
    }

    // 记录批量大小
    batchRequestSize.observe(friendIds.length);

    // 去重
    const uniqueIds = [...new Set(friendIds)];

    // 验证好友关系
    const { rows: friendships } = await query(`
      SELECT 
        CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END AS friend_id
      FROM friendships f
      WHERE (f.user_a=$1 OR f.user_b=$1)
        AND (f.user_a = ANY($2) OR f.user_b = ANY($2))
    `, [userId, uniqueIds]);

    const validFriendIds = new Set(friendships.map(f => f.friend_id));

    // 从 Redis 获取在线状态（最近 5 分钟活跃）
    let onlineStatuses = {};
    try {
      const redis = getRedis();
      if (redis) {
        const onlineKeys = uniqueIds.map(id => `user:online:${id}`);
        const onlineValues = await redis.mget(onlineKeys);
        
        uniqueIds.forEach((id, index) => {
          onlineStatuses[id] = onlineValues[index] === '1';
        });
      }
    } catch (redisErr) {
      logger.warn({ err: redisErr }, 'Redis online status check failed');
    }

    // 批量查询用户信息
    const { rows: users } = await query(`
      SELECT id, nickname, avatar_url, level, team, last_active_at
      FROM users
      WHERE id = ANY($1)
    `, [uniqueIds]);

    const userMap = new Map(users.map(u => [u.id, u]));

    // 批量查询好友关系详情（亲密度等）
    const { rows: friendshipDetails } = await query(`
      SELECT 
        CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END AS friend_id,
        f.level AS friendship_level,
        f.interaction_days,
        f.last_interaction_at
      FROM friendships f
      WHERE (f.user_a=$1 OR f.user_b=$1)
        AND (f.user_a = ANY($2) OR f.user_b = ANY($2))
    `, [userId, uniqueIds]);

    const friendshipMap = new Map(friendshipDetails.map(f => [f.friend_id, f]));

    // 组装结果
    const results = friendIds.map(friendId => {
      const user = userMap.get(friendId);
      const isOnline = onlineStatuses[friendId] || false;
      const isFriend = validFriendIds.has(friendId);
      const friendship = friendshipMap.get(friendId);

      return {
        friendId,
        isFriend,
        nickname: user?.nickname || null,
        avatarUrl: user?.avatar_url || null,
        level: user?.level || null,
        team: user?.team || null,
        isOnline,
        lastActiveAt: user?.last_active_at || null,
        friendship: isFriend ? {
          level: friendship?.friendship_level || 1,
          interactionDays: friendship?.interaction_days || 0,
          lastInteractionAt: friendship?.last_interaction_at || null
        } : null
      };
    });

    batchRequestTotal.inc({ endpoint: 'friends/status', status: 'success' });
    
    const duration = Date.now() - startTime;
    logger.info({ 
      requested: friendIds.length, 
      valid: validFriendIds.size,
      duration 
    }, 'Batch friends status completed');

    res.json(successResp({
      friends: results,
      requested: friendIds.length,
      valid: validFriendIds.size
    }));

  } catch (err) {
    batchRequestTotal.inc({ endpoint: 'friends/status', status: 'error' });
    logger.error({ err }, 'Batch friends status failed');
    next(err);
  }
});

/**
 * POST /batch/friends/summary
 * 批量获取好友摘要信息（精简版，用于列表展示）
 * 
 * Body: { friendIds: ['user1', 'user2'] }
 * Response: { code: 0, data: { friends: [summary1, summary2] } }
 */
router.post('/friends/summary', requireAuth, async (req, res, next) => {
  try {
    const { friendIds } = req.body;
    const userId = req.user.sub;

    if (!Array.isArray(friendIds) || friendIds.length === 0) {
      throw new AppError(1001, 'friendIds 必须是非空数组', 400);
    }

    if (friendIds.length > 200) {
      throw new AppError(1002, '单次批量查询最多 200 条', 400);
    }

    const uniqueIds = [...new Set(friendIds)];

    // 批量查询（单次 SQL）
    const { rows } = await query(`
      SELECT 
        u.id AS friend_id,
        u.nickname,
        u.avatar_url,
        u.level,
        u.team,
        f.level AS friendship_level,
        CASE WHEN o.user_id IS NOT NULL THEN true ELSE false END AS is_online
      FROM users u
      LEFT JOIN friendships f ON 
        ((f.user_a = $1 AND f.user_b = u.id) OR (f.user_b = $1 AND f.user_a = u.id))
      LEFT JOIN user_online_status o ON o.user_id = u.id AND o.last_seen > NOW() - INTERVAL '5 minutes'
      WHERE u.id = ANY($2)
    `, [userId, uniqueIds]);

    const userMap = new Map(rows.map(r => [r.friend_id, r]));

    const results = friendIds.map(id => {
      const row = userMap.get(id);
      if (!row) {
        return { friendId: id, exists: false };
      }
      
      return {
        friendId: id,
        exists: true,
        nickname: row.nickname,
        avatarUrl: row.avatar_url,
        level: row.level,
        team: row.team,
        friendshipLevel: row.friendship_level,
        isOnline: row.is_online
      };
    });

    res.json(successResp({
      friends: results,
      requested: friendIds.length
    }));

  } catch (err) {
    logger.error({ err }, 'Batch friends summary failed');
    next(err);
  }
});

/**
 * POST /batch/guilds/members
 * 批量获取公会成员状态
 * 
 * Body: { memberIds: ['user1', 'user2'] }
 */
router.post('/guilds/members', requireAuth, async (req, res, next) => {
  try {
    const { memberIds, guildId } = req.body;
    const userId = req.user.sub;

    if (!Array.isArray(memberIds) || memberIds.length === 0) {
      throw new AppError(1001, 'memberIds 必须是非空数组', 400);
    }

    if (memberIds.length > 100) {
      throw new AppError(1002, '单次批量查询最多 100 条', 400);
    }

    // 验证用户是否为公会成员
    if (guildId) {
      const { rows: [membership] } = await query(`
        SELECT 1 FROM guild_members 
        WHERE guild_id = $1 AND user_id = $2
      `, [guildId, userId]);

      if (!membership) {
        throw new AppError(2001, '您不是该公会成员', 403);
      }
    }

    const uniqueIds = [...new Set(memberIds)];

    // 批量查询成员信息
    const { rows: members } = await query(`
      SELECT 
        u.id,
        u.nickname,
        u.avatar_url,
        u.level,
        u.team,
        gm.role AS guild_role,
        gm.joined_at,
        gm.contribution,
        gm.last_active_at
      FROM users u
      LEFT JOIN guild_members gm ON gm.user_id = u.id AND gm.guild_id = $1
      WHERE u.id = ANY($2)
    `, [guildId, uniqueIds]);

    const memberMap = new Map(members.map(m => [m.id, m]));

    const results = memberIds.map(id => {
      const member = memberMap.get(id);
      if (!member) return { memberId: id, exists: false };

      return {
        memberId: id,
        exists: true,
        nickname: member.nickname,
        avatarUrl: member.avatar_url,
        level: member.level,
        team: member.team,
        guildRole: member.guild_role,
        joinedAt: member.joined_at,
        contribution: member.contribution,
        lastActiveAt: member.last_active_at
      };
    });

    res.json(successResp({
      members: results,
      requested: memberIds.length
    }));

  } catch (err) {
    logger.error({ err }, 'Batch guild members failed');
    next(err);
  }
});

module.exports = router;
