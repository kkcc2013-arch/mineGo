/**
 * 依赖容器单元测试
 */

const { DependencyContainer, getContainer, resetContainer } = require('../../shared/dependencyContainer');

describe('DependencyContainer', () => {
  let container;

  beforeEach(() => {
    container = new DependencyContainer();
  });

  afterEach(() => {
    container.reset();
  });

  describe('register()', () => {
    it('should register a dependency', () => {
      const factory = jest.fn(() => ({ name: 'test' }));
      container.register('test', factory);
      
      expect(container.has('test')).toBe(true);
      expect(container.getRegisteredDependencies()).toContain('test');
    });

    it('should throw error when registering duplicate dependency', () => {
      container.register('test', () => ({}));
      
      expect(() => {
        container.register('test', () => ({}));
      }).toThrow('already registered');
    });

    it('should register with options', () => {
      const factory = () => ({});
      const healthCheck = jest.fn();
      const shutdown = jest.fn();
      
      container.register('test', factory, {
        singleton: true,
        healthCheck,
        shutdown
      });
      
      expect(container.has('test')).toBe(true);
    });
  });

  describe('resolve()', () => {
    it('should resolve dependency', () => {
      const factory = () => ({ name: 'test' });
      container.register('test', factory);
      
      const instance = container.resolve('test');
      expect(instance.name).toBe('test');
    });

    it('should throw error for unregistered dependency', () => {
      expect(() => {
        container.resolve('unregistered');
      }).toThrow('not registered');
    });

    it('should cache singleton instances', () => {
      let counter = 0;
      const factory = () => ({ id: ++counter });
      container.register('test', factory, { singleton: true });
      
      const instance1 = container.resolve('test');
      const instance2 = container.resolve('test');
      
      expect(instance1.id).toBe(instance2.id);
    });

    it('should create new instance for non-singleton', () => {
      let counter = 0;
      const factory = () => ({ id: ++counter });
      container.register('test', factory, { singleton: false });
      
      const instance1 = container.resolve('test');
      const instance2 = container.resolve('test');
      
      expect(instance1.id).not.toBe(instance2.id);
    });

    it('should emit error event when factory fails', () => {
      const errorHandler = jest.fn();
      container.on('error', errorHandler);
      
      container.register('test', () => {
        throw new Error('Factory error');
      });
      
      expect(() => container.resolve('test')).toThrow();
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('initialize()', () => {
    it('should initialize all singleton dependencies', async () => {
      const factory1 = jest.fn(() => ({}));
      const factory2 = jest.fn(() => ({}));
      
      container.register('dep1', factory1, { singleton: true });
      container.register('dep2', factory2, { singleton: true });
      
      const results = await container.initialize();
      
      expect(results.success).toContain('dep1');
      expect(results.success).toContain('dep2');
      expect(factory1).toHaveBeenCalled();
      expect(factory2).toHaveBeenCalled();
    });

    it('should skip non-singleton dependencies', async () => {
      container.register('dep1', () => ({}), { singleton: true });
      container.register('dep2', () => ({}), { singleton: false });
      
      const results = await container.initialize();
      
      expect(results.success).toContain('dep1');
      expect(results.skipped).toContain('dep2');
    });

    it('should call initialize method on instance if exists', async () => {
      const mockInitialize = jest.fn();
      const factory = () => ({
        initialize: mockInitialize
      });
      
      container.register('test', factory);
      await container.initialize();
      
      expect(mockInitialize).toHaveBeenCalled();
    });

    it('should throw error if already initialized', async () => {
      await container.initialize();
      
      await expect(container.initialize()).rejects.toThrow('already initialized');
    });

    it('should report failed initializations', async () => {
      container.register('good', () => ({}));
      container.register('bad', () => {
        throw new Error('Init error');
      });
      
      const results = await container.initialize();
      
      expect(results.success).toContain('good');
      expect(results.failed).toContainEqual({
        name: 'bad',
        error: 'Init error'
      });
    });
  });

  describe('healthCheck()', () => {
    it('should return unhealthy if not initialized', async () => {
      const health = await container.healthCheck();
      
      expect(health.status).toBe('unhealthy');
      expect(health.reason).toBe('Container not initialized');
    });

    it('should check health of all dependencies', async () => {
      container.register('dep1', () => ({
        healthCheck: () => ({ status: 'healthy', info: 'test' })
      }));
      container.register('dep2', () => ({
        healthCheck: () => ({ status: 'healthy', info: 'test2' })
      }));
      
      await container.initialize();
      const health = await container.healthCheck();
      
      expect(health.status).toBe('healthy');
      expect(health.dependencies.dep1.status).toBe('healthy');
      expect(health.dependencies.dep2.status).toBe('healthy');
    });

    it('should handle health check errors', async () => {
      container.register('test', () => ({
        healthCheck: () => {
          throw new Error('Health check failed');
        }
      }));
      
      await container.initialize();
      const health = await container.healthCheck();
      
      expect(health.status).toBe('degraded');
      expect(health.dependencies.test.status).toBe('error');
    });

    it('should use custom health check function', async () => {
      const customHealthCheck = jest.fn(() => ({ custom: true }));
      
      container.register('test', () => ({}), {
        healthCheck: customHealthCheck
      });
      
      await container.initialize();
      await container.healthCheck();
      
      expect(customHealthCheck).toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('should shutdown all dependencies', async () => {
      const mockShutdown = jest.fn();
      
      container.register('test', () => ({
        shutdown: mockShutdown
      }));
      
      await container.initialize();
      const results = await container.shutdown();
      
      expect(results.success).toContain('test');
      expect(mockShutdown).toHaveBeenCalled();
    });

    it('should handle close method', async () => {
      const mockClose = jest.fn();
      
      container.register('test', () => ({
        close: mockClose
      }));
      
      await container.initialize();
      await container.shutdown();
      
      expect(mockClose).toHaveBeenCalled();
    });

    it('should handle disconnect method', async () => {
      const mockDisconnect = jest.fn();
      
      container.register('test', () => ({
        disconnect: mockDisconnect
      }));
      
      await container.initialize();
      await container.shutdown();
      
      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should use custom shutdown function', async () => {
      const mockShutdown = jest.fn();
      
      container.register('test', () => ({}), {
        shutdown: mockShutdown
      });
      
      await container.initialize();
      await container.shutdown();
      
      expect(mockShutdown).toHaveBeenCalled();
    });

    it('should report shutdown failures', async () => {
      container.register('test', () => ({
        shutdown: () => {
          throw new Error('Shutdown error');
        }
      }));
      
      await container.initialize();
      const results = await container.shutdown();
      
      expect(results.failed).toContainEqual({
        name: 'test',
        error: 'Shutdown error'
      });
    });
  });

  describe('reset()', () => {
    it('should clear all dependencies and instances', () => {
      container.register('test', () => ({}));
      container.resolve('test');
      
      container.reset();
      
      expect(container.has('test')).toBe(false);
      expect(container.getRegisteredDependencies()).toHaveLength(0);
    });
  });
});

describe('Global Container', () => {
  afterEach(() => {
    resetContainer();
  });

  it('should return same instance', () => {
    const container1 = getContainer();
    const container2 = getContainer();
    
    expect(container1).toBe(container2);
  });

  it('should reset global container', () => {
    const container1 = getContainer();
    resetContainer();
    const container2 = getContainer();
    
    expect(container1).not.toBe(container2);
  });
});
