# REQ-00077: 数据库慢查询分析与自动优化建议系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00077 |
| 标题 | 数据库慢查询分析与自动优化建议系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database/migrations、所有微服务、backend/shared、infrastructure/k8s |
| 创建时间 | 2026-06-10 10:30 |

## 需求描述

mineGo 项目使用 PostgreSQL 作为主数据库，随着用户量和数据量的增长，数据库性能对整个系统的影响越来越大。当前缺少系统化的慢查询分析机制，问题主要表现为：

1. **缺少实时慢查询监控**：无法及时发现性能下降的 SQL 语句
2. **缺少索引优化建议**：开发者难以判断哪些字段需要索引
3. **缺少查询执行计划分析**：无法快速定位性能瓶颈
4. **缺少自动化优化流程**：索引创建和维护依赖人工判断

本需求旨在构建完整的慢查询分析系统，包括：
- 实时慢查询日志采集和监控
- 自动分析查询执行计划并生成优化建议
- 索引使用率统计和无效索引检测
- 与 Prometheus 集成的性能指标
- Grafana 可视化仪表板
- 告警规则和自动化优化工作流

## 技术方案

### 1. 慢查询日志采集器

**文件**: `backend/shared/slowQueryCollector.js`

```javascript
/**
 * 慢查询日志采集器
 * 采集 PostgreSQL 慢查询日志，解析并上报
 */
const { Pool } = require('pg');
const logger = require('./logger');
const { slowQueryTotal, slowQueryDuration, slowQueryCount } = require('./metrics');

class SlowQueryCollector {
  constructor(options = {}) {
    this.threshold = options.threshold || 1000; // 默认 1 秒
    this.sampleRate = options.sampleRate || 1.0; // 采样率
    this.pool = null;
    this.stats = {
      totalQueries: 0,
      slowQueries: 0,
      topSlowQueries: []
    };
  }

  /**
   * 初始化数据库连接池
   */
  async initialize() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5, // 监控连接池，保持小规模
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    // 启动定期采集
    this.startCollection();
    
    logger.info('SlowQueryCollector initialized', {
      threshold: this.threshold,
      sampleRate: this.sampleRate
    });
  }

  /**
   * 启动定期采集
   */
  startCollection() {
    // 每 5 分钟采集一次
    this.collectionInterval = setInterval(async () => {
      await this.collect();
    }, 5 * 60 * 1000);

    // 立即执行一次
    this.collect().catch(err => {
      logger.error('Initial slow query collection failed', { error: err.message });
    });
  }

  /**
   * 采集慢查询日志
   */
  async collect() {
    try {
      // 查询 pg_stat_statements 扩展（需要预先启用）
      const slowQueriesResult = await this.pool.query(`
        SELECT 
          queryid,
          query,
          calls,
          total_time,
          mean_time,
          min_time,
          max_time,
          rows,
          shared_blks_hit,
          shared_blks_read
        FROM pg_stat_statements
        WHERE mean_time > $1
        ORDER BY total_time DESC
        LIMIT 100
      `, [this.threshold]);

      const slowQueries = slowQueriesResult.rows;

      // 上报指标
      for (const sq of slowQueries) {
        slowQueryTotal.inc({ query_id: sq.queryid });
        slowQueryDuration.observe({ query_id: sq.queryid }, sq.mean_time);
        
        // 更新统计
        this.stats.slowQueries++;
      }

      // 更新 top 慢查询列表
      this.updateTopSlowQueries(slowQueries.slice(0, 10));

      // 上报计数
      slowQueryCount.inc(this.stats.slowQueries);

      logger.debug('Slow query collection completed', {
        count: slowQueries.length,
        totalSlowQueries: this.stats.slowQueries
      });

    } catch (error) {
      // 如果 pg_stat_statements 未启用，使用替代方案
      if (error.code === '42P01') {
        await this.collectFromPgStatActivity();
      } else {
        logger.error('Slow query collection failed', { error: error.message });
      }
    }
  }

  /**
   * 从 pg_stat_activity 采集（备用方案）
   */
  async collectFromPgStatActivity() {
    const result = await this.pool.query(`
      SELECT 
        pid,
        now() - pg_stat_activity.query_start AS duration,
        query,
        state
      FROM pg_stat_activity
      WHERE (now() - pg_stat_activity.query_start) > interval '${this.threshold} milliseconds'
        AND state != 'idle'
      ORDER BY duration DESC
      LIMIT 100
    `);

    const activeSlowQueries = result.rows;
    
    for (const sq of activeSlowQueries) {
      const durationMs = parseFloat(sq.duration);
      slowQueryDuration.observe({ query_type: 'active' }, durationMs);
    }

    logger.debug('Collected from pg_stat_activity', {
      count: activeSlowQueries.length
    });
  }

  /**
   * 更新 top 慢查询列表
   */
  updateTopSlowQueries(newQueries) {
    this.stats.topSlowQueries = newQueries.map(sq => ({
      queryId: sq.queryid,
      query: this.truncateQuery(sq.query),
      calls: sq.calls,
      meanTime: sq.mean_time,
      totalTime: sq.total_time,
      rows: sq.rows
    }));
  }

  /**
   * 截断查询文本
   */
  truncateQuery(query, maxLength = 200) {
    if (!query) return '';
    if (query.length <= maxLength) return query;
    return query.substring(0, maxLength) + '...';
  }

  /**
   * 获取慢查询统计
   */
  getStats() {
    return {
      ...this.stats,
      threshold: this.threshold,
      sampleRate: this.sampleRate,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 停止采集
   */
  async stop() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
    }
    if (this.pool) {
      await this.pool.end();
    }
    logger.info('SlowQueryCollector stopped');
  }
}

module.exports = SlowQueryCollector;
```

