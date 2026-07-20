/**
 * 推送通知 API 路由
 * REQ-00136: FCM/APNs 移动推送通知系统
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { getPushNotificationService } = require('../../../../shared/pushNotificationService');
const { getClient } = require('../../../../shared/db');
const logger = require('../../../../shared/logger');
const { authenticate: auth } = require('../../../../shared/authMiddleware');

// 验证模式
const registerDeviceSchema = Joi.object({
    deviceId: Joi.string().required(),
    platform: Joi.string().valid('ios', 'android').required(),
    token: Joi.string().required(),
    appVersion: Joi.string(),
    osVersion: Joi.string(),
    deviceModel: Joi.string()
});

const updatePreferencesSchema = Joi.object({
    globalEnabled: Joi.boolean(),
    quietHoursStart: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/),
    quietHoursEnd: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/),
    timezone: Joi.string(),
    pokemonCatch: Joi.boolean(),
    gymBattle: Joi.boolean(),
    friendRequest: Joi.boolean(),
    giftReceived: Joi.boolean(),
    eventReminder: Joi.boolean(),
    systemAnnouncement: Joi.boolean(),
    marketing: Joi.boolean()
});

/**
 * 注册设备令牌
 * POST /api/push/devices/register
 */
router.post('/devices/register', auth, async (req, res) => {
    try {
        const { error, value } = registerDeviceSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.details[0].message });
        }

        const pushService = await getPushNotificationService();
        const device = await pushService.registerDeviceToken({
            userId: req.user.id,
            ...value
        });

        res.json({ success: true, device });
    } catch (error) {
        logger.error('Register device token error', { error: error.message, userId: req.user?.id });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 注销设备令牌
 * DELETE /api/push/devices/:deviceId
 */
router.delete('/devices/:deviceId', auth, async (req, res) => {
    try {
        const client = await getClient();

        await client.query(
            'UPDATE device_tokens SET is_active = false WHERE user_id = $1 AND device_id = $2',
            [req.user.id, req.params.deviceId]
        );

        res.json({ success: true });
    } catch (error) {
        logger.error('Unregister device token error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取用户设备列表
 * GET /api/push/devices
 */
router.get('/devices', auth, async (req, res) => {
    try {
        const client = await getClient();

        const result = await client.query(
            `SELECT id, device_id, platform, app_version, os_version, device_model, is_active, last_used_at, created_at
             FROM device_tokens 
             WHERE user_id = $1 
             ORDER BY last_used_at DESC`,
            [req.user.id]
        );

        res.json({ devices: result.rows });
    } catch (error) {
        logger.error('Get devices error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取推送偏好
 * GET /api/push/preferences
 */
router.get('/preferences', auth, async (req, res) => {
    try {
        const pushService = await getPushNotificationService();
        const preferences = await pushService.getUserPreferences(req.user.id);

        res.json({ preferences });
    } catch (error) {
        logger.error('Get push preferences error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 更新推送偏好
 * PUT /api/push/preferences
 */
router.put('/preferences', auth, async (req, res) => {
    try {
        const { error, value } = updatePreferencesSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.details[0].message });
        }

        // 转换字段名（camelCase -> snake_case）
        const preferences = {
            global_enabled: value.globalEnabled,
            quiet_hours_start: value.quietHoursStart,
            quiet_hours_end: value.quietHoursEnd,
            timezone: value.timezone,
            pokemon_catch: value.pokemonCatch,
            gym_battle: value.gymBattle,
            friend_request: value.friendRequest,
            gift_received: value.giftReceived,
            event_reminder: value.eventReminder,
            system_announcement: value.systemAnnouncement,
            marketing: value.marketing
        };

        const pushService = await getPushNotificationService();
        const updated = await pushService.updateUserPreferences(req.user.id, preferences);

        res.json({ success: true, preferences: updated });
    } catch (error) {
        logger.error('Update push preferences error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 发送测试推送
 * POST /api/push/test
 */
router.post('/test', auth, async (req, res) => {
    try {
        const pushService = await getPushNotificationService();
        const result = await pushService.sendPush({
            userId: req.user.id,
            type: 'system_announcement',
            title: '测试推送',
            body: '这是一条测试推送通知',
            data: { test: true, userId: req.user.id }
        });

        res.json({ success: result.success, result });
    } catch (error) {
        logger.error('Send test push error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取推送历史
 * GET /api/push/history
 */
router.get('/history', auth, async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const client = await getClient();

        const result = await client.query(
            `SELECT id, notification_type, title, body, status, sent_at, delivered_at, opened_at, created_at
             FROM push_notifications 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2 OFFSET $3`,
            [req.user.id, limit, offset]
        );

        res.json({ notifications: result.rows });
    } catch (error) {
        logger.error('Get push history error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 标记推送已打开
 * POST /api/push/:id/opened
 */
router.post('/:id/opened', auth, async (req, res) => {
    try {
        const client = await getClient();

        const result = await client.query(
            'UPDATE push_notifications SET opened_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id',
            [req.params.id, req.user.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Notification not found' });
        }

        res.json({ success: true });
    } catch (error) {
        logger.error('Mark push opened error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取推送统计
 * GET /api/push/analytics
 */
router.get('/analytics', auth, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const pushService = await getPushNotificationService();
        const analytics = await pushService.getAnalytics(startDate, endDate);

        res.json({ analytics });
    } catch (error) {
        logger.error('Get analytics error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
