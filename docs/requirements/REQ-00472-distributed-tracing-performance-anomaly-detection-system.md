# REQ-00472：分布式链路追踪性能异常检测系统

- **编号**：REQ-00472
- **类别**：可观测性/监控
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway-service、shared/tracing、monitoring-stack
- **创建时间**：2026-07-07 05:00
- **依赖需求**：REQ-00023（分布式追踪-jaeger）、REQ-00293（分布式追踪-opentelemetry集成）

## 1. 背景与问题

当前 mineGo 项目已实现基础的分布式追踪系统（Jaeger + OpenTelemetry），但在生产环境中暴露以下问题：

**性能监控盲区**：
- 链路数据仅用于事后排查，缺乏实时异常检测能力
- 无法自动识别性能退化（如P99延迟突增、响应时间异常波动）
- 依赖人工设置告警阈值，对复杂性能模式识别不足

**运维效率低**：
- 每日产生数百万条trace数据，无法有效筛选关键异常
- 性能问题发现滞后，往往在用户投诉后才被动响应
- 缺乏历史趋势对比，难以评估优化效果

**数据价值未充分利用**：
- 追踪数据未与业务指标（QPS、错误率）关联分析
- 缺乏智能根因推断，定位问题需人工逐条检查
- 未支持性能基线建立与偏离预警

## 2. 目标

构建基于分布式追踪的智能性能异常检测系统，实现：

1. **实时异常检测**：自动识别响应时间、错误率、吞吐量异常
2. **智能根因分析**：基于trace数据自动定位性能瓶颈和故障节点
3. **性能基线管理**：建立动态性能基线，支持趋势预警
4. **告警降噪**：智能聚合相关异常，减少告警疲劳

**可量化指标**：
- 异常检测准确率 ≥ 95%
- P99延迟异常发现时间 < 30秒
- 误报率 < 10%
- 平均根因定位时间缩短 60%

## 3. 范围

### 包含
- 分布式追踪数据实时分析引擎
- 基于机器学习的性能异常检测算法（Isolation Forest、LSTM）
- 动态性能基线计算与维护
- 异常聚合与根因推断引擎
- 与现有 Prometheus/Grafana 监控栈集成
- 性能异常告警规则自动生成

### 不包含
- 日志分析系统（已有独立日志模块）
- 业务指标异常检测（已有实时业务监控）
- 分布式追踪数据采集（已有OpenTelemetry实现）
- 前端性能监控（属于game-client范畴）

## 4. 详细需求

### 4.1 追踪数据采集与预处理

**数据源集成**：
```javascript
// backend/shared/tracing/trace-analyzer.js
class TraceDataCollector {
  constructor() {
    this.kafkaConsumer = new KafkaConsumer({
      topic: 'otel-spans',
      groupId: 'trace-analyzer-group'
    });
    
    this.spanBuffer = new CircularBuffer(100000); // 缓存最近10万条span
    this.aggregationWindow = 60000; // 60秒聚合窗口
  }
  
  async processSpan(span) {
    // 提取关键特征
    const features = {
      traceId: span.traceId,
      spanId: span.spanId,
      operationName: span.name,
      duration: span.duration,
      statusCode: span.attributes['http.status_code'],
      timestamp: span.startTime,
      service: span.resource.attributes['service.name'],
      parentSpanId: span.parentSpanId,
      
      // 上下文特征
      userId: span.attributes['user.id'],
      deviceId: span.attributes['device.id'],
      apiVersion: span.attributes['api.version'],
      
      // 性能指标
      dbCalls: span.attributes['db.calls'],
      cacheHits: span.attributes['cache.hits'],
      cacheMisses: span.attributes['cache.misses']
    };
    
    await this.spanBuffer.push(features);
    await this.updateRealtimeMetrics(features);
  }
}
```