### 2. 查询执行计划分析器

**文件**: `backend/shared/queryPlanAnalyzer.js`

```javascript
/**
 * 查询执行计划分析器
 * 分析 EXPLAIN ANALYZE 输出，生成优化建议
 */
const logger = require('./logger');

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
      const analysis = this.parsePlan(plan);

      // 生成优化建议
      const suggestions = this.generateSuggestions(analysis);

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
    const plan = planData['QUERY PLAN'] || planData;
    
    return {
      totalCost: plan['Total Cost'] || 0,
      planRows: plan['Plan Rows'] || 0,
      actualRows: plan['Actual Rows'] || 0,
      actualTime: plan['Actual Total Time'] || 0,
      planningTime: plan['Planning Time'] || 0,
      executionTime: plan['Execution Time'] || 0,
      nodeType: plan['Node Type'] || 'Unknown',
      scanType: this.detectScanType(plan),
      joinType: plan['Join Type'] || null,
      indexUsed: this.detectIndexUsage(plan),
      bufferHits: plan['Shared Hit Blocks'] || 0,
      bufferReads: plan['Shared Read Blocks'] || 0,
      warnings: this.detectWarnings(plan)
    };
  }

  /**
   * 检测扫描类型
   */
  detectScanType(plan) {
    const nodeType = plan['Node Type'];
    
    if (nodeType === 'Seq Scan') return 'Sequential Scan';
    if (nodeType === 'Index Scan') return 'Index Scan';
    if (nodeType === 'Index Only Scan') return 'Index Only Scan';
    if (nodeType === 'Bitmap Index Scan') return 'Bitmap Index Scan';
    
    return nodeType;
  }

  /**
   * 检测索引使用情况
   */
  detectIndexUsage(plan) {
    if (!plan || !plan.Plans) return null;
    
    for (const subPlan of plan.Plans) {
      if (subPlan['Index Name']) {
        return {
          indexName: subPlan['Index Name'],
          scanType: subPlan['Node Type']
        };
      }
      
      const nestedIndex = this.detectIndexUsage(subPlan);
      if (nestedIndex) return nestedIndex;
    }
    
    return null;
  }

  /**
   * 检测警告
   */
  detectWarnings(plan) {
    const warnings = [];

    // 检测全表扫描
    if (plan['Node Type'] === 'Seq Scan') {
      warnings.push({
        type: 'seq_scan',
        severity: 'high',
        message: 'Sequential scan detected - consider adding index'
      });
    }

    // 检测大结果集
    if (plan['Actual Rows'] > this.rowThreshold) {
      warnings.push({
        type: 'large_result',
        severity: 'medium',
        message: `Large result set (${plan['Actual Rows']} rows) - consider pagination or filtering`
      });
    }

    // 检测高成本
    if (plan['Total Cost'] > this.costThreshold) {
      warnings.push({
        type: 'high_cost',
        severity: 'high',
        message: `High query cost (${plan['Total Cost']}) - optimize query structure`
      });
    }

    // 检测缓存未命中
    if (plan['Shared Read Blocks'] > 100) {
      warnings.push({
        type: 'cache_miss',
        severity: 'medium',
        message: `High disk reads (${plan['Shared Read Blocks']} blocks) - data not cached`
      });
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
        reason: `High execution time (${analysis.executionTime}ms)`,
        action: 'Review query structure, avoid N+1 queries, use JOINs efficiently',
        estimatedImpact: '50-80% execution time reduction'
      });
    }

    // 缓存未命中建议
    const hitRate = analysis.bufferHits / (analysis.bufferHits + analysis.bufferReads || 1);
    if (hitRate < 0.8) {
      suggestions.push({
        type: 'increase_cache',
        priority: 'low',
        reason: `Low cache hit rate (${(hitRate * 100).toFixed(1)}%)`,
        action: 'Consider increasing shared_buffers or optimizing data access patterns',
        estimatedImpact: '30-50% I/O reduction'
      });
    }

    return suggestions;
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
}

module.exports = QueryPlanAnalyzer;
```

