'use strict';

/**
 * 威胁检测引擎
 * 基于规则引擎 + 异常检测的混合威胁评分系统
 */

const crypto = require('crypto');
const FeatureExtractor = require('./FeatureExtractor');

class ThreatDetectionEngine {
  constructor(config = {}) {
    this.featureExtractor = new FeatureExtractor(config.featureExtractor);
    
    // 威胁等级阈值
    this.levelThresholds = {
      normal: 30,
      suspicious: 50,
      threat: 70,
      critical: 100
    };
    
    // 规则引擎配置
    this.rules = this.initDefaultRules();
    
    // 特征权重（用于加权评分）
    this.featureWeights = {
      requestRate: 0.15,
      uniquePaths: 0.08,
      pathEntropy: 0.12,
      httpMethodVariance: 0.05,
      errorRate: 0.15,
      requestIntervalStd: 0.10,
      sensitiveApiHits: 0.15,
      isBot: 0.10,
      isScanning: 0.10
    };
    
    // 统计
    this.stats = {
      totalProcessed: 0,
      threatsDetected: {
        suspicious: 0,
        threat: 0,
        critical: 0
      },
      avgInferenceTime: 0
    };
  }

  /**
   * 初始化默认规则
   */
  initDefaultRules() {
    return [
      // DDoS 检测规则
      {
        id: 'ddos_high_rate',
        name: '高频请求攻击',
        condition: (f) => f.requestRate > 50,
        score: 40,
        category: 'ddos',
        description: '请求速率超过 50 req/s'
      },
      {
        id: 'ddos_burst',
        name: '突发流量',
        condition: (f) => f.requestRate > 20 && f.requestIntervalStd < 50,
        score: 30,
        category: 'ddos',
        description: '高频率且间隔稳定的突发请求'
      },
      
      // 扫描探测规则
      {
        id: 'scan_path_enumeration',
        name: '路径枚举扫描',
        condition: (f) => f.pathEntropy > 0.85 && f.uniquePaths > 20,
        score: 35,
        category: 'scan',
        description: '高熵值路径访问，疑似路径枚举'
      },
      {
        id: 'scan_error_probing',
        name: '错误探测',
        condition: (f) => f.errorRate > 0.5 && f.uniquePaths > 10,
        score: 25,
        category: 'scan',
        description: '高错误率路径探测'
      },
      
      // 暴力破解规则
      {
        id: 'brute_force_auth',
        name: '认证暴力破解',
        condition: (f) => f.authAttempts > 5 && f.requestRate > 2,
        score: 45,
        category: 'brute_force',
        description: '高频认证尝试'
      },
      {
        id: 'brute_force_sensitive',
        name: '敏感API暴力访问',
        condition: (f) => f.sensitiveApiHits > 0.8 && f.requestRate > 3,
        score: 40,
        category: 'brute_force',
        description: '高频敏感API访问'
      },
      
      // 机器人检测
      {
        id: 'bot_ua',
        name: '机器人UA检测',
        condition: (f) => f.isBot === true,
        score: 20,
        category: 'bot',
        description: '识别为爬虫/机器人'
      },
      
      // 异常行为
      {
        id: 'anomaly_low_interval',
        name: '超低间隔请求',
        condition: (f) => f.requestIntervalMean < 10 && f.requestRate > 30,
        score: 35,
        category: 'anomaly',
        description: '请求间隔极低，疑似自动化工具'
      },
      {
        id: 'anomaly_regular_pattern',
        name: '规律性请求模式',
        condition: (f) => f.requestIntervalStd < 20 && f.requestRate > 10,
        score: 25,
        category: 'anomaly',
        description: '请求间隔高度规律，疑似脚本'
      }
    ];
  }

