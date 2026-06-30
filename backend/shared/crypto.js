/**
 * REQ-00399: 加密工具模块
 * 提供密码哈希、验证和 API Key 生成功能
 */

const crypto = require('crypto');
const logger = require('./logger');

// 配置
const SALT_LENGTH = 16;
const HASH_LENGTH = 64;
const HASH_ITERATIONS = 100000;
const API_KEY_LENGTH = 32;

/**
 * 密码哈希 (使用 PBKDF2)
 * 
 * @param {string} password - 明文密码
 * @returns {Promise<string>} 哈希后的密码 (格式: salt:hash)
 */
async function hashPassword(password) {
  return new Promise((resolve, reject) => {
    try {
      const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
      
      crypto.pbkdf2(
        password,
        salt,
        HASH_ITERATIONS,
        HASH_LENGTH,
        'sha512',
        (err, derivedKey) => {
          if (err) {
            logger.error({
              module: 'crypto',
              msg: 'Failed to hash password',
              error: err.message
            });
            reject(err);
          } else {
            const hash = derivedKey.toString('hex');
            resolve(`${salt}:${hash}`);
          }
        }
      );
    } catch (error) {
      logger.error({
        module: 'crypto',
        msg: 'Failed to hash password',
        error: error.message
      });
      reject(error);
    }
  });
}

/**
 * 验证密码
 * 
 * @param {string} password - 明文密码
 * @param {string} storedHash - 存储的哈希 (格式: salt:hash)
 * @returns {Promise<boolean>} 是否匹配
 */
async function comparePassword(password, storedHash) {
  return new Promise((resolve) => {
    try {
      if (!storedHash || !storedHash.includes(':')) {
        resolve(false);
        return;
      }
      
      const [salt, hash] = storedHash.split(':');
      
      crypto.pbkdf2(
        password,
        salt,
        HASH_ITERATIONS,
        HASH_LENGTH,
        'sha512',
        (err, derivedKey) => {
          if (err) {
            logger.error({
              module: 'crypto',
              msg: 'Failed to compare password',
              error: err.message
            });
            resolve(false);
          } else {
            const computedHash = derivedKey.toString('hex');
            // 使用时序安全比较防止时序攻击
            resolve(crypto.timingSafeEqual(
              Buffer.from(hash, 'hex'),
              Buffer.from(computedHash, 'hex')
            ));
          }
        }
      );
    } catch (error) {
      logger.error({
        module: 'crypto',
        msg: 'Failed to compare password',
        error: error.message
      });
      resolve(false);
    }
  });
}

/**
 * 生成 API Key
 * 
 * @param {string} prefix - API Key 前缀 (可选)
 * @returns {string} API Key
 */
function generateApiKey(prefix = 'pk') {
  const randomBytes = crypto.randomBytes(API_KEY_LENGTH).toString('hex');
  const timestamp = Date.now().toString(36);
  const key = `${prefix}_${timestamp}_${randomBytes}`;
  return key;
}

/**
 * 生成随机令牌
 * 
 * @param {number} length - 令牌长度
 * @returns {string} 随机令牌
 */
function generateRandomToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * 哈希数据 (SHA-256)
 * 
 * @param {string} data - 要哈希的数据
 * @returns {string} 哈希值
 */
function hashData(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * HMAC 签名
 * 
 * @param {string} data - 要签名的数据
 * @param {string} secret - 密钥
 * @returns {string} 签名
 */
function signData(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/**
 * 验证签名
 * 
 * @param {string} data - 原始数据
 * @param {string} signature - 签名
 * @param {string} secret - 密钥
 * @returns {boolean} 是否有效
 */
function verifySignature(data, signature, secret) {
  const expectedSignature = signData(data, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature)
  );
}

/**
 * 加密数据 (AES-256-GCM)
 * 
 * @param {string} plaintext - 明文
 * @param {string} key - 加密密钥 (64字符hex)
 * @returns {Object} 包含 iv, ciphertext, authTag
 */
function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  
  let ciphertext = cipher.update(plaintext, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return {
    iv: iv.toString('hex'),
    ciphertext,
    authTag: authTag.toString('hex')
  };
}

/**
 * 解密数据 (AES-256-GCM)
 * 
 * @param {Object} encryptedData - 包含 iv, ciphertext, authTag
 * @param {string} key - 解密密钥 (64字符hex)
 * @returns {string} 明文
 */
function decrypt(encryptedData, key) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'hex'),
    Buffer.from(encryptedData.iv, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
  
  let plaintext = decipher.update(encryptedData.ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  
  return plaintext;
}

module.exports = {
  hashPassword,
  comparePassword,
  generateApiKey,
  generateRandomToken,
  hashData,
  signData,
  verifySignature,
  encrypt,
  decrypt
};
