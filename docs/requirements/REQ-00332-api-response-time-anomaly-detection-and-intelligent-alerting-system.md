# REQ-00332: API 响应时间异常检测与智能告警系统

## 元信息

| 字段 | 值 |
|------|-----|
| 编号 | REQ-00332 |
| 标题 | API 响应时间异常检测与智能告警系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-26 07:00 UTC |

## 需求描述

### 背景

当前系统已有基础监控和告警机制，但缺乏智能化的响应时间异常检测能力。传统静态阈值告警存在以下问题：

1. **阈值配置困难**：不同接口性能特征差异大，统一阈值导致误报或漏报
2. **季节性模式忽视**：业务高峰期和低谷期的正常波动被视为异常
3. **告警风暴**：多服务同时触发告警，运维人员难以定位根因
4. **缺乏预测能力**：无法提前预警即将发生的性能劣化

### 目标

构建一个基于机器学习的 API 响应时间异常检测与智能告警系统，实现：

1. **自适应基线学习**：自动学习每个接口的正常响应时间范围
2. **多维度异常检测**：检测缓慢增长、突增、周期性异常等多种模式
3. **智能告警聚合**：关联分析多服务告警，识别根因并聚合通知
4. **预测性告警**：基于趋势预测提前预警性能劣化
5. **降噪与抑制**：减少重复告警，设置告警静默期

## 技术方案

### 1. 核心架构设计

```
┌─────────────────────────────────────────────────────────────────────┐
│                    API Response Time Anomaly Detection               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │   Gateway    │───▶│  Metrics     │───▶│  Time-Series        │  │
│  │   Proxy      │    │  Collector   │    │  Database (Prometheus)│  │
│  └──────────────┘    └──────────────┘    └──────────────────────┘  │
│         │                                          │                │
│         │                                          ▼                │
│         │                               ┌──────────────────────┐   │
│         │                               │  Anomaly Detection   │   │
│         │                               │  Engine              │   │
│         │                               │  ┌────────────────┐  │   │
│         │                               │  │ Baseline       │  │   │
│         │                               │  │ Learner        │  │   │
│         │                               │  └────────────────┘  │   │
│         │                               │  ┌────────────────┐  │   │
│         │                               │  │ Pattern        │  │   │
│         │                               │  │ Detector       │  │   │
│         │                               │  └────────────────┘  │   │
│         │                               │  ┌────────────────┐  │   │
│         │                               │  │ Trend          │  │   │
│         │                               │  │ Predictor      │  │   │
│         │                               │  └────────────────┘  │   │
│         │                               └──────────────────────┘   │
│         │                                          │                │
│         │                                          ▼                │
│         │                               ┌──────────────────────┐   │
│         │                               │  Alert Manager       │   │
│         │                               │  ┌────────────────┐  │   │
│         │                               │  │ Correlation    │  │   │
│         │                               │  │ Analyzer       │  │   │
│         │                               │  └────────────────┘  │   │
│         │                               │  ┌────────────────┐  │   │
│         │                               │  │ Noise          │  │   │
│         │                               │  │ Suppressor     │  │   │
│         │                               │  └────────────────┘  │   │
│         │                               │  ┌────────────────┐  │   │
│         │                               │  │ Notification   │  │   │
│         │                               │  │ Dispatcher     │  │   │
│         │                               │  └────────────────┘  │   │
│         │                               └──────────────────────┘   │
│         │                                          │                │
│         ▼                                          ▼                │
│  ┌──────────────┐                       ┌──────────────────────┐   │
│  │  Admin       │◀──────────────────────│  Alert Channels      │   │
│  │  Dashboard   │                       │  (Slack/Email/PagerDuty)│  │
│  └──────────────┘                       └──────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 2. 响应时间数据采集模块

**文件**: `backend/shared/metrics/responseTimeCollector.js`

```javascript
/**
 * API 响应时间采集器
 * 采集维度：端点、方法、状态码、用户类型
 */
class ResponseTimeCollector {
  constructor(options = {}) {
    this.histogramBuckets = [
      0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 25, 50, 100
    ];
    this.labels = ['service', 'endpoint', 'method', 'status_code', 'user_type'];
    this.registry = options.registry || require('prom-client').register;
    
    // 创建 Histogram 指标
    this.responseTimeHistogram = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: this.labels,
      buckets: this.histogramBuckets,
      registers: [this.registry]
    });
    
    // 创建计数器用于计算 QPS
    this.requestCounter = new Counter({
      name: 'http_requests_total',
      help: 'Total HTTP requests',
      labelNames: this.labels,
      registers: [this.registry]
    });
    
    // 存储最近 N 条响应时间数据用于实时分析
    this.recentData = new Map(); // endpoint -> Array<timestamp, duration>
    this.maxRecentDataPoints = 1000;
  }

  /**
   * 记录请求响应时间
   */
  recordRequest(service, endpoint, method, statusCode, duration, userType = 'normal') {
    const labels = {
      service,
      endpoint,
      method,
      status_code: String(statusCode),
      user_type: userType
    };
    
    this.responseTimeHistogram.observe(labels, duration);
    this.requestCounter.inc(labels, 1);
    
    // 存储到最近数据窗口
    const key = `${service}:${endpoint}:${method}`;
    if (!this.recentData.has(key)) {
      this.recentData.set(key, []);
    }
    const dataPoints = this.recentData.get(key);
    dataPoints.push({
      timestamp: Date.now(),
      duration,
      statusCode,
      userType
    });
    
    // 限制数据窗口大小
    if (dataPoints.length > this.maxRecentDataPoints) {
      dataPoints.shift();
    }
  }

  /**
   * 获取端点的最近数据
   */
  getRecentData(service, endpoint, method) {
    const key = `${service}:${endpoint}:${method}`;
    return this.recentData.get(key) || [];
  }

  /**
   * 创建 Express 中间件
   */
  middleware(serviceName) {
    return (req, res, next) => {
      const start = process.hrtime.bigint();
      
      res.on('finish', () => {
        const end = process.hrtime.bigint();
        const duration = Number(end - start) / 1e9; // 转换为秒
        
        const endpoint = req.route?.path || req.path;
        const userType = req.user?.type || 'anonymous';
        
        this.recordRequest(
          serviceName,
          endpoint,
          req.method,
          res.statusCode,
          duration,
          userType
        );
      });
      
      next();
    };
  }
}

module.exports = ResponseTimeCollector;
```

### 3. 自适应基线学习模块

**文件**: `backend/shared/anomaly/baselineLearner.js`

```javascript
/**
 * 自适应基线学习器
 * 使用滚动窗口统计和历史季节性分析学习正常响应时间范围
 */
class BaselineLearner {
  constructor(options = {}) {
    // 滚动窗口配置
    this.windowSize = options.windowSize || 7 * 24 * 60 * 60 * 1000; // 7天
    this.shortTermWindow = options.shortTermWindow || 60 * 60 * 1000; // 1小时
    this.longTermWindow = options.longTermWindow || 24 * 60 * 60 * 1000; // 24小时
    
    // 季节性配置
    this.seasonalityPatterns = {
      hourly: 60 * 60 * 1000,      // 1小时周期
      daily: 24 * 60 * 60 * 1000,  // 1天周期
      weekly: 7 * 24 * 60 * 60 * 1000 // 1周周期
    };
    
    // 存储基线数据
    this.baselines = new Map(); // endpoint -> BaselineData
  }

