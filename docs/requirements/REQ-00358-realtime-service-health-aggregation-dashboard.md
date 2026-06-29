# REQ-00358：实时服务健康聚合仪表板与异常预测系统

- **编号**：REQ-00358
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/ServiceHealthAggregator.js、backend/shared/AnomalyPredictor.js、admin-dashboard、infrastructure/k8s/monitoring
- **创建时间**：2026-06-29 07:12 UTC
- **依赖需求**：REQ-00061（服务健康仪表板已实现）、REQ-00148（分布式追踪已实现）

## 1. 背景与问题

当前 mineGo 项目已有基础的健康检查和分布式追踪能力（REQ-00061, REQ-00148），但存在以下缺口：

1. **健康状态碎片化**：各服务独立上报健康状态，缺乏跨服务的聚合视角，运维人员无法快速判断整体系统健康度
2. **被动告警延迟**：现有告警基于阈值触发，往往是问题发生后才通知，缺乏预测能力
3. **根因定位耗时**：当系统出现异常时，需要人工查看多个仪表板（Prometheus、Grafana、Jaeger）才能定位根因
4. **历史趋势缺失**：没有健康状态的时序存储，无法分析系统稳定性的长期趋势

## 2. 目标

构建统一的实时服务健康聚合系统：
- 提供**单页面全局视角**展示所有服务健康状态
- 实现**异常预测**，在问题发生前 5-10 分钟发出预警
- 自动**关联分析**，快速定位异常根因
- 存储健康状态时序数据，支持历史趋势分析

## 3. 范围

- **包含**：
  - 服务健康聚合引擎（收集各服务健康指标）
  - 异常预测模型（基于历史数据的时序预测）
  - 健康状态 WebSocket 实时推送
  - admin-dashboard 集成仪表板
  - 健康状态历史存储（PostgreSQL 时序表）

- **不包含**：
  - 单个服务的健康检查逻辑（已由 REQ-00061 实现）
  - 分布式追踪数据采集（已由 REQ-00148 实现）
  - 告警通知渠道集成（已有 Alertmanager）

## 4. 详细需求

### 4.1 服务健康聚合引擎

```javascript
// backend/shared/ServiceHealthAggregator.js
class ServiceHealthAggregator {
  constructor() {
    this.services = ['gateway', 'user', 'location', 'pokemon', 'catch', 'gym', 'social', 'reward', 'payment'];
    this.healthCache = new Map(); // 服务 -> 最新健康状态
    this.historyBuffer = [];     // 最近 1 小时健康状态快照
  }

  // 每 10 秒采集一次所有服务健康状态
  async collectHealthSnapshot() {
    const snapshot = {
      timestamp: Date.now(),
      services: {},
      aggregateScore: 0,
      anomalies: []
    };

    for (const service of this.services) {
      const health = await this.fetchServiceHealth(service);
      snapshot.services[service] = health;
      this.healthCache.set(service, health);
    }

    snapshot.aggregateScore = this.calculateAggregateScore(snapshot.services);
    snapshot.anomalies = this.detectAnomalies(snapshot);
    
    this.historyBuffer.push(snapshot);
    if (this.historyBuffer.length > 360) { // 保留 1 小时
      this.historyBuffer.shift();
    }

    await this.persistSnapshot(snapshot);
    this.broadcastSnapshot(snapshot);
    return snapshot;
  }

  calculateAggregateScore(services) {
    const weights = {
      gateway: 0.25,
      user: 0.15,
      pokemon: 0.15,
      catch: 0.15,
      gym: 0.10,
      social: 0.08,
      location: 0.07,
      reward: 0.03,
      payment: 0.02
    };

    let score = 0;
    for (const [service, health] of Object.entries(services)) {
      score += (health.status === 'healthy' ? 100 : health.status === 'degraded' ? 50 : 0) * (weights[service] || 0.05);
    }
    return Math.round(score);
  }
}
```

### 4.2 异常预测模型

