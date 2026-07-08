/**
 * 插件管理器 - 统一管理插件生命周期
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const EventEmitter = require('events');
const DependencyResolver = require('./DependencyResolver');
const PluginHotLoader = require('./PluginHotLoader');

class PluginManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.plugins = new Map();           // 插件实例映射
    this.pluginConfigs = new Map();     // 插件配置映射
    this.resolver = new DependencyResolver(); // 依赖解析器
    this.hotLoader = new PluginHotLoader(this); // 热加载器
    this.initializationOrder = [];      // 初始化顺序
    this.configCenter = null;           // 配置中心引用
    this.logger = config.logger || console;
  }

  /**
   * 注册插件
   * @param {BasePlugin} plugin 插件实例
   * @param {Object} config 插件配置（可选）
   * @returns {PluginManager} this（链式调用）
   */
  register(plugin, config = {}) {
    if (!plugin.name) {
      throw new Error('Plugin must have a name property');
    }

    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin ${plugin.name} already registered`);
    }

    // 设置插件管理器引用
    plugin.setManager(this);
    plugin.setConfig(config);

    this.plugins.set(plugin.name, plugin);
    this.pluginConfigs.set(plugin.name, config);
    
    // 注册依赖关系到解析器
    const deps = plugin.getDependencies() || [];
    this.resolver.addNode(plugin.name, deps);

    this.logger.log(`[PluginManager] Registered plugin: ${plugin.name} v${plugin.version}`);
    this.emit('plugin:registered', { name: plugin.name, version: plugin.version, dependencies: deps });

    return this; // 支持链式调用
  }

  /**
   * 注销插件
   * @param {string} pluginName 插件名称
   */
  async unregister(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    // 检查是否有其他插件依赖此插件
    const dependents = this.resolver.getDependents(pluginName);
    if (dependents.length > 0) {
      throw new Error(`Cannot unregister ${pluginName}: dependents [${dependents.join(', ')}] must be unregistered first`);
    }

    // 停止并清理插件
    await this.stopPlugin(pluginName);
    await plugin.cleanup();

    this.plugins.delete(pluginName);
    this.pluginConfigs.delete(pluginName);
    this.resolver.removeNode(pluginName);

    this.logger.log(`[PluginManager] Unregistered plugin: ${pluginName}`);
    this.emit('plugin:unregistered', { name: pluginName });
  }

  /**
   * 初始化所有插件（按依赖拓扑排序）
   */
  async initializeAll() {
    // 解析依赖，获取初始化顺序
    try {
      this.initializationOrder = this.resolver.resolve();
    } catch (error) {
      this.logger.error('[PluginManager] Dependency resolution failed:', error.message);
      throw error;
    }
    
    this.logger.log(`[PluginManager] Initialization order: ${this.initializationOrder.join(' → ')}`);

    for (const pluginName of this.initializationOrder) {
      await this.initializePlugin(pluginName);
    }
  }

  /**
   * 初始化单个插件
   */
  async initializePlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    if (plugin.state !== 'uninitialized') {
      return; // 已初始化
    }

    try {
      plugin.state = 'initializing';
      
      // 注入配置
      const config = this.pluginConfigs.get(pluginName);
      plugin.setConfig(config);

      // 调用初始化
      await plugin.initialize();

      plugin.state = 'initialized';
      this.logger.log(`[PluginManager] Initialized plugin: ${pluginName}`);
      this.emit('plugin:initialized', { name: pluginName });
    } catch (error) {
      plugin.state = 'error';
      this.logger.error(`[PluginManager] Failed to initialize ${pluginName}:`, error);
      this.emit('plugin:error', { name: pluginName, error, phase: 'initialize' });
      throw error;
    }
  }

  /**
   * 启动所有插件
   */
  async startAll() {
    for (const pluginName of this.initializationOrder) {
      await this.startPlugin(pluginName);
    }
  }

  /**
   * 启动单个插件
   */
  async startPlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    if (plugin.state === 'running') {
      return; // 已运行
    }

    if (plugin.state !== 'initialized' && plugin.state !== 'stopped') {
      throw new Error(`Cannot start plugin ${pluginName} in state: ${plugin.state}`);
    }

    try {
      await plugin.start();
      plugin.state = 'running';
      plugin.startedAt = Date.now();
      
      this.logger.log(`[PluginManager] Started plugin: ${pluginName}`);
      this.emit('plugin:started', { name: pluginName });
    } catch (error) {
      plugin.state = 'error';
      this.logger.error(`[PluginManager] Failed to start ${pluginName}:`, error);
      this.emit('plugin:error', { name: pluginName, error, phase: 'start' });
      throw error;
    }
  }

  /**
   * 停止所有插件（逆序停止）
   */
  async stopAll() {
    const stopOrder = [...this.initializationOrder].reverse();
    
    for (const pluginName of stopOrder) {
      await this.stopPlugin(pluginName);
    }
  }

  /**
   * 停止单个插件
   */
  async stopPlugin(pluginName) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin || plugin.state !== 'running') {
      return;
    }

    try {
      plugin.state = 'stopping';
      await plugin.stop();
      plugin.state = 'stopped';
      plugin.startedAt = null;
      
      this.logger.log(`[PluginManager] Stopped plugin: ${pluginName}`);
      this.emit('plugin:stopped', { name: pluginName });
    } catch (error) {
      plugin.state = 'error';
      this.logger.error(`[PluginManager] Failed to stop ${pluginName}:`, error);
      this.emit('plugin:error', { name: pluginName, error, phase: 'stop' });
      throw error;
    }
  }

  /**
   * 热加载插件
   * @param {string} pluginPath 插件模块路径
   * @param {Object} config 插件配置
   */
  async hotLoad(pluginPath, config = {}) {
    const plugin = await this.hotLoader.load(pluginPath);
    this.register(plugin, config);
    await this.initializePlugin(plugin.name);
    await this.startPlugin(plugin.name);
    
    this.logger.log(`[PluginManager] Hot-loaded plugin: ${plugin.name}`);
    this.emit('plugin:hot-loaded', { name: plugin.name, path: pluginPath });
    
    return plugin;
  }

  /**
   * 热卸载插件
   */
  async hotUnload(pluginName) {
    await this.unregister(pluginName);
    this.logger.log(`[PluginManager] Hot-unloaded plugin: ${pluginName}`);
    this.emit('plugin:hot-unloaded', { name: pluginName });
  }

  /**
   * 热更新插件配置
   */
  async hotUpdateConfig(pluginName, newConfig) {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) {
      throw new Error(`Plugin ${pluginName} not found`);
    }

    this.pluginConfigs.set(pluginName, newConfig);
    await plugin.onConfigUpdate(newConfig);
    
    this.logger.log(`[PluginManager] Updated config for plugin: ${pluginName}`);
    this.emit('plugin:config-updated', { name: pluginName });
  }

  /**
   * 获取插件实例
   * @param {string} pluginName 插件名称
   * @returns {BasePlugin|null}
   */
  getPlugin(pluginName) {
    return this.plugins.get(pluginName);
  }

  /**
   * 获取所有插件状态
   */
  getAllPluginStates() {
    const states = {};
    for (const [name, plugin] of this.plugins) {
      states[name] = plugin.getState();
    }
    return states;
  }

  /**
   * 健康检查所有插件
   */
  async healthCheckAll() {
    const results = {};
    for (const [name, plugin] of this.plugins) {
      try {
        results[name] = await plugin.healthCheck();
      } catch (error) {
        results[name] = { healthy: false, error: error.message };
      }
    }
    return results;
  }

  /**
   * 设置配置中心（用于配置热更新）
   */
  setConfigCenter(configCenter) {
    this.configCenter = configCenter;
    
    // 监听配置变更
    if (configCenter && configCenter.on) {
      configCenter.on('config:updated', async ({ key, value }) => {
        const pluginName = key.replace('plugin.', '');
        if (this.plugins.has(pluginName)) {
          await this.hotUpdateConfig(pluginName, value);
        }
      });
    }
  }

  /**
   * 获取初始化顺序
   */
  getInitializationOrder() {
    return [...this.initializationOrder];
  }

  /**
   * 获取插件数量
   */
  getPluginCount() {
    return this.plugins.size;
  }

  /**
   * 检查插件是否存在
   */
  hasPlugin(pluginName) {
    return this.plugins.has(pluginName);
  }
}

module.exports = PluginManager;