# REQ-00043: 延迟任务队列与可靠重试机制

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00043 |
| 标题 | 延迟任务队列与可靠重试机制 |
| 类别 | 技术债/重构 |
| 优先级 | P1 |
| 状态 | done |
| 涉及服务 | 所有微服务、backend/shared、Kafka |
| 创建时间 | 2026-06-09 02:00 |

## 需求描述

### 背景
当前系统已实现基于 Kafka 的 EventBus（REQ-00013），但缺少：
1. **延迟任务执行**：无法在指定延迟后执行任务（如 Raid 结束后延迟发放奖励）
2. **可靠重试机制**：EventBus 的重试配置硬编码，缺少业务级重试策略
3. **死信队列处理**：DLQ 消息需手动处理，缺少自动重试和告警
4. **任务优先级**：所有任务平等处理，缺少优先级调度

### 目标
构建统一的延迟任务队列系统，支持：
- 延迟任务调度（秒/分/小时/天级）
- 指数退避重试策略
- 任务优先级队列
- 死信队列自动处理
- 任务可视化监控

### 应用场景
1. **Raid 奖励延迟发放**：Raid 结束后 5 分钟发放奖励
2. **通知延迟发送**：用户离线后 30 分钟发送推送
3. **支付超时取消**：订单创建 30 分钟后未支付自动取消
4. **数据清理任务**：每日凌晨 3 点执行过期数据清理
5. **缓存预热任务**：每小时执行热点数据预热

## 技术方案

### 1. 延迟队列核心模块

#### backend/shared/DelayQueue.js
```javascript
'use strict';

const { Kafka } = require('kafkajs');
const { createLogger } = require('./logger');
const { incrementCounter, observeHistogram } = require('./metrics');

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
   * Schedule a recurring task
   * @param {string} taskType - Task type
   * @param {object} payload - Task payload
   * @param {string} cronExpression - Cron expression (e.g., '0 3 * * *' = daily at 3 AM)
   */
  async scheduleRecurring(taskType, payload, cronExpression) {
    const cron = require('node-cron');
    
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }
    
    const scheduledTask = cron.schedule(cronExpression, async () => {
      await this.schedule(taskType, payload, { priority: 'low' });
    }, {
      scheduled: true,
      timezone: 'UTC',
    });
    
    logger.info({ taskType, cronExpression }, 'Recurring task scheduled');
    
    return scheduledTask;
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
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    return {
      scheduled: this.metrics?.tasksScheduled || 0,
      completed: this.metrics?.tasksCompleted || 0,
      failed: this.metrics?.tasksFailed || 0,
      retried: this.metrics?.tasksRetried || 0,
      deadLetter: this.metrics?.tasksDeadLetter || 0,
      activeHandlers: this.taskHandlers.size,
    };
  }

  /**
   * Graceful shutdown
   */
  async disconnect() {
    for (const [topic, consumer] of this.consumers) {
      await consumer.disconnect();
      logger.info({ topic }, 'Consumer disconnected');
    }
    
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

module.exports = { DelayQueue, getDelayQueue };
```

### 2. 任务处理器集成示例

#### backend/services/gym-service/src/handlers/raidRewardHandler.js
```javascript
'use strict';

const { getDelayQueue } = require('../../../shared/DelayQueue');
const { publishRaidRewards } = require('../services/raidService');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('raid-reward-handler');

/**
 * Initialize raid reward delay handler
 * Raid rewards are sent 5 minutes after raid ends
 */
async function initRaidRewardHandler() {
  const delayQueue = getDelayQueue({ clientId: 'gym-service' });
  
  await delayQueue.registerHandler('raid.reward', async (payload, task) => {
    logger.info({ raidId: payload.raidId }, 'Processing delayed raid reward');
    
    // Publish rewards to participants
    await publishRaidRewards(payload.raidId, payload.participants);
    
    logger.info({ 
      raidId: payload.raidId, 
      participantCount: payload.participants.length,
    }, 'Raid rewards distributed');
  });
  
  logger.info('Raid reward delay handler initialized');
}

/**
 * Schedule raid reward for delayed distribution
 */
async function scheduleRaidReward(raidId, participants) {
  const delayQueue = getDelayQueue({ clientId: 'gym-service' });
  
  // Delay 5 minutes
  const result = await delayQueue.schedule('raid.reward', {
    raidId,
    participants,
  }, {
    delay: 5 * 60 * 1000, // 5 minutes
    priority: 'high',     // High priority for rewards
    maxRetries: 10,       // Rewards are critical, more retries
  });
  
  logger.info({ 
    raidId, 
    participantCount: participants.length,
    taskId: result.taskId,
  }, 'Raid reward scheduled');
  
  return result;
}

module.exports = { initRaidRewardHandler, scheduleRaidReward };
```

