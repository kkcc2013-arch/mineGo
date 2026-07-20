// backend/services/social-service/src/voice/turnServer.js
// REQ-00116: TURN服务器管理器

'use strict';

const crypto = require('crypto');
const { createLogger } = require('../../../../shared/logger');
const { getPool } = require('../../../../shared/db');

const logger = createLogger('turn-server');

/**
 * TURN/STUN 服务器管理器
 * 生成和管理 TURN 凭证，用于 NAT 穿透
 */
class TURNServerManager {
  constructor() {
    this.config = {
      listeningPort: parseInt(process.env.TURN_PORT) || 3478,
      tlsPort: parseInt(process.env.TURN_TLS_PORT) || 5349,
      realm: process.env.TURN_REALM || 'minego.local',
      credentialsTTL: parseInt(process.env.TURN_CREDENTIALS_TTL) || 86400, // 24小时
      secret: process.env.TURN_SECRET || 'default-turn-secret-change-me'
    };
  }

  /**
   * 生成 TURN 凭证
   * 使用 HMAC-SHA1 生成临时凭证
   */
  async generateCredentials(userId) {
    const timestamp = Math.floor(Date.now() / 1000) + this.config.credentialsTTL;
    const username = `${timestamp}:${userId}`;
    const password = this.generatePassword(username);
    
    const pool = getPool();
    
    // 保存凭证到数据库
    const credentialHash = crypto
      .createHash('sha256')
      .update(password)
      .digest('hex');

    await pool.query(
      `INSERT INTO turn_credentials (user_id, username, credential_hash, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))
       RETURNING id`,
      [userId, username, credentialHash, timestamp]
    );

    logger.debug('TURN credentials generated', { userId, expiresAt: timestamp });

    return {
      username,
      password,
      ttl: this.config.credentialsTTL,
      uris: this.getTurnUris()
    };
  }

  /**
   * 生成密码 (HMAC-SHA1)
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
  getTurnUris() {
    const host = process.env.TURN_HOST || 'turn.minego.com';
    const port = this.config.listeningPort;
    const tlsPort = this.config.tlsPort;

    return [
      // STUN 服务器
      `stun:${host}:${port}`,
      
      // TURN UDP
      `turn:${host}:${port}?transport=udp`,
      
      // TURN TCP
      `turn:${host}:${port}?transport=tcp`,
      
      // TURN TLS
      `turns:${host}:${tlsPort}?transport=tcp`
    ];
  }

  /**
   * 验证凭证
   */
  async validateCredentials(username, password) {
    try {
      const pool = getPool();
      
      // 查询凭证
      const result = await pool.query(
        'SELECT * FROM turn_credentials WHERE username = $1 AND expires_at > NOW()',
        [username]
      );

      if (result.rows.length === 0) {
        return { valid: false, reason: 'Credentials not found or expired' };
      }

      const credential = result.rows[0];
      
      // 验证密码
      const expectedPassword = this.generatePassword(username);
      if (password !== expectedPassword) {
        return { valid: false, reason: 'Invalid password' };
      }

      // 更新使用统计
      await pool.query(
        `UPDATE turn_credentials 
         SET used_count = used_count + 1, last_used_at = NOW()
         WHERE id = $1`,
        [credential.id]
      );

      return { 
        valid: true, 
        userId: credential.user_id,
        expiresAt: credential.expires_at
      };
    } catch (error) {
      logger.error('Failed to validate credentials:', error);
      return { valid: false, reason: 'Validation error' };
    }
  }

  /**
   * 清理过期凭证
   */
  async cleanupExpiredCredentials() {
    try {
      const pool = getPool();
      
      const result = await pool.query(
        'DELETE FROM turn_credentials WHERE expires_at < NOW() RETURNING id'
      );

      logger.info('Cleaned up expired TURN credentials', { 
        count: result.rowCount 
      });

      return result.rowCount;
    } catch (error) {
      logger.error('Failed to cleanup credentials:', error);
      return 0;
    }
  }

  /**
   * 获取 TURN 使用统计
   */
  async getUsageStats(userId = null) {
    try {
      const pool = getPool();
      
      let query = `
        SELECT 
          user_id,
          COUNT(*) as total_credentials,
          SUM(used_count) as total_uses,
          MAX(last_used_at) as last_used_at
        FROM turn_credentials
        WHERE expires_at > NOW()
      `;
      
      const params = [];
      if (userId) {
        query += ' AND user_id = $1';
        params.push(userId);
      }
      
      query += ' GROUP BY user_id';

      const result = await pool.query(query, params);
      
      return result.rows;
    } catch (error) {
      logger.error('Failed to get usage stats:', error);
      return [];
    }
  }

  /**
   * API 端点：获取 TURN 凭证
   */
  async getCredentialsHandler(req, res) {
    try {
      const userId = req.user?.id;
      
      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
      }

      const credentials = await this.generateCredentials(userId);
      
      res.json({
        success: true,
        data: credentials
      });
    } catch (error) {
      logger.error('Failed to get TURN credentials:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate credentials'
      });
    }
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    try {
      // 检查配置是否完整
      const hasSecret = !!process.env.TURN_SECRET;
      const hasHost = !!process.env.TURN_HOST;

      return {
        status: 'healthy',
        config: {
          hasSecret,
          hasHost,
          realm: this.config.realm,
          port: this.config.listeningPort
        }
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }
}

// 单例模式
let turnServerManagerInstance = null;

function getTURNServerManager() {
  if (!turnServerManagerInstance) {
    turnServerManagerInstance = new TURNServerManager();
  }
  return turnServerManagerInstance;
}

module.exports = {
  TURNServerManager,
  getTURNServerManager
};