'use strict';

/**
 * 威胁特征提取器
 * 从请求中提取用于威胁检测的多维特征
 */

class FeatureExtractor {
  constructor(config = {}) {
    this.windowSize = config.windowSize || 60000; // 60秒滑动窗口
    this.sensitivePaths = config.sensitivePaths || [
      '/api/auth/login',
      '/api/auth/register',
      '/api/payment',
      '/api/user/profile',
      '/api/admin'
    ];
    
    // Redis key prefix
    this.redisPrefix = 'threat:features:';
  }

  /**
   * 提取单个请求的特征
   * @param {Object} req - Express request object
   * @param {Object} context - 请求上下文（会话信息等）
   * @returns {Object} 特征对象
   */
  extractRequestFeatures(req, context = {}) {
    const ip = this.getClientIp(req);
    const sessionId = req.session?.id || req.headers['x-session-id'] || 'anonymous';
    const userId = req.user?.id || null;
    
    return {
      // 基础请求信息
      timestamp: Date.now(),
      ip,
      sessionId,
      userId,
      method: req.method,
      path: req.path,
      userAgent: req.headers['user-agent'] || '',
      
      // 时间窗口内统计特征（需异步获取）
      windowStats: null // 将在 updateWindowStats 中填充
    };
  }

  /**
   * 更新时间窗口统计
   * @param {Object} redis - Redis client
   * @param {string} key - 统计 key (IP 或 session)
   * @param {Object} requestFeatures - 请求特征
   * @returns {Promise<Object>} 窗口统计
   */
  async updateWindowStats(redis, key, requestFeatures) {
    const windowKey = `${this.redisPrefix}${key}`;
    const now = Date.now();
    const windowStart = now - this.windowSize;
    
    // 使用 Redis Sorted Set 存储时间窗口数据
    const timestamp = now;
    
    // 创建特征数据点
    const dataPoint = {
      timestamp,
      path: requestFeatures.path,
      method: requestFeatures.method,
      statusCode: requestFeatures.statusCode || 200,
      responseTime: requestFeatures.responseTime || 0
    };
    
    // 添加到 Sorted Set
    await redis.zadd(windowKey, timestamp, JSON.stringify(dataPoint));
    
    // 移除过期的数据点
    await redis.zremrangebyscore(windowKey, '-inf', windowStart);
    
    // 设置过期时间
    await redis.expire(windowKey, Math.ceil(this.windowSize / 1000) + 10);
    
    // 获取窗口内所有数据
    const points = await redis.zrangebyscore(windowKey, windowStart, '+inf');
    
    // 计算统计特征
    const stats = this.calculateWindowStatistics(points.map(p => JSON.parse(p)));
    
    return stats;
  }