### 3. 索引使用率分析器

**文件**: `backend/shared/indexUsageAnalyzer.js`

```javascript
/**
 * 索引使用率分析器
 * 分析索引使用情况，检测无效索引
 */
const logger = require('./logger');

class IndexUsageAnalyzer {
  constructor(pool) {
    this.pool = pool;
  }

  /**
   * 分析所有索引使用情况
   */
  async analyze() {
    const indexStats = await this.getIndexStats();
    const unusedIndexes = await this.findUnusedIndexes(indexStats);
    const duplicateIndexes = await this.findDuplicateIndexes();
    const suggestedIndexes = await this.findSuggestedIndexes();

    return {
      totalIndexes: indexStats.length,
      usedIndexes: indexStats.filter(i => i.idx_scan > 0).length,
      unusedIndexes: unusedIndexes.length,
      duplicateIndexes: duplicateIndexes.length,
      suggestedIndexes: suggestedIndexes.length,
      details: {
        indexStats: indexStats.slice(0, 50), // 限制输出
        unusedIndexes,
        duplicateIndexes,
        suggestedIndexes
      },
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取索引统计信息
   */
  async getIndexStats() {
    const result = await this.pool.query(`
      SELECT
        schemaname,
        relname as table_name,
        indexrelname as index_name,
        idx_scan as index_scans,
        idx_tup_read as tuples_read,
        idx_tup_fetch as tuples_fetched,
        pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
        pg_relation_size(indexrelid) as index_size_bytes
      FROM pg_stat_user_indexes
      ORDER BY idx_scan DESC, pg_relation_size(indexrelid) DESC
    `);

    return result.rows;
  }

  /**
   * 查找未使用的索引
   */
  async findUnusedIndexes(indexStats) {
    // 扫描次数为 0 的索引
    const unusedByScan = indexStats.filter(i => i.idx_scan === 0);

    // 检查是否是约束索引（主键、唯一约束等）
    const constraintIndexes = await this.getConstraintIndexes();
    const constraintIndexNames = new Set(constraintIndexes.map(i => i.index_name));

    return unusedByScan.filter(i => {
      // 排除约束索引，这些不能删除
      return !constraintIndexNames.has(i.index_name);
    }).map(i => ({
      tableName: i.table_name,
      indexName: i.index_name,
      indexSize: i.index_size,
      reason: 'Never used (0 scans)'
    }));
  }

  /**
   * 获取约束索引
   */
  async getConstraintIndexes() {
    const result = await this.pool.query(`
      SELECT
        tc.table_name,
        kcu.column_name,
        tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
    `);

    return result.rows;
  }

  /**
   * 查找重复索引
   */
  async findDuplicateIndexes() {
    const result = await this.pool.query(`
      SELECT
        pg_get_indexdef(idx1.oid) as index1_def,
        pg_get_indexdef(idx2.oid) as index2_def,
        idx1.relname as index1_name,
        idx2.relname as index2_name,
        tbl.relname as table_name
      FROM pg_index i1
      JOIN pg_class idx1 ON idx1.oid = i1.indexrelid
      JOIN pg_class tbl ON tbl.oid = i1.indrelid
      JOIN pg_index i2 ON i2.indrelid = i1.indrelid AND i2.indexrelid != i1.indexrelid
      JOIN pg_class idx2 ON idx2.oid = i2.indexrelid
      WHERE i1.indkey = i2.indkey
        AND idx1.relname < idx2.relname
    `);

    return result.rows;
  }

  /**
   * 查找建议的索引（基于慢查询）
   */
  async findSuggestedIndexes() {
    // 从 pg_stat_statements 查找未使用索引的频繁查询
    const result = await this.pool.query(`
      SELECT 
        queryid,
        query,
        calls,
        total_time
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat%'
        AND query NOT LIKE '%information_schema%'
      ORDER BY total_time DESC
      LIMIT 20
    `).catch(() => ({ rows: [] }));

    // 简化分析：查找 WHERE 子句中可能的列
    const suggestions = [];
    
    for (const row of result.rows) {
      const whereMatch = row.query.match(/WHERE\s+(\w+)\s*=/i);
      if (whereMatch) {
        suggestions.push({
          queryId: row.queryid,
          columnSuggestion: whereMatch[1],
          reason: `Frequent filter on column (${row.calls} calls)`,
          totalTime: row.total_time
        });
      }
    }

    return suggestions;
  }

  /**
   * 生成索引优化报告
   */
  generateReport(analysis) {
    let report = '=== Database Index Analysis Report ===\n\n';

    report += `Total Indexes: ${analysis.totalIndexes}\n`;
    report += `Used Indexes: ${analysis.usedIndexes} (${(analysis.usedIndexes / analysis.totalIndexes * 100).toFixed(1)}%)\n`;
    report += `Unused Indexes: ${analysis.unusedIndexes}\n`;
    report += `Duplicate Indexes: ${analysis.duplicateIndexes}\n\n`;

    if (analysis.details.unusedIndexes.length > 0) {
      report += '=== Unused Indexes (Candidates for Removal) ===\n';
      for (const idx of analysis.details.unusedIndexes) {
        report += `  - ${idx.tableName}.${idx.indexName} (${idx.indexSize})\n`;
      }
      report += '\n';
    }

    if (analysis.details.duplicateIndexes.length > 0) {
      report += '=== Duplicate Indexes ===\n';
      for (const dup of analysis.details.duplicateIndexes) {
        report += `  - ${dup.table_name}: ${dup.index1_name} duplicates ${dup.index2_name}\n`;
      }
      report += '\n';
    }

    return report;
  }
}

module.exports = IndexUsageAnalyzer;
```

