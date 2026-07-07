/**
 * 智能分页策略选择器
 * 根据数据量和页码自动选择最优分页策略
 * 
 * @module PaginationStrategySelector
 * @author mineGo Team
 * @version 1.0.0
 */

const logger = require('../logger');

/**
 * 分页策略枚举
 */
const PaginationStrategy = {
  OFFSET: 'offset',
  CURSOR: 'cursor'
};

/**
 * 分页策略选择器类
 */
class PaginationStrategySelector {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {number} options.offsetThreshold - offset 阈值，超过此值使用游标分页，默认 1000
   * @param {number} options.totalEstimateThreshold - 总数估算阈值，超过此值不计算总数，默认 10000
   * @param {boolean} options.enableEstimation - 是否启用估算，默认 true
   */
  constructor(options = {}) {
    this.offsetThreshold = options.offsetThreshold || 1000;
    this.totalEstimateThreshold = options.totalEstimateThreshold || 10000;
    this.enableEstimation = options.enableEstimation !== false;
  }

  /**
   * 选择分页策略
   * 
   * @param {Object} paginationParams - 分页参数
   * @param {number} paginationParams.page - 页码
   * @param {number} paginationParams.pageSize - 每页数量
   * @param {string} paginationParams.cursor - 游标（可选）
   * @param {number} estimatedTotal - 预估总数（可选）
   * @returns {Object} 策略决策结果
   */
  selectStrategy(paginationParams, estimatedTotal = null) {
    const { page, pageSize, cursor } = paginationParams;
    
    // 已指定游标，使用游标分页
    if (cursor) {
      return {
        type: PaginationStrategy.CURSOR,
        calculateTotal: false,
        reason: 'Explicit cursor provided',
        suggestion: null
      };
    }
    
    // 计算 offset
    const offset = (page - 1) * pageSize;
    
    // 页码超过阈值，建议使用游标分页
    if (offset > this.offsetThreshold) {
      return {
        type: PaginationStrategy.CURSOR,
        calculateTotal: false,
        reason: `Offset ${offset} exceeds threshold ${this.offsetThreshold}`,
        suggestion: 'Use cursor-based pagination for better performance with large offsets',
        performanceWarning: {
          currentOffset: offset,
          threshold: this.offsetThreshold,
          impact: 'Large offsets can cause significant performance degradation'
        }
      };
    }
    
    // 数据量过大，不计算总数
    if (estimatedTotal && estimatedTotal > this.totalEstimateThreshold) {
      logger.info('Large dataset detected, skipping total count', {
        estimatedTotal,
        threshold: this.totalEstimateThreshold
      });
      
      return {
        type: PaginationStrategy.OFFSET,
        calculateTotal: false,
        reason: `Estimated total ${estimatedTotal} exceeds threshold ${this.totalEstimateThreshold}`,
        suggestion: 'Consider cursor-based pagination for large datasets',
        performanceWarning: {
          estimatedTotal,
          threshold: this.totalEstimateThreshold,
          impact: 'Counting large datasets can be expensive'
        }
      };
    }
    
    // 默认使用 offset 分页
    return {
      type: PaginationStrategy.OFFSET,
      calculateTotal: true,
      reason: 'Normal pagination scenario',
      suggestion: null
    };
  }

  /**
   * 估算数据量
   * 使用 EXPLAIN 或统计信息估算表行数
   * 
   * @param {Object} db - Knex 数据库实例
   * @param {string} tableName - 表名
   * @param {Object} whereClause - WHERE 条件（可选）
   * @returns {Promise<number|null>} 估算的行数
   */
  async estimateTotal(db, tableName, whereClause = null) {
    if (!this.enableEstimation) {
      return null;
    }
    
    try {
      // 方法1：使用 PostgreSQL 统计信息
      const statsResult = await this._getEstimatedRowsFromStats(db, tableName);
      if (statsResult !== null) {
        logger.debug('Estimated rows from statistics', {
          table: tableName,
          estimate: statsResult
        });
        return statsResult;
      }
    } catch (error) {
      logger.debug('Failed to get estimated rows from statistics', {
        table: tableName,
        error: error.message
      });
    }
    
    // 方法2：使用 EXPLAIN（备用方案）
    try {
      const explainResult = await this._getEstimatedRowsFromExplain(db, tableName, whereClause);
      if (explainResult !== null) {
        logger.debug('Estimated rows from EXPLAIN', {
          table: tableName,
          estimate: explainResult
        });
        return explainResult;
      }
    } catch (error) {
      logger.debug('Failed to get estimated rows from EXPLAIN', {
        table: tableName,
        error: error.message
      });
    }
    
    return null;
  }

  /**
   * 从 PostgreSQL 统计信息获取估算行数
   * @private
   */
  async _getEstimatedRowsFromStats(db, tableName) {
    try {
      const result = await db('pg_class')
        .select('reltuples')
        .where('relname', tableName)
        .first();
      
      if (result && result.reltuples > 0) {
        return Math.round(result.reltuples);
      }
    } catch (error) {
      // 忽略错误，使用备用方法
    }
    
    return null;
  }

  /**
   * 从 EXPLAIN 获取估算行数
   * @private
   */
  async _getEstimatedRowsFromExplain(db, tableName, whereClause) {
    try {
      let query = db(tableName).select('*');
      
      if (whereClause) {
        if (typeof whereClause === 'function') {
          query = query.where(whereClause);
        } else if (typeof whereClause === 'object') {
          query = query.where(whereClause);
        }
      }
      
      const sql = query.toString();
      const explainResult = await db.raw(`EXPLAIN ${sql}`);
      
      // 解析 EXPLAIN 结果
      if (explainResult.rows && explainResult.rows[0]) {
        const planLine = explainResult.rows[0]['QUERY PLAN'] || '';
        // 匹配 rows=N 模式
        const match = planLine.match(/rows=(\d+)/);
        if (match) {
          return parseInt(match[1], 10);
        }
      }
    } catch (error) {
      // 忽略错误
    }
    
    return null;
  }

  /**
   * 检查是否应该使用游标分页
   * 
   * @param {Object} paginationParams - 分页参数
   * @returns {boolean} 是否应该使用游标分页
   */
  shouldUseCursor(paginationParams) {
    const strategy = this.selectStrategy(paginationParams);
    return strategy.type === PaginationStrategy.CURSOR;
  }

  /**
   * 获取分页建议
   * 
   * @param {Object} paginationParams - 分页参数
   * @param {number} estimatedTotal - 预估总数（可选）
   * @returns {string|null} 分页建议
   */
  getSuggestion(paginationParams, estimatedTotal = null) {
    const strategy = this.selectStrategy(paginationParams, estimatedTotal);
    return strategy.suggestion;
  }

  /**
   * 创建选择器实例（工厂方法）
   * @static
   */
  static create(options = {}) {
    return new PaginationStrategySelector(options);
  }
}

// 导出类和枚举
module.exports = PaginationStrategySelector;
module.exports.PaginationStrategy = PaginationStrategy;