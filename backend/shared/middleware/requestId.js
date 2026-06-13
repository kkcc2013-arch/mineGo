// backend/shared/middleware/requestId.js - Request ID 中间件
'use strict';

const { randomUUID } = require('crypto');

/**
 * Request ID 中间件
 * 
 * 为每个请求生成唯一 ID，用于日志追踪和错误响应
 */
function requestIdMiddleware(options = {}) {
  const {
    headerName = 'x-request-id',
    attributeName = 'id',
    generator = () => `req_${Date.now()}_${randomUUID().substring(0, 8)}`
  } = options;
  
  return (req, res, next) => {
    // 从请求头获取或生成新的 requestId
    const requestId = req.headers[headerName] || 
                      req.headers['x-correlation-id'] ||
                      generator();
    
    // 挂载到请求对象
    req[attributeName] = requestId;
    req.requestId = requestId;
    
    // 设置响应头
    res.setHeader('X-Request-Id', requestId);
    
    // 记录请求开始
    const startTime = Date.now();
    
    // 响应结束时记录请求时长
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      res.locals = res.locals || {};
      res.locals.requestDuration = duration;
    });
    
    next();
  };
}

module.exports = requestIdMiddleware;
