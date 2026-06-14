# REQ-00191: 实时业务事件流监控与分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00191 |
| 标题 | 实时业务事件流监控与分析系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-14 11:00 |

## 需求描述

构建一个全面的实时业务事件流监控与分析系统，用于追踪、分析和可视化游戏内的关键业务事件。该系统将实时处理来自各微服务的业务事件（如精灵捕捉、道馆战斗、交易、支付等），提供实时仪表板、异常检测、趋势分析和预警功能。

### 核心目标
1. **实时事件摄取**：从所有微服务实时收集业务事件
2. **事件流处理**：支持复杂事件处理（CEP）和窗口聚合
3. **异常检测**：基于统计模型和机器学习检测业务异常
4. **可视化仪表板**：提供实时业务指标可视化
5. **告警与通知**：支持多渠道告警和升级策略

## 技术方案

### 1. 事件流架构设计

```javascript
// backend/shared/eventStream/EventStreamManager.js
const { Kafka } = require('kafkajs');
const { EventEmitter } = require('events');

class EventStreamManager extends EventEmitter {
  constructor(config) {
    super();
    this.kafka = new Kafka({
      brokers: config.kafkaBrokers,
      clientId: 'minego-event-stream'
    });
    this.producer = this.kafka.producer();
    this.consumer = this.kafka.consumer({ groupId: 'event-stream-processor' });
    this.eventSchemas = new Map();
    this.eventProcessors = new Map();
  }

  // 定义业务事件类型
  static EVENT_TYPES = {
    // 精灵相关
    POKEMON_CATCH: 'pokemon.catch',
    POKEMON_RELEASE: 'pokemon.release',
    POKEMON_EVOLVE: 'pokemon.evolve',
    POKEMON_TRADE: 'pokemon.trade',
    
    // 战斗相关
    GYM_BATTLE_START: 'gym.battle.start',
    GYM_BATTLE_END: 'gym.battle.end',
    PVP_DUEL_START: 'pvp.duel.start',
    PVP_DUEL_END: 'pvp.duel.end',
    
    // 社交相关
    FRIEND_ADD: 'social.friend.add',
    GIFT_SEND: 'social.gift.send',
    
    // 支付相关
    PAYMENT_INITIATED: 'payment.initiated',
    PAYMENT_COMPLETED: 'payment.completed',
    PAYMENT_FAILED: 'payment.failed',
    
    // 用户相关
    USER_LOGIN: 'user.login',
    USER_LOGOUT: 'user.logout',
    USER_REGISTER: 'user.register'
  };

  async initialize() {
    await this.producer.connect();
    await this.consumer.connect();
    
    // 订阅所有业务事件主题
    await this.consumer.subscribe({
      topics: ['minego.events.business', 'minego.events.analytics'],
      fromBeginning: false
    });
    
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const event = JSON.parse(message.value.toString());
        await this.processEvent(event);
      }
    });
  }

  // 发送业务事件
  async emitBusinessEvent(eventType, payload, metadata = {}) {
    const event = {
      eventId: this.generateEventId(),
      eventType,
      timestamp: Date.now(),
      payload,
      metadata: {
        ...metadata,
        serviceName: process.env.SERVICE_NAME,
        serviceVersion: process.env.SERVICE_VERSION,
        traceId: metadata.traceId || this.generateTraceId()
      }
    };

    // 验证事件模式
    await this.validateEventSchema(event);

    // 发送到 Kafka
    await this.producer.send({
      topic: 'minego.events.business',
      messages: [{
        key: event.eventId,
        value: JSON.stringify(event),
        headers: {
          eventType: eventType,
          source: metadata.serviceName || 'unknown'
        }
      }]
    });

    // 本地事件发射
    this.emit(eventType, event);
    
    return event;
  }

  async processEvent(event) {
    try {
      // 更新实时计数器
      await this.updateRealtimeCounters(event);
      
      // 执行复杂事件处理
      await this.executeCEP(event);
      
      // 异常检测
      await this.detectAnomalies(event);
      
      // 存储到时序数据库
      await this.storeToTimeseriesDB(event);
      
    } catch (error) {
      console.error('Event processing error:', error);
      this.emit('processing:error', { event, error });
    }
  }
}

module.exports = EventStreamManager;
```

### 2. 复杂事件处理（CEP）引擎