  /**
   * 学习端点的基线
   * @param {string} endpoint 端点标识
   * @param {Array} historicalData 历史数据 [{timestamp, duration}]
   * @returns {Object} 基线数据
   */
  learnBaseline(endpoint, historicalData) {
    if (historicalData.length < 100) {
      return this.getDefaultBaseline();
    }
    
    // 计算基础统计量
    const durations = historicalData.map(d => d.duration);
    const mean = this.calculateMean(durations);
    const stdDev = this.calculateStdDev(durations, mean);
    
    // 计算百分位数
    const percentiles = this.calculatePercentiles(durations, [0.5, 0.9, 0.95, 0.99]);
    
    // 季节性分析
    const seasonality = this.analyzeSeasonality(historicalData);
    
    // 趋势分析
    const trend = this.analyzeTrend(historicalData);
    
    const baseline = {
      endpoint,
      mean,
      stdDev,
      percentiles,
      seasonality,
      trend,
      upperBound: this.calculateUpperBound(mean, stdDev, percentiles),
      lowerBound: this.calculateLowerBound(mean, stdDev, percentiles),
      lastUpdated: Date.now(),
      sampleSize: historicalData.length
    };
    
    this.baselines.set(endpoint, baseline);
    return baseline;
  }

  /**
   * 计算季节性模式
   */
  analyzeSeasonality(historicalData) {
    const hourlyPatterns = new Map(); // hour -> durations
    const dailyPatterns = new Map();  // day -> durations
    
    for (const dataPoint of historicalData) {
      const date = new Date(dataPoint.timestamp);
      const hour = date.getHours();
      const day = date.getDay();
      
      if (!hourlyPatterns.has(hour)) {
        hourlyPatterns.set(hour, []);
      }
      hourlyPatterns.get(hour).push(dataPoint.duration);
      
      if (!dailyPatterns.has(day)) {
        dailyPatterns.set(day, []);
      }
      dailyPatterns.get(day).push(dataPoint.duration);
    }
    
    // 计算每小时的平均响应时间
    const hourlyMeans = {};
    for (const [hour, durations] of hourlyPatterns) {
      hourlyMeans[hour] = this.calculateMean(durations);
    }
    
    // 计算每天的平均响应时间
    const dailyMeans = {};
    for (const [day, durations] of dailyPatterns) {
      dailyMeans[day] = this.calculateMean(durations);
    }
    
    return {
      hourly: hourlyMeans,
      daily: dailyMeans
    };
  }

  /**
   * 分析趋势
   */
  analyzeTrend(historicalData) {
    if (historicalData.length < 2) {
      return { direction: 'stable', slope: 0 };
    }
    
    // 使用线性回归计算趋势
    const n = historicalData.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += historicalData[i].duration;
      sumXY += i * historicalData[i].duration;
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // 判断趋势方向
    let direction = 'stable';
    if (slope > 0.001) {
      direction = 'increasing';
    } else if (slope < -0.001) {
      direction = 'decreasing';
    }
    
    return {
      direction,
      slope,
      intercept,
      r2: this.calculateR2(historicalData, slope, intercept)
    };
  }

  /**
   * 计算上界（考虑季节性）
   */
  calculateUpperBound(mean, stdDev, percentiles) {
    // 使用 P95 + 3 * IQR 作为动态上界
    const p75 = percentiles[0.75] || percentiles[0.9];
    const p25 = percentiles[0.25] || percentiles[0.5];
    const iqr = p75 - p25;
    
    return {
      static: percentiles.p95 + stdDev,
      dynamic: percentiles.p95 + 1.5 * iqr
    };
  }

  /**
   * 计算下界
   */
  calculateLowerBound(mean, stdDev, percentiles) {
    return {
      static: Math.max(0, percentiles.p5 - stdDev),
      dynamic: percentiles.p5
    };
  }

  /**
   * 获取端点在特定时间的期望范围
   */
  getExpectedRange(endpoint, timestamp = Date.now()) {
    const baseline = this.baselines.get(endpoint);
    if (!baseline) {
      return this.getDefaultBaseline();
    }
    
    const date = new Date(timestamp);
    const hour = date.getHours();
    const day = date.getDay();
    
    // 基于季节性调整期望范围
    let seasonalMultiplier = 1;
    if (baseline.seasonality.hourly[hour]) {
      seasonalMultiplier = baseline.seasonality.hourly[hour] / baseline.mean;
    }
    
    return {
      lower: baseline.lowerBound.dynamic * seasonalMultiplier,
      upper: baseline.upperBound.dynamic * seasonalMultiplier,
      mean: baseline.mean * seasonalMultiplier,
      baseline: baseline
    };
  }

  /**
   * 辅助函数
   */
  calculateMean(values) {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  calculateStdDev(values, mean) {
    if (values.length === 0) return 0;
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    return Math.sqrt(this.calculateMean(squaredDiffs));
  }

  calculatePercentiles(values, percentiles) {
    const sorted = [...values].sort((a, b) => a - b);
    const result = {};
    
    for (const p of percentiles) {
      const index = Math.ceil(sorted.length * p) - 1;
      result[p] = sorted[Math.max(0, index)];
    }
    
    return result;
  }

  calculateR2(data, slope, intercept) {
    const yMean = this.calculateMean(data.map(d => d.duration));
    let ssTotal = 0, ssResidual = 0;
    
    for (let i = 0; i < data.length; i++) {
      const yActual = data[i].duration;
      const yPredicted = slope * i + intercept;
      ssTotal += Math.pow(yActual - yMean, 2);
      ssResidual += Math.pow(yActual - yPredicted, 2);
    }
    
    return 1 - (ssResidual / ssTotal);
  }

  getDefaultBaseline() {
    return {
      mean: 0,
      stdDev: 0,
      percentiles: { 0.5: 0, 0.9: 0, 0.95: 0, 0.99: 0 },
      upperBound: { static: 1, dynamic: 1 },
      lowerBound: { static: 0, dynamic: 0 },
      seasonality: { hourly: {}, daily: {} },
      trend: { direction: 'stable', slope: 0 }
    };
  }
}

module.exports = BaselineLearner;
```

### 4. 异常检测引擎

**文件**: `backend/shared/anomaly/anomalyDetector.js`

```javascript
/**
 * 多模式异常检测引擎
 * 支持：突发检测、缓慢增长检测、周期性异常检测
 */
class AnomalyDetector {
  constructor(options = {}) {
    this.baselineLearner = options.baselineLearner;
    this.detectors = {
      spike: new SpikeDetector(options.spike || {}),
      gradual: new GradualChangeDetector(options.gradual || {}),
      seasonal: new SeasonalAnomalyDetector(options.seasonal || {}),
      statistical: new StatisticalAnomalyDetector(options.statistical || {})
    };
    
    // 异常历史记录
    this.anomalyHistory = new Map(); // endpoint -> Array<Anomaly>
    this.maxHistorySize = 100;
  }

