'use strict';

/**
 * REQ-00584 单元测试
 * API 超时策略标准化与分级超时治理系统
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { TimeoutPolicyManager, TIMEOUT_LEVELS } = require('../../shared/TimeoutPolicyManager');

// Mock Redis
const mockRedis = {
  data: new Map(),
  get: async (key) => mockRedis.data.get(key) || null,
  set: async (key, value, ...args) => { mockRedis.data.set(key, value); return 'OK'; },
  del: async (key) => { mockRedis.data.delete(key); return 1; },
  keys: async (pattern) => {
    const prefix = pattern.replace('*', '');
    return Array.from(mockRedis.data.keys()).filter(k => k.startsWith(prefix));
  },
  quit: async () => {}
};

describe('TimeoutPolicyManager', () => {
  let manager;
  
  beforeEach(() => {
    mockRedis.data.clear();
    manager = new TimeoutPolicyManager({ redis: mockRedis });
  });
  
  afterEach(() => {
    manager.policies.clear();
    manager.routePatternCache.clear();
  });
  
  describe('register()', () => {
    it('should register a route policy with L1 level', () => {
      manager.register('GET /api/v2/users/:id', 'L1');
      
      const policy = manager.policies.get('GET /api/v2/users/:id');
      expect(policy).to.exist;
      expect(policy.level).to.equal('L1');
      expect(policy.defaultMs).to.equal(TIMEOUT_LEVELS.L1_FAST_READ.defaultMs);
    });
    
    it('should throw error for invalid level', () => {
      expect(() => manager.register('GET /test', 'L5')).to.throw('Invalid timeout level');
    });
    
    it('should accept custom timeout values', () => {
      manager.register('GET /api/v2/custom', 'L2', { defaultMs: 8000 });
      
      const policy = manager.policies.get('GET /api/v2/custom');
      expect(policy.defaultMs).to.equal(8000);
    });
  });
  
  describe('getTimeout()', () => {
    it('should return exact match policy', () => {
      manager.register('GET /api/v2/users/:id', 'L1');
      
      const policy = manager.getTimeout('/api/v2/users/:id', 'GET');
      expect(policy.level).to.equal('L1');
    });
    
    it('should match route pattern with parameters', () => {
      manager.register('GET /api/v2/users/:id', 'L1');
      
      const policy = manager.getTimeout('/api/v2/users/123', 'GET');
      expect(policy.level).to.equal('L1');
    });
    
    it('should return L2 default for unmatched routes', () => {
      const policy = manager.getTimeout('/api/v2/unknown', 'GET');
      expect(policy.level).to.equal('L2');
    });
  });
  
  describe('negotiateTimeout()', () => {
    beforeEach(() => {
      manager.register('GET /api/v2/users/:id', 'L1');
    });
    
    it('should return default when no client timeout', () => {
      const result = manager.negotiateTimeout('/api/v2/users/:id', 'GET', null);
      
      expect(result.negotiated).to.be.false;
      expect(result.result).to.equal('default');
      expect(result.effectiveTimeout).to.equal(TIMEOUT_LEVELS.L1_FAST_READ.defaultMs);
    });
    
    it('should accept client timeout within range', () => {
      const result = manager.negotiateTimeout('/api/v2/users/:id', 'GET', 4000);
      
      expect(result.negotiated).to.be.true;
      expect(result.result).to.equal('accepted');
      expect(result.effectiveTimeout).to.equal(4000);
    });
    
    it('should cap client timeout exceeding max', () => {
      const result = manager.negotiateTimeout('/api/v2/users/:id', 'GET', 10000);
      
      expect(result.negotiated).to.be.true;
      expect(result.result).to.equal('capped');
      expect(result.effectiveTimeout).to.equal(TIMEOUT_LEVELS.L1_FAST_READ.maxMs);
    });
    
    it('should reject client timeout below min', () => {
      const result = manager.negotiateTimeout('/api/v2/users/:id', 'GET', 100);
      
      expect(result.negotiated).to.be.true;
      expect(result.result).to.equal('rejected');
      expect(result.effectiveTimeout).to.equal(TIMEOUT_LEVELS.L1_FAST_READ.minMs);
    });
  });
  
  describe('updateTimeout()', () => {
    beforeEach(() => {
      manager.register('GET /api/v2/users/:id', 'L2');
    });
    
    it('should update existing policy timeout', async () => {
      await manager.updateTimeout('GET /api/v2/users/:id', 12000);
      
      const policy = manager.policies.get('GET /api/v2/users/:id');
      expect(policy.defaultMs).to.equal(12000);
    });
    
    it('should throw error for out of range timeout', async () => {
      try {
        await manager.updateTimeout('GET /api/v2/users/:id', 1);
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('out of range');
      }
    });
    
    it('should create new policy for unknown route', async () => {
      await manager.updateTimeout('GET /api/v2/new', 8000);
      
      const policy = manager.policies.get('GET /api/v2/new');
      expect(policy).to.exist;
      expect(policy.defaultMs).to.equal(8000);
    });
  });
  
  describe('matchRoute()', () => {
    it('should match routes with parameters', () => {
      expect(manager.matchRoute('GET /api/v2/users/:id', 'GET /api/v2/users/123')).to.be.true;
      expect(manager.matchRoute('GET /api/v2/users/:id', 'GET /api/v2/users/abc')).to.be.true;
    });
    
    it('should not match different methods', () => {
      expect(manager.matchRoute('GET /api/v2/users/:id', 'POST /api/v2/users/123')).to.be.false;
    });
    
    it('should not match different paths', () => {
      expect(manager.matchRoute('GET /api/v2/users/:id', 'GET /api/v2/items/123')).to.be.false;
    });
  });
  
  describe('getStats()', () => {
    it('should return correct statistics', () => {
      manager.register('GET /api/v2/users/:id', 'L1');
      manager.register('POST /api/v2/catch', 'L2');
      manager.register('GET /api/v2/pokemon', 'L3');
      
      const stats = manager.getStats();
      
      expect(stats.total).to.equal(3);
      expect(stats.byLevel.L1).to.equal(1);
      expect(stats.byLevel.L2).to.equal(1);
      expect(stats.byLevel.L3).to.equal(1);
    });
  });
  
  describe('deletePolicy()', () => {
    it('should delete existing policy', async () => {
      manager.register('GET /api/v2/test', 'L1');
      
      const deleted = await manager.deletePolicy('GET /api/v2/test');
      
      expect(deleted).to.be.true;
      expect(manager.policies.has('GET /api/v2/test')).to.be.false;
    });
    
    it('should return false for non-existing policy', async () => {
      const deleted = await manager.deletePolicy('GET /api/v2/unknown');
      expect(deleted).to.be.false;
    });
  });
});

describe('TIMEOUT_LEVELS', () => {
  it('should have four levels defined', () => {
    expect(TIMEOUT_LEVELS.L1_FAST_READ).to.exist;
    expect(TIMEOUT_LEVELS.L2_STANDARD_WRITE).to.exist;
    expect(TIMEOUT_LEVELS.L3_BATCH_OPERATION).to.exist;
    expect(TIMEOUT_LEVELS.L4_STREAMING).to.exist;
  });
  
  it('should have correct hierarchy', () => {
    expect(TIMEOUT_LEVELS.L1_FAST_READ.defaultMs).to.be.lessThan(TIMEOUT_LEVELS.L2_STANDARD_WRITE.defaultMs);
    expect(TIMEOUT_LEVELS.L2_STANDARD_WRITE.defaultMs).to.be.lessThan(TIMEOUT_LEVELS.L3_BATCH_OPERATION.defaultMs);
    expect(TIMEOUT_LEVELS.L3_BATCH_OPERATION.defaultMs).to.be.lessThan(TIMEOUT_LEVELS.L4_STREAMING.defaultMs);
  });
});