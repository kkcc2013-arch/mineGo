/**
 * 微服务链路追踪采样率智能自适应与成本优化系统
 * 
 * REQ-00582: 智能采样率自适应与成本优化
 * 
 * 核心功能：
 * - 根据流量模式动态调整采样率（0.1% - 100%）
 * - 错误请求和慢请求自动提高采样率至 100%
 * - 正常请求根据服务负载动态降低采样率
 * - 存储成本优化
 * - 关键追踪数据零丢失
 */

'use strict';

const { createLogger } = require('../logger');
const metrics = require('../metrics');

const logger = createLogger('intelligent-sampler');

/**
 * 采样决策类型
 */
const SampleDecision = {
  SAMPLED: 'sampled',
  NOT_SAMPLED: 'not_sampled',
  PRIORITY_SAMPLED: 'priority_sampled'
};

/**
 * 采样优先级规则
 */
const PriorityRules = {
  ERROR: 'error',           // 错误请求
  SLOW: 'slow',            // 慢请求
  PAYMENT: 'payment',      // 支付相关
  AUTH: 'auth',            // 认证相关
  VIP_USER: 'vip_user',    // VIP 用户
  CRITICAL_PATH: 'critical_path' // 关键路径
};

/**
 * 流量区间定义
 */
const TrafficZones = {
  LOW: { min: 0, max: 100, rate: 0.001 },           // 低峰期: 0.1%
  NORMAL: { min: 100, max: 1000, rate: 0.01 },      // 正常期: 1%
  HIGH: { min: 1000, max: 5000, rate: 0.05 },       // 高峰期: 5%
  PEAK: { min: 5000, max: Infinity, rate: 0.1 }    // 极高峰期: 10%
};

/**
 * 智能采样器配置
 */
const defaultConfig = {
  baseRate: 0.01,           // 默认 1%
  minRate: 0.001,           // 最小 0.1%
  maxRate: 1.0,             // 最大 100%
  errorRate: 1.0,           // 错误请求 100% 采样
  slowThresholdMs: 1000,    // 慢请求阈值
  adaptiveEnabled: true,    // 自适应启用
  priorityRules: [
    PriorityRules.ERROR,
    PriorityRules.SLOW,
    PriorityRules.PAYMENT,
    PriorityRules.AUTH
  ]
};

/**
 * 智能采样器
 */
class IntelligentSampler {
  constructor(config = {}) {
    this.config = { ...defaultConfig, ...config };
    this.currentRate = this.config.baseRate;
    this.metrics = {
      total: 0,
      sampled: 0,
      prioritySampled: 0,
      byReason: {}
    };
    
    // 注册 Prometheus 指标
    this.registerMetrics();
    
    logger.info({ config: this.config }, 'IntelligentSampler initialized');
  }

  /**
   * 注册 Prometheus 指标
   */
  registerMetrics() {
    // 当前采样率
    this.samplingRateGauge = metrics.gauge(
      'minego_tracing_sampling_rate',
      'Current tracing sampling rate',
      ['service']
    );

    // 采样决策计数
    this.samplingDecisionsCounter = metrics.counter(
      'minego_tracing_sampling_decisions_total',
      'Total sampling decisions',
      ['decision', 'reason']
    );

    // 优先采样计数
    this.prioritySampleCounter = metrics.counter(
      'minego_tracing_priority_sample_total',
      'Priority sampled traces',
      ['rule']
    );

    // 存储成本估算
    this.storageBytesCounter = metrics.counter(
      'minego_tracing_storage_bytes_total',
      'Estimated tracing storage bytes'
    );

    // 采样节省率
    this.savingsRatioGauge = metrics.gauge(
      'minego_tracing_sampling_savings_ratio',
      'Sampling cost savings ratio'
    );

    // QPS 指标
    this.qpsGauge = metrics.gauge(
      'minego_tracing_current_qps',
      'Current requests per second'
    );

    // 错误率指标
    this.errorRateGauge = metrics.gauge(
      'minego_tracing_current_error_rate',
      'Current error rate'
    );
  }

