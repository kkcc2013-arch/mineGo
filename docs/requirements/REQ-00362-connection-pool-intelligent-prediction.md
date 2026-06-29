# REQ-00362：数据库连接池智能预测与预分配系统

- **编号**：REQ-00362
- **类别**：性能优化
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：backend/shared、所有微服务、PostgreSQL、infrastructure/k8s
- **创建时间**：2026-06-29 12:15 UTC
- **依赖需求**：REQ-00084（数据库连接池监控与自适应扩缩容系统）

## 1. 背景与问题

### 现状分析

mineGo 项目已实现数据库连接池监控系统（REQ-00084），具备基本的连接池健康检测和自适应扩缩容能力。然而，当前系统存在以下性能瓶颈：

1. **被动扩容延迟**：仅在连接池接近满载时才触发扩容，高峰期响应延迟导致请求排队
2. **缺乏历史趋势分析**：未利用历史流量模式预测未来连接需求
3. **扩缩容决策简单**：仅基于当前使用率，未考虑时间段、活动周期、用户行为模式
4. **冷启动性能差**：服务重启后连接池为空，首次请求延迟高

### 典型场景

- **场景 1**：每日 18:00-22:00 高峰期，连接需求从 50 骤增至 300，扩容滞后导致请求超时
- **场景 2**：周末活动开始前 5 分钟，大量用户涌入，连接池未预热
- **场景 3**：凌晨流量低谷，连接池仍保持高水位，浪费资源
- **场景 4**：数据库故障恢复后，连接重建未考虑业务优先级

### 影响评估

- 高峰期 5% 请求因连接池满载而延迟
- 低谷期连接池资源浪费 40%
- 服务冷启动首次请求延迟增加 200-500ms

## 2. 目标

构建智能连接池预测与预分配系统，实现：

1. **流量预测**：基于历史数据预测未来连接需求（预测窗口 5-30 分钟）
2. **主动预分配**：提前扩容连接池，避免请求排队
3. **动态缩容**：流量低谷期智能释放空闲连接
4. **活动预热**：限时活动开始前自动预热连接池
5. **优先级重建**：故障恢复时按业务优先级重建连接

**预期效果**：
- 高峰期连接池满载率降低至 5% 以下
- 低谷期资源浪费降低至 15% 以下
- 服务冷启动首次请求延迟降低至 50ms 以内

## 3. 范围

### 包含

- **流量预测引擎**
  - 历史流量模式分析（小时级、日级、周级）
  - 特殊事件检测（活动、节假日、版本更新）
  - 连接需求预测模型（ARIMA + Prophet 混合）
  - 预测准确率监控与自校正

- **预分配调度器**
  - 预测驱动扩容（提前 5 分钟）
  - 阶梯式扩容（避免一次性大量创建）
  - 扩容速度控制（每秒最大新增连接数）
  - 紧急扩容通道（应对突发流量）

- **动态缩容管理**
  - 流量下降趋势检测
  - 渐进式连接释放
  - 最小保留水位线
  - 连接空闲超时动态调整

- **活动预热机制**
  - 活动配置解析（开始时间、预期流量）
  - 提前预热时间计算
  - 多级预热策略（慢速→中速→快速）
  - 预热状态通知

- **故障恢复优化**
  - 连接断开优先级队列
  - 核心服务优先重建（user-service, location-service）
  - 健康检查增强（延迟敏感度）
  - 恢复进度可视化

### 不包含

- 自动容量规划（容量预算计算）
- 跨区域连接池协调
- 数据库读写分离连接池（独立需求）
- 连接池租约管理（已有实现）

## 4. 详细需求

### 4.1 数据库设计

