# REQ-00158: 业务事件异常检测与智能告警系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00158 |
| 标题 | 业务事件异常检测与智能告警系统 |
| 类别 | 可观测性/监控 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared、Kafka、infrastructure/k8s/monitoring |
| 创建时间 | 2026-06-13 10:00 |

## 需求描述

基于 REQ-00130 的实时业务事件流基础设施，实现智能异常检测与告警系统。该系统能够自动识别业务指标异常模式（如捕捉成功率突降、支付失败率飙升、用户活跃度异常波动等），减少误报，提高告警准确率，帮助运营团队快速定位问题根因。

### 核心目标
1. **智能异常检测**：基于统计学方法（Z-Score、IQR）和时序预测模型自动检测异常
2. **告警降噪**：告警聚合、去重、静默策略，减少告警疲劳
3. **根因定位**：自动关联相关指标，辅助定位问题根因
4. **可视化仪表板**：实时展示异常事件历史和趋势

## 技术方案

### 1. 异常检测引擎

```javascript
// backend/shared/anomalyDetection/AnomalyDetector.js

const { SimpleLinearRegression } = require('ml-regression');
const logger = require('../logger');

class AnomalyDetector {
  constructor(config = {}) {
    this.zScoreThreshold = config.zScoreThreshold || 3.0;
    this.iqrMultiplier = config.iqrMultiplier || 1.5;
    this.minDataPoints = config.minDataPoints || 10;
    this.windowSize = config.windowSize || 60; // 分钟
  }

  /**
   * Z-Score 异常检测
   */
  detectZScoreAnomaly(values, currentValue) {
    if (values.length < this.minDataPoints) {
      return { isAnomaly: false, reason: 'insufficient_data' };
    }

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) {
      return { isAnomaly: false, reason: 'zero_variance' };
    }

    const zScore = (currentValue - mean) / stdDev;
    const isAnomaly = Math.abs(zScore) > this.zScoreThreshold;

    return {
      isAnomaly,
      zScore,
      mean,
      stdDev,
      threshold: this.zScoreThreshold,
      direction: zScore > 0 ? 'high' : 'low'
    };
  }

  /**
   * IQR 异常检测
   */
  detectIQRAnomaly(values, currentValue) {
    if (values.length < this.minDataPoints) {
      return { isAnomaly: false, reason: 'insufficient_data' };
    }

    const sorted = [...values].sort((a, b) => a - b);
    const q1Index = Math.floor(sorted.length * 0.25);
    const q3Index = Math.floor(sorted.length * 0.75);
    const q1 = sorted[q1Index];
    const q3 = sorted[q3Index];
    const iqr = q3 - q1;

    const lowerBound = q1 - this.iqrMultiplier * iqr;
    const upperBound = q3 + this.iqrMultiplier * iqr;

    const isAnomaly = currentValue < lowerBound || currentValue > upperBound;

    return {
      isAnomaly,
      currentValue,
      lowerBound,
      upperBound,
      q1,
      q3,
      iqr,
      direction: currentValue < lowerBound ? 'low' : (currentValue > upperBound ? 'high' : null)
    };
  }

  /**
   * 时序预测异常检测（简单线性回归）
   */
  detectTrendAnomaly(historicalData, currentValue) {
    if (historicalData.length < this.minDataPoints) {
      return { isAnomaly: false, reason: 'insufficient_data' };
    }

    const timestamps = historicalData.map((d, i) => i);
    const values = historicalData.map(d => d.value);

    const regression = new SimpleLinearRegression(timestamps, values);
    const predicted = regression.predict(historicalData.length);
    const residuals = values.map((v, i) => Math.abs(v - regression.predict(i)));
    const meanResidual = residuals.reduce((a, b) => a + b, 0) / residuals.length;

    const deviation = Math.abs(currentValue - predicted);
    const isAnomaly = deviation > meanResidual * 3;

    return {
      isAnomaly,
      predicted,
      actual: currentValue,
      deviation,
      meanResidual,
      slope: regression.slope,
      intercept: regression.intercept
    };
  }

  /**
   * 综合异常检测
   */
  async detect(historicalData, currentValue, methods = ['zscore', 'iqr', 'trend']) {
    const values = historicalData.map(d => d.value);
    const results = {};

    if (methods.includes('zscore')) {
      results.zscore = this.detectZScoreAnomaly(values, currentValue);
    }

    if (methods.includes('iqr')) {
      results.iqr = this.detectIQRAnomaly(values, currentValue);
    }

    if (methods.includes('trend')) {
      results.trend = this.detectTrendAnomaly(historicalData, currentValue);
    }

    // 综合判断：至少两种方法检测到异常才认为是真正异常
    const anomalyCount = Object.values(results).filter(r => r.isAnomaly).length;
    results.isAnomaly = anomalyCount >= 2;
    results.confidence = anomalyCount / methods.length;

    return results;
  }
}

module.exports = AnomalyDetector;
```

