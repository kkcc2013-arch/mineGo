# REQ-00347：服务调用异常预测与依赖健康传播追踪系统

- **编号**：REQ-00347
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、所有微服务、backend/shared/ServiceCallPredictor.js、backend/shared/DependencyHealthTracker.js、infrastructure/k8s/monitoring
- **创建时间**：2026-06-27 04:00 UTC
- **依赖需求**：REQ-00103（微服务依赖图）、REQ-00275（告警智能关联）

## 1. 背景与问题

当前 mineGo 项目已实现 Prometheus 监控、告警关联分析（REQ-00275）、分布式追踪（REQ-00148）等可观测性能力，但仍存在以下痛点：

1. **被动响应告警**：现有系统在问题发生后才触发告警，无法提前预警。例如数据库连接池耗尽前没有预警，导致服务雪崩。

2. **依赖健康传播不透明**：当下游服务（如 pokemon-service）出现健康问题（响应延迟升高、错误率上升）时，上游服务（gateway）无法及时感知并调整策略，导致用户请求失败。

3. **异常模式缺乏预测**：历史数据中存在明显的异常模式（如高峰期连接池饱和、Redis 内存溢出前兆），但没有系统化地学习和预测这些模式。

4. **缺乏健康传播可视化**：运维人员无法直观看到"数据库慢查询 → pokemon-service 延迟升高 → gateway 错误率上升"这种传播链路。

## 2. 目标

1. **实现服务调用异常预测**：基于历史监控数据，提前 5-15 分钟预测潜在异常，准确率 ≥ 80%
2. **依赖健康传播追踪**：实时追踪服务依赖链上的健康状态传播，提供可视化拓扑
3. **智能预警与自愈联动**：预测异常时自动触发预防性措施（如预热连接池、限流降级）
4. **减少故障影响范围**：通过提前预警，将故障影响用户数降低 50%+

## 3. 范围

### 包含
- 服务调用模式学习与异常预测引擎
- 依赖健康传播追踪器（基于服务拓扑图）
- 预测告警规则与 Prometheus 集成
- 健康传播可视化 API（供 Grafana/dashboard 使用）
- 预防性自愈措施触发器

### 不包含
- 机器学习模型训练平台（使用轻量级统计模型）
- 实时 A/B 测试分流（已有 REQ-00078）
- 新的服务注册发现机制（已有 REQ-00300）

## 4. 详细需求

### 4.1 服务调用异常预测引擎

```javascript
// backend/shared/ServiceCallPredictor.js

class ServiceCallPredictor {
  constructor(config = {}) {
    this.historyWindow = config.historyWindow || 7 * 24 * 3600 * 1000; // 7天历史
    this.predictionWindow = config.predictionWindow || 15 * 60 * 1000; // 预测未来15分钟
    this.models = new Map(); // 每个服务的预测模型
  }

  /**
   * 学习服务调用模式
   * 基于历史数据训练轻量级预测模型
   */
  async learnPatterns(serviceName) {
    const history = await this.getHistoricalMetrics(serviceName);
    
    // 提取特征：时间周期、请求量、响应时间、错误率
    const features = this.extractFeatures(history);
    
    // 使用移动平均 + 季节性分解
    const model = this.buildModel(features);
    this.models.set(serviceName, model);
    
    return model;
  }

  /**
   * 预测未来指标
   */
  async predict(serviceName, metricName, horizonMinutes = 15) {
    const model = this.models.get(serviceName);
    if (!model) {
      await this.learnPatterns(serviceName);
    }
    
    const prediction = model.forecast(horizonMinutes);
    
    // 判断是否异常
    const isAnomaly = this.detectAnomaly(prediction, model.baseline);
    
    return {
      service: serviceName,
      metric: metricName,
      predicted: prediction,
      isAnomaly,
      confidence: model.confidence,
      horizon: horizonMinutes
    };
  }

  /**
   * 批量预测所有服务
   */
  async predictAll() {
    const services = ['gateway', 'user-service', 'location-service', 
                      'pokemon-service', 'catch-service', 'gym-service',
                      'social-service', 'reward-service', 'payment-service'];
    
    const predictions = await Promise.all(
      services.map(svc => this.predict(svc, 'response_time', 15))
    );
    
    return predictions.filter(p => p.isAnomaly);
  }
}
```

**预测指标**：
- 响应时间（p95、p99）
- 错误率
- 吞吐量
- 连接池使用率
- Redis 内存使用率

### 4.2 依赖健康传播追踪器

