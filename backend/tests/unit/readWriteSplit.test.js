// backend/tests/unit/readWriteSplit.test.js
'use strict';

const { ReadWriteSplitManager, getReadWriteSplitManager } = require('../../shared/dbReadWriteSplit/ReadWriteSplitManager');
const { ReplicaLagMonitor, getReplicaLagMonitor } = require('../../jobs/replicaLagMonitor');

// Mock dependencies
jest.mock('../../shared/db', () => ({
  query: jest.fn()
}));

jest.mock('../../shared/redis', () => ({
  getRedis: jest.fn(),
  setRedis: jest.fn()
}));

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    totalCount: 10,
    idleCount: 5,
    waitingCount: 0
  }))
}));

describe('ReadWriteSplitManager', () => {
  let manager;
  
  beforeEach(() => {
    jest.clearAllMocks();
    manager = new ReadWriteSplitManager({
      primary: {
        host: 'localhost',
        port: 5432,
        database: 'test',
        user: 'test',
        password: 'test',
        max: 10
      },
      replicas: [
        {
          id: 'replica-1',
          host: 'localhost',
          port: 5433,
          database: 'test',
          user: 'test',
          password: 'test',
          max: 5,
          weight: 1
        },
        {
          id: 'replica-2',
          host: 'localhost',
          port: 5434,
          database: 'test',
          user: 'test',
          password: 'test',
          max: 5,
          weight: 2
        }
      ]
    });
  });
  
  afterEach(async () => {
    if (manager && manager.initialized) {
      await manager.shutdown();
    }
  });
  
  describe('initialize', () => {
    test('should create primary and replica pools', async () => {
      await manager.initialize();
      
      expect(manager.primaryPool).toBeDefined();
      expect(manager.replicaPools).toHaveLength(2);
      expect(manager.replicaPools[0].id).toBe('replica-1');
      expect(manager.replicaPools[1].id).toBe('replica-2');
    });
    
    test('should not initialize twice', async () => {
      await manager.initialize();
      await manager.initialize();
      
      expect(manager.initialized).toBe(true);
    });
  });
  
  describe('isWriteQuery', () => {
    test('should identify INSERT as write query', () => {
      expect(manager.isWriteQuery('INSERT INTO users VALUES (1)')).toBe(true);
    });
    
    test('should identify UPDATE as write query', () => {
      expect(manager.isWriteQuery('UPDATE users SET name = "test"')).toBe(true);
    });
    
    test('should identify DELETE as write query', () => {
      expect(manager.isWriteQuery('DELETE FROM users WHERE id = 1')).toBe(true);
    });
    
    test('should identify SELECT as read query', () => {
      expect(manager.isWriteQuery('SELECT * FROM users')).toBe(false);
    });
  });
  
  describe('determineConsistency', () => {
    test('should use explicit consistency', () => {
      const result = manager.determineConsistency('SELECT *', { consistency: 'strong' });
      expect(result).toBe('strong');
    });
    
    test('should use strong consistency for transaction', () => {
      const result = manager.determineConsistency('SELECT *', { inTransaction: true });
      expect(result).toBe('strong');
    });
    
    test('should use strong consistency for payment path', () => {
      const result = manager.determineConsistency('SELECT *', { path: '/api/payment/checkout' });
      expect(result).toBe('strong');
    });
    
    test('should use eventual consistency by default', () => {
      const result = manager.determineConsistency('SELECT *', {});
      expect(result).toBe('eventual');
    });
  });
  
  describe('selectReplica', () => {
    beforeEach(async () => {
      await manager.initialize();
    });
    
    test('should select healthy replica', () => {
      manager.replicaHealth['replica-1'].healthy = true;
      manager.replicaHealth['replica-2'].healthy = true;
      manager.lagData['replica-1'] = 100;
      manager.lagData['replica-2'] = 150;
      
      const replica = manager.selectReplica();
      
      expect(replica).toBeDefined();
      expect(['replica-1', 'replica-2']).toContain(replica.id);
    });
    
    test('should return null when all replicas unhealthy', () => {
      manager.replicaHealth['replica-1'].healthy = false;
      manager.replicaHealth['replica-2'].healthy = false;
      
      const replica = manager.selectReplica();
      
      expect(replica).toBeNull();
    });
    
    test('should exclude replicas with high lag', () => {
      manager.replicaHealth['replica-1'].healthy = true;
      manager.replicaHealth['replica-2'].healthy = true;
      manager.lagData['replica-1'] = 5000; // Exceeds critical threshold
      manager.lagData['replica-2'] = 100;
      
      const replica = manager.selectReplica();
      
      expect(replica.id).toBe('replica-2');
    });
  });
  
  describe('loadBalanceStrategy', () => {
    beforeEach(async () => {
      await manager.initialize();
      manager.replicaHealth['replica-1'].healthy = true;
      manager.replicaHealth['replica-2'].healthy = true;
      manager.lagData['replica-1'] = 100;
      manager.lagData['replica-2'] = 100;
    });
    
    test('round-robin should rotate replicas', () => {
      manager.config.loadBalanceStrategy = 'round-robin';
      
      const replica1 = manager.selectReplica();
      const replica2 = manager.selectReplica();
      
      // Should rotate between replicas
      expect(replica1.id).toBeDefined();
      expect(replica2.id).toBeDefined();
    });
    
    test('weighted should respect weights', () => {
      manager.config.loadBalanceStrategy = 'weighted';
      
      // replica-2 has weight 2, replica-1 has weight 1
      // Should favor replica-2
      const selections = [];
      for (let i = 0; i < 100; i++) {
        selections.push(manager.selectReplica().id);
      }
      
      const replica2Count = selections.filter(id => id === 'replica-2').length;
      const replica1Count = selections.filter(id => id === 'replica-1').length;
      
      // replica-2 should be selected approximately 2x more
      expect(replica2Count).toBeGreaterThan(replica1Count);
    });
  });
  
  describe('updateLagData', () => {
    beforeEach(async () => {
      await manager.initialize();
    });
    
    test('should update lag data', () => {
      manager.updateLagData('replica-1', 500);
      
      expect(manager.lagData['replica-1']).toBe(500);
      expect(manager.replicaHealth['replica-1'].lag).toBe(500);
    });
    
    test('should mark replica unhealthy when lag exceeds max', () => {
      manager.updateLagData('replica-1', 10000); // Exceeds max threshold
      
      expect(manager.replicaHealth['replica-1'].healthy).toBe(false);
    });
  });
  
  describe('getHealthSummary', () => {
    beforeEach(async () => {
      await manager.initialize();
    });
    
    test('should return health summary', () => {
      const health = manager.getHealthSummary();
      
      expect(health.primary).toBeDefined();
      expect(health.primary.healthy).toBe(true);
      expect(health.replicas).toHaveLength(2);
      expect(health.replicas[0].id).toBe('replica-1');
    });
  });
  
  describe('query', () => {
    beforeEach(async () => {
      await manager.initialize();
      manager.primaryPool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      manager.replicaPools[0].pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      manager.replicaPools[1].pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
      manager.replicaHealth['replica-1'].healthy = true;
      manager.replicaHealth['replica-2'].healthy = true;
      manager.lagData['replica-1'] = 100;
      manager.lagData['replica-2'] = 100;
    });
    
    test('should route write to primary', async () => {
      await manager.query('INSERT INTO users VALUES (1)');
      
      expect(manager.primaryPool.query).toHaveBeenCalled();
    });
    
    test('should route read to replica', async () => {
      await manager.query('SELECT * FROM users');
      
      expect(manager.replicaPools[0].pool.query).toHaveBeenCalled();
    });
    
    test('should route strong consistency read to primary', async () => {
      await manager.query('SELECT * FROM users', [], { consistency: 'strong' });
      
      expect(manager.primaryPool.query).toHaveBeenCalled();
    });
    
    test('should fallback to primary when all replicas down', async () => {
      manager.replicaHealth['replica-1'].healthy = false;
      manager.replicaHealth['replica-2'].healthy = false;
      
      await manager.query('SELECT * FROM users');
      
      expect(manager.primaryPool.query).toHaveBeenCalled();
    });
  });
});

