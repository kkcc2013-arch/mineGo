// backend/shared/notification/plugins/WebSocketPlugin.js
'use strict';

const NotificationPlugin = require('../PluginInterface');

/**
 * WebSocket 推送插件
 * 用于游戏内实时推送（REQ-00026 已实现）
 */
class WebSocketPlugin extends NotificationPlugin {
  constructor(wss) {
    super();
    this.wss = wss;
    this.connections = new Map(); // userId -> WebSocket
  }

  /**
   * 注册用户连接
   */
  registerConnection(userId, ws) {
    this.connections.set(userId, ws);
  }

  /**
   * 注销用户连接
   */
  unregisterConnection(userId) {
    this.connections.delete(userId);
  }

  async send(userId, payload, options = {}) {
    const ws = this.connections.get(userId);
    
    if (!ws || ws.readyState !== 1) { // WebSocket.OPEN
      return { success: false, error: 'User not connected' };
    }

    try {
      const message = JSON.stringify({
        type: payload.type || 'notification',
        title: payload.title,
        body: payload.body,
        data: payload.data || {},
        timestamp: Date.now(),
      });

      ws.send(message);
      
      return { 
        success: true, 
        messageId: `ws-${userId}-${Date.now()}` 
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getSupportedPlatforms() {
    return ['web'];
  }

  getName() {
    return 'websocket';
  }

  async isEnabledForUser(userId) {
    // WebSocket 插件对用户始终启用（如果在线）
    return this.connections.has(userId);
  }

  async getUserDeviceToken(userId) {
    // WebSocket 不需要 device token
    return null;
  }

  /**
   * 检查用户是否在线
   */
  isUserOnline(userId) {
    const ws = this.connections.get(userId);
    return ws && ws.readyState === 1;
  }
}

module.exports = WebSocketPlugin;
