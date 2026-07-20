// backend/shared/mock/ServiceMockRegistry.js
// REQ-00607: 服务 Mock 机制

const logger = require('../logger');
const fs = require('fs').promises;
const path = require('path');

/**
 * 服务 Mock 注册表
 */
class ServiceMockRegistry {
  constructor(options = {}) {
    this.enabled = options.enabled !== false && process.env.NODE_ENV !== 'production';
    this.mocks = new Map();
    this.configPath = options.configPath || path.join(process.cwd(), 'config', 'mock-services.json');
    this.delaySimulation = options.delaySimulation || true;
    this.errorInjection = options.errorInjection || false;
    
    // 默认 Mock 响应
    this.defaultMocks = {
      'pokemon-service': {
        '/internal/ability/assign': {
          response: {
            abilityId: 'static-discharge',
            slot: 1,
            hidden: false
          },
          delay: 50
        },
        '/internal/ability/battle-effect': {
          response: {
            effect: 'paralyze',
            chance: 30,
            duration: 3
          },
          delay: 30
        },
        '/internal/status-effect/apply': {
          response: {
            applied: true,
            effectId: 'burn-001',
            turns: 3
          },
          delay: 20
        }
      },
      'user-service': {
        '/internal/user/validate': {
          response: {
            valid: true,
            userId: 'mock-user-001'
          },
          delay: 10
        }
      },
      'location-service': {
        '/internal/location/validate': {
          response: {
            valid: true,
            region: 'beijing'
          },
          delay: 10
        }
      }
    };
    
    // 加载配置
    this.loadConfig();
  }
  
  /**
   * 加载 Mock 配置
   */
  async loadConfig() {
    try {
      const configData = await fs.readFile(this.configPath, 'utf8');
      const config = JSON.parse(configData);
      
      for (const [serviceName, serviceConfig] of Object.entries(config)) {
        if (serviceConfig.enabled) {
          this.mocks.set(serviceName, serviceConfig.endpoints);
          logger.info({ serviceName }, 'Mock service loaded from config');
        }
      }
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        logger.debug('Mock config file not found, using defaults');
      } else {
        logger.warn({ error: error.message }, 'Failed to load mock config');
      }
      
      // 使用默认 Mock
      for (const [serviceName, endpoints] of Object.entries(this.defaultMocks)) {
        this.mocks.set(serviceName, endpoints);
      }
    }
  }
  
  /**
   * 注册 Mock
   */
  register(serviceName, endpoint, mockConfig) {
    if (!this.mocks.has(serviceName)) {
      this.mocks.set(serviceName, new Map());
    }
    
    const endpoints = this.mocks.get(serviceName);
    endpoints[endpoint] = {
      response: mockConfig.response,
      delay: mockConfig.delay || 0,
      status: mockConfig.status || 200,
      error: mockConfig.error || null
    };
    
    logger.info({ serviceName, endpoint }, 'Mock registered');
  }
  
  /**
   * 检查是否启用 Mock
   */
  isEnabled(serviceName, endpoint) {
    if (!this.enabled) {
      return false;
    }
    
    const serviceMocks = this.mocks.get(serviceName);
    if (!serviceMocks) {
      return false;
    }
    
    return endpoint in serviceMocks;
  }
  
  /**
   * 获取 Mock 响应
   */
  async getMock(serviceName, endpoint, options = {}) {
    const serviceMocks = this.mocks.get(serviceName);
    
    if (!serviceMocks || !serviceMocks[endpoint]) {
      logger.warn({ serviceName, endpoint }, 'No mock found for endpoint');
      return {
        status: 404,
        data: { error: 'Mock not found' }
      };
    }
    
    const mock = serviceMocks[endpoint];
    
    // 模拟延迟
    if (this.delaySimulation && mock.delay > 0) {
      await this.sleep(mock.delay);
    }
    
    // 错误注入
    if (this.errorInjection && mock.error) {
      const shouldError = Math.random() < mock.error.probability;
      if (shouldError) {
        throw new Error(mock.error.message || 'Injected error');
      }
    }
    
    // 自定义响应函数
    if (typeof mock.response === 'function') {
      return {
        status: mock.status || 200,
        data: await mock.response(options)
      };
    }
    
    return {
      status: mock.status || 200,
      data: mock.response
    };
  }
  
  /**
   * 清除 Mock
   */
  clear(serviceName, endpoint) {
    if (!serviceName) {
      this.mocks.clear();
      logger.info('All mocks cleared');
      return;
    }
    
    if (endpoint) {
      const serviceMocks = this.mocks.get(serviceName);
      if (serviceMocks) {
        delete serviceMocks[endpoint];
        logger.info({ serviceName, endpoint }, 'Mock cleared');
      }
    } else {
      this.mocks.delete(serviceName);
      logger.info({ serviceName }, 'Service mocks cleared');
    }
  }
  
  /**
   * 列出所有 Mock
   */
  list() {
    const result = {};
    
    for (const [serviceName, endpoints] of this.mocks) {
      result[serviceName] = Object.keys(endpoints);
    }
    
    return result;
  }
  
  /**
   * 设置延迟模拟
   */
  setDelaySimulation(enabled) {
    this.delaySimulation = enabled;
    logger.info({ enabled }, 'Delay simulation updated');
  }
  
  /**
   * 设置错误注入
   */
  setErrorInjection(enabled) {
    this.errorInjection = enabled;
    logger.info({ enabled }, 'Error injection updated');
  }
  
  /**
   * 模拟网络错误
   */
  simulateNetworkError(serviceName, endpoint, errorType = 'ECONNREFUSED') {
    const serviceMocks = this.mocks.get(serviceName);
    
    if (serviceMocks && serviceMocks[endpoint]) {
      serviceMocks[endpoint].error = {
        type: 'network',
        code: errorType,
        probability: 1
      };
      
      logger.info({ serviceName, endpoint, errorType }, 'Network error simulation set');
    }
  }
  
  /**
   * 模拟超时
   */
  simulateTimeout(serviceName, endpoint, timeoutMs = 30000) {
    const serviceMocks = this.mocks.get(serviceName);
    
    if (serviceMocks && serviceMocks[endpoint]) {
      serviceMocks[endpoint].delay = timeoutMs;
      
      logger.info({ serviceName, endpoint, timeoutMs }, 'Timeout simulation set');
    }
  }
  
  /**
   * Sleep 辅助函数
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 单例
let instance = null;

function getServiceMockRegistry(options = {}) {
  if (!instance) {
    instance = new ServiceMockRegistry(options);
  }
  return instance;
}

module.exports = {
  ServiceMockRegistry,
  getServiceMockRegistry
};
