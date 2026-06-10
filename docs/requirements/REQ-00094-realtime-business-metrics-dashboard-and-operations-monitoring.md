# REQ-00094: 实时业务指标仪表板与运营监控系统

- **编号**：REQ-00094
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、infrastructure/k8s/monitoring、admin-dashboard、backend/shared/businessMetrics.js
- **创建时间**：2026-06-10 16:05
- **依赖需求**：REQ-00002（结构化日志与 Prometheus 指标）

## 1. 背景与问题

当前 mineGo 项目已具备完善的技术层面监控（Prometheus 指标、Grafana 仪表板、Jaeger 链路追踪），但缺少**业务层面的实时监控与可视化**。运营团队无法快速了解：

1. **实时玩家数据**：当前在线玩家数、活跃分布、地理分布
2. **核心业务指标**：捕捉成功率、道馆占领情况、交易完成率、付费转化率
3. **运营关键指标**：DAU/MAU、留存率、ARPU、LTV
4. **异常业务信号**：异常捕捉率飙升、某区域玩家骤降、付费异常波动

运营决策依赖数据分析师手动跑 SQL 查询，响应延迟长达数小时。需要建立一套实时业务指标仪表板，支持运营团队实时监控游戏健康状态和业务表现。

## 2. 目标

1. 建立完整的游戏业务指标体系，覆盖玩家、精灵、道馆、社交、支付五大模块
2. 实现业务指标的实时采集、聚合与可视化
3. 提供运营专属仪表板，支持实时监控和自定义告警
4. 支持业务异常智能检测与自动告警
5. 提供 REST API 供第三方系统（如 BI 工具）对接

## 3. 范围

### 包含
- 业务指标定义与采集模块
- 指标聚合与存储（时序数据）
- 运营仪表板前端组件
- 业务异常检测告警规则
- REST API 接口

### 不包含
- 数据仓库建设（ETL、数据湖）
- 高级数据分析（机器学习预测模型）
- 用户行为分析平台（留存分析、漏斗分析）

## 4. 详细需求

### 4.1 业务指标定义

```javascript
// backend/shared/businessMetrics.js
const BUSINESS_METRICS = {
  // 玩家指标
  players: {
    online: 'minego_players_online',           // 当前在线玩家数
    newRegistrations: 'minego_players_new',    // 新注册玩家数
    dau: 'minego_players_dau',                 // 日活跃用户数
    mau: 'minego_players_mau',                 // 月活跃用户数
    retention: 'minego_players_retention',     // 留存率（1日/7日/30日）
    arpu: 'minego_players_arpu',              // 平均每用户收入
    ltv: 'minego_players_ltv',                // 用户生命周期价值
  },
  
  // 精灵指标
  pokemon: {
    caught: 'minego_pokemon_caught_total',    // 累计捕捉精灵数
    catchRate: 'minego_pokemon_catch_rate',   // 捕捉成功率
    spawned: 'minego_pokemon_spawned_total',  // 生成的精灵数
    evolved: 'minego_pokemon_evolved_total',  // 进化次数
    traded: 'minego_pokemon_traded_total',    // 交易次数
  },
  
  // 道馆指标
  gym: {
    total: 'minego_gym_total',                // 道馆总数
    owned: 'minego_gym_owned',                // 被占领道馆数
    battles: 'minego_gym_battles_total',      // 战斗次数
    raids: 'minego_gym_raids_total',          // Raid 次数
  },
  
  // 社交指标
  social: {
    friends: 'minego_social_friends_total',   // 好友关系数
    gifts: 'minego_social_gifts_total',       // 礼物发送数
    messages: 'minego_social_messages_total', // 消息数
  },
  
  // 支付指标
  payment: {
    revenue: 'minego_payment_revenue',        // 收入（分币）
    orders: 'minego_payment_orders_total',    // 订单数
    conversion: 'minego_payment_conversion',  // 付费转化率
    refund: 'minego_payment_refund_total',    // 退款数
  }
};
```

### 4.2 指标采集服务

```javascript
// backend/services/gateway/src/businessMetricsCollector.js
class BusinessMetricsCollector {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.aggregationInterval = 60000; // 1分钟聚合
  }

  // 记录玩家上线
  recordPlayerOnline(userId) {
    this.incrementGauge('minego_players_online', 1);
    this.incrementCounter('minego_players_dau', { userId });
  }

  // 记录玩家下线
  recordPlayerOffline(userId) {
    this.decrementGauge('minego_players_online', 1);
  }

  // 记录精灵捕捉
  recordPokemonCatch(userId, pokemonId, success, duration) {
    if (success) {
      this.incrementCounter('minego_pokemon_caught_total', { userId, pokemonId });
    }
    this.observeHistogram('minego_pokemon_catch_duration', duration, { success });
    this.updateCatchRate();
  }

  // 更新捕捉成功率
  async updateCatchRate() {
    const stats = await this.getRecentCatchStats();
    const rate = stats.success / stats.total;
    this.setGauge('minego_pokemon_catch_rate', rate);
  }

  // 记录支付
  recordPayment(userId, amount, currency) {
    this.incrementCounter('minego_payment_orders_total', { userId, currency });
    this.incrementCounter('minego_payment_revenue', amount, { currency });
    this.updateConversionRate();
  }

  // 聚合并推送到 Prometheus
  async aggregate() {
    const now = Date.now();
    for (const [name, gauge] of this.gauges) {
      // 推送当前值到 Prometheus
      metrics.businessGauge(name, gauge.value, gauge.labels);
    }
  }
}
```

