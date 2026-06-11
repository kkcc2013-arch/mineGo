/**
 * 分布式锁单元测试
 */

const { describe, it, beforeEach, afterEach, expect } = require('../test-helpers');
const {
  DistributedLock,
  ReadWriteLock,
  ReentrantLock,
  resetDistributedLock
} = require('../../shared/distributedLock');
const {
  DeadlockDetector,
  resetDeadlockDetector
} = require('../../shared/deadlockDetector');

// Mock Redis for testing
class MockRedis {
  constructor() {
    this.store = new Map();
    this.status = 'ready';
  }
  
  async connect() {
    this.status = 'ready';
    return true;
  }
  
  async set(key, value, ...args) {
    const ttlIndex = args.indexOf('PX');
    const ttl = ttlIndex !== -1 ? args[ttlIndex + 1] : null;
    const nx = args.includes('NX');
    
    if (nx && this.store.has(key)) {
      return null;
    }
    
    this.store.set(key, {
      value,
      ttl: ttl ? Date.now() + parseInt(ttl) : null
    });
    
    return 'OK';
  }
  
  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    
    if (entry.ttl && Date.now() > entry.ttl) {
      this.store.delete(key);
      return null;
    }
    
    return entry.value;
  }
  
  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }
  
  async exists(key) {
    const entry = this.store.get(key);
    if (!entry) return 0;
    
    if (entry.ttl && Date.now() > entry.ttl) {
      this.store.delete(key);
      return 0;
    }
    
    return 1;
  }
  
  async pttl(key) {
    const entry = this.store.get(key);
    if (!entry) return -2;
    if (!entry.ttl) return -1;
    
    const remaining = entry.ttl - Date.now();
    return remaining > 0 ? remaining : -2;
  }
  
  async eval(script, numKeys, ...args) {
    // Simple Lua script simulation
    if (script.includes('redis.call("get")')) {
      const key = args[0];
      const expectedValue = args[1];
      const actualValue = await this.get(key);
      
      if (actualValue === expectedValue) {
        if (script.includes('del')) {
          return await this.del(key);
        } else if (script.includes('pexpire')) {
          const ttl = args[2];
          const entry = this.store.get(key);
          if (entry) {
            entry.ttl = Date.now() + parseInt(ttl);
            return 1;
          }
        }
      }
      return 0;
    }
    return 0;
  }
  
  async quit() {
    this.status = 'end';
    return 'OK';
  }
}

// ============================================================================
// DistributedLock Tests
// ============================================================================