### 4. Prometheus 指标定义

**文件**: `backend/shared/metrics.js` (扩展)

```javascript
// 添加慢查询相关指标

// 慢查询计数
const slowQueryTotal = new promClient.Counter({
  name: 'database_slow_query_total',
  help: 'Total number of slow queries detected',
  labelNames: ['query_id', 'service']
});

// 慢查询延迟直方图
const slowQueryDuration = new promClient.Histogram({
  name: 'database_slow_query_duration_ms',
  help: 'Duration of slow queries in milliseconds',
  labelNames: ['query_id', 'service'],
  buckets: [100, 500, 1000, 2000, 5000, 10000, 30000]
});

// 慢查询总数
const slowQueryCount = new promClient.Gauge({
  name: 'database_slow_query_count',
  help: 'Current count of slow queries'
});

// 索引使用率
const indexUsageRatio = new promClient.Gauge({
  name: 'database_index_usage_ratio',
  help: 'Ratio of used indexes to total indexes',
  labelNames: ['schema', 'table']
});

// 查询执行时间百分位
const queryExecutionTime = new promClient.Histogram({
  name: 'database_query_execution_time_ms',
  help: 'Query execution time percentiles',
  labelNames: ['service', 'operation'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000]
});

// 缓存命中率
const bufferCacheHitRatio = new promClient.Gauge({
  name: 'database_buffer_cache_hit_ratio',
  help: 'Database buffer cache hit ratio',
  labelNames: ['service']
});

module.exports = {
  // ... 现有导出
  slowQueryTotal,
  slowQueryDuration,
  slowQueryCount,
  indexUsageRatio,
  queryExecutionTime,
  bufferCacheHitRatio
};
```

