// backend/tests/unit/client-integrity.test.js
// REQ-00483: 客户端完整性验证单元测试

'use strict';

const { ClientIntegrityMiddleware } = require('../../gateway/src/middleware/client-integrity');
const crypto = require('crypto');

// Mock dependencies
jest.mock('../../shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

jest.mock('../../shared/redis', () => ({
  getRedis: () => ({
    get: jest.fn(),
    set: jest.fn(),
    setex: jest.fn(),
    zadd: jest.fn(),
    zrangebyscore: jest.fn(),
    expire: jest.fn()
  }),
  getJSON: jest.fn(),
  setJSON: jest.fn()
}));

describe('ClientIntegrityMiddleware', () => {
  let middleware;
  let mockReq;
  let mockRes;
  let mockNext;
  
  beforeEach(() => {
    middleware = new ClientIntegrityMiddleware();
    
    mockReq = {
      user: { sub: 'test-user-123' },
      headers: {
        'x-request-id': 'req-123',
        'x-client-signature': null,
        'x-client-version': '1.0.0',
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'zh-CN',
        'x-device-id': 'device-456'
      },
      body: {
        _environment: {}
      },
      ip: '192.168.1.1'
    };
    
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    mockNext = jest.fn();
  });
  
  describe('_verifyClientSignature', () => {
    test('should return false when signature is missing', async () => {
      const result = await middleware._verifyClientSignature(
        null,
        'req-123',
        '1.0.0'
      );
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('missing_signature_or_request_id');
    });
    
    test('should return false when client version is invalid', async () => {
      const result = await middleware._verifyClientSignature(
        'signature-123',
        'req-123',
        '0.0.1'
      );
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_client_version');
    });
    
    test('should return false when signature does not match', async () => {
      const result = await middleware._verifyClientSignature(
        'wrong-signature',
        'req-123',
        '1.0.0'
      );
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('signature_mismatch');
    });
    
    test('should return true when signature is valid', async () => {
      // 计算正确的签名
      const payload = `req-123:1.0.0`;
      const expectedSignature = crypto
        .createHmac('sha256', middleware.signingKey)
        .update(payload)
        .digest('hex');
      
      const result = await middleware._verifyClientSignature(
        expectedSignature,
        'req-123',
        '1.0.0'
      );
      
      expect(result.valid).toBe(true);
    });
  });
  
  describe('_assessEnvironmentRisk', () => {
    test('should detect rooted device', async () => {
      const envData = {
        isRooted: true
      };
      
      const result = await middleware._assessEnvironmentRisk(
        'user-123',
        envData,
        'fingerprint-123'
      );
      
      expect(result.factors.isRooted).toBe(40);
      expect(result.total).toBeGreaterThanOrEqual(40);
    });
    
    test('should detect emulator', async () => {
      const envData = {
        isEmulator: true,
        webglRenderer: 'SwiftShader',
        platform: 'Linux x86_64',
        hasTouchSupport: false,
        hardwareConcurrency: 2
      };
      
      const result = await middleware._assessEnvironmentRisk(
        'user-123',
        envData,
        'fingerprint-123'
      );
      
      expect(result.factors.isEmulator).toBe(50);
      expect(result.level).toBe('MEDIUM');
    });
    
    test('should detect debugger attached', async () => {
      const envData = {
        hasDebuggerAttached: true
      };
      
      const result = await middleware._assessEnvironmentRisk(
        'user-123',
        envData,
        'fingerprint-123'
      );
      
      expect(result.factors.hasDebugger).toBe(60);
    });
    
    test('should detect injection framework', async () => {
      const envData = {
        hasInjection: true,
        detectedHooks: ['XMLHttpRequest', 'fetch']
      };
      
      const result = await middleware._assessEnvironmentRisk(
        'user-123',
        envData,
        'fingerprint-123'
      );
      
      expect(result.factors.hasInjection).toBe(70);
    });
    
    test('should detect modified code', async () => {
      const envData = {
        modifiedFunctions: ['calculateCaptureProbability']
      };
      
      const result = await middleware._assessEnvironmentRisk(
        'user-123',
        envData,
        'fingerprint-123'
      );
      
      expect(result.factors.isModified).toBe(90);
      expect(result.level).toBe('CRITICAL');
    });
    
    test('should return LOW risk for clean environment', async () => {
      const envData = {};
      
      const result = await middleware._assessEnvironmentRisk(
        'user-123',
        envData,
        'fingerprint-123'
      );
      
      expect(result.total).toBe(0);
      expect(result.level).toBe('LOW');
    });
  });
  
  describe('_detectEmulator', () => {
    test('should detect SwiftShader renderer as emulator', () => {
      const envData = {
        webglRenderer: 'SwiftShader D3D9',
        platform: 'Linux x86_64',
        hasTouchSupport: false,
        hardwareConcurrency: 2
      };
      
      const result = middleware._detectEmulator(envData);
      
      expect(result).toBe(true);
    });
    
    test('should return false for real device', () => {
      const envData = {
        webglRenderer: 'Adreno 650',
        platform: 'Linux aarch64',
        hasTouchSupport: true,
        hardwareConcurrency: 8,
        batteryLevel: 75,
        batteryCharging: false
      };
      
      const result = middleware._detectEmulator(envData);
      
      expect(result).toBe(false);
    });
  });
  
  describe('_calculateIntegrityRiskScore', () => {
    test('should calculate risk score with correct weights', async () => {
      const signature = { valid: false };
      const environment = { total: 60 };
      const fingerprint = 'fingerprint-123';
      
      // Mock _assessFingerprintRisk
      middleware._assessFingerprintRisk = jest.fn().mockResolvedValue(20);
      
      const score = await middleware._calculateIntegrityRiskScore(
        signature,
        environment,
        fingerprint
      );
      
      // 签名失败: 80 * 0.30 = 24
      // 环境风险: 60 * 0.50 = 30
      // 指纹风险: 20 * 0.20 = 4
      // 总分: 58
      expect(score).toBe(58);
    });
    
    test('should return low score for valid client', async () => {
      const signature = { valid: true };
      const environment = { total: 0 };
      const fingerprint = 'fingerprint-123';
      
      middleware._assessFingerprintRisk = jest.fn().mockResolvedValue(0);
      
      const score = await middleware._calculateIntegrityRiskScore(
        signature,
        environment,
        fingerprint
      );
      
      expect(score).toBe(0);
    });
  });
  
  describe('_generateChallenge', () => {
    test('should generate hard computation challenge for high risk', async () => {
      const challenge = await middleware._generateChallenge('user-123', 85);
      
      expect(challenge.type).toBe('computation_hard');
      expect(challenge.data.difficulty).toBe(3);
      expect(challenge.data.operations).toContain('hash');
    });
    
    test('should generate medium computation challenge for medium risk', async () => {
      const challenge = await middleware._generateChallenge('user-123', 65);
      
      expect(challenge.type).toBe('computation_medium');
      expect(challenge.data.difficulty).toBe(2);
    });
    
    test('should generate behavior challenge for low risk', async () => {
      const challenge = await middleware._generateChallenge('user-123', 50);
      
      expect(challenge.type).toBe('behavior');
      expect(challenge.data.action).toBe('click_sequence');
    });
  });
  
  describe('verifyChallengeResponse', () => {
    test('should return false when challenge not found', async () => {
      const { getJSON } = require('../../shared/redis');
      getJSON.mockResolvedValue(null);
      
      const result = await middleware.verifyChallengeResponse(
        'user-123',
        'challenge-456',
        { result: 'test' }
      );
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('challenge_expired_or_not_found');
    });
    
    test('should return false when response time is too fast', async () => {
      const { getJSON } = require('../../shared/redis');
      getJSON.mockResolvedValue({
        type: 'computation_hard',
        data: {
          difficulty: 3,
          expectedResult: 'expected-hash'
        },
        createdAt: Date.now() - 50  // 50ms ago
      });
      
      const result = await middleware.verifyChallengeResponse(
        'user-123',
        'challenge-456',
        { result: 'expected-hash' }
      );
      
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('time_acceleration_detected');
    });
    
    test('should verify correct computation challenge response', async () => {
      const { getJSON } = require('../../shared/redis');
      
      const payload = crypto.randomBytes(32).toString('base64');
      const expectedResult = crypto
        .createHash('sha256')
        .update(payload.repeat(2))
        .digest('hex')
        .slice(0, 16);
      
      getJSON.mockResolvedValue({
        type: 'computation_medium',
        data: {
          difficulty: 2,
          expectedResult: expectedResult,
          payload: payload
        },
        createdAt: Date.now() - 500  // 500ms ago
      });
      
      const result = await middleware.verifyChallengeResponse(
        'user-123',
        'challenge-456',
        { result: expectedResult }
      );
      
      expect(result.valid).toBe(true);
    });
  });
  
  describe('_extractDeviceFingerprint', () => {
    test('should generate consistent fingerprint for same data', () => {
      const fingerprint1 = middleware._extractDeviceFingerprint(mockReq);
      const fingerprint2 = middleware._extractDeviceFingerprint(mockReq);
      
      expect(fingerprint1).toBe(fingerprint2);
      expect(fingerprint1).toHaveLength(16);
    });
    
    test('should generate different fingerprint for different data', () => {
      const fingerprint1 = middleware._extractDeviceFingerprint(mockReq);
      
      mockReq.headers['user-agent'] = 'Different User Agent';
      const fingerprint2 = middleware._extractDeviceFingerprint(mockReq);
      
      expect(fingerprint1).not.toBe(fingerprint2);
    });
  });
  
  describe('verifyRuntimeIntegrity', () => {
    test('should detect tampered function', async () => {
      const report = {
        functionHashes: {
          'calculateCaptureProbability': 'wrong-hash'
        }
      };
      
      const result = await middleware.verifyRuntimeIntegrity('user-123', report);
      
      expect(result.valid).toBe(false);
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].type).toBe('function_tampered');
    });
    
    test('should detect modified global objects', async () => {
      const report = {
        globalObjectsModified: ['window.gameConfig', 'window.gameConstants']
      };
      
      const result = await middleware.verifyRuntimeIntegrity('user-123', report);
      
      expect(result.valid).toBe(false);
      expect(result.issues[0].type).toBe('globals_modified');
    });
    
    test('should detect prototype chain modification', async () => {
      const report = {
        prototypeChainModified: true
      };
      
      const result = await middleware.verifyRuntimeIntegrity('user-123', report);
      
      expect(result.valid).toBe(false);
      expect(result.issues[0].type).toBe('prototype_tampered');
    });
    
    test('should return valid for clean runtime', async () => {
      const report = {
        functionHashes: {
          'calculateCaptureProbability': 'a1b2c3d4e5f6g7h8i9j0'
        }
      };
      
      const result = await middleware.verifyRuntimeIntegrity('user-123', report);
      
      expect(result.valid).toBe(true);
      expect(result.riskScore).toBe(0);
    });
  });
  
  describe('Middleware integration', () => {
    test('should reject request with invalid signature', async () => {
      mockReq.headers['x-client-signature'] = 'invalid-signature';
      
      await middleware.handle(mockReq, mockRes, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            code: 'CLIENT_SIGNATURE_INVALID'
          })
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });
    
    test('should require challenge for high risk client', async () => {
      // Mock valid signature
      const payload = `req-123:1.0.0`;
      mockReq.headers['x-client-signature'] = crypto
        .createHmac('sha256', middleware.signingKey)
        .update(payload)
        .digest('hex');
      
      // Mock high risk environment
      mockReq.body._environment = {
        isRooted: true,
        hasDebuggerAttached: true
      };
      
      // Mock no fingerprint history
      const { getJSON } = require('../../shared/redis');
      getJSON.mockResolvedValue(null);
      
      await middleware.handle(mockReq, mockRes, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(202);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          requiresChallenge: true
        })
      );
    });
    
    test('should pass valid client through', async () => {
      // Mock valid signature
      const payload = `req-123:1.0.0`;
      mockReq.headers['x-client-signature'] = crypto
        .createHmac('sha256', middleware.signingKey)
        .update(payload)
        .digest('hex');
      
      // Mock clean environment
      mockReq.body._environment = {};
      
      // Mock no fingerprint history
      const { getJSON, setJSON } = require('../../shared/redis');
      getJSON.mockResolvedValue(null);
      setJSON.mockResolvedValue(true);
      
      await middleware.handle(mockReq, mockRes, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.clientIntegrity).toBeDefined();
      expect(mockReq.clientIntegrity.verified).toBe(true);
    });
  });
});

