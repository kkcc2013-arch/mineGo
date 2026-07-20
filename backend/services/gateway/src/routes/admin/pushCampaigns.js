/**
 * 推送活动管理 API 路由（管理员）
 * REQ-00136: FCM/APNs 移动推送通知系统
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { getPushNotificationService } = require('../../../../../shared/pushNotificationService');
const { getClient } = require('../../../../../shared/db');
const logger = require('../../../../../shared/logger');
const adminAuth = require('../middleware/adminAuth');

// 验证模式
const createCampaignSchema = Joi.object({
    name: Joi.string().required(),
    description: Joi.string(),
    notificationType: Joi.string().required(),
    titleTemplate: Joi.string().required(),
    bodyTemplate: Joi.string().required(),
    imageUrl: Joi.string().uri(),
    targetSegment: Joi.string().valid('all', 'active_7d', 'active_30d', 'new_users', 'paying_users'),
    targetUserIds: Joi.array().items(Joi.string().uuid()),
    scheduledAt: Joi.date().min('now')
});

/**
 * 创建推送活动
 * POST /api/admin/push/campaigns
 */
router.post('/campaigns', adminAuth, async (req, res) => {
    try {
        const { error, value } = createCampaignSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.details[0].message });
        }

        const client = await getClient();

        const result = await client.query(
            `INSERT INTO push_campaigns 
             (name, description, notification_type, title_template, body_template, image_url, target_segment, target_user_ids, scheduled_at, status, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'scheduled', $10)
             RETURNING *`,
            [
                value.name,
                value.description,
                value.notificationType,
                value.titleTemplate,
                value.bodyTemplate,
                value.imageUrl,
                value.targetSegment || 'all',
                value.targetUserIds || [],
                value.scheduledAt,
                req.user.id
            ]
        );

        res.json({ success: true, campaign: result.rows[0] });
    } catch (error) {
        logger.error('Create campaign error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取活动列表
 * GET /api/admin/push/campaigns
 */
router.get('/campaigns', adminAuth, async (req, res) => {
    try {
        const { status, limit = 50, offset = 0 } = req.query;
        const client = await getClient();

        let query = 'SELECT * FROM push_campaigns';
        const params = [];

        if (status) {
            query += ' WHERE status = $1';
            params.push(status);
        }

        query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
        params.push(limit, offset);

        const result = await client.query(query, params);

        res.json({ campaigns: result.rows });
    } catch (error) {
        logger.error('Get campaigns error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取活动详情
 * GET /api/admin/push/campaigns/:id
 */
router.get('/campaigns/:id', adminAuth, async (req, res) => {
    try {
        const client = await getClient();

        const result = await client.query(
            'SELECT * FROM push_campaigns WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        res.json({ campaign: result.rows[0] });
    } catch (error) {
        logger.error('Get campaign error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 更新活动
 * PUT /api/admin/push/campaigns/:id
 */
router.put('/campaigns/:id', adminAuth, async (req, res) => {
    try {
        const { error, value } = createCampaignSchema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.details[0].message });
        }

        const client = await getClient();

        const result = await client.query(
            `UPDATE push_campaigns 
             SET name = $1, description = $2, notification_type = $3, title_template = $4, 
                 body_template = $5, image_url = $6, target_segment = $7, target_user_ids = $8, 
                 scheduled_at = $9, updated_at = NOW()
             WHERE id = $10 AND status = 'draft'
             RETURNING *`,
            [
                value.name,
                value.description,
                value.notificationType,
                value.titleTemplate,
                value.bodyTemplate,
                value.imageUrl,
                value.targetSegment || 'all',
                value.targetUserIds || [],
                value.scheduledAt,
                req.params.id
            ]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found or cannot be edited' });
        }

        res.json({ success: true, campaign: result.rows[0] });
    } catch (error) {
        logger.error('Update campaign error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 发送活动推送
 * POST /api/admin/push/campaigns/:id/send
 */
router.post('/campaigns/:id/send', adminAuth, async (req, res) => {
    try {
        const pushService = await getPushNotificationService();
        const result = await pushService.sendCampaignPush(req.params.id);

        res.json({ success: true, result });
    } catch (error) {
        logger.error('Send campaign error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 取消活动
 * POST /api/admin/push/campaigns/:id/cancel
 */
router.post('/campaigns/:id/cancel', adminAuth, async (req, res) => {
    try {
        const client = await getClient();

        const result = await client.query(
            `UPDATE push_campaigns 
             SET status = 'cancelled', updated_at = NOW() 
             WHERE id = $1 AND status IN ('draft', 'scheduled')
             RETURNING *`,
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Campaign not found or cannot be cancelled' });
        }

        res.json({ success: true, campaign: result.rows[0] });
    } catch (error) {
        logger.error('Cancel campaign error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * 获取推送统计
 * GET /api/admin/push/analytics
 */
router.get('/analytics', adminAuth, async (req, res) => {
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

/**
 * 获取推送概览统计
 * GET /api/admin/push/overview
 */
router.get('/overview', adminAuth, async (req, res) => {
    try {
        const client = await getClient();

        // 总设备数
        const devicesResult = await client.query(`
            SELECT 
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE is_active = true) as active,
                COUNT(*) FILTER (WHERE platform = 'ios') as ios,
                COUNT(*) FILTER (WHERE platform = 'android') as android
            FROM device_tokens
        `);

        // 今日推送统计
        const todayResult = await client.query(`
            SELECT 
                COUNT(*) as total_sent,
                COUNT(*) FILTER (WHERE status = 'delivered') as delivered,
                COUNT(*) FILTER (WHERE status = 'opened') as opened,
                COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM push_notifications
            WHERE DATE(created_at) = CURRENT_DATE
        `);

        // 活跃活动数
        const campaignsResult = await client.query(`
            SELECT COUNT(*) as count
            FROM push_campaigns
            WHERE status IN ('scheduled', 'running')
        `);

        res.json({
            devices: devicesResult.rows[0],
            today: todayResult.rows[0],
            activeCampaigns: parseInt(campaignsResult.rows[0].count)
        });
    } catch (error) {
        logger.error('Get overview error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
