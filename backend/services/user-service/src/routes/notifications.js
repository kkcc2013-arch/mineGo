// user-service/src/routes/notifications.js
// User notification preferences and history API - REQ-00026
'use strict';

const express = require('express');
const { query } = require('../../../shared/db');
const { requireAuth, AppError, successResp } = require('../../../shared/auth');
const { createLogger } = require('../../../shared/logger');
const { publishEvent } = require('../../../shared/EventBus');

const router = express.Router();
const logger = createLogger('notification-routes');

// ============================================================
// Notification Types
// ============================================================
const NOTIFICATION_TYPES = {
  RARE_SPAWN: 'RARE_SPAWN',
  RAID_STARTED: 'RAID_STARTED',
  FRIEND_REQUEST: 'FRIEND_REQUEST',
  GIFT_RECEIVED: 'GIFT_RECEIVED',
  QUEST_COMPLETE: 'QUEST_COMPLETE',
  GYM_UNDER_ATTACK: 'GYM_UNDER_ATTACK',
  GYM_LOST: 'GYM_LOST',
};

// ============================================================
// GET /v1/users/me/notification-preferences
// ============================================================
router.get('/preferences', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const { rows: [prefs] } = await query(`
      SELECT * FROM user_notification_preferences WHERE user_id = $1
    `, [userId]);

    if (!prefs) {
      // Create default preferences if not exists
      await query(`
        INSERT INTO user_notification_preferences (user_id)
        VALUES ($1)
        ON CONFLICT (user_id) DO NOTHING
      `, [userId]);

      const { rows: [newPrefs] } = await query(`
        SELECT * FROM user_notification_preferences WHERE user_id = $1
      `, [userId]);

      return res.json(successResp(newPrefs));
    }

    res.json(successResp(prefs));
  } catch (err) {
    logger.error({ err, userId: req.user.sub }, 'Failed to get notification preferences');
    next(err);
  }
});

// ============================================================
// PUT /v1/users/me/notification-preferences
// ============================================================
router.put('/preferences', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const updates = req.body;

    // Validate fields
    const validFields = [
      'rare_spawn', 'raid_started', 'friend_request', 'gift_received',
      'quest_complete', 'gym_under_attack', 'gym_lost',
      'sound_enabled', 'vibration_enabled'
    ];

    const fields = [];
    const values = [userId];
    let paramIndex = 2;

    for (const [key, value] of Object.entries(updates)) {
      if (validFields.includes(key) && typeof value === 'boolean') {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }

    if (fields.length === 0) {
      throw new AppError(4001, 'No valid fields to update', 400);
    }

    const queryStr = `
      INSERT INTO user_notification_preferences (user_id, ${validFields.filter(f => updates[f] !== undefined).join(', ')})
      VALUES ($1, ${values.slice(1).map((_, i) => `$${i + 2}`).join(', ')})
      ON CONFLICT (user_id) 
      DO UPDATE SET ${fields.join(', ')}, updated_at = NOW()
      RETURNING *
    `;

    // Simpler approach: upsert with all fields
    const upsertQuery = `
      INSERT INTO user_notification_preferences (
        user_id, rare_spawn, raid_started, friend_request, gift_received,
        quest_complete, gym_under_attack, gym_lost, sound_enabled, vibration_enabled
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (user_id)
      DO UPDATE SET
        rare_spawn = EXCLUDED.rare_spawn,
        raid_started = EXCLUDED.raid_started,
        friend_request = EXCLUDED.friend_request,
        gift_received = EXCLUDED.gift_received,
        quest_complete = EXCLUDED.quest_complete,
        gym_under_attack = EXCLUDED.gym_under_attack,
        gym_lost = EXCLUDED.gym_lost,
        sound_enabled = EXCLUDED.sound_enabled,
        vibration_enabled = EXCLUDED.vibration_enabled,
        updated_at = NOW()
      RETURNING *
    `;

    const { rows: [prefs] } = await query(upsertQuery, [
      userId,
      updates.rare_spawn ?? true,
      updates.raid_started ?? true,
      updates.friend_request ?? true,
      updates.gift_received ?? true,
      updates.quest_complete ?? true,
      updates.gym_under_attack ?? true,
      updates.gym_lost ?? false,
      updates.sound_enabled ?? true,
      updates.vibration_enabled ?? true,
    ]);

    logger.info({ userId, updates }, 'Notification preferences updated');
    res.json(successResp(prefs));
  } catch (err) {
    logger.error({ err, userId: req.user.sub }, 'Failed to update notification preferences');
    next(err);
  }
});

