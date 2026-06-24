'use strict';
/**
 * 负载均衡器
 * REQ-00300: 动态服务注册发现与健康感知路由系统
 * 
 * 支持多种负载均衡策略
 */

const logger = require('./logger');

/**
 * 负载均衡策略
 */
const LoadBalanceStrategy = {
  ROUND_ROBIN: 'round-robin',
  WEIGHTED_ROUND_ROBIN: 'weighted-round-robin',
  LEAST_CONNECTIONS: 'least-connections',
  HEALTH_SCORE: 'health-score',
  ZONE_AFFINITY: 'zone-affinity',
  RANDOM: 'random'
};

/**
 * 负载均衡器基类
 */
class LoadBalancer {
  constructor(config = {}) {
    this.config = {
      strategy: config.strategy || LoadBalanceStrategy.WEIGHTED_ROUND_ROBIN,
      zoneAffinityEnabled: config.zoneAffinityEnabled !== false,
      defaultZone: config.defaultZone || 'default',
      ...config
    };
    
    // 轮询计数器
    this.roundRobinCounters = new Map();
  }

  /**
   * 选择实例
   */
  select(instances, options = {}) {
    if (!instances || instances.length === 0) {
      return null;
    }

    if (instances.length === 1) {
      return instances[0];
    }

    const strategy = options.strategy || this.config.strategy;

    switch (strategy) {
      case LoadBalanceStrategy.ROUND_ROBIN:
        return this.roundRobin(instances);
      
      case LoadBalanceStrategy.WEIGHTED_ROUND_ROBIN:
        return this.weightedRoundRobin(instances);
      
      case LoadBalanceStrategy.LEAST_CONNECTIONS:
        return this.leastConnections(instances);
      
      case LoadBalanceStrategy.HEALTH_SCORE:
        return this.highestHealthScore(instances);
      
      case LoadBalanceStrategy.ZONE_AFFINITY:
        return this.zoneAffinity(instances, options.zone || this.config.defaultZone);
      
      case LoadBalanceStrategy.RANDOM:
        return this.random(instances);
      
      default:
        return instances[0];
    }
  }

  /**
   * 轮询策略
   */
  roundRobin(instances) {
    const serviceName = instances[0].serviceName;
    const counter = this.roundRobinCounters.get(serviceName) || 0;
    const index = counter % instances.length;
    
    this.roundRobinCounters.set(serviceName, counter + 1);
    
    return instances[index];
  }

  /**
   * 加权轮询策略
   */
  weightedRoundRobin(instances) {
    // 计算总权重
    let totalWeight = 0;
    const weightedInstances = [];

    for (const instance of instances) {
      const weight = instance.metadata?.weight || 100;
      const healthFactor = instance.healthScore / 100;
      const adjustedWeight = Math.max(1, weight * healthFactor);
      
      totalWeight += adjustedWeight;
      weightedInstances.push({ instance, adjustedWeight });
    }

    if (totalWeight === 0) {
      return instances[0];
    }

    // 随机选择
    let random = Math.random() * totalWeight;
    
    for (const { instance, adjustedWeight } of weightedInstances) {
      random -= adjustedWeight;
      if (random <= 0) {
        return instance;
      }
    }

    return instances[0];
  }

  /**
   * 最少连接策略
   */
  leastConnections(instances) {
    let minConnections = Infinity;
    let selectedInstance = instances[0];

    for (const instance of instances) {
      const connections = instance.connections || 0;
      if (connections < minConnections) {
        minConnections = connections;
        selectedInstance = instance;
      }
    }

    return selectedInstance;
  }

  /**
   * 最高健康评分策略
   */
  highestHealthScore(instances) {
    let maxScore = -1;
    let selectedInstance = instances[0];

    for (const instance of instances) {
      const score = instance.healthScore || 0;
      if (score > maxScore) {
        maxScore = score;
        selectedInstance = instance;
      }
    }

    return selectedInstance;
  }

  /**
   * 区域亲和策略
   */
  zoneAffinity(instances, preferredZone) {
    // 先尝试选择同区域实例
    const sameZoneInstances = instances.filter(
      inst => inst.metadata?.zone === preferredZone
    );

    if (sameZoneInstances.length > 0) {
      // 在同区域实例中使用加权轮询
      return this.weightedRoundRobin(sameZoneInstances);
    }

    // 没有同区域实例，使用所有实例
    return this.weightedRoundRobin(instances);
  }

