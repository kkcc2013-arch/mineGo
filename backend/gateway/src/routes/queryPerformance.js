/**
 * backend/gateway/src/routes/queryPerformance.js
 * REQ-00063: 数据库慢查询分析与自动优化建议系统
 * 性能监控仪表板 API
 */

'use strict';

const express = require('express');
const router = express.Router();
const { SlowQueryCollector, getCollector } = require('../../shared/slowQueryCollector');
const QueryAnalyzer = require('../../shared/queryAnalyzer');
const OptimizationAdvisor = require('../../shared/optimizationAdvisor');
const { Client } = require('pg');
const logger = require('../../shared/logger');
const { incrementCounter, observeHistogram } = require('../../shared/metrics');

// 数据库配置
const getDbConfig = () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'minego',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

// 初始化组件
let collectorInstance = null;
let analyzerInstance = null;
let advisorInstance = null;

function getComponents() {
  const dbConfig = getDbConfig();
  
  if (!collectorInstance) {
    collectorInstance = getCollector({
      dbConfig,
      slowThreshold: parseInt(process.env.SLOW_QUERY_THRESHOLD) || 1000
    });
  }
  
  if (!analyzerInstance) {
    analyzerInstance = new QueryAnalyzer();
  }
  
  if (!advisorInstance) {
    advisorInstance = new OptimizationAdvisor({ dbConfig });
  }
  
  return { collector: collectorInstance, analyzer: analyzerInstance, advisor: advisorInstance };
}

/**
 * 简单的管理员认证中间件
 */
function requireAdmin(req, res, next) {
  // 在生产环境中应该使用更严格的认证
  const adminKey = req.headers['x-admin-key'] || req.query.adminKey;
  
  if (process.env.NODE_ENV === 'production') {
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
  }
  
  next();
}

/**
 * GET /api/query-performance/overview
 * 获取性能概览
 */
router.get('/overview', requireAdmin, async (req, res) => {
  try {
    const { advisor } = getComponents();
    const report = await advisor.generateReport();
    
    incrementCounter('api_query_performance_overview_total');
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Failed to generate overview', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/query-performance/slow-queries
 * 获取慢查询列表
 */
router.get('/slow-queries', requireAdmin, async (req, res) => {
  try {
    const { 
      limit = 50, 
      offset = 0, 
      minTime = 0,
      startDate,
      endDate 
    } = req.query;
    
    const client = new Client(getDbConfig());
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
      `, [minTime, startDate || null, endDate || null, parseInt(limit), parseInt(offset)]);
      
      const countResult = await client.query(`
        SELECT COUNT(DISTINCT query_id) as total
        FROM slow_query_log
        WHERE mean_time_ms >= $1
          AND ($2::date IS NULL OR collected_at >= $2)
          AND ($3::date IS NULL OR collected_at <= $3)
      `, [minTime, startDate || null, endDate || null]);
      
      incrementCounter('api_slow_queries_list_total');
      
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
    logger.error('Failed to list slow queries', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/query-performance/recommendations
 * 获取优化建议列表
 */
router.get('/recommendations', requireAdmin, async (req, res) => {
  try {
    const { status, severity, limit = 50 } = req.query;
    
    const client = new Client(getDbConfig());
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
          applied_at,
          error_message
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
      
      incrementCounter('api_recommendations_list_total');
      
      res.json({
        success: true,
        data: result.rows
      });
      
    } finally {
      await client.end();
    }
  } catch (error) {
    logger.error('Failed to list recommendations', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/query-performance/recommendations/:id/apply
 * 应用优化建议
 */
router.post('/recommendations/:id/apply', requireAdmin, async (req, res) => {
  try {
    const startTime = Date.now();
    const { advisor } = getComponents();
    
    const result = await advisor.applyRecommendation(parseInt(req.params.id));
    
    observeHistogram('query_optimization_apply_duration_seconds', 
      (Date.now() - startTime) / 1000);
    incrementCounter('query_optimization_applied_total');
    
    logger.info('Optimization applied', { recommendationId: req.params.id });
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to apply recommendation', { 
      recommendationId: req.params.id,
      error: error.message 
    });
    incrementCounter('query_optimization_apply_errors_total');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/query-performance/recommendations/:id/dismiss
 * 忽略优化建议
 */
router.post('/recommendations/:id/dismiss', requireAdmin, async (req, res) => {
  try {
    const client = new Client(getDbConfig());
    await client.connect();
    
    try {
      await client.query(`
        UPDATE query_optimization_recommendations
        SET status = 'dismissed'
        WHERE id = $1 AND status = 'pending'
      `, [parseInt(req.params.id)]);
      
      res.json({
        success: true,
        message: 'Recommendation dismissed'
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    logger.error('Failed to dismiss recommendation', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/query-performance/analyze/:queryId
 * 分析特定查询
 */
router.post('/analyze/:queryId', requireAdmin, async (req, res) => {
  try {
    const { analyzer, advisor } = getComponents();
    const client = new Client(getDbConfig());
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
      let explainResult = null;
      try {
        const explainQuery = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query_text.substring(0, 1000)}`;
        const explainRes = await client.query(explainQuery);
        explainResult = explainRes.rows[0];
      } catch (explainError) {
        logger.warn('EXPLAIN ANALYZE failed', { 
          queryId: req.params.queryId,
          error: explainError.message 
        });
        // 使用空对象作为备用
        explainResult = {};
      }
      
      // 分析查询
      const analysis = await analyzer.analyze(query, explainResult);
      
      // 生成建议
      const recommendations = await advisor.generateRecommendations(analysis);
      
      incrementCounter('api_query_analyze_total');
      
      res.json({
        success: true,
        data: {
          query,
          explainPlan: explainResult,
          analysis,
          recommendations
        }
      });
      
    } finally {
      await client.end();
    }
  } catch (error) {
    logger.error('Failed to analyze query', { 
      queryId: req.params.queryId,
      error: error.message 
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/query-performance/collector/start
 * 启动慢查询采集器
 */
router.post('/collector/start', requireAdmin, async (req, res) => {
  try {
    const { collector } = getComponents();
    await collector.start();
    
    incrementCounter('slow_query_collector_start_total');
    
    res.json({
      success: true,
      message: 'Slow query collector started',
      status: collector.getStatus()
    });
  } catch (error) {
    logger.error('Failed to start collector', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/query-performance/collector/stop
 * 停止慢查询采集器
 */
router.post('/collector/stop', requireAdmin, async (req, res) => {
  try {
    const { collector } = getComponents();
    await collector.stop();
    
    incrementCounter('slow_query_collector_stop_total');
    
    res.json({
      success: true,
      message: 'Slow query collector stopped',
      status: collector.getStatus()
    });
  } catch (error) {
    logger.error('Failed to stop collector', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/query-performance/collector/status
 * 获取采集器状态
 */
router.get('/collector/status', requireAdmin, async (req, res) => {
  try {
    const { collector } = getComponents();
    const status = collector.getStatus();
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Failed to get collector status', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/query-performance/collector/collect
 * 手动触发采集
 */
router.post('/collector/collect', requireAdmin, async (req, res) => {
  try {
    const { collector } = getComponents();
    const result = await collector.manualCollect();
    
    incrementCounter('slow_query_collector_manual_total');
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to manual collect', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