**特征工程**：
```javascript
class FeatureEngineer {
  extractPerformanceFeatures(spans) {
    const features = {
      // 时间特征
      hourOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
      
      // 性能统计
      avgDuration: this.calculateAverage(spans, 'duration'),
      p50Duration: this.calculatePercentile(spans, 'duration', 50),
      p95Duration: this.calculatePercentile(spans, 'duration', 95),
      p99Duration: this.calculatePercentile(spans, 'duration', 99),
      
      // 错误特征
      errorRate: this.calculateErrorRate(spans),
      errorTypes: this.groupByField(spans, 'statusCode'),
      
      // 服务依赖特征
      serviceCallDepth: this.calculateCallDepth(spans),
      criticalPathDuration: this.calculateCriticalPath(spans),
      dbTimeRatio: this.calculateDbTimeRatio(spans),
      
      // 吞吐量特征
      requestRate: spans.length / this.windowSize,
      uniqueUsers: this.countUniqueUsers(spans),
      
      // 业务特征
      peakHour: this.isPeakHour(),
      eventType: this.extractEventType(spans)
    };
    
    return features;
  }
}
```

### 4.2 性能异常检测算法

**Isolation Forest实现**：
```javascript
// backend/shared/tracing/anomaly-detector.js
const IsolationForest = require('isolation-forest');
const tf = require('@tensorflow/tfjs-node');

class PerformanceAnomalyDetector {
  constructor() {
    this.models = {
      isolationForest: new IsolationForest({
        numTrees: 100,
        subsampleSize: 256,
        maxTreeDepth: 10
      }),
      
      // 用于时序异常检测
      lstmModel: null
    };
    
    this.baselines = new Map(); // 服务性能基线
    this.anomalyHistory = new CircularBuffer(10000);
  }
  
  async initializeModels() {
    // 加载历史数据训练基线
    const historicalData = await this.loadHistoricalTraces(7); // 最近7天
    this.trainIsolationForest(historicalData);
    await this.trainLSTMModel(historicalData);
    
    // 建立性能基线
    await this.establishBaselines(historicalData);
  }
  
  async detectAnomaly(features) {
    const anomalies = [];
    
    // 1. Isolation Forest 检测
    const ifScore = await this.models.isolationForest.score(features);
    if (ifScore > 0.7) {
      anomalies.push({
        type: 'statistical_anomaly',
        score: ifScore,
        details: 'Statistical deviation from normal behavior'
      });
    }
    
    // 2. LSTM 时序异常检测
    const lstmPrediction = await this.predictLSTM(features);
    const lstmDeviation = Math.abs(features.avgDuration - lstmPrediction);
    if (lstmDeviation > this.getLSTMThreshold(features.service)) {
      anomalies.push({
        type: 'temporal_anomaly',
        score: lstmDeviation / lstmPrediction,
        predicted: lstmPrediction,
        actual: features.avgDuration,
        details: 'Temporal deviation from predicted pattern'
      });
    }
    
    // 3. 基线偏离检测
    const baselineDeviation = this.checkBaselineDeviation(features);
    if (baselineDeviation) {
      anomalies.push(baselineDeviation);
    }
    
    // 4. 关联性异常检测（如错误率与响应时间关联）
    const correlationAnomaly = this.detectCorrelationAnomaly(features);
    if (correlationAnomaly) {
      anomalies.push(correlationAnomaly);
    }
    
    return anomalies.length > 0 ? { detected: true, anomalies } : { detected: false };
  }
}
```

**LSTM模型训练**：
```javascript
class LSTMAnomalyDetector {
  async buildModel() {
    const model = tf.sequential();
    
    model.add(tf.layers.lstm({
      units: 64,
      returnSequences: true,
      inputShape: [this.sequenceLength, this.numFeatures]
    }));
    
    model.add(tf.layers.dropout({ rate: 0.2 }));
    
    model.add(tf.layers.lstm({
      units: 32,
      returnSequences: false
    }));
    
    model.add(tf.layers.dense({
      units: this.numFeatures,
      activation: 'linear'
    }));
    
    model.compile({
      optimizer: tf.train.adam(0.001),
      loss: 'meanSquaredError'
    });
    
    return model;
  }
  
  async train(historicalData) {
    const { sequences, targets } = this.prepareTrainingData(historicalData);
    
    await this.model.fit(sequences, targets, {
      epochs: 50,
      batchSize: 32,
      validationSplit: 0.2,
      callbacks: {
        onEpochEnd: (epoch, logs) => {
          console.log(`Epoch ${epoch}: loss = ${logs.loss}`);
        }
      }
    });
  }
  
  async predict(features) {
    const input = this.prepareInput(features);
    const prediction = await this.model.predict(input);
    return prediction.dataSync();
  }
}
```

