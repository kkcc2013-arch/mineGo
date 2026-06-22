/**
 * backend/gateway/src/routes/queryPerformance.js
 * REQ-00063: 数据库慢查询分析与自动优化建议系统
 * 查询性能监控 API 路由
 */

'use strict';

const express = require('express');
const router = express.Router();
const { Client } = require('pg');
const { getCollector } = require('@pmg/shared/slowQueryCollector');
const QueryAnalyzer = require('@pmg/shared/queryAnalyzer');
const OptimizationAdvisor = require('@pmg/shared/optimizationAdvisor');
const logger = require('@pmg/shared/logger');
const { incrementCounter, observeHistogram } = require('@pmg/shared/metrics');
const authMiddleware = require('../middleware/auth');

// 初始化组件
const analyzer = new QueryAnalyzer();
const advisor = new OptimizationAdvisor({
  dbConfig: process.env.DATABASE_URL
});

/**
 * GET /api/query-performance/overview
 * 获取查询性能概览
 */
router.get('/overview', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const report = await advisor.generateReport();
    
    incrementCounter('api_query_performance_overview_total');
    
    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    logger.error('Failed to generate query performance overview', {
      error: error.message
    });
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
router.get('/slow-queries', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { 
      limit = 50, 
      offset = 0, 
      minTime = 0,
      startDate,
      endDate 
    } = req.query;
    
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
    logger.error('Failed to get slow queries', { error: error.message });
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
router.get('/recommendations', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const { status, severity, limit = 50 } = req.query;
    
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
    logger.error('Failed to get recommendations', { error: error.message });
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
router.post('/recommendations/:id/apply', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const startTime = Date.now();
    
    const result = await advisor.applyRecommendation(req.params.id);
    
    observeHistogram('query_optimization_apply_duration_seconds', 
      (Date.now() - startTime) / 1000);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Failed to apply recommendation', {
      recommendationId: req.params.id,
      error: error.message
    });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/query-performance/analyze/:queryId
 * 分析指定查询
 */
router.post('/analyze/:queryId', authMiddleware.requireAdmin, async (req, res) => {
  try {
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
      let explainResult = { rows: [{}] };
      try {
        explainResult = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query_text.substring(0, 1000)}`
        );
      } catch (explainError) {
        logger.warn('EXPLAIN ANALYZE failed', {
          queryId: req.params.queryId,
          error: explainError.message
        });
      }
      
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
router.post('/collector/start', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const collector = getCollector({
      dbConfig: process.env.DATABASE_URL,
      slowThreshold: parseInt(process.env.SLOW_QUERY_THRESHOLD) || 1000
    });
    
    await collector.start();
    
    res.json({
      success: true,
      message: 'Slow query collector started'
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
router.post('/collector/stop', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const collector = getCollector();
    await collector.stop();
    
    res.json({
      success: true,
      message: 'Slow query collector stopped'
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
router.get('/collector/status', authMiddleware.requireAdmin, async (req, res) => {
  try {
    const collector = getCollector();
    const status = collector.getStatus();
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;