### 2. 业务指标监控器

```javascript
// backend/shared/anomalyDetection/BusinessMetricsMonitor.js

const EventEmitter = require('events');
const Redis = require('ioredis');
const AnomalyDetector = require('./AnomalyDetector');
const logger = require('../logger');

class BusinessMetricsMonitor extends EventEmitter {
  constructor(config = {}) {
    super();
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.detector = new AnomalyDetector(config.detectorConfig);
    this.metricsConfig = this.loadMetricsConfig();
    this.checkInterval = config.checkInterval || 60000; // 1分钟
  }

  loadMetricsConfig() {
    return {
      'catch_success_rate': {
        description: '捕捉成功率',
        window: 60,
        thresholds: { low: 0.3, high: 0.95 },
        severity: { low: 'critical', high: 'warning' }
      },
      'payment_failure_rate': {
        description: '支付失败率',
        window: 60,
        thresholds: { low: 0, high: 0.05 },
        severity: { low: 'info', high: 'critical' }
      },
      'user_active_count': {
        description: '活跃用户数',
        window: 60,
        thresholds: { low: null, high: null },
        severity: { low: 'warning', high: 'warning' }
      },
      'gym_battle_duration': {
        description: '道馆战斗平均时长',
        window: 60,
        thresholds: { low: 5, high: 300 },
        severity: { low: 'info', high: 'warning' }
      },
      'api_error_rate': {
        description: 'API 错误率',
        window: 60,
        thresholds: { low: 0, high: 0.01 },
        severity: { low: 'info', high: 'critical' }
      }
    };
  }

  /**
   * 记录业务指标
   */
  async recordMetric(metricName, value, labels = {}) {
    const timestamp = Date.now();
    const key = `metric:${metricName}:${timestamp}`;
    const labelKey = `metric_labels:${metricName}`;

    await this.redis.multi()
      .set(key, JSON.stringify({ value, labels, timestamp }))
      .expire(key, 86400) // 保留24小时
      .hset(labelKey, timestamp, JSON.stringify(labels))
      .expire(labelKey, 86400)
      .exec();

    // 触发实时检测
    await this.checkForAnomaly(metricName, value, labels);
  }

  /**
   * 获取历史数据
   */
  async getHistoricalData(metricName, windowMinutes = 60) {
    const now = Date.now();
    const startTime = now - windowMinutes * 60 * 1000;
    
    const keys = await this.redis.keys(`metric:${metricName}:*`);
    const data = [];

    for (const key of keys) {
      const timestamp = parseInt(key.split(':').pop());
      if (timestamp >= startTime) {
        const record = await this.redis.get(key);
        if (record) {
          data.push(JSON.parse(record));
        }
      }
    }

    return data.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 检测异常
   */
  async checkForAnomaly(metricName, currentValue, labels = {}) {
    const config = this.metricsConfig[metricName];
    if (!config) return;

    const historicalData = await this.getHistoricalData(metricName, config.window);
    
    if (historicalData.length < 10) {
      logger.debug(`Insufficient data for ${metricName}`, { count: historicalData.length });
      return;
    }

    const result = await this.detector.detect(historicalData, currentValue);

    if (result.isAnomaly) {
      const alert = {
        metricName,
        metricDescription: config.description,
        currentValue,
        historicalMean: result.zscore?.mean,
        zScore: result.zscore?.zScore,
        confidence: result.confidence,
        severity: this.determineSeverity(config, currentValue, result),
        labels,
        timestamp: new Date().toISOString(),
        historicalData: historicalData.slice(-10) // 最近10个数据点
      };

      await this.emitAlert(alert);
    }
  }

  /**
   * 确定告警严重级别
   */
  determineSeverity(config, value, result) {
    if (!result.isAnomaly) return 'info';

    const { thresholds, severity } = config;
    const direction = result.zscore?.direction;

    if (direction === 'low' && thresholds.low !== null && value < thresholds.low) {
      return severity.low || 'warning';
    }

    if (direction === 'high' && thresholds.high !== null && value > thresholds.high) {
      return severity.high || 'warning';
    }

    // 基于置信度
    if (result.confidence > 0.8) return 'critical';
    if (result.confidence > 0.5) return 'warning';
    return 'info';
  }

  /**
   * 发送告警
   */
  async emitAlert(alert) {
    logger.warn('Business metric anomaly detected', alert);
    
    this.emit('anomaly', alert);
    
    // 发送到告警系统
    await this.sendToAlertManager(alert);
    
    // 存储告警历史
    await this.storeAlert(alert);
  }

  /**
   * 发送到 Alertmanager
   */
  async sendToAlertManager(alert) {
    const alertmanagerUrl = process.env.ALERTMANAGER_URL;
    if (!alertmanagerUrl) return;

    try {
      const response = await fetch(`${alertmanagerUrl}/api/v1/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{
          labels: {
            alertname: `BusinessAnomaly_${alert.metricName}`,
            severity: alert.severity,
            service: alert.labels.service || 'unknown'
          },
          annotations: {
            summary: `业务指标异常: ${alert.metricDescription}`,
            description: `当前值: ${alert.currentValue}, 历史均值: ${alert.historicalMean}, Z-Score: ${alert.zScore?.toFixed(2)}`,
            confidence: alert.confidence.toString()
          },
          startsAt: alert.timestamp
        }])
      });

      if (!response.ok) {
        logger.error('Failed to send alert to Alertmanager', { status: response.status });
      }
    } catch (error) {
      logger.error('Error sending alert to Alertmanager', { error: error.message });
    }
  }

  /**
   * 存储告警历史
   */
  async storeAlert(alert) {
    const key = `alerts:history:${Date.now()}`;
    await this.redis.setex(key, 604800, JSON.stringify(alert)); // 保留7天
  }
}

