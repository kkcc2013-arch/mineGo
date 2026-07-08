/**
 * 混沌工程插件适配器
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const BasePlugin = require('../pluginSystem/BasePlugin');
const ChaosEngine = require('../ChaosEngine');

class ChaosEnginePlugin extends BasePlugin {
  constructor() {
    super('chaosEngine', '1.0.0');
    this.dependencies = ['configCenter'];
    this.engine = null;
  }

  async initialize() {
    this.log('[ChaosEnginePlugin] Initializing...');
    
    const configCenter = this.getDependency('configCenter');
    if (configCenter) {
      this.config = configCenter.get('chaos') || this.config;
    }
    
    this.engine = new ChaosEngine(this.config);
    this.log('[ChaosEnginePlugin] Initialized');
  }

  async start() {
    this.log('[ChaosEnginePlugin] Starting...');
    // 混沌引擎在需要时才激活实验
  }

  async stop() {
    this.log('[ChaosEnginePlugin] Stopping...');
    if (this.engine) {
      this.engine.stopAllExperiments && this.engine.stopAllExperiments();
    }
  }

  async cleanup() {
    this.engine = null;
  }

  async onConfigUpdate(newConfig) {
    await super.onConfigUpdate(newConfig);
    if (this.engine && this.engine.updateConfig) {
      this.engine.updateConfig(newConfig);
    }
    this.log('[ChaosEnginePlugin] Config updated');
  }

  async healthCheck() {
    const baseResult = await super.healthCheck();
    const activeExperiments = this.engine ? (this.engine.getActiveExperiments ? this.engine.getActiveExperiments() : []) : [];
    
    return {
      ...baseResult,
      details: {
        engineStatus: this.engine ? 'available' : 'unavailable',
        activeExperiments: activeExperiments.length
      }
    };
  }

  /**
   * 获取混沌引擎实例
   */
  getEngine() {
    return this.engine;
  }

  log(message) {
    console.log(message);
  }
}

module.exports = ChaosEnginePlugin;