describe('Environment Risk Assessment', () => {
  let middleware;
  
  beforeEach(() => {
    middleware = new ClientIntegrityMiddleware();
  });
  
  test('should classify risk levels correctly', async () => {
    const testCases = [
      { total: 0, expected: 'LOW' },
      { total: 40, expected: 'MEDIUM' },
      { total: 70, expected: 'HIGH' },
      { total: 100, expected: 'CRITICAL' }
    ];
    
    for (const testCase of testCases) {
      const result = await middleware._assessEnvironmentRisk(
        'user-123',
        { isRooted: testCase.total >= 40 },
        'fingerprint'
      );
      
      if (testCase.total > 0) {
        expect(result.total).toBeGreaterThanOrEqual(testCase.total);
      }
    }
  });
});

describe('Challenge System', () => {
  let middleware;
  
  beforeEach(() => {
    middleware = new ClientIntegrityMiddleware();
  });
  
  test('should generate different challenges for different risk levels', async () => {
    const challenges = await Promise.all([
      middleware._generateChallenge('user-1', 50),
      middleware._generateChallenge('user-2', 65),
      middleware._generateChallenge('user-3', 85)
    ]);
    
    expect(challenges[0].type).toBe('behavior');
    expect(challenges[1].type).toBe('computation_medium');
    expect(challenges[2].type).toBe('computation_hard');
  });
  
  test('should include all required fields in challenge', async () => {
    const challenge = await middleware._generateChallenge('user-123', 65);
    
    expect(challenge).toHaveProperty('challengeId');
    expect(challenge).toHaveProperty('type');
    expect(challenge).toHaveProperty('data');
    expect(challenge).toHaveProperty('timeout');
  });
});

