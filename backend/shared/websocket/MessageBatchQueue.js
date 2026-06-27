/**
 * 消息批处理队列
 * REQ-00329: WebSocket 连接池与消息批处理性能优化
 * 
 * 功能：
 * - 消息队列化管理，减少网络请求次数
 * - 批量发送优化，提升吞吐量
 * - 优先级队列，确保重要消息优先发送
 * - 背压控制，防止消息堆积导致内存溢出
 * - 自动刷新机制，保证消息及时送达
 */

'use strict';

const { createLogger } = require('../logger');
const websocketMetrics = require('./Metrics');

const logger = createLogger('message-batch-queue');

class MessageBatchQueue {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Object} connectionPool - 连接池实例（用于发送消息）
   */
  constructor(options = {}, connectionPool = null) {
    // 配置参数
    this.maxBatchSize = options.maxBatchSize || 50; // 单批次最大消息数
    this.maxBatchDelay = options.maxBatchDelay || 100; // 最大批处理延迟(ms)
    this.maxQueueSize = options.maxQueueSize || 10000; // 队列最大容量
    this.enableBackpressure = options.enableBackpressure !== false;
    this.flushOnHighPriority = options.flushOnHighPriority !== false;

    // 连接池引用
    this.connectionPool = connectionPool;

    // 消息队列
    this.queues = new Map(); // userId -> MessageQueue
    this.flushTimers = new Map(); // userId -> timer

    // 统计指标
    this.metrics = {
      totalEnqueued: 0,
      totalFlushed: 0,
      totalDropped: 0,
      backpressureEvents: 0,
      avgQueueSize: 0,
      avgFlushTime: 0
    };

    logger.info('Message batch queue initialized', {
      maxBatchSize: this.maxBatchSize,
      maxBatchDelay: this.maxBatchDelay,
      maxQueueSize: this.maxQueueSize,
      enableBackpressure: this.enableBackpressure
    });
  }

  /**
   * 设置连接池
   * @param {Object} pool - 连接池实例
   */
  setConnectionPool(pool) {
    this.connectionPool = pool;
  }

  /**
   * 添加消息到批处理队列
   * @param {string} userId - 用户ID
   * @param {Object} message - 消息内容
   * @param {Object} options - 选项（priority, immediate）
   * @returns {Object} 入队结果
   */
  enqueue(userId, message, options = {}) {
    // 立即发送的消息不入队
    if (options.immediate && this.connectionPool) {
      this.connectionPool.sendToUser(userId, [message], options);
      return { queued: false, immediate: true };
    }

    let queue = this.queues.get(userId);

    // 创建队列（如果不存在）
    if (!queue) {
      queue = this.createQueue(userId);
      this.queues.set(userId, queue);
    }

    // 背压控制
    if (this.enableBackpressure && queue.size >= this.maxQueueSize) {
      this.applyBackpressure(userId, queue);
      return { queued: false, reason: 'queue_full', queueSize: queue.size };
    }

    // 添加消息
    queue.messages.push({
      ...message,
      enqueuedAt: Date.now(),
      priority: options.priority || 'normal'
    });

    queue.size++;
    this.metrics.totalEnqueued++;

    // 更新队列统计
    this.updateQueueStats(userId, queue);

    // 触发批处理
    if (queue.size >= this.maxBatchSize) {
      this.flushQueue(userId);
    } else if (options.priority === 'high' && this.flushOnHighPriority) {
      // 高优先级消息立即刷新
      this.flushQueue(userId);
    } else if (!this.flushTimers.has(userId)) {
      // 调度定时刷新
      this.scheduleFlush(userId);
    }

    return { queued: true, queueSize: queue.size };
  }

  /**
   * 批量添加消息
   * @param {string} userId - 用户ID
   * @param {Array} messages - 消息数组
   * @param {Object} options - 选项
   * @returns {Object} 入队结果
   */
  enqueueBatch(userId, messages, options = {}) {
    if (!Array.isArray(messages)) {
      messages = [messages];
    }

    const results = messages.map(msg => this.enqueue(userId, msg, options));
    const queued = results.filter(r => r.queued).length;

    return {
      total: messages.length,
      queued,
      notQueued: messages.length - queued
    };
  }

  /**
   * 创建消息队列
   * @param {string} userId - 用户ID
   * @returns {Object} 队列对象
   */
  createQueue(userId) {
    return {
      userId,
      messages: [],
      size: 0,
      createdAt: Date.now(),
      lastFlushAt: Date.now(),
      stats: {
        totalMessages: 0,
        avgWaitTime: 0
      }
    };
  }

  /**
   * 调度队列刷新
   * @param {string} userId - 用户ID
   */
  scheduleFlush(userId) {
    // 避免重复调度
    if (this.flushTimers.has(userId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.flushQueue(userId);
    }, this.maxBatchDelay);

    this.flushTimers.set(userId, timer);
  }

  /**
   * 刷新队列（批量发送）
   * @param {string} userId - 用户ID
   */
  async flushQueue(userId) {
    // 清除定时器
    const timer = this.flushTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(userId);
    }

    const queue = this.queues.get(userId);
    if (!queue || queue.size === 0) return;

    const flushStart = Date.now();

    // 提取消息批次
    const batch = this.extractBatch(queue);

    // 计算消息等待时间
    const waitTimes = batch.messages.map(msg => flushStart - msg.enqueuedAt);
    const avgWaitTime = waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length;

    // 发送到连接池
    if (this.connectionPool) {
      await this.connectionPool.sendToUser(userId, batch.messages, {
        compress: batch.messages.length > 10
      });
    }

    // 更新队列状态
    queue.lastFlushAt = flushStart;
    queue.stats.totalMessages += batch.messages.length;
    queue.stats.avgWaitTime = 
      (queue.stats.avgWaitTime + avgWaitTime) / 2;

    // 更新指标
    this.metrics.totalFlushed += batch.messages.length;
    this.metrics.avgFlushTime = 
      (this.metrics.avgFlushTime + (Date.now() - flushStart)) / 2;

    // 记录指标
    websocketMetrics.queueDelay.observe(avgWaitTime / 1000);
    websocketMetrics.batchSize.observe(batch.messages.length);

    // 移除空队列
    if (queue.size === 0) {
      this.queues.delete(userId);
    }

    logger.debug('Queue flushed', {
      userId,
      messageCount: batch.messages.length,
      avgWaitTime: Math.round(avgWaitTime),
      flushTime: Date.now() - flushStart
    });
  }

  /**
   * 提取批次消息
   * @param {Object} queue - 队列对象
   * @returns {Object} 批次对象
   */
  extractBatch(queue) {
    // 按优先级排序（high > normal > low）
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    queue.messages.sort((a, b) => 
      (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1)
    );

    // 提取最多 maxBatchSize 条消息
    const messages = queue.messages.splice(0, this.maxBatchSize);
    queue.size = queue.messages.length;

    return { messages };
  }

  /**
   * 应用背压控制
   * @param {string} userId - 用户ID
   * @param {Object} queue - 队列对象
   */
  applyBackpressure(userId, queue) {
    // 记录背压事件
    this.metrics.backpressureEvents++;
    websocketMetrics.backpressureEvents.inc({ user_id: userId });

    // 降级策略：丢弃低优先级消息
    const droppedCount = this.dropLowPriorityMessages(queue);
    this.metrics.totalDropped += droppedCount;

    logger.warn('Backpressure applied', {
      userId,
      queueSize: queue.size,
      droppedCount,
      totalBackpressureEvents: this.metrics.backpressureEvents
    });

    // 发送背压通知
    if (this.connectionPool) {
      this.connectionPool.sendToUser(userId, [{
        type: 'backpressure_warning',
        message: '消息发送过于频繁，部分低优先级消息已被丢弃',
        droppedCount,
        timestamp: Date.now()
      }], { priority: 'high', immediate: true });
    }
  }

  /**
   * 丢弃低优先级消息
   * @param {Object} queue - 队列对象
   * @returns {number} 丢弃的消息数量
   */
  dropLowPriorityMessages(queue) {
    const initialSize = queue.size;
    
    // 只保留高优先级和普通优先级消息
    queue.messages = queue.messages.filter(msg => msg.priority !== 'low');
    queue.size = queue.messages.length;
    
    return initialSize - queue.size;
  }

  /**
   * 更新队列统计
   * @param {string} userId - 用户ID
   * @param {Object} queue - 队列对象
   */
  updateQueueStats(userId, queue) {
    // 更新平均队列大小
    let totalSize = 0;
    this.queues.forEach(q => {
      totalSize += q.size;
    });
    this.metrics.avgQueueSize = Math.round(totalSize / this.queues.size);

    // 更新 Prometheus 指标
    websocketMetrics.queueSizeGauge.set(queue.size);
  }

  /**
   * 获取队列状态
   * @param {string} userId - 用户ID（可选，不提供则返回所有队列状态）
   * @returns {Object} 队列状态
   */
  getQueueStatus(userId) {
    if (userId) {
      const queue = this.queues.get(userId);
      if (!queue) {
        return { exists: false };
      }

      return {
        exists: true,
        userId: queue.userId,
        size: queue.size,
        createdAt: queue.createdAt,
        lastFlushAt: queue.lastFlushAt,
        stats: queue.stats
      };
    }

    // 返回所有队列状态
    const statuses = [];
    this.queues.forEach((queue, uid) => {
      statuses.push({
        userId: uid,
        size: queue.size,
        lastFlushAt: queue.lastFlushAt
      });
    });

    return {
      totalQueues: this.queues.size,
      metrics: this.metrics,
      queues: statuses
    };
  }

  /**
   * 清空所有队列
   */
  async flushAll() {
    const userIds = Array.from(this.queues.keys());
    
    await Promise.allSettled(
      userIds.map(userId => this.flushQueue(userId))
    );

    logger.info('All queues flushed', {
      queueCount: userIds.length,
      totalFlushed: this.metrics.totalFlushed
    });
  }

  /**
   * 清理指定用户的队列
   * @param {string} userId - 用户ID
   */
  clearQueue(userId) {
    // 清除定时器
    const timer = this.flushTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(userId);
    }

    // 移除队列
    const queue = this.queues.get(userId);
    if (queue) {
      this.metrics.totalDropped += queue.size;
      this.queues.delete(userId);
    }

    logger.info('Queue cleared', {
      userId,
      droppedCount: queue ? queue.size : 0
    });
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计数据
   */
  getStats() {
    return {
      ...this.metrics,
      activeQueues: this.queues.size,
      pendingTimers: this.flushTimers.size
    };
  }
}

module.exports = { MessageBatchQueue };
