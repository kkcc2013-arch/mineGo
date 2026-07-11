/**
 * 错误趋势分析器
 * 
 * 功能：
 * - 实时监控错误发生率
 * - 异常峰值检测（基于统计模型）
 * - 趋势预测
 * 
 * @module ErrorTrendAnalyzer
 */

const logger = require('../logger');
const redis = require('../redis');

class ErrorTrendAnalyzer {
  constructor(config = {}) {
    this.windowSize = config.windowSize || 60;  // 统计窗口大小（秒）
    this.baselineWindow = config.baselineWindow || 3600; // 基线窗口（秒）
    this.anomalyThreshold = config.anomalyThreshold || 3.0; // 异常阈值（标准差倍数）
    this.minSampleSize = config.minSampleSize || 10; // 最小样本量
    
    this.statsPrefix = 'error:stats:';
  }

  /**
   * 检测异常
   * @param {string} service - 服务名称
   * @param {string} errorCode - 错误码（可选）
   * @returns {Object} 异常检测结果
   */
  async detectAnomaly(service, errorCode = null) {
    try {
      // 1. 获取当前错误率
      const currentRate = await this._getCurrentRate(service, errorCode);
      
      // 2. 获取历史基线
      const baseline = await this._getBaseline(service, errorCode);
      
      if (!baseline || baseline.sampleSize < this.minSampleSize) {
        return {
          service,
          errorCode,
          currentRate,
          baseline: null,
          zScore: 0,
          isAnomaly: false,
          severity: 'unknown',
          message: '样本量不足，无法检测异常'
        };
      }
      
      // 3. 计算Z-score
      const zScore = baseline.stdDev > 0 
        ? (currentRate - baseline.mean) / baseline.stdDev 
        : 0;
      
      // 4. 判断是否异常
      const isAnomaly = Math.abs(zScore) > this.anomalyThreshold;
      
      // 5. 计算严重程度
      const severity = this._calculateSeverity(zScore, currentRate);
      
      const result = {
        service,
        errorCode,
        currentRate,
        baseline: {
          mean: Math.round(baseline.mean * 100) / 100,
          stdDev: Math.round(baseline.stdDev * 100) / 100,
          min: Math.round(baseline.min * 100) / 100,
          max: Math.round(baseline.max * 100) / 100,
          sampleSize: baseline.sampleSize
        },
        zScore: Math.round(zScore * 100) / 100,
        isAnomaly,
        severity,
        message: this._generateMessage(isAnomaly, zScore, currentRate, baseline.mean)
      };
      
      // 6. 记录检测结果
      if (isAnomaly) {
        await this._recordAnomaly(result);
      }
      
      return result;
    } catch (error) {
      logger.error('Anomaly detection failed', {
        error: error.message,
        service,
        errorCode
      });
      
      return {
        service,
        errorCode,
        isAnomaly: false,
        severity: 'error',
        message: `检测失败: ${error.message}`
      };
    }
  }

  /**
   * 获取当前错误率
   * @param {string} service - 服务名称
   * @param {string} errorCode - 错误码（可选）
   * @returns {number} 当前错误率（错误数/分钟）
   */
  async _getCurrentRate(service, errorCode) {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - this.windowSize;
    
    const key = errorCode 
      ? `${this.statsPrefix}${service}:code:${errorCode}:timeline`
      : `${this.statsPrefix}${service}:timeline`;
    
    // 获取时间窗口内的错误计数
    const counts = await redis.zrangebyscore(key, windowStart, now, 'WITHSCORES');
    
    let total = 0;
    for (let i = 1; i < counts.length; i += 2) {
      total += parseInt(counts[i], 10);
    }
    
    return total / (this.windowSize / 60); // 转换为每分钟
  }

  /**
   * 获取历史基线
   * @param {string} service - 服务名称
   * @param {string} errorCode - 错误码（可选）
   * @returns {Object} 基线统计
   */
  async _getBaseline(service, errorCode) {
    const now = Math.floor(Date.now() / 1000);
    const baselineStart = now - this.baselineWindow;
    
    const key = errorCode 
      ? `${this.statsPrefix}${service}:code:${errorCode}:timeline`
      : `${this.statsPrefix}${service}:timeline`;
    
    // 获取基线窗口内的所有数据点
    const dataPoints = await redis.zrangebyscore(key, baselineStart, now, 'WITHSCORES');
    
    if (dataPoints.length < this.minSampleSize) {
      return null;
    }
    
    // 提取计数值
    const values = [];
    for (let i = 1; i < dataPoints.length; i += 2) {
      values.push(parseInt(dataPoints[i], 10));
    }
    
    // 计算统计量
    return this._calculateStatistics(values);
  }

  /**
   * 计算统计量
   * @param {Array} values - 数值数组
   * @returns {Object} 统计结果
   */
  _calculateStatistics(values) {
    const n = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    
    const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n;
    const stdDev = Math.sqrt(variance);
    
    return {
      mean,
      stdDev: stdDev || 0.1, // 避免除零
      min: Math.min(...values),
      max: Math.max(...values),
      sampleSize: n
    };
  }

  /**
   * 计算严重程度
   * @param {number} zScore - Z分数
   * @param {number} currentRate - 当前错误率
   * @returns {string} 严重程度
   */
  _calculateSeverity(zScore, currentRate) {
    const absZ = Math.abs(zScore);
    
    if (currentRate > 100 || absZ > 5) return 'critical';
    if (currentRate > 50 || absZ > 4) return 'high';
    if (currentRate > 20 || absZ > 3) return 'medium';
    return 'low';
  }