  /**
   * 随机策略
   */
  random(instances) {
    const index = Math.floor(Math.random() * instances.length);
    return instances[index];
  }

  /**
   * 更新轮询计数器
   */
  updateCounter(serviceName, value) {
    this.roundRobinCounters.set(serviceName, value);
  }

  /**
   * 重置计数器
   */
  resetCounters() {
    this.roundRobinCounters.clear();
  }
}

/**
 * 金丝雀路由器
 */
class CanaryRouter {
  constructor(config = {}) {
    this.config = {
      canaryWeightKey: 'canary:weight:',
      canaryVersionKey: 'canary:version:',
      redisClient: config.redisClient,
      ...config
    };
  }

  /**
   * 金丝雀路由
   */
  async route(req, serviceName, instances) {
    const version = req.headers['x-service-version'];
    
    if (!version) {
      // 无版本头，使用正常实例
      const stableInstances = instances.filter(
        inst => !inst.metadata?.tags?.includes('canary')
      );
      return stableInstances.length > 0 ? stableInstances[0] : instances[0];
    }

    // 获取金丝雀权重
    const canaryWeight = await this.getCanaryWeight(serviceName, version);
    
    if (Math.random() < canaryWeight) {
      // 路由到金丝雀实例
      return this.selectCanaryInstance(instances, version);
    } else {
      // 路由到稳定实例
      return this.selectStableInstance(instances);
    }
  }

  /**
   * 获取金丝雀权重
   */
  async getCanaryWeight(serviceName, version) {
    if (!this.config.redisClient) {
      return 0;
    }

    const key = `${this.config.canaryWeightKey}${serviceName}:${version}`;
    const weight = await this.config.redisClient.get(key);
    
    return weight ? parseFloat(weight) : 0;
  }

  /**
   * 设置金丝雀权重
   */
  async setCanaryWeight(serviceName, version, weight) {
    if (!this.config.redisClient) {
      return false;
    }

    const key = `${this.config.canaryWeightKey}${serviceName}:${version}`;
    await this.config.redisClient.set(key, weight);
    
    return true;
  }

  /**
   * 选择金丝雀实例
   */
  selectCanaryInstance(instances, version) {
    const canaryInstances = instances.filter(inst => 
      inst.version === version || inst.metadata?.tags?.includes('canary')
    );

    return canaryInstances.length > 0 ? canaryInstances[0] : instances[0];
  }

  /**
   * 选择稳定实例
   */
  selectStableInstance(instances) {
    const stableInstances = instances.filter(
      inst => !inst.metadata?.tags?.includes('canary')
    );

    return stableInstances.length > 0 ? stableInstances[0] : instances[0];
  }
}

/**
 * 服务选择器
 * 整合负载均衡和金丝雀路由
 */
class ServiceSelector {
  constructor(config = {}) {
    this.loadBalancer = new LoadBalancer(config);
    this.canaryRouter = new CanaryRouter(config);
    this.config = config;
  }

  /**
   * 选择服务实例
   */
  async selectInstance(instances, options = {}) {
    if (!instances || instances.length === 0) {
      return null;
    }

    // 如果启用金丝雀路由
    if (this.config.canaryEnabled && options.req) {
      const canaryInstance = await this.canaryRouter.route(
        options.req,
        instances[0].serviceName,
        instances
      );
      if (canaryInstance) {
        return canaryInstance;
      }
    }

    // 使用负载均衡器选择实例
    return this.loadBalancer.select(instances, options);
  }

  /**
   * 获取负载均衡器
   */
  getLoadBalancer() {
    return this.loadBalancer;
  }

  /**
   * 获取金丝雀路由器
   */
  getCanaryRouter() {
    return this.canaryRouter;
  }
}

// 单例实例
let loadBalancerInstance = null;
let serviceSelectorInstance = null;

/**
 * 获取负载均衡器实例
 */
function getLoadBalancer(config = {}) {
  if (!loadBalancerInstance) {
    loadBalancerInstance = new LoadBalancer(config);
  }
  return loadBalancerInstance;
}

/**
 * 获取服务选择器实例
 */
function getServiceSelector(config = {}) {
  if (!serviceSelectorInstance) {
    serviceSelectorInstance = new ServiceSelector(config);
  }
  return serviceSelectorInstance;
}

module.exports = {
  LoadBalancer,
  CanaryRouter,
  ServiceSelector,
  LoadBalanceStrategy,
  getLoadBalancer,
  getServiceSelector
};
