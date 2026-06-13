// backend/shared/middleware/index.js - 中间件统一导出
'use strict';

const { errorHandlerMiddleware, notFoundHandler, asyncHandler } = require('./errorHandler');
const requestIdMiddleware = require('./requestId');
const responseFormatterMiddleware = require('./responseFormatter');

module.exports = {
  // 错误处理
  errorHandler: errorHandlerMiddleware,
  errorHandlerMiddleware,
  notFoundHandler,
  asyncHandler,
  
  // Request ID
  requestIdMiddleware,
  
  // 响应格式化
  responseFormatterMiddleware
};