module.exports = BusinessMetricsMonitor;
```

### 3. 告警聚合与降噪器

```javascript
// backend/shared/anomalyDetection/AlertAggregator.js

const Redis = require('ioredis');
const logger = require('../logger');

class AlertAggregator {
  constructor(config = {}) {
    this.redis = new Redis(config.redisUrl || process.env.REDIS_URL);
    this.aggregationWindow = config.aggregationWindow || 300; // 5分钟聚合窗口
    this.cooldownPeriod = config.cooldownPeriod || 600; // 10分钟冷却期
    this.maxAlertsPerWindow = config.maxAlertsPerWindow || 50;
  }

  /**
   * 处理告警（聚合、去重、静默）
   */
  async processAlert(alert) {
    const alertKey = this.getAlertKey(alert);
    
    // 检查冷却期
    if (await this.isInCooldown(alertKey)) {
      logger.debug(`Alert ${alertKey} is in cooldown, skipping`);
      return null;
    }

    // 检查聚合窗口内是否有相似告警
    const aggregatedAlert = await this.findSimilarAlert(alert);
    
    if (aggregatedAlert) {
      // 更新聚合计数
      await this.incrementAlertCount(aggregatedAlert.id);
      logger.info(`Aggregated alert: ${alertKey}`, { count: aggregatedAlert.count + 1 });
      return null;
    }

    // 创建新告警
    const newAlert = await this.createNewAlert(alert);
    
    // 设置冷却期
    await this.setCooldown(alertKey);

    return newAlert;
  }