  /**
   * 生成消息
   * @param {boolean} isAnomaly - 是否异常
   * @param {number} zScore - Z分数
   * @param {number} currentRate - 当前错误率
   * @param {number} baselineMean - 基线均值
   * @returns {string} 消息
   */
  _generateMessage(isAnomaly, zScore, currentRate, baselineMean) {
    if (!isAnomaly) {
      return '错误率正常';
    }
    
    const direction = zScore > 0 ? '上升' : '下降';
    const ratio = (currentRate / baselineMean).toFixed(1);
    
    return `错误率异常${direction}，当前 ${currentRate.toFixed(1)}/min，是基线的 ${ratio} 倍`;
  }

  /**
   * 记录异常
   * @param {Object} anomaly - 异常信息
   */
  async _recordAnomaly(anomaly) {
    try {
      const key = 'error:anomalies:recent';
      await redis.lpush(key, JSON.stringify({
        ...anomaly,
        detectedAt: new Date().toISOString()
      }));
      await redis.ltrim(key, 0, 99); // 保留最近100条
    } catch (error) {
      logger.error('Failed to record anomaly', { error: error.message });
    }
  }

  /**
   * 获取趋势预测
   * @param {string} service - 服务名称
   * @param {number} horizonMinutes - 预测时间范围（分钟）
   * @returns {Object} 预测结果
   */
  async predictTrend(service, horizonMinutes = 30) {
    try {
      // 获取历史数据
      const historyKey = `${this.statsPrefix}${service}:timeline`;
      const now = Math.floor(Date.now() / 1000);
      const historyStart = now - 3600; // 最近1小时
      
      const dataPoints = await redis.zrangebyscore(
        historyKey,
        historyStart,
        now,
        'WITHSCORES'
      );
      
      if (dataPoints.length < 20) {
        return {
          service,
          prediction: null,
          message: '历史数据不足，无法预测'
        };
      }
      
      // 提取时间序列数据
      const series = [];
      for (let i = 0; i < dataPoints.length; i += 2) {
        series.push({
          timestamp: parseInt(dataPoints[i], 10),
          value: parseInt(dataPoints[i + 1], 10)
        });
      }
      
      // 简单线性回归预测
      const prediction = this._simpleLinearRegression(series, horizonMinutes);
      
      return {
        service,
        prediction: {
          rate: Math.round(prediction.rate * 100) / 100,
          horizon: `${horizonMinutes} minutes`,
          confidence: prediction.confidence
        },
        trend: prediction.trend,
        message: prediction.trend === 'increasing' 
          ? `预计未来${horizonMinutes}分钟错误率将上升至 ${prediction.rate.toFixed(1)}/min`
          : prediction.trend === 'decreasing'
          ? `预计错误率将下降至 ${prediction.rate.toFixed(1)}/min`
          : `预计错误率将保持稳定在 ${prediction.rate.toFixed(1)}/min`
      };
    } catch (error) {
      logger.error('Trend prediction failed', {
        error: error.message,
        service
      });
      
      return {
        service,
        prediction: null,
        message: `预测失败: ${error.message}`
      };
    }
  }

  /**
   * 简单线性回归
   * @param {Array} series - 时间序列数据
   * @param {number} horizonMinutes - 预测范围（分钟）
   * @returns {Object} 预测结果
   */
  _simpleLinearRegression(series, horizonMinutes) {
    const n = series.length;
    const x = series.map((_, i) => i);
    const y = series.map(s => s.value);
    
    // 计算斜率和截距
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
    const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
    
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    
    // 预测未来值
    const futureIndex = n + horizonMinutes;
    const predictedValue = slope * futureIndex + intercept;
    
    // 计算趋势方向
    let trend = 'stable';
    if (slope > 0.1) trend = 'increasing';
    else if (slope < -0.1) trend = 'decreasing';
    
    // 计算置信度（基于R²）
    const yMean = sumY / n;
    const ssTotal = y.reduce((acc, yi) => acc + Math.pow(yi - yMean, 2), 0);
    const ssResidual = y.reduce((acc, yi, i) => {
      const predicted = slope * x[i] + intercept;
      return acc + Math.pow(yi - predicted, 2);
    }, 0);
    const rSquared = 1 - ssResidual / ssTotal;
    
    return {
      rate: Math.max(0, predictedValue),
      trend,
      confidence: Math.max(0, Math.min(1, rSquared))
    };
  }

  /**
   * 更新错误统计
   * @param {Object} errorEvent - 错误事件
   */
  async updateStats(errorEvent) {
    const now = Math.floor(Date.now() / 1000);
    const minuteKey = Math.floor(now / 60) * 60;
    
    const multi = redis.multi();
    
    // 服务级统计
    multi.zadd(
      `${this.statsPrefix}${errorEvent.service}:timeline`,
      minuteKey,
      1,
      'NX' // 只在不存时设置
    );
    
    multi.zincrby(
      `${this.statsPrefix}${errorEvent.service}:timeline`,
      1,
      minuteKey.toString()
    );
    
    // 错误码级统计
    if (errorEvent.errorCode) {
      multi.zadd(
        `${this.statsPrefix}${errorEvent.service}:code:${errorEvent.errorCode}:timeline`,
        minuteKey,
        1,
        'NX'
      );
      
      multi.zincrby(
        `${this.statsPrefix}${errorEvent.service}:code:${errorEvent.errorCode}:timeline`,
        1,
        minuteKey.toString()
      );
    }
    
    await multi.exec();
  }
}

module.exports = ErrorTrendAnalyzer;