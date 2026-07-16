/**
 * 采样率管理器
 * 
 * REQ-00582: 采样率动态配置与管理
 * 
 * 功能：
 * - 采样率配置管理
 * - 流量监控与自适应调整
 * - 多服务采样率协调
 */

'use strict';

const { createLogger, metrics } = require('../logger');
const { query } = require('../db');
const { IntelligentSampler, defaultConfig } = require('./IntelligentSampler');

const logger = createLogger('sampling-rate-manager');

/**
 * 采样率管理器配置
 */
const managerConfig = {
  updateIntervalMs: 10000,     // 采样率更新间隔 10秒
  metricsWindowMs: 60000,     // 指标统计窗口 1分钟
  historyRetentionMs: 86400000, // 历史保留 1天
  minSamplesForAdaptation: 100  // 最小样本数才进行自适应
};

/**
 * 服务流量指标
 */
class ServiceMetrics {
  constructor(serviceName) {
    this.serviceName = serviceName;
    this.requests = [];
    this.errors = 0;
    this.slowRequests = 0;
    this.lastUpdate = Date.now();
  }

  addRequest(duration, isError, isSlow) {
    this.requests.push({
      timestamp: Date.now(),
      duration,
      isError,
      isSlow
    });
    
    if (isError) this.errors++;
    if (isSlow) this.slowRequests++;
    
    // 清理旧数据
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - managerConfig.metricsWindowMs;
    this.requests = this.requests.filter(r => r.timestamp > cutoff);
  }

  getQPS() {
    this.prune();
    const duration = (Date.now() - this.lastUpdate) / 1000;
    return this.requests.length / Math.max(duration, 1);
  }

  getErrorRate() {
    if (this.requests.length === 0) return 0;
    return this.errors / this.requests.length;
  }

  getSlowRequestRatio() {
    if (this.requests.length === 0) return 0;
    return this.slowRequests / this.requests.length;
  }

  getAvgLatency() {
    if (this.requests.length === 0) return 0;
    const total = this.requests.reduce((sum, r) => sum + r.duration, 0);
    return total / this.requests.length;
  }
}

/**
 * 采样率管理器
 */
class SamplingRateManager {
  constructor() {
    this.samplers = new Map();  // serviceName -> IntelligentSampler
    this.serviceMetrics = new Map(); // serviceName -> ServiceMetrics
    this.configOverrides = new Map(); // serviceName -> config
    this.updateInterval = null;
    this.history = [];
  }

  /**
   * 初始化管理器
   */
  async initialize(services = []) {
    // 默认服务列表
    const defaultServices = [
      'gateway', 'user-service', 'location-service',
      'pokemon-service', 'catch-service', 'gym-service',
      'social-service', 'reward-service', 'payment-service'
    ];
    
    const allServices = services.length > 0 ? services : defaultServices;
    
    for (const serviceName of allServices) {
      await this.addService(serviceName);
    }
    
    // 启动定时更新
    this.startAutoUpdate();
    
    logger.info({ services: allServices }, 'SamplingRateManager initialized');
    
    return {
      services: allServices,
      status: 'initialized'
    };
  }

  /**
   * 添加服务
   */
  async addService(serviceName) {
    if (this.samplers.has(serviceName)) {
      logger.warn({ serviceName }, 'Service already exists');
      return this.samplers.get(serviceName);
    }
    
    // 尝试从数据库加载配置
    let config = { ...defaultConfig };
    try {
      const { rows } = await query(`
        SELECT * FROM sampling_config WHERE service_name = $1
      `, [serviceName]);
      
      if (rows.length > 0) {
        config = {
          ...defaultConfig,
          ...rows[0]
        };
      }
    } catch (err) {
      logger.debug({ serviceName, err: err.message }, 'No saved config, using defaults');
    }
    
    const sampler = new IntelligentSampler(config);
    this.samplers.set(serviceName, sampler);
    this.serviceMetrics.set(serviceName, new ServiceMetrics(serviceName));
    
    logger.info({ serviceName, config }, 'Service added');
    
    return sampler;
  }

  /**
   * 启动自动更新
   */
  startAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    
    this.updateInterval = setInterval(() => {
      this.updateAllRates();
    }, managerConfig.updateIntervalMs);
    
