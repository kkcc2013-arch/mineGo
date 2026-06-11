/**
 * 预测性扩容引擎
 * 基于历史负载数据预测未来负载，提前扩容
 * 
 * REQ-00071: K8s Pod 资源自动扩缩容优化系统
 */

const logger = require('./logger');
const metrics = require('./metrics');

/**
 * 预测性扩容引擎
 */
class PredictiveScalingEngine {
  constructor(config = {}) {
    // Prometheus 查询端点
    this.prometheusUrl = config.prometheusUrl || process.env.PROMETHEUS_URL || 'http://prometheus-server:9090';
    
    // 预测配置
    this.config = {
      predictionWindow: config.predictionWindow || 15 * 60, // 预测未来15分钟
      historyWindow: config.historyWindow || 7 * 24 * 3600, // 使用7天历史数据
      scaleAheadTime: config.scaleAheadTime || 5 * 60, // 提前5分钟扩容
      minConfidence: config.minConfidence || 0.7, // 最低置信度阈值
      checkInterval: config.checkInterval || 5 * 60 * 1000, // 检查间隔 5分钟
      ...config
    };
    
    // 服务配置
    this.serviceConfigs = {
      gateway: {
        hpaMin: 2,
        hpaMax: 20,
        metricName: 'http_requests_per_second',
        targetPerPod: 1000,
        scaleThreshold: 0.8, // 当预测负载达到80%时开始扩容
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
        hpaMax: 10,
        metricName: 'pokemon_requests_per_second',
        targetPerPod: 800,
        scaleThreshold: 0.75,
      },
      'user-service': {
        hpaMin: 2,
        hpaMax: 10,
        metricName: 'user_requests_per_second',
        targetPerPod: 600,
        scaleThreshold: 0.75,
      },
      'gym-service': {
        hpaMin: 2,
        hpaMax: 15,
        metricName: 'battle_requests_per_second',
        targetPerPod: 200,
        scaleThreshold: 0.7,
      }
    };
    
    // 历史数据缓存
    this.historyCache = new Map();
    this.lastUpdateTime = null;
    
    // Prometheus 指标
    this.setupMetrics();
  }

  /**
   * 设置 Prometheus 指标
   */
  setupMetrics() {
    this.metrics = {
      predictedLoad: metrics.registerGauge(
        'predicted_load_value',
        'Predicted load for the service',
        ['service', 'prediction_window_seconds']
      ),
      
      predictionConfidence: metrics.registerGauge(
        'prediction_confidence',
        'Confidence level of the prediction',
        ['service']
      ),
      
      predictiveScalingExecutions: metrics.registerCounter(
        'predictive_scaling_executions_total',
        'Total predictive scaling executions',
        ['service', 'action', 'result']
      ),
      
      scalingRecommendations: metrics.registerGauge(
        'scaling_recommendations_count',
        'Number of scaling recommendations',
        ['service', 'action']
      )
    };
  }

