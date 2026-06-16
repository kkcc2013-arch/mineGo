// backend/shared/EventBus.js - Adapter-based implementation
'use strict';

const { createLogger } = require('./logger');
const KafkaAdapter = require('./adapters/KafkaAdapter');
const MemoryAdapter = require('./adapters/MemoryAdapter');
const RedisStreamAdapter = require('./adapters/RedisStreamAdapter');

const logger = createLogger('event-bus');

/**
 * EventBus - 事件总线（适配器模式）
 * 
 * Features:
 * - 支持多种消息系统：Kafka、Memory、Redis Streams
 * - 通过配置动态切换适配器
 * - 保持向后兼容的 API
 * - 自动重试机制
 * - Prometheus 指标
 * - 优雅关闭
 */
class EventBus {
  constructor(adapter, config = {}) {
    this.adapter = adapter;
    this.config = config;
    this.isConnected = false;
    
    // Metrics
    this.metrics = {
      eventsPublished: 0,
      eventsProcessed: 0,
      eventsFailed: 0,
      dlqMessages: 0,
    };
    
    // 订阅记录（用于向后兼容）
    this.subscriptions = new Map();
  }

  /**
   * 连接到消息系统
   */
  async connect() {
    if (this.isConnected) {
      logger.warn('[EventBus] Already connected');
      return this;
    }

    try {
      await this.adapter.connect();
      this.isConnected = true;
      
      const adapterType = this.adapter.constructor.name;
      logger.info(`[EventBus] Connected using ${adapterType}`);
      
      return this;
    } catch (error) {
      logger.error('[EventBus] Connection failed:', error);
      throw error;
    }
  }

  /**
   * 断开连接
   */
  async disconnect() {
    if (!this.isConnected) {
      return;
    }

    try {
      await this.adapter.disconnect();
      this.isConnected = false;
      logger.info('[EventBus] Disconnected');
    } catch (error) {
      logger.error('[EventBus] Disconnect error:', error);
      throw error;
    }
  }

