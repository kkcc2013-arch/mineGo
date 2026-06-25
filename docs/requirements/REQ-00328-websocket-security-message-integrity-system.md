# REQ-00328: WebSocket 通信安全加固与消息完整性验证系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00328 |
| 标题 | WebSocket 通信安全加固与消息完整性验证系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gym-service、catch-service、gateway、backend/shared、game-client、infrastructure/k8s |
| 创建时间 | 2026-06-25 05:00 UTC |

## 需求描述

### 背景
mineGo 项目的实时对战、捕捉、道馆战斗等核心功能大量使用 WebSocket 进行双向通信。当前 WebSocket 通信缺乏完整的安全保护机制，存在消息篡改、重放攻击、中间人攻击等安全风险。

### 目标
1. **消息完整性验证**：确保所有 WebSocket 消息在传输过程中未被篡改
2. **防重放攻击**：防止恶意用户重复发送已捕获的消息
3. **消息加密传输**：对敏感数据进行端到端加密
4. **时间戳验证**：防止延迟攻击和时间窗口外的消息被处理
5. **异常消息检测**：实时监控异常消息模式并自动阻断

### 业务场景
- **实时对战**：gym-service 的战斗操作需要确保指令未被篡改
- **精灵捕捉**：catch-service 的捕捉请求需要防止伪造
- **社交互动**：玩家间的实时聊天需要隐私保护
- **道馆挑战**：道馆战斗结果需要完整性和不可否认性

## 技术方案

### 1. WebSocket 消息签名机制

#### 1.1 消息签名中间件
```javascript
// backend/shared/middleware/websocketSignature.js
const crypto = require('crypto');
const { promisify } = require('util');

class WebSocketSignatureMiddleware {
  constructor(config = {}) {
    this.algorithm = config.algorithm || 'RSA-SHA256';
    this.timestampWindow = config.timestampWindow || 30000; // 30秒时间窗口
    this.nonceCache = new Map(); // nonce 防重放缓存
    this.maxNonceCacheSize = 100000;
  }

  /**
   * 生成消息签名
   * @param {Object} message - 原始消息对象
   * @param {string} privateKey - 用户私钥
   * @returns {Object} - 带签名的消息
   */
  async signMessage(message, privateKey) {
    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    
    const payload = {
      ...message,
      timestamp,
      nonce
    };

    // 构建待签名字符串（排序后的 JSON）
    const signString = this.buildSignString(payload);
    
    // 使用私钥签名
    const sign = crypto.createSign(this.algorithm);
    sign.update(signString);
    sign.end();
    
    const signature = sign.sign(privateKey, 'base64');
    
    return {
      ...payload,
      signature
    };
  }

  /**
   * 验证消息签名
   * @param {Object} signedMessage - 带签名的消息
   * @param {string} publicKey - 用户公钥
   * @returns {Object} - 验证结果 { valid: boolean, reason?: string }
   */
  async verifyMessage(signedMessage, publicKey) {
    const { signature, timestamp, nonce, ...message } = signedMessage;

    // 1. 验证时间戳（防止延迟攻击）
    if (!this.validateTimestamp(timestamp)) {
      return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
    }

    // 2. 验证 nonce（防止重放攻击）
    if (!this.validateNonce(nonce, timestamp)) {
      return { valid: false, reason: 'REPLAY_ATTACK_DETECTED' };
    }

    // 3. 构建签名字符串并验证
    const signString = this.buildSignString({ ...message, timestamp, nonce });
    
    const verify = crypto.createVerify(this.algorithm);
    verify.update(signString);
    verify.end();

    const isValid = verify.verify(publicKey, signature, 'base64');
    
    if (!isValid) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    // 4. 记录 nonce 防重放
    this.recordNonce(nonce, timestamp);

    return { valid: true };
  }

  /**
   * 构建待签名字符串
   */
  buildSignString(payload) {
    const sortedKeys = Object.keys(payload).sort();
    const pairs = sortedKeys.map(key => {
      const value = typeof payload[key] === 'object' 
        ? JSON.stringify(payload[key]) 
        : String(payload[key]);
      return `${key}=${value}`;
    });
    return pairs.join('&');
  }

  /**
   * 验证时间戳
   */
  validateTimestamp(timestamp) {
    const now = Date.now();
    const diff = Math.abs(now - timestamp);
    return diff <= this.timestampWindow;
  }

  /**
   * 验证 nonce
   */
  validateNonce(nonce, timestamp) {
    const cached = this.nonceCache.get(nonce);
    if (cached) {
      return false; // nonce 已使用，拒绝重放
    }
    return true;
  }

  /**
   * 记录 nonce
   */
  recordNonce(nonce, timestamp) {
    // 清理过期 nonce（防止内存泄漏）
    if (this.nonceCache.size >= this.maxNonceCacheSize) {
      this.cleanupExpiredNonces();
    }
    
    this.nonceCache.set(nonce, timestamp);
  }

  /**
   * 清理过期 nonce
   */
  cleanupExpiredNonces() {
    const now = Date.now();
    const expireTime = now - this.timestampWindow * 2;
    
    for (const [nonce, timestamp] of this.nonceCache.entries()) {
      if (timestamp < expireTime) {
        this.nonceCache.delete(nonce);
      }
    }
  }
}

module.exports = WebSocketSignatureMiddleware;
```

