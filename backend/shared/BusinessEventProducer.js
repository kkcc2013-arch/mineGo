/**
 * backend/shared/BusinessEventProducer.js
 * 业务事件生产者 SDK
 * 
 * @module BusinessEventProducer
 * @description 统一的业务事件发送接口，集成到各微服务
 */

const { Kafka } = require('kafkajs');
const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('./logger');
const { getEventCategory, isValidEventType } = require('./businessEvents');
const { businessEventsTotal } = require('./metrics');

const logger = createLogger('business-event-producer');

class BusinessEventProducer {
  constructor(options = {}) {
    this.kafka = new Kafka({
      brokers: options.brokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
      clientId: options.clientId || `minego-${process.env.SERVICE_NAME || 'unknown'}`
    });
    
    this.producer = this.kafka.producer({
      maxInFlightRequests: 5,
      idempotent: true,
      transactionTimeout: 30000
    });
    
    this.connected = false;
    this.topic = options.topic || 'business-events';
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelay = options.retryDelay || 1000;
    
    // 批量发送配置
    this.batchQueue = [];
    this.batchSize = options.batchSize || 100;
    this.batchTimeout = options.batchTimeout || 5000;
    this.batchTimer = null;
  }
  
  /**
   * 连接 Kafka
   */
  async connect() {
    if (this.connected) return;
    
    try {
      await this.producer.connect();
      this.connected = true;
      logger.info('Business event producer connected to Kafka');
      
      // 启动批量发送定时器
      this._startBatchTimer();
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Kafka');
      throw err;
    }
  }
  
  /**
   * 断开连接
   */
  async disconnect() {
    if (!this.connected) return;
    
    try {
      // 发送剩余批量事件
      if (this.batchQueue.length > 0) {
        await this._flushBatch();
      }
      
      // 停止定时器
      if (this.batchTimer) {
        clearInterval(this.batchTimer);
        this.batchTimer = null;
      }
      
      await this.producer.disconnect();
      this.connected = false;
      logger.info('Business event producer disconnected');
    } catch (err) {
      logger.error({ err }, 'Failed to disconnect from Kafka');
    }
  }
  
  /**
   * 发送业务事件
   * @param {string} eventType - 事件类型（如 'catch.success'）
   * @param {Object} payload - 事件数据
   * @param {Object} context - 上下文信息
   * @returns {Promise<string>} 事件 ID
   */
  async emit(eventType, payload, context = {}) {
    // 验证事件类型
    if (!isValidEventType(eventType)) {
      logger.warn({ eventType }, 'Invalid event type, will still send');
    }
    
    const event = {
      id: uuidv4(),
      type: eventType,
      category: getEventCategory(eventType),
      timestamp: new Date().toISOString(),
      version: '1.0',
      payload: payload || {},
      context: {
        userId: context.userId || null,
        deviceId: context.deviceId || null,
        ip: context.ip || null,
        location: context.location || null, // { lat, lng, city, country }
        appVersion: context.appVersion || null,
        platform: context.platform || null, // ios/android/web
        traceId: context.traceId || null,
        spanId: context.spanId || null,
        service: process.env.SERVICE_NAME || 'unknown',
        environment: process.env.NODE_ENV || 'development',
        ...context
      }
    };
    
    // 添加到批量队列
    this.batchQueue.push(event);
    
    // 达到批量大小或立即发送
    if (this.batchQueue.length >= this.batchSize || context.immediate) {
      await this._flushBatch();
    }
    
    // Prometheus 指标
    if (businessEventsTotal) {
      businessEventsTotal.inc({ type: eventType, category: event.category });
    }
    
    logger.debug({ eventType, eventId: event.id }, 'Business event queued');
    
    return event.id;
  }
  
  /**
   * 发送事件（立即发送，不等待批量）
   * @param {string} eventType - 事件类型
   * @param {Object} payload - 事件数据
   * @param {Object} context - 上下文信息
   * @returns {Promise<string>} 事件 ID
   */
  async emitImmediate(eventType, payload, context = {}) {
    return this.emit(eventType, payload, { ...context, immediate: true });
  }
  
  /**
   * 批量发送事件
   * @param {Array<{eventType: string, payload: Object, context: Object}>} events - 事件列表
   */
  async emitBatch(events) {
    for (const event of events) {
      await this.emit(event.eventType, event.payload, event.context);
    }
  }
  
  /**
   * 刷新批量队列
   */
  async _flushBatch() {
    if (this.batchQueue.length === 0) return;
    
    const events = this.batchQueue.splice(0, this.batchQueue.length);
    
    try {
      const messages = events.map(event => ({
        key: event.context.userId || event.id,
        value: JSON.stringify(event),
        headers: {
          'event-type': event.type,
          'event-category': event.category,
          'event-id': event.id,
          'trace-id': event.context.traceId || ''
        }
      }));
      
      await this._sendWithRetry(messages);
      
      logger.debug({ count: events.length }, 'Batch events sent');
    } catch (err) {
      logger.error({ err, count: events.length }, 'Failed to send batch events');
      // 放回队列重试
      this.batchQueue.unshift(...events);
    }
  }
  
  /**
   * 带重试的发送
   */
  async _sendWithRetry(messages) {
    let lastError;
    
    for (let i = 0; i < this.retryAttempts; i++) {
      try {
        await this.producer.send({
          topic: this.topic,
          messages
        });
        return;
      } catch (err) {
        lastError = err;
        logger.warn({ err, attempt: i + 1 }, 'Send failed, retrying...');
        await new Promise(resolve => setTimeout(resolve, this.retryDelay * (i + 1)));
      }
    }
    
    throw lastError;
  }
  
  /**
   * 启动批量发送定时器
   */
  _startBatchTimer() {
    this.batchTimer = setInterval(async () => {
      if (this.batchQueue.length > 0) {
        await this._flushBatch();
      }
    }, this.batchTimeout);
  }
}

// 单例模式
let instance = null;

/**
 * 获取单例实例
 * @param {Object} options - 配置选项
 * @returns {BusinessEventProducer}
 */
function getBusinessEventProducer(options = {}) {
  if (!instance) {
    instance = new BusinessEventProducer(options);
  }
  return instance;
}

module.exports = {
  BusinessEventProducer,
  getBusinessEventProducer
};
