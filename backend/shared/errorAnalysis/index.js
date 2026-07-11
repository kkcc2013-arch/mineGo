/**
 * 错误智能分析系统入口
 * 
 * 导出所有分析模块，提供统一接口
 * 
 * @module errorAnalysis
 */

const StackFingerprintGenerator = require('./StackFingerprintGenerator');
const ErrorAggregator = require('./ErrorAggregator');
const RootCauseAnalyzer = require('./RootCauseAnalyzer');
const ErrorTrendAnalyzer = require('./ErrorTrendAnalyzer');
const ErrorContextSnapshot = require('./ErrorContextSnapshot');
const IntelligentAlerting = require('./IntelligentAlerting');

/**
 * 错误分析管理器
 * 
 * 整合所有分析模块，提供一站式错误分析服务
 */
class ErrorAnalysisManager {
  constructor(config = {}) {
    // 初始化各模块
    this.fingerprintGenerator = new StackFingerprintGenerator(config.fingerprint);
    this.aggregator = new ErrorAggregator(config.aggregator);
    this.rootCauseAnalyzer = new RootCauseAnalyzer(config.rootCause);
    this.trendAnalyzer = new ErrorTrendAnalyzer(config.trend);
    this.snapshotManager = new ErrorContextSnapshot(config.snapshot);
    this.alerting = new IntelligentAlerting(config.alerting);
    
    this.config = config;
  }

  /**
   * 处理错误事件（完整流程）
   * 
   * @param {Object} errorEvent - 错误事件
   * @param {Object} context - 上下文
   * @returns {Object} 处理结果
   */
  async processError(errorEvent, context = {}) {
    try {
      // 1. 聚合错误
      const aggregateResult = await this.aggregator.aggregate(errorEvent);
      
      // 2. 更新趋势统计
      await this.trendAnalyzer.updateStats(errorEvent);
      
      // 3. 保存上下文快照
      const snapshotId = await this.snapshotManager.save(
        { ...errorEvent, groupId: aggregateResult.groupId },
        context
      );
      
      // 4. 检测异常（新聚合组）
      let anomalyResult = null;
      if (aggregateResult.isNew || aggregateResult.occurrenceCount === 1) {
        anomalyResult = await this.trendAnalyzer.detectAnomaly(
          errorEvent.service,
          errorEvent.errorCode
        );
      }
      
      // 5. 根因分析（首次出现或异常）
      let rootCauseResult = null;
      if (aggregateResult.isNew || (anomalyResult && anomalyResult.isAnomaly)) {
        const group = await this.aggregator.getGroup(aggregateResult.groupId);
        rootCauseResult = await this.rootCauseAnalyzer.analyze(group);
      }
      
      // 6. 发送告警（如果需要）
      let alertResult = null;
      if (this._shouldAlert(aggregateResult, anomalyResult, rootCauseResult)) {
        const group = await this.aggregator.getGroup(aggregateResult.groupId);
        alertResult = await this.alerting.alert(group, rootCauseResult);
      }
      
      return {
        aggregate: aggregateResult,
        snapshot: { id: snapshotId },
        anomaly: anomalyResult,
        rootCause: rootCauseResult,
        alert: alertResult
      };
    } catch (error) {
      const logger = require('../logger');
      logger.error('Error processing failed', {
        error: error.message,
        event: errorEvent
      });
      
      throw error;
    }
  }

  /**
   * 判断是否需要发送告警
   */
  _shouldAlert(aggregateResult, anomalyResult, rootCauseResult) {
    // 新聚合组
    if (aggregateResult.isNew) {
      return true;
    }
    
    // 异常峰值
    if (anomalyResult && anomalyResult.isAnomaly && anomalyResult.severity !== 'low') {
      return true;
    }
    
    // 高置信度根因
    if (rootCauseResult && rootCauseResult.causes && rootCauseResult.causes.length > 0) {
      const topCause = rootCauseResult.causes[0];
      if (topCause.confidence >= 0.9 && topCause.type !== 'known_issue') {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 获取聚合组详情
   */
  async getGroup(groupId) {
    return await this.aggregator.getGroup(groupId);
  }

  /**
   * 获取活跃聚合组列表
   */
  async getActiveGroups(filters) {
    return await this.aggregator.getActiveGroups(filters);
  }

  /**
   * 获取聚合组的快照列表
   */
  async getGroupSnapshots(groupId, options) {
    return await this.snapshotManager.getGroupSnapshots(groupId, options);
  }

  /**
   * 获取快照详情
   */
  async getSnapshot(snapshotId) {
    return await this.snapshotManager.get(snapshotId);
  }

  /**
   * 解决聚合组
   */
  async resolveGroup(groupId, resolution) {
    return await this.aggregator.resolveGroup(groupId, resolution);
  }

  /**
   * 获取错误趋势
   */
  async getTrend(params) {
    return await this.trendAnalyzer.getTrend(params);
  }

  /**
   * 获取异常检测结果
   */
  async detectAnomaly(service, errorCode) {
    return await this.trendAnalyzer.detectAnomaly(service, errorCode);
  }

  /**
   * 获取趋势预测
   */
  async predictTrend(service, horizonMinutes) {
    return await this.trendAnalyzer.predictTrend(service, horizonMinutes);
  }

  /**
   * 获取告警统计
   */
  async getAlertStats(date) {
    return await this.alerting.getStats(date);
  }
}

// 导出模块
module.exports = {
  StackFingerprintGenerator,
  ErrorAggregator,
  RootCauseAnalyzer,
  ErrorTrendAnalyzer,
  ErrorContextSnapshot,
  IntelligentAlerting,
  ErrorAnalysisManager
};