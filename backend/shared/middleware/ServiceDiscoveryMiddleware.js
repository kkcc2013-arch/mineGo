'use strict';
/**
 * 服务发现中间件
 * REQ-00300: 动态服务注册发现与健康感知路由系统
 * 
 * Gateway 动态路由中间件
 */

const logger = require('./logger');
const { getRegistry } = require('./ServiceRegistry');
const { getServiceSelector } = require('./LoadBalancer');
const http = require('http');
const https = require('https');

/**
 * 服务发现中间件配置
 */
const DEFAULT_CONFIG = {
  discoveryTimeout: 100, // 服务发现超时 100ms
  proxyTimeout: 30000, // 代理请求超时 30s
  retryCount: 2, // 重试次数
  retryDelay: 100, // 重试延迟 100ms
  enableCanary: true, // 启用金丝雀路由
  enableCircuitBreaker: true, // 启用熔断器
  circuitBreakerThreshold: 5, // 熔断器阈值
  circuitBreakerTimeout: 30000 // 熔断器恢复超时
};

/**
 * 服务路由映射
 */
const SERVICE_ROUTES = {
  '/api/user': 'user-service',
  '/api/pokemon': 'pokemon-service',
  '/api/location': 'location-service',
  '/api/catch': 'catch-service',
  '/api/gym': 'gym-service',
  '/api/social': 'social-service',
  '/api/reward': 'reward-service',
  '/api/payment': 'payment-service'
};

/**
 * 服务发现中间件
 */
class ServiceDiscoveryMiddleware {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = getRegistry();
    this.selector = getServiceSelector({
      canaryEnabled: this.config.enableCanary
    });
    
    // 熔断器状态
    this.circuitBreakers = new Map();
    
