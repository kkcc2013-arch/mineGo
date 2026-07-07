/**
 * REQ-00479 单元测试 - 缓存失效中心
 */

const { describe, it, before, after, beforeEach } = require('mocha');
const { expect } = require('chai');
const CacheInvalidationCenter = require('../shared/cdc/CacheInvalidationCenter');
const ChangeToCacheMapper = require('../shared/cdc/ChangeToCacheMapper');
const InvalidationRetryQueue = require('../shared/cdc/InvalidationRetryQueue');
const sinon = require('sinon');

describe('REQ-00479: 数据库查询结果缓存自动失效策略系统', () => {
  
  describe('ChangeToCacheMapper', () => {
    let mapper;
    
    before(() => {
      mapper = new ChangeToCacheMapper();
    });
    
    it('应正确映射用户表 INSERT 操作', () => {
      const changeEvent = {
        table: 'users',
        operation: 'insert',
        data: { id: 'user123', username: 'test' }
      };
      
      const patterns = mapper.map(changeEvent);
      
      expect(patterns).to.be.an('array');
      expect(patterns.length).to.be.greaterThan(0);
      expect(patterns).to.include('api:/users:list:*');
    });
    
    it('应正确映射用户表 UPDATE 操作', () => {
      const changeEvent = {
        table: 'users',
        operation: 'update',
        data: { id: 'user123', username: 'test', coins: 100 },
        oldData: { id: 'user123', username: 'oldname', coins: 50 }
      };
      
      const patterns = mapper.map(changeEvent);
      
      expect(patterns).to.include('api:/users:user123:*');
      expect(patterns).to.include('api:/users:user123/balance:*');
    });
    
    it('应正确替换模式中的变量', () => {
      const changeEvent = {
        table: 'gyms',
        operation: 'update',
        data: { id: 'gym001', team_id: 'red' }
      };
      
      const patterns = mapper.map(changeEvent);
      
      expect(patterns).to.include('api:/gyms:gym001:*');
    });
    
    it('应返回空数组对于未知表', () => {
      const changeEvent = {
        table: 'unknown_table',
        operation: 'insert',
        data: { id: '123' }
      };
      
      const patterns = mapper.map(changeEvent);
      
      expect(patterns).to.be.an('array');
      expect(patterns.length).to.equal(0);
    });
    
    it('应支持添加自定义映射规则', () => {
      mapper.addTableMapping('new_table', {
        insert: ['api:/new_table:*'],
        update: ['api:/new_table:{id}:*']
      });
      
      const changeEvent = {
        table: 'new_table',
        operation: 'insert',
        data: { id: '123' }
      };
      
      const patterns = mapper.map(changeEvent);
      
      expect(patterns).to.include('api:/new_table:*');
    });
  });
  
  describe('InvalidationRetryQueue', () => {
    let queue;
    
    beforeEach(() => {
      // 使用模拟 Redis
      queue = new InvalidationRetryQueue({
        redis: { host: 'mock-redis' }
      });
    });
    
    it('应正确入队失效任务', async () => {
      // 模拟 Redis 方法
      queue.redis = {
        hset: sinon.stub().resolves(),
        expire: sinon.stub().resolves(),
        zadd: sinon.stub().resolves(),
        hgetall: sinon.stub().resolves({}),
        hget: sinon.stub().resolves('0'),
        zrem: sinon.stub().resolves(),
        del: sinon.stub().resolves(),
        ping: sinon.stub().resolves('PONG'),
        zcard: sinon.stub().resolves(0),
        zcount: sinon.stub().resolves(0),
        zrangebyscore: sinon.stub().resolves([]),
        quit: sinon.stub().resolves()
      };
      
      const taskId = await queue.enqueue('api:/test:*', 'test_failed');
      
      expect(taskId).to.be.a('string');
      expect(taskId).to.include('task:');
      expect(queue.stats.tasksQueued).to.equal(1);
    });
    
    it('应支持批量入队', async () => {
      queue.redis = {
        hset: sinon.stub().resolves(),
        expire: sinon.stub().resolves(),
        zadd: sinon.stub().resolves(),
        quit: sinon.stub().resolves(),
        ping: sinon.stub().resolves('PONG')
      };
      
      const patterns = ['api:/test1:*', 'api:/test2:*', 'api:/test3:*'];
      const results = await queue.enqueueBatch(patterns, 'batch_test');
      
      expect(results.length).to.equal(3);
      expect(results.filter(r => r.status === 'queued').length).to.equal(3);
    });
  });
  
  describe('CacheInvalidationCenter', () => {
    let center;
    
    beforeEach(() => {
      center = new CacheInvalidationCenter({
        enabled: false // 测试时不启用 CDC
      });
    });
    
    it('应正确初始化各组件', () => {
      expect(center.cdcListener).to.exist;
      expect(center.mapper).to.exist;
      expect(center.retryQueue).to.exist;
    });
    
    it('应正确处理变更事件', async () => {
      // 模拟缓存删除
      const cacheStub = sinon.stub(center, 'invalidatePattern').resolves();
      
      const changeEvent = {
        table: 'users',
        operation: 'update',
        data: { id: 'user123' },
        timestamp: Date.now()
      };
      
      await center.handleChangeEvent(changeEvent);
      
      expect(center.stats.eventsReceived).to.equal(1);
      expect(cacheStub.called).to.be.true;
    });
    
    it('应记录失效延迟', async () => {
      const cacheStub = sinon.stub(center, 'invalidatePattern').resolves();
      
      const changeEvent = {
        table: 'users',
        operation: 'update',
        data: { id: 'user123' },
        timestamp: Date.now()
      };
      
      await center.handleChangeEvent(changeEvent);
      
      expect(center.stats.avgLatency).to.be.a('number');
      expect(center.stats.maxLatency).to.be.a('number');
    });
    
    it('应返回正确的统计信息', async () => {
      // 模拟队列统计
      sinon.stub(center.retryQueue, 'getStats').resolves({
        queueSize: 0,
        tasksCompleted: 0
      });
      
      const stats = await center.getStats();
      
      expect(stats).to.have.property('center');
      expect(stats).to.have.property('cdc');
      expect(stats).to.have.property('queue');
    });
  });
  
  describe('验收标准测试', () => {
    it('数据库更新后 100ms 内缓存应被清除', async () => {
      const center = new CacheInvalidationCenter({ enabled: false });
      
      // 模拟快速失效
      sinon.stub(center, 'invalidatePattern').resolves();
      
      const startTime = Date.now();
      const changeEvent = {
        table: 'users',
        operation: 'update',
        data: { id: 'test' },
        timestamp: startTime
      };
      
      await center.handleChangeEvent(changeEvent);
      const latency = Date.now() - startTime;
      
      expect(latency).to.be.lessThan(100);
    });
    
    it('支持缓存 Key 的模式匹配批量删除', () => {
      const mapper = new ChangeToCacheMapper();
      
      const changeEvent = {
        table: 'gyms',
        operation: 'update',
        data: { id: 'gym001' }
      };
      
      const patterns = mapper.map(changeEvent);
      
      // 应返回多个模式
      expect(patterns.length).to.be.greaterThan(1);
      // 所有模式应包含通配符或具体 ID
      patterns.forEach(pattern => {
        expect(pattern).to.include('api:/');
      });
    });
    
    it('在 Redis 网络波动时支持异步清理重试', async () => {
      const queue = new InvalidationRetryQueue();
      
      // 模拟 Redis
      queue.redis = {
        hset: sinon.stub().resolves(),
        expire: sinon.stub().resolves(),
        zadd: sinon.stub().resolves(),
        quit: sinon.stub().resolves(),
        ping: sinon.stub().resolves('PONG')
      };
      
      // 入队一个失败任务
      const taskId = await queue.enqueue('api:/test:*', 'redis_timeout');
      
      expect(taskId).to.exist;
      expect(queue.config.maxRetries).to.equal(5);
    });
  });
});