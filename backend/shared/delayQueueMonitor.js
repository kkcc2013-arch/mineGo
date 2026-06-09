'use strict';

const { Kafka } = require('kafkajs');
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
    this.alertThreshold = config.alertThreshold || 5; // Alert after N DLQ messages
    
    this.kafka = new Kafka({
      clientId: config.clientId || 'dlq-monitor',
      brokers: config.brokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
    });
    
    this.consumer = null;
    this.producer = null;
    this.isRunning = false;
    
    // Statistics
    this.stats = {
      dlqMessagesReceived: 0,
      dlqAutoRetried: 0,
      dlqAlertsSent: 0,
      dlqResolved: 0,
    };
    
    // Alert tracking (per task type)
    this.alertCounts = new Map();
  }

  /**
   * Start monitoring DLQ
   */
  async start() {
    if (this.isRunning) return;
    
    // Connect producer for re-scheduling
    this.producer = this.kafka.producer();
    await this.producer.connect();
    
    // Subscribe to DLQ topic
    this.consumer = this.kafka.consumer({ 
      groupId: 'dlq-monitor',
      fromBeginning: false,
    });
    
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.dlqTopic, fromBeginning: false });
    
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const task = JSON.parse(message.value.toString());
          await this._handleDLQMessage(task);
        } catch (err) {
          logger.error({ err }, 'Error handling DLQ message');
        }
      },
    });
    
    this.isRunning = true;
    logger.info('DLQ monitor started');
  }

  /**
   * Handle DLQ message
   */
  async _handleDLQMessage(task) {
    this.stats.dlqMessagesReceived++;
    
    logger.warn({ 
      taskId: task.id, 
      taskType: task.type,
      retries: task.retries,
      error: task.error?.message,
    }, 'DLQ message received');
    
    incrementCounter('delay_queue_dlq_messages_total', 1, {
      task_type: task.type,
    });
    
    // Track alert count
    const typeCount = (this.alertCounts.get(task.type) || 0) + 1;
    this.alertCounts.set(task.type, typeCount);
    
    // Send alert if threshold reached
    if (typeCount >= this.alertThreshold) {
      this._sendAlert(task, typeCount);
      this.alertCounts.set(task.type, 0); // Reset counter
    }
    
    // Try auto-retry if enabled
    if (this.autoRetryEnabled && task.retries < this.maxAutoRetries) {
      await this._autoRetry(task);
    }
    
    // Update gauge
    gauge('delay_queue_dlq_size', this.stats.dlqMessagesReceived);
  }

  /**
   * Send alert for DLQ task
   */
  _sendAlert(task, count) {
    this.stats.dlqAlertsSent++;
    
    // Integration with existing notification system
    logger.alert({
      type: 'delay_queue_dlq_threshold',
      severity: 'high',
      taskType: task.type,
      count,
      lastTaskId: task.id,
      error: task.error?.message,
    });
    
    incrementCounter('delay_queue_dlq_alerts_sent_total', 1, {
      task_type: task.type,
    });
    
    logger.info({ 
      taskType: task.type, 
      count,
    }, 'DLQ alert sent');
  }

  /**
   * Auto-retry DLQ task
   */
  async _autoRetry(task) {
    try {
      const delayQueue = getDelayQueue();
      
      // Reset retry count for fresh attempt
      const freshTask = {
        ...task,
        retries: 0,
        autoRetry: true,
        autoRetryAt: new Date().toISOString(),
      };
      
      await delayQueue.schedule(task.type, task.payload, {
        priority: 'high',
        maxRetries: task.maxRetries,
        metadata: { 
          ...task.metadata,
          autoRetry: true,
          originalTaskId: task.id,
        },
      });
      
      this.stats.dlqAutoRetried++;
      
      incrementCounter('delay_queue_dlq_auto_retried_total', 1, {
        task_type: task.type,
      });
      
      logger.info({ 
        taskId: task.id, 
        taskType: task.type,
      }, 'DLQ task auto-retried');
      
    } catch (err) {
      logger.error({ 
        err, 
        taskId: task.id,
      }, 'Failed to auto-retry DLQ task');
    }
  }

  /**
   * Manually retry a DLQ task
   */
  async retryTask(taskId, taskData) {
    const delayQueue = getDelayQueue();
    
    const result = await delayQueue.schedule(taskData.type, taskData.payload, {
      priority: 'high',
      maxRetries: taskData.maxRetries,
      metadata: {
        ...taskData.metadata,
        manualRetry: true,
        originalTaskId: taskId,
      },
    });
    
    this.stats.dlqResolved++;
    
    logger.info({ 
      taskId, 
      newTaskId: result.taskId,
    }, 'DLQ task manually retried');
    
    return result;
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
    
    const health = {
      status: dlqRate < 5 ? 'healthy' : (dlqRate < 10 ? 'degraded' : 'unhealthy'),
      queueStats: stats,
      monitorStats: this.stats,
      dlqRate: `${dlqRate}%`,
      autoRetryEnabled: this.autoRetryEnabled,
    };
    
    gauge('delay_queue_health_score', dlqRate < 5 ? 100 : (dlqRate < 10 ? 50 : 0));
    
    return health;
  }

  /**
   * Get DLQ statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      alertThreshold: this.alertThreshold,
      autoRetryEnabled: this.autoRetryEnabled,
    };
  }

  /**
   * Clear alert counts
   */
  clearAlertCounts() {
    this.alertCounts.clear();
  }

  /**
   * Stop monitor
   */
  async stop() {
    this.isRunning = false;
    
    if (this.consumer) {
      await this.consumer.disconnect();
    }
    
    if (this.producer) {
      await this.producer.disconnect();
    }
    
    logger.info('DLQ monitor stopped');
  }
}

// Singleton instance
let monitorInstance = null;

/**
 * Get or create monitor instance
 */
function getDelayQueueMonitor(config = {}) {
  if (!monitorInstance) {
    monitorInstance = new DelayQueueMonitor(config);
  }
  return monitorInstance;
}

/**
 * Reset singleton (for testing)
 */
function resetDelayQueueMonitor() {
  monitorInstance = null;
}

module.exports = { 
  DelayQueueMonitor, 
  getDelayQueueMonitor, 
  resetDelayQueueMonitor 
};
