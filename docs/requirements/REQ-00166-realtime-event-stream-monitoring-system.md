# REQ-00166: 实时业务事件流监控与分析系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00166 |
| 标题 | 实时业务事件流监控与分析系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-13 19:00 |

## 需求描述

构建一个实时业务事件流监控与分析系统，对游戏中发生的各类业务事件（捕捉、战斗、交易、社交互动等）进行实时采集、处理、分析和可视化。该系统将帮助运营团队实时了解游戏状态、发现异常模式、优化游戏体验。

### 核心功能
1. **事件采集管道**：从各微服务实时收集业务事件
2. **流式处理引擎**：对事件流进行实时聚合、过滤、转换
3. **实时分析仪表板**：可视化展示关键业务指标
4. **异常检测与告警**：自动识别异常事件模式并触发告警
5. **历史事件查询**：支持对历史事件数据进行查询和分析

## 技术方案

### 1. 事件采集层

```javascript
// backend/shared/eventStream/EventCollector.js
const { Kafka } = require('kafkajs');

class EventCollector {
  constructor() {
    this.kafka = new Kafka({
      clientId: 'minego-event-collector',
      brokers: process.env.KAFKA_BROKERS.split(',')
    });
    this.producer = this.kafka.producer();
  }

  async emitEvent(eventType, payload, metadata = {}) {
    const event = {
      id: uuidv4(),
      type: eventType,
      payload,
      metadata: {
        ...metadata,
        timestamp: Date.now(),
        service: process.env.SERVICE_NAME,
        version: process.env.SERVICE_VERSION
      }
    };

    await this.producer.send({
      topic: `events.${eventType.split('.')[0]}`,
      messages: [{
        key: event.id,
        value: JSON.stringify(event)
      }]
    });

    return event;
  }
}

module.exports = EventCollector;
```

### 2. 流式处理引擎

```javascript
// backend/shared/eventStream/StreamProcessor.js
const { Kafka: KafkaClient } = require('kafkajs');
const Redis = require('ioredis');

class StreamProcessor {
  constructor() {
    this.kafka = new KafkaClient({
      clientId: 'stream-processor',
      brokers: process.env.KAFKA_BROKERS.split(',')
    });
    this.redis = new Redis(process.env.REDIS_URL);
    this.aggregators = new Map();
  }

  // 实时聚合器
  registerAggregator(name, config) {
    this.aggregators.set(name, {
      windowSize: config.windowSize || 60000, // 1分钟窗口
      aggregation: config.aggregation,
      output: config.output
    });
  }

  // 滑动窗口统计
  async aggregateEvents(events, windowKey) {
    const stats = {
      count: events.length,
      unique_users: new Set(events.map(e => e.metadata.userId)).size,
      by_type: {},
      time_series: []
    };

    events.forEach(event => {
      const type = event.type;
      stats.by_type[type] = (stats.by_type[type] || 0) + 1;
    });

    return stats;
  }

  // 异常检测
  detectAnomalies(currentStats, historicalBaseline) {
    const anomalies = [];
    
    for (const [key, value] of Object.entries(currentStats)) {
      const baseline = historicalBaseline[key] || { mean: 0, stdDev: 0 };
      const zScore = (value - baseline.mean) / (baseline.stdDev || 1);
      
      if (Math.abs(zScore) > 3) {
        anomalies.push({
          metric: key,
          value,
          expected: baseline.mean,
          zScore,
          severity: Math.abs(zScore) > 5 ? 'critical' : 'warning'
        });
      }
    }
    
    return anomalies;
  }
}

module.exports = StreamProcessor;
```

### 3. 事件类型定义

```javascript
// backend/shared/eventStream/eventTypes.js
const EventTypes = {
  // 捕捉相关
  CATCH_SUCCESS: 'catch.success',
  CATCH_FAIL: 'catch.fail',
  CATCH_ESCAPED: 'catch.escaped',
  
  // 战斗相关
  BATTLE_START: 'battle.start',
  BATTLE_END: 'battle.end',
  BATTLE_WIN: 'battle.win',
  BATTLE_LOSE: 'battle.lose',
  
  // 社交相关
  TRADE_INITIATED: 'trade.initiated',
  TRADE_COMPLETED: 'trade.completed',
  FRIEND_ADDED: 'friend.added',
  
  // 支付相关
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_SUCCESS: 'payment.success',
  PAYMENT_FAILED: 'payment.fail',
  
  // 用户行为
  USER_LOGIN: 'user.login',
  USER_LOGOUT: 'user.logout',
  USER_LEVEL_UP: 'user.levelup',
  
  // 系统事件
  SERVER_ERROR: 'system.error',
  PERFORMANCE_WARNING: 'system.performance'
};

module.exports = EventTypes;
```

