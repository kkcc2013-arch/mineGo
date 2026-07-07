/**
 * REQ-00466: 成本异常检测器
 * 使用统计学方法检测成本异常波动
 */

class CostAnomalyDetector {
  constructor(options = {}) {
    // Z-score 阈值（超出此值视为异常）
    this.zScoreThreshold = options.zScoreThreshold || 2.5;
    // 移动平均窗口大小
    this.windowSize = options.windowSize || 7;  // 7天
    // 最小数据点数量
    this.minDataPoints = options.minDataPoints || 5;
    // 季节性周期（小时）
    this.seasonalPeriod = options.seasonalPeriod || 24;
  }

  /**
   * 检测成本异常
   * @param {Array<number>} historicalCosts - 历史成本数据
   * @param {number} currentCost - 当前成本
   * @returns {Object} 检测结果
   */
  detect(historicalCosts, currentCost) {
    if (historicalCosts.length < this.minDataPoints) {
      return { isAnomaly: false, reason: 'Insufficient data points' };
    }

    // 计算 Z-score
    const mean = this.calculateMean(historicalCosts);
    const stdDev = this.calculateStdDev(historicalCosts, mean);
    const zScore = stdDev > 0 ? (currentCost - mean) / stdDev : 0;

    // 检测异常
    const isAnomaly = Math.abs(zScore) > this.zScoreThreshold;

    // 检测趋势变化
    const trendDirection = this.detectTrend(historicalCosts);

    return {
      isAnomaly,
      zScore,
      mean,
      stdDev,
      currentCost,
      expectedRange: {
        min: Math.max(0, mean - this.zScoreThreshold * stdDev),
        max: mean + this.zScoreThreshold * stdDev
      },
      trendDirection,
      anomalyType: this.classifyAnomaly(zScore, currentCost, mean),
      severity: this.calculateSeverity(zScore)
    };
  }

  /**
   * 分类异常类型
   */
  classifyAnomaly(zScore, currentCost, mean) {
    if (mean === 0) return 'normal';
    if (currentCost > mean * 2) return 'cost_spike';
    if (currentCost > mean * 1.5) return 'cost_increase';
    if (currentCost < mean * 0.5) return 'cost_decrease';
    if (zScore > this.zScoreThreshold) return 'high_variance';
    return 'normal';
  }

  /**
   * 计算严重程度
   */
  calculateSeverity(zScore) {
    const absZScore = Math.abs(zScore);
    if (absZScore > 4) return 'critical';
    if (absZScore > 3) return 'high';
    if (absZScore > 2.5) return 'medium';
    return 'low';
  }

  /**
   * 计算移动平均
   */
  calculateMovingAverage(data, windowSize) {
    if (data.length < windowSize) return this.calculateMean(data);
    
    const window = data.slice(-windowSize);
    return this.calculateMean(window);
  }

  /**
   * 检测趋势方向
   */
  detectTrend(data) {
    if (data.length < 3) return 'stable';
    
    const recent = data.slice(-3);
    const earlier = data.slice(-6, -3);
    
    if (earlier.length === 0) return 'stable';
    
    const recentMean = this.calculateMean(recent);
    const earlierMean = this.calculateMean(earlier);
    
    if (earlierMean === 0) return 'stable';
    
    const changeRate = (recentMean - earlierMean) / earlierMean;
    
    if (changeRate > 0.2) return 'increasing';
    if (changeRate < -0.2) return 'decreasing';
    return 'stable';
  }

  /**
   * 季节性异常检测（小时级数据）
   */
  detectSeasonalAnomaly(hourlyData, currentHourCost) {
    if (hourlyData.length < this.seasonalPeriod * 2) {
      return { isAnomaly: false, reason: 'Insufficient hourly data' };
    }

    // 获取相同历史时段的数据
    const currentHour = new Date().getHours();
    const historicalHourlyCosts = hourlyData.filter((_, idx) => 
      (idx % this.seasonalPeriod) === currentHour
    );

    if (historicalHourlyCosts.length < 3) {
      return { isAnomaly: false, reason: 'Insufficient same-hour data' };
    }

    const mean = this.calculateMean(historicalHourlyCosts);
    const stdDev = this.calculateStdDev(historicalHourlyCosts, mean);
    const zScore = stdDev > 0 ? (currentHourCost - mean) / stdDev : 0;

    return {
      isAnomaly: Math.abs(zScore) > this.zScoreThreshold,
      zScore,
      expectedForHour: mean,
      actualCost: currentHourCost,
      hour: currentHour
    };
  }

  calculateMean(data) {
    if (data.length === 0) return 0;
    return data.reduce((sum, val) => sum + val, 0) / data.length;
  }

  calculateStdDev(data, mean) {
    if (data.length < 2) return 0;
    const squaredDiffs = data.map(val => Math.pow(val - mean, 2));
    return Math.sqrt(this.calculateMean(squaredDiffs));
  }
}

module.exports = { CostAnomalyDetector };
