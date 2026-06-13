/**
 * backend/shared/routes/slowQuery.js
 * REQ-00077: 数据库慢查询分析与自动优化建议系统
 * API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const SlowQueryCollector = require('../slowQueryCollector');
const QueryPlanAnalyzer = require('../queryPlanAnalyzer');
const IndexUsageAnalyzer = require('../indexUsageAnalyzer');
const QueryAnalyzer = require('../queryAnalyzer');
const { query, getPool } = require('../db');
const logger = require('../logger');

let collector = null;
let planAnalyzer = null;
let indexAnalyzer = null;
let queryAnalyzer = null;

/**
 * 初始化分析器
 */
async function initializeAnalyzers() {
  const pool = getPool();
  
  if (!collector) {
    collector = new SlowQueryCollector.getCollector({
      dbConfig: {
        connectionString: process.env.DATABASE_URL
      }
    });
  }
  
  if (!planAnalyzer) {
    planAnalyzer = new QueryPlanAnalyzer(pool);
  }
  
  if (!indexAnalyzer) {
    indexAnalyzer = new IndexUsageAnalyzer(pool);
  }
  
  if (!queryAnalyzer) {
    queryAnalyzer = new QueryAnalyzer();
  }
}

/**
 * GET /api/slow-query/stats
 * 获取慢查询统计
 */
