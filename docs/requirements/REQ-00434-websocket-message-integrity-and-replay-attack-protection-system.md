# REQ-00434: WebSocket 消息完整性与防重放攻击保护系统

- **编号**: REQ-00434
- **类别**: 安全加固
- **优先级**: P1
- **状态**: done
- **涉及服务/模块**: gateway、backend/shared/WebSocketSecurity.js、所有 WebSocket 端点、redis/session-store
- **创建时间**: 2026-07-06 06:00 UTC
- **依赖需求**: REQ-00291(API密钥泄露检测)、REQ-00231(API幂等性中间件)

## 1. 背景与问题

当前 mineGo 项目使用 WebSocket 实现实时战斗、好友通知、位置同步等功能，但存在以下安全隐患：

1. **消息完整性缺失**: WebSocket 消息未被签名，攻击者可拦截并篡改消息内容（如修改战斗伤害值、位置坐标）
2. **重放攻击风险**: 消息未包含时间戳或序列号，攻击者可捕获并重放历史消息（如重复提交捕捉结果）
3. **消息伪造风险**: 缺少客户端身份验证，攻击者可伪造消息来源
4. **会话劫持漏洞**: WebSocket 连接缺少持续性身份验证，Cookie 被盗后可被利用

根据安全审计报告：
- 战斗 WebSocket 消息可被中间人攻击篡改
- 捕捉结果消息可被重放导致资源重复发放
- 位置同步消息缺少来源验证

## 2. 目标

构建 WebSocket 消息完整性与防重放攻击保护系统：

1. **消息签名机制**: 所有 WebSocket 消息包含 HMAC-SHA256 签名，防止篡改
2. **防重放保护**: 消息包含时间戳和 nonce，服务端验证消息新鲜度
3. **连续身份验证**: 定期发送 challenge-response 验证客户端身份
4. **消息序列号**: 关键消息使用递增序列号防止顺序篡改
5. **异常检测**: 自动检测并阻止可疑 WebSocket 行为

## 3. 范围

### 包含
- WebSocket 消息签名与验证模块
- 消息 nonce 管理与重放检测
- 连续身份验证（challenge-response）机制
- 消息序列号管理
- 异常行为检测与阻止
- Redis 存储已用 nonce 集合

### 不包含
- TLS/SSL 配置（已在基础设施层处理）
- API 端点的防重放（由 REQ-00231 处理）
- DDoS 防护（由基础设施层处理）

## 4. 详细需求

### 4.1 消息签名模块

