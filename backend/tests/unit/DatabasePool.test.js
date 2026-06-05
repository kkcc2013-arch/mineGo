// tests/unit/DatabasePool.test.js
'use strict';

const { DatabasePoolManager, SERVICE_POOL_CONFIG, POOL_MANAGER_CONFIG } = require('../../backend/shared/DatabasePool');

// Mock pg module
jest.mock('pg', () => {
  const mockPool = {
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0,
    options: { max: 10 },
    on: jest.fn(),
    query: jest.fn().mockResolvedValue({ rows: [{ 1: 1 }], rowCount: 1 }),
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: jest.fn(),
    }),
    end: jest.fn().mockResolvedValue(undefined),
  };
  
  return {
    Pool: jest.fn().mockImplementation(() => mockPool),
  };
});

// Mock logger
jest.mock('../../backend/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('DatabasePoolManager', () => {
  let poolManager;
  
  beforeEach(() => {
    // Create new instance for each test
    poolManager = new DatabasePoolManager();
  });
  
  afterEach(async () => {
    // Clean up
    if (poolManager) {
      await poolManager.closeAll();
    }
  });

  describe('Constructor', () => {
    test('should initialize with empty pools map', () => {
      expect(poolManager.pools).toBeInstanceOf(Map);
      expect(poolManager.pools.size).toBe(0);
    });

    test('should have default configuration', () => {
      expect(poolManager.config.idleTimeoutMillis).toBe(30000);
      expect(poolManager.config.connectionTimeoutMillis).toBe(3000);
      expect(poolManager.config.scaleUpThreshold).toBe(0.80);
      expect(poolManager.config.scaleDownThreshold).toBe(0.30);
    });

    test('should have service-specific configurations', () => {
      expect(poolManager.serviceConfigs['user-service']).toBeDefined();
      expect(poolManager.serviceConfigs['user-service'].max).toBe(12);
      expect(poolManager.serviceConfigs['catch-service'].max).toBe(12);
      expect(poolManager.serviceConfigs['payment-service'].max).toBe(10);
    });
  });

  describe('getPoolName', () => {
    test('should generate pool name from service name', () => {
      const poolName = poolManager.getPoolName('user-service');
      expect(poolName).toBe('pool-user-service');
    });

    test('should handle default service name', () => {
      const poolName = poolManager.getPoolName('default');
      expect(poolName).toBe('pool-default');
    });
  });

  describe('getPool', () => {
    test('should create pool if not exists', () => {
      const pool = poolManager.getPool('user-service');
      expect(pool).toBeDefined();
      expect(poolManager.pools.size).toBe(1);
    });

    test('should return existing pool if already created', () => {
      const pool1 = poolManager.getPool('user-service');
      const pool2 = poolManager.getPool('user-service');
      
      expect(pool1).toBe(pool2);
      expect(poolManager.pools.size).toBe(1);
    });

    test('should create separate pools for different services', () => {
      poolManager.getPool('user-service');
      poolManager.getPool('catch-service');
      
      expect(poolManager.pools.size).toBe(2);
    });

    test('should apply service-specific config', () => {
      poolManager.getPool('user-service');
      const state = poolManager.pools.get('pool-user-service');
      
      expect(state.config.max).toBe(12);
      expect(state.config.min).toBe(3);
    });

    test('should apply custom options', () => {
      poolManager.getPool('custom-service', { max: 15, min: 5 });
      const state = poolManager.pools.get('pool-custom-service');
      
      expect(state.config.max).toBe(15);
      expect(state.config.min).toBe(5);
    });
  });

  describe('getStats', () => {
    test('should return empty object when no pools', () => {
      const stats = poolManager.getStats();
      expect(stats).toEqual({});
    });

    test('should return stats for all pools', () => {
      poolManager.getPool('user-service');
      poolManager.getPool('catch-service');
      
      const stats = poolManager.getStats();
      
      expect(stats['pool-user-service']).toBeDefined();
      expect(stats['pool-catch-service']).toBeDefined();
      
      expect(stats['pool-user-service'].total).toBe(5);
      expect(stats['pool-user-service'].idle).toBe(3);
      expect(stats['pool-user-service'].waiting).toBe(0);
      expect(stats['pool-user-service'].max).toBe(10);
    });

    test('should calculate usage correctly', () => {
      poolManager.getPool('user-service');
      const stats = poolManager.getStats();
      
      // Usage = (total - idle) / max * 100 = (5 - 3) / 10 * 100 = 20%
      expect(stats['pool-user-service'].usage).toBe(20);
    });
  });

  describe('getAggregateStats', () => {
    test('should return aggregate statistics', () => {
      poolManager.getPool('user-service');
      poolManager.getPool('catch-service');
      
      const stats = poolManager.getAggregateStats();
      
      expect(stats.totalPools).toBe(2);
      expect(stats.totalConnections).toBe(10); // 5 per pool
      expect(stats.totalIdle).toBe(6); // 3 per pool
      expect(stats.maxConnections).toBe(20); // 10 per pool
      expect(stats.monthlyCostEstimate).toBe(40); // 20 * $2
    });
  });

  describe('query', () => {
    test('should execute query on pool', async () => {
      const result = await poolManager.query('user-service', 'SELECT 1');
      
      expect(result).toBeDefined();
      expect(result.rows).toEqual([{ 1: 1 }]);
    });
  });

  describe('transaction', () => {
    test('should execute transaction successfully', async () => {
      const callback = jest.fn().mockResolvedValue({ success: true });
      const result = await poolManager.transaction('user-service', callback);
      
      expect(result).toEqual({ success: true });
      expect(callback).toHaveBeenCalled();
    });
  });

  describe('healthCheck', () => {
    test('should return health status for all pools', async () => {
      poolManager.getPool('user-service');
      poolManager.getPool('catch-service');
      
      const health = await poolManager.healthCheck();
      
      expect(health['pool-user-service']).toBeDefined();
      expect(health['pool-user-service'].healthy).toBe(true);
      expect(health['pool-catch-service']).toBeDefined();
      expect(health['pool-catch-service'].healthy).toBe(true);
    });
  });

  describe('closeAll', () => {
    test('should close all pools', async () => {
      poolManager.getPool('user-service');
      poolManager.getPool('catch-service');
      
      await poolManager.closeAll();
      
      expect(poolManager.pools.size).toBe(0);
    });

    test('should clear intervals', async () => {
      poolManager.getPool('user-service');
      poolManager.startMetricsCollection();
      
      await poolManager.closeAll();
      
      expect(poolManager.metricsInterval).toBeNull();
      expect(poolManager.scaleInterval).toBeNull();
    });
  });

  describe('Dynamic Scaling', () => {
    test('should not scale if disabled', () => {
      poolManager.config.enableDynamicSizing = false;
      poolManager.getPool('user-service');
      
      expect(poolManager.scaleInterval).toBeNull();
    });

    test('should start scaling if enabled', () => {
      poolManager.config.enableDynamicSizing = true;
      poolManager.getPool('user-service');
      poolManager.startDynamicScaling();
      
      expect(poolManager.scaleInterval).toBeDefined();
    });
  });
});