  /**
   * 计算窗口统计特征
   * @param {Array} dataPoints - 时间窗口内的数据点
   * @returns {Object} 统计特征
   */
  calculateWindowStatistics(dataPoints) {
    if (dataPoints.length === 0) {
      return this.getDefaultStats();
    }
    
    const now = Date.now();
    const timestamps = dataPoints.map(p => p.timestamp);
    const paths = dataPoints.map(p => p.path);
    const methods = dataPoints.map(p => p.method);
    const statusCodes = dataPoints.map(p => p.statusCode);
    const responseTimes = dataPoints.map(p => p.responseTime || 0);
    
    // 请求速率
    const windowDuration = (now - Math.min(...timestamps)) / 1000 || 1;
    const requestRate = dataPoints.length / windowDuration;
    
    // 唯一路径数
    const uniquePaths = new Set(paths).size;
    
    // 路径熵值
    const pathEntropy = this.calculateEntropy(paths);
    
    // HTTP 方法分布
    const methodCounts = this.countValues(methods);
    const httpMethodVariance = this.calculateVariance(Object.values(methodCounts));
    
    // 错误率
    const errorCount = statusCodes.filter(c => c >= 400).length;
    const errorRate = errorCount / dataPoints.length;
    
    // 请求间隔统计
    const intervals = this.calculateIntervals(timestamps);
    const intervalStats = intervals.length > 0 
      ? this.calculateDistributionStats(intervals)
      : { mean: 0, std: 0, skewness: 0 };
    
    // 响应时间统计
    const responseTimeStats = this.calculateDistributionStats(responseTimes);
    
    // 敏感 API 命中率
    const sensitiveHits = paths.filter(p => 
      this.sensitivePaths.some(sp => p.startsWith(sp))
    ).length;
    const sensitiveApiHits = sensitiveHits / dataPoints.length;
    
    return {
      requestRate: Math.round(requestRate * 100) / 100,
      totalRequests: dataPoints.length,
      uniquePaths,
      pathEntropy: Math.round(pathEntropy * 100) / 100,
      httpMethodVariance: Math.round(httpMethodVariance * 100) / 100,
      errorRate: Math.round(errorRate * 100) / 100,
      requestInterval: intervalStats,
      responseTime: responseTimeStats,
      sensitiveApiHits: Math.round(sensitiveApiHits * 100) / 100,
      methodDistribution: methodCounts
    };
  }

  /**
   * 计算熵值
   * @param {Array} values - 值数组
   * @returns {number} 熵值 (0-1)
   */
  calculateEntropy(values) {
    if (values.length === 0) return 0;
    
    const counts = this.countValues(values);
    const total = values.length;
    let entropy = 0;
    
    for (const count of Object.values(counts)) {
      const p = count / total;
      if (p > 0) {
        entropy -= p * Math.log2(p);
      }
    }
    
    // 归一化到 0-1
    const maxEntropy = Math.log2(Object.keys(counts).length);
    return maxEntropy > 0 ? entropy / maxEntropy : 0;
  }

  /**
   * 计算方差
   * @param {Array<number>} values - 数值数组
   * @returns {number} 方差
   */
  calculateVariance(values) {
    if (values.length === 0) return 0;
    
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    
    return variance;
  }

  /**
   * 计算间隔
   * @param {Array<number>} timestamps - 时间戳数组
   * @returns {Array<number>} 间隔数组（ms）
   */
  calculateIntervals(timestamps) {
    if (timestamps.length < 2) return [];
    
    const sorted = [...timestamps].sort((a, b) => a - b);
    const intervals = [];
    
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(sorted[i] - sorted[i - 1]);
    }
    
