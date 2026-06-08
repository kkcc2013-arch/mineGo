// backend/services/user-service/src/routes/notifications.js
'use strict';

const { Router } = require('express');
const { query, transaction } = require('../../../../shared/db');
const { requireAuth, AppError, successResp, errorHandler } = require('../../../../shared/auth');
const { createLogger } = require('../../../../shared/logger');

const logger = createLogger('user-service:notifications');
const router = Router();

/**
 * GET /api/notifications/preferences
 * 获取用户推送偏好
 */
router.get('/preferences', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const { rows: [prefs] } = await query(
      `SELECT 
        preferred_channels, 
        notification_types, 
        quiet_hours,
        CASE WHEN fcm_token IS NOT NULL THEN true ELSE false END as has_fcm_token,
        CASE WHEN apns_token IS NOT NULL THEN true ELSE false END as has_apns_token
       FROM user_push_preferences 
       WHERE user_id = $1`,
      [userId]
    );

    if (!prefs) {
      // 创建默认偏好
      await query(
        `INSERT INTO user_push_preferences (user_id) VALUES ($1)`,
        [userId]
      );
      
      return res.json(successResp({
        preferredChannels: ['websocket', 'fcm', 'apns'],
        notificationTypes: {
          gym_raid: true,
          friend_request: true,
          trade_request: true,
          reward: true,
          system: true,
        },
        quietHours: { enabled: false, start: '22:00', end: '08:00' },
        hasFcmToken: false,
        hasApnsToken: false,
      }));
    }

    res.json(successResp({
      preferredChannels: prefs.preferred_channels,
      notificationTypes: prefs.notification_types,
      quietHours: prefs.quiet_hours,
      hasFcmToken: prefs.has_fcm_token,
      hasApnsToken: prefs.has_apns_token,
    }));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/preferences
 * 更新用户推送偏好
 */
router.post('/preferences', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { preferredChannels, notificationTypes, quietHours } = req.body;

    // 验证参数
    if (preferredChannels && !Array.isArray(preferredChannels)) {
      throw new AppError(4001, 'preferredChannels 必须是数组', 400);
    }

    if (notificationTypes && typeof notificationTypes !== 'object') {
      throw new AppError(4002, 'notificationTypes 必须是对象', 400);
    }

    if (quietHours && typeof quietHours !== 'object') {
      throw new AppError(4003, 'quietHours 必须是对象', 400);
    }

    // 构造更新语句
    const updates = [];
    const values = [userId];
    let paramIndex = 2;

    if (preferredChannels) {
      updates.push(`preferred_channels = $${paramIndex++}`);
      values.push(preferredChannels);
    }

    if (notificationTypes) {
      updates.push(`notification_types = $${paramIndex++}`);
      values.push(JSON.stringify(notificationTypes));
    }

    if (quietHours) {
      updates.push(`quiet_hours = $${paramIndex++}`);
      values.push(JSON.stringify(quietHours));
    }

    if (updates.length === 0) {
      throw new AppError(4004, '没有提供更新字段', 400);
    }

    updates.push('updated_at = NOW()');

    await query(
      `INSERT INTO user_push_preferences (user_id, preferred_channels, notification_types, quiet_hours)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) 
       DO UPDATE SET ${updates.join(', ')}`,
      values.length === 2 
        ? [...values, preferredChannels || ['websocket', 'fcm', 'apns'], notificationTypes || {}, quietHours || {}]
        : values
    );

    logger.info({ userId }, 'Push preferences updated');

    res.json(successResp(null, '推送偏好已更新'));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/notifications/device-token
 * 注册设备推送 Token
 */
router.post('/device-token', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { platform, token } = req.body;

    if (!platform || !token) {
      throw new AppError(4005, 'platform 和 token 是必需字段', 400);
    }

    if (!['ios', 'android'].includes(platform)) {
      throw new AppError(4006, 'platform 必须是 ios 或 android', 400);
    }

    // 确保用户有推送偏好记录
    await query(
      `INSERT INTO user_push_preferences (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    // 更新对应平台的 token
    const tokenField = platform === 'ios' ? 'apns_token' : 'fcm_token';
    
    await query(
      `UPDATE user_push_preferences 
       SET ${tokenField} = $2, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, token]
    );

    logger.info({ userId, platform }, 'Device token registered');

    res.json(successResp(null, '设备 Token 注册成功'));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/notifications/device-token
 * 注销设备推送 Token（用户登出时调用）
 */
router.delete('/device-token', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { platform } = req.body;

    if (!platform) {
      throw new AppError(4007, 'platform 是必需字段', 400);
    }

    const tokenField = platform === 'ios' ? 'apns_token' : 'fcm_token';
    
    await query(
      `UPDATE user_push_preferences 
       SET ${tokenField} = NULL, updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    logger.info({ userId, platform }, 'Device token removed');

    res.json(successResp(null, '设备 Token 已注销'));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/notifications/logs
 * 获取推送日志（最近 50 条）
 */
router.get('/logs', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const { rows } = await query(
      `SELECT 
        channel, 
        notification_type, 
        title, 
        body, 
        success, 
        error_message,
        created_at
       FROM push_logs 
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    res.json(successResp(rows));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