describe('ReplicaLagMonitor', () => {
  let monitor;
  
  beforeEach(() => {
    jest.clearAllMocks();
    monitor = new ReplicaLagMonitor({
      checkInterval: 1000
    });
  });
  
  afterEach(async () => {
    if (monitor && monitor.running) {
      await monitor.stop();
    }
  });
  
  describe('start', () => {
    test('should start monitoring', async () => {
      await monitor.start();
      
      expect(monitor.running).toBe(true);
      expect(monitor.interval).toBeDefined();
    });
    
    test('should not start twice', async () => {
      await monitor.start();
      await monitor.start();
      
      expect(monitor.running).toBe(true);
    });
  });
  
  describe('stop', () => {
    test('should stop monitoring', async () => {
      await monitor.start();
      await monitor.stop();
      
      expect(monitor.running).toBe(false);
      expect(monitor.interval).toBeNull();
    });
  });
  
  describe('measureLagFromHeartbeat', () => {
    test('should calculate lag correctly', async () => {
      const expectedTimestamp = Date.now() - 200; // 200ms ago
      const replica = {
        id: 'replica-1',
        pool: {
          query: jest.fn().mockResolvedValue({
            rows: [{ heartbeat_time: expectedTimestamp }]
          })
        }
      };
      
      const lag = await monitor.measureLagFromHeartbeat(replica, expectedTimestamp);
      
      // Lag should be approximately 200ms (plus query time)
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(500);
    });
    
    test('should return large value when no heartbeat', async () => {
      const replica = {
        id: 'replica-1',
        pool: {
          query: jest.fn().mockResolvedValue({ rows: [] })
        }
      };
      
      const lag = await monitor.measureLagFromHeartbeat(replica, Date.now());
      
      expect(lag).toBe(999999);
    });
  });
  
  describe('checkAlerts', () => {
    test('should trigger warning alert', () => {
      const loggerSpy = jest.spyOn(monitor, 'sendAlert');
      
      monitor.checkAlerts('replica-1', 600);
      
      expect(loggerSpy).toHaveBeenCalled();
    });
    
    test('should trigger critical alert', () => {
      const loggerSpy = jest.spyOn(monitor, 'sendAlert');
      
      monitor.checkAlerts('replica-1', 2500);
      
      expect(loggerSpy).toHaveBeenCalledWith('replica-1', 2500, 'critical');
    });
  });
});

