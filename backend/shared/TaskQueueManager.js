/**
 * Task Queue Manager - 任务队列管理器
 * REQ-00519: 后端任务队列可靠性增强与死信处理系统
 * 
 * 功能：
 * - 指数退避重试策略
 * - 死信队列（DLQ）机制
 * - 任务优先级管理
 * - 任务状态监控
 * 
 * @module backend/shared/TaskQueueManager
 * @version 1.0.0
 */

'use strict';

const logger = require('./logger');
const { ExponentialBackoffRetry } = require('./retry/ExponentialBackoffRetry');

/**
 * TaskQueueManager - 任务队列管理器
 */
class TaskQueueManager {
  constructor(options = {}) {
    this.options = {
      redis: options.redis || null,
      kafka: options.kafka || null,
      maxRetries: options.maxRetries || 5,
      baseRetryDelay: options.baseRetryDelay || 1000,
      maxRetryDelay: options.maxRetryDelay || 60000,
      dlqThreshold: options.dlqThreshold || 100,
      alertThreshold: options.alertThreshold || 50,
      ...options
    };
    
    this.retryStrategy = new ExponentialBackoffRetry({
      baseDelay: this.options.baseRetryDelay,
      maxDelay: this.options.maxRetryDelay,
      maxRetries: this.options.maxRetries
    });
    
    this.dlq = {
      redis: this.options.redis ? `${this.options.redis.namespace || 'minego'}:dlq` : null,
      kafka: this.options.kafka ? `${this.options.kafka.topic || 'dlq-topic'}` : null
    };
    
    this.metrics = {
      tasksProcessed: 0,
      tasksFailed: 0,
      tasksRetried: 0,
      tasksToDLQ: 0,
      currentDLQSize: 0
    };
  }

  /**
   * 执行任务，带有重试和 DLQ 支持
   * @param {Function} taskFn - 任务函数
   * @param {Object} taskData - 任务数据
   * @param {Object} options - 执行选项
   * @returns {Promise<Object>} - 执行结果
   */
  async executeTask(taskFn, taskData, options = {}) {
    const taskId = taskData.id || this.generateTaskId();
    const taskType = taskData.type || 'default';
    const maxRetries = options.maxRetries || this.options.maxRetries;
    
    const task = {
      id: taskId,
      type: taskType,
      data: taskData,
      status: 'pending',
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    // 保存任务到队列
    await this.saveTask(task);
    
    // 执行任务
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      task.retryCount = attempt;
      task.status = attempt === 0 ? 'processing' : 'retrying';
      task.updatedAt = Date.now();
      
      await this.updateTask(task);
      
      try {
        const result = await taskFn(taskData);
        
        task.status = 'completed';
        task.result = result;
        task.updatedAt = Date.now();
        
        await this.updateTask(task);
        this.metrics.tasksProcessed++;
        
        logger.info('Task completed', {
          taskId,
          taskType,
          attempt,
          duration: task.updatedAt - task.createdAt
        });
        
        return { success: true, result, taskId };
        
      } catch (error) {
        lastError = error;
        
        logger.warn('Task failed', {
          taskId,
          taskType,
          attempt,
          error: error.message,
          retryCount: task.retryCount
        });
        
        // 检查是否达到最大重试次数
        if (attempt >= maxRetries) {
          // 移入死信队列
          await this.moveToDLQ(task, error);
          this.metrics.tasksFailed++;
          this.metrics.tasksToDLQ++;
          
          return {
            success: false,
            error: error.message,
            taskId,
            movedToDLQ: true
          };
        }
        
        // 计算退避延迟
        const delay = this.retryStrategy.calculateDelay(attempt);
        
        logger.info('Retrying task', {
          taskId,
          taskType,
          nextAttempt: attempt + 1,
          delayMs: delay
        });
        
        // 等待退避时间
        await this.sleep(delay);
        this.metrics.tasksRetried++;
      }
    }
    
    // 所有重试都失败，移入 DLQ
    await this.moveToDLQ(task, lastError);
    
    return {
      success: false,
      error: lastError.message,
      taskId,
      movedToDLQ: true
    };
  }

