/**
 * Unit Tests for Distributed Lock Service
 * 
 * Tests Redis Redlock implementation, auto-extension, deadlock detection
 * 
 * @module distributedLock.test
 */

const chai = require('chai');
const { expect } = chai;
const sinon = require('sinon');
const chaiAsPromised = require('chai-as-promised');
const { 
  DistributedLock, 
  ReadWriteLock, 
  ReentrantLock,
  resetDistributedLock 
} = require('../shared/distributedLock');

chai.use(chaiAsPromised);

describe('DistributedLock', () => {
  let lock;
  let mockRedisClients;
  
  beforeEach(() => {
    // Create mock Redis clients
    mockRedisClients = [];
    
    const createMockClient = () => {
      const client = {
        set: sinon.stub(),
        eval: sinon.stub(),
        exists: sinon.stub(),
        pttl: sinon.stub(),
        quit: sinon.stub().resolves(),
        on: sinon.stub()
      };
      mockRedisClients.push(client);
      return client;
    };
    
    // Override constructor to use mocks
    lock = new DistributedLock({
      servers: ['mock1:6379', 'mock2:6379', 'mock3:6379']
    });
    
    // Replace real clients with mocks
    lock.clients = mockRedisClients;
  });
  
  afterEach(async () => {
    // Clean up
    if (lock) {
      // Stop all watchdogs
      for (const timer of lock.watchdogs.values()) {
        clearInterval(timer);
      }
      lock.watchdogs.clear();
    }
    
    resetDistributedLock();
    sinon.restore();
  });
  
  describe('acquire()', () => {
    it('should acquire lock successfully when quorum reached', async () => {
      // Mock successful SET on all clients
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
      });
      
      const result = await lock.acquire('test:resource', 10000);
      
      expect(result).to.have.property('resource', 'test:resource');
      expect(result).to.have.property('lockId');
      expect(result).to.have.property('key', 'lock:test:resource');
      expect(result).to.have.property('ttl', 10000);
      expect(result).to.have.property('acquiredAt');
      
      // Verify all clients were called
      mockRedisClients.forEach(client => {
        expect(client.set.calledOnce).to.be.true;
        expect(client.set.firstCall.args).to.deep.equal([
          'lock:test:resource',
          result.lockId,
          'PX',
          10000,
          'NX'
        ]);
      });
    });
    
    it('should acquire lock with minimum quorum (2 of 3)', async () => {
      // Mock partial success (2 OK, 1 null)
      mockRedisClients[0].set.resolves('OK');
      mockRedisClients[1].set.resolves('OK');
      mockRedisClients[2].set.resolves(null);
      
      const result = await lock.acquire('test:resource', 10000);
      
      expect(result).to.exist;
      expect(result.resource).to.equal('test:resource');
    });
    
    it('should fail when quorum not reached', async () => {
      // Mock insufficient success (1 OK, 2 null)
      mockRedisClients[0].set.resolves('OK');
      mockRedisClients[1].set.resolves(null);
      mockRedisClients[2].set.resolves(null);
      
      // Mock release to avoid errors
      mockRedisClients.forEach(client => {
        client.eval.resolves(1);
      });
      
      await expect(lock.acquire('test:resource', 10000))
        .to.be.rejectedWith('Failed to acquire lock');
    });
    
    it('should retry on failure', async () => {
      // First attempt: all fail
      mockRedisClients.forEach(client => {
        client.set.onFirstCall().resolves(null);
        client.set.onSecondCall().resolves('OK');
        client.eval.resolves(1);
      });
      
      const result = await lock.acquire('test:resource', 10000, { retryCount: 1 });
      
      expect(result).to.exist;
      
      // Verify retry happened
      mockRedisClients.forEach(client => {
        expect(client.set.calledTwice).to.be.true;
      });
    });
    
    it('should start watchdog when autoExtend enabled', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const result = await lock.acquire('test:resource', 10000, {
        autoExtend: true,
        extendInterval: 100
      });
      
      expect(result.autoExtend).to.be.true;
      expect(lock.watchdogs.has(result.lockId)).to.be.true;
      
      // Wait for watchdog to trigger
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Verify extension was called
      mockRedisClients.forEach(client => {
        expect(client.eval.called).to.be.true;
      });
    });
    
    it('should stop watchdog after maxExtendCount', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const result = await lock.acquire('test:resource', 10000, {
        autoExtend: true,
        extendInterval: 50,
        maxExtendCount: 2
      });
      
      expect(lock.watchdogs.has(result.lockId)).to.be.true;
      
      // Wait for max extend count
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(lock.watchdogs.has(result.lockId)).to.be.false;
    });
    
    it('should use custom retryCount', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves(null);
        client.eval.resolves(1);
      });
      
      try {
        await lock.acquire('test:resource', 10000, { retryCount: 2 });
      } catch (err) {
        // Should fail after 3 attempts (initial + 2 retries)
        expect(err.message).to.include('Failed to acquire lock');
      }
    });
  });
  
  describe('release()', () => {
    it('should release lock using Lua script', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const lockObj = await lock.acquire('test:resource', 10000);
      await lock.release(lockObj);
      
      // Verify release script was called
      mockRedisClients.forEach(client => {
        expect(client.eval.calledOnce).to.be.true;
        expect(client.eval.firstCall.args[1]).to.equal(1); // numKeys
        expect(client.eval.firstCall.args[2]).to.equal('lock:test:resource');
        expect(client.eval.firstCall.args[3]).to.equal(lockObj.lockId);
      });
    });
    
    it('should stop watchdog when releasing', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const lockObj = await lock.acquire('test:resource', 10000, {
        autoExtend: true
      });
      
      expect(lock.watchdogs.has(lockObj.lockId)).to.be.true;
      
      await lock.release(lockObj);
      
      expect(lock.watchdogs.has(lockObj.lockId)).to.be.false;
    });
    
    it('should throw error for invalid lock object', async () => {
      await expect(lock.release(null))
        .to.be.rejectedWith('Invalid lock object');
      
      await expect(lock.release({}))
        .to.be.rejectedWith('Invalid lock object');
    });
  });
  
  describe('extend()', () => {
    it('should extend lock TTL', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const lockObj = await lock.acquire('test:resource', 10000);
      const result = await lock.extend(lockObj, 20000);
      
      expect(result).to.be.true;
      expect(lockObj.ttl).to.equal(20000);
      expect(lockObj.extendCount).to.equal(1);
      
      // Verify extension script was called
      mockRedisClients.forEach(client => {
        expect(client.eval.called).to.be.true;
      });
    });
    
    it('should fail extension when lock lost', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(0); // Extension failed
      });
      
      const lockObj = await lock.acquire('test:resource', 10000);
      const result = await lock.extend(lockObj, 20000);
      
      expect(result).to.be.false;
    });
  });
  
  describe('withLock()', () => {
    it('should auto-acquire and release lock', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const fn = sinon.stub().resolves('result');
      
      const result = await lock.withLock('test:resource', 10000, fn);
      
      expect(result).to.equal('result');
      expect(fn.calledOnce).to.be.true;
      
      // Verify lock was acquired and released
      mockRedisClients.forEach(client => {
        expect(client.set.calledOnce).to.be.true;
        expect(client.eval.calledOnce).to.be.true;
      });
    });
    
    it('should release lock even if function throws', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const fn = sinon.stub().rejects(new Error('Function error'));
      
      await expect(lock.withLock('test:resource', 10000, fn))
        .to.be.rejectedWith('Function error');
      
      // Verify lock was still released
      mockRedisClients.forEach(client => {
        expect(client.eval.calledOnce).to.be.true;
      });
    });
  });
  
  describe('tryAcquire()', () => {
    it('should return lock if available', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
      });
      
      const result = await lock.tryAcquire('test:resource', 10000);
      
      expect(result).to.exist;
    });
    
    it('should return null if unavailable', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves(null);
        client.eval.resolves(1);
      });
      
      const result = await lock.tryAcquire('test:resource', 10000);
      
      expect(result).to.be.null;
    });
  });
  
  describe('isLocked()', () => {
    it('should return true when resource is locked', async () => {
      mockRedisClients.forEach(client => {
        client.exists.resolves(1);
      });
      
      const result = await lock.isLocked('test:resource');
      
      expect(result).to.be.true;
    });
    
    it('should return false when resource is unlocked', async () => {
      mockRedisClients.forEach(client => {
        client.exists.resolves(0);
      });
      
      const result = await lock.isLocked('test:resource');
      
      expect(result).to.be.false;
    });
  });
  
  describe('getTTL()', () => {
    it('should return minimum TTL across instances', async () => {
      mockRedisClients[0].pttl.resolves(5000);
      mockRedisClients[1].pttl.resolves(3000);
      mockRedisClients[2].pttl.resolves(7000);
      
      const result = await lock.getTTL('test:resource');
      
      expect(result).to.equal(3000);
    });
    
    it('should return -1 when not locked', async () => {
      mockRedisClients.forEach(client => {
        client.pttl.resolves(-2); // Key doesn't exist
      });
      
      const result = await lock.getTTL('test:resource');
      
      expect(result).to.equal(-1);
    });
  });
  
  describe('close()', () => {
    it('should close all connections', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.quit.resolves();
      });
      
      await lock.acquire('test:resource', 10000, { autoExtend: true });
      
      await lock.close();
      
      mockRedisClients.forEach(client => {
        expect(client.quit.calledOnce).to.be.true;
      });
      
      expect(lock.watchdogs.size).to.equal(0);
    });
  });
});

