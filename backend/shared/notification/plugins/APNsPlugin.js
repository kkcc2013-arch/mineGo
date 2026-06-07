// backend/shared/notification/plugins/APNsPlugin.js
'use strict';

const NotificationPlugin = require('../PluginInterface');
const { query } = require('../../db');
const { createLogger } = require('../../logger');

const logger = createLogger('notification-apns');

/**
 * APNs (Apple Push Notification service) 推送插件
 * 支持 iOS 设备
 */
class APNsPlugin extends NotificationPlugin {
  constructor(config) {
    super();
    this.config = config;
    this.provider = null;
    
    // 延迟初始化
    if (config && config.keyPath) {
      this.initialize(config);
    }
  }

  /**
   * 初始化 APNs
   */
  initialize(config) {
    try {
      const apn = require('apn');
      
      this.provider = new apn.Provider({
        token: {
          key: config.keyPath,
          keyId: config.keyId,
          teamId: config.teamId,
        },
        production: config.production !== false, // 默认生产环境
      });
      
      logger.info('APNs initialized successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize APNs');
    }
  }

  async send(userId, payload, options = {}) {
    if (!this.provider) {
      return { success: false, error: 'APNs not initialized' };
    }

    try {
      const apn = require('apn');
      
      // 1. 查询用户的 APNs device token
      const deviceToken = await this.getUserDeviceToken(userId);
      if (!deviceToken) {
        return { success: false, error: 'No APNs token for user' };
      }

      // 2. 构造 APNs 通知
      const notification = new apn.Notification({
        alert: { 
          title: payload.title, 
          body: payload.body 
        },
        payload: payload.data || {},
        topic: this.config.bundleId || 'com.mineGo.app',
        expiry: options.ttl || Math.floor(Date.now() / 1000) + 86400,
        priority: options.priority === 'high' ? 10 : 5,
        sound: 'default',
        badge: await this.getUnreadCount(userId),
      });

      // 3. 发送推送
      const result = await this.provider.send(notification, deviceToken);
      
      if (result.sent.length > 0) {
        logger.info({ userId, messageId: result.sent[0] }, 'APNs push sent successfully');
        return { success: true, messageId: result.sent[0] };
      }
      
      // 处理失败
      if (result.failed.length > 0) {
        const failure = result.failed[0];
        logger.error({ userId, error: failure.error }, 'APNs push failed');
        
        // 处理 token 失效
        if (failure.status === '410' || failure.status === '410') {
          await this.removeInvalidToken(userId, 'apns');
        }
        
        return { success: false, error: failure.error?.reason || 'APNs push failed' };
      }
      
      return { success: false, error: 'Unknown APNs error' };
    } catch (error) {
      logger.error({ err: error, userId }, 'APNs push error');
      return { success: false, error: error.message };
    }
  }

  getSupportedPlatforms() {
    return ['ios'];
  }

  getName() {
    return 'apns';
  }

  async isEnabledForUser(userId) {
    try {
      const { rows: [prefs] } = await query(
        'SELECT preferred_channels FROM user_push_preferences WHERE user_id = $1',
        [userId]
      );
      
      if (!prefs) return false;
      return prefs.preferred_channels.includes('apns');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check APNs preference');
      return false;
    }
  }

  async getUserDeviceToken(userId) {
    try {
      const { rows: [prefs] } = await query(
        'SELECT apns_token FROM user_push_preferences WHERE user_id = $1',
        [userId]
      );
      
      return prefs?.apns_token || null;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get APNs token');
      return null;
    }
  }

  /**
   * 移除无效的 Token
   */
  async removeInvalidToken(userId, platform) {
    try {
      await query(
        `UPDATE user_push_preferences 
         SET apns_token = NULL, updated_at = NOW() 
         WHERE user_id = $1`,
        [userId]
      );
      
      logger.info({ userId, platform }, 'Removed invalid APNs token');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to remove invalid token');
    }
  }

  /**
   * 获取用户未读消息数（用于 badge）
   */
  async getUnreadCount(userId) {
    try {
      const { rows: [result] } = await query(
        `SELECT COUNT(*) as count FROM notifications 
         WHERE user_id = $1 AND read_at IS NULL`,
        [userId]
      );
      
      return parseInt(result.count, 10) || 0;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get unread count');
      return 0;
    }
  }
}

module.exports = APNsPlugin;
