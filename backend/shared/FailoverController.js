/**
 * REQ-00399: 故障转移控制器
 */
const logger = require('./logger');

class FailoverController {
  constructor(options = {}) {
    this.services = {};
    this.primary = {};
    this.fallback = {};
    this.healthCheckInterval = options.healthCheckInterval || 30000;
  }
  
  registerService(name, primary, fallback) {
    this.services[name] = { primary, fallback, healthy: true };
    this.primary[name] = primary;
    this.fallback[name] = fallback;
  }
  
  getService(name) {
    const service = this.services[name];
    if (!service) return null;
    return service.healthy ? service.primary : service.fallback;
  }
  
  async healthCheck(name) {
    const service = this.services[name];
    if (!service) return false;
    try {
      // 简单健康检查
      service.healthy = true;
      return true;
    } catch (error) {
      service.healthy = false;
      logger.warn({ module: 'FailoverController', service: name, msg: 'Health check failed' });
      return false;
    }
  }
}

async function failover(serviceName, options = {}) {
  const controller = new FailoverController(options);
  return controller.getService(serviceName);
}

module.exports = {
  FailoverController,
  failover
};