  /**
   * 移动任务到死信队列
   * @param {Object} task - 任务对象
   * @param {Error} error - 错误对象
   */
  async moveToDLQ(task, error) {
    const dlqTask = {
      ...task,
      status: 'dead_letter',
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code || 'UNKNOWN'
      },
      movedToDLQAt: Date.now()
    };
    
    // 保存到 Redis DLQ
    if (this.options.redis) {
      try {
        const redisClient = this.options.redis.client || require('./redis');
        const dlqKey = this.dlq.redis;
        
        await redisClient.lpush(dlqKey, JSON.stringify(dlqTask));
        const dlqSize = await redisClient.llen(dlqKey);
        
        this.metrics.currentDLQSize = dlqSize;
        
        logger.warn('Task moved to Redis DLQ', {
          taskId: task.id,
          dlqKey,
          dlqSize,
          error: error.message
        });
        
        // 检查告警阈值
        if (dlqSize >= this.options.alertThreshold) {
          await this.triggerDLQAlert(dlqSize);
        }
        
      } catch (redisError) {
        logger.error('Failed to save to Redis DLQ', {
          taskId: task.id,
          error: redisError.message
        });
      }
    }
    
    // 发送到 Kafka DLQ
    if (this.options.kafka && this.options.kafka.producer) {
      try {
        await this.options.kafka.producer.send({
          topic: this.dlq.kafka,
          messages: [{
            key: task.id,
            value: JSON.stringify(dlqTask),
            headers: {
              'task-type': task.type,
              'error-code': error.code || 'UNKNOWN',
              'retry-count': String(task.retryCount)
            }
          }]
        });
        
        logger.warn('Task sent to Kafka DLQ', {
          taskId: task.id,
          topic: this.dlq.kafka,
          error: error.message
        });
        
      } catch (kafkaError) {
        logger.error('Failed to send to Kafka DLQ', {
          taskId: task.id,
          error: kafkaError.message
        });
      }
    }
    
