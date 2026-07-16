/**
 * REQ-00565: 数据库敏感字段透明加密系统
 * 
 * 加密引擎核心实现
 * - AES-256-GCM 作为默认加密算法
 * - 支持确定性加密（用于可查询字段）和非确定性加密（高敏感字段）
 * - 基于密钥派生函数（HKDF）的上下文密钥生成
 */

'use strict';

const crypto = require('crypto');
const { createLogger } = require('../logger');

const logger = createLogger('encryption-engine');

/**
 * 加密算法配置
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 IV 长度
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16;

/**
 * 加密引擎类
 */
class EncryptionEngine {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.masterKey - 主密钥（Base64 编码）
   * @param {string} options.keyId - 密钥标识符
   * @param {Object} options.keyProvider - 密钥提供者（可选，用于密钥轮换）
   */
  constructor(options = {}) {
    if (!options.masterKey && !options.keyProvider) {
      throw new Error('Either masterKey or keyProvider is required');
    }

    this.masterKey = options.masterKey 
      ? Buffer.from(options.masterKey, 'base64')
      : null;
    this.keyId = options.keyId || 'default';
    this.keyProvider = options.keyProvider || null;
    this.keyCache = new Map();

    // 验证主密钥长度
    if (this.masterKey && this.masterKey.length !== KEY_LENGTH) {
      throw new Error(`Master key must be ${KEY_LENGTH} bytes, got ${this.masterKey.length}`);
    }

    logger.info('EncryptionEngine initialized', { keyId: this.keyId });
  }

  /**
   * 获取加密密钥（派生密钥）
   * @param {string} context - 加密上下文（表名+字段名）
   * @returns {Promise<Buffer>}
   */
  async getEncryptionKey(context) {
    const masterKey = this.keyProvider 
      ? await this.keyProvider.getCurrentKey(this.keyId)
      : this.masterKey;

    // 使用 HKDF 从主密钥派生上下文密钥
    // info: "pmg-encryption:<context>"
    const info = `pmg-encryption:${context}`;
    
    // 从缓存获取
    const cacheKey = `${this.keyId}:${context}`;
    if (this.keyCache.has(cacheKey)) {
      return this.keyCache.get(cacheKey);
    }

    // 派生密钥
    const derivedKey = crypto.hkdfSync(
      masterKey,
      'pmg-salt', // 固定 salt（主密钥不同即可）
      info,
      KEY_LENGTH,
      'sha256'
    );

    // 缓存派生密钥（TTL 5分钟）
    this.keyCache.set(cacheKey, Buffer.from(derivedKey));
    setTimeout(() => this.keyCache.delete(cacheKey), 5 * 60 * 1000);

    return Buffer.from(derivedKey);
  }

  /**
   * 加密数据
   * @param {string} plaintext - 明文
   * @param {string} context - 加密上下文（表名+字段名）
   * @param {Object} options - 加密选项
   * @param {boolean} options.deterministic - 是否使用确定性加密
   * @returns {Promise<string>} - Base64 编码的密文
   */
  async encrypt(plaintext, context, options = {}) {
    if (plaintext === null || plaintext === undefined) {
      return null;
    }

    const plaintextStr = String(plaintext);
    if (plaintextStr === '') {
      return '';
    }

    try {
      const key = await this.getEncryptionKey(context);
      let iv, ciphertext;

      if (options.deterministic) {
        // 确定性加密：IV 由上下文和明文派生
        const ivMaterial = crypto.createHash('sha256')
          .update(context)
          .update(plaintextStr)
          .digest()
          .slice(0, IV_LENGTH);
        iv = ivMaterial;
      } else {
        // 非确定性加密：随机 IV
        iv = crypto.randomBytes(IV_LENGTH);
      }

      const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH
      });

      ciphertext = Buffer.concat([
        cipher.update(plaintextStr, 'utf8'),
        cipher.final()
      ]);

      const authTag = cipher.getAuthTag();

      // 格式：[IV_LENGTH|IV|AUTH_TAG|CIPHERTEXT]
      // 添加版本前缀以便未来升级
      const version = Buffer.from([0x01]); // 版本 1
      const encrypted = Buffer.concat([version, iv, authTag, ciphertext]);

