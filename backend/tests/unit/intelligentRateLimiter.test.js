// backend/tests/unit/intelligentRateLimiter.test.js
// REQ-00367: 智能限流器单元测试

'use strict';

const { describe, it, beforeEach, afterEach, expect, mock } = require('test');
const { IntelligentRateLimiter, DefaultMetricsCollector } = require('../../shared/IntelligentRateLimiter');

// Mock Redis and DB
const mockRedis = {
  get: mock.fn(),
  setex: mock.fn(),
  incr: mock.fn(),
  expire: mock.fn(),
  info: mock.fn()
};

const mockQuery = mock.fn();

// Setup mocks
beforeEach(() => {
  mockRedis.get.mockReset();
  mockRedis.setex.mockReset();
  mockRedis.incr.mockReset();
  mockRedis.expire.mockReset();
  mockQuery.mockReset();
});

describe('IntelligentRateLimiter', () => {
  describe('calculateLoadLevel', () => {
    it('should return "low" when all metrics are below low thresholds', () => {
      const limiter = new IntelligentRateLimiter();

      const load = { cpu: 40, memory: 50, activeConnections: 400 };
      const level = limiter.calculateLoadLevel(load);

      expect(level).toBe('low');
    });

    it('should return "medium" when metrics are between low and medium thresholds', () => {
      const limiter = new IntelligentRateLimiter();

      const load = { cpu: 65, memory: 70, activeConnections: 800 };
      const level = limiter.calculateLoadLevel(load);

      expect(level).toBe('medium');
    });

    it('should return "high" when metrics exceed high thresholds', () => {
      const limiter = new IntelligentRateLimiter();

      const load = { cpu: 95, memory: 98, activeConnections: 2500 };
      const level = limiter.calculateLoadLevel(load);

      expect(level).toBe('high');
    });

    it('should calculate weighted average with correct weights', () => {
      const limiter = new IntelligentRateLimiter();

      // CPU weight = 0.4, Memory weight = 0.3, Connections weight = 0.3
      const load = { cpu: 60, memory: 60, activeConnections: 500 };
      const level = limiter.calculateLoadLevel(load);

      // All scores = 2 (medium), weighted avg = 2, so medium
      expect(level).toBe('medium');
    });
  });

  describe('getLoadScore', () => {
    it('should return 1 for values below low threshold', () => {
      const limiter = new IntelligentRateLimiter();
      const thresholds = { low: 50, medium: 75, high: 90 };

      const score = limiter.getLoadScore(40, thresholds);

      expect(score).toBe(1);
    });

    it('should return 2 for values between low and medium', () => {
      const limiter = new IntelligentRateLimiter();
      const thresholds = { low: 50, medium: 75, high: 90 };

      const score = limiter.getLoadScore(60, thresholds);

      expect(score).toBe(2);
    });

    it('should return 3 for values above medium threshold', () => {
      const limiter = new IntelligentRateLimiter();
      const thresholds = { low: 50, medium: 75, high: 90 };

      const score = limiter.getLoadScore(80, thresholds);

      expect(score).toBe(3);
    });
  });

  describe('calculateDynamicLimit', () => {
    it('should apply adjustment factor to base limit', async () => {
      const limiter = new IntelligentRateLimiter({
        redis: mockRedis
      });
      limiter.currentLoadLevel = 'medium';
      limiter.currentAdjustmentFactor = 1.0;
      limiter.tierConfigs.set('free', { minuteLimit: 20, priorityWeight: 1 });

      mockRedis.get.mockResolvedValue('free');

      const result = await limiter.calculateDynamicLimit('user1', '/api/test');

      expect(result.baseLimit).toBe(20);
      expect(result.dynamicLimit).toBe(20);
      expect(result.adjustmentFactor).toBe(1.0);
    });

    it('should increase limit during low load', async () => {
      const limiter = new IntelligentRateLimiter({
        redis: mockRedis
      });
      limiter.currentLoadLevel = 'low';
      limiter.currentAdjustmentFactor = 1.5;
      limiter.tierConfigs.set('free', { minuteLimit: 20, priorityWeight: 1 });

      mockRedis.get.mockResolvedValue('free');

      const result = await limiter.calculateDynamicLimit('user1', '/api/test');

      expect(result.dynamicLimit).toBe(30); // 20 * 1.5
    });

    it('should decrease limit during high load', async () => {
      const limiter = new IntelligentRateLimiter({
        redis: mockRedis
      });
      limiter.currentLoadLevel = 'high';
      limiter.currentAdjustmentFactor = 0.6;
      limiter.tierConfigs.set('free', { minuteLimit: 20, priorityWeight: 1 });

      mockRedis.get.mockResolvedValue('free');

      const result = await limiter.calculateDynamicLimit('user1', '/api/test');

      expect(result.dynamicLimit).toBe(12); // 20 * 0.6
    });
  });

  describe('checkRateLimit', () => {
    it('should allow requests below limit', async () => {
      const limiter = new IntelligentRateLimiter({
        redis: mockRedis
      });
      limiter.currentLoadLevel = 'medium';
      limiter.currentAdjustmentFactor = 1.0;
      limiter.tierConfigs.set('free', { minuteLimit: 20, priorityWeight: 1 });

      mockRedis.get.mockResolvedValue('free');
      mockRedis.incr.mockResolvedValue(5);

      const result = await limiter.checkRateLimit('user1', '/api/test', 'req1');

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(5);
      expect(result.remaining).toBe(15);
    });

    it('should deny requests above limit', async () => {
      const limiter = new IntelligentRateLimiter({
        redis: mockRedis
      });
      limiter.currentLoadLevel = 'medium';
      limiter.currentAdjustmentFactor = 1.0;
      limiter.tierConfigs.set('free', { minuteLimit: 20, priorityWeight: 1 });

      mockRedis.get.mockResolvedValue('free');
      mockRedis.incr.mockResolvedValue(25);

      const result = await limiter.checkRateLimit('user1', '/api/test', 'req1');

      expect(result.allowed).toBe(false);
      expect(result.current).toBe(25);
      expect(result.remaining).toBe(0);
    });

    it('should return fallback result on error', async () => {
      const limiter = new IntelligentRateLimiter({
        redis: mockRedis
      });
      limiter.tierConfigs.set('free', { minuteLimit: 20, priorityWeight: 1 });

      mockRedis.get.mockRejectedValue(new Error('Redis error'));
      mockRedis.incr.mockRejectedValue(new Error('Redis error'));

      const result = await limiter.checkRateLimit('user1', '/api/test', 'req1');

      expect(result.allowed).toBe(true); // Fallback allows request
      expect(result.error).toBe('Redis error');
    });
  });

  describe('getStatus', () => {
    it('should return current status', () => {
      const limiter = new IntelligentRateLimiter();
      limiter.currentLoadLevel = 'medium';
      limiter.currentAdjustmentFactor = 1.0;

      const status = limiter.getStatus();

      expect(status.loadLevel).toBe('medium');
      expect(status.adjustmentFactor).toBe(1.0);
    });
  });
});

describe('DefaultMetricsCollector', () => {
  describe('getSystemLoad', () => {
    it('should return system metrics', async () => {
      const collector = new DefaultMetricsCollector();

      const load = await collector.getSystemLoad();

      expect(load).toHaveProperty('cpu');
      expect(load).toHaveProperty('memory');
      expect(load).toHaveProperty('activeConnections');

      expect(typeof load.cpu).toBe('number');
      expect(typeof load.memory).toBe('number');
      expect(typeof load.activeConnections).toBe('number');
    });

    it('should return memory percentage', async () => {
      const collector = new DefaultMetricsCollector();

      const load = await collector.getSystemLoad();

      expect(load.memory).toBeGreaterThanOrEqual(0);
      expect(load.memory).toBeLessThanOrEqual(100);
    });
  });
});