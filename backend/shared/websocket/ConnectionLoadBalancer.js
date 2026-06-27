/**
 * 连接负载均衡器
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 * 
 * 功能：
 * - 多 worker pool 负载均衡
 * - 动态负载监控
 * - 智能连接分配
 * - 自动故障转移
 */

'use strict';

const { createLogger } = require('../logger');
const websocketMetrics = require('./Metrics');

const logger = createLogger('connection-load-balancer');

class ConnectionLoadBalancer {
  constructor(options = {}) {
    // 配置参数
    this.maxWorkers = options.maxWorkers || 10;
    this.healthCheckInterval = options.healthCheckInterval || 30000; // 30秒
    this.enableAutoFailover = options.enableAutoFailover !== false;

    // Worker pool 管理
    this.workerPools = new Map(); // workerId -> WorkerPool
    this.loadMetrics = new Map(); // workerId -> LoadMetrics

    // 负载均衡策略
    this.strategy = options.strategy || 'least-connections'; // least-connections, round-robin, weighted

    // 轮询索引（用于 round-robin）
    this.roundRobinIndex = 0;

    // 健康检查定时器
    this.healthCheckTimer = null;

    logger.info('Connection load balancer initialized', {
      maxWorkers: this.maxWorkers,
      strategy: this.strategy,
      healthCheckInterval: this.healthCheckInterval
    });

    // 启动健康检查
    if (this.enableAutoFailover) {
      this.startHealthCheck();
    }
  }

  /**
   * 注册 worker pool
   * @param {Object} workerPool - Worker pool 实例
   */
  registerWorkerPool(workerPool) {
    if (this.workerPools.size >= this.maxWorkers) {
      logger.warn('Max worker pools reached, cannot register new worker');
      return false;
    }

    this.workerPools.set(workerPool.id, workerPool);

    // 初始化负载指标
    this.loadMetrics.set(workerPool.id, {
      connectionCount: 0,
      cpuUsage: 0,
      memoryUsage: 0,
      messageRate: 0,
      lastUpdate: Date.now(),
      status: 'healthy'
    });

    logger.info('Worker pool registered', {
      workerId: workerPool.id,
      totalWorkers: this.workerPools.size
    });

    return true;
  }

  /**
   * 注销 worker pool
   * @param {string} workerId - Worker ID
   */
  unregisterWorkerPool(workerId) {
    this.workerPools.delete(workerId);
    this.loadMetrics.delete(workerId);

    logger.info('Worker pool unregistered', {
      workerId,
      remainingWorkers: this.workerPools.size
    });
  }

  /**
   * 选择负载最低的 worker pool
   * @returns {Object} 选中的 worker pool
   */
  selectWorkerPool() {
    if (this.workerPools.size === 0) {
      logger.warn('No worker pools available');
      return null;
    }

    let selectedPool = null;

    switch (this.strategy) {
      case 'least-connections':
        selectedPool = this.selectByLeastConnections();
        break;

      case 'round-robin':
        selectedPool = this.selectByRoundRobin();
        break;

      case 'weighted':
        selectedPool = this.selectByWeight();
        break;

      default:
        selectedPool = this.selectByLeastConnections();
    }

    return selectedPool;
  }

  /**
   * 最少连接数策略
   * @returns {Object} Worker pool
   */
  selectByLeastConnections() {
    let selectedPool = null;
    let lowestLoad = Infinity;

    for (const [id, pool] of this.workerPools) {
      const metrics = this.loadMetrics.get(id);
      
      // 跳过不健康的 worker
      if (metrics.status !== 'healthy') {
        continue;
      }

      const load = this.calculateLoad(metrics);

      if (load < lowestLoad) {
        lowestLoad = load;
        selectedPool = pool;
      }
    }

    return selectedPool || this.getFirstHealthyWorker();
  }

  /**
   * 轮询策略
   * @returns {Object} Worker pool
   */
  selectByRoundRobin() {
    const healthyWorkers = this.getHealthyWorkers();
    
    if (healthyWorkers.length === 0) {
      return null;
    }

    const selected = healthyWorkers[this.roundRobinIndex % healthyWorkers.length];
    this.roundRobinIndex++;

    return selected;
  }

