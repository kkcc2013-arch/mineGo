/**
 * 成本-性能权衡机制
 * 在非核心业务高峰期优先选择低成本实例
 */

const logger = require('../../shared/logger');

class CostPerformanceBalancer {
  constructor(config = {}) {
    this.config = {
      // 实例类型配置
      instanceTypes: {
        onDemand: {
          costMultiplier: 1.0,
          reliability: 0.9999,
          availability: 'always'
        },
        spot: {
          costMultiplier: 0.3,  // Spot实例便宜70%
          reliability: 0.95,
          availability: 'conditional',
          interruptionRate: 0.05  // 5%中断概率
        },
        reserved: {
          costMultiplier: 0.6,  // 预留实例便宜40%
          reliability: 0.9999,
          availability: 'limited'
        }
      },
      
      // 服务等级配置
      serviceTiers: {
        critical: {
          minReliability: 0.9999,
          allowedInstanceTypes: ['onDemand', 'reserved'],
          maxSpotRatio: 0
        },
        important: {
          minReliability: 0.99,
          allowedInstanceTypes: ['onDemand', 'reserved', 'spot'],
          maxSpotRatio: 0.3
        },
        normal: {
          minReliability: 0.95,
          allowedInstanceTypes: ['onDemand', 'spot'],
          maxSpotRatio: 0.7
        }
      },

      // 服务分类
      serviceClassification: {
        'gateway': 'critical',
        'user-service': 'critical',
        'pokemon-service': 'important',
        'location-service': 'important',
        'catch-service': 'important',
        'gym-service': 'important',
        'social-service': 'normal',
        'reward-service': 'normal',
        'payment-service': 'critical'
      },

      ...config
    };

    this.costMetrics = new Map();
    this.performanceMetrics = new Map();
  }

  /**
   * 分析成本-性能权衡
   */
  async analyzeTradeoff(serviceName, predictedLoad) {
    const serviceTier = this.config.serviceClassification[serviceName] || 'normal';
    const tierConfig = this.config.serviceTiers[serviceTier];

    const analysis = {
      service: serviceName,
      tier: serviceTier,
      predictedLoad,
      recommendations: [],
      estimatedCost: 0,
      estimatedPerformance: 0,
      riskLevel: 'low'
    };

    // 计算实例组合方案
    const instanceMix = this.calculateOptimalInstanceMix(predictedLoad, tierConfig);

    // 成本估算
    analysis.estimatedCost = this.estimateCost(instanceMix);

    // 性能估算
    analysis.estimatedPerformance = this.estimatePerformance(instanceMix, predictedLoad);

    // 风险评估
    analysis.riskLevel = this.assessRisk(instanceMix, tierConfig);

    // 生成推荐方案
    analysis.recommendations = this.generateRecommendations(instanceMix, analysis);

    logger.info('Cost-performance tradeoff analyzed', {
      service: serviceName,
      tier: serviceTier,
      cost: analysis.estimatedCost,
      performance: analysis.estimatedPerformance,
      risk: analysis.riskLevel
    });

    return analysis;
  }

  /**
   * 计算最优实例组合
   */
  calculateOptimalInstanceMix(predictedLoad, tierConfig) {
    const mix = {
      onDemand: 0,
      spot: 0,
      reserved: 0,
      totalInstances: 0
    };

    // 计算所需总实例数
    const baseInstances = Math.ceil(predictedLoad / 1000);  // 假设每个实例处理1000 req/s
    mix.totalInstances = baseInstances;

    // 根据服务等级分配实例类型
    if (tierConfig.allowedInstanceTypes.includes('reserved')) {
      // 优先使用预留实例
      mix.reserved = Math.floor(baseInstances * 0.4);  // 40%预留
    }

    if (tierConfig.allowedInstanceTypes.includes('spot')) {
      // 在允许范围内使用Spot实例
      const maxSpot = Math.floor(baseInstances * tierConfig.maxSpotRatio);
      
      // 根据时间段调整Spot比例
      const hour = new Date().getHours();
      const isBusinessHours = hour >= 9 && hour <= 18;
      
      if (!isBusinessHours) {
        // 非业务高峰期，增加Spot比例
        mix.spot = Math.min(maxSpot, Math.floor(baseInstances * (tierConfig.maxSpotRatio * 1.2)));
      } else {
        // 业务高峰期，保守使用Spot
        mix.spot = Math.floor(maxSpot * 0.5);
      }
    }

    // 其余使用按需实例
    mix.onDemand = mix.totalInstances - mix.spot - mix.reserved;

    return mix;
  }

  /**
   * 估算成本
   */
  estimateCost(instanceMix) {
    const baseCostPerInstance = 100;  // 假设每实例每小时100元

    const cost = 
      instanceMix.onDemand * baseCostPerInstance * this.config.instanceTypes.onDemand.costMultiplier +
      instanceMix.spot * baseCostPerInstance * this.config.instanceTypes.spot.costMultiplier +
      instanceMix.reserved * baseCostPerInstance * this.config.instanceTypes.reserved.costMultiplier;

    return cost;
  }

