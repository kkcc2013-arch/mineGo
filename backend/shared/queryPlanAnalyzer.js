/**
 * backend/shared/queryPlanAnalyzer.js
 * REQ-00077: 数据库慢查询分析与自动优化建议系统
 * 查询执行计划分析器
 */

'use strict';

const logger = require('./logger');
const { recordHistogram, incrementCounter } = require('./metrics');

class QueryPlanAnalyzer {
  constructor(pool) {
    this.pool = pool;
    this.costThreshold = 1000; // 成本阈值
    this.rowThreshold = 10000; // 行数阈值
  }

  /**
   * 分析查询执行计划
   */
  async analyze(query, params = []) {
    try {
      // 获取执行计划
      const explainResult = await this.pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
        params
      );

      const plan = explainResult.rows[0];
      const analysis = this.parsePlan(plan['QUERY PLAN'] || plan);

      // 生成优化建议
      const suggestions = this.generateSuggestions(analysis);

      // 记录指标
      this.recordMetrics(analysis);

      return {
        query: query.substring(0, 200),
        analysis,
        suggestions,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      logger.error('Query plan analysis failed', {
        error: error.message,
        query: query.substring(0, 100)
      });
      return null;
    }
  }

  /**
   * 解析执行计划
   */
  parsePlan(planData) {
    if (!planData) {
      return { error: 'No plan data available' };
    }

    const plan = Array.isArray(planData) ? planData[0].Plan : planData.Plan || planData;
    
    return {
      totalCost: plan['Total Cost'] || plan.total_cost || 0,
      planRows: plan['Plan Rows'] || plan.plan_rows || 0,
      actualRows: plan['Actual Rows'] || plan.actual_rows || 0,
      actualTime: plan['Actual Total Time'] || plan.actual_total_time || 0,
      planningTime: plan['Planning Time'] || plan.planning_time || 0,
      executionTime: plan['Execution Time'] || plan.execution_time || 0,
      nodeType: plan['Node Type'] || plan.node_type || 'Unknown',
      scanType: this.detectScanType(plan),
      joinType: plan['Join Type'] || plan.join_type || null,
      indexUsed: this.detectIndexUsage(plan),
      bufferHits: plan['Shared Hit Blocks'] || plan.shared_hit_blocks || 0,
      bufferReads: plan['Shared Read Blocks'] || plan.shared_read_blocks || 0,
      warnings: this.detectWarnings(plan)
    };
  }

  /**
   * 检测扫描类型
   */
  detectScanType(plan) {
    const nodeType = plan['Node Type'] || plan.node_type;
    
    if (nodeType === 'Seq Scan') return 'Sequential Scan';
    if (nodeType === 'Index Scan') return 'Index Scan';
    if (nodeType === 'Index Only Scan') return 'Index Only Scan';
    if (nodeType === 'Bitmap Index Scan') return 'Bitmap Index Scan';
    if (nodeType === 'Bitmap Heap Scan') return 'Bitmap Heap Scan';
    
    return nodeType || 'Unknown';
  }

  /**
   * 检测索引使用情况
   */
  detectIndexUsage(plan) {
    if (!plan) return null;
    
    // 检查当前节点
    const indexName = plan['Index Name'] || plan.index_name;
    if (indexName) {
      return {
        indexName,
        scanType: plan['Node Type'] || plan.node_type
      };
    }
    
    // 递归检查子计划
    const plans = plan.Plans || plan.plans || [];
    for (const subPlan of plans) {
      const nestedIndex = this.detectIndexUsage(subPlan);
      if (nestedIndex) return nestedIndex;
    }
    
    return null;
  }

  /**
   * 检测警告
   */
  detectWarnings(plan) {
    if (!plan) return [];
    
    const warnings = [];

    // 检测全表扫描
    const nodeType = plan['Node Type'] || plan.node_type;
    if (nodeType === 'Seq Scan') {
      const actualRows = plan['Actual Rows'] || plan.actual_rows || 0;
      warnings.push({
        type: 'seq_scan',
        severity: actualRows > 1000 ? 'high' : 'medium',
        message: 'Sequential scan detected - consider adding index',
        details: { nodeType, rowsScanned: actualRows }
      });
    }

    // 检测大结果集
    const actualRows = plan['Actual Rows'] || plan.actual_rows || 0;
    if (actualRows > this.rowThreshold) {
      warnings.push({
        type: 'large_result',
        severity: 'medium',
        message: `Large result set (${actualRows} rows) - consider pagination or filtering`,
        details: { rows: actualRows }
      });
    }

    // 检测高成本
    const totalCost = plan['Total Cost'] || plan.total_cost || 0;
    if (totalCost > this.costThreshold) {
      warnings.push({
        type: 'high_cost',
        severity: 'high',
        message: `High query cost (${totalCost}) - optimize query structure`,
        details: { cost: totalCost }
      });
    }

    // 检测缓存未命中
    const sharedReadBlocks = plan['Shared Read Blocks'] || plan.shared_read_blocks || 0;
    if (sharedReadBlocks > 100) {
      warnings.push({
        type: 'cache_miss',
        severity: 'medium',
        message: `High disk reads (${sharedReadBlocks} blocks) - data not cached`,
        details: { diskReads: sharedReadBlocks }
      });
    }

    // 检测排序操作
    if (nodeType === 'Sort') {
      const sortMethod = plan['Sort Method'] || plan.sort_method || '';
      const sortSpaceUsed = plan['Sort Space Used'] || plan.sort_space_used || 0;
      
      if (sortMethod.includes('external') || sortSpaceUsed > 1024) {
        warnings.push({
          type: 'external_sort',
          severity: 'medium',
          message: 'External sort detected - may require disk I/O',
          details: { sortMethod, sortSpaceUsed }
        });
      }
    }

    // 检测 Hash Join 可能的内存问题
    if (nodeType === 'Hash Join') {
      const hashBuckets = plan['Hash Buckets'] || plan.hash_buckets || 0;
      if (hashBuckets > 1000000) {
        warnings.push({
          type: 'large_hash',
          severity: 'medium',
          message: 'Large hash table in join - consider reducing join size',
          details: { hashBuckets }
        });
      }
    }

    return warnings;
  }