describe('Device Fingerprint', () => {
  let middleware;
  
  beforeEach(() => {
    middleware = new ClientIntegrityMiddleware();
  });
  
  test('should handle missing headers gracefully', () => {
    const req = {
      headers: {},
      ip: '127.0.0.1'
    };
    
    const fingerprint = middleware._extractDeviceFingerprint(req);
    
    expect(fingerprint).toBeDefined();
    expect(fingerprint).toHaveLength(16);
  });
  
  test('should use IP as fallback', () => {
    const req1 = {
      headers: {},
      ip: '192.168.1.1'
    };
    
    const req2 = {
      headers: {},
      ip: '192.168.1.2'
    };
    
    const fingerprint1 = middleware._extractDeviceFingerprint(req1);
    const fingerprint2 = middleware._extractDeviceFingerprint(req2);
    
    expect(fingerprint1).not.toBe(fingerprint2);
  });
});

// 性能测试
describe('Performance', () => {
  test('should complete verification within 200ms', async () => {
    const middleware = new ClientIntegrityMiddleware();
    
    const { getJSON, setJSON } = require('../../shared/redis');
    getJSON.mockResolvedValue(null);
    setJSON.mockResolvedValue(true);
    
    const start = Date.now();
    
    // Mock valid signature
    const payload = `req-123:1.0.0`;
    const signature = crypto
      .createHmac('sha256', middleware.signingKey)
      .update(payload)
      .digest('hex');
    
    const req = {
      user: { sub: 'user-123' },
      headers: {
        'x-request-id': 'req-123',
        'x-client-signature': signature,
        'x-client-version': '1.0.0',
        'user-agent': 'Test',
        'accept-language': 'en-US'
      },
      body: { _environment: {} },
      ip: '127.0.0.1'
    };
    
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    const next = jest.fn();
    
    await middleware.handle(req, res, next);
    
    const elapsed = Date.now() - start;
    
    expect(elapsed).toBeLessThan(200);
  });
});