  /**
   * 估算性能
   */
  estimatePerformance(instanceMix, predictedLoad) {
    // 计算有效容量
    let effectiveCapacity = 
      instanceMix.onDemand * 1000 * this.config.instanceTypes.onDemand.reliability +
      instanceMix.spot * 1000 * this.config.instanceTypes.spot.reliability +
      instanceMix.reserved * 1000 * this.config.instanceTypes.reserved.reliability;

    // 计算性能裕度
    const headroom = (effectiveCapacity - predictedLoad) / effectiveCapacity;

    return {
      effectiveCapacity: Math.round(effectiveCapacity),
      headroom: Math.round(headroom * 100),
      canHandleLoad: effectiveCapacity >= predictedLoad * 1.2  // 20%安全裕度
    };
  }

  /**
   * 风险评估
   */
  assessRisk(instanceMix, tierConfig) {
    const spotRatio = instanceMix.spot / instanceMix.totalInstances;
    const maxAllowedRatio = tierConfig.maxSpotRatio;

    if (spotRatio > maxAllowedRatio) {
      return 'high';
    } else if (spotRatio > maxAllowedRatio * 0.8) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * 生成推荐方案
   */
  generateRecommendations(instanceMix, analysis) {
    const recommendations = [];

    // 成本优化建议
    if (analysis.riskLevel === 'low' && instanceMix.spot < instanceMix.totalInstances * 0.3) {
      recommendations.push({
        type: 'cost_optimization',
        message: '当前负载较低，可增加Spot实例比例以降低成本',
        potentialSavings: instanceMix.totalInstances * 0.2 * 70  // 额外20%Spot可节省的成本
      });
    }

    // 性能保障建议
    if (!analysis.estimatedPerformance.canHandleLoad) {
      recommendations.push({
        type: 'performance_urgency',
        message: '当前容量不足以应对预测负载，建议立即扩容',
        additionalInstancesNeeded: Math.ceil((analysis.predictedLoad * 1.2 - analysis.estimatedPerformance.effectiveCapacity) / 1000)
      });
    }

    // 风险缓解建议
    if (analysis.riskLevel === 'high') {
      recommendations.push({
        type: 'risk_mitigation',
        message: 'Spot实例比例过高，建议增加按需实例以保障稳定性',
        action: 'reduce_spot_ratio'
      });
    }

    return recommendations;
  }

  /**
   * 动态调整实例类型分配
   */
  async adjustInstanceAllocation(serviceName, currentAllocation, predictedLoad) {
    const analysis = await this.analyzeTradeoff(serviceName, predictedLoad);
    const serviceTier = this.config.serviceClassification[serviceName];
    const tierConfig = this.config.serviceTiers[serviceTier];

    const newAllocation = this.calculateOptimalInstanceMix(predictedLoad, tierConfig);

    const changes = {
      serviceName,
      current: currentAllocation,
      proposed: newAllocation,
      reason: 'cost_optimization',
      expectedSavings: 0
    };

    // 计算预期节省
    const currentCost = this.estimateCost(currentAllocation);
    const newCost = this.estimateCost(newAllocation);
    changes.expectedSavings = Math.max(0, currentCost - newCost);

    logger.info('Instance allocation adjusted', {
      service: serviceName,
      currentCost,
      newCost,
      savings: changes.expectedSavings
    });

    return changes;
  }

  /**
   * 获取成本报告
   */
  async getCostReport() {
    const services = Object.keys(this.config.serviceClassification);
    const report = {
      timestamp: new Date(),
      totalCost: 0,
      breakdown: [],
      recommendations: []
    };

    for (const serviceName of services) {
      const metrics = this.costMetrics.get(serviceName) || { currentCost: 0, predictedLoad: 1000 };
      const analysis = await this.analyzeTradeoff(serviceName, metrics.predictedLoad);

      report.breakdown.push({
        service: serviceName,
        tier: analysis.tier,
        currentCost: metrics.currentCost,
        estimatedCost: analysis.estimatedCost,
        riskLevel: analysis.riskLevel
      });

      report.totalCost += metrics.currentCost;
      report.recommendations.push(...analysis.recommendations);
    }

    return report;
  }

  /**
   * 更新成本指标
   */
  updateCostMetrics(serviceName, metrics) {
    this.costMetrics.set(serviceName, {
      timestamp: new Date(),
      ...metrics
    });
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    return {
      status: 'healthy',
      servicesConfigured: Object.keys(this.config.serviceClassification).length,
      metricsTracked: this.costMetrics.size
    };
  }
}

module.exports = CostPerformanceBalancer;
