// backend/shared/indexOptimizer/IndexOptimizerManager.js
'use strict';

const { SlowQueryCollector } = require('./SlowQueryCollector');
const { IndexRecommender } = require('./IndexRecommender');
const { IndexHealthChecker } = require('./IndexHealthChecker');
const { IndexOptimizationExecutor } = require('./IndexOptimizationExecutor');
const { createLogger } = require('../logger');
const { register, gauge, counter } = require('../metrics');

const logger = createLogger('index-optimizer-manager');

// Prometheus 指标
const slowQueryCountGauge = gauge({
  name: 'minego_index_optimizer_slow_queries',
  help: 'Number of slow queries detected',
  labelNames: ['severity']
});

const recommendationCounter = counter({
  name: 'minego_index_optimizer_recommendations',
  help: 'Number of index recommendations generated',
  labelNames: ['type', 'priority']
});

const executionCounter = counter({
  name: 'minego_index_optimizer_executions',
  help: 'Number of index optimization executions',
  labelNames: ['status', 'type']
});

const healthIssuesGauge = gauge({
  name: 'minego_index_optimizer_health_issues',
  help: 'Number of index health issues detected',
  labelNames: ['category']
});

/**
 * 索引优化管理器
 * 整合慢查询收集、建议生成、健康检查和执行功能
 */
class IndexOptimizerManager {
  constructor(config = {}) {
    this.config = {
      slowQueryThreshold: config.slowQueryThreshold || 500,
      collectionInterval: config.collectionInterval || 60000,
      maxRecommendations: config.maxRecommendations || 50,
      dryRun: config.dryRun !== false,
      executionWindow: config.executionWindow || { start: 2, end: 6 },
      notificationWebhook: config.notificationWebhook
    };
    
    this.pool = config.pool;
    
    // 初始化各模块
    this.slowQueryCollector = new SlowQueryCollector({
      pool: this.pool,
      slowQueryThreshold: this.config.slowQueryThreshold,
      collectionInterval: this.config.collectionInterval
    });
    
    this.indexRecommender = new IndexRecommender();
    this.healthChecker = new IndexHealthChecker(this.pool);
    this.executor = new IndexOptimizationExecutor(this.pool, {
      dryRun: this.config.dryRun,
      executionWindow: this.config.executionWindow,
      notificationWebhook: this.config.notificationWebhook
    });
    
    this.recommendations = [];
    this.lastHealthReport = null;
    this.initialized = false;
  }

  /**
   * 初始化管理器
   */
  async initialize() {
    try {
      await this.slowQueryCollector.initialize();
      
      // 监听慢查询事件
      this.slowQueryCollector.on('slowQuery', async (slowQuery) => {
        try {
          await this.processSlowQuery(slowQuery);
        } catch (error) {
          logger.error({ error: error.message }, '处理慢查询失败');
        }
      });
      
      this.slowQueryCollector.on('error', (error) => {
        logger.error({ error: error.message }, '慢查询收集器错误');
      });
      
      this.initialized = true;
      
      logger.info({
        slowQueryThreshold: this.config.slowQueryThreshold,
        dryRun: this.config.dryRun
      }, '索引优化管理器已初始化');
      
      return true;
      
    } catch (error) {
      logger.error({ error: error.message }, '初始化失败');
      throw error;
    }
  }

  /**
   * 处理慢查询
   */
  async processSlowQuery(slowQuery) {
    // 更新指标
    slowQueryCountGauge.set({ severity: slowQuery.severity }, 
      this.slowQueryCollector.queryBuffer.filter(q => q.severity === slowQuery.severity).length);
    
    // 获取表名
    const pattern = this.indexRecommender.patternAnalyzer.analyze(slowQuery.query);
    if (!pattern || !pattern.table) {
      return;
    }
    
    // 获取表统计信息
    const tableStats = await this.slowQueryCollector.getTableStats(pattern.table);
    if (!tableStats || tableStats.length === 0) {
      return;
    }
    
    // 获取现有索引
    const existingIndexes = await this.slowQueryCollector.getExistingIndexes(pattern.table);
    
    // 生成建议
    const recommendations = await this.indexRecommender.analyzeAndRecommend(
      slowQuery,
      tableStats,
      existingIndexes
    );
    
    // 添加到建议列表
    for (const rec of recommendations) {
      this.recommendations.push(rec);
      
      // 更新指标
      recommendationCounter.inc({
        type: rec.type,
        priority: rec.priority >= 80 ? 'high' : rec.priority >= 50 ? 'medium' : 'low'
      });
    }
    
    // 限制建议数量
    if (this.recommendations.length > this.config.maxRecommendations) {
      // 按优先级排序，保留高优先级建议
      this.recommendations = this.recommendations
        .sort((a, b) => b.priority - a.priority)
        .slice(0, this.config.maxRecommendations);
    }
    
    logger.info({
      table: pattern.table,
      newRecommendations: recommendations.length,
      totalRecommendations: this.recommendations.length
    }, '慢查询分析完成');
  }

