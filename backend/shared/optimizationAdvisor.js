/**
 * backend/shared/optimizationAdvisor.js
 * REQ-00063: 数据库慢查询分析与自动优化建议系统
 * 自动优化建议生成器
 */

'use strict';

const { Client } = require('pg');
const logger = require('./logger');
const { incrementCounter } = require('./metrics');

class OptimizationAdvisor {
  constructor(config = {}) {
    this.dbConfig = config.dbConfig;
    this.enableAutoApply = config.enableAutoApply || false;
  }

  /**
   * 生成优化建议
   * @param {Object} analysisResult - 分析结果
   * @returns {Array} 建议列表
   */
  async generateRecommendations(analysisResult) {
    const recommendations = [];
    
    // 基于分析结果生成建议
    for (const suggestion of analysisResult.suggestions) {
      const recommendation = await this.buildRecommendation(
        analysisResult.queryId,
        suggestion
      );
      if (recommendation) {
        recommendations.push(recommendation);
      }
    }
    
    // 排序按影响程度
    recommendations.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });
    
    return recommendations;
  }

  /**
   * 构建建议对象
   */
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
    if (suggestion.type === 'create_index' && suggestion.sql) {
      recommendation.conflictCheck = await this.checkIndexConflict(suggestion.sql);
    }
    
    // 存储建议
    await this.storeRecommendation(recommendation);
    
    return recommendation;
  }

  /**
   * 检查索引冲突
   */
  async checkIndexConflict(indexSQL) {
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

  /**
   * 提取索引列
   */
  extractIndexColumns(indexDef) {
    const match = indexDef.match(/\(([^)]+)\)/);
    return match ? match[1].split(',').map(c => c.trim()) : [];
  }

  /**
   * 检查索引是否重叠
   */
  isOverlappingIndex(newColumns, existingColumns) {
    // 检查是否新索引是已有索引的前缀
    if (newColumns.length <= existingColumns.length) {
      const prefix = existingColumns.slice(0, newColumns.length);
      return newColumns.every((col, i) => col === prefix[i]);
    }
    return false;
  }

  /**
   * 存储建议到数据库
   */
  async storeRecommendation(recommendation) {
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

  /**
   * 应用建议
   */
  async applyRecommendation(recommendationId) {
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
        if (recommendation.sql && !recommendation.sql.startsWith('--')) {
          await client.query(recommendation.sql);
        }
        
        // 更新状态
        await client.query(`
          UPDATE query_optimization_recommendations
          SET status = 'applied', applied_at = NOW()
          WHERE id = $1
        `, [recommendationId]);
        
        await client.query('COMMIT');
        
        incrementCounter('query_optimization_applied_total');
        
        logger.info('Recommendation applied', { 
          recommendationId,
          type: recommendation.type 
        });
        
        return { success: true, recommendationId };
        
      } catch (error) {
        await client.query('ROLLBACK');
        
        // 更新状态为失败
        await client.query(`
          UPDATE query_optimization_recommendations
          SET status = 'failed', error_message = $1
          WHERE id = $2
        `, [error.message, recommendationId]);
        
        incrementCounter('query_optimization_apply_errors_total');
        
        throw error;
      }
      
    } finally {
      await client.end();
    }
  }

  /**
   * 生成性能报告
   */
  async generateReport() {
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