      return encrypted.toString('base64');
    } catch (error) {
      logger.error('Encryption failed', { context, error: error.message });
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  /**
   * 解密数据
   * @param {string} ciphertext - Base64 编码的密文
   * @param {string} context - 加密上下文
   * @returns {Promise<string>} - 明文
   */
  async decrypt(ciphertext, context) {
    if (ciphertext === null || ciphertext === undefined) {
      return null;
    }

    if (ciphertext === '') {
      return '';
    }

    try {
      const encrypted = Buffer.from(ciphertext, 'base64');

      // 解析格式
      const version = encrypted[0];
      if (version !== 0x01) {
        throw new Error(`Unsupported encryption version: ${version}`);
      }

      const iv = encrypted.slice(1, 1 + IV_LENGTH);
      const authTag = encrypted.slice(1 + IV_LENGTH, 1 + IV_LENGTH + AUTH_TAG_LENGTH);
      const data = encrypted.slice(1 + IV_LENGTH + AUTH_TAG_LENGTH);

      const key = await this.getEncryptionKey(context);

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH
      });

      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(data),
        decipher.final()
      ]);

      return decrypted.toString('utf8');
    } catch (error) {
      logger.error('Decryption failed', { context, error: error.message });
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }

  /**
   * 确定性加密（用于可查询字段）
   * 相同明文 + 相同上下文 → 相同密文
   * @param {string} plaintext - 明文
   * @param {string} context - 加密上下文
   * @returns {Promise<string>}
   */
  async encryptDeterministic(plaintext, context) {
    return this.encrypt(plaintext, context, { deterministic: true });
  }

  /**
   * 非确定性加密（高敏感字段）
   * 每次加密结果不同
   * @param {string} plaintext - 明文
   * @param {string} context - 加密上下文
   * @returns {Promise<string>}
   */
  async encryptRandom(plaintext, context) {
    return this.encrypt(plaintext, context, { deterministic: false });
  }

  /**
   * 生成盲索引（用于模糊查询）
   * @param {string} plaintext - 明文
   * @param {string} context - 索引上下文
   * @returns {Promise<string>} - 索引值（十六进制）
   */
  async generateBlindIndex(plaintext, context) {
    if (!plaintext) return null;

    const key = await this.getEncryptionKey(`index:${context}`);
    
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(String(plaintext));
    
    return hmac.digest('hex');
  }

  /**
   * 批量加密
   * @param {Array<{value: string, context: string}>} items - 加密项列表
   * @param {Object} options - 加密选项
   * @returns {Promise<string[]>}
   */
  async encryptBatch(items, options = {}) {
    return Promise.all(
      items.map(item => this.encrypt(item.value, item.context, options))
    );
  }

  /**
   * 批量解密
   * @param {Array<{value: string, context: string}>} items - 解密项列表
   * @returns {Promise<string[]>}
   */
  async decryptBatch(items) {
    return Promise.all(
      items.map(item => this.decrypt(item.value, item.context))
    );
  }

  /**
   * 健康检查
   * @returns {Promise<Object>}
   */
  async healthCheck() {
    try {
      const testContext = 'health:check';
      const testPlaintext = 'test-data-12345';
      
      const encrypted = await this.encrypt(testPlaintext, testContext);
      const decrypted = await this.decrypt(encrypted, testContext);
      
      const success = decrypted === testPlaintext;
      
      return {
        status: success ? 'healthy' : 'unhealthy',
        algorithm: ALGORITHM,
        keyId: this.keyId,
        cacheSize: this.keyCache.size
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  /**
   * 清除密钥缓存
   */
  clearCache() {
    this.keyCache.clear();
    logger.info('Encryption key cache cleared');
  }
}

/**
 * 创建加密引擎实例
 * @param {Object} options - 配置选项
 * @returns {EncryptionEngine}
 */
function createEncryptionEngine(options) {
  return new EncryptionEngine(options);
}

module.exports = {
  EncryptionEngine,
  createEncryptionEngine,
  ALGORITHM,
  KEY_LENGTH,
  IV_LENGTH,
  AUTH_TAG_LENGTH
};