// backend/tests/unit/ConfigCenter.test.js
'use strict';

const { ConfigCenter, getConfigCenter } = require('../../../shared/ConfigCenter');

// Mock dependencies
jest.mock('../../../shared/redis', () => ({
  getRedis: jest.fn(() => ({
    hgetall: jest.fn().mockResolvedValue({
      rateLimit: JSON.stringify({ windowMs: 60000, max: 200 }),
      cache: JSON.stringify({ defaultTTL: 300 })
    }),
    hset: jest.fn().mockResolvedValue(1),
    hdel: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue('5'),
    set: jest.fn().mockResolvedValue('OK'),
    incr: jest.fn().mockResolvedValue(6),
    lpush: jest.fn().mockResolvedValue(1),
    lrange: jest.fn().mockResolvedValue([]),
    ltrim: jest.fn().mockResolvedValue('OK'),
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue('PONG'),
    keys: jest.fn().mockResolvedValue([]),
    pipeline: jest.fn(() => ({
      hset: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([])
    })),
    duplicate: jest.fn(() => ({
      subscribe: jest.fn().mockResolvedValue(1),
      on: jest.fn()
    }))
  }))
}));

jest.mock('../../../shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }))
}));

describe('ConfigCenter', () => {
  let configCenter;
  
  beforeEach(() => {
    // Reset singleton
    configCenter = null;
  });
  
  afterEach(() => {
    jest.clearAllMocks();
  });
  
  describe('initialization', () => {
    it('should initialize with default configs', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      
      // Wait for initialization
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(configCenter.serviceName).toBe('test-service');
      expect(configCenter.environment).toBe('test');
      expect(configCenter.defaultConfigs).toBeDefined();
    });
    
    it('should use environment variable for service name', async () => {
      process.env.SERVICE_NAME = 'env-service';
      configCenter = new ConfigCenter();
      
      await new Promise(resolve => setTimeout(resolve, 200));
      
      expect(configCenter.serviceName).toBe('env-service');
      
      delete process.env.SERVICE_NAME;
    });
  });
  
  describe('get', () => {
    it('should return default value if key not found', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const value = await configCenter.get('nonexistent', 'default');
      expect(value).toBe('default');
    });
    
    it('should return config from local cache', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      // Manually set local config
      configCenter.localConfig.testKey = 'testValue';
      
      const value = await configCenter.get('testKey');
      expect(value).toBe('testValue');
    });
    
    it('should return default config if available', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const value = await configCenter.get('rateLimit');
      expect(value).toEqual({ windowMs: 60000, max: 200 });
    });
  });
  
  describe('getSync', () => {
    it('should return local config synchronously', () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      configCenter.localConfig.syncKey = 'syncValue';
      
      const value = configCenter.getSync('syncKey');
      expect(value).toBe('syncValue');
    });
    
    it('should return default value if key not found', () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      
      const value = configCenter.getSync('nonexistent', 'default');
      expect(value).toBe('default');
    });
  });
  
  describe('set', () => {
    it('should update config in Redis', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const result = await configCenter.set('testKey', 'testValue', 'admin');
      
      expect(result.success).toBe(true);
      expect(result.version).toBeDefined();
    });
  });
  
  describe('updateConfig', () => {
    it('should batch update configs', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const newConfig = {
        key1: 'value1',
        key2: 'value2'
      };
      
      const result = await configCenter.updateConfig(newConfig, 'admin', 'test batch update');
      
      expect(result.success).toBe(true);
      expect(result.version).toBeDefined();
    });
  });
  
  describe('delete', () => {
    it('should delete config from Redis', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      configCenter.localConfig.deleteKey = 'deleteValue';
      
      const result = await configCenter.delete('deleteKey', 'admin');
      
      expect(result.success).toBe(true);
    });
  });
  
  describe('subscribe', () => {
    it('should register callback for config changes', () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      
      const callback = jest.fn();
      const unsubscribe = configCenter.subscribe('testKey', callback);
      
      expect(configCenter.watchers.has('testKey')).toBe(true);
      expect(configCenter.watchers.get('testKey').has(callback)).toBe(true);
      
      // Test unsubscribe
      unsubscribe();
      expect(configCenter.watchers.get('testKey').has(callback)).toBe(false);
    });
  });
  
  describe('handleConfigUpdate', () => {
    it('should update local config and trigger callbacks', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      
      const callback = jest.fn();
      configCenter.subscribe('testKey', callback);
      
      await configCenter.handleConfigUpdate({
        key: 'testKey',
        value: 'newValue',
        version: 10,
        type: 'set'
      });
      
      expect(configCenter.localConfig.testKey).toBe('newValue');
      expect(configCenter.configVersion).toBe(10);
      expect(callback).toHaveBeenCalledWith('testKey', 'newValue', 'set');
    });
    
    it('should handle delete type', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      configCenter.localConfig.deleteKey = 'deleteValue';
      
      await configCenter.handleConfigUpdate({
        key: 'deleteKey',
        value: null,
        version: 11,
        type: 'delete'
      });
      
      expect(configCenter.localConfig.deleteKey).toBeUndefined();
    });
  });
  
  describe('getHistory', () => {
    it('should return config history', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const history = await configCenter.getHistory(10);
      expect(Array.isArray(history)).toBe(true);
    });
  });
  
  describe('rollback', () => {
    it('should throw error if version not found', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      await expect(configCenter.rollback(999, 'admin'))
        .rejects.toThrow('Config version 999 not found');
    });
  });
  
  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      await new Promise(resolve => setTimeout(resolve, 200));
      
      const health = await configCenter.healthCheck();
      
      expect(health.status).toBe('healthy');
      expect(health.service).toBe('test-service');
    });
  });
  
  describe('waitForInitialization', () => {
    it('should wait for initialization', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      configCenter.initialized = false;
      
      // Set initialized after a delay
      setTimeout(() => {
        configCenter.initialized = true;
      }, 100);
      
      await configCenter.waitForInitialization(1000);
      
      expect(configCenter.initialized).toBe(true);
    });
    
    it('should timeout and use defaults', async () => {
      configCenter = new ConfigCenter({ serviceName: 'test-service' });
      configCenter.initialized = false;
      
      await configCenter.waitForInitialization(100);
      
      expect(configCenter.initialized).toBe(true);
      expect(configCenter.localConfig).toEqual(configCenter.defaultConfigs);
    });
  });
});

describe('getConfigCenter', () => {
  it('should return singleton instance', () => {
    const instance1 = getConfigCenter({ serviceName: 'service1' });
    const instance2 = getConfigCenter({ serviceName: 'service2' });
    
    expect(instance1).toBe(instance2);
  });
});
