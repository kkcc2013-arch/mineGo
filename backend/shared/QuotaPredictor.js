// backend/shared/QuotaPredictor.js
// REQ-00367: 配额预测与预警系统

'use strict';

const { getRedis } = require('./redis');
const { createLogger } = require('./logger');
const { query } = require('./db');
const metrics = require('./metrics');

const logger = createLogger('quota-predictor');

/**
 * 配额预测器
 * 基于历史使用模式预测配额消耗趋势
 */
class QuotaPredictor {
  constructor(options = {}) {
    this.redis = getRedis();
    this.predictionCachePrefix = 'quota_prediction:';
    this.predictionCacheTTL = 300; // 5分钟缓存

    // 预测模型配置
    this.config = {
      historyDays: options.historyDays || 7,
      predictionHours: options.predictionHours || 24,
      warningThresholds: {
        critical: 0.95,  // 95% 使用率预警
        high: 0.90,      // 90% 使用率预警
        warning: 0.80    // 80% 使用率预警
      }
    };

    this.registerMetrics();
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    // 预测准确率
    if (!metrics.register.getSingleMetric('quota_prediction_accuracy')) {
      metrics.register.registerMetric(
        new metrics.promClient.Gauge({
          name: 'quota_prediction_accuracy',
          help: 'Quota prediction accuracy percentage',
          labelNames: ['user_id']
        })
      );
    }

    // 预警触发计数
    if (!metrics.register.getSingleMetric('quota_warnings_generated_total')) {
      metrics.register.registerMetric(
        new metrics.promClient.Counter({
          name: 'quota_warnings_generated_total',
          help: 'Total quota warnings generated',
          labelNames: ['warning_type', 'severity']
        })
      );
    }
  }

  /**
   * 预测用户配额使用趋势
   */
  async predictUsageTrend(userId, hoursAhead = this.config.predictionHours) {
    const cacheKey = `${this.predictionCachePrefix}${userId}`;

    // 尝试从缓存获取
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn({ err, userId }, 'Prediction cache read failed');
    }

    // 获取历史使用数据
    const historicalData = await this.getHistoricalUsage(userId, this.config.historyDays);

    // 分析使用模式
    const patterns = this.analyzePatterns(historicalData);

    // 获取当前配额
    const currentQuota = await this.getCurrentQuota(userId);

    // 生成预测
    const predictions = [];
    const now = new Date();
    const currentHour = now.getHours();

    for (let i = 1; i <= hoursAhead; i++) {
      const targetHour = (currentHour + i) % 24;
      const predictedRequests = this.predictHourlyRequests(patterns, targetHour);

      const hourStart = new Date(now);
      hourStart.setHours(targetHour, 0, 0, 0);
      if (targetHour < currentHour) {
        hourStart.setDate(hourStart.getDate() + 1);
      }

      // 计算累积使用量
      const currentUsage = await this.getCurrentHourlyUsage(userId);
      const cumulativeUsage = currentUsage + predictions.reduce((sum, p) => sum + p.predictedRequests, 0) + predictedRequests;

      // 计算剩余配额
      const remainingQuota = currentQuota.dailyLimit - cumulativeUsage;
      const willExhaust = remainingQuota <= currentQuota.dailyLimit * (1 - this.config.warningThresholds.high);

      predictions.push({
        hour: i,
        targetHour,
        hourStart: hourStart.toISOString(),
        predictedRequests,
        cumulativeUsage,
        remainingQuota,
        usagePercentage: (cumulativeUsage / currentQuota.dailyLimit) * 100,
        willExhaust,
        warningLevel: this.getWarningLevel(cumulativeUsage / currentQuota.dailyLimit)
      });
    }

    const result = {
      userId,
      generatedAt: now.toISOString(),
      currentQuota,
      patterns,
      predictions,
      warningHours: predictions.filter(p => p.willExhaust).map(p => ({
        hour: p.hour,
        level: p.warningLevel,
        remaining: p.remainingQuota
      })),
      trendDirection: patterns.trendDirection,
      peakHours: patterns.peakHours,
      estimatedExhaustionHour: predictions.find(p => p.remainingQuota <= 0)?.hour || null
    };

