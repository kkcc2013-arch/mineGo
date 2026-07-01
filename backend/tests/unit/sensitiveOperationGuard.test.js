// backend/tests/unit/sensitiveOperationGuard.test.js
'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const RiskEvaluator = require('../../shared/RiskEvaluator');
const { SensitiveOperationGuard } = require('../../shared/SensitiveOperationGuard');

// Mock Redis
const mockRedis = {
  get: sinon.stub(),
  set: sinon.stub(),
  setex: sinon.stub(),
  lpush: sinon.stub(),
  lrange: sinon.stub(),
  ltrim: sinon.stub(),
  expire: sinon.stub(),
  sadd: sinon.stub(),
  smembers: sinon.stub(),
  zadd: sinon.stub(),
  zrangebyscore: sinon.stub(),
  zremrangebyscore: sinon.stub(),
  hincrby: sinon.stub()
};

// Mock database
sinon.stub(require('../../shared/database'), 'redis').value(mockRedis);

describe('RiskEvaluator', () => {
  let riskEvaluator;

  beforeEach(() => {
    riskEvaluator = new RiskEvaluator();
    sinon.resetHistory();
  });

  describe('getOperationRisk', () => {
    it('should return risk config for known operations', () => {
      const paymentRisk = riskEvaluator.getOperationRisk('payment.purchase');
      expect(paymentRisk).to.exist;
      expect(paymentRisk.level).to.equal('critical');
      expect(paymentRisk.weight).to.equal(100);
    });

    it('should return null for unknown operations', () => {
      const unknownRisk = riskEvaluator.getOperationRisk('unknown.operation');
      expect(unknownRisk).to.be.null;
    });
  });

  describe('evaluateDeviceTrust', () => {
    it('should return high risk for missing device', async () => {
      const result = await riskEvaluator.evaluateDeviceTrust('user1', null);
      expect(result.score).to.be.greaterThan(50);
      expect(result.risk).to.equal('high');
    });

    it('should return medium risk for new device', async () => {
      mockRedis.get.resolves(null);
      
      const result = await riskEvaluator.evaluateDeviceTrust('user1', 'device1');
      expect(result.score).to.equal(50);
      expect(result.risk).to.equal('medium');
    });

    it('should return low risk for trusted device', async () => {
      mockRedis.get.resolves(JSON.stringify({
        firstSeen: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        isTrusted: true,
        recentUsageCount: 20
      }));
      
      const result = await riskEvaluator.evaluateDeviceTrust('user1', 'device1');
      expect(result.score).to.be.lessThan(30);
      expect(result.risk).to.equal('low');
    });

    it('should return high risk for suspicious device', async () => {
      mockRedis.get.resolves(JSON.stringify({
        isSuspicious: true,
        fingerprintMismatch: true,
        isRooted: true
      }));
      
      const result = await riskEvaluator.evaluateDeviceTrust('user1', 'device1');
      expect(result.score).to.be.greaterThan(50);
      expect(result.risk).to.equal('high');
    });
  });

  describe('evaluateLocationRisk', () => {
    it('should return medium risk for missing location', async () => {
      const result = await riskEvaluator.evaluateLocationRisk('user1', null);
      expect(result.score).to.equal(50);
      expect(result.risk).to.equal('medium');
    });

    it('should return low risk for first location', async () => {
      mockRedis.get.resolves(null);
      mockRedis.setex.resolves('OK');
      
      const result = await riskEvaluator.evaluateLocationRisk('user1', {
        lat: 31.2304,
        lng: 121.4737
      });
      expect(result.score).to.be.lessThan(40);
      expect(result.risk).to.equal('low');
    });

    it('should return high risk for impossible travel', async () => {
      // Shanghai location
      mockRedis.get.resolves(JSON.stringify({
        lat: 31.2304,
        lng: 121.4737,
        timestamp: Date.now() - 1000 * 60 * 30 // 30 minutes ago
      }));
      
      // Beijing location (1000+ km away)
      const result = await riskEvaluator.evaluateLocationRisk('user1', {
        lat: 39.9042,
        lng: 116.4074
      });
      expect(result.score).to.be.greaterThan(50);
      expect(result.risk).to.equal('high');
    });

    it('should return low risk for normal movement', async () => {
      mockRedis.get.resolves(JSON.stringify({
        lat: 31.2304,
        lng: 121.4737,
        timestamp: Date.now() - 1000 * 60 * 60 // 1 hour ago
      }));
      
      // Near Shanghai (within normal speed)
      const result = await riskEvaluator.evaluateLocationRisk('user1', {
        lat: 31.2400,
        lng: 121.4800
      });
      expect(result.score).to.be.lessThan(20);
      expect(result.risk).to.equal('low');
    });
  });

  describe('evaluateIpRisk', () => {
    it('should return medium risk for missing IP', async () => {
      const result = await riskEvaluator.evaluateIpRisk(null, 'user1');
      expect(result.score).to.equal(50);
      expect(result.risk).to.equal('medium');
    });

    it('should add risk for new IP', async () => {
      mockRedis.smembers.resolves(['192.168.1.1']);
      mockRedis.sadd.resolves(1);
      mockRedis.get.resolves(null);
      
      const result = await riskEvaluator.evaluateIpRisk('192.168.1.2', 'user1');
      expect(result.score).to.be.greaterThan(20);
      expect(result.reason).to.include('新 IP');
    });

    it('should return high risk for VPN/Tor', async () => {
      mockRedis.smembers.resolves(['192.168.1.1']);
      mockRedis.get.resolves(JSON.stringify({
        isVpn: true,
        isTor: false
      }));
      
      const result = await riskEvaluator.evaluateIpRisk('192.168.1.1', 'user1');
      expect(result.score).to.be.greaterThan(30);
    });

    it('should return very high risk for blacklisted IP', async () => {
      mockRedis.smembers.resolves(['192.168.1.1']);
      mockRedis.get.resolves(JSON.stringify({
        isBlacklisted: true
      }));
      
      const result = await riskEvaluator.evaluateIpRisk('192.168.1.1', 'user1');
      expect(result.score).to.be.greaterThan(70);
    });
  });

  describe('evaluate', () => {
    it('should return complete evaluation for critical operation', async () => {
      mockRedis.get.resolves(null);
      mockRedis.setex.resolves('OK');
      mockRedis.lpush.resolves(1);
      mockRedis.lrange.resolves([]);
      mockRedis.smembers.resolves([]);
      mockRedis.sadd.resolves(1);
      
      const result = await riskEvaluator.evaluate({
        operation: 'payment.purchase',
        userId: 'user1',
        deviceId: 'device1',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0'
      });
      
      expect(result).to.have.property('level');
      expect(result).to.have.property('score');
      expect(result).to.have.property('factors');
      expect(result).to.have.property('recommendation');
      expect(result.operationRisk.level).to.equal('critical');
    });

    it('should accumulate risk from multiple factors', async () => {
      mockRedis.get.resolves(JSON.stringify({
        isSuspicious: true,
        firstSeen: Date.now() - 1000 // Very new
      }));
      mockRedis.lpush.resolves(1);
      mockRedis.lrange.resolves([]);
      mockRedis.smembers.resolves(['192.168.1.1']);
      mockRedis.get.onFirstCall().resolves(JSON.stringify({
        isSuspicious: true
      }));
      mockRedis.get.onSecondCall().resolves(null);
      mockRedis.get.onThirdCall().resolves(JSON.stringify({
        isVpn: true
      }));
      
      const result = await riskEvaluator.evaluate({
        operation: 'payment.purchase',
        userId: 'user1',
        deviceId: 'device1',
        ip: '192.168.1.2',
        userAgent: 'Mozilla/5.0'
      });
      
      expect(result.score).to.be.greaterThan(50);
    });
  });

  describe('determineRiskLevel', () => {
    it('should determine critical level correctly', () => {
      expect(riskEvaluator.determineRiskLevel(95)).to.equal('critical');
      expect(riskEvaluator.determineRiskLevel(90)).to.equal('critical');
    });

    it('should determine high level correctly', () => {
      expect(riskEvaluator.determineRiskLevel(85)).to.equal('high');
      expect(riskEvaluator.determineRiskLevel(80)).to.equal('high');
    });

    it('should determine medium level correctly', () => {
      expect(riskEvaluator.determineRiskLevel(70)).to.equal('medium');
      expect(riskEvaluator.determineRiskLevel(60)).to.equal('medium');
    });

    it('should determine low level correctly', () => {
      expect(riskEvaluator.determineRiskLevel(50)).to.equal('low');
      expect(riskEvaluator.determineRiskLevel(20)).to.equal('low');
    });
  });

  describe('calculateDistance', () => {
    it('should calculate distance between Shanghai and Beijing correctly', () => {
      const distance = riskEvaluator.calculateDistance(
        31.2304, 121.4737, // Shanghai
        39.9042, 116.4074  // Beijing
      );
      expect(distance).to.be.approximately(1068, 50); // ~1068 km
    });

    it('should return 0 for same location', () => {
      const distance = riskEvaluator.calculateDistance(
        31.2304, 121.4737,
        31.2304, 121.4737
      );
      expect(distance).to.be.approximately(0, 0.1);
    });
  });
});

