const { IPlugin } = require('./IPlugin');
const logger = require('../logger');
const metrics = require('../metrics');

/**
 * 插件管理器 - 统一管理所有中间件插件
 * 
 * @class PluginManager
 */
class PluginManager {
  constructor() {
    this.plugins = new Map();        // 已注册插件类 {name: PluginClass}
    this.loadedPlugins = new Map();  // 已加载插件实例 {name: {instance, config, status}}
    this.config = {};                // 全局配置
    this.logger = logger.child({ component: 'PluginManager' });
    this.isInitialized = false;
    this.isRunning = false;
  }

  /**
   * 注册插件类
   * 
   * @param {Class} PluginClass - 插件类（必须继承 IPlugin）
   * @throws {Error} 插件已注册或无效
   */
  register(PluginClass) {
    // 验证是否为有效插件类
    if (!(PluginClass.prototype instanceof IPlugin)) {
      throw new Error('Plugin must extend IPlugin');
    }

    const meta = PluginClass.meta;
    if (!meta || !meta.name) {
      throw new Error('Plugin must have valid meta.name');
    }

    if (this.plugins.has(meta.name)) {
      throw new Error(`Plugin "${meta.name}" already registered`);
    }

    this.plugins.set(meta.name, PluginClass);
    this.logger.info({ plugin: meta.name, version: meta.version }, 'Plugin registered');
  }

  /**
   * 批量注册插件
   * 
   * @param {Class[]} plugins - 插件类数组
   */
  registerAll(plugins) {
    for (const Plugin of plugins) {
      this.register(Plugin);
    }
  }

  /**
   * 解析依赖关系并拓扑排序
   * 
   * @param {string[]} enabledPlugins - 需要启用的插件名称列表
   * @returns {string[]} 排序后的插件名称列表
   * @throws {Error} 依赖循环或缺失
   */
  resolveDependencies(enabledPlugins) {
    const visited = new Set();
    const result = [];
    const visiting = new Set(); // 用于检测循环依赖

    const visit = (pluginName) => {
      if (visited.has(pluginName)) return;
      if (visiting.has(pluginName)) {
        throw new Error(`Circular dependency detected: ${pluginName}`);
      }

      const PluginClass = this.plugins.get(pluginName);
      if (!PluginClass) {
        throw new Error(`Plugin "${pluginName}" not found`);
      }

      visiting.add(pluginName);

      // 递归访问依赖
      const deps = PluginClass.meta.dependencies || [];
      for (const dep of deps) {
        if (!enabledPlugins.includes(dep)) {
          this.logger.warn(
            { plugin: pluginName, dependency: dep },
            'Dependency not enabled, skipping'
          );
          continue;
        }
        visit(dep);
      }

      visiting.delete(pluginName);
      visited.add(pluginName);
      result.push(pluginName);
    };

    // 按优先级排序后进行拓扑排序
    const sorted = [...enabledPlugins].sort((a, b) => {
      const pluginA = this.plugins.get(a);
      const pluginB = this.plugins.get(b);
      return (pluginA?.meta?.priority || 100) - (pluginB?.meta?.priority || 100);
    });

    for (const plugin of sorted) {
      visit(plugin);
    }

    return result;
  }

  /**
   * 加载单个插件
   * 
   * @async
   * @param {string} name - 插件名称
   * @param {Object} config - 插件配置
   * @returns {Promise<void>}
   */
  async loadPlugin(name, config = {}) {
    const PluginClass = this.plugins.get(name);
    if (!PluginClass) {
      throw new Error(`Plugin "${name}" not found`);
    }

    if (this.loadedPlugins.has(name)) {
      throw new Error(`Plugin "${name}" already loaded`);
    }

    const instance = new PluginClass();
    const mergedConfig = { ...PluginClass.defaultConfig, ...config };

    // 验证配置
    instance.validateConfig(mergedConfig);

    // 创建插件上下文
    const context = this.getContext();

    try {
      // 初始化插件
      await instance.init(mergedConfig, context);

      this.loadedPlugins.set(name, {
        instance,
        config: mergedConfig,
        status: 'initialized',
        loadedAt: new Date(),
      });

      this.logger.info({ plugin: name, config: mergedConfig }, 'Plugin loaded');

      // 更新指标
      metrics.incrementCounter('plugin_load_count', 1, { status: 'success' });
    } catch (err) {
      this.logger.error({ err, plugin: name }, 'Plugin load failed');
      metrics.incrementCounter('plugin_load_count', 1, { status: 'failure' });
      throw err;
    }
  }

  /**
   * 批量加载插件
   * 
   * @async
   * @param {Object} pluginConfigs - 插件配置映射 {pluginName: config}
   */
  async loadPlugins(pluginConfigs) {
    const enabledPlugins = Object.keys(pluginConfigs);
    const loadOrder = this.resolveDependencies(enabledPlugins);

    for (const name of loadOrder) {
      await this.loadPlugin(name, pluginConfigs[name]);
    }

    this.isInitialized = true;
  }

