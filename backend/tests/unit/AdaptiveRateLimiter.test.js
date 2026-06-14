// backend/tests/unit/AdaptiveRateLimiter.test.js
// REQ-00098: 自适应限流器单元测试

'use strict';

const { AdaptiveRateLimiter, UserQuotaManager } = require('../../shared/AdaptiveRateLimiter');
const { expect } = require('chai');
const sinon = require('sinon');

describe('AdaptiveRateLimiter', () => {
  let limiter;

  beforeEach(() => {
    limiter = new AdaptiveRateLimiter({
      checkIntervalMs: 1000,
      cooldownMs: 2000
    });
  });

  describe('calculateLoadScore', () => {
    it('should return 0 for low values', () => {
      const score = limiter.calculateLoadScore(30, { low: 50, medium: 70, high: 90 });
      expect(score).to.equal(0);
    });

    it('should return 20-50 for medium-low values', () => {
      const score = limiter.calculateLoadScore(60, { low: 50, medium: 70, high: 90 });
      expect(score).to.be.within(20, 50);
    });

    it('should return 50-80 for medium-high values', () => {
      const score = limiter.calculateLoadScore(80, { low: 50, medium: 70, high: 90 });
      expect(score).to.be.within(50, 80);
    });

    it('should return 80-100 for high values', () => {
      const score = limiter.calculateLoadScore(95, { low: 50, medium: 70, high: 90 });
      expect(score).to.be.within(80, 100);
    });
  });

  describe('adjustLimit', () => {
    it('should reduce factor for high load', async () => {
      const result = await limiter.adjustLimit({
        cpu: 95,
        memory: 90,
        avgResponseTime: 1200
      });

      expect(result.loadFactor).to.be.lessThan(1.0);
      expect(result.loadScore).to.be.greaterThan(80);
      expect(result.adjusted).to.be.true;
    });

    it('should maintain factor for normal load', async () => {
      const result = await limiter.adjustLimit({
        cpu: 60,
        memory: 65,
        avgResponseTime: 300
      });

      expect(result.loadFactor).to.equal(1.0);
      expect(result.loadScore).to.be.within(20, 60);
    });

    it('should increase factor for low load', async () => {
      const result = await limiter.adjustLimit({
        cpu: 20,
        memory: 30,
        avgResponseTime: 100
      });

      expect(result.loadFactor).to.be.greaterThan(1.0);
      expect(result.loadScore).to.be.lessThan(20);
    });

    it('should not adjust during cooldown period', async () => {
      // 第一次调整
      await limiter.adjustLimit({
        cpu: 95,
        memory: 90,
        avgResponseTime: 1200
      });

      // 冷却期内再次调整
      const result = await limiter.adjustLimit({
        cpu: 20,
        memory: 30,
        avgResponseTime: 100
      });

      expect(result.adjusted).to.be.false;
      expect(result.reason).to.equal('cooldown');
    });

    it('should limit factor to min and max bounds', async () => {
      // 测试最小边界
      await limiter.adjustLimit({ cpu: 99, memory: 99, avgResponseTime: 2000 });
      expect(limiter.currentLoadFactor).to.be.at.least(0.3);

      // 等待冷却期
      await new Promise(resolve => setTimeout(resolve, 2500));

      // 测试最大边界
      await limiter.adjustLimit({ cpu: 10, memory: 20, avgResponseTime: 50 });
      expect(limiter.currentLoadFactor).to.be.at.most(1.5);
    });
  });

  describe('matchApiPattern', () => {
    it('should match exact path', () => {
      limiter.tierConfigs.set('/api/v2/payment/charge', {
        tier: 'critical',
        baseLimit: 10,
        burstLimit: 15
      });

      const config = limiter.matchApiPattern('/api/v2/payment/charge');
      expect(config.tier).to.equal('critical');
    });

    it('should match wildcard pattern', () => {
      limiter.tierConfigs.set('/api/v2/payment/*', {
        tier: 'critical',
        baseLimit: 10,
        burstLimit: 15
      });

      const config = limiter.matchApiPattern('/api/v2/payment/refund');
      expect(config.tier).to.equal('critical');
    });

    it('should return default for unmatched path', () => {
      const config = limiter.matchApiPattern('/api/v2/unknown/endpoint');
      expect(config.tier).to.equal('normal');
    });
  });

  describe('setLoadFactor', () => {
    it('should manually set load factor', () => {
      const result = limiter.setLoadFactor(0.5, 'manual test');
      expect(result.newFactor).to.equal(0.5);
      expect(limiter.currentLoadFactor).to.equal(0.5);
    });

    it('should clamp factor to bounds', () => {
      limiter.setLoadFactor(0.1, 'too low');
      expect(limiter.currentLoadFactor).to.equal(0.3);

      limiter.setLoadFactor(2.0, 'too high');
      expect(limiter.currentLoadFactor).to.equal(1.5);
    });
  });

  describe('getStatus', () => {
    it('should return current status', () => {
      const status = limiter.getStatus();
      expect(status).to.have.property('loadFactor');
      expect(status).to.have.property('loadScore');
      expect(status).to.have.property('thresholds');
    });
  });
});

