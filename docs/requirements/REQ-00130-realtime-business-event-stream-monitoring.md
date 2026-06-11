# REQ-00130：实时业务事件流监控与分析系统

- **编号**：REQ-00130
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring
- **创建时间**：2026-06-11 22:00
- **依赖需求**：REQ-00023（分布式链路追踪与 Jaeger 集成）、REQ-00002（结构化日志与 Prometheus 指标集成）

## 1. 背景与问题

当前 mineGo 项目已具备基础的监控能力：
- Prometheus 指标收集（延迟、错误率、吞吐量）
- 结构化日志（包含 traceId）
- 分布式链路追踪（Jaeger）

**但缺少业务层面的实时监控能力**：
1. **业务事件无统一收集**：捕捉成功、道馆占领、交易完成等关键业务事件散落在各服务日志中，无法统一查询和分析
2. **业务异常难以及时发现**：某类型精灵捕捉率异常下降、交易失败率突然上升等业务问题无法实时告警
3. **运营决策缺乏数据支持**：无法实时查看活跃玩家数、精灵分布热力图、道具消耗趋势等业务指标
4. **事后分析困难**：发生业务问题时，难以快速定位相关事件链路，需要跨服务日志查询

## 2. 目标

建立完整的业务事件流监控体系，实现：
1. **统一事件收集**：所有业务事件通过 Kafka 汇聚到事件流平台
2. **实时业务指标**：提供 20+ 业务指标的实时仪表板（活跃玩家、捕捉统计、交易量、支付金额等）
3. **智能告警**：基于业务规则的异常检测（如：某区域捕捉率下降 50% 触发告警）
4. **事件查询与回溯**：支持按时间、类型、用户、地理位置等维度查询历史业务事件

**预期收益**：
- 业务异常发现时间从小时级降至分钟级
- 运营决策响应速度提升 5 倍
- 问题定位时间缩短 80%

## 3. 范围

### 包含
- 业务事件定义与分类体系（8 大类 50+ 事件类型）
- 事件生产者 SDK（集成到各微服务）
- Kafka Topic 设计与分区策略
- 事件消费者服务（写入 ClickHouse 时序数据库）
- 实时聚合引擎（Flink 或自研）
- 业务指标计算服务（Prometheus + 自定义指标）
- Grafana 业务仪表板（8 个仪表板）
- 业务告警规则（15+ 规则）
- 事件查询 API（5 个端点）
- 管理后台集成（admin-dashboard）

### 不包含
- 用户行为分析平台（未来可扩展）
- AI 预测模型（如预测流失用户）
- 数据仓库建设（ETL 流程）

## 4. 详细需求

### 4.1 业务事件分类体系

```javascript
// backend/shared/events/businessEvents.js
const EVENT_TYPES = {
  // 1. 用户行为
  USER: {
    REGISTER: 'user.register',
    LOGIN: 'user.login',
    LOGOUT: 'user.logout',
    LEVEL_UP: 'user.level_up',
    ACHIEVEMENT_UNLOCK: 'user.achievement_unlock'
  },
  
  // 2. 精灵捕捉
  CATCH: {
    ATTEMPT: 'catch.attempt',
    SUCCESS: 'catch.success',
    FAIL: 'catch.fail',
    ESCAPE: 'catch.escape',
    CRITICAL: 'catch.critical'  // 暴击捕捉
  },
  
  // 3. 道馆战斗
  GYM: {
    RAID_START: 'gym.raid_start',
    RAID_WIN: 'gym.raid_win',
    RAID_FAIL: 'gym.raid_fail',
    BATTLE_WIN: 'gym.battle_win',
    BATTLE_FAIL: 'gym.battle_fail',
    GYM_CAPTURE: 'gym.gym_capture'
  },
  
  // 4. 精灵交易
  TRADE: {
    INITIATE: 'trade.initiate',
    COMPLETE: 'trade.complete',
    CANCEL: 'trade.cancel',
    STARDEXCHANGE: 'trade.stardust_exchange'
  },
  
  // 5. 支付
  PAYMENT: {
    ORDER_CREATE: 'payment.order_create',
    ORDER_SUCCESS: 'payment.order_success',
    ORDER_FAIL: 'payment.order_fail',
    REFUND: 'payment.refund'
  },
  
  // 6. 社交互动
  SOCIAL: {
    FRIEND_ADD: 'social.friend_add',
    GIFT_SEND: 'social.gift_send',
    GIFT_OPEN: 'social.gift_open',
    GUILD_JOIN: 'social.guild_join',
    GUILD_LEAVE: 'social.guild_leave'
  },
  
  // 7. 道具使用
  ITEM: {
    USE: 'item.use',
    PURCHASE: 'item.purchase',
    REWARD: 'item.reward'
  },
  
  // 8. PVP 对战
  PVP: {
    MATCH_START: 'pvp.match_start',
    MATCH_END: 'pvp.match_end',
    RANK_CHANGE: 'pvp.rank_change'
  }
};
```