describe('DistributedLock', () => {
  let lock;
  let mockClients;
  
  beforeEach(() => {
    resetDistributedLock();
    mockClients = [new MockRedis(), new MockRedis(), new MockRedis()];
    
    lock = new DistributedLock({
      servers: ['localhost:6379', 'localhost:6380', 'localhost:6381'],
      retryCount: 3,
      retryDelay: 100
    });
    
    // Replace clients with mocks
    lock.clients = mockClients;
  });
  
  afterEach(async () => {
    await lock.close();
  });
  
  describe('acquire', () => {
    it('should acquire a lock successfully', async () => {
      const resource = 'test:resource:1';
      const ttl = 10000;
      
      const lockObj = await lock.acquire(resource, ttl);
      
      expect(lockObj).toBeDefined();
      expect(lockObj.resource).toBe(resource);
      expect(lockObj.lockId).toBeDefined();
      expect(lockObj.ttl).toBe(ttl);
      expect(lockObj.validityTime).toBeGreaterThan(0);
    });
    
    it('should fail to acquire lock when resource is already locked', async () => {
      const resource = 'test:resource:2';
      const ttl = 10000;
      
      // First acquisition
      const lock1 = await lock.acquire(resource, ttl);
      
      // Second acquisition should fail
      await expect(lock.acquire(resource, ttl, { retryCount: 0 }))
        .rejects.toThrow('Failed to acquire lock');
      
      // Cleanup
      await lock.release(lock1);
    });
    
    it('should acquire lock with auto-extend enabled', async () => {
      const resource = 'test:resource:3';
      const ttl = 5000;
      
      const lockObj = await lock.acquire(resource, ttl, {
        autoExtend: true,
        extendInterval: 1000,
        maxExtendCount: 5
      });
      
      expect(lockObj).toBeDefined();
      expect(lockObj.autoExtend).toBe(true);
      expect(lock.watchdogs.has(lockObj.lockId)).toBe(true);
      
      // Cleanup
      await lock.release(lockObj);
    });
    
    it('should respect retry count', async () => {
      const resource = 'test:resource:4';
      const ttl = 10000;
      
      // Acquire lock
      const lock1 = await lock.acquire(resource, ttl);
      
      const startTime = Date.now();
      
      await expect(lock.acquire(resource, ttl, { retryCount: 2, retryDelay: 100 }))
        .rejects.toThrow();
      
      const elapsed = Date.now() - startTime;
      // Should have retried 2 times with ~100ms delay each
      expect(elapsed).toBeGreaterThan(150);
      
      await lock.release(lock1);
    });
  });
  
  describe('release', () => {
    it('should release a lock successfully', async () => {
      const resource = 'test:resource:5';
      const ttl = 10000;
      
      const lockObj = await lock.acquire(resource, ttl);
      await lock.release(lockObj);
      
      // Should be able to acquire again
      const lockObj2 = await lock.acquire(resource, ttl);
      expect(lockObj2).toBeDefined();
      
      await lock.release(lockObj2);
    });
    
    it('should stop watchdog when releasing lock', async () => {
      const resource = 'test:resource:6';
      const ttl = 5000;
      
      const lockObj = await lock.acquire(resource, ttl, {
        autoExtend: true,
        extendInterval: 1000
      });
      
      expect(lock.watchdogs.has(lockObj.lockId)).toBe(true);
      
      await lock.release(lockObj);
      
      expect(lock.watchdogs.has(lockObj.lockId)).toBe(false);
    });
    
    it('should throw error for invalid lock object', async () => {
      await expect(lock.release(null))
        .rejects.toThrow('Invalid lock object');
      
      await expect(lock.release({}))
        .rejects.toThrow('Invalid lock object');
    });
  });
  
  describe('extend', () => {
    it('should extend lock TTL', async () => {
      const resource = 'test:resource:7';
      const ttl = 5000;
      
      const lockObj = await lock.acquire(resource, ttl);
      
      const success = await lock.extend(lockObj, 10000);
      expect(success).toBe(true);
      expect(lockObj.ttl).toBe(10000);
      
      await lock.release(lockObj);
    });
    
    it('should fail to extend released lock', async () => {
      const resource = 'test:resource:8';
      const ttl = 5000;
      
      const lockObj = await lock.acquire(resource, ttl);
      await lock.release(lockObj);
      
      const success = await lock.extend(lockObj, 10000);
      expect(success).toBe(false);
    });
  });
  
  describe('withLock', () => {
    it('should execute function with lock and auto-release', async () => {
      const resource = 'test:resource:9';
      const ttl = 10000;
      
      const result = await lock.withLock(resource, ttl, async () => {
        return { success: true, data: 'test' };
      });
      
      expect(result).toEqual({ success: true, data: 'test' });
      
      // Lock should be released
      const isLocked = await lock.isLocked(resource);
      expect(isLocked).toBe(false);
    });
    
    it('should release lock even if function throws', async () => {
      const resource = 'test:resource:10';
      const ttl = 10000;
      
      await expect(lock.withLock(resource, ttl, async () => {
        throw new Error('Test error');
      })).rejects.toThrow('Test error');
      
      // Lock should still be released
      const isLocked = await lock.isLocked(resource);
      expect(isLocked).toBe(false);
    });
  });
  
  describe('tryAcquire', () => {
    it('should return lock if available', async () => {
      const resource = 'test:resource:11';
      const ttl = 10000;
      
      const lockObj = await lock.tryAcquire(resource, ttl);
      expect(lockObj).toBeDefined();
      
      await lock.release(lockObj);
    });
    
    it('should return null if not available', async () => {
      const resource = 'test:resource:12';
      const ttl = 10000;
      
      const lock1 = await lock.acquire(resource, ttl);
      const lock2 = await lock.tryAcquire(resource, ttl);
      
      expect(lock2).toBeNull();
      
      await lock.release(lock1);
    });
  });
  
  describe('isLocked', () => {
    it('should return true when locked', async () => {
      const resource = 'test:resource:13';
      const ttl = 10000;
      
      await lock.acquire(resource, ttl);
      
      const isLocked = await lock.isLocked(resource);
      expect(isLocked).toBe(true);
    });
    
    it('should return false when not locked', async () => {
      const resource = 'test:resource:14';
      
      const isLocked = await lock.isLocked(resource);
      expect(isLocked).toBe(false);
    });
  });
  
  describe('getTTL', () => {
    it('should return remaining TTL', async () => {
      const resource = 'test:resource:15';
      const ttl = 10000;
      
      await lock.acquire(resource, ttl);
      
      const remainingTTL = await lock.getTTL(resource);
      expect(remainingTTL).toBeGreaterThan(0);
      expect(remainingTTL).toBeLessThanOrEqual(ttl);
    });
    
    it('should return -1 when not locked', async () => {
      const resource = 'test:resource:16';
      
      const ttl = await lock.getTTL(resource);
      expect(ttl).toBe(-1);
    });
  });
});

