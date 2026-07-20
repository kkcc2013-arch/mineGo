// backend/tests/unit/service-discovery-client.test.js
// REQ-00607: 服务发现客户端单元测试

const { ServiceDiscoveryClient, LoadBalanceStrategy } = require('../../shared/serviceDiscovery/ServiceDiscoveryClient');

// Mock Redis
const mockRedis = {
  hset: jest.fn().mockResolvedValue(1),
  hgetall: jest.fn().mockResolvedValue({
    'instance-1': JSON.stringify({
      instanceId: 'instance-1',
      serviceName: 'test-service',
      host: 'localhost',
      port: 3000,
      weight: 1,
      lastHeartbeat: Date.now()
    }),
    'instance-2': JSON.stringify({
      instanceId: 'instance-2',
      serviceName: 'test-service',
      host: 'localhost',
      port: 3001,
      weight: 2,
      lastHeartbeat: Date.now()
    })
  }),
  hget: jest.fn().mockResolvedValue(JSON.stringify({
    instanceId: 'instance-1',
    serviceName: 'test-service',
    host: 'localhost',
    port: 3000
  })),
  hdel: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1)
};

jest.mock('../../shared/redis', () => ({
  getRedis: () => mockRedis
}));

jest.mock('../../shared/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../shared/metrics', () => ({
  Counter: class Counter {
    constructor() { this.value = 0; }
    inc() { this.value++; }
  },
  Gauge: class Gauge {
    constructor() { this.value = 0; }
    set(val) { this.value = val; }
  },
  Histogram: class Histogram {
    constructor() { this.values = []; }
    observe(val) { this.values.push(val); }
  }
}));

describe('ServiceDiscoveryClient', () => {
  let client;
  
  beforeEach(() => {
    client = new ServiceDiscoveryClient({
      redisClient: mockRedis,
      cacheTTL: 30000
    });
    jest.clearAllMocks();
  });
  
  afterEach(async () => {
    await client.close();
  });
  
  describe('register', () => {
    it('should register a service instance', async () => {
      const instanceId = await client.register('test-service', {
        host: 'localhost',
        port: 3000
      });
      
      expect(instanceId).toBeDefined();
      expect(instanceId).toContain('test-service');
      expect(mockRedis.hset).toHaveBeenCalled();
    });
    
    it('should use provided instanceId', async () => {
      const instanceId = await client.register('test-service', {
        instanceId: 'custom-id',
        host: 'localhost',
        port: 3000
      });
      
      expect(instanceId).toBe('custom-id');
    });
  });
  
  describe('discover', () => {
    it('should discover service instances', async () => {
      const result = await client.discover('test-service');
      
      expect(result.instances).toBeDefined();
      expect(result.instances.length).toBe(2);
      expect(result.selected).toBeDefined();
      expect(result.strategy).toBe(LoadBalanceStrategy.ROUND_ROBIN);
    });
    
    it('should use cache for subsequent calls', async () => {
      // First call
      await client.discover('test-service');
      const callCount1 = mockRedis.hgetall.mock.calls.length;
      
      // Second call (should use cache)
      await client.discover('test-service');
      const callCount2 = mockRedis.hgetall.mock.calls.length;
      
      expect(callCount2).toBe(callCount1); // Should not call Redis again
    });
    
    it('should return empty array when no instances found', async () => {
      mockRedis.hgetall.mockResolvedValueOnce({});
      
      const result = await client.discover('nonexistent-service');
      
      expect(result.instances).toEqual([]);
      expect(result.selected).toBeNull();
    });
  });
  
  describe('selectInstance', () => {
    it('should select instance using round-robin strategy', () => {
      const instances = [
        { instanceId: '1', serviceName: 'test', weight: 1 },
        { instanceId: '2', serviceName: 'test', weight: 1 },
        { instanceId: '3', serviceName: 'test', weight: 1 }
      ];
      
      const first = client.selectInstance(instances, LoadBalanceStrategy.ROUND_ROBIN);
      const second = client.selectInstance(instances, LoadBalanceStrategy.ROUND_ROBIN);
      const third = client.selectInstance(instances, LoadBalanceStrategy.ROUND_ROBIN);
      
      expect(first.instanceId).toBe('1');
      expect(second.instanceId).toBe('2');
      expect(third.instanceId).toBe('3');
    });
    
    it('should select instance using weighted strategy', () => {
      const instances = [
        { instanceId: 'low', serviceName: 'test', weight: 1 },
        { instanceId: 'high', serviceName: 'test', weight: 10 }
      ];
      
      // Weighted should prefer 'high' most of the time
      let highCount = 0;
      for (let i = 0; i < 100; i++) {
        const selected = client.selectInstance(instances, LoadBalanceStrategy.WEIGHTED);
        if (selected.instanceId === 'high') highCount++;
      }
      
      expect(highCount).toBeGreaterThan(80); // ~91% should be 'high'
    });
    
    it('should return null when instances is empty', () => {
      const selected = client.selectInstance([], LoadBalanceStrategy.ROUND_ROBIN);
      expect(selected).toBeNull();
    });
  });
  
  describe('heartbeat', () => {
    it('should update lastHeartbeat', async () => {
      await client.heartbeat('instance-1', 'test-service');
      
      expect(mockRedis.hget).toHaveBeenCalledWith(
        'service:discovery:test-service',
        'instance-1'
      );
      expect(mockRedis.hset).toHaveBeenCalled();
    });
  });
  
  describe('deregister', () => {
    it('should deregister a service instance', async () => {
      await client.deregister('instance-1', 'test-service');
      
      expect(mockRedis.hdel).toHaveBeenCalledWith(
        'service:discovery:test-service',
        'instance-1'
      );
    });
  });
  
  describe('markFailure / markSuccess', () => {
    it('should increment failure count', () => {
      client.markFailure('instance-1');
      client.markFailure('instance-1');
      client.markFailure('instance-1');
      
      expect(client.failureCounts.get('instance-1')).toBe(3);
    });
    
    it('should recover after enough successes', () => {
      client.markFailure('instance-1');
      client.markFailure('instance-1');
      
      // Need 5 successes to recover
      for (let i = 0; i < 5; i++) {
        client.markSuccess('instance-1');
      }
      
      expect(client.failureCounts.has('instance-1')).toBe(false);
    });
  });
  
  describe('clearCache', () => {
    it('should clear cache for specific service', async () => {
      // Populate cache
      await client.discover('test-service');
      
      expect(client.serviceCache.has('test-service')).toBe(true);
      
      // Clear cache
      client.clearCache('test-service');
      
      expect(client.serviceCache.has('test-service')).toBe(false);
    });
    
    it('should clear all cache when no service specified', async () => {
      await client.discover('test-service');
      await client.discover('another-service');
      
      client.clearCache();
      
      expect(client.serviceCache.size).toBe(0);
    });
  });
});

describe('LoadBalanceStrategy', () => {
  it('should export all strategies', () => {
    expect(LoadBalanceStrategy.ROUND_ROBIN).toBe('round-robin');
    expect(LoadBalanceStrategy.WEIGHTED).toBe('weighted');
    expect(LoadBalanceStrategy.LEAST_CONNECTIONS).toBe('least-connections');
    expect(LoadBalanceStrategy.RANDOM).toBe('random');
  });
});
