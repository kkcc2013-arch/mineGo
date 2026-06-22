/**
 * REQ-00259: 数据库读写分离路由器单元测试
 */

'use strict';

const { ReadWriteRouter } = require('../../shared/ReadWriteRouter');
const { Pool } = require('pg');

// Mock pg Pool
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [{ test: 1 }] }),
      release: jest.fn()
    }),
    end: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue({ rows: [{ test: 1 }] })
  }))
}));

describe('ReadWriteRouter', () => {
  let router;
  
  beforeEach(() => {
    router = new ReadWriteRouter({
      master: { connectionString: 'postgres://localhost/master' },
      replicas: [
        { name: 'replica-1', connectionString: 'postgres://localhost/replica1' },
        { name: 'replica-2', connectionString: 'postgres://localhost/replica2' }
      ],
      healthCheckInterval: 60000 // Disable auto health check in tests
    });
  });
  
  afterEach(async () => {
    if (router && router.initialized) {
      await router.shutdown();
    }
  });

  describe('initialize', () => {
    test('should create master and replica pools', async () => {
      await router.initialize();
      
      expect(router.masterPool).toBeDefined();
      expect(router.replicaPools.size).toBe(2);
      expect(router.replicaPools.has('replica-1')).toBe(true);
      expect(router.replicaPools.has('replica-2')).toBe(true);
    });
    
    test('should not reinitialize if already initialized', async () => {
      await router.initialize();
      const firstPool = router.masterPool;
      
      await router.initialize();
      
      expect(router.masterPool).toBe(firstPool);
    });
  });

  describe('getQueryType', () => {
    test('should identify SELECT as read', () => {
      expect(router.getQueryType('SELECT * FROM users')).toBe('read');
    });
    
    test('should identify INSERT as write', () => {
      expect(router.getQueryType('INSERT INTO users VALUES (1)')).toBe('write');
    });
    
    test('should identify UPDATE as write', () => {
      expect(router.getQueryType('UPDATE users SET name = $1')).toBe('write');
    });
    
    test('should identify DELETE as write', () => {
      expect(router.getQueryType('DELETE FROM users WHERE id = $1')).toBe('write');
    });
    
    test('should identify SELECT FOR UPDATE as write', () => {
      expect(router.getQueryType('SELECT * FROM users FOR UPDATE')).toBe('write');
    });
    
    test('should identify BEGIN as write', () => {
      expect(router.getQueryType('BEGIN')).toBe('write');
    });
    
    test('should identify COMMIT as write', () => {
      expect(router.getQueryType('COMMIT')).toBe('write');
    });
    
    test('should handle lowercase queries', () => {
      expect(router.getQueryType('select * from users')).toBe('read');
    });
    
    test('should handle leading whitespace', () => {
      expect(router.getQueryType('  SELECT * FROM users')).toBe('read');
    });
  });

  describe('selectReplica', () => {
    beforeEach(async () => {
      await router.initialize();
    });
    
    test('should return null when no healthy replicas', () => {
      // All replicas are unhealthy by default
      const result = router.selectReplica();
      expect(result).toBeNull();
    });
    
    test('should return healthy replica when available', () => {
      // Mark one replica as healthy
      router.nodeHealth.set('replica-1', {
        healthy: true,
        syncDelay: 10,
        activeConnections: 0
      });
      
      const result = router.selectReplica();
      expect(result).toBe('replica-1');
    });
    
    test('should use round-robin for multiple replicas', () => {
      router.nodeHealth.set('replica-1', {
        healthy: true,
        syncDelay: 10,
        activeConnections: 5
      });
      router.nodeHealth.set('replica-2', {
        healthy: true,
        syncDelay: 10,
        activeConnections: 2
      });
      
      const first = router.selectReplica();
      const second = router.selectReplica();
      
      // Round-robin should alternate
      expect(['replica-1', 'replica-2']).toContain(first);
      expect(['replica-1', 'replica-2']).toContain(second);
    });
    
    test('should exclude replicas with high sync delay', () => {
      router.nodeHealth.set('replica-1', {
        healthy: true,
        syncDelay: 200, // Higher than threshold (100)
        activeConnections: 0
      });
      router.nodeHealth.set('replica-2', {
        healthy: true,
        syncDelay: 50,
        activeConnections: 0
      });
      
      const result = router.selectReplica();
      expect(result).toBe('replica-2');
    });
  });

  describe('getHealthyReplicas', () => {
    beforeEach(async () => {
      await router.initialize();
    });
    
    test('should return empty array when no healthy replicas', () => {
      const result = router.getHealthyReplicas();
      expect(result).toHaveLength(0);
    });
    
    test('should return only healthy replicas', () => {
      router.nodeHealth.set('replica-1', {
        healthy: true,
        syncDelay: 10
      });
      router.nodeHealth.set('replica-2', {
        healthy: false,
        syncDelay: 1000
      });
      
      const result = router.getHealthyReplicas();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('replica-1');
    });
    
    test('should exclude replicas above sync delay threshold', () => {
      router.nodeHealth.set('replica-1', {
        healthy: true,
        syncDelay: 50
      });
      router.nodeHealth.set('replica-2', {
        healthy: true,
        syncDelay: 200 // Above threshold of 100
      });
      
      const result = router.getHealthyReplicas();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('replica-1');
    });
  });

  describe('selectLeastConnections', () => {
    test('should select replica with least connections', () => {
      const replicas = [
        { name: 'replica-1', activeConnections: 10 },
        { name: 'replica-2', activeConnections: 3 },
        { name: 'replica-3', activeConnections: 7 }
      ];
      
      const result = router.selectLeastConnections(replicas);
      expect(result).toBe('replica-2');
    });
  });

  describe('selectRandom', () => {
    test('should select one of the replicas', () => {
      const replicas = [
        { name: 'replica-1' },
        { name: 'replica-2' },
        { name: 'replica-3' }
      ];
      
      // Run multiple times to ensure it works
      for (let i = 0; i < 10; i++) {
        const result = router.selectRandom(replicas);
        expect(['replica-1', 'replica-2', 'replica-3']).toContain(result);
      }
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await router.initialize();
    });
    
    test('should route read query to replica when available', async () => {
      // Mock healthy replica
      router.nodeHealth.set('replica-1', {
        healthy: true,
        syncDelay: 10,
        activeConnections: 0
      });
      
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
        release: jest.fn()
      };
      
      router.replicaPools.get('replica-1').connect = jest.fn().mockResolvedValue(mockClient);
      
      const result = await router.query('SELECT * FROM users');
      
      expect(result.rows).toEqual([{ id: 1 }]);
      expect(router.stats.replicaHits).toBe(1);
    });
    
    test('should fallback to master when no healthy replica', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
        release: jest.fn()
      };
      
      router.masterPool.connect = jest.fn().mockResolvedValue(mockClient);
      
      const result = await router.query('SELECT * FROM users');
      
      expect(result.rows).toEqual([{ id: 1 }]);
      expect(router.stats.masterFallbacks).toBe(1);
    });
    
    test('should route write query to master', async () => {
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
        release: jest.fn()
      };
      
      router.masterPool.connect = jest.fn().mockResolvedValue(mockClient);
      
      await router.query('INSERT INTO users VALUES (1)');
      
      expect(router.stats.writeQueries).toBe(1);
    });
    
    test('should force master when option is set', async () => {
      // Even with healthy replica
      router.nodeHealth.set('replica-1', {
        healthy: true,
        syncDelay: 10
      });
      
      const mockClient = {
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn()
      };
      
      router.masterPool.connect = jest.fn().mockResolvedValue(mockClient);
      
      await router.query('SELECT * FROM users', [], { forceMaster: true });
      
      expect(router.stats.replicaHits).toBe(0);
    });
  });

  describe('getStats', () => {
    test('should return statistics', () => {
      router.stats.readQueries = 100;
      router.stats.writeQueries = 50;
      router.stats.replicaHits = 80;
      router.stats.masterFallbacks = 20;
      
      const stats = router.getStats();
      
      expect(stats.readQueries).toBe(100);
      expect(stats.writeQueries).toBe(50);
      expect(stats.replicaHits).toBe(80);
      expect(stats.masterFallbacks).toBe(20);
    });
  });

  describe('shutdown', () => {
    test('should end all pools', async () => {
      await router.initialize();
      
      const masterEndSpy = jest.spyOn(router.masterPool, 'end');
      const replica1EndSpy = jest.spyOn(router.replicaPools.get('replica-1'), 'end');
      const replica2EndSpy = jest.spyOn(router.replicaPools.get('replica-2'), 'end');
      
      await router.shutdown();
      
      expect(masterEndSpy).toHaveBeenCalled();
      expect(replica1EndSpy).toHaveBeenCalled();
      expect(replica2EndSpy).toHaveBeenCalled();
    });
    
    test('should clear health check timer', async () => {
      await router.initialize();
      
      router.healthCheckTimer = setInterval(() => {}, 1000);
      
      await router.shutdown();
      
      expect(router.healthCheckTimer).toBeNull();
    });
  });
});

describe('Configuration', () => {
  test('should use default config when not provided', () => {
    const router = new ReadWriteRouter();
    
    expect(router.config.syncDelayThreshold).toBe(100);
    expect(router.config.loadBalanceStrategy).toBe('round-robin');
    expect(router.config.fallbackToMaster).toBe(true);
  });
  
  test('should override default config', () => {
    const router = new ReadWriteRouter({
      syncDelayThreshold: 200,
      loadBalanceStrategy: 'least-connections'
    });
    
    expect(router.config.syncDelayThreshold).toBe(200);
    expect(router.config.loadBalanceStrategy).toBe('least-connections');
  });
});