```sql
-- 流量预测历史表
CREATE TABLE connection_pool_predictions (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  prediction_time TIMESTAMPTZ NOT NULL,
  predicted_connections INTEGER NOT NULL,
  confidence_score DECIMAL(3,2), -- 0.00-1.00
  model_version VARCHAR(20),
  features JSONB, -- 输入特征
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_predictions_service_time (service_name, prediction_time)
);

-- 预分配调度记录表
CREATE TABLE connection_pool_schedules (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  action VARCHAR(20) NOT NULL, -- 'preallocate', 'scale_up', 'scale_down'
  target_connections INTEGER NOT NULL,
  current_connections INTEGER NOT NULL,
  trigger_reason VARCHAR(50), -- 'prediction', 'manual', 'event'
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'completed', 'failed'
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error_message TEXT,
  
  INDEX idx_schedules_service_status (service_name, status, started_at)
);

-- 流量模式特征表
CREATE TABLE traffic_patterns (
  id SERIAL PRIMARY KEY,
  service_name VARCHAR(50) NOT NULL,
  pattern_type VARCHAR(20) NOT NULL, -- 'hourly', 'daily', 'weekly', 'event'
  pattern_key VARCHAR(50) NOT NULL, -- 'monday-18:00', 'event-summer_festival'
  avg_connections INTEGER NOT NULL,
  peak_connections INTEGER NOT NULL,
  confidence DECIMAL(3,2),
  sample_count INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(service_name, pattern_type, pattern_key)
);

-- 活动预热配置表
CREATE TABLE event_preheat_configs (
  id SERIAL PRIMARY KEY,
  event_id VARCHAR(100) NOT NULL,
  event_name VARCHAR(200),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  expected_rpm INTEGER, -- 预期每分钟请求数
  preheat_minutes INTEGER DEFAULT 10,
  target_connections INTEGER,
  services JSONB, -- {"user-service": 200, "location-service": 300}
  status VARCHAR(20) DEFAULT 'scheduled', -- 'scheduled', 'preheating', 'active', 'completed'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_event_preheat_time (start_time, status)
);
```

### 4.2 流量预测引擎

```javascript
// backend/shared/ConnectionPoolPredictor.js

const { Prophet } = require('node-prophet');
const ARIMA = require('arima');

class ConnectionPoolPredictor {
  constructor(config = {}) {
    this.config = {
      historyWindow: 7 * 24 * 3600, // 7天历史数据
      predictionWindow: 30 * 60, // 预测未来30分钟
      minConfidence: 0.7,
      models: {
        arima: { p: 2, d: 1, q: 2 },
        prophet: { yearlySeasonality: false, weeklySeasonality: true }
      },
      ...config
    };
    
    this.models = new Map();
    this.patterns = new Map();
  }
  
  /**
   * 训练预测模型
   */
  async trainModel(serviceName) {
    // 获取历史连接使用数据
    const history = await this.getHistoricalData(serviceName);
    
    if (history.length < 100) {
      logger.warn({ serviceName, sampleCount: history.length }, 
        'Insufficient data for training');
      return null;
    }
    
    // 准备时间序列数据
    const timeSeries = this.prepareTimeSeries(history);
    
    // 训练 ARIMA 模型
    const arima = new ARIMA(this.config.models.arima);
    arima.train(timeSeries.values);
    
    // 训练 Prophet 模型（如果有足够数据）
    let prophet = null;
    if (history.length >= 1000) {
      prophet = new Prophet(this.config.models.prophet);
      await prophet.fit(timeSeries.dataframe);
    }
    
    this.models.set(serviceName, {
      arima,
      prophet,
      trainedAt: Date.now(),
      lastData: timeSeries.values.slice(-10)
    });
    
    logger.info({ serviceName, sampleCount: history.length }, 'Model trained');
    return this.models.get(serviceName);
  }
  
  /**
   * 预测未来连接需求
   */
  async predict(serviceName, predictionHorizon = 30) {
    const model = this.models.get(serviceName);
    
    if (!model) {
      await this.trainModel(serviceName);
      if (!this.models.has(serviceName)) {
        return this.fallbackPrediction(serviceName);
      }
    }
    
    const modelData = this.models.get(serviceName);
    
    // ARIMA 预测
    const arimaPredictions = modelData.arima.predict(predictionHorizon);
    
    // Prophet 预测（如果可用）
    let prophetPredictions = null;
    if (modelData.prophet) {
      const future = modelData.prophet.makeFutureDataframe({
        periods: predictionHorizon,
        freq: '1min'
      });
      const forecast = await modelData.prophet.predict(future);
      prophetPredictions = forecast.map(f => f.yhat);
    }
    
    // 混合预测（加权平均）
    const combinedPredictions = this.combinePredictions(
      arimaPredictions,
      prophetPredictions,
      predictionHorizon
    );
    
    // 应用模式修正
    const patternCorrected = this.applyPatternCorrection(
      serviceName,
      combinedPredictions
    );
    
    // 保存预测结果
    await this.savePredictions(serviceName, patternCorrected);
    
    return patternCorrections;
  }
  
  /**
   * 获取当前时刻的模式
   */
  getCurrentPattern(serviceName) {
    const now = new Date();
    const dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getDay()];
    const hour = now.getHours();
    
    const patternKey = `${dayOfWeek}-${hour}:00`;
    return this.patterns.get(`${serviceName}:${patternKey}`);
  }
  
  /**
   * 回退预测（历史平均值）
   */
  fallbackPrediction(serviceName) {
    const pattern = this.getCurrentPattern(serviceName);
    
    if (pattern) {
      return {
        predictions: Array(30).fill(pattern.avgConnections),
        confidence: pattern.confidence,
        source: 'pattern'
      };
    }
    
    // 默认值
    return {
      predictions: Array(30).fill(50),
      confidence: 0.3,
      source: 'default'
    };
  }
  
  /**
   * 计算预测准确率
   */
  async evaluateAccuracy(serviceName) {
    const predictions = await this.getRecentPredictions(serviceName);
    const actuals = await this.getActualConnections(serviceName);
    
    const errors = predictions.map((pred, i) => {
      const actual = actuals[i];
      return Math.abs(pred.predicted_connections - actual) / actual;
    });
  
    const mape = errors.reduce((sum, e) => sum + e, 0) / errors.length;
    const accuracy = 1 - mape;
    
    return {
      serviceName,
      mape,
      accuracy,
      sampleCount: predictions.length,
      evaluatedAt: new Date()
    };
  }
}

module.exports = ConnectionPoolPredictor;
```

