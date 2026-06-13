// backend/shared/response.js — 统一 API 响应格式
'use strict';

const { randomUUID } = require('crypto');

/**
 * 统一 API 响应格式
 * 
 * 所有接口应使用此模块提供的函数来构造响应
 * 
 * 格式规范：
 * - 成功响应：{ success: true, code: 0, message, data, requestId, timestamp }
 * - 错误响应：{ success: false, code, message, details, requestId, timestamp, path }
 * - 分页响应：{ success: true, code: 0, data, pagination, requestId, timestamp }
 */

/**
 * 成功响应
 * @param {*} data 业务数据
 * @param {string} message 成功消息（默认："Success"）
 * @param {string} requestId 请求追踪 ID
 * @returns {Object}
 */
function successResp(data = null, message = 'Success', requestId = null) {
  return {
    success: true,
    code: 0,
    message,
    data,
    requestId,
    timestamp: new Date().toISOString()
  };
}

/**
 * 创建成功响应（201）
 * @param {*} data 创建的数据
 * @param {string} message 成功消息
 * @param {string} requestId 请求追踪 ID
 * @returns {Object}
 */
function createdResp(data, message = 'Created successfully', requestId = null) {
  return {
    success: true,
    code: 0,
    message,
    data,
    requestId,
    timestamp: new Date().toISOString()
  };
}

/**
 * 错误响应
 * @param {string} code 错误码
 * @param {string} message 错误消息
 * @param {Object} details 错误详情
 * @param {string} requestId 请求追踪 ID
 * @param {string} path 请求路径
 * @returns {Object}
 */
function errorResp(code, message, details = {}, requestId = null, path = null) {
  const response = {
    success: false,
    code,
    message,
    details,
    requestId,
    timestamp: new Date().toISOString()
  };
  
  if (path) {
    response.path = path;
  }
  
  return response;
}

/**
 * 分页响应
 * @param {Array} items 数据项数组
 * @param {number} page 当前页码
 * @param {number} pageSize 每页大小
 * @param {number} total 总记录数
 * @param {string} requestId 请求追踪 ID
 * @returns {Object}
 */
function paginatedResp(items, page, pageSize, total, requestId = null) {
  const totalPages = Math.ceil(total / pageSize);
  
  return {
    success: true,
    code: 0,
    message: 'Success',
    data: items,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasMore: page < totalPages
    },
    requestId,
    timestamp: new Date().toISOString()
  };
}

/**
 * Express 中间件：自动注入 requestId 到响应
 * 
 * @deprecated 请使用 ./middleware/responseFormatter 代替
 */
function traceIdMiddleware(req, res, next) {
  // 保存原始 res.json
  const originalJson = res.json.bind(res);
  
  // 覆盖 res.json
  res.json = function (body) {
    // 如果响应体是对象且没有 requestId，自动注入
    if (body && typeof body === 'object' && !('requestId' in body)) {
      body.requestId = req.requestId || req.headers['x-request-id'] || null;
    }
    return originalJson(body);
  };
  
  // 添加辅助方法到 res
  res.success = (data, message) => {
    const requestId = req.requestId || req.headers['x-request-id'];
    return res.json(successResp(data, message, requestId));
  };
  
  res.error = (code, message, details) => {
    const requestId = req.requestId || req.headers['x-request-id'];
    return res.json(errorResp(code, message, details, requestId, req.originalUrl));
  };
  
  res.paginated = (items, page, pageSize, total) => {
    const requestId = req.requestId || req.headers['x-request-id'];
    return res.json(paginatedResp(items, page, pageSize, total, requestId));
  };
  
  next();
}

/**
 * ResponseFormatter 类
 * 
 * 提供静态方法创建标准响应
 */
class ResponseFormatter {
  /**
   * 成功响应
   */
  static success(data, message = 'Success', requestId = null) {
    return successResp(data, message, requestId);
  }
  
  /**
   * 创建成功响应
   */
  static created(data, message = 'Created successfully', requestId = null) {
    return createdResp(data, message, requestId);
  }
  
  /**
   * 错误响应
   */
  static error(code, message, details = {}, requestId = null, path = null) {
    return errorResp(code, message, details, requestId, path);
  }
  
  /**
   * 分页响应
   */
  static paginated(items, page, pageSize, total, requestId = null) {
    return paginatedResp(items, page, pageSize, total, requestId);
  }
  
  /**
   * 从 Error 对象创建错误响应
   */
  static fromError(error, requestId = null, path = null) {
    return {
      success: false,
      code: error.code || 'GEN-001',
      message: error.message || 'Internal server error',
      details: error.details || {},
      requestId,
      timestamp: error.timestamp || new Date().toISOString(),
      ...(path && { path })
    };
  }
}

module.exports = {
  successResp,
  createdResp,
  errorResp,
  paginatedResp,
  traceIdMiddleware,
  ResponseFormatter
};
