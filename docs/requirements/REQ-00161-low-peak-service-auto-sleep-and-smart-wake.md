# REQ-00161: 低峰期服务自动休眠与智能唤醒系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00161 |
| 标题 | 低峰期服务自动休眠与智能唤醒系统 |
| 类别 | 成本/资源优化 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared/sleepManager.js、backend/shared/trafficAnalyzer.js、infrastructure/k8s、backend/jobs |
| 创建时间 | 2026-06-13 10:30 |

## 需求描述

在夜间或低峰期，微服务的资源利用率显著降低，但仍保持全量运行，造成云成本浪费。本需求实现智能休眠与唤醒机制：

1. **流量分析**：实时监控各服务的请求量和资源使用率
2. **休眠策略**：当流量低于阈值且持续一定时间后，自动缩减副本数至最小（或0）
3. **智能唤醒**：当检测到流量回升或定时任务触发时，快速扩容恢复服务
4. **成本可视化**：展示休眠节省的成本和资源统计

### 业务价值
- 降低云服务器成本 20-40%
- 提升资源利用率
- 自动化运维，减少人工干预

## 技术方案

### 1. 流量分析器（Traffic Analyzer）

```javascript
// backend/shared/trafficAnalyzer.js
const { MongoClient } = require('mongodb');
const { Kafka } = require('kafkajs');
const logger = require('./logger');

class TrafficAnalyzer {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'traffic-analyzer',
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.consumer = this.kafka.consumer({ groupId: 'traffic-analyzer' });
    this.producer = this.kafka.producer();
    
    // 流量统计窗口
    this.windows = {
      minute: new Map(),  // 每分钟统计
      hour: new Map(),    // 每小时统计
      day: new Map()      // 每日统计
    };
    
    // 服务流量阈值配置
    this.thresholds = {
      'user-service': { lowRpm: 10, lowCpu: 5 },
      'location-service': { lowRpm: 50, lowCpu: 10 },
      'pokemon-service': { lowRpm: 30, lowCpu: 8 },
      'catch-service': { lowRpm: 20, lowCpu: 10 },
      'gym-service': { lowRpm: 15, lowCpu: 8 },
      'social-service': { lowRpm: 10, lowCpu: 5 },
      'reward-service': { lowRpm: 5, lowCpu: 3 },
      'payment-service': { lowRpm: 2, lowCpu: 2 }
    };
  }

  async start() {
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
    setInterval(() => this.analyzePatterns(), 60000); // 每分钟分析
    setInterval(() => this.predictPeakHours(), 3600000); // 每小时预测
  }

  recordRequest(serviceName, userId, endpoint) {
    const minuteKey = Math.floor(Date.now() / 60000);
    const key = `${serviceName}:${minuteKey}`;
    
    if (!this.windows.minute.has(key)) {
      this.windows.minute.set(key, { count: 0, uniqueUsers: new Set(), endpoints: new Map() });
    }
    
    const window = this.windows.minute.get(key);
    window.count++;
    window.uniqueUsers.add(userId);
    window.endpoints.set(endpoint, (window.endpoints.get(endpoint) || 0) + 1);
    
    // 清理过期窗口
    this.cleanupWindows();
  }

  recordMetrics(serviceName, metrics) {
    const minuteKey = Math.floor(Date.now() / 60000);
    const key = `${serviceName}:${minuteKey}`;
    
    if (!this.windows.minute.has(key)) {
      this.windows.minute.set(key, { count: 0, uniqueUsers: new Set(), endpoints: new Map() });
    }
    
    const window = this.windows.minute.get(key);
    window.cpu = metrics.cpu;
    window.memory = metrics.memory;
    window.latency = metrics.latency;
  }

  cleanupWindows() {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const oneDayAgo = now - 86400000;
    
    // 清理分钟窗口（保留1小时）
    for (const [key] of this.windows.minute) {
      const minute = parseInt(key.split(':')[1]) * 60000;
      if (minute < oneHourAgo) {
        this.windows.minute.delete(key);
      }
    }
  }

  async analyzePatterns() {
    const recommendations = [];
    
    for (const [serviceName, threshold] of Object.entries(this.thresholds)) {
      const stats = this.getServiceStats(serviceName);
      
      // 低流量判断
      const isLowTraffic = stats.rpm < threshold.lowRpm;
      const isLowCpu = stats.avgCpu < threshold.lowCpu;
      const sustainedMinutes = stats.sustainedLowCount;
      
      if (isLowTraffic && isLowCpu && sustainedMinutes >= 10) {
        recommendations.push({
          service: serviceName,
          action: 'sleep',
          reason: `持续 ${sustainedMinutes} 分钟低流量 (${stats.rpm} RPM, ${stats.avgCpu}% CPU)`,
          currentReplicas: stats.currentReplicas,
          suggestedReplicas: this.getMinReplicas(serviceName)
        });
      }
      
      // 流量回升判断
      if (stats.rpm > threshold.lowRpm * 2 && stats.isSleeping) {
        recommendations.push({
          service: serviceName,
          action: 'wake',
          reason: `流量回升 (${stats.rpm} RPM)`,
          currentReplicas: stats.currentReplicas,
          suggestedReplicas: stats.targetReplicas || 2
        });
      }
    }
    
    // 发送休眠/唤醒建议
    if (recommendations.length > 0) {
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
    
    // 计算持续低流量时间
    const threshold = this.thresholds[serviceName];
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
      sustainedLowCount,
      currentReplicas: windows[windows.length - 1].replicas || 2,
      isSleeping: sustainedLowCount >= 10
    };
  }

  getMinReplicas(serviceName) {
    // 核心服务保持至少1个副本
    const coreServices = ['gateway', 'user-service'];
    return coreServices.includes(serviceName) ? 1 : 0;
  }

  async predictPeakHours() {
    // 基于历史数据预测高峰时段
    // 使用简单的时间段统计（可后续升级为ML模型）
    const hourlyStats = this.getHourlyStats();
    
    const peakHours = [];
    for (let hour = 0; hour < 24; hour++) {
      const hourStats = hourlyStats[hour] || { avgRpm: 0 };
      if (hourStats.avgRpm > 100) {
        peakHours.push(hour);
      }
    }
    
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
    
    return peakHours;
  }

  getHourlyStats() {
    const hourlyStats = {};
    
    for (const [key, window] of this.windows.minute) {
      const [service, minuteKey] = key.split(':');
      const hour = Math.floor(parseInt(minuteKey) / 60) % 24;
      
      if (!hourlyStats[hour]) {
        hourlyStats[hour] = { totalRpm: 0, count: 0 };
      }
      
      hourlyStats[hour].totalRpm += window.count;
      hourlyStats[hour].count++;
    }
    
    for (const hour in hourlyStats) {
      hourlyStats[hour].avgRpm = hourlyStats[hour].totalRpm / hourlyStats[hour].count;
    }
    
    return hourlyStats;
  }
}

module.exports = TrafficAnalyzer;
```

