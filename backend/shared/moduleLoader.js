/**
 * 模块加载器 (Module Loader)
 * 
 * REQ-00600: 动态模块加载器与依赖注入容器系统
 * 
 * 特性：
 * - 目录扫描加载模块
 * - 依赖图解析（拓扑排序）
 * - 循环依赖检测
 * - 按序初始化
 * - 优雅关闭
 * - 环境适配
 */

const fs = require('fs').promises;
const path = require('path');
const { DIContainer, Lifecycle } = require('./diContainer');
const { createLogger } = require('./logger');

const logger = createLogger('module-loader');

/**
 * 模块加载器
 */
class ModuleLoader {
  constructor(container = null) {
    this.container = container || new DIContainer();
    this.modules = new Map();
    this.initializationOrder = [];
    this.isInitialized = false;
    this.isShuttingDown = false;
  }

  /**
   * 加载模块目录
   * @param {string} dir - 目录路径
   * @param {string} pattern - 文件匹配模式（glob 格式，默认 **/*.module.js）
   * @returns {Promise<number>} 加载的模块数量
   */
  async loadDirectory(dir, pattern = '**/*.module.js') {
    const absoluteDir = path.resolve(dir);
    let count = 0;

    try {
      const files = await this._scanDirectory(absoluteDir, pattern);
      
      for (const file of files) {
        await this.loadFile(file);
        count++;
      }

      logger.info({ dir: absoluteDir, count }, 'Directory modules loaded');
      return count;
    } catch (err) {
      logger.error({ err, dir: absoluteDir }, 'Failed to load directory');
      throw err;
    }
  }

