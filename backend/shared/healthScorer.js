/**
 * REQ-00061: 服务健康评分引擎
 * 基于多维度指标计算服务健康分数（0-100）
 */

const logger = require('./logger');

// 健康评分权重配置
const HEALTH_WEIGHTS = {
  cpu: 0.15,
  memory: 0.15,
  errorRate: 0.20,
  responseTime: 0.20,
  connectionPool: 0.15,
  eventLag: 0.15
};

// 健康状态阈值
const HEALTH_THRESHOLDS = {
  healthy: 80,
  warning: 60,
  degraded: 40,
  critical: 0
};

class HealthScorer {
  constructor(options = {}) {
    this.weights = options.weights || HEALTH_WEIGHTS;
    this.thresholds = options.thresholds || HEALTH_THRESHOLDS;
    this.history = new Map();
    this.maxHistorySize = options.maxHistorySize || 100;
  }

  /**
   * 计算服务健康分数
   * @param {string} serviceName - 服务名称
   * @param {Object} metrics - 指标数据
   * @returns {Object} 健康评分详情
   */
  calculateHealthScore(serviceName, metrics) {
    const scores = {
      cpu: this._scoreCPU(metrics.cpu ?? 0),
      memory: this._scoreMemory(metrics.memory ?? 0),
      errorRate: this._scoreErrorRate(metrics.errorRate ?? 0),
      responseTime: this._scoreResponseTime(metrics.responseTime ?? 0),
      connectionPool: this._scoreConnectionPool(metrics.connectionPool ?? 0),
      eventLag: this._scoreEventLag(metrics.eventLag ?? 0)
    };

    // 计算加权总分
    let totalScore = 0;
    for (const [key, weight] of Object.entries(this.weights)) {
      totalScore += scores[key].score * weight;
    }

    // 保存历史记录
    this._saveHistory(serviceName, totalScore, scores);

    // 确定健康状态
    const status = this._determineStatus(totalScore);

    const result = {
      serviceName,
      totalScore: Math.round(totalScore),
      status,
      scores,
      trend: this._calculateTrend(serviceName),
      recommendations: this._generateRecommendations(scores, status),
      timestamp: new Date().toISOString()
    };

    logger.debug({
      serviceName,
      totalScore: result.totalScore,
      status
    }, '健康评分计算完成');

    return result;
  }

  /**
   * 批量计算多个服务的健康分数
   * @param {Array<{serviceName: string, metrics: Object}>} services - 服务列表
   * @returns {Array<Object>} 健康评分列表
   */
  calculateBatch(services) {
    return services.map(({ serviceName, metrics }) => 
      this.calculateHealthScore(serviceName, metrics)
    );
  }

  /**
   * CPU 健康评分 (0-100)
   */
  _scoreCPU(cpuPercent) {
    if (cpuPercent < 50) {
      return { score: 100, status: 'healthy', detail: `CPU ${cpuPercent.toFixed(1)}% 正常` };
    }
    if (cpuPercent < 70) {
      return { score: 85, status: 'healthy', detail: `CPU ${cpuPercent.toFixed(1)}% 中等负载` };
    }
    if (cpuPercent < 85) {
      return { score: 60, status: 'warning', detail: `CPU ${cpuPercent.toFixed(1)}% 高负载` };
    }
    return { score: 30, status: 'critical', detail: `CPU ${cpuPercent.toFixed(1)}% 严重过载` };
  }

  /**
   * 内存健康评分 (0-100)
   */
  _scoreMemory(memoryPercent) {
    if (memoryPercent < 60) {
      return { score: 100, status: 'healthy', detail: `内存 ${memoryPercent.toFixed(1)}% 正常` };
    }
    if (memoryPercent < 75) {
      return { score: 80, status: 'healthy', detail: `内存 ${memoryPercent.toFixed(1)}% 中等使用` };
    }
    if (memoryPercent < 90) {
      return { score: 50, status: 'warning', detail: `内存 ${memoryPercent.toFixed(1)}% 高使用` };
    }
    return { score: 20, status: 'critical', detail: `内存 ${memoryPercent.toFixed(1)}% 即将 OOM` };
  }

  /**
   * 错误率健康评分 (0-100)
   */
  _scoreErrorRate(errorRate) {
    if (errorRate < 0.01) {
      return { score: 100, status: 'healthy', detail: '错误率 <1% 优秀' };
    }
    if (errorRate < 0.05) {
      return { score: 80, status: 'healthy', detail: `错误率 ${(errorRate * 100).toFixed(2)}% 正常` };
    }
    if (errorRate < 0.10) {
      return { score: 50, status: 'warning', detail: `错误率 ${(errorRate * 100).toFixed(2)}% 偏高` };
    }
    return { score: 10, status: 'critical', detail: `错误率 ${(errorRate * 100).toFixed(2)}% 严重` };
  }

  /**
   * 响应时间健康评分 (0-100)
   */
  _scoreResponseTime(p95Latency) {
    const latencyMs = p95Latency;
    if (latencyMs < 100) {
      return { score: 100, status: 'healthy', detail: `P95 ${latencyMs.toFixed(0)}ms 极快` };
    }
    if (latencyMs < 300) {
      return { score: 90, status: 'healthy', detail: `P95 ${latencyMs.toFixed(0)}ms 良好` };
    }
    if (latencyMs < 500) {
      return { score: 70, status: 'warning', detail: `P95 ${latencyMs.toFixed(0)}ms 一般` };
    }
    if (latencyMs < 1000) {
      return { score: 40, status: 'warning', detail: `P95 ${latencyMs.toFixed(0)}ms 偏慢` };
    }
    return { score: 15, status: 'critical', detail: `P95 ${latencyMs.toFixed(0)}ms 严重慢` };
  }

