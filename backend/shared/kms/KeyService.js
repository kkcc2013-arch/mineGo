/**
 * Key Service - 密钥访问服务
 * 
 * 提供密钥的统一访问接口，支持缓存、审计日志、自动刷新。
 * 
 * @module shared/kms/KeyService
 */

'use strict';

const { getKeyVault } = require('./KeyVault');
const logger = require('../logger');

// 数据库连接（延迟加载）
let db = null;

function getDb() {
  if (!db) {
    db = require('../db');
  }
  return db;
}

/**
 * 密钥类型枚举
 */
const KeyType = {
  JWT_SECRET: 'jwt_secret',
  API_KEY: 'api_key',
  DATABASE_PASSWORD: 'db_password',
  REDIS_PASSWORD: 'redis_password',
  ENCRYPTION_KEY: 'encryption_key',
  OAUTH_SECRET: 'oauth_secret',
  PAYMENT_KEY: 'payment_key',
  NOTIFICATION_KEY: 'notification_key'
};

/**
 * 密钥敏感等级
 */
const KeySensitivity = {
  CRITICAL: 'critical',   // P0：支付、加密密钥，轮换周期 30 天
  HIGH: 'high',           // P1：JWT、数据库密码，轮换周期 90 天
  MEDIUM: 'medium',       // P2：API 密钥，轮换周期 180 天
  LOW: 'low'              // P3：通知密钥，轮换周期 365 天
};

/**
 * 轮换周期配置（天）
 */
const RotationPeriod = {
  critical: 30,
  high: 90,
  medium: 180,
  low: 365
};

class KeyService {
  constructor(options = {}) {
    this.vault = getKeyVault();
    this.cache = new Map();
    this.cacheTTLMs = options.cacheTTLMs || 5 * 60 * 1000; // 5 分钟缓存
    this.serviceName = process.env.SERVICE_NAME || 'unknown';
    this.enableAudit = options.enableAudit !== false;
    
    // 启动时清理过期缓存
    this.startCacheCleanup();
  }

  /**
   * 获取密钥（优先缓存）
   * 
   * @param {string} keyName - 密钥名称
   * @param {Object} options - { version: 'latest' | number }
   * @returns {Promise<string>} - 明文密钥
   */
  async getKey(keyName, options = {}) {
    const version = options.version || 'latest';
    const cacheKey = `${keyName}:${version}`;
    
    // 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTLMs) {
      if (this.enableAudit) {
        await this.logAccess(keyName, 'read', true, { cacheHit: true });
      }
      return cached.value;
    }

