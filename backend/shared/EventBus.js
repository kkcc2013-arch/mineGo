// backend/shared/EventBus.js
'use strict';

const { Kafka } = require('kafkajs');
const { createLogger } = require('./logger');

const logger = createLogger('event-bus');

/**
 * 是否启用 Kafka：显式 KAFKA_ENABLED 优先；否则配置了 KAFKA_BROKERS 或事件总线适配器为 kafka（默认）时启用。
 * 生产机（PM2，无 Kafka）配置 EVENT_BUS_ADAPTER=redis，此时 Kafka 事件发布降级为空操作，
 * 避免无限重连刷屏和 unhandledRejection。
 */
function isKafkaEnabled() {
  if (process.env.KAFKA_ENABLED) return process.env.KAFKA_ENABLED === 'true';
  if (process.env.KAFKA_BROKERS) return true;
  return (process.env.EVENT_BUS_ADAPTER || 'kafka').toLowerCase() === 'kafka';
}

/**
 * EventBus - Kafka-based event bus for microservices communication
 * 
 * Features:
 * - Event publishing and subscription
 * - Automatic retry mechanism
 * - Dead letter queue (DLQ) support
 * - Prometheus metrics integration
 * - Graceful shutdown
 */
class EventBus {
  constructor(config = {}) {
    this.clientId = config.clientId || 'minego-service';
    this.brokers = config.brokers || (process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092']);
    
    this.kafka = new Kafka({
      clientId: this.clientId,
      brokers: this.brokers,
      retry: {
        initialRetryTime: 100,
        retries: 8,
        maxRetryTime: 30000,
        multiplier: 2,
      },
      connectionTimeout: 3000,
      requestTimeout: 30000,
    });
    
    this.producer = null;
    this.consumers = new Map();
    this.isConnected = false;
    this.disabled = config.enabled === undefined ? !isKafkaEnabled() : !config.enabled;
    
    // Metrics
    this.metrics = {
      eventsPublished: 0,
      eventsProcessed: 0,
      eventsFailed: 0,
      dlqMessages: 0,
    };
  }

  /**
   * Connect to Kafka
   */
  async connect() {
    if (this.isConnected || this.disabled) return;
    
    try {
      this.producer = this.kafka.producer({
        maxRetryTime: 30000,
        allowAutoTopicCreation: true,
      });
      
      await this.producer.connect();
      this.isConnected = true;
      logger.info({ clientId: this.clientId, brokers: this.brokers }, 'EventBus connected to Kafka');
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Kafka');
      throw err;
    }
  }

  /**
   * Publish an event to a topic
   * @param {string} topic - Topic name
   * @param {object} event - Event payload
   * @param {object} options - Publishing options
   */
  async publish(topic, event, options = {}) {
    if (this.disabled) {
      logger.debug({ topic, type: event && event.type }, 'Kafka disabled, event not published');
      return { skipped: true };
    }
    if (!this.isConnected) {
      await this.connect();
    }
    
    const message = {
      key: event.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      value: JSON.stringify({
        ...event,
        timestamp: event.timestamp || new Date().toISOString(),
        source: this.clientId,
      }),
      headers: options.headers || {},
    };

    try {
      const result = await this.producer.send({
        topic,
        messages: [message],
        ack: options.ack || -1, // Wait for all replicas
      });
      
      this.metrics.eventsPublished++;
      
      logger.info({
        topic,
        eventId: event.id,
        partition: result[0].partition,
        offset: result[0].baseOffset,
      }, 'Event published successfully');
      
      return result;
    } catch (err) {
      logger.error({ err, topic, eventId: event.id }, 'Failed to publish event');
      throw err;
    }
  }

  /**
   * Subscribe to a topic with a handler
   * @param {string} topic - Topic name
   * @param {function} handler - Event handler function
   * @param {object} options - Subscription options
   */
  async subscribe(topic, handler, options = {}) {
    if (this.disabled) {
      logger.info({ topic }, 'Kafka disabled, subscription skipped');
      return null;
    }
    const groupId = options.groupId || `${this.clientId}-${topic}`;
    
    const consumer = this.kafka.consumer({
      groupId,
      fromBeginning: options.fromBeginning || false,
      maxWaitTimeInMs: 5000,
      sessionTimeout: 30000,
      heartbeatInterval: 3000,
    });

    try {
      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: options.fromBeginning || false });
      
      const maxRetries = options.maxRetries || 3;
      const retryDelay = options.retryDelay || 1000;

      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const startTime = Date.now();
          
          try {
            const event = JSON.parse(message.value.toString());
            
            logger.debug({
              topic,
              partition,
              offset: message.offset,
              eventId: event.id,
            }, 'Processing event');
            
            // Execute handler with retry
            let lastError;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
              try {
                await handler(event, { topic, partition, offset: message.offset });
                this.metrics.eventsProcessed++;
                
                const duration = Date.now() - startTime;
                logger.info({
                  topic,
                  eventId: event.id,
                  attempt,
                  duration,
                }, 'Event processed successfully');
                
                return; // Success
              } catch (err) {
                lastError = err;
                logger.warn({
                  err,
                  topic,
                  eventId: event.id,
                  attempt,
                  maxRetries,
                }, 'Event handler failed, retrying');
                
                if (attempt < maxRetries) {
                  await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                }
              }
            }
            
            // All retries failed - send to DLQ
            this.metrics.eventsFailed++;
            await this.sendToDLQ(topic, event, lastError, maxRetries);
            
          } catch (err) {
            logger.error({ err, topic, offset: message.offset }, 'Failed to process message');
            this.metrics.eventsFailed++;
          }
        },
      });

      this.consumers.set(topic, consumer);
      logger.info({ topic, groupId }, 'Subscribed to topic');
      
    } catch (err) {
      logger.error({ err, topic, groupId }, 'Failed to subscribe to topic');
      throw err;
    }
  }

  /**
   * Send event to Dead Letter Queue
   */
  async sendToDLQ(originalTopic, event, error, attempts) {
    const dlqTopic = `${originalTopic}-dlq`;
    
    try {
      await this.publish(dlqTopic, {
        id: `dlq-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        originalEvent: event,
        originalTopic,
        error: {
          message: error.message,
          stack: error.stack,
        },
        attempts,
        failedAt: new Date().toISOString(),
      });
      
      this.metrics.dlqMessages++;
      logger.error({ originalTopic, dlqTopic, eventId: event.id }, 'Event sent to DLQ');
    } catch (err) {
      logger.error({ err, originalTopic }, 'Failed to send event to DLQ');
    }
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      connected: this.isConnected,
      consumers: this.consumers.size,
    };
  }

  /**
   * Disconnect from Kafka
   */
  async disconnect() {
    try {
      if (this.producer) {
        await this.producer.disconnect();
      }
      
      for (const [topic, consumer] of this.consumers) {
        await consumer.disconnect();
        logger.info({ topic }, 'Consumer disconnected');
      }
      
      this.isConnected = false;
      logger.info('EventBus disconnected from Kafka');
    } catch (err) {
      logger.error({ err }, 'Error during disconnect');
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    if (this.disabled) {
      return { status: 'disabled', healthy: true };
    }
    if (!this.isConnected) {
      return { status: 'disconnected', healthy: false };
    }
    
    try {
      // Try to get metadata to verify connection
      const admin = this.kafka.admin();
      await admin.connect();
      const topics = await admin.listTopics();
      await admin.disconnect();
      
      return {
        status: 'connected',
        healthy: true,
        topicsCount: topics.length,
        metrics: this.getMetrics(),
      };
    } catch (err) {
      return {
        status: 'error',
        healthy: false,
        error: err.message,
      };
    }
  }
}

// Singleton instance
let eventBusInstance = null;

/**
 * Get or create EventBus instance
 */
function getEventBus(config) {
  if (!eventBusInstance) {
    eventBusInstance = new EventBus(config);
  }
  return eventBusInstance;
}

// 业务事件类型（活动、排行榜、合规等服务通过 publishEvent 发布；原先这些服务 import 了不存在的导出，调用即抛错）
const EVENTS = Object.freeze({
  EVENT_CREATED: 'event.created',
  EVENT_ACTIVATED: 'event.activated',
  EVENT_DEACTIVATED: 'event.deactivated',
  EVENT_JOINED: 'event.joined',
  EVENT_PAUSED: 'event.paused',
  EVENT_RESUMED: 'event.resumed',
  EVENT_CANCELLED: 'event.cancelled',
  SPAWN_BOOST_ACTIVATED: 'event.spawn_boost_activated',
  REWARD_GRANT: 'reward.granted',
  LEADERBOARD_UPDATED: 'leaderboard.updated',
  DATA_TRANSFER_REQUESTED: 'compliance.data_transfer_requested',
});

/**
 * 发布业务事件（尽力而为）：事件总线不可用时只记日志，绝不让业务请求失败
 * @param {string} type    事件类型（EVENTS.*，也接受任意字符串）
 * @param {object} payload 事件内容
 * @param {object} [options]
 * @param {string} [options.topic='game.events']
 */
async function publishEvent(type, payload = {}, { topic = 'game.events' } = {}) {
  try {
    const bus = getEventBus({ clientId: process.env.SERVICE_NAME || 'minego' });
    return await bus.publish(topic, {
      type,
      ...payload,
      timestamp: payload.timestamp || new Date().toISOString(),
    });
  } catch (err) {
    logger.warn({ type, topic, err: err.message }, 'publishEvent failed (ignored)');
    return { error: err.message };
  }
}

module.exports = {
  EventBus,
  getEventBus,
  isKafkaEnabled,
  EVENTS,
  publishEvent,
};
