/**
 * SecureStorage - 安全存储模块
 * 
 * 功能：
 * - 关键数据加密存储
 * - 数据完整性校验
 * - 访问审计日志
 * 
 * @module frontend/game-client/src/security/SecureStorage
 */

const { memoryGuard } = require('./MemoryGuard');

// 保护的数据类型定义
const SECURE_DATA_KEYS = {
  PLAYER_CURRENCY: 'player:currency',           // 金币、宝石、星尘
  PLAYER_INVENTORY: 'player:inventory',         // 精灵球、药水数量
  POKEMON_CP: (id) => `pokemon:${id}:cp`,       // 精灵 CP
  POKEMON_IV: (id) => `pokemon:${id}:iv`,       // 精灵 IV
  POKEMON_STATS: (id) => `pokemon:${id}:stats`, // 精灵完整属性
  BATTLE_STATE: 'battle:state',                 // 战斗状态
  CATCH_STATE: 'catch:state',                   // 捕捉状态
  PLAYER_PROFILE: 'player:profile'              // 玩家档案
};

class SecureStorage {
  constructor() {
    this.memoryGuard = memoryGuard;
    this.encryptedData = new Map();
    this.accessLog = [];
    this.maxLogEntries = 100;
    this.encryptionKey = null;
    this.ready = false;
    
    // 敏感数据模式
    this.sensitivePatterns = [
      /password/i,
      /token/i,
      /secret/i,
      /key/i,
      /auth/i,
      /credential/i
    ];
  }

  /**
   * 初始化安全存储
   * @returns {Promise<void>}
   */
  async init() {
    if (this.ready) return;
    
    // 确保 MemoryGuard 已初始化
    if (!this.memoryGuard.initialized) {
      await this.memoryGuard.init();
    }
    
    // 派生加密密钥
    this.encryptionKey = await this.deriveEncryptionKey();
    this.ready = true;
    
    console.log('[SecureStorage] Initialized');
  }

  /**
   * 派生加密密钥
   * @returns {Promise<CryptoKey>}
   */
  async deriveEncryptionKey() {
    const baseKey = this.memoryGuard.secretKey || 'default-key';
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      encoder.encode(baseKey),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: encoder.encode('minego-secure-storage'),
        iterations: 100000,
        hash: 'SHA-256'
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * 安全存储数据
   * @param {string} key 
   * @param {*} value 
   * @param {Object} options 
   * @returns {boolean}
   */
  async setSecure(key, value, options = {}) {
    try {
      if (!this.ready) await this.init();
      
      // 序列化数据
      const jsonStr = JSON.stringify(value);
      
      // 加密
      const encrypted = await this.encrypt(jsonStr);
      
      // 生成校验码
      const checksum = this.memoryGuard.generateChecksum(value, key);
      
      // 存储加密数据和校验信息
      const storageItem = {
        encrypted,
        checksum,
        timestamp: Date.now(),
        version: 1,
        metadata: options.metadata || {}
      };
      
      this.encryptedData.set(key, storageItem);
      
      // 同时存入 localStorage（可选持久化）
      if (options.persist) {
        localStorage.setItem(`secure:${key}`, JSON.stringify(storageItem));
      }
      
      // 记录访问
      this.logAccess(key, 'write', true);
      
      return true;
    } catch (error) {
      console.error(`[SecureStorage] Failed to set ${key}:`, error);
      this.logAccess(key, 'write', false);
      return false;
    }
  }

  /**
   * 安全读取数据
   * @param {string} key 
   * @returns {*}
   */
  async getSecure(key) {
    try {
      if (!this.ready) await this.init();
      
      // 优先从内存获取
      let stored = this.encryptedData.get(key);
      
      // 如果内存没有，尝试从 localStorage 加载
      if (!stored) {
        const persisted = localStorage.getItem(`secure:${key}`);
        if (persisted) {
          stored = JSON.parse(persisted);
          this.encryptedData.set(key, stored);
        }
      }
      
      if (!stored) {
        return null;
      }
      
      // 解密
      const decrypted = await this.decrypt(stored.encrypted);
      const value = JSON.parse(decrypted);
      
      // 验证完整性
      if (!this.memoryGuard.verifyChecksum(value, key)) {
        throw new Error(`Integrity check failed for ${key}`);
      }
      
      // 记录访问
      this.logAccess(key, 'read', true);
      
      return value;
    } catch (error) {
      console.error(`[SecureStorage] Failed to get ${key}:`, error);
      this.logAccess(key, 'read', false);
      return null;
    }
  }

  /**
   * 更新安全数据
   * @param {string} key 
   * @param {Function} updater 
   * @returns {*}
   */
  async updateSecure(key, updater) {
    const current = await this.getSecure(key);
    const updated = updater(current);
    await this.setSecure(key, updated);
    return updated;
  }

  /**
   * 删除安全数据
   * @param {string} key 
   * @returns {boolean}
   */
  async removeSecure(key) {
    try {
      this.encryptedData.delete(key);
      localStorage.removeItem(`secure:${key}`);
      this.memoryGuard.checksums.delete(key);
      this.logAccess(key, 'delete', true);
      return true;
    } catch (error) {
      console.error(`[SecureStorage] Failed to remove ${key}:`, error);
      return false;
    }
  }

  /**
   * AES-GCM 加密
   * @param {string} plaintext 
   * @returns {Promise<string>}
   */
  async encrypt(plaintext) {
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      encoder.encode(plaintext)
    );
    
    // 合并 IV 和密文
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    
    // Base64 编码
    return btoa(String.fromCharCode(...combined));
  }

