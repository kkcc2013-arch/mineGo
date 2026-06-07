// backend/shared/notification/plugins/FCMPlugin.js
'use strict';

const NotificationPlugin = require('../PluginInterface');
const { query } = require('../../db');
const { createLogger } = require('../../logger');

const logger = createLogger('notification-fcm');

/**
 * FCM (Firebase Cloud Messaging) 推送插件
 * 支持 Android、iOS、Web 三个平台
 */
class FCMPlugin extends NotificationPlugin {
  constructor(config) {
    super();
    this.config = config;
    this.app = null;
    this.messaging = null;
    
    // 延迟初始化（避免在未配置时报错）
    if (config && config.serviceAccount) {
      this.initialize(config);
    }
  }

  /**
   * 初始化 FCM
   */
  initialize(config) {
    try {
      const admin = require('firebase-admin');
      
      // 避免重复初始化
      if (admin.apps.length === 0) {
        this.app = admin.initializeApp({
          credential: admin.credential.cert(config.serviceAccount),
        }, 'mineGo-fcm');
      } else {
        this.app = admin.app('mineGo-fcm');
      }
      
      this.messaging = this.app.messaging();
      logger.info('FCM initialized successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize FCM');
    }
  }

  async send(userId, payload, options = {}) {
    if (!this.messaging) {
      return { success: false, error: 'FCM not initialized' };
    }

    try {
      // 1. 查询用户的 FCM device token
      const token = await this.getUserDeviceToken(userId);
      if (!token) {
        return { success: false, error: 'No FCM token for user' };
      }

      // 2. 构造 FCM 消息
      const message = {
        token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
        data: this.stringifyData(payload.data || {}),
        android: {
          ttl: options.ttl || 86400000, // 1 day
          priority: options.priority || 'high',
          notification: {
            icon: 'ic_notification',
            color: '#4CAF50',
            sound: 'default',
          },
        },
        apns: {
          payload: {
            aps: {
              alert: {
                title: payload.title,
                body: payload.body,
              },
              sound: 'default',
              'content-available': 1,
            },
          },
        },
        webpush: {
          notification: {
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-72.png',
          },
        },
      };

      // 3. 发送推送
      const response = await this.messaging.send(message);
      
      logger.info({ userId, messageId: response }, 'FCM push sent successfully');
      
      return { success: true, messageId: response };
    } catch (error) {
      logger.error({ err: error, userId }, 'FCM push failed');
      
      // 处理特定错误（如 token 失效）
      if (error.code === 'messaging/registration-token-not-registered') {
        await this.removeInvalidToken(userId, 'fcm');
      }
      
      return { success: false, error: error.message };
    }
  }

  getSupportedPlatforms() {
    return ['android', 'ios', 'web'];
  }

  getName() {
    return 'fcm';
  }

  async isEnabledForUser(userId) {
    try {
      const { rows: [prefs] } = await query(
        'SELECT preferred_channels FROM user_push_preferences WHERE user_id = $1',
        [userId]
      );
      
      if (!prefs) return false;
      return prefs.preferred_channels.includes('fcm');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check FCM preference');
      return false;
    }
  }

  async getUserDeviceToken(userId) {
    try {
      const { rows: [prefs] } = await query(
        'SELECT fcm_token FROM user_push_preferences WHERE user_id = $1',
        [userId]
      );
      
      return prefs?.fcm_token || null;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get FCM token');
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
         SET fcm_token = NULL, updated_at = NOW() 
         WHERE user_id = $1`,
        [userId]
      );
      
      logger.info({ userId, platform }, 'Removed invalid FCM token');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to remove invalid token');
    }
  }

  /**
   * 将 data 对象转为字符串（FCM 要求）
   */
  stringifyData(data) {
    const result = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return result;
  }
}

module.exports = FCMPlugin;
