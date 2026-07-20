/**
 * REQ-00599: API 响应延迟异常检测与智能告警系统
 * 延迟基准计算与异常检测引擎
 */

const logger = require('./logger');
const { metrics } = require('./metrics');
const EventEmitter = require('events');

/**
 * 延迟基准计算器
 * 使用滑动窗口计算延迟基准和动态阈值
 */
class LatencyBaselineCalculator {
  constructor(options = {}) {
    this.windowSize = options.windowSize || 3600; // 默认 1 小时窗口（秒）
    this.percentiles = options.percentiles || [50, 95, 99];
    this.buckets = options.buckets || [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
    this.dataPoints = new Map(); // endpoint -> [{ timestamp, latency }]
    this.baselines = new Map(); // endpoint -> { p50, p95, p99, mean, stddev, threshold }
    this.updateInterval = options.updateInterval || 60000; // 每分钟更新一次基准
    this.thresholdMultiplier = options.thresholdMultiplier || 3; // Mean + 3 * StdDev
    
    this.updateTimer = null;
  }

  /**
   * 启动基准计算器
   */
  start() {
    if (this.updateTimer) {
      return;
    }
    
    logger.info('Starting latency baseline calculator', {
      windowSize: this.windowSize,
      updateInterval: this.updateInterval
    });
    
    // 定期更新基准
    this.updateTimer = setInterval(() => {
      this.updateBaselines();
    }, this.updateInterval);
    
    // 立即执行一次
    this.updateBaselines();
  }

  /**
   * 停止基准计算器
   */
  stop() {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
      logger.info('Latency baseline calculator stopped');
    }
  }

  /**
   * 记录延迟数据点
   * @param {string} endpoint - API 端点
   * @param {number} latency - 延迟（毫秒）
   * @param {number} timestamp - 时间戳（毫秒）
   */
  recordLatency(endpoint, latency, timestamp = Date.now()) {
    if (!this.dataPoints.has(endpoint)) {
      this.dataPoints.set(endpoint, []);
    }
    
    const points = this.dataPoints.get(endpoint);
    points.push({ timestamp, latency });
    
    // 清理过期数据点
    const cutoff = timestamp - this.windowSize * 1000;
    while (points.length > 0 && points[0].timestamp < cutoff) {
      points.shift();
    }
    
    // 记录指标
    metrics.gauge('latency_baseline_data_points', points.length, { endpoint });
  }

  /**
   * 更新所有端点的基准
   */
  updateBaselines() {
    for (const [endpoint, points] of this.dataPoints.entries()) {
      if (points.length < 10) {
        // 数据点太少，跳过
        continue;
      }
      
      const baseline = this.calculateBaseline(points);
      this.baselines.set(endpoint, baseline);
      
      // 记录基准指标
      metrics.gauge('latency_baseline_p50', baseline.p50, { endpoint });
      metrics.gauge('latency_baseline_p95', baseline.p95, { endpoint });
      metrics.gauge('latency_baseline_p99', baseline.p99, { endpoint });
      metrics.gauge('latency_baseline_mean', baseline.mean, { endpoint });
      metrics.gauge('latency_baseline_stddev', baseline.stddev, { endpoint });
      metrics.gauge('latency_baseline_threshold', baseline.threshold, { endpoint });
      
      logger.debug('Updated latency baseline', {
        endpoint,
        p50: baseline.p50,
        p95: baseline.p95,
        p99: baseline.p99,
        threshold: baseline.threshold
      });
    }
  }

  /**
   * 计算单个端点的基准
   * @param {Array} points - 数据点数组
   * @returns {Object} 基准对象
   */
  calculateBaseline(points) {
    const latencies = points.map(p => p.latency).sort((a, b) => a - b);
    
    const p50 = this.percentile(latencies, 50);
    const p95 = this.percentile(latencies, 95);
    const p99 = this.percentile(latencies, 99);
    
    const mean = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
    const variance = latencies.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / latencies.length;
    const stddev = Math.sqrt(variance);
    
    // 动态阈值：Mean + N * StdDev
    const threshold = mean + this.thresholdMultiplier * stddev;
    
    return {
      p50,
      p95,
      p99,
      mean,
      stddev,
      threshold,
      sampleSize: latencies.length,
      updatedAt: Date.now()
    };
  }