describe('SERVICE_POOL_CONFIG', () => {
  test('should have configurations for all services', () => {
    const expectedServices = [
      'user-service',
      'catch-service',
      'payment-service',
      'gateway',
      'location-service',
      'pokemon-service',
      'gym-service',
      'reward-service',
      'social-service',
      'default',
    ];
    
    expectedServices.forEach(service => {
      expect(SERVICE_POOL_CONFIG[service]).toBeDefined();
      expect(SERVICE_POOL_CONFIG[service].max).toBeGreaterThan(0);
      expect(SERVICE_POOL_CONFIG[service].min).toBeGreaterThan(0);
    });
  });

  test('should have higher limits for core services', () => {
    expect(SERVICE_POOL_CONFIG['user-service'].max).toBe(12);
    expect(SERVICE_POOL_CONFIG['catch-service'].max).toBe(12);
    expect(SERVICE_POOL_CONFIG['payment-service'].max).toBe(10);
    
    // Non-core services should have lower limits
    expect(SERVICE_POOL_CONFIG['reward-service'].max).toBeLessThan(
      SERVICE_POOL_CONFIG['user-service'].max
    );
  });

  test('should sum to reasonable total', () => {
    const totalMax = Object.values(SERVICE_POOL_CONFIG)
      .filter(c => c !== SERVICE_POOL_CONFIG['default'])
      .reduce((sum, config) => sum + config.max, 0);
    
    // Total should be less than 160 (original limit)
    expect(totalMax).toBeLessThan(160);
    // But enough for operations
    expect(totalMax).toBeGreaterThan(50);
  });
});

describe('POOL_MANAGER_CONFIG', () => {
  test('should have sensible defaults', () => {
    expect(POOL_MANAGER_CONFIG.idleTimeoutMillis).toBe(30000);
    expect(POOL_MANAGER_CONFIG.connectionTimeoutMillis).toBe(3000);
    expect(POOL_MANAGER_CONFIG.scaleUpThreshold).toBeGreaterThan(POOL_MANAGER_CONFIG.scaleDownThreshold);
    expect(POOL_MANAGER_CONFIG.maxPoolLimit).toBeGreaterThan(POOL_MANAGER_CONFIG.minPoolLimit);
  });

  test('should have reasonable scale thresholds', () => {
    expect(POOL_MANAGER_CONFIG.scaleUpThreshold).toBe(0.80);
    expect(POOL_MANAGER_CONFIG.scaleDownThreshold).toBe(0.30);
  });
});