  /**
   * 启动所有已加载的插件
   * 
   * @async
   */
  async startAll() {
    if (!this.isInitialized) {
      throw new Error('PluginManager not initialized');
    }

    const order = this.resolveDependencies([...this.loadedPlugins.keys()]);
    const context = this.getContext();

    for (const name of order) {
      const pluginInfo = this.loadedPlugins.get(name);
      try {
        await pluginInfo.instance.start(context);
        pluginInfo.status = 'running';
        this.logger.info({ plugin: name }, 'Plugin started');
      } catch (err) {
        this.logger.error({ err, plugin: name }, 'Plugin start failed');
        pluginInfo.status = 'error';
        throw err;
      }
    }

    this.isRunning = true;
  }

  /**
   * 停止所有插件（逆序）
   * 
   * @async
   */
  async stopAll() {
    if (!this.isRunning) return;

    const order = this.resolveDependencies([...this.loadedPlugins.keys()]).reverse();
    const context = this.getContext();

    for (const name of order) {
      const pluginInfo = this.loadedPlugins.get(name);
      try {
        await pluginInfo.instance.stop(context);
        pluginInfo.status = 'stopped';
        this.logger.info({ plugin: name }, 'Plugin stopped');
      } catch (err) {
        this.logger.error({ err, plugin: name }, 'Plugin stop failed');
      }
    }

    this.isRunning = false;
  }

  /**
   * 获取所有中间件（按优先级排序）
   * 
   * @returns {Function[]} Express 中间件数组
   */
  getMiddlewares() {
    return [...this.loadedPlugins.values()]
      .filter(p => p.instance.getMiddleware())
      .sort((a, b) => {
        const priorityA = a.instance.constructor.meta.priority || 100;
        const priorityB = b.instance.constructor.meta.priority || 100;
        return priorityA - priorityB;
      })
      .map(p => p.instance.getMiddleware());
  }

  /**
   * 启用插件
   * 
   * @async
   * @param {string} name - 插件名称
   * @param {Object} config - 插件配置
   */
  async enable(name, config = {}) {
    if (this.loadedPlugins.has(name)) {
      throw new Error(`Plugin "${name}" already enabled`);
    }

    await this.loadPlugin(name, config);

    if (this.isRunning) {
      const pluginInfo = this.loadedPlugins.get(name);
      await pluginInfo.instance.start(this.getContext());
      pluginInfo.status = 'running';
    }
  }

  /**
   * 禁用插件
   * 
   * @async
   * @param {string} name - 插件名称
   */
  async disable(name) {
    const pluginInfo = this.loadedPlugins.get(name);
    if (!pluginInfo) {
      throw new Error(`Plugin "${name}" not loaded`);
    }

    await pluginInfo.instance.stop(this.getContext());
    this.loadedPlugins.delete(name);
    this.logger.info({ plugin: name }, 'Plugin disabled');
  }

  /**
   * 更新插件配置
   * 
   * @async
   * @param {string} name - 插件名称
   * @param {Object} newConfig - 新配置
   */
  async updateConfig(name, newConfig) {
    const pluginInfo = this.loadedPlugins.get(name);
    if (!pluginInfo) {
      throw new Error(`Plugin "${name}" not loaded`);
    }

    // 停止并重新加载
    await this.disable(name);
    await this.enable(name, newConfig);
  }

  /**
   * 获取插件状态
   * 
   * @returns {Object} 插件状态信息
   */
  getStatus() {
    const plugins = [];
    for (const [name, info] of this.loadedPlugins) {
      plugins.push({
        name,
        version: info.instance.constructor.meta.version,
        status: info.status,
        config: info.config,
        loadedAt: info.loadedAt,
      });
    }

    return {
      isInitialized: this.isInitialized,
      isRunning: this.isRunning,
      totalPlugins: this.plugins.size,
      loadedPlugins: this.loadedPlugins.size,
      plugins,
    };
  }

  /**
   * 获取插件健康状态
   * 
   * @async
   * @param {string} name - 插件名称（可选，不传则检查所有）
   * @returns {Object} 健康检查结果
   */
  async healthCheck(name = null) {
    if (name) {
      const pluginInfo = this.loadedPlugins.get(name);
      if (!pluginInfo) {
        throw new Error(`Plugin "${name}" not loaded`);
      }
      return await pluginInfo.instance.healthCheck();
    }

    // 检查所有插件
    const results = {};
    for (const [pluginName, info] of this.loadedPlugins) {
      try {
        results[pluginName] = await info.instance.healthCheck();
      } catch (err) {
        results[pluginName] = {
          status: 'error',
          error: err.message,
        };
      }
    }
    return results;
  }

  /**
   * 获取插件上下文
   * 
   * @private
   * @returns {Object} 插件上下文对象
   */
  getContext() {
    return {
      logger: this.logger,
      metrics,
      config: this.config,
    };
  }

  /**
   * 设置全局配置
   * 
   * @param {Object} config - 全局配置对象
   */
  setConfig(config) {
    this.config = config;
  }
}

// 单例模式
const pluginManager = new PluginManager();

module.exports = { PluginManager, pluginManager };