  /**
   * 扫描目录获取匹配的文件
   * @param {string} dir - 目录路径
   * @param {string} pattern - 匹配模式
   * @returns {Promise<Array<string>>}
   */
  async _scanDirectory(dir, pattern) {
    const files = [];
    const patternRegex = this._patternToRegex(pattern);

    const scan = async (currentDir) => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.isFile() && patternRegex.test(entry.name)) {
          files.push(fullPath);
        }
      }
    };

    await scan(dir);
    return files;
  }

  /**
   * 将 glob 模式转换为正则表达式
   * @param {string} pattern - glob 模式
   * @returns {RegExp}
   */
  _patternToRegex(pattern) {
    // 简单实现：支持 ** 和 * 通配符
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '<<<DOUBLE_STAR>>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<<DOUBLE_STAR>>>/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  /**
   * 加载单个模块文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<Object>} 模块定义
   */
  async loadFile(filePath) {
    const absolutePath = require.resolve(filePath);
    
    try {
      // 清除缓存以支持热重载
      delete require.cache[absolutePath];
      
      const moduleDef = require(absolutePath);
      
      // 验证模块定义
      this._validateModuleDefinition(moduleDef);
      
      // 注册到容器
      this._registerModule(moduleDef);
      
      // 保存模块定义
      this.modules.set(moduleDef.name, {
        definition: moduleDef,
        filePath: absolutePath
      });

      logger.debug({ module: moduleDef.name, file: absolutePath }, 'Module loaded');
      return moduleDef;
    } catch (err) {
      logger.error({ err, file: absolutePath }, 'Failed to load module');
      throw err;
    }
  }

  /**
   * 验证模块定义格式
   * @param {Object} moduleDef - 模块定义
   */
  _validateModuleDefinition(moduleDef) {
    if (!moduleDef.name) {
      throw new Error('Module definition must have a "name" property');
    }
    if (typeof moduleDef.name !== 'string') {
      throw new Error('Module "name" must be a string');
    }
    if (!moduleDef.factory && !moduleDef.class) {
      throw new Error(`Module "${moduleDef.name}" must have either "factory" or "class" property`);
    }
  }

  /**
   * 注册模块到容器
   * @param {Object} moduleDef - 模块定义
   */
  _registerModule(moduleDef) {
    const moduleClass = moduleDef.class || moduleDef.factory;
    const currentEnv = process.env.NODE_ENV || 'development';
    
    // 环境适配
    let deps = moduleDef.dependencies || [];
    let factory = moduleDef.factory;
    
    if (moduleDef.environments && moduleDef.environments[currentEnv]) {
      const envConfig = moduleDef.environments[currentEnv];
      if (envConfig.dependencies) {
        deps = envConfig.dependencies;
      }
      if (envConfig.factory) {
        factory = envConfig.factory;
      }
    }

    this.container.register(moduleDef.name, moduleClass, {
      lifecycle: moduleDef.lifecycle || Lifecycle.SINGLETON,
      deps,
      factory
    });
  }

  /**
   * 解析依赖图，获取初始化顺序（拓扑排序）
   * @returns {Array<string>} 模块名称（按依赖顺序排列）
   */
  resolveDependencies() {
    const order = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (name) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving: ${name}`);
      }

      visiting.add(name);
      
      const deps = this.container.getDependencies(name);
      for (const dep of deps) {
        if (this.container.has(dep)) {
          visit(dep);
        }
      }

      visiting.delete(name);
      visited.add(name);
      order.push(name);
    };

    for (const name of this.container.getRegisteredNames()) {
      visit(name);
    }

    this.initializationOrder = order;
    logger.info({ order: order.join(' -> ') }, 'Dependencies resolved');
    return order;
  }

  /**
   * 检测循环依赖
   * @returns {Array<string>} 循环依赖链，无循环返回空数组
   */
  detectCircularDependencies() {
    return this.container.detectCircularDependencies();
  }

  /**
   * 按依赖顺序初始化所有模块
   * @returns {Promise<void>}
   */
  async initializeAll() {
    if (this.isInitialized) {
      logger.warn('Modules already initialized');
      return;
    }

    // 检测循环依赖
    const cycle = this.detectCircularDependencies();
    if (cycle.length > 0) {
      throw new Error(`Circular dependency detected: ${cycle.join(' -> ')}`);
    }

    // 解析依赖顺序
    const order = this.resolveDependencies();
    const startTime = Date.now();

    // 按序初始化
    const initialized = [];
    try {
      for (const name of order) {
        const moduleInfo = this.modules.get(name);
        
        // 触发 beforeInit 钩子
        this.container._triggerHooks('beforeInit', name);
        
        // 获取实例（触发依赖解析和创建）
        const instance = this.container.get(name);
        
        // 调用生命周期钩子
        if (moduleInfo?.definition.lifecycle?.init) {
          await moduleInfo.definition.lifecycle.init(instance);
        }
        
        initialized.push(name);
        logger.debug({ module: name, progress: `${initialized.length}/${order.length}` }, 'Module initialized');
      }

      this.isInitialized = true;
      const duration = Date.now() - startTime;
      logger.info({ count: initialized.length, duration }, 'All modules initialized');
    } catch (err) {
      // 初始化失败，回滚已初始化的模块
      logger.error({ err, initialized }, 'Initialization failed, rolling back');
      await this._rollback(initialized.reverse());
      throw err;
    }
  }

  /**
   * 回滚已初始化的模块
   * @param {Array<string>} modules - 需要回滚的模块列表（逆序）
   */
  async _rollback(modules) {
    for (const name of modules) {
      try {
        const moduleInfo = this.modules.get(name);
        const instance = this.container.get(name);
        
        if (moduleInfo?.definition.lifecycle?.stop && instance) {
          await moduleInfo.definition.lifecycle.stop(instance);
        }
      } catch (err) {
        logger.error({ err, module: name }, 'Rollback failed');
      }
    }
  }

  /**
   * 启动所有模块（调用 start 钩子）
   * @returns {Promise<void>}
   */
  async startAll() {
    if (!this.isInitialized) {
      throw new Error('Modules must be initialized before starting');
    }

    for (const name of this.initializationOrder) {
      const moduleInfo = this.modules.get(name);
      const instance = this.container.get(name);
      
      if (moduleInfo?.definition.lifecycle?.start && instance) {
        await moduleInfo.definition.lifecycle.start(instance);
        logger.debug({ module: name }, 'Module started');
      }
    }

    logger.info('All modules started');
  }

  /**
   * 优雅关闭所有模块
   * @returns {Promise<void>}
   */
  async shutdownAll() {
    if (this.isShuttingDown) {
      logger.warn('Already shutting down');
      return;
    }

    this.isShuttingDown = true;
    const startTime = Date.now();

    // 逆序关闭
    const reverseOrder = [...this.initializationOrder].reverse();
    
    for (const name of reverseOrder) {
      try {
        const moduleInfo = this.modules.get(name);
        const instance = this.container.isInitialized(name) ? this.container.get(name) : null;
        
        if (moduleInfo?.definition.lifecycle?.stop && instance) {
          await moduleInfo.definition.lifecycle.stop(instance);
          logger.debug({ module: name }, 'Module stopped');
        }
      } catch (err) {
        logger.error({ err, module: name }, 'Failed to stop module');
      }
    }

    // 清理容器
    this.container.clear();

    const duration = Date.now() - startTime;
    logger.info({ duration }, 'All modules shut down');
  }

  /**
   * 获取模块实例
   * @param {string} name - 模块名称
   * @returns {any}
   */
  get(name) {
    return this.container.get(name);
  }

  /**
   * 检查模块是否已注册
   * @param {string} name - 模块名称
   * @returns {boolean}
   */
  has(name) {
    return this.container.has(name);
  }

  /**
   * 获取所有已注册的模块名称
   * @returns {Array<string>}
   */
  getModuleNames() {
    return this.container.getRegisteredNames();
  }

  /**
   * 获取模块信息
   * @param {string} name - 模块名称
   * @returns {Object|null}
   */
  getModuleInfo(name) {
    const info = this.modules.get(name);
    if (!info) return null;
    
    return {
      name: info.definition.name,
      version: info.definition.version,
      dependencies: info.definition.dependencies || [],
      lifecycle: info.definition.lifecycle ? Object.keys(info.definition.lifecycle) : [],
      filePath: info.filePath
    };
  }

  /**
   * 获取依赖图（用于可视化）
   * @returns {Object}
   */
  getDependencyGraph() {
    return this.container.getDependencyGraph();
  }

  /**
   * 热重载指定模块
   * @param {string} name - 模块名称
   * @returns {Promise<void>}
   */
  async hotReload(name) {
    const moduleInfo = this.modules.get(name);
    if (!moduleInfo) {
      throw new Error(`Module "${name}" not found`);
    }

    // 停止旧实例
    if (this.container.isInitialized(name)) {
      const oldInstance = this.container.get(name);
      if (moduleInfo.definition.lifecycle?.stop) {
        await moduleInfo.definition.lifecycle.stop(oldInstance);
      }
    }

    // 重新加载文件
    await this.loadFile(moduleInfo.filePath);

    // 重新初始化
    const newInstance = this.container.get(name);
    if (moduleInfo.definition.lifecycle?.init) {
      await moduleInfo.definition.lifecycle.init(newInstance);
    }
    if (moduleInfo.definition.lifecycle?.start) {
      await moduleInfo.definition.lifecycle.start(newInstance);
    }

    logger.info({ module: name }, 'Module hot reloaded');
  }
}

/**
 * 热重载管理器（可选功能）
 */
class HotReloader {
  constructor(loader, options = {}) {
    this.loader = loader;
    this.watchDir = options.watchDir || './modules';
    this.debounce = options.debounce || 1000;
    this.timers = new Map();
    this.fs = require('fs');
  }

  /**
   * 开始监听文件变化
   */
  start() {
    this.watcher = this.fs.watch(
      this.watchDir,
      { recursive: true },
      (eventType, filename) => {
        if (filename && filename.endsWith('.module.js')) {
          this._scheduleReload(filename);
        }
      }
    );

    logger.info({ dir: this.watchDir }, 'Hot reloader started');
  }

  /**
   * 停止监听
   */
  stop() {
    if (this.watcher) {
      this.watcher.close();
    }
    logger.info('Hot reloader stopped');
  }

  /**
   * 调度重载（防抖）
   */
  _scheduleReload(filename) {
    if (this.timers.has(filename)) {
      clearTimeout(this.timers.get(filename));
    }

    const timer = setTimeout(() => {
      this.timers.delete(filename);
      // 查找对应的模块名并重载
      for (const [name, info] of this.loader.modules) {
        if (info.filePath.includes(filename)) {
          this.loader.hotReload(name).catch(err => {
            logger.error({ err, module: name }, 'Hot reload failed');
          });
          break;
        }
      }
    }, this.debounce);

    this.timers.set(filename, timer);
  }
}

// 导出
module.exports = {
  ModuleLoader,
  HotReloader
};