### 4.2 事件生产者 SDK

```javascript
// backend/shared/BusinessEventProducer.js
class BusinessEventProducer {
  constructor() {
    this.kafka = new Kafka({
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.producer = this.kafka.producer();
    this.connected = false;
  }
  
  async connect() {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
    }
  }
  
  /**
   * 发送业务事件
   * @param {string} eventType - 事件类型（如 'catch.success'）
   * @param {Object} payload - 事件数据
   * @param {Object} context - 上下文信息
   */
  async emit(eventType, payload, context = {}) {
    const event = {
      id: uuidv4(),
      type: eventType,
      category: eventType.split('.')[0], // catch, gym, trade...
      timestamp: new Date().toISOString(),
      payload,
      context: {
        userId: context.userId,
        deviceId: context.deviceId,
        ip: context.ip,
        location: context.location, // { lat, lng }
        appVersion: context.appVersion,
        platform: context.platform, // ios/android
        traceId: context.traceId,
        ...context
      }
    };
    
    // 根据事件类别选择分区
    const partitionKey = context.userId || event.id;
    
    await this.producer.send({
      topic: 'business-events',
      messages: [{
        key: partitionKey,
        value: JSON.stringify(event),
        headers: {
          'event-type': eventType,
          'event-category': event.category
        }
      }]
    });
    
    // Prometheus 指标
    businessEventsTotal.inc({ type: eventType });
    
    logger.debug({ eventType, eventId: event.id }, 'Business event emitted');
    
    return event.id;
  }
}
```

### 4.3 Kafka Topic 设计

```yaml
# infrastructure/k8s/kafka/business-events-topics.yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: business-events
  namespace: kafka
spec:
  partitions: 12  # 按用户 ID 分区，保证同用户事件有序
  replicas: 3
  config:
    retention.ms: 604800000  # 7 天
    compression.type: lz4
    segment.bytes: 1073741824  # 1GB
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: business-events-aggregated
  namespace: kafka
spec:
  partitions: 3
  replicas: 3
  config:
    retention.ms: 2592000000  # 30 天（聚合数据）
    compression.type: lz4
```

### 4.4 事件消费者与存储