describe('UserQuotaManager', () => {
  let manager;

  beforeEach(() => {
    manager = new UserQuotaManager();
  });

  describe('parseDuration', () => {
    it('should parse days', () => {
      const ms = manager.parseDuration('7d');
      expect(ms).to.equal(7 * 24 * 60 * 60 * 1000);
    });

    it('should parse hours', () => {
      const ms = manager.parseDuration('24h');
      expect(ms).to.equal(24 * 60 * 60 * 1000);
    });

    it('should parse minutes', () => {
      const ms = manager.parseDuration('30m');
      expect(ms).to.equal(30 * 60 * 1000);
    });

    it('should return default for invalid format', () => {
      const ms = manager.parseDuration('invalid');
      expect(ms).to.equal(24 * 60 * 60 * 1000); // 默认 1 天
    });
  });

  describe('formatDuration', () => {
    it('should format hours and minutes', () => {
      const formatted = manager.formatDuration(2 * 60 * 60 * 1000 + 30 * 60 * 1000);
      expect(formatted).to.equal('2h 30m');
    });

    it('should format minutes and seconds', () => {
      const formatted = manager.formatDuration(5 * 60 * 1000 + 30 * 1000);
      expect(formatted).to.equal('5m 30s');
    });

    it('should format only seconds', () => {
      const formatted = manager.formatDuration(45 * 1000);
      expect(formatted).to.equal('45s');
    });
  });
});

describe('AdaptiveRateLimiter Integration', () => {
  it('should correctly calculate effective limit with load factor', () => {
    const limiter = new AdaptiveRateLimiter();
    limiter.currentLoadFactor = 0.5;

    const baseLimit = 100;
    const effectiveLimit = Math.floor(baseLimit * limiter.currentLoadFactor);
    expect(effectiveLimit).to.equal(50);
  });

  it('should prioritize critical APIs', () => {
    const limiter = new AdaptiveRateLimiter();
    limiter.tierConfigs.set('/api/v2/payment/*', {
      tier: 'critical',
      baseLimit: 10,
      burstLimit: 15
    });
    limiter.tierConfigs.set('/api/v2/location/*', {
      tier: 'normal',
      baseLimit: 120,
      burstLimit: 200
    });

    const paymentConfig = limiter.matchApiPattern('/api/v2/payment/charge');
    const locationConfig = limiter.matchApiPattern('/api/v2/location/nearby');

    expect(paymentConfig.baseLimit).to.be.lessThan(locationConfig.baseLimit);
    expect(paymentConfig.tier).to.equal('critical');
    expect(locationConfig.tier).to.equal('normal');
  });
});