### 4.3 根因分析引擎

**智能根因定位**：
```javascript
class RootCauseAnalyzer {
  async analyzeRootCause(anomaly, traceData) {
    const rootCauses = [];
    
    // 1. 关键路径分析
    const criticalPath = this.identifyCriticalPath(traceData);
    const bottleneck = this.findBottleneck(criticalPath);
    if (bottleneck) {
      rootCauses.push({
        type: 'critical_path_bottleneck',
        confidence: 0.85,
        details: {
          service: bottleneck.service,
          operation: bottleneck.operation,
          duration: bottleneck.duration,
          percentage: bottleneck.percentageOfTotal
        }
      });
    }
    
    // 2. 服务依赖故障传播分析
    const dependencyGraph = this.buildDependencyGraph(traceData);
    const faultSource = this.traceFaultSource(dependencyGraph, anomaly);
    if (faultSource) {
      rootCauses.push({
        type: 'cascading_failure',
        confidence: 0.90,
        details: {
          sourceService: faultSource.service,
          sourceOperation: faultSource.operation,
          propagationPath: faultSource.propagationPath
        }
      });
    }
    
    // 3. 数据库查询异常
    const dbAnomalies = this.analyzeDbPatterns(traceData);
    if (dbAnomalies.length > 0) {
      rootCauses.push({
        type: 'database_anomaly',
        confidence: 0.80,
        details: dbAnomalies
      });
    }
    
    // 4. 缓存失效分析
    const cacheAnalysis = this.analyzeCachePatterns(traceData);
    if (cacheAnalysis.cacheMissRate > 0.5) {
      rootCauses.push({
        type: 'cache_degradation',
        confidence: 0.75,
        details: cacheAnalysis
      });
    }
    
    return this.rankRootCauses(rootCauses);
  }
}
```

### 4.4 性能基线管理

**动态基线计算**：
```javascript
class PerformanceBaselineManager {
  constructor() {
    this.baselines = new Map();
    this.seasonality = {
      hourly: true,
      daily: true,
      weekly: true
    };
  }
  
  async updateBaseline(service, operation, metrics) {
    const key = `${service}:${operation}`;
    
    // 获取历史数据
    const history = await this.getHistoricalMetrics(service, operation, 30); // 30天历史
    
    // 计算分位数基线
    const baseline = {
      service,
      operation,
      timestamp: Date.now(),
      
      // 响应时间基线
      duration: {
        mean: this.calculateMean(history, 'duration'),
        std: this.calculateStd(history, 'duration'),
        p50: this.calculatePercentile(history, 'duration', 50),
        p95: this.calculatePercentile(history, 'duration', 95),
        p99: this.calculatePercentile(history, 'duration', 99)
      },
      
      // 吞吐量基线
      throughput: {
        mean: this.calculateMean(history, 'throughput'),
        std: this.calculateStd(history, 'throughput'),
        seasonal: this.extractSeasonalPattern(history, 'throughput')
      },
      
      // 错误率基线
      errorRate: {
        mean: this.calculateMean(history, 'errorRate'),
        baseline: this.calculateErrorBaseline(history)
      },
      
      // 时段特定基线
      hourlyBaselines: this.calculateHourlyBaselines(history),
      dailyBaselines: this.calculateDailyBaselines(history)
    };
    
    this.baselines.set(key, baseline);
    await this.persistBaseline(baseline);
  }
  
  checkDeviation(service, operation, currentMetrics) {
    const key = `${service}:${operation}`;
    const baseline = this.baselines.get(key);
    
    if (!baseline) return null;
    
    const deviations = [];
    
    // 检查响应时间偏离
    const durationZScore = (currentMetrics.duration - baseline.duration.mean) / baseline.duration.std;
    if (Math.abs(durationZScore) > 3) {
      deviations.push({
        metric: 'duration',
        zScore: durationZScore,
        baseline: baseline.duration,
        current: currentMetrics.duration,
        deviation: ((currentMetrics.duration - baseline.duration.p99) / baseline.duration.p99) * 100
      });
    }
    
    // 检查吞吐量偏离
    const throughputDeviation = this.checkThroughputDeviation(baseline, currentMetrics);
    if (throughputDeviation) {
      deviations.push(throughputDeviation);
    }
    
    return deviations.length > 0 ? deviations : null;
  }
}
```