  /**
   * 生成优化建议
   */
  generateSuggestions(analysis) {
    const suggestions = [];

    // 全表扫描建议
    if (analysis.scanType === 'Sequential Scan' && analysis.actualRows > 100) {
      suggestions.push({
        type: 'add_index',
        priority: 'high',
        reason: 'Sequential scan on large table',
        action: 'Consider adding index on filter/join columns',
        estimatedImpact: '70-90% query time reduction'
      });
    }

    // 大结果集建议
    if (analysis.actualRows > this.rowThreshold) {
      suggestions.push({
        type: 'limit_result',
        priority: 'medium',
        reason: 'Large result set returned',
        action: 'Add LIMIT clause or implement pagination',
        estimatedImpact: '80-95% data transfer reduction'
      });
    }

    // 高执行时间建议
    if (analysis.executionTime > 1000) {
      suggestions.push({
        type: 'optimize_query',
        priority: 'high',
        reason: `High execution time (${analysis.executionTime.toFixed(2)}ms)`,
        action: 'Review query structure, avoid N+1 queries, use JOINs efficiently',
        estimatedImpact: '50-80% execution time reduction'
      });
    }

    // 缓存未命中建议
    const hitRate = analysis.bufferHits / (analysis.bufferHits + analysis.bufferReads || 1);
    if (hitRate < 0.8 && analysis.bufferReads > 0) {
      suggestions.push({
        type: 'increase_cache',
        priority: 'low',
        reason: `Low cache hit rate (${(hitRate * 100).toFixed(1)}%)`,
        action: 'Consider increasing shared_buffers or optimizing data access patterns',
        estimatedImpact: '30-50% I/O reduction'
      });
    }

    // 未使用索引建议
    if (!analysis.indexUsed && analysis.scanType !== 'Unknown' && analysis.totalCost > 100) {
      suggestions.push({
        type: 'review_index',
        priority: 'medium',
        reason: 'Query not using any index',
        action: 'Review WHERE clause columns and consider adding appropriate index',
        estimatedImpact: 'Variable'
      });
    }

    return suggestions;
  }

  /**
   * 记录 Prometheus 指标
   */
  recordMetrics(analysis) {
    // 执行时间
    recordHistogram('query_plan_execution_time_ms', analysis.executionTime, {
      scan_type: analysis.scanType
    });

    // 成本
    recordHistogram('query_plan_cost', analysis.totalCost, {
      scan_type: analysis.scanType
    });

    // 结果集大小
    recordHistogram('query_plan_result_rows', analysis.actualRows);

    // 缓存命中率
    const hitRate = analysis.bufferHits / (analysis.bufferHits + analysis.bufferReads || 1);
    recordHistogram('query_plan_cache_hit_rate', hitRate);

    // 分析计数
    incrementCounter('query_plan_analysis_total', { scan_type: analysis.scanType });
  }

  /**
   * 批量分析查询
   */
  async analyzeBatch(queries) {
    const results = [];
    
    for (const { query, params } of queries) {
      const analysis = await this.analyze(query, params);
      if (analysis) {
        results.push(analysis);
      }
      
      // 避免过度负载
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  }

  /**
   * 比较两个执行计划
   */
  comparePlans(plan1, plan2) {
    return {
      executionTimeDiff: plan2.executionTime - plan1.executionTime,
      costDiff: plan2.totalCost - plan1.totalCost,
      rowsDiff: plan2.actualRows - plan1.actualRows,
      improvement: plan1.executionTime > 0 
        ? ((plan1.executionTime - plan2.executionTime) / plan1.executionTime * 100).toFixed(2)
        : 0
    };
  }

  /**
   * 获取查询优化建议报告
   */
  generateOptimizationReport(analysis) {
    let report = '=== Query Plan Analysis Report ===\n\n';

    report += `Analyzed at: ${analysis.timestamp}\n`;
    report += `Query: ${analysis.query}\n\n`;

    report += '## Plan Summary\n';
    report += `- Node Type: ${analysis.analysis.nodeType}\n`;
    report += `- Scan Type: ${analysis.analysis.scanType}\n`;
    report += `- Total Cost: ${analysis.analysis.totalCost.toFixed(2)}\n`;
    report += `- Execution Time: ${analysis.analysis.executionTime.toFixed(2)}ms\n`;
    report += `- Rows Returned: ${analysis.analysis.actualRows}\n`;
    report += `- Index Used: ${analysis.analysis.indexUsed ? analysis.analysis.indexUsed.indexName : 'None'}\n\n`;

    if (analysis.analysis.warnings.length > 0) {
      report += '## Warnings\n';
      for (const warning of analysis.analysis.warnings) {
        report += `- [${warning.severity.toUpperCase()}] ${warning.message}\n`;
      }
      report += '\n';
    }

    if (analysis.suggestions.length > 0) {
      report += '## Optimization Suggestions\n';
      for (const sug of analysis.suggestions) {
        report += `- [${sug.priority.toUpperCase()}] ${sug.reason}\n`;
        report += `  Action: ${sug.action}\n`;
        report += `  Estimated Impact: ${sug.estimatedImpact}\n`;
      }
    }

    return report;
  }
}

module.exports = QueryPlanAnalyzer;