    return intervals;
  }

  /**
   * 计算分布统计
   * @param {Array<number>} values - 数值数组
   * @returns {Object} { mean, std, skewness }
   */
  calculateDistributionStats(values) {
    if (values.length === 0) {
      return { mean: 0, std: 0, skewness: 0 };
    }
    
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    
    if (n === 1) {
      return { mean: Math.round(mean * 100) / 100, std: 0, skewness: 0 };
    }
    
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / n;
    const std = Math.sqrt(variance);
    
    // 偏度计算
    const skewness = values.reduce((sum, val) => {
      return sum + Math.pow((val - mean) / std, 3);
    }, 0) / n;
    
    return {
      mean: Math.round(mean * 100) / 100,
      std: Math.round(std * 100) / 100,
      skewness: Math.round(skewness * 100) / 100
    };
  }

  /**
   * 计数值
   * @param {Array} values - 值数组
   * @returns {Object} { value: count }
   */
  countValues(values) {
    const counts = {};
    for (const val of values) {
      counts[val] = (counts[val] || 0) + 1;
    }
    return counts;
  }

  /**
   * 获取客户端 IP
   * @param {Object} req - Express request
   * @returns {string} IP 地址
   */
  getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.connection?.remoteAddress ||
           req.ip ||
           'unknown';
  }

  /**
   * 获取默认统计
   */
  getDefaultStats() {
    return {
      requestRate: 0,
      totalRequests: 0,
      uniquePaths: 0,
      pathEntropy: 0,
      httpMethodVariance: 0,
      errorRate: 0,
      requestInterval: { mean: 0, std: 0, skewness: 0 },
      responseTime: { mean: 0, std: 0, skewness: 0 },
      sensitiveApiHits: 0,
      methodDistribution: {}
    };
  }

  /**
   * 合并请求特征和窗口统计
   * @param {Object} requestFeatures - 请求特征
   * @param {Object} windowStats - 窗口统计
   * @param {Object} sessionContext - 会话上下文
   * @returns {Object} 完整特征向量
   */
  mergeFeatures(requestFeatures, windowStats, sessionContext = {}) {
    return {
      // 原始信息
      ip: requestFeatures.ip,
      sessionId: requestFeatures.sessionId,
      userId: requestFeatures.userId,
      timestamp: requestFeatures.timestamp,
      
      // 窗口统计特征
      requestRate: windowStats.requestRate,
      totalRequests: windowStats.totalRequests,
      uniquePaths: windowStats.uniquePaths,
      pathEntropy: windowStats.pathEntropy,
      httpMethodVariance: windowStats.httpMethodVariance,
      errorRate: windowStats.errorRate,
      requestIntervalMean: windowStats.requestInterval.mean,
      requestIntervalStd: windowStats.requestInterval.std,
      requestIntervalSkewness: windowStats.requestInterval.skewness,
      responseTimeMean: windowStats.responseTime.mean,
      responseTimeStd: windowStats.responseTime.std,
      sensitiveApiHits: windowStats.sensitiveApiHits,
      
      // 会话特征
      sessionAge: sessionContext.sessionAge || 0,
      authAttempts: sessionContext.authAttempts || 0,
      
      // 行为模式
      isBot: this.detectBotPattern(requestFeatures.userAgent, windowStats),
      isScanning: this.detectScanPattern(windowStats)
    };
  }

  /**
   * 检测机器人模式
   * @param {string} userAgent - User Agent
   * @param {Object} stats - 窗口统计
   * @returns {boolean}
   */
  detectBotPattern(userAgent, stats) {
    if (!userAgent) return false;
    
    const botSignatures = [
      'bot', 'crawler', 'spider', 'scraper', 'curl', 'wget', 'python-requests'
    ];
    
    const isBotUA = botSignatures.some(sig => 
      userAgent.toLowerCase().includes(sig)
    );
    
    const isHighRate = stats.requestRate > 10; // > 10 req/s
    
    const isRegularInterval = stats.requestIntervalStd < 100; // 间隔标准差 < 100ms
    
    return isBotUA || (isHighRate && isRegularInterval);
  }

  /**
   * 检测扫描模式
   * @param {Object} stats - 窗口统计
   * @returns {boolean}
   */
  detectScanPattern(stats) {
    // 扫描特征：高路径熵 + 高请求率 + 高错误率
    return stats.pathEntropy > 0.8 && 
           stats.requestRate > 5 && 
           stats.errorRate > 0.3;
  }

  /**
   * 转换为模型输入向量
   * @param {Object} features - 完整特征对象
   * @returns {Array<number>} 特征向量
   */
  toFeatureVector(features) {
    return [
      features.requestRate || 0,
      features.totalRequests || 0,
      features.uniquePaths || 0,
      features.pathEntropy || 0,
      features.httpMethodVariance || 0,
      features.errorRate || 0,
      features.requestIntervalMean || 0,
      features.requestIntervalStd || 0,
      features.requestIntervalSkewness || 0,
      features.responseTimeMean || 0,
      features.responseTimeStd || 0,
      features.sensitiveApiHits || 0,
      features.sessionAge || 0,
      features.authAttempts || 0,
      features.isBot ? 1 : 0,
      features.isScanning ? 1 : 0
    ];
  }
}

module.exports = FeatureExtractor;
