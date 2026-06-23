/**
 * Key Rotation Service - 密钥轮换服务
 * 
 * 提供自动和手动密钥轮换功能，支持零停机轮换。
 * 
 * @module shared/kms/KeyRotationService
 */

'use strict';

const { getKeyVault } = require('./KeyVault');
const { getKeyService, RotationPeriod } = require('./KeyService');
const logger = require('../logger');

// 数据库连接（延迟加载）
let db = null;

function getDb() {
  if (!db) {
    db = require('../db');
  }
  return db;
}

class KeyRotationService {
  constructor(options = {}) {
    this.vault = getKeyVault();
    this.keyService = getKeyService();
    this.notificationCallback = options.notificationCallback;
  }

  /**
   * 轮换密钥（零停机）
   * 
   * 策略：
   * 1. 生成新版本密钥
   * 2. 新版本激活，旧版本标记为 deprecated
   * 3. 保留旧版本 24 小时（允许正在进行的请求完成）
   * 4. 24 小时后撤销旧版本
   * 
   * @param {string} keyId - 密钥 ID 或密钥名称
   * @param {string} reason - 轮换原因
   * @returns {Promise<Object>} - 轮换结果
   */
  async rotateKey(keyId, reason = 'scheduled') {
    const database = getDb();
    const keyMeta = await this.getKeyMeta(keyId);
    
    if (!keyMeta) {
      throw new Error(`Key ${keyId} not found`);
    }

    if (!keyMeta.is_active) {
      throw new Error(`Key ${keyMeta.key_name} is not active`);
    }

    const newVersion = keyMeta.current_version + 1;
    
    logger.info(`[KMS] Rotating key ${keyMeta.key_name} from version ${keyMeta.current_version} to ${newVersion}`);

    const client = await database.getClient();
    
    try {
      await client.query('BEGIN');

      // 生成新密钥
      const newKeyValue = this.vault.generateKey(keyMeta.key_type);
      
      // 加密新密钥
      const encrypted = this.vault.encrypt(newKeyValue);

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
      
      // 旧版本标记为 deprecated（但仍然有效，支持零停机）
      await client.query(
        `UPDATE kms_key_versions 
         SET status = 'deprecated' 
         WHERE key_id = $1 AND version = $2 AND status = 'active'`,
        [keyMeta.id, keyMeta.current_version]
      );
      
      // 更新密钥元数据
      await client.query(
        `UPDATE kms_keys 
         SET current_version = $1, 
             last_rotated_at = CURRENT_TIMESTAMP,
             next_rotation_at = CURRENT_TIMESTAMP + (rotation_period_days || ' days')::interval,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [newVersion, keyMeta.id]
      );

      // 记录审计日志
      await client.query(
        `INSERT INTO kms_access_logs 
         (key_id, service_name, action, success, details, created_at)
         VALUES ($1, 'kms-rotation', 'rotate', true, $2, CURRENT_TIMESTAMP)`,
        [
          keyMeta.id, 
          JSON.stringify({ 
            fromVersion: keyMeta.current_version, 
            toVersion: newVersion,
            reason 
          })
        ]
      );

      await client.query('COMMIT');

      // 清除缓存
      this.keyService.clearCache(keyMeta.key_name);
      
      // 发送通知
      await this.notifyRotation(keyMeta.key_name, newVersion, reason);
      
      // 安排旧版本清理（24 小时后）
      this.scheduleOldVersionCleanup(keyMeta.id, keyMeta.current_version);

      logger.info(`[KMS] Key ${keyMeta.key_name} rotated successfully to version ${newVersion}`);

      return { 
        keyName: keyMeta.key_name, 
        newVersion,
        previousVersion: keyMeta.current_version
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`[KMS] Failed to rotate key ${keyMeta.key_name}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 获取密钥元数据
   */
  async getKeyMeta(keyId) {
    const database = getDb();
    
    // 支持 UUID 或密钥名称
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyId);
    
    if (isUUID) {
      return database.queryOne('SELECT * FROM kms_keys WHERE id = $1', [keyId]);
    } else {
      return database.queryOne('SELECT * FROM kms_keys WHERE key_name = $1', [keyId]);
    }
  }

  /**
   * 检查并轮换到期密钥
   */
  async checkAndRotateExpired() {
    const database = getDb();
    
    const keysToRotate = await database.query(
      `SELECT * FROM kms_keys 
       WHERE is_active = true 
       AND next_rotation_at <= CURRENT_TIMESTAMP
       ORDER BY sensitivity ASC`  // 先轮换高敏感密钥
    );

    const results = [];
    
    for (const key of keysToRotate.rows) {
      try {
        const result = await this.rotateKey(key.id, 'scheduled');
        results.push({ keyName: key.key_name, success: true, result });
      } catch (error) {
        logger.error(`[KMS] Failed to rotate key ${key.key_name}:`, error);
        results.push({ keyName: key.key_name, success: false, error: error.message });
        
        // 发送失败通知
        await this.alertRotationFailed(key, error);
      }
    }

    return results;
  }

  /**
   * 安排旧版本清理
   */
  scheduleOldVersionCleanup(keyId, version) {
    // 24 小时后撤销旧版本
    setTimeout(async () => {
      try {
        const database = getDb();
        await database.query(
          `UPDATE kms_key_versions 
           SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
           WHERE key_id = $1 AND version = $2 AND status = 'deprecated'`,
          [keyId, version]
        );
        logger.info(`[KMS] Key version ${keyId}:${version} revoked after grace period`);
      } catch (error) {
        logger.error(`[KMS] Failed to revoke old key version:`, error);
      }
    }, 24 * 60 * 60 * 1000);
  }

  /**
   * 发送轮换通知
   */
  async notifyRotation(keyName, newVersion, reason) {
    const notification = {
      event: 'key_rotated',
      keyName,
      newVersion,
      reason,
      timestamp: new Date().toISOString()
    };

    if (this.notificationCallback) {
      try {
        await this.notificationCallback(notification);
      } catch (error) {
        logger.error('[KMS] Notification callback failed:', error);
      }
    }

    // 发送到日志
    logger.info('[KMS] Key rotation notification:', notification);
  }

  /**
   * 轮换失败告警
   */
  async alertRotationFailed(keyMeta, error) {
    const alert = {
      level: 'critical',
      event: 'key_rotation_failed',
      keyName: keyMeta.key_name,
      sensitivity: keyMeta.sensitivity,
      error: error.message,
      timestamp: new Date().toISOString()
    };

    logger.error('[KMS] Key rotation failed alert:', alert);

    if (this.notificationCallback) {
      try {
        await this.notificationCallback(alert);
      } catch (err) {
        logger.error('[KMS] Alert callback failed:', err);
      }
    }
  }

  /**
   * 立即撤销密钥版本
   */
  async revokeVersion(keyName, version, reason) {
    const database = getDb();
    const keyMeta = await this.getKeyMeta(keyName);
    
    if (!keyMeta) {
      throw new Error(`Key ${keyName} not found`);
    }

    await database.query(
      `UPDATE kms_key_versions 
       SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
       WHERE key_id = $1 AND version = $2`,
      [keyMeta.id, version]
    );

    // 清除缓存
    this.keyService.clearCache(keyName);

    // 记录审计日志
    await database.query(
      `INSERT INTO kms_access_logs 
       (key_id, service_name, action, success, details, created_at)
       VALUES ($1, 'kms-revoke', 'revoke', true, $2, CURRENT_TIMESTAMP)`,
      [keyMeta.id, JSON.stringify({ version, reason })]
    );

    logger.info(`[KMS] Key ${keyName} version ${version} revoked: ${reason}`);

    return { keyName, version, reason };
  }

  /**
   * 获取轮换状态
   */
  async getRotationStatus() {
    const database = getDb();
    
    const result = await database.query(
      `SELECT 
         k.key_name,
         k.key_type,
         k.sensitivity,
         k.current_version,
         k.last_rotated_at,
         k.next_rotation_at,
         k.rotation_period_days,
         EXTRACT(EPOCH FROM (k.next_rotation_at - CURRENT_TIMESTAMP)) / 86400 as days_until_rotation
       FROM kms_keys k
       WHERE k.is_active = true
       ORDER BY k.next_rotation_at ASC`
    );

    return result.rows;
  }
}

// 单例模式
let instance = null;

function getKeyRotationService(options) {
  if (!instance) {
    instance = new KeyRotationService(options);
  }
  return instance;
}

module.exports = {
  KeyRotationService,
  getKeyRotationService
};
