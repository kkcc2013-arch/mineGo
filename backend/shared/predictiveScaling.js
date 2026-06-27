// backend/shared/predictiveScaling.js
// 预测性扩容引擎 - 基于历史负载数据预测未来负载，提前扩容
'use strict';

const logger = require('./logger');

/**
 * 预测性扩容引擎
 */
class PredictiveScalingEngine {
  constructor(config = {}) {
    // Prometheus 客户端（可选，生产环境需要配置）
    this.prometheusUrl = config.prometheusUrl || process.env.PROMETHEUS_URL || 'http://prometheus-server:9090';
    
    // 预测配置
    this.config = {
      predictionWindow: config.predictionWindow || 15 * 60, // 预测未来15分钟
      historyWindow: config.historyWindow || 7 * 24 * 3600, // 使用7天历史数据
      scaleAheadTime: config.scaleAheadTime || 5 * 60, // 提前5分钟扩容
      minConfidence: config.minConfidence || 0.7, // 最低置信度阈值
      enabled: config.enabled !== false, // 默认启用
      ...config
    };
    
    // 服务配置
    this.serviceConfigs = {
      gateway: {
        hpaMin: 2,
        hpaMax: 20,
        metricName: 'http_requests_per_second',
        targetPerPod: 1000,
        scaleThreshold: 0.8,
      },
      'catch-service': {
        hpaMin: 3,
        hpaMax: 30,
        metricName: 'catch_requests_per_second',
        targetPerPod: 500,
        scaleThreshold: 0.75,
      },
      'location-service': {
        hpaMin: 2,
        hpaMax: 15,
        metricName: 'geo_query_latency_p99',
        targetPerPod: 200,
        scaleThreshold: 0.7,
      },
      'pokemon-service': {
        hpaMin: 2,
        hpaMax: 20,
        metricName: 'pokemon_requests_per_second',
        targetPerPod: 800,
        scaleThreshold: 0.8,
      },
      'user-service': {
        hpaMin: 2,
        hpaMax: 15,
        metricName: 'user_requests_per_second',
        targetPerPod: 500,
        scaleThreshold: 0.75,
      },
      'gym-service': {
        hpaMin: 2,
        hpaMax: 20,
        metricName: 'gym_battle_requests_per_second',
        targetPerPod: 300,
        scaleThreshold: 0.7,
      }
    };
    
    // 历史数据缓存
    this.historyCache = new Map();
    this.lastUpdateTime = null;
  }

  /**
   * 模拟历史数据获取（简化版，生产环境需对接 Prometheus）
   */
  async fetchHistoryData(serviceName, metricName) {
    // 生成模拟的历史数据（用于开发测试）
    // 生产环境应从 Prometheus 查询真实数据
    const hours = 168; // 7天 * 24小时
    const data = [];
    
    const baseLoad = this.serviceConfigs[serviceName]?.targetPerPod || 500;
    
    for (let i = 0; i < hours; i++) {
      const timestamp = Math.floor(Date.now() / 1000) - (hours - i) * 3600;
      const hour = new Date(timestamp * 1000).getHours();
      const day = new Date(timestamp * 1000).getDay();
      
      // 模拟日内模式：高峰在 12:00-14:00 和 18:00-22:00
      let hourlyFactor = 1;
      if (hour >= 12 && hour <= 14) hourlyFactor = 1.5;
      else if (hour >= 18 && hour <= 22) hourlyFactor = 1.8;
      else if (hour >= 0 && hour <= 6) hourlyFactor = 0.3;
      
      // 模拟周内模式：周末负载更高
      let weeklyFactor = 1;
      if (day === 0 || day === 6) weeklyFactor = 1.2;
      
      // 添加一些随机波动
      const noise = Math.random() * 0.2 - 0.1;
      
      const load = baseLoad * hourlyFactor * weeklyFactor * (1 + noise);
      
      data.push({ timestamp, value: load });
    }
    
    return data;
  }

  /**
   * 时间序列分析：检测周期性模式
   */
  analyzePeriodicPattern(historyData) {
    if (historyData.length < 168) { // 至少需要7天数据
      return null;
    }
    
    // 按小时分组，检测日内模式
    const hourlyPattern = new Array(24).fill(0);
    const hourlyCounts = new Array(24).fill(0);
    
    historyData.forEach(point => {
      const hour = new Date(point.timestamp * 1000).getHours();
      hourlyPattern[hour] += point.value;
      hourlyCounts[hour]++;
    });
    
    // 计算每小时平均值
    const hourlyAvg = hourlyPattern.map((sum, i) => 
      hourlyCounts[i] > 0 ? sum / hourlyCounts[i] : 0
    );
    
    // 检测周内模式（工作日 vs 周末）
    const weekdayPattern = new Array(7).fill(0);
    const weekdayCounts = new Array(7).fill(0);
    
    historyData.forEach(point => {
      const day = new Date(point.timestamp * 1000).getDay();
      weekdayPattern[day] += point.value;
      weekdayCounts[day]++;
    });
    
    const weekdayAvg = weekdayPattern.map((sum, i) =>
      weekdayCounts[i] > 0 ? sum / weekdayCounts[i] : 0
    );
    
    return {
      hourly: hourlyAvg,
      weekly: weekdayAvg
    };
  }