    // 缓存预测结果
    try {
      await this.redis.setex(cacheKey, this.predictionCacheTTL, JSON.stringify(result));
    } catch (err) {
      logger.warn({ err, userId }, 'Prediction cache write failed');
    }

    return result;
  }

  /**
   * 获取历史使用数据
   */
  async getHistoricalUsage(userId, days) {
    try {
      const result = await query(`
        SELECT date, hour, request_count, endpoint_breakdown
        FROM user_usage_history
        WHERE user_id = $1 AND date >= NOW() - INTERVAL '${days} days'
        ORDER BY date DESC, hour DESC
      `, [userId]);

      if (result.rows.length === 0) {
        // 使用模拟数据作为初始预测
        return this.generateMockHistory(days);
      }

      return result.rows.map(row => ({
        date: row.date,
        hour: row.hour,
        requestCount: row.request_count,
        endpointBreakdown: row.endpoint_breakdown,
        weekday: new Date(row.date).getDay()
      }));
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to get historical usage, using mock');
      return this.generateMockHistory(days);
    }
  }

  /**
   * 生成模拟历史数据（用于新用户）
   */
  generateMockHistory(days) {
    const data = [];
    for (let i = 0; i < days; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const weekday = date.getDay();

      for (let hour = 0; hour < 24; hour++) {
        // 模拟使用模式：高峰时段请求多
        const baseCount = weekday === 0 || weekday === 6 ? 50 : 30;
        const hourFactor = (hour >= 10 && hour <= 22) ? 2 : 0.5;
        const variance = Math.random() * 20;

        data.push({
          date: date.toISOString().split('T')[0],
          hour,
          requestCount: Math.floor(baseCount * hourFactor + variance),
          weekday
        });
      }
    }
    return data;
  }

  /**
   * 分析使用模式
   */
  analyzePatterns(historicalData) {
    const patterns = {
      hourlyDistribution: new Array(24).fill(0),
      weekdayDistribution: new Array(7).fill(0),
      averageRequestsPerHour: 0,
      peakHours: [],
      lowHours: [],
      trendDirection: 'stable',
      hourlyVariance: new Array(24).fill(0)
    };

    // 计算每小时分布
    const hourCounts = new Array(24).fill(0);
    const hourCounters = new Array(24).fill(0);

    historicalData.forEach(record => {
      patterns.hourlyDistribution[record.hour] += record.requestCount;
      patterns.weekdayDistribution[record.weekday] += record.requestCount;
      hourCounts[record.hour] += record.requestCount;
      hourCounters[record.hour]++;
    });

    // 计算平均值
    const totalRequests = historicalData.reduce((sum, r) => sum + r.requestCount, 0);
    const totalHours = historicalData.length;
    patterns.averageRequestsPerHour = totalRequests / totalHours;

    // 归一化每小时分布
    for (let i = 0; i < 24; i++) {
      if (hourCounters[i] > 0) {
        patterns.hourlyDistribution[i] = hourCounts[i] / hourCounters[i];
      }
    }

    // 找出高峰时段
    const avgHourlyUsage = patterns.averageRequestsPerHour;
    patterns.peakHours = patterns.hourlyDistribution
      .map((usage, hour) => ({ hour, usage }))
      .filter(h => h.usage > avgHourlyUsage * 1.5)
      .map(h => h.hour)
      .sort((a, b) => patterns.hourlyDistribution[b] - patterns.hourlyDistribution[a]);

    // 找出低谷时段
    patterns.lowHours = patterns.hourlyDistribution
      .map((usage, hour) => ({ hour, usage }))
      .filter(h => h.usage < avgHourlyUsage * 0.5)
      .map(h => h.hour);

    // 分析趋势
    if (historicalData.length >= 3) {
      const recentData = historicalData.slice(0, Math.min(3, historicalData.length));
      const olderData = historicalData.slice(Math.min(3, historicalData.length));

      if (olderData.length > 0) {
        const recentAvg = recentData.reduce((sum, r) => sum + r.requestCount, 0) / recentData.length;
        const olderAvg = olderData.reduce((sum, r) => sum + r.requestCount, 0) / olderData.length;

        if (recentAvg > olderAvg * 1.1) {
          patterns.trendDirection = 'increasing';
        } else if (recentAvg < olderAvg * 0.9) {
          patterns.trendDirection = 'decreasing';
        }
      }
    }

    return patterns;
  }

  /**
   * 预测每小时请求量
   */
  predictHourlyRequests(patterns, targetHour) {
    const basePrediction = patterns.hourlyDistribution[targetHour] || patterns.averageRequestsPerHour;

    // 应用趋势因子
    let trendFactor = 1;
    if (patterns.trendDirection === 'increasing') {
      trendFactor = 1.1;
    } else if (patterns.trendDirection === 'decreasing') {
      trendFactor = 0.9;
    }

    return Math.floor(basePrediction * trendFactor);
  }

  /**
   * 获取当前配额
   */
  async getCurrentQuota(userId) {
    try {
      const result = await query(`
        SELECT daily_limit, hourly_limit, used_today, used_this_hour
        FROM user_quotas WHERE user_id = $1
      `, [userId]);

      if (result.rows.length === 0) {
        return { dailyLimit: 1000, hourlyLimit: 100, usedToday: 0, usedThisHour: 0 };
      }

      return {
        dailyLimit: result.rows[0].daily_limit,
        hourlyLimit: result.rows[0].hourly_limit,
        usedToday: result.rows[0].used_today,
        usedThisHour: result.rows[0].used_this_hour
      };
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to get current quota');
      return { dailyLimit: 1000, hourlyLimit: 100, usedToday: 0, usedThisHour: 0 };
    }
  }

  /**
   * 获取当前小时使用量
   */
  async getCurrentHourlyUsage(userId) {
    try {
      const now = new Date();
      const currentHour = now.getHours();
      const today = now.toISOString().split('T')[0];

      const result = await query(`
        SELECT request_count FROM user_usage_history
        WHERE user_id = $1 AND date = $2 AND hour = $3
      `, [userId, today, currentHour]);

      return result.rows[0]?.request_count || 0;
    } catch (err) {
      return 0;
    }
  }

  /**
   * 获取预警等级
   */
  getWarningLevel(usagePercentage) {
    if (usagePercentage >= this.config.warningThresholds.critical) {
      return 'critical';
    }
    if (usagePercentage >= this.config.warningThresholds.high) {
      return 'high';
    }
    if (usagePercentage >= this.config.warningThresholds.warning) {
      return 'warning';
    }
    return 'normal';
  }

  /**
   * 生成智能预警
   */
  async generateWarnings(userId) {
    const prediction = await this.predictUsageTrend(userId);
    const warnings = [];

    // 配额即将用尽预警
    if (prediction.warningHours.length > 0) {
      const earliestWarning = prediction.warningHours[0];

      warnings.push({
        type: 'quota_exhaustion',
        severity: earliestWarning.level,
        message: `预计在未来 ${earliestWarning.hour} 小时内配额将达到 ${prediction.estimatedExhaustionHour ? '用尽' : '预警线'}`,
        details: {
          predictedExhaustionHour: prediction.estimatedExhaustionHour,
          currentUsage: prediction.currentQuota.usedToday,
          remainingQuota: earliestWarning.remaining
        },
        recommendations: [
          '升级至更高层级套餐以获取更多配额',
          '在非高峰时段（' + prediction.lowHours.slice(0, 3).join(',') + '点）使用服务',
          '减少批量操作频率'
        ],
        generatedAt: new Date().toISOString()
      });

      // 记录预警指标
      const warningCounter = metrics.register.getSingleMetric('quota_warnings_generated_total');
      if (warningCounter) {
        warningCounter.inc({ warning_type: 'quota_exhaustion', severity: earliestWarning.level });
      }
    }

    // 使用趋势异常预警
    if (prediction.trendDirection === 'increasing') {
      const currentUsage = prediction.currentQuota.usedToday;
      const avgDailyUsage = prediction.patterns.averageRequestsPerHour * 24;

      if (currentUsage > avgDailyUsage * 1.5) {
        warnings.push({
          type: 'usage_spike',
          severity: 'high',
          message: '检测到使用量异常增长趋势，当前使用量超过平均值 50%',
          details: {
            currentUsage,
            avgDailyUsage,
            trendDirection: prediction.trendDirection
          },
          recommendations: [
            '检查是否有自动化脚本在使用',
            '考虑优化请求频率',
            '联系客服了解优化建议'
          ],
          generatedAt: new Date().toISOString()
        });

        const warningCounter = metrics.register.getSingleMetric('quota_warnings_generated_total');
        if (warningCounter) {
          warningCounter.inc({ warning_type: 'usage_spike', severity: 'high' });
        }
      }
    }

    // 高峰时段使用预警
    const now = new Date();
    const currentHour = now.getHours();
    if (prediction.peakHours.includes(currentHour)) {
      warnings.push({
        type: 'peak_hour_usage',
        severity: 'warning',
        message: '当前处于高峰时段，服务可能响应较慢',
        details: {
          currentHour,
          peakHours: prediction.peakHours
        },
        recommendations: [
          '如非紧急操作，可等待低谷时段处理',
          '优先处理关键业务请求'
        ],
        generatedAt: new Date().toISOString()
      });
    }

    // 记录预警到数据库
    for (const warning of warnings) {
      await this.recordWarning(userId, warning);
    }

    return {
      userId,
      warnings,
      hasWarnings: warnings.length > 0,
      predictionSummary: {
        trendDirection: prediction.trendDirection,
        estimatedExhaustionHour: prediction.estimatedExhaustionHour,
        peakHours: prediction.peakHours,
        lowHours: prediction.lowHours
      }
    };
  }

  /**
   * 记录预警到数据库
   */
  async recordWarning(userId, warning) {
    try {
      await query(`
        INSERT INTO quota_warnings (
          user_id, warning_type, severity, message, usage_percentage, recommendation
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        userId,
        warning.type,
        warning.severity,
        warning.message,
        warning.details?.currentUsage / warning.details?.avgDailyUsage || null,
        warning.recommendations?.join('; ')
      ]);
    } catch (err) {
      logger.warn({ err, userId, warning }, 'Failed to record warning');
    }
  }

  /**
   * 更新使用历史
   */
  async updateUsageHistory(userId, endpoint, requestCount = 1) {
    const now = new Date();
    const today = now.toISOString().split('T')[0];
    const currentHour = now.getHours();

    try {
      // 更新当前小时的记录
      await query(`
        INSERT INTO user_usage_history (user_id, date, hour, request_count, endpoint_breakdown)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id, date, hour) DO UPDATE SET
          request_count = user_usage_history.request_count + $4,
          endpoint_breakdown = user_usage_history.endpoint_breakdown || $5
      `, [userId, today, currentHour, requestCount, JSON.stringify({ [endpoint]: requestCount })]);
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to update usage history');
    }
  }

  /**
   * 获取批量预测（用于管理员）
   */
  async getBatchPredictions(userIds) {
    const predictions = {};

    for (const userId of userIds) {
      try {
        predictions[userId] = await this.predictUsageTrend(userId, 12);
      } catch (err) {
        logger.warn({ err, userId }, 'Failed to get batch prediction');
        predictions[userId] = null;
      }
    }

    return predictions;
  }
}

// 单例
const quotaPredictor = new QuotaPredictor();

module.exports = {
  QuotaPredictor,
  quotaPredictor
};