const { IPlugin } = require('../plugins/IPlugin');
const { PluginManager, pluginManager } = require('../plugins/PluginManager');
const AuthPlugin = require('../plugins/builtins/AuthPlugin');
const RateLimitPlugin = require('../plugins/builtins/RateLimitPlugin');
const LoggingPlugin = require('../plugins/builtins/LoggingPlugin');
const TracingPlugin = require('../plugins/builtins/TracingPlugin');
const CircuitBreakerPlugin = require('../plugins/builtins/CircuitBreakerPlugin');

// Mock plugin for testing
class MockPlugin extends IPlugin {
  static get meta() {
    return {
      name: 'mock',
      version: '1.0.0',
      description: 'Mock plugin for testing',
      dependencies: [],
      priority: 50,
      category: 'test',
    };
  }

  static get defaultConfig() {
    return {
      enabled: true,
    };
  }

  async init(config, context) {
    this.config = config;
    this.context = context;
  }

  getMiddleware() {
    return (req, res, next) => next();
  }
}

describe('PluginManager', () => {
  let manager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  afterEach(() => {
    manager.loadedPlugins.clear();
    manager.plugins.clear();
  });

  describe('register()', () => {
    it('should register a valid plugin', () => {
      manager.register(MockPlugin);
      expect(manager.plugins.has('mock')).toBe(true);
    });

    it('should throw error for duplicate registration', () => {
      manager.register(MockPlugin);
      expect(() => manager.register(MockPlugin)).toThrow('already registered');
    });

    it('should throw error for invalid plugin class', () => {
      class InvalidPlugin {}
      expect(() => manager.register(InvalidPlugin)).toThrow('must extend IPlugin');
    });
  });

  describe('registerAll()', () => {
    it('should register multiple plugins', () => {
      manager.registerAll([MockPlugin, AuthPlugin]);
      expect(manager.plugins.size).toBe(2);
    });
  });

  describe('resolveDependencies()', () => {
    it('should return plugins in priority order', () => {
      manager.register(AuthPlugin);      // priority: 10
      manager.register(LoggingPlugin);    // priority: 30
      manager.register(TracingPlugin);    // priority: 5

      const order = manager.resolveDependencies(['auth', 'logging', 'tracing']);
      
      expect(order).toEqual(['tracing', 'auth', 'logging']);
    });

    it('should resolve dependencies correctly', () => {
      // Create plugins with dependencies
      class PluginA extends MockPlugin {
        static get meta() {
          return { ...MockPlugin.meta, name: 'pluginA', priority: 10 };
        }
      }
      
      class PluginB extends MockPlugin {
        static get meta() {
          return { 
            ...MockPlugin.meta, 
            name: 'pluginB', 
            priority: 20,
            dependencies: ['pluginA'] 
          };
        }
      }

      manager.register(PluginA);
      manager.register(PluginB);

      const order = manager.resolveDependencies(['pluginA', 'pluginB']);
      
      // pluginA should come before pluginB
      expect(order.indexOf('pluginA')).toBeLessThan(order.indexOf('pluginB'));
    });

    it('should detect circular dependencies', () => {
      class PluginX extends MockPlugin {
        static get meta() {
          return { ...MockPlugin.meta, name: 'pluginX', dependencies: ['pluginY'] };
        }
      }
      
      class PluginY extends MockPlugin {
        static get meta() {
          return { ...MockPlugin.meta, name: 'pluginY', dependencies: ['pluginX'] };
        }
      }

      manager.register(PluginX);
      manager.register(PluginY);

      expect(() => manager.resolveDependencies(['pluginX', 'pluginY']))
        .toThrow('Circular dependency');
    });
  });

  describe('loadPlugin()', () => {
    it('should load a plugin successfully', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock', { enabled: true });

      expect(manager.loadedPlugins.has('mock')).toBe(true);
      const pluginInfo = manager.loadedPlugins.get('mock');
      expect(pluginInfo.status).toBe('initialized');
    });

    it('should merge config with defaults', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock', { customConfig: 'value' });

      const pluginInfo = manager.loadedPlugins.get('mock');
      expect(pluginInfo.config).toEqual({
        enabled: true,
        customConfig: 'value',
      });
    });

    it('should throw error for non-existent plugin', async () => {
      await expect(manager.loadPlugin('nonexistent'))
        .rejects.toThrow('not found');
    });
  });

  describe('startAll()', () => {
    it('should start all loaded plugins', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock');
      await manager.startAll();

      const pluginInfo = manager.loadedPlugins.get('mock');
      expect(pluginInfo.status).toBe('running');
      expect(manager.isRunning).toBe(true);
    });

    it('should throw error if not initialized', async () => {
      await expect(manager.startAll()).rejects.toThrow('not initialized');
    });
  });

  describe('stopAll()', () => {
    it('should stop all plugins in reverse order', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock');
      await manager.startAll();
      await manager.stopAll();

      const pluginInfo = manager.loadedPlugins.get('mock');
      expect(pluginInfo.status).toBe('stopped');
      expect(manager.isRunning).toBe(false);
    });
  });

  describe('getMiddlewares()', () => {
    it('should return middlewares in priority order', async () => {
      manager.registerAll([AuthPlugin, LoggingPlugin, TracingPlugin]);
      await manager.loadPlugin('auth');
      await manager.loadPlugin('logging');
      await manager.loadPlugin('tracing');

      const middlewares = manager.getMiddlewares();
      expect(middlewares.length).toBe(3);
    });

    it('should filter out plugins without middleware', async () => {
      class NoMiddlewarePlugin extends MockPlugin {
        static get meta() {
          return { ...MockPlugin.meta, name: 'noMiddleware' };
        }
        getMiddleware() {
          return null;
        }
      }

      manager.register(MockPlugin);
      manager.register(NoMiddlewarePlugin);
      await manager.loadPlugin('mock');
      await manager.loadPlugin('noMiddleware');

      const middlewares = manager.getMiddlewares();
      expect(middlewares.length).toBe(1);
    });
  });

  describe('enable() / disable()', () => {
    it('should enable a plugin dynamically', async () => {
      manager.register(MockPlugin);
      await manager.enable('mock');

      expect(manager.loadedPlugins.has('mock')).toBe(true);
    });

    it('should disable a plugin', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock');
      await manager.disable('mock');

      expect(manager.loadedPlugins.has('mock')).toBe(false);
    });
  });

  describe('updateConfig()', () => {
    it('should reload plugin with new config', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock', { enabled: true });
      await manager.updateConfig('mock', { enabled: false });

      const pluginInfo = manager.loadedPlugins.get('mock');
      expect(pluginInfo.config.enabled).toBe(false);
    });
  });

  describe('getStatus()', () => {
    it('should return complete status information', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock');

      const status = manager.getStatus();

      expect(status.totalPlugins).toBe(1);
      expect(status.loadedPlugins).toBe(1);
      expect(status.plugins).toHaveLength(1);
      expect(status.plugins[0].name).toBe('mock');
    });
  });

  describe('healthCheck()', () => {
    it('should check health of a specific plugin', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock');

      const health = await manager.healthCheck('mock');

      expect(health.status).toBeDefined();
    });

    it('should check health of all plugins', async () => {
      manager.register(MockPlugin);
      await manager.loadPlugin('mock');

      const health = await manager.healthCheck();

      expect(health.mock).toBeDefined();
    });
  });
});

