/**
 * REQ-00506: 容器资源智能利用率分析系统
 * 资源采样定时任务
 * 
 * 功能：
 * - 每日定时采样所有微服务资源消耗
 * - 自动分析并生成报告
 * - 应用自动调整策略
 * 
 * @module backend/jobs/resourceSamplingJob
 */

'use strict';

const { createLogger } = require('../shared/logger');
const ResourceSampler = require('../shared/resourceAnalysis/ResourceSampler');
const ResourceAnalysisEngine = require('../shared/resourceAnalysis/ResourceAnalysisEngine');
const AutoAdjustmentPlugin = require('../shared/resourceAnalysis/AutoAdjustmentPlugin');

const logger = createLogger('resource-sampling-job');

/**
 * 服务列表
 */
const SERVICES = [
  'api-gateway',
  'user-service',
  'location-service',
  'pokemon-service',
  'catch-service',
  'gym-service',
  'social-service',
  'reward-service',
  'payment-service'
];

/**
 * 资源采样定时任务类
 */
class ResourceSamplingJob {
  constructor() {
    this.sampler = new ResourceSampler();
    this.analyzer = new ResourceAnalysisEngine();
    this.adjuster = new AutoAdjustmentPlugin({
      strategy: process.env.RESOURCE_ADJUSTMENT_STRATEGY || 'conservative',
      dryRun: process.env.RESOURCE_ADJUSTMENT_DRY_RUN === 'true'
    });
  }

  /**
   * 执行完整流程
   * @returns {Promise<Object>} 执行结果
   */
  async run() {
    const startTime = Date.now();
    logger.info('Starting resource sampling job');

    try {
      // Step 1: 采样所有服务资源
      logger.info('Step 1: Sampling resources from all services');
      const samplingResult = await this.sampler.sampleAllResources('pmg');

      if (!samplingResult.success || samplingResult.sampleCount === 0) {
        logger.warn('No samples collected, skipping analysis');
        return {
          success: false,
          reason: 'No samples collected',
          timestamp: new Date().toISOString()
        };
      }

      // Step 2: 计算利用率统计
      logger.info({ count: SERVICES.length }, 'Step 2: Calculating utilization stats');
      const statsPromises = SERVICES.map(service => 
        this.sampler.calculateUtilizationStats(service, 24)
      );
      const allStats = await Promise.all(statsPromises);

      // 合并所有服务的容器统计
      const allContainers = [];
      allStats.forEach(stats => {
        if (stats.containers) {
          allContainers.push(...stats.containers);
        }
      });

      logger.info({ containerCount: allContainers.length }, 'Containers collected for analysis');

      // Step 3: 分析资源利用率
      logger.info('Step 3: Analyzing resource utilization');
      const analysisResults = await this.analyzer.analyzeAllContainers(allContainers);

      // Step 4: 生成报告
      logger.info('Step 4: Generating analysis report');
      const report = await this.analyzer.generateReport(analysisResults);

      // Step 5: 自动调整（可选）
      let adjustmentResult = null;
      if (process.env.AUTO_RESOURCE_ADJUSTMENT === 'true') {
        logger.info('Step 5: Applying auto adjustments');
        adjustmentResult = await this.adjuster.executeAutoAdjustment(report);
      } else {
        logger.info('Step 5: Auto adjustment disabled');
        adjustmentResult = {
          success: true,
          message: 'Auto adjustment disabled',
          dryRun: true
        };
      }

      const duration = Date.now() - startTime;
      logger.info({ 
        duration, 
        sampleCount: samplingResult.sampleCount,
        containerCount: allContainers.length,
        adjustments: adjustmentResult.totalAdjustments || 0
      }, 'Resource sampling job completed');

      return {
        success: true,
        sampling: samplingResult,
        analysis: {
          containerCount: allContainers.length,
          summary: analysisResults.summary
        },
        report: {
          summary: report.summary,
          recommendations: {
            immediate: report.recommendations.immediate.length,
            scheduled: report.recommendations.scheduled.length,
            lowPriority: report.recommendations.lowPriority.length
          }
        },
        adjustment: adjustmentResult,
        duration,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error({ err: error, duration }, 'Resource sampling job failed');

      return {
        success: false,
        error: error.message,
        duration,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 仅采样（不分析）
   * @returns {Promise<Object>} 采样结果
   */
  async sampleOnly() {
    logger.info('Running resource sampling (no analysis)');

    try {
      const result = await this.sampler.sampleAllResources('pmg');
      return {
        success: true,
        sampling: result,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ err: error }, 'Sampling failed');
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 仅分析（基于历史数据）
   * @param {number} hours - 分析最近 N 小时的数据
   * @returns {Promise<Object>} 分析结果
   */
  async analyzeOnly(hours = 24) {
    logger.info({ hours }, 'Running analysis (no new sampling)');

    try {
      // 获取历史采样数据
      const statsPromises = SERVICES.map(service =>
        this.sampler.calculateUtilizationStats(service, hours)
      );
      const allStats = await Promise.all(statsPromises);

      const allContainers = [];
      allStats.forEach(stats => {
        if (stats.containers) {
          allContainers.push(...stats.containers);
        }
      });

      if (allContainers.length === 0) {
        return {
          success: false,
          reason: 'No historical data found',
          timestamp: new Date().toISOString()
        };
      }

      const analysisResults = await this.analyzer.analyzeAllContainers(allContainers);
      const report = await this.analyzer.generateReport(analysisResults);

      return {
        success: true,
        containerCount: allContainers.length,
        analysis: analysisResults,
        report,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ err: error }, 'Analysis failed');
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 执行调整（手动触发）
   * @param {Object} options - 调整选项
   * @returns {Promise<Object>} 调整结果
   */
  async executeAdjustments(options = {}) {
    const { strategy, dryRun } = options;

    logger.info({ strategy, dryRun }, 'Manual adjustment execution triggered');

    try {
      // 先获取最新分析报告
      const analysisResult = await this.analyzeOnly(24);

      if (!analysisResult.success) {
        return analysisResult;
      }

      // 执行调整
      const adjuster = new AutoAdjustmentPlugin({
        strategy: strategy || 'conservative',
        dryRun: dryRun !== false
      });

      const result = await adjuster.executeAutoAdjustment(analysisResult.report);

      return {
        success: true,
        analysis: analysisResult.report.summary,
        adjustment: result,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ err: error }, 'Manual adjustment failed');
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 健康检查
   * @returns {Promise<Object>} 健康状态
   */
  async healthCheck() {
    const prometheusHealthy = await this.sampler.healthCheck();

    return {
      healthy: prometheusHealthy,
      components: {
        sampler: prometheusHealthy,
        analyzer: true, // 纯计算模块，总是健康
        adjuster: true  // 配置模块，总是健康
      },
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * 主执行函数（用于定时任务）
 */
async function main() {
  const job = new ResourceSamplingJob();
  const result = await job.run();

  if (result.success) {
    console.log('✅ Resource sampling job completed successfully');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error('❌ Resource sampling job failed:', result.error);
    process.exit(1);
  }
}

// 如果直接运行，执行主函数
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = ResourceSamplingJob;