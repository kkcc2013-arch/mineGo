/**
 * 插件基类，所有插件必须继承此类
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

class BasePlugin {
  constructor(name, version) {
    this.name = name;
    this.version = version;
    this.state = 'uninitialized'; // uninitialized | initializing | initialized | running | stopping | stopped | error
    this.config = {};
    this.dependencies = [];
    this.startedAt = null;
    this.manager = null; // PluginManager 引用
  }

  /**
   * 声明插件依赖
   * @returns {string[]} 依赖的插件名称列表
   */
  getDependencies() {
    return this.dependencies;
  }

  /**
   * 设置插件配置
   * @param {Object} config 配置对象
   */
  setConfig(config) {
    this.config = config || {};
  }

  /**
   * 设置 PluginManager 引用
   * @param {PluginManager} manager
   */
  setManager(manager) {
    this.manager = manager;
  }

  /**
   * 初始化插件（子类实现）
   * 在所有依赖插件初始化完成后调用
   */
  async initialize() {
    throw new Error(`${this.name} must implement initialize()`);
  }

  /**
   * 启动插件（子类实现）
   */
  async start() {
    throw new Error(`${this.name} must implement start()`);
  }

  /**
   * 停止插件（子类实现）
   */
  async stop() {
    throw new Error(`${this.name} must implement stop()`);
  }

  /**
   * 清理插件资源（子类实现）
   */
  async cleanup() {
    throw new Error(`${this.name} must implement cleanup()`);
  }

  /**
   * 健康检查（子类可选实现）
   * @returns {Promise<{healthy: boolean, details?: Object}>}
   */
  async healthCheck() {
    return { 
      healthy: this.state === 'running',
      details: {
        state: this.state,
        uptime: this.startedAt ? Date.now() - this.startedAt : 0
      }
    };
  }

  /**
   * 配置热更新回调（子类可选实现）
   * @param {Object} newConfig 新配置
   */
  async onConfigUpdate(newConfig) {
    this.config = newConfig;
  }

  /**
   * 获取插件状态
   */
  getState() {
    return {
      name: this.name,
      version: this.version,
      state: this.state,
      dependencies: this.dependencies,
      config: this.config,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      startedAt: this.startedAt
    };
  }

  /**
   * 获取依赖插件实例
   * @param {string} depName 依赖插件名称
   * @returns {BasePlugin|null}
   */
  getDependency(depName) {
    if (!this.manager) return null;
    return this.manager.getPlugin(depName);
  }
}

module.exports = BasePlugin;