  /**
   * 计算百分位数
   * @param {Array} sortedValues - 已排序的值数组
   * @param {number} p - 百分位数（0-100）
   * @returns {number} 百分位值
   */
  percentile(sortedValues, p) {
    if (sortedValues.length === 0) return 0;
    
    const index = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    
    if (lower === upper) {
      return sortedValues[lower];
    }
    
    // 线性插值
    const weight = index - lower;
    return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
  }

  /**
   * 获取端点的基准
   * @param {string} endpoint - API 端点
   * @returns {Object|null} 基准对象
   */
  getBaseline(endpoint) {
    return this.baselines.get(endpoint) || null;
  }

  /**
   * 获取所有基准
   * @returns {Map} 基准映射
   */
  getAllBaselines() {
    return new Map(this.baselines);
  }
}

/**
 * 延迟异常检测器
 * 基于基准检测异常延迟并触发告警
 */
class LatencyAnomalyDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.calculator = options.calculator || new LatencyBaselineCalculator(options);
    this.consecutiveThreshold = options.consecutiveThreshold || 3; // 连续 N 个数据点异常才告警
    this.anomalyWindow = options.anomalyWindow || 300000; // 5 分钟窗口
    this.anomalyCounts = new Map(); // endpoint -> { count, firstAnomalyTime }
    this.alertCooldown = options.alertCooldown || 600000; // 10 分钟冷却期
    this.lastAlertTime = new Map(); // endpoint -> timestamp
    
    this.isRunning = false;
  }

  /**
   * 启动检测器
   */
  start() {
    if (this.isRunning) {
      return;
    }
    
    this.isRunning = true;
    this.calculator.start();
    
    logger.info('Latency anomaly detector started', {
      consecutiveThreshold: this.consecutiveThreshold,
      anomalyWindow: this.anomalyWindow,
      alertCooldown: this.alertCooldown
    });
  }

  /**
   * 停止检测器
   */
  stop() {
    this.isRunning = false;
    this.calculator.stop();
    this.anomalyCounts.clear();
    this.lastAlertTime.clear();
    
    logger.info('Latency anomaly detector stopped');
  }

  /**
   * 检测延迟异常
   * @param {string} endpoint - API 端点
   * @param {number} latency - 当前延迟（毫秒）
   * @returns {Object} 检测结果 { isAnomaly, baseline, deviation }
   */
  detect(endpoint, latency) {
    // 记录数据点
    this.calculator.recordLatency(endpoint, latency);
    
    // 获取基准
    const baseline = this.calculator.getBaseline(endpoint);
    if (!baseline) {
      // 没有足够的基准数据，跳过检测
      return {
        isAnomaly: false,
        baseline: null,
        deviation: 0
      };
    }
    
    // 计算偏离度
    const deviation = latency - baseline.threshold;
    const isAnomaly = deviation > 0;
    
    // 记录异常指标
    metrics.gauge('latency_current', latency, { endpoint });
    metrics.gauge('latency_deviation', deviation, { endpoint });
    
    if (isAnomaly) {
      this.handleAnomaly(endpoint, latency, baseline, deviation);
    } else {
      this.resetAnomalyCount(endpoint);
    }
    
    return {
      isAnomaly,
      baseline,
      deviation,
      latency
    };
  }

  /**
   * 处理异常
   * @param {string} endpoint - API 端点
   * @param {number} latency - 当前延迟
   * @param {Object} baseline - 基准对象
   * @param {number} deviation - 偏离值
   */
  handleAnomaly(endpoint, latency, baseline, deviation) {
    const now = Date.now();
    
    // 检查冷却期
    const lastAlert = this.lastAlertTime.get(endpoint);
    if (lastAlert && now - lastAlert < this.alertCooldown) {
      // 在冷却期内，跳过告警
      logger.debug('Anomaly alert in cooldown', { endpoint });
      return;
    }
    
    // 更新异常计数
    if (!this.anomalyCounts.has(endpoint)) {
      this.anomalyCounts.set(endpoint, {
        count: 0,
        firstAnomalyTime: now
      });
    }
    
    const anomalyInfo = this.anomalyCounts.get(endpoint);
    
    // 检查是否在异常窗口内
    if (now - anomalyInfo.firstAnomalyTime > this.anomalyWindow) {
      // 超出窗口，重置计数
      anomalyInfo.count = 0;
      anomalyInfo.firstAnomalyTime = now;
    }
    
    anomalyInfo.count++;
    
    // 记录异常计数指标
    metrics.gauge('latency_anomaly_count', anomalyInfo.count, { endpoint });
    
    // 检查是否达到连续异常阈值
    if (anomalyInfo.count >= this.consecutiveThreshold) {
      this.triggerAlert(endpoint, latency, baseline, deviation, anomalyInfo);
      
      // 更新最后告警时间
      this.lastAlertTime.set(endpoint, now);
      
      // 重置计数
      anomalyInfo.count = 0;
      anomalyInfo.firstAnomalyTime = now;
    }
  }

  /**
   * 触发告警
   * @param {string} endpoint - API 端点
   * @param {number} latency - 当前延迟
   * @param {Object} baseline - 基准对象
   * @param {number} deviation - 偏离值
   * @param {Object} anomalyInfo - 异常信息
   */
  triggerAlert(endpoint, latency, baseline, deviation, anomalyInfo) {
    const alert = {
      type: 'latency_anomaly',
      severity: deviation > baseline.stddev * 2 ? 'critical' : 'warning',
      endpoint,
      latency,
      baseline: {
        p50: baseline.p50,
        p95: baseline.p95,
        p99: baseline.p99,
        mean: baseline.mean,
        threshold: baseline.threshold
      },
      deviation,
      deviationPercent: ((deviation / baseline.threshold) * 100).toFixed(2),
      consecutiveCount: anomalyInfo.count,
      timestamp: Date.now()
    };
    
    logger.warn('Latency anomaly detected', alert);
    
    // 增加告警计数
    metrics.increment('latency_anomaly_alerts_total', 1, {
      endpoint,
      severity: alert.severity
    });
    
    // 发出告警事件
    this.emit('alert', alert);
  }

  /**
   * 重置异常计数
   * @param {string} endpoint - API 端点
   */
  resetAnomalyCount(endpoint) {
    if (this.anomalyCounts.has(endpoint)) {
      const anomalyInfo = this.anomalyCounts.get(endpoint);
      if (anomalyInfo.count > 0) {
        logger.debug('Resetting anomaly count', { endpoint, previousCount: anomalyInfo.count });
      }
      anomalyInfo.count = 0;
    }
  }

  /**
   * 获取端点的异常状态
   * @param {string} endpoint - API 端点
   * @returns {Object} 异常状态
   */
  getAnomalyStatus(endpoint) {
    const baseline = this.calculator.getBaseline(endpoint);
    const anomalyInfo = this.anomalyCounts.get(endpoint);
    const lastAlert = this.lastAlertTime.get(endpoint);
    
    return {
      hasBaseline: !!baseline,
      baseline,
      currentAnomalyCount: anomalyInfo ? anomalyInfo.count : 0,
      lastAlertTime: lastAlert || null
    };
  }

  /**
   * 获取所有端点的异常状态
   * @returns {Array} 异常状态列表
   */
  getAllAnomalyStatuses() {
    const statuses = [];
    
    for (const [endpoint] of this.calculator.getAllBaselines()) {
      statuses.push({
        endpoint,
        ...this.getAnomalyStatus(endpoint)
      });
    }
    
    return statuses;
  }
}

module.exports = {
  LatencyBaselineCalculator,
  LatencyAnomalyDetector
};
