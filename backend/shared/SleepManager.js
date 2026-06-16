/**
 * 休眠管理器 - 自动缩减/扩展服务副本
 * REQ-00161: 低峰期服务自动休眠与智能唤醒系统
 */

const k8s = require('@kubernetes/client-node');
const logger = require('./logger');
const redis = require('./redis');
const { Kafka } = require('kafkajs');

class SleepManager {
  constructor(options = {}) {
    // Kubernetes 客户端配置
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromDefault();
      this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
    } catch (error) {
      logger.warn('Kubernetes config not available, running in mock mode', { error: error.message });
      this.appsV1Api = null;
    }

    // Kafka 配置
    this.kafka = new Kafka({
      clientId: options.clientId || 'sleep-manager',
      brokers: options.kafkaBrokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.consumer = this.kafka.consumer({ groupId: 'sleep-manager-group' });
    this.producer = this.kafka.producer();

    // 服务状态缓存
    this.serviceStates = new Map();

    // 冷却时间配置（防止频繁切换）
    this.cooldownMs = {
      sleep: 10 * 60 * 1000,  // 休眠后10分钟内不允许唤醒
      wake: 5 * 60 * 1000     // 唤醒后5分钟内不允许休眠
    };

    // 部署命名空间
    this.namespace = options.namespace || process.env.K8S_NAMESPACE || 'default';

    // Mock 模式用于开发测试
    this.mockMode = options.mockMode || !this.appsV1Api;

    this.initialized = false;
  }

  async start() {
    if (this.initialized) return;

    try {
      await this.consumer.connect();
      await this.producer.connect();
      await this.consumer.subscribe({ topic: 'sleep-recommendations', fromBeginning: false });

      await this.consumer.run({
        eachMessage: async ({ message }) => {
          try {
            const recommendation = JSON.parse(message.value.toString());
            await this.processRecommendation(recommendation);
          } catch (error) {
            logger.error('SleepManager processing error', { error: error.message });
          }
        }
      });

      this.initialized = true;
      logger.info('SleepManager started successfully', { mockMode: this.mockMode });
    } catch (error) {
      logger.error('SleepManager start failed', { error: error.message });
      throw error;
    }
  }

  async stop() {
    if (this.initialized) {
      await this.consumer.disconnect();
      await this.producer.disconnect();
      this.initialized = false;
    }
  }

  async processRecommendation(recommendation) {
    const { service, action, reason, currentReplicas, suggestedReplicas } = recommendation;

    // 检查冷却时间
    if (!await this.canExecute(service, action)) {
      logger.info('Action skipped due to cooldown', { service, action });
      return;
    }

    // 执行休眠或唤醒
    if (action === 'sleep') {
      await this.sleepService(service, suggestedReplicas, reason);
    } else if (action === 'wake') {
      await this.wakeService(service, suggestedReplicas, reason);
    }
  }

  async sleepService(serviceName, minReplicas, reason) {
    try {
      const deploymentName = serviceName.replace('-service', '');

      if (this.mockMode) {
        // Mock 模式
        logger.info('[MOCK] Service put to sleep', { serviceName, minReplicas, reason });
        await this.recordStateChange(serviceName, 'sleep', {
          from: 2,
          to: minReplicas,
          reason
        });
        return;
      }

      // 获取当前部署状态
      const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, this.namespace);
      const currentReplicas = deployment.body.spec.replicas;

      if (currentReplicas <= minReplicas) {
        logger.info('Service already at minimum replicas', { serviceName, replicas: currentReplicas });
        return;
      }

      // 缩减副本
      const patch = {
        spec: {
          replicas: minReplicas
        }
      };

      await this.appsV1Api.patchNamespacedDeployment(
        deploymentName,
        this.namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );

      // 记录状态变更
      await this.recordStateChange(serviceName, 'sleep', {
        from: currentReplicas,
        to: minReplicas,
        reason
      });

      // 更新休眠服务列表
      if (minReplicas === 0) {
        await redis.sadd('sleeping-services', serviceName);
      }

      logger.info('Service put to sleep', { serviceName, from: currentReplicas, to: minReplicas, reason });

    } catch (error) {
      logger.error('Failed to sleep service', { serviceName, error: error.message });
    }
  }