  /**
   * 计算采样率
   * @param {object} metricsData - 当前指标数据
   * @returns {number} 采样率 (0-1)
   */
  calculateSamplingRate(metricsData) {
    if (!this.config.adaptiveEnabled) {
      return this.config.baseRate;
    }

    const { qps, errorRate, slowRequestRatio, avgLatency } = metricsData;
    
    // 1. 基于流量区间的采样率
    let rate = this.getBaseRateByQPS(qps);
    
    // 2. 错误率影响：错误率越高，采样率越高
    if (errorRate > 0.05) {
      // 错误率 > 5%，采样率翻倍
      rate = Math.min(rate * 2, this.config.maxRate);
    } else if (errorRate > 0.01) {
      // 错误率 > 1%，采样率提升 50%
      rate = Math.min(rate * 1.5, this.config.maxRate);
    }
    
    // 3. 慢请求比例影响
    if (slowRequestRatio > 0.1) {
      // 慢请求比例 > 10%，采样率提升
      rate = Math.min(rate * 1.3, this.config.maxRate);
    }
    
    // 4. 平均延迟影响
    if (avgLatency > 500) {
      // 平均延迟 > 500ms，提升采样率
      rate = Math.min(rate * 1.2, this.config.maxRate);
    }
    
    // 5. 确保在合法范围内
    rate = Math.max(this.config.minRate, Math.min(this.config.maxRate, rate));
    
    this.currentRate = rate;
    
    // 更新 Prometheus 指标
    this.samplingRateGauge.set(rate);
    if (qps) this.qpsGauge.set(qps);
    if (errorRate) this.errorRateGauge.set(errorRate);
    
    logger.debug({ 
      qps, 
      errorRate, 
      slowRequestRatio,
      avgLatency,
      calculatedRate: rate 
    }, 'Sampling rate calculated');
    
    return rate;
  }

  /**
   * 根据QPS获取基础采样率
   */
  getBaseRateByQPS(qps) {
    if (!qps || qps < 0) return this.config.baseRate;
    
    if (qps >= TrafficZones.PEAK.min) {
      return TrafficZones.PEAK.rate;
    } else if (qps >= TrafficZones.HIGH.min) {
      return TrafficZones.HIGH.rate;
    } else if (qps >= TrafficZones.NORMAL.min) {
      return TrafficZones.NORMAL.rate;
    } else {
      return TrafficZones.LOW.rate;
    }
  }

  /**
   * 决定是否采样
   * @param {object} span - 追踪 span
   * @param {object} metricsData - 当前指标数据
   * @returns {object} { sampled: boolean, reason: string, decision: string }
   */
  shouldSample(span, metricsData) {
    this.metrics.total++;
    
    const reasons = [];
    
    // 1. 检查优先采样条件
    const priorityResult = this.checkPrioritySampling(span);
    if (priorityResult.matched) {
      this.metrics.prioritySampled++;
      this.metrics.sampled++;
      this.recordPrioritySample(priorityResult.rule);
      this.recordDecision(SampleDecision.PRIORITY_SAMPLED, priorityResult.rule);
      
      return {
        sampled: true,
        reason: `priority:${priorityResult.rule}`,
        decision: SampleDecision.PRIORITY_SAMPLED
      };
    }
    
    // 2. 计算当前采样率
    const samplingRate = this.calculateSamplingRate(metricsData);
    
    // 3. 随机采样决策
    const sampled = Math.random() < samplingRate;
    
    if (sampled) {
      this.metrics.sampled++;
      this.recordDecision(SampleDecision.SAMPLED, 'random');
    } else {
      this.recordDecision(SampleDecision.NOT_SAMPLED, 'random');
    }
    
    // 更新节省率
    this.updateSavingsRatio();
    
    return {
      sampled,
      reason: sampled ? 'random' : 'excluded',
      decision: sampled ? SampleDecision.SAMPLED : SampleDecision.NOT_SAMPLED,
      samplingRate
    };
  }

