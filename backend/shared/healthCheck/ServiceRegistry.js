'use strict';

/**
 * REQ-00508: 服务注册中心客户端
 * 
 * 功能：
 * - 服务实例注册/注销
 * - 心跳上报
 * - 服务发现与健康状态订阅
 * - 内存缓存与 Redis 持久化
 */

const EventEmitter = require('events');

class ServiceRegistry extends EventEmitter {
  constructor(config = {}) {
    super();

    this.redisClient = config.redisClient;
    this.keyPrefix = config.keyPrefix || 'minego:services:';
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 10000;  // 10秒
    this.ttlSeconds = config.ttlSeconds || 30;  // 30秒过期
    
    this.localRegistry = new Map();  // 本地缓存
    this.heartbeatTimers = new Map();
    this.logger = config.logger || console;
  }

  /**
   * 注册服务实例
   * @param {Object} serviceInstance - 服务实例配置
   * @returns {string} 实例ID
   */
  async register(serviceInstance) {
    const {
      id,
      name,
      host,
      port,
      protocol = 'http',
      weight = 100,
      metadata = {}
    } = serviceInstance;

    const instanceId = id || `${name}-${host}:${port}`;
    const now = Date.now();

    const instance = {
      id: instanceId,
      name,
      host,
      port,
      protocol,
      weight,
      metadata,
      status: 'healthy',
      registeredAt: now,
      lastHeartbeat: now
    };

    // 本地存储
    this.localRegistry.set(instanceId, instance);

    // Redis 持久化（如果配置了）
    if (this.redisClient) {
      await this._saveToRedis(instance);
    }

    // 启动心跳
    this._startHeartbeat(instanceId);

    this.logger.info(`[ServiceRegistry] Registered: ${instanceId}`);
    this.emit('registered', instance);

    return instanceId;
  }

  /**
   * 注销服务实例
   * @param {string} instanceId - 实例ID
   */
  async deregister(instanceId) {
    const instance = this.localRegistry.get(instanceId);
    if (!instance) return;

    // 停止心跳
    this._stopHeartbeat(instanceId);

    // 从本地移除
    this.localRegistry.delete(instanceId);

    // 从 Redis 移除
    if (this.redisClient) {
      await this._removeFromRedis(instanceId);
    }

    this.logger.info(`[ServiceRegistry] Deregistered: ${instanceId}`);
    this.emit('deregistered', instance);
  }

  /**
   * 发现服务实例
   * @param {string} serviceName - 服务名称
   * @returns {Array} 实例列表
   */
  async discover(serviceName) {
    // 先从本地缓存查找
    const localInstances = [];
    for (const instance of this.localRegistry.values()) {
      if (instance.name === serviceName && instance.status === 'healthy') {
        localInstances.push(instance);
      }
    }

    // 如果本地有，直接返回
    if (localInstances.length > 0) {
      return localInstances;
    }

    // 从 Redis 加载（如果配置了）
    if (this.redisClient) {
      const instances = await this._loadFromRedis(serviceName);
      return instances;
    }

    return [];
  }

  /**
   * 获取单个实例（负载均衡）
   * @param {string} serviceName - 服务名称
   * @param {string} strategy - 负载均衡策略
   * @returns {Object} 实例
   */
  async getOne(serviceName, strategy = 'round-robin') {
    const instances = await this.discover(serviceName);
    
    if (instances.length === 0) {
      return null;
    }

    if (instances.length === 1) {
      return instances[0];
    }

    // 根据策略选择实例
    switch (strategy) {
      case 'round-robin':
        return this._roundRobinSelect(serviceName, instances);
      case 'random':
        return instances[Math.floor(Math.random() * instances.length)];
      case 'least-connections':
        return this._leastConnectionSelect(instances);
      case 'weighted':
        return this._weightedSelect(instances);
      default:
        return instances[0];
    }
  }

  /**
   * 更新实例状态
   * @param {string} instanceId - 实例ID
   * @param {string} status - 新状态
   */
  async updateStatus(instanceId, status) {
    const instance = this.localRegistry.get(instanceId);
    if (!instance) return;

    const previousStatus = instance.status;
    instance.status = status;
    instance.lastHeartbeat = Date.now();

    // 更新 Redis
    if (this.redisClient) {
      await this._saveToRedis(instance);
    }

    if (previousStatus !== status) {
      this.logger.info(`[ServiceRegistry] ${instanceId} status: ${previousStatus} -> ${status}`);
      this.emit('statusChange', { instance, previousStatus, currentStatus: status });
    }
  }