### 4.5 告警集成与降噪

**智能告警管理**：
```javascript
class IntelligentAlertManager {
  constructor() {
    this.alertCorrelator = new AlertCorrelator();
    this.alertDeduplicator = new AlertDeduplicator();
    this.notificationRouter = new NotificationRouter();
  }
  
  async processAnomaly(anomaly) {
    // 1. 异常关联分析
    const correlatedAlerts = await this.alertCorrelator.findCorrelated(anomaly);
    
    // 2. 去重与合并
    const dedupedAlert = this.alertDeduplicator.deduplicate(anomaly, correlatedAlerts);
    
    if (dedupedAlert.isDuplicate) {
      await this.updateExistingAlert(dedupedAlert);
      return;
    }
    
    // 3. 计算严重性
    const severity = this.calculateSeverity(anomaly);
    
    // 4. 生成告警
    const alert = {
      id: uuidv4(),
      timestamp: Date.now(),
      anomaly: anomaly,
      severity: severity,
      rootCause: anomaly.rootCause,
      suggestedAction: this.generateActionSuggestion(anomaly),
      
      // 关联信息
      relatedAlerts: correlatedAlerts.map(a => a.id),
      affectedServices: anomaly.affectedServices,
      impactAssessment: this.assessImpact(anomaly)
    };
    
    // 5. 路由通知
    await this.notificationRouter.route(alert);
    
    // 6. 持久化
    await this.persistAlert(alert);
    
    // 7. 发送到 Prometheus
    this.sendToPrometheus(alert);
  }
  
  calculateSeverity(anomaly) {
    let score = 0;
    
    // 异常分数
    score += anomaly.score * 30;
    
    // 影响范围
    if (anomaly.affectedUsers > 1000) score += 30;
    else if (anomaly.affectedUsers > 100) score += 20;
    else if (anomaly.affectedUsers > 10) score += 10;
    
    // P99 延迟影响
    if (anomaly.p99Increase > 100) score += 25;
    else if (anomaly.p99Increase > 50) score += 15;
    else if (anomaly.p99Increase > 20) score += 8;
    
    // 错误率影响
    if (anomaly.errorRateIncrease > 0.05) score += 25;
    else if (anomaly.errorRateIncrease > 0.01) score += 15;
    
    // 映射到严重性级别
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }
}
```

### 4.6 Prometheus集成

