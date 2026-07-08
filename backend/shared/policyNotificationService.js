/**
 * REQ-00497: 隐私政策变更通知服务
 * 
 * 功能：
 * - 批量通知用户政策更新
 * - 支持多渠道通知（邮件、推送、站内信、短信）
 * - 通知状态跟踪
 * - 重试机制
 * 
 * @module backend/shared/policyNotificationService
 */

'use strict';

const { createLogger } = require('./logger');
const { executeQuery, transaction } = require('./db');
const { getRedisClient } = require('./cache');

const logger = createLogger('policy-notification-service');

/**
 * 通知类型
 */
const NOTIFICATION_TYPES = {
  EMAIL: 'email',
  PUSH: 'push',
  IN_APP: 'in_app',
  SMS: 'sms'
};

/**
 * 通知状态
 */
const NOTIFICATION_STATUS = {
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  READ: 'read',
  CONFIRMED: 'confirmed'
};

/**
 * 政策变更通知服务
 */
class PolicyNotificationService {
  constructor(options = {}) {
    this.batchSize = options.batchSize || 500;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelayMs = options.retryDelayMs || 60000; // 1分钟
  }

  /**
   * 调度政策更新通知
   * @param {number} policyId 政策ID
   * @param {Object} options 选项
   * @returns {Promise<Object>} 调度结果
   */
  async schedulePolicyUpdateNotifications(policyId, options = {}) {
    const {
      channels = [NOTIFICATION_TYPES.EMAIL, NOTIFICATION_TYPES.IN_APP],
      scheduledAt = new Date(),
      excludeConfirmed = true
    } = options;

    // 获取政策信息
    const policyResult = await executeQuery(
      'SELECT * FROM privacy_policies WHERE id = $1',
      [policyId]
    );

    if (policyResult.rows.length === 0) {
      throw new Error('Policy not found');
    }

    const policy = policyResult.rows[0];

    // 获取需要通知的用户
    let usersQuery = `
      SELECT u.id, u.phone, u.email, u.language, u.push_token
      FROM users u
      WHERE u.status != 'banned'
    `;

    if (excludeConfirmed) {
      usersQuery += `
        AND NOT EXISTS (
          SELECT 1 FROM user_privacy_confirmations upc
          WHERE upc.user_id = u.id 
            AND upc.policy_id = $1
            AND upc.revoked_at IS NULL
        )
      `;
    }

    const usersResult = await executeQuery(usersQuery, excludeConfirmed ? [policyId] : []);
    const users = usersResult.rows;

    logger.info('Scheduling policy update notifications', {
      policyId,
      policyVersion: policy.version,
      userCount: users.length,
      channels
    });

    // 批量创建通知记录
    let scheduledCount = 0;
    const batches = this.chunkArray(users, this.batchSize);

    for (const batch of batches) {
      await transaction(async (client) => {
        for (const user of batch) {
          for (const channel of channels) {
            await client.query(
              `INSERT INTO privacy_update_notifications (
                policy_id, user_id, notification_type, scheduled_at, status
              ) VALUES ($1, $2, $3, $4, $5)`,
              [policyId, user.id, channel, scheduledAt, NOTIFICATION_STATUS.PENDING]
            );
            scheduledCount++;
          }
        }
      });
    }

    return {
      success: true,
      scheduledCount,
      userCount: users.length,
      channels
    };
  }