  /**
   * AES-GCM 解密
   * @param {string} encrypted 
   * @returns {Promise<string>}
   */
  async decrypt(encrypted) {
    // Base64 解码
    const combined = new Uint8Array(
      atob(encrypted).split('').map(c => c.charCodeAt(0))
    );
    
    // 分离 IV 和密文
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      ciphertext
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  }

  /**
   * 记录访问日志
   * @param {string} key 
   * @param {string} operation 
   * @param {boolean} success 
   */
  logAccess(key, operation, success) {
    this.accessLog.push({
      key,
      operation,
      success,
      timestamp: Date.now(),
      url: window.location.href
    });
    
    // 限制日志大小
    if (this.accessLog.length > this.maxLogEntries) {
      this.accessLog = this.accessLog.slice(-this.maxLogEntries);
    }
  }

  /**
   * 获取访问日志
   * @returns {Array}
   */
  getAccessLog() {
    return [...this.accessLog];
  }

  /**
   * 检查是否为敏感数据键
   * @param {string} key 
   * @returns {boolean}
   */
  isSensitiveKey(key) {
    return this.sensitivePatterns.some(pattern => pattern.test(key));
  }

  /**
   * 批量设置安全数据
   * @param {Object} items 
   * @returns {Object}
   */
  async setSecureBatch(items) {
    const results = {};
    
    for (const [key, value] of Object.entries(items)) {
      results[key] = await this.setSecure(key, value);
    }
    
    return results;
  }

  /**
   * 批量获取安全数据
   * @param {string[]} keys 
   * @returns {Object}
   */
  async getSecureBatch(keys) {
    const results = {};
    
    for (const key of keys) {
      results[key] = await this.getSecure(key);
    }
    
    return results;
  }

  /**
   * 导出安全数据（用于备份）
   * @returns {Object}
   */
  async exportSecure() {
    const exported = {
      timestamp: Date.now(),
      sessionId: this.memoryGuard.sessionId,
      data: {}
    };
    
    for (const [key, value] of this.encryptedData.entries()) {
      exported.data[key] = {
        encrypted: value.encrypted,
        checksum: value.checksum,
        timestamp: value.timestamp
      };
    }
    
    return exported;
  }

  /**
   * 清空所有安全数据
   */
  async clearAll() {
    this.encryptedData.clear();
    this.accessLog = [];
    
    // 清除 localStorage 中的安全数据
    const keys = Object.keys(localStorage);
    for (const key of keys) {
      if (key.startsWith('secure:')) {
        localStorage.removeItem(key);
      }
    }
    
    console.log('[SecureStorage] All data cleared');
  }

  /**
   * 获取存储统计信息
   * @returns {Object}
   */
  getStats() {
    let totalSize = 0;
    
    for (const [key, value] of this.encryptedData.entries()) {
      totalSize += JSON.stringify(value).length;
    }
    
    return {
      itemCount: this.encryptedData.size,
      totalSize,
      totalSizeKB: (totalSize / 1024).toFixed(2),
      accessLogCount: this.accessLog.length,
      ready: this.ready
    };
  }
}

// 单例导出
const secureStorage = new SecureStorage();

// 全局暴露
if (typeof window !== 'undefined') {
  window.__secureStorage = secureStorage;
}

module.exports = { SecureStorage, secureStorage, SECURE_DATA_KEYS };
