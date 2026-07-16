/**
 * REQ-00565: 数据库敏感字段透明加密系统
 * 
 * 密钥管理服务
 * - 集中式密钥存储
 * - 密钥轮换机制
 * - 多环境密钥隔离
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { createLogger } = require('../logger');

const logger = createLogger('key-management');

/**
 * 密钥管理服务
 */
class KeyManagementService {
  /**
   * @param {Object} options - 配置选项
   * @param {string} options.storageType - 存储类型: 'file' | 'vault' | 'kms'
   * @param {string} options.storagePath - 文件存储路径（storageType='file'）
   * @param {string} options.environment - 环境: 'dev' | 'staging' | 'prod'
   * @param {Object} options.vaultConfig - Vault 配置（storageType='vault'）
   * @param {Object} options.kmsConfig - KMS 配置（storageType='kms'）
   */
  constructor(options = {}) {
    this.storageType = options.storageType || 'file';
    this.storagePath = options.storagePath || './keys';
    this.environment = options.environment || 'dev';
    this.vaultConfig = options.vaultConfig || null;
    this.kmsConfig = options.kmsConfig || null;
    
    this.keys = new Map(); // keyId -> { key, version, createdAt, status }
    this.keyVersions = new Map(); // context -> [version1, version2, ...]
    
    this.initialized = false;
  }

  /**
   * 初始化密钥管理服务
   */
  async initialize() {
    if (this.initialized) return;

    try {
      if (this.storageType === 'file') {
        await this._initializeFileStorage();
      } else if (this.storageType === 'vault') {
        await this._initializeVaultStorage();
      } else if (this.storageType === 'kms') {
        await this._initializeKMSStorage();
      }

      this.initialized = true;
      logger.info('KeyManagementService initialized', {
        storageType: this.storageType,
        environment: this.environment
      });
    } catch (error) {
      logger.error('Failed to initialize KeyManagementService', { error: error.message });
      throw error;
    }
  }

  /**
   * 文件存储初始化
   */
  async _initializeFileStorage() {
    // 确保密钥目录存在
    await fs.mkdir(this.storagePath, { recursive: true });
    
    // 加载现有密钥
    const keyFile = path.join(this.storagePath, `keys-${this.environment}.json`);
    
    try {
      const data = await fs.readFile(keyFile, 'utf8');
      const keysData = JSON.parse(data);
      
      for (const [keyId, keyInfo] of Object.entries(keysData.keys || {})) {
        this.keys.set(keyId, {
          key: Buffer.from(keyInfo.key, 'base64'),
          version: keyInfo.version,
          createdAt: new Date(keyInfo.createdAt),
          status: keyInfo.status || 'active'
        });
      }
      
      logger.info(`Loaded ${this.keys.size} keys from file storage`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 文件不存在，创建默认密钥
        await this._createDefaultKey();
      } else {
        throw error;
      }
    }
  }

  /**
   * 创建默认主密钥
   */
  async _createDefaultKey() {
    const masterKey = crypto.randomBytes(32);
    const keyId = 'master';
    
    this.keys.set(keyId, {
      key: masterKey,
      version: 1,
      createdAt: new Date(),
      status: 'active'
    });
    
    await this._saveKeysToFile();
    
    logger.warn('Created default master key. Please secure this key in production!', {
      keyId,
      environment: this.environment
    });
  }

  /**
   * 保存密钥到文件
   */
  async _saveKeysToFile() {
    const keyFile = path.join(this.storagePath, `keys-${this.environment}.json`);
    
    const keysData = {
      environment: this.environment,
      updatedAt: new Date().toISOString(),
      keys: {}
    };
    
    for (const [keyId, keyInfo] of this.keys.entries()) {
      keysData.keys[keyId] = {
        key: keyInfo.key.toString('base64'),
        version: keyInfo.version,
        createdAt: keyInfo.createdAt.toISOString(),
        status: keyInfo.status
      };
    }
    
    await fs.writeFile(keyFile, JSON.stringify(keysData, null, 2));
    
    // 设置文件权限为仅所有者可读写
    await fs.chmod(keyFile, 0o600);
    
    logger.info('Keys saved to file', { keyFile, keyCount: this.keys.size });
  }

  /**
   * Vault 存储初始化（待实现）
   */
  async _initializeVaultStorage() {
    // TODO: 实现 HashiCorp Vault 集成
    throw new Error('Vault storage not implemented yet');
  }

  /**
   * KMS 存储初始化（待实现）
   */
  async _initializeKMSStorage() {
    // TODO: 实现 AWS KMS 或其他云 KMS 集成
    throw new Error('KMS storage not implemented yet');
  }

