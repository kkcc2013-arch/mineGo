/**
 * 熔断器插件适配器
 * REQ-00505: 插件生命周期管理与热插拔系统
 */

const BasePlugin = require('../pluginSystem/BasePlugin');
const CircuitBreaker = require('../CircuitBreaker');

class CircuitBreakerPlugin extends BasePlugin {
  constructor() {
    super('circuitBreaker', '1.0.0');
    this.dependencies = ['configCenter']; // 依赖配置中心
    this.breaker = null;
  }

  async initialize() {
    this.log('[CircuitBreakerPlugin] Initializing...');
    
    // 从配置中心获取配置（如果存在）
    const configCenter = this.getDependency('configCenter');
    if (configCenter) {
      this.config = configCenter.get('circuitBreaker') || this.config;
    }
    
    this.breaker = new CircuitBreaker(this.config);
    this.log('[CircuitBreakerPlugin] Initialized');
  }

  async start() {
    this.log('[CircuitBreakerPlugin] Starting...');
    // 熔断器无需启动操作，初始化时已创建实例
  }

  async stop() {
    this.log('[CircuitBreakerPlugin] Stopping...');
    // 关闭所有熔断器
    if (this.breaker) {
      this.breaker.closeAll && this.breaker.closeAll();
    }
  }

  async cleanup() {
    this.breaker = null;
  }

  async onConfigUpdate(newConfig) {
    await super.onConfigUpdate(newConfig);
    if (this.breaker && this.breaker.updateConfig) {
      this.breaker.updateConfig(newConfig);
    }
    this.log('[CircuitBreakerPlugin] Config updated');
  }

  async healthCheck() {
    const baseResult = await super.healthCheck();
    return {
      ...baseResult,
      details: {
        circuitBreakerStatus: this.breaker ? 'available' : 'unavailable'
      }
    };
  }

  /**
   * 获取熔断器实例（供外部使用）
   */
  getBreaker() {
    return this.breaker;
  }

  log(message) {
    console.log(message);
  }
}

module.exports = CircuitBreakerPlugin;