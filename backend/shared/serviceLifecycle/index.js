// backend/shared/serviceLifecycle/index.js
// 服务生命周期管理模块入口
'use strict';

const {
  ServiceLifecycleManager,
  createServiceLifecycleManager
} = require('./ServiceLifecycleManager');

const ServiceLifecycleStateMachine = require('./ServiceLifecycleStateMachine');
const GracefulShutdownOrchestrator = require('./GracefulShutdownOrchestrator');
const DependencyStartupCoordinator = require('./DependencyStartupCoordinator');

const {
  ServiceLifecycleState,
  STATE_TRANSITIONS,
  STATE_GROUPS,
  STATE_DESCRIPTIONS,
  canAcceptRequests,
  isRunning,
  isShuttingDown,
  isTerminal,
  getStateGroup
} = require('./ServiceLifecycleState');

/**
 * 快速创建服务生命周期管理器
 * @param {string} serviceName 服务名称
 * @param {Object} config 配置选项
 */
async function createLifecycleManager(serviceName, config) {
  return createServiceLifecycleManager(serviceName, config);
}

/**
 * 装饰器：为服务添加生命周期管理
 * @param {Object} service 服务实例
 * @param {string} serviceName 服务名称
 */
function withLifecycle(service, serviceName) {
  const manager = new ServiceLifecycleManager(serviceName);
  
  // 添加生命周期方法到服务
  service.lifecycle = manager;
  service.start = async (config) => {
    await manager.start(config);
  };
  service.stop = async () => {
    await manager.stop();
  };
  service.healthCheck = async () => {
    return manager.healthCheck();
  };
  
  return service;
}

module.exports = {
  // 主要导出
  ServiceLifecycleManager,
  createServiceLifecycleManager,
  createLifecycleManager,
  withLifecycle,
  
  // 子模块
  ServiceLifecycleStateMachine,
  GracefulShutdownOrchestrator,
  DependencyStartupCoordinator,
  
  // 状态定义
  ServiceLifecycleState,
  STATE_TRANSITIONS,
  STATE_GROUPS,
  STATE_DESCRIPTIONS,
  
  // 工具函数
  canAcceptRequests,
  isRunning,
  isShuttingDown,
  isTerminal,
  getStateGroup
};
