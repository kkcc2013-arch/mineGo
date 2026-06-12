// backend/shared/index.js
// 共享模块统一导出

'use strict';

const { createLogger, childLogger, requestLogger } = require('./logger');
const metrics = require('./metrics');
const { query, transaction, pool } = require('./db');

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
  db: { query, transaction, pool }
};
