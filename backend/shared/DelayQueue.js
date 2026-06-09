'use strict';

const { Kafka } = require('kafkajs');
const { createLogger } = require('./logger');
const { incrementCounter, observeHistogram, gauge } = require('./metrics');

const logger = createLogger('delay-queue');

/**
 * DelayQueue - Delayed task queue with reliable retry mechanism
 * 
 * Features:
 * - Delayed task execution (seconds to days)
 * - Exponential backoff retry
 * - Priority queues
 * - Dead letter queue auto-handling
 * - Prometheus metrics
 */
class DelayQueue {
  constructor(config = {}) {
    this.clientId = config.clientId || 'minego-delay-queue';
    this.brokers = config.brokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'];
    
    this.kafka = new Kafka({
      clientId: this.clientId,
      brokers: this.brokers,
    });
    
    this.producer = null;
    this.consumers = new Map();
    this.taskHandlers = new Map();
    this.isConnected = false;
    
    // Delay queue configuration
    this.delayTopicPrefix = config.delayTopicPrefix || 'delay-queue';
    this.dlqTopic = config.dlqTopic || 'delay-queue-dlq';
    this.maxRetries = config.maxRetries || 5;
    
    // Priority levels (0 = highest)
    this.priorityLevels = {
      critical: 0,   // Payment callbacks, account recovery
      high: 1,       // Raid rewards, notifications
      normal: 2,     // Data sync, statistics
      low: 3,        // Analytics, cleanup
    };
    
    // Metrics tracking
    this.metrics = {
      tasksScheduled: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      tasksRetried: 0,
      tasksDeadLetter: 0,
    };
    
    // Recurring tasks
    this.recurringTasks = new Map();
  }

