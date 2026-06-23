/**
 * Key Vault - 密钥加密存储模块
 * 
 * 提供 AES-256-GCM 加密存储能力，所有密钥加密后存储在数据库中。
 * 生产环境应使用外部 KMS 或 HSM 获取主密钥。
 * 
 * @module shared/kms/KeyVault
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class KeyVault {
  constructor(options = {}) {
    this.algorithm = 'aes-256-gcm';
    this.masterKey = this.getMasterKey(options);
    this.keyFile = options.keyFile || path.join(process.cwd(), '.master-key');
    
    // 开发环境警告
    if (process.env.NODE_ENV !== 'production' && !process.env.MASTER_KEY) {
      console.warn('[KeyVault] Warning: Using auto-generated master key. Set MASTER_KEY in production.');
    }
  }

  /**
   * 获取主密钥
   * 优先级：环境变量 > 密钥文件 > 自动生成（仅开发环境）
   */
  getMasterKey(options) {
    // 1. 环境变量
    if (process.env.MASTER_KEY) {
      const key = Buffer.from(process.env.MASTER_KEY, 'hex');
      if (key.length !== 32) {
        throw new Error('MASTER_KEY must be 32 bytes (64 hex characters)');
      }
      return process.env.MASTER_KEY;
    }

    // 2. 选项传入
    if (options.masterKey) {
      const key = Buffer.from(options.masterKey, 'hex');
      if (key.length !== 32) {
        throw new Error('masterKey must be 32 bytes (64 hex characters)');
      }
      return options.masterKey;
    }

    // 3. 生产环境必须设置主密钥
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MASTER_KEY must be set in production environment');
    }

    // 4. 开发环境：尝试从文件读取或生成
    return this.getOrCreateDevKey();
  }

  /**
   * 开发环境：获取或创建主密钥
   */
  getOrCreateDevKey() {
    const keyFile = this.keyFile;
    
    try {
      // 尝试读取现有密钥文件
      if (fs.existsSync(keyFile)) {
        const key = fs.readFileSync(keyFile, 'utf8').trim();
        if (Buffer.from(key, 'hex').length === 32) {
          return key;
        }
      }
    } catch (err) {
      // 忽略读取错误
    }

    // 生成新密钥
    const newKey = crypto.randomBytes(32).toString('hex');
    
    try {
      fs.writeFileSync(keyFile, newKey, { mode: 0o600 });
      console.log(`[KeyVault] Generated new master key, saved to ${keyFile}`);
    } catch (err) {
      console.warn(`[KeyVault] Could not save master key file: ${err.message}`);
    }
    
    return newKey;
  }

  /**
   * 加密明文密钥
   * 
   * @param {string} plaintext - 明文密钥
   * @returns {Object} - { encrypted_value, iv, tag, algorithm }
   */
  encrypt(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') {
      throw new Error('Plaintext must be a non-empty string');
    }

    const iv = crypto.randomBytes(16);
    const keyBuffer = Buffer.from(this.masterKey, 'hex');
    
    const cipher = crypto.createCipheriv(this.algorithm, keyBuffer, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    return {
      encrypted_value: encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      algorithm: this.algorithm
    };
  }

  /**
   * 解密密文
   * 
   * @param {string} encryptedValue - 密文（hex）
   * @param {string} ivHex - 初始化向量（hex）
   * @param {string} tagHex - GCM 认证标签（hex）
   * @returns {string} - 明文密钥
   */
  decrypt(encryptedValue, ivHex, tagHex) {
    if (!encryptedValue || !ivHex || !tagHex) {
      throw new Error('Missing required decryption parameters');
    }

    const keyBuffer = Buffer.from(this.masterKey, 'hex');
    const ivBuffer = Buffer.from(ivHex, 'hex');
    const tagBuffer = Buffer.from(tagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(this.algorithm, keyBuffer, ivBuffer);
    decipher.setAuthTag(tagBuffer);
    
    let decrypted = decipher.update(encryptedValue, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * 生成随机密钥
   * 
   * @param {string} keyType - 密钥类型
   * @param {number} length - 密钥长度（字节）
   * @returns {string} - 生成的密钥
   */
  generateKey(keyType, length = 32) {
    const generators = {
      jwt_secret: () => crypto.randomBytes(64).toString('hex'),
      api_key: () => crypto.randomBytes(32).toString('hex'),
      db_password: () => this.generatePassword(length || 32),
      redis_password: () => this.generatePassword(length || 32),
      encryption_key: () => crypto.randomBytes(32).toString('hex'),
      oauth_secret: () => crypto.randomBytes(32).toString('hex'),
      payment_key: () => crypto.randomBytes(32).toString('hex'),
      notification_key: () => crypto.randomBytes(32).toString('hex')
    };
    
    const generator = generators[keyType];
    if (!generator) {
      // 默认生成随机 hex 密钥
      return crypto.randomBytes(length).toString('hex');
    }
    
    return generator();
  }

  /**
   * 生成强密码
   * 
   * @param {number} length - 密码长度
   * @returns {string} - 生成的密码
   */
  generatePassword(length) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    
    // 确保包含各类字符
    const lowers = 'abcdefghijklmnopqrstuvwxyz';
    const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const specials = '!@#$%^&*';
    
    password += lowers[crypto.randomInt(0, lowers.length)];
    password += uppers[crypto.randomInt(0, uppers.length)];
    password += digits[crypto.randomInt(0, digits.length)];
    password += specials[crypto.randomInt(0, specials.length)];
    
    // 填充剩余长度
    for (let i = password.length; i < length; i++) {
      password += charset[crypto.randomInt(0, charset.length)];
    }
    
    // 打乱顺序
    return password.split('').sort(() => crypto.randomInt(0, 2) - 1).join('');
  }

  /**
   * 验证主密钥是否有效
   */
  validateMasterKey() {
    try {
      const test = this.encrypt('test');
      const decrypted = this.decrypt(test.encrypted_value, test.iv, test.tag);
      return decrypted === 'test';
    } catch (err) {
      return false;
    }
  }

  /**
   * 轮换主密钥（需要重新加密所有密钥）
   * 
   * @param {string} newMasterKey - 新的主密钥
   * @param {Array} encryptedKeys - 所有加密的密钥 [{ encrypted_value, iv, tag }]
   * @returns {Array} - 重新加密后的密钥
   */
  rotateMasterKey(newMasterKey, encryptedKeys) {
    const newVault = new KeyVault({ masterKey: newMasterKey });
    
    return encryptedKeys.map(key => {
      // 用旧密钥解密
      const plaintext = this.decrypt(key.encrypted_value, key.iv, key.tag);
      // 用新密钥加密
      const reEncrypted = newVault.encrypt(plaintext);
      
      return {
        ...key,
        ...reEncrypted
      };
    });
  }
}

// 单例模式
let instance = null;

function getKeyVault(options) {
  if (!instance) {
    instance = new KeyVault(options);
  }
  return instance;
}

module.exports = {
  KeyVault,
  getKeyVault
};
