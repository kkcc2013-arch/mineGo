'use strict';

/**
 * REQ-00508: 服务发现与动态负载均衡健康检查系统 - 单元测试
 */

const { HealthChecker, ServiceRegistry, LoadBalancer } = require('./index');

// Mock HTTP request
jest.mock('http', () => ({
  request: jest.fn((options, callback) => {
    const mockResponse = {
      statusCode: 200,
      on: jest.fn((event, handler) => {
        if (event === 'data') handler('{}');
        if (event === 'end') handler();
      })
    };
    callback(mockResponse);
    return {
      on: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn()
    };
  })
}));

// Mock Redis client
const mockRedisClient = {
  setex: jest.fn().mockResolvedValue(true),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(true),
  sadd: jest.fn().mockResolvedValue(true),
  srem: jest.fn().mockResolvedValue(true),
  smembers: jest.fn().mockResolvedValue([])
};

describe('HealthChecker', () => {
  let healthChecker;

  beforeEach(() => {
    healthChecker = new HealthChecker({
      checkIntervalMs: 5000,
      timeoutMs: 2000,
      failureThreshold: 3,
      successThreshold: 2
    });
  });

  afterEach(() => {
    healthChecker.shutdown();
  });

  test('should register service instance', () => {
    const instanceId = healthChecker.register({
      name: 'user-service',
      host: 'localhost',
      port: 3001,
      healthPath: '/health'
    });

    expect(instanceId).toBeDefined();
    expect(healthChecker.services.size).toBe(1);
    expect(healthChecker.timers.has(instanceId)).toBe(true);
  });

  test('should deregister service instance', () => {
    const instanceId = healthChecker.register({
      name: 'user-service',
      host: 'localhost',
      port: 3001
    });

    healthChecker.deregister(instanceId);
    expect(healthChecker.services.size).toBe(0);
    expect(healthChecker.timers.has(instanceId)).toBe(false);
  });

  test('should emit registered event', () => {
    const callback = jest.fn();
    healthChecker.on('registered', callback);

    healthChecker.register({
      name: 'pokemon-service',
      host: 'localhost',
      port: 3002
    });

    expect(callback).toHaveBeenCalled();
  });

  test('should return healthy instances', () => {
    healthChecker.register({
      name: 'gateway',
      host: 'localhost',
      port: 3000
    });

    // 手动设置状态为 healthy
    const instance = Array.from(healthChecker.services.values())[0];
    instance.status = 'healthy';

    const healthy = healthChecker.getHealthyInstances('gateway');
    expect(healthy.length).toBe(1);
  });

  test('should return stats', () => {
    healthChecker.register({ name: 'service-a', host: 'localhost', port: 3001 });
    healthChecker.register({ name: 'service-b', host: 'localhost', port: 3002 });

    const stats = healthChecker.getStats();
    expect(stats.total).toBe(2);
  });
});

describe('ServiceRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new ServiceRegistry({
      redisClient: mockRedisClient,
      heartbeatIntervalMs: 10000,
      ttlSeconds: 30
    });
  });

  afterEach(async () => {
    await registry.shutdown();
  });

  test('should register service instance', async () => {
    const instanceId = await registry.register({
      name: 'catch-service',
      host: 'localhost',
      port: 3003,
      weight: 100
    });

    expect(instanceId).toBeDefined();
    expect(registry.localRegistry.size).toBe(1);
    expect(mockRedisClient.setex).toHaveBeenCalled();
  });

  test('should deregister service instance', async () => {
    const instanceId = await registry.register({
      name: 'catch-service',
      host: 'localhost',
      port: 3003
    });

    await registry.deregister(instanceId);
    expect(registry.localRegistry.size).toBe(0);
    expect(mockRedisClient.del).toHaveBeenCalled();
  });

  test('should discover services', async () => {
    await registry.register({ name: 'gym-service', host: 'localhost', port: 3004 });
    
    const instances = await registry.discover('gym-service');
    expect(instances.length).toBe(1);
    expect(instances[0].name).toBe('gym-service');
  });

  test('should update instance status', async () => {
    const instanceId = await registry.register({
      name: 'social-service',
      host: 'localhost',
      port: 3005
    });

    await registry.updateStatus(instanceId, 'unhealthy');
    
    const instance = registry.localRegistry.get(instanceId);
    expect(instance.status).toBe('unhealthy');
  });

  test('should update instance weight', async () => {
    const instanceId = await registry.register({
      name: 'reward-service',
      host: 'localhost',
      port: 3006,
      weight: 100
    });

    await registry.updateWeight(instanceId, 50);
    
    const instance = registry.localRegistry.get(instanceId);
    expect(instance.weight).toBe(50);
  });

  test('should select instance using round-robin', async () => {
    await registry.register({ name: 'payment-service', host: 'host1', port: 3007 });
    await registry.register({ name: 'payment-service', host: 'host2', port: 3007 });

    const instance1 = await registry.getOne('payment-service', 'round-robin');
    const instance2 = await registry.getOne('payment-service', 'round-robin');

    // 轮询应该返回不同实例
    expect(instance1).toBeDefined();
    expect(instance2).toBeDefined();
  });

  test('should select instance using weighted strategy', async () => {
    await registry.register({ name: 'location-service', host: 'host1', port: 3008, weight: 80 });
    await registry.register({ name: 'location-service', host: 'host2', port: 3008, weight: 20 });

    const instance = await registry.getOne('location-service', 'weighted');
    expect(instance).toBeDefined();
  });
});

