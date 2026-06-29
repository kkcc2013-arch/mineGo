# REQ-00363：API 请求签名验证与防重放攻击系统

- **编号**：REQ-00363
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、backend/shared、game-client
- **创建时间**：2026-06-29 12:10 UTC
- **依赖需求**：REQ-00045（设备完整性检测）

## 1. 背景与问题

当前 mineGo 项目的 API 安全主要依赖 JWT Token 认证，但存在以下安全漏洞：

1. **请求可被重放攻击**：攻击者截获合法请求后，可以在有效期内重复发送相同请求，导致重复扣款、重复领取奖励等问题。

2. **请求参数可被篡改**：虽然使用了 HTTPS，但在某些场景下（如代理、中间人攻击风险），请求参数仍可能被修改。

3. **缺少请求签名机制**：API 请求未进行签名验证，无法确保请求来源的真实性和完整性。

4. **时间戳验证缺失**：服务端未对请求时间戳进行严格校验，允许过期请求被执行。

根据 REQ-00045 的设备完整性检测基础，需要进一步强化 API 层面的请求验证机制，防止重放攻击和请求篡改。

## 2. 目标

1. **防止重放攻击**：通过请求签名 + 时间戳 + Nonce 三重验证，确保每个请求只能执行一次。
2. **保证请求完整性**：通过 HMAC-SHA256 签名，防止请求参数被篡改。
3. **性能优化**：签名验证延迟 < 5ms，不影响正常请求响应时间。
4. **渐进式部署**：支持按端点、按用户群逐步启用签名验证。

## 3. 范围

### 包含
- 请求签名生成与验证中间件
- Nonce 缓存与去重机制（Redis）
- 时间戳有效期校验（可配置窗口）
- 签名算法实现（HMAC-SHA256）
- 客户端签名 SDK
- 管理后台签名配置界面
- 请求签名日志与异常告警

### 不包含
- 客户端证书认证（PKI）
- 请求加密（数据仍使用 HTTPS 传输加密）
- 生物识别验证
- 区块链审计追踪

## 4. 详细需求

### 4.1 请求签名协议

每个 API 请求必须包含以下 Headers：

```
X-Request-Signature: <HMAC-SHA256签名>
X-Request-Timestamp: <Unix时间戳，毫秒>
X-Request-Nonce: <UUID随机数>
```

**签名算法**：
```javascript
// 签名生成步骤
1. 将请求方法、路径、时间戳、Nonce、请求体按字典序拼接
   stringToSign = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`

2. 使用用户会话密钥（或设备密钥）计算 HMAC-SHA256
   signature = HMAC-SHA256(userSessionKey, stringToSign)

3. Base64 编码签名
   signatureBase64 = Base64.encode(signature)
```

### 4.2 服务端验证中间件

```javascript
// backend/shared/middleware/requestSignature.js

const redis = require('../redis');
const { createHmac } = require('crypto');
const { AppError } = require('../response');

const CONFIG = {
  // 签名有效期窗口（毫秒）
  TIMESTAMP_WINDOW: 5 * 60 * 1000, // 5分钟
  // Nonce 缓存过期时间
  NONCE_EXPIRE: 10 * 60 * 1000, // 10分钟
  // 是否启用签名验证（可按端点配置）
  enabled: true,
  // 豁免路径（不需要签名验证）
  exemptPaths: ['/health', '/metrics', '/api/v1/public/*'],
  // 是否强制验证（false=宽松模式，允许未签名请求）
  strict: true
};

/**
 * 请求签名验证中间件
 */
