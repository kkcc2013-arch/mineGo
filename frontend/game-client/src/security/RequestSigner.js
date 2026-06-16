/**
 * RequestSigner - 请求签名与防重放模块
 * 
 * 功能：
 * - 请求签名（HMAC-SHA256）
 * - 防重放（Nonce + 时间戳）
 * - 自动签名关键 API 请求
 * 
 * @module frontend/game-client/src/security/RequestSigner
 */

const { memoryGuard } = require('./MemoryGuard');

// 需要签名保护的关键 API 路径
const PROTECTED_PATHS = [
  '/api/v1/catch',
  '/api/v1/battle',
  '/api/v1/payment',
  '/api/v1/pokemon/trade',
  '/api/v1/pokemon/transfer',
  '/api/v1/reward/claim',
  '/api/v1/gym',
  '/api/v1/user/profile'
];

class RequestSigner {
  constructor() {
    this.memoryGuard = memoryGuard;
    this.nonceCache = new Set();
    this.maxNonceCacheSize = 10000;
    this.pendingRequests = new Map();
    this.apiBaseUrl = '/api/v1/security';
    
    // 拦截原始 fetch
    this.originalFetch = window.fetch.bind(window);
    this.isInterceptorInstalled = false;
  }

  /**
   * 安装请求拦截器
   */
  installInterceptor() {
    if (this.isInterceptorInstalled) {
      return;
    }
    
    const self = this;
    
    // 替换全局 fetch
    window.fetch = async function(url, options = {}) {
      const urlString = url instanceof Request ? url.url : url.toString();
      const path = self.extractPath(urlString);
      
      // 检查是否需要签名
      if (self.shouldSign(path)) {
        options = await self.signOptions(urlString, options);
      }
      
      // 发送请求
      return self.originalFetch(url, options);
    };
    
    this.isInterceptorInstalled = true;
    console.log('[RequestSigner] Interceptor installed');
  }

  /**
   * 卸载拦截器
   */
  uninstallInterceptor() {
    if (this.isInterceptorInstalled) {
      window.fetch = this.originalFetch;
      this.isInterceptorInstalled = false;
    }
  }

  /**
   * 提取 URL 路径
   * @param {string} url 
   * @returns {string}
   */
  extractPath(url) {
    try {
      const urlObj = new URL(url, window.location.origin);
      return urlObj.pathname;
    } catch {
      return url;
    }
  }

  /**
   * 判断路径是否需要签名
   * @param {string} path 
   * @returns {boolean}
   */
  shouldSign(path) {
    return PROTECTED_PATHS.some(protectedPath => 
      path.startsWith(protectedPath)
    );
  }

  /**
   * 签名请求选项
   * @param {string} url 
   * @param {Object} options 
   * @returns {Promise<Object>}
   */
  async signOptions(url, options) {
    const method = options.method || 'GET';
    const body = options.body ? this.parseBody(options.body) : {};
    const path = this.extractPath(url);
    
    const signData = this.signRequest(method, path, body);
    
    return {
      ...options,
      headers: {
        ...options.headers,
        ...signData.headers,
        'Content-Type': 'application/json'
      }
    };
  }

  /**
   * 解析请求体
   * @param {*} body 
   * @returns {Object}
   */
  parseBody(body) {
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    }
    return body || {};
  }

  /**
   * 签名请求
   * @param {string} method 
   * @param {string} path 
   * @param {Object} body 
   * @returns {Object}
   */
  signRequest(method, path, body = {}) {
    const timestamp = Date.now();
    const nonce = crypto.randomUUID();
    
    // 缓存 Nonce（客户端防重放）
    this.cacheNonce(nonce);
    
    // 构造签名字符串
    const bodyStr = JSON.stringify(this.sortObject(body));
    const signStr = [
      method.toUpperCase(),
      path,
      timestamp.toString(),
      nonce,
      bodyStr
    ].join('\n');
    
    // HMAC-SHA256 签名
    const signature = this.hmacSha256(signStr, this.memoryGuard.secretKey);
    
    return {
      nonce,
      timestamp,
      signature,
      headers: {
        'X-Request-Timestamp': timestamp.toString(),
        'X-Request-Nonce': nonce,
        'X-Request-Signature': signature,
        'X-Session-Id': this.memoryGuard.sessionId || ''
      }
    };
  }

  /**
   * 发送签名请求
   * @param {string} url 
   * @param {Object} options 
   * @returns {Promise<Response>}
   */
  async signedFetch(url, options = {}) {
    const method = options.method || 'GET';
    const body = options.body ? this.parseBody(options.body) : {};
    const path = this.extractPath(url);
    
    const signData = this.signRequest(method, path, body);
    
    const response = await this.originalFetch(url, {
      ...options,
      headers: {
        ...options.headers,
        ...signData.headers,
        'Content-Type': 'application/json'
      }
    });
    
    // 处理签名错误响应
    if (response.status === 401) {
      const result = await response.clone().json().catch(() => ({}));
      
      if (result.error === 'Replay attack detected' || 
          result.error === 'Invalid signature') {
        console.error('[RequestSigner] Security error:', result.error);
        
        // 触发安全处理
        this.memoryGuard.onTamperDetected(
          'request_signature',
          'valid',
          'invalid',
          result.error
        );
      }
    }
    
    return response;
  }

  /**
   * 缓存 Nonce
   * @param {string} nonce 
   */
  cacheNonce(nonce) {
    this.nonceCache.add(nonce);
    
    // 限制缓存大小
    if (this.nonceCache.size > this.maxNonceCacheSize) {
      // 删除最早的 Nonce
      const iterator = this.nonceCache.values();
      const first = iterator.next().value;
      this.nonceCache.delete(first);
    }
  }

  /**
   * 检查 Nonce 是否已使用
   * @param {string} nonce 
   * @returns {boolean}
   */
  isNonceUsed(nonce) {
    return this.nonceCache.has(nonce);
  }

  /**
   * HMAC-SHA256 签名
   * @param {string} message 
   * @param {string} key 
   * @returns {string}
   */
  hmacSha256(message, key) {
    // 使用与 MemoryGuard 相同的同步实现
    const combined = key + message + key;
    let hash = 0;
    
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    
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
   * 排序对象属性
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
   * 批量签名请求
   * @param {Array<{url: string, options: Object}>} requests 
   * @returns {Promise<Response[]>}
   */
  async signedFetchBatch(requests) {
    return Promise.all(
      requests.map(({ url, options }) => this.signedFetch(url, options))
    );
  }

  /**
   * 获取签名统计
   * @returns {Object}
   */
  getStats() {
    return {
      nonceCacheSize: this.nonceCache.size,
      pendingRequests: this.pendingRequests.size,
      interceptorInstalled: this.isInterceptorInstalled
    };
  }

  /**
   * 清除 Nonce 缓存
   */
  clearNonceCache() {
    this.nonceCache.clear();
  }

  /**
   * 添加受保护路径
   * @param {string} path 
   */
  addProtectedPath(path) {
    if (!PROTECTED_PATHS.includes(path)) {
      PROTECTED_PATHS.push(path);
    }
  }

  /**
   * 移除受保护路径
   * @param {string} path 
   */
  removeProtectedPath(path) {
    const index = PROTECTED_PATHS.indexOf(path);
    if (index > -1) {
      PROTECTED_PATHS.splice(index, 1);
    }
  }
}

// 单例导出
const requestSigner = new RequestSigner();

// 全局暴露
if (typeof window !== 'undefined') {
  window.__requestSigner = requestSigner;
}

module.exports = { RequestSigner, requestSigner, PROTECTED_PATHS };
