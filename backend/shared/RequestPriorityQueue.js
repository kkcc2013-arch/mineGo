// backend/shared/RequestPriorityQueue.js
// REQ-00367: 请求优先级队列系统

'use strict';

const { getRedis } = require('./redis');
const { createLogger } = require('./logger');
const { query } = require('./db');
const metrics = require('./metrics');

const logger = createLogger('request-priority-queue');

/**
 * 请求优先级队列
 * 支持多级优先级的请求排队和处理
 */
class RequestPriorityQueue {
  constructor(options = {}) {
    this.redis = getRedis();
    this.maxQueueSize = options.maxQueueSize || 10000;
    this.queuePrefix = 'priority_queue:';

    // 优先级定义
    this.priorities = ['highest', 'high', 'normal', 'low'];
    this.priorityWeights = {
      highest: 4,
      high: 3,
      normal: 2,
      low: 1
    };

    // 关键业务端点
    this.criticalEndpoints = [
      '/api/auth/login',
      '/api/payment/process',
      '/api/gym/battle/start',
      '/api/catch/start'
    ];

    // 批量操作标识
    this.batchEndpoints = [
      '/api/pokemon/batch',
      '/api/admin/bulk',
      '/api/sync/all'
    ];

    this.registerMetrics();
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    // 队列大小
    if (!metrics.register.getSingleMetric('priority_queue_size')) {
      metrics.register.registerMetric(
        new metrics.promClient.Gauge({
          name: 'priority_queue_size',
          help: 'Current priority queue size',
          labelNames: ['priority']
        })
      );
    }

    // 队列等待时间
    if (!metrics.register.getSingleMetric('queue_wait_time_ms')) {
      metrics.register.registerMetric(
        new metrics.promClient.Histogram({
          name: 'queue_wait_time_ms',
          help: 'Queue wait time in milliseconds',
          labelNames: ['priority'],
          buckets: [100, 500, 1000, 5000, 10000, 30000, 60000]
        })
      );
    }

    // 队列处理计数
    if (!metrics.register.getSingleMetric('queue_operations_total')) {
      metrics.register.registerMetric(
        new metrics.promClient.Counter({
          name: 'queue_operations_total',
          help: 'Total queue operations',
          labelNames: ['priority', 'operation']
        })
      );
    }
  }

  /**
   * 将请求加入优先级队列
   */
  async enqueue(request) {
    const priority = this.determinePriority(request);
    const queueKey = `${this.queuePrefix}${priority}`;

    // 检查队列大小
    const queueSize = await this.redis.llen(queueKey);
    if (queueSize >= this.maxQueueSize) {
      logger.warn({
        priority,
        queueSize,
        maxQueueSize: this.maxQueueSize
      }, 'Queue is full, request rejected');

      // 记录拒绝
      await this.recordStats(priority, 'rejected', 0);

      throw new Error('Queue is full, request rejected');
    }

    const queueItem = {
      ...request,
      enqueuedAt: Date.now(),
      priority
    };

    // 加入队列
    await this.redis.rpush(queueKey, JSON.stringify(queueItem));

    // 更新队列指标
    const sizeGauge = metrics.register.getSingleMetric('priority_queue_size');
    if (sizeGauge) {
      sizeGauge.set({ priority }, queueSize + 1);
    }

    // 记录入队
    const opCounter = metrics.register.getSingleMetric('queue_operations_total');
    if (opCounter) {
      opCounter.inc({ priority, operation: 'enqueue' });
    }

    await this.recordStats(priority, 'enqueued', 0);

    logger.debug({
      requestId: request.requestId,
      priority,
      queuePosition: queueSize + 1
    }, 'Request enqueued');

    return {
      queued: true,
      priority,
      queuePosition: queueSize + 1,
      estimatedWaitTime: this.estimateWaitTime(priority, queueSize + 1)
    };
  }

  /**
   * 从队列中取出请求（按优先级）
   */
  async dequeue() {
    // 按优先级顺序检查队列
    for (const priority of this.priorities) {
      const queueKey = `${this.queuePrefix}${priority}`;
      const item = await this.redis.lpop(queueKey);

      if (item) {
        const request = JSON.parse(item);
        const waitTime = Date.now() - request.enqueuedAt;

        // 更新队列指标
        const sizeGauge = metrics.register.getSingleMetric('priority_queue_size');
        const queueSize = await this.redis.llen(queueKey);
        if (sizeGauge) {
          sizeGauge.set({ priority }, queueSize);
        }

        // 记录等待时间
        const waitHist = metrics.register.getSingleMetric('queue_wait_time_ms');
        if (waitHist) {
          waitHist.observe({ priority }, waitTime);
        }

        // 记录出队
        const opCounter = metrics.register.getSingleMetric('queue_operations_total');
        if (opCounter) {
          opCounter.inc({ priority, operation: 'dequeue' });
        }

        await this.recordStats(priority, 'dequeued', waitTime);

        return {
          ...request,
          waitTime,
          processedAt: Date.now()
        };
      }
    }

    return null; // 所有队列都为空
  }

