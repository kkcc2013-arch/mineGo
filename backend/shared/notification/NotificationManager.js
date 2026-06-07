// backend/shared/notification/NotificationManager.js
'use strict';

const { query } = require('../db');
const { createLogger } = require('../logger');

const logger = createLogger('notification-manager');

/**
 * 推送通知管理器
 * 统一管理多渠道推送，智能选择推送渠道
 */
class NotificationManager {
  constructor() {
    this.plugins = new Map(); // name -> plugin instance
  }

  /**
   * 注册推送插件
   */
  registerPlugin(plugin) {
    if (!plugin.getName) {
      throw new Error('Plugin must implement getName()');
    }
    
    const name = plugin.getName();
    this.plugins.set(name, plugin);
    
    logger.info({ plugin: name }, 'Notification plugin registered');
  }

  /**
   * 智能推送：根据用户状态和偏好选择渠道
   * @param {string} userId - 用户ID
   * @param {Object} payload - 推送内容 { title, body, data, type }
   * @param {Object} options - 推送选项 { ttl, priority, skipOnline }
   */
  async send(userId, payload, options = {}) {
    logger.info({ userId, type: payload.type }, 'Sending notification');

    try {
      // 1. 检查静默时段
      if (await this.isInQuietHours(userId)) {
        logger.info({ userId }, 'User in quiet hours, skipping notification');
        return { success: false, error: 'Quiet hours' };
      }

      // 2. 检查通知类型是否启用
      if (!await this.isNotificationTypeEnabled(userId, payload.type)) {
        logger.info({ userId, type: payload.type }, 'Notification type disabled by user');
        return { success: false, error: 'Notification type disabled' };
      }

      // 3. 检查用户是否在线（WebSocket 连接）
      const isOnline = await this.checkUserOnline(userId);
      
      if (isOnline && this.plugins.has('websocket') && !options.skipOnline) {
        // 在线用户优先使用 WebSocket
        const result = await this.plugins.get('websocket').send(userId, payload, options);
        
        if (result.success) {
          await this.logPush(userId, 'websocket', payload, result);
          return result;
        }
      }

      // 4. 离线用户或 WebSocket 失败：查询用户推送偏好
      const preferences = await this.getUserPreferences(userId);
      
      if (!preferences) {
        logger.warn({ userId }, 'No push preferences found for user');
        return { success: false, error: 'No push preferences' };
      }

      // 5. 按优先级尝试推送渠道
      for (const channel of preferences.channels) {
        if (!this.plugins.has(channel)) {
          continue;
        }

        const plugin = this.plugins.get(channel);
        
        // 检查渠道是否启用
        if (!await plugin.isEnabledForUser(userId)) {
          logger.debug({ userId, channel }, 'Channel disabled for user');
          continue;
        }

        // 尝试发送
        const result = await plugin.send(userId, payload, options);
        
        if (result.success) {
          await this.logPush(userId, channel, payload, result);
          logger.info({ userId, channel, messageId: result.messageId }, 'Notification sent successfully');
          return result;
        }
        
        logger.warn({ userId, channel, error: result.error }, 'Channel failed, trying next');
      }

      // 6. 所有渠道失败，记录失败日志
      await this.logPushFailure(userId, payload);
      logger.error({ userId }, 'All notification channels failed');
      
      return { success: false, error: 'All channels failed' };
    } catch (error) {
      logger.error({ err: error, userId }, 'Notification manager error');
      return { success: false, error: error.message };
    }
  }

  /**
   * 批量推送
   */
  async sendBatch(userIds, payload, options = {}) {
    const results = await Promise.allSettled(
      userIds.map(userId => this.send(userId, payload, options))
    );

    const summary = {
      total: userIds.length,
      success: results.filter(r => r.status === 'fulfilled' && r.value.success).length,
      failed: results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length,
    };

    logger.info(summary, 'Batch notification completed');
    
    return summary;
  }

  /**
   * 检查用户是否在线
   */
  async checkUserOnline(userId) {
    const websocketPlugin = this.plugins.get('websocket');
    if (!websocketPlugin) return false;
    
    return websocketPlugin.isUserOnline(userId);
  }

  /**
   * 获取用户推送偏好
   */
  async getUserPreferences(userId) {
    try {
      const { rows: [prefs] } = await query(
        'SELECT preferred_channels, notification_types, quiet_hours FROM user_push_preferences WHERE user_id = $1',
        [userId]
      );
      
      if (!prefs) return null;
      
      return {
        channels: prefs.preferred_channels || ['websocket', 'fcm', 'apns'],
        notificationTypes: prefs.notification_types || {},
        quietHours: prefs.quiet_hours || { enabled: false },
      };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get user preferences');
      return null;
    }
  }

  /**
   * 检查是否在静默时段
   */
  async isInQuietHours(userId) {
    try {
      const { rows: [prefs] } = await query(
        'SELECT quiet_hours FROM user_push_preferences WHERE user_id = $1',
        [userId]
      );
      
      if (!prefs || !prefs.quiet_hours || !prefs.quiet_hours.enabled) {
        return false;
      }

      const { start, end } = prefs.quiet_hours;
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      
      // 处理跨午夜的情况（如 22:00 - 08:00）
      if (start < end) {
        return currentTime >= start && currentTime < end;
      } else {
        return currentTime >= start || currentTime < end;
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check quiet hours');
      return false;
    }
  }

  /**
   * 检查通知类型是否启用
   */
  async isNotificationTypeEnabled(userId, type) {
    if (!type) return true;
    
    try {
      const { rows: [prefs] } = await query(
        'SELECT notification_types FROM user_push_preferences WHERE user_id = $1',
        [userId]
      );
      
      if (!prefs || !prefs.notification_types) return true;
      
      return prefs.notification_types[type] !== false;
    } catch (error) {
      logger.error({ err: error, userId, type }, 'Failed to check notification type');
      return true;
    }
  }

  /**
   * 记录推送日志
   */
  async logPush(userId, channel, payload, result) {
    try {
      await query(
        `INSERT INTO push_logs 
         (user_id, channel, notification_type, title, body, payload, success, message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          channel,
          payload.type || 'unknown',
          payload.title,
          payload.body,
          JSON.stringify(payload.data || {}),
          true,
          result.messageId,
        ]
      );
    } catch (error) {
      logger.error({ err: error, userId, channel }, 'Failed to log push');
    }
  }

  /**
   * 记录推送失败日志
   */
  async logPushFailure(userId, payload) {
    try {
      await query(
        `INSERT INTO push_logs 
         (user_id, channel, notification_type, title, body, payload, success, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          userId,
          'all',
          payload.type || 'unknown',
          payload.title,
          payload.body,
          JSON.stringify(payload.data || {}),
          false,
          'All channels failed',
        ]
      );
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to log push failure');
    }
  }

  /**
   * 获取插件列表
   */
  getRegisteredPlugins() {
    return Array.from(this.plugins.keys());
  }
}

// 单例模式
let instance = null;

function getNotificationManager() {
  if (!instance) {
    instance = new NotificationManager();
  }
  return instance;
}

module.exports = {
  NotificationManager,
  getNotificationManager,
};
