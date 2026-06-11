// backend/services/user-service/src/routes/messageCenter.js
// REQ-00099: 游戏消息中心与通知管理系统 - API 路由
'use strict';

const { Router } = require('express');
const { query } = require('../../../../shared/db');
const { getRedis, getJSON, setJSON, del } = require('../../../../shared/redis');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');
const promClient = require('prom-client');

const logger = createLogger('user-service:message-center');
const router = Router();

// ============================================================
// Prometheus 指标
// ============================================================

const metrics = {
  notificationsFetched: new promClient.Counter({
    name: 'minego_message_center_notifications_fetched_total',
    help: 'Total notifications fetched',
    labelNames: ['status'],
  }),

  notificationsMarkedRead: new promClient.Counter({
    name: 'minego_message_center_notifications_marked_read_total',
    help: 'Total notifications marked as read',
  }),

  notificationsDeleted: new promClient.Counter({
    name: 'minego_message_center_notifications_deleted_total',
    help: 'Total notifications deleted',
  }),

  unreadCountQueries: new promClient.Counter({
    name: 'minego_message_center_unread_count_queries_total',
    help: 'Total unread count queries',
  }),
};

// ============================================================
// 工具函数
// ============================================================

/**
 * 通知类型映射
 */
const NOTIFICATION_TYPE_MAP = {
  RARE_SPAWN: { icon: '🐉', label: '稀有精灵', category: 'pokemon' },
  RAID_STARTED: { icon: '⚔️', label: 'Raid 战斗', category: 'raid' },
  FRIEND_REQUEST: { icon: '👥', label: '好友请求', category: 'friend' },
  GIFT_RECEIVED: { icon: '🎁', label: '礼物接收', category: 'friend' },
  QUEST_COMPLETE: { icon: '✅', label: '任务完成', category: 'reward' },
  SYSTEM: { icon: '📢', label: '系统通知', category: 'system' },
  TRADE_REQUEST: { icon: '🔄', label: '交易请求', category: 'friend' },
};

/**
 * 格式化通知数据
 */
function formatNotification(row) {
  const typeInfo = NOTIFICATION_TYPE_MAP[row.notification_type] || { icon: '📬', label: '通知' };
  
  return {
    id: row.id,
    type: row.notification_type,
    icon: typeInfo.icon,
    typeLabel: typeInfo.label,
    category: typeInfo.category,
    title: row.title,
    body: row.body,
    data: row.data || {},
    isRead: row.read,
    readAt: row.read_at,
    createdAt: row.created_at,
    // 计算相对时间
    timeAgo: getTimeAgo(row.created_at),
  };
}

/**
 * 计算相对时间
 */
