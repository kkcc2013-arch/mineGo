/**
 * 性能基准线管理服务
 * 维护和查询历史性能基准线数据
 * 
 * @module PerformanceBaselineManager
 * @requires REQ-00257 (API回归测试系统)
 * @requires REQ-00476 (API性能预算系统)
 */

'use strict';

const { createLogger } = require('../../shared/logger');

const logger = createLogger('performance-baseline-manager');

/**
 * 性能基准线管理器
 */
class PerformanceBaselineManager {
  /**
   * @param {Object} db - PostgreSQL 数据库连接
   * @param {Object} redis - Redis 连接
   */
  constructor(db, redis) {
    this.db = db;
    this.redis = redis;
  }

  /**
   * 获取所有 API 的基准线摘要
   * @returns {Promise<Array>} 基准线摘要列表
   */
  async getBaselineSummary() {
    logger.debug('Fetching baseline summary');
    
    try {
      const result = await this.db.query(`
        SELECT 
          endpoint,
          avg_response_time,
          median_response_time,
          p90_response_time,
          p95_response_time,
          p99_response_time,
          error_rate,
          throughput,
          sample_count,
          std_dev,
          last_updated,
          EXTRACT(EPOCH FROM (NOW() - last_updated)) / 3600 as hours_since_update
        FROM api_performance_baselines
        WHERE last_updated > NOW() - INTERVAL '30 days'
        ORDER BY endpoint
      `);
      
      logger.debug('Baseline summary fetched', { count: result.rows.length });
      
      return result.rows.map(row => ({
        endpoint: row.endpoint,
        avgResponseTime: Math.round(row.avg_response_time * 100) / 100,
        medianResponseTime: Math.round(row.median_response_time * 100) / 100,
        p90ResponseTime: Math.round(row.p90_response_time * 100) / 100,
        p95ResponseTime: Math.round(row.p95_response_time * 100) / 100,
        p99ResponseTime: Math.round(row.p99_response_time * 100) / 100,
        errorRate: (row.error_rate * 100).toFixed(2) + '%',
        throughput: Math.round(row.throughput),
        samples: row.sample_count,
        stdDev: row.std_dev ? Math.round(row.std_dev * 100) / 100 : null,
        lastUpdated: row.last_updated,
        freshness: this._describeFreshness(row.hours_since_update)
      }));
      
    } catch (error) {
      logger.error('Failed to fetch baseline summary', { error: error.message });
      throw error;
    }
  }