  /**
   * 检测响应时间是否异常
   * @param {string} endpoint 端点标识
   * @param {number} duration 响应时间（秒）
   * @param {number} timestamp 时间戳
   * @returns {Object|null} 异常信息，null 表示正常
   */
  detect(endpoint, duration, timestamp = Date.now()) {
    const expectedRange = this.baselineLearner.getExpectedRange(endpoint, timestamp);
    const baseline = this.baselineLearner.baselines.get(endpoint);
    
    if (!baseline) {
      return null; // 无基线数据，无法检测
    }
    
    // 运行所有检测器
    const detections = [];
    
    // 1. 突发检测
    const spikeResult = this.detectors.spike.detect(duration, expectedRange, baseline);
    if (spikeResult) {
      detections.push({
        type: 'spike',
        severity: spikeResult.severity,
        deviation: spikeResult.deviation,
        description: `响应时间突增至 ${duration.toFixed(3)}s，超过正常范围 ${expectedRange.upper.toFixed(3)}s`
      });
    }
    
    // 2. 缓慢增长检测
    const gradualResult = this.detectors.gradual.detect(endpoint, duration, timestamp);
    if (gradualResult) {
      detections.push({
        type: 'gradual_increase',
        severity: gradualResult.severity,
        trend: gradualResult.trend,
        description: `响应时间持续增长，趋势斜率 ${gradualResult.trend.slope.toFixed(6)}`
      });
    }
    
    // 3. 季节性异常检测
    const seasonalResult = this.detectors.seasonal.detect(endpoint, duration, timestamp, expectedRange);
    if (seasonalResult) {
      detections.push({
        type: 'seasonal_anomaly',
        severity: seasonalResult.severity,
        expectedValue: seasonalResult.expected,
        actualValue: duration,
        description: `当前时段期望响应时间 ${seasonalResult.expected.toFixed(3)}s，实际 ${duration.toFixed(3)}s`
      });
    }
    
    // 4. 统计异常检测
    const statisticalResult = this.detectors.statistical.detect(duration, baseline);
    if (statisticalResult) {
      detections.push({
        type: 'statistical',
        severity: statisticalResult.severity,
        zScore: statisticalResult.zScore,
        description: `Z-Score ${statisticalResult.zScore.toFixed(2)}，超过阈值 ${statisticalResult.threshold}`
      });
    }
    
    // 合并检测结果
    if (detections.length === 0) {
      return null;
    }
    
    const anomaly = {
      endpoint,
      timestamp,
      duration,
      expectedRange,
      detections,
      severity: this.calculateOverallSeverity(detections),
      isAnomaly: true
    };
    
    // 记录到历史
    this.recordAnomaly(endpoint, anomaly);
    
    return anomaly;
  }

  /**
   * 计算整体严重程度
   */
  calculateOverallSeverity(detections) {
    const severityScores = { critical: 3, high: 2, medium: 1, low: 0.5 };
    const maxSeverity = Math.max(...detections.map(d => severityScores[d.severity] || 0));
    
    // 多种检测同时触发时提升严重程度
    const severityBoost = detections.length > 1 ? 0.5 : 0;
    const totalScore = maxSeverity + severityBoost;
    
    if (totalScore >= 3) return 'critical';
    if (totalScore >= 2) return 'high';
    if (totalScore >= 1) return 'medium';
    return 'low';
  }

  /**
   * 记录异常到历史
   */
  recordAnomaly(endpoint, anomaly) {
    if (!this.anomalyHistory.has(endpoint)) {
      this.anomalyHistory.set(endpoint, []);
    }
    
    const history = this.anomalyHistory.get(endpoint);
    history.push(anomaly);
    
    if (history.length > this.maxHistorySize) {
      history.shift();
    }
  }

  /**
   * 获取端点的异常历史
   */
  getAnomalyHistory(endpoint, limit = 20) {
    const history = this.anomalyHistory.get(endpoint) || [];
    return history.slice(-limit);
  }
}

/**
 * 突发检测器
 */
class SpikeDetector {
  constructor(options = {}) {
    this.spikeMultiplier = options.spikeMultiplier || 3; // 超过均值 3 倍视为突发
    this.severityThresholds = {
      medium: 3,
      high: 5,
      critical: 10
    };
  }

  detect(duration, expectedRange, baseline) {
    if (duration <= expectedRange.upper) {
      return null;
    }
    
    const deviation = duration / expectedRange.upper;
    
    let severity = 'low';
    if (deviation >= this.severityThresholds.critical) {
      severity = 'critical';
    } else if (deviation >= this.severityThresholds.high) {
      severity = 'high';
    } else if (deviation >= this.severityThresholds.medium) {
      severity = 'medium';
    }
    
    return { severity, deviation };
  }
}

/**
 * 缓慢增长检测器
 */
class GradualChangeDetector {
  constructor(options = {}) {
    this.windowSize = options.windowSize || 10; // 最近 N 个数据点
    this.slopeThresholds = {
      medium: 0.0001,  // 每次增长 0.1ms
      high: 0.001,     // 每次增长 1ms
      critical: 0.01   // 每次增长 10ms
    };
    this.recentData = new Map();
  }

  detect(endpoint, duration, timestamp) {
    if (!this.recentData.has(endpoint)) {
      this.recentData.set(endpoint, []);
    }
    
    const data = this.recentData.get(endpoint);
    data.push({ duration, timestamp });
    
    if (data.length > this.windowSize) {
      data.shift();
    }
    
    if (data.length < 5) {
      return null;
    }
    
    // 计算趋势
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < data.length; i++) {
      sumX += i;
      sumY += data[i].duration;
      sumXY += i * data[i].duration;
      sumX2 += i * i;
    }
    
    const n = data.length;
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    
    if (slope <= this.slopeThresholds.medium) {
      return null;
    }
    
    let severity = 'medium';
    if (slope >= this.slopeThresholds.critical) {
      severity = 'critical';
    } else if (slope >= this.slopeThresholds.high) {
      severity = 'high';
    }
    
    return { severity, trend: { slope } };
  }
}

/**
 * 季节性异常检测器
 */
class SeasonalAnomalyDetector {
  constructor(options = {}) {
    this.deviationThreshold = options.deviationThreshold || 0.5; // 50% 偏差
  }

  detect(endpoint, duration, timestamp, expectedRange) {
    const expected = expectedRange.mean;
    
    if (expected === 0) {
      return null;
    }
    
    const deviation = Math.abs(duration - expected) / expected;
    
    if (deviation < this.deviationThreshold) {
      return null;
    }
    
    let severity = 'medium';
    if (deviation >= 1) {
      severity = 'critical';
    } else if (deviation >= 0.75) {
      severity = 'high';
    }
    
    return {
      severity,
      expected,
      deviation
    };
  }
}