  /**
   * 执行健康检查
   */
  async runHealthCheck() {
    try {
      const report = await this.healthChecker.checkIndexHealth();
      this.lastHealthReport = report;
      
      // 更新指标
      healthIssuesGauge.set({ category: 'unused' }, report.unusedIndexes.length);
      healthIssuesGauge.set({ category: 'duplicate' }, report.duplicateIndexes.length);
      healthIssuesGauge.set({ category: 'fragmented' }, report.fragmentedIndexes.length);
      healthIssuesGauge.set({ category: 'oversized' }, report.oversizedIndexes.length);
      
      // 将健康检查建议添加到总建议列表
      for (const rec of report.recommendations) {
        const existing = this.recommendations.find(r =>
          r.indexName === rec.index.indexName &&
          r.tableName === rec.index.table &&
          r.type === rec.action
        );
        
        if (!existing) {
          this.recommendations.push({
            type: rec.index.recommendation,
            indexName: rec.index.indexName,
            tableName: rec.index.table,
            columns: rec.index.columns || [],
            sql: rec.index.sql,
            priority: rec.priority,
            reason: rec.index.reason,
            safeWindow: rec.index.safeWindow,
            category: rec.category
          });
          
          recommendationCounter.inc({
            type: rec.index.recommendation,
            priority: 'medium'
          });
        }
      }
      
      logger.info({
        unused: report.unusedIndexes.length,
        duplicate: report.duplicateIndexes.length,
        fragmented: report.fragmentedIndexes.length,
        oversized: report.oversizedIndexes.length
      }, '索引健康检查完成');
      
      return report;
      
    } catch (error) {
      logger.error({ error: error.message }, '健康检查失败');
      throw error;
    }
  }

  /**
   * 执行优化
   */
  async executeOptimizations(limit = 5) {
    // 按优先级排序建议
    const sortedRecommendations = this.recommendations
      .sort((a, b) => b.priority - a.priority)
      .slice(0, limit);
    
    if (sortedRecommendations.length === 0) {
      logger.info('没有待执行的优化建议');
      return { executed: 0, results: [] };
    }
    
    const results = await this.executor.executeBatch(sortedRecommendations);
    
    // 更新指标
    for (const result of results.results) {
      executionCounter.inc({
        status: result.success ? 'success' : 'failed',
        type: result.log?.recommendation?.type || 'unknown'
      });
    }
    
    // 清除已执行的建议
    if (results.succeeded > 0) {
      this.recommendations = this.recommendations.filter(rec =>
        !sortedRecommendations.some(exec =>
          exec.indexName === rec.indexName &&
          exec.tableName === rec.tableName &&
          results.results.some(r =>
            r.success &&
            r.log?.recommendation?.indexName === rec.indexName
          )
        )
      );
    }
    
    return results;
  }

  /**
   * 执行完整的优化流程
   */
  async runFullOptimization() {
    logger.info('开始完整索引优化流程...');
    
    // 1. 收集慢查询
    await this.slowQueryCollector.collectSlowQueries();
    
    // 2. 运行健康检查
    const healthReport = await this.runHealthCheck();
    
    // 3. 执行优化
    const executionResults = await this.executeOptimizations(5);
    
    logger.info({
      slowQueries: this.slowQueryCollector.queryBuffer.length,
      recommendations: this.recommendations.length,
      executed: executionResults.executed,
      succeeded: executionResults.succeeded
    }, '完整优化流程完成');
    
    return {
      healthReport,
      recommendations: this.recommendations,
      executionResults
    };
  }

  /**
   * 获取状态摘要
   */
  getStatusSummary() {
    return {
      slowQueries: {
        total: this.slowQueryCollector.queryBuffer.length,
        critical: this.slowQueryCollector.queryBuffer.filter(q => q.severity === 'critical').length,
        high: this.slowQueryCollector.queryBuffer.filter(q => q.severity === 'high').length,
        medium: this.slowQueryCollector.queryBuffer.filter(q => q.severity === 'medium').length,
        low: this.slowQueryCollector.queryBuffer.filter(q => q.severity === 'low').length
      },
      recommendations: {
        total: this.recommendations.length,
        highPriority: this.recommendations.filter(r => r.priority >= 80).length,
        mediumPriority: this.recommendations.filter(r => r.priority >= 50 && r.priority < 80).length,
        lowPriority: this.recommendations.filter(r => r.priority < 50).length
      },
      health: this.lastHealthReport?.summary || null,
      executionStats: this.executor.getExecutionStats(),
      config: {
        dryRun: this.config.dryRun,
        slowQueryThreshold: this.config.slowQueryThreshold,
        executionWindow: this.config.executionWindow
      }
    };
  }

  /**
   * 停止管理器
   */
  stop() {
    this.slowQueryCollector.stop();
    this.initialized = false;
    
    logger.info('索引优化管理器已停止');
  }
}

module.exports = { IndexOptimizerManager };