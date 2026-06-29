// backend/shared/indexOptimizer/SlowQueryCollector.js
'use strict';

const EventEmitter = require('events');
const { createLogger } = require('../logger');

const logger = createLogger('slow-query-collector');

/**
 * 慢查询收集器
 * 通过 pg_stat_statements 扩展收集和分析慢查询
 */
class SlowQueryCollector extends EventEmitter {
  constructor(config = {}) {
    super();
    this.pool = config.pool;
    this.slowQueryThreshold = config.slowQueryThreshold || 500; // 500ms
    this.collectionInterval = config.collectionInterval || 60000; // 1分钟
    this.queryBuffer = [];
    this.maxBufferSize = config.maxBufferSize || 10000;
    this.collectionTimer = null;
    this.isCollecting = false;
  }

  /**
   * 初始化慢查询收集器
   */
  async initialize() {
    try {
      // 检查 pg_stat_statements 是否可用
      const extensionCheck = await this.pool.query(`
        SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
      `);
      
      if (extensionCheck.rows.length === 0) {
        // 尝试创建扩展
        try {
          await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
          logger.info('pg_stat_statements 扩展已安装');
        } catch (error) {
          logger.warn({ error: error.message }, '无法安装 pg_stat_statements 扩展，将使用慢查询日志');
        }
      }
      
      // 开始定时收集
      this.startCollection();
      
      logger.info({
        slowQueryThreshold: this.slowQueryThreshold,
        collectionInterval: this.collectionInterval
      }, '慢查询收集器已初始化');
      
      return true;
    } catch (error) {
      logger.error({ error: error.message }, '慢查询收集器初始化失败');
      throw error;
    }
  }