```javascript
// backend/shared/eventStream/CEPEngine.js
class CEPEngine {
  constructor() {
    this.patterns = new Map();
    this.windows = new Map();
    this.aggregators = new Map();
  }

  // 定义复杂事件模式
  definePattern(patternName, config) {
    this.patterns.set(patternName, {
      name: patternName,
      conditions: config.conditions,
      window: config.window, // 时间窗口
      aggregations: config.aggregations,
      action: config.action
    });
  }

  // 窗口聚合处理
  processWindowEvent(event, patternName) {
    const pattern = this.patterns.get(patternName);
    if (!pattern) return;

    const windowKey = `${patternName}:${Math.floor(Date.now() / pattern.window)}`;
    
    if (!this.windows.has(windowKey)) {
      this.windows.set(windowKey, {
        events: [],
        startTime: Date.now(),
        aggregations: this.initAggregations(pattern.aggregations)
      });
    }

    const windowData = this.windows.get(windowKey);
    windowData.events.push(event);

    // 更新聚合
    this.updateAggregations(windowData, event, pattern.aggregations);

    // 检查模式条件
    if (this.checkConditions(windowData, pattern.conditions)) {
      pattern.action(windowData);
    }

    // 清理过期窗口
    this.cleanupExpiredWindows();
  }

  // 预定义业务模式
  initializeBusinessPatterns(eventEmitter) {
    // 模式1: 5分钟内同一用户捕捉超过50只精灵
    this.definePattern('excessive_catch_rate', {
      window: 5 * 60 * 1000,
      conditions: [
        { type: 'count', field: 'userId', operator: '>', value: 50 }
      ],
      aggregations: [
        { type: 'count', name: 'catchCount', groupBy: 'userId' }
      ],
      action: (windowData) => {
        eventEmitter.emit('alert:suspicious_activity', {
          type: 'excessive_catch',
          data: windowData
        });
      }
    });

    // 模式2: 1小时内支付失败率超过30%
    this.definePattern('high_payment_failure_rate', {
      window: 60 * 60 * 1000,
      conditions: [
        { type: 'ratio', numerator: 'failed', denominator: 'total', operator: '>', value: 0.3 }
      ],
      aggregations: [
        { type: 'count', name: 'total', filter: { eventType: 'payment.*' } },
        { type: 'count', name: 'failed', filter: { eventType: 'payment.failed' } }
      ],
      action: (windowData) => {
        eventEmitter.emit('alert:payment_issue', {
          type: 'high_failure_rate',
          data: windowData
        });
      }
    });

    // 模式3: 10分钟内同一IP注册超过10个账号
    this.definePattern('bulk_registration', {
      window: 10 * 60 * 1000,
      conditions: [
        { type: 'count', field: 'ip', operator: '>', value: 10 }
      ],
      aggregations: [
        { type: 'count', name: 'regCount', groupBy: 'ip' }
      ],
      action: (windowData) => {
        eventEmitter.emit('alert:bulk_registration', {
          type: 'suspicious_ip',
          data: windowData
        });
      }
    });

    // 模式4: 道馆战斗异常连胜
    this.definePattern('abnormal_win_streak', {
      window: 30 * 60 * 1000,
      conditions: [
        { type: 'count', field: 'userId', operator: '>', value: 100 },
        { type: 'custom', check: (data) => data.winRate > 0.95 }
      ],
      aggregations: [
        { type: 'count', name: 'battles', groupBy: 'userId' },
        { type: 'count', name: 'wins', groupBy: 'userId', filter: { result: 'win' } }
      ],
      action: (windowData) => {
        eventEmitter.emit('alert:cheating_suspected', {
          type: 'battle_cheat',
          data: windowData
        });
      }
    });
  }
}

module.exports = CEPEngine;
```

### 3. 实时指标计算与存储