### 2. 休眠管理器（Sleep Manager）

```javascript
// backend/shared/sleepManager.js
const k8s = require('@kubernetes/client-node');
const logger = require('./logger');
const { Redis } = require('./redis');

class SleepManager {
  constructor() {
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();
    this.appsV1Api = this.kc.makeApiClient(k8s.AppsV1Api);
    this.redis = new Redis();
    
    // 服务状态缓存
    this.serviceStates = new Map();
    
    // 冷却时间配置（防止频繁切换）
    this.cooldownMs = {
      sleep: 10 * 60 * 1000,  // 休眠后10分钟内不允许唤醒
      wake: 5 * 60 * 1000     // 唤醒后5分钟内不允许休眠
    };
  }

  async start(consumer) {
    await consumer.subscribe({ topic: 'sleep-recommendations', fromBeginning: false });
    
    await consumer.run({
      eachMessage: async ({ message }) => {
        try {
          const recommendation = JSON.parse(message.value.toString());
          await this.processRecommendation(recommendation);
        } catch (error) {
          logger.error('SleepManager processing error', { error: error.message });
        }
      }
    });
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
      
      // 获取当前部署状态
      const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, 'default');
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
        'default',
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
      
      logger.info('Service put to sleep', { serviceName, from: currentReplicas, to: minReplicas, reason });
      
    } catch (error) {
      logger.error('Failed to sleep service', { serviceName, error: error.message });
    }
  }

  async wakeService(serviceName, targetReplicas, reason) {
    try {
      const deploymentName = serviceName.replace('-service', '');
      
      // 获取当前部署状态
      const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, 'default');
      const currentReplicas = deployment.body.spec.replicas;
      
      if (currentReplicas >= targetReplicas) {
        logger.info('Service already at target replicas', { serviceName, replicas: currentReplicas });
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
        'default',
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
      
      logger.info('Service woken up', { serviceName, from: currentReplicas, to: targetReplicas, reason });
      
    } catch (error) {
      logger.error('Failed to wake service', { serviceName, error: error.message });
    }
  }

  async waitForReady(deploymentName, targetReplicas, timeout = 120000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        const deployment = await this.appsV1Api.readNamespacedDeployment(deploymentName, 'default');
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
    const lastExecution = await this.redis.get(key);
    
    if (lastExecution) {
      const elapsed = Date.now() - parseInt(lastExecution);
      const cooldown = this.cooldownMs[action];
      return elapsed >= cooldown;
    }
    
    return true;
  }

  async recordStateChange(serviceName, action, details) {
    const key = `sleep-manager:${serviceName}:${action}`;
    await this.redis.setex(key, 3600, Date.now().toString());
    
    // 存储历史记录
    const historyKey = `sleep-manager:history:${serviceName}`;
    const history = JSON.parse(await this.redis.get(historyKey) || '[]');
    history.push({
      action,
      ...details,
      timestamp: new Date().toISOString()
    });
    
    // 只保留最近100条记录
    if (history.length > 100) {
      history.shift();
    }
    
    await this.redis.setex(historyKey, 86400 * 30, JSON.stringify(history));
  }

  async getServiceSleepHistory(serviceName) {
    const historyKey = `sleep-manager:history:${serviceName}`;
    return JSON.parse(await this.redis.get(historyKey) || '[]');
  }

  async calculateCostSavings() {
    const savings = [];
    
    for (const serviceName of Object.keys(this.thresholds)) {
      const history = await this.getServiceSleepHistory(serviceName);
      
      // 计算过去24小时的节省
      const last24h = history.filter(h => {
        const time = new Date(h.timestamp).getTime();
        return Date.now() - time < 86400000;
      });
      
      const totalSleepMinutes = last24h
        .filter(h => h.action === 'sleep')
        .reduce((sum, h) => sum + (h.to - h.from) * 10, 0); // 假设每分钟每副本 $0.001
      
      savings.push({
        service: serviceName,
        sleepMinutes: totalSleepMinutes,
        estimatedSavings: totalSleepMinutes * 0.001
      });
    }
    
    return savings;
  }
}

module.exports = SleepManager;
```

