'use strict';
/**
 * 中间件模块导出
 * REQ-00307: API 请求参数验证与响应格式一致性中间件系统
 */

const { 
  responseFormatter, 
  legacyResponseAdapter, 
  responseTimeTracker,
  generateRequestId 
} = require('./responseFormatter');

const {
  validateBody,
  validateQuery,
  validateParams,
  validateHeaders,
  validate,
  validateFile,
  validateIf,
  formatZodErrors
} = require('./requestValidator');

module.exports = {
  // 响应格式化
  responseFormatter,
  legacyResponseAdapter,
  responseTimeTracker,
  generateRequestId,
  
  // 请求验证
  validateBody,
  validateQuery,
  validateParams,
  validateHeaders,
  validate,
  validateFile,
  validateIf,
  formatZodErrors
};