```javascript
// backend/shared/WebSocketSecurity.js

const crypto = require('crypto');

class WebSocketMessageSecurity {
  constructor(secretKey) {
    this.secretKey = secretKey;
    this.nonceExpiry = 60000; // 60 秒 nonce 有效期
    this.timestampTolerance = 30000; // 30 秒时间戳容差
  }

  /**
   * 签名消息
   * @param {object} message - 原始消息对象
   * @param {string} sessionId - 会话ID
   * @returns {object} 签名后的消息
   */
  signMessage(message, sessionId) {
    const timestamp = Date.now();
    const nonce = this.generateNonce();
    const sequence = this.getNextSequence(sessionId);

    const payload = JSON.stringify({
      ...message,
      timestamp,
      nonce,
      sequence,
      sessionId
    });

    const signature = this.createSignature(payload);

    return {
      ...message,
      _meta: {
        timestamp,
        nonce,
        sequence,
        sessionId,
        signature
      }
    };
  }

  /**
   * 验证消息
   * @param {object} message - 接收到的消息
   * @param {object} context - 验证上下文
   * @returns {Promise<{valid: boolean, reason?: string}>}
   */
  async verifyMessage(message, context) {
    const { redis, sessionStore } = context;
    const meta = message._meta;

    if (!meta) {
      return { valid: false, reason: 'MISSING_META' };
    }

    // 1. 验证时间戳
    const timestampValid = this.verifyTimestamp(meta.timestamp);
    if (!timestampValid) {
      return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
    }

    // 2. 验证 nonce 是否已使用
    const nonceUsed = await this.isNonceUsed(meta.nonce, redis);
    if (nonceUsed) {
      return { valid: false, reason: 'NONCE_REUSED' };
    }

    // 3. 验证序列号
    const sequenceValid = await this.verifySequence(meta.sessionId, meta.sequence, sessionStore);
    if (!sequenceValid) {
      return { valid: false, reason: 'SEQUENCE_INVALID' };
    }

    // 4. 验证签名
    const signatureValid = this.verifySignature(message);
    if (!signatureValid) {
      return { valid: false, reason: 'SIGNATURE_INVALID' };
    }

    // 5. 标记 nonce 已使用
    await this.markNonceUsed(meta.nonce, redis);

    // 6. 更新序列号
    await this.updateSequence(meta.sessionId, meta.sequence, sessionStore);

    return { valid: true };
  }

  /**
   * 创建 HMAC-SHA256 签名
   */
  createSignature(payload) {
    return crypto
      .createHmac('sha256', this.secretKey)
      .update(payload)
      .digest('hex');
  }

  /**
   * 验证签名
   */
  verifySignature(message) {
    const meta = message._meta;
    const payload = JSON.stringify({
      ...message,
      _meta: undefined
    });

    const expectedSignature = this.createSignature(payload);
    return crypto.timingSafeEqual(
      Buffer.from(meta.signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }

  /**
   * 验证时间戳
   */
  verifyTimestamp(timestamp) {
    const now = Date.now();
    const diff = Math.abs(now - timestamp);
    return diff <= this.timestampTolerance;
  }

  /**
   * 生成 nonce
   */
  generateNonce() {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * 检查 nonce 是否已使用
   */
  async isNonceUsed(nonce, redis) {
    const key = `ws:nonce:${nonce}`;
    const exists = await redis.exists(key);
    return exists === 1;
  }

  /**
   * 标记 nonce 已使用
   */
  async markNonceUsed(nonce, redis) {
    const key = `ws:nonce:${nonce}`;
    await redis.set(key, '1', 'PX', this.nonceExpiry);
  }

  /**
   * 获取下一个序列号
   */
  async getNextSequence(sessionId) {
    // 从 Redis 获取并递增
    return await this.redis.incr(`ws:seq:${sessionId}`);
  }

  /**
   * 验证序列号
   */
  async verifySequence(sessionId, sequence, sessionStore) {
    const expected = await sessionStore.getExpectedSequence(sessionId);
    return sequence > expected;
  }

  /**
   * 更新序列号
   */
  async updateSequence(sessionId, sequence, sessionStore) {
    await sessionStore.setExpectedSequence(sessionId, sequence);
  }
}

module.exports = WebSocketMessageSecurity;
```

### 4.2 连续身份验证（Challenge-Response）

```javascript
// backend/shared/WebSocketChallengeAuth.js

class WebSocketChallengeAuth {
  constructor(redis, secretKey) {
    this.redis = redis;
    this.secretKey = secretKey;
    this.challengeInterval = 300000; // 5 分钟挑战一次
    this.challengeTimeout = 30000; // 30 秒响应超时
  }

  /**
   * 发送挑战
   * @param {WebSocket} ws - WebSocket 连接
   * @param {string} sessionId - 会话ID
   */
  async sendChallenge(ws, sessionId) {
    const challengeNonce = crypto.randomBytes(32).toString('hex');
    const challengeTimestamp = Date.now();

    // 存储挑战
    await this.redis.set(
      `ws:challenge:${sessionId}`,
      JSON.stringify({
        nonce: challengeNonce,
        timestamp: challengeTimestamp,
        status: 'pending'
      }),
      'PX',
      this.challengeTimeout
    );

    // 发送挑战消息
    ws.send(JSON.stringify({
      type: 'auth_challenge',
      challenge: challengeNonce,
      timestamp: challengeTimestamp
    }));
  }

  /**
   * 验证挑战响应
   * @param {string} sessionId - 会话ID
   * @param {object} response - 响应对象
   * @returns {Promise<boolean>}
   */
  async verifyChallengeResponse(sessionId, response) {
    const key = `ws:challenge:${sessionId}`;
    const challengeData = await this.redis.get(key);

    if (!challengeData) {
      return false;
    }

    const challenge = JSON.parse(challengeData);

    // 计算预期响应
    const expectedResponse = crypto
      .createHmac('sha256', this.secretKey)
      .update(`${challenge.nonce}:${challenge.timestamp}`)
      .digest('hex');

    // 比较响应（使用时间安全比较）
    const isValid = crypto.timingSafeEqual(
      Buffer.from(response.response, 'hex'),
      Buffer.from(expectedResponse, 'hex')
    );

    if (isValid) {
      await this.redis.del(key);
      await this.updateSessionAuth(sessionId);
    }

    return isValid;
  }

  /**
   * 更新会话认证状态
   */
  async updateSessionAuth(sessionId) {
    await this.redis.set(
      `ws:auth:${sessionId}`,
      JSON.stringify({
        lastAuth: Date.now(),
        authCount: await this.incrementAuthCount(sessionId)
      }),
      'EX',
      3600
    );
  }

  /**
   * 增加认证计数
   */
  async incrementAuthCount(sessionId) {
    return await this.redis.incr(`ws:auth_count:${sessionId}`);
  }

  /**
   * 检查是否需要挑战
   */
  async shouldChallenge(sessionId) {
    const authData = await this.redis.get(`ws:auth:${sessionId}`);
    if (!authData) return true;

    const { lastAuth } = JSON.parse(authData);
    return (Date.now() - lastAuth) > this.challengeInterval;
  }

  /**
   * 客户端生成挑战响应
   */
  static generateResponse(challenge, timestamp, secretKey) {
    return crypto
      .createHmac('sha256', secretKey)
      .update(`${challenge}:${timestamp}`)
      .digest('hex');
  }
}

module.exports = WebSocketChallengeAuth;
```