### 3. K8s 配置 - 预热注解

```yaml
# infrastructure/k8s/base/deployments/pokemon-service.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pokemon-service
  annotations:
    sleep.minemine.com/enabled: "true"
    sleep.minemine.com/min-replicas: "0"
    sleep.minemine.com/wake-replicas: "2"
    sleep.minemine.com/cooldown-minutes: "10"
spec:
  replicas: 2
  selector:
    matchLabels:
      app: pokemon-service
  template:
    metadata:
      labels:
        app: pokemon-service
    spec:
      containers:
      - name: pokemon-service
        image: minego/pokemon-service:latest
        resources:
          requests:
            memory: "256Mi"
            cpu: "100m"
          limits:
            memory: "512Mi"
            cpu: "500m"
---
# Horizontal Pod Autoscaler 用于唤醒后自动扩容
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: pokemon-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: pokemon-service
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### 4. 网关层唤醒触发器

```javascript
// backend/gateway/src/middleware/sleepWakeTrigger.js
const { Kafka } = require('kafkajs');
const logger = require('../../shared/logger');

class SleepWakeTrigger {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'sleep-wake-trigger',
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.producer = this.kafka.producer();
    this.initialized = false;
  }

  async init() {
    if (!this.initialized) {
      await this.producer.connect();
      this.initialized = true;
    }
  }

  async checkAndWake(serviceName, req) {
    await this.init();
    
    // 如果请求到休眠服务，触发唤醒
    const sleepingServices = await this.getSleepingServices();
    
    if (sleepingServices.includes(serviceName)) {
      logger.info('Triggering wake for sleeping service', { service: serviceName });
      
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
            timestamp: new Date().toISOString()
          })
        }]
      });
      
      // 返回等待响应或使用备用策略
      return {
        shouldWait: true,
        estimatedWaitTime: 30 // 秒
      };
    }
    
    return { shouldWait: false };
  }

  async getSleepingServices() {
    // 从Redis或服务状态缓存获取休眠服务列表
    const { Redis } = require('../../shared/redis');
    const redis = new Redis();
    
    const sleeping = await redis.smembers('sleeping-services');
    return sleeping || [];
  }
}