  /**
   * 加权策略（基于历史性能）
   * @returns {Object} Worker pool
   */
  selectByWeight() {
    const healthyWorkers = this.getHealthyWorkers();
    
    if (healthyWorkers.length === 0) {
      return null;
    }

    // 计算每个 worker 的权重
    const weights = healthyWorkers.map(pool => {
      const metrics = this.loadMetrics.get(pool.id);
      // 负载越低，权重越高
      return {
        pool,
        weight: 1 / (this.calculateLoad(metrics) + 0.1)
      };
    });

    // 加权随机选择
    const totalWeight = weights.reduce((sum, w) => sum + w.weight, 0);
    let random = Math.random() * totalWeight;

    for (const { pool, weight } of weights) {
      random -= weight;
      if (random <= 0) {
        return pool;
      }
    }

    return weights[0].pool;
  }

  /**
   * 计算负载分数
   * @param {Object} metrics - 负载指标
   * @returns {number} 负载分数（0-100）
   */
  calculateLoad(metrics) {
    const weights = {
      connectionCount: 0.4,
      cpuUsage: 0.3,
      memoryUsage: 0.2,
      messageRate: 0.1
    };

    // 归一化各项指标（假设最大值）
    const normalized = {
      connectionCount: Math.min(metrics.connectionCount / 1000, 1) * 100,
      cpuUsage: metrics.cpuUsage, // 已经是百分比
      memoryUsage: metrics.memoryUsage, // 已经是百分比
      messageRate: Math.min(metrics.messageRate / 10000, 1) * 100
    };

    return (
      normalized.connectionCount * weights.connectionCount +
      normalized.cpuUsage * weights.cpuUsage +
      normalized.memoryUsage * weights.memoryUsage +
      normalized.messageRate * weights.messageRate
    );
  }

  /**
   * 更新负载指标
   * @param {string} workerId - Worker ID
   * @param {Object} metrics - 新的负载指标
   */
  updateMetrics(workerId, metrics) {
    const currentMetrics = this.loadMetrics.get(workerId);
    
    if (!currentMetrics) {
      logger.warn('Unknown worker ID, cannot update metrics', { workerId });
      return;
    }

    this.loadMetrics.set(workerId, {
      ...currentMetrics,
      ...metrics,
      lastUpdate: Date.now()
    });

    // 更新 Prometheus 指标
    const load = this.calculateLoad(this.loadMetrics.get(workerId));
    websocketMetrics.poolLoad.set({ worker_id: workerId }, load);
  }

  /**
   * 获取所有健康的 worker
   * @returns {Array} 健康的 worker pool 列表
   */
  getHealthyWorkers() {
    const healthy = [];
    
    for (const [id, pool] of this.workerPools) {
      const metrics = this.loadMetrics.get(id);
      if (metrics.status === 'healthy') {
        healthy.push(pool);
      }
    }

    return healthy;
  }

  /**
   * 获取第一个健康的 worker
   * @returns {Object} Worker pool
   */
  getFirstHealthyWorker() {
    for (const [id, pool] of this.workerPools) {
      const metrics = this.loadMetrics.get(id);
      if (metrics.status === 'healthy') {
        return pool;
      }
    }

    // 如果没有健康的，返回第一个（降级）
    return this.workerPools.values().next().value;
  }

  /**
   * 启动健康检查
   */
  startHealthCheck() {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.healthCheckInterval);