  /**
   * Initialize delay queue
   */
  async connect() {
    if (this.isConnected) return;
    
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: true,
      idempotent: true,
    });
    
    await this.producer.connect();
    this.isConnected = true;
    
    logger.info({ clientId: this.clientId }, 'DelayQueue connected');
  }

  /**
   * Schedule a delayed task
   * @param {string} taskType - Task type identifier
   * @param {object} payload - Task payload
   * @param {object} options - Scheduling options
   * @param {number} options.delay - Delay in milliseconds
   * @param {number} options.delayUntil - Execute at specific timestamp (alternative to delay)
   * @param {string} options.priority - Task priority (critical/high/normal/low)
   * @param {number} options.maxRetries - Override default max retries
   * @param {object} options.metadata - Additional metadata
   */
  async schedule(taskType, payload, options = {}) {
    if (!this.isConnected) await this.connect();
    
    const priority = options.priority || 'normal';
    const priorityLevel = this.priorityLevels[priority] ?? 2;
    
    // Calculate execution time
    let executeAt;
    if (options.delayUntil) {
      executeAt = new Date(options.delayUntil);
    } else if (options.delay) {
      executeAt = new Date(Date.now() + options.delay);
    } else {
      executeAt = new Date(); // Immediate execution
    }
    
    const taskId = `${taskType}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const task = {
      id: taskId,
      type: taskType,
      payload,
      priority: priorityLevel,
      executeAt: executeAt.toISOString(),
      retries: 0,
      maxRetries: options.maxRetries || this.maxRetries,
      createdAt: new Date().toISOString(),
      metadata: options.metadata || {},
    };
    
    // Determine delay bucket (for efficient delay scheduling)
    const delayMs = executeAt.getTime() - Date.now();
    const delayBucket = this._getDelayBucket(delayMs);
    
    const topic = `${this.delayTopicPrefix}-${delayBucket}`;
    
    try {
      await this.producer.send({
        topic,
        messages: [{
          key: taskId,
          value: JSON.stringify(task),
          headers: {
            'task-type': taskType,
            'priority': priorityLevel.toString(),
            'execute-at': executeAt.toISOString(),
          },
        }],
      });
      
      this.metrics.tasksScheduled++;
      incrementCounter('delay_queue_tasks_scheduled_total', 1, { 
        task_type: taskType, 
        priority,
        delay_bucket: delayBucket,
      });
      
      logger.info({ taskId, taskType, executeAt, priority }, 'Task scheduled');
      
      return { taskId, executeAt };
    } catch (err) {
      logger.error({ err, taskType }, 'Failed to schedule task');
      throw err;
    }
  }

  /**
   * Schedule a recurring task using cron expression
   * @param {string} taskType - Task type
   * @param {object} payload - Task payload
   * @param {string} cronExpression - Cron expression (e.g., '0 3 * * *' = daily at 3 AM)
   * @param {object} options - Additional options
   */
  async scheduleRecurring(taskType, payload, cronExpression, options = {}) {
    // Simple cron parser (supports basic patterns)
    const parseCron = (expr) => {
      const parts = expr.split(' ');
      if (parts.length !== 5) throw new Error(`Invalid cron expression: ${expr}`);
      
      const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
      return { minute, hour, dayOfMonth, month, dayOfWeek };
    };
    
    // Validate cron expression
    parseCron(cronExpression);
    
    const taskId = `recurring-${taskType}-${Date.now()}`;
    
    // Store recurring task config
    const recurringConfig = {
      id: taskId,
      taskType,
      payload,
      cronExpression,
      options,
      lastRun: null,
      nextRun: this._calculateNextRun(cronExpression),
      active: true,
    };
    
    this.recurringTasks.set(taskId, recurringConfig);
    
    // Start recurring task scheduler
    this._startRecurringScheduler(recurringConfig);
    
    logger.info({ taskId, taskType, cronExpression }, 'Recurring task scheduled');
    
    return { taskId, nextRun: recurringConfig.nextRun };
  }

  /**
   * Calculate next run time from cron expression
   */
  _calculateNextRun(cronExpression) {
    const parts = cronExpression.split(' ');
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    
    const now = new Date();
    let next = new Date(now);
    
    // Simple implementation: support basic patterns
    if (minute === '*' && hour === '*') {
      // Every minute
      next.setMinutes(next.getMinutes() + 1);
    } else if (minute !== '*' && hour === '*') {
      // Every hour at specific minute
      next.setMinutes(parseInt(minute));
      if (next <= now) next.setHours(next.getHours() + 1);
    } else if (minute !== '*' && hour !== '*') {
      // Daily at specific time
      next.setHours(parseInt(hour), parseInt(minute), 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);
    } else {
      // Default: next hour
      next.setHours(next.getHours() + 1, 0, 0, 0);
    }
    
    return next;
  }

  /**
   * Start recurring task scheduler
   */
  _startRecurringScheduler(config) {
    const checkAndSchedule = async () => {
      if (!config.active) return;
      
      const now = new Date();
      if (now >= config.nextRun) {
        // Schedule the task
        await this.schedule(config.taskType, config.payload, {
          priority: config.options.priority || 'low',
          maxRetries: config.options.maxRetries,
          metadata: { recurring: true, recurringId: config.id },
        });
        
        config.lastRun = now;
        config.nextRun = this._calculateNextRun(config.cronExpression);
        
        logger.debug({ 
          taskId: config.id, 
          taskType: config.taskType,
          nextRun: config.nextRun,
        }, 'Recurring task executed');
      }
    };
    
    // Check every minute
    const interval = setInterval(checkAndSchedule, 60000);
    config._interval = interval;
  }

  /**
   * Register a task handler
   * @param {string} taskType - Task type to handle
   * @param {Function} handler - Async handler function
   * @param {object} options - Handler options
   */
  async registerHandler(taskType, handler, options = {}) {
    if (!this.isConnected) await this.connect();
    
    const topic = options.topic || `${this.delayTopicPrefix}-ready`;
    
    if (!this.consumers.has(topic)) {
      const consumer = this.kafka.consumer({
        groupId: `${this.clientId}-${taskType}`,
        fromBeginning: false,
      });
      
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: false });
      
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          await this._processMessage(message, handler);
        },
      });
      
      this.consumers.set(topic, consumer);
    }
    
    this.taskHandlers.set(taskType, handler);
    
    logger.info({ taskType, topic }, 'Task handler registered');
  }

  /**
   * Process a task message
   */
  async _processMessage(message, handler) {
    const task = JSON.parse(message.value.toString());
    const startTime = Date.now();
    
    try {
      incrementCounter('delay_queue_tasks_started_total', 1, { 
        task_type: task.type,
      });
      
      // Execute task
      await handler(task.payload, task);
      
      // Success
      const duration = Date.now() - startTime;
      observeHistogram('delay_queue_task_duration_seconds', duration / 1000, {
        task_type: task.type,
        status: 'success',
      });
      
      this.metrics.tasksCompleted++;
      incrementCounter('delay_queue_tasks_completed_total', 1, { 
        task_type: task.type,
      });
      
      logger.info({ taskId: task.id, taskType: task.type, duration }, 'Task completed');
      
    } catch (err) {
      await this._handleTaskFailure(task, err, message);
    }
  }

  /**
   * Handle task failure with retry logic
   */
  async _handleTaskFailure(task, error, originalMessage) {
    logger.error({ 
      taskId: task.id, 
      taskType: task.type, 
      error: error.message,
      retries: task.retries,
    }, 'Task failed');
    
    this.metrics.tasksFailed++;
    task.retries++;
    
    // Check if we should retry
    if (task.retries < task.maxRetries) {
      // Calculate exponential backoff delay
      const backoffDelay = this._calculateBackoffDelay(task.retries);
      const newExecuteAt = new Date(Date.now() + backoffDelay);
      
      task.executeAt = newExecuteAt.toISOString();
      task.lastError = error.message;
      task.lastErrorAt = new Date().toISOString();
      
      // Re-schedule with backoff
      const delayBucket = this._getDelayBucket(backoffDelay);
      const topic = `${this.delayTopicPrefix}-${delayBucket}`;
      
      await this.producer.send({
        topic,
        messages: [{
          key: task.id,
          value: JSON.stringify(task),
        }],
      });
      
      this.metrics.tasksRetried++;
      incrementCounter('delay_queue_tasks_retried_total', 1, { 
        task_type: task.type,
        retry_attempt: task.retries.toString(),
      });
      
      logger.info({ 
        taskId: task.id, 
        taskType: task.type, 
        retryAttempt: task.retries,
        nextExecuteAt: newExecuteAt,
        backoffDelay,
      }, 'Task scheduled for retry');
      
    } else {
      // Max retries reached, send to DLQ
      await this._sendToDLQ(task, error);
    }
  }

  /**
   * Send task to dead letter queue
   */
  async _sendToDLQ(task, error) {
    const dlqMessage = {
      ...task,
      failedAt: new Date().toISOString(),
      error: {
        message: error.message,
        stack: error.stack,
      },
      finalStatus: 'dead_letter',
    };
    
    await this.producer.send({
      topic: this.dlqTopic,
      messages: [{
        key: task.id,
        value: JSON.stringify(dlqMessage),
      }],
    });
    
    this.metrics.tasksDeadLetter++;
    incrementCounter('delay_queue_tasks_dead_letter_total', 1, { 
      task_type: task.type,
    });
    
    logger.error({ 
      taskId: task.id, 
      taskType: task.type,
      retries: task.retries,
    }, 'Task sent to DLQ after max retries');
    
    // Emit alert event
    this._emitDLQAlert(task, error);
  }

  /**
   * Calculate exponential backoff delay
   * Base: 1s, then 2s, 4s, 8s, 16s, 32s, ...
   * With jitter to prevent thundering herd
   */
  _calculateBackoffDelay(retryCount) {
    const baseDelay = 1000; // 1 second
    const maxDelay = 300000; // 5 minutes
    
    // Exponential backoff
    let delay = Math.min(baseDelay * Math.pow(2, retryCount - 1), maxDelay);
    
    // Add jitter (±10%)
    const jitter = delay * 0.1 * (Math.random() * 2 - 1);
    delay += jitter;
    
    return Math.floor(delay);
  }

  /**
   * Get delay bucket for efficient scheduling
   * Buckets: immediate, 1m, 5m, 15m, 1h, 6h, 24h
   */
  _getDelayBucket(delayMs) {
    if (delayMs <= 0) return 'immediate';
    if (delayMs < 60000) return '1m';      // < 1 min
    if (delayMs < 300000) return '5m';     // < 5 min
    if (delayMs < 900000) return '15m';    // < 15 min
    if (delayMs < 3600000) return '1h';    // < 1 hour
    if (delayMs < 21600000) return '6h';   // < 6 hours
    return '24h';
  }

  /**
   * Emit DLQ alert (integrate with notification system)
   */
  _emitDLQAlert(task, error) {
    // Integration with existing notification system
    logger.alert({
      type: 'delay_queue_dlq',
      severity: 'high',
      taskId: task.id,
      taskType: task.type,
      error: error.message,
    });
    
    incrementCounter('delay_queue_dlq_alerts_total', 1, {
      task_type: task.type,
    });
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    return {
      scheduled: this.metrics.tasksScheduled,
      completed: this.metrics.tasksCompleted,
      failed: this.metrics.tasksFailed,
      retried: this.metrics.tasksRetried,
      deadLetter: this.metrics.tasksDeadLetter,
      activeHandlers: this.taskHandlers.size,
      recurringTasks: this.recurringTasks.size,
    };
  }

  /**
   * Cancel a recurring task
   */
  cancelRecurring(taskId) {
    const config = this.recurringTasks.get(taskId);
    if (config) {
      config.active = false;
      if (config._interval) {
        clearInterval(config._interval);
      }
      this.recurringTasks.delete(taskId);
      logger.info({ taskId }, 'Recurring task cancelled');
      return true;
    }
    return false;
  }

  /**
   * Graceful shutdown
   */
  async disconnect() {
    // Stop all recurring tasks
    for (const [id, config] of this.recurringTasks) {
      if (config._interval) {
        clearInterval(config._interval);
      }
    }
    this.recurringTasks.clear();
    
    // Disconnect consumers
    for (const [topic, consumer] of this.consumers) {
      await consumer.disconnect();
      logger.info({ topic }, 'Consumer disconnected');
    }
    
    // Disconnect producer
    if (this.producer) {
      await this.producer.disconnect();
    }
    
    this.isConnected = false;
    logger.info('DelayQueue disconnected');
  }
}

// Singleton instance
let delayQueueInstance = null;

/**
 * Get or create DelayQueue instance
 */
function getDelayQueue(config = {}) {
  if (!delayQueueInstance) {
    delayQueueInstance = new DelayQueue(config);
  }
  return delayQueueInstance;
}

/**
 * Reset singleton (for testing)
 */
function resetDelayQueue() {
  delayQueueInstance = null;
}

module.exports = { DelayQueue, getDelayQueue, resetDelayQueue };
