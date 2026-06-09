'use strict';

const { Kafka } = require('kafkajs');
const { createLogger } = require('./logger');
const { incrementCounter, gauge } = require('./metrics');

const logger = createLogger('delay-bucket-scheduler');

/**
 * Delay Bucket Scheduler
 * Moves tasks from delay buckets to ready queue when time arrives
 * 
 * Buckets:
 * - immediate: execute now
 * - 1m: tasks within 1 minute
 * - 5m: tasks within 5 minutes
 * - 15m: tasks within 15 minutes
 * - 1h: tasks within 1 hour
 * - 6h: tasks within 6 hours
 * - 24h: tasks within 24 hours
 */
class DelayBucketScheduler {
  constructor(config = {}) {
    this.buckets = ['immediate', '1m', '5m', '15m', '1h', '6h', '24h'];
    this.delayTopicPrefix = config.delayTopicPrefix || 'delay-queue';
    this.readyTopic = config.readyTopic || 'delay-queue-ready';
    
    this.kafka = new Kafka({
      clientId: config.clientId || 'delay-bucket-scheduler',
      brokers: config.brokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
    });
    
    this.producer = null;
    this.consumers = [];
    this.isRunning = false;
    this.pollIntervals = [];
    
    // Bucket check intervals (ms)
    this.bucketIntervals = {
      'immediate': 1000,   // Check every second
      '1m': 5000,          // Check every 5 seconds
      '5m': 15000,         // Check every 15 seconds
      '15m': 60000,        // Check every minute
      '1h': 300000,        // Check every 5 minutes
      '6h': 900000,        // Check every 15 minutes
      '24h': 3600000,      // Check every hour
    };
    
    // Metrics
    this.stats = {
      tasksMoved: 0,
      tasksRebucketed: 0,
      errors: 0,
    };
  }

  /**
   * Start bucket scheduler
   */
  async start() {
    if (this.isRunning) return;
    
    this.producer = this.kafka.producer();
    await this.producer.connect();
    
    // Create consumer for each delay bucket
    for (const bucket of this.buckets) {
      const consumer = this.kafka.consumer({ 
        groupId: `delay-scheduler-${bucket}`,
        sessionTimeout: 30000,
        heartbeatInterval: 10000,
      });
      
      await consumer.connect();
      await consumer.subscribe({ 
        topic: `${this.delayTopicPrefix}-${bucket}`,
        fromBeginning: false,
      });
      
      this.consumers.push({ bucket, consumer });
      
      logger.info({ bucket }, 'Bucket consumer connected');
    }
    
    // Start polling for each bucket
    this._startBucketPollers();
    
    this.isRunning = true;
    logger.info('Delay bucket scheduler started');
  }

  /**
   * Start bucket pollers with different intervals
   */
  _startBucketPollers() {
    for (const { bucket, consumer } of this.consumers) {
      const interval = this.bucketIntervals[bucket] || 60000;
      
      const poller = setInterval(async () => {
        if (!this.isRunning) return;
        
        try {
          await this._pollBucket(bucket, consumer);
        } catch (err) {
          logger.error({ err, bucket }, 'Error polling bucket');
          this.stats.errors++;
        }
      }, interval);
      
      this.pollIntervals.push(poller);
    }
    
    // Also start immediate queue processor (runs frequently)
    this._startImmediateProcessor();
  }

  /**
   * Start immediate queue processor
   */
  _startImmediateProcessor() {
    const immediatePoller = setInterval(async () => {
      if (!this.isRunning) return;
      
      try {
        const immediateConsumer = this.consumers.find(c => c.bucket === 'immediate')?.consumer;
        if (immediateConsumer) {
          await this._pollBucket('immediate', immediateConsumer);
        }
      } catch (err) {
        logger.error({ err }, 'Error processing immediate bucket');
      }
    }, 1000); // Every second
    
    this.pollIntervals.push(immediatePoller);
  }

  /**
   * Poll a specific bucket for ready tasks
   */
  async _pollBucket(bucket, consumer) {
    // Use consumer to fetch messages
    // For each message, check if it's ready to execute
    const topic = `${this.delayTopicPrefix}-${bucket}`;
    
    try {
      // Run consumer for a short time to process available messages
      await consumer.run({
        eachMessage: async ({ message }) => {
          await this._processBucketMessage(bucket, message);
        },
        autoCommit: true,
      });
    } catch (err) {
      if (!err.message?.includes('already running')) {
        throw err;
      }
    }
  }

  /**
   * Process message from delay bucket
   */
  async _processBucketMessage(bucket, message) {
    try {
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
            headers: {
              'task-type': task.type,
              'original-bucket': bucket,
            },
          }],
        });
        
        this.stats.tasksMoved++;
        incrementCounter('delay_bucket_tasks_moved_total', 1, { 
          bucket,
          task_type: task.type,
        });
        
        logger.debug({ taskId: task.id, bucket }, 'Task moved to ready queue');
        
      } else {
        // Not ready yet, check if it needs re-bucketing
        const remainingDelay = executeAt - now;
        const newBucket = this._getDelayBucket(remainingDelay);
        
        if (newBucket !== bucket) {
          // Move to more appropriate bucket
          await this.producer.send({
            topic: `${this.delayTopicPrefix}-${newBucket}`,
            messages: [{
              key: task.id,
              value: JSON.stringify(task),
            }],
          });
          
          this.stats.tasksRebucketed++;
          incrementCounter('delay_bucket_tasks_rebucketed_total', 1, { 
            from_bucket: bucket,
            to_bucket: newBucket,
          });
          
          logger.debug({ 
            taskId: task.id, 
            oldBucket: bucket, 
            newBucket,
          }, 'Task re-bucketed');
        }
      }
    } catch (err) {
      logger.error({ err, bucket }, 'Error processing bucket message');
      this.stats.errors++;
    }
  }

  /**
   * Get appropriate delay bucket
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
   * Get scheduler statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      buckets: this.buckets.length,
      activeConsumers: this.consumers.length,
    };
  }

  /**
   * Stop scheduler
   */
  async stop() {
    this.isRunning = false;
    
    // Stop all pollers
    for (const interval of this.pollIntervals) {
      clearInterval(interval);
    }
    this.pollIntervals = [];
    
    // Disconnect consumers
    for (const { bucket, consumer } of this.consumers) {
      try {
        await consumer.disconnect();
        logger.info({ bucket }, 'Bucket consumer disconnected');
      } catch (err) {
        logger.error({ err, bucket }, 'Error disconnecting consumer');
      }
    }
    this.consumers = [];
    
    // Disconnect producer
    if (this.producer) {
      await this.producer.disconnect();
    }
    
    logger.info('Delay bucket scheduler stopped');
  }
}

// Singleton instance
let schedulerInstance = null;

/**
 * Get or create scheduler instance
 */
function getDelayBucketScheduler(config = {}) {
  if (!schedulerInstance) {
    schedulerInstance = new DelayBucketScheduler(config);
  }
  return schedulerInstance;
}

/**
 * Reset singleton (for testing)
 */
function resetDelayBucketScheduler() {
  schedulerInstance = null;
}

module.exports = { DelayBucketScheduler, getDelayBucketScheduler, resetDelayBucketScheduler };
