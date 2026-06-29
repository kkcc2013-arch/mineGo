// backend/shared/ConnectionPoolPredictor.js
// REQ-00362: 数据库连接池智能预测与预分配系统

'use strict';

const { query } = require('./db');
const { getRedis, setJSON, getJSON } = require('./redis');
const { createLogger } = require('./logger');

const logger = createLogger('pool-predictor');

// ============================================================
// 配置
// ============================================================

const PREDICTOR_CONFIG = {
  historyWindow: 7 * 24 * 3600 * 1000, // 7天历史数据（毫秒）
  predictionWindow: 30, // 预测未来30分钟
  minConfidence: 0.7,
  minSamplesForTraining: 100,
  modelRefreshInterval: 6 * 3600 * 1000, // 每6小时刷新模型
  cacheTTL: 300, // 预测结果缓存5分钟
  
  // 时间段权重
  hourWeights: {
    0: 0.3, 1: 0.2, 2: 0.15, 3: 0.1, 4: 0.1, 5: 0.15, // 凌晨低谷
    6: 0.3, 7: 0.4, 8: 0.5, 9: 0.6, 10: 0.7, 11: 0.8, // 上午上升
    12: 0.7, 13: 0.6, 14: 0.7, 15: 0.8, 16: 0.85, 17: 0.9, // 下午高峰
    18: 1.0, 19: 1.0, 20: 0.95, 21: 0.9, 22: 0.7, 23: 0.5 // 晚高峰到回落
  },
  
  // 星期权重
  dayWeights: {
    sunday: 0.8,
    monday: 0.9,
    tuesday: 0.85,
    wednesday: 0.85,
    thursday: 0.85,
    friday: 1.0,
    saturday: 1.0
  }
};

// ============================================================
// 连接池预测器类
// ============================================================

class ConnectionPoolPredictor {
  constructor(config = {}) {
    this.config = { ...PREDICTOR_CONFIG, ...config };
    this.patterns = new Map();
    this.models = new Map();
    this.redis = null;
    this.lastTrainingTime = new Map();
  }

  /**
   * 初始化 Redis 连接
   */
  async initRedis() {
    if (!this.redis) {
      this.redis = getRedis();
    }
    return this.redis;
  }

  /**
   * 获取历史连接使用数据
   */
  async getHistoricalData(serviceName) {
    try {
      const { rows } = await query(`
        SELECT 
          timestamp,
          connection_count,
          pool_usage_percent
        FROM connection_pool_history
        WHERE service_name = $1
          AND timestamp > NOW() - INTERVAL '7 days'
        ORDER BY timestamp ASC
      `, [serviceName]);

      return rows.map(r => ({
        timestamp: new Date(r.timestamp),
        connections: r.connection_count,
        usage: r.pool_usage_percent
      }));
    } catch (err) {
      logger.warn({ serviceName, err: err.message }, 'Failed to get historical data, using defaults');
      return [];
    }
  }

  /**
   * 获取流量模式
   */
  async loadPatterns(serviceName) {
    try {
      const { rows } = await query(`
        SELECT 
          pattern_type,
          pattern_key,
          avg_connections,
          peak_connections,
          confidence,
          sample_count
        FROM traffic_patterns
        WHERE service_name = $1
      `, [serviceName]);

      for (const row of rows) {
        const key = `${serviceName}:${row.pattern_type}:${row.pattern_key}`;
        this.patterns.set(key, {
          avgConnections: row.avg_connections,
          peakConnections: row.peak_connections,
          confidence: row.confidence,
          sampleCount: row.sample_count
        });
      }

      logger.info({ serviceName, patternCount: rows.length }, 'Patterns loaded');
    } catch (err) {
      logger.warn({ serviceName, err: err.message }, 'Failed to load patterns');
    }
  }

  /**
   * 获取当前时刻的模式
   */
  getCurrentPattern(serviceName) {
    const now = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayOfWeek = days[now.getDay()];
    const hour = now.getHours();

    // 查找小时级模式
    const hourPatternKey = `${serviceName}:hourly:${hour}:00`;
    const hourPattern = this.patterns.get(hourPatternKey);

    // 查找日级模式
    const dayPatternKey = `${serviceName}:daily:${dayOfWeek}`;
    const dayPattern = this.patterns.get(dayPatternKey);

    // 查找周级模式
    const weekPatternKey = `${serviceName}:weekly:${dayOfWeek}-${hour}:00`;
    const weekPattern = this.patterns.get(weekPatternKey);

    // 组合模式（优先使用更具体的）
    if (weekPattern && weekPattern.confidence >= this.config.minConfidence) {
      return weekPattern;
    }
    if (hourPattern && hourPattern.confidence >= this.config.minConfidence) {
      return hourPattern;
    }
    if (dayPattern && dayPattern.confidence >= this.config.minConfidence) {
      return dayPattern;
    }

    return null;
  }

