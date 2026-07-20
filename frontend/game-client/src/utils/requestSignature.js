/**
 * 客户端请求签名 SDK
 * @module RequestSignatureClient
 */

class RequestSignatureClient {
  constructor() {
    this.keyVersion = 'current';
    this.secretKey = null;
    this.enabled = true;
    this.keyExpiry = null;
  }

  /**
   * 初始化，从服务端获取签名密钥
   */
  async initialize(sessionToken) {
    try {
      const response = await fetch('/api/v1/auth/signing-key', {
        headers: { 
          'Authorization': `Bearer ${sessionToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to get signing key: ${response.status}`);
      }
      
      const data = await response.json();
      this.secretKey = data.key;
      this.keyVersion = data.version;
      this.keyExpiry = data.expiry ? new Date(data.expiry) : null;
      
      console.log('[RequestSignature] Initialized with key version:', this.keyVersion);
      
      return {
        keyVersion: this.keyVersion,
        expiry: this.keyExpiry
      };
    } catch (error) {
      console.error('[RequestSignature] Initialization failed:', error);
      this.enabled = false;
      throw error;
    }
  }

  /**
   * 为请求添加签名头
   */
  signRequest(method, path, body = {}) {
    if (!this.enabled || !this.secretKey) {
      console.warn('[RequestSignature] Signature disabled or key not initialized');
      return {};
    }

    // 检查密钥是否过期
    if (this.keyExpiry && new Date() > this.keyExpiry) {
      console.warn('[RequestSignature] Key expired, signature skipped');
      return {};
    }

    const timestamp = Date.now();
    const nonce = this.generateNonce();
    const bodyHash = this.sha256Sync(JSON.stringify(body));
    
    const canonicalString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = this.hmacSha256Sync(this.secretKey, canonicalString);
    
    console.log('[RequestSignature] Request signed', {
      method,
      path,
      keyVersion: this.keyVersion
    });

    return {
      'X-Signature': signature,
      'X-Timestamp': timestamp.toString(),
      'X-Nonce': nonce,
      'X-Key-Version': this.keyVersion
    };
  }

  /**
   * 异步签名（浏览器环境）
   */
  async signRequestAsync(method, path, body = {}) {
    if (!this.enabled || !this.secretKey) {
      console.warn('[RequestSignature] Signature disabled or key not initialized');
      return {};
    }

    const timestamp = Date.now();
    const nonce = this.generateNonce();
    const bodyHash = await this.sha256(JSON.stringify(body));
    
    const canonicalString = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const signature = await this.hmacSha256(this.secretKey, canonicalString);

    return {
      'X-Signature': signature,
      'X-Timestamp': timestamp.toString(),
      'X-Nonce': nonce,
      'X-Key-Version': this.keyVersion
    };
  }

  /**
   * 生成 Nonce
   */
  generateNonce() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * SHA-256 哈希（异步，浏览器环境）
   */
  async sha256(data) {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * SHA-256 哈希（同步，Node.js 环境）
   */
  sha256Sync(data) {
    // 在浏览器环境中，如果没有同步方法，返回占位符
    if (typeof require !== 'undefined') {
      const crypto = require('crypto');
      return crypto.createHash('sha256').update(data).digest('hex');
    }
    
    // 浏览器环境回退：使用简单的哈希算法（实际应使用异步方法）
    console.warn('[RequestSignature] Using fallback hash, consider using async method');
    return this.simpleHash(data);
  }

  /**
   * HMAC-SHA256（异步，浏览器环境）
   */
  async hmacSha256(key, data) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(data);
    
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
    const signatureArray = Array.from(new Uint8Array(signature));
    return signatureArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * HMAC-SHA256（同步，Node.js 环境）
   */
  hmacSha256Sync(key, data) {
    if (typeof require !== 'undefined') {
      const crypto = require('crypto');
      return crypto.createHmac('sha256', key).update(data).digest('hex');
    }
    
    // 浏览器环境回退
    console.warn('[RequestSignature] Using fallback HMAC, consider using async method');
    return this.simpleHMAC(key, data);
  }

  /**
   * 简单哈希（回退方法）
   */
  simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(64, '0');
  }

  /**
   * 简单 HMAC（回退方法）
   */
  simpleHMAC(key, data) {
    const combined = key + data;
    return this.simpleHash(combined);
  }

  /**
   * 检查密钥状态
   */
  getKeyStatus() {
    return {
      initialized: !!this.secretKey,
      keyVersion: this.keyVersion,
      enabled: this.enabled,
      expired: this.keyExpiry ? new Date() > this.keyExpiry : false,
      expiry: this.keyExpiry
    };
  }

  /**
   * 禁用签名
   */
  disable() {
    this.enabled = false;
    console.log('[RequestSignature] Signature disabled');
  }

  /**
   * 启用签名
   */
  enable() {
    if (this.secretKey) {
      this.enabled = true;
      console.log('[RequestSignature] Signature enabled');
    } else {
      console.warn('[RequestSignature] Cannot enable: key not initialized');
    }
  }

  /**
   * 清除密钥
   */
  clearKey() {
    this.secretKey = null;
    this.keyVersion = 'current';
    this.keyExpiry = null;
    console.log('[RequestSignature] Key cleared');
  }
}

// 单例实例
export const requestSignature = new RequestSignatureClient();

// 默认导出
export default RequestSignatureClient;