  /**
   * 检测威胁
   * @param {Object} redis - Redis client
   * @param {Object} req - Express request
   * @param {Object} context - 请求上下文
   * @returns {Promise<Object>} 威胁检测结果
   */
  async detect(redis, req, context = {}) {
    const startTime = Date.now();
    
    try {
      // 1. 提取请求特征
      const requestFeatures = this.featureExtractor.extractRequestFeatures(req, context);
      
      // 2. 获取客户端标识
      const clientKey = requestFeatures.ip;
      
      // 3. 更新时间窗口统计
      const windowStats = await this.featureExtractor.updateWindowStats(
        redis, 
        clientKey, 
        { 
          ...requestFeatures,
          statusCode: context.statusCode || 200,
          responseTime: context.responseTime || 0
        }
      );
      
      // 4. 合并特征
      const fullFeatures = this.featureExtractor.mergeFeatures(
        requestFeatures, 
        windowStats, 
        context
      );
      
      // 5. 规则引擎检测
      const ruleResults = this.applyRules(fullFeatures);
      
      // 6. 计算威胁分数
      const threatScore = this.calculateThreatScore(fullFeatures, ruleResults);
      
      // 7. 确定威胁等级
      const threatLevel = this.determineLevel(threatScore);
      
      // 8. 生成威胁ID
      const threatId = threatLevel !== 'normal' 
        ? this.generateThreatId(requestFeatures.ip, fullFeatures.timestamp)
        : null;
      
      // 更新统计
      this.stats.totalProcessed++;
      if (threatLevel !== 'normal') {
        this.stats.threatsDetected[threatLevel]++;
      }
      
      const inferenceTime = Date.now() - startTime;
      this.stats.avgInferenceTime = 
        (this.stats.avgInferenceTime * 0.9) + (inferenceTime * 0.1);
      
      return {
        threatId,
        threatScore,
        threatLevel,
        features: fullFeatures,
        matchedRules: ruleResults.map(r => ({
          id: r.rule.id,
          name: r.rule.name,
          score: r.rule.score,
          category: r.rule.category
        })),
        inferenceTime,
        timestamp: fullFeatures.timestamp
      };
      
    } catch (error) {
      console.error('[ThreatDetectionEngine] Detection error:', error);
      return {
        threatId: null,
        threatScore: 0,
        threatLevel: 'normal',
        features: null,
        matchedRules: [],
        inferenceTime: Date.now() - startTime,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  /**
   * 应用规则
   * @param {Object} features - 特征对象
   * @returns {Array} 匹配的规则列表
   */
  applyRules(features) {
    const matched = [];
    
    for (const rule of this.rules) {
      try {
        if (rule.condition(features)) {
          matched.push({
            rule,
            features: { ...features }
          });
        }
      } catch (err) {
        console.warn(`[ThreatDetectionEngine] Rule ${rule.id} error:`, err.message);
      }
    }
    
    return matched;
  }

  /**
   * 计算威胁分数
   * @param {Object} features - 特征对象
   * @param {Array} ruleResults - 规则匹配结果
   * @returns {number} 威胁分数 (0-100)
   */
  calculateThreatScore(features, ruleResults) {
    // 基础分数：规则匹配分数
    let baseScore = 0;
    
    for (const result of ruleResults) {
      baseScore += result.rule.score;
    }
    
    // 加权特征分数
    let featureScore = 0;
    
    // 请求速率贡献
    featureScore += Math.min(features.requestRate / 50, 1) * 20;
    
    // 错误率贡献
    featureScore += features.errorRate * 15;
    
    // 敏感API命中贡献
    featureScore += features.sensitiveApiHits * 15;
    
    // 路径熵贡献
    featureScore += features.pathEntropy * 10;
    
    // 机器人/扫描标记
    if (features.isBot) featureScore += 10;
    if (features.isScanning) featureScore += 10;
    
    // 合并分数（规则分数 + 特征分数）
    const totalScore = baseScore + featureScore;
    
    // 归一化到 0-100
    return Math.min(Math.round(totalScore), 100);
  }

  /**
   * 确定威胁等级
   * @param {number} score - 威胁分数
   * @returns {string} 威胁等级
   */
  determineLevel(score) {
    if (score >= this.levelThresholds.critical) return 'critical';
    if (score >= this.levelThresholds.threat) return 'threat';
    if (score >= this.levelThresholds.suspicious) return 'suspicious';
    return 'normal';
  }

  /**
   * 生成威胁ID
   * @param {string} ip - IP地址
   * @param {number} timestamp - 时间戳
   * @returns {string} 唯一威胁ID
   */
  generateThreatId(ip, timestamp) {
    const hash = crypto
      .createHash('sha256')
      .update(`${ip}:${timestamp}:${Math.random()}`)
      .digest('hex')
      .substring(0, 16);
    
    return `threat-${Date.now()}-${hash}`;
  }

  /**
   * 添加自定义规则
   * @param {Object} rule - 规则对象
   */
  addRule(rule) {
    const normalizedRule = {
      id: rule.id || `custom-${Date.now()}`,
      name: rule.name || 'Custom Rule',
      condition: rule.condition,
      score: rule.score || 10,
      category: rule.category || 'custom',
      description: rule.description || ''
    };
    
    this.rules.push(normalizedRule);
    console.log(`[ThreatDetectionEngine] Added rule: ${normalizedRule.id}`);
  }

  /**
   * 移除规则
   * @param {string} ruleId - 规则ID
   */
  removeRule(ruleId) {
    const index = this.rules.findIndex(r => r.id === ruleId);
    if (index !== -1) {
      this.rules.splice(index, 1);
      console.log(`[ThreatDetectionEngine] Removed rule: ${ruleId}`);
    }
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      ...this.stats,
      rulesCount: this.rules.length,
      avgInferenceTime: Math.round(this.stats.avgInferenceTime * 100) / 100
    };
  }

  /**
   * 批量检测（用于批量处理）
   * @param {Object} redis - Redis client
   * @param {Array} requests - 请求数组
   * @returns {Promise<Array>} 检测结果数组
   */
  async batchDetect(redis, requests) {
    const results = [];
    
    for (const { req, context } of requests) {
      const result = await this.detect(redis, req, context);
      results.push(result);
    }
    
    return results;
  }
}

module.exports = ThreatDetectionEngine;