describe('ConsistencyMiddleware', () => {
  const { consistencyMiddleware, replicaLagMiddleware } = require('../../gateway/src/middleware/consistencyMiddleware');
  
  let req, res, next;
  
  beforeEach(() => {
    req = {
      path: '/api/test',
      method: 'GET',
      get: jest.fn(),
      query: {}
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      set: jest.fn()
    };
    next = jest.fn();
  });
  
  describe('consistencyMiddleware', () => {
    test('should set strong consistency for payment path', async () => {
      req.path = '/api/payment/checkout';
      
      const middleware = consistencyMiddleware();
      await middleware(req, res, next);
      
      expect(req.consistencyLevel).toBe('strong');
      expect(next).toHaveBeenCalled();
    });
    
    test('should set strong consistency from header', async () => {
      req.get.mockReturnValue('strong');
      
      const middleware = consistencyMiddleware();
      await middleware(req, res, next);
      
      expect(req.consistencyLevel).toBe('strong');
    });
    
    test('should set eventual consistency by default', async () => {
      const middleware = consistencyMiddleware();
      await middleware(req, res, next);
      
      expect(req.consistencyLevel).toBe('eventual');
    });
  });
  
  describe('replicaLagMiddleware', () => {
    test('should fallback to primary when no healthy replica', async () => {
      // Mock manager with no healthy replicas
      jest.doMock('../../shared/dbReadWriteSplit/ReadWriteSplitManager', () => ({
        getReadWriteSplitManager: () => ({
          getHealthSummary: () => ({
            primary: { healthy: true },
            replicas: [
              { id: 'replica-1', healthy: false, lag: 10000 }
            ]
          })
        })
      }));
      
      const middleware = replicaLagMiddleware();
      await middleware(req, res, next);
      
      expect(next).toHaveBeenCalled();
    });
  });
});

describe('Integration Tests', () => {
  test('should handle complete read-write split flow', async () => {
    const manager = new ReadWriteSplitManager({
      primary: {
        host: 'localhost',
        port: 5432,
        database: 'test',
        max: 5
      },
      replicas: [
        {
          id: 'replica-1',
          host: 'localhost',
          port: 5433,
          database: 'test',
          max: 3
        }
      ]
    });
    
    await manager.initialize();
    
    // Simulate lag data
    manager.updateLagData('replica-1', 100);
    
    // Check health
    const health = manager.getHealthSummary();
    expect(health.primary.healthy).toBe(true);
    expect(health.replicas[0].healthy).toBe(true);
    
    await manager.shutdown();
  });
});

// Performance tests
describe('Performance Tests', () => {
  test('should handle 1000 concurrent queries', async () => {
    const manager = new ReadWriteSplitManager({
      primary: {
        host: 'localhost',
        port: 5432,
        database: 'test',
        max: 50
      },
      replicas: [
        {
          id: 'replica-1',
          host: 'localhost',
          port: 5433,
          database: 'test',
          max: 30
        }
      ]
    });
    
    await manager.initialize();
    
    // Mock query
    manager.primaryPool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    manager.replicaPools[0].pool.query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    manager.replicaHealth['replica-1'].healthy = true;
    manager.lagData['replica-1'] = 100;
    
    const startTime = Date.now();
    
    const promises = [];
    for (let i = 0; i < 1000; i++) {
      promises.push(manager.query('SELECT * FROM test'));
    }
    
    await Promise.all(promises);
    
    const duration = Date.now() - startTime;
    
    console.log(`1000 queries completed in ${duration}ms`);
    expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    
    await manager.shutdown();
  });
});
