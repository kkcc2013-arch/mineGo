// tests/CacheInvalidationSyncEngine.test.js
'use strict';

/**
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 * 单元测试
 */

const { describe, it, beforeEach, afterEach, expect, mock } = require('test');
const CacheInvalidationSyncEngine = require('../shared/CacheInvalidationSyncEngine');
const cache = require('../shared/cache');

describe('CacheInvalidationSyncEngine', () => {
  let syncEngine;
  let mockRedis;
  let mockCDCAdapter;
  
  beforeEach(() => {
    // Mock Redis 客户端
    mockRedis = {
      publish: mock.fn().resolves(),
      subscribe: mock.fn().resolves(),
      scan: mock.fn().resolves(['0', []]),
      quit: mock.fn().resolves()
    };
    
    // Mock CDC Adapter
    mockCDCAdapter = {
      start: mock.fn().resolves(),
      stop: mock.fn().resolves(),
      on: mock.fn(),
      getStats: mock.fn().returns({
        totalChanges: 0,
        insertCount: 0,
        updateCount: 0,
        deleteCount: 0
      })
    };
    
    // Mock cache
    mock.cache = {
      delete: mock.fn().resolves(),
      get: mock.fn().resolves(null),
      set: mock.fn().resolves()
    };
    
    // 创建同步引擎实例
    syncEngine = new CacheInvalidationSyncEngine({
      redis: { host: 'localhost', port: 6379 },
      invalidationChannel: 'test:cache:invalidation',
      enablePreload: false
    });
    
    // 替换依赖为 mock
    syncEngine.redisClient = mockRedis;
    syncEngine.redisSubscriber = mockRedis;
    syncEngine.cdcAdapter = mockCDCAdapter;
  });
  
  afterEach(() => {
    syncEngine = null;
  });
  
  describe('generateCacheKeys', () => {
    it('should generate correct cache keys for pokemon INSERT', () => {
      const table = 'pokemon';
      const operation = 'INSERT';
      const before = null;
      const after = { id: 123, user_id: 456, name: 'Pikachu' };
      const key = { id: 123 };
      const rules = CacheInvalidationSyncEngine.INVALIDATION_RULES.pokemon;
      
      const cacheKeys = syncEngine.generateCacheKeys(table, operation, before, after, key, rules);
      
      expect(cacheKeys).toContain('api:/pokemon/123');
      expect(cacheKeys).toContain('api:/pokemon/456/inventory');
      expect(cacheKeys).toContain('api:/pokemon/nearby:*');
    });
    
    it('should generate correct cache keys for users UPDATE', () => {
      const table = 'users';
      const operation = 'UPDATE';
      const before = { id: 789, name: 'OldName' };
      const after = { id: 789, name: 'NewName' };
      const key = { id: 789 };
      const rules = CacheInvalidationSyncEngine.INVALIDATION_RULES.users;
      
      const cacheKeys = syncEngine.generateCacheKeys(table, operation, before, after, key, rules);
      
      expect(cacheKeys).toContain('api:/users/789');
      expect(cacheKeys).toContain('api:/users/789/profile');
    });
    
    it('should generate correct cache keys for gyms DELETE', () => {
      const table = 'gyms';
      const operation = 'DELETE';
      const before = { id: 100, name: 'Gym1' };
      const after = null;
      const key = { id: 100 };
      const rules = CacheInvalidationSyncEngine.INVALIDATION_RULES.gyms;
      
      const cacheKeys = syncEngine.generateCacheKeys(table, operation, before, after, key, rules);
      
      expect(cacheKeys).toContain('api:/gyms/100');
      expect(cacheKeys).toContain('api:/gyms/nearby:*');
    });
  });
  
  describe('resolveParamValue', () => {
    it('should resolve simple param path', () => {
      const data = { after: { user_id: 123 } };
      const paramPath = 'after.user_id';
      
      const value = syncEngine.resolveParamValue(paramPath, data);
      
      expect(value).toBe(123);
    });
    
    it('should resolve nested param path', () => {
      const data = { before: { pokemon: { id: 456 } } };
      const paramPath = 'before.pokemon.id';
      
      const value = syncEngine.resolveParamValue(paramPath, data);
      
      expect(value).toBe(456);
    });
    
    it('should return null for missing param', () => {
      const data = { after: {} };
      const paramPath = 'after.user_id';
      
      const value = syncEngine.resolveParamValue(paramPath, data);
      
      expect(value).toBeNull();
    });
    
    it('should return null for invalid path', () => {
      const data = null;
      const paramPath = 'after.user_id';
      
      const value = syncEngine.resolveParamValue(paramPath, data);
      
      expect(value).toBeNull();
    });
  });
  
  describe('invalidateKeys', () => {
    it('should invalidate single cache key', async () => {
      const cacheKeys = ['api:/pokemon/123'];
      const table = 'pokemon';
      const operation = 'INSERT';
      
      await syncEngine.invalidateKeys(cacheKeys, table, operation);
      
      expect(cache.delete).toHaveBeenCalledWith('api:/pokemon/123');
      expect(mockRedis.publish).toHaveBeenCalled();
    });
    
    it('should invalidate multiple cache keys', async () => {
      const cacheKeys = ['api:/pokemon/123', 'api:/pokemon/456/inventory'];
      const table = 'pokemon';
      const operation = 'INSERT';
      
      await syncEngine.invalidateKeys(cacheKeys, table, operation);
      
      expect(cache.delete).toHaveBeenCalledTimes(2);
      expect(mockRedis.publish).toHaveBeenCalledTimes(2);
    });
    
    it('should broadcast invalidation message with correct format', async () => {
      const key = 'api:/pokemon/123';
      const table = 'pokemon';
      const operation = 'INSERT';
      
      await syncEngine.broadcastInvalidation(key, table, operation);
      
      const publishedMessage = JSON.parse(mockRedis.publish.mock.calls[0][1]);
      
      expect(publishedMessage.key).toBe('api:/pokemon/123');
      expect(publishedMessage.table).toBe('pokemon');
      expect(publishedMessage.operation).toBe('INSERT');
      expect(publishedMessage.timestamp).toBeDefined();
    });
  });
  
  describe('handleCDCEvent', () => {
    it('should handle INSERT event correctly', async () => {
      const event = {
        table: 'pokemon',
        operation: 'INSERT',
        before: null,
        after: { id: 123, user_id: 456 },
        key: { id: 123 },
        timestamp: new Date()
      };
      
      await syncEngine.handleCDCEvent(event);
      
      expect(syncEngine.stats.totalInvalidations).toBe(1);
      expect(syncEngine.stats.successCount).toBe(1);
    });
    
    it('should skip table without invalidation rules', async () => {
      const event = {
        table: 'unknown_table',
        operation: 'INSERT',
        before: null,
        after: { id: 123 },
        key: { id: 123 },
        timestamp: new Date()
      };
      
      await syncEngine.handleCDCEvent(event);
      
      expect(syncEngine.stats.totalInvalidations).toBe(0);
    });
    
    it('should skip operation not configured in rules', async () => {
      const event = {
        table: 'users', // users rules: ['UPDATE', 'DELETE']
        operation: 'INSERT',
        before: null,
        after: { id: 123 },
        key: { id: 123 },
        timestamp: new Date()
      };
      
      await syncEngine.handleCDCEvent(event);
      
      expect(syncEngine.stats.totalInvalidations).toBe(0);
    });
    
    it('should handle UPDATE event correctly', async () => {
      const event = {
        table: 'users',
        operation: 'UPDATE',
        before: { id: 789, name: 'OldName' },
        after: { id: 789, name: 'NewName' },
        key: { id: 789 },
        timestamp: new Date()
      };
      
      await syncEngine.handleCDCEvent(event);
      
      expect(syncEngine.stats.totalInvalidations).toBe(1);
      expect(syncEngine.stats.successCount).toBe(1);
    });
    
    it('should handle DELETE event correctly', async () => {
      const event = {
        table: 'gyms',
        operation: 'DELETE',
        before: { id: 100, name: 'Gym1' },
        after: null,
        key: { id: 100 },
        timestamp: new Date()
      };
      
      await syncEngine.handleCDCEvent(event);
      
      expect(syncEngine.stats.totalInvalidations).toBe(1);
    });
    
    it('should update failure count on error', async () => {
      // Mock cache.delete to throw error
      cache.delete.mock.rejectsOnce(new Error('Cache error'));
      
      const event = {
        table: 'pokemon',
        operation: 'INSERT',
        before: null,
        after: { id: 123 },
        key: { id: 123 },
        timestamp: new Date()
      };
      
      await syncEngine.handleCDCEvent(event);
      
      expect(syncEngine.stats.failureCount).toBe(1);
    });
  });
  
  describe('handleCascadeInvalidation', () => {
    it('should cascade invalidate related tables', async () => {
      mockRedis.scan.mock.resolves(['0', ['api:/pokemon/456/inventory']]);
      
      await syncEngine.handleCascadeInvalidation(['pokemon_inventory'], 'pokemon');
      
      expect(mockRedis.scan).toHaveBeenCalled();
      expect(cache.delete).toHaveBeenCalled();
      expect(syncEngine.stats.cascadeInvalidations).toBe(1);
    });
    
    it('should handle empty scan result', async () => {
      mockRedis.scan.mock.resolves(['0', []]);
      
      await syncEngine.handleCascadeInvalidation(['pokemon_inventory'], 'pokemon');
      
      expect(cache.delete).not.toHaveBeenCalled();
      expect(syncEngine.stats.cascadeInvalidations).toBe(1); // Still increments for tracking
    });
  });
  
  describe('hot key tracking', () => {
    it('should track key access count', () => {
      const key = 'api:/pokemon/123';
      
      syncEngine.trackKeyAccess(key);
      syncEngine.trackKeyAccess(key);
      
      expect(syncEngine.hotKeys.get(key)).toBe(2);
    });
    
    it('should mark key as hot after threshold', () => {
      const key = 'api:/pokemon/123';
      syncEngine.config.preloadThreshold = 5;
      
      for (let i = 0; i < 5; i++) {
        syncEngine.trackKeyAccess(key);
      }
      
      expect(syncEngine.hotKeys.has(key)).toBe(true);
      expect(syncEngine.hotKeys.get(key)).toBe(5);
    });
  });
  
  describe('getStats', () => {
    it('should return correct statistics', async () => {
      const event = {
        table: 'pokemon',
        operation: 'INSERT',
        before: null,
        after: { id: 123 },
        key: { id: 123 },
        timestamp: new Date()
      };
      
      await syncEngine.handleCDCEvent(event);
      
      const stats = syncEngine.getStats();
      
      expect(stats.totalInvalidations).toBe(1);
      expect(stats.successCount).toBe(1);
      expect(stats.failureCount).toBe(0);
      expect(stats.isRunning).toBeDefined();
    });
  });
});

