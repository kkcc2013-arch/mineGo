/**
 * TURN Server Manager - TURN/STUN 服务器凭证管理
 * 生成和管理 WebRTC TURN 服务器凭证
 */

const crypto = require('crypto');
const logger = require('../../../shared/logger');

class TURNServerManager {
  constructor(options = {}) {
    this.config = {
      host: options.host || process.env.TURN_HOST || 'turn.minego.com',
      port: options.port || parseInt(process.env.TURN_PORT) || 3478,
      realm: options.realm || process.env.TURN_REALM || 'minego.com',
      secret: options.secret || process.env.TURN_SECRET,
      credentialsTTL: options.credentialsTTL || 86400, // 24 小时
      ...options
    };

    if (!this.config.secret) {
      logger.warn('TURN secret not configured, using default (not recommended for production)');
      this.config.secret = 'default-turn-secret-change-me';
    }
  }

  /**
   * 生成 TURN 凭证
   */
  generateCredentials(userId) {
    const timestamp = Math.floor(Date.now() / 1000) + this.config.credentialsTTL;
    const username = `${timestamp}:${userId}`;
    const password = this.generatePassword(username);
    
    return {
      username,
      password,
      ttl: this.config.credentialsTTL,
      expiresAt: new Date(timestamp * 1000).toISOString(),
      uris: this.getTURNURIs()
    };
  }

  /**
   * 生成密码（基于 HMAC）
   */
  generatePassword(username) {
    return crypto
      .createHmac('sha1', this.config.secret)
      .update(username)
      .digest('base64');
  }

  /**
   * 获取 TURN 服务器 URI 列表
   */
  getTURNURIs() {
    const { host, port } = this.config;
    
    return [
      `stun:${host}:${port}`,
      `turn:${host}:${port}?transport=udp`,
      `turn:${host}:${port}?transport=tcp`,
      `turns:${host}:${port + 1}?transport=tcp` // TLS 端口
    ];
  }

  /**
   * 获取 ICE 服务器配置（用于 WebRTC）
   */
  getICEServerConfig(userId) {
    const credentials = this.generateCredentials(userId);
    
    return {
      iceServers: [{
        urls: credentials.uris,
        username: credentials.username,
        credential: credentials.password
      }],
      iceTransportPolicy: 'all'
    };
  }

  /**
   * 验证凭证
   */
  verifyCredentials(username, password) {
    try {
      // 解析时间戳
      const parts = username.split(':');
      if (parts.length < 2) {
        return { valid: false, error: 'Invalid username format' };
      }

      const timestamp = parseInt(parts[0]);
      const now = Math.floor(Date.now() / 1000);

      // 检查是否过期
      if (timestamp < now) {
        return { valid: false, error: 'Credentials expired' };
      }

      // 验证密码
      const expectedPassword = this.generatePassword(username);
      if (password !== expectedPassword) {
        return { valid: false, error: 'Invalid password' };
      }

      return { 
        valid: true, 
        userId: parts.slice(1).join(':'),
        expiresAt: new Date(timestamp * 1000)
      };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * 刷新凭证（延长有效期）
   */
  refreshCredentials(username) {
    try {
      const parts = username.split(':');
      if (parts.length < 2) {
        return null;
      }

      const userId = parts.slice(1).join(':');
      return this.generateCredentials(userId);
    } catch (error) {
      logger.error('Failed to refresh credentials', { error: error.message });
      return null;
    }
  }

  /**
   * 获取服务器状态
   */
  getStatus() {
    return {
      host: this.config.host,
      port: this.config.port,
      realm: this.config.realm,
      configured: !!this.config.secret,
      uris: this.getTURNURIs()
    };
  }
}

module.exports = TURNServerManager;