  /**
   * 连接池健康评分 (0-100)
   */
  _scoreConnectionPool(poolUsage) {
    if (poolUsage < 50) {
      return { score: 100, status: 'healthy', detail: `连接池使用 ${poolUsage.toFixed(1)}%` };
    }
    if (poolUsage < 70) {
      return { score: 80, status: 'healthy', detail: `连接池使用 ${poolUsage.toFixed(1)}%` };
    }
    if (poolUsage < 85) {
      return { score: 50, status: 'warning', detail: `连接池使用 ${poolUsage.toFixed(1)}% 偏高` };
    }
    return { score: 20, status: 'critical', detail: `连接池使用 ${poolUsage.toFixed(1)}% 即将耗尽` };
  }

  /**
   * 事件积压健康评分 (0-100)
   */
  _scoreEventLag(eventLagSeconds) {
    if (eventLagSeconds < 10) {
      return { score: 100, status: 'healthy', detail: `事件延迟 ${eventLagSeconds.toFixed(1)}s 正常` };
    }
    if (eventLagSeconds < 60) {
      return { score: 70, status: 'warning', detail: `事件延迟 ${eventLagSeconds.toFixed(1)}s 稍高` };
    }
    if (eventLagSeconds < 300) {
      return { score: 40, status: 'warning', detail: `事件延迟 ${eventLagSeconds.toFixed(1)}s 严重积压` };
    }
    return { score: 10, status: 'critical', detail: `事件延迟 ${eventLagSeconds.toFixed(1)}s 极度积压` };
  }

  /**
   * 确定整体健康状态
   */
  _determineStatus(score) {
    if (score >= this.thresholds.healthy) return 'healthy';
    if (score >= this.thresholds.warning) return 'warning';
    if (score >= this.thresholds.degraded) return 'degraded';
    return 'critical';
  }

  /**
   * 计算趋势（最近评分变化方向）
   */
  _calculateTrend(serviceName) {
    const history = this.history.get(serviceName) || [];
    if (history.length < 2) return 'stable';

    const recent = history.slice(-5);
    const avgRecent = recent.slice(-3).reduce((a, b) => a + b.score, 0) / Math.min(3, recent.length);
    const avgOld = recent.slice(0, Math.max(1, recent.length - 3)).reduce((a, b) => a + b.score, 0) / Math.max(1, recent.length - 3);

    const diff = avgRecent - avgOld;
    if (diff > 5) return 'improving';
    if (diff < -5) return 'declining';
    return 'stable';
  }

  /**
   * 生成优化建议
   */
  _generateRecommendations(scores, status) {
    const recommendations = [];

    for (const [key, data] of Object.entries(scores)) {
      if (data.status === 'critical' || data.status === 'warning') {
        const recommendation = this._createRecommendation(key, data);
        if (recommendation) {
          recommendations.push(recommendation);
        }
      }
    }

    return recommendations.sort((a, b) => {
      const priorityOrder = { high: 0, medium: 1, low: 2 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
  }

  /**
   * 创建单个维度的优化建议
   */
  _createRecommendation(key, data) {
    const isCritical = data.status === 'critical';
    const priority = isCritical ? 'high' : 'medium';

    const recommendations = {
      cpu: {
        type: 'scaling',
        action: '建议增加 Pod 副本数或优化 CPU 密集型代码',
        autoRecoverable: true
      },
      memory: {
        type: 'memory',
        action: '建议增加内存限制或排查内存泄漏',
        autoRecoverable: false
      },
      errorRate: {
        type: 'error',
        action: '建议查看错误日志并考虑回滚到上一稳定版本',
        autoRecoverable: true
      },
      responseTime: {
        type: 'performance',
        action: '建议优化慢查询或增加缓存',
        autoRecoverable: false
      },
      connectionPool: {
        type: 'connection',
        action: '建议扩容连接池或优化数据库查询',
        autoRecoverable: true
      },
      eventLag: {
        type: 'event',
        action: '建议增加消费者实例或优化事件处理逻辑',
        autoRecoverable: true
      }
    };

    const base = recommendations[key];
    if (!base) return null;

    return {
      dimension: key,
      type: base.type,
      priority,
      action: base.action,
      autoRecoverable: base.autoRecoverable,
      detail: data.detail
    };
  }

  /**
   * 保存历史记录
   */
  _saveHistory(serviceName, totalScore, scores) {
    if (!this.history.has(serviceName)) {
      this.history.set(serviceName, []);
    }

    const history = this.history.get(serviceName);
    history.push({
      score: totalScore,
      timestamp: Date.now(),
      scores
    });

    // 只保留最近 N 条记录
    while (history.length > this.maxHistorySize) {
      history.shift();
    }
  }

  /**
   * 获取服务历史记录
   */
  getHistory(serviceName, limit = 10) {
    const history = this.history.get(serviceName) || [];
    return history.slice(-limit);
  }

  /**
   * 清除历史记录
   */
  clearHistory(serviceName) {
    if (serviceName) {
      this.history.delete(serviceName);
    } else {
      this.history.clear();
    }
  }

  /**
   * 获取所有服务的当前状态摘要
   */
  getSummary() {
    const summary = {};
    for (const [serviceName, history] of this.history.entries()) {
      if (history.length > 0) {
        const latest = history[history.length - 1];
        summary[serviceName] = {
          score: Math.round(latest.score),
          status: this._determineStatus(latest.score),
          lastUpdate: new Date(latest.timestamp).toISOString()
        };
      }
    }
    return summary;
  }
}

module.exports = HealthScorer;
module.exports.HEALTH_WEIGHTS = HEALTH_WEIGHTS;
module.exports.HEALTH_THRESHOLDS = HEALTH_THRESHOLDS;
