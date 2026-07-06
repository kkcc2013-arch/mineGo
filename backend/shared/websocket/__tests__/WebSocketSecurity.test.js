/**
 * WebSocket 消息安全系统单元测试
 * REQ-00434: WebSocket 消息完整性与防重放攻击保护系统
 */

const WebSocketMessageSecurity = require('../WebSocketMessageSecurity');
const WebSocketChallengeAuth = require('../WebSocketChallengeAuth');
const WebSocketAnomalyDetector = require('../WebSocketAnomalyDetector');
const crypto = require('crypto');

// Mock Redis
const mockRedis = {
  store: new Map(),
  async get(key) {
    return this.store.get(key);
  },
  async set(key, value, ...args) {
    this.store.set(key, value);
    return 'OK';
  },
  async incr(key) {
    const value = parseInt(this.store.get(key) || '0');
    this.store.set(key, String(value + 1));
    return value + 1;
  },
  async exists(key) {
    return this.store.has(key) ? 1 : 0;
  },
  async del(key) {
    this.store.delete(key);
    return 1;
  },
  async expire(key, seconds) {
    return 1;
  },
  async lpush(key, value) {
    return 1;
  },
  async lrange(key, start, end) {
    return [];
  },
  async ltrim(key, start, end) {
    return 'OK';
  },
  async publish(channel, message) {
    return 1;
  },
  clear() {
    this.store.clear();
  }
};