  /**
   * 发布事件
   * @param {string} topic - 主题名称
   * @param {Object} event - 事件对象
   * @param {Object} options - 发布选项
   */
  async publish(topic, event, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      // 确保事件格式正确
      const formattedEvent = {
        ...event,
        timestamp: event.timestamp || Date.now(),
        source: event.source || this.config.clientId || 'unknown',
        eventId: event.eventId || `${topic}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };

      await this.adapter.publish(topic, formattedEvent, options);
      
      this.metrics.eventsPublished++;
      logger.debug(`[EventBus] Published event to ${topic}:`, event.eventType || 'unknown');
      
      return formattedEvent.eventId;
    } catch (error) {
      logger.error(`[EventBus] Publish error to ${topic}:`, error);
      this.metrics.eventsFailed++;
      throw error;
    }
  }

  /**
   * 订阅主题
   * @param {string} topic - 主题名称
   * @param {Function} handler - 事件处理函数
   * @param {Object} options - 订阅选项
   */
  async subscribe(topic, handler, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      // 包装处理器以添加额外功能（重试、DLQ、metrics）
      const wrappedHandler = async (event, context) => {
        try {
          await handler(event, context);
          this.metrics.eventsProcessed++;
        } catch (error) {
          logger.error(`[EventBus] Handler error for ${topic}:`, error);
          this.metrics.eventsFailed++;
          
          // 重试逻辑
          const maxRetries = options.maxRetries || 3;
          const retryAttempts = context.retryAttempts || 0;
          
          if (retryAttempts < maxRetries) {
            logger.warn(`[EventBus] Retrying event (attempt ${retryAttempts + 1}/${maxRetries})`);
            
            // 重试由适配器处理，这里只传递错误
            throw error;
          } else {
            // 发送到 DLQ
            if (this.config.enableDLQ !== false) {
              await this._sendToDLQ(topic, event, error, context);
            }
            throw error;
          }
        }
      };

      await this.adapter.subscribe(topic, wrappedHandler, options);
      
      this.subscriptions.set(topic, { handler, options, wrappedHandler });
      
      logger.info(`[EventBus] Subscribed to topic: ${topic}`);
      return this;
    } catch (error) {
      logger.error(`[EventBus] Subscribe error for ${topic}:`, error);
      throw error;
    }
  }

  /**
   * 取消订阅
   */
  async unsubscribe(topic) {
    try {
      await this.adapter.unsubscribe(topic);
      this.subscriptions.delete(topic);
      logger.info(`[EventBus] Unsubscribed from topic: ${topic}`);
    } catch (error) {
      logger.error(`[EventBus] Unsubscribe error for ${topic}:`, error);
      throw error;
    }
  }

  /**
   * 发送到死信队列
   */
  async _sendToDLQ(topic, event, error, context) {
    const dlqTopic = `${topic}-dlq`;
    
    const dlqEvent = {
      ...event,
      originalTopic: topic,
      error: {
        message: error.message,
        stack: error.stack,
        timestamp: Date.now()
      },
      context: {
        messageId: context.messageId,
        timestamp: context.timestamp,
        retryAttempts: context.retryAttempts || 0
      }
    };

    try {
      await this.adapter.publish(dlqTopic, dlqEvent, { key: event.eventId });
      this.metrics.dlqMessages++;
      logger.warn(`[EventBus] Sent event to DLQ: ${dlqTopic}`);
    } catch (dlqError) {
      logger.error(`[EventBus] DLQ publish error:`, dlqError);
    }
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const adapterHealth = await this.adapter.healthCheck();
    
    return {
      healthy: this.isConnected && adapterHealth.healthy,
      connected: this.isConnected,
      adapter: this.adapter.constructor.name,
      subscriptions: Array.from(this.subscriptions.keys()),
      metrics: this.metrics,
      adapterMetrics: adapterHealth
    };
  }

  /**
   * 获取指标
   */
  getMetrics() {
    const adapterMetrics = this.adapter.getMetrics();
    
    return {
      ...this.metrics,
      ...adapterMetrics,
      connected: this.isConnected,
      adapter: this.adapter.constructor.name
    };
  }

  /**
   * Prometheus 指标格式
   */
  getPrometheusMetrics() {
    const m = this.metrics;
    return `
# HELP eventbus_published_total Total events published
# TYPE eventbus_published_total counter
eventbus_published_total ${m.eventsPublished}

# HELP eventbus_processed_total Total events processed successfully
# TYPE eventbus_processed_total counter
eventbus_processed_total ${m.eventsProcessed}

# HELP eventbus_failed_total Total events failed
# TYPE eventbus_failed_total counter
eventbus_failed_total ${m.eventsFailed}

# HELP eventbus_dlq_total Total events sent to DLQ
# TYPE eventbus_dlq_total counter
eventbus_dlq_total ${m.dlqMessages}
`;
  }

  /**
   * 等待所有消息处理完成
   */
  async flush() {
    // 内存适配器：等待队列清空
    if (this.adapter.constructor.name === 'MemoryAdapter') {
      const queues = this.adapter.queues;
      for (const [topic, queue] of queues) {
        while (queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    
    // Kafka/Redis：等待所有消息确认
    // 由适配器内部处理
  }
}

/**
 * 创建 EventBus 实例（工厂方法）
 * @param {Object} config - 配置对象
 * @returns {EventBus}
 */
function createEventBus(config = {}) {
  const adapterType = config.adapter || process.env.EVENT_BUS_ADAPTER || 'kafka';
  
  const adapters = {
    kafka: () => new KafkaAdapter(config),
    memory: () => new MemoryAdapter(config),
    redis: () => new RedisStreamAdapter(config),
  };
  
  if (!adapters[adapterType]) {
    throw new Error(`Unknown adapter type: ${adapterType}. Supported: kafka, memory, redis`);
  }
  
  const adapter = adapters[adapterType]();
  const eventBus = new EventBus(adapter, config);
  
  logger.info(`[EventBus] Creating EventBus with ${adapterType} adapter`);
  
  return eventBus;
}

// 向后兼容：导出类和工厂方法
module.exports = {
  EventBus,
  createEventBus,
  KafkaAdapter,
  MemoryAdapter,
  RedisStreamAdapter
};

// 默认导出（向后兼容）
module.exports.default = createEventBus;