describe('Built-in Plugins', () => {
  describe('AuthPlugin', () => {
    it('should have correct metadata', () => {
      expect(AuthPlugin.meta.name).toBe('auth');
      expect(AuthPlugin.meta.priority).toBe(10);
      expect(AuthPlugin.meta.dependencies).toEqual([]);
    });

    it('should have valid config schema', () => {
      expect(AuthPlugin.configSchema.type).toBe('object');
      expect(AuthPlugin.configSchema.required).toContain('jwtSecret');
    });
  });

  describe('RateLimitPlugin', () => {
    it('should have correct metadata', () => {
      expect(RateLimitPlugin.meta.name).toBe('rateLimit');
      expect(RateLimitPlugin.meta.priority).toBe(20);
    });

    it('should have default config', () => {
      expect(RateLimitPlugin.defaultConfig.max).toBe(100);
      expect(RateLimitPlugin.defaultConfig.windowMs).toBe(60000);
    });
  });

  describe('LoggingPlugin', () => {
    it('should have correct metadata', () => {
      expect(LoggingPlugin.meta.name).toBe('logging');
      expect(LoggingPlugin.meta.priority).toBe(30);
    });

    it('should have skip paths configured', () => {
      expect(LoggingPlugin.defaultConfig.skipPaths).toContain('/health');
    });
  });

  describe('TracingPlugin', () => {
    it('should have highest priority', () => {
      expect(TracingPlugin.meta.priority).toBe(5);
    });

    it('should require serviceName', () => {
      expect(TracingPlugin.configSchema.required).toContain('serviceName');
    });
  });

  describe('CircuitBreakerPlugin', () => {
    it('should have correct metadata', () => {
      expect(CircuitBreakerPlugin.meta.name).toBe('circuitBreaker');
      expect(CircuitBreakerPlugin.meta.priority).toBe(15);
    });

    it('should require services list', () => {
      expect(CircuitBreakerPlugin.configSchema.required).toContain('services');
    });
  });
});

describe('IPlugin', () => {
  it('should define all required lifecycle hooks', () => {
    const plugin = new MockPlugin();
    
    expect(typeof plugin.init).toBe('function');
    expect(typeof plugin.start).toBe('function');
    expect(typeof plugin.stop).toBe('function');
    expect(typeof plugin.healthCheck).toBe('function');
    expect(typeof plugin.getMiddleware).toBe('function');
    expect(typeof plugin.handleEvent).toBe('function');
  });

  it('should throw error if init not implemented', async () => {
    const plugin = new IPlugin();
    
    await expect(plugin.init({}, {})).rejects.toThrow('Not implemented');
  });

  it('should validate config against schema', () => {
    const plugin = new MockPlugin();
    plugin.config = { enabled: true };

    expect(() => plugin.validateConfig({ enabled: true })).not.toThrow();
  });

  it('should return healthy status by default', async () => {
    const plugin = new MockPlugin();
    const health = await plugin.healthCheck();

    expect(health.status).toBe('healthy');
  });
});