### 4. 实时仪表板 API

```javascript
// backend/services/admin-dashboard/src/routes/eventStream.js
const express = require('express');
const router = express.Router();
const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL);

// 获取实时统计
router.get('/stats/realtime', async (req, res) => {
  const stats = await redis.multi()
    .get('events:stats:minute')
    .get('events:stats:hour')
    .get('events:stats:anomalies')
    .exec();
  
  res.json({
    minute: JSON.parse(stats[0][1] || '{}'),
    hour: JSON.parse(stats[1][1] || '{}'),
    anomalies: JSON.parse(stats[2][1] || '[]'),
    timestamp: Date.now()
  });
});

// 获取事件流（WebSocket 支持）
router.get('/stream', (req, res) => {
  res.json({
    ws_url: `${process.env.WS_URL}/events/stream`,
    topics: ['catch', 'battle', 'trade', 'payment', 'user']
  });
});

// 历史事件查询
router.post('/query', async (req, res) => {
  const { eventType, startTime, endTime, userId, limit = 100 } = req.body;
  
  // 查询 Elasticsearch 或 TimescaleDB
  const events = await queryHistoricalEvents({
    eventType,
    startTime,
    endTime,
    userId,
    limit
  });
  
  res.json(events);
});

module.exports = router;
```

### 5. K8s 部署配置

```yaml
# infrastructure/k8s/monitoring/event-stream-processor.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: event-stream-processor
  namespace: monitoring
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
        image: minego/event-processor:latest
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
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: event-processor-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: event-stream-processor
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

### 6. Grafana 仪表板配置

```json
{
  "dashboard": {
    "title": "Real-time Business Events",
    "panels": [
      {
        "title": "Events per Minute",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(minego_events_total[1m])",
            "legendFormat": "{{event_type}}"
          }
        ]
      },
      {
        "title": "Active Users (Real-time)",
        "type": "stat",
        "targets": [
          {
            "expr": "minego_active_users_realtime"
          }
        ]
      },
      {
        "title": "Anomaly Score",
        "type": "gauge",
        "targets": [
          {
            "expr": "minego_anomaly_score"
          }
        ]
      },
      {
        "title": "Event Distribution",
        "type": "piechart",
        "targets": [
          {
            "expr": "sum by (event_type)(minego_events_total)"
          }
        ]
      }
    ]
  }
}
```

## 验收标准

- [ ] 所有微服务集成事件采集器，关键业务事件发送到 Kafka
- [ ] 流式处理引擎实现 1 分钟滑动窗口聚合
- [ ] 异常检测算法能够识别流量异常（z-score > 3 自动告警）
- [ ] Grafana 仪表板展示实时业务指标（刷新频率 ≤ 10秒）
- [ ] 历史事件查询 API 支持 30 天内数据检索（响应时间 < 2秒）
- [ ] WebSocket 实时推送支持至少 100 个并发连接
- [ ] 事件处理延迟 P99 < 500ms
- [ ] 系统可用性 ≥ 99.9%

## 影响范围

- **新增文件**：
  - `backend/shared/eventStream/EventCollector.js`
  - `backend/shared/eventStream/StreamProcessor.js`
  - `backend/shared/eventStream/eventTypes.js`
  - `backend/services/admin-dashboard/src/routes/eventStream.js`
  - `infrastructure/k8s/monitoring/event-stream-processor.yaml`
  
- **修改文件**：
  - 各微服务业务逻辑中集成事件发送
  - `infrastructure/k8s/monitoring/grafana/dashboards/` 新增仪表板

## 参考

- [Kafka Streams 架构设计](https://kafka.apache.org/documentation/streams/)
- [Redis Stream 实时处理](https://redis.io/topics/streams-intro)
- [Grafana 实时仪表板最佳实践](https://grafana.com/docs/grafana/latest/dashboards/)
- [异常检测算法：Z-Score 与统计方法](https://en.wikipedia.org/wiki/Standard_score)
