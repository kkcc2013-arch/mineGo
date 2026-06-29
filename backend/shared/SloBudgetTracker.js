/**
 * SloBudgetTracker - 错误预算追踪与燃尽率计算
 * 
 * 功能：
 * - 实时追踪错误预算消耗
 * - 计算多周期燃尽率（1h, 6h, 24h, 72h）
 * - 预测预算耗尽时间
 * - Prometheus 指标导出
 * - 预算耗尽事件触发
 */

const promClient = require('prom-client');
const EventEmitter = require('events');

// 时间窗口（毫秒）
const TIME_WINDOWS = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '72h': 72 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000
};

// 指标类型
const METRIC_TYPES = {
  REQUEST_TOTAL: 'request_total',
  REQUEST_ERRORS: 'request_errors',
  REQUEST_LATENCY: 'request_latency',
  REQUEST_TIMEOUTS: 'request_timeouts'
};

class SloBudgetTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.sloManager = options.sloManager;
    this.redis = options.redis;
    this.logger = options.logger || console;
    this.prometheusRegistry = options.prometheusRegistry || promClient.register;
    
    // 数据存储（Redis key 前缀）
    this.keyPrefix = options.keyPrefix || 'slo:budget:';
    
    // 缓存
    this.budgetCache = new Map();
    this.errorWindows = new Map(); // service -> { timestamps: [], counts: [] }
    
    // 燃尽率计算周期
    this.burnRatePeriods = ['1h', '6h', '24h', '72h'];
    
    // 注册 Prometheus 指标
    this.registerMetrics();
    
    // 启动后台任务
    this.startBackgroundTasks();
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    this.metrics = {
      budgetTotalGauge: new promClient.Gauge({
        name: 'minego_slo_budget_total',
        help: 'Total error budget for current window',
        labelNames: ['service', 'window'],
        registers: [this.prometheusRegistry]
      }),
      
      budgetRemainingGauge: new promClient.Gauge({
        name: 'minego_slo_budget_remaining',
        help: 'Remaining error budget',
        labelNames: ['service', 'window'],
        registers: [this.prometheusRegistry]
      }),
      
      budgetRemainingRatioGauge: new promClient.Gauge({
        name: 'minego_slo_budget_remaining_ratio',
        help: 'Remaining budget ratio (0-1)',
        labelNames: ['service', 'window'],
        registers: [this.prometheusRegistry]
      }),
      
      burnRateGauge: new promClient.Gauge({
        name: 'minego_slo_burn_rate',
        help: 'Error budget burn rate',
        labelNames: ['service', 'period'],
        registers: [this.prometheusRegistry]
      }),
      
      budgetExhaustionCounter: new promClient.Counter({
        name: 'minego_slo_budget_exhaustion_events_total',
        help: 'Number of SLO budget exhaustion events',
        labelNames: ['service'],
        registers: [this.prometheusRegistry]
      }),
      
      requestTotalCounter: new promClient.Counter({
        name: 'minego_slo_request_total',
        help: 'Total requests counted for SLO',
        labelNames: ['service', 'endpoint'],
        registers: [this.prometheusRegistry]
      }),
      
      requestErrorCounter: new promClient.Counter({
        name: 'minego_slo_request_errors_total',
        help: 'Total errors counted for SLO',
        labelNames: ['service', 'endpoint', 'error_type'],
        registers: [this.prometheusRegistry]
      }),
      
      predictionGauge: new promClient.Gauge({
        name: 'minego_slo_budget_exhaustion_prediction_seconds',
        help: 'Predicted time until budget exhaustion',
        labelNames: ['service'],
        registers: [this.prometheusRegistry]
      })
    };
  }

  /**
   * 启动后台任务
   */
  startBackgroundTasks() {
    // 每 30 秒刷新指标
    setInterval(() => this.refreshMetrics(), 30 * 1000);
    
    // 每 5 分钟检查预算状态
    setInterval(() => this.checkBudgetStatus(), 5 * 60 * 1000);
    
    // 每小时清理过期数据
    setInterval(() => this.cleanupOldData(), 60 * 60 * 1000);
  }

  /**
   * 记录请求
   */
  async recordRequest(service, endpoint, success, errorType = null) {
    // 更新请求计数
    this.metrics.requestTotalCounter.inc({ service, endpoint });
    
    if (!success) {
      this.metrics.requestErrorCounter.inc({ 
        service, 
        endpoint, 
        error_type: errorType || 'unknown' 
      });
      
      // 记录错误时间戳
      await this.recordError(service);
    }
    
    // 更新 Redis 计数
    if (this.redis) {
      const now = Date.now();
      const windowKey = this.getWindowKey(service, '30d');
      
      await this.redis.hincrby(windowKey, 'total_requests', 1);
      if (!success) {
        await this.redis.hincrby(windowKey, 'error_count', 1);
      }
    }
  }

  /**
   * 记录错误时间戳
   */
  async recordError(service) {
    const now = Date.now();
    
    if (!this.errorWindows.has(service)) {
      this.errorWindows.set(service, []);
    }
    
    const windows = this.errorWindows.get(service);
    windows.push(now);
    
    // 保留最近 72 小时的错误
    const cutoff = now - TIME_WINDOWS['72h'];
    this.errorWindows.set(
      service, 
      windows.filter(t => t > cutoff)
    );
    
    // Redis 持久化
    if (this.redis) {
      await this.redis.zadd(
        `${this.keyPrefix}errors:${service}`,
        now,
        now.toString()
      );
    }
  }

  /**
   * 计算错误数（指定时间窗口）
   */
  getErrorCount(service, period) {
    const windows = this.errorWindows.get(service) || [];
    const cutoff = Date.now() - TIME_WINDOWS[period];
    return windows.filter(t => t > cutoff).length;
  }

  /**
   * 计算燃尽率
   */
  async calculateBurnRate(service, period) {
    const slo = this.sloManager.getSlo(service);
    if (!slo) return null;
    
    const windowMs = TIME_WINDOWS[period];
    const windowTotal = slo.window;
    const windowDays = parseInt(windowTotal);
    const windowMsTotal = windowDays * 24 * 60 * 60 * 1000;
    
    // 获取该时间窗口的错误数
    const errorCount = this.getErrorCount(service, period);
    
    // 获取总预算
    const budgetStatus = await this.getStatus(service);
    if (!budgetStatus) return null;
    
    const totalBudget = budgetStatus.totalBudget;
    const remainingBudget = budgetStatus.remainingBudget;
    
    if (remainingBudget <= 0) return Infinity;
    
    // 燃尽率 = (错误数 / 剩余预算) × (总窗口时长 / 计算周期)
    const burnRate = (errorCount / remainingBudget) * (windowMsTotal / windowMs);
    
    return burnRate;
  }

  /**
   * 获取状态
   */
  async getStatus(service) {
    const slo = this.sloManager.getSlo(service);
    if (!slo) return null;
    
    // 尝试从缓存获取
    if (this.budgetCache.has(service)) {
      return this.budgetCache.get(service);
    }
    
    // 从 Redis 或 Prometheus 获取数据
    let totalRequests, errorCount;
    
    if (this.redis) {
      const windowKey = this.getWindowKey(service, '30d');
      const data = await this.redis.hgetall(windowKey);
      
      totalRequests = parseInt(data.total_requests || 0);
      errorCount = parseInt(data.error_count || 0);
    } else {
      // 使用本地数据
      totalRequests = 1000000; // 默认值，实际应从 Prometheus 获取
      errorCount = this.getErrorCount(service, '72h') * 10; // 估算
    }
    
    const totalBudget = Math.floor((1 - slo.target) * totalRequests);
    const remainingBudget = Math.max(0, totalBudget - errorCount);
    const consumedBudget = totalBudget - remainingBudget;
    const remainingRatio = totalBudget > 0 ? remainingBudget / totalBudget : 0;
    
    // 计算各周期燃尽率
    const burnRates = {};
    for (const period of this.burnRatePeriods) {
      burnRates[period] = await this.calculateBurnRate(service, period);
    }
    
    // 计算健康状态
    const health = this.sloManager.calculateHealth(remainingRatio, burnRates['1h'] || 0);
    
    // 预测耗尽时间
    const exhaustionPrediction = this.predictExhaustion(service, remainingBudget, burnRates['24h']);
    
    const status = {
      service,
      target: slo.target,
      window: slo.window,
      totalRequests,
      errorCount,
      totalBudget,
      remainingBudget,
      consumedBudget,
      remainingRatio,
      burnRates,
      health,
      exhaustionPrediction,
      lastUpdated: Date.now()
    };
    
    // 缓存
    this.budgetCache.set(service, status);
    
    return status;
  }

  /**
   * 预测预算耗尽时间
   */
  predictExhaustion(service, remainingBudget, burnRate) {
    if (!burnRate || burnRate <= 0 || remainingBudget <= 0) {
      return null;
    }
    
    const slo = this.sloManager.getSlo(service);
    if (!slo) return null;
    
    const windowDays = parseInt(slo.window);
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    
    // 剩余时间 = 剩余预算 / (燃尽率 × 总预算 / 窗口时长)
    const exhaustionSeconds = (remainingBudget / burnRate) * (windowMs / 1000) / windowDays;
    
    return {
      seconds: Math.floor(exhaustionSeconds),
      timestamp: Date.now() + exhaustionSeconds * 1000,
      humanReadable: this.formatTime(exhaustionSeconds)
    };
  }

  /**
   * 格式化时间
   */
  formatTime(seconds) {
    if (seconds < 60) return `${Math.floor(seconds)}秒`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分钟`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}小时`;
    return `${Math.floor(seconds / 86400)}天`;
  }

  /**
   * 刷新 Prometheus 指标
   */
  async refreshMetrics() {
    const services = Object.keys(this.sloManager.getAllSlos());
    
    for (const service of services) {
      const status = await this.getStatus(service);
      if (!status) continue;
      
      // 更新预算指标
      this.metrics.budgetTotalGauge.set(
        { service, window: status.window },
        status.totalBudget
      );
      this.metrics.budgetRemainingGauge.set(
        { service, window: status.window },
        status.remainingBudget
      );
      this.metrics.budgetRemainingRatioGauge.set(
        { service, window: status.window },
        status.remainingRatio
      );
      
      // 更新燃尽率指标
      for (const [period, rate] of Object.entries(status.burnRates)) {
        this.metrics.burnRateGauge.set(
          { service, period },
          rate || 0
        );
      }
      
      // 更新预测指标
      if (status.exhaustionPrediction) {
        this.metrics.predictionGauge.set(
          { service },
          status.exhaustionPrediction.seconds
        );
      }
    }
  }

  /**
   * 检查预算状态
   */
  async checkBudgetStatus() {
    const services = Object.keys(this.sloManager.getAllSlos());
    const alerts = [];
    
    for (const service of services) {
      const status = await this.getStatus(service);
      if (!status) continue;
      
      // 检查预算耗尽
      if (status.remainingRatio < 0.05) {
        alerts.push({
          service,
          type: 'budget_exhaustion',
          severity: 'critical',
          message: `${service} 预算剩余率 ${status.remainingRatio.toFixed(3)} 低于 5%`,
          status
        });
        
        this.metrics.budgetExhaustionCounter.inc({ service });
        this.emit('budgetExhaustion', { service, status });
      }
      
      // 检查燃尽率
      if (status.burnRates['1h'] && status.burnRates['1h'] > 2.0) {
        alerts.push({
          service,
          type: 'high_burn_rate',
          severity: 'warning',
          message: `${service} 1小时燃尽率 ${status.burnRates['1h'].toFixed(2)} 超过阈值 2.0`,
          status
        });
        
        this.emit('highBurnRate', { service, status, period: '1h' });
      }
    }
    
    return alerts;
  }

  /**
   * 清理过期数据
   */
  async cleanupOldData() {
    const cutoff = Date.now() - TIME_WINDOWS['72h'];
    
    for (const [service, windows] of this.errorWindows.entries()) {
      this.errorWindows.set(
        service,
        windows.filter(t => t > cutoff)
      );
    }
    
    // 清理 Redis 数据
    if (this.redis) {
      const services = Object.keys(this.sloManager.getAllSlos());
      for (const service of services) {
        await this.redis.zremrangebyscore(
          `${this.keyPrefix}errors:${service}`,
          '-inf',
          cutoff
        );
      }
    }
  }

  /**
   * 重新计算预算
   */
  async recalculate(service) {
    // 清除缓存
    this.budgetCache.delete(service);
    
    // 强制刷新
    const status = await this.getStatus(service);
    
    this.logger.info(`Budget recalculated for ${service}:`, {
      remainingRatio: status.remainingRatio,
      burnRate1h: status.burnRates['1h']
    });
    
    return status;
  }

  /**
   * 获取 Redis key
   */
  getWindowKey(service, window) {
    return `${this.keyPrefix}${service}:${window}`;
  }
}

module.exports = { SloBudgetTracker, TIME_WINDOWS, METRIC_TYPES };
