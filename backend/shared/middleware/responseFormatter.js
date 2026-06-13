// backend/shared/middleware/responseFormatter.js - 统一响应格式化中间件
'use strict';

const { randomUUID } = require('crypto');

/**
 * 统一响应格式化中间件
 * 
 * 为 res 对象添加标准化的响应方法
 */
function responseFormatterMiddleware(req, res, next) {
  const requestId = req.requestId || req.id || null;
  
  /**
   * 成功响应
   * @param {*} data 业务数据
   * @param {string} message 成功消息
   */
  res.success = function(data, message = 'Success') {
    return res.json({
      success: true,
      code: 0,
      message,
      data,
      requestId,
      timestamp: new Date().toISOString()
    });
  };
  
  /**
   * 分页响应
   * @param {Array} items 数据项数组
   * @param {Object} pagination 分页信息
   */
  res.paginated = function(items, pagination) {
    const { page, pageSize, total } = pagination;
    const totalPages = Math.ceil(total / pageSize);
    
    return res.json({
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
    });
  };
  
  /**
   * 创建响应（201）
   * @param {*} data 创建的数据
   * @param {string} message 成功消息
   */
  res.created = function(data, message = 'Created successfully') {
    return res.status(201).json({
      success: true,
      code: 0,
      message,
      data,
      requestId,
      timestamp: new Date().toISOString()
    });
  };
  
  /**
   * 无内容响应（204）
   */
  res.noContent = function() {
    return res.status(204).send();
  };
  
  /**
   * 错误响应（已弃用，应使用错误处理中间件）
   * @deprecated 使用 next(error) 代替
   */
  res.fail = function(code, message, details = {}) {
    return res.json({
      success: false,
      code,
      message,
      details,
      requestId,
      timestamp: new Date().toISOString()
    });
  };
  
  next();
}

module.exports = responseFormatterMiddleware;