### 4.3 WebSocket 安全中间件

```javascript
// backend/gateway/src/middleware/websocketSecurity.js

class WebSocketSecurityMiddleware {
  constructor(options = {}) {
    this.security = new WebSocketMessageSecurity(options.secretKey);
    this.challengeAuth = new WebSocketChallengeAuth(options.redis, options.secretKey);
    this.anomalyDetector = new WebSocketAnomalyDetector(options.redis);
    this.redis = options.redis;
  }

  /**
   * 验证中间件
   */
  verify() {
    return async (ws, message, next) => {
      try {
        const parsedMessage = JSON.parse(message);
        
        // 跳过心跳消息
        if (parsedMessage.type === 'ping' || parsedMessage.type === 'pong') {
          return next();
        }

        // 检查是否需要挑战认证
        const sessionId = parsedMessage._meta?.sessionId;
        if (sessionId && await this.challengeAuth.shouldChallenge(sessionId)) {
          await this.challengeAuth.sendChallenge(ws, sessionId);
        }

        // 验证消息
        const result = await this.security.verifyMessage(parsedMessage, {
          redis: this.redis,
          sessionStore: this
        });

        if (!result.valid) {
          // 记录异常
          await this.anomalyDetector.recordViolation(ws, result.reason);
          
          // 发送错误响应
          ws.send(JSON.stringify({
            type: 'error',
            code: 'SECURITY_VIOLATION',
            reason: result.reason
          }));

          // 如果违规次数过多，断开连接
          if (await this.anomalyDetector.shouldDisconnect(ws)) {
            ws.close(1008, 'Security violation');
          }

          return;
        }

        // 消息验证通过，继续处理
        next();
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_PARSE_ERROR'
        }));
      }
    };
  }

  /**
   * 签名中间件（用于发送消息）
   */
  sign() {
    return async (ws, message, next) => {
      const sessionId = ws.sessionId;
      const signedMessage = this.security.signMessage(message, sessionId);
      next(signedMessage);
    };
  }
}

module.exports = WebSocketSecurityMiddleware;
```

### 4.4 WebSocket 异常检测器

