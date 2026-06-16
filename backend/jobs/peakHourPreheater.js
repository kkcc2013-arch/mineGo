/**
 * 高峰时段预热任务
 * REQ-00161: 低峰期服务自动休眠与智能唤醒系统
 */

const { Kafka } = require('kafkajs');
const logger = require('../shared/logger');
const redis = require('../shared/redis');

class PeakHourPreheater {
  constructor(options = {}) {
    this.kafka = new Kafka({
      clientId: options.clientId || 'peak-hour-preheater',
      brokers: options.kafkaBrokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({ groupId: 'peak-hour-preheater-group' });

    this.peakHours = [];
    this.timezone = process.env.TIMEZONE || 'UTC';

    // 所有可预热的服务
    this.services = [
      'user-service',
      'location-service',
      'pokemon-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service'
    ];

    // 预热提前时间（分钟）
    this.preheatAdvanceMinutes = options.preheatAdvanceMinutes || 30;

    // 检查间隔（分钟）
    this.checkIntervalMs = options.checkIntervalMs || 60000;

    this.initialized = false;
  }

  async start() {
    if (this.initialized) return;

    try {
      await this.producer.connect();
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: 'peak-hours-prediction', fromBeginning: false });

      // 监听高峰时段预测
      await this.consumer.run({
        eachMessage: async ({ message }) => {
          try {
            const prediction = JSON.parse(message.value.toString());
            this.peakHours = prediction.peakHours || [];
            this.timezone = prediction.timezone || 'UTC';
            logger.info('Updated peak hours prediction', { peakHours: this.peakHours, timezone: this.timezone });
          } catch (error) {
            logger.error('Failed to parse peak hours prediction', { error: error.message });
          }
        }
      });

      // 每分钟检查是否接近高峰时段
      this.checkTimer = setInterval(() => this.checkAndPreheat(), this.checkIntervalMs);

      // 从 Redis 加载已保存的高峰时段
      await this.loadPeakHours();

      this.initialized = true;
      logger.info('PeakHourPreheater started successfully');

      // 立即执行一次检查
      await this.checkAndPreheat();

    } catch (error) {
      logger.error('PeakHourPreheater start failed', { error: error.message });
      throw error;
    }
  }

  async stop() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
    }

    if (this.initialized) {
      await this.consumer.disconnect();
      await this.producer.disconnect();
      this.initialized = false;
    }
  }

  async loadPeakHours() {
    try {
      const saved = await redis.get('peak-hours:prediction');
      if (saved) {
        const data = JSON.parse(saved);
        this.peakHours = data.peakHours || [];
        this.timezone = data.timezone || 'UTC';
        logger.info('Loaded peak hours from cache', { peakHours: this.peakHours });
      }
    } catch (error) {
      logger.error('Failed to load peak hours', { error: error.message });
    }
  }

  async savePeakHours() {
    try {
      await redis.setex('peak-hours:prediction', 86400, JSON.stringify({
        peakHours: this.peakHours,
        timezone: this.timezone,
        updatedAt: new Date().toISOString()
      }));
    } catch (error) {
      logger.error('Failed to save peak hours', { error: error.message });
    }
  }

  async checkAndPreheat() {
    if (this.peakHours.length === 0) {
      // 使用默认高峰时段（如果未设置）
      this.peakHours = this.getDefaultPeakHours();
    }

    const now = new Date();
    const localHour = this.getLocalHour(now);
    const minutes = now.getMinutes();
    const minutesToNextHour = 60 - minutes;

    // 检查下一个小时是否是高峰时段
    const nextHour = (localHour + 1) % 24;

    if (this.peakHours.includes(nextHour)) {
      // 如果距离高峰时段在预热提前时间内
      if (minutesToNextHour <= this.preheatAdvanceMinutes) {
        // 检查是否已经预热过
        const lastPreheatKey = `preheat:${nextHour}:${now.toISOString().split('T')[0]}`;
        const alreadyPreheated = await redis.get(lastPreheatKey);

        if (!alreadyPreheated) {
          logger.info('Approaching peak hour, preheating services', {
            peakHour: nextHour,
            minutesToPeak: minutesToNextHour
          });

          await this.preheatAllServices();

          // 标记已预热
          await redis.setex(lastPreheatKey, 86400, '1');
        }
      }
    }

    // 也检查当前高峰时段开始时的预热（整点）
    if (this.peakHours.includes(localHour) && minutes === 0) {
      const lastPreheatKey = `preheat:${localHour}:${now.toISOString().split('T')[0]}`;
      const alreadyPreheated = await redis.get(lastPreheatKey);

      if (!alreadyPreheated) {
        logger.info('Peak hour started, ensuring all services are warm', {
          peakHour: localHour
        });

        await this.preheatAllServices();
        await redis.setex(lastPreheatKey, 86400, '1');
      }
    }
  }

  getDefaultPeakHours() {
    // 默认高峰时段：早上8-9点，中午12-13点，晚上18-22点
    // 根据 timezone 调整
    const tz = this.timezone;

    if (tz === 'Asia/Shanghai') {
      return [8, 12, 18, 19, 20, 21];
    }

    // 默认 UTC 时间
    return [0, 4, 12, 16, 17, 18, 19];
  }

  getLocalHour(date) {
    const utcHour = date.getUTCHours();
    const tz = this.timezone;

    // 简单时区转换
    const offsets = {
      'UTC': 0,
      'Asia/Shanghai': 8,
      'America/New_York': -5,
      'America/Los_Angeles': -8,
      'Europe/London': 0,
      'Europe/Paris': 1,
      'Asia/Tokyo': 9
    };

    const offset = offsets[tz] || 0;
    return (utcHour + offset + 24) % 24;
  }

  async preheatAllServices() {
    const results = [];

    for (const service of this.services) {
      try {
        await this.producer.send({
          topic: 'sleep-recommendations',
          messages: [{
            key: service,
            value: JSON.stringify({
              service,
              action: 'wake',
              reason: 'Preheating before peak hour',
              currentReplicas: 0,
              suggestedReplicas: this.getTargetReplicas(service),
              priority: 'high',
              timestamp: new Date().toISOString()
            })
          }]
        });

        results.push({ service, success: true });

      } catch (error) {
        logger.error('Failed to send preheat message', { service, error: error.message });
        results.push({ service, success: false, error: error.message });
      }
    }

    logger.info('Preheat completed', {
      total: results.length,
      success: results.filter(r => r.success).length
    });

    return results;
  }

  getTargetReplicas(serviceName) {
    // 根据服务重要性设置预热副本数
    const replicas = {
      'user-service': 3,
      'location-service': 4,
      'pokemon-service': 4,
      'catch-service': 4,
      'gym-service': 3,
      'social-service': 3,
      'reward-service': 2,
      'payment-service': 2
    };

    return replicas[serviceName] || 2;
  }

  async forcePreheat() {
    // 手动强制预热所有服务
    logger.info('Force preheating all services');
    return await this.preheatAllServices();
  }

  getStatus() {
    const now = new Date();
    const localHour = this.getLocalHour(now);

    return {
      peakHours: this.peakHours,
      timezone: this.timezone,
      currentHour: localHour,
      isPeakHour: this.peakHours.includes(localHour),
      preheatAdvanceMinutes: this.preheatAdvanceMinutes,
      services: this.services
    };
  }
}

module.exports = PeakHourPreheater;
