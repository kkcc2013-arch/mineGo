const IEventBusAdapter = require('./IEventBusAdapter');
const { Kafka } = require('kafkajs');
const logger = require('../logger');

/**
 * Kafka 适配器
 * 封装 kafkajs，提供与 EventBus 一致的功能
 */
class KafkaAdapter extends IEventBusAdapter {
  constructor(config = {}) {
    super(config);
    
    this.brokers = config.brokers || (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
    this.clientId = config.clientId || process.env.SERVICE_NAME || 'mineGo-service';
    this.sasl = config.sasl || null;
    this.ssl = config.ssl || false;
    
    this.kafka = null;
    this.producer = null;
    this.consumers = new Map(); // topic -> consumer
    this.subscriptions = new Map(); // topic -> { handler, options }
  }

  async connect() {
    if (this.isConnected) {
      logger.warn('[KafkaAdapter] Already connected');
      return;
    }

    try {
      this.kafka = new Kafka({
        clientId: this.clientId,
        brokers: this.brokers,
        sasl: this.sasl,
        ssl: this.ssl,
        retry: {
          initialRetryTime: 100,
          retries: 8,
          maxRetryTime: 30000,
          multiplier: 2,
          factor: 0.2
        }
      });

      this.producer = this.kafka.producer({
        maxInFlightRequests: 1,
        idempotent: true,
        transactionalId: `${this.clientId}-producer`,
        transactionTimeout: 30000
      });

      await this.producer.connect();
      this.isConnected = true;
      logger.info(`[KafkaAdapter] Connected to Kafka: ${this.brokers.join(', ')}`);
    } catch (error) {
      logger.error('[KafkaAdapter] Connection failed:', error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async disconnect() {
    if (!this.isConnected) {
      return;
    }

    try {
      // 断开所有消费者
      for (const [topic, consumer] of this.consumers) {
        await consumer.disconnect();
        logger.info(`[KafkaAdapter] Disconnected consumer for topic: ${topic}`);
      }
      this.consumers.clear();
      this.subscriptions.clear();

      // 断开生产者
      if (this.producer) {
        await this.producer.disconnect();
      }

      this.isConnected = false;
      logger.info('[KafkaAdapter] Disconnected from Kafka');
    } catch (error) {
      logger.error('[KafkaAdapter] Disconnect error:', error);
      throw error;
    }
  }

  async publish(topic, event, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      const message = {
        key: options.key || `${topic}-${Date.now()}`,
        value: JSON.stringify(event),
        headers: options.headers || {},
        partition: options.partition,
        timestamp: Date.now().toString()
      };

      await this.producer.send({
        topic,
        messages: [message],
        ack: options.ack || 1 // 0=无确认, 1=leader确认, -1=所有副本确认
      });

      this.updateMetric('published');
      logger.debug(`[KafkaAdapter] Published event to ${topic}:`, event.eventType || 'unknown');
    } catch (error) {
      logger.error(`[KafkaAdapter] Publish error to ${topic}:`, error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async subscribe(topic, handler, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    const groupId = options.groupId || `${this.clientId}-consumer`;

    try {
      // 如果已有订阅，先取消
      if (this.consumers.has(topic)) {
        await this.unsubscribe(topic);
      }

      const consumer = this.kafka.consumer({
        groupId,
        fromBeginning: options.fromBeginning || false,
        sessionTimeout: options.sessionTimeout || 30000,
        heartbeatInterval: options.heartbeatInterval || 3000,
        maxBytesPerPartition: options.maxBytesPerPartition || 1048576, // 1MB
        retry: {
          retries: options.retryRetries || 5,
          initialRetryTime: 100,
          maxRetryTime: 30000
        }
      });

      await consumer.connect();
      await consumer.subscribe({ topic, fromBeginning: options.fromBeginning || false });

      await consumer.run({
        autoCommit: options.autoCommit !== false,
        autoCommitInterval: options.autoCommitInterval || 5000,
        autoCommitThreshold: options.autoCommitThreshold || 100,
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const event = JSON.parse(message.value.toString());
            const context = {
              topic,
              partition,
              offset: message.offset,
              key: message.key?.toString(),
              timestamp: parseInt(message.timestamp),
              headers: message.headers
            };

            await handler(event, context);
            this.updateMetric('consumed');
          } catch (error) {
            logger.error(`[KafkaAdapter] Handler error for ${topic}:`, error);
            this.updateMetric('errors');
            
            // 错误处理策略：重试或发送到 DLQ
            if (options.retryOnError !== false) {
              this.updateMetric('retries');
              logger.warn(`[KafkaAdapter] Retrying message from ${topic}`);
              // 由上层 EventBus 处理重试逻辑
              throw error;
            }
          }
        }
      });

      this.consumers.set(topic, consumer);
      this.subscriptions.set(topic, { handler, options, groupId });
      
      logger.info(`[KafkaAdapter] Subscribed to topic: ${topic} (groupId: ${groupId})`);
    } catch (error) {
      logger.error(`[KafkaAdapter] Subscribe error for ${topic}:`, error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async unsubscribe(topic) {
    const consumer = this.consumers.get(topic);
    if (consumer) {
      try {
        await consumer.disconnect();
        this.consumers.delete(topic);
        this.subscriptions.delete(topic);
        logger.info(`[KafkaAdapter] Unsubscribed from topic: ${topic}`);
      } catch (error) {
        logger.error(`[KafkaAdapter] Unsubscribe error for ${topic}:`, error);
        throw error;
      }
    }
  }

  async healthCheck() {
    try {
      if (!this.isConnected) {
        return { healthy: false, reason: 'Not connected' };
      }

      // 尝试获取元数据验证连接
      const admin = this.kafka.admin();
      await admin.connect();
      const metadata = await admin.fetchTopicMetadata();
      await admin.disconnect();

      return {
        healthy: true,
        brokers: this.brokers,
        topics: metadata.topics.map(t => t.name),
        ...this.getMetrics()
      };
    } catch (error) {
      return {
        healthy: false,
        reason: error.message,
        ...this.getMetrics()
      };
    }
  }

  /**
   * 创建主题（如果不存在）
   */
  async createTopic(topic, options = {}) {
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      
      const topicConfigs = [{
        topic,
        numPartitions: options.numPartitions || 3,
        replicationFactor: options.replicationFactor || 1,
        configEntries: options.configEntries || []
      }];

      await admin.createTopics({ topics: topicConfigs });
      logger.info(`[KafkaAdapter] Created topic: ${topic}`);
    } catch (error) {
      if (error.message.includes('already exists')) {
        logger.debug(`[KafkaAdapter] Topic ${topic} already exists`);
      } else {
        logger.error(`[KafkaAdapter] Create topic error:`, error);
        throw error;
      }
    } finally {
      await admin.disconnect();
    }
  }
}

module.exports = KafkaAdapter;
