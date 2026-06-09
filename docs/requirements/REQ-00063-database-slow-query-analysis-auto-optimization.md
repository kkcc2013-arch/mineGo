# REQ-00063: 数据库慢查询分析与自动优化建议系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00063 |
| 标题 | 数据库慢查询分析与自动优化建议系统 |
| 类别 | 数据库/数据治理 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | database/migrations、所有微服务、backend/shared、infrastructure/k8s |
| 创建时间 | 2026-06-09 22:00 |

## 需求描述

### 背景
随着用户量和数据量的增长，数据库查询性能成为系统瓶颈。当前缺乏系统化的慢查询监控和优化建议机制，导致：
1. 性能问题发现滞后，影响用户体验
2. 索引优化依赖人工经验，效率低下
3. 缺乏历史查询性能趋势分析
4. 无法自动识别潜在的性能风险

### 目标
构建完整的数据库慢查询分析与自动优化建议系统：
- 实时采集和分析慢查询日志
- 自动识别问题查询并生成优化建议
- 提供查询性能趋势可视化
- 支持自动索引建议和 SQL 重写建议
- 集成告警机制，主动发现性能问题

## 技术方案

### 1. 慢查询日志采集系统

```javascript
// backend/shared/slowQueryCollector.js

const { Client } = require('pg');
const logger = require('./logger');
const { incrementCounter, recordHistogram } = require('./metrics');

class SlowQueryCollector {
  constructor(config = {}) {
    this.slowThreshold = config.slowThreshold || 1000; // 1秒
    this.verySlowThreshold = config.verySlowThreshold || 5000; // 5秒
    this.collectInterval = config.collectInterval || 60000; // 1分钟
    this.dbConfig = config.dbConfig;
    this.isRunning = false;
    this.lastCollectionTime = null;
  }

  async start() {
    this.isRunning = true;
    await this.enableSlowQueryLog();
    this.startCollectionLoop();
    logger.info('Slow query collector started', {
      slowThreshold: this.slowThreshold,
      verySlowThreshold: this.verySlowThreshold
    });
  }

  async enableSlowQueryLog() {
    const client = new Client(this.dbConfig);
    await client.connect();
    
    // 启用慢查询日志
    await client.query(`
      ALTER SYSTEM SET log_min_duration_statement = ${this.slowThreshold};
      ALTER SYSTEM SET log_statement = 'all';
    `);
    
    // 配置 pg_stat_statements 扩展
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
    `);
    
    await client.end();
    logger.info('Slow query logging enabled');
  }

  startCollectionLoop() {
    this.collectionTimer = setInterval(async () => {
      try {
        await this.collectSlowQueries();
      } catch (error) {
        logger.error('Failed to collect slow queries', { error: error.message });
      }
    }, this.collectInterval);
  }

  async collectSlowQueries() {
    const client = new Client(this.dbConfig);
    await client.connect();
    
    try {
      // 从 pg_stat_statements 获取慢查询
      const result = await client.query(`
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
          shared_blks_read,
          shared_blks_dirtied,
          shared_blks_written
        FROM pg_stat_statements
        WHERE mean_time > $1
        ORDER BY total_time DESC
        LIMIT 100
      `, [this.slowThreshold]);
      
      const slowQueries = result.rows;
      
      // 记录指标
      for (const query of slowQueries) {
        this.recordQueryMetrics(query);
        await this.analyzeAndStoreQuery(query);
      }
      
      this.lastCollectionTime = new Date();
      logger.info('Collected slow queries', { 
        count: slowQueries.length,
        topQueryTime: slowQueries[0]?.mean_time 
      });
      
    } finally {
      await client.end();
    }
  }

  recordQueryMetrics(query) {
    // Prometheus 指标
    incrementCounter('slow_query_total', 1, {
      query_id: query.queryid,
      service: 'database'
    });
    
    recordHistogram('query_duration_seconds', query.mean_time / 1000, {
      query_id: query.queryid
    });
    
    recordHistogram('query_rows_returned', query.rows, {
      query_id: query.queryid
    });
    
    // 缓存命中率
    const cacheHitRatio = query.shared_blks_hit / 
      (query.shared_blks_hit + query.shared_blks_read || 1);
    recordHistogram('query_cache_hit_ratio', cacheHitRatio, {
      query_id: query.queryid
    });
  }

  async analyzeAndStoreQuery(query) {
    // 存储到数据库进行分析
    const client = new Client(this.dbConfig);
    await client.connect();
    
    try {
      await client.query(`
        INSERT INTO slow_query_log (
          query_id, query_text, calls, total_time_ms, 
          mean_time_ms, min_time_ms, max_time_ms, rows_affected,
          cache_hit_ratio, collected_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (query_id, collected_at::date) 
        DO UPDATE SET
          calls = EXCLUDED.calls,
          total_time_ms = EXCLUDED.total_time_ms,
          mean_time_ms = EXCLUDED.mean_time_ms
      `, [
        query.queryid,
        query.query.substring(0, 5000), // 限制长度
        query.calls,
        query.total_time,
        query.mean_time,
        query.min_time,
        query.max_time,
        query.rows,
        query.shared_blks_hit / (query.shared_blks_hit + query.shared_blks_read || 1)
      ]);
    } finally {
      await client.end();
    }
  }

  async stop() {
    this.isRunning = false;
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
    }
    logger.info('Slow query collector stopped');
  }
}