// 中间件
function sleepWakeMiddleware(trigger) {
  return async (req, res, next) => {
    const serviceName = getServiceNameFromPath(req.path);
    
    if (serviceName) {
      const result = await trigger.checkAndWake(serviceName, req);
      
      if (result.shouldWait) {
        // 返回 202 Accepted，客户端应稍后重试
        return res.status(202).json({
          error: 'SERVICE_WAKING_UP',
          message: `${serviceName} is starting up, please retry in ${result.estimatedWaitTime} seconds`,
          retryAfter: result.estimatedWaitTime
        });
      }
    }
    
    next();
  };
}

function getServiceNameFromPath(path) {
  const pathMap = {
    '/api/users': 'user-service',
    '/api/location': 'location-service',
    '/api/pokemon': 'pokemon-service',
    '/api/catch': 'catch-service',
    '/api/gym': 'gym-service',
    '/api/social': 'social-service',
    '/api/reward': 'reward-service',
    '/api/payment': 'payment-service'
  };
  
  for (const [prefix, service] of Object.entries(pathMap)) {
    if (path.startsWith(prefix)) {
      return service;
    }
  }
  
  return null;
}

module.exports = { SleepWakeTrigger, sleepWakeMiddleware };
```

### 5. 定时任务 - 预热高峰时段

```javascript
// backend/jobs/peakHourPreheater.js
const { Kafka } = require('kafkajs');
const logger = require('../shared/logger');

class PeakHourPreheater {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'peak-hour-preheater',
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({ groupId: 'peak-hour-preheater' });
    
    this.peakHours = [];
    this.timezone = process.env.TIMEZONE || 'UTC';
  }

  async start() {
    await this.producer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: 'peak-hours-prediction', fromBeginning: false });
    
    // 监听高峰时段预测
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const prediction = JSON.parse(message.value.toString());
        this.peakHours = prediction.peakHours;
        this.timezone = prediction.timezone;
        logger.info('Updated peak hours prediction', { peakHours: this.peakHours });
      }
    });
    
    // 每分钟检查是否接近高峰时段
    setInterval(() => this.checkAndPreheat(), 60000);
  }

  async checkAndPreheat() {
    const now = new Date();
    const localHour = this.getLocalHour(now);
    
    // 提前30分钟预热
    const upcomingHour = (localHour + 1) % 24;
    
    if (this.peakHours.includes(upcomingHour)) {
      const minutesToPeak = (60 - now.getMinutes());
      
      if (minutesToPeak <= 30) {
        logger.info('Approaching peak hour, preheating services', {
          peakHour: upcomingHour,
          minutesToPeak
        });
        
        await this.preheatAllServices();
      }
    }
  }

  getLocalHour(date) {
    const utcHour = date.getUTCHours();
    // 简单时区转换，实际应使用 moment-timezone 或 luxon
    const offset = this.timezone === 'Asia/Shanghai' ? 8 : 0;
    return (utcHour + offset) % 24;
  }

  async preheatAllServices() {
    const services = [
      'user-service',
      'location-service',
      'pokemon-service',
      'catch-service',
      'gym-service',
      'social-service',
      'reward-service',
      'payment-service'
    ];
    
    for (const service of services) {
      await this.producer.send({
        topic: 'sleep-recommendations',
        messages: [{
          key: service,
          value: JSON.stringify({
            service,
            action: 'wake',
            reason: 'Preheating before peak hour',
            currentReplicas: 0,
            suggestedReplicas: 3,
            timestamp: new Date().toISOString()
          })
        }]
      });
    }
  }
}