  /**
   * 基于历史模式的简单预测
   */
  patternBasedPrediction(serviceName, horizon = 30) {
    const now = new Date();
    const predictions = [];
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

    for (let i = 0; i < horizon; i++) {
      const futureTime = new Date(now.getTime() + i * 60 * 1000);
      const futureHour = futureTime.getHours();
      const futureDay = days[futureTime.getDay()];

      // 获取时间段权重
      const hourWeight = this.config.hourWeights[futureHour] || 0.5;
      const dayWeight = this.config.dayWeights[futureDay] || 0.85;

      // 获取模式数据
      const patternKey = `${serviceName}:weekly:${futureDay}-${futureHour}:00`;
      const pattern = this.patterns.get(patternKey);

      if (pattern) {
        // 基于模式的预测
        predictions.push(Math.ceil(pattern.avgConnections * hourWeight * dayWeight));
      } else {
        // 默认预测（基于权重）
        const baseConnections = 10; // 基础连接数
        predictions.push(Math.ceil(baseConnections * hourWeight * dayWeight * 5));
      }
    }

    // 计算置信度
    const pattern = this.getCurrentPattern(serviceName);
    const confidence = pattern ? pattern.confidence : 0.5;

    return {
      predictions,
      confidence,
      source: 'pattern',
      peak: Math.max(...predictions),
      min: Math.min(...predictions)
    };
  }

  /**
   * 简单移动平均预测
   */
  movingAveragePrediction(history, horizon = 30) {
    if (history.length < 10) {
      return null;
    }

    // 取最近1小时的平均值
    const recent = history.slice(-60);
    const avg = recent.reduce((sum, h) => sum + h.connections, 0) / recent.length;

    // 获取趋势
    const older = history.slice(-120, -60);
    const olderAvg = older.length > 0 
      ? older.reduce((sum, h) => sum + h.connections, 0) / older.length 
      : avg;

    const trend = avg > olderAvg ? 1.05 : (avg < olderAvg ? 0.95 : 1.0);

    // 生成预测
    const predictions = [];
    for (let i = 0; i < horizon; i++) {
      predictions.push(Math.ceil(avg * Math.pow(trend, i / 30)));
    }

    return {
      predictions,
      confidence: 0.6,
      source: 'moving_average',
      peak: Math.max(...predictions),
      min: Math.min(...predictions)
    };
  }

  /**
   * 主预测方法
   */
  async predict(serviceName, horizon = 30) {
    // 检查缓存
    const cacheKey = `pool:prediction:${serviceName}`;
    try {
      await this.initRedis();
      const cached = await getJSON(cacheKey);
      if (cached && cached.timestamp && 
          Date.now() - cached.timestamp < this.config.cacheTTL * 1000) {
        logger.debug({ serviceName }, 'Using cached prediction');
        return cached;
      }
    } catch (err) {
      logger.warn({ serviceName, err: err.message }, 'Cache read failed');
    }

    // 加载模式
    await this.loadPatterns(serviceName);

    // 获取历史数据
    const history = await this.getHistoricalData(serviceName);

    // 选择预测方法
    let prediction;

    if (history.length >= this.config.minSamplesForTraining) {
      // 尝试移动平均预测
      const maPrediction = this.movingAveragePrediction(history, horizon);
      if (maPrediction) {
        prediction = maPrediction;
      } else {
        prediction = this.patternBasedPrediction(serviceName, horizon);
      }
    } else {
      // 使用模式预测
      prediction = this.patternBasedPrediction(serviceName, horizon);
    }

    // 添加元信息
    prediction.serviceName = serviceName;
    prediction.horizon = horizon;
    prediction.timestamp = Date.now();

    // 保存预测结果
    try {
      await setJSON(cacheKey, prediction, this.config.cacheTTL);
    } catch (err) {
      logger.warn({ serviceName, err: err.message }, 'Cache write failed');
    }

    // 保存到数据库
    await this.savePrediction(serviceName, prediction);

    logger.info({
      serviceName,
      peak: prediction.peak,
      confidence: prediction.confidence,
      source: prediction.source
    }, 'Prediction generated');

    return prediction;
  }

  /**
   * 保存预测结果到数据库
   */
  async savePrediction(serviceName, prediction) {
    try {
      await query(`
        INSERT INTO connection_pool_predictions 
          (service_name, prediction_time, predicted_connections, confidence_score, model_version, features)
        VALUES ($1, NOW(), $2, $3, $4, $5)
      `, [
        serviceName,
        prediction.peak,
        prediction.confidence,
        prediction.source,
        JSON.stringify({
          horizon: prediction.horizon,
          min: prediction.min,
          peak: prediction.peak
        })
      ]);
    } catch (err) {
      logger.warn({ serviceName, err: err.message }, 'Failed to save prediction');
    }
  }

