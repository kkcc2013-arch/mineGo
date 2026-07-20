/**
 * 依赖注入容器 (Dependency Injection Container)
 * 
 * REQ-00600: 动态模块加载器与依赖注入容器系统
 * 
 * 特性：
 * - Singleton 和 Transient 两种生命周期
 * - 构造器注入和属性注入
 * - 环境适配（dev/test/prod）
 * - 热重载支持
 * - 循环依赖检测
 */

const { createLogger } = require('./logger');

const logger = createLogger('di-container');

/**
 * 生命周期类型
 */
const Lifecycle = {
  SINGLETON: 'singleton',
  TRANSIENT: 'transient'
};

/**
 * 模块注册信息
 */
class ModuleRegistration {
  constructor(name, moduleClass, options = {}) {
    this.name = name;
    this.moduleClass = moduleClass;
    this.options = {
      lifecycle: Lifecycle.SINGLETON,
      deps: [],
      env: {},
      factory: null,
      ...options
    };
    this.instance = null;
    this.initialized = false;
  }
}

/**
 * 依赖注入容器
 */
class DIContainer {
  constructor() {
    this.registrations = new Map();
    this.resolving = new Set(); // 用于循环依赖检测
    this.hooks = {
      beforeResolve: [],
      afterResolve: [],
      beforeInit: [],
      afterInit: []
    };
  }

  /**
   * 注册模块
   * @param {string} name - 模块名称
   * @param {Function|Class} moduleClass - 模块类或工厂函数
   * @param {Object} options - 配置选项
   * @param {string} options.lifecycle - 生命周期 (singleton|transient)
   * @param {Array<string>} options.deps - 依赖列表
   * @param {Object} options.env - 环境适配配置
   * @param {Function} options.factory - 自定义工厂函数
   */
  register(name, moduleClass, options = {}) {
    if (this.registrations.has(name)) {
      logger.warn(`Module "${name}" is already registered, replacing...`);
    }

    const registration = new ModuleRegistration(name, moduleClass, options);
    this.registrations.set(name, registration);
    
    logger.debug({ module: name, lifecycle: options.lifecycle }, 'Module registered');
    return this;
  }

  /**
   * 批量注册模块
   * @param {Object} modules - 模块配置对象 { name: { class, options } }
   */
  registerAll(modules) {
    for (const [name, config] of Object.entries(modules)) {
      this.register(name, config.class, config.options);
    }
    return this;
  }

  /**
   * 获取模块实例
   * @param {string} name - 模块名称
   * @returns {any} 模块实例
   */
  get(name) {
    const registration = this.registrations.get(name);
    
    if (!registration) {
      throw new Error(`Module "${name}" is not registered. Available modules: ${Array.from(this.registrations.keys()).join(', ')}`);
    }

    // 循环依赖检测
    if (this.resolving.has(name)) {
      throw new Error(`Circular dependency detected: ${Array.from(this.resolving).join(' -> ')} -> ${name}`);
    }

    // Singleton 且已初始化，直接返回实例
    if (registration.options.lifecycle === Lifecycle.SINGLETON && registration.instance) {
      return registration.instance;
    }

    // 解析并创建实例
    return this._resolve(registration);
  }

  /**
   * 解析模块依赖并创建实例
   * @param {ModuleRegistration} registration - 模块注册信息
   * @returns {any} 模块实例
   */
  _resolve(registration) {
    const { name, moduleClass, options } = registration;
    
    this.resolving.add(name);
    
    try {
      // 触发 beforeResolve 钩子
      this._triggerHooks('beforeResolve', name);

      // 解析依赖
      const deps = {};
      for (const depName of options.deps) {
        deps[depName] = this.get(depName);
      }

      // 创建实例
      let instance;
      if (options.factory) {
        // 使用自定义工厂函数
        instance = options.factory(deps);
      } else if (typeof moduleClass === 'function') {
        // 构造器注入
        instance = new moduleClass(deps);
      } else {
        // 直接返回模块（如配置对象）
        instance = moduleClass;
      }

      // 属性注入
      if (options.properties) {
        for (const [prop, depName] of Object.entries(options.properties)) {
          instance[prop] = this.get(depName);
        }
      }

      // Singleton 缓存实例
      if (options.lifecycle === Lifecycle.SINGLETON) {
        registration.instance = instance;
        registration.initialized = true;
      }

      // 触发 afterResolve 钩子
      this._triggerHooks('afterResolve', name, instance);

      logger.debug({ module: name }, 'Module resolved');
      return instance;
    } finally {
      this.resolving.delete(name);
    }
  }

  /**
   * 批量获取模块实例
   * @param {Array<string>} names - 模块名称列表
   * @returns {Object} 模块实例对象 { name: instance }
   */
  getAll(names) {
    const result = {};
    for (const name of names) {
      result[name] = this.get(name);
    }
    return result;
  }

