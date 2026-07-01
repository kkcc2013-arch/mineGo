'use strict';
/**
 * 验证中间件模块导出
 * 重新导出 requestValidator 的功能以保持向后兼容
 */

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

/**
 * 通用请求验证中间件
 * @param {Object} schema - Zod 验证模式
 * @param {string} target - 验证目标 ('body' | 'query' | 'params')
 */
const validateRequest = (schema, target = 'body') => {
  const validators = {
    body: validateBody,
    query: validateQuery,
    params: validateParams,
    headers: validateHeaders
  };
  
  const validator = validators[target] || validateBody;
  return validator(schema);
};

module.exports = {
  validateRequest,
  validateBody,
  validateQuery,
  validateParams,
  validateHeaders,
  validate,
  validateFile,
  validateIf,
  formatZodErrors
};