function getTimeAgo(date) {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = Math.floor((now - then) / 1000);
  
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天前`;
  return new Date(date).toLocaleDateString('zh-CN');
}

// ============================================================
// API 路由
// ============================================================

/**
 * GET /api/notifications
 * 获取通知列表（支持分页、筛选）
 * 
 * Query params:
 * - status: all | unread | read (default: all)
 * - type: notification_type (optional)
 * - page: page number (default: 1)
 * - limit: items per page (default: 20, max: 100)
 */
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const status = req.query.status || 'all';
    const type = req.query.type;
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = (page - 1) * limit;

    // 构建查询条件
    const conditions = ['user_id = $1'];
    const values = [userId];
    let paramIndex = 2;

    if (status === 'unread') {
      conditions.push(`read = false`);
    } else if (status === 'read') {
      conditions.push(`read = true`);
    }

    if (type) {
      conditions.push(`notification_type = $${paramIndex++}`);
      values.push(type);
    }

    // 查询通知列表
    const { rows } = await query(
      `SELECT 
        id, notification_type, title, body, data, read, read_at, created_at
       FROM notification_history
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...values, limit, offset]
    );

    // 查询总数
    const { rows: [{ count: total }] } = await query(
      `SELECT COUNT(*) FROM notification_history WHERE ${conditions.join(' AND ')}`,
      values
    );

    // 查询未读数量
    const { rows: [{ count: unreadCount }] } = await query(
      `SELECT COUNT(*) FROM notification_history 
       WHERE user_id = $1 AND read = false`,
      [userId]
    );

    metrics.notificationsFetched.inc({ status });

    res.json(successResp({
      notifications: rows.map(formatNotification),
      pagination: {
        total: parseInt(total),
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
      unreadCount: parseInt(unreadCount),
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/notifications/unread-count
 * 获取未读通知数量（按类型分组）
 */
router.get('/unread-count', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    // 尝试从 Redis 缓存获取
    const cacheKey = `notification:unread:${userId}`;
    const cached = await getJSON(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < 60000) {
      metrics.unreadCountQueries.inc();
      return res.json(successResp(cached.data));
    }

    // 查询数据库
    const { rows } = await query(
      `SELECT 
        notification_type,
        COUNT(*) as count
       FROM notification_history
       WHERE user_id = $1 AND read = false
       GROUP BY notification_type`,
      [userId]
    );

    // 汇总结果
    const result = {
      total: 0,
      byType: {},
    };

    for (const row of rows) {
      result.total += parseInt(row.count);
      result.byType[row.notification_type] = parseInt(row.count);
    }

    // 缓存结果（1 分钟）
    await setJSON(cacheKey, {
      data: result,
      timestamp: Date.now(),
    }, 60);

    metrics.unreadCountQueries.inc();

    res.json(successResp(result));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/notifications/:id/read
 * 标记单条通知为已读
 */
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const notificationId = req.params.id;

    const { rowCount } = await query(
      `UPDATE notification_history
       SET read = true, read_at = NOW()
       WHERE id = $1 AND user_id = $2 AND read = false`,
      [notificationId, userId]
    );

    if (rowCount === 0) {
      throw new AppError(4040, '通知不存在或已读', 404);
    }

    // 清除未读数量缓存
    await del(`notification:unread:${userId}`);

    metrics.notificationsMarkedRead.inc();

    logger.info({ userId, notificationId }, 'Notification marked as read');

    res.json(successResp({ isRead: true }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/batch-read
 * 批量标记已读
 * 
 * Body:
 * - ids: string[] (通知 ID 数组)
 * - all: boolean (标记所有未读)
 */
router.post('/batch-read', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { ids, all } = req.body;

    let updatedCount = 0;

    if (all === true) {
      // 标记所有未读通知为已读
      const { rowCount } = await query(
        `UPDATE notification_history
         SET read = true, read_at = NOW()
         WHERE user_id = $1 AND read = false`,
        [userId]
      );
      updatedCount = rowCount;
    } else if (Array.isArray(ids) && ids.length > 0) {
      // 标记指定通知为已读
      const { rowCount } = await query(
        `UPDATE notification_history
         SET read = true, read_at = NOW()
         WHERE user_id = $1 AND id = ANY($2) AND read = false`,
        [userId, ids]
      );
      updatedCount = rowCount;
    } else {
      throw new AppError(4008, '需要提供 ids 数组或 all=true', 400);
    }

    // 清除未读数量缓存
    await del(`notification:unread:${userId}`);

    metrics.notificationsMarkedRead.inc(updatedCount);

    logger.info({ userId, updatedCount }, 'Notifications batch marked as read');

    res.json(successResp({ updatedCount }));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/notifications/:id
 * 删除单条通知
 */
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const notificationId = req.params.id;

    const { rowCount } = await query(
      `DELETE FROM notification_history
       WHERE id = $1 AND user_id = $2`,
      [notificationId, userId]
    );

    if (rowCount === 0) {
      throw new AppError(4040, '通知不存在', 404);
    }

    // 清除未读数量缓存
    await del(`notification:unread:${userId}`);

    metrics.notificationsDeleted.inc();

    logger.info({ userId, notificationId }, 'Notification deleted');

    res.json(successResp(null, '通知已删除'));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/clear-read
 * 批量删除已读通知
 * 
 * Body:
 * - beforeDate: ISO date string (可选，默认删除所有已读)
 */
router.post('/clear-read', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { beforeDate } = req.body;

    let queryText = `DELETE FROM notification_history WHERE user_id = $1 AND read = true`;
    const values = [userId];

    if (beforeDate) {
      queryText += ` AND created_at < $2`;
      values.push(beforeDate);
    }

    const { rowCount: deletedCount } = await query(queryText, values);

    metrics.notificationsDeleted.inc(deletedCount);

    logger.info({ userId, deletedCount }, 'Read notifications cleared');

    res.json(successResp({ deletedCount }));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/notifications/stats
 * 获取通知统计信息
 */
router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const { rows: [stats] } = await query(
      `SELECT 
        COUNT(*) as total_count,
        COUNT(*) FILTER (WHERE read = false) as unread_count,
        COUNT(*) FILTER (WHERE read = true) as read_count,
        COUNT(*) FILTER (WHERE notification_type = 'RARE_SPAWN') as rare_spawn_count,
        COUNT(*) FILTER (WHERE notification_type = 'RAID_STARTED') as raid_count,
        COUNT(*) FILTER (WHERE notification_type = 'FRIEND_REQUEST') as friend_request_count,
        COUNT(*) FILTER (WHERE notification_type = 'QUEST_COMPLETE') as quest_count,
        COUNT(*) FILTER (WHERE notification_type = 'SYSTEM') as system_count,
        MAX(created_at) as last_notification_at
       FROM notification_history
       WHERE user_id = $1`,
      [userId]
    );

    res.json(successResp({
      total: parseInt(stats.total_count) || 0,
      unread: parseInt(stats.unread_count) || 0,
      read: parseInt(stats.read_count) || 0,
      byType: {
        rareSpawn: parseInt(stats.rare_spawn_count) || 0,
        raid: parseInt(stats.raid_count) || 0,
        friendRequest: parseInt(stats.friend_request_count) || 0,
        quest: parseInt(stats.quest_count) || 0,
        system: parseInt(stats.system_count) || 0,
      },
      lastNotificationAt: stats.last_notification_at,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/notifications/preferences
 * 更新通知偏好设置
 * 
 * Body:
 * - notificationTypes: { [type]: boolean }
 * - quietHours: { enabled: boolean, start: string, end: string }
 */
router.patch('/preferences', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { notificationTypes, quietHours } = req.body;

    // 验证参数
    if (notificationTypes && typeof notificationTypes !== 'object') {
      throw new AppError(4009, 'notificationTypes 必须是对象', 400);
    }

    if (quietHours) {
      if (typeof quietHours !== 'object') {
        throw new AppError(4010, 'quietHours 必须是对象', 400);
      }
      if (quietHours.start && !/^\d{2}:\d{2}$/.test(quietHours.start)) {
        throw new AppError(4011, 'quietHours.start 格式错误，应为 HH:MM', 400);
      }
      if (quietHours.end && !/^\d{2}:\d{2}$/.test(quietHours.end)) {
        throw new AppError(4012, 'quietHours.end 格式错误，应为 HH:MM', 400);
      }
    }

    // 更新偏好设置
    const updates = [];
    const values = [userId];
    let paramIndex = 2;

    if (notificationTypes) {
      updates.push(`notification_types = $${paramIndex++}`);
      values.push(JSON.stringify(notificationTypes));
    }

    if (quietHours) {
      updates.push(`quiet_hours = $${paramIndex++}`);
      values.push(JSON.stringify(quietHours));
    }

    if (updates.length === 0) {
      throw new AppError(4013, '没有提供更新字段', 400);
    }

    updates.push('updated_at = NOW()');

    await query(
      `INSERT INTO user_push_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) 
       DO UPDATE SET ${updates.join(', ')}`,
      values
    );

    logger.info({ userId }, 'Notification preferences updated');

    res.json(successResp({ updated: true }));
  } catch (err) {
    next(err);
  }
});

// 错误处理
router.use(errorHandler);

module.exports = router;