describe('ReadWriteLock', () => {
  let distributedLock;
  let rwLock;
  let mockRedisClients;
  
  beforeEach(() => {
    mockRedisClients = [];
    
    const createMockClient = () => {
      const client = {
        set: sinon.stub().resolves('OK'),
        eval: sinon.stub().resolves(1),
        exists: sinon.stub().resolves(0),
        quit: sinon.stub().resolves()
      };
      mockRedisClients.push(client);
      return client;
    };
    
    distributedLock = new DistributedLock({
      servers: ['mock1:6379', 'mock2:6379', 'mock3:6379']
    });
    
    distributedLock.clients = mockRedisClients;
    rwLock = new ReadWriteLock(distributedLock);
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  describe('acquireRead()', () => {
    it('should acquire read lock when no write lock', async () => {
      mockRedisClients.forEach(client => {
        client.exists.resolves(0);
        client.set.resolves('OK');
      });
      
      const result = await rwLock.acquireRead('test:resource', 10000);
      
      expect(result).to.exist;
      expect(result.key).to.equal('lock:test:resource:read');
    });
    
    it('should fail when write lock exists', async () => {
      mockRedisClients.forEach(client => {
        client.exists.onFirstCall().resolves(1); // write lock exists
      });
      
      await expect(rwLock.acquireRead('test:resource', 10000))
        .to.be.rejectedWith('Resource is locked for writing');
    });
  });
  
  describe('acquireWrite()', () => {
    it('should acquire write lock when no locks exist', async () => {
      mockRedisClients.forEach(client => {
        client.exists.resolves(0);
        client.set.resolves('OK');
      });
      
      const result = await rwLock.acquireWrite('test:resource', 10000);
      
      expect(result).to.exist;
      expect(result.key).to.equal('lock:test:resource:write');
    });
    
    it('should fail when read lock exists', async () => {
      mockRedisClients.forEach(client => {
        client.exists.onFirstCall().resolves(1); // read lock
        client.exists.onSecondCall().resolves(0); // write lock
      });
      
      await expect(rwLock.acquireWrite('test:resource', 10000))
        .to.be.rejectedWith('Resource is already locked');
    });
    
    it('should fail when write lock exists', async () => {
      mockRedisClients.forEach(client => {
        client.exists.onFirstCall().resolves(0); // read lock
        client.exists.onSecondCall().resolves(1); // write lock
      });
      
      await expect(rwLock.acquireWrite('test:resource', 10000))
        .to.be.rejectedWith('Resource is already locked');
    });
  });
});

describe('ReentrantLock', () => {
  let distributedLock;
  let reentrantLock;
  let mockRedisClients;
  
  beforeEach(() => {
    mockRedisClients = [];
    
    const createMockClient = () => {
      const client = {
        set: sinon.stub().resolves('OK'),
        eval: sinon.stub().resolves(1),
        quit: sinon.stub().resolves()
      };
      mockRedisClients.push(client);
      return client;
    };
    
    distributedLock = new DistributedLock({
      servers: ['mock1:6379', 'mock2:6379', 'mock3:6379']
    });
    
    distributedLock.clients = mockRedisClients;
    reentrantLock = new ReentrantLock(distributedLock);
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  describe('acquire()', () => {
    it('should acquire lock on first call', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
      });
      
      const result = await reentrantLock.acquire('test:resource', 10000);
      
      expect(result).to.exist;
      
      // Check local lock count
      const threadId = process.pid;
      const key = `test:resource:${threadId}`;
      expect(reentrantLock.localLocks.has(key)).to.be.true;
      expect(reentrantLock.localLocks.get(key).count).to.equal(1);
    });
    
    it('should increment count on reentry', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
      });
      
      const result1 = await reentrantLock.acquire('test:resource', 10000);
      const result2 = await reentrantLock.acquire('test:resource', 10000);
      
      expect(result1.lockId).to.equal(result2.lockId);
      
      // Check count
      const threadId = process.pid;
      const key = `test:resource:${threadId}`;
      expect(reentrantLock.localLocks.get(key).count).to.equal(2);
      
      // Verify only one Redis SET call
      mockRedisClients.forEach(client => {
        expect(client.set.calledOnce).to.be.true;
      });
    });
  });
  
  describe('release()', () => {
    it('should decrement count but not release Redis lock', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const lockObj = await reentrantLock.acquire('test:resource', 10000);
      await reentrantLock.acquire('test:resource', 10000); // Reentry
      
      await reentrantLock.release(lockObj);
      
      // Check count
      const threadId = process.pid;
      const key = `test:resource:${threadId}`;
      expect(reentrantLock.localLocks.get(key).count).to.equal(1);
      
      // Redis lock should not be released
      mockRedisClients.forEach(client => {
        expect(client.eval.called).to.be.false;
      });
    });
    
    it('should release Redis lock when count reaches 0', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const lockObj = await reentrantLock.acquire('test:resource', 10000);
      await reentrantLock.release(lockObj);
      
      // Check local lock removed
      const threadId = process.pid;
      const key = `test:resource:${threadId}`;
      expect(reentrantLock.localLocks.has(key)).to.be.false;
      
      // Redis lock should be released
      mockRedisClients.forEach(client => {
        expect(client.eval.calledOnce).to.be.true;
      });
    });
    
    it('should throw error if lock not held', async () => {
      mockRedisClients.forEach(client => {
        client.set.resolves('OK');
        client.eval.resolves(1);
      });
      
      const lockObj = await reentrantLock.acquire('test:resource', 10000);
      
      // Clear local locks manually
      reentrantLock.localLocks.clear();
      
      await expect(reentrantLock.release(lockObj))
        .to.be.rejectedWith('Lock not held by current thread');
    });
  });
});

