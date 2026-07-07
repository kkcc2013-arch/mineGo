/**
 * 游标分页器
 * 用于大数据量查询，避免 offset 性能问题
 * 
 * @module CursorPaginator
 * @author mineGo Team
 * @version 1.0.0
 */

const logger = require('../logger');

/**
 * 游标分页器类
 */
class CursorPaginator {
  /**
   * 构造函数
   * @param {Object} db - Knex 数据库实例
   * @param {string} tableName - 表名
   * @param {Object} options - 配置选项
   * @param {string} options.cursorField - 游标字段，默认 'id'
   * @param {string} options.orderField - 排序字段，默认 'createdAt'
   * @param {string} options.orderDirection - 排序方向，默认 'DESC'
   * @param {Object} options.defaultWhere - 默认查询条件
   */
  constructor(db, tableName, options = {}) {
    if (!db) {
      throw new Error('Database instance is required');
    }
    if (!tableName) {
      throw new Error('Table name is required');
    }
    
    this.db = db;
    this.tableName = tableName;
    this.cursorField = options.cursorField || 'id';
    this.orderField = options.orderField || 'createdAt';
    this.orderDirection = options.orderDirection || 'DESC';
    this.defaultWhere = options.defaultWhere || null;
  }

  /**
   * 执行游标查询
   * 
   * @param {string} cursor - 游标字符串（base64 编码）
   * @param {number} pageSize - 每页数量
   * @param {string} direction - 方向 'next' 或 'prev'
   * @param {Object} additionalWhere - 额外查询条件
   * @returns {Promise<Object>} 分页结果
   */
  async query(cursor, pageSize, direction = 'next', additionalWhere = null) {
    const cursorData = this.decodeCursor(cursor);
    
    // 构建基础查询
    let query = this.db(this.tableName)
      .select('*')
      .limit(pageSize + 1);  // 多取一条用于判断 hasNext
    
    // 应用默认条件
    if (this.defaultWhere) {
      query = this._applyWhere(query, this.defaultWhere);
    }
    
    // 应用额外条件
    if (additionalWhere) {
      query = this._applyWhere(query, additionalWhere);
    }
    
    // 应用游标条件
    if (cursorData) {
      query = this._applyCursorCondition(query, cursorData, direction);
    }
    
    // 应用排序
    const isNext = direction === 'next';
    query = query
      .orderBy(this.orderField, isNext ? this.orderDirection : this._reverseOrder(this.orderDirection))
      .orderBy(this.cursorField, isNext ? 'asc' : 'desc');
    
    // 执行查询
    const items = await query;
    
    // 判断是否有更多数据
    const hasMore = items.length > pageSize;
    if (hasMore) {
      items.pop();  // 移除多取的一条
    }
    
    // 如果是向前查询，需要反转结果
    const resultItems = isNext ? items : items.reverse();
    
    // 构建结果
    const result = {
      items: resultItems,
      hasNext: isNext ? hasMore : !!cursor,
      hasPrev: isNext ? !!cursor : hasMore,
      nextCursor: null,
      prevCursor: null,
      type: 'cursor'
    };
    
    // 生成游标
    if (resultItems.length > 0) {
      if (isNext) {
        result.nextCursor = hasMore ? this.encodeCursor(resultItems[resultItems.length - 1]) : null;
        result.prevCursor = cursor || null;
      } else {
        result.nextCursor = cursor || null;
        result.prevCursor = hasMore ? this.encodeCursor(resultItems[0]) : null;
      }
    }
    
    // 记录日志
    logger.debug('Cursor pagination query completed', {
      table: this.tableName,
      itemCount: resultItems.length,
      hasNext: result.hasNext,
      hasPrev: result.hasPrev,
      direction
    });
    
    return result;
  }