  /**
   * 生成告警唯一键
   */
  getAlertKey(alert) {
    return `alert:${alert.metricName}:${alert.severity}:${JSON.stringify(alert.labels)}`;
  }

  /**
   * 检查冷却期
   */
  async isInCooldown(alertKey) {
    const cooldownKey = `cooldown:${alertKey}`;
    return await this.redis.exists(cooldownKey);
  }

  /**
   * 设置冷却期
   */
  async setCooldown(alertKey) {
    const cooldownKey = `cooldown:${alertKey}`;
    await this.redis.setex(cooldownKey, this.cooldownPeriod, '1');
  }

  /**
   * 查找相似告警
   */
  async findSimilarAlert(alert) {
    const windowStart = Date.now() - this.aggregationWindow * 1000;
    const keys = await this.redis.keys('alert_instance:*');
    
    for (const key of keys) {
      const data = await this.redis.get(key);
      if (!data) continue;

      const existingAlert = JSON.parse(data);
      
      // 检查是否相似
      if (this.isSimilarAlert(existingAlert, alert)) {
        return existingAlert;
      }
    }

    return null;
  }

  /**
   * 判断告警是否相似
   */
  isSimilarAlert(alert1, alert2) {
    return (
      alert1.metricName === alert2.metricName &&
      alert1.severity === alert2.severity &&
      JSON.stringify(alert1.labels) === JSON.stringify(alert2.labels) &&
      Date.now() - new Date(alert1.timestamp).getTime() < this.aggregationWindow * 1000
    );
  }

  /**
   * 创建新告警实例
   */
  async createNewAlert(alert) {
    const id = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const alertInstance = {
      id,
      ...alert,
      count: 1,
      firstOccurrence: alert.timestamp,
      lastOccurrence: alert.timestamp
    };

    await this.redis.setex(
      `alert_instance:${id}`,
      this.aggregationWindow * 2,
      JSON.stringify(alertInstance)
    );

    return alertInstance;
  }

  /**
   * 增加告警计数
   */
  async incrementAlertCount(alertId) {
    const key = `alert_instance:${alertId}`;
    const data = await this.redis.get(key);
    
    if (data) {
      const alert = JSON.parse(data);
      alert.count++;
      alert.lastOccurrence = new Date().toISOString();
      await this.redis.setex(key, this.aggregationWindow * 2, JSON.stringify(alert));
    }
  }

  /**
   * 静默规则管理
   */
  async createSilenceRule(matchers, duration, createdBy, comment) {
    const silenceId = `silence_${Date.now()}`;
    const silence = {
      id: silenceId,
      matchers,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + duration * 1000).toISOString(),
      createdBy,
      comment,
      status: 'active'
    };

    await this.redis.setex(`silence:${silenceId}`, duration, JSON.stringify(silence));
    logger.info('Created silence rule', { silenceId, duration, matchers });
    
    return silence;
  }

  /**
   * 检查告警是否被静默
   */
  async isSilenced(alert) {
    const silenceKeys = await this.redis.keys('silence:*');
    
    for (const key of silenceKeys) {
      const silence = JSON.parse(await this.redis.get(key));
      
      if (this.matchesSilence(alert, silence.matchers)) {
        logger.info(`Alert ${alert.metricName} is silenced`, { silenceId: silence.id });
        return true;
      }
    }

    return false;
  }

  /**
   * 检查告警是否匹配静默规则
   */
  matchesSilence(alert, matchers) {
    return matchers.every(matcher => {
      const value = matcher.isLabel 
        ? alert.labels[matcher.name]
        : alert[matcher.name];
      
      if (matcher.isRegex) {
        return new RegExp(matcher.value).test(value);
      }
      
      return value === matcher.value;
    });
  }
}