module.exports = PeakHourPreheater;
```

### 6. 成本节省仪表板 API

```javascript
// backend/gateway/src/routes/costSavingsRoutes.js
const express = require('express');
const router = express.Router();
const SleepManager = require('../../shared/sleepManager');
const TrafficAnalyzer = require('../../shared/trafficAnalyzer');

const sleepManager = new SleepManager();
const trafficAnalyzer = new TrafficAnalyzer();

// 获取成本节省统计
router.get('/api/cost-savings/summary', async (req, res) => {
  try {
    const savings = await sleepManager.calculateCostSavings();
    const totalSavings = savings.reduce((sum, s) => sum + s.estimatedSavings, 0);
    
    res.json({
      totalEstimatedSavings: totalSavings.toFixed(2),
      currency: 'USD',
      period: 'last_24h',
      breakdown: savings,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取服务休眠历史
router.get('/api/cost-savings/history/:serviceName', async (req, res) => {
  try {
    const history = await sleepManager.getServiceSleepHistory(req.params.serviceName);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 获取流量分析
router.get('/api/cost-savings/traffic-analysis', async (req, res) => {
  try {
    const hourlyStats = trafficAnalyzer.getHourlyStats();
    const peakHours = await trafficAnalyzer.predictPeakHours();
    
    res.json({
      hourlyStats,
      peakHours,
      timezone: process.env.TIMEZONE || 'UTC'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 手动触发休眠/唤醒（管理员权限）
router.post('/api/cost-savings/control', async (req, res) => {
  try {
    const { service, action, replicas } = req.body;
    
    // 权限检查
    if (!req.user?.roles?.includes('admin')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    if (action === 'sleep') {
      await sleepManager.sleepService(service, replicas, 'Manual trigger');
    } else if (action === 'wake') {
      await sleepManager.wakeService(service, replicas, 'Manual trigger');
    }
    
    res.json({ success: true, service, action, replicas });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] 流量分析器能够实时收集各服务的请求量和资源使用率
- [ ] 当流量低于阈值持续10分钟以上时，自动缩减服务副本至最小值
- [ ] 当检测到流量回升时，自动扩容服务副本
- [ ] 网关层能检测休眠服务并触发唤醒
- [ ] 高峰时段前30分钟自动预热所有服务
- [ ] 成本节省仪表板正确展示节省统计
- [ ] 休眠/唤醒操作有冷却时间保护，防止频繁切换
- [ ] 所有状态变更记录可追溯
- [ ] 手动触发接口需要管理员权限
- [ ] 单元测试覆盖核心逻辑

## 影响范围

- **新增文件**:
  - `backend/shared/trafficAnalyzer.js` - 流量分析器
  - `backend/shared/sleepManager.js` - 休眠管理器
  - `backend/gateway/src/middleware/sleepWakeTrigger.js` - 网关唤醒触发器
  - `backend/jobs/peakHourPreheater.js` - 高峰时段预热任务
  - `backend/gateway/src/routes/costSavingsRoutes.js` - 成本节省API

- **修改文件**:
  - `infrastructure/k8s/base/deployments/*.yaml` - 添加休眠注解
  - `backend/gateway/src/index.js` - 挂载休眠唤醒中间件

- **依赖服务**:
  - Kubernetes API (需要 RBAC 权限)
  - Redis (状态存储)
  - Kafka (事件流)

## 参考

- [Kubernetes HPA](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [KEDA - Kubernetes Event-driven Autoscaling](https://keda.sh/)
- [AWS Cost Optimization](https://aws.amazon.com/aws-cost-management/aws-cost-optimization/)
- [GCP Cluster Autoscaler](https://cloud.google.com/kubernetes-engine/docs/concepts/cluster-autoscaler)
