// shared/costPredictor.js - 成本预测器
'use strict'
const { createLogger } = require('./logger');
const { predictedCostGauge, costAnomalyGauge, potentialSavingsGauge } = require('./costMetrics');

const logger = createLogger('cost-predictor');

/**
 * 成本预测器
 * 基于历史数据进行预测和优化建议
 */
class CostPredictor {
  constructor(historicalData = []) {
    this.historicalData = historicalData;
  }

  /**
   * 设置历史数据
   */
  setHistoricalData(data) {
    this.historicalData = data;
  }

  /**
   * 线性回归预测
   */
  predictLinearRegression(days = 30) {
    const data = this.historicalData.slice(-30); // 使用最近 30 天数据
    
    if (data.length < 7) {
      logger.warn({ dataPoints: data.length }, 'Insufficient data for linear regression');
      return null;
    }
    
    // 最小二乘法
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    const n = data.length;
    
    data.forEach((point, i) => {
      const x = i;
      const y = point.cost || point.amount || 0;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
    });
    
    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) {
      return null;
    }
    
    const slope = (n * sumXY - sumX * sumY) / denominator;
    const intercept = (sumY - slope * sumX) / n;
    
    // 计算相关系数 R²
    const meanY = sumY / n;
    let ssTotal = 0, ssResidual = 0;
    
    data.forEach((point, i) => {
      const y = point.cost || point.amount || 0;
      const yPred = slope * i + intercept;
      ssTotal += Math.pow(y - meanY, 2);
      ssResidual += Math.pow(y - yPred, 2);
    });
    
    const rSquared = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;
    
    // 预测未来 N 天
    const predictions = [];
    for (let i = 0; i < days; i++) {
      predictions.push({
        day: i + 1,
        date: this.getDateString(i + 1),
        predictedCost: Math.max(0, slope * (data.length + i) + intercept)
      });
    }
    
    const monthlyTotal = this.calculateMonthlyTotal(predictions);
    
    // 更新 Prometheus 指标
    predictedCostGauge.set({ service: 'all' }, monthlyTotal);
    
