/**
 * 分页系统模块索引
 * 导出统一的分页中间件、游标分页器和策略选择器
 * 
 * @module pagination
 * @author mineGo Team
 * @version 1.0.0
 */

const PaginationMiddleware = require('./PaginationMiddleware');
const CursorPaginator = require('./CursorPaginator');
const PaginationStrategySelector = require('./PaginationStrategySelector');

/**
 * 创建默认分页中间件配置
 * @param {Object} options - 配置选项
 * @returns {Object} 中间件实例
 */
function createPaginationMiddleware(options = {}) {
  return PaginationMiddleware.create(options);
}

/**
 * 创建游标分页器
 * @param {Object} db - 数据库实例
 * @param {string} tableName - 表名
 * @param {Object} options - 配置选项
 * @returns {CursorPaginator} 分页器实例
 */
function createCursorPaginator(db, tableName, options = {}) {
  return new CursorPaginator(db, tableName, options);
}

/**
 * 创建策略选择器
 * @param {Object} options - 配置选项
 * @returns {PaginationStrategySelector} 选择器实例
 */
function createStrategySelector(options = {}) {
  return new PaginationStrategySelector(options);
}

/**
 * 分页助手函数
 * 用于路由中快速创建分页结果
 * 
 * @param {Express.Request} req - Express 请求对象
 * @param {Array} items - 数据项
 * @param {number} total - 总数（可选）
 * @param {Object} options - 选项（可选）
 * @returns {Object} 分页响应对象
 */
function createPaginatedResponse(req, items, total = null, options = {}) {
  const pagination = req.pagination || {};
  const pageSize = pagination.pageSize || 20;
  const page = pagination.page || 1;
  
  const response = {
    success: true,
    data: items,
    meta: {
      requestId: req.requestId || `req-${Date.now()}`,
      timestamp: new Date().toISOString(),
      pagination: {
        type: pagination.cursor ? 'cursor' : 'offset',
        page,
        pageSize,
        total: total || null,
        totalPages: total ? Math.ceil(total / pageSize) : null,
        hasNext: items.length === pageSize,
        hasPrev: page > 1
      }
    }
  };
  
  // 如果提供了游标信息
  if (options.nextCursor || options.prevCursor) {
    response.meta.pagination.type = 'cursor';
    response.meta.pagination.nextCursor = options.nextCursor || null;
    response.meta.pagination.prevCursor = options.prevCursor || null;
    response.meta.pagination.hasNext = options.hasNext || items.length === pageSize;
    response.meta.pagination.hasPrev = options.hasPrev || page > 1;
  }
  
  return response;
}

// 导出所有模块
module.exports = {
  PaginationMiddleware,
  CursorPaginator,
  PaginationStrategySelector,
  PaginationStrategy: require('./PaginationStrategySelector').PaginationStrategy,
  
  // 工厂函数
  createPaginationMiddleware,
  createCursorPaginator,
  createStrategySelector,
  
  // 助手函数
  createPaginatedResponse
};