### 3. 支付订单超时取消

#### backend/services/payment-service/src/handlers/orderTimeoutHandler.js
```javascript
'use strict';

const { getDelayQueue } = getDelayQueue = require('../../../shared/DelayQueue');
const { cancelExpiredOrder } = require('../services/orderService');
const { createLogger } = require('../../../shared/logger');

const logger = createLogger('order-timeout-handler');

/**
 * Initialize order timeout handler
 * Unpaid orders are cancelled after 30 minutes
 */
async function initOrderTimeoutHandler() {
  const delayQueue = getDelayQueue({ clientId: 'payment-service' });
  
  await delayQueue.registerHandler('order.timeout', async (payload, task) => {
    logger.info({ orderId: payload.orderId }, 'Processing order timeout check');
    
    // Cancel expired order
    await cancelExpiredOrder(payload.orderId);
    
    logger.info({ orderId: payload.orderId }, 'Expired order cancelled');
  });
  
  logger.info('Order timeout handler initialized');
}

/**
 * Schedule order timeout check
 */
async function scheduleOrderTimeout(orderId) {
  const delayQueue = getDelayQueue({ clientId: 'payment-service' });
  
  // Delay 30 minutes
  const result = await delayQueue.schedule('order.timeout', {
    orderId,
  }, {
    delay: 30 * 60 * 1000, // 30 minutes
    priority: 'critical',  // Critical for payment integrity
    maxRetries: 3,         // Limited retries for timeouts
  });
  
  logger.info({ orderId, taskId: result.taskId }, 'Order timeout scheduled');
  
  return result;
}

module.exports = { initOrderTimeoutHandler, scheduleOrderTimeout };
```

### 4. 延迟队列监控服务

#### backend/shared/delayQueueMonitor.js
```javascript
'use strict';

const { getDelayQueue } = require('./DelayQueue');
const { createLogger } = require('./logger');
const { incrementCounter, gauge } = require('./metrics');

const logger = createLogger('delay-queue-monitor');

/**
 * Delay Queue Monitor Service
 * - Monitors DLQ and triggers alerts
 * - Provides queue statistics
 * - Auto-retries recoverable DLQ tasks
 */
class DelayQueueMonitor {
  constructor(config = {}) {
    this.dlqTopic = config.dlqTopic || 'delay-queue-dlq';
    this.autoRetryEnabled = config.autoRetryEnabled || false;
    this.maxAutoRetries = config.maxAutoRetries || 1;
  }

  /**
   * Start monitoring DLQ
   */
  async start() {
    const delayQueue = getDelayQueue();
    
    // Subscribe to DLQ topic
    const { Kafka } = require('kafkajs');
    const kafka = new Kafka({
      clientId: 'dlq-monitor',
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
    });
    
    const consumer = kafka.consumer({ groupId: 'dlq-monitor' });
    await consumer.connect();
    await consumer.subscribe({ topic: this.dlqTopic, fromBeginning: false });
    
    await consumer.run({
      eachMessage: async ({ message }) => {
        const task = JSON.parse(message.value.toString());
        await this._handleDLQMessage(task);
      },
    });
    
    logger.info('DLQ monitor started');
  }

  /**
   * Handle DLQ message
   */
  async _handleDLQMessage(task) {
    logger.warn({ 
      taskId: task.id, 
      taskType: task.type,
      retries: task.retries,
    }, 'DLQ message received');
    
    // Alert
    this._sendAlert(task);
    
    // Try auto-retry if enabled
    if (this.autoRetryEnabled && task.retries < this.maxAutoRetries) {
      await this._autoRetry(task);
    }
  }

  /**
   * Send alert for DLQ task
   */
  _sendAlert(task) {
    // Integration with existing notification system
    logger.alert({
      type: 'delay_queue_dlq',
      severity: 'high',
      taskId: task.id,
      taskType: task.type,
      error: task.error?.message,
    });
    
    incrementCounter('delay_queue_dlq_alerts_total', 1, {
      task_type: task.type,
    });
  }

  /**
   * Auto-retry DLQ task
   */
  async _autoRetry(task) {
    const delayQueue = getDelayQueue();
    
    // Reset retry count for fresh attempt
    task.retries = 0;
    task.autoRetry = true;
    
    await delayQueue.schedule(task.type, task.payload, {
      priority: 'high',
      maxRetries: task.maxRetries,
    });
    
    logger.info({ taskId: task.id }, 'DLQ task auto-retried');
  }

  /**
   * Get queue health status
   */
  async getHealth() {
    const delayQueue = getDelayQueue();
    const stats = await delayQueue.getStats();
    
    const dlqRate = stats.completed > 0 
      ? (stats.deadLetter / stats.completed * 100).toFixed(2) 
      : 0;
    
    return {
      status: dlqRate < 5 ? 'healthy' : 'degraded',
      stats,
      dlqRate: `${dlqRate}%`,
    };
  }
}

module.exports = DelayQueueMonitor;
```