```javascript
// backend/services/event-processor/src/index.js
const { Kafka } = require('kafkajs');
const { ClickHouse } = require('@clickhouse/client');

class BusinessEventConsumer {
  constructor() {
    this.kafka = new Kafka({
      brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092']
    });
    this.consumer = this.kafka.consumer({ 
      groupId: 'business-event-processor',
      fromBeginning: false
    });
    
    this.clickhouse = new ClickHouse({
      host: process.env.CLICKHOUSE_HOST || 'http://localhost:8123',
      database: 'minego_events'
    });
  }
  
  async start() {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: 'business-events', fromBeginning: false });
    
    await this.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const event = JSON.parse(message.value.toString());
        
        // 写入 ClickHouse
        await this.clickhouse.insert({
          table: 'business_events',
          values: [{
            id: event.id,
            type: event.type,
            category: event.category,
            timestamp: event.timestamp,
            user_id: event.context.userId,
            device_id: event.context.deviceId,
            location_lat: event.context.location?.lat,
            location_lng: event.context.location?.lng,
            payload: JSON.stringify(event.payload),
            context: JSON.stringify(event.context)
          }],
          format: 'JSONEachRow'
        });
        
        // 更新实时聚合指标
        await this.updateRealtimeMetrics(event);
        
        logger.debug({ eventId: event.id, type: event.type }, 'Event processed');
      }
    });
  }
  
  async updateRealtimeMetrics(event) {
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const key = `metrics:${event.category}:${minute}`;
    
    // Redis 实时计数
    await redis.hincrby(key, event.type, 1);
    await redis.expire(key, 3600);  // 1 小时过期
    
    // Prometheus 指标
    businessEventsByCategory.inc({ category: event.category });
  }
}
```

### 4.5 ClickHouse 表结构

```sql
-- database/migrations/20260611_220000__create_business_events_table.sql
CREATE DATABASE IF NOT EXISTS minego_events;

CREATE TABLE IF NOT EXISTS minego_events.business_events (
  id String,
  type String,
  category String,
  timestamp DateTime64(3),
  user_id String,
  device_id String,
  location_lat Float32,
  location_lng Float32,
  payload String,  -- JSON
  context String,  -- JSON
  date Date DEFAULT toDate(timestamp)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (category, type, timestamp, user_id)
TTL date + INTERVAL 90 DAY;  -- 保留 90 天

-- 聚合物化视图（按小时）
CREATE MATERIALIZED VIEW IF NOT EXISTS minego_events.events_hourly
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (category, type, hour)
AS SELECT
  category,
  type,
  toStartOfHour(timestamp) AS hour,
  count() AS event_count,
  uniq(user_id) AS unique_users
FROM minego_events.business_events
GROUP BY category, type, hour;

-- 聚合物化视图（按天）
CREATE MATERIALIZED VIEW IF NOT EXISTS minego_events.events_daily
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (category, type, day)
AS SELECT
  category,
  type,
  toDate(timestamp) AS day,
  count() AS event_count,
  uniq(user_id) AS unique_users
FROM minego_events.business_events
GROUP BY category, type, day;
```

### 4.6 实时业务指标计算

```javascript
// backend/shared/businessMetrics.js
const client = require('prom-client');

// 业务指标定义
const businessMetrics = {
  // 活跃用户数
  activeUsers: new client.Gauge({
    name: 'minego_active_users',
    help: '当前活跃用户数（5分钟窗口）',
    labelNames: ['platform']
  }),
  
  // 捕捉成功率
  catchSuccessRate: new client.Gauge({
    name: 'minego_catch_success_rate',
    help: '精灵捕捉成功率',
    labelNames: ['species_type', 'rarity']
  }),
  
  // 道馆占领数
  gymCaptures: new client.Gauge({
    name: 'minego_gym_captures_total',
    help: '道馆占领总数',
    labelNames: ['team']
  }),
  
  // 交易量
  tradeVolume: new client.Counter({
    name: 'minego_trade_volume_total',
    help: '交易完成总数',
    labelNames: ['trade_type']
  }),
  
  // 支付金额
  paymentAmount: new client.Counter({
    name: 'minego_payment_amount_total',
    help: '支付总金额（分）',
    labelNames: ['currency', 'product_type']
  }),
  
  // PVP 对战数
  pvpMatches: new client.Counter({
    name: 'minego_pvp_matches_total',
    help: 'PVP 对战总数',
    labelNames: ['battle_type', 'result']
  }),
  
  // 事件吞吐量
  eventThroughput: new client.Histogram({
    name: 'minego_event_throughput_seconds',
    help: '事件处理吞吐量',
    labelNames: ['event_category'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5]
  }),
  
  // 地理分布
  eventsByRegion: new client.Gauge({
    name: 'minego_events_by_region',
    help: '各地区事件数量',
    labelNames: ['region', 'event_type']
  })
};

class BusinessMetricsCalculator {
  constructor() {
    this.redis = new Redis(process.env.REDIS_URL);
  }
  
  async calculate() {
    // 活跃用户数（5分钟内）
    const activeUsers = await this.redis.pfcount('active_users:5min');
    businessMetrics.activeUsers.set({}, activeUsers);
    
    // 捕捉成功率（最近 1 小时）
    const catchAttempts = await this.redis.get('events:catch.attempt:1h') || 0;
    const catchSuccesses = await this.redis.get('events:catch.success:1h') || 0;
    const rate = catchAttempts > 0 ? catchSuccesses / catchAttempts : 0;
    businessMetrics.catchSuccessRate.set({}, rate);
    
    // 道馆占领数（实时查询数据库）
    const { rows: [{ count: gymCount }] } = await query(`
      SELECT COUNT(*)::int 
      FROM gyms 
      WHERE occupied_at IS NOT NULL
    `);
    businessMetrics.gymCaptures.set({ team: 'all' }, gymCount);
    
    logger.debug('Business metrics calculated');
  }
  
  start() {
    // 每分钟计算一次
    setInterval(() => this.calculate(), 60000);
    this.calculate();  // 立即执行一次
  }
}

module.exports = { businessMetrics, BusinessMetricsCalculator };
```