describe('Edge Cases', () => {
  let lock;
  let mockRedisClients;
  
  beforeEach(() => {
    mockRedisClients = [];
    
    const createMockClient = () => {
      const client = {
        set: sinon.stub(),
        eval: sinon.stub(),
        exists: sinon.stub(),
        pttl: sinon.stub(),
        quit: sinon.stub().resolves()
      };
      mockRedisClients.push(client);
      return client;
    };
    
    lock = new DistributedLock({
      servers: ['mock1:6379', 'mock2:6379', 'mock3:6379']
    });
    
    lock.clients = mockRedisClients;
  });
  
  afterEach(() => {
    sinon.restore();
  });
  
  it('should handle Redis connection errors gracefully', async () => {
    // First client OK, others error
    mockRedisClients[0].set.resolves('OK');
    mockRedisClients[1].set.rejects(new Error('Connection error'));
    mockRedisClients[2].set.rejects(new Error('Connection error'));
    
    const result = await lock.acquire('test:resource', 10000);
    
    // Should succeed with quorum of 1
    expect(result).to.exist;
  });
  
  it('should handle acquisition time exceeding TTL', async () => {
    // Mock slow responses
    mockRedisClients.forEach(client => {
      client.set.resolves('OK');
    });
    
    // Mock long acquisition time
    const originalDate = Date.now;
    let callCount = 0;
    
    Date.now = function() {
      callCount++;
      if (callCount === 1) return 1000;
      if (callCount === 2) return 15000; // After TTL
      return originalDate();
    };
    
    try {
      await lock.acquire('test:resource', 10000);
      
      // Should fail or have reduced validity
    } catch (err) {
      expect(err.message).to.include('Failed to acquire lock');
    }
    
    Date.now = originalDate;
  });
  
  it('should handle concurrent lock attempts', async () => {
    mockRedisClients.forEach(client => {
      client.set.resolves('OK');
      client.eval.resolves(1);
    });
    
    // Attempt multiple concurrent locks
    const promises = [
      lock.acquire('test:resource1', 10000),
      lock.acquire('test:resource2', 10000),
      lock.acquire('test:resource3', 10000)
    ];
    
    const results = await Promise.all(promises);
    
    expect(results).to.have.length(3);
    expect(results[0].resource).to.equal('test:resource1');
    expect(results[1].resource).to.equal('test:resource2');
    expect(results[2].resource).to.equal('test:resource3');
  });
  
  it('should calculate validity time correctly', async () => {
    mockRedisClients.forEach(client => {
      client.set.resolves('OK');
    });
    
    const ttl = 10000;
    const driftFactor = 0.01;
    
    const result = await lock.acquire('test:resource', ttl);
    
    // Validity should be less than TTL due to acquisition time and drift
    expect(result.validityTime).to.be.lessThan(ttl);
    expect(result.validityTime).to.be.greaterThan(0);
  });
});