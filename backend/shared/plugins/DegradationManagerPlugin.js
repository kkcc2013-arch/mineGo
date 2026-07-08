/**
 * 降级管理器插件适配器
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const BasePlugin = require('../pluginSystem/BasePlugin');
const DegradationManager = require('../DegradationManager');

class DegradationManagerPlugin extends BasePlugin {
  constructor() {
    super('degradationManager', '1.0.0');
    this.dependencies = ['configCenter', 'circuitBreaker'];
    this.manager = null;
  }

  async initialize() {
    this.log('[DegradationManagerPlugin] Initializing...');
    
    const configCenter = this.getDependency('configCenter');
    if (configCenter) {
      this.config = configCenter.get('degradation') || this.config;
    }
    
    this.manager = new DegradationManager(this.config);
    this.log('[DegradationManagerPlugin] Initialized');
  }

  async start() {
    this.log('[DegradationManagerPlugin] Starting...');
    // 启动降级策略监控
    if (this.manager) {
      this.manager.start && this.manager.start();
    }
  }

  async stop() {
    this.log('[DegradationManagerPlugin] Stopping...');
    if (this.manager) {
      this.manager.stop && this.manager.stop();
    }
  }

  async cleanup() {
    this.manager = null;
  }

  async onConfigUpdate(newConfig) {
    await super.onConfigUpdate(newConfig);
    if (this.manager && this.manager.updateConfig) {
      this.manager.updateConfig(newConfig);
    }
    this.log('[DegradationManagerPlugin] Config updated');
  }

  async healthCheck() {
    const baseResult = await super.healthCheck();
    const degradationStatus = this.manager ? (this.manager.getStatus ? this.manager.getStatus() : 'unknown') : 'unavailable';
    
    return {
      ...baseResult,
      details: {
        managerStatus: this.manager ? 'available' : 'unavailable',
        degradationStatus
      }
    };
  }

  /**
   * 获取降级管理器实例
   */
  getManager() {
    return this.manager;
  }

  log(message) {
    console.log(message);
  }
}

module.exports = DegradationManagerPlugin;