### 4.7 Grafana 业务仪表板

```json
// infrastructure/k8s/monitoring/grafana-dashboards/business-overview.json
{
  "dashboard": {
    "title": "mineGo 业务概览",
    "panels": [
      {
        "title": "活跃用户数（实时）",
        "type": "stat",
        "targets": [{
          "expr": "minego_active_users",
          "legendFormat": "当前活跃"
        }],
        "gridPos": { "x": 0, "y": 0, "w": 6, "h": 4 }
      },
      {
        "title": "捕捉成功率（1小时）",
        "type": "gauge",
        "targets": [{
          "expr": "minego_catch_success_rate * 100",
          "legendFormat": "成功率 %"
        }],
        "gridPos": { "x": 6, "y": 0, "w": 6, "h": 4 }
      },
      {
        "title": "事件吞吐量（每分钟）",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(minego_event_throughput_seconds_count[1m])",
            "legendFormat": "{{event_category}}"
          }
        ],
        "gridPos": { "x": 0, "y": 4, "w": 12, "h": 6 }
      },
      {
        "title": "支付金额趋势（24小时）",
        "type": "graph",
        "targets": [{
          "expr": "rate(minego_payment_amount_total[1h])",
          "legendFormat": "{{currency}}"
        }],
        "gridPos": { "x": 0, "y": 10, "w": 12, "h": 6 }
      },
      {
        "title": "地理热力图",
        "type": "grafana-worldmap-panel",
        "targets": [{
          "expr": "minego_events_by_region",
          "legendFormat": "{{region}}"
        }],
        "gridPos": { "x": 0, "y": 16, "w": 12, "h": 8 }
      }
    ]
  }
}
```

### 4.8 业务告警规则

```yaml
# infrastructure/k8s/monitoring/prometheus-business-rules.yml
groups:
  - name: minego_business_alerts
    interval: 30s
    rules:
      # 活跃用户数骤降
      - alert: ActiveUsersDropped
        expr: |
          (minego_active_users - minego_active_users offset 10m) / minego_active_users offset 10m < -0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "活跃用户数骤降超过 30%"
          description: "当前 {{ $value | humanizePercentage }}"
      
      # 捕捉成功率异常低
      - alert: CatchSuccessRateLow
        expr: minego_catch_success_rate < 0.2
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "捕捉成功率异常低（< 20%）"
          description: "当前 {{ $value | humanizePercentage }}"
      
      # 交易失败率异常高
      - alert: TradeFailureRateHigh
        expr: |
          rate(minego_trade_volume_total{trade_type="fail"}[10m]) /
          rate(minego_trade_volume_total[10m]) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "交易失败率超过 10%"
      
      # 支付成功率下降
      - alert: PaymentSuccessRateDropped
        expr: |
          (rate(minego_payment_amount_total{status="success"}[1h]) -
           rate(minego_payment_amount_total{status="success"}[1h] offset 1h)) < 0
        for: 30m
        labels:
          severity: critical
        annotations:
          summary: "支付成功率持续下降"
          description: "1小时内下降趋势明显"
      
      # 某区域事件量异常
      - alert: RegionEventAnomaly
        expr: |
          abs((minego_events_by_region - minego_events_by_region offset 1h) / 
              minego_events_by_region offset 1h) > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "区域 {{ $labels.region }} 事件量异常波动"
```