  /**
   * 确定请求优先级
   */
  determinePriority(request) {
    // VIP 用户最高优先级
    if (request.userTier === 'vip' || request.userTier === 'svip') {
      return 'highest';
    }

    // Premium 用户高优先级
    if (request.userTier === 'premium') {
      return 'high';
    }

    // 关键业务端点提升优先级
    if (this.criticalEndpoints.some(ep => request.endpoint?.startsWith(ep))) {
      return 'high';
    }

    // 批量操作降低优先级
    if (this.batchEndpoints.some(ep => request.endpoint?.startsWith(ep)) || request.isBatch) {
      return 'low';
    }

    // 支付相关请求提升优先级
    if (request.endpoint?.includes('/payment/')) {
      return 'highest';
    }

    // 认证相关请求提升优先级
    if (request.endpoint?.includes('/auth/')) {
      return 'high';
    }

    // 默认普通优先级
    return 'normal';
  }

  /**
   * 获取队列状态
   */
  async getQueueStatus() {
    const status = {};

    for (const priority of this.priorities) {
      const queueKey = `${this.queuePrefix}${priority}`;
      const size = await this.redis.llen(queueKey);

      status[priority] = {
        size,
        maxCapacity: this.maxQueueSize,
        utilization: (size / this.maxQueueSize) * 100,
        weight: this.priorityWeights[priority]
      };
    }

    // 总队列状态
    const totalSize = Object.values(status).reduce((sum, s) => sum + s.size, 0);
    status.total = {
      size: totalSize,
      maxCapacity: this.maxQueueSize * this.priorities.length,
      utilization: (totalSize / (this.maxQueueSize * this.priorities.length)) * 100
    };

    return status;
  }

  /**
   * 估算等待时间
   */
  estimateWaitTime(priority, position) {
    // 基于优先级和位置的估算
    const baseWaitTime = 100; // 每个请求基础处理时间 100ms
    const priorityFactor = 5 - this.priorityWeights[priority]; // 优先级越低，等待越长

    return position * baseWaitTime * priorityFactor;
  }

  /**
   * 清空队列
   */
  async clearQueue(priority = null) {
    if (priority) {
      const queueKey = `${this.queuePrefix}${priority}`;
      await this.redis.del(queueKey);
      logger.info({ priority }, 'Queue cleared');
    } else {
      // 清空所有队列
      for (const p of this.priorities) {
        const queueKey = `${this.queuePrefix}${p}`;
        await this.redis.del(queueKey);
      }
      logger.info('All queues cleared');
    }
  }

  /**
   * 记录队列统计
   */
  async recordStats(priority, operation, waitTime) {
    try {
      const now = new Date();
      const snapshotTime = now.toISOString();

      // 更新 Redis 统计
      const statsKey = `${this.queuePrefix}stats:${priority}`;
      const stats = {
        queueName: priority,
        snapshotTime,
        operation
      };

      if (operation === 'enqueued') {
        await this.redis.hincrby(statsKey, 'queueSize', 1);
      } else if (operation === 'dequeued') {
        await this.redis.hincrby(statsKey, 'queueSize', -1);
        await this.redis.hincrby(statsKey, 'dequeuedCount', 1);
        await this.redis.hset(statsKey, 'avgWaitTimeMs', waitTime);
      } else if (operation === 'rejected') {
        await this.redis.hincrby(statsKey, 'rejectionCount', 1);
      }

      // 设置过期时间
      await this.redis.expire(statsKey, 3600);
    } catch (err) {
      logger.warn({ err, priority, operation }, 'Failed to record queue stats');
    }
  }

  /**
   * 获取队列统计
   */
  async getQueueStats() {
    const stats = {};

    for (const priority of this.priorities) {
      const statsKey = `${this.queuePrefix}stats:${priority}`;
      const data = await this.redis.hgetall(statsKey);

      stats[priority] = {
        queueSize: parseInt(data.queueSize || 0),
        dequeuedCount: parseInt(data.dequeuedCount || 0),
        avgWaitTimeMs: parseInt(data.avgWaitTimeMs || 0),
        rejectionCount: parseInt(data.rejectionCount || 0)
      };
    }

    return stats;
  }

  /**
   * 获取队列头部请求（不移除）
   */
  async peek(priority = null) {
    if (priority) {
      const queueKey = `${this.queuePrefix}${priority}`;
      const item = await this.redis.lindex(queueKey, 0);
      return item ? JSON.parse(item) : null;
    }

    // 返回所有队列的头部
    const result = {};
    for (const p of this.priorities) {
      const queueKey = `${this.queuePrefix}${p}`;
      const item = await this.redis.lindex(queueKey, 0);
      if (item) {
        result[p] = JSON.parse(item);
      }
    }
    return result;
  }
}

// 单例
const requestPriorityQueue = new RequestPriorityQueue();

module.exports = {
  RequestPriorityQueue,
  requestPriorityQueue
};