describe('LoadBalancer', () => {
  let loadBalancer;
  let mockRegistry;
  let mockHealthChecker;

  beforeEach(() => {
    mockRegistry = {
      localRegistry: new Map(),
      discover: jest.fn().mockResolvedValue([
        { id: 'inst1', name: 'test-service', host: 'host1', port: 3000, weight: 100, status: 'healthy' },
        { id: 'inst2', name: 'test-service', host: 'host2', port: 3000, weight: 100, status: 'healthy' }
      ]),
      updateWeight: jest.fn().mockResolvedValue(true)
    };

    mockHealthChecker = {
      getHealthyInstances: jest.fn().mockReturnValue([
        { id: 'inst1', name: 'test-service', host: 'host1', port: 3000, weight: 100, status: 'healthy' },
        { id: 'inst2', name: 'test-service', host: 'host2', port: 3000, weight: 100, status: 'healthy' }
      ]),
      on: jest.fn()
    };

    loadBalancer = new LoadBalancer({
      serviceRegistry: mockRegistry,
      healthChecker: mockHealthChecker,
      defaultStrategy: 'round-robin'
    });
  });

  test('should select instance using round-robin', async () => {
    const instance = await loadBalancer.select('test-service', 'round-robin');
    expect(instance).toBeDefined();
    expect(instance.name).toBe('test-service');
  });

  test('should select instance using random strategy', async () => {
    const instance = await loadBalancer.select('test-service', 'random');
    expect(instance).toBeDefined();
  });

  test('should select instance using least-connections strategy', async () => {
    // 模拟一些连接
    loadBalancer._connections.set('inst1', 5);
    loadBalancer._connections.set('inst2', 2);

    const instance = await loadBalancer.select('test-service', 'least-connections');
    expect(instance.id).toBe('inst2');  // 应该选择连接数少的
  });

  test('should track connections', async () => {
    await loadBalancer.select('test-service');
    
    // 应该有连接计数
    expect(loadBalancer._connections.size).toBeGreaterThan(0);
  });

  test('should release connection', async () => {
    loadBalancer._connections.set('inst1', 3);
    loadBalancer.release('inst1');
    
    expect(loadBalancer._connections.get('inst1')).toBe(2);
  });

  test('should adjust weight', async () => {
    mockRegistry.localRegistry.set('inst1', { id: 'inst1', weight: 100 });
    
    await loadBalancer.adjustWeight('inst1', -20);
    expect(mockRegistry.updateWeight).toHaveBeenCalledWith('inst1', 80);
  });

  test('should auto-adjust weight based on response time', async () => {
    mockRegistry.localRegistry.set('inst1', { id: 'inst1', weight: 100 });
    
    // 响应时间过长，应降低权重
    await loadBalancer.autoAdjustWeight('inst1', 600);
    expect(mockRegistry.updateWeight).toHaveBeenCalledWith('inst1', 90);
  });

  test('should emit events', async () => {
    const callback = jest.fn();
    loadBalancer.on('selected', callback);

    await loadBalancer.select('test-service');
    expect(callback).toHaveBeenCalled();
  });
});

describe('createSystem', () => {
  test('should create complete system', () => {
    const { createSystem } = require('./index');
    
    const system = createSystem({
      registry: { redisClient: mockRedisClient },
      healthChecker: { checkIntervalMs: 5000 },
      loadBalancer: { defaultStrategy: 'round-robin' }
    });

    expect(system.registry).toBeDefined();
    expect(system.healthChecker).toBeDefined();
    expect(system.loadBalancer).toBeDefined();
    expect(system.registerService).toBeDefined();
    expect(system.deregisterService).toBeDefined();
  });
});