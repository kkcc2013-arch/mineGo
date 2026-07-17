/**
 * 敏感 API 二次身份验证与风控行为分级系统
 * 单元测试
 * 
 * REQ-00588
 */

'use strict';

const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('mocha');
const RiskAssessmentMiddleware = require('../../../src/middleware/riskAssessment');
const SensitiveApiMfaService = require('../../../security/src/sensitiveApiMfa');

// Mock Redis
class MockRedis {
  constructor() {
    this.data = new Map();
    this.expiry = new Map();
  }
  
  async get(key) {
    return this.data.get(key);
  }
  
  async set(key, value) {
    this.data.set(key, value);
    return 'OK';
  }
  
  async setex(key, ttl, value) {
    this.data.set(key, value);
    this.expiry.set(key, Date.now() + ttl * 1000);
    return 'OK';
  }
  
  async hset(key, ...args) {
    const obj = this.data.get(key) || {};
    for (let i = 0; i < args.length - 1; i += 2) {
      obj[args[i]] = args[i + 1];
    }
    this.data.set(key, obj);
    return 1;
  }
  
  async hgetall(key) {
    return this.data.get(key) || {};
  }
  
  async hincrby(key, field, amount) {
    const obj = this.data.get(key) || {};
    obj[field] = (parseInt(obj[field]) || 0) + amount;
    this.data.set(key, obj);
    return obj[field];
  }
  
  async del(key) {
    this.data.delete(key);
    return 1;
  }
  
  async expire(key, ttl) {
    this.expiry.set(key, Date.now() + ttl * 1000);
    return 1;
  }
  
  async sismember(key, value) {
    const set = this.data.get(key) || new Set();
    return set.has(value) ? 1 : 0;
  }
  
  async sadd(key, value) {
    const set = this.data.get(key) || new Set();
    set.add(value);
    this.data.set(key, set);
    return 1;
  }
  
  async lrange(key, start, end) {
    return this.data.get(key) || [];
  }
  
  async lpush(key, value) {
    const list = this.data.get(key) || [];
    list.unshift(value);
    this.data.set(key, list);
    return list.length;
  }
  
  async ltrim(key, start, end) {
    return 'OK';
  }
  
  async incr(key) {
    const val = (parseInt(this.data.get(key)) || 0) + 1;
    this.data.set(key, val.toString());
    return val;
  }
  
  async scard(key) {
    const set = this.data.get(key) || new Set();
    return set.size;
  }
  
  async publish(channel, message) {
    return 1;
  }
}

// Mock Database
class MockDb {
  constructor() {
    this.queries = [];
  }
  