  /**
   * 开始定时收集
   */
  startCollection() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
    }
    
    this.collectionTimer = setInterval(async () => {
      if (this.isCollecting) return;
      
      try {
        this.isCollecting = true;
        await this.collectSlowQueries();
      } catch (error) {
        this.emit('error', error);
        logger.error({ error: error.message }, '收集慢查询失败');
      } finally {
        this.isCollecting = false;
      }
    }, this.collectionInterval);
    
    // 立即执行一次
    this.isCollecting = true;
    this.collectSlowQueries().finally(() => {
      this.isCollecting = false;
    });
  }

  /**
   * 收集慢查询
   */
  async collectSlowQueries() {
    try {
      const result = await this.pool.query(`
        SELECT 
          queryid,
          query,
          calls,
          total_exec_time,
          mean_exec_time,
          min_exec_time,
          max_exec_time,
          rows,
          shared_blks_hit,
          shared_blks_read,
          temp_blks_written,
          blk_read_time,
          blk_write_time
        FROM pg_stat_statements
        WHERE mean_exec_time > $1
          AND query NOT LIKE '%pg_stat%'
          AND query NOT LIKE '%EXPLAIN%'
        ORDER BY total_exec_time DESC
        LIMIT 100
      `, [this.slowQueryThreshold]);
      
      const newQueries = [];
      
      for (const row of result.rows) {
        const slowQuery = {
          queryId: row.queryid?.toString() || `auto_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          query: this.normalizeQuery(row.query),
          originalQuery: row.query,
          calls: row.calls,
          totalExecTime: parseFloat(row.total_exec_time) || 0,
          meanExecTime: parseFloat(row.mean_exec_time) || 0,
          minExecTime: parseFloat(row.min_exec_time) || 0,
          maxExecTime: parseFloat(row.max_exec_time) || 0,
          rows: row.rows,
          cacheHitRatio: this.calculateCacheHitRatio(row.shared_blks_hit, row.shared_blks_read),
          tempBlocks: row.temp_blks_written,
          readTime: row.blk_read_time,
          writeTime: row.blk_write_time,
          timestamp: Date.now(),
          severity: this.calculateSeverity(row.mean_exec_time)
        };
        
        // 添加到缓冲区
        this.queryBuffer.push(slowQuery);
        newQueries.push(slowQuery);
        
        // 发出慢查询事件
        this.emit('slowQuery', slowQuery);
      }
      
      // 限制缓冲区大小
      if (this.queryBuffer.length > this.maxBufferSize) {
        this.queryBuffer = this.queryBuffer.slice(-this.maxBufferSize);
      }
      
      if (newQueries.length > 0) {
        logger.info({ count: newQueries.length }, '收集到新慢查询');
      }
      
      return newQueries;
    } catch (error) {
      // 如果 pg_stat_statements 不可用，使用替代方案
      if (error.code === '42P01' || error.message.includes('pg_stat_statements')) {
        logger.warn('pg_stat_statements 不可用，跳过慢查询收集');
        return [];
      }
      throw error;
    }
  }

  /**
   * 标准化查询（移除常量，保留结构）
   */
  normalizeQuery(query) {
    if (!query) return '';
    
    return query
      .replace(/\$\d+/g, '?')        // 参数占位符
      .replace(/\d+\.?\d*/g, '?')   // 数字常量（包括小数）
      .replace(/'[^']*'/g, '?')     // 字符串常量
      .replace(/"[^"]*"/g, '"?"')   // 标识符中的字符串
      .replace(/\s+/g, ' ')         // 多个空白字符
      .replace(/\(\s*\)/g, '()')    // 空括号
      .trim()
      .substring(0, 1000);         // 限制长度
  }

  /**
   * 计算缓存命中率
   */
  calculateCacheHitRatio(hit, read) {
    const hitNum = parseFloat(hit) || 0;
    const readNum = parseFloat(read) || 0;
    const total = hitNum + readNum;
    
    if (total === 0) return 100;
    return parseFloat(((hitNum / total) * 100).toFixed(2));
  }

  /**
   * 计算严重程度
   */
  calculateSeverity(meanExecTime) {
    const time = parseFloat(meanExecTime) || 0;
    
    if (time > 5000) return 'critical';    // > 5秒
    if (time > 2000) return 'high';        // > 2秒
    if (time > 1000) return 'medium';      // > 1秒
    return 'low';
  }

  /**
   * 获取查询执行计划
   */
  async getQueryPlan(query) {
    try {
      // 只对 SELECT 查询分析执行计划
      if (!query.trim().toUpperCase().startsWith('SELECT')) {
        return null;
      }
      
      // 限制查询时间，避免执行时间过长
      await this.pool.query('SET statement_timeout = 5000');
      const result = await this.pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
      await this.pool.query('SET statement_timeout = 30000');
      
      return result.rows[0];
    } catch (error) {
      logger.debug({ error: error.message, query: query.substring(0, 100) }, '无法获取查询执行计划');
      return null;
    }
  }

  /**
   * 获取表的统计信息
   */
  async getTableStats(tableName) {
    try {
      const result = await this.pool.query(`
        SELECT 
          schemaname,
          tablename,
          attname,
          n_distinct,
          correlation,
          most_common_vals,
          most_common_freqs,
          histogram_bounds,
          null_frac,
          avg_width
        FROM pg_stats
        WHERE tablename = $1
      `, [tableName]);
      
      return result.rows;
    } catch (error) {
      logger.error({ error: error.message, tableName }, '获取表统计信息失败');
      return [];
    }
  }

  /**
   * 获取现有索引
   */
  async getExistingIndexes(tableName) {
    try {
      const result = await this.pool.query(`
        SELECT
          i.schemaname,
          i.tablename,
          i.indexname,
          i.indexdef,
          array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) as columns,
          pg_relation_size(i.indexname::regclass) as size,
          pg_stat_user_indexes.idx_scan as scans,
          pg_stat_user_indexes.idx_tup_read as tuples_read,
          pg_stat_user_indexes.idx_tup_fetch as tuples_fetched
        FROM pg_indexes i
        JOIN pg_class c ON c.relname = i.tablename
        JOIN pg_index ix ON ix.indrelid = c.oid AND ix.indexrelid = i.indexname::regclass
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(ix.indkey)
        LEFT JOIN pg_stat_user_indexes ON pg_stat_user_indexes.indexrelname = i.indexname
        WHERE i.tablename = $1
        GROUP BY i.schemaname, i.tablename, i.indexname, i.indexdef,
                 pg_stat_user_indexes.idx_scan, pg_stat_user_indexes.idx_tup_read,
                 pg_stat_user_indexes.idx_tup_fetch
      `, [tableName]);
      
      return result.rows.map(row => ({
        schema: row.schemaname,
        table: row.tablename,
        indexName: row.indexname,
        definition: row.indexdef,
        columns: row.columns,
        size: row.size,
        scans: row.scans || 0,
        tuplesRead: row.tuples_read || 0,
        tuplesFetched: row.tuples_fetched || 0
      }));
    } catch (error) {
      logger.error({ error: error.message, tableName }, '获取现有索引失败');
      return [];
    }
  }

  /**
   * 停止收集
   */
  stop() {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
    }
    logger.info('慢查询收集器已停止');
  }

  /**
   * 获取最近的慢查询
   */
  getRecentSlowQueries(limit = 50) {
    return this.queryBuffer.slice(-limit);
  }

  /**
   * 清空缓冲区
   */
  clearBuffer() {
    this.queryBuffer = [];
    logger.info('慢查询缓冲区已清空');
  }
}

module.exports = { SlowQueryCollector };