  /**
   * 获取特定 API 的性能趋势
   * @param {string} endpoint - API 端点
   * @param {number} days - 查询天数
   * @returns {Promise<Object>} 性能趋势数据
   */
  async getPerformanceTrend(endpoint, days = 30) {
    logger.debug('Fetching performance trend', { endpoint, days });
    
    try {
      const result = await this.db.query(`
        SELECT 
          DATE(created_at) as date,
          AVG((metrics->>'avgResponseTime')::float) as avg_response_time,
          AVG((metrics->>'p95ResponseTime')::float) as p95_response_time,
          AVG((metrics->>'errorRate')::float) as error_rate,
          COUNT(*) as test_count
        FROM api_performance_test_results
        WHERE endpoint = $1
          AND created_at > NOW() - INTERVAL '${days} days'
        GROUP BY DATE(created_at)
        ORDER BY date
      `, [endpoint]);
      
      logger.debug('Performance trend fetched', { 
        endpoint, 
        dataPoints: result.rows.length 
      });
      
      return {
        endpoint,
        period: `${days} days`,
        data: result.rows.map(row => ({
          date: row.date,
          avgResponseTime: Math.round(row.avg_response_time * 100) / 100,
          p95ResponseTime: Math.round(row.p95_response_time * 100) / 100,
          errorRate: (row.error_rate * 100).toFixed(2),
          testCount: row.test_count
        }))
      };
      
    } catch (error) {
      logger.error('Failed to fetch performance trend', { 
        endpoint, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * 获取性能回归历史
   * @param {string} endpoint - API 端点（可选）
   * @param {number} days - 查询天数
   * @returns {Promise<Array>} 回归历史列表
   */
  async getRegressionHistory(endpoint = null, days = 30) {
    logger.debug('Fetching regression history', { endpoint, days });
    
    try {
      let query = `
        SELECT 
          endpoint,
          created_at,
          passed,
          analysis_result->'regressions' as regressions,
          analysis_result->'overallScore' as overall_score,
          metrics->>'avgResponseTime' as avg_response_time,
          metrics->>'p95ResponseTime' as p95_response_time
        FROM api_performance_test_results
        WHERE created_at > NOW() - INTERVAL '${days} days'
          AND passed = false
      `;
      
      const params = [];
      if (endpoint) {
        query += ' AND endpoint = $1';
        params.push(endpoint);
      }
      
      query += ' ORDER BY created_at DESC LIMIT 100';
      
      const result = await this.db.query(query, params);
      
      return result.rows.map(row => ({
        endpoint: row.endpoint,
        timestamp: row.created_at,
        avgResponseTime: parseFloat(row.avg_response_time) || 0,
        p95ResponseTime: parseFloat(row.p95_response_time) || 0,
        overallScore: row.overall_score || 0,
        regressions: row.regressions || []
      }));
      
    } catch (error) {
      logger.error('Failed to fetch regression history', { error: error.message });
      throw error;
    }
  }

  /**
   * 强制更新基准线
   * @param {string} endpoint - API 端点
   * @param {Object} baseline - 新的基准线数据
   * @returns {Promise<Object>} 更新结果
   */
  async forceUpdateBaseline(endpoint, baseline) {
    logger.info('Force updating baseline', { endpoint });
    
    try {
      await this.db.query(`
        INSERT INTO api_performance_baselines
          (endpoint, avg_response_time, median_response_time,
           p90_response_time, p95_response_time, p99_response_time,
           error_rate, throughput, sample_count, std_dev, last_updated)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (endpoint) DO UPDATE SET
          avg_response_time = EXCLUDED.avg_response_time,
          median_response_time = EXCLUDED.median_response_time,
          p90_response_time = EXCLUDED.p90_response_time,
          p95_response_time = EXCLUDED.p95_response_time,
          p99_response_time = EXCLUDED.p99_response_time,
          error_rate = EXCLUDED.error_rate,
          throughput = EXCLUDED.throughput,
          sample_count = EXCLUDED.sample_count,
          std_dev = EXCLUDED.std_dev,
          last_updated = NOW()
      `, [
        endpoint,
        baseline.avgResponseTime || baseline.avg_response_time,
        baseline.medianResponseTime || baseline.median_response_time,
        baseline.p90ResponseTime || baseline.p90_response_time,
        baseline.p95ResponseTime || baseline.p95_response_time,
        baseline.p99ResponseTime || baseline.p99_response_time,
        baseline.errorRate || baseline.error_rate,
        baseline.throughput,
        baseline.samples || baseline.sample_count || 100,
        baseline.stdDev || baseline.std_dev
      ]);
      
      // 清除缓存
      const cacheKey = `perf:baseline:${endpoint.replace(/\s+/g, ':')}`;
      try {
        await this.redis.del(cacheKey);
      } catch (e) {
        logger.warn('Redis cache clear failed', { error: e.message });
      }
      
      logger.info('Baseline updated successfully', { endpoint });
      
      return { success: true, endpoint };
      
    } catch (error) {
      logger.error('Failed to update baseline', { 
        endpoint, 
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * 删除过期的测试结果
   * @param {number} retentionDays - 保留天数
   * @returns {Promise<Object>} 清理结果
   */
  async cleanupOldData(retentionDays = 90) {
    logger.info('Cleaning up old test results', { retentionDays });
    
    try {
      const result = await this.db.query(`
        DELETE FROM api_performance_test_results
        WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
        RETURNING COUNT(*) as deleted_count
      `);
      
      const deleted = result.rows[0]?.deleted_count || 0;
      
      logger.info('Cleanup completed', { deletedRecords: deleted });
      
      return { 
        success: true, 
        deleted,
        retentionDays 
      };
      
    } catch (error) {
      logger.error('Cleanup failed', { error: error.message });
      throw error;
    }
  }

  /**
   * 获取性能健康状态
   * @returns {Promise<Object>} 健康状态摘要
   */
  async getHealthStatus() {
    logger.debug('Fetching health status');
    
    try {
      // 获取最近的测试结果统计
      const recentTests = await this.db.query(`
        SELECT 
          COUNT(*) as total_tests,
          COUNT(*) FILTER (WHERE passed = true) as passed_tests,
          COUNT(*) FILTER (WHERE passed = false) as failed_tests,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as tests_last_24h,
          AVG((analysis_result->>'overallScore')::float) as avg_score
        FROM api_performance_test_results
        WHERE created_at > NOW() - INTERVAL '7 days'
      `);
      
      // 获取基准线状态
      const baselineStatus = await this.db.query(`
        SELECT 
          COUNT(*) as total_baselines,
          COUNT(*) FILTER (WHERE last_updated > NOW() - INTERVAL '7 days') as fresh_baselines,
          COUNT(*) FILTER (WHERE last_updated <= NOW() - INTERVAL '7 days') as stale_baselines
        FROM api_performance_baselines
      `);
      
      const testStats = recentTests.rows[0];
      const baseStats = baselineStatus.rows[0];
      
      const healthScore = this._calculateHealthScore(testStats, baseStats);
      
      return {
        healthy: healthScore >= 70,
        score: healthScore,
        tests: {
          total: parseInt(testStats.total_tests) || 0,
          passed: parseInt(testStats.passed_tests) || 0,
          failed: parseInt(testStats.failed_tests) || 0,
          last24h: parseInt(testStats.tests_last_24h) || 0,
          avgScore: parseFloat(testStats.avg_score)?.toFixed(2) || 'N/A'
        },
        baselines: {
          total: parseInt(baseStats.total_baselines) || 0,
          fresh: parseInt(baseStats.fresh_baselines) || 0,
          stale: parseInt(baseStats.stale_baselines) || 0
        },
        timestamp: new Date().toISOString()
      };
      
    } catch (error) {
      logger.error('Failed to fetch health status', { error: error.message });
      return {
        healthy: false,
        score: 0,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * 导出基准线数据
   * @param {string} format - 导出格式（json, csv）
   * @returns {Promise<string>} 导出的数据
   */
  async exportBaselines(format = 'json') {
    logger.info('Exporting baselines', { format });
    
    try {
      const result = await this.db.query(`
        SELECT * FROM api_performance_baselines
        ORDER BY endpoint
      `);
      
      if (format === 'csv') {
        const headers = [
          'endpoint', 'avg_response_time', 'median_response_time',
          'p90_response_time', 'p95_response_time', 'p99_response_time',
          'error_rate', 'throughput', 'sample_count', 'last_updated'
        ];
        
        const rows = result.rows.map(row => 
          headers.map(h => row[h] || '').join(',')
        );
        
        return [headers.join(','), ...rows].join('\n');
      }
      
      return JSON.stringify(result.rows, null, 2);
      
    } catch (error) {
      logger.error('Export failed', { error: error.message });
      throw error;
    }
  }

  /**
   * 描述数据新鲜度
   * @private
   */
  _describeFreshness(hours) {
    if (hours < 1) return '刚刚更新';
    if (hours < 24) return `${Math.floor(hours)}小时前`;
    return `${Math.floor(hours / 24)}天前`;
  }

  /**
   * 计算健康得分
   * @private
   */
  _calculateHealthScore(testStats, baseStats) {
    let score = 100;
    
    // 测试通过率
    const total = parseInt(testStats.total_tests) || 1;
    const passRate = (parseInt(testStats.passed_tests) || 0) / total;
    score *= passRate;
    
    // 基准线新鲜度
    const freshRate = (parseInt(baseStats.fresh_baselines) || 0) / 
                      (parseInt(baseStats.total_baselines) || 1);
    score *= (0.5 + freshRate * 0.5);
    
    // 最近测试频率
    const recentTests = parseInt(testStats.tests_last_24h) || 0;
    if (recentTests < 5) score *= 0.9;
    
    return Math.round(score);
  }
}

module.exports = PerformanceBaselineManager;