### 4.3 预分配调度器

```javascript
// backend/shared/ConnectionPoolScheduler.js

class ConnectionPoolScheduler {
  constructor(predictor, poolManager) {
    this.predictor = predictor;
    this.poolManager = poolManager;
    this.schedules = new Map();
    this.config = {
      minConnections: 10,
      maxConnections: 500,
      scaleUpStep: 20, // 每次扩容步长
      scaleUpRate: 10, // 每秒最多新增连接数
      preheatLeadTime: 300, // 提前预热时间（秒）
      cooldownPeriod: 60 // 扩缩容冷却期（秒）
    };
  }
  
  /**
   * 启动调度循环
   */
  start() {
    // 每5分钟执行预测
    setInterval(() => this.runPredictionCycle(), 5 * 60 * 1000);
    
    // 每分钟检查调度执行
    setInterval(() => this.runScheduleExecution(), 60 * 1000);
    
    // 每10分钟评估预测准确率
    setInterval(() => this.evaluateAndCorrect(), 10 * 60 * 1000);
    
    logger.info('Connection pool scheduler started');
  }
  
  /**
   * 预测循环
   */
  async runPredictionCycle() {
    const services = this.getActiveServices();
    
    for (const serviceName of services) {
      try {
        // 生成预测
        const prediction = await this.predictor.predict(serviceName, 30);
        
        // 计算需要预分配的连接数
        const currentPool = await this.poolManager.getPoolStats(serviceName);
        const peakPredicted = Math.max(...prediction.predictions);
        
        // 提前5分钟预分配
        const leadTime = 5;
        const predictedAtLeadTime = prediction.predictions[leadTime];
        
        if (predictedAtLeadTime > currentPool.currentConnections * 1.2) {
          // 需要预分配
          await this.schedulePreallocation(serviceName, {
            targetConnections: Math.ceil(predictedAtLeadTime * 1.1),
            currentConnections: currentPool.currentConnections,
            triggerReason: 'prediction',
            executeAt: Date.now() + (leadTime - 1) * 60 * 1000 // 提前1分钟执行
          });
        }
        
        // 检查是否需要缩容
        const minPredicted = Math.min(...prediction.predictions.slice(10));
        if (minPredicted < currentPool.currentConnections * 0.5) {
          await this.scheduleScaledown(serviceName, {
            targetConnections: Math.ceil(minPredicted * 1.2),
            currentConnections: currentPool.currentConnections,
            triggerReason: 'prediction',
            executeAt: Date.now() + 10 * 60 * 1000
          });
        }
        
      } catch (error) {
        logger.error({ serviceName, error: error.message }, 
          'Prediction cycle failed');
      }
    }
  }
  
  /**
   * 调度执行
   */
  async runScheduleExecution() {
    const now = Date.now();
    
    for (const [scheduleId, schedule] of this.schedules) {
      if (schedule.executeAt <= now && schedule.status === 'pending') {
        try {
          await this.executeSchedule(scheduleId, schedule);
        } catch (error) {
          logger.error({ scheduleId, error: error.message },
            'Schedule execution failed');
          schedule.status = 'failed';
          schedule.errorMessage = error.message;
        }
      }
    }
  }
  
  /**
   * 执行调度
   */
  async executeSchedule(scheduleId, schedule) {
    schedule.status = 'running';
    schedule.startedAt = new Date();
    
    const { serviceName, targetConnections, currentConnections } = schedule;
    const action = targetConnections > currentConnections ? 'scale_up' : 'scale_down';
    
    if (action === 'scale_up') {
      // 阶梯式扩容
      const steps = Math.ceil((targetConnections - currentConnections) / this.config.scaleUpStep);
      
      for (let i = 0; i < steps; i++) {
        const stepTarget = Math.min(
          currentConnections + (i + 1) * this.config.scaleUpStep,
          targetConnections
        );
        
        await this.poolManager.setPoolSize(serviceName, stepTarget);
        
        // 限速
        if (i < steps - 1) {
          await sleep(1000); // 每秒最多新增 scaleUpRate 个连接
        }
      }
    } else {
      // 渐进式缩容
      const steps = Math.ceil((currentConnections - targetConnections) / 10);
      
      for (let i = 0; i < steps; i++) {
        const stepTarget = Math.max(
          currentConnections - (i + 1) * 10,
          targetConnections,
          this.config.minConnections
        );
        
        await this.poolManager.setPoolSize(serviceName, stepTarget);
        
        // 等待连接释放
        if (i < steps - 1) {
          await sleep(2000);
        }
      }
    }
    
    schedule.status = 'completed';
    schedule.completedAt = new Date();
    
    // 更新数据库
    await this.updateScheduleRecord(scheduleId, schedule);
    
    logger.info({ scheduleId, serviceName, action, targetConnections },
      'Schedule executed');
  }
  
  /**
   * 活动预热
   */
  async preheatForEvent(event) {
    const preheatTime = new Date(event.start_time.getTime() - event.preheat_minutes * 60 * 1000);
    const now = new Date();
    
    if (preheatTime > now) {
      // 计算预热策略
      const timeUntilPreheat = preheatTime - now;
      const timeUntilEvent = event.start_time - now;
      
      // 多级预热
      const stages = [
        { time: timeUntilPreheat, factor: 0.3 }, // 30% 目标连接数
        { time: timeUntilEvent - 5 * 60 * 1000, factor: 0.7 }, // 70%
        { time: timeUntilEvent - 2 * 60 * 1000, factor: 1.0 } // 100%
      ];
      
      for (const stage of stages) {
        for (const [service, targetConnections] of Object.entries(event.services)) {
          const stageTarget = Math.ceil(targetConnections * stage.factor);
          
          setTimeout(async () => {
            await this.poolManager.warmupPool(service, stageTarget);
            logger.info({ service, event: event.event_id, stageTarget },
              'Event preheat stage executed');
          }, stage.time);
        }
      }
    }
  }
}

module.exports = ConnectionPoolScheduler;
```