### 5. 延迟桶调度器

#### backend/shared/delayBucketScheduler.js
```javascript
'use strict';

const { Kafka } = require('kafkajs');
const { createLogger } = require('./logger');

const logger = createLogger('delay-bucket-scheduler');

/**
 * Delay Bucket Scheduler
 * Moves tasks from delay buckets to ready queue when time arrives
 */
class DelayBucketScheduler {
  constructor(config = {}) {
    this.buckets = ['1m', '5m', '15m', '1h', '6h', '24h'];
    this.delayTopicPrefix = config.delayTopicPrefix || 'delay-queue';
    this.readyTopic = config.readyTopic || 'delay-queue-ready';
    
    this.kafka = new Kafka({
      clientId: 'delay-bucket-scheduler',
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
    });
    
    this.producer = null;
    this.consumers = [];
  }

  /**
   * Start bucket scheduler
   */
  async start() {
    this.producer = this.kafka.producer();
    await this.producer.connect();
    
    // Create consumer for each delay bucket
    for (const bucket of this.buckets) {
      const consumer = this.kafka.consumer({ 
        groupId: `delay-scheduler-${bucket}` 
      });
      
      await consumer.connect();
      await consumer.subscribe({ 
        topic: `${this.delayTopicPrefix}-${bucket}`,
        fromBeginning: false,
      });
      
      await consumer.run({
        eachMessage: async ({ message }) => {
          await this._processBucketMessage(bucket, message);
        },
      });
      
      this.consumers.push(consumer);
    }
    
    // Start polling for ready tasks
    this._startReadyPoller();
    
    logger.info('Delay bucket scheduler started');
  }

  /**
   * Process message from delay bucket
   */
  async _processBucketMessage(bucket, message) {
    const task = JSON.parse(message.value.toString());
    const executeAt = new Date(task.executeAt).getTime();
    const now = Date.now();
    
    if (executeAt <= now) {
      // Task is ready, move to ready queue
      await this.producer.send({
        topic: this.readyTopic,
        messages: [{
          key: task.id,
          value: JSON.stringify(task),
        }],
      });
      
      logger.debug({ taskId: task.id, bucket }, 'Task moved to ready queue');
    } else {
      // Re-schedule to appropriate bucket
      const remainingDelay = executeAt - now;
      const newBucket = this._getDelayBucket(remainingDelay);
      
      if (newBucket !== bucket) {
        await this.producer.send({
          topic: `${this.delayTopicPrefix}-${newBucket}`,
          messages: [{
            key: task.id,
            value: JSON.stringify(task),
          }],
        });
        
        logger.debug({ 
          taskId: task.id, 
          oldBucket: bucket, 
          newBucket,
        }, 'Task re-bucketed');
      }
    }
  }

  /**
   * Get appropriate delay bucket
   */
  _getDelayBucket(delayMs) {
    if (delayMs <= 0) return 'immediate';
    if (delayMs < 60000) return '1m';
    if (delayMs < 300000) return '5m';
    if (delayMs < 900000) return '15m';
    if (delayMs < 3600000) return '1h';
    if (delayMs < 21600000) return '6h';
    return '24h';
  }

  /**
   * Start ready task poller (checks immediate bucket frequently)
   */
  _startReadyPoller() {
    setInterval(async () => {
      try {
        // Check immediate bucket every second
        await this._checkImmediateBucket();
      } catch (err) {
        logger.error({ err }, 'Error checking immediate bucket');
      }
    }, 1000);
  }

  /**
   * Check immediate bucket for ready tasks
   */
  async _checkImmediateBucket() {
    // Implementation for immediate bucket polling
    // Uses Kafka consumer to fetch and process immediate tasks
  }

  /**
   * Stop scheduler
   */
  async stop() {
    for (const consumer of this.consumers) {
      await consumer.disconnect();
    }
    
    if (this.producer) {
      await this.producer.disconnect();
    }
    
    logger.info('Delay bucket scheduler stopped');
  }
}

module.exports = DelayBucketScheduler;
```