    // 服务调用统计
    this.serviceStats = new Map();
  }

  /**
   * 提取服务名称
   */
  extractServiceName(path) {
    for (const [prefix, serviceName] of Object.entries(SERVICE_ROUTES)) {
      if (path.startsWith(prefix)) {
        return serviceName;
      }
    }
    return null;
  }

  /**
   * 发现服务实例
   */
  async discoverService(serviceName, req) {
    const startTime = Date.now();

    try {
      // 发现健康实例
      const instances = await this.registry.discover(serviceName, {
        healthStatus: 'healthy',
        minHealthScore: 50
      });

      if (!instances || instances.length === 0) {
        throw new Error(`No healthy instances for ${serviceName}`);
      }

      // 选择实例
      const instance = await this.selector.selectInstance(instances, {
        req,
        strategy: 'weighted-round-robin',
        zone: req.headers['x-zone'] || 'default'
      });

      if (!instance) {
        throw new Error(`Failed to select instance for ${serviceName}`);
      }

      const discoveryTime = Date.now() - startTime;
      
      logger.debug('Service instance discovered', {
        serviceName,
        instanceId: instance.instanceId,
        host: instance.host,
        port: instance.port,
        discoveryTime
      });

      return instance;
    } catch (err) {
      logger.error('Service discovery failed', {
        serviceName,
        error: err.message,
        discoveryTime: Date.now() - startTime
      });
      throw err;
    }
  }

  /**
   * 检查熔断器状态
   */
  checkCircuitBreaker(instanceId) {
    if (!this.config.enableCircuitBreaker) {
      return true;
    }

    const breaker = this.circuitBreakers.get(instanceId);
    
    if (!breaker) {
      return true;
    }

    if (breaker.state === 'open') {
      const now = Date.now();
      if (now - breaker.lastFailure > this.config.circuitBreakerTimeout) {
        // 进入半开状态
        breaker.state = 'half-open';
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * 记录成功
   */
  recordSuccess(instanceId) {
    const breaker = this.circuitBreakers.get(instanceId);
    if (breaker) {
      breaker.failureCount = 0;
      breaker.state = 'closed';
    }
  }

  /**
   * 记录失败
   */
  recordFailure(instanceId) {
    if (!this.config.enableCircuitBreaker) {
      return;
    }

    let breaker = this.circuitBreakers.get(instanceId);
    if (!breaker) {
      breaker = {
        state: 'closed',
        failureCount: 0,
        lastFailure: 0
      };
      this.circuitBreakers.set(instanceId, breaker);
    }

    breaker.failureCount++;
    breaker.lastFailure = Date.now();

    if (breaker.failureCount >= this.config.circuitBreakerThreshold) {
      breaker.state = 'open';
      
      logger.warn('Circuit breaker opened', {
        instanceId,
        failureCount: breaker.failureCount
      });
    }
  }

  /**
   * 代理请求
   */
  async proxyRequest(req, res, instance) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      // 构造目标 URL
      const targetPath = req.originalUrl || req.url;
      const options = {
        hostname: instance.host,
        port: instance.port,
        path: targetPath,
        method: req.method,
        headers: {
          ...req.headers,
          'x-forwarded-for': req.ip || req.connection.remoteAddress,
          'x-forwarded-host': req.headers.host,
          'x-instance-id': instance.instanceId
        },
        timeout: this.config.proxyTimeout
      };

      const protocol = instance.port === 443 ? https : http;
      
      const proxyReq = protocol.request(options, (proxyRes) => {
        const responseTime = Date.now() - startTime;
        
        // 更新统计
        this.updateStats(instance.serviceName, responseTime, proxyRes.statusCode);

        // 复制响应头
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        
        // 流式传输响应体
        proxyRes.pipe(res);
        
        proxyRes.on('end', () => {
          this.recordSuccess(instance.instanceId);
          resolve();
        });
      });

      proxyReq.on('error', (err) => {
        const responseTime = Date.now() - startTime;
        this.updateStats(instance.serviceName, responseTime, 500);
        this.recordFailure(instance.instanceId);
        
        logger.error('Proxy request failed', {
          instanceId: instance.instanceId,
          error: err.message,
          responseTime
        });
        
        reject(err);
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        this.recordFailure(instance.instanceId);
        reject(new Error('Proxy timeout'));
      });

      // 流式传输请求体
      if (req.body) {
        proxyReq.write(JSON.stringify(req.body));
      }
      
      req.pipe(proxyReq);
    });
  }

  /**
   * 更新统计
   */
  updateStats(serviceName, responseTime, statusCode) {
    let stats = this.serviceStats.get(serviceName);
    if (!stats) {
      stats = {
        totalRequests: 0,
        successRequests: 0,
        errorRequests: 0,
        totalResponseTime: 0,
        avgResponseTime: 0
      };
      this.serviceStats.set(serviceName, stats);
    }

    stats.totalRequests++;
    stats.totalResponseTime += responseTime;
    stats.avgResponseTime = stats.totalResponseTime / stats.totalRequests;

    if (statusCode >= 200 && statusCode < 400) {
      stats.successRequests++;
    } else {
      stats.errorRequests++;
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const result = {};
    for (const [serviceName, stats] of this.serviceStats.entries()) {
      result[serviceName] = {
        ...stats,
        errorRate: stats.totalRequests > 0 
          ? (stats.errorRequests / stats.totalRequests * 100).toFixed(2) + '%'
          : '0%'
      };
    }
    return result;
  }

  /**
   * 中间件主函数
   */
  middleware() {
    return async (req, res, next) => {
      const serviceName = this.extractServiceName(req.path);

      if (!serviceName) {
        // 不在路由映射中，直接跳过
        return next();
      }

      try {
        // 发现服务实例
        const instance = await this.discoverService(serviceName, req);

        // 检查熔断器
        if (!this.checkCircuitBreaker(instance.instanceId)) {
          // 尝试发现其他实例
          const alternativeInstance = await this.findAlternativeInstance(serviceName, instance.instanceId, req);
          
          if (alternativeInstance) {
            await this.proxyRequest(req, res, alternativeInstance);
            return;
          } else {
            throw new Error('Service unavailable due to circuit breaker');
          }
        }

        // 代理请求
        await this.proxyRequest(req, res, instance);
        
      } catch (err) {
        logger.error('Service discovery middleware error', {
          serviceName,
          path: req.path,
          error: err.message
        });

        res.status(503).json({
          code: 5001,
          message: 'Service temporarily unavailable',
          error: err.message,
          service: serviceName
        });
      }
    };
  }

  /**
   * 查找替代实例
   */
  async findAlternativeInstance(serviceName, excludeInstanceId, req) {
    const instances = await this.registry.discover(serviceName, {
      healthStatus: 'healthy',
      minHealthScore: 50
    });

    const alternatives = instances.filter(inst => {
      return inst.instanceId !== excludeInstanceId && 
             this.checkCircuitBreaker(inst.instanceId);
    });

    if (alternatives.length === 0) {
      return null;
    }

    return this.selector.selectInstance(alternatives, { req });
  }

  /**
   * 重试逻辑
   */
  async retryRequest(req, res, serviceName, retryCount = 0) {
    if (retryCount >= this.config.retryCount) {
      throw new Error('Max retry count exceeded');
    }

    try {
      const instance = await this.discoverService(serviceName, req);
      await this.proxyRequest(req, res, instance);
    } catch (err) {
      await new Promise(resolve => setTimeout(resolve, this.config.retryDelay));
      await this.retryRequest(req, res, serviceName, retryCount + 1);
    }
  }
}

/**
 * 创建服务发现中间件
 */
function createServiceDiscoveryMiddleware(config = {}) {
  const middleware = new ServiceDiscoveryMiddleware(config);
  return middleware.middleware();
}

/**
 * 获取中间件实例（用于访问统计等方法）
 */
function getServiceDiscoveryMiddleware(config = {}) {
  return new ServiceDiscoveryMiddleware(config);
}

module.exports = {
  ServiceDiscoveryMiddleware,
  createServiceDiscoveryMiddleware,
  getServiceDiscoveryMiddleware,
  SERVICE_ROUTES,
  DEFAULT_CONFIG
};