module.exports = AlertAggregator;
```

### 4. 根因分析器

```javascript
// backend/shared/anomalyDetection/RootCauseAnalyzer.js

const logger = require('../logger');

class RootCauseAnalyzer {
  constructor(config = {}) {
    this.correlationThreshold = config.correlationThreshold || 0.7;
    this.relatedMetrics = this.loadRelatedMetrics();
  }

  /**
   * 加载关联指标配置
   */
  loadRelatedMetrics() {
    return {
      'catch_success_rate': [
        'api_latency_catch',
        'redis_hit_rate',
        'location_service_health',
        'pokemon_spawn_count',
        'device_crash_rate'
      ],
      'payment_failure_rate': [
        'payment_gateway_latency',
        'payment_service_health',
        'database_connection_pool_usage',
        'api_error_rate_payment',
        'redis_error_rate'
      ],
      'user_active_count': [
        'api_request_count',
        'gateway_health',
        'authentication_success_rate',
        'push_notification_delivery_rate'
      ],
      'gym_battle_duration': [
        'gym_service_latency',
        'pokemon_service_latency',
        'battle_calculation_time',
        'database_query_time_gym'
      ]
    };
  }

  /**
   * 分析根因
   */
  async analyze(anomalyAlert, metricsHistory) {
    const metricName = anomalyAlert.metricName;
    const relatedMetrics = this.relatedMetrics[metricName] || [];
    
    const correlations = [];
    
    for (const relatedMetric of relatedMetrics) {
      const history = metricsHistory[relatedMetric];
      if (!history || history.length < 10) continue;

      const correlation = this.calculateCorrelation(
        metricsHistory[metricName].slice(-60),
        history.slice(-60)
      );

      if (Math.abs(correlation) > this.correlationThreshold) {
        correlations.push({
          metric: relatedMetric,
          correlation,
          recentTrend: this.calculateTrend(history.slice(-10)),
          status: this.detectAnomalousState(history)
        });
      }
    }

    // 排序相关度
    correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    return {
      primaryAlert: anomalyAlert,
      correlatedMetrics: correlations,
      suggestedCauses: this.generateSuggestions(correlations),
      confidence: this.calculateConfidence(correlations)
    };
  }

  /**
   * 计算皮尔逊相关系数
   */
  calculateCorrelation(series1, series2) {
    const n = Math.min(series1.length, series2.length);
    if (n < 5) return 0;

    const x = series1.slice(0, n).map(d => d.value);
    const y = series2.slice(0, n).map(d => d.value);

    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      denomX += dx * dx;
      denomY += dy * dy;
    }

    const denominator = Math.sqrt(denomX * denomY);
    if (denominator === 0) return 0;