/**
 * 统计异常检测器（基于 Z-Score）
 */
class StatisticalAnomalyDetector {
  constructor(options = {}) {
    this.zScoreThresholds = {
      medium: 2,
      high: 3,
      critical: 4
    };
  }

  detect(duration, baseline) {
    if (baseline.stdDev === 0) {
      return null;
    }
    
    const zScore = (duration - baseline.mean) / baseline.stdDev;
    
    if (zScore < this.zScoreThresholds.medium) {
      return null;
    }
    
    let severity = 'medium';
    let threshold = this.zScoreThresholds.medium;
    
    if (zScore >= this.zScoreThresholds.critical) {
      severity = 'critical';
      threshold = this.zScoreThresholds.critical;
    } else if (zScore >= this.zScoreThresholds.high) {
      severity = 'high';
      threshold = this.zScoreThresholds.high;
    }
    
    return { severity, zScore, threshold };
  }
}

module.exports = AnomalyDetector;
```

### 5. 智能告警管理器

**文件**: `backend/shared/anomaly/alertManager.js`

```javascript
/**
 * 智能告警管理器
 * 实现告警聚合、降噪、根因分析
 */
class AlertManager {
  constructor(options = {}) {
    this.channels = options.channels || []; // Slack, Email, PagerDuty
    this.alertHistory = new Map(); // alertId -> Alert
    this.activeAlerts = new Map(); // endpoint -> Alert
    this.silencePeriods = new Map(); // endpoint -> silenceEndTime
    this.correlationWindow = options.correlationWindow || 60000; // 60秒内的告警进行关联
    
    // 告警抑制配置
    this.suppressionConfig = {
      maxAlertsPerEndpoint: 3,        // 每个端点最多活跃告警数
      deduplicationWindow: 300000,     // 5分钟内相同告警去重
      silenceDuration: 1800000         // 静默期 30 分钟
    };
  }

  /**
   * 处理异常检测结果，生成告警
   */
  async processAnomaly(anomaly) {
    const { endpoint, severity, timestamp } = anomaly;
    
    // 检查静默期
    if (this.isSilenced(endpoint)) {
      return { suppressed: true, reason: 'silence_period' };
    }
    
    // 检查去重
    const existingAlert = this.activeAlerts.get(endpoint);
    if (existingAlert && this.isDuplicate(anomaly, existingAlert)) {
      return { suppressed: true, reason: 'duplicate' };
    }
    
    // 创建告警
    const alert = this.createAlert(anomaly);
    
    // 尝试关联分析
    const correlatedAlerts = this.findCorrelatedAlerts(alert);
    if (correlatedAlerts.length > 0) {
      alert.correlatedWith = correlatedAlerts.map(a => a.id);
      alert.rootCause = this.inferRootCause(alert, correlatedAlerts);
    }
    
    // 存储
    this.activeAlerts.set(endpoint, alert);
    this.alertHistory.set(alert.id, alert);
    
    // 发送通知
    await this.dispatchAlert(alert);
    
    // 检查是否需要设置静默期
    if (severity === 'high' || severity === 'critical') {
      this.setSilencePeriod(endpoint, this.suppressionConfig.silenceDuration);
    }
    
    return { suppressed: false, alert };
  }