async function verifyRequestSignature(req, res, next) {
  try {
    // 检查是否豁免路径
    if (isExemptPath(req.path)) {
      return next();
    }

    const signature = req.headers['x-request-signature'];
    const timestamp = parseInt(req.headers['x-request-timestamp']);
    const nonce = req.headers['x-request-nonce'];

    // 非强制模式下，缺少签名的请求允许通过（记录日志）
    if (!signature && !CONFIG.strict) {
      req.logger.warn('Request missing signature (non-strict mode)');
      return next();
    }

    // 强制模式下，缺少签名的请求拒绝
    if (!signature || !timestamp || !nonce) {
      throw new AppError(4001, 'Missing signature headers', 401);
    }

    // 验证时间戳
    const now = Date.now();
    if (Math.abs(now - timestamp) > CONFIG.TIMESTAMP_WINDOW) {
      throw new AppError(4002, 'Request timestamp expired', 401);
    }

    // 验证 Nonce 唯一性（防重放）
    const nonceKey = `nonce:${nonce}`;
    const exists = await redis.get(nonceKey);
    if (exists) {
      throw new AppError(4003, 'Request replay detected', 401);
    }

    // 缓存 Nonce
    await redis.setex(nonceKey, Math.ceil(CONFIG.NONCE_EXPIRE / 1000), '1');

    // 获取用户会话密钥
    const userId = req.user?.sub;
    if (!userId) {
      throw new AppError(4004, 'User not authenticated', 401);
    }

    const sessionKey = await getSessionKey(userId);
    if (!sessionKey) {
      throw new AppError(4005, 'Invalid session', 401);
    }

    // 计算期望签名
    const expectedSignature = calculateSignature(req, timestamp, nonce, sessionKey);

    // 验证签名
    if (signature !== expectedSignature) {
      throw new AppError(4006, 'Invalid request signature', 401);
    }

    // 记录验证成功
    req.logger.debug('Request signature verified', { nonce, timestamp });

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * 计算请求签名
 */
function calculateSignature(req, timestamp, nonce, secretKey) {
  const method = req.method.toUpperCase();
  const path = req.path;
  const body = JSON.stringify(req.body || {});
  const bodyHash = createHmac('sha256', secretKey).update(body).digest('hex');

  const stringToSign = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const signature = createHmac('sha256', secretKey)
    .update(stringToSign)
    .digest('base64');

  return signature;
}

/**
 * 检查是否豁免路径
 */
function isExemptPath(path) {
  return CONFIG.exemptPaths.some(pattern => {
    if (pattern.endsWith('*')) {
      return path.startsWith(pattern.slice(0, -1));
    }
    return path === pattern;
  });
}

/**
 * 获取用户会话密钥
 */
async function getSessionKey(userId) {
  const key = await redis.get(`session_key:${userId}`);
  return key;
}

module.exports = {
  verifyRequestSignature,
  calculateSignature,
  CONFIG
};
```

### 4.3 会话密钥管理

```javascript
// backend/services/user-service/src/sessionKeyService.js

const crypto = require('crypto');
const redis = require('../../../shared/redis');
const { query } = require('../../../shared/db');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('session-key-service');

const SESSION_KEY_LENGTH = 32; // 256 bits
const SESSION_KEY_EXPIRE = 7 * 24 * 60 * 60; // 7天

class SessionKeyService {
  /**
   * 为用户生成新的会话密钥
   */
  async generateSessionKey(userId) {
    const sessionKey = crypto.randomBytes(SESSION_KEY_LENGTH).toString('hex');

    // 存储到 Redis
    await redis.setex(
      `session_key:${userId}`,
      SESSION_KEY_EXPIRE,
      sessionKey
    );

    // 记录到数据库（用于审计）
    await query(`
      INSERT INTO user_session_keys (user_id, key_hash, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '${SESSION_KEY_EXPIRE} seconds')
    `, [userId, this.hashKey(sessionKey)]);

    logger.info({ userId }, 'Session key generated');
    return sessionKey;
  }

  /**
   * 获取用户当前会话密钥
   */
  async getSessionKey(userId) {
    const key = await redis.get(`session_key:${userId}`);
    return key;
  }

  /**
   * 刷新会话密钥
   */
  async refreshSessionKey(userId) {
    return this.generateSessionKey(userId);
  }

  /**
   * 撤销会话密钥
   */
  async revokeSessionKey(userId) {
    await redis.del(`session_key:${userId}`);
    await query(`
      UPDATE user_session_keys
      SET revoked_at = NOW()
      WHERE user_id = $1 AND revoked_at IS NULL
    `, [userId]);

    logger.info({ userId }, 'Session key revoked');
  }

  /**
   * 密钥哈希（存储用）
   */
  hashKey(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }
}

module.exports = new SessionKeyService();
```

### 4.4 客户端签名 SDK

```javascript
// frontend/game-client/src/utils/requestSigner.js

/**
 * API 请求签名 SDK
 */
class RequestSigner {
  constructor() {
    this.sessionKey = null;
  }

  /**
   * 初始化会话密钥（登录后调用）
   */
  setSessionKey(key) {
    this.sessionKey = key;
    // 安全存储到内存（不持久化）
  }

  /**
   * 清除会话密钥（登出时调用）
   */
  clearSessionKey() {
    this.sessionKey = null;
  }

  /**
   * 为请求添加签名 Headers
   */
  signRequest(config) {
    if (!this.sessionKey) {
      console.warn('No session key, request will not be signed');
      return config;
    }

    const timestamp = Date.now();
    const nonce = this.generateNonce();
    const signature = this.calculateSignature(config, timestamp, nonce);

    config.headers = {
      ...config.headers,
      'X-Request-Signature': signature,
      'X-Request-Timestamp': timestamp,
      'X-Request-Nonce': nonce
    };

    return config;
  }

  /**
   * 生成 Nonce
   */
  generateNonce() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * 计算签名
   */
  calculateSignature(config, timestamp, nonce) {
    const method = (config.method || 'GET').toUpperCase();
    const path = this.extractPath(config.url);
    const body = JSON.stringify(config.data || {});
    const bodyHash = this.hmacSha256(this.sessionKey, body);

    const stringToSign = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
    return this.hmacSha256Base64(this.sessionKey, stringToSign);
  }

  /**
   * HMAC-SHA256 (hex)
   */
  hmacSha256(key, data) {
    // 使用 Web Crypto API
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const messageData = encoder.encode(data);

    // 同步计算（简化版，实际应使用 async/await）
    // 生产环境需要使用 crypto.subtle.importKey + crypto.subtle.sign
    return this.syncHmac(key, data);
  }

  /**
   * HMAC-SHA256 (Base64)
   */
  hmacSha256Base64(key, data) {
    const hex = this.hmacSha256(key, data);
    return btoa(hex.match(/\w{2}/g).map(a => String.fromCharCode(parseInt(a, 16))).join(''));
  }

  /**
   * 同步 HMAC（使用第三方库如 js-sha256）
   */
  syncHmac(key, data) {
    // 实际实现应使用 js-sha256 或类似库
    // 这里仅为示例
    const sha256 = require('js-sha256');
    const hmac = sha256.hmac(key, data);
    return hmac;
  }

  /**
   * 从 URL 提取路径
   */
  extractPath(url) {
    try {
      const urlObj = new URL(url, window.location.origin);
      return urlObj.pathname;
    } catch {
      return url;
    }
  }
}

export default new RequestSigner();
```

### 4.5 数据库表设计

```sql
-- 用户会话密钥表
CREATE TABLE IF NOT EXISTS user_session_keys (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id),
    key_hash VARCHAR(64) NOT NULL,
    device_id VARCHAR(100),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP,
    last_used_at TIMESTAMP
);

CREATE INDEX idx_session_keys_user ON user_session_keys(user_id);
CREATE INDEX idx_session_keys_expires ON user_session_keys(expires_at);
CREATE INDEX idx_session_keys_revoked ON user_session_keys(revoked_at) WHERE revoked_at IS NULL;

-- 签名验证日志表
CREATE TABLE IF NOT EXISTS signature_verification_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID,
    request_path VARCHAR(500),
    request_method VARCHAR(10),
    nonce VARCHAR(100),
    timestamp BIGINT,
    verification_result VARCHAR(20), -- success, failed, expired, replay
    failure_reason TEXT,
    ip_address INET,
    created_at TIMESTAMP DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- 创建分区（按月）
CREATE TABLE signature_logs_202606 PARTITION OF signature_verification_logs
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE signature_logs_202607 PARTITION OF signature_verification_logs
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX idx_sig_logs_user ON signature_verification_logs(user_id);
CREATE INDEX idx_sig_logs_result ON signature_verification_logs(verification_result);
CREATE INDEX idx_sig_logs_created ON signature_verification_logs(created_at);

-- 签名配置表
CREATE TABLE IF NOT EXISTS signature_config (
    id SERIAL PRIMARY KEY,
    endpoint_pattern VARCHAR(500) NOT NULL,
    enabled BOOLEAN DEFAULT true,
    strict_mode BOOLEAN DEFAULT true,
    timestamp_window_ms INTEGER DEFAULT 300000,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO signature_config (endpoint_pattern, enabled, strict_mode, description) VALUES
('/api/v1/payment/*', true, true, '支付相关接口强制签名'),
('/api/v1/trade/*', true, true, '交易相关接口强制签名'),
('/api/v1/reward/*', true, true, '奖励领取接口强制签名'),
('/api/v1/user/*', true, false, '用户接口宽松模式'),
('/api/v1/pokemon/*', true, false, '精灵接口宽松模式');
```

### 4.6 Prometheus 指标

```javascript
// backend/shared/metrics.js

const signatureVerificationTotal = new Counter({
  name: 'signature_verification_total',
  help: 'Total signature verifications',
  labelNames: ['result', 'endpoint']
});

const signatureVerificationDuration = new Histogram({
  name: 'signature_verification_duration_seconds',
  help: 'Signature verification duration',
  buckets: [0.001, 0.003, 0.005, 0.01, 0.05]
});

const nonceCacheHitTotal = new Counter({
  name: 'nonce_cache_hit_total',
  help: 'Nonce cache hit count',
  labelNames: ['hit'] // true/false
});

const replayAttackTotal = new Counter({
  name: 'replay_attack_total',
  help: 'Detected replay attacks',
  labelNames: ['endpoint', 'user_id']
});
```

## 5. 验收标准（可测试）

- [ ] 每个请求包含 X-Request-Signature、X-Request-Timestamp、X-Request-Nonce Headers
- [ ] 签名验证中间件正确验证 HMAC-SHA256 签名
- [ ] 时间戳超过 5 分钟的请求被拒绝（返回 401）
- [ ] 相同 Nonce 的重复请求被拒绝（返回 401，记录 replay_attack_total 指标）
- [ ] 签名不匹配的请求被拒绝（返回 401）
- [ ] 豁免路径（/health、/metrics）无需签名即可访问
- [ ] 宽松模式下未签名请求允许通过（记录日志）
- [ ] 用户登录时生成会话密钥并返回给客户端
- [ ] 用户登出时会话密钥被撤销
- [ ] 会话密钥 7 天过期，自动刷新
- [ ] 签名验证延迟 < 5ms（P95）
- [ ] Redis Nonce 缓存命中率 > 99%
- [ ] 签名验证日志正确记录到 signature_verification_logs 表
- [ ] Prometheus 指标 signature_verification_total 正确计数
- [ ] 管理后台可配置哪些端点需要强制签名验证
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**L（Large）** - 3-5 个工作日

- 后端中间件与服务（1.5天）
- 数据库设计与迁移（0.5天）
- 客户端 SDK 集成（1天）
- 测试与调试（1天）

## 7. 优先级理由

**P1（高优先级）**：

1. **安全关键**：防止重放攻击直接关系到支付、交易、奖励等核心业务的安全。
2. **影响范围广**：所有 API 请求都需要经过此验证机制。
3. **依赖前置**：基于 REQ-00045 设备完整性检测的进一步强化。
4. **成熟度提升**：安全与合规维度可提升 1-2 分。

实施后可显著提升系统安全性，防止请求重放和篡改攻击，符合金融级安全标准。
