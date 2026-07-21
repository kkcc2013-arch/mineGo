/**
 * 流量特征分析引擎
 * 用于分析实时流量并预测未来趋势
 */

const logger = require('../../shared/logger');
const { getRedisClient } = require('../../shared/redis');
const { getDatabasePool } = require('../../shared/database');

class TrafficAnalyzer {
  constructor(config = {}) {
    this.config = {
      historyWindow: config.historyWindow || 24 * 60 * 60 * 1000, // 24小时历史窗口
      predictionWindow: config.predictionWindow || 4 * 60 * 60 * 1000, // 预测未来4小时
      sampleInterval: config.sampleInterval || 60 * 1000, // 采样间隔1分钟
      seasonalPattern: config.seasonalPattern || true, // 是否识别季节性模式
      ...config
    };

    this.redisClient = null;
    this.dbPool = null;
    this.historicalData = [];
    this.currentPatterns = new Map();
  }

  /**
   * 初始化分析器
   */
  async initialize() {
    try {
      this.redisClient = await getRedisClient();
      this.dbPool = await getDatabasePool();

      // 加载历史数据
      await this.loadHistoricalData();

      logger.info('TrafficAnalyzer initialized successfully', {
        historyWindow: this.config.historyWindow,
        predictionWindow: this.config.predictionWindow
      });

      return true;
    } catch (error) {
      logger.error('Failed to initialize TrafficAnalyzer', { error: error.message });
      throw error;
    }
  }