  /**
   * 创建告警对象
   */
  createAlert(anomaly) {
    return {
      id: `alert-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      endpoint: anomaly.endpoint,
      timestamp: anomaly.timestamp,
      severity: anomaly.severity,
      duration: anomaly.duration,
      expectedRange: anomaly.expectedRange,
      detections: anomaly.detections,
      status: 'firing',
      acknowledged: false,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedAt: null,
      correlatedWith: [],
      rootCause: null,
      notificationsSent: []
    };
  }

  /**
   * 查找关联告警
   */
  findCorrelatedAlerts(newAlert) {
    const correlated = [];
    const windowStart = newAlert.timestamp - this.correlationWindow;
    
    for (const [endpoint, alert] of this.activeAlerts) {
      if (alert.id === newAlert.id) continue;
      if (alert.timestamp < windowStart) continue;
      
      // 判断是否相关
      if (this.areRelated(newAlert, alert)) {
        correlated.push(alert);
      }
    }
    
    return correlated;
  }

  /**
   * 判断两个告警是否相关
   */
  areRelated(alert1, alert2) {
    // 同一服务不同端点的告警可能相关
    const service1 = alert1.endpoint.split(':')[0];
    const service2 = alert2.endpoint.split(':')[0];
    
    if (service1 === service2) return true;
    
    // 依赖服务的告警可能相关（需要服务依赖图）
    // 这里简化处理，实际可以结合服务依赖关系
    return false;
  }

  /**
   * 推断根因
   */
  inferRootCause(newAlert, correlatedAlerts) {
    // 简单的根因推断逻辑
    // 如果多个服务同时出现响应时间异常，可能是下游服务问题
    
    const services = new Set();
    services.add(newAlert.endpoint.split(':')[0]);
    
    for (const alert of correlatedAlerts) {
      services.add(alert.endpoint.split(':')[0]);
    }
    
    if (services.size > 1) {
      return {
        type: 'downstream_issue',
        confidence: 0.7,
        description: `${services.size} 个服务同时出现响应时间异常，可能是共享下游服务问题`,
        affectedServices: Array.from(services)
      };
    }
    
    return {
      type: 'single_service',
      confidence: 0.9,
      description: `单个服务响应时间异常，可能是服务自身问题`,
      affectedServices: Array.from(services)
    };
  }

  /**
   * 检查是否在静默期
   */
  isSilenced(endpoint) {
    const silenceEndTime = this.silencePeriods.get(endpoint);
    if (!silenceEndTime) return false;
    
    if (Date.now() < silenceEndTime) {
      return true;
    }
    
    // 静默期已过，清除
    this.silencePeriods.delete(endpoint);
    return false;
  }

  /**
   * 设置静默期
   */
  setSilencePeriod(endpoint, duration) {
    this.silencePeriods.set(endpoint, Date.now() + duration);
  }

  /**
   * 检查是否重复告警
   */
  isDuplicate(newAnomaly, existingAlert) {
    if (Date.now() - existingAlert.timestamp > this.suppressionConfig.deduplicationWindow) {
      return false;
    }
    
    // 相同端点、相同类型检测视为重复
    const newTypes = new Set(newAnomaly.detections.map(d => d.type));
    const existingTypes = new Set(existingAlert.detections.map(d => d.type));
    
    for (const type of newTypes) {
      if (existingTypes.has(type)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 发送告警通知
   */
  async dispatchAlert(alert) {
    const notification = this.formatNotification(alert);
    
    for (const channel of this.channels) {
      try {
        await channel.send(notification);
        alert.notificationsSent.push({
          channel: channel.name,
          timestamp: Date.now(),
          success: true
        });
      } catch (error) {
        alert.notificationsSent.push({
          channel: channel.name,
          timestamp: Date.now(),
          success: false,
          error: error.message
        });
      }
    }
  }

  /**
   * 格式化告警通知
   */
  formatNotification(alert) {
    const severityEmoji = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '⚪'
    };
    
    const header = `${severityEmoji[alert.severity]} [${alert.severity.toUpperCase()}] API 响应时间异常`;
    
    const details = [
      `**端点**: ${alert.endpoint}`,
      `**响应时间**: ${alert.duration.toFixed(3)}s`,
      `**期望范围**: ${alert.expectedRange.lower.toFixed(3)}s - ${alert.expectedRange.upper.toFixed(3)}s`,
      `**检测类型**: ${alert.detections.map(d => d.type).join(', ')}`,
      `**时间**: ${new Date(alert.timestamp).toISOString()}`
    ];
    
    if (alert.rootCause) {
      details.push(`**根因分析**: ${alert.rootCause.description}`);
    }
    
    if (alert.correlatedWith.length > 0) {
      details.push(`**关联告警**: ${alert.correlatedWith.length} 个`);
    }
    
    return {
      title: header,
      body: details.join('\n'),
      severity: alert.severity,
      alertId: alert.id,
      actions: [
        { text: '查看详情', url: `/admin/alerts/${alert.id}` },
        { text: '确认', url: `/admin/alerts/${alert.id}/acknowledge` },
        { text: '静默', url: `/admin/alerts/${alert.id}/silence` }
      ]
    };
  }

  /**
   * 确认告警
   */
  acknowledgeAlert(alertId, acknowledgedBy) {
    const alert = this.alertHistory.get(alertId);
    if (!alert) return null;
    
    alert.acknowledged = true;
    alert.acknowledgedBy = acknowledgedBy;
    alert.acknowledgedAt = Date.now();
    
    return alert;
  }

  /**
   * 解决告警
   */
  resolveAlert(alertId) {
    const alert = this.alertHistory.get(alertId);
    if (!alert) return null;
    
    alert.status = 'resolved';
    alert.resolvedAt = Date.now();
    
    // 从活跃告警中移除
    this.activeAlerts.delete(alert.endpoint);
    
    return alert;
  }

  /**
   * 获取活跃告警
   */
  getActiveAlerts(filters = {}) {
    let alerts = Array.from(this.activeAlerts.values());
    
    if (filters.severity) {
      alerts = alerts.filter(a => a.severity === filters.severity);
    }
    
    if (filters.service) {
      alerts = alerts.filter(a => a.endpoint.startsWith(filters.service));
    }
    
    return alerts.sort((a, b) => b.timestamp - a.timestamp);
  }
}

module.exports = AlertManager;
```

### 6. 趋势预测模块

**文件**: `backend/shared/anomaly/trendPredictor.js`

```javascript
/**
 * 趋势预测器
 * 基于时间序列预测即将发生的性能劣化
 */
class TrendPredictor {
  constructor(options = {}) {
    this.predictionHorizon = options.predictionHorizon || 3600000; // 预测未来 1 小时
    this.warningThreshold = options.warningThreshold || 0.8; // 达到阈值的 80% 预警
  }

  /**
   * 预测未来响应时间趋势
   * @param {string} endpoint 端点标识
   * @param {Array} historicalData 历史数据
   * @param {number} slaThreshold SLA 阈值（秒）
   * @returns {Object} 预测结果
   */
  predict(endpoint, historicalData, slaThreshold) {
    if (historicalData.length < 10) {
      return { confidence: 0, predictions: [] };
    }
    
    // 使用指数加权移动平均 (EWMA) 预测
    const ewmaPredictions = this.ewmaPredict(historicalData);
    
    // 使用线性回归预测
    const regressionPredictions = this.linearRegressionPredict(historicalData);
    
    // 组合预测
    const combinedPredictions = this.combinePredictions(
      ewmaPredictions,
      regressionPredictions
    );
    
    // 检测是否即将突破阈值
    const thresholdBreach = this.detectThresholdBreach(
      combinedPredictions,
      slaThreshold
    );
    
    return {
      endpoint,
      current: historicalData[historicalData.length - 1].duration,
      predictions: combinedPredictions,
      thresholdBreach,
      confidence: this.calculateConfidence(historicalData),
      recommendation: this.generateRecommendation(thresholdBreach)
    };
  }

  /**
   * EWMA 预测
   */
  ewmaPredict(data, alpha = 0.3) {
    const predictions = [];
    let ewma = data[0].duration;
    
    // 计算当前 EWMA
    for (let i = 1; i < data.length; i++) {
      ewma = alpha * data[i].duration + (1 - alpha) * ewma;
    }
    
    // 预测未来数据点
    const steps = 12; // 未来 12 个时间点（每 5 分钟一个）
    for (let i = 1; i <= steps; i++) {
      predictions.push({
        timestamp: Date.now() + i * 5 * 60 * 1000,
        value: ewma, // EWMA 假设未来值等于当前 EWMA
        method: 'ewma'
      });
    }
    
    return predictions;
  }

  /**
   * 线性回归预测
   */
  linearRegressionPredict(data) {
    const n = data.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += data[i].duration;
      sumXY += i * data[i].duration;
      sumX2 += i * i;
    }
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // 预测未来数据点
    const predictions = [];
    const steps = 12;
    
    for (let i = 1; i <= steps; i++) {
      const futureIndex = n + i - 1;
      const value = slope * futureIndex + intercept;
      
      predictions.push({
        timestamp: Date.now() + i * 5 * 60 * 1000,
        value: Math.max(0, value),
        method: 'linear_regression'
      });
    }
    
    return predictions;
  }

  /**
   * 组合预测
   */
  combinePredictions(ewmaPredictions, regressionPredictions) {
    return ewmaPredictions.map((ewma, i) => ({
      timestamp: ewma.timestamp,
      value: (ewma.value + regressionPredictions[i].value) / 2,
      methods: ['ewma', 'linear_regression']
    }));
  }

  /**
   * 检测阈值突破
   */
  detectThresholdBreach(predictions, threshold) {
    for (let i = 0; i < predictions.length; i++) {
      const prediction = predictions[i];
      
      if (prediction.value >= threshold * this.warningThreshold) {
        return {
          willBreach: prediction.value >= threshold,
          predictedValue: prediction.value,
          threshold,
          timeToBreach: prediction.timestamp - Date.now(),
          stepIndex: i
        };
      }
    }
    
    return null;
  }

  /**
   * 计算预测置信度
   */
  calculateConfidence(data) {
    // 基于数据量和波动性计算置信度
    const dataFactor = Math.min(1, data.length / 100);
    
    const values = data.map(d => d.duration);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const cv = Math.sqrt(variance) / mean; // 变异系数
    
    const volatilityFactor = Math.max(0.3, 1 - cv);
    
    return dataFactor * volatilityFactor;
  }

  /**
   * 生成建议
   */
  generateRecommendation(thresholdBreach) {
    if (!thresholdBreach) {
      return null;
    }
    
    const minutes = Math.round(thresholdBreach.timeToBreach / 60000);
    
    if (thresholdBreach.willBreach) {
      return {
        type: 'critical',
        message: `预计 ${minutes} 分钟后将突破 SLA 阈值，建议立即采取措施`,
        actions: [
          '检查服务资源使用情况',
          '查看是否有异常流量',
          '准备扩容或限流'
        ]
      };
    }
    
    return {
      type: 'warning',
      message: `预计 ${minutes} 分钟后接近 SLA 阈值（${Math.round(thresholdBreach.predictedValue * 1000)}ms）`,
      actions: [
        '监控服务性能趋势',
        '评估扩容需求'
      ]
    };
  }
}

module.exports = TrendPredictor;
```

### 7. 定时任务调度

**文件**: `backend/jobs/anomalyDetectionJob.js`

```javascript
/**
 * 异常检测定时任务
 */
const cron = require('node-cron');
const { PrometheusDriver } = require('prometheus-query');
const BaselineLearner = require('../shared/anomaly/baselineLearner');
const AnomalyDetector = require('../shared/anomaly/anomalyDetector');
const AlertManager = require('../shared/anomaly/alertManager');
const TrendPredictor = require('../shared/anomaly/trendPredictor');

class AnomalyDetectionJob {
  constructor(config) {
    this.prometheus = new PrometheusDriver({
      endpoint: config.prometheusUrl,
      baseURL: '/api/v1'
    });
    
    this.baselineLearner = new BaselineLearner();
    this.anomalyDetector = new AnomalyDetector({
      baselineLearner: this.baselineLearner
    });
    this.alertManager = new AlertManager({
      channels: config.alertChannels
    });
    this.trendPredictor = new TrendPredictor();
    
    this.monitoredEndpoints = config.monitoredEndpoints || [];
    this.slaThresholds = config.slaThresholds || {};
  }

  /**
   * 启动定时任务
   */
  start() {
    // 每 5 分钟执行一次异常检测
    cron.schedule('*/5 * * * *', () => this.runDetection());
    
    // 每小时更新基线
    cron.schedule('0 * * * *', () => this.updateBaselines());
    
    // 每 15 分钟执行趋势预测
    cron.schedule('*/15 * * * *', () => this.runPrediction());
    
    console.log('Anomaly detection jobs started');
  }

  /**
   * 执行异常检测
   */
  async runDetection() {
    console.log('Running anomaly detection...');
    
    for (const endpoint of this.monitoredEndpoints) {
      try {
        // 查询最近 5 分钟的响应时间数据
        const query = `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{endpoint="${endpoint}"}[5m]))`;
        const result = await this.prometheus.rangeQueryInstant(query);
        
        if (result && result.length > 0) {
          const currentDuration = result[0].value;
          
          // 执行检测
          const anomaly = this.anomalyDetector.detect(endpoint, currentDuration);
          
          if (anomaly) {
            await this.alertManager.processAnomaly(anomaly);
            console.log(`Anomaly detected for ${endpoint}:`, anomaly.severity);
          }
        }
      } catch (error) {
        console.error(`Error detecting anomaly for ${endpoint}:`, error);
      }
    }
  }

  /**
   * 更新基线
   */
  async updateBaselines() {
    console.log('Updating baselines...');
    
    for (const endpoint of this.monitoredEndpoints) {
      try {
        // 查询过去 7 天的数据
        const query = `http_request_duration_seconds{endpoint="${endpoint}"}`;
        const result = await this.prometheus.rangeQuery(query, 7 * 24 * 60 * 60, 60);
        
        if (result && result.values) {
          const historicalData = result.values.map((v, i) => ({
            timestamp: Date.now() - (result.values.length - i) * 60000,
            duration: v
          }));
          
          this.baselineLearner.learnBaseline(endpoint, historicalData);
          console.log(`Baseline updated for ${endpoint}`);
        }
      } catch (error) {
        console.error(`Error updating baseline for ${endpoint}:`, error);
      }
    }
  }

  /**
   * 执行趋势预测
   */
  async runPrediction() {
    console.log('Running trend prediction...');
    
    for (const endpoint of this.monitoredEndpoints) {
      try {
        // 获取历史数据
        const query = `http_request_duration_seconds{endpoint="${endpoint}"}`;
        const result = await this.prometheus.rangeQuery(query, 2 * 60 * 60, 60); // 过去 2 小时
        
        if (result && result.values) {
          const historicalData = result.values.map((v, i) => ({
            timestamp: Date.now() - (result.values.length - i) * 60000,
            duration: v
          }));
          
          const slaThreshold = this.slaThresholds[endpoint] || 1.0;
          const prediction = this.trendPredictor.predict(
            endpoint,
            historicalData,
            slaThreshold
          );
          
          if (prediction.thresholdBreach && prediction.confidence > 0.5) {
            // 发送预测性告警
            const predictiveAlert = {
              endpoint,
              timestamp: Date.now(),
              severity: prediction.thresholdBreach.willBreach ? 'high' : 'medium',
              type: 'predictive',
              prediction,
              detections: [{
                type: 'predictive',
                severity: prediction.thresholdBreach.willBreach ? 'high' : 'medium',
                description: prediction.recommendation?.message
              }]
            };
            
            await this.alertManager.processAnomaly(predictiveAlert);
            console.log(`Predictive alert for ${endpoint}`);
          }
        }
      } catch (error) {
        console.error(`Error predicting trend for ${endpoint}:`, error);
      }
    }
  }
}

module.exports = AnomalyDetectionJob;
```

### 8. Admin Dashboard 集成

**文件**: `frontend/admin-dashboard/src/pages/AnomalyMonitoring.vue`

```vue
<template>
  <div class="anomaly-monitoring">
    <v-container fluid>
      <!-- 概览卡片 -->
      <v-row>
        <v-col cols="12" md="3">
          <v-card>
            <v-card-title>活跃告警</v-card-title>
            <v-card-text>
              <div class="text-h3">{{ activeAlertsCount }}</div>
              <div class="text-caption">
                <span class="critical">{{ criticalCount }} 严重</span> |
                <span class="high">{{ highCount }} 高</span> |
                <span class="medium">{{ mediumCount }} 中</span>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
        
        <v-col cols="12" md="3">
          <v-card>
            <v-card-title>监控端点</v-card-title>
            <v-card-text>
              <div class="text-h3">{{ monitoredEndpoints.length }}</div>
              <div class="text-caption">已配置监控的 API 端点</div>
            </v-card-text>
          </v-card>
        </v-col>
        
        <v-col cols="12" md="3">
          <v-card>
            <v-card-title>异常检测率</v-card-title>
            <v-card-text>
              <div class="text-h3">{{ anomalyRate.toFixed(1) }}%</div>
              <div class="text-caption">过去 24 小时</div>
            </v-card-text>
          </v-card>
        </v-col>
        
        <v-col cols="12" md="3">
          <v-card>
            <v-card-title>预测准确率</v-card-title>
            <v-card-text>
              <div class="text-h3">{{ predictionAccuracy.toFixed(1) }}%</div>
              <div class="text-caption">预测性告警准确率</div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- 实时响应时间图表 -->
      <v-row>
        <v-col cols="12">
          <v-card>
            <v-card-title>
              实时响应时间监控
              <v-spacer></v-spacer>
              <v-select
                v-model="selectedEndpoint"
                :items="monitoredEndpoints"
                label="选择端点"
                dense
                outlined
                style="max-width: 300px"
              ></v-select>
            </v-card-title>
            <v-card-text>
              <ResponseTimeChart
                :endpoint="selectedEndpoint"
                :baseline="currentBaseline"
              />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>

      <!-- 活跃告警列表 -->
      <v-row>
        <v-col cols="12">
          <v-card>
            <v-card-title>
              活跃告警
              <v-spacer></v-spacer>
              <v-btn color="primary" @click="acknowledgeAll">全部确认</v-btn>
            </v-card-title>
            <v-data-table
              :headers="alertHeaders"
              :items="activeAlerts"
              :items-per-page="10"
            >
              <template v-slot:item.severity="{ item }">
                <v-chip :color="getSeverityColor(item.severity)" small>
                  {{ item.severity }}
                </v-chip>
              </template>
              
              <template v-slot:item.timestamp="{ item }">
                {{ formatTimestamp(item.timestamp) }}
              </template>
              
              <template v-slot:item.duration="{ item }">
                {{ item.duration.toFixed(3) }}s
              </template>
              
              <template v-slot:item.actions="{ item }">
                <v-btn x-small @click="viewDetails(item)">详情</v-btn>
                <v-btn x-small @click="acknowledge(item)">确认</v-btn>
                <v-btn x-small @click="silence(item)">静默</v-btn>
              </template>
            </v-data-table>
          </v-card>
        </v-col>
      </v-row>

      <!-- 异常历史趋势 -->
      <v-row>
        <v-col cols="12" md="6">
          <v-card>
            <v-card-title>异常类型分布</v-card-title>
            <v-card-text>
              <PieChart :data="anomalyTypeDistribution" />
            </v-card-text>
          </v-card>
        </v-col>
        
        <v-col cols="12" md="6">
          <v-card>
            <v-card-title>响应时间基线范围</v-card-title>
            <v-card-text>
              <BaselineRangeChart :baselines="endpointBaselines" />
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </v-container>

    <!-- 告警详情对话框 -->
    <v-dialog v-model="detailsDialog" max-width="800">
      <v-card v-if="selectedAlert">
        <v-card-title>
          告警详情 - {{ selectedAlert.id }}
          <v-spacer></v-spacer>
          <v-chip :color="getSeverityColor(selectedAlert.severity)">
            {{ selectedAlert.severity }}
          </v-chip>
        </v-card-title>
        <v-card-text>
          <v-simple-table>
            <template v-slot:default>
              <tbody>
                <tr><td>端点</td><td>{{ selectedAlert.endpoint }}</td></tr>
                <tr><td>响应时间</td><td>{{ selectedAlert.duration.toFixed(3) }}s</td></tr>
                <tr><td>期望范围</td><td>{{ selectedAlert.expectedRange.lower.toFixed(3) }}s - {{ selectedAlert.expectedRange.upper.toFixed(3) }}s</td></tr>
                <tr><td>检测时间</td><td>{{ formatTimestamp(selectedAlert.timestamp) }}</td></tr>
                <tr><td>检测类型</td><td>{{ selectedAlert.detections.map(d => d.type).join(', ') }}</td></tr>
                <tr v-if="selectedAlert.rootCause">
                  <td>根因分析</td>
                  <td>{{ selectedAlert.rootCause.description }}</td>
                </tr>
              </tbody>
            </template>
          </v-simple-table>
          
          <v-divider class="my-4"></v-divider>
          
          <h4>检测结果</h4>
          <v-list>
            <v-list-item v-for="detection in selectedAlert.detections" :key="detection.type">
              <v-list-item-content>
                <v-list-item-title>{{ detection.type }}</v-list-item-title>
                <v-list-item-subtitle>{{ detection.description }}</v-list-item-subtitle>
              </v-list-item-content>
            </v-list-item>
          </v-list>
        </v-card-text>
        <v-card-actions>
          <v-spacer></v-spacer>
          <v-btn text @click="detailsDialog = false">关闭</v-btn>
          <v-btn color="primary" @click="acknowledge(selectedAlert)">确认</v-btn>
          <v-btn color="warning" @click="silence(selectedAlert)">静默</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script>
import ResponseTimeChart from '@/components/ResponseTimeChart.vue';
import PieChart from '@/components/PieChart.vue';
import BaselineRangeChart from '@/components/BaselineRangeChart.vue';

export default {
  name: 'AnomalyMonitoring',
  components: {
    ResponseTimeChart,
    PieChart,
    BaselineRangeChart
  },
  data() {
    return {
      activeAlerts: [],
      monitoredEndpoints: [],
      selectedEndpoint: null,
      currentBaseline: null,
      endpointBaselines: [],
      detailsDialog: false,
      selectedAlert: null,
      alertHeaders: [
        { text: '严重程度', value: 'severity' },
        { text: '端点', value: 'endpoint' },
        { text: '响应时间', value: 'duration' },
        { text: '检测类型', value: 'detections[0].type' },
        { text: '时间', value: 'timestamp' },
        { text: '操作', value: 'actions', sortable: false }
      ]
    };
  },
  computed: {
    activeAlertsCount() {
      return this.activeAlerts.length;
    },
    criticalCount() {
      return this.activeAlerts.filter(a => a.severity === 'critical').length;
    },
    highCount() {
      return this.activeAlerts.filter(a => a.severity === 'high').length;
    },
    mediumCount() {
      return this.activeAlerts.filter(a => a.severity === 'medium').length;
    },
    anomalyRate() {
      // 计算过去 24 小时的异常率
      return 2.3; // 示例值
    },
    predictionAccuracy() {
      // 计算预测准确率
      return 87.5; // 示例值
    },
    anomalyTypeDistribution() {
      const types = {};
      for (const alert of this.activeAlerts) {
        for (const detection of alert.detections) {
          types[detection.type] = (types[detection.type] || 0) + 1;
        }
      }
      return types;
    }
  },
  methods: {
    async fetchActiveAlerts() {
      try {
        const response = await this.$http.get('/api/admin/anomalies/alerts/active');
        this.activeAlerts = response.data;
      } catch (error) {
        console.error('Failed to fetch active alerts:', error);
      }
    },
    async fetchMonitoredEndpoints() {
      try {
        const response = await this.$http.get('/api/admin/anomalies/endpoints');
        this.monitoredEndpoints = response.data;
        if (this.monitoredEndpoints.length > 0 && !this.selectedEndpoint) {
          this.selectedEndpoint = this.monitoredEndpoints[0];
        }
      } catch (error) {
        console.error('Failed to fetch monitored endpoints:', error);
      }
    },
    async fetchBaseline(endpoint) {
      try {
        const response = await this.$http.get(`/api/admin/anomalies/baselines/${encodeURIComponent(endpoint)}`);
        this.currentBaseline = response.data;
      } catch (error) {
        console.error('Failed to fetch baseline:', error);
      }
    },
    viewDetails(alert) {
      this.selectedAlert = alert;
      this.detailsDialog = true;
    },
    async acknowledge(alert) {
      try {
        await this.$http.post(`/api/admin/anomalies/alerts/${alert.id}/acknowledge`);
        await this.fetchActiveAlerts();
      } catch (error) {
        console.error('Failed to acknowledge alert:', error);
      }
    },
    async acknowledgeAll() {
      for (const alert of this.activeAlerts) {
        await this.acknowledge(alert);
      }
    },
    async silence(alert) {
      try {
        await this.$http.post(`/api/admin/anomalies/alerts/${alert.id}/silence`, {
          duration: 1800000 // 30 分钟
        });
        await this.fetchActiveAlerts();
      } catch (error) {
        console.error('Failed to silence alert:', error);
      }
    },
    getSeverityColor(severity) {
      const colors = {
        critical: 'red',
        high: 'orange',
        medium: 'yellow',
        low: 'grey'
      };
      return colors[severity] || 'grey';
    },
    formatTimestamp(timestamp) {
      return new Date(timestamp).toLocaleString();
    }
  },
  watch: {
    selectedEndpoint(newEndpoint) {
      if (newEndpoint) {
        this.fetchBaseline(newEndpoint);
      }
    }
  },
  mounted() {
    this.fetchActiveAlerts();
    this.fetchMonitoredEndpoints();
    
    // 设置自动刷新
    this.refreshInterval = setInterval(() => {
      this.fetchActiveAlerts();
    }, 30000); // 每 30 秒刷新
  },
  beforeDestroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }
};
</script>

<style scoped>
.anomaly-monitoring {
  padding: 16px;
}

.critical { color: red; }
.high { color: orange; }
.medium { color: #ffc107; }
</style>
```

### 9. API 路由

**文件**: `backend/services/gateway/routes/anomalyRoutes.js`

```javascript
const express = require('express');
const router = express.Router();
const AlertManager = require('../../shared/anomaly/alertManager');
const BaselineLearner = require('../../shared/anomaly/baselineLearner');

// 初始化（实际应从依赖注入容器获取）
const alertManager = new AlertManager();
const baselineLearner = new BaselineLearner();

/**
 * GET /api/admin/anomalies/alerts/active
 * 获取活跃告警列表
 */
router.get('/alerts/active', async (req, res) => {
  try {
    const { severity, service } = req.query;
    const alerts = alertManager.getActiveAlerts({ severity, service });
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/anomalies/alerts/:id
 * 获取告警详情
 */
router.get('/alerts/:id', async (req, res) => {
  try {
    const alert = alertManager.alertHistory.get(req.params.id);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json(alert);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/anomalies/alerts/:id/acknowledge
 * 确认告警
 */
router.post('/alerts/:id/acknowledge', async (req, res) => {
  try {
    const alert = alertManager.acknowledgeAlert(
      req.params.id,
      req.user?.id || 'unknown'
    );
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    res.json(alert);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/anomalies/alerts/:id/silence
 * 设置静默期
 */
router.post('/alerts/:id/silence', async (req, res) => {
  try {
    const alert = alertManager.alertHistory.get(req.params.id);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    
    const duration = req.body.duration || 1800000; // 默认 30 分钟
    alertManager.setSilencePeriod(alert.endpoint, duration);
    
    res.json({ success: true, silencedUntil: Date.now() + duration });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/anomalies/endpoints
 * 获取监控的端点列表
 */
router.get('/endpoints', async (req, res) => {
  try {
    const endpoints = Array.from(baselineLearner.baselines.keys());
    res.json(endpoints);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/admin/anomalies/baselines/:endpoint
 * 获取端点的基线数据
 */
router.get('/baselines/:endpoint', async (req, res) => {
  try {
    const baseline = baselineLearner.baselines.get(req.params.endpoint);
    if (!baseline) {
      return res.status(404).json({ error: 'Baseline not found' });
    }
    res.json(baseline);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/admin/anomalies/baselines/:endpoint/refresh
 * 手动刷新基线
 */
router.post('/baselines/:endpoint/refresh', async (req, res) => {
  try {
    // 触发基线重新学习（实际实现需要获取历史数据）
    res.json({ success: true, message: 'Baseline refresh triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] **数据采集**：响应时间数据正确采集并存储到 Prometheus，支持按服务/端点/方法/状态码多维度查询
- [ ] **基线学习**：自动学习每个端点的正常响应时间范围，包含季节性模式分析（每小时/每天波动）
- [ ] **突发检测**：能够检测响应时间突增异常，准确率 > 90%
- [ ] **缓慢增长检测**：能够检测响应时间持续增长趋势，提前预警
- [ ] **季节性异常检测**：能够区分正常业务高峰和异常波动
- [ ] **统计异常检测**：基于 Z-Score 的统计异常检测正常工作
- [ ] **智能告警聚合**：多个相关告警自动聚合，减少告警风暴
- [ ] **根因推断**：能够推断多服务异常的可能根因
- [ ] **告警降噪**：重复告警去重、静默期设置正常工作，告警数量减少 > 50%
- [ ] **预测性告警**：能够预测未来 1 小时内的性能劣化，准确率 > 70%
- [ ] **多通道通知**：支持 Slack/Email/PagerDuty 多通道告警通知
- [ ] **Admin Dashboard**：实时监控页面正常展示告警、基线、历史趋势
- [ ] **告警操作**：支持确认、静默、解决等告警生命周期管理
- [ ] **API 接口**：所有管理 API 正常工作，响应时间 < 100ms
- [ ] **性能要求**：异常检测延迟 < 5 秒，不影响正常业务请求

## 影响范围

### 新增文件
- `backend/shared/metrics/responseTimeCollector.js` - 响应时间采集器
- `backend/shared/anomaly/baselineLearner.js` - 基线学习模块
- `backend/shared/anomaly/anomalyDetector.js` - 异常检测引擎
- `backend/shared/anomaly/alertManager.js` - 智能告警管理器
- `backend/shared/anomaly/trendPredictor.js` - 趋势预测模块
- `backend/jobs/anomalyDetectionJob.js` - 定时任务调度
- `backend/services/gateway/routes/anomalyRoutes.js` - API 路由
- `frontend/admin-dashboard/src/pages/AnomalyMonitoring.vue` - 监控页面
- `frontend/admin-dashboard/src/components/ResponseTimeChart.vue` - 响应时间图表组件
- `frontend/admin-dashboard/src/components/BaselineRangeChart.vue` - 基线范围图表组件

### 修改文件
- `backend/services/gateway/server.js` - 挂载异常检测路由
- `backend/shared/index.js` - 导出异常检测模块
- `infrastructure/k8s/monitoring/prometheus.yml` - 添加自定义指标查询
- `infrastructure/k8s/monitoring/alertmanager.yml` - 集成智能告警

## 参考

- [Prometheus Query Documentation](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Time Series Anomaly Detection](https://arxiv.org/abs/2009.09889)
- [Google SRE Book - Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/)
- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/)