### 4.9 事件查询 API

```javascript
// backend/gateway/src/routes/businessEvents.js
const router = express.Router();

/**
 * @route   GET /api/events
 * @desc    查询业务事件
 * @query   type - 事件类型（可选）
 * @query   category - 事件类别（可选）
 * @query   userId - 用户 ID（可选）
 * @query   startTime - 开始时间（ISO 8601）
 * @query   endTime - 结束时间（ISO 8601）
 * @query   limit - 返回数量（默认 100）
 */
router.get('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { type, category, userId, startTime, endTime, limit = 100 } = req.query;
    
    let sql = 'SELECT * FROM minego_events.business_events WHERE 1=1';
    const params = [];
    
    if (type) {
      sql += ` AND type = ?`;
      params.push(type);
    }
    if (category) {
      sql += ` AND category = ?`;
      params.push(category);
    }
    if (userId) {
      sql += ` AND user_id = ?`;
      params.push(userId);
    }
    if (startTime) {
      sql += ` AND timestamp >= ?`;
      params.push(startTime);
    }
    if (endTime) {
      sql += ` AND timestamp <= ?`;
      params.push(endTime);
    }
    
    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(parseInt(limit));
    
    const events = await clickhouse.query(sql, params).toPromise();
    
    res.json(successResp({ events, total: events.length }));
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/events/stats
 * @desc    获取事件统计（按类别/类型分组）
 * @query   interval - 时间间隔（hour/day）
 * @query   startTime - 开始时间
 * @query   endTime - 结束时间
 */
router.get('/stats', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { interval = 'hour', startTime, endTime } = req.query;
    
    const table = interval === 'day' ? 'events_daily' : 'events_hourly';
    
    const stats = await clickhouse.query(`
      SELECT 
        category, type, 
        ${interval === 'day' ? 'day' : 'hour'} as time,
        sum(event_count) as count,
        sum(unique_users) as users
      FROM minego_events.${table}
      WHERE ${interval === 'day' ? 'day' : 'hour'} BETWEEN ? AND ?
      GROUP BY category, type, time
      ORDER BY time DESC
    `, [startTime, endTime]).toPromise();
    
    res.json(successResp({ stats }));
  } catch (err) {
    next(err);
  }
});

/**
 * @route   GET /api/events/heatmap
 * @desc    获取事件地理热力图数据
 * @query   eventType - 事件类型（可选）
 * @query   startTime - 开始时间
 * @query   endTime - 结束时间
 */
router.get('/heatmap', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { eventType, startTime, endTime } = req.query;
    
    let sql = `
      SELECT 
        round(location_lat, 2) as lat,
        round(location_lng, 2) as lng,
        count() as count
      FROM minego_events.business_events
      WHERE timestamp BETWEEN ? AND ?
        AND location_lat IS NOT NULL
    `;
    const params = [startTime, endTime];
    
    if (eventType) {
      sql += ` AND type = ?`;
      params.push(eventType);
    }
    
    sql += `
      GROUP BY lat, lng
      ORDER BY count DESC
      LIMIT 10000
    `;
    
    const heatmap = await clickhouse.query(sql, params).toPromise();
    
    res.json(successResp({ heatmap }));
  } catch (err) {
    next(err);
  }
});
```

