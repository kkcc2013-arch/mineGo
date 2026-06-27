/**
 * 分区查询中间件
 * REQ-00323: 数据库分区表与大数据量表分区策略
 * 
 * 自动为查询添加分区裁剪优化
 */

const PartitionQueryOptimizer = require('../shared/partitionQueryOptimizer');
const logger = require('../shared/logger');

/**
 * 分区查询中间件
 * @param {Object} options - 配置选项
 * @param {string} options.defaultPartitionKey - 默认分区键
 * @param {number} options.defaultMonthsBack - 默认查询过去月数
 * @param {boolean} options.forceOptimization - 强制优化
 */
function partitionQueryMiddleware(options = {}) {
  const {
    defaultPartitionKey = 'created_at',
    defaultMonthsBack = 3,
    forceOptimization = true
  } = options;

  return async (req, res, next) => {
    // 如果请求体中有日期范围参数，自动添加到查询上下文
    if (req.body && (req.body.startDate || req.body.start_date)) {
      req.partitionContext = {
        dateRange: {
          start: req.body.startDate || req.body.start_date,
          end: req.body.endDate || req.body.end_date || new Date()
        }
      };
    }

    // 为查询参数添加日期范围
    if (req.query && (req.query.startDate || req.query.start_date)) {
      req.partitionContext = {
        dateRange: {
          start: req.query.startDate || req.query.start_date,
          end: req.query.endDate || req.query.end_date || new Date()
        }
      };
    }

    next();
  };
}

/**
 * 分区查询辅助函数
 */
class PartitionQueryHelper {
  /**
   * 执行优化的分区查询
   * @param {Object} pool - 数据库连接池
   * @param {string} query - SQL 查询
   * @param {Array} params - 查询参数
   * @param {Object} options - 优化选项
   */
  static async executeOptimized(pool, query, params = [], options = {}) {
    const {
      partitionKey = 'created_at',
      dateRange = null,
      forceDefaultRange = true,
      maxMonthsBack = 3,
      analyze = false
    } = options;

    // 生成优化查询
    const optimized = PartitionQueryOptimizer.generateOptimizedQuery(query, {
      params,
      partitionKey,
      dateRange,
      forceDefaultRange,
      maxMonthsBack
    });

    if (analyze) {
      logger.debug('Query optimization analysis', {
        original: query,
        optimized: optimized.query,
        analysis: optimized.analysis
      });
    }

    // 执行优化后的查询
    const result = await pool.query(optimized.query, optimized.params);

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      optimization: optimized.analysis
    };
  }

  /**
   * 执行分区范围查询
   * @param {Object} pool - 数据库连接池
   * @param {string} tableName - 表名
   * @param {Date} startDate - 开始日期
   * @param {Date} endDate - 结束日期
   * @param {Object} options - 查询选项
   */
  static async queryByDateRange(pool, tableName, startDate, endDate, options = {}) {
    const {
      columns = '*',
      whereClause = '',
      params = [],
      orderBy = 'created_at DESC',
      limit = null,
      offset = null
    } = options;

    // 获取适用的分区
    const partitions = PartitionQueryOptimizer.getApplicablePartitions(
      tableName,
      startDate,
      endDate
    );

    // 构建 UNION ALL 查询
    const unionQueries = partitions.map(partition => {
      return `SELECT ${columns} FROM ${partition}`;
    });

    let query = unionQueries.join(' UNION ALL ');

    if (whereClause) {
      query += ` WHERE ${whereClause}`;
    }

    if (orderBy) {
      query += ` ORDER BY ${orderBy}`;
    }

    if (limit) {
      query += ` LIMIT ${limit}`;
    }

    if (offset) {
      query += ` OFFSET ${offset}`;
    }

    const result = await pool.query(query, params);

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      partitionsScanned: partitions.length
    };
  }

  /**
   * 执行分区统计查询
   * @param {Object} pool - 数据库连接池
   * @param {string} tableName - 表名
   * @param {Date} startDate - 开始日期
   * @param {Date} endDate - 结束日期
   * @param {string} groupBy - 分组字段
   */
  static async queryStatsByDateRange(pool, tableName, startDate, endDate, groupBy = 'DATE(created_at)') {
    const partitions = PartitionQueryOptimizer.getApplicablePartitions(
      tableName,
      startDate,
      endDate
    );

    const unionQueries = partitions.map(partition => {
      return `SELECT ${groupBy} as date, COUNT(*) as count FROM ${partition} GROUP BY ${groupBy}`;
    });

    const query = `
      SELECT date, SUM(count) as total_count
      FROM (${unionQueries.join(' UNION ALL ')}) subquery
      GROUP BY date
      ORDER BY date
    `;

    const result = await pool.query(query);

    return result.rows;
  }
}

module.exports = {
  partitionQueryMiddleware,
  PartitionQueryHelper
};