'use strict';

/**
 * REQ-00508: 动态负载均衡器
 * 
 * 功能：
 * - 多种负载均衡策略（轮询、随机、加权、最少连接）
 * - 与服务注册中心集成
 * - 健康状态感知
 * - 动态权重调整
 * - 连接追踪
 */

const EventEmitter = require('events');

class LoadBalancer extends EventEmitter {
  constructor(config) {
    super();

    this.serviceRegistry = config.serviceRegistry;
    this.healthChecker = config.healthChecker;
    this.defaultStrategy = config.defaultStrategy || 'round-robin';
    this.logger = config.logger || console;

    // 连接追踪
    this._connections = new Map();  // instanceId -> connection count
    this._rrCounters = new Map();   // serviceName -> counter

    // 监听健康状态变化
    if (this.healthChecker) {
      this.healthChecker.on('statusChange', this._onStatusChange.bind(this));
    }
  }

  /**
   * 选择一个实例
   * @param {string} serviceName - 服务名称
   * @param {string} strategy - 负载均衡策略（可选）
   * @returns {Object} 选中的实例
   */
  async select(serviceName, strategy = this.defaultStrategy) {
    // 获取健康实例列表
    const healthyInstances = await this._getHealthyInstances(serviceName);
    
    if (healthyInstances.length === 0) {
      this.logger.warn(`[LoadBalancer] No healthy instances for ${serviceName}`);
      return null;
    }

    // 根据策略选择实例
    let selected;
    switch (strategy) {
      case 'round-robin':
        selected = this._roundRobinSelect(serviceName, healthyInstances);
        break;
      case 'random':
        selected = this._randomSelect(healthyInstances);
        break;
      case 'least-connections':
        selected = this._leastConnectionSelect(healthyInstances);
        break;
      case 'weighted':
        selected = this._weightedSelect(healthyInstances);
        break;
      default:
        selected = healthyInstances[0];
    }

    // 增加连接计数
    this._incrementConnection(selected.id);

    this.emit('selected', { serviceName, instance: selected, strategy });

    return selected;
  }

  /**
   * 释放连接
   * @param {string} instanceId - 实例ID
   */
  release(instanceId) {
    const count = this._connections.get(instanceId) || 0;
    if (count > 0) {
      this._connections.set(instanceId, count - 1);
    }
  }

  /**
   * 获取服务负载统计
   * @param {string} serviceName - 服务名称
   * @returns {Object} 负载统计
   */
  async getLoadStats(serviceName) {
    const instances = await this._getHealthyInstances(serviceName);
    
    const stats = {
      serviceName,
      totalInstances: instances.length,
      totalConnections: 0,
      instances: []
    };

    for (const instance of instances) {
      const connections = this._connections.get(instance.id) || 0;
      stats.totalConnections += connections;
      stats.instances.push({
        id: instance.id,
        host: instance.host,
        port: instance.port,
        weight: instance.weight,
        connections,
        status: instance.status
      });
    }

    return stats;
  }

  /**
   * 动态调整权重
   * @param {string} instanceId - 实例ID
   * @param {number} delta - 权重变化量
   */
  async adjustWeight(instanceId, delta) {
    if (!this.serviceRegistry) return;

    const instance = this.serviceRegistry.localRegistry.get(instanceId);
    if (!instance) return;

    const newWeight = Math.max(0, Math.min(100, instance.weight + delta));
    
    await this.serviceRegistry.updateWeight(instanceId, newWeight);
    
    this.logger.info(
      `[LoadBalancer] Weight adjusted for ${instanceId}: ${instance.weight} -> ${newWeight}`
    );
    
    this.emit('weightAdjusted', { instanceId, oldWeight: instance.weight, newWeight });
  }

  /**
   * 自动权重调整（基于响应时间）
   * @param {string} instanceId - 实例ID
   * @param {number} responseTime - 响应时间（ms）
   */
  async autoAdjustWeight(instanceId, responseTime) {
    // 响应时间 > 500ms 降低权重
    // 响应时间 < 100ms 增加权重
    if (responseTime > 500) {
      await this.adjustWeight(instanceId, -10);
    } else if (responseTime < 100) {
      await this.adjustWeight(instanceId, 5);
    }
  }

  /**
   * 获取健康实例
   * @private
   */
  async _getHealthyInstances(serviceName) {
    if (this.healthChecker) {
      return this.healthChecker.getHealthyInstances(serviceName);
    }
    
    if (this.serviceRegistry) {
      return await this.serviceRegistry.discover(serviceName);
    }
    
    return [];
  }

  /**
   * 健康状态变化处理
   * @private
   */
  _onStatusChange({ instance, previousStatus, currentStatus }) {
    if (currentStatus === 'unhealthy') {
      // 清除该实例的连接计数
      this._connections.delete(instance.id);
      
      this.logger.warn(
        `[LoadBalancer] Instance ${instance.id} marked unhealthy, removing from rotation`
      );
      
      this.emit('instanceDown', instance);
    } else if (previousStatus === 'unhealthy' && currentStatus === 'healthy') {
      this.logger.info(
        `[LoadBalancer] Instance ${instance.id} recovered, adding to rotation`
      );
      
      this.emit('instanceUp', instance);
    }
  }

  /**
   * 轮询选择
   * @private
   */
  _roundRobinSelect(serviceName, instances) {
    const counter = this._rrCounters.get(serviceName) || 0;
    const index = counter % instances.length;
    this._rrCounters.set(serviceName, counter + 1);
    return instances[index];
  }

  /**
   * 随机选择
   * @private
   */
  _randomSelect(instances) {
    return instances[Math.floor(Math.random() * instances.length)];
  }

  /**
   * 最少连接选择
   * @private
   */
  _leastConnectionSelect(instances) {
    let minConn = Infinity;
    let selected = instances[0];

    for (const instance of instances) {
      const conn = this._connections.get(instance.id) || 0;
      if (conn < minConn) {
        minConn = conn;
        selected = instance;
      }
    }

    return selected;
  }

  /**
   * 加权选择
   * @private
   */
  _weightedSelect(instances) {
    const totalWeight = instances.reduce((sum, i) => sum + (i.weight || 100), 0);
    let random = Math.random() * totalWeight;

    for (const instance of instances) {
      random -= (instance.weight || 100);
      if (random <= 0) {
        return instance;
      }
    }

    return instances[0];
  }

  /**
   * 增加连接计数
   * @private
   */
  _incrementConnection(instanceId) {
    const count = this._connections.get(instanceId) || 0;
    this._connections.set(instanceId, count + 1);
  }
}

module.exports = LoadBalancer;
