/**
 * DI Container 单元测试
 * 
 * REQ-00600: 动态模块加载器与依赖注入容器系统
 */

const { DIContainer, Lifecycle } = require('../diContainer');

describe('DIContainer', () => {
  let container;

  beforeEach(() => {
    container = new DIContainer();
  });

  afterEach(() => {
    container.clear();
  });

  describe('register()', () => {
    it('should register a module', () => {
      class TestService {}
      container.register('test', TestService);
      
      expect(container.has('test')).toBe(true);
    });

    it('should allow chaining', () => {
      class ServiceA {}
      class ServiceB {}
      
      const result = container
        .register('a', ServiceA)
        .register('b', ServiceB);
      
      expect(result).toBe(container);
    });

    it('should warn when re-registering', () => {
      class ServiceA {}
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      
      container.register('a', ServiceA);
      container.register('a', ServiceA);
      
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('get()', () => {
    it('should create singleton instance', () => {
      class SingletonService {
        constructor(deps) {
          this.id = Math.random();
        }
      }
      
      container.register('singleton', SingletonService, {
        lifecycle: Lifecycle.SINGLETON
      });
      
      const instance1 = container.get('singleton');
      const instance2 = container.get('singleton');
      
      expect(instance1).toBe(instance2);
    });

    it('should create transient instances', () => {
      class TransientService {
        constructor(deps) {
          this.id = Math.random();
        }
      }
      
      container.register('transient', TransientService, {
        lifecycle: Lifecycle.TRANSIENT
      });
      
      const instance1 = container.get('transient');
      const instance2 = container.get('transient');
      
      expect(instance1).not.toBe(instance2);
    });

    it('should throw for unregistered module', () => {
      expect(() => container.get('nonexistent'))
        .toThrow('Module "nonexistent" is not registered');
    });

    it('should resolve dependencies', () => {
      class Logger {
        constructor(deps) {
          this.name = 'logger';
        }
      }
      
      class Database {
        constructor(deps) {
          this.logger = deps.logger;
        }
      }
      
      container.register('logger', Logger, { deps: [] });
      container.register('database', Database, { deps: ['logger'] });
      
      const db = container.get('database');
      
      expect(db.logger.name).toBe('logger');
    });

    it('should detect circular dependencies', () => {
      class ServiceA {
        constructor(deps) {
          this.b = deps.b;
        }
      }
      
      class ServiceB {
        constructor(deps) {
          this.a = deps.a;
        }
      }
      
      container.register('a', ServiceA, { deps: ['b'] });
      container.register('b', ServiceB, { deps: ['a'] });
      
      expect(() => container.get('a'))
        .toThrow('Circular dependency detected');
    });

    it('should use custom factory', () => {
      container.register('custom', null, {
        factory: (deps) => ({ custom: true })
      });
      
      const instance = container.get('custom');
      
      expect(instance.custom).toBe(true);
    });

    it('should support property injection', () => {
      class Logger {}
      class Service {
        constructor(deps) {
          this.name = 'service';
        }
      }
      
      container.register('logger', Logger, { deps: [] });
      container.register('service', Service, {
        deps: [],
        properties: { logger: 'logger' }
      });
      
      const service = container.get('service');
      
      expect(service.logger).toBeDefined();
    });
  });

  describe('getAll()', () => {
    it('should get multiple instances', () => {
      class ServiceA {}
      class ServiceB {}
      
      container.register('a', ServiceA);
      container.register('b', ServiceB);
      
      const instances = container.getAll(['a', 'b']);
      
      expect(instances.a).toBeDefined();
      expect(instances.b).toBeDefined();
    });
  });

  describe('has() and isInitialized()', () => {
    it('should check registration', () => {
      class Service {}
      container.register('service', Service);
      
      expect(container.has('service')).toBe(true);
      expect(container.has('nonexistent')).toBe(false);
    });

    it('should check initialization', () => {
      class Service {}
      container.register('service', Service);
      
      expect(container.isInitialized('service')).toBe(false);
      container.get('service');
      expect(container.isInitialized('service')).toBe(true);
    });
  });

  describe('replace()', () => {
    it('should replace module implementation', () => {
      class OldService {
        constructor(deps) {
          this.version = 'old';
        }
      }
      
      class NewService {
        constructor(deps) {
          this.version = 'new';
        }
      }
      
      container.register('service', OldService);
      const oldInstance = container.get('service');
      
      container.replace('service', NewService);
      const newInstance = container.get('service');
      
      expect(newInstance.version).toBe('new');
    });
  });

  describe('remove()', () => {
    it('should remove module', () => {
      class Service {}
      container.register('service', Service);
      
      container.remove('service');
      
      expect(container.has('service')).toBe(false);
    });

    it('should call destroy on removal', () => {
      class Service {
        destroy() {
          this.destroyed = true;
        }
      }
      
      container.register('service', Service);
      const instance = container.get('service');
      
      container.remove('service');
      
      expect(instance.destroyed).toBe(true);
    });
  });

  describe('detectCircularDependencies()', () => {
    it('should return empty array when no cycle', () => {
      class A {}
      class B {}
      
      container.register('a', A, { deps: [] });
      container.register('b', B, { deps: ['a'] });
      
      const cycle = container.detectCircularDependencies();
      
      expect(cycle).toEqual([]);
    });

    it('should detect cycle', () => {
      class A {}
      class B {}
      class C {}
      
      container.register('a', A, { deps: ['b'] });
      container.register('b', B, { deps: ['c'] });
      container.register('c', C, { deps: ['a'] });
      
      const cycle = container.detectCircularDependencies();
      
      expect(cycle.length).toBeGreaterThan(0);
    });
  });

  describe('getDependencyGraph()', () => {
    it('should return dependency graph', () => {
      class A {}
      class B {}
      
      container.register('a', A, { deps: [] });
      container.register('b', B, { deps: ['a'] });
      
      const graph = container.getDependencyGraph();
      
      expect(graph.nodes.length).toBe(2);
      expect(graph.edges.length).toBe(1);
      expect(graph.edges[0]).toEqual({ from: 'b', to: 'a' });
    });
  });

  describe('hooks', () => {
    it('should trigger beforeResolve and afterResolve hooks', () => {
      class Service {}
      
      const beforeResolve = jest.fn();
      const afterResolve = jest.fn();
      
      container
        .on('beforeResolve', beforeResolve)
        .on('afterResolve', afterResolve);
      
      container.register('service', Service);
      container.get('service');
      
      expect(beforeResolve).toHaveBeenCalledWith('service');
      expect(afterResolve).toHaveBeenCalledWith('service', expect.any(Service));
    });
  });

  describe('createChildContainer()', () => {
    it('should create child with inherited registrations', () => {
      class Parent {}
      
      container.register('parent', Parent);
      
      const child = container.createChildContainer();
      
      expect(child.has('parent')).toBe(true);
    });
  });

  describe('clear()', () => {
    it('should clear all registrations', () => {
      class Service {
        destroy() {}
      }
      
      container.register('service', Service);
      container.get('service');
      
      container.clear();
      
      expect(container.has('service')).toBe(false);
    });
  });
});

describe('Lifecycle', () => {
  it('should define SINGLETON and TRANSIENT', () => {
    expect(Lifecycle.SINGLETON).toBe('singleton');
    expect(Lifecycle.TRANSIENT).toBe('transient');
  });
});