```javascript
// backend/shared/eventStream/MetricsCalculator.js
const { Redis } = require('ioredis');

class MetricsCalculator {
  constructor(redisClient) {
    this.redis = redisClient;
    this.metricDefinitions = this.loadMetricDefinitions();
  }

  loadMetricDefinitions() {
    return {
      // 用户活跃指标
      dau: {
        type: 'unique_count',
        key: 'metrics:dau',
        field: 'userId',
        ttl: 86400 * 7
      },
      mau: {
        type: 'unique_count',
        key: 'metrics:mau',
        field: 'userId',
        ttl: 86400 * 35
      },
      online_users: {
        type: 'unique_count',
        key: 'metrics:online',
        field: 'userId',
        ttl: 300
      },

      // 业务指标
      catch_rate: {
        type: 'ratio',
        numerator: { eventType: 'pokemon.catch' },
        denominator: { eventType: 'pokemon.catch_attempt' },
        window: 3600
      },
      battle_win_rate: {
        type: 'ratio',
        numerator: { eventType: 'gym.battle.end', result: 'win' },
        denominator: { eventType: 'gym.battle.end' },
        window: 3600
      },
      trade_volume: {
        type: 'sum',
        key: 'metrics:trade_volume',
        field: 'amount',
        filter: { eventType: 'pokemon.trade' },
        ttl: 86400
      },

      // 支付指标
      revenue_per_hour: {
        type: 'sum',
        key: 'metrics:revenue:hourly',
        field: 'amount',
        filter: { eventType: 'payment.completed' },
        ttl: 86400 * 30
      },
      arpu: {
        type: 'avg_per_user',
        key: 'metrics:arpu',
        field: 'amount',
        filter: { eventType: 'payment.completed' },
        ttl: 86400 * 30
      }
    };
  }

  async updateMetric(metricName, event) {
    const definition = this.metricDefinitions[metricName];
    if (!definition) return;

    const now = Date.now();
    const timeKey = this.getTimeKey(definition, now);

    switch (definition.type) {
      case 'unique_count':
        await this.redis.pfadd(timeKey, event.payload[definition.field]);
        await this.redis.expire(timeKey, definition.ttl);
        break;

      case 'sum':
        await this.redis.incrbyfloat(timeKey, event.payload[definition.field] || 0);
        await this.redis.expire(timeKey, definition.ttl);
        break;

      case 'counter':
        await this.redis.incr(timeKey);
        await this.redis.expire(timeKey, definition.ttl);
        break;

      case 'ratio':
        // 使用 HyperLogLog 和计数器组合
        const numeratorKey = `${metricName}:numerator:${timeKey}`;
        const denominatorKey = `${metricName}:denominator:${timeKey}`;
        
        if (this.matchFilter(event, definition.numerator)) {
          await this.redis.incr(numeratorKey);
        }
        if (this.matchFilter(event, definition.denominator)) {
          await this.redis.incr(denominatorKey);
        }
        break;
    }
  }

  async getMetric(metricName, timeRange = 'current') {
    const definition = this.metricDefinitions[metricName];
    if (!definition) return null;

    const timeKey = this.getTimeKey(definition, Date.now());

    switch (definition.type) {
      case 'unique_count':
        return await this.redis.pfcount(timeKey);

      case 'sum':
      case 'counter':
        return parseFloat(await this.redis.get(timeKey) || 0);

      case 'ratio':
        const numerator = parseFloat(
          await this.redis.get(`${metricName}:numerator:${timeKey}`) || 0
        );
        const denominator = parseFloat(
          await this.redis.get(`${metricName}:denominator:${timeKey}`) || 1
        );
        return denominator > 0 ? numerator / denominator : 0;

      default:
        return null;
    }
  }

  async getAllCurrentMetrics() {
    const metrics = {};
    for (const metricName of Object.keys(this.metricDefinitions)) {
      metrics[metricName] = await this.getMetric(metricName);
    }
    return metrics;
  }
}

module.exports = MetricsCalculator;
```

### 4. 异常检测引擎