    logger.info('Health check started', {
      interval: this.healthCheckInterval
    });
  }

  /**
   * 执行健康检查
   */
  async performHealthCheck() {
    const now = Date.now();

    for (const [workerId, metrics] of this.loadMetrics) {
      // 检查是否超时
      const timeSinceUpdate = now - metrics.lastUpdate;
      
      if (timeSinceUpdate > this.healthCheckInterval * 2) {
        // 超时，标记为不健康
        if (metrics.status === 'healthy') {
          this.markWorkerUnhealthy(workerId, 'timeout');
        }
      } else if (metrics.cpuUsage > 90 || metrics.memoryUsage > 90) {
        // 资源过载，标记为不健康
        if (metrics.status === 'healthy') {
          this.markWorkerUnhealthy(workerId, 'overload');
        }
      } else if (metrics.status !== 'healthy') {
        // 恢复健康
        this.markWorkerHealthy(workerId);
      }
    }

    logger.debug('Health check completed', {
      healthyWorkers: this.getHealthyWorkers().length,
      totalWorkers: this.workerPools.size
    });
  }

  /**
   * 标记 worker 为不健康
   * @param {string} workerId - Worker ID
   * @param {string} reason - 原因
   */
  markWorkerUnhealthy(workerId, reason) {
    const metrics = this.loadMetrics.get(workerId);
    if (metrics) {
      metrics.status = 'unhealthy';
      metrics.unhealthyReason = reason;
      metrics.unhealthyAt = Date.now();

      logger.warn('Worker marked as unhealthy', {
        workerId,
        reason,
        load: this.calculateLoad(metrics)
      });

      // 触发故障转移（如果启用）
      if (this.enableAutoFailover) {
        this.triggerFailover(workerId);
      }
    }
  }

  /**
   * 标记 worker 为健康
   * @param {string} workerId - Worker ID
   */
  markWorkerHealthy(workerId) {
    const metrics = this.loadMetrics.get(workerId);
    if (metrics) {
      metrics.status = 'healthy';
      delete metrics.unhealthyReason;
      delete metrics.unhealthyAt;

      logger.info('Worker recovered to healthy', {
        workerId,
        load: this.calculateLoad(metrics)
      });
    }
  }

  /**
   * 触发故障转移
   * @param {string} failedWorkerId - 失败的 worker ID
   */
  async triggerFailover(failedWorkerId) {
    const failedPool = this.workerPools.get(failedWorkerId);
    
    if (!failedPool) {
      return;
    }

    logger.info('Triggering failover', {
      failedWorkerId,
      healthyWorkers: this.getHealthyWorkers().length
    });

    // 获取健康的 worker
    const targetPool = this.selectWorkerPool();
    
    if (!targetPool) {
      logger.error('No healthy workers available for failover');
      return;
    }

    // 迁移连接（如果有连接池支持）
    if (failedPool.getConnections && targetPool.addConnection) {
      const connections = failedPool.getConnections();
      
      for (const conn of connections) {
        try {
          targetPool.addConnection(conn);
        } catch (error) {
          logger.error('Failed to migrate connection during failover', {
            error: error.message,
            userId: conn.userId
          });
        }
      }
    }

    logger.info('Failover completed', {
      failedWorkerId,
      targetWorkerId: targetPool.id,
      migratedConnections: failedPool.getConnections ? failedPool.getConnections().length : 0
    });
  }

  /**
   * 获取负载均衡器状态
   * @returns {Object} 状态信息
   */
  getStatus() {
    const workerStatuses = [];
    
    for (const [workerId, pool] of this.workerPools) {
      const metrics = this.loadMetrics.get(workerId);
      workerStatuses.push({
        workerId,
        status: metrics.status,
        load: this.calculateLoad(metrics),
        connectionCount: metrics.connectionCount,
        cpuUsage: metrics.cpuUsage,
        memoryUsage: metrics.memoryUsage,
        messageRate: metrics.messageRate,
        lastUpdate: metrics.lastUpdate
      });
    }

    return {
      strategy: this.strategy,
      totalWorkers: this.workerPools.size,
      healthyWorkers: this.getHealthyWorkers().length,
      workers: workerStatuses
    };
  }

  /**
   * 停止健康检查
   */
  stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    logger.info('Health check stopped');
  }

  /**
   * 关闭负载均衡器
   */
  shutdown() {
    this.stopHealthCheck();
    this.workerPools.clear();
    this.loadMetrics.clear();

    logger.info('Load balancer shutdown');
  }
}

module.exports = { ConnectionLoadBalancer };