  /**
   * 预测未来负载
   */
  async predictFutureLoad(serviceName, predictionWindow) {
    const config = this.serviceConfigs[serviceName];
    if (!config) {
      return null;
    }
    
    // 获取历史数据
    const historyData = await this.fetchHistoryData(serviceName, config.metricName);
    
    // 分析周期性模式
    const pattern = this.analyzePeriodicPattern(historyData);
    if (!pattern) {
      logger.warn('Insufficient data for prediction', { serviceName });
      return null;
    }
    
    // 当前时间
    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    
    // 基准负载（当天当小时的平均值）
    const currentBaseLoad = pattern.hourly[currentHour];
    
    // 预测未来负载（基于历史模式）
    const predictions = [];
    
    for (let i = 0; i < predictionWindow / 60; i++) {
      const futureTime = new Date(now.getTime() + i * 60 * 1000);
      const futureHour = futureTime.getHours();
      const futureDay = futureTime.getDay();
      
      // 基于小时和周模式的预测
      const avgHourlyLoad = pattern.hourly.reduce((a, b) => a + b, 0) / 24;
      const avgWeeklyLoad = pattern.weekly.reduce((a, b) => a + b, 0) / 7;
      
      const hourlyFactor = pattern.hourly[futureHour] / avgHourlyLoad;
      const weeklyFactor = pattern.weekly[futureDay] / avgWeeklyLoad;
      
      const predictedLoad = currentBaseLoad * hourlyFactor * weeklyFactor;
      
      predictions.push({
        timestamp: Math.floor(futureTime.getTime() / 1000),
        load: predictedLoad,
        hour: futureHour,
        day: futureDay
      });
    }
    
    // 计算置信度（基于历史数据量和波动性）
    const variance = this.calculateVariance(historyData);
    const confidence = Math.max(0, Math.min(1, 1 - variance / 2));
    
    return {
      service: serviceName,
      predictions,
      confidence,
      pattern: {
        peakHours: this.findPeakHours(pattern.hourly),
        peakDays: this.findPeakDays(pattern.weekly)
      }
    };
  }

  /**
   * 计算方差（变异系数）
   */
  calculateVariance(data) {
    if (data.length === 0) return 1;
    
    const mean = data.reduce((sum, p) => sum + p.value, 0) / data.length;
    const variance = data.reduce((sum, p) => sum + Math.pow(p.value - mean, 2), 0) / data.length;
    
    return Math.sqrt(variance) / Math.max(mean, 1); // 变异系数
  }

  /**
   * 找出高峰时段
   */
  findPeakHours(hourlyPattern) {
    const sorted = hourlyPattern
      .map((value, hour) => ({ hour, value }))
      .sort((a, b) => b.value - a.value);
    
    return sorted.slice(0, 5).map(p => p.hour);
  }

  /**
   * 找出高峰日期
   */
  findPeakDays(weeklyPattern) {
    const sorted = weeklyPattern
      .map((value, day) => ({ day, value }))
      .sort((a, b) => b.value - a.value);
    
    return sorted.slice(0, 3).map(p => p.day);
  }

  /**
   * 获取当前副本数（模拟）
   */
  async getCurrentReplicas(serviceName) {
    // 生产环境应从 Kubernetes API 获取
    // 这里返回模拟值
    return this.serviceConfigs[serviceName]?.hpaMin || 2;
  }