    logger.debug('Auto update started');
  }

  /**
   * 停止自动更新
   */
  stopAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.debug('Auto update stopped');
    }
  }

  /**
   * 更新所有服务的采样率
   */
  updateAllRates() {
    for (const [serviceName, sampler] of this.samplers) {
      const metrics = this.serviceMetrics.get(serviceName);
      
      const metricsData = {
        qps: metrics.getQPS(),
        errorRate: metrics.getErrorRate(),
        slowRequestRatio: metrics.getSlowRequestRatio(),
        avgLatency: metrics.getAvgLatency()
      };
      
      sampler.calculateSamplingRate(metricsData);
      
      // 记录历史
      this.recordHistory(serviceName, sampler.currentRate, metricsData);
    }
  }

  /**
   * 记录历史
   */
  recordHistory(serviceName, rate, metricsData) {
    this.history.push({
      timestamp: Date.now(),
      serviceName,
      rate,
      ...metricsData
    });
    
    // 清理旧历史
    const cutoff = Date.now() - managerConfig.historyRetentionMs;
    this.history = this.history.filter(h => h.timestamp > cutoff);
  }

  /**
   * 决定是否采样
   */
  shouldSample(serviceName, span) {
    if (!this.samplers.has(serviceName)) {
      logger.warn({ serviceName }, 'Service not found');
      return { sampled: false, reason: 'service_not_found' };
    }
    
    const sampler = this.samplers.get(serviceName);
    const metrics = this.serviceMetrics.get(serviceName);
    
    const metricsData = {
      qps: metrics.getQPS(),
      errorRate: metrics.getErrorRate(),
      slowRequestRatio: metrics.getSlowRequestRatio(),
      avgLatency: metrics.getAvgLatency()
    };
    
    return sampler.shouldSample(span, metricsData);
  }

  /**
   * 记录请求
   */
  recordRequest(serviceName, duration, isError, isSlow) {
    if (!this.serviceMetrics.has(serviceName)) {
      return;
    }
    
    const metrics = this.serviceMetrics.get(serviceName);
    metrics.addRequest(duration, isError, isSlow);
  }

  /**
   * 获取服务采样率
   */
  getServiceRate(serviceName) {
    if (!this.samplers.has(serviceName)) {
      return null;
    }
    
    const sampler = this.samplers.get(serviceName);
    const metrics = this.serviceMetrics.get(serviceName);
    
    return {
      serviceName,
      currentRate: sampler.currentRate,
      config: sampler.config,
      stats: sampler.getStats(),
      metrics: {
        qps: metrics.getQPS(),
        errorRate: metrics.getErrorRate(),
        slowRequestRatio: metrics.getSlowRequestRatio(),
        avgLatency: metrics.getAvgLatency()
      }
    };
  }

  /**
   * 获取所有服务采样率
   */
  getAllRates() {
    const rates = {};
    
    for (const [serviceName] of this.samplers) {
      rates[serviceName] = this.getServiceRate(serviceName);
    }
    
    return rates;
  }

  /**
   * 更新服务配置
   */
  async updateServiceConfig(serviceName, newConfig) {
    if (!this.samplers.has(serviceName)) {
      logger.warn({ serviceName }, 'Service not found for config update');
      return { success: false, error: 'service_not_found' };
    }
    
    const sampler = this.samplers.get(serviceName);
    const result = sampler.updateConfig(newConfig);
    
    // 保存到数据库
    try {
      await query(`
        INSERT INTO sampling_config (
          service_name, base_rate, min_rate, max_rate, 
          error_rate, slow_threshold_ms, adaptive_enabled, priority_rules
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (service_name) DO UPDATE SET
          base_rate = EXCLUDED.base_rate,
          min_rate = EXCLUDED.min_rate,
          max_rate = EXCLUDED.max_rate,
          error_rate = EXCLUDED.error_rate,
          slow_threshold_ms = EXCLUDED.slow_threshold_ms,
          adaptive_enabled = EXCLUDED.adaptive_enabled,
          priority_rules = EXCLUDED.priority_rules,
          updated_at = NOW()
      `, [
        serviceName,
        sampler.config.baseRate,
        sampler.config.minRate,
        sampler.config.maxRate,
        sampler.config.errorRate,
        sampler.config.slowThresholdMs,
        sampler.config.adaptiveEnabled,
        JSON.stringify(sampler.config.priorityRules)
      ]);
      
      logger.info({ serviceName, newConfig }, 'Config updated and saved');
    } catch (err) {
      logger.error({ err, serviceName }, 'Failed to save config');
      result.saved = false;
    }
    
    return result;
  }

  /**
   * 获取历史趋势
   */
  getHistory(serviceName = null, hours = 1) {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    
    let history = this.history.filter(h => h.timestamp > cutoff);
    
    if (serviceName) {
      history = history.filter(h => h.serviceName === serviceName);
    }
    
    // 聚合为每分钟一个点
    const aggregated = {};
    
    for (const record of history) {
      const minute = Math.floor(record.timestamp / 60000);
      const key = `${record.serviceName}:${minute}`;
      
      if (!aggregated[key]) {
        aggregated[key] = {
          serviceName: record.serviceName,
          timestamp: minute * 60000,
          rates: [],
          qps: [],
          errorRates: []
        };
      }
      
      aggregated[key].rates.push(record.rate);
      aggregated[key].qps.push(record.qps);
      aggregated[key].errorRates.push(record.errorRate);
    }
    
    return Object.values(aggregated).map(a => ({
      serviceName: a.serviceName,
      timestamp: a.timestamp,
      avgRate: a.rates.reduce((sum, r) => sum + r, 0) / a.rates.length,
      avgQps: a.qps.reduce((sum, q) => sum + q, 0) / a.qps.length,
      avgErrorRate: a.errorRates.reduce((sum, e) => sum + e, 0) / a.errorRates.length
    })).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * 关闭管理器
   */
  shutdown() {
    this.stopAutoUpdate();
    this.samplers.clear();
    this.serviceMetrics.clear();
    
    logger.info('SamplingRateManager shutdown');
  }
}

// 数据库表结构
const schema = `
CREATE TABLE IF NOT EXISTS sampling_config (
  service_name VARCHAR(100) PRIMARY KEY,
  base_rate DECIMAL(5,4) DEFAULT 0.01,
  min_rate DECIMAL(5,4) DEFAULT 0.001,
  max_rate DECIMAL(5,4) DEFAULT 1.0,
  error_rate DECIMAL(5,4) DEFAULT 1.0,
  slow_threshold_ms INTEGER DEFAULT 1000,
  adaptive_enabled BOOLEAN DEFAULT true,
  priority_rules JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sampling_config_service ON sampling_config(service_name);
`;

module.exports = {
  SamplingRateManager,
  ServiceMetrics,
  managerConfig,
  schema
};