```javascript
// backend/shared/eventStream/AnomalyDetector.js
class AnomalyDetector {
  constructor(config) {
    this.baselines = new Map();
    this.algorithms = {
      zscore: this.zscoreDetection.bind(this),
      moving_average: this.movingAverageDetection.bind(this),
      percentile: this.percentileDetection.bind(this)
    };
  }

  // 基于Z-score的异常检测
  async zscoreDetection(metricName, currentValue, history) {
    if (history.length < 10) return { isAnomaly: false };

    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    const variance = history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / history.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return { isAnomaly: false };

    const zScore = Math.abs((currentValue - mean) / stdDev);
    
    return {
      isAnomaly: zScore > 3,
      zScore,
      mean,
      stdDev,
      confidence: Math.min(1, zScore / 3)
    };
  }

  // 移动平均异常检测
  async movingAverageDetection(metricName, currentValue, history, windowSize = 10) {
    if (history.length < windowSize) return { isAnomaly: false };

    const recentValues = history.slice(-windowSize);
    const movingAvg = recentValues.reduce((a, b) => a + b, 0) / windowSize;
    const threshold = movingAvg * 0.3; // 30% 偏差阈值

    const deviation = Math.abs(currentValue - movingAvg);
    
    return {
      isAnomaly: deviation > threshold,
      deviation,
      movingAvg,
      threshold,
      confidence: Math.min(1, deviation / threshold)
    };
  }

  // 百分位异常检测
  async percentileDetection(metricName, currentValue, history) {
    if (history.length < 20) return { isAnomaly: false };

    const sorted = [...history].sort((a, b) => a - b);
    const p5 = this.percentile(sorted, 5);
    const p95 = this.percentile(sorted, 95);

    const isAnomaly = currentValue < p5 || currentValue > p95;
    
    return {
      isAnomaly,
      lowerBound: p5,
      upperBound: p95,
      isLow: currentValue < p5,
      isHigh: currentValue > p95,
      confidence: isAnomaly ? 
        Math.max(
          Math.abs(currentValue - p5) / p5,
          Math.abs(currentValue - p95) / p95
        ) : 0
    };
  }

  percentile(arr, p) {
    const index = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, index)];
  }

  async detect(metricName, currentValue, algorithm = 'zscore') {
    const history = await this.getMetricHistory(metricName);
    const detector = this.algorithms[algorithm];
    
    if (!detector) {
      throw new Error(`Unknown algorithm: ${algorithm}`);
    }

    return await detector(metricName, currentValue, history);
  }

  async getMetricHistory(metricName) {
    // 从时序数据库获取历史数据
    // 实现略...
    return [];
  }
}

module.exports = AnomalyDetector;
```

### 5. 实时仪表板 WebSocket 服务

```javascript
// backend/shared/eventStream/DashboardService.js
const WebSocket = require('ws');

class DashboardService {
  constructor(server, eventStreamManager, metricsCalculator) {
    this.wss = new WebSocket.Server({ server, path: '/ws/dashboard' });
    this.eventStream = eventStreamManager;
    this.metrics = metricsCalculator;
    this.clients = new Map();
    
    this.initialize();
  }

  initialize() {
    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      
      this.clients.set(clientId, {
        ws,
        subscriptions: new Set(['metrics', 'alerts']),
        lastPing: Date.now()
      });

      ws.on('message', (message) => {
        this.handleMessage(clientId, JSON.parse(message));
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });

      // 发送初始数据
      this.sendInitialData(ws);
    });

    // 订阅事件流，广播给客户端
    this.eventStream.on('metrics:updated', (data) => {
      this.broadcast('metrics', data);
    });

    this.eventStream.on('alert', (alert) => {
      this.broadcast('alerts', alert);
    });

    // 定期推送指标更新
    setInterval(() => {
      this.pushMetricsUpdate();
    }, 5000);
  }

  async sendInitialData(ws) {
    const metrics = await this.metrics.getAllCurrentMetrics();
    
    ws.send(JSON.stringify({
      type: 'initial',
      data: {
        metrics,
        timestamp: Date.now()
      }
    }));
  }

  async pushMetricsUpdate() {
    const metrics = await this.metrics.getAllCurrentMetrics();
    
    this.broadcast('metrics', {
      metrics,
      timestamp: Date.now()
    });
  }

  broadcast(type, data) {
    const message = JSON.stringify({ type, data });
    
    this.clients.forEach((client, clientId) => {
      if (client.subscriptions.has(type) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    });
  }

  handleMessage(clientId, message) {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.action) {
      case 'subscribe':
        client.subscriptions.add(message.channel);
        break;
      case 'unsubscribe':
        client.subscriptions.delete(message.channel);
        break;
      case 'ping':
        client.lastPing = Date.now();
        client.ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  }
}

module.exports = DashboardService;
```

### 6. K8s 部署配置

