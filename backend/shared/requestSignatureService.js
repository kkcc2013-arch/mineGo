/**
 * API 请求签名验证与防篡改保护系统
 * @module RequestSignatureService
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('./logger');
const { metrics } = require('./metrics');

const logger = createLogger('request-signature');

/**
 * 请求签名验证服务
 * 防止请求篡改、重放攻击
 */
class RequestSignatureService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.keyStore = new Map(); // keyVersion -> secretKey
    this.nonceCache = new Map(); // nonce -> timestamp
    this.maxTimestampDrift = options.maxTimestampDrift || 300000; // 5分钟
    this.nonceExpiry = options.nonceExpiry || 300000; // 5分钟
    
    // 敏感 API 端点配置
    this.sensitiveEndpoints = new Set([
      'POST:/v1/pokemon/catch',
      'POST:/v1/pokemon/transfer',
      'POST:/v1/trade/confirm',
      'POST:/v1/trade/accept',
      'POST:/v1/gym/battle/start',
      'POST:/v1/gym/battle/result',
      'POST:/v1/reward/claim',
      'POST:/v1/payment/initialize',
      'POST:/v1/payment/confirm',
      'DELETE:/v1/pokemon/*',
      'PUT:/v1/user/settings',
    ]);

    // 初始化默认密钥
    if (options.defaultKey) {
      this.keyStore.set('current', options.defaultKey);
      this.keyCreatedAt = new Date();
    } else {
      // 从环境变量获取
      const envKey = process.env.REQUEST_SIGNATURE_KEY;
      if (envKey) {
        this.keyStore.set('current', envKey);
        this.keyCreatedAt = new Date();
      } else {
        logger.warn('No default signature key configured, generating temporary key');
        this.rotateKeySync(crypto.randomBytes(32).toString('hex'));
      }
    }

    // 定期清理过期的 Nonce
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredNonces();
    }, 60000); // 每分钟清理一次

    logger.info('RequestSignatureService initialized', {
      maxTimestampDrift: this.maxTimestampDrift,
      nonceExpiry: this.nonceExpiry,
      keyVersions: Array.from(this.keyStore.keys())
    });
  }

  /**
   * 生成签名
   */
  generateSignature(method, path, body, keyVersion = 'current') {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const secretKey = this.getActiveKey(keyVersion);
    
    if (!secretKey) {
      throw new Error(`Invalid key version: ${keyVersion}`);
    }

    const bodyHash = this.hashBody(body || {});
    const canonicalString = this.buildCanonicalString(method, path, timestamp, nonce, bodyHash);
    
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(canonicalString)
      .digest('hex');
    
    logger.debug('Signature generated', {
      method,
      path,
      timestamp,
      nonce,
      keyVersion,
      bodyHash
    });

    return { signature, timestamp, nonce, keyVersion };
  }

  /**
   * 验证签名
   */
  async verifySignature(request) {
    const startTime = Date.now();
    const { method, path, headers, body } = request;
    
    const signature = headers['x-signature'];
    const timestamp = parseInt(headers['x-timestamp'], 10);
    const nonce = headers['x-nonce'];
    const keyVersion = headers['x-key-version'] || 'current';
    
    // 1. 检查必需头
    if (!signature || !timestamp || !nonce) {
      this.recordVerification('MISSING_REQUIRED_HEADERS', startTime);
      return { valid: false, reason: 'MISSING_REQUIRED_HEADERS' };
    }
    
    // 2. 检查时间戳
    const now = Date.now();
    if (Math.abs(now - timestamp) > this.maxTimestampDrift) {
      logger.warn('Timestamp expired', {
        timestamp,
        now,
        drift: Math.abs(now - timestamp),
        maxDrift: this.maxTimestampDrift
      });
      this.recordVerification('TIMESTAMP_EXPIRED', startTime);
      return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
    }
    
    // 3. 检查 Nonce 重放
    if (this.nonceCache.has(nonce)) {
      logger.warn('Nonce reused', { nonce, method, path });
      this.recordVerification('NONCE_REUSED', startTime);
      return { valid: false, reason: 'NONCE_REUSED' };
    }
    
    // 4. 获取密钥
    const secretKey = this.keyStore.get(keyVersion);
    if (!secretKey) {
      logger.error('Invalid key version', { keyVersion });
      this.recordVerification('INVALID_KEY_VERSION', startTime);
      return { valid: false, reason: 'INVALID_KEY_VERSION' };
    }
    
    // 5. 计算并验证签名
    const bodyHash = this.hashBody(body || {});
    const canonicalString = this.buildCanonicalString(method, path, timestamp, nonce, bodyHash);
    const expectedSignature = crypto
      .createHmac('sha256', secretKey)
      .update(canonicalString)
      .digest('hex');
    
    if (signature !== expectedSignature) {
      logger.warn('Invalid signature', {
        expected: expectedSignature.substring(0, 16) + '...',
        received: signature.substring(0, 16) + '...',
        method,
        path
      });
      this.recordVerification('INVALID_SIGNATURE', startTime);
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }
    
    // 6. 记录 Nonce
    this.nonceCache.set(nonce, now);
    
    this.recordVerification('SUCCESS', startTime);
    
    logger.debug('Signature verified successfully', {
      method,
      path,
      keyVersion,
      duration: Date.now() - startTime
    });
    
    return { valid: true };
  }

  /**
   * 判断是否需要签名验证
   */
  requiresSignature(method, path) {
    for (const pattern of this.sensitiveEndpoints) {
      if (this.matchPattern(pattern, method, path)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 路径匹配
   */
  matchPattern(pattern, method, path) {
    const [patternMethod, patternPath] = pattern.split(':');
    if (patternMethod !== method) return false;
    
    if (patternPath.endsWith('*')) {
      return path.startsWith(patternPath.slice(0, -1));
    }
    
    // 支持参数占位符（如 /v1/pokemon/:id）
    if (patternPath.includes(':')) {
      const patternParts = patternPath.split('/');
      const pathParts = path.split('/');
      
      if (patternParts.length !== pathParts.length) return false;
      
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) continue;
        if (patternParts[i] !== pathParts[i]) return false;
      }
      
      return true;
    }
    
    return patternPath === path;
  }

  /**
   * 密钥轮换
   */
  async rotateKey(newKey) {
    const newVersion = `v${Date.now()}`;
    
    // 添加新密钥
    this.keyStore.set(newVersion, newKey);
    
    // 更新当前密钥
    const oldVersion = 'current';
    const oldKey = this.keyStore.get(oldVersion);
    if (oldKey) {
      // 保留旧密钥一段时间，用于处理正在进行的请求
      const backupVersion = `backup_${Date.now()}`;
      this.keyStore.set(backupVersion, oldKey);
      
      // 10分钟后删除备份密钥
      setTimeout(() => {
        this.keyStore.delete(backupVersion);
        logger.info('Backup key removed', { version: backupVersion });
      }, 600000);
    }
    
    this.keyStore.set('current', newKey);
    this.keyCreatedAt = new Date();
    
    // 发布密钥更新事件
    this.emit('key_rotated', {
      newVersion,
      timestamp: this.keyCreatedAt.toISOString()
    });
    
    logger.info('Signature key rotated', {
      newVersion,
      activeVersions: Array.from(this.keyStore.keys())
    });
    
    return newVersion;
  }

  /**
   * 同步轮换密钥
   */
  rotateKeySync(newKey) {
    const version = `v${Date.now()}`;
    this.keyStore.set(version, newKey);
    this.keyStore.set('current', newKey);
    this.keyCreatedAt = new Date();
    return version;
  }

  /**
   * 获取活跃密钥
   */
  getActiveKey(keyVersion) {
    return this.keyStore.get(keyVersion) || this.keyStore.get('current');
  }

  /**
   * 构建规范字符串
   */
  buildCanonicalString(method, path, timestamp, nonce, bodyHash) {
    return `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  }

  /**
   * 计算请求体哈希
   */
  hashBody(body) {
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    return crypto.createHash('sha256').update(bodyString).digest('hex');
  }

  /**
   * 记录验证结果
   */
  recordVerification(result, startTime) {
    const duration = Date.now() - startTime;
    
    metrics.timing('signature_verification_duration', duration);
    metrics.increment(`signature_verification_${result.toLowerCase()}`, 1);
    
    if (result !== 'SUCCESS') {
      logger.warn('Signature verification failed', {
        result,
        duration
      });
    }
  }

  /**
   * 清理过期的 Nonce
   */
  cleanupExpiredNonces() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [nonce, timestamp] of this.nonceCache.entries()) {
      if (now - timestamp > this.nonceExpiry) {
        this.nonceCache.delete(nonce);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      logger.debug('Cleaned expired nonces', { count: cleanedCount });
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      keyVersions: Array.from(this.keyStore.keys()),
      nonceCacheSize: this.nonceCache.size,
      sensitiveEndpoints: Array.from(this.sensitiveEndpoints),
      keyCreatedAt: this.keyCreatedAt,
      maxTimestampDrift: this.maxTimestampDrift,
      nonceExpiry: this.nonceExpiry
    };
  }

  /**
   * 添加敏感端点
   */
  addSensitiveEndpoint(method, path) {
    this.sensitiveEndpoints.add(`${method}:${path}`);
    logger.info('Sensitive endpoint added', { method, path });
  }

  /**
   * 移除敏感端点
   */
  removeSensitiveEndpoint(method, path) {
    this.sensitiveEndpoints.delete(`${method}:${path}`);
    logger.info('Sensitive endpoint removed', { method, path });
  }

  /**
   * 销毁服务
   */
  destroy() {
    clearInterval(this.cleanupInterval);
    this.removeAllListeners();
    logger.info('RequestSignatureService destroyed');
  }
}

// 单例实例
let instance = null;

function getInstance(options) {
  if (!instance) {
    instance = new RequestSignatureService(options);
  }
  return instance;
}

module.exports = {
  RequestSignatureService,
  getInstance
};
