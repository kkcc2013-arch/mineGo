/**
 * IntelligentRateLimiter 单元测试
 */

const { describe, it, beforeEach, expect } = require('vitest');
const IntelligentRateLimiter = require('../IntelligentRateLimiter');

// Mock dependencies
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    multi: jest.fn().mockReturnThis(),
    zremrangebyscore: jest.fn().mockReturnThis(),
    zcard: jest.fn().mockReturnThis(),
    zadd: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([
      [null, 0],
      [null, 5],
      [null, 1],
      [null, 1]
    ]),
    lpush: jest.fn().mockResolvedValue(1),
    ltrim: jest.fn().mockResolvedValue('OK'),
    llen: jest.fn().mockResolvedValue(0),
    keys: jest.fn().mockResolvedValue([]),
    publish: jest.fn().mockResolvedValue(1)
  }));
});

jest.mock('../UserReputationScore', () => ({
  calculateReputation: jest.fn().mockResolvedValue({
    userId: '123',
    totalScore: 75,
    level: 'GOLD',
    multiplier: 1.3
  }),
  recordBehaviorEvent: jest.fn().mockResolvedValue(undefined)
}));

describe('IntelligentRateLimiter', () => {
  let limiter;
  
  beforeEach(() => {
    limiter = new IntelligentRateLimiter();
  });
  
  describe('checkLimit', () => {
    it('should return limit result with reputation and system load info', async () => {
      const result = await limiter.checkLimit('123', '/api/pokemon', 'GET');
      
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('current');
      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('remaining');
      expect(result).toHaveProperty('resetAt');
      expect(result).toHaveProperty('reputationLevel');
      expect(result).toHaveProperty('systemLoadLevel');
    });
    
    it('should use default limit for unknown endpoints', async () => {
      const result = await limiter.checkLimit('123', '/api/unknown', 'GET');
      
      expect(result.limit).toBeGreaterThan(0);
    });
  });
  
  describe('calculateDynamicLimit', () => {
    it('should calculate limit based on reputation and system load', () => {
      const baseMax = 100;
      const reputationMultiplier = 1.3;
      const systemMultiplier = 1.0;
      
      const result = limiter.calculateDynamicLimit(
        baseMax,
        reputationMultiplier,
        systemMultiplier,
        1,
        '123'
      );
      
      expect(result).toBe(Math.floor(baseMax * reputationMultiplier * systemMultiplier));
    });
    
    it('should apply boost multiplier', () => {
      const baseMax = 100;
      const reputationMultiplier = 1.0;
      const systemMultiplier = 1.0;
      const boost = 2.0;
      
      const result = limiter.calculateDynamicLimit(
        baseMax,
        reputationMultiplier,
        systemMultiplier,
        boost,
        '123'
      );
      
      expect(result).toBe(Math.floor(baseMax * boost));
    });
    
    it('should ensure minimum limit of 5', () => {
      const result = limiter.calculateDynamicLimit(10, 0.1, 0.1, 1, '123');
      
      expect(result).toBeGreaterThanOrEqual(5);
    });
  });
  
  describe('getSystemLoad', () => {
    it('should return system load with level and multiplier', async () => {
      const result = await limiter.getSystemLoad();
      
      expect(result).toHaveProperty('overall');
      expect(result).toHaveProperty('level');
      expect(result).toHaveProperty('multiplier');
      expect(result).toHaveProperty('details');
      expect(result.overall).toBeGreaterThanOrEqual(0);
      expect(result.overall).toBeLessThanOrEqual(1);
    });
    
    it('should return cached result if available', async () => {
      const cached = {
        overall: 0.5,
        level: 'low',
        multiplier: 1.2,
        details: { cpu: 0.3, memory: 0.4 }
      };
      
      limiter.redis.get = jest.fn().mockResolvedValue(JSON.stringify(cached));
      
      const result = await limiter.getSystemLoad();
      
      expect(result).toEqual(cached);
    });
  });
  
  describe('executeLimitCheck', () => {
    it('should allow request under limit', async () => {
      limiter.redis.exec = jest.fn().mockResolvedValue([
        [null, 0],
        [null, 5],  // current count
        [null, 1],
        [null, 1]
      ]);
      
      const result = await limiter.executeLimitCheck('123', 'GET /api/pokemon', 60000, 100);
      
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(6);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });
    
    it('should deny request over limit', async () => {
      limiter.redis.exec = jest.fn().mockResolvedValue([
        [null, 0],
        [null, 100],  // current count at limit
        [null, 1],
        [null, 1]
      ]);
      
      const result = await limiter.executeLimitCheck('123', 'GET /api/pokemon', 60000, 100);
      
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });
  
  describe('grantTemporaryBoost', () => {
    it('should grant boost and publish event', async () => {
      await limiter.grantTemporaryBoost('123', 2.0, 3600, 'Event bonus');
      
      expect(limiter.redis.setex).toHaveBeenCalled();
      expect(limiter.redis.publish).toHaveBeenCalled();
    });
  });
  
  describe('getQuotaStatus', () => {
    it('should return quota status for all endpoints', async () => {
      const result = await limiter.getQuotaStatus('123');
      
      expect(result).toHaveProperty('userId', '123');
      expect(result).toHaveProperty('reputation');
      expect(result).toHaveProperty('systemLoad');
      expect(result).toHaveProperty('quotas');
    });
  });
  
  describe('BASE_LIMITS', () => {
    it('should have limits for key endpoints', () => {
      expect(limiter.BASE_LIMITS).toHaveProperty('GET /api/pokemon');
      expect(limiter.BASE_LIMITS).toHaveProperty('POST /api/catch');
      expect(limiter.BASE_LIMITS).toHaveProperty('POST /api/gym/battle');
      expect(limiter.BASE_LIMITS).toHaveProperty('default');
    });
    
    it('should have reasonable default limits', () => {
      const defaultLimit = limiter.BASE_LIMITS.default;
      expect(defaultLimit.window).toBeGreaterThan(0);
      expect(defaultLimit.max).toBeGreaterThan(0);
    });
  });
  
  describe('SYSTEM_LOAD thresholds', () => {
    it('should have decreasing multipliers for higher load', () => {
      const levels = limiter.SYSTEM_LOAD;
      
      expect(levels.low.multiplier).toBeGreaterThan(levels.medium.multiplier);
      expect(levels.medium.multiplier).toBeGreaterThan(levels.high.multiplier);
      expect(levels.high.multiplier).toBeGreaterThan(levels.critical.multiplier);
    });
  });
});
