/**
 * Kafka MirrorMaker 跨区域消息同步
 * 支持主备区域消息队列同步
 */

const { Kafka } = require('kafkajs');
const logger = require('../logger');
const { metrics } = require('../metrics');

class KafkaMirrorMaker {
  constructor(options = {}) {
    this.primaryCluster = options.primary || {
      brokers: (process.env.KAFKA_PRIMARY_BROKERS || 'kafka-primary.beijing:9092').split(','),
      clientId: 'mirrormaker-primary'
    };
    
    this.standbyCluster = options.standby || {
      brokers: (process.env.KAFKA_STANDBY_BROKERS || 'kafka-standby.shanghai:9092').split(','),
      clientId: 'mirrormaker-standby'
    };
    
    this.topics = options.topics || [
      'user-events',
      'pokemon-events',
      'catch-events',
      'gym-events',
      'social-events',
      'reward-events',
      'payment-events'
    ];
    
    this.topicPrefix = options.topicPrefix || 'mirror.';
    this.replicationFactor = options.replicationFactor || 3;
    
    this.primaryKafka = null;
    this.standbyKafka = null;
    this.isRunning = false;
  }

  /**
   * 初始化 MirrorMaker
   */
  async initialize() {
    try {
      // 创建主集群连接
      this.primaryKafka = new Kafka({
        brokers: this.primaryCluster.brokers,
        clientId: this.primaryCluster.clientId
      });
      
      // 创建备集群连接
      this.standbyKafka = new Kafka({
        brokers: this.standbyCluster.brokers,
        clientId: this.standbyCluster.clientId
      });
      
      logger.info({
        primary: this.primaryCluster.brokers,
        standby: this.standbyCluster.brokers
      }, 'Kafka MirrorMaker 已初始化');
      
      return { success: true };
    } catch (error) {
      logger.error({ error: error.message }, 'Kafka MirrorMaker 初始化失败');
      throw error;
    }
  }

  /**
   * 启动消息同步
   */
  async start() {
    if (this.isRunning) {
      logger.warn('MirrorMaker 已在运行');
      return;
    }
    
    try {
      const admin = this.standbyKafka.admin();
      await admin.connect();
      
      // 在备集群创建镜像主题
      for (const topic of this.topics) {
        const mirrorTopic = `${this.topicPrefix}${topic}`;
        
        try {
          await admin.createTopics({
            topics: [{
              topic: mirrorTopic,
              numPartitions: 3,
              replicationFactor: this.replicationFactor
            }]
          });
          
          logger.info({ topic: mirrorTopic }, '镜像主题已创建');
        } catch (error) {
          if (!error.message.includes('already exists')) {
            logger.warn({ error: error.message, topic: mirrorTopic }, '创建镜像主题失败');
          }
        }
      }
      
      await admin.disconnect();
      
      // 启动消费者和生产者
      const consumer = this.primaryKafka.consumer({
        groupId: 'mirrormaker-group',
        fromBeginning: false
      });
      
      const producer = this.standbyKafka.producer();
      
      await consumer.connect();
      await producer.connect();
      
      // 订阅所有主题
      await consumer.subscribe({
        topics: this.topics,
        fromBeginning: false
      });
      
      // 消费并转发消息
      await consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          const mirrorTopic = `${this.topicPrefix}${topic}`;
          
          try {
            await producer.send({
              topic: mirrorTopic,
              messages: [{
                key: message.key,
                value: message.value,
                headers: message.headers,
                timestamp: message.timestamp
              }]
            });
            
            if (typeof metrics !== 'undefined' && metrics.increment) {
              metrics.increment('kafka_mirrormaker_messages_total', 1, { topic });
            }
          } catch (error) {
            logger.error({ error: error.message, topic }, '消息镜像失败');
          }
        }
      });
      
      this.isRunning = true;
      logger.info('Kafka MirrorMaker 已启动');
      
    } catch (error) {
      logger.error({ error: error.message }, 'Kafka MirrorMaker 启动失败');
      throw error;
    }
  }

  /**
   * 停止消息同步
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }
    
    this.isRunning = false;
    logger.info('Kafka MirrorMaker 已停止');
  }

  /**
   * 检查同步状态
   */
  async checkSyncStatus() {
    try {
      const admin = this.standbyKafka.admin();
      await admin.connect();
      
      const topicMetadata = await admin.fetchTopicMetadata({
        topics: this.topics.map(t => `${this.topicPrefix}${t}`)
      });
      
      await admin.disconnect();
      
      return {
        syncedTopics: topicMetadata.topics.length,
        totalTopics: this.topics.length,
        isRunning: this.isRunning
      };
    } catch (error) {
      logger.error({ error: error.message }, '检查同步状态失败');
      return { error: error.message };
    }
  }

  /**
   * 获取主集群健康状态
   */
  async checkPrimaryHealth() {
    try {
      const admin = this.primaryKafka.admin();
      await admin.connect();
      
      const clusterInfo = await admin.describeCluster();
      await admin.disconnect();
      
      return {
        healthy: true,
        brokers: clusterInfo.brokers.length,
        controllerId: clusterInfo.controller
      };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }

  /**
   * 获取备集群健康状态
   */
  async checkStandbyHealth() {
    try {
      const admin = this.standbyKafka.admin();
      await admin.connect();
      
      const clusterInfo = await admin.describeCluster();
      await admin.disconnect();
      
      return {
        healthy: true,
        brokers: clusterInfo.brokers.length,
        controllerId: clusterInfo.controller
      };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }
}

module.exports = KafkaMirrorMaker;