  /**
   * 加载历史流量数据
   */
  async loadHistoricalData() {
    const query = `
      SELECT 
        time_bucket('1 minute', timestamp) AS bucket,
        AVG(request_count) AS avg_requests,
        AVG(response_time) AS avg_response_time,
        MAX(request_count) AS max_requests,
        MIN(request_count) AS min_requests,
        COUNT(*) AS sample_count
      FROM traffic_metrics
      WHERE timestamp > NOW() - INTERVAL '${this.config.historyWindow / 1000} seconds'
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const result = await this.dbPool.query(query);
    this.historicalData = result.rows.map(row => ({
      timestamp: new Date(row.bucket),
      requestCount: parseFloat(row.avg_requests),
      responseTime: parseFloat(row.avg_response_time),
      maxRequests: parseInt(row.max_requests),
      minRequests: parseInt(row.min_requests)
    }));

    logger.info('Historical traffic data loaded', {
      dataPoints: this.historicalData.length
    });
  }

  /**
   * 采集实时流量数据
   */
  async collectCurrentTraffic() {
    const key = 'gateway:traffic:current';
    const data = await this.redisClient.hgetall(key);

    const currentTraffic = {
      timestamp: new Date(),
      requestCount: parseInt(data.request_count || 0),
      responseTime: parseFloat(data.avg_response_time || 0),
      activeUsers: parseInt(data.active_users || 0),
      errorRate: parseFloat(data.error_rate || 0)
    };

    // 添加到历史数据
    this.historicalData.push(currentTraffic);

    // 保持历史数据在窗口范围内
    const cutoff = Date.now() - this.config.historyWindow;
    this.historicalData = this.historicalData.filter(d => d.timestamp.getTime() > cutoff);

    return currentTraffic;
  }

  /**
   * 识别流量模式（季节性、周期性）
   */
  async identifyPatterns() {
    const patterns = {
      hourly: this.detectHourlyPattern(),
      daily: this.detectDailyPattern(),
      weekly: this.detectWeeklyPattern()
    };

    // 检测特殊事件（节假日、推广活动）
    const specialEvents = await this.detectSpecialEvents();

    this.currentPatterns.set('regular', patterns);
    this.currentPatterns.set('special', specialEvents);

    logger.info('Traffic patterns identified', {
      hourly: patterns.hourly.length,
      daily: patterns.daily.length,
      weekly: patterns.weekly.length,
      specialEvents: specialEvents.length
    });

    return { patterns, specialEvents };
  }

  /**
   * 检测小时级模式
   */
  detectHourlyPattern() {
    const hourlyAvg = new Array(24).fill(0);
    const hourlyCount = new Array(24).fill(0);

    this.historicalData.forEach(data => {
      const hour = data.timestamp.getHours();
      hourlyAvg[hour] += data.requestCount;
      hourlyCount[hour]++;
    });

    return hourlyAvg.map((sum, i) => ({
      hour: i,
      avgRequests: hourlyCount[i] > 0 ? sum / hourlyCount[i] : 0,
      peak: hourlyCount[i] > 0
    }));
  }

  /**
   * 检测日级模式
   */
  detectDailyPattern() {
    const dailyAvg = new Array(7).fill(0);
    const dailyCount = new Array(7).fill(0);

    this.historicalData.forEach(data => {
      const day = data.timestamp.getDay();
      dailyAvg[day] += data.requestCount;
      dailyCount[day]++;
    });

    return dailyAvg.map((sum, i) => ({
      day: i,
      dayName: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i],
      avgRequests: dailyCount[i] > 0 ? sum / dailyCount[i] : 0
    }));
  }

  /**
   * 检测周级模式
   */
  detectWeeklyPattern() {
    // 简化实现：检测周末 vs 工作日
    const weekend = this.historicalData.filter(d => [0, 6].includes(d.timestamp.getDay()));
    const weekday = this.historicalData.filter(d => ![0, 6].includes(d.timestamp.getDay()));

    return {
      weekendAvg: weekend.length > 0 
        ? weekend.reduce((sum, d) => sum + d.requestCount, 0) / weekend.length 
        : 0,
      weekdayAvg: weekday.length > 0 
        ? weekday.reduce((sum, d) => sum + d.requestCount, 0) / weekday.length 
        : 0
    };
  }

  /**
   * 检测特殊事件
   */
  async detectSpecialEvents() {
    const query = `
      SELECT 
        event_type,
        event_name,
        event_start,
        event_end,
        expected_traffic_multiplier
      FROM scheduled_events
      WHERE event_end > NOW()
      ORDER BY event_start ASC
    `;

    const result = await this.dbPool.query(query);
    return result.rows;
  }

  /**
   * 预测未来流量趋势
   */
  async predictTrafficTrend(predictionWindow = this.config.predictionWindow) {
    if (this.historicalData.length < 60) {
      logger.warn('Insufficient historical data for prediction', {
        dataPoints: this.historicalData.length
      });
      return null;
    }

    // 获取当前模式
    const { patterns, specialEvents } = await this.identifyPatterns();
    const currentHour = new Date().getHours();
    const currentDay = new Date().getDay();

    // 基础预测：使用历史平均值
    let basePrediction = patterns.hourly[currentHour]?.avgRequests || 0;

    // 调整：日级模式
    const dayMultiplier = patterns.daily[currentDay]?.avgRequests / patterns.daily.reduce((sum, d) => sum + d.avgRequests, 0) * 7 || 1;
    basePrediction *= dayMultiplier;

    // 调整：周级模式
    const isWeekend = [0, 6].includes(currentDay);
    const weeklyMultiplier = isWeekend ? patterns.weekly.weekendAvg / patterns.weekly.weekdayAvg : 1;
    basePrediction *= weeklyMultiplier;

    // 调整：特殊事件
    const activeEvents = specialEvents.filter(e => {
      const now = Date.now();
      return new Date(e.event_start).getTime() <= now && new Date(e.event_end).getTime() >= now;
    });

    if (activeEvents.length > 0) {
      const eventMultiplier = Math.max(...activeEvents.map(e => parseFloat(e.expected_traffic_multiplier || 1)));
      basePrediction *= eventMultiplier;
    }

    // 计算预测区间
    const predictions = [];
    const now = Date.now();
    const steps = Math.floor(predictionWindow / this.config.sampleInterval);

    for (let i = 0; i < steps; i++) {
      const futureTime = new Date(now + i * this.config.sampleInterval);
      const futureHour = futureTime.getHours();
      const futureDay = futureTime.getDay();

      let prediction = patterns.hourly[futureHour]?.avgRequests || basePrediction;
      prediction *= (patterns.daily[futureDay]?.avgRequests / patterns.daily.reduce((sum, d) => sum + d.avgRequests, 0) * 7 || 1);

      predictions.push({
        timestamp: futureTime,
        predictedRequests: Math.round(prediction),
        confidence: this.calculateConfidence(i, steps)
      });
    }

    const summary = {
      currentTraffic: await this.collectCurrentTraffic(),
      predictionWindow: predictionWindow,
      avgPredictedRequests: predictions.reduce((sum, p) => sum + p.predictedRequests, 0) / predictions.length,
      maxPredictedRequests: Math.max(...predictions.map(p => p.predictedRequests)),
      minPredictedRequests: Math.min(...predictions.map(p => p.predictedRequests)),
      confidence: predictions[predictions.length - 1]?.confidence || 0,
      activeEvents: activeEvents.length
    };

    logger.info('Traffic trend predicted', summary);

    return { predictions, summary };
  }

  /**
   * 计算预测置信度
   */
  calculateConfidence(stepIndex, totalSteps) {
    // 置信度随预测时间递减
    const baseConfidence = 0.9;
    const decayRate = 0.05;
    const confidence = baseConfidence * Math.exp(-decayRate * stepIndex / totalSteps);
    return Math.max(0.5, Math.min(1.0, confidence));
  }

  /**
   * 获取预测准确率（用于验证）
   */
  async getPredictionAccuracy() {
    const query = `
      SELECT 
        p.predicted_value,
        a.actual_value,
        ABS(p.predicted_value - a.actual_value) / a.actual_value AS error_rate
      FROM traffic_predictions p
      JOIN traffic_actuals a ON p.timestamp = a.timestamp
      WHERE p.timestamp > NOW() - INTERVAL '7 days'
    `;

    const result = await this.dbPool.query(query);

    if (result.rows.length === 0) {
      return 0;
    }

    const avgErrorRate = result.rows.reduce((sum, row) => sum + parseFloat(row.error_rate || 0), 0) / result.rows.length;
    const accuracy = 1 - avgErrorRate;

    logger.info('Prediction accuracy calculated', {
      sampleSize: result.rows.length,
      avgErrorRate,
      accuracy
    });

    return accuracy;
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    return {
      status: 'healthy',
      historicalDataPoints: this.historicalData.length,
      patternsDetected: this.currentPatterns.size,
      lastUpdate: this.historicalData[this.historicalData.length - 1]?.timestamp || null
    };
  }

  /**
   * 关闭资源
   */
  async shutdown() {
    if (this.redisClient) {
      await this.redisClient.quit();
    }
    if (this.dbPool) {
      await this.dbPool.end();
    }
    logger.info('TrafficAnalyzer shutdown complete');
  }
}

module.exports = TrafficAnalyzer;