    try {
      // 从数据库获取
      const keyMeta = await this.getKeyMeta(keyName);
      const targetVersion = version === 'latest' ? keyMeta.current_version : version;
      
      const keyVersion = await this.getKeyVersion(keyMeta.id, targetVersion);

      if (!keyVersion || keyVersion.status !== 'active') {
        throw new Error(`Key ${keyName} version ${targetVersion} not available`);
      }

      // 解密
      const decrypted = this.vault.decrypt(
        keyVersion.encrypted_value,
        keyVersion.iv,
        keyVersion.tag
      );

      // 缓存
      this.cache.set(cacheKey, {
        value: decrypted,
        timestamp: Date.now()
      });

      if (this.enableAudit) {
        await this.logAccess(keyName, 'read', true, { cacheHit: false, version: targetVersion });
      }
      
      return decrypted;
    } catch (error) {
      if (this.enableAudit) {
        await this.logAccess(keyName, 'read', false, { error: error.message });
      }
      throw error;
    }
  }

  /**
   * 获取密钥元数据
   */
  async getKeyMeta(keyName) {
    const database = getDb();
    const result = await database.queryOne(
      'SELECT * FROM kms_keys WHERE key_name = $1 AND is_active = true',
      [keyName]
    );
    
    if (!result) {
      throw new Error(`Key ${keyName} not found`);
    }
    
    return result;
  }

  /**
   * 获取密钥特定版本
   */
  async getKeyVersion(keyId, version) {
    const database = getDb();
    return database.queryOne(
      'SELECT * FROM kms_key_versions WHERE key_id = $1 AND version = $2',
      [keyId, version]
    );
  }

  /**
   * 创建新密钥
   * 
   * @param {Object} params - { keyName, keyType, sensitivity, value?, rotationPeriodDays? }
   * @returns {Promise<Object>} - 创建的密钥信息
   */
  async createKey(params) {
    const { keyName, keyType, sensitivity, value, rotationPeriodDays } = params;
    
    if (!keyName || !keyType || !sensitivity) {
      throw new Error('keyName, keyType, and sensitivity are required');
    }

    const database = getDb();
    
    // 检查是否已存在
    const existing = await database.queryOne(
      'SELECT id FROM kms_keys WHERE key_name = $1',
      [keyName]
    );
    
    if (existing) {
      throw new Error(`Key ${keyName} already exists`);
    }

    // 生成或使用提供的密钥值
    const keyValue = value || this.vault.generateKey(keyType);
    
    // 加密
    const encrypted = this.vault.encrypt(keyValue);
    
    // 确定轮换周期
    const rotationDays = rotationPeriodDays || RotationPeriod[sensitivity] || 90;

    const client = await database.getClient();
    
    try {
      await client.query('BEGIN');

      // 创建密钥记录
      const keyResult = await client.query(
        `INSERT INTO kms_keys 
         (key_type, key_name, sensitivity, current_version, rotation_period_days, next_rotation_at)
         VALUES ($1, $2, $3, 1, $4, CURRENT_TIMESTAMP + ($4 || ' days')::interval)
         RETURNING *`,
        [keyType, keyName, sensitivity, rotationDays]
      );

      const key = keyResult.rows[0];

      // 创建第一个版本
      await client.query(
        `INSERT INTO kms_key_versions 
         (key_id, version, encrypted_value, iv, tag, algorithm, status, expires_at)
         VALUES ($1, 1, $2, $3, $4, $5, 'active', CURRENT_TIMESTAMP + ($6 || ' days')::interval)`,
        [key.id, encrypted.encrypted_value, encrypted.iv, encrypted.tag, 
         encrypted.algorithm, rotationDays]
      );

      await client.query('COMMIT');

      if (this.enableAudit) {
        await this.logAccess(keyName, 'create', true, { keyType, sensitivity });
      }

      return {
        id: key.id,
        keyName: key.key_name,
        keyType: key.key_type,
        sensitivity: key.sensitivity,
        currentVersion: 1
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 记录访问日志
   */
  async logAccess(keyName, action, success, details = {}) {
    try {
      const database = getDb();
      
      // 获取密钥 ID
      const keyMeta = await database.queryOne(
        'SELECT id FROM kms_keys WHERE key_name = $1',
        [keyName]
      );

      if (!keyMeta) {
        return; // 密钥不存在，不记录
      }

      await database.query(
        `INSERT INTO kms_access_logs 
         (key_id, service_name, action, success, details, created_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [
          keyMeta.id,
          this.serviceName,
          action,
          success,
          JSON.stringify(details)
        ]
      );
    } catch (error) {
      // 日志记录失败不应影响主流程
      logger.error('[KMS] Failed to log access:', error);
    }
  }

  /**
   * 清除密钥缓存
   */
  clearCache(keyName) {
    if (keyName) {
      // 清除特定密钥的所有版本缓存
      for (const key of this.cache.keys()) {
        if (key.startsWith(keyName + ':')) {
          this.cache.delete(key);
        }
      }
    } else {
      // 清除所有缓存
      this.cache.clear();
    }
  }

  /**
   * 启动缓存清理
   */
  startCacheCleanup() {
    // 每 10 分钟清理过期缓存
    setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.cache.entries()) {
        if (now - value.timestamp > this.cacheTTLMs * 2) {
          this.cache.delete(key);
        }
      }
    }, 10 * 60 * 1000);
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  /**
   * 获取所有密钥列表（不包含值）
   */
  async listKeys(options = {}) {
    const database = getDb();
    const { limit = 100, offset = 0, sensitivity, keyType } = options;
    
    let query = 'SELECT id, key_name, key_type, sensitivity, current_version, last_rotated_at, next_rotation_at, is_active FROM kms_keys WHERE 1=1';
    const params = [];
    
    if (sensitivity) {
      params.push(sensitivity);
      query += ` AND sensitivity = $${params.length}`;
    }
    
    if (keyType) {
      params.push(keyType);
      query += ` AND key_type = $${params.length}`;
    }
    
    query += ' ORDER BY sensitivity ASC, key_name ASC';
    query += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    return database.query(query, params);
  }

  /**
   * 获取访问日志
   */
  async getAccessLogs(keyName, options = {}) {
    const database = getDb();
    const { limit = 100 } = options;
    
    const keyMeta = await this.getKeyMeta(keyName);
    
    return database.query(
      `SELECT * FROM kms_access_logs
       WHERE key_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [keyMeta.id, limit]
    );
  }
}

// 单例模式
let instance = null;

function getKeyService(options) {
  if (!instance) {
    instance = new KeyService(options);
  }
  return instance;
}

module.exports = {
  KeyService,
  getKeyService,
  KeyType,
  KeySensitivity,
  RotationPeriod
};
