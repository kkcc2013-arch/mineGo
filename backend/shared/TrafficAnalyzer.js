/**
 * 流量分析器 - 实时监控服务流量和资源使用率
 * REQ-00161: 低峰期服务自动休眠与智能唤醒系统
 */

const { Kafka } = require('kafkajs');
const logger = require('./logger');
const redis = require('./redis');

class TrafficAnalyzer {
  constructor(options = {}) {
    this.kafka = new Kafka({
      clientId: options.clientId || 'traffic-analyzer',
      brokers: options.kafkaBrokers || process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.consumer = this.kafka.consumer({ groupId: 'traffic-analyzer-group' });
    this.producer = this.kafka.producer();
    this.initialized = false;

    // 流量统计窗口
    this.windows = {
      minute: new Map(),
      hour: new Map(),
      day: new Map()
    };

    // 服务流量阈值配置
    this.thresholds = {
      'user-service': { lowRpm: 10, lowCpu: 5, wakeRpm: 20 },
      'location-service': { lowRpm: 50, lowCpu: 10, wakeRpm: 100 },
      'pokemon-service': { lowRpm: 30, lowCpu: 8, wakeRpm: 60 },
      'catch-service': { lowRpm: 20, lowCpu: 10, wakeRpm: 40 },
      'gym-service': { lowRpm: 15, lowCpu: 8, wakeRpm: 30 },
      'social-service': { lowRpm: 10, lowCpu: 5, wakeRpm: 20 },
      'reward-service': { lowRpm: 5, lowCpu: 3, wakeRpm: 10 },
      'payment-service': { lowRpm: 2, lowCpu: 2, wakeRpm: 5 }
    };

    // 核心服务不可休眠
    this.coreServices = ['gateway', 'user-service'];

    // 分析间隔
    this.analyzeInterval = options.analyzeInterval || 60000;
    this.predictInterval = options.predictInterval || 3600000;
  }

  async start() {
    if (this.initialized) return;

    try {
      await this.consumer.connect();
      await this.producer.connect();

      await this.consumer.subscribe({ topic: 'api-requests', fromBeginning: false });
      await this.consumer.subscribe({ topic: 'service-metrics', fromBeginning: false });

      await this.consumer.run({
        eachMessage: async ({ topic, partition, message }) => {
          try {
            const data = JSON.parse(message.value.toString());

            if (topic === 'api-requests') {
              this.recordRequest(data.service, data.userId, data.endpoint);
            } else if (topic === 'service-metrics') {
              this.recordMetrics(data.service, data.metrics);
            }
          } catch (error) {
            logger.error('TrafficAnalyzer message processing error', { error: error.message });
          }
        }
      });

      // 定期分析流量模式
      this.analyzeTimer = setInterval(() => this.analyzePatterns(), this.analyzeInterval);
      this.predictTimer = setInterval(() => this.predictPeakHours(), this.predictInterval);

      this.initialized = true;
      logger.info('TrafficAnalyzer started successfully');
    } catch (error) {
      logger.error('TrafficAnalyzer start failed', { error: error.message });
      throw error;
    }
  }

  async stop() {
    if (this.analyzeTimer) clearInterval(this.analyzeTimer);
    if (this.predictTimer) clearInterval(this.predictTimer);

    if (this.initialized) {
      await this.consumer.disconnect();
      await this.producer.disconnect();
      this.initialized = false;
    }
  }

  recordRequest(serviceName, userId, endpoint) {
    const minuteKey = Math.floor(Date.now() / 60000);
    const key = `${serviceName}:${minuteKey}`;

    if (!this.windows.minute.has(key)) {
      this.windows.minute.set(key, {
        count: 0,
        uniqueUsers: new Set(),
        endpoints: new Map(),
        cpu: 0,
        memory: 0
      });
    }

    const window = this.windows.minute.get(key);
    window.count++;
    if (userId) window.uniqueUsers.add(userId);
    if (endpoint) window.endpoints.set(endpoint, (window.endpoints.get(endpoint) || 0) + 1);

    this.cleanupWindows();
  }

  recordMetrics(serviceName, metrics) {
    const minuteKey = Math.floor(Date.now() / 60000);
    const key = `${serviceName}:${minuteKey}`;

    if (!this.windows.minute.has(key)) {
      this.windows.minute.set(key, {
        count: 0,
        uniqueUsers: new Set(),
        endpoints: new Map(),
        cpu: 0,
        memory: 0
      });
    }

    const window = this.windows.minute.get(key);
    if (metrics.cpu !== undefined) window.cpu = metrics.cpu;
    if (metrics.memory !== undefined) window.memory = metrics.memory;
    if (metrics.latency !== undefined) window.latency = metrics.latency;
  }

  cleanupWindows() {
    const now = Date.now();
    const oneHourAgo = now - 3600000;

    for (const [key] of this.windows.minute) {
      const parts = key.split(':');
      const minute = parseInt(parts[1]) * 60000;
      if (minute < oneHourAgo) {
        this.windows.minute.delete(key);
      }
    }
  }

  async analyzePatterns() {
    const recommendations = [];

    for (const [serviceName, threshold] of Object.entries(this.thresholds)) {
      if (this.coreServices.includes(serviceName)) continue;

      const stats = this.getServiceStats(serviceName);

      // 低流量判断 - 持续10分钟以上
      const isLowTraffic = stats.rpm < threshold.lowRpm;
      const isLowCpu = stats.avgCpu < threshold.lowCpu;
      const sustainedMinutes = stats.sustainedLowCount;

      if (isLowTraffic && isLowCpu && sustainedMinutes >= 10) {
        recommendations.push({
          service: serviceName,
          action: 'sleep',
          reason: `持续 ${sustainedMinutes} 分钟低流量 (${stats.rpm.toFixed(1)} RPM, ${stats.avgCpu.toFixed(1)}% CPU)`,
          currentReplicas: stats.currentReplicas,
          suggestedReplicas: this.getMinReplicas(serviceName),
          metrics: { rpm: stats.rpm, cpu: stats.avgCpu }
        });
      }

      // 流量回升判断
      if (stats.rpm > threshold.wakeRpm && stats.isSleeping) {
        recommendations.push({
          service: serviceName,
          action: 'wake',
          reason: `流量回升 (${stats.rpm.toFixed(1)} RPM)`,
          currentReplicas: stats.currentReplicas,
          suggestedReplicas: stats.targetReplicas || 2,
          metrics: { rpm: stats.rpm }
        });
      }
    }

    if (recommendations.length > 0) {
      try {
        await this.producer.send({
          topic: 'sleep-recommendations',
          messages: recommendations.map(r => ({
            key: r.service,
            value: JSON.stringify({
              ...r,
              timestamp: new Date().toISOString()
            })
          }))
        });

        logger.info('Sleep recommendations generated', { count: recommendations.length });
      } catch (error) {
        logger.error('Failed to send recommendations', { error: error.message });
      }
    }

    return recommendations;
  }

  getServiceStats(serviceName) {
    const now = Date.now();
    const minuteKeys = [];

    // 获取最近10分钟的窗口
    for (let i = 0; i < 10; i++) {
      const minuteKey = Math.floor((now - i * 60000) / 60000);
      minuteKeys.push(`${serviceName}:${minuteKey}`);
    }

    const windows = minuteKeys
      .map(k => this.windows.minute.get(k))
      .filter(w => w);

    if (windows.length === 0) {
      return { rpm: 0, avgCpu: 0, sustainedLowCount: 10, currentReplicas: 0, isSleeping: true };
    }

    const totalRequests = windows.reduce((sum, w) => sum + w.count, 0);
    const rpm = totalRequests / windows.length;
    const avgCpu = windows.reduce((sum, w) => sum + (w.cpu || 0), 0) / windows.length;
    const avgMemory = windows.reduce((sum, w) => sum + (w.memory || 0), 0) / windows.length;

    // 计算持续低流量时间
    const threshold = this.thresholds[serviceName] || { lowRpm: 10, lowCpu: 5 };
    let sustainedLowCount = 0;
    for (const w of windows) {
      if (w.count < threshold.lowRpm && (w.cpu || 100) < threshold.lowCpu) {
        sustainedLowCount++;
      } else {
        break;
      }
    }

    return {
      rpm,
      avgCpu,
      avgMemory,
      sustainedLowCount,
      currentReplicas: windows[windows.length - 1].replicas || 2,
      isSleeping: sustainedLowCount >= 10,
      targetReplicas: 2
    };
  }

  getMinReplicas(serviceName) {
    return this.coreServices.includes(serviceName) ? 1 : 0;
  }

  async predictPeakHours() {
    const hourlyStats = this.getHourlyStats();

    const peakHours = [];
    for (let hour = 0; hour < 24; hour++) {
      const hourStats = hourlyStats[hour] || { avgRpm: 0 };
      if (hourStats.avgRpm > 100) {
        peakHours.push(hour);
      }
    }

    try {
      await this.producer.send({
        topic: 'peak-hours-prediction',
        messages: [{
          key: 'prediction',
          value: JSON.stringify({
            peakHours,
            timezone: process.env.TIMEZONE || 'UTC',
            timestamp: new Date().toISOString()
          })
        }]
      });
    } catch (error) {
      logger.error('Failed to send peak hours prediction', { error: error.message });
    }

    return peakHours;
  }

  getHourlyStats() {
    const hourlyStats = {};

    for (const [key, window] of this.windows.minute) {
      const [service, minuteKey] = key.split(':');
      const hour = Math.floor(parseInt(minuteKey) / 60) % 24;

      if (!hourlyStats[hour]) {
        hourlyStats[hour] = { totalRpm: 0, count: 0, services: new Map() };
      }

      hourlyStats[hour].totalRpm += window.count;
      hourlyStats[hour].count++;

      if (!hourlyStats[hour].services.has(service)) {
        hourlyStats[hour].services.set(service, { rpm: 0, count: 0 });
      }
      const serviceStats = hourlyStats[hour].services.get(service);
      serviceStats.rpm += window.count;
      serviceStats.count++;
    }

    for (const hour in hourlyStats) {
      hourlyStats[hour].avgRpm = hourlyStats[hour].count > 0
        ? hourlyStats[hour].totalRpm / hourlyStats[hour].count
        : 0;

      for (const [service, stats] of hourlyStats[hour].services) {
        stats.avgRpm = stats.count > 0 ? stats.rpm / stats.count : 0;
      }
    }

    return hourlyStats;
  }

  async getServiceTrafficHistory(serviceName, hours = 24) {
    const history = [];
    const now = Date.now();
    const startTime = now - hours * 3600000;

    for (const [key, window] of this.windows.minute) {
      const [service, minuteKey] = key.split(':');
      if (service !== serviceName) continue;

      const timestamp = parseInt(minuteKey) * 60000;
      if (timestamp < startTime) continue;

      history.push({
        timestamp: new Date(timestamp).toISOString(),
        rpm: window.count,
        uniqueUsers: window.uniqueUsers.size,
        avgCpu: window.cpu || 0,
        avgMemory: window.memory || 0
      });
    }

    return history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }
}

module.exports = TrafficAnalyzer;