  /**
   * 从 Prometheus 获取历史负载数据
   */
  async fetchHistoryData(serviceName, metricName) {
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - this.config.historyWindow;
    
    const query = `avg_over_time(${metricName}{namespace="minego",service="${serviceName}"}[7d])`;
    
    try {
      const response = await fetch(`${this.prometheusUrl}/api/v1/query_range?query=${encodeURIComponent(query)}&start=${startTime}&end=${endTime}&step=3600`);
      const data = await response.json();
      
      if (data.status === 'success' && data.data.result.length > 0) {
        return data.data.result[0].values.map(([timestamp, value]) => ({
          timestamp,
          value: parseFloat(value)
        }));
      }
      
      return [];
    } catch (error) {
      logger.error('Failed to fetch history data', {
        service: serviceName,
        metric: metricName,
        error: error.message
      });
      return [];
    }
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
    
    // 计算当前基础负载
    const weeklyAvg = pattern.weekly.reduce((a, b) => a + b, 0) / 7;
    const hourlyAvg = pattern.hourly.reduce((a, b) => a + b, 0) / 24;
    const currentBaseLoad = weeklyAvg > 0 ? pattern.weekly[currentDay] * pattern.hourly[currentHour] / weeklyAvg : hourlyAvg;
    
    // 预测未来负载（基于历史模式）
    const predictions = [];
    
    for (let i = 0; i < predictionWindow / 60; i++) {
      const futureTime = new Date(now.getTime() + i * 60 * 1000);
      const futureHour = futureTime.getHours();
      const futureDay = futureTime.getDay();
      
      // 基于小时和周模式的预测
      const hourlyFactor = hourlyAvg > 0 ? pattern.hourly[futureHour] / hourlyAvg : 1;
      const weeklyFactor = weeklyAvg > 0 ? pattern.weekly[futureDay] / weeklyAvg : 1;
      
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
    
    // 更新指标
    if (this.metrics.predictedLoad) {
      this.metrics.predictedLoad.set(
        { service: serviceName, prediction_window_seconds: predictionWindow },
        predictions.length > 0 ? predictions[0].load : 0
      );
    }
    
    if (this.metrics.predictionConfidence) {
      this.metrics.predictionConfidence.set(
        { service: serviceName },
        confidence
      );
    }
    
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
   * 计算方差
   */
  calculateVariance(data) {
    if (data.length === 0) return 1;
    
    const mean = data.reduce((sum, p) => sum + p.value, 0) / data.length;
    const variance = data.reduce((sum, p) => sum + Math.pow(p.value - mean, 2), 0) / data.length;
    const stdDev = Math.sqrt(variance);
    
    return mean > 0 ? stdDev / mean : 1; // 变异系数
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
   * 获取当前副本数
   */
  async getCurrentReplicas(serviceName) {
    try {
      const query = `kube_deployment_status_replicas{namespace="minego",deployment="${serviceName}"}`;
      const response = await fetch(`${this.prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`);
      const data = await response.json();
      
      if (data.status === 'success' && data.data.result.length > 0) {
        return parseInt(data.data.result[0].value[1]);
      }
    } catch (error) {
      logger.error('Failed to get current replicas', {
        service: serviceName,
        error: error.message
      });
    }
    
    return this.serviceConfigs[serviceName]?.hpaMin || 1;
  }

  /**
   * 生成扩容建议
   */
  async generateScalingRecommendations() {
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
        if (requiredReplicas > currentReplicas && 
            maxLoad / currentReplicas / config.targetPerPod > config.scaleThreshold) {
          const recommendation = {
            service: serviceName,
            action: 'scale_up',
            currentReplicas,
            recommendedReplicas: Math.min(requiredReplicas, config.hpaMax),
            predictedLoad: maxLoad,
            confidence: prediction.confidence,
            peakTime: prediction.predictions.find(p => p.load === maxLoad)?.timestamp,
            executeAt: Math.floor(Date.now() / 1000) + this.config.scaleAheadTime,
            reason: `Predicted load ${maxLoad.toFixed(0)} exceeds threshold`
          };
          
          recommendations.push(recommendation);
          
          // 更新指标
          if (this.metrics.scalingRecommendations) {
            this.metrics.scalingRecommendations.set(
              { service: serviceName, action: 'scale_up' },
              1
            );
          }
        }
        
        // 如果预测负载远低于当前容量，生成缩容建议
        const minLoad = Math.min(...prediction.predictions.map(p => p.load));
        const minRequiredReplicas = Math.ceil(minLoad / config.targetPerPod / 0.5); // 50% buffer
        
        if (minRequiredReplicas < currentReplicas - 1 && 
            currentReplicas > config.hpaMin) {
          const recommendation = {
            service: serviceName,
            action: 'scale_down',
            currentReplicas,
            recommendedReplicas: Math.max(minRequiredReplicas, config.hpaMin),
            predictedLoad: minLoad,
            confidence: prediction.confidence,
            reason: `Predicted load ${minLoad.toFixed(0)} allows scale down`
          };
          
          recommendations.push(recommendation);
          
          // 更新指标
          if (this.metrics.scalingRecommendations) {
            this.metrics.scalingRecommendations.set(
              { service: serviceName, action: 'scale_down' },
              1
            );
          }
        }
      } catch (error) {
        logger.error('Failed to generate recommendation', {
          service: serviceName,
          error: error.message
        });
      }
    }
    
    return recommendations;
  }

  /**
   * 执行预测性扩容
   */
  async executePredictiveScaling() {
    const recommendations = await this.generateScalingRecommendations();
    const results = [];
    
    for (const rec of recommendations) {
      if (rec.action === 'scale_up' && rec.confidence >= this.config.minConfidence) {
        logger.info('Executing predictive scale up', rec);
        
        // 记录执行
        if (this.metrics.predictiveScalingExecutions) {
          this.metrics.predictiveScalingExecutions.inc({
            service: rec.service,
            action: rec.action,
            result: 'executed'
          });
        }
        
        results.push({
          ...rec,
          status: 'executed',
          timestamp: new Date().toISOString()
        });
      } else {
        logger.info('Skipping scale recommendation', { 
          reason: 'Low confidence or not scale_up',
          recommendation: rec 
        });
      }
    }
    
    return results;
  }

  /**
   * 启动定时任务
   */
  start() {
    logger.info('Starting predictive scaling engine', {
      checkInterval: this.config.checkInterval,
      services: Object.keys(this.serviceConfigs)
    });
    
    // 立即执行一次
    this.executePredictiveScaling().catch(err => {
      logger.error('Initial predictive scaling failed', { error: err.message });
    });
    
    // 定时执行
    this.intervalId = setInterval(async () => {
      try {
        await this.executePredictiveScaling();
      } catch (error) {
        logger.error('Predictive scaling job failed', { error: error.message });
      }
    }, this.config.checkInterval);
    
    return this;
  }

  /**
   * 停止定时任务
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Predictive scaling engine stopped');
    }
    return this;
  }
}

/**
 * 创建并启动预测性扩容引擎
 */
function createPredictiveScalingEngine(config = {}) {
  return new PredictiveScalingEngine(config);
}

/**
 * 启动预测性扩容定时任务
 */
async function startPredictiveScalingJob(config = {}) {
  const engine = new PredictiveScalingEngine(config);
  return engine.start();
}

module.exports = {
  PredictiveScalingEngine,
  createPredictiveScalingEngine,
  startPredictiveScalingJob
};