### 4.10 集成到现有服务

```javascript
// backend/services/catch-service/src/index.js (示例集成)
const { BusinessEventProducer } = require('../../../shared/BusinessEventProducer');
const eventProducer = new BusinessEventProducer();

// 在捕捉成功时发送事件
app.post('/catch', requireAuth, async (req, res, next) => {
  try {
    const { pokemonId, ballType } = req.body;
    const userId = req.user.sub;
    
    // 发送捕捉尝试事件
    await eventProducer.emit(EVENT_TYPES.CATCH.ATTEMPT, {
      pokemonId, ballType
    }, {
      userId,
      location: req.user.location,
      traceId: req.traceId
    });
    
    // 执行捕捉逻辑...
    const success = await attemptCatch(pokemonId, ballType);
    
    if (success) {
      // 发送捕捉成功事件
      await eventProducer.emit(EVENT_TYPES.CATCH.SUCCESS, {
        pokemonId, ballType, cp: success.cp
      }, {
        userId,
        location: req.user.location,
        traceId: req.traceId
      });
    }
    
    res.json(successResp({ success }));
  } catch (err) {
    next(err);
  }
});
```

## 5. 验收标准（可测试）

- [ ] 8 大类 50+ 事件类型定义完成，并通过单元测试验证
- [ ] 所有 9 个微服务集成 BusinessEventProducer，关键业务事件发送覆盖 100%
- [ ] Kafka Topic 创建成功，分区策略正确，吞吐量测试通过（> 10K events/s）
- [ ] ClickHouse 表结构创建成功，数据写入正常，查询性能 < 100ms
- [ ] 实时业务指标计算正确，与实际业务数据误差 < 1%
- [ ] Grafana 仪表板创建成功，8 个仪表板全部正常显示
- [ ] Prometheus 告警规则加载成功，模拟异常场景触发告警
- [ ] 事件查询 API 5 个端点全部可用，响应时间 < 200ms
- [ ] 集成测试覆盖：事件生产 → Kafka → ClickHouse → 查询完整链路
- [ ] 单元测试覆盖：BusinessEventProducer、BusinessMetricsCalculator、API 路由
- [ ] 性能测试：单服务每秒发送 1000 事件，无阻塞
- [ ] 文档完善：事件定义文档、API 文档、运维手册

## 6. 工作量估算

**规模**：XL（大型）

**理由**：
1. 需要搭建新基础设施（Kafka、ClickHouse）
2. 涉及 9 个微服务改造
3. 需要设计完整的事件分类体系
4. 实时聚合和指标计算复杂度高
5. Grafana 仪表板和告警规则数量多

**预估工时**：
- 架构设计与事件定义：2 天
- 基础设施搭建（Kafka/ClickHouse）：2 天
- BusinessEventProducer SDK：1 天
- 集成到 9 个微服务：3 天
- 实时指标计算服务：2 天
- Grafana 仪表板：1 天
- 告警规则：0.5 天
- 查询 API：1 天
- 测试与文档：1.5 天

**总计**：14 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **监控盲区严重**：当前仅有技术指标监控，缺少业务监控，无法及时发现业务异常
2. **运营决策必需**：实时业务数据是运营决策的基础，直接影响商业化效率
3. **问题定位效率低**：发生业务问题时，缺少事件链路追踪，排查时间长
4. **与现有体系协同**：已有的 Prometheus、Jaeger、日志系统可与本需求完美集成
5. **扩展性强**：事件流平台可为未来的 AI 预测、用户行为分析等高级功能提供数据基础

**为何不是 P0**：
- 不阻塞核心业务功能
- 系统当前可正常运行，监控缺失不影响用户使用
- 需要较多基础设施投入，适合在系统稳定后逐步建设

**为何不是 P2**：
- 业务异常发现滞后会造成较大损失
- 运营团队急需实时数据支持
- 问题排查效率提升对开发团队帮助显著