router.get('/stats', async (req, res) => {
  try {
    await initializeAnalyzers();
    const stats = collector.getStatus();
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Failed to get slow query stats', { error: error.message });
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
    const limit = parseInt(req.query.limit) || 10;
    
    const result = await query(`
      SELECT 
        query_id,
        query_text,
        calls,
        total_time_ms,
        mean_time_ms,
        rows_affected,
        cache_hit_ratio,
        collected_at
      FROM slow_query_log
      ORDER BY mean_time_ms DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    // 如果表不存在，尝试从 pg_stat_statements 获取
    try {
      const pgResult = await query(`
        SELECT 
          queryid as query_id,
          query as query_text,
          calls,
          total_exec_time as total_time_ms,
          mean_exec_time as mean_time_ms,
          rows as rows_affected
        FROM pg_stat_statements
        ORDER BY mean_exec_time DESC
        LIMIT $1
      `, [parseInt(req.query.limit) || 10]);
      
      res.json({
        success: true,
        data: pgResult.rows,
        source: 'pg_stat_statements'
      });
    } catch (pgError) {
      logger.error('Failed to get top slow queries', { error: pgError.message });
      res.status(500).json({
        success: false,
        error: 'Could not retrieve slow queries'
      });
    }
  }
});

/**
 * POST /api/slow-query/analyze
 * 分析指定查询的执行计划
 */
router.post('/analyze', async (req, res) => {
  try {
    await initializeAnalyzers();
    const { query: sqlQuery, params } = req.body;

    if (!sqlQuery) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    const analysis = await planAnalyzer.analyze(sqlQuery, params || []);
    
    res.json({
      success: true,
      data: analysis
    });
  } catch (error) {
    logger.error('Failed to analyze query', { error: error.message });
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
    logger.error('Failed to analyze indexes', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/slow-query/indexes/report
 * 获取索引优化报告
 */
router.get('/indexes/report', async (req, res) => {
  try {
    await initializeAnalyzers();
    const analysis = await indexAnalyzer.analyze();
    const report = indexAnalyzer.generateReport(analysis);
    
    res.set('Content-Type', 'text/plain');
    res.send(report);
  } catch (error) {
    logger.error('Failed to generate index report', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/slow-query/indexes/table/:tableName
 * 获取特定表的索引信息
 */
router.get('/indexes/table/:tableName', async (req, res) => {
  try {
    await initializeAnalyzers();
    const { tableName } = req.params;
    const indexes = await indexAnalyzer.getTableIndexes(tableName);
    
    res.json({
      success: true,
      data: indexes
    });
  } catch (error) {
    logger.error('Failed to get table indexes', { error: error.message });
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
    
    // 获取慢查询
    const slowQueryResult = await query(`
      SELECT 
        query_id,
        query_text,
        calls,
        total_time_ms,
        mean_time_ms,
        rows_affected,
        cache_hit_ratio,
        collected_at
      FROM slow_query_log
      ORDER BY mean_time_ms DESC
      LIMIT 10
    `).catch(() => ({ rows: [] }));

    // 获取索引分析
    const indexAnalysis = await indexAnalyzer.analyze();

    const report = {
      generatedAt: new Date().toISOString(),
      summary: {
        slowQueries: slowQueryResult.rows.length,
        indexUsage: {
          total: indexAnalysis.totalIndexes,
          used: indexAnalysis.usedIndexes,
          unused: indexAnalysis.unusedIndexes,
          duplicate: indexAnalysis.duplicateIndexes
        }
      },
      topSlowQueries: slowQueryResult.rows,
      unusedIndexes: indexAnalysis.details.unusedIndexes,
      duplicateIndexes: indexAnalysis.details.duplicateIndexes,
      suggestedIndexes: indexAnalysis.details.suggestedIndexes,
      indexBloat: indexAnalysis.details.indexBloat
    };

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Failed to generate report', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/slow-query/collect
 * 手动触发慢查询采集
 */
router.post('/collect', async (req, res) => {
  try {
    await initializeAnalyzers();
    const result = await collector.manualCollect();
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to collect slow queries', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/slow-query/metrics
 * 获取慢查询相关指标
 */
router.get('/metrics', async (req, res) => {
  try {
    // 获取数据库统计
    const dbStats = await query(`
      SELECT 
        count(*) as total_queries,
        avg(mean_exec_time) as avg_execution_time,
        max(mean_exec_time) as max_execution_time,
        sum(calls) as total_calls
      FROM pg_stat_statements
      WHERE query NOT LIKE '%pg_stat%'
    `).catch(() => ({ rows: [] }));

    // 获取缓存命中率
    const cacheStats = await query(`
      SELECT 
        sum(heap_blks_hit) as hits,
        sum(heap_blks_read) as reads
      FROM pg_statio_user_tables
    `).catch(() => ({ rows: [] }));

    const cacheHit = cacheStats.rows[0];
    const hitRate = cacheHit && (cacheHit.hits + cacheHit.reads) > 0
      ? cacheHit.hits / (cacheHit.hits + cacheHit.reads)
      : 0;

    res.json({
      success: true,
      data: {
        queries: dbStats.rows[0] || {},
        cacheHitRate: hitRate
      }
    });
  } catch (error) {
    logger.error('Failed to get metrics', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/slow-query/explain
 * 执行 EXPLAIN ANALYZE
 */
router.post('/explain', async (req, res) => {
  try {
    const { query: sqlQuery, params } = req.body;

    if (!sqlQuery) {
      return res.status(400).json({
        success: false,
        error: 'Query is required'
      });
    }

    // 只允许 SELECT 查询
    if (!sqlQuery.trim().toUpperCase().startsWith('SELECT')) {
      return res.status(400).json({
        success: false,
        error: 'Only SELECT queries are allowed for safety'
      });
    }

    const result = await query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sqlQuery}`, params || []);
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    logger.error('Failed to execute EXPLAIN', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/slow-query/suggestions
 * 获取优化建议
 */
router.get('/suggestions', async (req, res) => {
  try {
    await initializeAnalyzers();
    
    const indexAnalysis = await indexAnalyzer.analyze();
    
    const suggestions = [];

    // 未使用索引建议
    for (const idx of indexAnalysis.details.unusedIndexes.slice(0, 5)) {
      suggestions.push({
        type: 'drop_index',
        priority: 'low',
        tableName: idx.tableName,
        indexName: idx.indexName,
        reason: idx.reason,
        sql: `DROP INDEX IF EXISTS ${idx.indexName};`
      });
    }

    // 建议创建的索引
    for (const sug of indexAnalysis.details.suggestedIndexes.slice(0, 5)) {
      suggestions.push({
        type: 'create_index',
        priority: 'medium',
        column: sug.columnSuggestion,
        reason: sug.reason,
        sql: `-- Consider: CREATE INDEX idx_${sug.columnSuggestion} ON table_name (${sug.columnSuggestion});`
      });
    }

    // 重复索引建议
    for (const dup of indexAnalysis.details.duplicateIndexes.slice(0, 5)) {
      suggestions.push({
        type: 'drop_duplicate',
        priority: 'medium',
        tableName: dup.tableName,
        indexName: dup.index2Name,
        reason: `Duplicate of ${dup.index1Name}`,
        sql: `DROP INDEX IF EXISTS ${dup.index2Name};`
      });
    }

    res.json({
      success: true,
      data: {
        total: suggestions.length,
        suggestions
      }
    });
  } catch (error) {
    logger.error('Failed to get suggestions', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