#### 1.2 Redis 分布式 nonce 缓存
```javascript
// backend/shared/cache/distributedNonceCache.js
const Redis = require('ioredis');

class DistributedNonceCache {
  constructor(redisClient) {
    this.redis = redisClient;
    this.prefix = 'ws:nonce:';
    this.ttl = 60; // 60秒 TTL
  }

  async checkAndSet(nonce, timestamp) {
    const key = this.prefix + nonce;
    
    // 使用 SETNX 原子操作
    const result = await this.redis.set(key, timestamp, 'EX', this.ttl, 'NX');
    
    return result === 'OK'; // OK 表示首次设置，null 表示已存在
  }

  async has(nonce) {
    const key = this.prefix + nonce;
    return await this.redis.exists(key);
  }

  async delete(nonce) {
    const key = this.prefix + nonce;
    return await this.redis.del(key);
  }
}

module.exports = DistributedNonceCache;
```

### 2. WebSocket 消息加密机制

#### 2.1 端到端加密管理器
```javascript
// backend/shared/security/websocketEncryption.js
const crypto = require('crypto');

class WebSocketEncryptionManager {
  constructor(config = {}) {
    this.algorithm = config.algorithm || 'aes-256-gcm';
    this.keyLength = 32; // 256-bit
    this.ivLength = 16;
    this.authTagLength = 16;
  }

  /**
   * 为用户生成会话密钥
   */
  generateSessionKey() {
    return crypto.randomBytes(this.keyLength).toString('base64');
  }

  /**
   * 使用用户公钥加密会话密钥
   */
  async encryptSessionKey(sessionKey, publicKeyPem) {
    const buffer = Buffer.from(sessionKey, 'base64');
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      buffer
    );
    return encrypted.toString('base64');
  }

  /**
   * 使用用户私钥解密会话密钥
   */
  async decryptSessionKey(encryptedSessionKey, privateKeyPem) {
    const buffer = Buffer.from(encryptedSessionKey, 'base64');
    const decrypted = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      buffer
    );
    return decrypted.toString('base64');
  }

  /**
   * 加密消息
   */
  encryptMessage(message, sessionKey) {
    const key = Buffer.from(sessionKey, 'base64');
    const iv = crypto.randomBytes(this.ivLength);
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    
    const messageBuffer = Buffer.from(JSON.stringify(message), 'utf8');
    const encrypted = Buffer.concat([
      cipher.update(messageBuffer),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    return {
      iv: iv.toString('base64'),
      encrypted: encrypted.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  /**
   * 解密消息
   */
  decryptMessage(encryptedPayload, sessionKey) {
    const key = Buffer.from(sessionKey, 'base64');
    const iv = Buffer.from(encryptedPayload.iv, 'base64');
    const encrypted = Buffer.from(encryptedPayload.encrypted, 'base64');
    const authTag = Buffer.from(encryptedPayload.authTag, 'base64');
    
    const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
    decipher.setAuthTag(authTag);
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return JSON.parse(decrypted.toString('utf8'));
  }
}

module.exports = WebSocketEncryptionManager;
```

