// backend/shared/serviceDiscovery/ServiceDiscoveryClient.js
// REQ-00607: 服务发现客户端

const logger = require('../logger');
const { metrics } = require('../metrics');
const { getRedis } = require('../redis');
const CircuitBreaker = require('../CircuitBreaker');

/**
 * 负载均衡策略
 */
const LoadBalanceStrategy = {
  ROUND_ROBIN: 'round-robin',
  WEIGHTED: 'weighted',
  LEAST_CONNECTIONS: 'least-connections',
  RANDOM: 'random'
};

/**
 * 服务发现客户端
 */
class ServiceDiscoveryClient {
  constructor(options = {}) {
    this.redisClient = options.redisClient || getRedis();
    this.cacheTTL = options.cacheTTL || 30000; // 缓存 30 秒
    this.healthCheckInterval = options.healthCheckInterval || 10000;
    this.failureThreshold = options.failureThreshold || 3;
    this.recoveryThreshold = options.recoveryThreshold || 5;
    
    // 本地缓存
    this.serviceCache = new Map();
    this.cacheExpiry = new Map();
    
    // 负载均衡策略
    this.loadBalanceStrategy = options.loadBalanceStrategy || LoadBalanceStrategy.ROUND_ROBIN;
    this.roundRobinIndex = new Map();
    
    // 熔断器
    this.circuitBreakers = new Map();
    
    // 健康检查计数器
    this.failureCounts = new Map();
    this.recoveryCounts = new Map();
    
    // 指标
    this.initMetrics();
    
    // 监控定时器
    this.monitors = new Map();
  }
  
  /**
   * 初始化 Prometheus 指标
   */
  initMetrics() {
    this.metrics = {
      serviceDiscoveryRequestsTotal: new metrics.Counter({
        name: 'minego_service_discovery_requests_total',
        help: 'Total service discovery requests',
        labelNames: ['service', 'operation', 'status']
      }),
      
      serviceDiscoveryCacheHits: new metrics.Counter({
        name: 'minego_service_discovery_cache_hits_total',
        help: 'Service discovery cache hits',
        labelNames: ['service']
      }),
      
      serviceDiscoveryCacheMisses: new metrics.Counter({
        name: 'minego_service_discovery_cache_misses_total',
        help: 'Service discovery cache misses',
        labelNames: ['service']
      }),
      
      serviceDiscoveryLatency: new metrics.Histogram({
        name: 'minego_service_discovery_latency_seconds',
        help: 'Service discovery latency',
        labelNames: ['service', 'operation'],
        buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
      })
    };
  }
  