module.exports = SlowQueryCollector;
```

### 2. 查询分析引擎

```javascript
// backend/shared/queryAnalyzer.js

const logger = require('./logger');

class QueryAnalyzer {
  constructor() {
    this.analysisRules = [
      this.checkMissingIndex.bind(this),
      this.checkFullTableScan.bind(this),
      this.checkInefficientJoin.bind(this),
      this.checkMissingWhereClause.bind(this),
      this.checkSelectStar.bind(this),
      this.checkOrCondition.bind(this),
      this.checkLikePattern.bind(this),
      this.checkOrderByWithoutIndex.bind(this),
      this.checkSubquery.bind(this),
      this.checkDistinct.bind(this)
    ];
  }

  async analyze(query, explainResult) {
    const issues = [];
    const suggestions = [];
    
    // 运行所有分析规则
    for (const rule of this.analysisRules) {
      try {
        const result = await rule(query, explainResult);
        if (result) {
          issues.push(result.issue);
          suggestions.push(result.suggestion);
        }
      } catch (error) {
        logger.warn('Analysis rule failed', { 
          rule: rule.name, 
          error: error.message 
        });
      }
    }
    
    return {
      queryId: query.queryid,
      queryText: query.query,
      issues,
      suggestions,
      severity: this.calculateSeverity(issues),
      analyzedAt: new Date()
    };
  }

  checkMissingIndex(query, explainResult) {
    // 检查 EXPLAIN 中的 Seq Scan
    const planStr = JSON.stringify(explainResult);
    
    if (planStr.includes('Seq Scan') && query.mean_time > 500) {
      // 提取表名
      const tableMatch = query.query.match(/FROM\s+(\w+)/i);
      const tableName = tableMatch ? tableMatch[1] : 'unknown';
      
      // 提取 WHERE 条件中的列
      const whereMatch = query.query.match(/WHERE\s+(.+?)(?:ORDER|GROUP|LIMIT|$)/i);
      const whereClause = whereMatch ? whereMatch[1] : '';
      const columns = this.extractColumns(whereClause);
      
      return {
        issue: {
          type: 'missing_index',
          severity: 'high',
          table: tableName,
          columns: columns,
          impact: `Sequential scan on ${tableName}, avg ${query.mean_time}ms`
        },
        suggestion: {
          type: 'create_index',
          sql: this.generateIndexSQL(tableName, columns),
          reason: 'Add index to avoid full table scan',
          estimatedImprovement: '70-90% query time reduction'
        }
      };
    }
    return null;
  }

  checkFullTableScan(query, explainResult) {
    const planStr = JSON.stringify(explainResult);
    
    // 检查大表全表扫描
    if (planStr.includes('Seq Scan') && query.rows > 10000) {
      return {
        issue: {
          type: 'full_table_scan',
          severity: 'critical',
          rowsScanned: query.rows,
          impact: `Scanning ${query.rows} rows without filter`
        },
        suggestion: {
          type: 'add_where_clause',
          reason: 'Add WHERE clause to limit scanned rows',
          estimatedImprovement: '90%+ row reduction'
        }
      };
    }
    return null;
  }

  checkInefficientJoin(query, explainResult) {
    const planStr = JSON.stringify(explainResult);
    
    // 检查 Nested Loop 在大表上的使用
    if (planStr.includes('Nested Loop') && query.mean_time > 1000) {
      const joinCount = (query.query.match(/JOIN/gi) || []).length;
      
      if (joinCount > 2) {
        return {
          issue: {
            type: 'inefficient_join',
            severity: 'medium',
            joinCount,
            impact: 'Multiple joins causing performance degradation'
          },
          suggestion: {
            type: 'optimize_join',
            reason: 'Consider denormalization or materialized view',
            estimatedImprovement: '50-70% query time reduction'
          }
        };
      }
    }
    return null;
  }