### 3. WebSocket 网关安全拦截器

#### 3.1 网关层消息验证
```javascript
// gateway/websocket/securityInterceptor.js
const WebSocketSignatureMiddleware = require('../../shared/middleware/websocketSignature');
const WebSocketEncryptionManager = require('../../shared/security/websocketEncryption');
const DistributedNonceCache = require('../../shared/cache/distributedNonceCache');
const logger = require('../../shared/logger');
const metrics = require('../../shared/metrics');

class WebSocketSecurityInterceptor {
  constructor(redisClient) {
    this.signatureMiddleware = new WebSocketSignatureMiddleware();
    this.encryptionManager = new WebSocketEncryptionManager();
    this.nonceCache = new DistributedNonceCache(redisClient);
    
    // 安全事件计数器
    this.securityEvents = {
      invalidSignature: 0,
      replayAttack: 0,
      timestampExpired: 0,
      decryptionFailed: 0
    };
  }

  /**
   * 拦截并验证 WebSocket 消息
   */
  async intercept(ws, messageBuffer, next) {
    const startTime = Date.now();
    
    try {
      const message = JSON.parse(messageBuffer.toString());
      
      // 检查是否需要加密验证
      if (message.encrypted) {
        const decrypted = await this.verifyAndDecryptMessage(ws, message);
        ws._decryptedMessage = decrypted;
        return next();
      }
      
      // 检查是否需要签名验证
      if (message.signature) {
        const verification = await this.verifySignedMessage(ws, message);
        
        if (!verification.valid) {
          this.handleSecurityEvent(ws, verification.reason, message);
          return ws.close(1008, verification.reason);
        }
      }
      
      // 记录处理延迟
      const duration = Date.now() - startTime;
      metrics.histogram('ws_security_intercept_duration', duration);
      
      next();
      
    } catch (error) {
      logger.error('WebSocket security intercept error', { error: error.message });
      ws.close(1011, 'SECURITY_ERROR');
    }
  }

  /**
   * 验证并解密加密消息
   */
  async verifyAndDecryptMessage(ws, message) {
    try {
      const sessionKey = ws._sessionKey;
      
      if (!sessionKey) {
        throw new Error('SESSION_KEY_NOT_FOUND');
      }
      
      const decrypted = this.encryptionManager.decryptMessage(
        message.payload,
        sessionKey
      );
      
      return decrypted;
      
    } catch (error) {
      this.securityEvents.decryptionFailed++;
      logger.warn('WebSocket decryption failed', { 
        userId: ws.userId,
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * 验证签名消息
   */
  async verifySignedMessage(ws, message) {
    const publicKey = ws._publicKey;
    
    if (!publicKey) {
      return { valid: false, reason: 'PUBLIC_KEY_NOT_FOUND' };
    }
    
    // 使用分布式 nonce 缓存验证
    const nonceValid = await this.nonceCache.checkAndSet(
      message.nonce,
      message.timestamp
    );
    
    if (!nonceValid) {
      this.securityEvents.replayAttack++;
      return { valid: false, reason: 'REPLAY_ATTACK_DETECTED' };
    }
    
    // 验证签名
    const verification = await this.signatureMiddleware.verifyMessage(
      message,
      publicKey
    );
    
    if (!verification.valid) {
      this.securityEvents.invalidSignature++;
    }
    
    return verification;
  }

  /**
   * 处理安全事件
   */
  handleSecurityEvent(ws, reason, message) {
    const event = {
      userId: ws.userId,
      deviceId: ws.deviceId,
      reason,
      timestamp: Date.now(),
      messagePreview: JSON.stringify(message).substring(0, 200)
    };
    
    logger.security('WebSocket security violation', event);
    metrics.increment('ws_security_violation', { reason });
    
    // 如果是重放攻击或签名验证失败，可能需要封禁用户
    if (reason === 'REPLAY_ATTACK_DETECTED' || reason === 'INVALID_SIGNATURE') {
      this.flagSuspiciousActivity(ws.userId, reason);
    }
  }

  /**
   * 标记可疑活动
   */
  async flagSuspiciousActivity(userId, reason) {
    // TODO: 集成风控系统，记录用户可疑行为
    logger.security('Suspicious activity detected', { userId, reason });
  }

  /**
   * 获取安全事件统计
   */
  getSecurityStats() {
    return { ...this.securityEvents };
  }
}

module.exports = WebSocketSecurityInterceptor;
```

