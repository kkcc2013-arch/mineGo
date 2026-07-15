/**
 * DistributedLock Unit Tests
 * 
 * 分布式锁的单元测试
 * 
 * @module backend/shared/tests/distributedLock.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('mocha');
const { expect } = require('chai');
const sinon = require('sinon');

// 模拟 Redis
const mockRedis = {
  set: sinon.stub(),
  get: sinon.stub(),
  del: sinon.stub(),
  exists: sinon.stub(),
  pttl: sinon.stub(),
  pexpire: sinon.stub(),
  eval: sinon.stub(),
  ping: sinon.stub(),
  quit: sinon.stub()
};

// 模拟 ioredis
const mockIORedis = function() {
  return mockRedis;
};

mockIORedis.prototype = mockRedis;

// 注入模拟
const proxyquire = require('proxyquire').noCallThru();

const { DistributedLock, ReadWriteLock, ReentrantLock, resetInstances } = proxyquire('./../distributedLock', {
  'ioredis': mockIORedis
});

describe('DistributedLock', function() {
  let lock;
  
  beforeEach(function() {
    resetInstances();
    
    // 重置所有存根
    Object.keys(mockRedis).forEach(key => {
      if (mockRedis[key].reset) mockRedis[key].reset();
    });
    
    lock = new DistributedLock({
      servers: ['localhost:6379'],
      retryCount: 3,
      retryDelay: 50
    });
  });
  
  afterEach(async function() {
    if (lock) {
      await lock.close();
    }
  });
  
  describe('#acquire', function() {
    it('should successfully acquire a lock', async function() {
      // 模拟 Redis SET 返回 OK
      mockRedis.set.resolves('OK');
      
      const resource = 'test:resource';
      const ttl = 10000;
      
      const lockObj = await lock.acquire(resource, ttl);
      
      expect(lockObj).to.exist;
      expect(lockObj.resource).to.equal(resource);
      expect(lockObj.ttl).to.equal(ttl);
      expect(lockObj.lockId).to.be.a('string');
      expect(lockObj.acquiredAt).to.be.a('number');
    });
    
    it('should fail to acquire lock when Redis returns null', async function() {
      // 模拟锁已被占用
      mockRedis.set.resolves(null);
      
      const resource = 'test:locked-resource';
      const ttl = 10000;
      
      try {
        await lock.acquire(resource, ttl, { retryCount: 0 });
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.include('Failed to acquire lock');
      }
    });
    
    it('should retry on failure', async function() {
      // 第一次失败，第二次成功
      mockRedis.set.onFirstCall().resolves(null);
      mockRedis.set.onSecondCall().resolves('OK');
      
      const resource = 'test:retry-resource';
      const ttl = 10000;
      
      const lockObj = await lock.acquire(resource, ttl, { retryCount: 1 });
      
      expect(lockObj).to.exist;
      expect(mockRedis.set.calledTwice).to.be.true;
    });
    
    it('should generate unique lock IDs', async function() {
      mockRedis.set.resolves('OK');
      
      const lock1 = await lock.acquire('resource1', 10000);
      const lock2 = await lock.acquire('resource2', 10000);
      
      expect(lock1.lockId).to.not.equal(lock2.lockId);
    });
  });
  
  describe('#release', function() {
    it('should successfully release a lock', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const lockObj = await lock.acquire('test:release', 10000);
      const result = await lock.release(lockObj);
      
      expect(result).to.be.true;
      expect(mockRedis.eval.called).to.be.true;
    });
    
    it('should throw error for invalid lock object', async function() {
      try {
        await lock.release(null);
        expect.fail('Should have thrown an error');
      } catch (err) {
        expect(err.message).to.include('Invalid lock object');
      }
    });
    
    it('should use Lua script for atomic release', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const lockObj = await lock.acquire('test:atomic-release', 10000);
      await lock.release(lockObj);
      
      // 验证 Lua 脚本被调用
      const evalCall = mockRedis.eval.getCall(0);
      expect(evalCall.args[0]).to.include('redis.call("get"');
      expect(evalCall.args[0]).to.include('redis.call("del"');
    });
  });
  
  describe('#extend', function() {
    it('should extend lock TTL', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const lockObj = await lock.acquire('test:extend', 10000);
      const newTTL = 20000;
      
      const result = await lock.extend(lockObj, newTTL);
      
      expect(result).to.be.true;
      expect(lockObj.ttl).to.equal(newTTL);
      expect(lockObj.extendCount).to.equal(1);
    });
    
    it('should fail to extend if lock is not held', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(0); // 锁不匹配
      
      const lockObj = await lock.acquire('test:extend-fail', 10000);
      const result = await lock.extend(lockObj, 20000);
      
      expect(result).to.be.false;
    });
  });
  
  describe('#withLock', function() {
    it('should execute function with lock', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const resource = 'test:with-lock';
      const expected = { result: 'success' };
      
      const result = await lock.withLock(resource, 10000, async () => {
        return expected;
      });
      
      expect(result).to.deep.equal(expected);
    });
    
    it('should release lock even if function throws', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      try {
        await lock.withLock('test:with-lock-throw', 10000, async () => {
          throw new Error('Test error');
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.equal('Test error');
      }
      
      // 验证锁被释放
      expect(mockRedis.eval.called).to.be.true;
    });
  });
  
  describe('#tryAcquire', function() {
    it('should return null if lock not available', async function() {
      mockRedis.set.resolves(null);
      
      const lockObj = await lock.tryAcquire('test:try-acquire-fail', 10000);
      
      expect(lockObj).to.be.null;
    });
    
    it('should return lock if available', async function() {
      mockRedis.set.resolves('OK');
      
      const lockObj = await lock.tryAcquire('test:try-acquire-success', 10000);
      
      expect(lockObj).to.exist;
    });
  });
  
  describe('#isLocked', function() {
    it('should return true if resource is locked', async function() {
      mockRedis.exists.resolves(1);
      
      const result = await lock.isLocked('test:locked-resource');
      
      expect(result).to.be.true;
    });
    
    it('should return false if resource is not locked', async function() {
      mockRedis.exists.resolves(0);
      
      const result = await lock.isLocked('test:unlocked-resource');
      
      expect(result).to.be.false;
    });
  });
  
  describe('#getTTL', function() {
    it('should return TTL for locked resource', async function() {
      mockRedis.pttl.resolves(5000);
      
      const ttl = await lock.getTTL('test:ttl-resource');
      
      expect(ttl).to.equal(5000);
    });
    
    it('should return -1 for non-existent resource', async function() {
      mockRedis.pttl.resolves(-2);
      
      const ttl = await lock.getTTL('test:nonexistent');
      
      expect(ttl).to.equal(-1);
    });
  });
  
  describe('Watchdog', function() {
    it('should start watchdog when autoExtend is true', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const clock = sinon.useFakeTimers();
      
      try {
        const lockObj = await lock.acquire('test:watchdog', 10000, {
          autoExtend: true,
          extendInterval: 3000
        });
        
        expect(lock.watchdogs.has(lockObj.lockId)).to.be.true;
        
        // 快进时间触发续期
        await clock.tickAsync(3000);
        
        expect(mockRedis.eval.called).to.be.true;
        
        lock.stopWatchdog(lockObj);
      } finally {
        clock.restore();
      }
    });
    
    it('should stop watchdog after max extend count', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const lockObj = await lock.acquire('test:watchdog-max', 10000, {
        autoExtend: true,
        extendInterval: 100,
        maxExtendCount: 2
      });
      
      // 执行两次续期
      await lock.extend(lockObj, lockObj.ttl);
      await lock.extend(lockObj, lockObj.ttl);
      
      // 第三次应该不再续期
      const clock = sinon.useFakeTimers();
      try {
        await clock.tickAsync(150);
        // 看门狗应该已停止
        expect(lock.watchdogs.has(lockObj.lockId)).to.be.false;
      } finally {
        clock.restore();
      }
    });
  });
  
  describe('#getHealth', function() {
    it('should return healthy status when Redis is up', async function() {
      mockRedis.ping.resolves('PONG');
      
      const health = await lock.getHealth();
      
      expect(health.status).to.equal('healthy');
      expect(health.healthy).to.be.greaterThan(0);
    });
    
    it('should return unhealthy status when Redis is down', async function() {
      mockRedis.ping.rejects(new Error('Connection refused'));
      
      const health = await lock.getHealth();
      
      expect(health.status).to.equal('unhealthy');
      expect(health.healthy).to.equal(0);
    });
  });
});

describe('ReadWriteLock', function() {
  let distributedLock;
  let readWriteLock;
  
  beforeEach(function() {
    resetInstances();
    Object.keys(mockRedis).forEach(key => {
      if (mockRedis[key].reset) mockRedis[key].reset();
    });
    
    distributedLock = new DistributedLock({
      servers: ['localhost:6379']
    });
    readWriteLock = new ReadWriteLock(distributedLock);
  });
  
  describe('#acquireRead', function() {
    it('should acquire read lock when no write lock exists', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.exists.resolves(0); // 无写锁
      
      const lockObj = await readWriteLock.acquireRead('test:rw-read', 10000);
      
      expect(lockObj).to.exist;
    });
    
    it('should fail when write lock exists', async function() {
      mockRedis.exists.resolves(1); // 存在写锁
      
      try {
        await readWriteLock.acquireRead('test:rw-read-blocked', 10000);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('locked for writing');
      }
    });
  });
  
  describe('#acquireWrite', function() {
    it('should acquire write lock when no locks exist', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.exists.resolves(0); // 无任何锁
      
      const lockObj = await readWriteLock.acquireWrite('test:rw-write', 10000);
      
      expect(lockObj).to.exist;
    });
    
    it('should fail when read lock exists', async function() {
      mockRedis.exists.onFirstCall().resolves(1); // 存在读锁
      
      try {
        await readWriteLock.acquireWrite('test:rw-write-blocked', 10000);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('already locked');
      }
    });
  });
});

describe('ReentrantLock', function() {
  let distributedLock;
  let reentrantLock;
  
  beforeEach(function() {
    resetInstances();
    Object.keys(mockRedis).forEach(key => {
      if (mockRedis[key].reset) mockRedis[key].reset();
    });
    
    distributedLock = new DistributedLock({
      servers: ['localhost:6379']
    });
    reentrantLock = new ReentrantLock(distributedLock);
  });
  
  describe('#acquire', function() {
    it('should allow re-entrancy', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const resource = 'test:reentrant';
      
      const lock1 = await reentrantLock.acquire(resource, 10000);
      const lock2 = await reentrantLock.acquire(resource, 10000);
      
      // 应该是同一个锁对象
      expect(lock1.lockId).to.equal(lock2.lockId);
      expect(reentrantLock.getHoldCount(resource)).to.equal(2);
    });
    
    it('should release lock after all exits', async function() {
      mockRedis.set.resolves('OK');
      mockRedis.eval.resolves(1);
      
      const resource = 'test:reentrant-release';
      
      const lock1 = await reentrantLock.acquire(resource, 10000);
      const lock2 = await reentrantLock.acquire(resource, 10000);
      
      await reentrantLock.release(lock2);
      expect(reentrantLock.getHoldCount(resource)).to.equal(1);
      
      await reentrantLock.release(lock1);
      expect(reentrantLock.getHoldCount(resource)).to.equal(0);
      
      // 最后一次释放应该调用底层 release
      expect(mockRedis.eval.called).to.be.true;
    });
  });
  
  describe('#getHoldCount', function() {
    it('should return 0 for non-held lock', function() {
      expect(reentrantLock.getHoldCount('test:non-held')).to.equal(0);
    });
  });
});

describe('Integration Tests', function() {
  it('should handle concurrent lock requests', async function() {
    resetInstances();
    Object.keys(mockRedis).forEach(key => {
      if (mockRedis[key].reset) mockRedis[key].reset();
    });
    
    const lock = new DistributedLock({
      servers: ['localhost:6379'],
      retryCount: 0
    });
    
    // 模拟并发竞争
    let acquired = 0;
    
    mockRedis.set.onFirstCall().resolves('OK');
    mockRedis.set.onSecondCall().resolves(null);
    mockRedis.set.onThirdCall().resolves(null);
    
    const results = await Promise.allSettled([
      lock.acquire('test:concurrent', 10000).then(() => { acquired++; }),
      lock.acquire('test:concurrent', 10000).catch(() => {}),
      lock.acquire('test:concurrent', 10000).catch(() => {})
    ]);
    
    // 只有一个应该成功
    expect(acquired).to.equal(1);
    
    await lock.close();
  });
});