  /**
   * 处理待发送的通知
   * @param {number} limit 处理数量限制
   * @returns {Promise<Object>} 处理结果
   */
  async processPendingNotifications(limit = 100) {
    const result = {
      processed: 0,
      sent: 0,
      failed: 0
    };

    // 获取待处理通知
    const pendingResult = await executeQuery(
      `SELECT pn.*, pp.title, pp.version, u.email, u.phone, u.push_token, u.language
       FROM privacy_update_notifications pn
       JOIN privacy_policies pp ON pp.id = pn.policy_id
       JOIN users u ON u.id = pn.user_id
       WHERE pn.status = $1 
         AND pn.scheduled_at <= NOW()
         AND pn.retry_count < $2
       ORDER BY pn.scheduled_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [NOTIFICATION_STATUS.PENDING, this.maxRetries, limit]
    );

    const notifications = pendingResult.rows;
    result.processed = notifications.length;

    for (const notification of notifications) {
      try {
        await this.sendNotification(notification);
        
        // 更新状态为已发送
        await executeQuery(
          `UPDATE privacy_update_notifications 
           SET status = $1, sent_at = NOW()
           WHERE id = $2`,
          [NOTIFICATION_STATUS.SENT, notification.id]
        );

        result.sent++;
      } catch (error) {
        logger.error('Failed to send notification', {
          notificationId: notification.id,
          error: error.message
        });

        // 更新状态为失败，增加重试计数
        await executeQuery(
          `UPDATE privacy_update_notifications 
           SET status = $1, error_message = $2, retry_count = retry_count + 1
           WHERE id = $3`,
          [NOTIFICATION_STATUS.FAILED, error.message, notification.id]
        );

        result.failed++;
      }
    }

    logger.info('Processed pending notifications', result);
    return result;
  }

  /**
   * 发送单个通知
   * @param {Object} notification 通知数据
   */
  async sendNotification(notification) {
    const { notification_type, email, phone, push_token, language, title, version } = notification;

    const message = this.getNotificationMessage(language, title, version);

    switch (notification_type) {
      case NOTIFICATION_TYPES.EMAIL:
        return await this.sendEmail(email, message);
      
      case NOTIFICATION_TYPES.PUSH:
        return await this.sendPush(push_token, message);
      
      case NOTIFICATION_TYPES.IN_APP:
        return await this.sendInAppMessage(notification.user_id, message);
      
      case NOTIFICATION_TYPES.SMS:
        return await this.sendSMS(phone, message);
      
      default:
        throw new Error(`Unknown notification type: ${notification_type}`);
    }
  }

  /**
   * 获取通知消息内容
   */
  getNotificationMessage(language, title, version) {
    const messages = {
      'zh-CN': {
        subject: '隐私政策更新通知',
        body: `您的隐私政策已更新。请登录并确认最新版本的《${title}》（版本 ${version}）以继续使用服务。`
      },
      'en-US': {
        subject: 'Privacy Policy Update Notice',
        body: `Your privacy policy has been updated. Please log in and confirm the latest "${title}" (version ${version}) to continue using the service.`
      }
    };

    return messages[language] || messages['zh-CN'];
  }

  /**
   * 发送邮件通知
   */
  async sendEmail(email, message) {
    // 集成邮件发送服务
    // 这里使用占位实现，实际应调用邮件服务
    logger.info('Sending email notification', { email, subject: message.subject });
    
    // 模拟发送
    if (process.env.NODE_ENV === 'test') {
      return { success: true };
    }

    // 实际实现应调用邮件服务
    // const emailService = require('./emailService');
    // return await emailService.send(email, message.subject, message.body);
    
    return { success: true };
  }

  /**
   * 发送推送通知
   */
  async sendPush(pushToken, message) {
    if (!pushToken) {
      throw new Error('No push token available');
    }

    logger.info('Sending push notification', { pushToken: pushToken.substring(0, 20) + '...' });
    
    // 实际实现应调用推送服务
    // const pushService = require('./pushService');
    // return await pushService.send(pushToken, message.subject, message.body);
    
    return { success: true };
  }

  /**
   * 发送站内消息
   */
  async sendInAppMessage(userId, message) {
    // 插入站内消息
    await executeQuery(
      `INSERT INTO notifications (user_id, type, title, body, data, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        userId,
        'policy_update',
        message.subject,
        message.body,
        JSON.stringify({ action: 'CONFIRM_PRIVACY_POLICY' })
      ]
    );

    logger.info('Sent in-app notification', { userId });
    return { success: true };
  }

  /**
   * 发送短信通知
   */
  async sendSMS(phone, message) {
    if (!phone) {
      throw new Error('No phone number available');
    }

    logger.info('Sending SMS notification', { phone: phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') });
    
    // 实际实现应调用短信服务
    // const smsService = require('./smsService');
    // return await smsService.send(phone, message.body);
    
    return { success: true };
  }

  /**
   * 标记通知为已读
   */
  async markAsRead(notificationId) {
    await executeQuery(
      `UPDATE privacy_update_notifications 
       SET status = $1, read_at = NOW()
       WHERE id = $2`,
      [NOTIFICATION_STATUS.READ, notificationId]
    );
  }

  /**
   * 标记通知为已确认
   */
  async markAsConfirmed(policyId, userId) {
    await executeQuery(
      `UPDATE privacy_update_notifications 
       SET status = $1
       WHERE policy_id = $2 AND user_id = $3`,
      [NOTIFICATION_STATUS.CONFIRMED, policyId, userId]
    );
  }

  /**
   * 获取通知统计
   */
  async getNotificationStats(policyId) {
    const result = await executeQuery(
      `SELECT 
        notification_type,
        status,
        COUNT(*) AS count
       FROM privacy_update_notifications
       WHERE policy_id = $1
       GROUP BY notification_type, status
       ORDER BY notification_type, status`,
      [policyId]
    );

    return result.rows;
  }

  /**
   * 重试失败的通知
   */
  async retryFailedNotifications(policyId) {
    const result = await executeQuery(
      `UPDATE privacy_update_notifications 
       SET status = $1, retry_count = 0, error_message = NULL, scheduled_at = NOW()
       WHERE policy_id = $2 
         AND status = $3 
         AND retry_count < $4`,
      [NOTIFICATION_STATUS.PENDING, policyId, NOTIFICATION_STATUS.FAILED, this.maxRetries]
    );

    logger.info('Retrying failed notifications', {
      policyId,
      count: result.rowCount
    });

    return { retriedCount: result.rowCount };
  }

  /**
   * 数组分块
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
}

/**
 * 创建单例实例
 */
let instance = null;

function getPolicyNotificationService() {
  if (!instance) {
    instance = new PolicyNotificationService();
  }
  return instance;
}

module.exports = {
  PolicyNotificationService,
  getPolicyNotificationService,
  NOTIFICATION_TYPES,
  NOTIFICATION_STATUS
};