### 4. 客户端集成示例

#### 4.1 游戏客户端 WebSocket 安全管理
```javascript
// game-client/src/network/SecureWebSocket.js
import CryptoJS from 'crypto-js';
import { RSA } from 'hybrid-crypto-js';

export class SecureWebSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.ws = null;
    this.publicKey = null;
    this.privateKey = null;
    this.sessionKey = null;
    
    this.init();
  }

  async init() {
    // 1. 生成 RSA 密钥对
    await this.generateKeyPair();
    
    // 2. 建立 WebSocket 连接
    await this.connect();
    
    // 3. 进行密钥交换
    await this.performKeyExchange();
  }

  /**
   * 生成 RSA 密钥对
   */
  async generateKeyPair() {
    return new Promise((resolve, reject) => {
      const rsa = new RSA();
      rsa.generateKeyPairAsync((keyPair) => {
        this.publicKey = keyPair.publicKey;
        this.privateKey = keyPair.privateKey;
        resolve();
      });
    });
  }

  /**
   * 建立 WebSocket 连接
   */
  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      
      this.ws.onopen = () => {
        console.log('SecureWebSocket connected');
        resolve();
      };
      
      this.ws.onerror = (error) => {
        console.error('SecureWebSocket error', error);
        reject(error);
      };
      
      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };
    });
  }

  /**
   * 密钥交换
   */
  async performKeyExchange() {
    // 发送公钥到服务器
    const keyExchangeMessage = {
      type: 'KEY_EXCHANGE',
      publicKey: this.publicKey,
      timestamp: Date.now()
    };
    
    this.ws.send(JSON.stringify(keyExchangeMessage));
    
    // 等待服务器响应加密的会话密钥
    return new Promise((resolve) => {
      this._keyExchangeResolver = resolve;
    });
  }

  /**
   * 发送加密消息
   */
  async sendSecure(message) {
    if (!this.sessionKey) {
      throw new Error('Session key not established');
    }
    
    // 加密消息
    const encrypted = this.encryptMessage(message, this.sessionKey);
    
    // 签名消息
    const signed = await this.signMessage(encrypted);
    
    this.ws.send(JSON.stringify(signed));
  }

  /**
   * 加密消息
   */
  encryptMessage(message, key) {
    const iv = CryptoJS.lib.WordArray.random(16);
    const encrypted = CryptoJS.AES.encrypt(
      JSON.stringify(message),
      key,
      { iv: iv, mode: CryptoJS.mode.GCM }
    );
    
    return {
      iv: iv.toString(),
      encrypted: encrypted.toString(),
      authTag: encrypted.ciphertext.words.slice(-4).toString()
    };
  }

  /**
   * 签名消息
   */
  async signMessage(message) {
    const timestamp = Date.now();
    const nonce = CryptoJS.lib.WordArray.random(16).toString();
    
    const signString = this.buildSignString({ ...message, timestamp, nonce });
    
    // 使用私钥签名
    const signature = await this.signWithPrivateKey(signString);
    
    return {
      ...message,
      timestamp,
      nonce,
      signature
    };
  }

  /**
   * 处理接收到的消息
   */
  handleMessage(data) {
    const message = JSON.parse(data);
    
    // 处理密钥交换响应
    if (message.type === 'KEY_EXCHANGE_RESPONSE') {
      this.sessionKey = this.decryptSessionKey(message.encryptedSessionKey);
      if (this._keyExchangeResolver) {
        this._keyExchangeResolver();
      }
      return;
    }
    
    // 解密消息
    if (message.encrypted) {
      const decrypted = this.decryptMessage(message.payload);
      this.emit('message', decrypted);
    } else {
      this.emit('message', message);
    }
  }

  /**
   * 构建签名字符串
   */
  buildSignString(payload) {
    const sortedKeys = Object.keys(payload).sort();
    return sortedKeys.map(key => `${key}=${payload[key]}`).join('&');
  }

  /**
   * 使用私钥签名
   */
  async signWithPrivateKey(data) {
    // 实现私钥签名逻辑
    // ...
  }
}
```