### 5. API 路由

**文件**: `backend/shared/routes/slowQuery.js`

```javascript
/**
 * 慢查询分析 API 路由
 */
const express = require('express');
const router = express.Router();
const SlowQueryCollector = require('../slowQueryCollector');
const QueryPlanAnalyzer = require('../queryPlanAnalyzer');
const IndexUsageAnalyzer = require('../indexUsageAnalyzer');
const db = require('../db');

let collector = null;
let planAnalyzer = null;
let indexAnalyzer = null;

/**
 * 初始化分析器
 */
async function initializeAnalyzers() {
  if (!collector) {
    collector = new SlowQueryCollector();
    await collector.initialize();
  }
  
  if (!planAnalyzer) {
    planAnalyzer = new QueryPlanAnalyzer(db.getPool());
  }
  
  if (!indexAnalyzer) {
    indexAnalyzer = new IndexUsageAnalyzer(db.getPool());
  }
}

/**
 * GET /api/slow-query/stats
 * 获取慢查询统计
 */
router.get('/stats', async (req, res) => {
  try {
    await initializeAnalyzers();
    const stats = collector.getStats();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/slow-query/top
 * 获取 top N 慢查询
 */
router.get('/top', async (req, res) => {
  try {
    await initializeAnalyzers();
    const limit = parseInt(req.query.limit) || 10;
    const topQueries = collector.stats.topSlowQueries.slice(0, limit);
    
    res.json({
      success: true,
      data: topQueries
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/slow-query/analyze
 * 分析指定查询的执行计划
 */
router.post('/analyze', async (req, res) => {
  try {
    await initializeAnalyzers();
    const { query, params } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    const analysis = await planAnalyzer.analyze(query, params || []);
    
    res.json({
      success: true,
      data: analysis
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/slow-query/indexes
 * 获取索引使用情况分析
 */
router.get('/indexes', async (req, res) => {
  try {
    await initializeAnalyzers();
    const analysis = await indexAnalyzer.analyze();
    
    res.json({
      success: true,
      data: analysis
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/slow-query/report
 * 生成完整分析报告
 */
router.get('/report', async (req, res) => {
  try {
    await initializeAnalyzers();
    
    const [queryStats, indexAnalysis] = await Promise.all([
      collector.getStats(),
      indexAnalyzer.analyze()
    ]);

    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        slowQueries: queryStats.slowQueries,
        totalQueries: queryStats.totalQueries,
        indexUsage: {
          total: indexAnalysis.totalIndexes,
          used: indexAnalysis.usedIndexes,
          unused: indexAnalysis.unusedIndexes
        }
      },
      topSlowQueries: queryStats.topSlowQueries.slice(0, 10),
      unusedIndexes: indexAnalysis.details.unusedIndexes,
      suggestedOptimizations: indexAnalysis.details.suggestedIndexes
    };

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

### 6. Grafana 仪表板

**文件**: `infrastructure/k8s/monitoring/grafana-dashboards/slow-query-analysis.json`

```json
{
  "dashboard": {
    "title": "Database Slow Query Analysis",
    "panels": [
      {
        "title": "Slow Query Count Over Time",
        "type": "graph",
        "targets": [
          {
            "expr": "rate(database_slow_query_total[5m])",
            "legendFormat": "{{query_id}}"
          }
        ]
      },
      {
        "title": "Query Duration Distribution",
        "type": "heatmap",
        "targets": [
          {
            "expr": "rate(database_slow_query_duration_ms_bucket[5m])",
            "legendFormat": "{{le}}"
          }
        ]
      },
      {
        "title": "Index Usage Ratio",
        "type": "gauge",
        "targets": [
          {
            "expr": "database_index_usage_ratio",
            "legendFormat": "{{schema}}.{{table}}"
          }
        ]
      },
      {
        "title": "Buffer Cache Hit Ratio",
        "type": "stat",
        "targets": [
          {
            "expr": "database_buffer_cache_hit_ratio",
            "legendFormat": "{{service}}"
      },
      {
        "title": "Query Execution Time P95",
        "type": "graph",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(database_query_execution_time_ms_bucket[5m]))",
            "legendFormat": "{{operation}}"
          }
        ]
      },
      {
        "title": "Top 10 Slow Queries",
        "type": "table",
        "targets": [
          {
            "expr": "topk(10, database_slow_query_duration_ms_sum)",
            "format": "table"
          }
        ]
      }
    ]
  }
}
```

### 7. 告警规则

**文件**: `infrastructure/k8s/monitoring/prometheus-rules.yml` (扩展)

```yaml
groups:
  - name: slow-query-alerts
    rules:
      - alert: HighSlowQueryRate
        expr: rate(database_slow_query_total[5m]) > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High slow query rate detected"
          description: "{{ $value }} slow queries per second"

      - alert: VerySlowQuery
        expr: database_slow_query_duration_ms > 10000
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Very slow query detected (>10s)"
          description: "Query {{ $labels.query_id }} took {{ $value }}ms"

      - alert: LowIndexUsageRatio
        expr: database_index_usage_ratio < 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Low index usage ratio"
          description: "Only {{ $value }} of indexes are being used"

      - alert: LowCacheHitRatio
        expr: database_buffer_cache_hit_ratio < 0.8
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Low buffer cache hit ratio"
          description: "Cache hit ratio is {{ $value }}, consider tuning"