  checkMissingWhereClause(query) {
    // 检查没有 WHERE 子句的查询
    if (!query.query.match(/WHERE/i) && 
        (query.query.match(/SELECT/i) && query.query.match(/FROM/i))) {
      return {
        issue: {
          type: 'missing_where_clause',
          severity: 'high',
          impact: 'Query without filter conditions'
        },
        suggestion: {
          type: 'add_filter',
          reason: 'Add WHERE clause to limit result set',
          estimatedImprovement: 'Variable, depends on data volume'
        }
      };
    }
    return null;
  }

  checkSelectStar(query) {
    // 检查 SELECT *
    if (query.query.match(/SELECT\s+\*\s+FROM/i)) {
      return {
        issue: {
          type: 'select_star',
          severity: 'medium',
          impact: 'Fetching all columns unnecessarily'
        },
        suggestion: {
          type: 'explicit_columns',
          reason: 'Specify required columns instead of SELECT *',
          estimatedImprovement: '20-40% bandwidth reduction'
        }
      };
    }
    return null;
  }

  checkOrCondition(query) {
    // 检查 OR 条件可能导致索引失效
    const orCount = (query.query.match(/\bOR\b/gi) || []).length;
    
    if (orCount > 2 && query.mean_time > 500) {
      return {
        issue: {
          type: 'or_condition',
          severity: 'medium',
          orCount,
          impact: 'OR conditions may prevent index usage'
        },
        suggestion: {
          type: 'use_union',
          sql: this.suggestUnion(query.query),
          reason: 'Convert OR to UNION for better index utilization',
          estimatedImprovement: '50-80% query time reduction'
        }
      };
    }
    return null;
  }

