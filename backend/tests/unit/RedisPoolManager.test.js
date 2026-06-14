// tests/unit/RedisPoolManager.test.js - Redis 连接池管理器单元测试
'use strict';

const { RedisPoolManager, ConnectionLeakDetector, HealthChecker } = require('../../../shared/RedisPoolManager');
const Redis = require('ioredis');

// Mock ioredis
jest.mock('ioredis');

describe('RedisPoolManager', () => {
  let manager;
  let mockRedisClient;

  beforeEach(() => {
    // 重置单例
    jest.clearAllMocks();

    // Mock Redis 客户端
    mockRedisClient = {
      ping: jest.fn().mockResolvedValue('PONG'),
      quit: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue('value'),
      set: jest.fn().mockResolvedValue('OK'),
      on: jest.fn(),
    };

    Redis.mockImplementation(() => mockRedisClient);
    Redis.Cluster = jest.fn().mockImplementation(() => mockRedisClient);

    manager = new RedisPoolManager({ serviceName: 'test-service' });
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
    }
  });

  describe('createPool', () => {
    it('should create a pool with default config', async () => {
      const pool = await manager.createPool('default');

      expect(pool).toBeDefined();
      expect(pool.name).toBe('default');
      expect(pool.connections.length).toBe(2); // minConnections
    });

    it('should create multiple pools', async () => {
      await manager.createPool('pool1');
      await manager.createPool('pool2');

      expect(manager.pools.size).toBe(2);
    });

    it('should return existing pool if already created', async () => {
      const pool1 = await manager.createPool('default');
      const pool2 = await manager.createPool('default');

      expect(pool1).toBe(pool2);
    });
  });

  describe('acquire and release', () => {
    beforeEach(async () => {
      await manager.createPool('default');
    });

    it('should acquire a connection', async () => {
      const connection = await manager.acquire('default');

      expect(connection).toBeDefined();
      expect(connection.id).toBeDefined();
      expect(connection.client).toBe(mockRedisClient);
    });

    it('should release a connection', async () => {
      const connection = await manager.acquire('default');
      await manager.release(connection, 'default');

      const stats = manager.getPoolStats('default');
      expect(stats.active).toBe(0);
      expect(stats.idle).toBeGreaterThan(0);
    });

    it('should track active connections', async () => {
      const conn1 = await manager.acquire('default');
      const conn2 = await manager.acquire('default');

      const stats = manager.getPoolStats('default');
      expect(stats.active).toBe(2);
    });
  });

  describe('execute', () => {
    beforeEach(async () => {
      await manager.createPool('default');
    });

    it('should execute a command', async () => {
      const result = await manager.execute('default', 'get', 'key');

      expect(result).toBe('value');
      expect(mockRedisClient.get).toHaveBeenCalledWith('key');
    });

    it('should handle command errors', async () => {
      mockRedisClient.set.mockRejectedValueOnce(new Error('Redis error'));

      await expect(manager.execute('default', 'set', 'key', 'value')).rejects.toThrow('Redis error');
    });
  });

  describe('getPoolStats', () => {
    beforeEach(async () => {
      await manager.createPool('default');
    });

    it('should return pool stats', () => {
      const stats = manager.getPoolStats('default');

      expect(stats).toBeDefined();
      expect(stats.name).toBe('default');
      expect(stats.total).toBeDefined();
      expect(stats.idle).toBeDefined();
      expect(stats.active).toBeDefined();
      expect(stats.waiting).toBeDefined();
    });

    it('should return null for non-existent pool', () => {
      const stats = manager.getPoolStats('nonexistent');
      expect(stats).toBeNull();
    });
  });

  describe('healthCheck', () => {
    beforeEach(async () => {
      await manager.createPool('default');
    });

    it('should return healthy status', async () => {
      const health = await manager.healthCheck('default');

      expect(health.status).toBe('healthy');
      expect(health.latency).toBeGreaterThanOrEqual(0);
    });

    it('should return unhealthy status on ping failure', async () => {
      mockRedisClient.ping.mockRejectedValueOnce(new Error('Connection refused'));

      const health = await manager.healthCheck('default');

      expect(health.status).toBe('unhealthy');
    });
  });

  describe('resetPool', () => {
    beforeEach(async () => {
      await manager.createPool('default');
    });

    it('should reset pool connections', async () => {
      const conn1 = await manager.acquire('default');
      const conn2 = await manager.acquire('default');

      await manager.resetPool('default');

      const stats = manager.getPoolStats('default');
      expect(stats.active).toBe(0);
    });
  });

  describe('close', () => {
    it('should close all pools', async () => {
      await manager.createPool('default');
      await manager.close();

      expect(manager.pools.size).toBe(0);
      expect(mockRedisClient.quit).toHaveBeenCalled();
    });
  });
});

describe('ConnectionLeakDetector', () => {
  let detector;

  beforeEach(() => {
    detector = new ConnectionLeakDetector(1000, 'test-service'); // 1 秒阈值
  });

  it('should track connection acquisition', () => {
    detector.trackAcquire('conn-1');
    detector.trackAcquire('conn-2');

    expect(detector.getTrackedCount()).toBe(2);
  });

  it('should track connection release', () => {
    detector.trackAcquire('conn-1');
    detector.trackRelease('conn-1');

    expect(detector.getTrackedCount()).toBe(0);
  });

  it('should detect leaked connections', async () => {
    detector.trackAcquire('conn-1');

    // 等待超过阈值
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const leaks = detector.detectLeaks();
    expect(leaks.length).toBe(1);
    expect(leaks[0].id).toBe('conn-1');
  });

  it('should not detect non-leaked connections', async () => {
    detector.trackAcquire('conn-1');
    detector.trackAcquire('conn-2');

    // 立即检测（未超过阈值）
    const leaks = detector.detectLeaks();
    expect(leaks.length).toBe(0);
  });

  it('should clear all tracked connections', () => {
    detector.trackAcquire('conn-1');
    detector.trackAcquire('conn-2');
    detector.clear();

    expect(detector.getTrackedCount()).toBe(0);
  });
});

describe('HealthChecker', () => {
  let checker;
  let mockClient;

  beforeEach(() => {
    mockClient = {
      ping: jest.fn().mockResolvedValue('PONG'),
    };

    checker = new HealthChecker('test-pool', {
      checkInterval: 1000,
      latencyThreshold: 100,
    });
  });

  afterEach(() => {
    checker.stop();
  });

  it('should return healthy status for low latency', async () => {
    const result = await checker.check(mockClient);

    expect(result.status).toBe('healthy');
    expect(result.latency).toBeLessThan(50);
  });

  it('should return degraded status for medium latency', async () => {
    // 模拟延迟
    mockClient.ping.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve('PONG'), 60))
    );

    const result = await checker.check(mockClient);

    expect(result.status).toBe('degraded');
  });

  it('should return unhealthy status for high latency', async () => {
    mockClient.ping.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve('PONG'), 150))
    );

    const result = await checker.check(mockClient);

    expect(result.status).toBe('unhealthy');
  });

  it('should return unhealthy status on ping failure', async () => {
    mockClient.ping.mockRejectedValueOnce(new Error('Connection refused'));

    const result = await checker.check(mockClient);

    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('Connection refused');
  });

  it('should start and stop periodic checks', () => {
    checker.start(mockClient);
    expect(checker.timer).toBeDefined();

    checker.stop();
    expect(checker.timer).toBeNull();
  });
});