describe('INVALIDATION_RULES', () => {
  it('should have rules for all core tables', () => {
    const { INVALIDATION_RULES } = require('../shared/CacheInvalidationSyncEngine');
    
    expect(INVALIDATION_RULES.pokemon).toBeDefined();
    expect(INVALIDATION_RULES.users).toBeDefined();
    expect(INVALIDATION_RULES.gyms).toBeDefined();
    expect(INVALIDATION_RULES.raid_battles).toBeDefined();
    expect(INVALIDATION_RULES.friendships).toBeDefined();
    expect(INVALIDATION_RULES.trades).toBeDefined();
    expect(INVALIDATION_RULES.achievements).toBeDefined();
    expect(INVALIDATION_RULES.quests).toBeDefined();
    expect(INVALIDATION_RULES.user_stats).toBeDefined();
  });
  
  it('should have correct operation configuration', () => {
    const { INVALIDATION_RULES } = require('../shared/CacheInvalidationSyncEngine');
    
    // users: UPDATE and DELETE only
    expect(INVALIDATION_RULES.users.operations).toContain('UPDATE');
    expect(INVALIDATION_RULES.users.operations).toContain('DELETE');
    expect(INVALIDATION_RULES.users.operations).not.toContain('INSERT');
    
    // pokemon: all operations
    expect(INVALIDATION_RULES.pokemon.operations).toContain('INSERT');
    expect(INVALIDATION_RULES.pokemon.operations).toContain('UPDATE');
    expect(INVALIDATION_RULES.pokemon.operations).toContain('DELETE');
  });
  
  it('should have cascade configuration for related tables', () => {
    const { INVALIDATION_RULES } = require('../shared/CacheInvalidationSyncEngine');
    
    expect(INVALIDATION_RULES.pokemon.cascade).toContain('pokemon_inventory');
    expect(INVALIDATION_RULES.gyms.cascade).toContain('gym_defenders');
  });
});