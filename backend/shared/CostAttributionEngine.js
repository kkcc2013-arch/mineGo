// backend/shared/CostAttributionEngine.js
// REQ-00367: 成本归因与优化建议引擎

'use strict';

const { getRedis } = require('./redis');
const { createLogger } = require('./logger');
const { query } = require('./db');
const metrics = require('./metrics');

const logger = createLogger('cost-attribution-engine');

/**
 * 成本归因引擎
 * 计算资源消耗成本并生成优化建议
 */
class CostAttributionEngine {
  constructor(options = {}) {
    this.redis = getRedis();
    this.config = {
      // 基础请求成本（美元）
      baseRequestCost: options.baseRequestCost || 0.0001,
      // 端点权重（不同类型请求的成本因子）
      endpointWeights: {
        '/api/catch': 2.0,
        '/api/gym/battle': 3.0,
        '/api/payment': 2.5,
        '/api/pokemon/list': 0.5,
        '/api/auth/login': 1.0,
        'default': 1.0
      },
      // 响应时间因子阈值
      responseTimeThresholds: {
        low: 100,
        medium: 300,
        high: 1000
      },
      // 数据大小因子阈值（KB）
      dataSizeThresholds: {
        low: 10,
        medium: 100,
        high: 500
      }
    };

    this.registerMetrics();
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    // 请求成本计数器
    if (!metrics.register.getSingleMetric('request_cost_total')) {
      metrics.register.registerMetric(
        new metrics.promClient.Counter({
          name: 'request_cost_total',
          help: 'Total request cost in USD',
          labelNames: ['user_id', 'endpoint', 'user_tier']
        })
      );
    }

    // 每日成本统计
    if (!metrics.register.getSingleMetric('daily_cost_usd')) {
      metrics.register.registerMetric(
        new metrics.promClient.Gauge({
          name: 'daily_cost_usd',
          help: 'Daily total cost in USD',
          labelNames: ['user_tier', 'endpoint']
        })
      );
    }

    // 优化建议生成计数
    if (!metrics.register.getSingleMetric('optimization_suggestions_total')) {
      metrics.register.registerMetric(
        new metrics.promClient.Counter({
          name: 'optimization_suggestions_total',
          help: 'Total optimization suggestions generated',
          labelNames: ['suggestion_type', 'priority']
        })
      );
    }
  }

