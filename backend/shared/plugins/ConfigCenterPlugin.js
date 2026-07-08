/**
 * 配置中心插件适配器
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const BasePlugin = require('../pluginSystem/BasePlugin');
const ConfigCenter = require('../ConfigCenter');

class ConfigCenterPlugin extends BasePlugin {
  constructor() {
    super('configCenter', '1.0.0');
    this.dependencies = []; // 无依赖，是基础插件
    this.configCenter = null;
  }

  async initialize() {
    this.log('[ConfigCenterPlugin] Initializing...');
    
    this.configCenter = new ConfigCenter(this.config);
    
    // 监听配置变更并广播
    this.configCenter.on && this.configCenter.on('config:changed', (change) => {
      this.emit('config:updated', change);
    });
    
    this.log('[ConfigCenterPlugin] Initialized');
  }

  async start() {
    this.log('[ConfigCenterPlugin] Starting...');
    // 配置中心已在初始化时启动
  }

  async stop() {
    this.log('[ConfigCenterPlugin] Stopping...');
    if (this.configCenter) {
      this.configCenter.stop && this.configCenter.stop();
    }
  }

  async cleanup() {
    this.configCenter = null;
  }

  async onConfigUpdate(newConfig) {
    await super.onConfigUpdate(newConfig);
    if (this.configCenter) {
      this.configCenter.reload && this.configCenter.reload(newConfig);
    }
    this.log('[ConfigCenterPlugin] Config updated');
  }

  async healthCheck() {
    const baseResult = await super.healthCheck();
    const lastSync = this.configCenter ? (this.configCenter.getLastSyncTime ? this.configCenter.getLastSyncTime() : null) : null;
    
    return {
      ...baseResult,
      details: {
        configCenterStatus: this.configCenter ? 'available' : 'unavailable',
        lastSync
      }
    };
  }

  /**
   * 获取配置值
   */
  get(key) {
    return this.configCenter ? this.configCenter.get(key) : undefined;
  }

  /**
   * 设置配置值
   */
  set(key, value) {
    return this.configCenter ? this.configCenter.set(key, value) : false;
  }

  /**
   * 获取配置中心实例
   */
  getConfigCenter() {
    return this.configCenter;
  }

  log(message) {
    console.log(message);
  }
}

module.exports = ConfigCenterPlugin;