```

### 8. 数据库迁移（启用 pg_stat_statements）

**文件**: `database/pending/20260610_103000__enable_pg_stat_statements.sql`

```sql
-- 启用 pg_stat_statements 扩展
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 重置统计（可选，谨慎使用）
-- SELECT pg_stat_statements_reset();

-- 创建慢查询分析历史表
CREATE TABLE IF NOT EXISTS slow_query_history (
    id SERIAL PRIMARY KEY,
    query_id BIGINT,
    query_text TEXT,
    mean_time_ms FLOAT,
    total_time_ms FLOAT,
    calls BIGINT,
    rows_returned BIGINT,
    shared_blks_hit BIGINT,
    shared_blks_read BIGINT,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_slow_query_history_query_id (query_id),
    INDEX idx_slow_query_history_recorded_at (recorded_at)
);

-- 创建索引建议表
CREATE TABLE IF NOT EXISTS index_suggestions (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(255),
    column_name VARCHAR(255),
    suggestion_type VARCHAR(50),
    reason TEXT,
    priority VARCHAR(20),
    estimated_impact TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    applied BOOLEAN DEFAULT FALSE,
    applied_at TIMESTAMP,
    INDEX idx_index_suggestions_table (table_name),
    INDEX idx_index_suggestions_applied (applied)
);

