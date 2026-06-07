// backend/shared/notification/PluginInterface.js
'use strict';

/**
 * 推送通知插件接口
 * 所有推送渠道插件必须实现此接口
 */
class NotificationPlugin {
  /**
   * 发送推送通知
   * @param {string} userId - 用户ID
   * @param {Object} payload - 推送内容 { title, body, data, type }
   * @param {Object} options - 渠道特定选项 { ttl, priority }
   * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
   */
  async send(userId, payload, options) {
    throw new Error('Plugin must implement send()');
  }

  /**
   * 获取支持的平台列表
   * @returns {string[]} 支持的平台列表，如 ['ios', 'android', 'web']
   */
  getSupportedPlatforms() {
    throw new Error('Plugin must implement getSupportedPlatforms()');
  }

  /**
   * 获取插件名称
   * @returns {string} 插件名称，如 'fcm', 'apns', 'websocket'
   */
  getName() {
    throw new Error('Plugin must implement getName()');
  }

  /**
   * 检查该用户是否启用此渠道
   * @param {string} userId 
   * @returns {Promise<boolean>}
   */
  async isEnabledForUser(userId) {
    throw new Error('Plugin must implement isEnabledForUser()');
  }

  /**
   * 查询用户的设备推送 Token
   * @param {string} userId
   * @returns {Promise<string|null>}
   */
  async getUserDeviceToken(userId) {
    throw new Error('Plugin must implement getUserDeviceToken()');
  }
}

module.exports = NotificationPlugin;