### 4.4 Prometheus 指标

```javascript
const predictionMetrics = {
  // 预测准确率
  predictionAccuracy: new promClient.Gauge({
    name: 'minego_pool_prediction_accuracy',
    help: 'Connection pool prediction accuracy by service',
    labelNames: ['service'],
    registers: [register]
  }),
  
  // 预测值 vs 实际值
  predictedVsActual: new promClient.Gauge({
    name: 'minego_pool_predicted_vs_actual_connections',
    help: 'Predicted vs actual connection count',
    labelNames: ['service', 'type'], // type: predicted, actual
    registers: [register]
  }),
  
  // 预分配次数
  preallocationTotal: new promClient.Counter({
    name: 'minego_pool_preallocation_total',
    help: 'Total preallocation actions',
    labelNames: ['service', 'trigger'],
    registers: [register]
  }),
  
  // 扩缩容耗时
  scalingDuration: new promClient.Histogram({
    name: 'minego_pool_scaling_duration_seconds',
    help: 'Connection pool scaling duration',
    labelNames: ['service', 'action'],
    buckets: [1, 5, 10, 30, 60, 120],
    registers: [register]
  }),
  
  // 活动预热状态
  eventPreheatStatus: new promClient.Gauge({
    name: 'minego_pool_event_preheat_status',
    help: 'Event preheat status (0=scheduled, 1=preheating, 2=active, 3=completed)',
    labelNames: ['event_id'],
    registers: [register]
  })
};
```