```javascript
// backend/shared/AnomalyPredictor.js
class AnomalyPredictor {
  constructor() {
    this.modelConfig = {
      predictionWindow: 5 * 60 * 1000, // 预测未来 5 分钟
      trainingWindow: 24 * 60 * 60 * 1000, // 使用 24 小时历史数据
      thresholds: {
        cpu: { warning: 70, critical: 90 },
        memory: { warning: 75, critical: 95 },
        latency: { warning: 500, critical: 2000 },
        errorRate: { warning: 0.01, critical: 0.05 }
      }
    };
  }

  // 基于指数加权移动平均的预测
  predictAnomalies(historyBuffer) {
    const predictions = [];
    
    for (const service of Object.keys(historyBuffer[0]?.services || {})) {
      const serviceHistory = historyBuffer.map(s => ({
        timestamp: s.timestamp,
        ...s.services[service]
      }));

      // 预测 CPU、内存、延迟、错误率趋势
      const cpuPrediction = this.exponentialSmoothing(serviceHistory.map(h => h.metrics?.cpu || 0));
      const latencyPrediction = this.exponentialSmoothing(serviceHistory.map(h => h.metrics?.latency || 0));
      const errorPrediction = this.exponentialSmoothing(serviceHistory.map(h => h.metrics?.errorRate || 0));

      if (this.isAnomalyPredicted(cpuPrediction, latencyPrediction, errorPrediction)) {
        predictions.push({
          service,
          predictedAt: Date.now() + this.modelConfig.predictionWindow,
          confidence: this.calculateConfidence(serviceHistory),
          predictedIssue: this.classifyPredictedIssue(cpuPrediction, latencyPrediction, errorPrediction),
          recommendedAction: this.getRecommendedAction(service, cpuPrediction, latencyPrediction)
        });
      }
    }

    return predictions;
  }

  exponentialSmoothing(data, alpha = 0.3) {
    if (data.length === 0) return 0;
    let smoothed = data[0];
    for (let i = 1; i < data.length; i++) {
      smoothed = alpha * data[i] + (1 - alpha) * smoothed;
    }
    return smoothed;
  }
}
```

### 4.3 实时推送与仪表板 API

```javascript
// gateway/routes/admin-health.js
router.get('/admin/health/aggregate', authAdmin, async (req, res) => {
  const aggregator = req.app.locals.healthAggregator;
  const snapshot = await aggregator.getLatestSnapshot();
  res.json({
    aggregateScore: snapshot.aggregateScore,
    services: snapshot.services,
    anomalies: snapshot.anomalies,
    predictions: await aggregator.getPredictions()
  });
});

router.ws('/admin/health/stream', (ws, req) => {
  const aggregator = req.app.locals.healthAggregator;
  const unsubscribe = aggregator.subscribe(snapshot => {
    ws.send(JSON.stringify({
      type: 'health-update',
      data: snapshot
    }));
  });
  
  ws.on('close', unsubscribe);
});
```

### 4.4 历史数据存储

```sql
-- database/migrations/20260629_health_aggregation.sql
CREATE TABLE health_snapshots (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aggregate_score INTEGER NOT NULL,
  services JSONB NOT NULL,
  anomalies JSONB DEFAULT '[]',
  predictions JSONB DEFAULT '[]'
);

CREATE INDEX idx_health_snapshots_timestamp ON health_snapshots(timestamp DESC);

-- 分区策略：按天分区
CREATE TABLE health_snapshots_20260629 PARTITION OF health_snapshots
  FOR VALUES FROM ('2026-06-29') TO ('2026-06-30');
```

## 5. 验收标准（可测试）

- [ ] 管理后台能展示所有 9 个服务的实时健康状态（绿/黄/红）
- [ ] 健康聚合分数每 10 秒更新一次，WebSocket 延迟 < 500ms
- [ ] 异常预测能在问题发生前 5 分钟预警（准确率 > 70%）
- [ ] 历史数据保留 30 天，查询 24 小时数据响应时间 < 2s
- [ ] 系统健康分数低于 60 时自动触发告警
- [ ] 单元测试覆盖核心预测逻辑，覆盖率 > 80%

## 6. 工作量估算

**L（Large）** - 需要实现聚合引擎、预测模型、WebSocket 推送、仪表板集成和历史存储，涉及多个模块协作。

## 7. 优先级理由

作为 P1 需求，此功能：
1. 直接提升运维效率，减少故障定位时间（MTTR）
2. 预测能力可预防潜在故障，提升系统稳定性
3. 依赖已实现的健康检查和追踪基础，时机成熟
4. 对项目"生产可用"目标有直接贡献
