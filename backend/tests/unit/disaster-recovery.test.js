const { describe, it, beforeEach, afterEach, expect, vi } = require('vitest');
const HealthChecker = require('../../shared/disasterRecovery/HealthChecker');
const FailoverController = require('../../shared/disasterRecovery/FailoverController');
const DatabaseSync = require('../../shared/disasterRecovery/DatabaseSync');
const DrillManager = require('../../shared/disasterRecovery/DrillManager');

// Mock dependencies
vi.mock('../../shared/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  },
  metrics: {
    gauge: vi.fn(() => ({
      set: vi.fn()
    })),
    counter: vi.fn(() => ({
      inc: vi.fn()
    })),
    histogram: vi.fn(() => ({
      observe: vi.fn()
    }))
  }
}));

vi.mock('ioredis', () => {
  return vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    setex: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1)
  }));
});

vi.mock('axios', () => ({
  get: vi.fn().mockResolvedValue({ status: 200, data: { status: 'healthy' } })
}));

describe('HealthChecker', () => {
  let healthChecker;
  
  beforeEach(() => {
    healthChecker = new HealthChecker({
      checkInterval: 1000,
      timeout: 3000,
      failureThreshold: 3,
      recoveryThreshold: 2,
      services: [
        { name: 'test-service', url: 'http://test-service:8080' }
      ]
    });
  });
  
  afterEach(() => {
    healthChecker.stop();
  });
  
  describe('constructor', () => {
    it('should initialize with default config', () => {
      const checker = new HealthChecker();
      expect(checker.config.checkInterval).toBe(5000);
      expect(checker.config.timeout).toBe(3000);
      expect(checker.config.failureThreshold).toBe(3);
      expect(checker.config.recoveryThreshold).toBe(2);
    });
    
    it('should accept custom config', () => {
      expect(healthChecker.config.checkInterval).toBe(1000);
      expect(healthChecker.config.services).toHaveLength(1);
    });
  });
  
  describe('checkService', () => {
    it('should return healthy for 200 response', async () => {
      const result = await healthChecker.checkService({
        name: 'test-service',
        url: 'http://test-service:8080'
      });
      
      expect(result.healthy).toBe(true);
      expect(result.latency).toBeDefined();
    });
    
    it('should return unhealthy for non-200 response', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValueOnce({ status: 503, data: { status: 'unhealthy' } });
      
      const result = await healthChecker.checkService({
        name: 'test-service',
        url: 'http://test-service:8080'
      });
      
      expect(result.healthy).toBe(false);
    });
    
    it('should return unhealthy on error', async () => {
      const axios = require('axios');
      axios.get.mockRejectedValueOnce(new Error('Connection refused'));
      
      const result = await healthChecker.checkService({
        name: 'test-service',
        url: 'http://test-service:8080'
      });
      
      expect(result.healthy).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });
  
  describe('handleHealthy', () => {
    it('should reset failure count', () => {
      const service = { name: 'test-service', url: 'http://test-service:8080' };
      healthChecker.failureCounts.set('test-service:primary', 2);
      
      healthChecker.handleHealthy(service, { healthy: true });
      
      expect(healthChecker.failureCounts.get('test-service:primary')).toBe(0);
    });
    
    it('should increment recovery count', () => {
      const service = { name: 'test-service', url: 'http://test-service:8080' };
      
      healthChecker.handleHealthy(service, { healthy: true });
      healthChecker.handleHealthy(service, { healthy: true });
      
      expect(healthChecker.recoveryCounts.get('test-service:primary')).toBe(2);
    });
    
    it('should mark as healthy after recovery threshold', () => {
      const service = { name: 'test-service', url: 'http://test-service:8080' };
      healthChecker.healthStatus.set('test-service:primary', false);
      
      healthChecker.handleHealthy(service, { healthy: true });
      healthChecker.handleHealthy(service, { healthy: true });
      
      expect(healthChecker.healthStatus.get('test-service:primary')).toBe(true);
    });
  });
  
  describe('handleUnhealthy', () => {
    it('should increment failure count', () => {
      const service = { name: 'test-service', url: 'http://test-service:8080' };
      
      healthChecker.handleUnhealthy(service, { error: 'Test error' });
      healthChecker.handleUnhealthy(service, { error: 'Test error' });
      
      expect(healthChecker.failureCounts.get('test-service:primary')).toBe(2);
    });
    
    it('should mark as unhealthy after failure threshold', () => {
      const service = { name: 'test-service', url: 'http://test-service:8080' };
      
      healthChecker.handleUnhealthy(service, { error: 'Test error' });
      healthChecker.handleUnhealthy(service, { error: 'Test error' });
      healthChecker.handleUnhealthy(service, { error: 'Test error' });
      
      expect(healthChecker.healthStatus.get('test-service:primary')).toBe(false);
    });
  });
  
  describe('getHealthStatus', () => {
    it('should return overall healthy status', () => {
      healthChecker.healthStatus.set('service1:primary', true);
      healthChecker.healthStatus.set('service2:primary', true);
      
      const status = healthChecker.getHealthStatus();
      
      expect(status.overall).toBe(true);
      expect(status.services.service1.primary.healthy).toBe(true);
    });
    
    it('should return overall unhealthy if any service unhealthy', () => {
      healthChecker.healthStatus.set('service1:primary', true);
      healthChecker.healthStatus.set('service2:primary', false);
      
      const status = healthChecker.getHealthStatus();
      
      expect(status.overall).toBe(false);
    });
  });
  
  describe('start and stop', () => {
    it('should start health checks', async () => {
      await healthChecker.start();
      
      expect(healthChecker.isRunning).toBe(true);
    });
    
    it('should stop health checks', async () => {
      await healthChecker.start();
      healthChecker.stop();
      
      expect(healthChecker.isRunning).toBe(false);
      expect(healthChecker.timer).toBeNull();
    });
    
    it('should not start twice', async () => {
      await healthChecker.start();
      await healthChecker.start();
      
      expect(healthChecker.isRunning).toBe(true);
    });
  });
});

describe('FailoverController', () => {
  let controller;
  
  beforeEach(() => {
    controller = new FailoverController({
      primaryRegion: 'cn-east-1',
      secondaryRegion: 'cn-north-1',
      cooldownPeriod: 60000
    });
  });
  
  describe('constructor', () => {
    it('should initialize with default config', () => {
      expect(controller.config.primaryRegion).toBe('cn-east-1');
      expect(controller.config.secondaryRegion).toBe('cn-north-1');
      expect(controller.state.activeRegion).toBe('cn-east-1');
    });
  });
  
  describe('initialize', () => {
    it('should restore state from Redis', async () => {
      await controller.initialize();
      
      expect(controller.state.activeRegion).toBeDefined();
    });
  });
  
  describe('acquireLock', () => {
    it('should acquire lock successfully', async () => {
      const lock = await controller.acquireLock();
      
      expect(lock).toBeDefined();
    });
  });
  
  describe('releaseLock', () => {
    it('should release lock', async () => {
      const lock = await controller.acquireLock();
      await controller.releaseLock(lock);
      
      // No error means success
      expect(true).toBe(true);
    });
  });
  
  describe('getState', () => {
    it('should return current state', () => {
      const state = controller.getState();
      
      expect(state.activeRegion).toBeDefined();
      expect(state.config.primaryRegion).toBe('cn-east-1');
    });
  });
  
  describe('getRegionEndpoints', () => {
    it('should return endpoints for primary region', () => {
      const endpoints = controller.getRegionEndpoints('cn-east-1');
      
      expect(Array.isArray(endpoints)).toBe(true);
    });
    
    it('should return endpoints for secondary region', () => {
      const endpoints = controller.getRegionEndpoints('cn-north-1');
      
      expect(Array.isArray(endpoints)).toBe(true);
    });
  });
});

describe('DatabaseSync', () => {
  let dbSync;
  
  beforeEach(() => {
    dbSync = new DatabaseSync({
      syncInterval: 1000,
      lagThreshold: 60000
    });
  });
  
  afterEach(async () => {
    await dbSync.stop();
  });
  
  describe('constructor', () => {
    it('should initialize with default config', () => {
      expect(dbSync.config.syncInterval).toBe(1000);
      expect(dbSync.config.lagThreshold).toBe(60000);
    });
  });
  
  describe('checkSyncStatus', () => {
    it('should return status when no databases configured', async () => {
      const status = await dbSync.checkSyncStatus();
      
      expect(status.healthy).toBe(false);
    });
  });
  
  describe('getStatus', () => {
    it('should return current status', async () => {
      const status = await dbSync.getStatus();
      
      expect(status.isRunning).toBeDefined();
    });
  });
  
  describe('start and stop', () => {
    it('should start monitoring', async () => {
      await dbSync.start();
      
      expect(dbSync.isRunning).toBe(true);
    });
    
    it('should stop monitoring', async () => {
      await dbSync.start();
      await dbSync.stop();
      
      expect(dbSync.isRunning).toBe(false);
    });
  });
});

describe('DrillManager', () => {
  let drillManager;
  let mockFailoverController;
  
  beforeEach(() => {
    mockFailoverController = {
      failover: vi.fn().mockResolvedValue({
        duration: 5000,
        fromRegion: 'cn-east-1',
        toRegion: 'cn-north-1'
      })
    };
    
    drillManager = new DrillManager(mockFailoverController, {
      maxDrillDuration: 60000,
      autoRollback: false
    });
  });
  
  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(drillManager.config.maxDrillDuration).toBe(60000);
      expect(drillManager.activeDrill).toBeNull();
    });
  });
  
  describe('scheduleDrill', () => {
    it('should schedule a drill', async () => {
      const drill = await drillManager.scheduleDrill({
        createdBy: 'test-user'
      });
      
      expect(drill.id).toBeDefined();
      expect(drill.status).toBe('scheduled');
      expect(drill.createdBy).toBe('test-user');
    });
    
    it('should accept custom scheduled time', async () => {
      const scheduledTime = new Date(Date.now() + 3600000);
      const drill = await drillManager.scheduleDrill({
        scheduledTime
      });
      
      expect(new Date(drill.scheduledTime).getTime()).toBe(scheduledTime.getTime());
    });
  });
  
  describe('startDrill', () => {
    it('should start a drill', async () => {
      const drill = await drillManager.scheduleDrill();
      const result = await drillManager.startDrill(drill.id);
      
      expect(result.status).toBe('running');
      expect(result.rto).toBeDefined();
    });
    
    it('should throw error if drill already in progress', async () => {
      const drill = await drillManager.scheduleDrill();
      await drillManager.startDrill(drill.id);
      
      const drill2 = await drillManager.scheduleDrill();
      
      await expect(drillManager.startDrill(drill2.id)).rejects.toThrow(
        'Another drill is already in progress'
      );
    });
  });
  
  describe('rollbackDrill', () => {
    it('should rollback a drill', async () => {
      const drill = await drillManager.scheduleDrill();
      await drillManager.startDrill(drill.id);
      
      const result = await drillManager.rollbackDrill(drill.id);
      
      expect(result.status).toBe('completed');
      expect(result.totalDuration).toBeDefined();
    });
    
    it('should throw error if no active drill', async () => {
      await expect(drillManager.rollbackDrill('non-existent')).rejects.toThrow(
        'No active drill with the specified ID'
      );
    });
  });
  
  describe('getDrillHistory', () => {
    it('should return empty history initially', () => {
      const history = drillManager.getDrillHistory();
      
      expect(history).toHaveLength(0);
    });
    
    it('should return drill history after completion', async () => {
      const drill = await drillManager.scheduleDrill();
      await drillManager.startDrill(drill.id);
      await drillManager.rollbackDrill(drill.id);
      
      const history = drillManager.getDrillHistory();
      
      expect(history).toHaveLength(1);
    });
  });
  
  describe('getActiveDrill', () => {
    it('should return null when no active drill', () => {
      expect(drillManager.getActiveDrill()).toBeNull();
    });
    
    it('should return active drill', async () => {
      const drill = await drillManager.scheduleDrill();
      await drillManager.startDrill(drill.id);
      
      const active = drillManager.getActiveDrill();
      
      expect(active).toBeDefined();
      expect(active.id).toBe(drill.id);
    });
  });
});