// ============================================================
// GET /v1/users/me/notifications
// Query params: limit (default 50), unread_only (default false)
// ============================================================
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const unreadOnly = req.query.unread_only === 'true';

    let queryStr = `
      SELECT id, type, data, read, created_at
      FROM notification_history
      WHERE user_id = $1
    `;
    const values = [userId];

    if (unreadOnly) {
      queryStr += ' AND read = FALSE';
    }

    queryStr += ` ORDER BY created_at DESC LIMIT $2`;
    values.push(limit);

    const { rows: notifications } = await query(queryStr, values);

    res.json(successResp({
      notifications,
      total: notifications.length,
      hasMore: notifications.length === limit,
    }));
  } catch (err) {
    logger.error({ err, userId: req.user.sub }, 'Failed to get notification history');
    next(err);
  }
});

// ============================================================
// PUT /v1/users/me/notifications/:id/read
// Mark a single notification as read
// ============================================================
router.put('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const notificationId = req.params.id;

    const { rowCount } = await query(`
      UPDATE notification_history
      SET read = TRUE
      WHERE id = $1 AND user_id = $2
    `, [notificationId, userId]);

    if (rowCount === 0) {
      throw new AppError(4002, 'Notification not found', 404);
    }

    res.json(successResp({ id: notificationId, read: true }));
  } catch (err) {
    logger.error({ err, userId: req.user.sub, notificationId: req.params.id }, 'Failed to mark notification as read');
    next(err);
  }
});

// ============================================================
// PUT /v1/users/me/notifications/read-all
// Mark all notifications as read
// ============================================================
router.put('/read-all', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;

    const { rowCount } = await query(`
      UPDATE notification_history
      SET read = TRUE
      WHERE user_id = $1 AND read = FALSE
    `, [userId]);

    logger.info({ userId, count: rowCount }, 'All notifications marked as read');
    res.json(successResp({ updatedCount: rowCount }));
  } catch (err) {
    logger.error({ err, userId: req.user.sub }, 'Failed to mark all notifications as read');
    next(err);
  }
});

// ============================================================
// DELETE /v1/users/me/notifications/:id
// Delete a single notification
// ============================================================
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const notificationId = req.params.id;

    const { rowCount } = await query(`
      DELETE FROM notification_history
      WHERE id = $1 AND user_id = $2
    `, [notificationId, userId]);

    if (rowCount === 0) {
      throw new AppError(4002, 'Notification not found', 404);
    }

    res.json(successResp({ deleted: true }));
  } catch (err) {
    logger.error({ err, userId: req.user.sub, notificationId: req.params.id }, 'Failed to delete notification');
    next(err);
  }
});

// ============================================================
// Internal API: Create notification
// Called by other services via EventBus
// ============================================================
async function createNotification(userId, type, data) {
  try {
    // Check user preferences
    const { rows: [prefs] } = await query(`
      SELECT * FROM user_notification_preferences WHERE user_id = $1
    `, [userId]);

    // Map type to preference field
    const typeToPref = {
      RARE_SPAWN: 'rare_spawn',
      RAID_STARTED: 'raid_started',
      FRIEND_REQUEST: 'friend_request',
      GIFT_RECEIVED: 'gift_received',
      QUEST_COMPLETE: 'quest_complete',
      GYM_UNDER_ATTACK: 'gym_under_attack',
      GYM_LOST: 'gym_lost',
    };

    const prefField = typeToPref[type];
    if (prefField && prefs && prefs[prefField] === false) {
      logger.debug({ userId, type }, 'Notification disabled by user preference');
      return null;
    }

    // Insert notification
    const { rows: [notification] } = await query(`
      INSERT INTO notification_history (user_id, type, data)
      VALUES ($1, $2, $3)
      RETURNING id, type, data, read, created_at
    `, [userId, type, JSON.stringify(data)]);

    logger.info({ userId, type, notificationId: notification.id }, 'Notification created');

    // Publish to WebSocket via EventBus
    if (publishEvent) {
      publishEvent('notification.created', {
        userId,
        notification: {
          id: notification.id,
          type,
          data,
          timestamp: notification.created_at,
        },
      });
    }

    return notification;
  } catch (err) {
    logger.error({ err, userId, type }, 'Failed to create notification');
    return null;
  }
}

// ============================================================
// Export
// ============================================================
module.exports = {
  router,
  createNotification,
  NOTIFICATION_TYPES,
};