  /**
   * 记录请求成本
   */
  async recordRequestCost(requestData) {
    const {
      userId,
      endpoint,
      requestId,
      responseTimeMs,
      responseSizeBytes,
      userTier
    } = requestData;

    // 计算成本
    const cost = this.calculateRequestCost({
      endpoint,
      responseTimeMs,
      responseSizeBytes
    });

    // 确定优先级
    const priority = this.determinePriority(userTier, endpoint);

    try {
      // 记录到数据库
      await query(`
        INSERT INTO request_cost_attribution (
          user_id, endpoint, request_id, response_time_ms, response_size_bytes,
          cost_usd, user_tier, priority
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        userId,
        endpoint,
        requestId,
        responseTimeMs,
        responseSizeBytes,
        cost,
        userTier,
        priority
      ]);

      // 更新 Prometheus 指标
      const costCounter = metrics.register.getSingleMetric('request_cost_total');
      if (costCounter) {
        costCounter.inc({ user_id: userId, endpoint, user_tier: userTier || 'free' }, cost);
      }

      logger.debug({
        userId,
        endpoint,
        cost,
        responseTimeMs
      }, 'Request cost recorded');

      return {
        recorded: true,
        cost,
        priority
      };
    } catch (err) {
      logger.warn({ err, userId, endpoint }, 'Failed to record request cost');
      return {
        recorded: false,
        cost,
        priority
      };
    }
  }

  /**
   * 计算单个请求成本
   */
  calculateRequestCost(requestData) {
    const { endpoint, responseTimeMs = 200, responseSizeBytes = 1024 } = requestData;

    // 基础成本
    const baseCost = this.config.baseRequestCost;

    // 端点权重
    const endpointWeight = this.matchEndpointWeight(endpoint);

    // 响应时间因子
    const responseTimeFactor = this.getResponseTimeFactor(responseTimeMs);

    // 数据大小因子
    const dataSizeFactor = this.getDataSizeFactor(responseSizeBytes);

    // 计算总成本
    const totalCost = baseCost * endpointWeight * responseTimeFactor * dataSizeFactor;

    return Math.round(totalCost * 100000000) / 100000000; // 保留8位小数
  }

  /**
   * 匹配端点权重
   */
  matchEndpointWeight(endpoint) {
    // 精确匹配
    if (this.config.endpointWeights[endpoint]) {
      return this.config.endpointWeights[endpoint];
    }

    // 前缀匹配
    for (const [pattern, weight] of Object.entries(this.config.endpointWeights)) {
      if (endpoint.startsWith(pattern)) {
        return weight;
      }
    }

    return this.config.endpointWeights.default;
  }

  /**
   * 获取响应时间因子
   */
  getResponseTimeFactor(responseTimeMs) {
    const thresholds = this.config.responseTimeThresholds;

    if (responseTimeMs <= thresholds.low) {
      return 0.8; // 快速响应成本较低
    } else if (responseTimeMs <= thresholds.medium) {
      return 1.0;
    } else if (responseTimeMs <= thresholds.high) {
      return 1.2;
    } else {
      return 1.5; // 慢响应成本较高
    }
  }

  /**
   * 获取数据大小因子
   */
  getDataSizeFactor(responseSizeBytes) {
    const sizeKB = responseSizeBytes / 1024;
    const thresholds = this.config.dataSizeThresholds;

    if (sizeKB <= thresholds.low) {
      return 0.9;
    } else if (sizeKB <= thresholds.medium) {
      return 1.0;
    } else if (sizeKB <= thresholds.high) {
      return 1.1;
    } else {
      return 1.3;
    }
  }

  /**
   * 确定请求优先级
   */
  determinePriority(userTier, endpoint) {
    if (userTier === 'vip' || userTier === 'svip') return 'highest';
    if (userTier === 'premium') return 'high';
    if (endpoint.includes('/payment/') || endpoint.includes('/auth/')) return 'high';
    return 'normal';
  }

  /**
   * 计算资源成本归因（按维度汇总）
   */
  async calculateCostAttribution(timeRange = '24h') {
    const timeCondition = this.getTimeCondition(timeRange);

    try {
      // 按用户归因
      const byUserResult = await query(`
        SELECT user_id, COUNT(*) as requests, SUM(cost_usd) as total_cost,
               AVG(response_time_ms) as avg_response_time
        FROM request_cost_attribution
        WHERE created_at >= ${timeCondition}
        GROUP BY user_id
        ORDER BY total_cost DESC
        LIMIT 100
      `);

      // 按端点归因
      const byEndpointResult = await query(`
        SELECT endpoint, COUNT(*) as requests, SUM(cost_usd) as total_cost,
               AVG(response_time_ms) as avg_response_time,
               AVG(response_size_bytes) as avg_response_size
        FROM request_cost_attribution
        WHERE created_at >= ${timeCondition}
        GROUP BY endpoint
        ORDER BY total_cost DESC
      `);

      // 按用户层级归因
      const byTierResult = await query(`
        SELECT user_tier, COUNT(*) as requests, SUM(cost_usd) as total_cost,
               COUNT(DISTINCT user_id) as unique_users
        FROM request_cost_attribution
        WHERE created_at >= ${timeCondition}
        GROUP BY user_tier
      `);

      // 总成本
      const totalCostResult = await query(`
        SELECT SUM(cost_usd) as total_cost, COUNT(*) as total_requests
        FROM request_cost_attribution
        WHERE created_at >= ${timeCondition}
      `);

      const attribution = {
        byUser: byUserResult.rows.map(row => ({
          userId: row.user_id,
          requests: row.requests,
          totalCost: row.total_cost,
          avgResponseTime: row.avg_response_time
        })),
        byEndpoint: byEndpointResult.rows.map(row => ({
          endpoint: row.endpoint,
          requests: row.requests,
          totalCost: row.total_cost,
          avgResponseTime: row.avg_response_time,
          avgResponseSize: row.avg_response_size
        })),
        byTier: byTierResult.rows.map(row => ({
          tier: row.user_tier,
          requests: row.requests,
          totalCost: row.total_cost,
          uniqueUsers: row.unique_users
        })),
        totalCost: totalCostResult.rows[0]?.total_cost || 0,
        totalRequests: totalCostResult.rows[0]?.total_requests || 0,
        timeRange,
        generatedAt: new Date().toISOString()
      };

      // 更新每日成本指标
      const dailyGauge = metrics.register.getSingleMetric('daily_cost_usd');
      if (dailyGauge) {
        for (const tier of attribution.byTier) {
          dailyGauge.set({ user_tier: tier.tier }, tier.totalCost);
        }
        for (const ep of attribution.byEndpoint) {
          dailyGauge.set({ endpoint: ep.endpoint }, ep.totalCost);
        }
      }

      return attribution;
    } catch (err) {
      logger.error({ err, timeRange }, 'Failed to calculate cost attribution');
      throw err;
    }
  }

  /**
   * 获取时间条件
   */
  getTimeCondition(timeRange) {
    const now = new Date();

    switch (timeRange) {
      case '1h':
        return `NOW() - INTERVAL '1 hour'`;
      case '24h':
        return `NOW() - INTERVAL '24 hours'`;
      case '7d':
        return `NOW() - INTERVAL '7 days'`;
      case '30d':
        return `NOW() - INTERVAL '30 days'`;
      default:
        return `NOW() - INTERVAL '24 hours'`;
    }
  }

  /**
   * 生成优化建议
   */
  async generateOptimizationSuggestions(userId) {
    const suggestions = [];

    try {
      // 获取用户成本数据
      const costResult = await query(`
        SELECT endpoint, COUNT(*) as requests, SUM(cost_usd) as total_cost,
               AVG(response_time_ms) as avg_response_time
        FROM request_cost_attribution
        WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
        GROUP BY endpoint
        ORDER BY requests DESC
      `, [userId]);

      if (costResult.rows.length === 0) {
        return suggestions;
      }

      const userMetrics = costResult.rows;
      const totalCost = userMetrics.reduce((sum, r) => sum + r.total_cost, 0);

      // 高频低价值请求优化
      const highFreqEndpoints = userMetrics.filter(r => r.requests > 100 && r.avg_response_time < 100);
      if (highFreqEndpoints.length > 0) {
        suggestions.push({
          type: 'caching',
          priority: 'high',
          title: '启用客户端缓存',
          description: `检测到 ${highFreqEndpoints.length} 个高频低价值端点，可启用本地缓存以减少请求`,
          potentialSavings: totalCost * 0.2,
          affectedEndpoints: highFreqEndpoints.map(r => r.endpoint),
          implementation: '在前端添加请求去重和本地缓存逻辑',
          estimatedImprovement: '减少请求量 30%'
        });
      }

      // 慢响应优化
      const slowEndpoints = userMetrics.filter(r => r.avg_response_time > 500);
      if (slowEndpoints.length > 0) {
        suggestions.push({
          type: 'performance',
          priority: 'high',
          title: '优化慢响应端点',
          description: `检测到 ${slowEndpoints.length} 个端点平均响应时间超过 500ms`,
          potentialSavings: totalCost * 0.15,
          affectedEndpoints: slowEndpoints.map(r => ({
            endpoint: r.endpoint,
            avgResponseTime: r.avg_response_time
          })),
          implementation: '检查后端性能，考虑添加索引或优化查询',
          estimatedImprovement: '响应时间降低 50%'
        });
      }

      // 批量操作优化
      const batchEndpoints = userMetrics.filter(r => r.endpoint.includes('batch') || r.endpoint.includes('bulk'));
      if (batchEndpoints.length > 0) {
        suggestions.push({
          type: 'batch_optimization',
          priority: 'medium',
          title: '优化批量请求策略',
          description: '检测到批量操作，建议合并或延迟执行',
          potentialSavings: totalCost * 0.1,
          affectedEndpoints: batchEndpoints.map(r => r.endpoint),
          implementation: '使用消息队列延迟处理非紧急批量请求',
          estimatedImprovement: '减少高峰期负载 20%'
        });
      }

      // 配额使用优化
      const quotaUsage = await this.getUserQuotaUsage(userId);
      if (quotaUsage && quotaUsage.utilization > 0.8) {
        suggestions.push({
          type: 'quota_management',
          priority: 'high',
          title: '优化配额使用策略',
          description: `当前配额使用率 ${quotaUsage.utilization.toFixed(2)}%，建议优化请求频率`,
          potentialSavings: quotaUsage.exceededRequests * 0.001,
          recommendations: [
            '减少冗余请求',
            '使用 WebSocket 替代轮询',
            '升级套餐获取更多配额'
          ],
          estimatedImprovement: '配额使用率降至 70%'
        });
      }

      // 记录建议生成
      const suggestionCounter = metrics.register.getSingleMetric('optimization_suggestions_total');
      for (const suggestion of suggestions) {
        if (suggestionCounter) {
          suggestionCounter.inc({ suggestion_type: suggestion.type, priority: suggestion.priority });
        }
      }

      return suggestions;
    } catch (err) {
      logger.warn({ err, userId }, 'Failed to generate optimization suggestions');
      return suggestions;
    }
  }

  /**
   * 获取用户配额使用情况
   */
  async getUserQuotaUsage(userId) {
    try {
      const result = await query(`
        SELECT daily_limit, used_today, quota_level
        FROM user_quotas WHERE user_id = $1
      `, [userId]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];
      const utilization = row.used_today / row.daily_limit;

      return {
        dailyLimit: row.daily_limit,
        usedToday: row.used_today,
        utilization,
        exceededRequests: Math.max(0, row.used_today - row.daily_limit),
        tier: row.quota_level
      };
    } catch (err) {
      return null;
    }
  }

  /**
   * 获取成本报告
   */
  async getCostReport(timeRange = '7d') {
    const attribution = await this.calculateCostAttribution(timeRange);

    // 计算趋势
    const previousPeriod = await this.calculateCostAttribution(
      timeRange === '7d' ? '14d' : '30d'
    );

    const trend = {
      costChange: attribution.totalCost - previousPeriod.totalCost,
      requestsChange: attribution.totalRequests - previousPeriod.totalRequests,
      costPercentage: ((attribution.totalCost - previousPeriod.totalCost) / previousPeriod.totalCost) * 100
    };

    return {
      ...attribution,
      trend,
      topCostUsers: attribution.byUser.slice(0, 10),
      topCostEndpoints: attribution.byEndpoint.slice(0, 10),
      recommendations: this.generateSystemRecommendations(attribution)
    };
  }

  /**
   * 生成系统级优化建议
   */
  generateSystemRecommendations(attribution) {
    const recommendations = [];

    // 高成本端点建议
    const highCostEndpoints = attribution.byEndpoint.filter(e => e.totalCost > attribution.totalCost * 0.1);
    if (highCostEndpoints.length > 0) {
      recommendations.push({
        type: 'endpoint_optimization',
        message: `${highCostEndpoints[0].endpoint} 占总成本 ${((highCostEndpoints[0].totalCost / attribution.totalCost) * 100).toFixed(1)}%，建议优化`
      });
    }

    // VIP用户成本占比
    const vipCost = attribution.byTier.find(t => t.tier === 'vip')?.totalCost || 0;
    if (vipCost > attribution.totalCost * 0.3) {
      recommendations.push({
        type: 'vip_resource_allocation',
        message: 'VIP用户成本占比较高，考虑增加专属资源池'
      });
    }

    return recommendations;
  }
}

// 单例
const costAttributionEngine = new CostAttributionEngine();

module.exports = {
  CostAttributionEngine,
  costAttributionEngine
};