# REQ-00136: FCM/APNs 移动推送通知系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00136 |
| 标题 | FCM/APNs 移动推送通知系统 |
| 类别 | 功能增强 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | user-service、reward-service、gateway、game-client、Firebase、Apple Developer |
| 创建时间 | 2026-06-12 00:00 |

## 需求描述

实现完整的移动端推送通知系统，支持 Firebase Cloud Messaging (FCM) 和 Apple Push Notification Service (APNs) 双平台推送。该系统将实现：

1. **多场景推送通知**：精灵捕捉成功、道馆战斗结果、好友请求、活动提醒、系统公告等
2. **用户偏好管理**：允许用户自定义推送通知开关和频率
3. **智能推送策略**：基于用户活跃度、时区、推送历史优化推送时机
4. **推送统计分析**：送达率、打开率、转化率追踪

此系统填补"未覆盖高价值缺口"中的推送通知功能（游戏内通知已实现 REQ-00026，多渠道插件已实现 REQ-00032，但缺少 FCM/APNs 实际推送）。

## 技术方案

### 1. 数据库设计

```sql
-- device_tokens 表：用户设备令牌
CREATE TABLE device_tokens (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id VARCHAR(64) NOT NULL,
    platform VARCHAR(20) NOT NULL CHECK (platform IN ('ios', 'android')),
    token TEXT NOT NULL,
    app_version VARCHAR(20),
    os_version VARCHAR(20),
    device_model VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, device_id),
    INDEX idx_device_tokens_user (user_id),
    INDEX idx_device_tokens_token (token)
);

-- push_notifications 表：推送通知记录
CREATE TABLE push_notifications (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_token_id INTEGER REFERENCES device_tokens(id),
    notification_type VARCHAR(50) NOT NULL,
    title VARCHAR(100) NOT NULL,
    body TEXT NOT NULL,
    data JSONB DEFAULT '{}',
    image_url TEXT,
    priority VARCHAR(20) DEFAULT 'normal' CHECK (priority IN ('high', 'normal')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'failed', 'cancelled')),
    fcm_message_id VARCHAR(100),
    apns_apns_id VARCHAR(100),
    sent_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    opened_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_push_notifications_user (user_id),
    INDEX idx_push_notifications_status (status),
    INDEX idx_push_notifications_type (notification_type),
    INDEX idx_push_notifications_created (created_at)
);

-- push_preferences 表：用户推送偏好
CREATE TABLE push_preferences (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    global_enabled BOOLEAN DEFAULT true,
    quiet_hours_start TIME DEFAULT '22:00',
    quiet_hours_end TIME DEFAULT '08:00',
    timezone VARCHAR(50) DEFAULT 'UTC',
    pokemon_catch BOOLEAN DEFAULT true,
    gym_battle BOOLEAN DEFAULT true,
    friend_request BOOLEAN DEFAULT true,
    gift_received BOOLEAN DEFAULT true,
    event_reminder BOOLEAN DEFAULT true,
    system_announcement BOOLEAN DEFAULT true,
    marketing BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- push_campaigns 表：推送活动管理
CREATE TABLE push_campaigns (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    notification_type VARCHAR(50) NOT NULL,
    title_template VARCHAR(100) NOT NULL,
    body_template TEXT NOT NULL,
    image_url TEXT,
    target_segment VARCHAR(50),
    target_user_ids UUID[] DEFAULT '{}',
    scheduled_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'running', 'completed', 'cancelled')),
    total_targets INTEGER DEFAULT 0,
    sent_count INTEGER DEFAULT 0,
    delivered_count INTEGER DEFAULT 0,
    opened_count INTEGER DEFAULT 0,
    failed_count INTEGER DEFAULT 0,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_push_campaigns_status (status),
    INDEX idx_push_campaigns_scheduled (scheduled_at)
);

-- push_analytics 表：推送分析统计
CREATE TABLE push_analytics (
    id SERIAL PRIMARY KEY,
    date DATE NOT NULL UNIQUE,
    total_sent INTEGER DEFAULT 0,
    total_delivered INTEGER DEFAULT 0,
    total_opened INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    ios_sent INTEGER DEFAULT 0,
    android_sent INTEGER DEFAULT 0,
    by_type JSONB DEFAULT '{}',
    avg_delivery_time_ms INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    INDEX idx_push_analytics_date (date)
);
```

### 2. 推送服务核心模块

