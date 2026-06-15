/**
 * FCM/APNs 移动推送通知服务
 * REQ-00136
 * 
 * 功能：
 * - FCM (Firebase Cloud Messaging) 推送
 * - APNs (Apple Push Notification Service) 推送
 * - 设备令牌管理
 * - 用户推送偏好管理
 * - 推送活动管理
 * - 推送统计分析
 */

const admin = require('firebase-admin');
const { getClient } = require('./db');
const { getRedisClient } = require('./redis');
const logger = require('./logger');
const { incrementCounter, observeHistogram, pushNotificationsSentTotal, pushNotificationsErrorsTotal, pushNotificationDurationSeconds, deviceTokensTotal, pushCampaignsActive } = require('./metrics');

class PushNotificationService {
    constructor() {
        this.fcmApp = null;
        this.initialized = false;
    }

    /**
     * 初始化 Firebase Admin SDK
     */
    async initialize() {
        try {
            // 检查环境变量
            if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PRIVATE_KEY) {
                logger.warn('Firebase credentials not configured, push notifications will be disabled');
                return;
            }

            // 初始化 Firebase Admin
            this.fcmApp = admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
                })
            }, 'push-notification-app');

            this.initialized = true;
            logger.info('PushNotificationService initialized', { fcm: !!this.fcmApp });
        } catch (error) {
            logger.error('Failed to initialize PushNotificationService', { error: error.message });
            this.initialized = false;
        }
    }

    /**
     * 发送推送通知
     * @param {Object} params - 推送参数
     * @returns {Promise<Object>} 发送结果
     */
    async sendPush(params) {
        const { userId, type, title, body, data = {}, image, priority = 'normal' } = params;

        if (!this.initialized) {
            logger.warn('PushNotificationService not initialized, skipping push notification');
            return { success: false, reason: 'service_not_initialized' };
        }

        const startTime = Date.now();

        try {
            // 获取用户设备令牌
            const deviceTokens = await this.getActiveDeviceTokens(userId);

            if (deviceTokens.length === 0) {
                logger.warn('No active device tokens found', { userId, type });
                return { success: false, reason: 'no_device_tokens' };
            }

            // 获取用户推送偏好
            const preferences = await this.getUserPreferences(userId);
            if (!preferences.global_enabled || !this.isTypeEnabled(preferences, type)) {
                logger.info('Push notification disabled by user preferences', { userId, type });
                return { success: false, reason: 'disabled_by_preferences' };
            }

            // 检查静默时段
            if (this.isQuietHours(preferences)) {
                logger.info('Push notification in quiet hours, scheduling for later', { userId, type });
                return await this.scheduleForLater(params, preferences);
            }

            // 发送到所有设备
            const results = await Promise.allSettled(
                deviceTokens.map(device => this.sendToDevice(device, { title, body, data, image, priority }))
            );

            // 统计结果
            const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
            const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;

            // 记录通知
            await this.recordNotification({
                userId,
                deviceTokens,
                type,
                title,
                body,
                data,
                image,
                priority,
                status: successful > 0 ? 'sent' : 'failed',
                results
            });

            // 更新指标
            if (pushNotificationsSentTotal) {
                pushNotificationsSentTotal.inc({ type, status: successful > 0 ? 'success' : 'failed' });
            }
            if (pushNotificationDurationSeconds) {
                pushNotificationDurationSeconds.observe({ type }, (Date.now() - startTime) / 1000);
            }

            logger.info('Push notification sent', {
                userId,
                type,
                devices: deviceTokens.length,
                successful,
                failed,
                duration: Date.now() - startTime
            });

            return {
                success: successful > 0,
                sent: successful,
                failed,
                totalDevices: deviceTokens.length
            };

        } catch (error) {
            logger.error('Push notification error', { userId, type, error: error.message });
            if (pushNotificationsErrorsTotal) {
                pushNotificationsErrorsTotal.inc({ type, error: error.constructor.name });
            }
            throw error;
        }
    }

    /**
     * 发送到单个设备
     */
    async sendToDevice(device, payload) {
        const { platform, token } = device;
        const { title, body, data, image, priority } = payload;

        try {
            // 使用 FCM 发送（iOS 和 Android 都支持）
            const message = {
                token,
                notification: {
                    title,
                    body,
                    image
                },
                data: this.formatData(data),
                android: platform === 'android' ? {
                    priority: priority === 'high' ? 'high' : 'normal',
                    notification: {
                        channelId: this.getChannelId(data.type),
                        sound: 'default',
                        icon: 'ic_notification',
                        color: '#FF6B6B'
                    }
                } : undefined,
                apns: platform === 'ios' ? {
                    payload: {
                        aps: {
                            alert: { title, body },
                            sound: 'default',
                            badge: await this.getUnreadCount(data.userId)
                        }
                    }
                } : undefined
            };

            const response = await admin.messaging().send(message);
            return { success: true, messageId: response, platform };

        } catch (error) {
            logger.error('Send to device failed', { platform, token: token.substring(0, 10), error: error.message });

            // 处理无效令牌
            if (error.code === 'messaging/registration-token-not-registered' ||
                error.code === 'messaging/invalid-registration-token') {
                await this.deactivateDeviceToken(token);
            }

            return { success: false, error: error.message, platform };
        }
    }

    /**
     * 批量发送推送通知
     */
    async sendBatch(notifications) {
        const results = [];

        for (const notification of notifications) {
            try {
                const result = await this.sendPush(notification);
                results.push({ notification, result });
            } catch (error) {
                results.push({ notification, result: { success: false, error: error.message } });
            }
        }

        return results;
    }

    /**
     * 发送活动推送
     */
    async sendCampaignPush(campaignId) {
        const client = await getClient();

        try {
            // 获取活动信息
            const campaignResult = await client.query(
                'SELECT * FROM push_campaigns WHERE id = $1 AND status = $2',
                [campaignId, 'scheduled']
            );

            if (campaignResult.rows.length === 0) {
                throw new Error('Campaign not found or not scheduled');
            }

            const campaignData = campaignResult.rows[0];

            // 更新状态为运行中
            await client.query(
                'UPDATE push_campaigns SET status = $1, started_at = NOW() WHERE id = $2',
                ['running', campaignId]
            );

            // 获取目标用户
            const targetUsers = await this.getCampaignTargets(campaignData);
            let sentCount = 0;
            let deliveredCount = 0;
            let failedCount = 0;

            // 分批发送
            const batchSize = 100;
            for (let i = 0; i < targetUsers.length; i += batchSize) {
                const batch = targetUsers.slice(i, i + batchSize);

                for (const userId of batch) {
                    try {
                        const result = await this.sendPush({
                            userId,
                            type: campaignData.notification_type,
                            title: campaignData.title_template,
                            body: campaignData.body_template,
                            image: campaignData.image_url,
                            data: { campaignId }
                        });

                        if (result.success) {
                            sentCount += result.sent;
                            deliveredCount += result.sent;
                        } else {
                            failedCount++;
                        }
                    } catch (error) {
                        failedCount++;
                    }
                }

                // 更新进度
                await client.query(
                    `UPDATE push_campaigns 
                     SET sent_count = $1, delivered_count = $2, failed_count = $3 
                     WHERE id = $4`,
                    [sentCount, deliveredCount, failedCount, campaignId]
                );
            }

            // 完成活动
            await client.query(
                `UPDATE push_campaigns 
                 SET status = 'completed', completed_at = NOW(),
                     sent_count = $1, delivered_count = $2, failed_count = $3,
                     total_targets = $4
                 WHERE id = $5`,
                [sentCount, deliveredCount, failedCount, targetUsers.length, campaignId]
            );

            logger.info('Campaign completed', {
                campaignId,
                totalTargets: targetUsers.length,
                sent: sentCount,
                delivered: deliveredCount,
                failed: failedCount
            });

            return {
                success: true,
                totalTargets: targetUsers.length,
                sent: sentCount,
                delivered: deliveredCount,
                failed: failedCount
            };

        } finally {
            client.release();
        }
    }

    /**
     * 获取活跃设备令牌
     */
    async getActiveDeviceTokens(userId) {
        const client = await getClient();

        try {
            const result = await client.query(
                `SELECT id, device_id, platform, token 
                 FROM device_tokens 
                 WHERE user_id = $1 AND is_active = true
                 ORDER BY last_used_at DESC NULLS LAST`,
                [userId]
            );

            return result.rows;
        } finally {
            client.release();
        }
    }

    /**
     * 注册设备令牌
     */
    async registerDeviceToken(params) {
        const { userId, deviceId, platform, token, appVersion, osVersion, deviceModel } = params;
        const client = await getClient();

        try {
            const result = await client.query(
                `INSERT INTO device_tokens (user_id, device_id, platform, token, app_version, os_version, device_model, last_used_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                 ON CONFLICT (user_id, device_id) 
                 DO UPDATE SET 
                     token = EXCLUDED.token,
                     app_version = EXCLUDED.app_version,
                     os_version = EXCLUDED.os_version,
                     device_model = EXCLUDED.device_model,
                     is_active = true,
                     last_used_at = NOW(),
                     updated_at = NOW()
                 RETURNING *`,
                [userId, deviceId, platform, token, appVersion, osVersion, deviceModel]
            );

            logger.info('Device token registered', { userId, deviceId, platform });

            return result.rows[0];
        } finally {
            client.release();
        }
    }

    /**
     * 停用设备令牌
     */
    async deactivateDeviceToken(token) {
        const client = await getClient();

        try {
            await client.query(
                `UPDATE device_tokens SET is_active = false, updated_at = NOW() WHERE token = $1`,
                [token]
            );

            logger.info('Device token deactivated', { token: token.substring(0, 10) });
        } finally {
            client.release();
        }
    }

    /**
     * 获取用户推送偏好
     */
    async getUserPreferences(userId) {
        const client = await getClient();

        try {
            let result = await client.query(
                'SELECT * FROM push_preferences WHERE user_id = $1',
                [userId]
            );

            if (result.rows.length === 0) {
                // 创建默认偏好
                result = await client.query(
                    `INSERT INTO push_preferences (user_id) 
                     VALUES ($1) 
                     RETURNING *`,
                    [userId]
                );
            }

            return result.rows[0];
        } finally {
            client.release();
        }
    }

    /**
     * 更新用户推送偏好
     */
    async updateUserPreferences(userId, preferences) {
        const client = await getClient();

        try {
            const fields = Object.keys(preferences).filter(k => preferences[k] !== undefined);
            const values = [userId, ...fields.map(f => preferences[f])];
            const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');

            const result = await client.query(
                `UPDATE push_preferences 
                 SET ${setClause}, updated_at = NOW() 
                 WHERE user_id = $1 
                 RETURNING *`,
                values
            );

            return result.rows[0];
        } finally {
            client.release();
        }
    }

    /**
     * 检查推送类型是否启用
     */
    isTypeEnabled(preferences, type) {
        const typeMapping = {
            'pokemon_catch': 'pokemon_catch',
            'gym_battle': 'gym_battle',
            'friend_request': 'friend_request',
            'gift_received': 'gift_received',
            'event_reminder': 'event_reminder',
            'system_announcement': 'system_announcement',
            'marketing': 'marketing'
        };

        const prefKey = typeMapping[type];
        return prefKey ? (preferences[prefKey] !== false) : true;
    }

    /**
     * 检查是否在静默时段
     */
    isQuietHours(preferences) {
        if (!preferences || !preferences.quiet_hours_start || !preferences.quiet_hours_end) {
            return false;
        }

        try {
            const now = new Date();
            const timezone = preferences.timezone || 'UTC';
            const userTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
            const currentTime = userTime.getHours() * 60 + userTime.getMinutes();

            const [startHour, startMin] = preferences.quiet_hours_start.split(':').map(Number);
            const [endHour, endMin] = preferences.quiet_hours_end.split(':').map(Number);

            const startMinutes = startHour * 60 + startMin;
            const endMinutes = endHour * 60 + endMin;

            if (startMinutes > endMinutes) {
                // 跨越午夜
                return currentTime >= startMinutes || currentTime < endMinutes;
            } else {
                return currentTime >= startMinutes && currentTime < endMinutes;
            }
        } catch (error) {
            logger.error('Error checking quiet hours', { error: error.message });
            return false;
        }
    }

    /**
     * 延迟调度推送
     */
    async scheduleForLater(params, preferences) {
        const redis = getRedisClient();
        const scheduledTime = this.getNextActiveTime(preferences);

        await redis.zadd(
            'scheduled_push_notifications',
            scheduledTime.getTime(),
            JSON.stringify({ ...params, scheduledAt: scheduledTime.toISOString() })
        );

        return { success: true, scheduled: true, scheduledAt: scheduledTime };
    }

    /**
     * 获取下一个活跃时间
     */
    getNextActiveTime(preferences) {
        const now = new Date();
        const [endHour, endMin] = preferences.quiet_hours_end.split(':').map(Number);

        const nextTime = new Date(now.toLocaleString('en-US', { timeZone: preferences.timezone || 'UTC' }));
        nextTime.setHours(endHour, endMin, 0, 0);

        if (nextTime <= now) {
            nextTime.setDate(nextTime.getDate() + 1);
        }

        return nextTime;
    }

    /**
     * 获取未读计数
     */
    async getUnreadCount(userId) {
        const client = await getClient();

        try {
            const result = await client.query(
                'SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND is_read = false',
                [userId]
            );

            return parseInt(result.rows[0].count, 10);
        } catch (error) {
            return 0;
        } finally {
            client.release();
        }
    }

    /**
     * 格式化数据载荷
     */
    formatData(data) {
        const formatted = {};
        for (const [key, value] of Object.entries(data || {})) {
            formatted[key] = String(value);
        }
        return formatted;
    }

    /**
     * 获取渠道 ID
     */
    getChannelId(type) {
        const channelMapping = {
            'pokemon_catch': 'catches',
            'gym_battle': 'battles',
            'friend_request': 'social',
            'gift_received': 'social',
            'event_reminder': 'events',
            'system_announcement': 'system',
            'marketing': 'marketing'
        };

        return channelMapping[type] || 'general';
    }

    /**
     * 记录通知
     */
    async recordNotification(params) {
        const client = await getClient();

        try {
            const { userId, deviceTokens, type, title, body, data, image, priority, status, results } = params;

            for (const device of deviceTokens) {
                const result = results.find(r => r.status === 'fulfilled' && r.value && r.value.platform === device.platform);

                await client.query(
                    `INSERT INTO push_notifications 
                     (user_id, device_token_id, notification_type, title, body, data, image_url, priority, status, sent_at, fcm_message_id)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
                    [
                        userId,
                        device.id,
                        type,
                        title,
                        body,
                        JSON.stringify(data),
                        image,
                        priority,
                        status,
                        result?.value?.messageId || null
                    ]
                );
            }
        } finally {
            client.release();
        }
    }

    /**
     * 获取活动目标用户
     */
    async getCampaignTargets(campaign) {
        const client = await getClient();

        try {
            if (campaign.target_user_ids && campaign.target_user_ids.length > 0) {
                return campaign.target_user_ids;
            }

            // 基于分段查询用户
            const segmentQueries = {
                'all': 'SELECT id FROM users WHERE is_active = true',
                'active_7d': "SELECT id FROM users WHERE last_login_at > NOW() - INTERVAL '7 days'",
                'active_30d': "SELECT id FROM users WHERE last_login_at > NOW() - INTERVAL '30 days'",
                'new_users': "SELECT id FROM users WHERE created_at > NOW() - INTERVAL '7 days'",
                'paying_users': "SELECT DISTINCT user_id as id FROM payments WHERE status = 'completed'"
            };

            const query = segmentQueries[campaign.target_segment] || segmentQueries['all'];
            const result = await client.query(query);

            return result.rows.map(r => r.id);
        } finally {
            client.release();
        }
    }

    /**
     * 获取推送统计
     */
    async getAnalytics(startDate, endDate) {
        const client = await getClient();

        try {
            const result = await client.query(
                `SELECT 
                    date,
                    total_sent,
                    total_delivered,
                    total_opened,
                    total_failed,
                    ios_sent,
                    android_sent,
                    by_type,
                    avg_delivery_time_ms
                 FROM push_analytics 
                 WHERE date BETWEEN $1 AND $2 
                 ORDER BY date`,
                [startDate, endDate]
            );

            return result.rows;
        } finally {
            client.release();
        }
    }

    /**
     * 更新每日统计
     */
    async updateDailyAnalytics() {
        const client = await getClient();

        try {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateStr = yesterday.toISOString().split('T')[0];

            await client.query(
                `INSERT INTO push_analytics (date, total_sent, total_delivered, total_opened, total_failed, ios_sent, android_sent, by_type, avg_delivery_time_ms)
                 SELECT 
                     DATE(created_at) as date,
                     COUNT(CASE WHEN status IN ('sent', 'delivered', 'opened') THEN 1 END) as total_sent,
                     COUNT(CASE WHEN status IN ('delivered', 'opened') THEN 1 END) as total_delivered,
                     COUNT(CASE WHEN status = 'opened' THEN 1 END) as total_opened,
                     COUNT(CASE WHEN status = 'failed' THEN 1 END) as total_failed,
                     COUNT(CASE WHEN status IN ('sent', 'delivered', 'opened') AND dt.platform = 'ios' THEN 1 END) as ios_sent,
                     COUNT(CASE WHEN status IN ('sent', 'delivered', 'opened') AND dt.platform = 'android' THEN 1 END) as android_sent,
                     '{}'::jsonb as by_type,
                     AVG(EXTRACT(EPOCH FROM (delivered_at - sent_at)) * 1000)::INTEGER as avg_delivery_time_ms
                 FROM push_notifications pn
                 LEFT JOIN device_tokens dt ON pn.device_token_id = dt.id
                 WHERE DATE(created_at) = $1
                 GROUP BY DATE(created_at)
                 ON CONFLICT (date) DO UPDATE SET 
                     total_sent = EXCLUDED.total_sent,
                     total_delivered = EXCLUDED.total_delivered,
                     total_opened = EXCLUDED.total_opened,
                     total_failed = EXCLUDED.total_failed,
                     ios_sent = EXCLUDED.ios_sent,
                     android_sent = EXCLUDED.android_sent,
                     by_type = EXCLUDED.by_type,
                     avg_delivery_time_ms = EXCLUDED.avg_delivery_time_ms`,
                [dateStr]
            );

            logger.info('Daily analytics updated', { date: dateStr });
        } finally {
            client.release();
        }
    }
}

// 单例实例
let pushNotificationService = null;

async function getPushNotificationService() {
    if (!pushNotificationService) {
        pushNotificationService = new PushNotificationService();
        await pushNotificationService.initialize();
    }
    return pushNotificationService;
}

module.exports = {
    PushNotificationService,
    getPushNotificationService
};