  /**
   * 检查优先采样条件
   */
  checkPrioritySampling(span) {
    const priorityRules = this.config.priorityRules;
    
    for (const rule of priorityRules) {
      let matched = false;
      
      switch (rule) {
        case PriorityRules.ERROR:
          // 检查HTTP状态码或应用错误
          matched = (span.statusCode && span.statusCode >= 400) ||
                    (span.status && span.status === 'ERROR') ||
                    (span.attributes && span.attributes.has('error'));
          break;
          
        case PriorityRules.SLOW:
          // 检查慢请求
          matched = span.duration && span.duration > this.config.slowThresholdMs;
          break;
          
        case PriorityRules.PAYMENT:
          // 支付相关
          matched = span.name && (
            span.name.includes('payment') ||
            span.name.includes('Payment') ||
            span.name.includes('checkout') ||
            span.name.includes('purchase')
          );
          break;
          
        case PriorityRules.AUTH:
          // 认证相关
          matched = span.name && (
            span.name.includes('auth') ||
            span.name.includes('login') ||
            span.name.includes('token') ||
            span.name.includes('session')
          );
          break;
          
        case PriorityRules.VIP_USER:
          // VIP用户
          matched = span.attributes && 
                    span.attributes.get('user-type') === 'vip';
          break;
          
        case PriorityRules.CRITICAL_PATH:
          // 关键路径
          matched = span.attributes && 
                    span.attributes.get('critical') === 'true';
          break;
      }
      
      if (matched) {
        return { matched: true, rule };
      }
    }
    
    return { matched: false };
  }

  /**
   * 记录优先采样
   */
  recordPrioritySample(rule) {
    this.prioritySampleCounter.inc({ rule });
    
    if (!this.metrics.byReason[rule]) {
      this.metrics.byReason[rule] = 0;
    }
    this.metrics.byReason[rule]++;
  }

  /**
   * 记录采样决策
   */
  recordDecision(decision, reason) {
    this.samplingDecisionsCounter.inc({ decision, reason });
  }

  /**
   * 更新节省率
   */
  updateSavingsRatio() {
    if (this.metrics.total === 0) return;
    
    const sampled = this.metrics.sampled;
    const total = this.metrics.total;
    
    // 节省率 = (总数 - 采样数) / 总数
    const savingsRatio = (total - sampled) / total;
    
    this.savingsRatioGauge.set(savingsRatio);
  }

  /**
   * 估算存储字节数
   */
  estimateStorageBytes(span) {
    // 基于span属性估算大小
    const baseSize = 1024; // 基础大小 1KB
    const attributeSize = span.attributes ? span.attributes.size * 64 : 0;
    const eventSize = span.events ? span.events.length * 128 : 0;
    
    const totalBytes = baseSize + attributeSize + eventSize;
    
    this.storageBytesCounter.inc(totalBytes);
    
    return totalBytes;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      config: this.config,
      currentRate: this.currentRate,
      metrics: {
        ...this.metrics,
        sampleRatio: this.metrics.total > 0 
          ? this.metrics.sampled / this.metrics.total 
          : 0,
        priorityRatio: this.metrics.total > 0 
          ? this.metrics.prioritySampled / this.metrics.total 
          : 0,
        savingsRatio: this.metrics.total > 0 
          ? (this.metrics.total - this.metrics.sampled) / this.metrics.total 
          : 0
      }
    };
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig) {
    const oldConfig = { ...this.config };
    this.config = { ...this.config, ...newConfig };
    
    logger.info({ 
      oldConfig, 
      newConfig: this.config 
    }, 'Sampling config updated');
    
    return {
      success: true,
      oldConfig,
      newConfig: this.config
    };
  }

  /**
   * 重置统计
   */
  resetStats() {
    this.metrics = {
      total: 0,
      sampled: 0,
      prioritySampled: 0,
      byReason: {}
    };
    
    logger.info('Sampling stats reset');
  }
}

module.exports = {
  IntelligentSampler,
  SampleDecision,
  PriorityRules,
  TrafficZones,
  defaultConfig
};