    return numerator / denominator;
  }

  /**
   * 计算趋势
   */
  calculateTrend(data) {
    if (data.length < 3) return 'stable';
    
    const values = data.map(d => d.value);
    const firstHalf = values.slice(0, Math.floor(values.length / 2));
    const secondHalf = values.slice(Math.floor(values.length / 2));
    
    const firstMean = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondMean = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
    
    const change = (secondMean - firstMean) / firstMean;
    
    if (change > 0.1) return 'increasing';
    if (change < -0.1) return 'decreasing';
    return 'stable';
  }

  /**
   * 检测异常状态
   */
  detectAnomalousState(data) {
    const values = data.slice(-10).map(d => d.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const latest = values[values.length - 1];
    
    const deviation = Math.abs(latest - mean) / mean;
    
    if (deviation > 0.5) return 'anomalous';
    if (deviation > 0.2) return 'warning';
    return 'normal';
  }

  /**
   * 生成建议原因
   */
  generateSuggestions(correlations) {
    const suggestions = [];

    for (const corr of correlations.slice(0, 3)) {
      if (corr.metric.includes('latency')) {
        suggestions.push({
          cause: '服务响应延迟增加',
          metric: corr.metric,
          action: '检查服务健康状态，查看慢查询日志'
        });
      } else if (corr.metric.includes('error')) {
        suggestions.push({
          cause: '错误率上升',
          metric: corr.metric,
          action: '检查错误日志，排查服务异常'
        });
      } else if (corr.metric.includes('redis')) {
        suggestions.push({
          cause: 'Redis 缓存问题',
          metric: corr.metric,
          action: '检查 Redis 内存使用，连接池状态'
        });
      } else if (corr.metric.includes('database')) {
        suggestions.push({
          cause: '数据库性能问题',
          metric: corr.metric,
          action: '检查慢查询，连接池，锁等待'
        });
      }
    }

    return suggestions;
  }

  /**
   * 计算根因分析置信度
   */
  calculateConfidence(correlations) {
    if (correlations.length === 0) return 0;
    
    const maxCorrelation = Math.abs(correlations[0].correlation);
    const anomalousCount = correlations.filter(c => c.status === 'anomalous').length;
    
    return Math.min(1, (maxCorrelation * 0.5) + (anomalousCount / correlations.length * 0.5));
  }
}

module.exports = RootCauseAnalyzer;
```

### 5. 集成到微服务

```javascript
// backend/shared/middleware/businessMetrics.js

const BusinessMetricsMonitor = require('../anomalyDetection/BusinessMetricsMonitor');

let monitor = null;

function initBusinessMetrics(config) {
  if (!monitor) {
    monitor = new BusinessMetricsMonitor(config);
    
    monitor.on('anomaly', (alert) => {
      console.warn('Business anomaly detected:', alert);
    });
  }
  
  return monitor;
}

function getBusinessMetricsMonitor() {
  return monitor;
}

/**
 * 捕捉成功率监控中间件
 */
function catchMetricsMiddleware(req, res, next) {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const isSuccess = res.statusCode >= 200 && res.statusCode < 300;
    
    if (monitor) {
      monitor.recordMetric('catch_success_rate', isSuccess ? 1 : 0, {
        service: 'catch-service',
        endpoint: req.path
      });
      
      monitor.recordMetric('api_latency_catch', duration, {
        service: 'catch-service',
        endpoint: req.path
      });
    }
  });
  
  next();
}

/**
 * 支付失败率监控中间件
 */
function paymentMetricsMiddleware(req, res, next) {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const isFailure = res.statusCode >= 400;
    
    if (monitor) {
      monitor.recordMetric('payment_failure_rate', isFailure ? 1 : 0, {
        service: 'payment-service',
        endpoint: req.path
      });
      
      monitor.recordMetric('payment_gateway_latency', duration, {
        service: 'payment-service'
      });
    }
  });
  
  next();
}

module.exports = {
  initBusinessMetrics,
  getBusinessMetricsMonitor,
  catchMetricsMiddleware,
  paymentMetricsMiddleware
};
```

### 6. 可视化仪表板 API

```javascript
// backend/services/admin-dashboard/src/routes/anomalyDashboard.js

const express = require('express');
const router = express.Router();
const Redis = require('ioredis');
const logger = require('../../shared/logger');

const redis = new Redis(process.env.REDIS_URL);

/**
 * 获取异常事件历史
 */
