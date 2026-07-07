/**
 * 统一分页中间件
 * 自动解析分页参数并注入到请求对象
 * 包装响应以包含统一的分页元数据
 * 
 * @module PaginationMiddleware
 * @author mineGo Team
 * @version 1.0.0
 */

const logger = require('../logger');

/**
 * 分页中间件类
 */
class PaginationMiddleware {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {number} options.defaultPageSize - 默认每页数量，默认 20
   * @param {number} options.maxPageSize - 最大每页数量，默认 100
   * @param {number} options.cursorThreshold - 游标分页阈值，默认 1000
   */
  constructor(options = {}) {
    this.defaultPageSize = options.defaultPageSize || 20;
    this.maxPageSize = options.maxPageSize || 100;
    this.cursorThreshold = options.cursorThreshold || 1000;
    
    // 支持的参数别名映射（用于向后兼容）
    this.paramAliases = {
      page: ['page', 'p'],
      pageSize: ['pageSize', 'limit', 'size', 'perPage'],
      cursor: ['cursor', 'c'],
      direction: ['direction', 'dir']
    };
  }

  /**
   * 解析分页参数中间件
   * 将分页参数解析并注入到 req.pagination 对象
   * 
   * @param {Express.Request} req - Express 请求对象
   * @param {Express.Response} res - Express 响应对象
   * @param {Function} next - 下一个中间件
   */
  parsePaginationParams(req, res, next) {
    const query = req.query || {};
    
    // 解析参数（支持别名）
    const page = this._getParamValue(query, 'page');
    const pageSize = this._getParamValue(query, 'pageSize');
    const cursor = this._getParamValue(query, 'cursor');
    const direction = this._getParamValue(query, 'direction');
    
    // 验证并规范化参数
    const parsed = {
      page: this._validatePage(page),
      pageSize: this._validatePageSize(pageSize),
      cursor: cursor || null,
      direction: this._validateDirection(direction),
      total: null,  // 可由后续设置
      strategy: null  // 可由策略选择器设置
    };
    
    // 计算 offset
    if (!parsed.cursor) {
      parsed.offset = (parsed.page - 1) * parsed.pageSize;
    }
    
    // 检查是否需要建议使用游标分页
    if (parsed.offset && parsed.offset > this.cursorThreshold) {
      parsed.cursorSuggested = true;
      logger.warn(`Large offset detected (${parsed.offset}), cursor pagination recommended`, {
        requestId: req.requestId,
        endpoint: req.path
      });
    }
    
    // 注入到请求对象
    req.pagination = parsed;
    
    // 添加分页参数到响应元数据预留位置
    req._paginationInitialized = true;
    
    next();
  }

  /**
   * 包装分页响应中间件
   * 自动为成功响应添加分页元数据
   * 
   * @param {Express.Request} req - Express 请求对象
   * @param {Express.Response} res - Express 响应对象
   * @param {Function} next - 下一个中间件
   */
  wrapPaginatedResponse(req, res, next) {
    // 保存原始 json 方法
    const originalJson = res.json.bind(res);
    
    // 重写 json 方法
    res.json = (data) => {
      // 只处理分页请求且成功响应
      if (req.pagination && data && data.success === true) {
        // 确保 meta 对象存在
        if (!data.meta) {
          data.meta = {
            requestId: req.requestId || `req-${Date.now()}`,
            timestamp: new Date().toISOString()
          };
        }
        
        // 添加分页元数据
        if (req.paginationResult) {
          data.meta.pagination = this._buildPaginationMeta(req, req.paginationResult);
        } else if (Array.isArray(data.data)) {
          // 自动构建分页元数据（如果没有手动设置）
          data.meta.pagination = this._buildAutoPaginationMeta(req, data.data);
        }
      }
      
      return originalJson(data);
    };
    
    next();
  }

  /**
   * 设置分页结果（供路由调用）
   * 
   * @param {Express.Request} req - Express 请求对象
   * @param {Object} result - 分页结果
   * @param {Array} result.items - 数据项
   * @param {number} result.total - 总数（可选）
   * @param {string} result.nextCursor - 下一页游标（可选）
   * @param {string} result.prevCursor - 上一页游标（可选）
   * @param {boolean} result.hasNext - 是否有下一页
   * @param {boolean} result.hasPrev - 是否有上一页
   */
  setPaginationResult(req, result) {
    req.paginationResult = {
      items: result.items || [],
      total: result.total || null,
      nextCursor: result.nextCursor || null,
      prevCursor: result.prevCursor || null,
      hasNext: result.hasNext || false,
      hasPrev: result.hasPrev || false,
      type: result.type || (req.pagination.cursor ? 'cursor' : 'offset')
    };
  }

  /**
   * 构建分页元数据
   * @private
   */
  _buildPaginationMeta(req, result) {
    const { page, pageSize } = req.pagination;
    const { type, total, nextCursor, prevCursor, hasNext, hasPrev } = result;
    
    if (type === 'cursor') {
      return {
        type: 'cursor',
        pageSize,
        hasNext,
        hasPrev,
        nextCursor,
        prevCursor,
        // 游标分页不返回 total，除非显式提供
        total: total || undefined,
        totalPages: total ? Math.ceil(total / pageSize) : undefined
      };
    } else {
      const totalPages = total ? Math.ceil(total / pageSize) : null;
      return {
        type: 'offset',
        page,
        pageSize,
        total: total || null,
        totalPages,
        hasNext: totalPages ? page < totalPages : hasNext,
        hasPrev: page > 1 || hasPrev,
        nextCursor: null,
        prevCursor: null
      };
    }
  }

  /**
   * 自动构建分页元数据（当没有手动设置时）
   * @private
   */
  _buildAutoPaginationMeta(req, items) {
    const { page, pageSize, total } = req.pagination;
    
    // 简单推断是否有下一页
    const hasNext = items.length === pageSize;
    const hasPrev = page > 1;
    
    return {
      type: 'offset',
      page,
      pageSize,
      total: total || null,
      totalPages: total ? Math.ceil(total / pageSize) : null,
      hasNext,
      hasPrev,
      nextCursor: null,
      prevCursor: null
    };
  }

  /**
   * 获取参数值（支持别名）
   * @private
   */
  _getParamValue(query, paramName) {
    const aliases = this.paramAliases[paramName] || [paramName];
    for (const alias of aliases) {
      if (query[alias] !== undefined) {
        return query[alias];
      }
    }
    return undefined;
  }

  /**
   * 验证页码
   * @private
   */
  _validatePage(page) {
    const parsed = parseInt(page, 10);
    if (isNaN(parsed) || parsed < 1) {
      return 1;
    }
    return parsed;
  }

  /**
   * 验证每页数量
   * @private
   */
  _validatePageSize(pageSize) {
    const parsed = parseInt(pageSize, 10);
    if (isNaN(parsed) || parsed < 1) {
      return this.defaultPageSize;
    }
    return Math.min(parsed, this.maxPageSize);
  }

  /**
   * 验证方向
   * @private
   */
  _validateDirection(direction) {
    if (!direction) return 'next';
    const normalized = String(direction).toLowerCase();
    return normalized === 'prev' ? 'prev' : 'next';
  }

  /**
   * 创建中间件实例（工厂方法）
   * @static
   */
  static create(options = {}) {
    const instance = new PaginationMiddleware(options);
    
    // 返回 Express 中间件数组
    return {
      parseParams: instance.parsePaginationParams.bind(instance),
      wrapResponse: instance.wrapPaginatedResponse.bind(instance),
      instance
    };
  }
}

module.exports = PaginationMiddleware;