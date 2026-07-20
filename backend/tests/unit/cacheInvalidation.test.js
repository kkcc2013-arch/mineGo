/**
 * 缓存失效系统单元测试
 * REQ-00523: 数据库查询结果缓存失效智能同步系统
 */

const { expect } = require('chai');
const sinon = require('sinon');
const { 
  ChangeEventType, 
  ChangeEvent, 
  PostgreSQLCDCAdapter 
} = require('../cdcAdapter');

const CacheInvalidationEngine = require('../cacheInvalidationEngine');

describe('REQ-00523: Cache Invalidation System', () => {
  
  describe('ChangeEvent', () => {
    
    it('should create change event with correct properties', () => {
      const event = new ChangeEvent({
        timestamp: 1626876000000,
        table: 'users',
        schema: 'public',
        operation: 'insert',
        after: { id: 123, name: 'Alice' },
        primaryKey: { fields: ['id'], value: '123' },
        transactionId: 'tx-123'
      });
      
      expect(event.timestamp).to.equal(1626876000000);
      expect(event.table).to.equal('users');
      expect(event.schema).to.equal('public');
      expect(event.operation).to.equal('insert');
      expect(event.after).to.deep.equal({ id: 123, name: 'Alice' });
    });
    
    it('should get primary key value for insert operation', () => {
      const event = new ChangeEvent({
        operation: 'insert',
        table: 'users',
        after: { id: 456, name: 'Bob' },
        primaryKey: { fields: ['id'] }
      });
      
      const pkValue = event.getPrimaryKeyValue();
      expect(pkValue).to.equal('456');
    });
    
    it('should get primary key value for delete operation', () => {
      const event = new ChangeEvent({
        operation: 'delete',
        table: 'users',
        before: { id: 789, name: 'Charlie' },
        primaryKey: { fields: ['id'], value: '789' }
      });
      
      const pkValue = event.getPrimaryKeyValue();
      expect(pkValue).to.equal('789');
    });
    
    it('should detect changed fields for update operation', () => {
      const event = new ChangeEvent({
        operation: 'update',
        table: 'users',
        before: { id: 123, name: 'Alice', level: 10 },
        after: { id: 123, name: 'Alice Smith', level: 11 }
      });
      
      const changedFields = event.getChangedFields();
      expect(changedFields).to.include('name');
      expect(changedFields).to.include('level');
      expect(changedFields).to.not.include('id');
    });
    
    it('should return all fields for insert/delete', () => {
      const insertEvent = new ChangeEvent({
        operation: 'insert',
        table: 'users',
        after: { id: 123, name: 'Alice' }
      });
      
      const insertFields = insertEvent.getChangedFields();
      expect(insertFields).to.deep.equal(['id', 'name']);
      
      const deleteEvent = new ChangeEvent({
        operation: 'delete',
        table: 'users',
        before: { id: 456, name: 'Bob' }
      });
      
      const deleteFields = deleteEvent.getChangedFields();
      expect(deleteFields).to.deep.equal(['id', 'name']);
    });
  });
  
  describe('PostgreSQLCDCAdapter', () => {
    let adapter;
    let mockPgClient;
    
    beforeEach(() => {
      mockPgClient = {
        query: sinon.stub().resolves(),
        on: sinon.stub(),
        removeListener: sinon.stub()
      };
      
      adapter = new PostgreSQLCDCAdapter(mockPgClient, {
        channel: 'test_channel',
        tables: ['users', 'pokemon']
      });
    });
    
    afterEach(async () => {
      if (adapter && adapter.isRunning) {
        await adapter.stop();
      }
    });
    
    it('should initialize with correct config', () => {
      expect(adapter.config.channel).to.equal('test_channel');
      expect(adapter.config.tables).to.deep.equal(['users', 'pokemon']);
      expect(adapter.isRunning).to.be.false;
    });
    
    it('should create trigger function on initialization', async () => {
      await adapter.createTriggerFunction();
      
      expect(mockPgClient.query.calledOnce).to.be.true;
      const sql = mockPgClient.query.firstCall.args[0];
      expect(sql).to.include('CREATE OR REPLACE FUNCTION notify_cache_invalidation()');
      expect(sql).to.include('pg_notify');
    });
    
    it('should create triggers for specified tables', async () => {
      await adapter.createTriggers();
      
      // 应该为每个表调用一次 query
      expect(mockPgClient.query.callCount).to.be.at.least(2);
    });
    
    it('should merge duplicate change events', () => {
      const event1 = new ChangeEvent({
        timestamp: 1000,
        table: 'users',
        operation: 'update',
        after: { id: 123, name: 'Alice' }
      });
      
      const event2 = new ChangeEvent({
        timestamp: 2000,
        table: 'users',
        operation: 'update',
        after: { id: 123, name: 'Alice Updated' }
      });
      
      adapter.bufferChange(event1);
      adapter.bufferChange(event2);
      
      const merged = adapter.mergeEvents([event1, event2]);
      expect(merged.length).to.equal(1);
      expect(merged[0].after.name).to.equal('Alice Updated');
    });
  });
  
  describe('CacheInvalidationEngine', () => {
    let engine;
    let mockCacheModule;
    let mockCDCAdapter;
    let mockRedisClient;
    
    beforeEach(() => {
      // 创建模拟对象
      mockCacheModule = {
        memoryCache: new Map([
          ['user:123', { data: 'test', expireAt: Date.now() + 60000 }],
          ['user:123:profile', { data: 'profile', expireAt: Date.now() + 60000 }],
          ['pokemon:456', { data: 'pokemon', expireAt: Date.now() + 60000 }]
        ])
      };
      
      mockCDCAdapter = {
        on: sinon.stub()
      };
      
      mockRedisClient = {
        del: sinon.stub().resolves(1),
        status: 'ready'
      };
      
      engine = new CacheInvalidationEngine(mockCacheModule, mockCDCAdapter, {
        enableMetrics: true
      });
      
      // 模拟 Redis 客户端
      engine.redisClient = mockRedisClient;
    });
    
    it('should load default invalidation rules', () => {
      engine.loadDefaultInvalidationRules();
      
      expect(engine.invalidationRules.size).to.be.at.least(10);
      expect(engine.invalidationRules.has('users')).to.be.true;
      expect(engine.invalidationRules.has('pokemon')).to.be.true;
    });
    
    it('should extract primary key value from insert event', () => {
      engine.loadDefaultInvalidationRules();
      
      const event = new ChangeEvent({
        operation: 'insert',
        table: 'users',
        after: { id: 123, name: 'Alice' }
      });
      
      const pkValue = engine.extractPrimaryKeyValue(event, 'id');
      expect(pkValue).to.equal(123);
    });
    
    it('should extract primary key value from delete event', () => {
      const event = new ChangeEvent({
        operation: 'delete',
        table: 'users',
        before: { id: 456, name: 'Bob' }
      });
      
      const pkValue = engine.extractPrimaryKeyValue(event, 'id');
      expect(pkValue).to.equal(456);
    });
    
    it('should extract composite primary key value', () => {
      const event = new ChangeEvent({
        operation: 'update',
        table: 'user_items',
        after: { user_id: 123, item_id: 456, quantity: 10 }
      });
      
      const pkValue = engine.extractPrimaryKeyValue(event, ['user_id', 'item_id']);
      expect(pkValue).to.equal('123:456');
    });
    
    it('should generate cache keys from exact pattern', () => {
      engine.loadDefaultInvalidationRules();
      
      const rules = engine.invalidationRules.get('users');
      const event = new ChangeEvent({
        operation: 'update',
        table: 'users',
        after: { id: 123, name: 'Alice' }
      });
      
      const keys = engine.generateCacheKeys(rules.cacheKeys, '123', event);
      
      expect(keys).to.include('user:123');
    });
    
    it('should generate cache keys with prefix pattern', () => {
      engine.loadDefaultInvalidationRules();
      
      const rules = engine.invalidationRules.get('users');
      const event = new ChangeEvent({
        operation: 'update',
        table: 'users',
        after: { id: 123, name: 'Alice' }
      });
      
      const keys = engine.generateCacheKeys(rules.cacheKeys, '123', event);
      
      // 应该包含精确键和前缀匹配的键
      expect(keys).to.include('user:123');
      expect(keys).to.include('user:123:profile');
    });
    
    it('should invalidate cache keys', async () => {
      engine.cacheModule.memoryCache.set('test:key', { data: 'test' });
      
      await engine.invalidateCache('test:key', 'update');
      
      expect(engine.cacheModule.memoryCache.has('test:key')).to.be.false;
      expect(mockRedisClient.del.calledWith('test:key')).to.be.true;
      expect(engine.metrics.invalidatedKeys).to.equal(1);
    });
    
    it('should handle invalidation with retry', async () => {
      mockRedisClient.del.onFirstCall().rejects(new Error('Temporary error'));
      mockRedisClient.del.onSecondCall().resolves(1);
      
      engine.config.maxRetries = 3;
      engine.config.retryDelayMs = 10;
      
      await engine.invalidateCache('test:key', 'update');
      
      expect(mockRedisClient.del.callCount).to.equal(2);
      expect(engine.metrics.invalidatedKeys).to.equal(1);
    });
    
    it('should update metrics after invalidation', () => {
      const initialLatency = engine.metrics.averageLatencyMs;
      
      engine.updateMetrics(50, 3);
      
      const expectedLatency = initialLatency * 0.9 + 50 * 0.1;
      expect(engine.metrics.averageLatencyMs).to.be.closeTo(expectedLatency, 0.1);
    });
    
    it('should handle database change event', async () => {
      engine.loadDefaultInvalidationRules();
      engine.isInitialized = true;
      
      const event = new ChangeEvent({
        operation: 'update',
        table: 'users',
        after: { id: 123, name: 'Alice Updated' }
      });
      
      // 添加一些缓存键
      engine.cacheModule.memoryCache.set('user:123', { data: 'old' });
      
      await engine.handleDatabaseChange(event);
      
      // 验证缓存被失效
      expect(engine.cacheModule.memoryCache.has('user:123')).to.be.false;
      expect(engine.metrics.totalChanges).to.equal(1);
      expect(engine.metrics.invalidatedKeys).to.be.at.least(1);
    });
    
    it('should skip tables without rules', async () => {
      engine.loadDefaultInvalidationRules();
      engine.isInitialized = true;
      
      const event = new ChangeEvent({
        operation: 'update',
        table: 'unknown_table',
        after: { id: 123 }
      });
      
      const initialTotal = engine.metrics.totalChanges;
      
      await engine.handleDatabaseChange(event);
      
      // 不应该失效任何键
      expect(engine.metrics.invalidatedKeys).to.equal(initialTotal === 0 ? 0 : engine.metrics.invalidatedKeys);
    });
    
    it('should add custom invalidation rule', () => {
      engine.addInvalidationRule('custom_table', {
        primaryKey: 'id',
        cacheKeys: [
          { pattern: 'custom:{id}', type: 'exact' }
        ]
      });
      
      expect(engine.invalidationRules.has('custom_table')).to.be.true;
      
      const rule = engine.invalidationRules.get('custom_table');
      expect(rule.primaryKey).to.equal('id');
      expect(rule.cacheKeys[0].pattern).to.equal('custom:{id}');
    });
    
    it('should remove invalidation rule', () => {
      engine.addInvalidationRule('temp_table', {
        primaryKey: 'id',
        cacheKeys: []
      });
      
      const removed = engine.removeInvalidationRule('temp_table');
      
      expect(removed).to.be.true;
      expect(engine.invalidationRules.has('temp_table')).to.be.false;
    });
    
    it('should get metrics', () => {
      engine.metrics.totalChanges = 100;
      engine.metrics.invalidatedKeys = 95;
      engine.metrics.failedInvalidations = 5;
      engine.metrics.averageLatencyMs = 25.5;
      
      const metrics = engine.getMetrics();
      
      expect(metrics.totalChanges).to.equal(100);
      expect(metrics.invalidatedKeys).to.equal(95);
      expect(metrics.failedInvalidations).to.equal(5);
      expect(metrics.averageLatencyMs).to.equal(25.5);
      expect(metrics.health).to.equal('uninitialized'); // 因为 isInitialized = false
    });
    
    it('should perform health check', async () => {
      engine.isInitialized = true;
      
      const health = await engine.healthCheck();
      
      expect(health.status).to.equal('healthy');
      expect(health.rulesCount).to.be.at.least(0);
      expect(health.metrics).to.exist;
      expect(health.redisConnected).to.be.true;
    });
  });
  
  describe('Integration Tests', () => {
    
    it('should handle complete flow: change event -> cache invalidation', async () => {
      // 创建内存缓存
      const memoryCache = new Map([
        ['user:123', { data: 'user data', expireAt: Date.now() + 60000 }],
        ['user:123:profile', { data: 'profile', expireAt: Date.now() + 60000 }]
      ]);
      
      // 创建引擎
      const mockCDC = { on: sinon.stub() };
      const mockRedis = { del: sinon.stub().resolves(1), status: 'ready' };
      
      const engine = new CacheInvalidationEngine(
        { memoryCache },
        mockCDC,
        { enableMetrics: true }
      );
      
      engine.redisClient = mockRedis;
      engine.loadDefaultInvalidationRules();
      engine.isInitialized = true;
      
      // 模拟数据库变更事件
      const event = new ChangeEvent({
        operation: 'update',
        table: 'users',
        after: { id: 123, name: 'Alice' }
      });
      
      await engine.handleDatabaseChange(event);
      
      // 验证结果
      expect(memoryCache.has('user:123')).to.be.false;
      expect(memoryCache.has('user:123:profile')).to.be.false;
      expect(mockRedis.del.calledTwice).to.be.true;
      expect(engine.metrics.invalidatedKeys).to.equal(2);
    });
  });
  
  describe('Performance Tests', () => {
    
    it('should handle high-frequency changes with debounce', (done) => {
      const mockPgClient = {
        query: sinon.stub().resolves(),
        on: sinon.stub(),
        removeListener: sinon.stub()
      };
      
      const adapter = new PostgreSQLCDCAdapter(mockPgClient, {
        debounceMs: 50
      });
      
      const changesReceived = [];
      adapter.on('change', (event) => {
        changesReceived.push(event);
      });
      
      // 快速发送多个变更事件
      for (let i = 0; i < 10; i++) {
        adapter.bufferChange(new ChangeEvent({
          operation: 'update',
          table: 'users',
          after: { id: 123, version: i }
        }));
      }
      
      // 等待缓冲区刷新
      setTimeout(() => {
        // 应该合并重复事件
        expect(changesReceived.length).to.be.lessThan(10);
        done();
      }, 100);
    });
    
    it('should meet latency requirement (< 50ms)', async () => {
      const memoryCache = new Map();
      for (let i = 0; i < 100; i++) {
        memoryCache.set(`user:${i}`, { data: `data${i}`, expireAt: Date.now() + 60000 });
      }
      
      const mockCDC = { on: sinon.stub() };
      const mockRedis = { del: sinon.stub().resolves(1), status: 'ready' };
      
      const engine = new CacheInvalidationEngine(
        { memoryCache },
        mockCDC,
        { enableMetrics: true }
      );
      
      engine.redisClient = mockRedis;
      engine.loadDefaultInvalidationRules();
      engine.isInitialized = true;
      
      const event = new ChangeEvent({
        operation: 'update',
        table: 'users',
        after: { id: 50 }
      });
      
      const startTime = Date.now();
      await engine.handleDatabaseChange(event);
      const latency = Date.now() - startTime;
      
      expect(latency).to.be.lessThan(50);
    });
  });
});
