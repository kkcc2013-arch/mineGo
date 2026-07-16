// mockService/managers/VirtualServiceManager.js - 虚拟服务管理器
'use strict';

/**
 * REQ-00546: API Mock 服务与测试隔离系统
 * 
 * VirtualServiceManager - 微服务虚拟化管理器
 * 
 * 特性：
 * - 为 9 个微服务提供虚拟化版本
 * - 服务状态管理
 * - 服务发现集成
 * - 动态路由
 * - 服务降级模拟
 */

const { createLogger } = require('../../logger');
const MockServer = require('../core/MockServer');
const DataFactory = require('../factories/DataFactory');

const logger = createLogger('virtual-service-manager');

/**
 * 微服务定义
 */
const MICROSERVICES = {
  gateway: {
    name: 'Gateway Service',
    port: 3000,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'GET', path: '/api/users', response: { users: [] } },
      { method: 'POST', path: '/api/auth/login', response: { token: 'mock-jwt-token' } }
    ]
  },
  user: {
    name: 'User Service',
    port: 3001,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'GET', path: '/users/:id', response: (req) => ({ id: req.params.id, username: 'mock_user' }) },
      { method: 'PUT', path: '/users/:id', response: { success: true } }
    ]
  },
  location: {
    name: 'Location Service',
    port: 3002,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'GET', path: '/nearby', response: { pokemon: [], gyms: [], pokestops: [] } },
      { method: 'POST', path: '/update', response: { success: true } }
    ]
  },
  pokemon: {
    name: 'Pokemon Service',
    port: 3003,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'GET', path: '/pokemon/:id', response: (req) => ({ id: req.params.id, species_id: 25, name: 'Pikachu' }) },
      { method: 'GET', path: '/inventory/:userId', response: { pokemon: [] } }
    ]
  },
  catch: {
    name: 'Catch Service',
    port: 3004,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'POST', path: '/catch', response: { success: true, pokemon_id: 'mock-pokemon-id' } },
      { method: 'POST', path: '/encounter', response: { pokemon: {} } }
    ]
  },
  gym: {
    name: 'Gym Service',
    port: 3005,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'GET', path: '/gyms/:id', response: (req) => ({ id: req.params.id, name: 'Mock Gym', level: 3 }) },
      { method: 'POST', path: '/battle', response: { result: 'win', xp: 100 } }
    ]
  },
  social: {
    name: 'Social Service',
    port: 3006,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'GET', path: '/friends/:userId', response: { friends: [] } },
      { method: 'POST', path: '/trade', response: { success: true } }
    ]
  },
  reward: {
    name: 'Reward Service',
    port: 3007,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'POST', path: '/claim', response: { rewards: [] } },
      { method: 'GET', path: '/daily', response: { available: true, rewards: [] } }
    ]
  },
  payment: {
    name: 'Payment Service',
    port: 3008,
    routes: [
      { method: 'GET', path: '/health', response: { status: 'ok' } },
      { method: 'POST', path: '/purchase', response: { success: true, transaction_id: 'mock-transaction-id' } },
      { method: 'GET', path: '/products', response: { products: [] } }
    ]
  }
};

/**
 * 虚拟服务类
 */
class VirtualService {
  constructor(serviceName, config, dataFactory) {
    this.serviceName = serviceName;
    this.config = config;
    this.dataFactory = dataFactory;
    this.server = null;
    this.isRunning = false;
    this.routes = new Map();
    this.stats = {
      requests: 0,
      errors: 0,
      avgResponseTime: 0
    };
    
    this._initializeRoutes();
  }

  /**
   * 初始化路由
   */
  _initializeRoutes() {
    const serviceDef = MICROSERVICES[this.serviceName];
    if (!serviceDef) {
      logger.warn({ service: this.serviceName }, 'Service definition not found');
      return;
    }
    
    for (const routeConfig of serviceDef.routes) {
      this.addRoute(routeConfig);
    }
  }

  /**
   * 添加路由
   */
  addRoute(config) {
    const key = `${config.method}:${config.path}`;
    this.routes.set(key, config);
    
    logger.debug({
      service: this.serviceName,
      method: config.method,
      path: config.path
    }, 'Route added');
  }

  /**
   * 启动虚拟服务
   */
  async start() {
    if (this.isRunning) {
      logger.warn({ service: this.serviceName }, 'Service already running');
      return;
    }
    
    const serviceDef = MICROSERVICES[this.serviceName];
    const port = serviceDef.port + 9000; // 避免端口冲突
    
    this.server = new MockServer({
      port,
      mode: 'replay'
    });
    
    // 注册所有路由
    for (const route of this.routes.values()) {
      this.server.registerRoute(route);
    }
    
    await this.server.start();
    this.isRunning = true;
    
    logger.info({
      service: this.serviceName,
      port
    }, 'Virtual service started');
  }