### 5. 数据库迁移

#### 5.1 WebSocket 会话密钥表
```sql
-- database/migrations/20260625_create_ws_session_keys.sql
CREATE TABLE ws_session_keys (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  session_key_encrypted TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  
  UNIQUE(user_id, device_id, is_active)
);

CREATE INDEX idx_ws_session_keys_user ON ws_session_keys(user_id);
CREATE INDEX idx_ws_session_keys_device ON ws_session_keys(device_id);
CREATE INDEX idx_ws_session_keys_expires ON ws_session_keys(expires_at);

-- 定期清理过期会话密钥
CREATE OR REPLACE FUNCTION cleanup_expired_session_keys() RETURNS void AS $$
BEGIN
  DELETE FROM ws_session_keys 
  WHERE expires_at < NOW() - INTERVAL '1 day';
END;
$$ LANGUAGE plpgsql;
```

#### 5.2 WebSocket 安全事件日志表
```sql
-- database/migrations/20260625_create_ws_security_events.sql
CREATE TABLE ws_security_events (
  id SERIAL PRIMARY KEY,
  user_id VARCHAR(255),
  device_id VARCHAR(255),
  event_type VARCHAR(50) NOT NULL,
  reason VARCHAR(100),
  message_preview TEXT,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ws_security_events_user ON ws_security_events(user_id);
CREATE INDEX idx_ws_security_events_type ON ws_security_events(event_type);
CREATE INDEX idx_ws_security_events_created ON ws_security_events(created_at);

-- 分区表（按月分区）
CREATE TABLE ws_security_events_202606 PARTITION OF ws_security_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
```

### 6. Prometheus 指标与监控

#### 6.1 安全指标定义
```javascript
// backend/shared/metrics/websocketSecurityMetrics.js
const prometheus = require('prom-client');

const wsSecurityMetrics = {
  // 消息签名验证计数
  wsSignatureValidations: new prometheus.Counter({
    name: 'ws_signature_validations_total',
    help: 'Total number of WebSocket message signature validations',
    labelNames: ['service', 'result'] // result: success, failure
  }),

  // 重放攻击检测计数
  wsReplayAttacksDetected: new prometheus.Counter({
    name: 'ws_replay_attacks_detected_total',
    help: 'Total number of replay attacks detected',
    labelNames: ['service']
  }),

  // 消息加密/解密计数
  wsEncryptionOperations: new prometheus.Counter({
    name: 'ws_encryption_operations_total',
    help: 'Total number of WebSocket message encryption operations',
    labelNames: ['service', 'operation', 'result'] // operation: encrypt, decrypt
  }),

  // 会话密钥生成计数
  wsSessionKeyGenerations: new prometheus.Counter({
    name: 'ws_session_key_generations_total',
    help: 'Total number of WebSocket session keys generated',
    labelNames: ['service']
  }),

  // 安全拦截延迟
  wsSecurityInterceptDuration: new prometheus.Histogram({
    name: 'ws_security_intercept_duration_seconds',
    help: 'Duration of WebSocket security intercept operations',
    labelNames: ['service', 'operation'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
  }),

  // 活跃 WebSocket 安全会话数
  wsActiveSecureSessions: new prometheus.Gauge({
    name: 'ws_active_secure_sessions',
    help: 'Number of active secure WebSocket sessions',
    labelNames: ['service']
  })
};

module.exports = wsSecurityMetrics;
```

