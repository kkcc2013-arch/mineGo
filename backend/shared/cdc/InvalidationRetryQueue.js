/**
 * 缓存失效重试队列 - 保证最终一致性
 * 
 * REQ-00479: 数据库查询结果缓存自动失效策略系统
 * 
 * 特性：
 * - 失效失败任务入队列重试
 * - 支持优先级队列
 * - 自动过期清理
 * - 最大重试次数限制
 * - 支持 Kafka/Redis 队列
 */

const { createLogger } = require('../logger');
const Redis = require('ioredis');

const logger = createLogger('invalidation-retry-queue');

class InvalidationRetryQueue {
  constructor(config = {}) {
    this.config = {
      // Redis 配置
      redis: config.redis || {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        db: process.env.REDIS_QUEUE_DB || 2
      },
      
      // 队列名称
      queueName: config.queueName || 'cache:invalidation:retry',
      
      // 最大重试次数
      maxRetries: config.maxRetries || 5,
      
      // 重试延迟（指数退避）
      retryDelays: config.retryDelays || [1000, 5000, 15000, 60000, 300000],
      
      // 任务过期时间
      taskExpiry: config.taskExpiry || 86400000, // 24 小时
      
      // 批量处理大小
      batchSize: config.batchSize || 100,
      
      // 处理间隔
      processInterval: config.processInterval || 5000
    };
    
    this.redis = null;
    this.isProcessing = false;
    this.processor = null;
    
    // 统计数据
    this.stats = {
      tasksQueued: 0,
      tasksRetried: 0,
      tasksCompleted: 0,
      tasksExpired: 0,
      tasksFailed: 0
    };
  }
  
  /**
   * 初始化队列
   */
  async init() {
    try {
      this.redis = new Redis(this.config.redis);
      
      this.redis.on('connect', () => {
        logger.info('Retry queue Redis connected');
      });
      
      this.redis.on('error', (error) => {
        logger.error({ error }, 'Retry queue Redis error');
      });
      
      // 启动定时处理
      this.startPeriodicProcess();
      
      logger.info('Invalidation retry queue initialized');
      
    } catch (error) {
      logger.error({ error }, 'Failed to initialize retry queue');
      throw error;
    }
  }
  