### 4.3 运营仪表板 API

```javascript
// backend/gateway/src/routes/admin/businessMetrics.js
router.get('/api/admin/metrics/realtime', async (req, res) => {
  const metrics = await businessMetricsService.getRealtimeMetrics();
  res.json({
    timestamp: new Date(),
    players: {
      online: metrics.players_online,
      dau: metrics.players_dau,
      newToday: metrics.players_new_today
    },
    pokemon: {
      caught: metrics.pokemon_caught,
      catchRate: metrics.pokemon_catch_rate
    },
    gym: {
      battles: metrics.gym_battles,
      raids: metrics.gym_raids
    },
    payment: {
      revenue: metrics.payment_revenue,
      orders: metrics.payment_orders
    }
  });
});

router.get('/api/admin/metrics/hourly', async (req, res) => {
  const { start, end } = req.query;
  const data = await businessMetricsService.getHourlyMetrics(start, end);
  res.json(data);
});

router.get('/api/admin/metrics/daily', async (req, res) => {
  const { start, end } = req.query;
  const data = await businessMetricsService.getDailyMetrics(start, end);
  res.json(data);
});

router.get('/api/admin/metrics/geo', async (req, res) => {
  const distribution = await businessMetricsService.getGeoDistribution();
  res.json(distribution);
});
```

### 4.4 业务异常检测规则

```yaml
# infrastructure/k8s/monitoring/business-alerts.yml
groups:
  - name: business_anomalies
    rules:
      # 在线玩家数异常下降
      - alert: OnlinePlayersDrop
        expr: |
          (minego_players_online - minego_players_online offset 1h) / minego_players_online offset 1h < -0.3
        for: 10m
        labels:
          severity: critical
          category: business
        annotations:
          summary: "在线玩家数异常下降超过30%"
          description: "当前在线: {{ $value }}，较1小时前下降超过30%"

      # 捕捉成功率异常
      - alert: CatchRateAnomaly
        expr: |
          minego_pokemon_catch_rate < 0.3 or minego_pokemon_catch_rate > 0.95
        for: 15m
        labels:
          severity: warning
          category: business
        annotations:
          summary: "捕捉成功率异常: {{ $value | humanizePercentage }}"

      # 付费转化率异常
      - alert: PaymentConversionDrop
        expr: |
          (minego_payment_conversion - minego_payment_conversion offset 1d) / minego_payment_conversion offset 1d < -0.2
        for: 2h
        labels:
          severity: warning
          category: business
        annotations:
          summary: "付费转化率下降超过20%"

      # 某地区玩家骤降
      - alert: RegionPlayersDrop
        expr: |
          minego_players_online_by_region / minego_players_online_by_region offset 1h < 0.5
        for: 30m
        labels:
          severity: warning
          category: business
        annotations:
          summary: "地区 {{ $labels.region }} 玩家数骤降超过50%"
```

### 4.5 前端仪表板组件

```javascript
// frontend/admin-dashboard/src/components/BusinessDashboard.js
class BusinessDashboard {
  constructor() {
    this.refreshInterval = 30000; // 30秒刷新
    this.charts = {};
  }

  async init() {
    await this.loadMetrics();
    this.renderOverviewCards();
    this.renderPlayerChart();
    this.renderRevenueChart();
    this.renderGeoMap();
    this.startAutoRefresh();
  }

  renderOverviewCards() {
    const cards = [
      { title: '在线玩家', value: this.metrics.players.online, icon: '👥', trend: '+5%' },
      { title: '今日DAU', value: this.metrics.players.dau, icon: '📈', trend: '+12%' },
      { title: '捕捉成功率', value: `${(this.metrics.pokemon.catchRate * 100).toFixed(1)}%`, icon: '🎯' },
      { title: '今日收入', value: `¥${(this.metrics.payment.revenue / 100).toFixed(2)}`, icon: '💰', trend: '+8%' }
    ];
    // 渲染卡片...
  }

  async loadMetrics() {
    const response = await fetch('/api/admin/metrics/realtime');
    this.metrics = await response.json();
  }

  startAutoRefresh() {
    setInterval(() => this.loadMetrics(), this.refreshInterval);
  }
}
```

## 5. 验收标准

- [ ] 业务指标定义模块实现完成，覆盖 5 大业务模块 20+ 核心指标
- [ ] 指标采集服务实现完成，支持实时采集与聚合
- [ ] 运营仪表板 REST API 实现完成，至少 5 个核心接口
- [ ] 业务异常检测规则配置完成，至少 5 条告警规则
- [ ] 前端仪表板组件实现完成，支持实时刷新
- [ ] Prometheus 业务指标暴露完成
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 性能要求：API 响应时间 < 200ms

## 6. 工作量估算

**L（Large）** - 需要实现指标采集、聚合存储、API 接口、前端仪表板、告警规则等多个模块，预计 2-3 个工作日。

## 7. 优先级理由

**P1** - 业务监控对运营决策至关重要，能够及时发现业务异常、优化运营策略。当前技术监控完善但缺少业务视角，是项目走向生产运营的关键一环。