## 5. 验收标准（可测试）

- [ ] **流量预测**
  - 预测准确率 > 80%（MAPE < 20%）
  - 高峰期预测误差 < 15%
  - 特殊事件检测准确率 > 90%
  - 模型训练时间 < 30 秒

- [ ] **预分配调度**
  - 高峰期前 5 分钟完成预分配
  - 扩容延迟 < 10 秒
  - 缩容渐进式执行
  - 冷却期生效

- [ ] **动态缩容**
  - 流量下降趋势检测准确
  - 缩容不触发最小水位线
  - 连接释放平滑
  - 低谷期资源浪费 < 20%

- [ ] **活动预热**
  - 活动开始前完成预热
  - 多级预热正常执行
  - 预热通知发送成功
  - 预热状态可视化

- [ ] **故障恢复优化**
  - 核心服务优先重建
  - 连接恢复成功率 > 99%
  - 恢复进度实时更新
  - 健康检查增强生效

- [ ] **监控指标**
  - 所有 Prometheus 指标正常上报
  - 预测准确率实时监控
  - 扩缩容历史可追溯
  - 异常告警触发

- [ ] **单元测试**
  - 预测模型测试覆盖所有场景
  - 调度逻辑测试覆盖所有分支
  - 模式检测测试覆盖所有类型
  - 故障恢复测试覆盖所有优先级

## 6. 工作量估算

**L（Large）** - 预计 3-4 天

- 预测引擎开发：1 天（ARIMA + Prophet 混合模型）
- 数据库设计与迁移：0.5 天
- 调度器开发：0.5 天（预分配 + 动态缩容）
- 活动预热机制：0.5 天
- 故障恢复优化：0.5 天
- 单元测试：0.5 天
- 集成测试与调优：0.5 天

## 7. 优先级理由

**P1 理由**：

1. **解决性能瓶颈**：当前高峰期连接池满载导致 5% 请求延迟
2. **资源优化**：低谷期连接池浪费 40% 资源
3. **用户体验提升**：冷启动首次请求延迟从 200ms+ 降至 50ms
4. **活动支撑**：大型活动需要提前预热连接池
5. **对"项目可用"贡献大**：提升性能与可扩展性维度评分

**不设 P0 的原因**：
- 现有连接池监控系统（REQ-00084）已提供基础能力
- 性能问题非阻塞性，仅影响高峰期部分请求
- 可与其他 P1 性能优化需求并行开发

## 8. 风险与依赖

### 风险

1. **预测误差导致资源浪费**：过度预测会浪费资源 → 设置预测上限，人工审核
2. **模型训练开销**：历史数据量大导致训练慢 → 增量训练，定期全量重训
3. **扩缩容抖动**：预测波动导致频繁调整 → 平滑策略，冷却期

### 依赖

- REQ-00084：需要连接池监控系统提供实时数据
- PostgreSQL：需要访问 pg_stat_activity 获取连接统计
- Redis：预测结果缓存
- Prometheus：监控指标采集