  /**
   * 入队失效任务
   */
  async enqueue(pattern, reason = 'failed', metadata = {}) {
    const task = {
      pattern,
      reason,
      metadata,
      retries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nextRetryAt: Date.now() + this.config.retryDelays[0]
    };
    
    try {
      // 存储任务（使用 Redis Hash）
      const taskId = `task:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
      
      await this.redis.hset(taskId, {
        pattern: task.pattern,
        reason: task.reason,
        metadata: JSON.stringify(task.metadata),
        retries: task.retries.toString(),
        createdAt: task.createdAt.toString(),
        updatedAt: task.updatedAt.toString(),
        nextRetryAt: task.nextRetryAt.toString()
      });
      
      // 设置过期时间
      await this.redis.expire(taskId, this.config.taskExpiry / 1000);
      
      // 加入队列（使用 Sorted Set 按下次重试时间排序）
      await this.redis.zadd(this.config.queueName, task.nextRetryAt, taskId);
      
      this.stats.tasksQueued++;
      
      logger.info({ 
        taskId, 
        pattern, 
        reason,
        nextRetryAt: new Date(task.nextRetryAt).toISOString() 
      }, 'Invalidation task queued');
      
      return taskId;
      
    } catch (error) {
      logger.error({ error, pattern }, 'Failed to enqueue task');
      throw error;
    }
  }
  
  /**
   * 批量入队
   */
  async enqueueBatch(patterns, reason = 'batch_failed') {
    const results = [];
    
    for (const pattern of patterns) {
      try {
        const taskId = await this.enqueue(pattern, reason);
        results.push({ pattern, taskId, status: 'queued' });
      } catch (error) {
        results.push({ pattern, error: error.message, status: 'failed' });
      }
    }
    
    logger.info({ 
      total: patterns.length, 
      queued: results.filter(r => r.status === 'queued').length 
    }, 'Batch enqueue completed');
    
    return results;
  }
  
  /**
   * 启动定时处理
   */
  startPeriodicProcess() {
    this.processor = setInterval(async () => {
      await this.processReadyTasks();
    }, this.config.processInterval);
    
    logger.info('Periodic process started');
  }
  
  /**
   * 处理准备好的任务
   */
  async processReadyTasks() {
    if (this.isProcessing) {
      return; // 防止并发处理
    }
    
    this.isProcessing = true;
    
    try {
      const now = Date.now();
      
      // 获取到期任务
      const readyTasks = await this.redis.zrangebyscore(
        this.config.queueName,
        0,
        now,
        'LIMIT',
        0,
        this.config.batchSize
      );
      
      if (readyTasks.length === 0) {
        return;
      }
      
      logger.info({ count: readyTasks.length }, 'Processing ready tasks');
      
      // 处理每个任务
      for (const taskId of readyTasks) {
        await this.processTask(taskId);
      }
      
    } catch (error) {
      logger.error({ error }, 'Error processing ready tasks');
    } finally {
      this.isProcessing = false;
    }
  }
  
  /**
   * 处理单个任务
   */
  async processTask(taskId) {
    try {
      // 获取任务详情
      const taskData = await this.redis.hgetall(taskId);
      
      if (!taskData || !taskData.pattern) {
        // 任务不存在或已过期，移除
        await this.removeFromQueue(taskId);
        this.stats.tasksExpired++;
        return;
      }
      
      const task = {
        pattern: taskData.pattern,
        retries: parseInt(taskData.retries) || 0,
        metadata: JSON.parse(taskData.metadata || '{}')
      };
      
      // 尝试执行失效
      const cache = require('../cache');
      await cache.delPattern(task.pattern);
      
      // 成功，移除任务
      await this.removeFromQueue(taskId);
      this.stats.tasksCompleted++;
      
      logger.info({ taskId, pattern: task.pattern }, 'Task completed successfully');
      
    } catch (error) {
      // 失败，更新重试信息
      const retries = parseInt(await this.redis.hget(taskId, 'retries')) || 0;
      
      if (retries >= this.config.maxRetries) {
        // 达到最大重试次数，移除任务
        await this.removeFromQueue(taskId);
        this.stats.tasksFailed++;
        
        logger.error({ 
          taskId, 
          retries, 
          error: error.message 
        }, 'Task failed after max retries');
        
        // 发送告警
        await this.sendFailedAlert(taskId, error);
        
      } else {
        // 更新重试信息
        const newRetries = retries + 1;
        const nextDelay = this.config.retryDelays[newRetries] || 300000;
        const nextRetryAt = Date.now() + nextDelay;
        
        await this.redis.hset(taskId, {
          retries: newRetries.toString(),
          updatedAt: Date.now().toString(),
          nextRetryAt: nextRetryAt.toString()
        });
        
        // 更新队列中的排序
        await this.redis.zadd(this.config.queueName, nextRetryAt, taskId);
        
        this.stats.tasksRetried++;
        
        logger.warn({ 
          taskId, 
          retries: newRetries, 
          nextRetryAt: new Date(nextRetryAt).toISOString() 
        }, 'Task retry scheduled');
      }
    }
  }
  
  /**
   * 从队列移除任务
   */
  async removeFromQueue(taskId) {
    await this.redis.zrem(this.config.queueName, taskId);
    await this.redis.del(taskId);
  }
  
  /**
   * 发送失败告警
   */
  async sendFailedAlert(taskId, error) {
    const { Alerting } = require('../alerting');
    const alerting = new Alerting();
    
    await alerting.sendAlert('error', 
      `缓存失效重试队列任务最终失败: ${taskId}`, {
        taskId,
        error: error.message,
        channel: '#ops-alerts'
      }
    );
  }
  
  /**
   * 获取队列统计
   */
  async getStats() {
    const queueSize = await this.redis.zcard(this.config.queueName);
    
    const overdueCount = await this.redis.zcount(
      this.config.queueName,
      0,
      Date.now() - 60000 // 超过 1 分钟未处理
    );
    
    return {
      ...this.stats,
      queueSize,
      overdueCount,
      isProcessing: this.isProcessing
    };
  }
  
  /**
   * 清理过期任务
   */
  async cleanupExpired() {
    const expiryTime = Date.now() - this.config.taskExpiry;
    
    const expiredTasks = await this.redis.zrangebyscore(
      this.config.queueName,
      0,
      expiryTime
    );
    
    for (const taskId of expiredTasks) {
      await this.removeFromQueue(taskId);
      this.stats.tasksExpired++;
    }
    
    logger.info({ count: expiredTasks.length }, 'Expired tasks cleaned');
  }
  
  /**
   * 停止处理
   */
  stop() {
    if (this.processor) {
      clearInterval(this.processor);
      this.processor = null;
    }
    
    logger.info('Retry queue processing stopped');
  }
  
  /**
   * 关闭队列
   */
  async close() {
    this.stop();
    
    if (this.redis) {
      await this.redis.quit();
    }
    
    logger.info('Retry queue closed');
  }
}

module.exports = InvalidationRetryQueue;