```yaml
# infrastructure/k8s/monitoring/event-stream.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: event-stream-processor
  namespace: minego-monitoring
spec:
  replicas: 3
  selector:
    matchLabels:
      app: event-stream-processor
  template:
    metadata:
      labels:
        app: event-stream-processor
    spec:
      containers:
      - name: processor
        image: minego/event-stream-processor:latest
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
        env:
        - name: KAFKA_BROKERS
          valueFrom:
            configMapKeyRef:
              name: kafka-config
              key: brokers
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: redis-secret
              key: url
        - name: TIMESERIES_DB_URL
          valueFrom:
            secretKeyRef:
              name: timeseries-secret
              key: url
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: event-stream-processor-hpa
  namespace: minego-monitoring
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: event-stream-processor
  minReplicas: 3
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: External
    external:
      metric:
        name: kafka_consumer_lag
        selector:
          matchLabels:
            topic: minego.events.business
      target:
        type: AverageValue
        averageValue: "1000"
```

### 7. 前端仪表板组件

```javascript
// frontend/game-client/src/components/EventStreamDashboard.jsx
import React, { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

const EventStreamDashboard = () => {
  const [metrics, setMetrics] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [connected, setConnected] = useState(false);
  const [ws, setWs] = useState(null);

  useEffect(() => {
    const websocket = new WebSocket(`${WS_BASE_URL}/ws/dashboard`);
    
    websocket.onopen = () => {
      setConnected(true);
      websocket.send(JSON.stringify({ action: 'subscribe', channel: 'metrics' }));
      websocket.send(JSON.stringify({ action: 'subscribe', channel: 'alerts' }));
    };

    websocket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      switch (message.type) {
        case 'initial':
        case 'metrics':
          setMetrics(prev => ({
            ...prev,
            ...message.data.metrics,
            lastUpdate: message.data.timestamp
          }));
          break;
        case 'alerts':
          setAlerts(prev => [message.data, ...prev].slice(0, 50));
          break;
      }
    };

    websocket.onclose = () => setConnected(false);
    
    setWs(websocket);

    return () => websocket.close();
  }, []);

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <h2>实时业务监控</h2>
        <span className={`connection-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? '已连接' : '断开连接'}
        </span>
      </div>

      <div className="metrics-grid">
        <MetricCard 
          title="日活跃用户 (DAU)" 
          value={metrics.dau?.toLocaleString()} 
          icon="users" 
        />
        <MetricCard 
          title="在线用户" 
          value={metrics.online_users?.toLocaleString()} 
          icon="wifi" 
        />
        <MetricCard 
          title="小时收入" 
          value={`$${(metrics.revenue_per_hour || 0).toFixed(2)}`} 
          icon="dollar" 
        />
        <MetricCard 
          title="捕捉成功率" 
          value={`${((metrics.catch_rate || 0) * 100).toFixed(1)}%`} 
          icon="target" 
        />
      </div>

      <div className="alerts-section">
        <h3>实时告警</h3>
        <div className="alerts-list">
          {alerts.map((alert, index) => (
            <AlertItem key={index} alert={alert} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default EventStreamDashboard;
```

## 验收标准

- [ ] 所有微服务成功接入事件流系统，事件发送延迟 < 100ms
- [ ] Kafka 主题创建完成，分区配置合理，支持水平扩展
- [ ] CEP 引擎成功识别预定义的4种业务异常模式
- [ ] 实时指标计算准确，与离线计算误差 < 1%
- [ ] Z-score 异常检测算法正确实现，召回率 > 90%
- [ ] WebSocket 仪表板成功连接并实时更新，延迟 < 1s
- [ ] K8s HPA 配置生效，能根据 Kafka 消费延迟自动扩缩容
- [ ] 告警通知成功发送至多渠道（邮件、Slack、短信）
- [ ] 集成测试覆盖所有核心场景，覆盖率 > 80%
- [ ] 文档完整，包含架构图、API 文档、运维手册

## 影响范围

- backend/shared/eventStream/ - 新增事件流核心模块
- backend/services/*/src/index.js - 所有微服务集成事件发送
- infrastructure/k8s/monitoring/ - 新增 K8s 部署配置
- frontend/game-client/src/components/ - 新增仪表板组件
- docs/architecture/event-stream.md - 新增架构文档

## 参考

- [Kafka Streams 文档](https://kafka.apache.org/documentation/streams/)
- [复杂事件处理模式](https://www.oreilly.com/library/view/real-time-event-processing/9781491987392/)
- [时序数据库最佳实践](https://prometheus.io/docs/practices/)
- [WebSocket 实时通信](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