```javascript
// backend/shared/pushNotificationService.js

const admin = require('firebase-admin');
const apn = require('apn');
const { v4: uuidv4 } = require('uuid');
const { getClient } = require('./db');
const { getRedisClient } = require('./redis');
const logger = require('./logger');
const { incrementCounter, observeHistogram } = require('./metrics');

class PushNotificationService {
    constructor() {
        this.fcmApp = null;
        this.apnProvider = null;
        this.initialized = false;
    }

    /**
     * 初始化 FCM 和 APNs
     */
    async initialize() {
        // 初始化 Firebase Admin
        this.fcmApp = admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
            })
        });

        // 初始化 APNs Provider
        this.apnProvider = new apn.Provider({
            production: process.env.NODE_ENV === 'production',
            cert: process.env.APNS_CERT_PATH,
            key: process.env.APNS_KEY_PATH,
            passphrase: process.env.APNS_PASSPHRASE
        });

        this.initialized = true;
        logger.info('PushNotificationService initialized', {
            fcm: !!this.fcmApp,
            apns: !!this.apnProvider
        });
    }

    /**
     * 发送推送通知
     * @param {Object} params - 推送参数
     * @returns {Promise<Object>} 发送结果
     */
    async sendPush(params) {
        const { userId, type, title, body, data = {}, image, priority = 'normal' } = params;

        if (!this.initialized) {
            await this.initialize();
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
            incrementCounter('push_notifications_sent_total', { type, status: successful > 0 ? 'success' : 'failed' });
            observeHistogram('push_notification_duration_seconds', (Date.now() - startTime) / 1000, { type });

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
            incrementCounter('push_notifications_errors_total', { type, error: error.constructor.name });
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
            if (platform === 'android' || platform === 'ios') {
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
            }

            return { success: false, reason: 'unsupported_platform' };

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
            const campaign = await client.query(
                'SELECT * FROM push_campaigns WHERE id = $1 AND status = $2',
                [campaignId, 'scheduled']
            );

            if (campaign.rows.length === 0) {
                throw new Error('Campaign not found or not scheduled');
            }

            const campaignData = campaign.rows[0];

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
            const fields = Object.keys(preferences);
            const values = [userId, ...Object.values(preferences)];
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
        return prefKey ? preferences[prefKey] : true;
    }

    /**
     * 检查是否在静默时段
     */
    isQuietHours(preferences) {
        if (!preferences.quiet_hours_start || !preferences.quiet_hours_end) {
            return false;
        }

        const now = new Date();
        const userTime = new Date(now.toLocaleString('en-US', { timeZone: preferences.timezone }));
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

        const nextTime = new Date(now.toLocaleString('en-US', { timeZone: preferences.timezone }));
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
        } finally {
            client.release();
        }
    }

    /**
     * 格式化数据载荷
     */
    formatData(data) {
        const formatted = {};
        for (const [key, value] of Object.entries(data)) {
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
                const result = results.find(r => r.status === 'fulfilled' && r.value.platform === device.platform);

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
                'active_7d': 'SELECT id FROM users WHERE last_login_at > NOW() - INTERVAL \'7 days\'',
                'active_30d': 'SELECT id FROM users WHERE last_login_at > NOW() - INTERVAL \'30 days\'',
                'new_users': 'SELECT id FROM users WHERE created_at > NOW() - INTERVAL \'7 days\'',
                'paying_users': 'SELECT DISTINCT user_id as id FROM payments WHERE status = \'completed\''
            };

            const query = segmentQueries[campaign.target_segment] || segmentQueries['all'];
            const result = await client.query(query);

            return result.rows.map(r => r.id);
        } finally {
            client.release();
        }
    }

    /**
     * 处理推送回执
     */
    async handleDeliveryReceipt(params) {
        const { messageId, platform, status, deliveredAt } = params;
        const client = await getClient();

        try {
            const field = platform === 'ios' ? 'apns_apns_id' : 'fcm_message_id';

            await client.query(
                `UPDATE push_notifications 
                 SET status = $1, delivered_at = $2 
                 WHERE ${field} = $3`,
                [status, deliveredAt || new Date(), messageId]
            );
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
                     jsonb_object_agg(notification_type, type_count) as by_type,
                     AVG(EXTRACT(EPOCH FROM (delivered_at - sent_at)) * 1000)::INTEGER as avg_delivery_time_ms
                 FROM push_notifications pn
                 JOIN device_tokens dt ON pn.device_token_id = dt.id
                 LEFT JOIN LATERAL (
                     SELECT notification_type, COUNT(*) as type_count
                     FROM push_notifications pn2
                     WHERE DATE(pn2.created_at) = DATE(pn.created_at)
                     GROUP BY notification_type
                 ) type_counts ON true
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
```

### 3. API 路由

