// backend/shared/index.js
// 共享模块统一导出

'use strict';

const { createLogger, childLogger, requestLogger } = require('./logger');
const metrics = require('./metrics');
const { query, transaction, pool } = require('./db');

// Redis 客户端（向后兼容）
const redis = require('./redis');
const { RedisPoolManager, getPoolManager, initPool } = require('./RedisPoolManager');

// 错误处理
const errors = require('./errors');
const { 
  errorHandler, 
  errorHandlerMiddleware, 
  notFoundHandler, 
  asyncHandler 
} = require('./middleware/errorHandler');
const requestIdMiddleware = require('./middleware/requestId');
const responseFormatterMiddleware = require('./middleware/responseFormatter');

// 响应格式化
const { 
  successResp, 
  createdResp, 
  errorResp, 
  paginatedResp, 
  ResponseFormatter 
} = require('./response');

module.exports = {
  // 日志
  createLogger,
  childLogger,
  requestLogger,
  logger: createLogger('shared'),
  
  // 指标
  metrics,
  
  // 数据库
  query,
  transaction,
  pool,
  db: { query, transaction, pool },
  
  // Redis
  redis,
  RedisPoolManager,
  getPoolManager,
  initRedisPool: initPool,
  
  // 错误处理
  errors,
  errorHandler,
  errorHandlerMiddleware,
  notFoundHandler,
  asyncHandler,
  
  // 中间件
  requestIdMiddleware,
  responseFormatterMiddleware,
  
  // 响应格式化
  successResp,
  createdResp,
  errorResp,
  paginatedResp,
  ResponseFormatter
};
