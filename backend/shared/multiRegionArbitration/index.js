/**
 * REQ-00514: 多区域服务状态同步与智能仲裁系统
 * 模块导出索引
 * 
 * 创建时间: 2026-07-08 22:00 UTC
 */

'use strict';

const MultiRegionStateCollector = require('./MultiRegionStateCollector');
const ServiceDependencyAnalyzer = require('./ServiceDependencyAnalyzer');
const ArbitrationEngine = require('./ArbitrationEngine');
const DegradationFirstPolicy = require('./DegradationFirstPolicy');
const SplitBrainPrevention = require('./SplitBrainPrevention');
const ArbitrationDecisionLogger = require('./ArbitrationDecisionLogger');

/**
 * 创建完整的多区域仲裁系统实例
 */
async function createMultiRegionArbitrationSystem(config = {}) {
  const stateCollector = new MultiRegionStateCollector(config.stateCollector);
  const dependencyAnalyzer = new ServiceDependencyAnalyzer(config.dependencyAnalyzer);
  const arbitrationEngine = new ArbitrationEngine(config.arbitrationEngine);
  const degradationPolicy = new DegradationFirstPolicy(config.degradationPolicy);
  const splitBrainPrevention = new SplitBrainPrevention(config.splitBrainPrevention);
  const decisionLogger = new ArbitrationDecisionLogger(config.decisionLogger);
  
  // 初始化所有组件
  await stateCollector.initialize();
  await degradationPolicy.initialize();
  await splitBrainPrevention.initialize();
  await decisionLogger.initialize();
  
  // 初始化仲裁引擎（需要引用其他组件）
  await arbitrationEngine.initialize({
    stateCollector,
    dependencyAnalyzer,
    degradationPolicy,
    splitBrainPrevention,
    failoverController: config.failoverController
  });
  
  return {
    stateCollector,
    dependencyAnalyzer,
    arbitrationEngine,
    degradationPolicy,
    splitBrainPrevention,
    decisionLogger,
    
    /**
     * 停止所有组件
     */
    async stop() {
      await stateCollector.stop();
      await degradationPolicy.stop();
      await splitBrainPrevention.stop();
      await decisionLogger.stop();
    },
    
    /**
     * 获取系统状态
     */
    getStatus() {
      return {
        stateCollector: stateCollector.getStatus(),
        arbitration: arbitrationEngine.getArbitrationState(),
        lock: splitBrainPrevention.getLockStatus(),
        activeDegradations: degradationPolicy.getActiveDegradations(),
        loggerStats: decisionLogger.getStats()
      };
    },
    
    /**
     * 执行仲裁
     */
    async arbitrate() {
      const stateSnapshot = stateCollector.getStateSnapshot();
      const decision = await arbitrationEngine.arbitrate(stateSnapshot);
      
      if (decision && decision.id) {
        await decisionLogger.logDecision(decision);
      }
      
      return decision;
    }
  };
}

module.exports = {
  MultiRegionStateCollector,
  ServiceDependencyAnalyzer,
  ArbitrationEngine,
  DegradationFirstPolicy,
  SplitBrainPrevention,
  ArbitrationDecisionLogger,
  createMultiRegionArbitrationSystem
};