// ============================================================================
// ReadWriteLock Tests
// ============================================================================

describe('ReadWriteLock', () => {
  let distributedLock;
  let readWriteLock;
  
  beforeEach(() => {
    resetDistributedLock();
    
    distributedLock = new DistributedLock({
      servers: ['localhost:6379']
    });
    
    // Mock clients
    distributedLock.clients = [new MockRedis()];
    
    readWriteLock = new ReadWriteLock(distributedLock);
  });
  
  afterEach(async () => {
    await distributedLock.close();
  });
  
  describe('acquireRead', () => {
    it('should acquire read lock', async () => {
      const resource = 'test:read:1';
      const ttl = 10000;
      
      const lockObj = await readWriteLock.acquireRead(resource, ttl);
      expect(lockObj).toBeDefined();
      
      await readWriteLock.releaseRead(lockObj);
    });
    
    it('should fail when write lock is held', async () => {
      const resource = 'test:read:2';
      const ttl = 10000;
      
      // Acquire write lock
      const writeLock = await readWriteLock.acquireWrite(resource, ttl);
      
      // Try to acquire read lock
      await expect(readWriteLock.acquireRead(resource, ttl, { retryCount: 0 }))
        .rejects.toThrow('Resource is locked for writing');
      
      await readWriteLock.releaseWrite(writeLock);
    });
  });
  
  describe('acquireWrite', () => {
    it('should acquire write lock', async () => {
      const resource = 'test:write:1';
      const ttl = 10000;
      
      const lockObj = await readWriteLock.acquireWrite(resource, ttl);
      expect(lockObj).toBeDefined();
      
      await readWriteLock.releaseWrite(lockObj);
    });
    
    it('should fail when read lock is held', async () => {
      const resource = 'test:write:2';
      const ttl = 10000;
      
      // Acquire read lock
      const readLock = await readWriteLock.acquireRead(resource, ttl);
      
      // Try to acquire write lock
      await expect(readWriteLock.acquireWrite(resource, ttl, { retryCount: 0 }))
        .rejects.toThrow('Resource is already locked');
      
      await readWriteLock.releaseRead(readLock);
    });
  });
});

// ============================================================================
// ReentrantLock Tests
// ============================================================================

