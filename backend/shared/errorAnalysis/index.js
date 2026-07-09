/**
 * Error Analysis Module Index
 * 
 * @module backend/shared/errorAnalysis
 */

'use strict';

const StackFingerprintGenerator = require('./StackFingerprintGenerator');
const ErrorAggregator = require('./ErrorAggregator');
const RootCauseAnalyzer = require('./RootCauseAnalyzer');

module.exports = {
  StackFingerprintGenerator,
  ErrorAggregator,
  RootCauseAnalyzer,
  
  /**
   * 创建错误分析系统的完整实例
   * @param {Object} config - 配置
   * @param {Object} dependencies - 依赖项
   * @returns {Object} 系统实例
   */
  createSystem(config = {}, dependencies = {}) {
    const fingerprintGenerator = new StackFingerprintGenerator(config.fingerprint || {});
    const aggregator = new ErrorAggregator(config.aggregator || {}, {
      redisClient: dependencies.redisClient,
      dbClient: dependencies.dbClient,
      fingerprintGenerator
    });
    const rootCauseAnalyzer = new RootCauseAnalyzer(dependencies);
    
    return {
      fingerprintGenerator,
      aggregator,
      rootCauseAnalyzer,
      
      /**
       * 处理错误事件
       */
      async processError(errorEvent) {
        const result = await aggregator.aggregate(errorEvent);
        
        // 如果是新组，执行根因分析
        if (result.isNew) {
          const group = aggregator.getGroup(result.groupId);
          const analysis = await rootCauseAnalyzer.analyze(group);
          return { ...result, analysis };
        }
        
        return result;
      }
    };
  }
};