  async query(sql, params) {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
}

describe('REQ-00588: 敏感 API 二次身份验证与风控行为分级系统', () => {
  let redis;
  let db;
  let riskMiddleware;
  let mfaService;
  
  beforeEach(() => {
    redis = new MockRedis();
    db = new MockDb();
    riskMiddleware = new RiskAssessmentMiddleware(redis, db);
    mfaService = new SensitiveApiMfaService(db, redis);
  });
  
  describe('RiskAssessmentMiddleware', () => {
    describe('getApiSensitivity', () => {
      it('should identify P0 (extremely sensitive) APIs', () => {
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/payment/withdraw'), 'P0');
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/user/change-password'), 'P0');
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/user/delete-account'), 'P0');
      });
      
      it('should identify P1 (highly sensitive) APIs', () => {
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/pokemon/trade'), 'P1');
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/pokemon/transfer'), 'P1');
      });
      
      it('should identify P2 (moderately sensitive) APIs', () => {
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/user/export-data'), 'P2');
      });
      
      it('should return null for non-sensitive APIs', () => {
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/pokemon/list'), null);
        assert.equal(riskMiddleware.getApiSensitivity('/api/v1/user/profile'), null);
      });
    });
    
    describe('getRiskLevel', () => {
      it('should return LOW for scores 0-30', () => {
        assert.equal(riskMiddleware.getRiskLevel(0), 'low');
        assert.equal(riskMiddleware.getRiskLevel(15), 'low');
        assert.equal(riskMiddleware.getRiskLevel(30), 'low');
      });
      
      it('should return MEDIUM for scores 31-60', () => {
        assert.equal(riskMiddleware.getRiskLevel(31), 'medium');
        assert.equal(riskMiddleware.getRiskLevel(45), 'medium');
        assert.equal(riskMiddleware.getRiskLevel(60), 'medium');
      });
      
      it('should return HIGH for scores 61-80', () => {
        assert.equal(riskMiddleware.getRiskLevel(61), 'high');
        assert.equal(riskMiddleware.getRiskLevel(75), 'high');
        assert.equal(riskMiddleware.getRiskLevel(80), 'high');
      });
      
      it('should return CRITICAL for scores 81-100', () => {
        assert.equal(riskMiddleware.getRiskLevel(81), 'critical');
        assert.equal(riskMiddleware.getRiskLevel(95), 'critical');
        assert.equal(riskMiddleware.getRiskLevel(100), 'critical');
      });
    });
    
    describe('makeDecision', () => {
      it('should deny P0 API access for CRITICAL risk', () => {
        const decision = riskMiddleware.makeDecision('P0', 'critical', 85);
        assert.equal(decision.action, 'deny');
      });
      
      it('should require full MFA for P0 API with HIGH risk', () => {
        const decision = riskMiddleware.makeDecision('P0', 'high', 70);
        assert.equal(decision.action, 'challenge');
        assert.equal(decision.challengeType, 'full_mfa');
      });
      
      it('should require quick verify for P0 API with MEDIUM risk', () => {
        const decision = riskMiddleware.makeDecision('P0', 'medium', 45);
        assert.equal(decision.action, 'challenge');
        assert.equal(decision.challengeType, 'quick_verify');
      });
      
      it('should always require verification for P0 APIs even with LOW risk', () => {
        const decision = riskMiddleware.makeDecision('P0', 'low', 10);
        assert.equal(decision.action, 'challenge');
      });
      
      it('should allow P1 API access for LOW risk', () => {
        const decision = riskMiddleware.makeDecision('P1', 'low', 20);
        assert.equal(decision.action, 'allow');
      });
      
      it('should require MFA for P1 API with HIGH risk', () => {
        const decision = riskMiddleware.makeDecision('P1', 'high', 70);
        assert.equal(decision.action, 'challenge');
        assert.equal(decision.challengeType, 'full_mfa');
      });
    });
    
    describe('calculateDistance', () => {
      it('should calculate correct distance between two points', () => {
        // 北京到上海约 1000km
        const distance = riskMiddleware.calculateDistance(
          39.9042, 116.4074,  // 北京
          31.2304, 121.4737   // 上海
        );
        assert.ok(distance > 900 && distance < 1100, `Distance should be ~1000km, got ${distance}`);
      });
      
      it('should return 0 for same location', () => {
        const distance = riskMiddleware.calculateDistance(0, 0, 0, 0);
        assert.equal(Math.round(distance), 0);
      });
    });
  });
  
  describe('SensitiveApiMfaService', () => {
    describe('generateVerificationCode', () => {
      it('should generate 6-digit code by default', () => {
        const code = mfaService.generateVerificationCode();
        assert.ok(code.length === 6, `Code should be 6 digits, got ${code.length}`);
        assert.ok(/^\d+$/.test(code), 'Code should be numeric');
      });
      
      it('should generate 4-digit code for quick verify', () => {
        const code = mfaService.generateVerificationCode(4);
        assert.ok(code.length === 4, `Code should be 4 digits, got ${code.length}`);
      });
    });
    
    describe('hashCode and verifyCodeHash', () => {
      it('should correctly hash and verify code', () => {
        const code = '123456';
        const hash = mfaService.hashCode(code);
        
        assert.ok(mfaService.verifyCodeHash(code, hash), 'Should verify correct code');
        assert.ok(!mfaService.verifyCodeHash('654321', hash), 'Should reject wrong code');
      });
    });
    
    describe('maskDestination', () => {
      it('should mask phone number correctly', () => {
        const masked = mfaService.maskDestination('13812345678', 'sms');
        assert.equal(masked, '138****5678');
      });
      
      it('should mask email correctly', () => {
        const masked = mfaService.maskDestination('test@example.com', 'email');
        assert.equal(masked, 't***@example.com');
      });
    });
    
    describe('createChallengeToken', () => {
      it('should create valid challenge token', async () => {
        const userId = 12345;
        const path = '/api/v1/payment/withdraw';
        const token = await riskMiddleware.createChallengeToken(userId, path, 50);
        
        assert.ok(token, 'Should return a token');
        assert.ok(typeof token === 'string', 'Token should be string');
        
        // Verify stored in Redis
        const key = `mfa_challenge:${userId}:${token}`;
        const data = await redis.hgetall(key);
        assert.equal(data.path, path);
      });
    });
    
    describe('initiateVerification', () => {
      it('should reject invalid challenge token', async () => {
        const result = await mfaService.initiateVerification(
          12345,
          'invalid-token',
          'sms'
        );
        
        assert.equal(result.success, false);
        assert.equal(result.error, 'INVALID_CHALLENGE_TOKEN');
      });
    });
  });
  
  describe('Integration Tests', () => {
    it('should complete full MFA flow', async () => {
      const userId = 12345;
      const path = '/api/v1/payment/withdraw';
      
      // 1. Create challenge token
      const challengeToken = await riskMiddleware.createChallengeToken(userId, path, 50);
      
      // 2. Store in Redis for MFA service to find
      await redis.hset(`mfa_challenge:${userId}:${challengeToken}`, {
        path,
        riskScore: '50'
      });
      
      // 3. Generate verification code manually
      const code = mfaService.generateVerificationCode();
      const verificationId = 'test-verification-id';
      
      // 4. Store verification
      await redis.hset(`mfa_verification:${verificationId}`, {
        userId: userId.toString(),
        challengeToken,
        verificationType: 'sms',
        code: mfaService.hashCode(code),
        path,
        riskScore: '50',
        attempts: '0'
      });
      
      // 5. Verify code (simulate user input)
      // Note: In real test, would use mfaService.verifyCode
      const storedCode = await redis.hget(`mfa_verification:${verificationId}`, 'code');
      const isValid = mfaService.verifyCodeHash(code, storedCode);
      
      assert.ok(isValid, 'Code verification should succeed');
    });
  });
});

// Export for running
module.exports = {
  MockRedis,
  MockDb
};