#### 6.2 Grafana 监控面板
```yaml
# infrastructure/k8s/monitoring/dashboards/websocket-security.json
{
  "dashboard": {
    "title": "WebSocket Security Monitoring",
    "panels": [
      {
        "title": "Message Signature Validation Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(ws_signature_validations_total[5m])",
            "legendFormat": "{{service}} - {{result}}"
          }
        ]
      },
      {
        "title": "Replay Attack Detection Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(ws_replay_attacks_detected_total[5m])",
            "legendFormat": "{{service}}"
          }
        ]
      },
      {
        "title": "Encryption/Decryption Success Rate",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(ws_encryption_operations_total{result=\"success\"}[5m])",
            "legendFormat": "{{service}} - {{operation}}"
          }
        ]
      },
      {
        "title": "Security Intercept Latency",
        "type": "heatmap",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(ws_security_intercept_duration_seconds_bucket[5m]))",
            "legendFormat": "p95"
          }
        ]
      }
    ]
  }
}
```

### 7. 告警规则

#### 7.1 Prometheus 告警规则
```yaml
# infrastructure/k8s/monitoring/alerts/websocket-security.yaml
groups:
  - name: websocket-security
    interval: 30s
    rules:
      # 高频率签名验证失败
      - alert: HighWebSocketSignatureFailureRate
        expr: |
          rate(ws_signature_validations_total{result="failure"}[5m]) 
          > 
          rate(ws_signature_validations_total{result="success"}[5m]) * 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High WebSocket signature validation failure rate"
          description: "Signature validation failure rate is above 10% in {{ $labels.service }}"

      # 重放攻击频繁发生
      - alert: ReplayAttackDetected
        expr: rate(ws_replay_attacks_detected_total[5m]) > 0.1
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Replay attack detected"
          description: "Replay attack detected in {{ $labels.service }} at rate {{ $value }}/s"

      # 加密操作失败率高
      - alert: HighEncryptionFailureRate
        expr: |
          rate(ws_encryption_operations_total{result="failure"}[5m])
          >
          rate(ws_encryption_operations_total{result="success"}[5m]) * 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High WebSocket encryption failure rate"
          description: "Encryption failure rate is above 5% in {{ $labels.service }}"
```

## 验收标准

- [ ] 所有 WebSocket 消息必须包含有效签名
- [ ] 签名验证成功率 ≥ 99.9%
- [ ] 重放攻击检测率达到 100%
- [ ] 消息加密支持 AES-256-GCM 算法
- [ ] 会话密钥每 24 小时自动轮换
- [ ] 安全拦截延迟 < 10ms (P95)
- [ ] 提供完整的 Prometheus 指标
- [ ] 集成 Grafana 监控面板
- [ ] 编写单元测试覆盖率 ≥ 80%
- [ ] 编写集成测试覆盖主要安全场景
- [ ] 更新 API 文档说明安全机制
- [ ] 提供客户端集成示例代码

## 影响范围

### 后端服务
- `gateway/` - WebSocket 网关安全拦截器
- `gym-service/` - 实时对战斗安全加固
- `catch-service/` - 捕捉请求安全验证
- `backend/shared/middleware/` - 签名中间件
- `backend/shared/security/` - 加密管理器
- `backend/shared/cache/` - 分布式 nonce 缓存
- `backend/shared/metrics/` - 安全指标

### 数据库
- `database/migrations/` - 会话密钥表、安全事件表

### 基础设施
- `infrastructure/k8s/monitoring/` - Grafana 面板、Prometheus 告警

### 客户端
- `game-client/src/network/` - 安全 WebSocket 客户端

## 参考

- [WebSocket Security Best Practices](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#websockets)
- [Message Signing Standards](https://www.w3.org/TR/WebCryptoAPI/)
- [OWASP WebSocket Security](https://owasp.org/www-community/vulnerabilities/Unvalidated_Redirects_and_Forwards_Cheat_Sheet)
- [Node.js Crypto Module](https://nodejs.org/api/crypto.html)
- [RSA Digital Signatures](https://en.wikipedia.org/wiki/Digital_signature)