  /**
   * 获取指定时间点的预测连接数
   */
  async getPredictedConnections(serviceName, minutesAhead = 5) {
    const prediction = await this.predict(serviceName, 30);
    
    if (minutesAhead <= prediction.predictions.length) {
      return prediction.predictions[minutesAhead - 1];
    }
    
    // 超出预测范围，返回峰值
    return prediction.peak;
  }

  /**
   * 检测是否需要预分配
   */
  async shouldPreallocate(serviceName, currentConnections) {
    const prediction = await this.predict(serviceName, 30);
    
    // 5分钟后的预测值
    const predicted5Min = prediction.predictions[4] || prediction.peak;
    
    // 如果预测值比当前高20%以上，需要预分配
    const threshold = currentConnections * 1.2;
    
    if (predicted5Min > threshold) {
      return {
        needPreallocate: true,
        currentConnections,
        predictedConnections: predicted5Min,
        targetConnections: Math.ceil(predicted5Min * 1.1), // 多预留10%
        confidence: prediction.confidence,
        leadTime: 5 // 提前5分钟
      };
    }

    return {
      needPreallocate: false,
      currentConnections,
      predictedConnections: predicted5Min
    };
  }

  /**
   * 检测是否可以缩容
   */
  async shouldScaleDown(serviceName, currentConnections) {
    const prediction = await this.predict(serviceName, 30);
    
    // 未来10-30分钟的最小值
    const minPredicted = Math.min(...prediction.predictions.slice(9));
    
    // 如果最小预测值比当前低50%以上，可以缩容
    if (minPredicted < currentConnections * 0.5 && currentConnections > 10) {
      return {
        shouldScaleDown: true,
        currentConnections,
        targetConnections: Math.ceil(minPredicted * 1.2),
        confidence: prediction.confidence
      };
    }

    return {
      shouldScaleDown: false,
      currentConnections,
      minPredicted
    };
  }

  /**
   * 更新流量模式
   */
  async updatePattern(serviceName, patternType, patternKey, avgConnections, peakConnections) {
    try {
      await query(`
        INSERT INTO traffic_patterns 
          (service_name, pattern_type, pattern_key, avg_connections, peak_connections, confidence, sample_count, last_updated)
        VALUES ($1, $2, $3, $4, $5, 0.8, 1, NOW())
        ON CONFLICT (service_name, pattern_type, pattern_key)
        DO UPDATE SET 
          avg_connections = (traffic_patterns.avg_connections * traffic_patterns.sample_count + $4) / (traffic_patterns.sample_count + 1),
          peak_connections = GREATEST(traffic_patterns.peak_connections, $5),
          sample_count = traffic_patterns.sample_count + 1,
          confidence = LEAST(traffic_patterns.confidence + 0.01, 0.95),
          last_updated = NOW()
      `, [serviceName, patternType, patternKey, avgConnections, peakConnections]);

      logger.debug({ serviceName, patternType, patternKey }, 'Pattern updated');
    } catch (err) {
      logger.warn({ serviceName, err: err.message }, 'Failed to update pattern');
    }
  }

  /**
   * 记录当前连接数据（用于模式学习）
   */
  async recordCurrentStats(serviceName, connectionCount, usagePercent) {
    const now = new Date();
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayOfWeek = days[now.getDay()];
    const hour = now.getHours();

    // 更新小时级模式
    await this.updatePattern(serviceName, 'hourly', `${hour}:00`, connectionCount, connectionCount);

    // 更新日级模式
    await this.updatePattern(serviceName, 'daily', dayOfWeek, connectionCount, connectionCount);

    // 更新周级模式
    await this.updatePattern(serviceName, 'weekly', `${dayOfWeek}-${hour}:00`, connectionCount, connectionCount);

    // 记录历史数据
    try {
      await query(`
        INSERT INTO connection_pool_history 
          (service_name, timestamp, connection_count, pool_usage_percent)
        VALUES ($1, NOW(), $2, $3)
      `, [serviceName, connectionCount, usagePercent]);
    } catch (err) {
      // 历史表可能不存在，忽略错误
    }
  }

  /**
   * 批量预测所有服务
   */
  async predictAllServices(services) {
    const predictions = {};
    
    for (const serviceName of services) {
      predictions[serviceName] = await this.predict(serviceName, 30);
    }

    return predictions;
  }
}

// ============================================================
// 单例导出
// ============================================================

let predictorInstance = null;

function getConnectionPoolPredictor(config = {}) {
  if (!predictorInstance) {
    predictorInstance = new ConnectionPoolPredictor(config);
  }
  return predictorInstance;
}

module.exports = {
  ConnectionPoolPredictor,
  getConnectionPoolPredictor,
  PREDICTOR_CONFIG
};