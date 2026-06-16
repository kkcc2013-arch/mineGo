const IEventBusAdapter = require('./IEventBusAdapter');
const { EventEmitter } = require('events');
const logger = require('../logger');

/**
 * 内存适配器
 * 用于开发、测试环境，基于内存队列实现
 * 支持异步消息投递、重试和错误处理
 */
class MemoryAdapter extends IEventBusAdapter {
  constructor(config = {}) {
    super(config);
    
    this.emitter = new EventEmitter();
    this.queues = new Map(); // topic -> Array<event>
    this.subscriptions = new Map(); // topic -> { handler, options }
    this.maxQueueSize = config.maxQueueSize || 10000;
    this.deliveryDelay = config.deliveryDelay || 0; // 模拟网络延迟
    this.retryAttempts = config.retryAttempts || 3;
    this.retryDelay = config.retryDelay || 100;
  }

  async connect() {
    if (this.isConnected) {
      logger.warn('[MemoryAdapter] Already connected');
      return;
    }

    this.isConnected = true;
    logger.info('[MemoryAdapter] Connected (in-memory mode)');
  }

  async disconnect() {
    if (!this.isConnected) {
      return;
    }

    // 清空所有队列和订阅
    this.queues.clear();
    this.subscriptions.clear();
    this.emitter.removeAllListeners();
    
    this.isConnected = false;
    logger.info('[MemoryAdapter] Disconnected');
  }

  async publish(topic, event, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      // 确保队列存在
      if (!this.queues.has(topic)) {
        this.queues.set(topic, []);
      }

      const queue = this.queues.get(topic);
      
      // 检查队列大小
      if (queue.length >= this.maxQueueSize) {
        throw new Error(`Queue ${topic} is full (max: ${this.maxQueueSize})`);
      }

      const message = {
        id: `${topic}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        event,
        timestamp: Date.now(),
        attempts: 0,
        options
      };

      queue.push(message);
      this.updateMetric('published');

      // 异步投递消息（模拟真实消息系统）
      if (this.deliveryDelay > 0) {
        setTimeout(() => this._deliverMessage(topic, message), this.deliveryDelay);
      } else {
        setImmediate(() => this._deliverMessage(topic, message));
      }

      logger.debug(`[MemoryAdapter] Published event to ${topic}:`, event.eventType || 'unknown');
    } catch (error) {
      logger.error(`[MemoryAdapter] Publish error to ${topic}:`, error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async subscribe(topic, handler, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      // 如果已有订阅，先取消
      if (this.subscriptions.has(topic)) {
        await this.unsubscribe(topic);
      }

      this.subscriptions.set(topic, { handler, options });
      
      // 订阅队列事件
      this.emitter.on(`message:${topic}`, async (message) => {
        const subscription = this.subscriptions.get(topic);
        if (subscription) {
          await this._handleMessage(topic, message, subscription);
        }
      });

      logger.info(`[MemoryAdapter] Subscribed to topic: ${topic}`);
    } catch (error) {
      logger.error(`[MemoryAdapter] Subscribe error for ${topic}:`, error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async unsubscribe(topic) {
    if (this.subscriptions.has(topic)) {
      this.subscriptions.delete(topic);
      this.emitter.removeAllListeners(`message:${topic}`);
      logger.info(`[MemoryAdapter] Unsubscribed from topic: ${topic}`);
    }
  }

  async healthCheck() {
    return {
      healthy: this.isConnected,
      mode: 'memory',
      queues: Array.from(this.queues.keys()).map(topic => ({
        topic,
        size: this.queues.get(topic).length
      })),
      subscriptions: Array.from(this.subscriptions.keys()),
      ...this.getMetrics()
    };
  }

  /**
   * 投递消息到订阅者
   */
  async _deliverMessage(topic, message) {
    const subscription = this.subscriptions.get(topic);
    if (!subscription) {
      // 没有订阅者，消息保留在队列
      logger.debug(`[MemoryAdapter] No subscriber for ${topic}, message queued`);
      return;
    }

    this.emitter.emit(`message:${topic}`, message);
  }

  /**
   * 处理消息（带重试）
   */
  async _handleMessage(topic, message, subscription) {
    const { handler, options } = subscription;
    const maxAttempts = options.retryAttempts || this.retryAttempts;

    try {
      const context = {
        topic,
        messageId: message.id,
        timestamp: message.timestamp,
        attempts: message.attempts
      };

      await handler(message.event, context);
      this.updateMetric('consumed');

      // 从队列移除成功处理的消息
      const queue = this.queues.get(topic);
      if (queue) {
        const index = queue.findIndex(m => m.id === message.id);
        if (index > -1) {
          queue.splice(index, 1);
        }
      }
    } catch (error) {
      logger.error(`[MemoryAdapter] Handler error for ${topic}:`, error);
      this.updateMetric('errors');

      message.attempts++;

      // 重试逻辑
      if (message.attempts < maxAttempts) {
        this.updateMetric('retries');
        logger.warn(`[MemoryAdapter] Retrying message ${message.id} (attempt ${message.attempts}/${maxAttempts})`);
        
        setTimeout(() => {
          this._deliverMessage(topic, message);
        }, this.retryDelay * message.attempts);
      } else {
        logger.error(`[MemoryAdapter] Message ${message.id} failed after ${maxAttempts} attempts`);
        
        // 从队列移除失败消息
        const queue = this.queues.get(topic);
        if (queue) {
          const index = queue.findIndex(m => m.id === message.id);
          if (index > -1) {
            queue.splice(index, 1);
          }
        }
      }
    }
  }

  /**
   * 获取队列中的消息数量
   */
  getQueueSize(topic) {
    const queue = this.queues.get(topic);
    return queue ? queue.length : 0;
  }

  /**
   * 清空队列
   */
  clearQueue(topic) {
    if (topic) {
      this.queues.delete(topic);
    } else {
      this.queues.clear();
    }
  }
}

module.exports = MemoryAdapter;