describe('WebSocketMessageSecurity', () => {
  let messageSecurity;
  const secretKey = 'test-secret-key-12345';
  const sessionId = 'session-test-001';

  beforeEach(() => {
    mockRedis.clear();
    messageSecurity = new WebSocketMessageSecurity({
      redis: mockRedis,
      secretKey,
      timestampTolerance: 30000,
      nonceExpiry: 60000
    });
  });

  describe('signMessage', () => {
    it('should sign message with valid metadata', () => {
      const message = {
        type: 'battle_action',
        data: { action: 'attack', damage: 50 }
      };

      const signedMessage = messageSecurity.signMessage(message, sessionId);

      expect(signedMessage).toHaveProperty('_meta');
      expect(signedMessage._meta).toHaveProperty('timestamp');
      expect(signedMessage._meta).toHaveProperty('nonce');
      expect(signedMessage._meta).toHaveProperty('sequence');
      expect(signedMessage._meta).toHaveProperty('sessionId', sessionId);
      expect(signedMessage._meta).toHaveProperty('signature');
      expect(signedMessage._meta.signature).toHaveLength(64); // HMAC-SHA256 hex长度
    });

    it('should increment sequence number', async () => {
      const message = { type: 'test', data: {} };

      const signed1 = messageSecurity.signMessage(message, sessionId);
      await messageSecurity.updateSequence(sessionId, signed1._meta.sequence);

      const signed2 = messageSecurity.signMessage(message, sessionId);

      expect(signed2._meta.sequence).toBeGreaterThan(signed1._meta.sequence);
    });
  });

  describe('verifyMessage', () => {
    it('should verify valid signed message', async () => {
      const message = { type: 'test', data: { value: 100 } };
      const signedMessage = messageSecurity.signMessage(message, sessionId);

      const result = await messageSecurity.verifyMessage(signedMessage, sessionId);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should reject message without meta', async () => {
      const message = { type: 'test', data: {} };

      const result = await messageSecurity.verifyMessage(message, sessionId);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('MISSING_META');
    });

    it('should reject message with mismatched session ID', async () => {
      const message = { type: 'test', data: {} };
      const signedMessage = messageSecurity.signMessage(message, sessionId);

      const result = await messageSecurity.verifyMessage(signedMessage, 'different-session');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('SESSION_MISMATCH');
    });

    it('should reject message with expired timestamp', async () => {
      const message = { type: 'test', data: {} };
      const signedMessage = messageSecurity.signMessage(message, sessionId);
      
      // 修改时间戳为过期值
      signedMessage._meta.timestamp = Date.now() - 60000;

      const result = await messageSecurity.verifyMessage(signedMessage, sessionId);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TIMESTAMP_EXPIRED');
    });

    it('should reject message with reused nonce', async () => {
      const message = { type: 'test', data: {} };
      const signedMessage = messageSecurity.signMessage(message, sessionId);
      
      // 首次验证通过
      await messageSecurity.verifyMessage(signedMessage, sessionId);
      
      // 标记 nonce 已使用
      await messageSecurity.markNonceUsed(signedMessage._meta.nonce);

      // 再次验证应该失败
      const result = await messageSecurity.verifyMessage(signedMessage, sessionId);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('NONCE_REUSED');
    });

    it('should reject message with invalid sequence', async () => {
      const message = { type: 'test', data: {} };
      const signedMessage = messageSecurity.signMessage(message, sessionId);
      
      // 首次验证
      await messageSecurity.verifyMessage(signedMessage, sessionId);
      
      // 使用相同序列号再次发送
      const duplicateSeqMessage = messageSecurity.signMessage(message, sessionId);
      duplicateSeqMessage._meta.sequence = signedMessage._meta.sequence; // 故意降低序列号

      const result = await messageSecurity.verifyMessage(duplicateSeqMessage, sessionId);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('SEQUENCE_NOT_INCREMENTED');
    });

    it('should reject message with invalid signature', async () => {
      const message = { type: 'test', data: {} };
      const signedMessage = messageSecurity.signMessage(message, sessionId);
      
      // 修改签名
      signedMessage._meta.signature = '0000000000000000000000000000000000000000000000000000000000000000';

      const result = await messageSecurity.verifyMessage(signedMessage, sessionId);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('SIGNATURE_INVALID');
    });
  });

  describe('nonce management', () => {
    it('should generate unique nonce', () => {
      const nonce1 = messageSecurity.generateNonce();
      const nonce2 = messageSecurity.generateNonce();

      expect(nonce1).toHaveLength(64); // 32字节hex
      expect(nonce2).toHaveLength(64);
      expect(nonce1).not.toBe(nonce2);
    });

    it('should mark nonce as used', async () => {
      const nonce = messageSecurity.generateNonce();
      
      await messageSecurity.markNonceUsed(nonce);
      
      const key = `ws:nonce:${nonce}`;
      expect(mockRedis.store.has(key)).toBe(true);
    });

    it('should detect reused nonce', async () => {
      const nonce = messageSecurity.generateNonce();
      
      await messageSecurity.markNonceUsed(nonce);
      
      const result = await messageSecurity.verifyNonce(nonce);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('NONCE_REUSED');
    });
  });

  describe('timestamp validation', () => {
    it('should accept valid timestamp', () => {
      const timestamp = Date.now();
      
      const result = messageSecurity.verifyTimestamp(timestamp);
      
      expect(result.valid).toBe(true);
    });

    it('should reject expired timestamp', () => {
      const timestamp = Date.now() - 60000; // 60秒前
      
      const result = messageSecurity.verifyTimestamp(timestamp);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TIMESTAMP_EXPIRED');
    });

    it('should reject future timestamp', () => {
      const timestamp = Date.now() + 60000; // 60秒后
      
      const result = messageSecurity.verifyTimestamp(timestamp);
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('TIMESTAMP_EXPIRED');
    });
  });

  describe('signature verification', () => {
    it('should create and verify valid signature', () => {
      const payload = JSON.stringify({ type: 'test', timestamp: Date.now() });
      const signature = messageSecurity.createSignature(payload);
      
      expect(signature).toHaveLength(64);
      expect(typeof signature).toBe('string');
    });
  });
});

