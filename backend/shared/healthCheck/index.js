'use strict';

/**
 * REQ-00508: 服务发现与动态负载均衡健康检查系统
 * 
 * 导出模块：
 * - HealthChecker: 服务健康检查器
 * - ServiceRegistry: 服务注册中心客户端
 * - LoadBalancer: 动态负载均衡器
 */

const HealthChecker = require('./HealthChecker');
const ServiceRegistry = require('./ServiceRegistry');
const LoadBalancer = require('./LoadBalancer');

module.exports = {
  HealthChecker,
  ServiceRegistry,
  LoadBalancer,

  /**
   * 创建完整的健康检查系统
   * @param {Object} config - 配置
   * @returns {Object} 包含所有组件的对象
   */
  createSystem(config) {
    const registry = new ServiceRegistry(config.registry || {});
    const healthChecker = new HealthChecker(config.healthChecker || {});
    const loadBalancer = new LoadBalancer({
      serviceRegistry: registry,
      healthChecker,
      ...config.loadBalancer || {}
    });

    return {
      registry,
      healthChecker,
      loadBalancer,

      /**
       * 注册服务并启动健康检查
       * @param {Object} serviceInstance - 服务实例配置
       */
      async registerService(serviceInstance) {
        // 先注册到注册中心
        const instanceId = await registry.register(serviceInstance);
        
        // 再注册到健康检查器
        healthChecker.register({
          id: instanceId,
          name: serviceInstance.name,
          host: serviceInstance.host,
          port: serviceInstance.port,
          protocol: serviceInstance.protocol,
          healthPath: serviceInstance.healthPath || '/health',
          checkInterval: serviceInstance.checkInterval,
          timeout: serviceInstance.timeout
        });

        return instanceId;
      },

      /**
       * 注销服务
       * @param {string} instanceId - 实例ID
       */
      async deregisterService(instanceId) {
        healthChecker.deregister(instanceId);
        await registry.deregister(instanceId);
      },

      /**
       * 关闭所有组件
       */
      async shutdown() {
        healthChecker.shutdown();
        await registry.shutdown();
      }
    };
  }
};