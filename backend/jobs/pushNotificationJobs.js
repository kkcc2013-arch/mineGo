/**
 * 推送通知定时任务
 * REQ-00136: FCM/APNs 移动推送通知系统
 */

const cron = require('node-cron');
const { getPushNotificationService } = require('../shared/pushNotificationService');
const { getClient } = require('../shared/db');
const { getRedisClient } = require('../shared/redis');
const logger = require('../shared/logger');

/**
 * 处理延迟推送（静默时段延迟的推送）
 * 每分钟执行一次
 */
cron.schedule('* * * * *', async () => {
    try {
        const pushService = await getPushNotificationService();
        const redis = getRedisClient();

        const now = Date.now();
        const scheduled = await redis.zrangebyscore('scheduled_push_notifications', 0, now);

        if (scheduled.length === 0) {
            return;
        }

        logger.info('Processing scheduled push notifications', { count: scheduled.length });

        for (const item of scheduled) {
            try {
                const notification = JSON.parse(item);
                await pushService.sendPush(notification);
                await redis.zrem('scheduled_push_notifications', item);
            } catch (error) {
                logger.error('Failed to send scheduled push', { error: error.message, item });
            }
        }
    } catch (error) {
        logger.error('Process scheduled push notifications error', { error: error.message });
    }
});

/**
 * 更新每日统计
 * 每天凌晨 1 点执行
 */
cron.schedule('0 1 * * *', async () => {
    try {
        const pushService = await getPushNotificationService();
        await pushService.updateDailyAnalytics();
        logger.info('Daily push analytics updated successfully');
    } catch (error) {
        logger.error('Update daily analytics error', { error: error.message });
    }
});

/**
 * 发送活动推送
 * 每分钟检查并发送预定时间的活动
 */
cron.schedule('* * * * *', async () => {
    try {
        const client = await getClient();

        const result = await client.query(
            `SELECT id FROM push_campaigns 
             WHERE status = 'scheduled' AND scheduled_at <= NOW()`
        );

        if (result.rows.length === 0) {
            return;
        }

        const pushService = await getPushNotificationService();

        for (const row of result.rows) {
            try {
                logger.info('Starting scheduled push campaign', { campaignId: row.id });
                await pushService.sendCampaignPush(row.id);
            } catch (error) {
                logger.error('Failed to send scheduled campaign', { 
                    campaignId: row.id, 
                    error: error.message 
                });
            }
        }
    } catch (error) {
        logger.error('Send scheduled campaigns error', { error: error.message });
    }
});

/**
 * 清理过期推送记录
 * 每周日凌晨 3 点执行
 */
cron.schedule('0 3 * * 0', async () => {
    try {
        const client = await getClient();

        // 删除 90 天前的推送记录
        const result = await client.query(
            `DELETE FROM push_notifications 
             WHERE created_at < NOW() - INTERVAL '90 days' 
             RETURNING id`
        );

        logger.info('Cleaned up old push notifications', { 
            deletedCount: result.rows.length 
        });
    } catch (error) {
        logger.error('Cleanup old push notifications error', { error: error.message });
    }
});

/**
 * 更新设备令牌活跃状态
 * 每天凌晨 4 点执行
 */
cron.schedule('0 4 * * *', async () => {
    try {
        const client = await getClient();

        // 将 30 天未使用的令牌标记为非活跃
        const result = await client.query(
            `UPDATE device_tokens 
             SET is_active = false 
             WHERE last_used_at < NOW() - INTERVAL '30 days' 
               AND is_active = true
             RETURNING id`
        );

        logger.info('Updated inactive device tokens', { 
            updatedCount: result.rows.length 
        });
    } catch (error) {
        logger.error('Update device tokens status error', { error: error.message });
    }
});

logger.info('Push notification jobs initialized');

module.exports = {};