```javascript
// backend/shared/DependencyHealthTracker.js

class DependencyHealthTracker {
  constructor(config = {}) {
    this.topology = SERVICE_TOPOLOGY; // 从 REQ-00103 获取
    this.healthScores = new Map();
    this.propagationHistory = [];
  }

  /**
   * 计算服务健康分数（0-100）
   */
  calculateHealthScore(serviceName) {
    const metrics = this.getLatestMetrics(serviceName);
    
    const score = {
      latency: this.scoreLatency(metrics.p95Latency),
      errorRate: this.scoreErrorRate(metrics.errorRate),
      throughput: this.scoreThroughput(metrics.throughput),
      saturation: this.scoreSaturation(metrics.cpu, metrics.memory)
    };
    
    // 加权平均
    const overall = score.latency * 0.3 + 
                    score.errorRate * 0.3 + 
                    score.throughput * 0.2 + 
                    score.saturation * 0.2;
    
    return { ...score, overall };
  }

  /**
   * 追踪健康传播路径
   * 从异常服务向上游追踪影响范围
   */
  tracePropagation(sourceService) {
    const affectedServices = [];
    const visited = new Set();
    
    const dfs = (service, depth) => {
      if (visited.has(service) || depth > 3) return;
      visited.add(service);
      
      // 找到所有依赖此服务的上游服务
      const upstreamServices = this.findUpstreamServices(service);
      
      for (const upstream of upstreamServices) {
        const impact = this.calculateImpact(service, upstream);
        affectedServices.push({
          service: upstream,
          affectedBy: service,
          depth,
          impact,
          propagationPath: this.getPath(sourceService, upstream)
        });
        
        dfs(upstream, depth + 1);
      }
    };
    
    dfs(sourceService, 0);
    
    return {
      source: sourceService,
      affectedServices,
      totalAffected: affectedServices.length,
      propagationTree: this.buildTree(sourceService, affectedServices)
    };
  }

  /**
   * 获取实时健康拓扑图
   */
  async getHealthTopology() {
    const nodes = [];
    const edges = [];
    
    for (const [service, deps] of Object.entries(this.topology)) {
      const health = this.calculateHealthScore(service);
      nodes.push({
        id: service,
        health: health.overall,
        status: health.overall >= 80 ? 'healthy' : 
                health.overall >= 50 ? 'degraded' : 'unhealthy'
      });
      
      for (const dep of deps) {
        edges.push({
          source: service,
          target: dep,
          healthPropagation: this.getPropagationStatus(service, dep)
        });
      }
    }
    
    return { nodes, edges, timestamp: new Date() };
  }
}
```

### 4.3 预测告警规则

```yaml
# infrastructure/k8s/monitoring/prediction-alerts.yml

groups:
  - name: prediction_alerts
    interval: 5m
    rules:
      # 响应时间预测告警
      - alert: PredictedHighLatency
        expr: |
          predict_linear(http_request_duration_seconds_p95[1h], 900) > 2
        for: 5m
        labels:
          severity: warning
          type: prediction
        annotations:
          summary: "预测 {{ $labels.service }} 响应时间将在 15 分钟内超过阈值"
          description: "当前 p95={{ $value }}s，预测 15 分钟后将超过 2s"
      
      # 错误率预测告警
      - alert: PredictedHighErrorRate
        expr: |
          predict_linear(http_requests_error_rate[1h], 900) > 0.05
        for: 5m
        labels:
          severity: critical
          type: prediction
        annotations:
          summary: "预测 {{ $labels.service }} 错误率将在 15 分钟内超过 5%"
      
      # 连接池饱和预测
      - alert: PredictedPoolExhaustion
        expr: |
          predict_linear(db_pool_used_ratio[1h], 900) > 0.9
        for: 5m
        labels:
          severity: critical
          type: prediction
        annotations:
          summary: "预测 {{ $labels.service }} 数据库连接池将在 15 分钟内耗尽"
      
      # 依赖健康传播告警
      - alert: DependencyHealthDegradation
        expr: |
          dependency_health_score < 50
        for: 2m
        labels:
          severity: warning
          type: propagation
        annotations:
          summary: "{{ $labels.service }} 依赖健康分数下降，可能影响上游服务"
```

### 4.4 预防性自愈措施

