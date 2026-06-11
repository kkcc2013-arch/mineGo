/**
 * REQ-00038: 审计日志加密存储模块
 * 扩展现有 auditLog.js，支持审计日志加密存储
 * 
 * 主要功能：
 * 1. 使用 AES-256-GCM 加密敏感审计数据
 * 2. 密钥管理与轮换
 * 3. 安全的日志解密接口
 */

'use strict';

const crypto = require('crypto');
const { createLogger } = require('./logger');

const logger = createLogger('audit-log-encrypted');

// 动态加载数据库模块
let dbModule = null;
function getDb() {
  if (!dbModule) {
    try {
      dbModule = require('./db');
    } catch (err) {
      logger.warn('Database module not available, using fallback storage');
      return null;
    }
  }
  return dbModule;
}

function query(text, params) {
  const db = getDb();
  if (!db) {
    throw new Error('Database not available for encrypted audit log');
  }
  return db.query(text, params);
}

// ============================================================
// 配置常量
// ============================================================

const ENCRYPTION_CONFIG = {
  algorithm: 'aes-256-gcm',
  keyLength: 32,
  ivLength: 16,
  authTagLength: 16,
  keyRotationDays: 90,
};

// ============================================================
// 密钥管理
// ============================================================

/**
 * 获取或创建加密密钥
 */
async function getOrCreateEncryptionKey() {
  const db = getDb();
  if (!db) {
    // 使用环境变量密钥（开发环境）
    const keyHex = process.env.AUDIT_ENCRYPTION_KEY;
    if (!keyHex) {
      logger.warn('AUDIT_ENCRYPTION_KEY not set, generating temporary key (NOT FOR PRODUCTION)');
      return {
        keyId: 'temp-' + Date.now(),
        workKey: crypto.randomBytes(32),
        isTemporary: true,
      };
    }
    return {
      keyId: 'env-key',
      workKey: Buffer.from(keyHex, 'hex'),
    };
  }

  // 尝试从数据库获取活跃密钥
  const result = await db.query(
    `SELECT id, encrypted_key, created_at, expires_at
     FROM encryption_keys
     WHERE is_active = true AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC
     LIMIT 1`
  );

  if (result.rows.length > 0) {
    const workKey = await decryptWorkKey(result.rows[0].id, result.rows[0].encrypted_key);
    return {
      keyId: result.rows[0].id,
      workKey,
    };
  }

  // 创建新密钥
  const keyId = crypto.randomBytes(32).toString('hex');
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;

  if (!masterKey) {
    logger.warn('MASTER_ENCRYPTION_KEY not set, using development mode');
    // 开发环境：直接使用环境变量或生成临时密钥
    const workKey = process.env.DATA_ENCRYPTION_KEY
      ? Buffer.from(process.env.DATA_ENCRYPTION_KEY, 'hex')
      : crypto.randomBytes(32);

    return {
      keyId,
      workKey,
    };
  }

  // 生产环境：使用主密钥加密工作密钥
  const masterKeyBuffer = Buffer.from(masterKey, 'hex');
  const workKey = crypto.randomBytes(32);

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKeyBuffer, iv);

  let encryptedKey = cipher.update(workKey, undefined, 'hex');
  encryptedKey += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // 存储到数据库
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + ENCRYPTION_CONFIG.keyRotationDays);

  await query(
    `INSERT INTO encryption_keys (id, encrypted_key, created_at, expires_at, is_active)
     VALUES ($1, $2, NOW(), $3, true)`,
    [keyId, iv.toString('hex') + ':' + encryptedKey + ':' + authTag.toString('hex'), expiresAt]
  );

  return { keyId, workKey };
}

/**
 * 解密工作密钥
 */
async function decryptWorkKey(keyId, encryptedKeyData) {
  const masterKey = process.env.MASTER_ENCRYPTION_KEY;
  
  if (!masterKey) {
    // 开发环境：直接使用环境变量
    return process.env.DATA_ENCRYPTION_KEY 
      ? Buffer.from(process.env.DATA_ENCRYPTION_KEY, 'hex')
      : null;
  }

  const parts = encryptedKeyData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted key format');
  }

  const [ivHex, encryptedKey, authTagHex] = parts;
  const masterKeyBuffer = Buffer.from(masterKey, 'hex');

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    masterKeyBuffer,
    Buffer.from(ivHex, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  let workKey = decipher.update(encryptedKey, 'hex', 'hex');
  workKey += decipher.final('hex');

  return Buffer.from(workKey, 'hex');
}

// ============================================================
// 审计日志加密
// ============================================================

/**
 * 加密审计日志数据
 * @param {object} logData - 日志数据
 * @returns {Promise<{encryptedData: string, iv: string, authTag: string, keyId: string}>}
 */