    // 保存到数据库（持久化）
    await this.saveDLQTaskToDatabase(dlqTask);
  }

  /**
   * 从 DLQ 重新处理任务
   * @param {string} taskId - 任务 ID
   * @param {Function} taskFn - 任务函数
   * @returns {Promise<Object>} - 重处理结果
   */
  async retryFromDLQ(taskId, taskFn) {
    logger.info('Retrying task from DLQ', { taskId });
    
    // 从 DLQ 获取任务
    let dlqTask = null;
    
    if (this.options.redis) {
      const redisClient = this.options.redis.client || require('./redis');
      const dlqKey = this.dlq.redis;
      
      // 搜索任务
      const dlqItems = await redisClient.lrange(dlqKey, 0, -1);
      for (const item of dlqItems) {
        const parsed = JSON.parse(item);
        if (parsed.id === taskId) {
          dlqTask = parsed;
          break;
        }
      }
      
      // 如果找到，从 DLQ 移除
      if (dlqTask) {
        await redisClient.lrem(dlqKey, 1, JSON.stringify(dlqTask));
        this.metrics.currentDLQSize--;
      }
    }
    
    if (!dlqTask) {
      // 从数据库获取
      dlqTask = await this.getDLQTaskFromDatabase(taskId);
    }
    
    if (!dlqTask) {
      return {
        success: false,
        error: 'Task not found in DLQ',
        taskId
      };
    }
    
    // 重置任务状态
    const retryTask = {
      ...dlqTask,
      status: 'retry_from_dlq',
      retryCount: 0,
      retriedFromDLQAt: Date.now()
    };
    
    delete retryTask.error;
    delete retryTask.movedToDLQAt;
    
    // 重新执行
    return await this.executeTask(taskFn, retryTask.data, {
      maxRetries: this.options.maxRetries
    });
  }

  /**
   * 获取 DLQ 统计信息
   * @returns {Promise<Object>} - DLQ 统计
   */
  async getDLQStats() {
    const stats = {
      redis: null,
      kafka: null,
      database: null,
      total: 0,
      byType: {},
      byError: {},
      oldestTask: null,
      newestTask: null
    };
    
    // Redis DLQ 统计
    if (this.options.redis) {
      const redisClient = this.options.redis.client || require('./redis');
      const dlqKey = this.dlq.redis;
      
      const dlqSize = await redisClient.llen(dlqKey);
      stats.redis = {
        size: dlqSize,
        key: dlqKey
      };
      stats.total += dlqSize;
      
      // 获取最早的和最新的任务
      if (dlqSize > 0) {
        const oldest = JSON.parse(await redisClient.lindex(dlqKey, -1));
        const newest = JSON.parse(await redisClient.lindex(dlqKey, 0));
        
        stats.oldestTask = {
          id: oldest.id,
          type: oldest.type,
          movedToDLQAt: oldest.movedToDLQAt
        };
        
        stats.newestTask = {
          id: newest.id,
          type: newest.type,
          movedToDLQAt: newest.movedToDLQAt
        };
      }
    }
    
    // 数据库 DLQ 统计
    stats.database = await this.getDLQStatsFromDatabase();
    stats.total += stats.database?.total || 0;
    
    // 按类型统计
    const allTasks = await this.getAllDLQTasks();
    for (const task of allTasks) {
      if (!stats.byType[task.type]) {
        stats.byType[task.type] = 0;
      }
      stats.byType[task.type]++;
      
      if (task.error) {
        const errorType = task.error.code || 'UNKNOWN';
        if (!stats.byError[errorType]) {
          stats.byError[errorType] = 0;
        }
        stats.byError[errorType]++;
      }
    }
    
    return stats;
  }

  /**
   * 获取 DLQ 任务列表
   * @param {Object} options - 查询选项
   * @returns {Promise<Array>} - 任务列表
   */
  async getDLQTasks(options = {}) {
    const {
      limit = 50,
      offset = 0,
      type = null,
      sortBy = 'movedToDLQAt',
      sortOrder = 'desc'
    } = options;
    
    let tasks = [];
    
    // 从 Redis 获取
    if (this.options.redis) {
      const redisClient = this.options.redis.client || require('./redis');
      const dlqKey = this.dlq.redis;
      
      const dlqItems = await redisClient.lrange(dlqKey, offset, offset + limit - 1);
      tasks = dlqItems.map(item => JSON.parse(item));
    }
    
    // 如果 Redis 数据不足，从数据库获取
    if (tasks.length < limit) {
      const dbTasks = await this.getDLQTasksFromDatabase({
        limit: limit - tasks.length,
        offset,
        type
      });
      tasks.push(...dbTasks);
    }
    
    // 过滤类型
    if (type) {
      tasks = tasks.filter(t => t.type === type);
    }
    
    // 排序
    tasks.sort((a, b) => {
      const aVal = a[sortBy] || 0;
      const bVal = b[sortBy] || 0;
      return sortOrder === 'desc' ? bVal - aVal : aVal - bVal;
    });
    
    return tasks;
  }

  /**
   * 清空 DLQ
   * @param {Object} options - 清空选项
   * @returns {Promise<Object>} - 清空结果
   */
  async clearDLQ(options = {}) {
    const { type = null, olderThan = null } = options;
    
    let clearedCount = 0;
    
    // 清空 Redis DLQ
    if (this.options.redis) {
      const redisClient = this.options.redis.client || require('./redis');
      const dlqKey = this.dlq.redis;
      
      if (!type && !olderThan) {
        // 全部清空
        clearedCount = await redisClient.llen(dlqKey);
        await redisClient.del(dlqKey);
        this.metrics.currentDLQSize = 0;
      } else {
        // 条件清空
        const dlqItems = await redisClient.lrange(dlqKey, 0, -1);
        for (const item of dlqItems) {
          const task = JSON.parse(item);
          const shouldRemove = 
            (type && task.type === type) ||
            (olderThan && task.movedToDLQAt < olderThan);
          
          if (shouldRemove) {
            await redisClient.lrem(dlqKey, 1, item);
            clearedCount++;
            this.metrics.currentDLQSize--;
          }
        }
      }
    }
    
    // 清空数据库 DLQ
    const dbClearedCount = await this.clearDLQFromDatabase(options);
    clearedCount += dbClearedCount;
    
    logger.info('DLQ cleared', {
      clearedCount,
      type,
      olderThan
    });
    
    return { clearedCount };
  }

  /**
   * 触发 DLQ 告警
   * @param {number} dlqSize - DLQ 大小
   */
  async triggerDLQAlert(dlqSize) {
    const alert = {
      type: 'dlq_threshold_exceeded',
      severity: 'warning',
      message: `DLQ size (${dlqSize}) exceeded alert threshold (${this.options.alertThreshold})`,
      threshold: this.options.alertThreshold,
      currentSize: dlqSize,
      timestamp: Date.now()
    };
    
    logger.warn('DLQ alert triggered', alert);
    
    // 发送 Prometheus 指标
    if (this.options.prometheus) {
      this.options.prometheus.gauge('dlq_size', dlqSize);
      this.options.prometheus.counter('dlq_alerts_triggered', 1);
    }
    
    // 发送告警通知
    if (this.options.alertManager) {
      await this.options.alertManager.sendAlert(alert);
    }
  }

  // ===== 辅助方法 =====

  /**
   * 生成任务 ID
   * @returns {string} - 任务 ID
   */
  generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 保存任务到队列
   * @param {Object} task - 任务对象
   */
  async saveTask(task) {
    // 保存到 Redis（可选）
    if (this.options.redis) {
      const redisClient = this.options.redis.client || require('./redis');
      const taskKey = `${this.options.redis.namespace || 'minego'}:tasks:${task.id}`;
      await redisClient.setex(taskKey, 86400, JSON.stringify(task));
    }
  }

  /**
   * 更新任务状态
   * @param {Object} task - 任务对象
   */
  async updateTask(task) {
    await this.saveTask(task);
  }

  /**
   * 保存 DLQ 任务到数据库
   * @param {Object} dlqTask - DLQ 任务对象
   */
  async saveDLQTaskToDatabase(dlqTask) {
    try {
      const db = require('./db');
      
      await db.query(`
        INSERT INTO dead_letter_queue (
          task_id, task_type, task_data, status, retry_count,
          error_message, error_stack, error_code, moved_to_dlq_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        dlqTask.id,
        dlqTask.type,
        JSON.stringify(dlqTask.data),
        dlqTask.status,
        dlqTask.retryCount,
        dlqTask.error?.message,
        dlqTask.error?.stack,
        dlqTask.error?.code,
        new Date(dlqTask.movedToDLQAt)
      ]);
      
    } catch (error) {
      logger.error('Failed to save DLQ task to database', {
        taskId: dlqTask.id,
        error: error.message
      });
    }
  }

  /**
   * 从数据库获取 DLQ 任务
   * @param {string} taskId - 任务 ID
   * @returns {Promise<Object|null>} - 任务对象
   */
  async getDLQTaskFromDatabase(taskId) {
    try {
      const db = require('./db');
      
      const result = await db.query(`
        SELECT * FROM dead_letter_queue WHERE task_id = $1
      `, [taskId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          id: row.task_id,
          type: row.task_type,
          data: JSON.parse(row.task_data),
          status: row.status,
          retryCount: row.retry_count,
          error: {
            message: row.error_message,
            stack: row.error_stack,
            code: row.error_code
          },
          movedToDLQAt: row.moved_to_dlq_at.getTime()
        };
      }
      
      return null;
      
    } catch (error) {
      logger.error('Failed to get DLQ task from database', {
        taskId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * 从数据库获取 DLQ 任务列表
   * @param {Object} options - 查询选项
   * @returns {Promise<Array>} - 任务列表
   */
  async getDLQTasksFromDatabase(options = {}) {
    try {
      const db = require('./db');
      
      const { limit = 50, offset = 0, type = null } = options;
      
      let query = `
        SELECT * FROM dead_letter_queue
        WHERE 1=1
      `;
      const params = [];
      
      if (type) {
        query += ` AND task_type = $${params.length + 1}`;
        params.push(type);
      }
      
      query += `
        ORDER BY moved_to_dlq_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `;
      params.push(limit, offset);
      
      const result = await db.query(query, params);
      
      return result.rows.map(row => ({
        id: row.task_id,
        type: row.task_type,
        data: JSON.parse(row.task_data),
        status: row.status,
        retryCount: row.retry_count,
        error: {
          message: row.error_message,
          stack: row.error_stack,
          code: row.error_code
        },
        movedToDLQAt: row.moved_to_dlq_at.getTime()
      }));
      
    } catch (error) {
      logger.error('Failed to get DLQ tasks from database', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * 从数据库获取 DLQ 统计
   * @returns {Promise<Object>} - 统计信息
   */
  async getDLQStatsFromDatabase() {
    try {
      const db = require('./db');
      
      const result = await db.query(`
        SELECT 
          COUNT(*) as total,
          COUNT(DISTINCT task_type) as unique_types,
          MIN(moved_to_dlq_at) as oldest,
          MAX(moved_to_dlq_at) as newest
        FROM dead_letter_queue
      `);
      
      const row = result.rows[0];
      
      return {
        total: parseInt(row.total),
        uniqueTypes: parseInt(row.unique_types),
        oldest: row.oldest?.getTime() || null,
        newest: row.newest?.getTime() || null
      };
      
    } catch (error) {
      logger.error('Failed to get DLQ stats from database', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * 获取所有 DLQ 任务（用于统计）
   * @returns {Promise<Array>} - 所有任务
   */
  async getAllDLQTasks() {
    // 从 Redis 获取
    let tasks = [];
    
    if (this.options.redis) {
      const redisClient = this.options.redis.client || require('./redis');
      const dlqKey = this.dlq.redis;
      
      const dlqItems = await redisClient.lrange(dlqKey, 0, -1);
      tasks = dlqItems.map(item => JSON.parse(item));
    }
    
    // 从数据库获取
    const dbTasks = await this.getDLQTasksFromDatabase({ limit: 1000 });
    tasks.push(...dbTasks);
    
    return tasks;
  }

  /**
   * 清空数据库 DLQ
   * @param {Object} options - 清空选项
   * @returns {Promise<number>} - 清空数量
   */
  async clearDLQFromDatabase(options = {}) {
    try {
      const db = require('./db');
      
      const { type = null, olderThan = null } = options;
      
      let query = 'DELETE FROM dead_letter_queue WHERE 1=1';
      const params = [];
      
      if (type) {
        query += ` AND task_type = $${params.length + 1}`;
        params.push(type);
      }
      
      if (olderThan) {
        query += ` AND moved_to_dlq_at < $${params.length + 1}`;
        params.push(new Date(olderThan));
      }
      
      const result = await db.query(query, params);
      
      return result.rowCount;
      
    } catch (error) {
      logger.error('Failed to clear DLQ from database', {
        error: error.message
      });
      return 0;
    }
  }

  /**
   * 休眠指定时间
   * @param {number} ms - 毫秒数
   * @returns {Promise<void>}
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取任务执行指标
   * @returns {Object} - 指标数据
   */
  getMetrics() {
    return {
      ...this.metrics,
      successRate: this.metrics.tasksProcessed / 
        (this.metrics.tasksProcessed + this.metrics.tasksFailed + 0.001),
      retryRate: this.metrics.tasksRetried / 
        (this.metrics.tasksProcessed + this.metrics.tasksFailed + 0.001),
      dlqRate: this.metrics.tasksToDLQ / 
        (this.metrics.tasksProcessed + this.metrics.tasksFailed + 0.001)
    };
  }
}

module.exports = { TaskQueueManager };