  async wakeService(serviceName, targetReplicas, reason) {
    try {
      const deploymentName = serviceName.replace('-service', '');

      if (this.mockMode) {
        // Mock 模式
        logger.info('[MOCK] Service woken up', { serviceName, targetReplicas, reason });
        await this.recordStateChange(serviceName, 'wake', {
          from: 0,
          to: targetReplicas,
          reason
        });
        await redis.srem('sleeping-services', serviceName);
        return;
      }

      // 获取当前部署状态
      const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, this.namespace);
      const currentReplicas = deployment.body.spec.replicas;

      if (currentReplicas >= targetReplicas) {
        logger.info('Service already at target replicas', { serviceName, replicas: currentReplicas });
        await redis.srem('sleeping-services', serviceName);
        return;
      }

      // 扩展副本
      const patch = {
        spec: {
          replicas: targetReplicas
        }
      };

      await this.appsV1Api.patchNamespacedDeployment(
        deploymentName,
        this.namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
      );

      // 等待 Pod 就绪
      await this.waitForReady(deploymentName, targetReplicas);

      // 记录状态变更
      await this.recordStateChange(serviceName, 'wake', {
        from: currentReplicas,
        to: targetReplicas,
        reason
      });

      // 从休眠列表移除
      await redis.srem('sleeping-services', serviceName);

      logger.info('Service woken up', { serviceName, from: currentReplicas, to: targetReplicas, reason });

    } catch (error) {
      logger.error('Failed to wake service', { serviceName, error: error.message });
    }
  }

  async waitForReady(deploymentName, targetReplicas, timeout = 120000) {
    if (this.mockMode) return true;

    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, this.namespace);
        const readyReplicas = deployment.body.status.readyReplicas || 0;

        if (readyReplicas >= targetReplicas) {
          return true;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error('Error checking deployment status', { deploymentName, error: error.message });
      }
    }

    throw new Error(`Timeout waiting for deployment ${deploymentName} to be ready`);
  }

  async canExecute(serviceName, action) {
    const key = `sleep-manager:${serviceName}:${action}`;
    const lastExecution = await redis.get(key);

    if (lastExecution) {
      const elapsed = Date.now() - parseInt(lastExecution);
      const cooldown = this.cooldownMs[action];
      return elapsed >= cooldown;
    }

    return true;
  }

  async recordStateChange(serviceName, action, details) {
    const key = `sleep-manager:${serviceName}:${action}`;
    await redis.setex(key, 3600, Date.now().toString());

    // 存储历史记录
    const historyKey = `sleep-manager:history:${serviceName}`;
    const historyStr = await redis.get(historyKey);
    const history = historyStr ? JSON.parse(historyStr) : [];

    history.push({
      action,
      ...details,
      timestamp: new Date().toISOString()
    });

    // 只保留最近100条记录
    if (history.length > 100) {
      history.shift();
    }

    await redis.setex(historyKey, 86400 * 30, JSON.stringify(history));
  }

  async getServiceSleepHistory(serviceName) {
    const historyKey = `sleep-manager:history:${serviceName}`;
    const historyStr = await redis.get(historyKey);
    return historyStr ? JSON.parse(historyStr) : [];
  }

  async getServiceState(serviceName) {
    const stateKey = `sleep-manager:state:${serviceName}`;
    const stateStr = await redis.get(stateKey);
    return stateStr ? JSON.parse(stateStr) : { status: 'unknown', replicas: 2 };
  }

  async updateServiceState(serviceName, state) {
    const stateKey = `sleep-manager:state:${serviceName}`;
    await redis.setex(stateKey, 3600, JSON.stringify(state));
  }

  async getSleepingServices() {
    return await redis.smembers('sleeping-services') || [];
  }

  async calculateCostSavings() {
    const savings = [];
    const services = Object.keys({
      'user-service': { lowRpm: 10, lowCpu: 5 },
      'location-service': { lowRpm: 50, lowCpu: 10 },
      'pokemon-service': { lowRpm: 30, lowCpu: 8 },
      'catch-service': { lowRpm: 20, lowCpu: 10 },
      'gym-service': { lowRpm: 15, lowCpu: 8 },
      'social-service': { lowRpm: 10, lowCpu: 5 },
      'reward-service': { lowRpm: 5, lowCpu: 3 },
      'payment-service': { lowRpm: 2, lowCpu: 2 }
    });

    for (const serviceName of services) {
      const history = await this.getServiceSleepHistory(serviceName);

      // 计算过去24小时的节省
      const now = Date.now();
      const last24h = history.filter(h => {
        const time = new Date(h.timestamp).getTime();
        return now - time < 86400000;
      });

      const totalSleepMinutes = last24h
        .filter(h => h.action === 'sleep')
        .reduce((sum, h) => sum + Math.abs(h.to - h.from) * 10, 0);

      // 假设每个副本每小时成本 $0.10
      const estimatedSavings = (totalSleepMinutes / 60) * 0.10;

      savings.push({
        service: serviceName,
        sleepMinutes: totalSleepMinutes,
        estimatedSavings: estimatedSavings.toFixed(2),
        currency: 'USD'
      });
    }

    return savings;
  }

  async getTotalCostSavings() {
    const savings = await this.calculateCostSavings();
    return savings.reduce((sum, s) => sum + parseFloat(s.estimatedSavings), 0);
  }

  // 手动触发休眠/唤醒（管理员接口）
  async manualControl(serviceName, action, replicas, operator) {
    const reason = `Manual trigger by ${operator}`;

    if (action === 'sleep') {
      await this.sleepService(serviceName, replicas, reason);
    } else if (action === 'wake') {
      await this.wakeService(serviceName, replicas, reason);
    }

    return { success: true, service: serviceName, action, replicas };
  }
}

module.exports = SleepManager;