```javascript
// backend/services/user-service/src/routes/push.js

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { getPushNotificationService } = require('../../../shared/pushNotificationService');
const logger = require('../../../shared/logger');
const auth = require('../middleware/auth');

// 注册设备令牌
router.post('/devices/register', auth, async (req, res) => {
    try {
        const schema = Joi.object({
            deviceId: Joi.string().required(),
            platform: Joi.string().valid('ios', 'android').required(),
            token: Joi.string().required(),
            appVersion: Joi.string(),
            osVersion: Joi.string(),
            deviceModel: Joi.string()
        });

        const { error, value } = schema.validate(req.body);
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
        logger.error('Register device token error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 注销设备令牌
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

// 获取推送偏好
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

// 更新推送偏好
router.put('/preferences', auth, async (req, res) => {
    try {
        const schema = Joi.object({
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

        const { error, value } = schema.validate(req.body);
        if (error) {
            return res.status(400).json({ error: error.details[0].message });
        }

        // 转换字段名
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

// 发送测试推送
router.post('/test', auth, async (req, res) => {
    try {
        const pushService = await getPushNotificationService();
        const result = await pushService.sendPush({
            userId: req.user.id,
            type: 'system_announcement',
            title: '测试推送',
            body: '这是一条测试推送通知',
            data: { test: true }
        });

        res.json({ success: result.success, result });
    } catch (error) {
        logger.error('Send test push error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 获取推送历史
router.get('/history', auth, async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const client = await getClient();

        const result = await client.query(
            `SELECT id, notification_type, title, body, status, sent_at, delivered_at, opened_at
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