    return {
      method: 'linear_regression',
      slope,
      intercept,
      rSquared,
      confidence: this.calculateConfidence(rSquared, n),
      predictions,
      monthlyTotal,
      trend: slope > 0.5 ? 'increasing' : slope < -0.5 ? 'decreasing' : 'stable'
    };
  }

  /**
   * 移动平均预测
   */
  predictMovingAverage(windowSize = 7, days = 30) {
    const data = this.historicalData.slice(-windowSize);
    
    if (data.length < windowSize) {
      logger.warn({ dataPoints: data.length, windowSize }, 'Insufficient data for moving average');
      return null;
    }
    
    const avgCost = data.reduce((sum, d) => sum + (d.cost || d.amount || 0), 0) / data.length;
    
    const predictions = [];
    for (let i = 0; i < days; i++) {
      predictions.push({
        day: i + 1,
        date: this.getDateString(i + 1),
        predictedCost: avgCost
      });
    }
    
    return {
      method: 'moving_average',
      windowSize,
      averageCost: avgCost,
      predictions,
      monthlyTotal: avgCost * 30
    };
  }

  /**
   * 指数平滑预测
   */
  predictExponentialSmoothing(alpha = 0.3, days = 30) {
    const data = this.historicalData;
    
    if (data.length < 3) {
      return null;
    }
    
    // 初始值
    let forecast = data[0].cost || data[0].amount || 0;
    
    // 计算平滑值
    for (let i = 1; i < data.length; i++) {
      const actual = data[i].cost || data[i].amount || 0;
      forecast = alpha * actual + (1 - alpha) * forecast;
    }
    
    const predictions = [];
    for (let i = 0; i < days; i++) {
      predictions.push({
        day: i + 1,
        date: this.getDateString(i + 1),
        predictedCost: forecast
      });
    }
    
    return {
      method: 'exponential_smoothing',
      alpha,
      smoothingValue: forecast,
      predictions,
      monthlyTotal: forecast * 30
    };
  }

  /**
   * 计算预测置信度
   */
  calculateConfidence(rSquared, dataPoints) {
    // 基于 R² 和数据点数量计算置信度
    const rSquaredWeight = rSquared * 0.6;
    const dataPointsWeight = Math.min(dataPoints / 30, 1) * 0.4;
    return Math.round((rSquaredWeight + dataPointsWeight) * 100);
  }

  /**
   * 计算月度预测总额
   */
  calculateMonthlyTotal(predictions) {
    return predictions.slice(0, 30).reduce((sum, p) => sum + p.predictedCost, 0);
  }

  /**
   * 获取日期字符串
   */
  getDateString(daysFromNow) {
    const date = new Date();
    date.setDate(date.getDate() + daysFromNow);
    return date.toISOString().split('T')[0];
  }

  /**
   * 检测异常成本
   */
  detectAnomalies(threshold = 2) {
    const data = this.historicalData;
    
    if (data.length < 7) {
      return [];
    }
    
    const values = data.map(d => d.cost || d.amount || 0);
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    
    if (stdDev === 0) {
      return [];
    }
    
    const anomalies = data.filter(d => {
      const value = d.cost || d.amount || 0;
      const zScore = Math.abs((value - mean) / stdDev);
      
      // 更新 Prometheus 指标
      if (zScore > threshold) {
        const date = d.date || d.timestamp?.split('T')[0] || 'unknown';
        costAnomalyGauge.set({ service: 'all', date }, zScore);
      }
      
      return zScore > threshold;
    }).map(d => ({
      date: d.date || d.timestamp?.split('T')[0],
      cost: d.cost || d.amount,
      mean,
      stdDev,
      zScore: Math.abs(((d.cost || d.amount || 0) - mean) / stdDev)
    }));
    
    return anomalies;
  }

  /**
   * 生成成本优化建议
   */
  generateOptimizationSuggestions(currentCosts) {
    const suggestions = [];
    
    if (!currentCosts || typeof currentCosts !== 'object') {
      return suggestions;
    }
    
    for (const [service, cost] of Object.entries(currentCosts)) {
      const costData = typeof cost === 'object' ? cost : { total: cost, cpu: 0, memory: 0 };
      
      // 检查低利用率资源
      if (costData.utilization !== undefined && costData.utilization < 0.2) {
        const monthlyCost = costData.total * 30;
        const saving = monthlyCost * 0.5;
        
        suggestions.push({
          type: 'underutilized',
          service,
          resourceType: 'compute',
          currentUtilization: costData.utilization,
          recommendation: `资源利用率仅 ${(costData.utilization * 100).toFixed(1)}%，建议缩小配置`,
          potentialSaving: saving,
          priority: 'high'
        });
        
        potentialSavingsGauge.set({ optimization_type: 'underutilized', service }, saving);
      }
      
      // 检查 CPU 成本优化
      if (costData.cpu > 5) {
        const saving = costData.cpu * 30 * 0.2;
        suggestions.push({
          type: 'cpu_optimization',
          service,
          resourceType: 'cpu',
          currentCost: costData.cpu,
          recommendation: 'CPU 成本较高，建议优化代码性能或使用更高效的实例类型',
          potentialSaving: saving,
          priority: 'medium'
        });
        
        potentialSavingsGauge.set({ optimization_type: 'cpu_optimization', service }, saving);
      }
      
      // 检查内存成本优化
      if (costData.memory > 3) {
        const saving = costData.memory * 30 * 0.15;
        suggestions.push({
          type: 'memory_optimization',
          service,
          resourceType: 'memory',
          currentCost: costData.memory,
          recommendation: '内存成本较高，建议检查内存泄漏或优化缓存策略',
          potentialSaving: saving,
          priority: 'medium'
        });
        
        potentialSavingsGauge.set({ optimization_type: 'memory_optimization', service }, saving);
      }
      
      // 检查预留实例机会
      if (costData.variance !== undefined && costData.variance < 0.1 && costData.total > 2) {
        const saving = costData.total * 30 * 0.3;
        suggestions.push({
          type: 'reserved_instance',
          service,
          resourceType: 'compute',
          recommendation: '资源使用稳定，建议购买预留实例节省成本',
          potentialSaving: saving,
          priority: 'low'
        });
        
        potentialSavingsGauge.set({ optimization_type: 'reserved_instance', service }, saving);
      }
    }
    
    // 按潜在节省金额排序
    return suggestions.sort((a, b) => b.potentialSaving - a.potentialSaving);
  }

  /**
   * 获取成本趋势分析
   */
  getTrendAnalysis() {
    const data = this.historicalData;
    
    if (data.length < 7) {
      return null;
    }
    
    const values = data.map(d => d.cost || d.amount || 0);
    const firstWeek = values.slice(0, 7).reduce((sum, v) => sum + v, 0) / 7;
    const lastWeek = values.slice(-7).reduce((sum, v) => sum + v, 0) / 7;
    
    const changePercent = firstWeek > 0 ? ((lastWeek - firstWeek) / firstWeek) * 100 : 0;
    
    const prediction = this.predictLinearRegression(30);
    
    return {
      firstWeekAvg: firstWeek,
      lastWeekAvg: lastWeek,
      changePercent: Math.round(changePercent * 100) / 100,
      trend: changePercent > 10 ? 'increasing' : changePercent < -10 ? 'decreasing' : 'stable',
      predictedMonthly: prediction?.monthlyTotal || 0,
      dataPoints: data.length
    };
  }
}

module.exports = { CostPredictor };