  /**
   * 停止虚拟服务
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    await this.server.stop();
    this.isRunning = false;
    
    logger.info({ service: this.serviceName }, 'Virtual service stopped');
  }

  /**
   * 模拟服务降级
   */
  simulateDegradation(type = 'slow', options = {}) {
    switch (type) {
      case 'slow':
        // 慢响应
        for (const route of this.routes.values()) {
          route.delay = options.delay || 5000;
        }
        break;
        
      case 'errors':
        // 错误响应
        for (const route of this.routes.values()) {
          route.errors = [{ status: 503, body: { error: 'Service unavailable' } }];
        }
        break;
        
      case 'timeout':
        // 超时
        for (const route of this.routes.values()) {
          route.delay = options.timeout || 30000;
        }
        break;
    }
    
    logger.info({ service: this.serviceName, type }, 'Simulating service degradation');
  }

  /**
   * 恢复正常
   */
  restore() {
    for (const route of this.routes.values()) {
      route.delay = 0;
      route.errors = [];
    }
    
    logger.info({ service: this.serviceName }, 'Service restored to normal');
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      serviceName: this.serviceName,
      isRunning: this.isRunning,
      routes: this.routes.size,
      ...this.stats,
      serverStats: this.server ? this.server.getStats() : null
    };
  }
}

/**
 * 虚拟服务管理器
 */
class VirtualServiceManager {
  constructor(config = {}) {
    this.config = config;
    this.services = new Map();
    this.dataFactory = new DataFactory(config);
    this.isInitialized = false;
    
    logger.info('VirtualServiceManager created');
  }

  /**
   * 初始化所有虚拟服务
   */
  async initialize() {
    if (this.isInitialized) {
      logger.warn('VirtualServiceManager already initialized');
      return;
    }
    
    // 创建所有虚拟服务实例
    for (const serviceName of Object.keys(MICROSERVICES)) {
      const service = new VirtualService(serviceName, this.config, this.dataFactory);
      this.services.set(serviceName, service);
    }
    
    this.isInitialized = true;
    logger.info({ services: this.services.size }, 'All virtual services initialized');
  }

  /**
   * 启动指定服务
   */
  async startService(serviceName) {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }
    
    await service.start();
    return service;
  }

  /**
   * 启动所有服务
   */
  async startAll() {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const promises = [];
    for (const service of this.services.values()) {
      promises.push(service.start());
    }
    
    await Promise.all(promises);
    
    logger.info('All virtual services started');
  }

  /**
   * 停止指定服务
   */
  async stopService(serviceName) {
    const service = this.services.get(serviceName);
    if (!service) {
      return;
    }
    
    await service.stop();
  }

  /**
   * 停止所有服务
   */
  async stopAll() {
    const promises = [];
    for (const service of this.services.values()) {
      promises.push(service.stop());
    }
    
    await Promise.all(promises);
    
    logger.info('All virtual services stopped');
  }

  /**
   * 关闭管理器
   */
  async shutdown() {
    await this.stopAll();
    this.services.clear();
    this.isInitialized = false;
    
    logger.info('VirtualServiceManager shutdown');
  }

  /**
   * 获取服务实例
   */
  getService(serviceName) {
    return this.services.get(serviceName);
  }

  /**
   * 为服务添加自定义路由
   */
  addCustomRoute(serviceName, routeConfig) {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }
    
    service.addRoute(routeConfig);
    
    logger.info({
      service: serviceName,
      method: routeConfig.method,
      path: routeConfig.path
    }, 'Custom route added');
  }

  /**
   * 模拟服务降级
   */
  simulateDegradation(serviceName, type, options = {}) {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }
    
    service.simulateDegradation(type, options);
  }

  /**
   * 恢复服务
   */
  restoreService(serviceName) {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service not found: ${serviceName}`);
    }
    
    service.restore();
  }

  /**
   * 获取所有服务状态
   */
  getAllServicesStatus() {
    const status = {};
    
    for (const [name, service] of this.services) {
      status[name] = service.getStats();
    }
    
    return status;
  }

  /**
   * 获取服务发现信息
   */
  getServiceDiscovery() {
    const discovery = {};
    
    for (const [name, service] of this.services) {
      if (service.isRunning) {
        const serviceDef = MICROSERVICES[name];
        discovery[name] = {
          name: serviceDef.name,
          port: serviceDef.port + 9000,
          status: 'running'
        };
      }
    }
    
    return discovery;
  }

  /**
   * 获取数据工厂
   */
  getDataFactory() {
    return this.dataFactory;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalServices: this.services.size,
      runningServices: Array.from(this.services.values()).filter(s => s.isRunning).length,
      isInitialized: this.isInitialized,
      services: this.getAllServicesStatus()
    };
  }
}

module.exports = VirtualServiceManager;