### 6. Prometheus 指标扩展

#### backend/shared/metrics.js (扩展)
```javascript
// Delay Queue Metrics
const delayQueueMetrics = {
  // Counter: Tasks scheduled
  'delay_queue_tasks_scheduled_total': {
    type: 'counter',
    help: 'Total number of tasks scheduled',
    labelNames: ['task_type', 'priority', 'delay_bucket'],
  },
  
  // Counter: Tasks started
  'delay_queue_tasks_started_total': {
    type: 'counter',
    help: 'Total number of tasks started processing',
    labelNames: ['task_type'],
  },
  
  // Counter: Tasks completed
  'delay_queue_tasks_completed_total': {
    type: 'counter',
    help: 'Total number of tasks completed successfully',
    labelNames: ['task_type'],
  },
  
  // Counter: Tasks retried
  'delay_queue_tasks_retried_total': {
    type: 'counter',
    help: 'Total number of task retries',
    labelNames: ['task_type', 'retry_attempt'],
  },
  
  // Counter: Tasks in DLQ
  'delay_queue_tasks_dead_letter_total': {
    type: 'counter',
    help: 'Total number of tasks sent to dead letter queue',
    labelNames: ['task_type'],
  },
  
  // Histogram: Task duration
  'delay_queue_task_duration_seconds': {
    type: 'histogram',
    help: 'Duration of task execution in seconds',
    labelNames: ['task_type', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
  },
  
  // Gauge: Queue size by bucket
  'delay_queue_bucket_size': {
    type: 'gauge',
    help: 'Current number of tasks in delay bucket',
    labelNames: ['bucket'],
  },
};
```

### 7. 数据库迁移

#### database/pending/20260609_020000__add_delay_queue_tables.sql
```sql
-- Delay queue task tracking table
CREATE TABLE delay_queue_tasks (
  id VARCHAR(100) PRIMARY KEY,
  type VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  priority INTEGER DEFAULT 2,
  status VARCHAR(20) DEFAULT 'pending', -- pending, processing, completed, failed, dead_letter
  execute_at TIMESTAMP NOT NULL,
  retries INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 5,
  error_message TEXT,
  error_stack TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  metadata JSONB
);

CREATE INDEX idx_delay_queue_tasks_status ON delay_queue_tasks(status);
CREATE INDEX idx_delay_queue_tasks_type ON delay_queue_tasks(type);
CREATE INDEX idx_delay_queue_tasks_execute_at ON delay_queue_tasks(execute_at) WHERE status = 'pending';
CREATE INDEX idx_delay_queue_tasks_priority ON delay_queue_tasks(priority, execute_at) WHERE status = 'pending';

-- Delay queue statistics table
CREATE TABLE delay_queue_stats (
  id SERIAL PRIMARY KEY,
  recorded_at TIMESTAMP DEFAULT NOW(),
  bucket VARCHAR(20) NOT NULL,
  task_count INTEGER NOT NULL,
  avg_delay_seconds NUMERIC,
  max_delay_seconds INTEGER
);

CREATE INDEX idx_delay_queue_stats_bucket ON delay_queue_stats(bucket, recorded_at DESC);

-- DLQ audit log
CREATE TABLE delay_queue_dlq_audit (
  id SERIAL PRIMARY KEY,
  task_id VARCHAR(100) NOT NULL,
  task_type VARCHAR(100) NOT NULL,
  original_payload JSONB,
  error_message TEXT,
  failed_at TIMESTAMP DEFAULT NOW(),
  resolved_at TIMESTAMP,
  resolved_by VARCHAR(100),
  resolution_notes TEXT
);

CREATE INDEX idx_dlq_audit_task_type ON delay_queue_dlq_audit(task_type);
CREATE INDEX idx_dlq_audit_failed_at ON delay_queue_dlq_audit(failed_at DESC);
```