  /**
   * 注册服务实例
   */
  async register(serviceName, metadata = {}) {
    const start = Date.now();
    
    try {
      const instanceId = metadata.instanceId || `${serviceName}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const instance = {
        instanceId,
        serviceName,
        host: metadata.host || process.env.SERVICE_HOST || 'localhost',
        port: metadata.port || process.env.SERVICE_PORT || 3000,
        version: metadata.version || process.env.SERVICE_VERSION || '1.0.0',
        tags: metadata.tags || [],
        metadata: metadata.metadata || {},
        healthCheckUrl: metadata.healthCheckUrl || '/health',
        weight: metadata.weight || 1,
        registeredAt: Date.now(),
        lastHeartbeat: Date.now()
      };
      
      const key = `service:discovery:${serviceName}:${instanceId}`;
      await this.redisClient.hset(
        `service:discovery:${serviceName}`,
        instanceId,
        JSON.stringify(instance)
      );
      
      // 设置 TTL
      await this.redisClient.expire(`service:discovery:${serviceName}`, this.cacheTTL * 2);
      
      this.metrics.serviceDiscoveryRequestsTotal.inc({
        service: serviceName,
        operation: 'register',
        status: 'success'
      });
      
      logger.info({ serviceName, instanceId, host: instance.host, port: instance.port }, 
        'Service instance registered');
      
      return instanceId;
      
    } catch (error) {
      this.metrics.serviceDiscoveryRequestsTotal.inc({
        service: serviceName,
        operation: 'register',
        status: 'error'
      });
      
      logger.error({ serviceName, error: error.message }, 'Failed to register service');
      throw error;
      
    } finally {
      this.metrics.serviceDiscoveryLatency.observe(
        { service: serviceName, operation: 'register' },
        (Date.now() - start) / 1000
      );
    }
  }
  
  /**
   * 发现服务实例
   */
  async discover(serviceName, options = {}) {
    const start = Date.now();
    const strategy = options.strategy || this.loadBalanceStrategy;
    
    try {
      // 检查缓存
      if (this.serviceCache.has(serviceName) && this.cacheExpiry.get(serviceName) > Date.now()) {
        this.metrics.serviceDiscoveryCacheHits.inc({ service: serviceName });
        
        const instances = this.serviceCache.get(serviceName);
        const selected = this.selectInstance(instances, strategy);
        
        this.metrics.serviceDiscoveryRequestsTotal.inc({
          service: serviceName,
          operation: 'discover',
          status: 'success'
        });
        
        return { instances, selected, strategy };
      }
      
      this.metrics.serviceDiscoveryCacheMisses.inc({ service: serviceName });
      
      // 从 Redis 获取
      const data = await this.redisClient.hgetall(`service:discovery:${serviceName}`);
      
      if (!data || Object.keys(data).length === 0) {
        logger.warn({ serviceName }, 'No instances found for service');
        return { instances: [], selected: null, strategy };
      }
      
      const instances = Object.values(data).map(d => {
        try {
          return JSON.parse(d);
        } catch {
          return null;
        }
      }).filter(i => i !== null);
      
      // 过滤不健康的实例
      const healthyInstances = instances.filter(i => {
        const failures = this.failureCounts.get(i.instanceId) || 0;
        return failures < this.failureThreshold;
      });
      
      // 更新缓存
      this.serviceCache.set(serviceName, healthyInstances);
      this.cacheExpiry.set(serviceName, Date.now() + this.cacheTTL);
      
      const selected = this.selectInstance(healthyInstances, strategy);
      
      this.metrics.serviceDiscoveryRequestsTotal.inc({
        service: serviceName,
        operation: 'discover',
        status: 'success'
      });
      
      logger.debug({ serviceName, instanceCount: healthyInstances.length }, 
        'Discovered service instances');
      
      return { instances: healthyInstances, selected, strategy };
      
    } catch (error) {
      this.metrics.serviceDiscoveryRequestsTotal.inc({
        service: serviceName,
        operation: 'discover',
        status: 'error'
      });
      
      logger.error({ serviceName, error: error.message }, 'Failed to discover service');
      
      // 降级返回缓存
      if (this.serviceCache.has(serviceName)) {
        const instances = this.serviceCache.get(serviceName);
        const selected = this.selectInstance(instances, strategy);
        return { instances, selected, strategy, degraded: true };
      }
      
      throw error;
      
    } finally {
      this.metrics.serviceDiscoveryLatency.observe(
        { service: serviceName, operation: 'discover' },
        (Date.now() - start) / 1000
      );
    }
  }
  
  /**
   * 选择实例（负载均衡）
   */
  selectInstance(instances, strategy) {
    if (!instances || instances.length === 0) {
      return null;
    }
    
    switch (strategy) {
      case LoadBalanceStrategy.ROUND_ROBIN:
        return this.selectRoundRobin(instances);
      
      case LoadBalanceStrategy.WEIGHTED:
        return this.selectWeighted(instances);
      
      case LoadBalanceStrategy.LEAST_CONNECTIONS:
        return this.selectLeastConnections(instances);
      
      case LoadBalanceStrategy.RANDOM:
        return instances[Math.floor(Math.random() * instances.length)];
      
      default:
        return instances[0];
    }
  }
  
  /**
   * 轮询选择
   */
  selectRoundRobin(instances) {
    if (instances.length === 1) {
      return instances[0];
    }
    
    const serviceName = instances[0].serviceName;
    const index = this.roundRobinIndex.get(serviceName) || 0;
    const selected = instances[index % instances.length];
    this.roundRobinIndex.set(serviceName, index + 1);
    
    return selected;
  }
  
  /**
   * 加权选择
   */
  selectWeighted(instances) {
    const totalWeight = instances.reduce((sum, i) => sum + (i.weight || 1), 0);
    let random = Math.random() * totalWeight;
    
    for (const instance of instances) {
      random -= instance.weight || 1;
      if (random <= 0) {
        return instance;
      }
    }
    
    return instances[0];
  }
  
  /**
   * 最少连接选择
   */
  selectLeastConnections(instances) {
    return instances.reduce((min, i) => {
      const minConns = min.connections || 0;
      const iConns = i.connections || 0;
      return iConns < minConns ? i : min;
    }, instances[0]);
  }
  
  /**
   * 发送心跳
   */
  async heartbeat(instanceId, serviceName) {
    try {
      const instance = await this.redisClient.hget(
        `service:discovery:${serviceName}`,
        instanceId
      );
      
      if (instance) {
        const data = JSON.parse(instance);
        data.lastHeartbeat = Date.now();
        
        await this.redisClient.hset(
          `service:discovery:${serviceName}`,
          instanceId,
          JSON.stringify(data)
        );
        
        logger.debug({ instanceId, serviceName }, 'Heartbeat sent');
      }
      
    } catch (error) {
      logger.error({ instanceId, serviceName, error: error.message }, 
        'Failed to send heartbeat');
    }
  }
  
  /**
   * 注销服务
   */
  async deregister(instanceId, serviceName) {
    try {
      await this.redisClient.hdel(
        `service:discovery:${serviceName}`,
        instanceId
      );
      
      // 清理缓存
      this.serviceCache.delete(serviceName);
      this.cacheExpiry.delete(serviceName);
      
      logger.info({ instanceId, serviceName }, 'Service instance deregistered');
      
    } catch (error) {
      logger.error({ instanceId, serviceName, error: error.message }, 
        'Failed to deregister service');
    }
  }
  
  /**
   * 标记实例失败
   */
  markFailure(instanceId) {
    const count = (this.failureCounts.get(instanceId) || 0) + 1;
    this.failureCounts.set(instanceId, count);
    
    this.recoveryCounts.delete(instanceId);
    
    logger.warn({ instanceId, failureCount: count }, 'Instance failure recorded');
    
    if (count >= this.failureThreshold) {
      logger.error({ instanceId, failureCount: count }, 
        'Instance marked as unhealthy');
    }
  }
  
  /**
   * 标记实例成功
   */
  markSuccess(instanceId) {
    const failures = this.failureCounts.get(instanceId) || 0;
    
    if (failures > 0) {
      const recoveries = (this.recoveryCounts.get(instanceId) || 0) + 1;
      this.recoveryCounts.set(instanceId, recoveries);
      
      if (recoveries >= this.recoveryThreshold) {
        this.failureCounts.delete(instanceId);
        this.recoveryCounts.delete(instanceId);
        logger.info({ instanceId }, 'Instance marked as healthy');
      }
    }
  }
  
  /**
   * 获取熔断器
   */
  getCircuitBreaker(instanceId, options = {}) {
    if (!this.circuitBreakers.has(instanceId)) {
      this.circuitBreakers.set(instanceId, new CircuitBreaker({
        failureThreshold: options.failureThreshold || 5,
        timeout: options.timeout || 60000,
        ...options
      }));
    }
    
    return this.circuitBreakers.get(instanceId);
  }
  
  /**
   * 清除缓存
   */
  clearCache(serviceName) {
    if (serviceName) {
      this.serviceCache.delete(serviceName);
      this.cacheExpiry.delete(serviceName);
    } else {
      this.serviceCache.clear();
      this.cacheExpiry.clear();
    }
    
    logger.debug({ serviceName }, 'Cache cleared');
  }
  
  /**
   * 关闭客户端
   */
  async close() {
    // 清理定时器
    for (const [name, timer] of this.monitors) {
      clearInterval(timer);
      logger.info({ monitor: name }, 'Monitor stopped');
    }
    
    this.monitors.clear();
    
    logger.info('Service discovery client closed');
  }
}

module.exports = {
  ServiceDiscoveryClient,
  LoadBalanceStrategy
};
