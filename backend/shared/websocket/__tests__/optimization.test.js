'use strict';

/**
 * WebSocket 优化模块单元测试
 */

const AdaptiveConnectionPool = require('../AdaptiveConnectionPool');
const ConnectionObjectPool = require('../ConnectionObjectPool');
const PriorityTaskScheduler = require('../PriorityTaskScheduler');
const BandwidthAdaptiveQueue = require('../BandwidthAdaptiveQueue');

// 模拟 logger 和 metrics
jest.mock('../../index', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn()
  },
  metrics: {
    gauge: jest.fn(() => ({ set: jest.fn() })),
    counter: jest.fn(() => ({ inc: jest.fn() })),
    histogram: jest.fn(() => ({ observe: jest.fn() }))
  }
}));

describe('AdaptiveConnectionPool', () => {
  let pool;
  
  beforeEach(() => {
    pool = new AdaptiveConnectionPool({
      minConnections: 100,
      maxConnections: 1000,
      initialMaxConnections: 500,
      monitorInterval: 1000
    });
  });
  
  afterEach(() => {
    pool.close();
  });
  
  test('should initialize with correct values', () => {
    expect(pool.getCurrentMax()).toBe(500);
    expect(pool.canAcceptConnection()).toBe(true);
  });
  
  test('should update current connections', () => {
    pool.updateCurrentConnections(400);
    expect(pool.state.currentConnections).toBe(400);
  });
  
  test('should allow connections under limit', () => {
    pool.updateCurrentConnections(400);
    expect(pool.canAcceptConnection()).toBe(true);
  });
  
  test('should deny connections at limit', () => {
    pool.updateCurrentConnections(500);
    expect(pool.canAcceptConnection()).toBe(false);
  });
  
  test('should provide status information', () => {
    const status = pool.getStatus();
    expect(status).toHaveProperty('currentMax');
    expect(status).toHaveProperty('currentConnections');
    expect(status).toHaveProperty('utilization');
    expect(status).toHaveProperty('config');
  });
});

describe('ConnectionObjectPool', () => {
  let objectPool;
  
  beforeEach(() => {
    objectPool = new ConnectionObjectPool({
      initialSize: 10,
      maxSize: 100
    });
  });
  
  afterEach(() => {
    objectPool.close();
  });
  
  test('should initialize with correct size', () => {
    const stats = objectPool.getStats();
    expect(stats.poolSize).toBe(10);
  });
  
  test('should acquire and release objects', () => {
    const obj = objectPool.acquire();
    expect(obj).toBeDefined();
    expect(obj.state).toBe('active');
    
    const statsAfterAcquire = objectPool.getStats();
    expect(statsAfterAcquire.inUse).toBe(1);
    
    objectPool.release(obj);
    const statsAfterRelease = objectPool.getStats();
    expect(statsAfterRelease.inUse).toBe(0);
  });
  
  test('should reuse objects', () => {
    const obj1 = objectPool.acquire();
    objectPool.release(obj1);
    
    const obj2 = objectPool.acquire();
    expect(obj2).toBe(obj1); // Should reuse the same object
  });
  
  test('should create new objects when pool is empty', () => {
    // Drain the pool
    const objects = [];
    for (let i = 0; i < 15; i++) {
      objects.push(objectPool.acquire());
    }
    
    const stats = objectPool.getStats();
    expect(stats.inUse).toBe(15);
    
    // Return all objects
    objects.forEach(obj => objectPool.release(obj));
  });
  
  test('should provide statistics', () => {
    objectPool.acquire();
    const stats = objectPool.getStats();
    
    expect(stats).toHaveProperty('poolSize');
    expect(stats).toHaveProperty('inUse');
    expect(stats).toHaveProperty('created');
    expect(stats).toHaveProperty('reused');
  });
});

