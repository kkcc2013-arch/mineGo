/**
 * REQ-00016: 数据加密模块
 * 用于加密敏感数据（GPS 位置、支付信息等）
 */

const crypto = require('crypto');
const logger = require('./logger');

class DataEncryption {
  constructor() {
    this.algorithm = 'aes-256-gcm';
    // 从环境变量获取加密密钥（32 字节 = 256 位）
    const keyHex = process.env.DATA_ENCRYPTION_KEY;
    if (!keyHex) {
      logger.warn('DATA_ENCRYPTION_KEY not set, using development key (NOT FOR PRODUCTION)');
      this.key = crypto.randomBytes(32);
    } else {
      this.key = Buffer.from(keyHex, 'hex');
    }
    
    if (this.key.length !== 32) {
      throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
    }
  }

  /**
   * 加密文本数据
   * @param {string} text - 要加密的文本
   * @returns {{encrypted: string, iv: string, authTag: string}}
   */
  encrypt(text) {
    try {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
      
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      const authTag = cipher.getAuthTag();
      
      return {
        encrypted,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex')
      };
    } catch (err) {
      logger.error({ err }, 'Encryption failed');
      throw new Error('Data encryption failed');
    }
  }

  /**
   * 解密数据
   * @param {string} encrypted - 加密数据（hex）
   * @param {string} ivHex - 初始化向量（hex）
   * @param {string} authTagHex - 认证标签（hex）
   * @returns {string} 解密后的文本
   */
  decrypt(encrypted, ivHex, authTagHex) {
    try {
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.key,
        Buffer.from(ivHex, 'hex')
      );
      
      decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
      
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (err) {
      logger.error({ err }, 'Decryption failed');
      throw new Error('Data decryption failed');
    }
  }

  /**
   * 加密 JSON 对象
   * @param {object} obj - 要加密的对象
   * @returns {{encrypted: string, iv: string, authTag: string}}
   */
  encryptObject(obj) {
    return this.encrypt(JSON.stringify(obj));
  }

  /**
   * 解密 JSON 对象
   * @param {string} encrypted - 加密数据
   * @param {string} iv - 初始化向量
   * @param {string} authTag - 认证标签
   * @returns {object} 解密后的对象
   */
  decryptObject(encrypted, iv, authTag) {
    const text = this.decrypt(encrypted, iv, authTag);
    return JSON.parse(text);
  }

  /**
   * 加密 GPS 位置
   * @param {number} lat - 纬度
   * @param {number} lng - 经度
   * @returns {{encrypted: string, iv: string, authTag: string}}
   */
  encryptLocation(lat, lng) {
    return this.encryptObject({ lat, lng, timestamp: Date.now() });
  }

  /**
   * 解密 GPS 位置
   * @param {string} encrypted - 加密数据
   * @param {string} iv - 初始化向量
   * @param {string} authTag - 认证标签
   * @returns {{lat: number, lng: number, timestamp: number}}
   */
  decryptLocation(encrypted, iv, authTag) {
    return this.decryptObject(encrypted, iv, authTag);
  }
}

// 单例
let instance = null;

function getEncryption() {
  if (!instance) {
    instance = new DataEncryption();
  }
  return instance;
}

module.exports = {
  DataEncryption,
  getEncryption,
  encrypt: (text) => getEncryption().encrypt(text),
  decrypt: (encrypted, iv, authTag) => getEncryption().decrypt(encrypted, iv, authTag),
  encryptObject: (obj) => getEncryption().encryptObject(obj),
  decryptObject: (encrypted, iv, authTag) => getEncryption().decryptObject(encrypted, iv, authTag),
  encryptLocation: (lat, lng) => getEncryption().encryptLocation(lat, lng),
  decryptLocation: (encrypted, iv, authTag) => getEncryption().decryptLocation(encrypted, iv, authTag)
};
