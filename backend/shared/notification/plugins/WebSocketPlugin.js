// backend/shared/notification/plugins/WebSocketPlugin.js
'use strict';

const NotificationPlugin = require('../PluginInterface');

/**
 * WebSocket 推送插件
 * 用于游戏内实时推送（REQ-00026 已实现）
 */
class WebSocketPlugin extends NotificationPlugin {
  constructor(wss, transport = null) {
    super();
    this.wss = wss;
    this.transport = transport;
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
    if (this.transport) {
      const sent = this.transport.sendNotificationToUser(userId, {...payload,eventType:payload.eventType||payload.type});
      return sent ? {success:true,messageId:`notification-${payload.id}`} : {success:false,error:'User not connected'};
    }
    const ws = this.connections.get(userId);
    
    if (!ws || ws.readyState !== 1) { // WebSocket.OPEN
      return { success: false, error: 'User not connected' };
    }

    try {
      const message = JSON.stringify({type:'NOTIFICATION',payload:{...payload,eventType:payload.eventType||payload.type,timestamp:payload.timestamp||new Date().toISOString()}});

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
    return this.transport ? this.transport.isUserConnected(userId) : this.connections.has(userId);
  }

  async getUserDeviceToken(userId) {
    // WebSocket 不需要 device token
    return null;
  }

  /**
   * 检查用户是否在线
   */
  isUserOnline(userId) {
    if (this.transport) return this.transport.isUserConnected(userId);
    const ws = this.connections.get(userId);
    return ws && ws.readyState === 1;
  }
}

module.exports = WebSocketPlugin;
