const IEventBusAdapter = require('./IEventBusAdapter');
const Redis = require('ioredis');
const logger = require('../logger');

/**
 * Redis Streams 适配器
 * 基于 Redis Streams 实现消息队列，适用于轻量级部署场景
 * 支持消费者组、消息确认、持久化
 */
class RedisStreamAdapter extends IEventBusAdapter {
  constructor(config = {}) {
    super(config);
    
    this.redisUrl = config.url || process.env.REDIS_URL || 'redis://localhost:6379';
    this.prefix = config.prefix || 'eventbus:';
    this.maxLen = config.maxLen || 10000; // 每个流的最大长度
    this.blockTime = config.blockTime || 5000; // XREADGROUP 阻塞时间（毫秒）
    this.batchSize = config.batchSize || 10; // 每次读取的消息数
    
    this.redis = null;
    this.consumerGroups = new Map(); // topic -> { groupName, consumerName }
    this.subscriptions = new Map(); // topic -> { handler, options, running }
    this.running = false;
  }

  async connect() {
    if (this.isConnected) {
      logger.warn('[RedisStreamAdapter] Already connected');
      return;
    }

    try {
      this.redis = new Redis(this.redisUrl, {
        maxRetriesPerRequest: 3,
        retryDelayOnFailover: 100,
        enableReadyCheck: true
      });

      this.redis.on('error', (err) => {
        logger.error('[RedisStreamAdapter] Redis error:', err);
        this.updateMetric('errors');
      });

      this.redis.on('connect', () => {
        logger.info('[RedisStreamAdapter] Redis connected');
      });

      await this.redis.ping();
      this.isConnected = true;
      logger.info(`[RedisStreamAdapter] Connected to Redis: ${this.redisUrl}`);
    } catch (error) {
      logger.error('[RedisStreamAdapter] Connection failed:', error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async disconnect() {
    if (!this.isConnected) {
      return;
    }

    try {
      this.running = false;
      
      // 等待所有消费者停止
      for (const [topic, sub] of this.subscriptions) {
        sub.running = false;
      }

      // 关闭 Redis 连接
      if (this.redis) {
        await this.redis.quit();
      }

      this.consumerGroups.clear();
      this.subscriptions.clear();
      this.isConnected = false;
      
      logger.info('[RedisStreamAdapter] Disconnected from Redis');
    } catch (error) {
      logger.error('[RedisStreamAdapter] Disconnect error:', error);
      throw error;
    }
  }

  async publish(topic, event, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      const streamKey = this._getStreamKey(topic);
      
      // 添加消息到流
      const fields = {
        event: JSON.stringify(event),
        timestamp: Date.now().toString(),
        type: event.eventType || 'unknown'
      };

      if (options.key) {
        fields.key = options.key;
      }

      const messageId = await this.redis.xadd(
        streamKey,
        'MAXLEN', '~', this.maxLen, // 限制流长度
        '*', // 自动生成 ID
        ...Object.entries(fields).flat()
      );

      this.updateMetric('published');
      logger.debug(`[RedisStreamAdapter] Published event to ${topic}: ${messageId}`);
      
      return messageId;
    } catch (error) {
      logger.error(`[RedisStreamAdapter] Publish error to ${topic}:`, error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async subscribe(topic, handler, options = {}) {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      const streamKey = this._getStreamKey(topic);
      const groupName = options.groupId || `${this.prefix}default-group`;
      const consumerName = options.consumerId || `${process.env.SERVICE_NAME || 'consumer'}-${process.pid}`;

      // 创建消费者组（如果不存在）
      try {
        await this.redis.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
        logger.info(`[RedisStreamAdapter] Created consumer group: ${groupName}`);
      } catch (err) {
        if (!err.message.includes('BUSYGROUP')) {
          throw err;
        }
      }

      this.consumerGroups.set(topic, { groupName, consumerName });
      this.subscriptions.set(topic, { handler, options, running: true });

      // 启动消费者
      this._startConsumer(topic);

      logger.info(`[RedisStreamAdapter] Subscribed to topic: ${topic} (group: ${groupName})`);
    } catch (error) {
      logger.error(`[RedisStreamAdapter] Subscribe error for ${topic}:`, error);
      this.updateMetric('errors');
      throw error;
    }
  }

  async unsubscribe(topic) {
    const subscription = this.subscriptions.get(topic);
    if (subscription) {
      subscription.running = false;
      this.subscriptions.delete(topic);
      
      // 可选：删除消费者
      const consumerGroup = this.consumerGroups.get(topic);
      if (consumerGroup) {
        const streamKey = this._getStreamKey(topic);
        try {
          await this.redis.xgroup('DELCONSUMER', streamKey, consumerGroup.groupName, consumerGroup.consumerName);
        } catch (err) {
          logger.warn(`[RedisStreamAdapter] Failed to delete consumer:`, err.message);
        }
        this.consumerGroups.delete(topic);
      }

      logger.info(`[RedisStreamAdapter] Unsubscribed from topic: ${topic}`);
    }
  }

  async healthCheck() {
    try {
      if (!this.isConnected) {
        return { healthy: false, reason: 'Not connected' };
      }

      const ping = await this.redis.ping();
      
      // 获取所有流的信息
      const streamInfos = [];
      for (const [topic] of this.subscriptions) {
        const streamKey = this._getStreamKey(topic);
        const info = await this.redis.xinfo('STREAM', streamKey).catch(() => null);
        if (info) {
          streamInfos.push({
            topic,
            length: info[1], // length
            groups: info[3]  // groups
          });
        }
      }

      return {
        healthy: ping === 'PONG',
        mode: 'redis-streams',
        streams: streamInfos,
        subscriptions: Array.from(this.subscriptions.keys()),
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
   * 启动消费者循环
   */
  async _startConsumer(topic) {
    const subscription = this.subscriptions.get(topic);
    const consumerGroup = this.consumerGroups.get(topic);
    
    if (!subscription || !consumerGroup) return;

    const { handler, options, running } = subscription;
    const { groupName, consumerName } = consumerGroup;
    const streamKey = this._getStreamKey(topic);

    const consume = async () => {
      while (subscription.running && this.isConnected) {
        try {
          // 读取新消息
          const messages = await this.redis.xreadgroup(
            'GROUP', groupName, consumerName,
            'COUNT', this.batchSize,
            'BLOCK', this.blockTime,
            'STREAMS', streamKey,
            '>' // 只读取未投递的消息
          );

          if (messages && messages.length > 0) {
            for (const [stream, streamMessages] of messages) {
              for (const [messageId, fields] of streamMessages) {
                await this._handleMessage(topic, messageId, fields, handler, groupName, streamKey);
              }
            }
          }

          // 处理待处理消息（未确认的消息）
          await this._processPendingMessages(topic, handler, groupName, consumerName, streamKey);
        } catch (error) {
          logger.error(`[RedisStreamAdapter] Consumer error for ${topic}:`, error);
          this.updateMetric('errors');
          
          // 短暂延迟后重试
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    };

    consume();
  }

  /**
   * 处理单条消息
   */
  async _handleMessage(topic, messageId, fields, handler, groupName, streamKey) {
    try {
      const eventStr = fields.find((_, i) => i % 2 === 0 && fields[i + 1] === 'event');
      const eventIndex = fields.indexOf('event');
      const event = eventIndex > -1 ? JSON.parse(fields[eventIndex + 1]) : {};

      const context = {
        topic,
        messageId,
        timestamp: parseInt(fields[fields.indexOf('timestamp') + 1]) || Date.now()
      };

      await handler(event, context);
      this.updateMetric('consumed');

      // 确认消息
      await this.redis.xack(streamKey, groupName, messageId);
    } catch (error) {
      logger.error(`[RedisStreamAdapter] Handler error for ${topic}:`, error);
      this.updateMetric('errors');
      // 不确认消息，让它留在待处理列表中
    }
  }

  /**
   * 处理待处理消息（死信或超时）
   */
  async _processPendingMessages(topic, handler, groupName, consumerName, streamKey) {
    try {
      // 读取待处理消息
      const pending = await this.redis.xpending(
        streamKey,
        groupName,
        '-', '+',
        10
      );

      if (!pending || pending.length === 0) return;

      for (const [messageId, owner, idleTime, deliveries] of pending) {
        // 如果消息闲置超过 60 秒，且投递次数 < 5，重新投递
        if (idleTime > 60000 && deliveries < 5) {
          this.updateMetric('retries');
          
          // 认领消息
          await this.redis.xclaim(
            streamKey,
            groupName,
            consumerName,
            60000,
            messageId
          );

          logger.warn(`[RedisStreamAdapter] Claimed pending message: ${messageId}`);
        } else if (deliveries >= 5) {
          // 投递次数过多，视为死信，确认并跳过
          await this.redis.xack(streamKey, groupName, messageId);
          logger.error(`[RedisStreamAdapter] Dead letter: ${messageId}`);
        }
      }
    } catch (error) {
      logger.error(`[RedisStreamAdapter] Process pending error:`, error);
    }
  }

  /**
   * 获取流的 Redis Key
   */
  _getStreamKey(topic) {
    return `${this.prefix}${topic}`;
  }

  /**
   * 清空流
   */
  async clearStream(topic) {
    const streamKey = this._getStreamKey(topic);
    await this.redis.del(streamKey);
    logger.info(`[RedisStreamAdapter] Cleared stream: ${topic}`);
  }
}

module.exports = RedisStreamAdapter;