  /**
   * 更新实例权重
   * @param {string} instanceId - 实例ID
   * @param {number} weight - 新权重
   */
  async updateWeight(instanceId, weight) {
    const instance = this.localRegistry.get(instanceId);
    if (!instance) return;

    instance.weight = Math.max(0, Math.min(100, weight));
    instance.lastHeartbeat = Date.now();

    if (this.redisClient) {
      await this._saveToRedis(instance);
    }

    this.emit('weightChange', instance);
  }

  /**
   * 获取所有服务
   * @returns {Object} 服务列表
   */
  async getAllServices() {
    const services = {};
    
    for (const instance of this.localRegistry.values()) {
      if (!services[instance.name]) {
        services[instance.name] = [];
      }
      services[instance.name].push(instance);
    }

    return services;
  }

  /**
   * 启动心跳
   * @private
   */
  _startHeartbeat(instanceId) {
    const instance = this.localRegistry.get(instanceId);
    if (!instance) return;

    const timer = setInterval(async () => {
      instance.lastHeartbeat = Date.now();
      
      if (this.redisClient) {
        await this._saveToRedis(instance);
      }
    }, this.heartbeatIntervalMs);

    this.heartbeatTimers.set(instanceId, timer);
  }

  /**
   * 停止心跳
   * @private
   */
  _stopHeartbeat(instanceId) {
    const timer = this.heartbeatTimers.get(instanceId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(instanceId);
    }
  }

  /**
   * 保存到 Redis
   * @private
   */
  async _saveToRedis(instance) {
    const key = `${this.keyPrefix}${instance.id}`;
    const data = JSON.stringify(instance);
    
    await this.redisClient.setex(key, this.ttlSeconds, data);
    
    // 更新服务名索引
    const indexKey = `${this.keyPrefix}index:${instance.name}`;
    await this.redisClient.sadd(indexKey, instance.id);
  }

  /**
   * 从 Redis 移除
   * @private
   */
  async _removeFromRedis(instanceId) {
    const instance = this.localRegistry.get(instanceId);
    if (!instance) return;

    const key = `${this.keyPrefix}${instanceId}`;
    await this.redisClient.del(key);

    const indexKey = `${this.keyPrefix}index:${instance.name}`;
    await this.redisClient.srem(indexKey, instanceId);
  }

  /**
   * 从 Redis 加载
   * @private
   */
  async _loadFromRedis(serviceName) {
    const indexKey = `${this.keyPrefix}index:${serviceName}`;
    const instanceIds = await this.redisClient.smembers(indexKey);

    const instances = [];
    for (const id of instanceIds) {
      const key = `${this.keyPrefix}${id}`;
      const data = await this.redisClient.get(key);
      
      if (data) {
        instances.push(JSON.parse(data));
      }
    }

    return instances;
  }

  /**
   * 轮询选择
   * @private
   */
  _roundRobinSelect(serviceName, instances) {
    // 使用服务名作为计数器键
    const key = `rr:${serviceName}`;
    this._rrCounters = this._rrCounters || {};
    
    const counter = this._rrCounters[key] || 0;
    this._rrCounters[key] = (counter + 1) % instances.length;
    
    return instances[counter % instances.length];
  }

  /**
   * 最少连接选择
   * @private
   */
  _leastConnectionSelect(instances) {
    // 简化实现：按权重降序
    return instances.sort((a, b) => b.weight - a.weight)[0];
  }

  /**
   * 加权选择
   * @private
   */
  _weightedSelect(instances) {
    const totalWeight = instances.reduce((sum, i) => sum + i.weight, 0);
    let random = Math.random() * totalWeight;
    
    for (const instance of instances) {
      random -= instance.weight;
      if (random <= 0) {
        return instance;
      }
    }
    
    return instances[0];
  }

  /**
   * 关闭
   */
  async shutdown() {
    // 停止所有心跳
    for (const instanceId of this.heartbeatTimers.keys()) {
      this._stopHeartbeat(instanceId);
    }

    this.logger.info('[ServiceRegistry] Shutdown complete');
    this.emit('shutdown');
  }
}

module.exports = ServiceRegistry;