  /**
   * 查询总数（可选）
   * 注意：大数据量时计算总数可能很慢
   * 
   * @param {Object} additionalWhere - 额外查询条件
   * @returns {Promise<number>} 总数
   */
  async count(additionalWhere = null) {
    let query = this.db(this.tableName).count('* as count').first();
    
    // 应用默认条件
    if (this.defaultWhere) {
      query = this._applyWhere(query, this.defaultWhere);
    }
    
    // 应用额外条件
    if (additionalWhere) {
      query = this._applyWhere(query, additionalWhere);
    }
    
    const result = await query;
    return result?.count || 0;
  }

  /**
   * 编码游标
   * @param {Object} item - 数据项
   * @returns {string} base64 编码的游标
   */
  encodeCursor(item) {
    if (!item) return null;
    
    const cursorData = {
      [this.cursorField]: item[this.cursorField],
      [this.orderField]: item[this.orderField]
    };
    
    try {
      return Buffer.from(JSON.stringify(cursorData)).toString('base64');
    } catch (error) {
      logger.error('Failed to encode cursor', { error: error.message });
      return null;
    }
  }

  /**
   * 解码游标
   * @param {string} cursor - base64 编码的游标
   * @returns {Object|null} 游标数据
   */
  decodeCursor(cursor) {
    if (!cursor) return null;
    
    try {
      const decoded = Buffer.from(cursor, 'base64').toString();
      return JSON.parse(decoded);
    } catch (error) {
      logger.warn('Failed to decode cursor', { cursor, error: error.message });
      return null;
    }
  }

  /**
   * 应用游标条件
   * @private
   */
  _applyCursorCondition(query, cursorData, direction) {
    const orderValue = cursorData[this.orderField];
    const cursorValue = cursorData[this.cursorField];
    const isDesc = this.orderDirection.toUpperCase() === 'DESC';
    const isNext = direction === 'next';
    
    if (isNext) {
      // 向后翻页
      if (isDesc) {
        // DESC 排序：orderField < value OR (orderField = value AND cursorField > value)
        query = query.where((builder) => {
          builder
            .where(this.orderField, '<', orderValue)
            .orWhere((subBuilder) => {
              subBuilder
                .where(this.orderField, '=', orderValue)
                .where(this.cursorField, '>', cursorValue);
            });
        });
      } else {
        // ASC 排序：orderField > value OR (orderField = value AND cursorField > value)
        query = query.where((builder) => {
          builder
            .where(this.orderField, '>', orderValue)
            .orWhere((subBuilder) => {
              subBuilder
                .where(this.orderField, '=', orderValue)
                .where(this.cursorField, '>', cursorValue);
            });
        });
      }
    } else {
      // 向前翻页
      if (isDesc) {
        // DESC 排序向前：orderField > value OR (orderField = value AND cursorField < value)
        query = query.where((builder) => {
          builder
            .where(this.orderField, '>', orderValue)
            .orWhere((subBuilder) => {
              subBuilder
                .where(this.orderField, '=', orderValue)
                .where(this.cursorField, '<', cursorValue);
            });
        });
      } else {
        // ASC 排序向前：orderField < value OR (orderField = value AND cursorField < value)
        query = query.where((builder) => {
          builder
            .where(this.orderField, '<', orderValue)
            .orWhere((subBuilder) => {
              subBuilder
                .where(this.orderField, '=', orderValue)
                .where(this.cursorField, '<', cursorValue);
            });
        });
      }
    }
    
    return query;
  }

  /**
   * 应用查询条件
   * @private
   */
  _applyWhere(query, where) {
    if (typeof where === 'function') {
      return query.where(where);
    }
    
    if (typeof where === 'object') {
      return query.where(where);
    }
    
    return query;
  }

  /**
   * 反转排序方向
   * @private
   */
  _reverseOrder(order) {
    return order.toUpperCase() === 'DESC' ? 'ASC' : 'DESC';
  }

  /**
   * 创建分页器实例（工厂方法）
   * @static
   */
  static create(db, tableName, options = {}) {
    return new CursorPaginator(db, tableName, options);
  }
}

module.exports = CursorPaginator;