describe('ReentrantLock', () => {
  let distributedLock;
  let reentrantLock;
  
  beforeEach(() => {
    resetDistributedLock();
    
    distributedLock = new DistributedLock({
      servers: ['localhost:6379']
    });
    
    // Mock clients
    distributedLock.clients = [new MockRedis()];
    
    reentrantLock = new ReentrantLock(distributedLock);
  });
  
  afterEach(async () => {
    await distributedLock.close();
  });
  
  describe('acquire', () => {
    it('should acquire lock', async () => {
      const resource = 'test:reentrant:1';
      const ttl = 10000;
      
      const lockObj = await reentrantLock.acquire(resource, ttl);
      expect(lockObj).toBeDefined();
      
      await reentrantLock.release(lockObj);
    });
    
    it('should allow re-entry from same process', async () => {
      const resource = 'test:reentrant:2';
      const ttl = 10000;
      
      // First acquisition
      const lock1 = await reentrantLock.acquire(resource, ttl);
      
      // Second acquisition (re-entry) should succeed
      const lock2 = await reentrantLock.acquire(resource, ttl);
      
      expect(lock1.lockId).toBe(lock2.lockId);
      
      // Release twice
      await reentrantLock.release(lock2);
      await reentrantLock.release(lock1);
    });
  });
  
  describe('release', () => {
    it('should throw error if not held by current process', async () => {
      const lockObj = { resource: 'test:reentrant:3', lockId: 'invalid' };
      
      await expect(reentrantLock.release(lockObj))
        .rejects.toThrow('Lock not held by current process');
    });
  });
});

// ============================================================================
// DeadlockDetector Tests
// ============================================================================

describe('DeadlockDetector', () => {
  let detector;
  
  beforeEach(() => {
    resetDeadlockDetector();
    detector = new DeadlockDetector();
  });
  
  afterEach(() => {
    detector.stop();
    detector.reset();
  });
  
  describe('recordWait', () => {
    it('should record wait relationship', () => {
      detector.recordAcquire('resource:1', 'holder:1');
      detector.recordWait('waiter:1', 'resource:1');
      
      const stats = detector.getStats();
      expect(stats.totalWaits).toBe(1);
    });
    
    it('should not record wait for same holder', () => {
      detector.recordAcquire('resource:2', 'holder:2');
      detector.recordWait('holder:2', 'resource:2');
      
      const stats = detector.getStats();
      expect(stats.totalWaits).toBe(0);
    });
  });
  
  describe('detectDeadlocks', () => {
    it('should detect simple deadlock', () => {
      // Process A holds resource 1, waits for resource 2
      detector.recordAcquire('resource:1', 'process:A');
      detector.recordAcquire('resource:2', 'process:B');
      detector.recordWait('process:A', 'resource:2');
      detector.recordWait('process:B', 'resource:1');
      
      const detected = detector.detectDeadlocks();
      expect(detected).toBe(true);
      
      const stats = detector.getStats();
      expect(stats.detectionCount).toBeGreaterThan(0);
    });
    
    it('should not detect deadlock when no cycle', () => {
      detector.recordAcquire('resource:3', 'process:C');
      detector.recordWait('process:D', 'resource:3');
      
      const detected = detector.detectDeadlocks();
      expect(detected).toBe(false);
    });
    
    it('should return false when no waits', () => {
      const detected = detector.detectDeadlocks();
      expect(detected).toBe(false);
    });
  });
  
  describe('start/stop', () => {
    it('should start and stop detection', () => {
      detector.start(1000);
      expect(detector.checkInterval).toBeDefined();
      
      detector.stop();
      expect(detector.checkInterval).toBeNull();
    });
    
    it('should not start twice', () => {
      detector.start(1000);
      detector.start(1000);
      
      expect(detector.checkInterval).toBeDefined();
      
      detector.stop();
    });
  });
  
  describe('getStats', () => {
    it('should return correct stats', () => {
      detector.recordAcquire('resource:4', 'holder:4');
      detector.recordWait('waiter:4', 'resource:4');
      
      const stats = detector.getStats();
      
      expect(stats.totalWaits).toBe(1);
      expect(stats.totalHolders).toBe(1);
      expect(stats.detectionCount).toBe(0);
    });
  });
  
  describe('reset', () => {
    it('should clear all state', () => {
      detector.recordAcquire('resource:5', 'holder:5');
      detector.recordWait('waiter:5', 'resource:5');
      detector.detectDeadlocks();
      
      detector.reset();
      
      const stats = detector.getStats();
      expect(stats.totalWaits).toBe(0);
      expect(stats.totalHolders).toBe(0);
      expect(stats.detectionCount).toBe(0);
    });
  });
});

// Export test runner
module.exports = {
  run: () => {
    console.log('Running distributed lock tests...');
    // Tests are run by the test framework
  }
};