describe('PriorityTaskScheduler', () => {
  let scheduler;
  
  beforeEach(() => {
    scheduler = new PriorityTaskScheduler({
      maxConcurrent: 5,
      queueLimit: 100,
      scheduleInterval: 5
    });
  });
  
  afterEach(async () => {
    await scheduler.close();
  });
  
  test('should schedule tasks', () => {
    const task = jest.fn();
    const result = scheduler.schedule(task, 'normal');
    expect(result).toBe(true);
    expect(scheduler.stats.totalScheduled).toBe(1);
  });
  
  test('should reject invalid priority', () => {
    const task = jest.fn();
    const result = scheduler.schedule(task, 'invalid');
    expect(result).toBe(false);
  });
  
  test('should respect queue limit', () => {
    const task = jest.fn();
    scheduler.config.queueLimit = 2;
    
    scheduler.schedule(task, 'normal');
    scheduler.schedule(task, 'normal');
    const result = scheduler.schedule(task, 'normal');
    
    expect(result).toBe(false);
    expect(scheduler.stats.totalDropped).toBe(1);
  });
  
  test('should provide status information', () => {
    scheduler.schedule(() => {}, 'high');
    const status = scheduler.getStatus();
    
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('currentTasks');
    expect(status).toHaveProperty('queues');
    expect(status).toHaveProperty('stats');
  });
});

describe('BandwidthAdaptiveQueue', () => {
  let queue;
  
  beforeEach(() => {
    queue = new BandwidthAdaptiveQueue({
      maxQueueSize: 100,
      minBatchSize: 1,
      maxBatchSize: 10
    });
  });
  
  afterEach(() => {
    queue.close();
  });
  
  test('should enqueue messages', () => {
    const result = queue.enqueue({ type: 'test', data: 'hello' });
    expect(result).toBe(true);
    expect(queue.queue.length).toBe(1);
  });
  
  test('should reject when queue full', () => {
    queue.config.maxQueueSize = 2;
    
    queue.enqueue({ type: 'test' });
    queue.enqueue({ type: 'test' });
    const result = queue.enqueue({ type: 'test' });
    
    expect(result).toBe(false);
  });
  
  test('should get batches', () => {
    queue.enqueue({ type: 'test', data: 'msg1' });
    queue.enqueue({ type: 'test', data: 'msg2' });
    
    const batch = queue.getBatch();
    expect(batch).toBeDefined();
    expect(batch.messages.length).toBeGreaterThan(0);
  });
  
  test('should return null when empty', () => {
    const batch = queue.getBatch();
    expect(batch).toBeNull();
  });
  
  test('should track bytes sent', () => {
    queue.recordBytesSent(100);
    queue.recordBytesSent(200);
    
    expect(queue.stats.totalBytes).toBe(300);
  });
  
  test('should provide statistics', () => {
    queue.enqueue({ type: 'test' });
    const stats = queue.getStats();
    
    expect(stats).toHaveProperty('totalQueued');
    expect(stats).toHaveProperty('bandwidth');
    expect(stats).toHaveProperty('strategy');
  });
  
  test('should provide current strategy', () => {
    queue.enqueue({ type: 'test' });
    const strategy = queue.getCurrentStrategy();
    
    expect(strategy).toHaveProperty('batchSize');
    expect(strategy).toHaveProperty('batchTimeout');
    expect(strategy).toHaveProperty('bandwidth');
    expect(strategy).toHaveProperty('queueLength');
  });
});

describe('Integration: All Components', () => {
  test('should work together', async () => {
    const adaptivePool = new AdaptiveConnectionPool({
      monitorInterval: 100
    });
    const objectPool = new ConnectionObjectPool();
    const scheduler = new PriorityTaskScheduler({
      scheduleInterval: 5
    });
    const bandwidthQueue = new BandwidthAdaptiveQueue();
    
    // Simulate workflow
    const connObj = objectPool.acquire();
    adaptivePool.updateCurrentConnections(100);
    
    scheduler.schedule(() => {
      bandwidthQueue.enqueue({ type: 'ping' });
    }, 'normal');
    
    bandwidthQueue.enqueue({ type: 'message', data: 'test' });
    const batch = bandwidthQueue.getBatch();
    
    expect(batch).toBeDefined();
    expect(batch.messages.length).toBeGreaterThan(0);
    
    // Cleanup
    objectPool.release(connObj);
    adaptivePool.close();
    await scheduler.close();
    bandwidthQueue.close();
  });
});