router.get('/anomalies/history', async (req, res) => {
  try {
    const { startTime, endTime, severity, metricName } = req.query;
    const keys = await redis.keys('alerts:history:*');
    const alerts = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const alert = JSON.parse(data);
        const alertTime = new Date(alert.timestamp).getTime();
        
        // 过滤条件
        if (startTime && alertTime < new Date(startTime).getTime()) continue;
        if (endTime && alertTime > new Date(endTime).getTime()) continue;
        if (severity && alert.severity !== severity) continue;
        if (metricName && alert.metricName !== metricName) continue;
        
        alerts.push(alert);
      }
    }

    // 按时间排序
    alerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    res.json({
      success: true,
      data: alerts.slice(0, 100),
      total: alerts.length
    });
  } catch (error) {
    logger.error('Failed to get anomaly history', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取指标异常统计
 */
router.get('/anomalies/stats', async (req, res) => {
  try {
    const { period = '24h' } = req.query;
    const hours = period === '7d' ? 168 : (period === '24h' ? 24 : 1);
    
    const keys = await redis.keys('alerts:history:*');
    const stats = {
      total: 0,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      byMetric: {},
      timeline: []
    };

    const cutoffTime = Date.now() - hours * 60 * 60 * 1000;

    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;

      const alert = JSON.parse(data);
      if (new Date(alert.timestamp).getTime() < cutoffTime) continue;

      stats.total++;
      stats.bySeverity[alert.severity] = (stats.bySeverity[alert.severity] || 0) + 1;
      stats.byMetric[alert.metricName] = (stats.byMetric[alert.metricName] || 0) + 1;
    }

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Failed to get anomaly stats', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 获取静默规则列表
 */
router.get('/silences', async (req, res) => {
  try {
    const keys = await redis.keys('silence:*');
    const silences = [];

    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        silences.push(JSON.parse(data));
      }
    }

    res.json({
      success: true,
      data: silences
    });
  } catch (error) {
    logger.error('Failed to get silences', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 创建静默规则
 */
router.post('/silences', async (req, res) => {
  try {
    const { matchers, duration, comment } = req.body;
    const createdBy = req.user?.email || 'system';

    const AlertAggregator = require('../../shared/anomalyDetection/AlertAggregator');
    const aggregator = new AlertAggregator();
    
    const silence = await aggregator.createSilenceRule(
      matchers,
      duration,
      createdBy,
      comment
    );

    res.json({
      success: true,
      data: silence
    });
  } catch (error) {
    logger.error('Failed to create silence', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
```

## 验收标准

- [ ] Z-Score 异常检测算法实现，准确率 > 85%
- [ ] IQR 异常检测算法实现，准确率 > 80%
- [ ] 时序预测异常检测实现，支持趋势分析
- [ ] 捕捉成功率、支付失败率、API 错误率监控已集成
- [ ] 告警聚合功能正常，聚合窗口内相似告警合并
- [ ] 冷却期机制生效，告警降噪比例 > 60%
- [ ] 静默规则支持创建、查询、自动过期
- [ ] 根因分析器能够自动关联相关指标
- [ ] 仪表板 API 提供历史查询、统计、静默管理接口
- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试验证端到端流程
- [ ] 文档完善，包含算法说明和配置指南

## 影响范围

- **新增文件**:
  - `backend/shared/anomalyDetection/AnomalyDetector.js`
  - `backend/shared/anomalyDetection/BusinessMetricsMonitor.js`
  - `backend/shared/anomalyDetection/AlertAggregator.js`
  - `backend/shared/anomalyDetection/RootCauseAnalyzer.js`
  - `backend/shared/middleware/businessMetrics.js`
  - `backend/services/admin-dashboard/src/routes/anomalyDashboard.js`

- **修改文件**:
  - `backend/services/catch-service/src/index.js` - 集成捕捉监控
  - `backend/services/payment-service/src/index.js` - 集成支付监控
  - `backend/services/gateway/src/index.js` - 集成全局监控
  - `infrastructure/k8s/monitoring/` - Grafana 仪表板配置

## 参考

- [异常检测算法对比](https://anomaly.io/anomaly-detection-algorithms/)
- [Prometheus Alertmanager 文档](https://prometheus.io/docs/alerting/latest/alertmanager/)
- [时序异常检测最佳实践](https://docs.datadoghq.com/monitors/guide/anomaly-monitor/)
- REQ-00130: 实时业务事件流监控与分析系统
