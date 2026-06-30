/**
 * 统一 API 响应工具类
 * 
 * 标准响应格式：
 * - 成功：{ success: true, data: {}, meta: { requestId, timestamp } }
 * - 分页：{ success: true, data: [], pagination: {...}, meta: {...} }
 * - 错误：{ success: false, error: { code, message, ... }, meta: {...} }
 */

'use strict';

const { v4: uuidv4 } = require('uuid');

class ApiResponse {
  /**
   * 生成请求元数据
   */
  static _generateMeta(res, options = {}) {
    return {
      requestId: res.locals?.requestId || uuidv4(),
      timestamp: new Date().toISOString(),
      ...options.meta
    };
  }

  /**
   * 成功响应
   * @param {Object} res - Express response 对象
   * @param {*} data - 响应数据
   * @param {Object} options - 可选配置
   */
  static success(res, data, options = {}) {
    const response = {
      success: true,
      data,
      meta: this._generateMeta(res, options)
    };

    return res.status(options.status || 200).json(response);
  }

  /**
   * 创建成功响应 (201)
   * @param {Object} res - Express response 对象
   * @param {*} data - 响应数据
   * @param {Object} options - 可选配置
   */
  static created(res, data, options = {}) {
    return this.success(res, data, { ...options, status: 201 });
  }

  /**
   * 无内容响应 (204)
   * @param {Object} res - Express response 对象
   */
  static noContent(res) {
    return res.status(204).send();
  }

  /**
   * 分页响应
   * @param {Object} res - Express response 对象
   * @param {Array} items - 列表数据
   * @param {Object} pagination - 分页信息 { page, limit, total }
   * @param {Object} options - 可选配置
   */
  static paginated(res, items, pagination, options = {}) {
    const { page, limit, total } = pagination;
    const totalPages = Math.ceil(total / limit);

    const response = {
      success: true,
      data: items,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(total),
        totalPages,
        hasMore: page < totalPages
      },
      meta: this._generateMeta(res, options)
    };

    return res.status(200).json(response);
  }

  /**
   * 列表响应（无分页，仅返回数组）
   * @param {Object} res - Express response 对象
   * @param {Array} items - 列表数据
   * @param {Object} options - 可选配置
   */
  static list(res, items, options = {}) {
    if (!Array.isArray(items)) {
      throw new Error('list() requires an array as data');
    }

    return this.success(res, items, options);
  }

  /**
   * 操作确认响应
   * @param {Object} res - Express response 对象
   * @param {Object} result - 操作结果
   * @param {Object} options - 可选配置
   */
  static actionResult(res, result, options = {}) {
    return this.success(res, result, options);
  }

  /**
   * 删除成功响应
   * @param {Object} res - Express response 对象
   * @param {number} affected - 影响的记录数
   */
  static deleted(res, affected = 1) {
    return this.success(res, { 
      affected,
      message: `Successfully deleted ${affected} item(s)`
    });
  }

  /**
   * 更新成功响应
   * @param {Object} res - Express response 对象
   * @param {Object} data - 更新后的数据
   */
  static updated(res, data) {
    return this.success(res, data);
  }

  /**
   * 批量操作响应
   * @param {Object} res - Express response 对象
   * @param {Object} result - 批量操作结果
   */
  static batchResult(res, result) {
    const { succeeded = [], failed = [], total = 0 } = result;
    
    return this.success(res, {
      total,
      succeeded: succeeded.length,
      failed: failed.length,
      details: { succeeded, failed }
    });
  }
}

module.exports = ApiResponse;