  checkLikePattern(query) {
    // 检查 LIKE '%pattern%' 导致索引失效
    if (query.query.match(/LIKE\s+['"]%/i)) {
      return {
        issue: {
          type: 'leading_wildcard',
          severity: 'medium',
          impact: 'Leading wildcard prevents index usage'
        },
        suggestion: {
          type: 'use_full_text_search',
          reason: 'Consider PostgreSQL full-text search or trigram index',
          estimatedImprovement: '60-80% search improvement'
        }
      };
    }
    return null;
  }

  checkOrderByWithoutIndex(query, explainResult) {
    const planStr = JSON.stringify(explainResult);
    
    // 检查 filesort
    if (planStr.includes('Sort') && query.query.match(/ORDER BY/i)) {
      const orderMatch = query.query.match(/ORDER\s+BY\s+(\w+)/i);
      const orderColumn = orderMatch ? orderMatch[1] : 'unknown';
      
      return {
        issue: {
          type: 'orderby_without_index',
          severity: 'medium',
          column: orderColumn,
          impact: 'In-memory sort operation'
        },
        suggestion: {
          type: 'add_orderby_index',
          sql: `CREATE INDEX idx_${orderColumn} ON table_name (${orderColumn})`,
          reason: 'Add index on ORDER BY column',
          estimatedImprovement: '40-60% sort time reduction'
        }
      };
    }
    return null;
  }

  checkSubquery(query) {
    // 检查子查询
    const subqueryCount = (query.query.match(/\(SELECT/gi) || []).length;
    
    if (subqueryCount > 1 && query.mean_time > 1000) {
      return {
        issue: {
          type: 'subquery',
          severity: 'medium',
          subqueryCount,
          impact: 'Multiple nested subqueries'
        },
        suggestion: {
          type: 'use_join',
          reason: 'Convert subqueries to JOINs for better performance',
          estimatedImprovement: '30-50% query time reduction'
        }
      };
    }
    return null;
  }

  checkDistinct(query) {
    // 检查 DISTINCT 可能导致的性能问题
    if (query.query.match(/DISTINCT/i) && query.mean_time > 500) {
      return {
        issue: {
          type: 'distinct_overhead',
          severity: 'low',
          impact: 'DISTINCT operation requires sorting/hashing'
        },
        suggestion: {
          type: 'check_duplicate_data',
          reason: 'Ensure DISTINCT is necessary, consider EXISTS instead',
          estimatedImprovement: '10-30% overhead reduction'
        }
      };
    }
    return null;
  }

  extractColumns(whereClause) {
    const columnPattern = /(\w+)\s*(?:=|>|<|>=|<=|LIKE|IN)/gi;
    const columns = [];
    let match;
    
    while ((match = columnPattern.exec(whereClause)) !== null) {
      if (!columns.includes(match[1])) {
        columns.push(match[1]);
      }
    }
    
    return columns;
  }

  generateIndexSQL(tableName, columns) {
    if (columns.length === 0) {
      return `-- Cannot generate index: no columns detected`;
    }
    
    const indexName = `idx_${tableName}_${columns.join('_')}`;
    return `CREATE INDEX ${indexName} ON ${tableName} (${columns.join(', ')})`;
  }

  suggestUnion(query) {
    // 简化示例：建议将 OR 转换为 UNION
    return `-- Consider converting OR conditions to UNION:
-- SELECT ... WHERE condition1
-- UNION
-- SELECT ... WHERE condition2`;
  }

  calculateSeverity(issues) {
    if (issues.some(i => i.severity === 'critical')) return 'critical';
    if (issues.some(i => i.severity === 'high')) return 'high';
    if (issues.some(i => i.severity === 'medium')) return 'medium';
    return 'low';
  }
}

module.exports = QueryAnalyzer;
```

### 3. 自动优化建议生成器

```javascript
// backend/shared/optimizationAdvisor.js

const logger = require('./logger');
const { callApi } = require('./apiClient');

class OptimizationAdvisor {
  constructor(config = {}) {
    this.dbConfig = config.dbConfig;
    this.openaiApiKey = config.openaiApiKey;
    this.enableAutoApply = config.enableAutoApply || false;
  }

  async generateRecommendations(analysisResult) {
    const recommendations = [];
    
    // 基于分析结果生成建议
    for (const suggestion of analysisResult.suggestions) {
      const recommendation = await this.buildRecommendation(
        analysisResult.queryId,
        suggestion
      );
      recommendations.push(recommendation);
    }
    
    // 排序按影响程度
    recommendations.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
    
    return recommendations;
  }

  async buildRecommendation(queryId, suggestion) {
    const recommendation = {
      queryId,
      type: suggestion.type,
      severity: suggestion.severity || 'medium',
      sql: suggestion.sql,
      reason: suggestion.reason,
      estimatedImprovement: suggestion.estimatedImprovement,
      createdAt: new Date(),
      status: 'pending'
    };
    
    // 如果是索引建议，验证索引是否已存在
    if (suggestion.type === 'create_index') {
      recommendation.conflictCheck = await this.checkIndexConflict(suggestion.sql);
    }
    
    // 存储建议
    await this.storeRecommendation(recommendation);
    
    return recommendation;
  }

  async checkIndexConflict(indexSQL) {
    const { Client } = require('pg');
    const client = new Client(this.dbConfig);
    await client.connect();
    
    try {
      // 提取索引名
      const indexNameMatch = indexSQL.match(/CREATE\s+INDEX\s+(\w+)/i);
      if (!indexNameMatch) return { hasConflict: false };
      
      const indexName = indexNameMatch[1];
      
      // 检查索引是否存在
      const result = await client.query(`
        SELECT indexname, indexdef 
        FROM pg_indexes 
        WHERE indexname = $1
      `, [indexName]);
      
      if (result.rows.length > 0) {
        return {
          hasConflict: true,
          existingIndex: result.rows[0].indexdef
        };
      }
      
      // 检查相似索引
      const tableMatch = indexSQL.match(/ON\s+(\w+)/i);
      const columnMatch = indexSQL.match(/\(([^)]+)\)/);
      
      if (tableMatch && columnMatch) {
        const tableName = tableMatch[1];
        const columns = columnMatch[1].split(',').map(c => c.trim());
        
        const similarResult = await client.query(`
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE tablename = $1
        `, [tableName]);
        
        for (const row of similarResult.rows) {
          const existingColumns = this.extractIndexColumns(row.indexdef);
          if (this.isOverlappingIndex(columns, existingColumns)) {
            return {
              hasConflict: true,
              existingIndex: row.indexdef,
              overlapReason: 'Similar index already exists'
            };
          }
        }
      }
      
      return { hasConflict: false };
      
    } finally {
      await client.end();
    }
  }

  extractIndexColumns(indexDef) {
    const match = indexDef.match(/\(([^)]+)\)/);
    return match ? match[1].split(',').map(c => c.trim()) : [];
  }

  isOverlappingIndex(newColumns, existingColumns) {
    // 检查是否新索引是已有索引的前缀
    if (newColumns.length <= existingColumns.length) {
      const prefix = existingColumns.slice(0, newColumns.length);
      return newColumns.every((col, i) => col === prefix[i]);
    }
    return false;
  }

  async storeRecommendation(recommendation) {
    const { Client } = require('pg');
    const client = new Client(this.dbConfig);
    await client.connect();
    
    try {
      await client.query(`
        INSERT INTO query_optimization_recommendations (
          query_id, type, severity, sql, reason, 
          estimated_improvement, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        recommendation.queryId,
        recommendation.type,
        recommendation.severity,
        recommendation.sql,
        recommendation.reason,
        recommendation.estimatedImprovement,
        recommendation.status,
        recommendation.createdAt
      ]);
    } finally {
      await client.end();
    }
  }

  async applyRecommendation(recommendationId) {
    const { Client } = require('pg');
    const client = new Client(this.dbConfig);
    await client.connect();
    
    try {
      // 获取建议
      const result = await client.query(`
        SELECT * FROM query_optimization_recommendations
        WHERE id = $1 AND status = 'pending'
      `, [recommendationId]);
      
      if (result.rows.length === 0) {
        throw new Error('Recommendation not found or already applied');
      }
      
      const recommendation = result.rows[0];
      
      // 执行 SQL
      await client.query('BEGIN');
      
      try {
        await client.query(recommendation.sql);
        
        // 更新状态
        await client.query(`
          UPDATE query_optimization_recommendations
          SET status = 'applied', applied_at = NOW()
          WHERE id = $1
        `, [recommendationId]);
        
        await client.query('COMMIT');
        
        logger.info('Recommendation applied', { 
          recommendationId,
          type: recommendation.type 
        });
        
        return { success: true };
        
      } catch (error) {
        await client.query('ROLLBACK');
        
        // 更新状态为失败
        await client.query(`
          UPDATE query_optimization_recommendations
          SET status = 'failed', error_message = $1
          WHERE id = $1
        `, [error.message, recommendationId]);
        
        throw error;
      }
      
    } finally {
      await client.end();
    }
  }

  async generateReport() {
    const { Client } = require('pg');
    const client = new Client(this.dbConfig);
    await client.connect();
    
    try {
      // 获取慢查询统计
      const slowQueryStats = await client.query(`
        SELECT 
          DATE(collected_at) as date,
          COUNT(*) as total_slow_queries,
          AVG(mean_time_ms) as avg_query_time,
          MAX(mean_time_ms) as max_query_time,
          COUNT(DISTINCT query_id) as unique_queries
        FROM slow_query_log
        WHERE collected_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE(collected_at)
        ORDER BY date DESC
      `);
      
      // 获取建议统计
      const recommendationStats = await client.query(`
        SELECT 
          type,
          severity,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'applied' THEN 1 ELSE 0 END) as applied,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
        FROM query_optimization_recommendations
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY type, severity
        ORDER BY severity, type
      `);
      
      // 获取 Top 慢查询
      const topSlowQueries = await client.query(`
        SELECT 
          query_id,
          query_text,
          AVG(mean_time_ms) as avg_time,
          SUM(calls) as total_calls,
          AVG(cache_hit_ratio) as avg_cache_hit
        FROM slow_query_log
        WHERE collected_at > NOW() - INTERVAL '24 hours'
        GROUP BY query_id, query_text
        ORDER BY avg_time DESC
        LIMIT 10
      `);
      
      return {
        period: '7 days',
        slowQueryStats: slowQueryStats.rows,
        recommendationStats: recommendationStats.rows,
        topSlowQueries: topSlowQueries.rows,
        generatedAt: new Date()
      };
      
    } finally {
      await client.end();
    }
  }
}

module.exports = OptimizationAdvisor;
```

### 4. 性能监控仪表板 API

```javascript
// backend/gateway/src/routes/queryPerformance.js

const express = require('express');
const router = express.Router();
const SlowQueryCollector = require('../../shared/slowQueryCollector');
const QueryAnalyzer = require('../../shared/queryAnalyzer');
const OptimizationAdvisor = require('../../shared/optimizationAdvisor');
const authMiddleware = require('../middleware/auth');
const { incrementCounter, observeHistogram } = require('../../shared/metrics');

// 初始化
const collector = new SlowQueryCollector({
  dbConfig: process.env.DATABASE_URL,
  slowThreshold: parseInt(process.env.SLOW_QUERY_THRESHOLD) || 1000
});

const analyzer = new QueryAnalyzer();
const advisor = new OptimizationAdvisor({
  dbConfig: process.env.DATABASE_URL
});

// GET /api/query-performance/overview
router.get('/overview', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const report = await advisor.generateReport();
    
    incrementCounter('api_query_performance_overview_total');
    
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

// GET /api/query-performance/slow-queries
router.get('/slow-queries', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { 
      limit = 50, 
      offset = 0, 
      minTime = 0,
      startDate,
      endDate 
    } = req.query;
    
    const { Client } = require('pg');
    const client = new Client(process.env.DATABASE_URL);
    await client.connect();
    
    try {
      const result = await client.query(`
        SELECT 
          query_id,
          query_text,
          calls,
          total_time_ms,
          mean_time_ms,
          min_time_ms,
          max_time_ms,
          rows_affected,
          cache_hit_ratio,
          collected_at
        FROM slow_query_log
        WHERE mean_time_ms >= $1
          AND ($2::date IS NULL OR collected_at >= $2)
          AND ($3::date IS NULL OR collected_at <= $3)
        ORDER BY mean_time_ms DESC
        LIMIT $4 OFFSET $5
      `, [minTime, startDate || null, endDate || null, limit, offset]);
      
      const countResult = await client.query(`
        SELECT COUNT(DISTINCT query_id) as total
        FROM slow_query_log
        WHERE mean_time_ms >= $1
          AND ($2::date IS NULL OR collected_at >= $2)
          AND ($3::date IS NULL OR collected_at <= $3)
      `, [minTime, startDate || null, endDate || null]);
      
      res.json({
        success: true,
        data: {
          queries: result.rows,
          pagination: {
            total: parseInt(countResult.rows[0].total),
            limit: parseInt(limit),
            offset: parseInt(offset)
          }
        }
      });
      
    } finally {
      await client.end();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// GET /api/query-performance/recommendations
router.get('/recommendations', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { status, severity, limit = 50 } = req.query;
    
    const { Client } = require('pg');
    const client = new Client(process.env.DATABASE_URL);
    await client.connect();
    
    try {
      let query = `
        SELECT 
          id,
          query_id,
          type,
          severity,
          sql,
          reason,
          estimated_improvement,
          status,
          created_at,
          applied_at
        FROM query_optimization_recommendations
        WHERE 1=1
      `;
      
      const params = [];
      if (status) {
        params.push(status);
        query += ` AND status = $${params.length}`;
      }
      if (severity) {
        params.push(severity);
        query += ` AND severity = $${params.length}`;
      }
      
      query += ` ORDER BY 
        CASE severity 
          WHEN 'critical' THEN 1 
          WHEN 'high' THEN 2 
          WHEN 'medium' THEN 3 
          ELSE 4 
        END,
        created_at DESC
        LIMIT $${params.length + 1}
      `;
      params.push(parseInt(limit));
      
      const result = await client.query(query, params);
      
      res.json({
        success: true,
        data: result.rows
      });
      
    } finally {
      await client.end();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/query-performance/recommendations/:id/apply
router.post('/recommendations/:id/apply', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const startTime = Date.now();
    
    const result = await advisor.applyRecommendation(req.params.id);
    
    observeHistogram('query_optimization_apply_duration_seconds', 
      (Date.now() - startTime) / 1000);
    incrementCounter('query_optimization_applied_total');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    incrementCounter('query_optimization_apply_errors_total');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/query-performance/analyze/:queryId
router.post('/analyze/:queryId', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { Client } = require('pg');
    const client = new Client(process.env.DATABASE_URL);
    await client.connect();
    
    try {
      // 获取查询信息
      const queryResult = await client.query(`
        SELECT * FROM slow_query_log 
        WHERE query_id = $1 
        ORDER BY collected_at DESC 
        LIMIT 1
      `, [req.params.queryId]);
      
      if (queryResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Query not found'
        });
      }
      
      const query = queryResult.rows[0];
      
      // 执行 EXPLAIN ANALYZE
      const explainResult = await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query_text.substring(0, 1000)}`
      );
      
      // 分析查询
      const analysis = await analyzer.analyze(query, explainResult.rows[0]);
      
      // 生成建议
      const recommendations = await advisor.generateRecommendations(analysis);
      
      res.json({
        success: true,
        data: {
          query,
          explainPlan: explainResult.rows[0],
          analysis,
          recommendations
        }
      });
      
    } finally {
      await client.end();
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/query-performance/collector/start
router.post('/collector/start', authMiddleware.requireAdmin, async (req, res) => {
  try {
    await collector.start();
    
    res.json({
      success: true,
      message: 'Slow query collector started'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/query-performance/collector/stop
router.post('/collector/stop', authMiddleware.requireAdmin, async (req, res) => {
  try {
    await collector.stop();
    
    res.json({
      success: true,
      message: 'Slow query collector stopped'
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

### 5. 数据库迁移脚本

```sql
-- database/pending/20260609_220000__add_slow_query_analysis_system.sql

-- 慢查询日志表
CREATE TABLE IF NOT EXISTS slow_query_log (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL,
  query_text TEXT NOT NULL,
  calls BIGINT,
  total_time_ms DOUBLE PRECISION,
  mean_time_ms DOUBLE PRECISION,
  min_time_ms DOUBLE PRECISION,
  max_time_ms DOUBLE PRECISION,
  rows_affected BIGINT,
  cache_hit_ratio DOUBLE PRECISION,
  collected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- 索引
  INDEX idx_slow_query_query_id (query_id),
  INDEX idx_slow_query_collected_at (collected_at),
  INDEX idx_slow_query_mean_time (mean_time_ms)
);

-- 查询优化建议表
CREATE TABLE IF NOT EXISTS query_optimization_recommendations (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL,
  type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,
  sql TEXT,
  reason TEXT,
  estimated_improvement VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending',
  conflict_check JSONB,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  applied_at TIMESTAMP WITH TIME ZONE,
  
  CONSTRAINT valid_severity CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'applied', 'failed', 'dismissed'))
);

CREATE INDEX idx_recommendations_query_id ON query_optimization_recommendations(query_id);
CREATE INDEX idx_recommendations_status ON query_optimization_recommendations(status);
CREATE INDEX idx_recommendations_severity ON query_optimization_recommendations(severity);

-- 查询性能历史表
CREATE TABLE IF NOT EXISTS query_performance_history (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL,
  snapshot_date DATE NOT NULL,
  total_calls BIGINT,
  avg_time_ms DOUBLE PRECISION,
  max_time_ms DOUBLE PRECISION,
  min_time_ms DOUBLE PRECISION,
  total_time_ms DOUBLE PRECISION,
  cache_hit_ratio DOUBLE PRECISION,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(query_id, snapshot_date)
);

CREATE INDEX idx_performance_history_date ON query_performance_history(snapshot_date);

-- 性能基线表
CREATE TABLE IF NOT EXISTS query_performance_baseline (
  id SERIAL PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL UNIQUE,
  query_pattern TEXT,
  baseline_avg_time_ms DOUBLE PRECISION,
  baseline_max_time_ms DOUBLE PRECISION,
  baseline_calls_per_day BIGINT,
  last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 告警配置表
CREATE TABLE IF NOT EXISTS query_alert_config (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  metric_type VARCHAR(50) NOT NULL,
  threshold DOUBLE PRECISION NOT NULL,
  comparison VARCHAR(10) NOT NULL,
  enabled BOOLEAN DEFAULT TRUE,
  notification_channels JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  CONSTRAINT valid_comparison CHECK (comparison IN ('gt', 'lt', 'gte', 'lte', 'eq'))
);

-- 插入默认告警配置
INSERT INTO query_alert_config (name, metric_type, threshold, comparison, notification_channels) VALUES
('Slow Query Alert', 'mean_time_ms', 5000, 'gt', '{"channels": ["slack", "email"]}'::jsonb),
('High Query Volume', 'calls_per_minute', 1000, 'gt', '{"channels": ["slack"]}'::jsonb),
('Low Cache Hit Ratio', 'cache_hit_ratio', 0.8, 'lt', '{"channels": ["email"]}'::jsonb);

-- 分区表（按日期分区）
CREATE TABLE IF NOT EXISTS slow_query_log_partitioned (
  LIKE slow_query_log INCLUDING DEFAULTS INCLUDING CONSTRAINTS
) PARTITION BY RANGE (collected_at);

-- 创建初始分区
CREATE TABLE slow_query_log_202606 PARTITION OF slow_query_log_partitioned
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE slow_query_log_202607 PARTITION OF slow_query_log_partitioned
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- 视图：慢查询摘要
CREATE OR REPLACE VIEW slow_query_summary AS
SELECT 
  query_id,
  LEFT(query_text, 200) as query_preview,
  COUNT(*) as occurrence_count,
  AVG(mean_time_ms) as avg_time_ms,
  MAX(mean_time_ms) as max_time_ms,
  MIN(mean_time_ms) as min_time_ms,
  SUM(calls) as total_calls,
  AVG(cache_hit_ratio) as avg_cache_hit_ratio
FROM slow_query_log
WHERE collected_at > NOW() - INTERVAL '7 days'
GROUP BY query_id, LEFT(query_text, 200)
ORDER BY avg_time_ms DESC;

-- 函数：自动创建分区
CREATE OR REPLACE FUNCTION create_monthly_partition(base_table TEXT, partition_month DATE)
RETURNS VOID AS $$
DECLARE
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_name := base_table || '_' || TO_CHAR(partition_month, 'YYYYMM');
  start_date := DATE_TRUNC('month', partition_month);
  end_date := start_date + INTERVAL '1 month';
  
  EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name, base_table, start_date, end_date);
END;
$$ LANGUAGE plpgsql;

-- 注释
COMMENT ON TABLE slow_query_log IS '存储慢查询日志，用于性能分析';
COMMENT ON TABLE query_optimization_recommendations IS '查询优化建议记录';
COMMENT ON TABLE query_performance_history IS '查询性能历史数据';
COMMENT ON TABLE query_performance_baseline IS '查询性能基线';
COMMENT ON TABLE query_alert_config IS '查询性能告警配置';
```

### 6. Prometheus 指标定义

```javascript
// backend/shared/metrics.js 扩展

// 慢查询相关指标
const slowQueryTotal = new Counter({
  name: 'slow_query_total',
  help: 'Total number of slow queries detected',
  labelNames: ['query_id', 'service']
});

const queryDurationSeconds = new Histogram({
  name: 'query_duration_seconds',
  help: 'Query duration in seconds',
  labelNames: ['query_id', 'service'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60]
});

const queryCacheHitRatio = new Histogram({
  name: 'query_cache_hit_ratio',
  help: 'Database query cache hit ratio',
  labelNames: ['query_id'],
  buckets: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99]
});

const queryOptimizationRecommendationsTotal = new Gauge({
  name: 'query_optimization_recommendations_total',
  help: 'Total number of optimization recommendations',
  labelNames: ['severity', 'status']
});

const queryOptimizationAppliedTotal = new Counter({
  name: 'query_optimization_applied_total',
  help: 'Total number of optimization recommendations applied'
});

const queryOptimizationApplyDuration = new Histogram({
  name: 'query_optimization_apply_duration_seconds',
  help: 'Duration of applying optimization recommendations',
  buckets: [0.1, 0.5, 1, 5, 10]
});
```

## 验收标准

- [ ] 慢查询日志采集系统能够实时采集慢查询（响应时间 > 1秒）
- [ ] 查询分析引擎能够识别至少 10 种查询问题类型
- [ ] 自动优化建议生成器能够为慢查询生成有效的索引建议
- [ ] 性能监控仪表板 API 提供完整的查询性能数据查询接口
- [ ] 支持优化建议的一键应用和回滚
- [ ] Prometheus 指标暴露查询性能相关指标
- [ ] 数据库迁移脚本创建所有必需的表和索引
- [ ] 支持按日期分区的慢查询日志存储
- [ ] 单元测试覆盖率达到 80% 以上
- [ ] 文档完整，包括 API 文档和使用指南

## 影响范围

- database/pending/ (新增迁移脚本)
- backend/shared/slowQueryCollector.js (新增)
- backend/shared/queryAnalyzer.js (新增)
- backend/shared/optimizationAdvisor.js (新增)
- backend/gateway/src/routes/queryPerformance.js (新增)
- backend/shared/metrics.js (扩展)
- backend/tests/unit/slow-query-analysis.test.js (新增)
- docs/database/slow-query-analysis.md (新增)
- infrastructure/k8s/monitoring/grafana-dashboards/query-performance.json (新增)

## 参考

- [PostgreSQL pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html)
- [PostgreSQL Query Tuning](https://www.postgresql.org/docs/current/performance-tips.html)
- [EXPLAIN ANALYZE Guide](https://www.postgresql.org/docs/current/using-explain.html)
- [Database Index Design](https://use-the-index-luke.com/)
