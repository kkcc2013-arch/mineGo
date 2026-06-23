/**
 * Emergency Response Service - 密钥应急响应服务
 * 
 * 提供密钥泄露时的紧急响应机制，包括立即撤销、紧急轮换等。
 * 
 * @module shared/kms/EmergencyResponseService
 */

'use strict';

const { getKeyVault } = require('./KeyVault');
const { getKeyService } = require('./KeyService');
const logger = require('../logger');

// 数据库连接（延迟加载）
let db = null;

function getDb() {
  if (!db) {
    db = require('../db');
  }
  return db;
}

class EmergencyResponseService {
  constructor(options = {}) {
    this.vault = getKeyVault();
    this.keyService = getKeyService();
    this.alertCallback = options.alertCallback;
  }

  /**
   * 紧急撤销密钥（泄露时使用）
   * 
   * @param {string} keyName - 密钥名称
   * @param {string} reason - 撤销原因
   * @returns {Promise<Object>} - 撤销结果
   */
  async revokeKey(keyName, reason) {
    const database = getDb();
    const keyMeta = await this.getKeyMeta(keyName);
    
    if (!keyMeta) {
      throw new Error(`Key ${keyName} not found`);
    }

    logger.critical(`[KMS] EMERGENCY: Revoking key ${keyName}: ${reason}`);

    const client = await database.getClient();
    
    try {
      await client.query('BEGIN');

      // 立即撤销所有活跃版本
      const revokeResult = await client.query(
        `UPDATE kms_key_versions 
         SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
         WHERE key_id = $1 AND status IN ('active', 'deprecated')
         RETURNING version`,
        [keyMeta.id]
      );

      // 标记密钥为 inactive
      await client.query(
        `UPDATE kms_keys SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [keyMeta.id]
      );
      
      // 记录安全事件
      await client.query(
        `INSERT INTO security_incidents 
         (key_id, key_name, action, reason, severity, created_at)
         VALUES ($1, $2, 'emergency_revoke', $3, 'critical', CURRENT_TIMESTAMP)`,
        [keyMeta.id, keyMeta.key_name, reason]
      );

      // 记录审计日志
      await client.query(
        `INSERT INTO kms_access_logs 
         (key_id, service_name, action, success, details, created_at)
         VALUES ($1, 'emergency-response', 'emergency_revoke', true, $2, CURRENT_TIMESTAMP)`,
        [keyMeta.id, JSON.stringify({ reason, revokedVersions: revokeResult.rows.map(r => r.version) })]
      );

      await client.query('COMMIT');

      // 清除所有缓存
      this.keyService.clearCache(keyName);

      // 发送紧急告警
      await this.sendEmergencyAlert(keyName, reason, 'revoked');

      logger.critical(`[KMS] Key ${keyName} emergency revoked: ${reason}`);

      return {
        keyName,
        revokedVersions: revokeResult.rows.map(r => r.version),
        reason,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`[KMS] Failed to emergency revoke key ${keyName}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 紧急轮换密钥
   * 
   * @param {string} keyName - 密钥名称
   * @param {string} reason - 轮换原因
   * @returns {Promise<Object>} - 轮换结果，包含新密钥值
   */
  async emergencyRotate(keyName, reason) {
    const database = getDb();
    const keyMeta = await this.getKeyMeta(keyName);
    
    if (!keyMeta) {
      throw new Error(`Key ${keyName} not found`);
    }

    logger.critical(`[KMS] EMERGENCY: Emergency rotating key ${keyName}: ${reason}`);

    const client = await database.getClient();
    
    try {
      await client.query('BEGIN');

      // 立即撤销所有版本
      await client.query(
        `UPDATE kms_key_versions 
         SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
         WHERE key_id = $1 AND status != 'revoked'`,
        [keyMeta.id]
      );

      // 生成新密钥
      const newKeyValue = this.vault.generateKey(keyMeta.key_type);
      
      // 加密新密钥
      const encrypted = this.vault.encrypt(newKeyValue);
      const newVersion = 1; // 从 1 开始，因为已撤销所有旧版本

      // 创建新版本
      await client.query(
        `INSERT INTO kms_key_versions 
         (key_id, version, encrypted_value, iv, tag, algorithm, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', CURRENT_TIMESTAMP + ($7 || ' days')::interval)`,
        [
          keyMeta.id, 
          newVersion, 
          encrypted.encrypted_value, 
          encrypted.iv, 
          encrypted.tag,
          encrypted.algorithm,
          keyMeta.rotation_period_days
        ]
      );

      // 激活密钥并重置版本号
      await client.query(
        `UPDATE kms_keys 
         SET is_active = true, 
             current_version = 1,
             last_rotated_at = CURRENT_TIMESTAMP,
             next_rotation_at = CURRENT_TIMESTAMP + (rotation_period_days || ' days')::interval,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [keyMeta.id]
      );

      // 记录安全事件
      await client.query(
        `INSERT INTO security_incidents 
         (key_id, key_name, action, reason, severity, created_at)
         VALUES ($1, $2, 'emergency_rotate', $3, 'critical', CURRENT_TIMESTAMP)`,
        [keyMeta.id, keyMeta.key_name, reason]
      );

      // 记录审计日志
      await client.query(
        `INSERT INTO kms_access_logs 
         (key_id, service_name, action, success, details, created_at)
         VALUES ($1, 'emergency-response', 'emergency_rotate', true, $2, CURRENT_TIMESTAMP)`,
        [keyMeta.id, JSON.stringify({ reason, newVersion })]
      );

      await client.query('COMMIT');

      // 清除所有缓存
      this.keyService.clearCache(keyName);

      // 发送紧急告警
      await this.sendEmergencyAlert(keyName, reason, 'rotated');

      logger.critical(`[KMS] Key ${keyName} emergency rotated`);

      return { 
        keyName, 
        newVersion,
        newKeyValue, // 返回新密钥值，用于更新服务配置
        reason,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`[KMS] Failed to emergency rotate key ${keyName}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取密钥元数据
   */
  async getKeyMeta(keyName) {
    const database = getDb();
    return database.queryOne('SELECT * FROM kms_keys WHERE key_name = $1', [keyName]);
  }

  /**
   * 发送紧急告警
   */
  async sendEmergencyAlert(keyName, reason, action) {
    const alert = {
      level: 'critical',
      event: 'key_emergency_action',
      keyName,
      action,
      reason,
      timestamp: new Date().toISOString()
    };

    logger.critical('[KMS] Emergency alert:', alert);

    if (this.alertCallback) {
      try {
        await this.alertCallback(alert);
      } catch (err) {
        logger.error('[KMS] Alert callback failed:', err);
      }
    }

    // 发送到监控系统
    try {
      const metrics = require('../metrics');
      metrics.increment('kms.emergency_actions', 1, [`key:${keyName}`, `action:${action}`]);
    } catch (err) {
      // 忽略监控错误
    }
  }

  /**
   * 获取安全事件历史
   */
  async getIncidentHistory(options = {}) {
    const database = getDb();
    const { limit = 50, keyName } = options;
    
    let query = 'SELECT * FROM security_incidents WHERE 1=1';
    const params = [];
    
    if (keyName) {
      params.push(keyName);
      query += ` AND key_name = $${params.length}`;
    }
    
    query += ' ORDER BY created_at DESC';
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
    
    return database.query(query, params);
  }

  /**
   * 检查密钥健康状态
   */
  async checkKeyHealth() {
    const database = getDb();
    
    const issues = [];

    // 检查过期未轮换的密钥
    const expiredKeys = await database.query(
      `SELECT key_name, sensitivity, next_rotation_at 
       FROM kms_keys 
       WHERE is_active = true 
       AND next_rotation_at < CURRENT_TIMESTAMP`
    );
    
    if (expiredKeys.rows.length > 0) {
      issues.push({
        type: 'expired_keys',
        severity: 'high',
        keys: expiredKeys.rows
      });
    }

    // 检查近期即将过期的密钥（7 天内）
    const soonToExpire = await database.query(
      `SELECT key_name, sensitivity, next_rotation_at 
       FROM kms_keys 
       WHERE is_active = true 
       AND next_rotation_at BETWEEN CURRENT_TIMESTAMP AND CURRENT_TIMESTAMP + INTERVAL '7 days'`
    );
    
    if (soonToExpire.rows.length > 0) {
      issues.push({
        type: 'soon_to_expire',
        severity: 'medium',
        keys: soonToExpire.rows
      });
    }

    // 检查未激活的密钥
    const inactiveKeys = await database.query(
      `SELECT key_name FROM kms_keys WHERE is_active = false`
    );
    
    if (inactiveKeys.rows.length > 0) {
      issues.push({
        type: 'inactive_keys',
        severity: 'low',
        keys: inactiveKeys.rows
      });
    }

    return {
      healthy: issues.length === 0,
      issues,
      checkedAt: new Date().toISOString()
    };
  }
}

// 单例模式
let instance = null;

function getEmergencyResponseService(options) {
  if (!instance) {
    instance = new EmergencyResponseService(options);
  }
  return instance;
}

module.exports = {
  EmergencyResponseService,
  getEmergencyResponseService
};