  /**
   * 检查模块是否已注册
   * @param {string} name - 模块名称
   * @returns {boolean}
   */
  has(name) {
    return this.registrations.has(name);
  }

  /**
   * 检查模块是否已初始化
   * @param {string} name - 模块名称
   * @returns {boolean}
   */
  isInitialized(name) {
    const registration = this.registrations.get(name);
    return registration ? registration.initialized : false;
  }

  /**
   * 替换模块实现（热重载）
   * @param {string} name - 模块名称
   * @param {Function|Class} newModuleClass - 新的模块类
   * @param {Object} options - 配置选项
   */
  replace(name, newModuleClass, options = {}) {
    const oldRegistration = this.registrations.get(name);
    if (!oldRegistration) {
      throw new Error(`Module "${name}" is not registered`);
    }

    // 合并原有配置
    const mergedOptions = {
      ...oldRegistration.options,
      ...options
    };

    // 重新注册
    this.register(name, newModuleClass, mergedOptions);
    
    logger.info({ module: name }, 'Module replaced (hot reload)');
  }

  /**
   * 移除模块
   * @param {string} name - 模块名称
   */
  remove(name) {
    const registration = this.registrations.get(name);
    if (registration && registration.instance && typeof registration.instance.destroy === 'function') {
      registration.instance.destroy();
    }
    this.registrations.delete(name);
    logger.debug({ module: name }, 'Module removed');
  }

  /**
   * 清空容器（测试用）
   */
  clear() {
    for (const [name, registration] of this.registrations) {
      if (registration.instance && typeof registration.instance.destroy === 'function') {
        try {
          registration.instance.destroy();
        } catch (err) {
          logger.error({ err, module: name }, 'Failed to destroy module');
        }
      }
    }
    this.registrations.clear();
    this.resolving.clear();
    logger.debug('Container cleared');
  }

  /**
   * 获取所有已注册的模块名称
   * @returns {Array<string>}
   */
  getRegisteredNames() {
    return Array.from(this.registrations.keys());
  }

  /**
   * 获取模块的依赖列表
   * @param {string} name - 模块名称
   * @returns {Array<string>}
   */
  getDependencies(name) {
    const registration = this.registrations.get(name);
    return registration ? registration.options.deps : [];
  }

  /**
   * 检测循环依赖
   * @returns {Array<string>} 循环依赖链，无循环返回空数组
   */
  detectCircularDependencies() {
    const visited = new Set();
    const recursionStack = new Set();
    const cycle = [];

    const dfs = (name) => {
      visited.add(name);
      recursionStack.add(name);

      const deps = this.getDependencies(name);
      for (const dep of deps) {
        if (!visited.has(dep)) {
          const result = dfs(dep);
          if (result.length > 0) {
            return result;
          }
        } else if (recursionStack.has(dep)) {
          // 找到循环
          return [...recursionStack, dep];
        }
      }

      recursionStack.delete(name);
      return [];
    };

    for (const name of this.registrations.keys()) {
      if (!visited.has(name)) {
        const result = dfs(name);
        if (result.length > 0) {
          return result;
        }
      }
    }

    return cycle;
  }

  /**
   * 获取依赖图（用于可视化）
   * @returns {Object} 依赖图 { nodes: [], edges: [] }
   */
  getDependencyGraph() {
    const nodes = [];
    const edges = [];

    for (const [name, registration] of this.registrations) {
      nodes.push({
        id: name,
        lifecycle: registration.options.lifecycle,
        initialized: registration.initialized
      });

      for (const dep of registration.options.deps) {
        edges.push({ from: name, to: dep });
      }
    }

    return { nodes, edges };
  }

  /**
   * 添加钩子
   * @param {string} event - 事件名称
   * @param {Function} callback - 回调函数
   */
  on(event, callback) {
    if (this.hooks[event]) {
      this.hooks[event].push(callback);
    }
    return this;
  }

  /**
   * 触发钩子
   * @param {string} event - 事件名称
   * @param  {...any} args - 参数
   */
  _triggerHooks(event, ...args) {
    const callbacks = this.hooks[event] || [];
    for (const callback of callbacks) {
      try {
        callback(...args);
      } catch (err) {
        logger.error({ err, event }, 'Hook callback error');
      }
    }
  }

  /**
   * 创建子容器（用于隔离测试）
   * @returns {DIContainer}
   */
  createChildContainer() {
    const child = new DIContainer();
    // 子容器继承父容器的注册
    for (const [name, registration] of this.registrations) {
      child.registrations.set(name, registration);
    }
    return child;
  }
}

// 导出
module.exports = {
  DIContainer,
  Lifecycle,
  ModuleRegistration
};