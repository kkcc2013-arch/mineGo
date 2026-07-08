/**
 * Kafka 输出适配器
 * 输出日志到 Kafka Topic，支持消息分区和批处理
 */
'use strict';

const ILogOutputAdapter = require('./ILogOutputAdapter');
const { Kafka } = require('kafkajs');

class KafkaAdapter extends ILogOutputAdapter {
  constructor() {
    super('kafka');
    this.kafka = null;
    this.producer = null;
    this.connected = false;
    this.batchBuffer = [];
    this.batchTimer = null;
  }

  async initialize(config) {
    await super.initialize(config);
    
    if (!config.brokers || !config.topic) {
      throw new Error('KafkaAdapter requires "brokers" and "topic" configuration');
    }
    
    this.topic = config.topic;
    this.partitionKey = config.partitionKey || 'service';
    this.batchSize = config.batchSize || 100;
    this.batchTimeout = config.batchTimeout || 5000;
    
    this.kafka = new Kafka({
      brokers: config.brokers,
      clientId: config.clientId || `minego-log-${process.env.SERVICE_NAME || 'app'}`,
      retry: {
        retries: config.retry?.maxRetries || 5,
        initialRetryTime: config.retry?.backoffMs || 300,
        multiplier: 2
      },
      connectionTimeout: config.connectionTimeout || 10000,
      requestTimeout: config.requestTimeout || 30000
    });
    
    this.producer = this.kafka.producer({
      allowAutoTopicCreation: config.allowAutoTopicCreation !== false,
      maxBatchSize: this.batchSize,
      linger: 50,
      compression: config.compression ? 1 : 0 // 1 = Gzip
    });
    
    try {
      await this.producer.connect();
      this.connected = true;
      this.healthStatus = 'healthy';
      
      // 启动批处理定时器
      this.batchTimer = setInterval(
        () => this.sendBatch().catch(err => console.error(`[KafkaAdapter] Batch send error:`, err)),
        this.batchTimeout
      );
      
    } catch (error) {
      this.healthStatus = 'error';
      throw error;
    }
  }

  async write(logEntry) {
    if (!this.initialized || !this.connected) {
      throw new Error('KafkaAdapter not initialized or not connected');
    }
    
    // 添加到批处理缓冲区
    this.batchBuffer.push(logEntry);
    
    // 达到批处理大小立即发送
    if (this.batchBuffer.length >= this.batchSize) {
      await this.sendBatch();
    }
  }

  async writeBatch(logEntries) {
    for (const entry of logEntries) {
      this.batchBuffer.push(entry);
    }
    
    if (this.batchBuffer.length >= this.batchSize) {
      await this.sendBatch();
    }
  }

  async sendBatch() {
    if (this.batchBuffer.length === 0) return;
    
    const entries = [...this.batchBuffer];
    this.batchBuffer = [];
    
    if (!this.connected) {
      // 连接断开，重新加入缓冲区并尝试重连
      this.batchBuffer.unshift(...entries);
      await this.reconnect();
      return;
    }
    
    const messages = entries.map(entry => {
      const formatted = this.formatEntry(entry);
      return {
        key: formatted[this.partitionKey] || 'default',
        value: JSON.stringify(formatted),
        timestamp: formatted.timestamp
      };
    });
    
    try {
      await this.producer.send({
        topic: this.topic,
        messages
      });
    } catch (error) {
      // 发送失败，重新加入缓冲区
      this.batchBuffer.unshift(...entries);
      this.healthStatus = 'error';
      throw error;
    }
  }

  async reconnect() {
    if (this.kafka && this.producer) {
      try {
        await this.producer.connect();
        this.connected = true;
        this.healthStatus = 'healthy';
      } catch (error) {
        this.connected = false;
        console.error(`[KafkaAdapter] Reconnect failed:`, error);
      }
    }
  }

  async flush() {
    await this.sendBatch();
  }

  async close() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    
    await super.close();
    
    // 发送剩余日志
    await this.sendBatch();
    
    if (this.producer && this.connected) {
      await this.producer.disconnect();
      this.connected = false;
    }
    
    this.healthStatus = 'closed';
  }

  async healthCheck() {
    const base = await super.healthCheck();
    
    let kafkaStatus = 'unknown';
    try {
      if (this.connected) {
        // 发送空消息检查连接
        await this.producer.send({
          topic: this.topic,
          messages: [{ key: 'health-check', value: '' }]
        });
        kafkaStatus = 'healthy';
      }
    } catch {
      kafkaStatus = 'unhealthy';
      this.connected = false;
    }
    
    return {
      ...base,
      status: this.connected && kafkaStatus === 'healthy' ? 'healthy' : 'unhealthy',
      details: {
        connected: this.connected,
        topic: this.topic,
        brokers: this.config.brokers?.join(','),
        batchBuffered: this.batchBuffer.length,
        kafkaStatus
      }
    };
  }
}

module.exports = KafkaAdapter;