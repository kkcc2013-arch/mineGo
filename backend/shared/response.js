// backend/shared/response.js — Unified API Response Format
'use strict';

/**
 * 统一 API 响应格式
 * 
 * 所有接口应使用此模块提供的函数来构造响应
 * 格式：{ code, message, data, traceId }
 */

/**
 * 成功响应
 * @param {*} data 业务数据
 * @param {string} message 成功消息（默认："成功"）
 * @param {string} traceId 追踪 ID（从请求上下文获取）
 * @returns {Object}
 */
function successResp(data = null, message = '成功', traceId = null) {
  return {
    code: 0,
    message,
    data,
    traceId,
  };
}

/**
 * 错误响应
 * @param {number} code 错误码（非 0）
 * @param {string} message 错误消息
 * @param {*} data 额外数据（可选）
 * @param {string} traceId 追踪 ID
 * @returns {Object}
 */
function errorResp(code, message, data = null, traceId = null) {
  return {
    code,
    message,
    data,
    traceId,
  };
}

/**
 * 分页响应
 * @param {Array} items 数据项数组
 * @param {number} page 当前页码
 * @param {number} pageSize 每页大小
 * @param {number} total 总记录数
 * @param {string} traceId 追踪 ID
 * @returns {Object}
 */
function paginatedResp(items, page, pageSize, total, traceId = null) {
  const totalPages = Math.ceil(total / pageSize);
  return {
    code: 0,
    message: '成功',
    data: {
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
      },
    },
    traceId,
  };
}

/**
 * Express 中间件：自动注入 traceId 到响应
 */
function traceIdMiddleware(req, res, next) {
  // 保存原始 res.json
  const originalJson = res.json.bind(res);
  
  // 覆盖 res.json
  res.json = function (body) {
    // 如果响应体是对象且没有 traceId，自动注入
    if (body && typeof body === 'object' && !('traceId' in body)) {
      body.traceId = req.headers['x-trace-id'] || null;
    }
    return originalJson(body);
  };
  
  // 添加辅助方法到 res
  res.success = (data, message) => {
    const traceId = req.headers['x-trace-id'];
    return res.json(successResp(data, message, traceId));
  };
  
  res.error = (code, message, data) => {
    const traceId = req.headers['x-trace-id'];
    return res.json(errorResp(code, message, data, traceId));
  };
  
  res.paginated = (items, page, pageSize, total) => {
    const traceId = req.headers['x-trace-id'];
    return res.json(paginatedResp(items, page, pageSize, total, traceId));
  };
  
  next();
}

module.exports = {
  successResp,
  errorResp,
  paginatedResp,
  traceIdMiddleware,
};