  /**
   * 生成扩容建议
   */
  async generateScalingRecommendations() {
    if (!this.config.enabled) {
      logger.info('Predictive scaling is disabled');
      return [];
    }
    
    const recommendations = [];
    
    for (const [serviceName, config] of Object.entries(this.serviceConfigs)) {
      try {
        const prediction = await this.predictFutureLoad(
          serviceName,
          this.config.predictionWindow
        );
        
        if (!prediction || prediction.confidence < this.config.minConfidence) {
          logger.debug('Skipping prediction due to low confidence', {
            service: serviceName,
            confidence: prediction?.confidence || 0
          });
          continue;
        }
        
        // 找出预测窗口内的最大负载
        const maxLoad = Math.max(...prediction.predictions.map(p => p.load));
        const currentReplicas = await this.getCurrentReplicas(serviceName);
        const requiredReplicas = Math.ceil(maxLoad / config.targetPerPod);
        
        // 如果预测负载超过阈值，生成扩容建议
        const loadRatio = maxLoad / (currentReplicas * config.targetPerPod);
        
        if (loadRatio > config.scaleThreshold && requiredReplicas > currentReplicas) {
          recommendations.push({
            service: serviceName,
            action: 'scale_up',
            currentReplicas,
            recommendedReplicas: Math.min(requiredReplicas, config.hpaMax),
            predictedLoad: Math.round(maxLoad),
            confidence: prediction.confidence,
            peakTime: prediction.predictions.find(p => p.load === maxLoad)?.timestamp,
            executeAt: Math.floor(Date.now() / 1000) + this.config.scaleAheadTime,
            reason: `Predicted load ${Math.round(maxLoad)} exceeds threshold (${config.scaleThreshold * 100}%)`,
            pattern: prediction.pattern
          });
        }
        
        // 如果预测负载远低于当前容量，生成缩容建议
        const minLoad = Math.min(...prediction.predictions.map(p => p.load));
        const minRequiredReplicas = Math.ceil(minLoad / config.targetPerPod / 0.5); // 50% buffer
        
        if (minRequiredReplicas < currentReplicas - 1 && currentReplicas > config.hpaMin) {
          recommendations.push({
            service: serviceName,
            action: 'scale_down',
            currentReplicas,
            recommendedReplicas: Math.max(minRequiredReplicas, config.hpaMin),
            predictedLoad: Math.round(minLoad),
            confidence: prediction.confidence,
            reason: `Predicted load ${Math.round(minLoad)} allows scale down`,
            pattern: prediction.pattern
          });
        }
        
      } catch (error) {
        logger.error('Failed to generate prediction', {
          service: serviceName,
          error: error.message
        });
      }
    }
    
    return recommendations;
  }

  /**
   * 执行预测性扩容（返回建议，实际执行需管理员确认）
   */
  async executePredictiveScaling(autoExecute = false) {
    const recommendations = await this.generateScalingRecommendations();
    const results = [];
    
    for (const rec of recommendations) {
      if (rec.action === 'scale_up') {
        logger.info('Scale up recommendation', rec);
        
        // 生产环境应通过 Kubernetes API 执行扩容
        // 这里只记录建议，不自动执行
        
        results.push({
          ...rec,
          status: autoExecute ? 'executed' : 'pending_approval',
          timestamp: new Date().toISOString()
        });
        
        if (autoExecute && rec.confidence >= this.config.minConfidence) {
          // 执行扩容逻辑（需要 K8s API 集成）
          logger.info('Auto-executing scale up', { service: rec.service });
        }
      } else {
        logger.info('Scale down recommendation', rec);
        results.push({
          ...rec,
          status: 'pending_approval',
          timestamp: new Date().toISOString()
        });
      }
    }
    
    return results;
  }

  /**
   * 获取服务配置
   */
  getServiceConfigs() {
    return this.serviceConfigs;
  }

  /**
   * 获取预测引擎状态
   */
  getStatus() {
    return {
      enabled: this.config.enabled,
      predictionWindow: this.config.predictionWindow,
      scaleAheadTime: this.config.scaleAheadTime,
      minConfidence: this.config.minConfidence,
      servicesCount: Object.keys(this.serviceConfigs).length,
      lastUpdateTime: this.lastUpdateTime
    };
  }
}

/**
 * 启动预测性扩容定时任务
 */
function startPredictiveScalingJob(engine, intervalMs = 5 * 60 * 1000) {
  if (!engine.config.enabled) {
    logger.info('Predictive scaling job skipped (disabled)');
    return null;
  }
  
  // 立即执行一次
  engine.executePredictiveScaling(false).catch(err => {
    logger.error('Predictive scaling initial run failed', { error: err.message });
  });
  
  // 定时执行
  const timer = setInterval(async () => {
    try {
      await engine.executePredictiveScaling(false);
      engine.lastUpdateTime = new Date().toISOString();
    } catch (error) {
      logger.error('Predictive scaling job failed', { error: error.message });
    }
  }, intervalMs);
  
  logger.info('Predictive scaling job started', { interval: `${intervalMs / 1000}s` });
  
  return timer;
}

module.exports = {
  PredictiveScalingEngine,
  startPredictiveScalingJob
};