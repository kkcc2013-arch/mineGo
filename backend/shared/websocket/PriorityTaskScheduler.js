'use strict';

const { logger, metrics } = require('../index');

/**
 * 优先级任务调度器 - CPU 资源优化
 * 
 * 实现基于优先级的任务调度，降低高负载延迟
 */
class PriorityTaskScheduler {
  constructor(options = {}) {
    this.config = {
      maxConcurrent: options.maxConcurrent || 10,
      queueLimit: options.queueLimit || 1000,
      priorityLevels: options.priorityLevels || {
        critical: 0,  // 心跳响应、认证
        high: 1,      // 战斗消息
        normal: 2,    // 常规消息
        low: 3        // 统计、日志
      },
      scheduleInterval: options.scheduleInterval || 10, // 10ms 调度周期
      timeSlice: options.timeSlice || 5 // 每个任务时间片（ms）
    };
    
    // 优先级队列
    this.queues = {
      critical: [],
      high: [],
      normal: [],
      low: []
    };
    
    // 执行状态
    this.running = false;
    this.currentTasks = 0;
    
    // 统计
    this.stats = {
      totalScheduled: 0,
      totalExecuted: 0,
      totalDropped: 0,
      avgWaitTime: 0,
      avgExecuteTime: 0
    };
    
    this._setupMetrics();
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    this.metrics = {
      queueLength: metrics.gauge('ws_scheduler_queue_length', 'Queue length', ['priority']),
      tasksExecuted: metrics.counter('ws_scheduler_tasks_total', 'Tasks executed', ['priority']),
      waitTime: metrics.histogram('ws_scheduler_wait_time_ms', 'Task wait time', [], [1, 5, 10, 50, 100]),
      executeTime: metrics.histogram('ws_scheduler_exec_time_ms', 'Task execute time', [], [0.1, 0.5, 1, 5, 10]),
      activeTasks: metrics.gauge('ws_scheduler_active_tasks', 'Currently active tasks')
    };
  }

  /**
   * 调度任务
   * @param {Function} task 任务函数
   * @param {string} priority 优先级
   */
  schedule(task, priority = 'normal') {
    if (!this.queues[priority]) {
      logger.warn('Invalid priority level', { priority });
      return false;
    }
    
    // 检查队列限制
    const totalQueued = Object.values(this.queues).reduce((sum, q) => sum + q.length, 0);
    if (totalQueued >= this.config.queueLimit) {
      this.stats.totalDropped++;
      logger.warn('Task queue full, task dropped');
      return false;
    }
    
    const taskEntry = {
      task,
      priority,
      scheduledAt: Date.now(),
      id: `${priority}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
    
    this.queues[priority].push(taskEntry);
    this.stats.totalScheduled++;
    
    this._updateQueueMetrics();
    
    // 启动调度器
    if (!this.running) {
      this._startScheduler();
    }
    
    return true;
  }

  /**
   * 启动调度器
   */
  _startScheduler() {
    this.running = true;
    this._scheduleLoop();
  }

  /**
   * 调度循环
   */
  async _scheduleLoop() {
    while (this.running) {
      // 检查并发限制
      if (this.currentTasks >= this.config.maxConcurrent) {
        await this._sleep(this.config.scheduleInterval);
        continue;
      }
      
      // 从最高优先级开始选择任务
      const taskEntry = this._selectNextTask();
      
      if (!taskEntry) {
        await this._sleep(this.config.scheduleInterval);
        continue;
      }
      
      // 异步执行任务
      this._executeTask(taskEntry);
      
      await this._sleep(this.config.scheduleInterval);
    }
  }

  /**
   * 选择下一个任务
   */
  _selectNextTask() {
    // 按优先级顺序检查队列
    for (const priority of ['critical', 'high', 'normal', 'low']) {
      const queue = this.queues[priority];
      if (queue.length > 0) {
        return queue.shift();
      }
    }
    return null;
  }

  /**
   * 执行任务
   */
  async _executeTask(taskEntry) {
    const { task, priority, scheduledAt } = taskEntry;
    
    this.currentTasks++;
    this.metrics.activeTasks.set(this.currentTasks);
    
    const startTime = Date.now();
    const waitTime = startTime - scheduledAt;
    
    try {
      // 执行任务（带超时）
      await this._executeWithTimeout(task, this.config.timeSlice);
      
      const executeTime = Date.now() - startTime;
      
      // 更新统计
      this.stats.totalExecuted++;
      this.stats.avgWaitTime = (this.stats.avgWaitTime * 0.9 + waitTime * 0.1);
      this.stats.avgExecuteTime = (this.stats.avgExecuteTime * 0.9 + executeTime * 0.1);
      
      // 更新指标
      this.metrics.tasksExecuted.inc({ priority });
      this.metrics.waitTime.observe(waitTime);
      this.metrics.executeTime.observe(executeTime);
      
    } catch (error) {
      logger.warn('Task execution failed', { error: error.message, priority });
    } finally {
      this.currentTasks--;
      this.metrics.activeTasks.set(this.currentTasks);
      this._updateQueueMetrics();
    }
  }

  /**
   * 带超时执行
   */
  async _executeWithTimeout(task, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Task timeout'));
      }, timeout);
      
      Promise.resolve()
        .then(() => task())
        .then(result => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  /**
   * 更新队列指标
   */
  _updateQueueMetrics() {
    for (const [priority, queue] of Object.entries(this.queues)) {
      this.metrics.queueLength.set(queue.length, { priority });
    }
  }

  /**
   * 休眠
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取状态
   */
  getStatus() {
    return {
      running: this.running,
      currentTasks: this.currentTasks,
      queues: Object.fromEntries(
        Object.entries(this.queues).map(([p, q]) => [p, q.length])
      ),
      stats: this.stats
    };
  }

  /**
   * 关闭调度器
   */
  async close() {
    this.running = false;
    
    // 等待所有任务完成
    while (this.currentTasks > 0) {
      await this._sleep(10);
    }
    
    logger.info('Priority task scheduler closed');
  }
}

module.exports = PriorityTaskScheduler;