async function encryptAuditLog(logData) {
  try {
    const { keyId, workKey } = await getOrCreateEncryptionKey();
    
    if (!workKey) {
      logger.warn('No encryption key available, storing log in plaintext (development mode)');
      return {
        encryptedData: JSON.stringify(logData),
        iv: null,
        authTag: null,
        keyId: 'dev-mode',
      };
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', workKey, iv);

    const logString = JSON.stringify(logData);
    let encrypted = cipher.update(logString, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
      encryptedData: encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
      keyId,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to encrypt audit log');
    throw err;
  }
}

/**
 * 解密审计日志数据
 * @param {string} encryptedData - 加密数据
 * @param {string} ivHex - 初始化向量
 * @param {string} authTagHex - 认证标签
 * @param {string} keyId - 密钥 ID
 * @returns {Promise<object>} 解密后的日志数据
 */
async function decryptAuditLog(encryptedData, ivHex, authTagHex, keyId) {
  try {
    // 开发模式：直接返回
    if (keyId === 'dev-mode' || !ivHex || !authTagHex) {
      return JSON.parse(encryptedData);
    }

    // 获取密钥
    const result = await query(
      `SELECT encrypted_key FROM encryption_keys WHERE id = $1`,
      [keyId]
    );

    if (result.rows.length === 0) {
      throw new Error(`Encryption key not found: ${keyId}`);
    }

    const workKey = await decryptWorkKey(keyId, result.rows[0].encrypted_key);

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      workKey,
      Buffer.from(ivHex, 'hex')
    );

    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return JSON.parse(decrypted);
  } catch (err) {
    logger.error({ err, keyId }, 'Failed to decrypt audit log');
    throw err;
  }
}

// ============================================================
// 审计日志写入（加密版本）
// ============================================================

/**
 * 写入加密审计日志
 * @param {object} params - 日志参数
 * @param {string} params.userId - 用户 ID
 * @param {string} params.action - 操作类型
 * @param {object} params.actionData - 操作数据
 * @param {string} params.resourceType - 资源类型
 * @param {string} params.resourceId - 资源 ID
 * @param {string} params.ipAddress - IP 地址
 * @param {string} params.userAgent - User Agent
 */
async function writeEncryptedAuditLog(params) {
  const {
    userId,
    action,
    actionData,
    resourceType,
    resourceId,
    ipAddress,
    userAgent,
  } = params;

  // 准备要加密的数据
  const dataToEncrypt = {
    actionData,
    ipAddress,
    userAgent,
    timestamp: new Date().toISOString(),
  };

  // 加密敏感数据
  const { encryptedData, iv, authTag, keyId } = await encryptAuditLog(dataToEncrypt);

  // 写入数据库
  const result = await query(
    `INSERT INTO audit_logs (
      user_id, action, resource_type, resource_id,
      encrypted_data, encryption_key_id, encryption_iv,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    RETURNING id`,
    [
      userId,
      action,
      resourceType,
      resourceId,
      Buffer.from(encryptedData, 'hex'),
      keyId,
      iv,
    ]
  );

  logger.debug({ logId: result.rows[0].id }, 'Encrypted audit log written');

  return result.rows[0].id;
}

/**
 * 查询并解密审计日志
 * @param {object} filters - 查询条件
 * @param {string} filters.userId - 用户 ID
 * @param {string} filters.action - 操作类型
 * @param {Date} filters.startDate - 开始日期
 * @param {Date} filters.endDate - 结束日期
 * @param {number} limit - 限制数量
 * @returns {Promise<Array>} 解密后的日志列表
 */
async function queryDecryptedAuditLogs(filters = {}, limit = 100) {
  const conditions = [];
  const values = [];
  let paramIndex = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    values.push(filters.userId);
  }

  if (filters.action) {
    conditions.push(`action = $${paramIndex++}`);
    values.push(filters.action);
  }

  if (filters.startDate) {
    conditions.push(`created_at >= $${paramIndex++}`);
    values.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push(`created_at <= $${paramIndex++}`);
    values.push(filters.endDate);
  }

  values.push(limit);

  const result = await query(
    `SELECT 
      id, user_id, action, resource_type, resource_id,
      encrypted_data, encryption_key_id, encryption_iv,
      created_at
    FROM audit_logs
    ${conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT $${paramIndex}`,
    values
  );

  // 解密日志
  const decryptedLogs = await Promise.all(
    result.rows.map(async (row) => {
      try {
        const encryptedData = row.encrypted_data.toString('hex');
        const decrypted = await decryptAuditLog(
          encryptedData,
          row.encryption_iv,
          row.encryption_key_id
        );

        return {
          id: row.id,
          userId: row.user_id,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id,
          createdAt: row.created_at,
          ...decrypted,
        };
      } catch (err) {
        logger.error({ err, logId: row.id }, 'Failed to decrypt log entry');
        return {
          id: row.id,
          error: 'Decryption failed',
        };
      }
    })
  );

  return decryptedLogs;
}

// ============================================================
// 密钥轮换
// ============================================================

/**
 * 执行密钥轮换
 * @returns {Promise<{newKeyId: string, rotatedAt: Date}>}
 */
async function rotateEncryptionKey() {
  logger.info('Starting encryption key rotation');

  // 创建新密钥
  const { keyId, workKey } = await getOrCreateEncryptionKey();

  // 标记旧密钥为非活跃
  await query(
    `UPDATE encryption_keys
     SET is_active = false
     WHERE id != $1 AND is_active = true`,
    [keyId]
  );

  logger.info({ newKeyId: keyId }, 'Encryption key rotation completed');

  return {
    newKeyId: keyId,
    rotatedAt: new Date(),
  };
}

/**
 * 获取密钥状态
 * @returns {Promise<Array>}
 */
async function getEncryptionKeyStatus() {
  const result = await query(
    `SELECT id, algorithm, created_at, expires_at, is_active
     FROM encryption_keys
     ORDER BY created_at DESC`
  );

  return result.rows.map(row => ({
    keyId: row.id,
    algorithm: row.algorithm,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    isActive: row.is_active,
  }));
}

// ============================================================
// 导出
// ============================================================

module.exports = {
  encryptAuditLog,
  decryptAuditLog,
  writeEncryptedAuditLog,
  queryDecryptedAuditLogs,
  rotateEncryptionKey,
  getEncryptionKeyStatus,
  ENCRYPTION_CONFIG,
};