// 标记推送已打开
router.post('/:id/opened', auth, async (req, res) => {
    try {
        const client = await getClient();

        await client.query(
            'UPDATE push_notifications SET opened_at = NOW() WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.id]
        );

        res.json({ success: true });
    } catch (error) {
        logger.error('Mark push opened error', { error: error.message });
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
```

### 4. 管理员 API

```javascript
// backend/gateway/src/routes/admin/pushCampaigns.js

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { getPushNotificationService } = require('../../../shared/pushNotificationService');
const { getClient } = require('../../../shared/db');
const logger = require('../../../shared/logger');
const adminAuth = require('../middleware/adminAuth');

// 创建推送活动
router.post('/campaigns', adminAuth, async (req, res) => {
    try {
        const schema = Joi.object({
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

        const { error, value } = schema.validate(req.body);
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
                value.targetSegment,
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

// 获取活动列表
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

// 发送活动推送
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

// 获取推送统计
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

module.exports = router;
```

### 5. Prometheus 指标

```javascript
// backend/shared/metrics.js (追加)

// 推送通知指标
const pushNotificationsSentTotal = new Counter({
    name: 'push_notifications_sent_total',
    help: 'Total number of push notifications sent',
    labelNames: ['type', 'status']
});

const pushNotificationsErrorsTotal = new Counter({
    name: 'push_notifications_errors_total',
    help: 'Total number of push notification errors',
    labelNames: ['type', 'error']
});

const pushNotificationDurationSeconds = new Histogram({
    name: 'push_notification_duration_seconds',
    help: 'Duration of push notification sending',
    labelNames: ['type'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});

const deviceTokensTotal = new Gauge({
    name: 'device_tokens_total',
    help: 'Total number of registered device tokens',
    labelNames: ['platform', 'status']
});

const pushCampaignsActive = new Gauge({
    name: 'push_campaigns_active',
    help: 'Number of active push campaigns'
});

module.exports = {
    // ...existing exports...
    pushNotificationsSentTotal,
    pushNotificationsErrorsTotal,
    pushNotificationDurationSeconds,
    deviceTokensTotal,
    pushCampaignsActive
};
```

### 6. 定时任务

```javascript
// backend/jobs/pushNotificationJobs.js

const cron = require('node-cron');
const { getPushNotificationService } = require('../shared/pushNotificationService');
const { getClient } = require('../shared/db');
const logger = require('../shared/logger');

// 处理延迟推送
cron.schedule('* * * * *', async () => {
    try {
        const pushService = await getPushNotificationService();
        const redis = getRedisClient();

        const now = Date.now();
        const scheduled = await redis.zrangebyscore('scheduled_push_notifications', 0, now);

        for (const item of scheduled) {
            const notification = JSON.parse(item);
            await pushService.sendPush(notification);
            await redis.zrem('scheduled_push_notifications', item);
        }

        logger.info('Processed scheduled push notifications', { count: scheduled.length });
    } catch (error) {
        logger.error('Process scheduled push notifications error', { error: error.message });
    }
});

// 更新每日统计
cron.schedule('0 1 * * *', async () => {
    try {
        const pushService = await getPushNotificationService();
        await pushService.updateDailyAnalytics();
    } catch (error) {
        logger.error('Update daily analytics error', { error: error.message });
    }
});

// 发送活动推送
cron.schedule('* * * * *', async () => {
    try {
        const client = await getClient();

        const result = await client.query(
            `SELECT id FROM push_campaigns 
             WHERE status = 'scheduled' AND scheduled_at <= NOW()`
        );

        if (result.rows.length > 0) {
            const pushService = await getPushNotificationService();

            for (const row of result.rows) {
                await pushService.sendCampaignPush(row.id);
            }
        }
    } catch (error) {
        logger.error('Send scheduled campaigns error', { error: error.message });
    }
});

module.exports = {};
```

### 7. 前端集成

```javascript
// frontend/game-client/src/services/PushNotificationService.js

class PushNotificationService {
    constructor() {
        this.token = null;
        this.messaging = null;
    }

    async initialize() {
        // 检查是否支持通知
        if (!('Notification' in window)) {
            console.warn('This browser does not support notifications');
            return false;
        }

        // 请求权限
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            console.warn('Notification permission denied');
            return false;
        }

        // 初始化 Firebase Messaging
        if (window.firebase && window.firebase.messaging) {
            this.messaging = window.firebase.messaging();

            // 获取令牌
            this.token = await this.messaging.getToken({
                vapidKey: process.env.REACT_APP_FIREBASE_VAPID_KEY
            });

            // 注册令牌
            await this.registerToken(this.token);

            // 监听令牌刷新
            this.messaging.onTokenRefresh(async () => {
                this.token = await this.messaging.getToken();
                await this.registerToken(this.token);
            });

            // 监听前台消息
            this.messaging.onMessage((payload) => {
                this.handleForegroundMessage(payload);
            });
        }

        return true;
    }

    async registerToken(token) {
        const deviceId = this.getDeviceId();
        const platform = this.getPlatform();

        await fetch('/api/push/devices/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId,
                platform,
                token,
                appVersion: process.env.REACT_APP_VERSION,
                osVersion: navigator.userAgent,
                deviceModel: navigator.platform
            })
        });
    }

    handleForegroundMessage(payload) {
        const { notification, data } = payload;

        // 显示应用内通知
        const event = new CustomEvent('pushNotification', {
            detail: { notification, data }
        });
        window.dispatchEvent(event);

        // 显示浏览器通知
        if (Notification.permission === 'granted') {
            new Notification(notification.title, {
                body: notification.body,
                icon: notification.icon,
                data: data
            });
        }
    }

    getDeviceId() {
        let deviceId = localStorage.getItem('deviceId');
        if (!deviceId) {
            deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            localStorage.setItem('deviceId', deviceId);
        }
        return deviceId;
    }

    getPlatform() {
        const userAgent = navigator.userAgent;
        if (/iPad|iPhone|iPod/.test(userAgent)) {
            return 'ios';
        } else if (/Android/.test(userAgent)) {
            return 'android';
        }
        return 'android'; // 默认使用 FCM
    }
}

export default new PushNotificationService();
```

## 验收标准

- [ ] 数据库迁移成功创建 6 张表
- [ ] FCM 推送成功发送到 Android 设备
- [ ] APNs 推送成功发送到 iOS 设备
- [ ] 用户设备令牌注册功能正常
- [ ] 用户推送偏好设置功能正常
- [ ] 静默时段功能正常（不发送或延迟发送）
- [ ] 推送活动创建和发送功能正常
- [ ] 推送统计分析功能正常
- [ ] 前端成功接收并显示推送通知
- [ ] 6 个 Prometheus 指标正常采集
- [ ] 单元测试覆盖率 > 80%
- [ ] 推送送达率 > 95%

## 影响范围

- 数据库：新增 6 张表
- user-service：新增 `/push` 路由
- gateway：新增 `/admin/pushCampaigns` 路由
- backend/shared：新增 `pushNotificationService.js`
- backend/jobs：新增 `pushNotificationJobs.js`
- frontend/game-client：新增推送服务集成
- 环境变量：新增 FIREBASE_* 和 APNS_* 配置

## 参考

- [Firebase Cloud Messaging 文档](https://firebase.google.com/docs/cloud-messaging)
- [Apple Push Notification Service 文档](https://developer.apple.com/documentation/usernotifications)
- REQ-00026：游戏内实时推送通知系统
- REQ-00032：多渠道推送通知插件架构