describe('WebSocketChallengeAuth', () => {
  let challengeAuth;
  const secretKey = 'test-secret-key-12345';
  const sessionId = 'session-test-001';

  beforeEach(() => {
    mockRedis.clear();
    challengeAuth = new WebSocketChallengeAuth({
      redis: mockRedis,
      secretKey,
      challengeInterval: 300000,
      challengeTimeout: 30000,
      maxChallengeFailures: 3
    });
  });

  describe('sendChallenge', () => {
    it('should generate and store challenge', async () => {
      const ws = { sessionId, send: jest.fn() };
      
      const challengeMessage = await challengeAuth.sendChallenge(ws, sessionId);

      expect(challengeMessage).toHaveProperty('type', 'auth_challenge');
      expect(challengeMessage).toHaveProperty('challengeId');
      expect(challengeMessage).toHaveProperty('challenge');
      expect(challengeMessage).toHaveProperty('timestamp');
      expect(challengeMessage).toHaveProperty('expiresIn');
      expect(challengeMessage.challenge).toHaveLength(64); // 32字节hex
    });

    it('should store challenge in Redis', async () => {
      const ws = { sessionId, send: jest.fn() };
      
      const challengeMessage = await challengeAuth.sendChallenge(ws, sessionId);
      
      const key = `ws:challenge:${sessionId}`;
      expect(mockRedis.store.has(key)).toBe(true);
    });
  });

  describe('verifyChallengeResponse', () => {
    it('should verify correct challenge response', async () => {
      const ws = { sessionId, send: jest.fn() };
      
      // 发送挑战
      const challengeMessage = await challengeAuth.sendChallenge(ws, sessionId);
      
      // 计算正确响应
      const response = WebSocketChallengeAuth.generateResponse(
        challengeMessage.challenge,
        challengeMessage.timestamp,
        secretKey
      );
      
      // 验证响应
      const result = await challengeAuth.verifyChallengeResponse(sessionId, {
        challengeId: challengeMessage.challengeId,
        response
      });

      expect(result.valid).toBe(true);
    });

    it('should reject incorrect challenge response', async () => {
      const ws = { sessionId, send: jest.fn() };
      
      // 发送挑战
      const challengeMessage = await challengeAuth.sendChallenge(ws, sessionId);
      
      // 错误响应
      const wrongResponse = '0000000000000000000000000000000000000000000000000000000000000000';
      
      // 验证响应
      const result = await challengeAuth.verifyChallengeResponse(sessionId, {
        challengeId: challengeMessage.challengeId,
        response: wrongResponse
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('RESPONSE_INVALID');
    });

    it('should reject expired challenge', async () => {
      const ws = { sessionId, send: jest.fn() };
      
      // 发送挑战
      const challengeMessage = await challengeAuth.sendChallenge(ws, sessionId);
      
      // 清除挑战（模拟过期）
      mockRedis.store.delete(`ws:challenge:${sessionId}`);
      
      // 尝试验证
      const response = WebSocketChallengeAuth.generateResponse(
        challengeMessage.challenge,
        challengeMessage.timestamp,
        secretKey
      );
      
      const result = await challengeAuth.verifyChallengeResponse(sessionId, {
        challengeId: challengeMessage.challengeId,
        response
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('CHALLENGE_EXPIRED');
    });

    it('should reject mismatched challenge ID', async () => {
      const ws = { sessionId, send: jest.fn() };
      
      // 发送挑战
      const challengeMessage = await challengeAuth.sendChallenge(ws, sessionId);
      
      const response = WebSocketChallengeAuth.generateResponse(
        challengeMessage.challenge,
        challengeMessage.timestamp,
        secretKey
      );
      
      // 使用错误的 challenge ID
      const result = await challengeAuth.verifyChallengeResponse(sessionId, {
        challengeId: 'wrong-challenge-id',
        response
      });

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('CHALLENGE_ID_MISMATCH');
    });
  });

  describe('shouldChallenge', () => {
    it('should return true for new session', async () => {
      const result = await challengeAuth.shouldChallenge(sessionId);
      
      expect(result).toBe(true);
    });

    it('should return false after recent authentication', async () => {
      // 模拟最近认证
      await challengeAuth.updateAuthState(sessionId, true);
      
      const result = await challengeAuth.shouldChallenge(sessionId);
      
      expect(result).toBe(false);
    });
  });

  describe('shouldDisconnect', () => {
    it('should disconnect after max failures', async () => {
      // 记录多次失败
      for (let i = 0; i < 3; i++) {
        await challengeAuth.recordFailure(sessionId);
      }
      
      const result = await challengeAuth.shouldDisconnect(sessionId);
      
      expect(result).toBe(true);
    });

    it('should not disconnect with few failures', async () => {
      // 记录少量失败
      await challengeAuth.recordFailure(sessionId);
      
      const result = await challengeAuth.shouldDisconnect(sessionId);
      
      expect(result).toBe(false);
    });
  });
});

describe('WebSocketAnomalyDetector', () => {
  let anomalyDetector;
  const sessionId = 'session-test-001';
  const ip = '192.168.1.100';

  beforeEach(() => {
    mockRedis.clear();
    anomalyDetector = new WebSocketAnomalyDetector({
      redis: mockRedis,
      maxViolationsPerMinute: 5,
      maxDuplicateMessages: 10,
      maxChallengeFailures: 3
    });
  });

  describe('recordViolation', () => {
    it('should record violation and increment count', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      await anomalyDetector.recordViolation(ws, 'SIGNATURE_INVALID');
      
      const count = await anomalyDetector.getSessionViolationCount(sessionId);
      
      expect(count).toBe(1);
    });

    it('should track IP violations', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      await anomalyDetector.recordViolation(ws, 'TIMESTAMP_EXPIRED');
      
      const ipViolations = await anomalyDetector.getIPViolationCount(ip);
      
      expect(ipViolations).toBe(1);
    });

    it('should update statistics', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      await anomalyDetector.recordViolation(ws, 'NONCE_REUSED');
      
      const stats = anomalyDetector.getStats();
      
      expect(stats.totalViolations).toBe(1);
    });
  });

  describe('shouldDisconnect', () => {
    it('should disconnect when session violations exceed threshold', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      // 记录超过阈值的违规
      for (let i = 0; i < 6; i++) {
        await anomalyDetector.recordViolation(ws, 'SIGNATURE_INVALID');
      }
      
      const result = await anomalyDetector.shouldDisconnect(ws);
      
      expect(result.shouldDisconnect).toBe(true);
    });

    it('should disconnect when IP violations exceed threshold', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      // 记录超过阈值的 IP 违规
      for (let i = 0; i < 12; i++) {
        await anomalyDetector.recordViolation(ws, 'TIMESTAMP_EXPIRED');
      }
      
      const result = await anomalyDetector.shouldDisconnect(ws);
      
      expect(result.shouldDisconnect).toBe(true);
    });

    it('should not disconnect with few violations', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      await anomalyDetector.recordViolation(ws, 'SIGNATURE_INVALID');
      
      const result = await anomalyDetector.shouldDisconnect(ws);
      
      expect(result.shouldDisconnect).toBe(false);
    });
  });

  describe('detectReplayPattern', () => {
    it('should detect duplicate nonce', async () => {
      const ws = { sessionId };
      
      const message = {
        type: 'battle_action',
        _meta: {
          nonce: 'abc123',
          timestamp: Date.now()
        }
      };
      
      // 首次记录消息
      await anomalyDetector.recordRecentMessage(sessionId, message);
      
      // 检测重复消息
      const result = await anomalyDetector.detectReplayPattern(ws, message);
      
      expect(result.detected).toBe(true);
      expect(result.details.reason).toBe('DUPLICATE_NONCE');
    });

    it('should detect timestamp anomaly', async () => {
      const ws = { sessionId };
      
      const message = {
        type: 'battle_action',
        _meta: {
          nonce: crypto.randomBytes(32).toString('hex'),
          timestamp: Date.now() - 120000 // 2分钟前（超出阈值）
        }
      };
      
      const result = await anomalyDetector.detectReplayPattern(ws, message);
      
      expect(result.detected).toBe(true);
      expect(result.details.reason).toBe('TIMESTAMP_ANOMALY');
    });

    it('should not detect replay for normal message', async () => {
      const ws = { sessionId };
      
      const message = {
        type: 'battle_action',
        _meta: {
          nonce: crypto.randomBytes(32).toString('hex'),
          timestamp: Date.now()
        }
      };
      
      const result = await anomalyDetector.detectReplayPattern(ws, message);
      
      expect(result.detected).toBe(false);
    });
  });

  describe('shouldAlert', () => {
    it('should alert when violations reach threshold', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      // 记录3次违规
      for (let i = 0; i < 3; i++) {
        await anomalyDetector.recordViolation(ws, 'SIGNATURE_INVALID');
      }
      
      const result = await anomalyDetector.shouldAlert(sessionId);
      
      expect(result).toBe(true);
    });

    it('should not alert with few violations', async () => {
      const ws = { sessionId, handshake: { address: ip } };
      
      await anomalyDetector.recordViolation(ws, 'SIGNATURE_INVALID');
      
      const result = await anomalyDetector.shouldAlert(sessionId);
      
      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return comprehensive statistics', () => {
      const stats = anomalyDetector.getStats();
      
      expect(stats).toHaveProperty('totalViolations');
      expect(stats).toHaveProperty('disconnections');
      expect(stats).toHaveProperty('alertsSent');
      expect(stats).toHaveProperty('thresholds');
      expect(stats.thresholds).toHaveProperty('maxViolationsPerMinute');
    });
  });
});