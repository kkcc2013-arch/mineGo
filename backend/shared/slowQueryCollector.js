/**
 * backend/shared/slowQueryCollector.js
 * REQ-00063: 数据库慢查询分析与自动优化建议系统
 * 慢查询日志采集系统
 */

'use strict';

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
    this.collectionTimer = null;
  }

  /**
   * 启动慢查询采集
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Slow query collector is already running');
      return;
    }

    this.isRunning = true;
    await this.enableSlowQueryLog();
    this.startCollectionLoop();
    
    logger.info('Slow query collector started', {
      slowThreshold: this.slowThreshold,
      verySlowThreshold: this.verySlowThreshold,
      collectInterval: this.collectInterval
    });
  }

  /**
   * 启用 PostgreSQL 慢查询日志
   */
  async enableSlowQueryLog() {
    const client = new Client(this.dbConfig);
    await client.connect();
    
    try {
      // 启用 pg_stat_statements 扩展
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
      `);
      
      // 配置慢查询日志参数（如果权限允许）
      try {
        await client.query(`
          ALTER SYSTEM SET log_min_duration_statement = ${this.slowThreshold};
        `);
        logger.info('Slow query logging enabled at database level');
      } catch (err) {
        // 可能没有权限修改系统配置，但这不影响 pg_stat_statements 的使用
        logger.warn('Could not modify database config, using pg_stat_statements only');
      }
      
    } finally {
      await client.end();
    }
  }

  /**
   * 启动定时采集循环
   */
  startCollectionLoop() {
    this.collectionTimer = setInterval(async () => {
      try {
        await this.collectSlowQueries();
      } catch (error) {
        logger.error('Failed to collect slow queries', { 
          error: error.message,
          stack: error.stack 
        });
        incrementCounter('slow_query_collector_errors_total', { 
          service: process.env.SERVICE_NAME || 'shared' 
        });
      }
    }, this.collectInterval);
  }

  /**
   * 采集慢查询数据
   */
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
          total_exec_time as total_time,
          mean_exec_time as mean_time,
          min_exec_time as min_time,
          max_exec_time as max_time,
          rows,
          shared_blks_hit,
          shared_blks_read,
          shared_blks_dirtied,
          shared_blks_written
        FROM pg_stat_statements
        WHERE mean_exec_time > $1
        ORDER BY total_exec_time DESC
        LIMIT 100
      `, [this.slowThreshold]);
      
      const slowQueries = result.rows;
      
      // 记录指标并存储
      for (const query of slowQueries) {
        this.recordQueryMetrics(query);
        await this.storeQuery(query);
      }
      
      // 记录采集统计
      this.lastCollectionTime = new Date();
      
      incrementCounter('slow_query_collector_runs_total', {
        service: process.env.SERVICE_NAME || 'shared'
      });
      
      logger.info('Collected slow queries', { 
        count: slowQueries.length,
        topQueryTime: slowQueries[0]?.mean_time || 0,
        collectedAt: this.lastCollectionTime
      });
      
      return { count: slowQueries.length, queries: slowQueries };
      
    } finally {
      await client.end();
    }
  }

  /**
   * 记录 Prometheus 指标
   */
  recordQueryMetrics(query) {
    const queryId = String(query.queryid || 'unknown');
    
    incrementCounter('slow_query_total', 1, {
      query_id: queryId,
      service: 'database'
    });
    
    recordHistogram('query_duration_seconds', query.mean_time / 1000, {
      query_id: queryId
    });
    
    recordHistogram('query_rows_returned', query.rows || 0, {
      query_id: queryId
    });
    
    // 缓存命中率
    const cacheHitRatio = query.shared_blks_hit / 
      (query.shared_blks_hit + query.shared_blks_read || 1);
    recordHistogram('query_cache_hit_ratio', cacheHitRatio, {
      query_id: queryId
    });
  }

  /**
   * 存储慢查询到数据库
   */
  async storeQuery(query) {
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
        String(query.queryid),
        query.query.substring(0, 5000),
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

  /**
   * 手动触发采集
   */
  async manualCollect() {
    if (!this.isRunning) {
      await this.start();
    }
    return await this.collectSlowQueries();
  }

  /**
   * 停止采集
   */
  async stop() {
    this.isRunning = false;
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
    logger.info('Slow query collector stopped');
  }

  /**
   * 获取采集状态
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      slowThreshold: this.slowThreshold,
      verySlowThreshold: this.verySlowThreshold,
      collectInterval: this.collectInterval,
      lastCollectionTime: this.lastCollectionTime
    };
  }
}

// 导出单例和类
let collectorInstance = null;

function getCollector(config) {
  if (!collectorInstance) {
    collectorInstance = new SlowQueryCollector(config);
  }
  return collectorInstance;
}

module.exports = {
  SlowQueryCollector,
  getCollector
};