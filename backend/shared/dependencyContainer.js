/**
 * 依赖注入容器 - 统一管理服务依赖的生命周期
 * 
 * 功能：
 * - 单例模式依赖注册
 * - 工厂模式依赖注册
 * - 自动健康检查
 * - 优雅关闭机制
 * - 测试友好的依赖替换
 * 
 * @module dependencyContainer
 */

const { EventEmitter } = require('events');

class DependencyContainer extends EventEmitter {
  constructor() {
    super();
    this.dependencies = new Map();
    this.instances = new Map();
    this.initialized = false;
    this.shuttingDown = false;
  }

  /**
   * 注册依赖
   * @param {string} name - 依赖名称
   * @param {Function} factory - 工厂函数，返回依赖实例
   * @param {Object} options - 配置选项
   * @param {boolean} options.singleton - 是否单例（默认 true）
   * @param {Function} options.healthCheck - 健康检查函数
   * @param {Function} options.shutdown - 关闭函数
   */
  register(name, factory, options = {}) {
    if (this.dependencies.has(name)) {
      throw new Error(`Dependency '${name}' already registered`);
    }

    const config = {
      factory,
      singleton: options.singleton !== false, // 默认单例
      healthCheck: options.healthCheck || null,
      shutdown: options.shutdown || null,
      initialized: false
    };

    this.dependencies.set(name, config);
    this.emit('registered', { name, singleton: config.singleton });
  }

  /**
   * 解析依赖
   * @param {string} name - 依赖名称
   * @returns {*} 依赖实例
   */
  resolve(name) {
    const config = this.dependencies.get(name);
    
    if (!config) {
      throw new Error(`Dependency '${name}' not registered`);
    }

    // 单例模式：返回缓存的实例
    if (config.singleton && this.instances.has(name)) {
      return this.instances.get(name);
    }

    // 调用工厂函数创建实例
    try {
      const instance = config.factory(this);
      
      // 单例模式：缓存实例
      if (config.singleton) {
        this.instances.set(name, instance);
      }

      this.emit('resolved', { name, singleton: config.singleton });
      return instance;
    } catch (error) {
      this.emit('error', { name, error });
      throw new Error(`Failed to resolve dependency '${name}': ${error.message}`);
    }
  }

  /**
   * 批量初始化所有依赖
   * @returns {Promise<Object>} 初始化结果
   */
  async initialize() {
    if (this.initialized) {
      throw new Error('Container already initialized');
    }

    const results = {
      success: [],
      failed: [],
      skipped: []
    };

    // 按依赖顺序初始化（这里简化为并行初始化）
    const initPromises = Array.from(this.dependencies.entries()).map(
      async ([name, config]) => {
        try {
          // 只初始化单例依赖
          if (!config.singleton) {
            results.skipped.push(name);
            return;
          }

          const instance = this.resolve(name);
          
          // 如果实例有初始化方法，调用它
          if (instance && typeof instance.initialize === 'function') {
            await instance.initialize();
          }

          config.initialized = true;
          results.success.push(name);
        } catch (error) {
          results.failed.push({ name, error: error.message });
          this.emit('init:failed', { name, error });
        }
      }
    );

    await Promise.all(initPromises);
    this.initialized = true;

    this.emit('initialized', results);
    return results;
  }

  /**
   * 执行健康检查
   * @returns {Promise<Object>} 健康检查结果
   */
  async healthCheck() {
    if (!this.initialized) {
      return {
        status: 'unhealthy',
        reason: 'Container not initialized'
      };
    }

    const healthResults = {
      status: 'healthy',
      dependencies: {},
      timestamp: new Date().toISOString()
    };

    const checkPromises = Array.from(this.dependencies.entries()).map(
      async ([name, config]) => {
        try {
          if (config.healthCheck) {
            const health = await config.healthCheck();
            healthResults.dependencies[name] = health;
          } else if (this.instances.has(name)) {
            const instance = this.instances.get(name);
            if (instance && typeof instance.healthCheck === 'function') {
              const health = await instance.healthCheck();
              healthResults.dependencies[name] = health;
            } else {
              healthResults.dependencies[name] = { status: 'unknown' };
            }
          } else {
            healthResults.dependencies[name] = { status: 'not_initialized' };
          }
        } catch (error) {
          healthResults.dependencies[name] = {
            status: 'error',
            error: error.message
          };
          healthResults.status = 'degraded';
        }
      }
    );

    await Promise.all(checkPromises);

    // 统计健康状态
    const statuses = Object.values(healthResults.dependencies).map(d => d.status);
    if (statuses.includes('error')) {
      healthResults.status = 'degraded';
    }

    this.emit('health:checked', healthResults);
    return healthResults;
  }

  /**
   * 优雅关闭所有依赖
   * @returns {Promise<Object>} 关闭结果
   */
  async shutdown() {
    if (this.shuttingDown) {
      return { status: 'already_shutting_down' };
    }

    this.shuttingDown = true;
    const results = {
      success: [],
      failed: []
    };

    // 反向关闭依赖（后注册的先关闭）
    const entries = Array.from(this.dependencies.entries()).reverse();
    
    for (const [name, config] of entries) {
      try {
        if (config.shutdown) {
          await config.shutdown();
        } else if (this.instances.has(name)) {
          const instance = this.instances.get(name);
          if (instance && typeof instance.shutdown === 'function') {
            await instance.shutdown();
          } else if (instance && typeof instance.close === 'function') {
            await instance.close();
          } else if (instance && typeof instance.disconnect === 'function') {
            await instance.disconnect();
          }
        }
        results.success.push(name);
      } catch (error) {
        results.failed.push({ name, error: error.message });
        this.emit('shutdown:failed', { name, error });
      }
    }

    this.initialized = false;
    this.shuttingDown = false;
    this.emit('shutdown:complete', results);

    return results;
  }

  /**
   * 重置容器（测试用）
   */
  reset() {
    this.dependencies.clear();
    this.instances.clear();
    this.initialized = false;
    this.shuttingDown = false;
    this.removeAllListeners();
  }

  /**
   * 获取所有已注册的依赖名称
   */
  getRegisteredDependencies() {
    return Array.from(this.dependencies.keys());
  }

  /**
   * 检查依赖是否已注册
   */
  has(name) {
    return this.dependencies.has(name);
  }

  /**
   * 检查依赖是否已初始化
   */
  isInitialized(name) {
    const config = this.dependencies.get(name);
    return config ? config.initialized : false;
  }
}

// 全局容器实例（单例）
let globalContainer = null;

/**
 * 获取全局容器实例
 */
function getContainer() {
  if (!globalContainer) {
    globalContainer = new DependencyContainer();
  }
  return globalContainer;
}

/**
 * 重置全局容器（测试用）
 */
function resetContainer() {
  if (globalContainer) {
    globalContainer.reset();
  }
  globalContainer = null;
}

module.exports = {
  DependencyContainer,
  getContainer,
  resetContainer
};