**自定义指标导出**：
```javascript
// backend/shared/tracing/metrics-exporter.js
const promClient = require('prom-client');

class TracingMetricsExporter {
  constructor() {
    this.register = new promClient.Registry();
    
    // 异常检测指标
    this.anomalyCounter = new promClient.Counter({
      name: 'trace_anomaly_detected_total',
      help: 'Total number of anomalies detected',
      labelNames: ['service', 'type', 'severity'],
      registers: [this.register]
    });
    
    // 响应时间偏离指标
    this.durationDeviationGauge = new promClient.Gauge({
      name: 'trace_duration_deviation_percentage',
      help: 'Duration deviation from baseline percentage',
      labelNames: ['service', 'operation'],
      registers: [this.register]
    });
    
    // 根因分析指标
    this.rootCauseCounter = new promClient.Counter({
      name: 'trace_root_cause_identified_total',
      help: 'Total root causes identified',
      labelNames: ['service', 'type'],
      registers: [this.register]
    });
    
    // 模型性能指标
    this.modelAccuracyGauge = new promClient.Gauge({
      name: 'trace_anomaly_detection_accuracy',
      help: 'Anomaly detection model accuracy',
      labelNames: ['model'],
      registers: [this.register]
    });
  }
  
  exportAnomalyMetrics(anomaly) {
    this.anomalyCounter.inc({
      service: anomaly.service,
      type: anomaly.type,
      severity: anomaly.severity
    });
    
    // 导出偏离度
    anomaly.deviations.forEach(dev => {
      this.durationDeviationGauge.set(
        { service: anomaly.service, operation: dev.operation },
        dev.deviationPercentage
      );
    });
    
    // 导出根因统计
    if (anomaly.rootCause) {
      this.rootCauseCounter.inc({
        service: anomaly.service,
        type: anomaly.rootCause.type
      });
    }
  }
}
```

### 4.7 Grafana仪表板配置

```json
{
  "dashboard": {
    "title": "Distributed Tracing Anomaly Detection",
    "panels": [
      {
        "title": "Anomaly Detection Rate",
        "targets": [{
          "expr": "rate(trace_anomaly_detected_total[5m])"
        }]
      },
      {
        "title": "Performance Deviation by Service",
        "targets": [{
          "expr": "trace_duration_deviation_percentage"
        }]
      },
      {
        "title": "Root Cause Distribution",
        "type": "piechart",
        "targets": [{
          "expr": "sum by (type)(trace_root_cause_identified_total)"
        }]
      },
      {
        "title": "Model Accuracy",
        "targets": [{
          "expr": "trace_anomaly_detection_accuracy"
        }]
      }
    ]
  }
}
```

## 5. 验收标准（可测试）

- [ ] Isolation Forest模型训练成功，训练准确率 ≥ 90%
- [ ] LSTM模型能预测下一时刻性能指标，预测误差 < 15%
- [ ] P99延迟异常能在30秒内被检测到
- [ ] 异常检测准确率 ≥ 95%（通过历史数据回测验证）
- [ ] 误报率 < 10%（通过人工标注验证）
- [ ] 根因自动定位准确率 ≥ 80%
- [ ] 性能基线每小时自动更新
- [ ] 告警聚合功能将相关告警合并率 ≥ 70%
- [ ] Grafana仪表板正确显示所有指标
- [ ] 与现有Prometheus监控栈无缝集成
- [ ] 支持至少100万条trace/小时的处理能力
- [ ] 系统资源消耗增加 < 10%

## 6. 工作量估算

**L（Large）**
- 算法复杂度高，需要训练ML模型
- 涉及多个组件集成（Kafka、Prometheus、Grafana）
- 需要大量测试验证准确性
- 预计工作量：2-3周

**拆分子任务**：
- 追踪数据采集与特征工程：3天
- 异常检测算法实现（Isolation Forest + LSTM）：5天
- 根因分析引擎：3天
- 性能基线管理：2天
- 告警集成与降噪：2天
- 测试与调优：3天

## 7. 优先级理由

**P1（高优先级）**：

1. **生产环境急需**：当前缺乏智能性能监控，多次因性能问题导致用户投诉后才发现
2. **成熟度短板**：可观测性维度得分已达10分，但缺乏主动异常检测能力，影响从13分提升到15分
3. **运维效率提升**：能大幅缩短故障发现和定位时间，预计提升运维效率60%
4. **数据价值释放**：充分利用现有trace数据，从被动查询转为主动监控
5. **用户体验保障**：及时发现性能退化，避免影响大量用户

此需求是实现"可观测性从10分提升到15分"的关键一步，对项目成熟度评分有直接贡献。