```javascript
// backend/shared/PreventiveHealing.js

class PreventiveHealing {
  constructor(predictor, healthTracker) {
    this.predictor = predictor;
    this.healthTracker = healthTracker;
    this.actions = new Map();
  }

  /**
   * 根据预测结果执行预防性措施
   */
  async executePreventiveActions(prediction) {
    const { service, metric, predicted } = prediction;
    
    // 根据预测类型选择措施
    const action = this.selectAction(service, metric, predicted);
    
    if (!action) return null;
    
    // 记录执行
    const execution = {
      timestamp: new Date(),
      prediction,
      action,
      result: null
    };
    
    try {
      const result = await this.executeAction(action);
      execution.result = { success: true, ...result };
      
      // 记录 Prometheus 指标
      preventiveActionCounter.inc({ 
        service, 
        action: action.type, 
        success: 'true' 
      });
      
    } catch (error) {
      execution.result = { success: false, error: error.message };
      preventiveActionCounter.inc({ 
        service, 
        action: action.type, 
        success: 'false' 
      });
    }
    
    return execution;
  }

  /**
   * 选择预防性措施
   */
  selectAction(service, metric, predicted) {
    const actions = {
      'response_time': {
        threshold: 2000, // 2秒
        actions: [
          { type: 'warmup_connection_pool', params: { service } },
          { type: 'enable_cache_prefetch', params: { service } }
        ]
      },
      'error_rate': {
        threshold: 0.05,
        actions: [
          { type: 'enable_circuit_breaker', params: { service } },
          { type: 'reduce_timeout', params: { service, timeout: 3000 } }
        ]
      },
      'db_pool_used_ratio': {
        threshold: 0.85,
        actions: [
          { type: 'expand_pool', params: { service, increment: 10 } },
          { type: 'enable_query_cache', params: { service } }
        ]
      },
      'redis_memory_used_ratio': {
        threshold: 0.8,
        actions: [
          { type: 'evict_expired_keys', params: {} },
          { type: 'enable_compression', params: {} }
        ]
      }
    };
    
    const config = actions[metric];
    if (!config || predicted < config.threshold) {
      return null;
    }
    
    // 返回第一个适用的措施
    return config.actions[0];
  }

  /**
   * 执行具体措施
   */
  async executeAction(action) {
    switch (action.type) {
      case 'warmup_connection_pool':
        return await this.warmupPool(action.params.service);
      
      case 'enable_cache_prefetch':
        return await this.enablePrefetch(action.params.service);
      
      case 'enable_circuit_breaker':
        return await this.enableCircuitBreaker(action.params.service);
      
      case 'expand_pool':
        return await this.expandPool(
          action.params.service, 
          action.params.increment
        );
      
      case 'evict_expired_keys':
        return await this.evictRedisKeys();
      
      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }
}
```

### 4.5 健康传播可视化 API

```javascript
// 后端 API 端点

// GET /api/monitoring/health/topology
router.get('/health/topology', async (req, res) => {
  const topology = await healthTracker.getHealthTopology();
  res.json(topology);
});

// GET /api/monitoring/predictions
router.get('/predictions', async (req, res) => {
  const predictions = await predictor.predictAll();
  res.json({
    timestamp: new Date(),
    predictions,
    count: predictions.length
  });
});

// GET /api/monitoring/propagation/:service
router.get('/propagation/:service', async (req, res) => {
  const { service } = req.params;
  const propagation = healthTracker.tracePropagation(service);
  res.json(propagation);
});

// GET /api/monitoring/health/score/:service
router.get('/health/score/:service', async (req, res) => {
  const { service } = req.params;
  const score = healthTracker.calculateHealthScore(service);
  res.json({
    service,
    score,
    timestamp: new Date()
  });
});
```

## 5. 验收标准（可测试）

- [ ] **预测准确率**：15 分钟内异常预测准确率 ≥ 80%（通过历史数据回测验证）
- [ ] **传播追踪延迟**：依赖健康传播追踪延迟 < 500ms
- [ ] **告警提前量**：预测告警比实际故障提前 ≥ 5 分钟
- [ ] **自愈成功率**：预防性措施执行成功率 ≥ 90%
- [ ] **可视化覆盖**：健康拓扑图覆盖所有 9 个微服务及其依赖
- [ ] **API 可用性**：所有监控 API 在网关响应时间 < 200ms
- [ ] **误报率控制**：预测误报率 < 15%
- [ ] **Prometheus 集成**：预测指标成功写入 Prometheus，可查询 `predict_*` 系列指标

## 6. 工作量估算

**L（Large）** - 8-10 人日

理由：
1. 预测引擎需要历史数据分析 + 模型训练（2天）
2. 依赖健康传播追踪器需要服务拓扑集成（2天）
3. 预防性自愈措施需要与现有熔断/限流系统集成（2天）
4. Prometheus 集成 + Grafana Dashboard（1天）
5. 测试与调优（2天）

## 7. 优先级理由

**P1 理由**：

1. **关键可用性提升**：从被动响应转为主动预防，直接提升系统可用性
2. **依赖现有基础设施**：可复用 REQ-00103（服务依赖图）和 REQ-00275（告警关联）的成果
3. **生产价值明确**：减少故障影响范围 50%+，显著降低运维成本
4. **技术债务预防**：避免"告警疲劳"，提高告警质量
5. **支撑 P0 需求**：为道馆战斗、支付等核心链路提供稳定性保障