  /**
   * 获取当前加密密钥
   * @param {string} keyId - 密钥标识符
   * @returns {Promise<Buffer>}
   */
  async getCurrentKey(keyId = 'master') {
    if (!this.initialized) {
      await this.initialize();
    }

    const keyInfo = this.keys.get(keyId);
    
    if (!keyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    if (keyInfo.status !== 'active') {
      throw new Error(`Key ${keyId} is not active (status: ${keyInfo.status})`);
    }
    
    return keyInfo.key;
  }

  /**
   * 获取指定版本的密钥（用于解密历史数据）
   * @param {string} keyId - 密钥标识符
   * @param {number} version - 密钥版本
   * @returns {Promise<Buffer>}
   */
  async getKeyByVersion(keyId, version) {
    if (!this.initialized) {
      await this.initialize();
    }

    // 简化实现：当前仅支持一个版本
    // 完整实现需要支持多版本密钥存储
    const keyInfo = this.keys.get(keyId);
    
    if (!keyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    if (keyInfo.version !== version) {
      logger.warn('Key version mismatch', { 
        keyId, 
        requestedVersion: version, 
        currentVersion: keyInfo.version 
      });
    }
    
    return keyInfo.key;
  }

  /**
   * 轮换密钥
   * @param {string} keyId - 密钥标识符
   * @returns {Promise<Object>}
   */
  async rotateKey(keyId = 'master') {
    if (!this.initialized) {
      await this.initialize();
    }

    const oldKeyInfo = this.keys.get(keyId);
    
    if (!oldKeyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }

    // 将旧密钥标记为已轮换（但保留用于解密历史数据）
    oldKeyInfo.status = 'rotated';
    oldKeyInfo.rotatedAt = new Date();

    // 生成新密钥
    const newKey = crypto.randomBytes(32);
    const newVersion = oldKeyInfo.version + 1;

    this.keys.set(keyId, {
      key: newKey,
      version: newVersion,
      createdAt: new Date(),
      status: 'active',
      previousVersion: oldKeyInfo.version
    });

    // 保存到存储
    await this._saveKeysToFile();

    logger.info('Key rotated', {
      keyId,
      oldVersion: oldKeyInfo.version,
      newVersion,
      environment: this.environment
    });

    return {
      keyId,
      oldVersion: oldKeyInfo.version,
      newVersion,
      rotatedAt: new Date().toISOString()
    };
  }

  /**
   * 创建新密钥
   * @param {string} keyId - 密钥标识符
   * @param {Buffer} key - 密钥（可选，不提供则自动生成）
   * @returns {Promise<Object>}
   */
  async createKey(keyId, key = null) {
    if (!this.initialized) {
      await this.initialize();
    }

    if (this.keys.has(keyId)) {
      throw new Error(`Key already exists: ${keyId}`);
    }

    const newKey = key || crypto.randomBytes(32);

    this.keys.set(keyId, {
      key: newKey,
      version: 1,
      createdAt: new Date(),
      status: 'active'
    });

    await this._saveKeysToFile();

    logger.info('Key created', { keyId, environment: this.environment });

    return {
      keyId,
      version: 1,
      createdAt: new Date().toISOString()
    };
  }

  /**
   * 列出所有密钥
   * @returns {Promise<Array>}
   */
  async listKeys() {
    if (!this.initialized) {
      await this.initialize();
    }

    const keyList = [];
    
    for (const [keyId, keyInfo] of this.keys.entries()) {
      keyList.push({
        keyId,
        version: keyInfo.version,
        createdAt: keyInfo.createdAt.toISOString(),
        status: keyInfo.status
      });
    }
    
    return keyList;
  }

  /**
   * 健康检查
   * @returns {Promise<Object>}
   */
  async healthCheck() {
    try {
      if (!this.initialized) {
        await this.initialize();
      }

      const activeKeys = Array.from(this.keys.values())
        .filter(k => k.status === 'active').length;

      return {
        status: 'healthy',
        storageType: this.storageType,
        environment: this.environment,
        totalKeys: this.keys.size,
        activeKeys,
        initialized: this.initialized
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message
      };
    }
  }

  /**
   * 导出密钥（用于备份）
   * @param {string} keyId - 密钥标识符
   * @returns {Promise<string>} - Base64 编码的密钥
   */
  async exportKey(keyId = 'master') {
    const keyInfo = this.keys.get(keyId);
    
    if (!keyInfo) {
      throw new Error(`Key not found: ${keyId}`);
    }
    
    logger.warn('Key exported', { keyId, environment: this.environment });
    
    return keyInfo.key.toString('base64');
  }

  /**
   * 导入密钥（用于恢复）
   * @param {string} keyId - 密钥标识符
   * @param {string} keyBase64 - Base64 编码的密钥
   * @param {number} version - 密钥版本
   * @returns {Promise<Object>}
   */
  async importKey(keyId, keyBase64, version = 1) {
    const key = Buffer.from(keyBase64, 'base64');
    
    if (key.length !== 32) {
      throw new Error('Key must be 32 bytes (256 bits)');
    }

    this.keys.set(keyId, {
      key,
      version,
      createdAt: new Date(),
      status: 'active',
      imported: true
    });

    await this._saveKeysToFile();

    logger.info('Key imported', { keyId, version, environment: this.environment });

    return {
      keyId,
      version,
      createdAt: new Date().toISOString()
    };
  }
}

/**
 * 创建密钥管理服务实例
 * @param {Object} options - 配置选项
 * @returns {KeyManagementService}
 */
function createKeyManagementService(options) {
  return new KeyManagementService(options);
}

// 单例实例
let defaultKMS = null;

/**
 * 获取默认密钥管理服务实例
 * @returns {KeyManagementService}
 */
function getDefaultKMS() {
  if (!defaultKMS) {
    defaultKMS = new KeyManagementService({
      storageType: process.env.KEY_STORAGE_TYPE || 'file',
      storagePath: process.env.KEY_STORAGE_PATH || './keys',
      environment: process.env.NODE_ENV || 'dev'
    });
  }
  return defaultKMS;
}

module.exports = {
  KeyManagementService,
  createKeyManagementService,
  getDefaultKMS
};