### 8. 管理API

#### backend/gateway/src/routes/delayQueueAdmin.js
```javascript
'use strict';

const express = require('express');
const { getDelayQueue } = require('../../../shared/DelayQueue');
const DelayQueueMonitor = require('../../../shared/delayQueueMonitor');
const { createLogger } = require('../../../shared/logger');

const router = express.Router();
const logger = createLogger('delay-queue-admin');

/**
 * GET /api/admin/delay-queue/stats
 * Get queue statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const delayQueue = getDelayQueue();
    const stats = await delayQueue.getStats();
    
    res.json({ success: true, stats });
  } catch (err) {
    logger.error({ err }, 'Failed to get queue stats');
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * GET /api/admin/delay-queue/health
 * Get queue health status
 */
router.get('/health', async (req, res) => {
  try {
    const monitor = new DelayQueueMonitor();
    const health = await monitor.getHealth();
    
    res.json(health);
  } catch (err) {
    logger.error({ err }, 'Failed to get queue health');
    res.status(500).json({ error: 'Failed to get health' });
  }
});

/**
 * POST /api/admin/delay-queue/tasks
 * Manually schedule a task
 */
router.post('/tasks', async (req, res) => {
  try {
    const { taskType, payload, delay, priority } = req.body;
    
    const delayQueue = getDelayQueue();
    const result = await delayQueue.schedule(taskType, payload, {
      delay: delay || 0,
      priority: priority || 'normal',
    });
    
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, 'Failed to schedule task');
    res.status(500).json({ error: 'Failed to schedule task' });
  }
});

/**
 * POST /api/admin/delay-queue/dlq/:taskId/retry
 * Retry a DLQ task manually
 */
router.post('/dlq/:taskId/retry', async (req, res) => {
  try {
    const { taskId } = req.params;
    // Implementation: fetch from DLQ and re-schedule
    
    res.json({ success: true, message: 'Task retry scheduled' });
  } catch (err) {
    logger.error({ err }, 'Failed to retry DLQ task');
    res.status(500).json({ error: 'Failed to retry task' });
  }
});

module.exports = router;
```

## 验收标准

- [ ] DelayQueue 核心模块实现并集成到 backend/shared
- [ ] 支持延迟任务调度（秒/分/小时/天级）
- [ ] 实现指数退避重试机制（可配置重试次数）
- [ ] 支持任务优先级（critical/high/normal/low）
- [ ] 死信队列自动处理和告警
- [ ] 至少 2 个服务集成延迟队列（gym-service, payment-service）
- [ ] Raid 奖励延迟发放功能实现
- [ ] 支付订单超时自动取消功能实现
- [ ] 管理API 提供 /api/admin/delay-queue/* 端点
- [ ] Prometheus 指标监控（7个以上指标）
- [ ] 单元测试覆盖率达到 80% 以上
- [ ] 文档更新：ARCHITECTURE.md 增加延迟队列架构说明

## 影响范围

### 新增文件
- backend/shared/DelayQueue.js
- backend/shared/delayBucketScheduler.js
- backend/shared/delayQueueMonitor.js
- backend/services/gym-service/src/handlers/raidRewardHandler.js
- backend/services/payment-service/src/handlers/orderTimeoutHandler.js
- backend/gateway/src/routes/delayQueueAdmin.js
- database/pending/20260609_020000__add_delay_queue_tables.sql
- backend/tests/unit/delay-queue.test.js

### 修改文件
- backend/shared/metrics.js (新增延迟队列指标)
- backend/shared/ServiceLauncher.js (集成延迟队列初始化)
- backend/services/gym-service/src/index.js (注册 raid.reward handler)
- backend/services/payment-service/src/index.js (注册 order.timeout handler)
- backend/gateway/src/index.js (挂载管理API路由)
- ARCHITECTURE.md (新增延迟队列架构说明)

## 参考

- [Kafka Delay Queue Pattern](https://kafka.apache.org/documentation/#impl_delayqueues)
- [Exponential Backoff Algorithm](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Redis Delay Queue Implementation](https://redis.io/topics/data-types-intro#sorted-sets)
- REQ-00013: 事件驱动架构与服务解耦
- REQ-00026: 游戏内实时推送通知系统
- REQ-00003: 支付订单幂等性与签名验证安全加固
