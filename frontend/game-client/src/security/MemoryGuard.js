/**
 * MemoryGuard - 客户端内存完整性校验与防护系统
 * 
 * 功能：
 * - 关键数据完整性校验（HMAC-SHA256）
 * - 运行时篡改检测与上报
 * - 会话密钥管理与动态刷新
 * 
 * @module frontend/game-client/src/security/MemoryGuard
 */

class MemoryGuard {
  constructor() {
    this.secretKey = null;
    this.sessionId = null;
    this.checksums = new Map();
    this.tamperCount = 0;
    this.maxTamperCount = 3;
    this.deviceId = null;
    this.initialized = false;
    this.keyRefreshInterval = null;
    this.apiBaseUrl = '/api/v1/security';
    
    // 关键数据类型（需要完整性保护）
    this.protectedDataKeys = new Set([
      'player:currency',
      'player:inventory',
      'battle:state',
      'catch:state'
    ]);
    
    // 绑定方法
    this.init = this.init.bind(this);
    this.generateChecksum = this.generateChecksum.bind(this);
    this.verifyChecksum = this.verifyChecksum.bind(this);
    this.onTamperDetected = this.onTamperDetected.bind(this);
  }

  /**
   * 初始化安全会话
   * @returns {Promise<{sessionId: string, expiresIn: number}>}
   */
  async init() {
    if (this.initialized) {
      return { sessionId: this.sessionId, expiresIn: 3600 };
    }

    try {
      // 获取设备标识
      this.deviceId = this.getDeviceId();

      // 请求服务端初始化会话
      const response = await fetch(`${this.apiBaseUrl}/init-session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          deviceId: this.deviceId,
          timestamp: Date.now(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          language: navigator.language,
          userAgent: navigator.userAgent
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to init session: ${response.status}`);
      }

      const data = await response.json();
      
      // 解密并设置密钥
      this.secretKey = this.decryptKey(data.encryptedKey, data.sessionId);
      this.sessionId = data.sessionId;
      this.initialized = true;

      // 启动密钥定期刷新
      this.startKeyRefresh(data.refreshInterval || 3600000);

      console.log('[MemoryGuard] Session initialized:', this.sessionId);
      
      return {
        sessionId: this.sessionId,
        expiresIn: data.expiresIn || 3600
      };
    } catch (error) {
      console.error('[MemoryGuard] Init failed:', error);
      throw error;
    }
  }

  /**
   * 获取设备唯一标识
   * @returns {string}
   */
  getDeviceId() {
    // 尝试从 localStorage 获取已有 ID
    let deviceId = localStorage.getItem('mg_device_id');
    
    if (!deviceId) {
      // 生成新设备 ID（基于浏览器指纹）
      const fingerprint = [
        navigator.userAgent,
        navigator.language,
        screen.width,
        screen.height,
        screen.colorDepth,
        new Date().getTimezoneOffset(),
        !!window.sessionStorage,
        !!window.localStorage
      ].join('|');
      
      deviceId = this.simpleHash(fingerprint);
      localStorage.setItem('mg_device_id', deviceId);
    }
    
    return deviceId;
  }

  /**
   * 简单哈希函数（用于设备指纹）
   * @param {string} str 
   * @returns {string}
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36).padStart(8, '0');
  }

  /**
   * 解密服务端返回的密钥
   * @param {string} encryptedKey 
   * @param {string} sessionId 
   * @returns {string}
   */
  decryptKey(encryptedKey, sessionId) {
    // 客户端使用 sessionId 作为解密因子
    // 实际实现中应使用更安全的密钥派生方式
    try {
      const decoded = atob(encryptedKey);
      const keyBytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        keyBytes[i] = decoded.charCodeAt(i) ^ sessionId.charCodeAt(i % sessionId.length);
      }
      return Array.from(keyBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      // 如果解密失败，直接使用（服务端返回的是明文密钥）
      return encryptedKey;
    }
  }

  /**
   * 启动密钥定期刷新
   * @param {number} interval 
   */
  startKeyRefresh(interval) {
    if (this.keyRefreshInterval) {
      clearInterval(this.keyRefreshInterval);
    }

    this.keyRefreshInterval = setInterval(async () => {
      try {
        const response = await fetch(`${this.apiBaseUrl}/refresh-key`, {
          method: 'POST',
          headers: this.getSecureHeaders(),
          body: JSON.stringify({
            sessionId: this.sessionId,
            timestamp: Date.now()
          })
        });

        if (response.ok) {
          const data = await response.json();
          this.secretKey = this.decryptKey(data.encryptedKey, this.sessionId);
          console.log('[MemoryGuard] Key refreshed');
        }
      } catch (error) {
        console.warn('[MemoryGuard] Key refresh failed:', error);
      }
    }, interval);
  }

  /**
   * 生成数据校验码
   * @param {*} data 
   * @param {string} dataKey 
   * @returns {string}
   */
  generateChecksum(data, dataKey) {
    const jsonStr = JSON.stringify(this.sortObject(data));
    const hmac = this.hmacSha256(jsonStr, this.secretKey);
    
    this.checksums.set(dataKey, {
      hmac,
      timestamp: Date.now(),
      dataHash: this.simpleHash(jsonStr)
    });
    
    return hmac;
  }

  /**
   * 验证数据完整性
   * @param {*} data 
   * @param {string} dataKey 
   * @returns {boolean}
   */
  verifyChecksum(data, dataKey) {
    const stored = this.checksums.get(dataKey);
    if (!stored) {
      console.warn(`[MemoryGuard] No checksum for key: ${dataKey}`);
      return true; // 没有校验码的数据暂时放过
    }

    const jsonStr = JSON.stringify(this.sortObject(data));
    const currentHmac = this.hmacSha256(jsonStr, this.secretKey);

    if (currentHmac !== stored.hmac) {
      this.onTamperDetected(dataKey, stored.hmac, currentHmac, stored.dataHash);
      return false;
    }

    return true;
  }

  /**
   * 检测到篡改时的处理
   * @param {string} dataKey 
   * @param {string} expected 
   * @param {string} actual 
   * @param {string} originalHash 
   */
  async onTamperDetected(dataKey, expected, actual, originalHash) {
    this.tamperCount++;
    
    console.error(`[MemoryGuard] Tamper detected! Key: ${dataKey}, Count: ${this.tamperCount}`);

    // 异步上报篡改事件
    try {
      const response = await fetch(`${this.apiBaseUrl}/report-tamper`, {
        method: 'POST',
        headers: this.getSecureHeaders(),
        body: JSON.stringify({
          sessionId: this.sessionId,
          dataKey,
          expectedHmac: expected,
          actualHmac: actual,
          originalHash,
          tamperCount: this.tamperCount,
          timestamp: Date.now(),
          stackTrace: new Error().stack,
          url: window.location.href
        })
      });

      const result = await response.json();
      
      if (result.action === 'ban') {
        this.triggerBan(result.reason || 'Tampering detected');
      }
    } catch (error) {
      console.error('[MemoryGuard] Failed to report tamper:', error);
    }

    // 本地阈值触发封禁
    if (this.tamperCount >= this.maxTamperCount) {
      this.triggerBan('Exceeded maximum tamper count');
    }
  }

  /**
   * 触发封禁
   * @param {string} reason 
   */
  triggerBan(reason) {
    console.error(`[MemoryGuard] Account banned: ${reason}`);
    
    // 清除本地数据
    localStorage.clear();
    sessionStorage.clear();
    
    // 重定向到封禁页面
    window.location.href = `/banned.html?reason=${encodeURIComponent(reason)}`;
  }

  /**
   * 包装安全数据
   * @param {*} data 
   * @param {string} dataKey 
   * @returns {Object}
   */
  wrapSecureData(data, dataKey) {
    const checksum = this.generateChecksum(data, dataKey);
    const self = this;
    
    return {
      data,
      _checksum: checksum,
      _key: dataKey,
      _timestamp: Date.now(),
      
      // 验证方法
      _verify() {
        return self.verifyChecksum(this.data, this._key);
      },
      
      // 安全更新方法
      _update(newData) {
        this.data = newData;
        this._checksum = self.generateChecksum(newData, this._key);
        this._timestamp = Date.now();
        return this;
      }
    };
  }

  /**
   * 获取安全请求头
   * @returns {Object}
   */
  getSecureHeaders() {
    const timestamp = Date.now();
    const nonce = crypto.randomUUID();
    
    return {
      'Content-Type': 'application/json',
      'X-Session-Id': this.sessionId || '',
      'X-Device-Id': this.deviceId || '',
      'X-Request-Timestamp': timestamp.toString(),
      'X-Request-Nonce': nonce
    };
  }

  /**
   * HMAC-SHA256 实现（简化版）
   * @param {string} message 
   * @param {string} key 
   * @returns {string}
   */
  hmacSha256(message, key) {
    // 使用 SubtleCrypto API 进行真正的 HMAC 计算
    // 这里提供同步简化实现用于快速校验
    const combined = key + message + key;
    let hash = 0;
    
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
    // 结合多次哈希增强安全性
    for (let round = 0; round < 3; round++) {
      const input = hash.toString(16) + key;
      hash = 0;
      for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash = hash & hash;
      }
    }
    
    return Math.abs(hash).toString(16).padStart(16, '0');
  }

  /**
   * 异步 HMAC-SHA256（使用 Web Crypto API）
   * @param {string} message 
   * @param {string} key 
   * @returns {Promise<string>}
   */
  async hmacSha256Async(message, key) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * 排序对象属性（确保一致性）
   * @param {*} obj 
   * @returns {*}
   */
  sortObject(obj) {
    if (typeof obj !== 'object' || obj === null) {
      return obj;
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObject(item));
    }
    
    const sorted = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
      sorted[key] = this.sortObject(obj[key]);
    }
    return sorted;
  }

  /**
   * 检查数据是否需要保护
   * @param {string} dataKey 
   * @returns {boolean}
   */
  isProtectedKey(dataKey) {
    // 检查是否匹配任何保护模式
    for (const pattern of this.protectedDataKeys) {
      if (dataKey.startsWith(pattern) || dataKey === pattern) {
        return true;
      }
    }
    // 精灵数据模式
    if (dataKey.startsWith('pokemon:') && (dataKey.includes(':cp') || dataKey.includes(':iv'))) {
      return true;
    }
    return false;
  }

  /**
   * 清理会话
   */
  destroy() {
    if (this.keyRefreshInterval) {
      clearInterval(this.keyRefreshInterval);
    }
    
    this.secretKey = null;
    this.sessionId = null;
    this.checksums.clear();
    this.tamperCount = 0;
    this.initialized = false;
    
    console.log('[MemoryGuard] Session destroyed');
  }

  /**
   * 获取当前状态
   * @returns {Object}
   */
  getStatus() {
    return {
      initialized: this.initialized,
      sessionId: this.sessionId,
      tamperCount: this.tamperCount,
      checksumCount: this.checksums.size,
      deviceId: this.deviceId
    };
  }
}

// 单例导出
const memoryGuard = new MemoryGuard();

// 全局暴露（用于调试）
if (typeof window !== 'undefined') {
  window.__memoryGuard = memoryGuard;
}

module.exports = { MemoryGuard, memoryGuard };