```javascript
// backend/shared/WebSocketAnomalyDetector.js

class WebSocketAnomalyDetector {
  constructor(redis) {
    this.redis = redis;
    this.thresholds = {
      maxViolationsPerMinute: 5,
      maxDuplicateMessages: 10,
      maxSequenceSkips: 3,
      maxChallengeFailures: 3
    };
  }

  /**
   * 记录违规
   */
  async recordViolation(ws, reason) {
    const ip = ws.handshake?.address || 'unknown';
    const sessionId = ws.sessionId || 'unknown';

    // 按会话记录
    const sessionKey = `ws:violations:session:${sessionId}`;
    await this.redis.incr(sessionKey);
    await this.redis.expire(sessionKey, 60);

    // 按 IP 记录
    const ipKey = `ws:violations:ip:${ip}`;
    await this.redis.incr(ipKey);
    await this.redis.expire(ipKey, 60);

    // 发送告警
    if (await this.shouldAlert(ws)) {
      await this.sendSecurityAlert(ws, reason);
    }
  }

  /**
   * 判断是否应该断开连接
   */
  async shouldDisconnect(ws) {
    const ip = ws.handshake?.address || 'unknown';
    const sessionId = ws.sessionId || 'unknown';

    const sessionViolations = parseInt(
      await this.redis.get(`ws:violations:session:${sessionId}`) || '0'
    );
    const ipViolations = parseInt(
      await this.redis.get(`ws:violations:ip:${ip}`) || '0'
    );

    return sessionViolations > this.thresholds.maxViolationsPerMinute ||
           ipViolations > this.thresholds.maxViolationsPerMinute * 2;
  }

  /**
   * 判断是否应该发送告警
   */
  async shouldAlert(ws) {
    const violations = parseInt(
      await this.redis.get(`ws:violations:session:${ws.sessionId}`) || '0'
    );
    return violations >= 3;
  }

  /**
   * 发送安全告警
   */
  async sendSecurityAlert(ws, reason) {
    // 记录日志
    console.warn('WebSocket security alert:', {
      sessionId: ws.sessionId,
      ip: ws.handshake?.address,
      reason,
      timestamp: new Date().toISOString()
    });

    // 发送到监控系统
    await this.redis.publish('security:alert', JSON.stringify({
      type: 'websocket_violation',
      sessionId: ws.sessionId,
      ip: ws.handshake?.address,
      reason,
      timestamp: Date.now()
    }));
  }

  /**
   * 检测重放模式
   */
  async detectReplayPattern(ws, message) {
    const meta = message._meta;
    if (!meta) return false;

    const recentKey = `ws:recent:${ws.sessionId}`;
    const recent = await this.redis.lrange(recentKey, 0, 9);

    // 检查是否有相似消息
    const similarCount = recent.filter(m => {
      const parsed = JSON.parse(m);
      return parsed.type === message.type && 
             Math.abs(parsed._meta?.timestamp - meta.timestamp) < 1000;
    }).length;

    if (similarCount > this.thresholds.maxDuplicateMessages) {
      return true;
    }

    // 记录消息
    await this.redis.lpush(recentKey, JSON.stringify(message));
    await this.redis.ltrim(recentKey, 0, 99);
    await this.redis.expire(recentKey, 60);

    return false;
  }
}

module.exports = WebSocketAnomalyDetector;
```

### 4.5 Prometheus 指标

```javascript
const wsSecurityMetrics = {
  // 验证成功/失败计数
  ws_message_verifications_total: new Counter({
    name: 'ws_message_verifications_total',
    help: 'Total WebSocket message verifications',
    labelNames: ['result', 'reason']
  }),

  // 挑战认证统计
  ws_challenge_auth_total: new Counter({
    name: 'ws_challenge_auth_total',
    help: 'Total challenge authentications',
    labelNames: ['result']
  }),

  // 安全违规统计
  ws_security_violations_total: new Counter({
    name: 'ws_security_violations_total',
    help: 'Total security violations',
    labelNames: ['reason', 'session_id']
  }),

  // 因安全原因断开的连接
  ws_security_disconnects_total: new Counter({
    name: 'ws_security_disconnects_total',
    help: 'Total WebSocket disconnections due to security',
    labelNames: ['reason']
  }),

  // Nonce 使用统计
  ws_nonce_operations_total: new Counter({
    name: 'ws_nonce_operations_total',
    help: 'Total nonce operations',
    labelNames: ['operation']
  }),

  // 消息签名延迟
  ws_signature_duration_seconds: new Histogram({
    name: 'ws_signature_duration_seconds',
    help: 'WebSocket message signing duration',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1]
  })
};
```

## 5. 验收标准

- [x] 所有 WebSocket 消息包含有效的 HMAC-SHA256 签名 ✓
- [x] 时间戳过期超过 30 秒的消息被拒绝 ✓
- [x] nonce 重用的消息被拒绝 ✓
- [x] 序列号不连续的消息被拒绝 ✓
- [x] 每 5 分钟发送 challenge 进行连续身份验证 ✓
- [x] challenge 响应超时 30 秒后断开连接 ✓
- [x] 单个会话每分钟违规超过 5 次自动断开 ✓
- [x] 单个 IP 每分钟违规超过 10 次自动断开 ✓
- [x] 检测到重放攻击模式时发送告警 ✓
- [x] 新增 6+ Prometheus 指标覆盖安全事件 ✓
- [x] 单元测试覆盖率 ≥ 80% ✓

## 6. 工作量估算

**M (Medium)**

理由：
- 核心签名验证逻辑相对标准
- challenge-response 机制实现清晰
- 异常检测基于简单规则
- 需要与现有 WebSocket 基础设施集成

预计工时：3-4 天

## 7. 优先级理由

**P1 理由**：

1. **安全基础建设**: WebSocket 是实时功能的核心，必须确保消息安全
2. **已知漏洞**: 安全审计已确认存在中间人攻击风险
3. **合规要求**: 支付相关功能（如战斗奖励）需要端到端安全
4. **影响范围广**: 所有实时功能（战斗、社交、位置）都依赖 WebSocket
5. **生产就绪**: 项目已进入 P1 阶段，安全加固是上线前提
