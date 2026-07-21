/**
 * 智能调度器主程序
 * 整合流量分析、预测调度、成本优化
 */

const logger = require('../../shared/logger');
const TrafficAnalyzer = require('./trafficAnalyzer');
const PredictiveScheduler = require('./predictiveScheduler');
const CostPerformanceBalancer = require('./costPerformanceBalancer');

class IntelligentScheduler {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      schedulingInterval: config.schedulingInterval || 60 * 1000,  // 每分钟调度一次
      predictionAccuracyThreshold: config.predictionAccuracyThreshold || 0.85,
      autoScalingEnabled: config.autoScalingEnabled !== false,
      costOptimizationEnabled: config.costOptimizationEnabled !== false,
      ...config
    };

    this.trafficAnalyzer = new TrafficAnalyzer(config);
    this.predictiveScheduler = new PredictiveScheduler(config);
    this.costBalancer = new CostPerformanceBalancer(config);

    this.isRunning = false;
    this.schedulingTimer = null;
    this.stats = {
      totalSchedulingCycles: 0,
      successfulScalings: 0,
      failedScalings: 0,
      lastRunTime: null
    };
  }

  /**
   * 启动智能调度器
   */
  async start() {
    if (!this.config.enabled) {
      logger.info('IntelligentScheduler is disabled');
      return false;
    }

    try {
      // 初始化所有组件
      await this.initialize();

      // 启动调度循环
      this.isRunning = true;
      this.schedulingTimer = setInterval(async () => {
        await this.runSchedulingCycle();
      }, this.config.schedulingInterval);

      logger.info('IntelligentScheduler started', {
        interval: this.config.schedulingInterval,
        autoScalingEnabled: this.config.autoScalingEnabled,
        costOptimizationEnabled: this.config.costOptimizationEnabled
      });

      return true;
    } catch (error) {
      logger.error('Failed to start IntelligentScheduler', { error: error.message });
      throw error;
    }
  }

  /**
   * 初始化所有组件
   */
  async initialize() {
    logger.info('Initializing IntelligentScheduler components...');

    await this.trafficAnalyzer.initialize();
    await this.predictiveScheduler.initialize();

    logger.info('All components initialized successfully');
  }

  /**
   * 执行一次完整的调度周期
   */
  async runSchedulingCycle() {
    const startTime = Date.now();
    this.stats.totalSchedulingCycles++;

    try {
      logger.info('Starting scheduling cycle', {
        cycle: this.stats.totalSchedulingCycles
      });

      // 1. 流量分析和预测
      const prediction = await this.trafficAnalyzer.predictTrafficTrend();
      
      if (!prediction) {
        logger.warn('No prediction available, skipping scheduling cycle');
        return null;
      }

      // 2. 检查预测准确率
      const accuracy = await this.trafficAnalyzer.getPredictionAccuracy();
      
      if (accuracy < this.config.predictionAccuracyThreshold) {
        logger.warn('Prediction accuracy below threshold, using reactive scaling', {
          accuracy,
          threshold: this.config.predictionAccuracyThreshold
        });
      }

      // 3. 执行预测调度
      const scalingDecision = await this.predictiveScheduler.executeScheduling();

      // 4. 成本优化分析
      if (this.config.costOptimizationEnabled && scalingDecision.action !== 'none') {
        await this.analyzeCostOptimization(scalingDecision);
      }

      // 5. 更新统计信息
      const duration = Date.now() - startTime;
      this.stats.lastRunTime = new Date();
      
      if (scalingDecision.action !== 'none') {
        this.stats.successfulScalings++;
      }

      logger.info('Scheduling cycle completed', {
        duration: `${duration}ms`,
        action: scalingDecision.action,
        accuracy
      });

      return {
        prediction: prediction.summary,
        scalingDecision,
        accuracy,
        duration
      };
    } catch (error) {
      this.stats.failedScalings++;
      logger.error('Scheduling cycle failed', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * 成本优化分析
   */
  async analyzeCostOptimization(scalingDecision) {
    const services = ['gateway', 'user-service', 'pokemon-service', 'location-service', 'catch-service', 'gym-service'];

    for (const serviceName of services) {
      const analysis = await this.costBalancer.analyzeTradeoff(
        serviceName,
        scalingDecision.targetReplicas * 1000  // 预估负载
      );

      // 如果有成本优化建议，记录日志
      if (analysis.recommendations.length > 0) {
        logger.info('Cost optimization opportunities found', {
          service: serviceName,
          recommendations: analysis.recommendations.length,
          estimatedCost: analysis.estimatedCost,
          riskLevel: analysis.riskLevel
        });
      }
    }
  }

  /**
   * 手动触发调度（用于测试或紧急情况）
   */
  async manualSchedule(reason = 'manual_trigger') {
    logger.info('Manual scheduling triggered', { reason });
    return await this.runSchedulingCycle();
  }

  /**
   * 获取当前状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.config,
      stats: this.stats,
      lastScalingAction: this.predictiveScheduler.lastScalingAction,
      predictions: this.predictiveScheduler.predictions.length
    };
  }

  /**
   * 获取详细报告
   */
  async getDetailedReport() {
    const prediction = await this.trafficAnalyzer.predictTrafficTrend();
    const costReport = await this.costBalancer.getCostReport();

    return {
      timestamp: new Date(),
      traffic: {
        current: await this.trafficAnalyzer.collectCurrentTraffic(),
        prediction: prediction?.summary || null
      },
      scaling: {
        lastAction: this.predictiveScheduler.lastScalingAction,
        currentReplicas: this.predictiveScheduler.getCurrentReplicaCount()
      },
      cost: costReport,
      stats: this.stats
    };
  }

  /**
   * 健康检查
   */
  async healthCheck() {
    const checks = {
      scheduler: {
        status: this.isRunning ? 'healthy' : 'stopped',
        stats: this.stats
      },
      trafficAnalyzer: await this.trafficAnalyzer.healthCheck(),
      predictiveScheduler: await this.predictiveScheduler.healthCheck(),
      costBalancer: await this.costBalancer.healthCheck()
    };

    const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      checks
    };
  }

  /**
   * 停止智能调度器
   */
  async stop() {
    if (this.schedulingTimer) {
      clearInterval(this.schedulingTimer);
      this.schedulingTimer = null;
    }

    this.isRunning = false;

    await this.trafficAnalyzer.shutdown();
    await this.predictiveScheduler.shutdown();

    logger.info('IntelligentScheduler stopped', {
      totalCycles: this.stats.totalSchedulingCycles,
      successfulScalings: this.stats.successfulScalings,
      failedScalings: this.stats.failedScalings
    });
  }
}

module.exports = IntelligentScheduler;