describe('SensitiveOperationGuard', () => {
  let guard;

  beforeEach(() => {
    guard = new SensitiveOperationGuard();
    sinon.resetHistory();
  });

  describe('getOperationFromRequest', () => {
    it('should map payment purchase route', () => {
      const req = {
        method: 'POST',
        path: '/api/v1/payment/purchase'
      };
      const operation = guard.getOperationFromRequest(req);
      expect(operation).to.equal('payment.purchase');
    });

    it('should return null for non-sensitive route', () => {
      const req = {
        method: 'GET',
        path: '/api/v1/pokemon/list'
      };
      const operation = guard.getOperationFromRequest(req);
      expect(operation).to.be.null;
    });
  });

  describe('checkVerificationRequirement', () => {
    it('should require MFA for critical level', () => {
      const evaluation = { level: 'critical', score: 95 };
      const req = { headers: {} };
      
      const result = guard.checkVerificationRequirement(evaluation, req);
      expect(result.required).to.be.true;
      expect(result.requirements.mfa).to.be.true;
    });

    it('should require SMS for high level', () => {
      const evaluation = { level: 'high', score: 80 };
      const req = { headers: {} };
      
      const result = guard.checkVerificationRequirement(evaluation, req);
      expect(result.required).to.be.true;
      expect(result.requirements.sms).to.be.true;
    });

    it('should require captcha for medium level', () => {
      const evaluation = { level: 'medium', score: 60 };
      const req = { headers: {} };
      
      const result = guard.checkVerificationRequirement(evaluation, req);
      expect(result.required).to.be.true;
      expect(result.requirements.captcha).to.be.true;
    });

    it('should not require verification for low level', () => {
      const evaluation = { level: 'low', score: 20 };
      const req = { headers: {} };
      
      const result = guard.checkVerificationRequirement(evaluation, req);
      expect(result.required).to.be.false;
    });

    it('should pass if verification already provided', () => {
      const evaluation = { level: 'critical', score: 95 };
      const req = { headers: { 'x-verified-types': 'mfa' } };
      
      const result = guard.checkVerificationRequirement(evaluation, req);
      expect(result.required).to.be.false;
    });
  });

  describe('checkCooldown', () => {
    it('should return inCooldown true if recently executed', async () => {
      mockRedis.get.resolves(Date.now().toString());
      
      const result = await guard.checkCooldown('user1', 'payment.purchase');
      expect(result.inCooldown).to.be.true;
      expect(result).to.have.property('remainingTime');
    });

    it('should return inCooldown false if cooldown expired', async () => {
      mockRedis.get.resolves((Date.now() - 400000).toString()); // 400 seconds ago
      
      const result = await guard.checkCooldown('user1', 'payment.purchase');
      expect(result.inCooldown).to.be.false;
    });

    it('should return inCooldown false if no record', async () => {
      mockRedis.get.resolves(null);
      
      const result = await guard.checkCooldown('user1', 'payment.purchase');
      expect(result.inCooldown).to.be.false;
    });
  });

  describe('sanitizeBody', () => {
    it('should mask sensitive fields', () => {
      const body = {
        username: 'test',
        password: 'secret123',
        newPassword: 'newSecret',
        token: 'jwt-token'
      };
      
      const result = guard.sanitizeBody(body);
      expect(result.username).to.equal('test');
      expect(result.password).to.equal('***');
      expect(result.newPassword).to.equal('***');
      expect(result.token).to.equal('***');
    });
  });

  describe('registerRoute', () => {
    it('should register custom route', () => {
      guard.registerRoute('POST', '/api/v1/custom/action', 'custom.action');
      const operation = guard.getOperationFromRequest({
        method: 'POST',
        path: '/api/v1/custom/action'
      });
      expect(operation).to.equal('custom.action');
    });
  });
});