-- 创建查询性能基准表
CREATE TABLE IF NOT EXISTS query_performance_baseline (
    id SERIAL PRIMARY KEY,
    query_signature VARCHAR(64),
    avg_execution_time_ms FLOAT,
    p95_execution_time_ms FLOAT,
    calls_per_hour FLOAT,
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(query_signature),
    INDEX idx_query_performance_signature (query_signature)
);

-- 添加注释
COMMENT ON TABLE slow_query_history IS 'History of slow queries detected';
COMMENT ON TABLE index_suggestions IS 'Suggestions for index optimization';
COMMENT ON TABLE query_performance_baseline IS 'Performance baselines for queries';
```

### 9. 单元测试

**文件**: `backend/tests/unit/slow-query-analysis.test.js`

```javascript
const { expect } = require('chai');
const sinon = require('sinon');
const SlowQueryCollector = require('../../shared/slowQueryCollector');
const QueryPlanAnalyzer = require('../../shared/queryPlanAnalyzer');
const IndexUsageAnalyzer = require('../../shared/indexUsageAnalyzer');

describe('Slow Query Analysis System', () => {
  describe('SlowQueryCollector', () => {
    let collector;
    
    beforeEach(() => {
      collector = new SlowQueryCollector({ threshold: 1000 });
    });

    afterEach(() => {
      if (collector) {
        collector.stop();
      }
    });

    it('should initialize with correct threshold', () => {
      expect(collector.threshold).to.equal(1000);
    });

    it('should truncate long queries', () => {
      const longQuery = 'SELECT * FROM users WHERE ' + 'x=1 AND '.repeat(100);
      const truncated = collector.truncateQuery(longQuery, 50);
      expect(truncated.length).to.be.at.most(53);
      expect(truncated).to.match(/\.\.\.$/);
    });

    it('should update top slow queries', () => {
      const queries = [
        { queryid: 1, query: 'SELECT 1', calls: 100, mean_time: 5000, total_time: 500000, rows: 10 },
        { queryid: 2, query: 'SELECT 2', calls: 50, mean_time: 3000, total_time: 150000, rows: 5 }
      ];
      
      collector.updateTopSlowQueries(queries);
      expect(collector.stats.topSlowQueries).to.have.lengthOf(2);
    });
  });

  describe('QueryPlanAnalyzer', () => {
    let analyzer;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub()
      };
      analyzer = new QueryPlanAnalyzer(mockPool);
    });

    it('should detect sequential scan', () => {
      const plan = { 'Node Type': 'Seq Scan' };
      const scanType = analyzer.detectScanType(plan);
      expect(scanType).to.equal('Sequential Scan');
    });

    it('should detect index scan', () => {
      const plan = { 'Node Type': 'Index Scan' };
      const scanType = analyzer.detectScanType(plan);
      expect(scanType).to.equal('Index Scan');
    });

    it('should generate suggestions for seq scan', () => {
      const analysis = {
        scanType: 'Sequential Scan',
        actualRows: 1000,
        executionTime: 2000,
        bufferHits: 0,
        bufferReads: 500
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      expect(suggestions).to.have.length.at.least(1);
      expect(suggestions[0].type).to.equal('add_index');
    });

    it('should detect high cost warnings', () => {
      const plan = { 'Total Cost': 5000, 'Actual Rows': 100 };
      const warnings = analyzer.detectWarnings(plan);
      const costWarning = warnings.find(w => w.type === 'high_cost');
      expect(costWarning).to.exist;
    });

    it('should calculate cache hit rate correctly', () => {
      const analysis = {
        bufferHits: 800,
        bufferReads: 200,
        scanType: 'Index Scan',
        actualRows: 100,
        executionTime: 100
      };
      
      const suggestions = analyzer.generateSuggestions(analysis);
      const cacheSuggestion = suggestions.find(s => s.type === 'increase_cache');
      expect(cacheSuggestion).to.not.exist; // 80% hit rate is acceptable
    });
  });

  describe('IndexUsageAnalyzer', () => {
    let analyzer;
    let mockPool;

    beforeEach(() => {
      mockPool = {
        query: sinon.stub()
      };
      analyzer = new IndexUsageAnalyzer(mockPool);
    });

    it('should find unused indexes', async () => {
      mockPool.query.resolves({
        rows: [
          { table_name: 'users', index_name: 'idx_unused', idx_scan: 0, index_size: '1 MB' }
        ]
      });
      
      // Mock constraint indexes query
      mockPool.query.onSecondCall().resolves({ rows: [] });
      
      const stats = [{ table_name: 'users', index_name: 'idx_unused', idx_scan: 0, index_size: '1 MB' }];
      const unused = await analyzer.findUnusedIndexes(stats);
      
      expect(unused).to.have.lengthOf(1);
    });

    it('should exclude constraint indexes from unused list', async () => {
      const stats = [
        { table_name: 'users', index_name: 'users_pkey', idx_scan: 0, index_size: '1 MB' }
      ];
      
      mockPool.query.resolves({
        rows: [
          { index_name: 'users_pkey', table_name: 'users' }
        ]
      });
      
      const unused = await analyzer.findUnusedIndexes(stats);
      expect(unused).to.have.lengthOf(0);
    });

    it('should generate proper report', () => {
      const analysis = {
        totalIndexes: 10,
        usedIndexes: 8,
        unusedIndexes: 2,
        duplicateIndexes: 1,
        details: {
          unusedIndexes: [{ tableName: 'test', indexName: 'idx_unused', indexSize: '1 MB' }],
          duplicateIndexes: [],
          suggestedIndexes: []
        }
      };
      
      const report = analyzer.generateReport(analysis);
      expect(report).to.include('Total Indexes: 10');
      expect(report).to.include('Unused Indexes');
    });
  });
});
```

## 验收标准

- [ ] 慢查询采集器成功采集超过阈值的查询
- [ ] 查询执行计划分析器正确识别全表扫描
- [ ] 生成索引优化建议（至少 3 种类型）
- [ ] 索引使用率分析正确识别未使用索引
- [ ] Prometheus 指标正确上报慢查询数据
- [ ] Grafana 仪表板显示 6 个监控面板
- [ ] 告警规则配置完成（至少 4 条规则）
- [ ] API 端点可用（/api/slow-query/*）
- [ ] 单元测试覆盖率 > 80%
- [ ] 文档完整（使用说明、最佳实践）

## 影响范围

- **新增文件**：
  - `backend/shared/slowQueryCollector.js`
  - `backend/shared/queryPlanAnalyzer.js`
  - `backend/shared/indexUsageAnalyzer.js`
  - `backend/shared/routes/slowQuery.js`
  - `infrastructure/k8s/monitoring/grafana-dashboards/slow-query-analysis.json`
  - `database/pending/20260610_103000__enable_pg_stat_statements.sql`
  - `backend/tests/unit/slow-query-analysis.test.js`

- **修改文件**：
  - `backend/shared/metrics.js`（添加新指标）
  - `infrastructure/k8s/monitoring/prometheus-rules.yml`（添加新规则）

## 参考

- [PostgreSQL pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html)
- [PostgreSQL EXPLAIN ANALYZE](https://www.postgresql.org/docs/current/sql-explain.html)
- [PostgreSQL Index Documentation](https://www.postgresql.org/docs/current/indexes.html)
- [Prometheus Histogram Best Practices](https://prometheus.io/docs/practices/histograms/)
