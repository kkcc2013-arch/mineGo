/**
 * 网关层休眠唤醒触发器
 * REQ-00161: 低峰期服务自动休眠与智能唤醒系统
 */

const { Kafka } = require('kafkajs');
const logger = require('@pmg/shared/logger');
const redis = require('@pmg/shared/redis');

class SleepWakeTrigger {
  constructor(options = {}) {
    this.kafka = new Kafka({
      clientId: options.clientId || 'sleep-wake-trigger',
      brokers: options.kafkaBrokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.producer = this.kafka.producer();
    this.initialized = false;

    // 服务唤醒等待时间估计（秒）
    this.estimatedWakeTime = options.estimatedWakeTime || 30;

    // 路径到服务的映射
    this.pathMap = {
      '/api/users': 'user-service',
      '/api/location': 'location-service',
      '/api/pokemon': 'pokemon-service',
      '/api/catch': 'catch-service',
      '/api/gym': 'gym-service',
      '/api/social': 'social-service',
      '/api/reward': 'reward-service',
      '/api/payment': 'payment-service'
    };
  }

  async init() {
    if (!this.initialized) {
      try {
        await this.producer.connect();
        this.initialized = true;
        logger.info('SleepWakeTrigger initialized');
      } catch (error) {
        logger.error('SleepWakeTrigger init failed', { error: error.message });
      }
    }
  }

  async checkAndWake(serviceName, req) {
    await this.init();

    try {
      // 获取休眠服务列表
      const sleepingServices = await this.getSleepingServices();

      if (sleepingServices.includes(serviceName)) {
        logger.info('Triggering wake for sleeping service', {
          service: serviceName,
          path: req.path
        });

        // 发送唤醒消息
        await this.producer.send({
          topic: 'sleep-recommendations',
          messages: [{
            key: serviceName,
            value: JSON.stringify({
              service: serviceName,
              action: 'wake',
              reason: `Incoming request to ${req.path}`,
              currentReplicas: 0,
              suggestedReplicas: 2,
              priority: 'high',
              source: 'gateway-trigger',
              timestamp: new Date().toISOString()
            })
          }]
        });

        return {
          shouldWait: true,
          estimatedWaitTime: this.estimatedWakeTime,
          service: serviceName
        };
      }

      return { shouldWait: false };

    } catch (error) {
      logger.error('SleepWakeTrigger check failed', { error: error.message });
      return { shouldWait: false };
    }
  }

  async getSleepingServices() {
    try {
      const sleeping = await redis.smembers('sleeping-services');
      return sleeping || [];
    } catch (error) {
      logger.error('Failed to get sleeping services', { error: error.message });
      return [];
    }
  }

  getServiceNameFromPath(path) {
    for (const [prefix, service] of Object.entries(this.pathMap)) {
      if (path.startsWith(prefix)) {
        return service;
      }
    }
    return null;
  }
}

/**
 * 休眠唤醒中间件
 * 当请求访问休眠服务时，触发唤醒并返回等待响应
 */
function sleepWakeMiddleware(trigger) {
  return async (req, res, next) => {
    // 只检查 API 请求
    if (!req.path.startsWith('/api/')) {
      return next();
    }

    const serviceName = trigger.getServiceNameFromPath(req.path);

    if (!serviceName) {
      return next();
    }

    try {
      const result = await trigger.checkAndWake(serviceName, req);

      if (result.shouldWait) {
        // 返回 202 Accepted，客户端应稍后重试
        return res.status(202).json({
          error: 'SERVICE_WAKING_UP',
          message: `${serviceName} is starting up, please retry in ${result.estimatedWaitTime} seconds`,
          retryAfter: result.estimatedWaitTime,
          service: result.service
        });
      }
    } catch (error) {
      logger.error('sleepWakeMiddleware error', { error: error.message });
    }

    next();
  };
}

/**
 * 服务状态检查中间件
 * 添加服务状态头信息
 */
function serviceStatusMiddleware(trigger) {
  return async (req, res, next) => {
    const serviceName = trigger.getServiceNameFromPath(req.path);

    if (serviceName) {
      try {
        const sleepingServices = await trigger.getSleepingServices();
        res.setHeader('X-Service-Status', sleepingServices.includes(serviceName) ? 'sleeping' : 'active');
      } catch (error) {
        // 静默失败
      }
    }

    next();
  };
}

module.exports = {
  SleepWakeTrigger,
  sleepWakeMiddleware,
  serviceStatusMiddleware
};