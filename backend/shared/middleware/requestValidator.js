/**
 * Request Validator Middleware - API 请求参数验证中间件
 * 
 * 功能：
 * - 基于 OpenAPI Schema 自动验证请求参数
 * - 验证 path/query/header/body 参数
 * - 返回友好的错误提示
 * - 记录 Prometheus 指标
 * 
 * @module shared/middleware/requestValidator
 */

'use strict';

const { getSchemaValidator } = require('../schemaValidator');
const { createLogger } = require('../logger');
const metrics = require('../metrics');

const logger = createLogger('request-validator');

/**
 * 请求验证中间件
 * @param {Object} options - 配置选项
 * @param {string} options.version - API 版本 (默认 'v1')
 * @param {boolean} options.strict - 严格模式，找不到 Schema 时报错
 * @param {Function} options.onValidationError - 验证失败回调
 * @returns {Function} Express 中间件
 */
function requestValidatorMiddleware(options = {}) {
  const {
    version = 'v1',
    strict = false,
    onValidationError = null,
  } = options;

  const validator = getSchemaValidator();

  return async (req, res, next) => {
    // 获取 operationId（由 OpenAPI 中间件或路由注解设置）
    const operationId = req.openapi?.operationId || req.operationId;
    
    if (!operationId) {
      // 如果没有 operationId，跳过验证
      if (strict) {
        logger.warn('Request missing operationId', {
          method: req.method,
          path: req.path,
        });
      }
      return next();
    }

    const startTime = Date.now();

    try {
      // 构建验证数据
      const data = {};
      
      if (Object.keys(req.params).length > 0) {
        data.params = req.params;
      }
      
      if (Object.keys(req.query).length > 0) {
        data.query = req.query;
      }
      
      if (Object.keys(req.headers).length > 0) {
        // 提取相关 headers
        data.headers = {};
        const relevantHeaders = ['content-type', 'authorization', 'x-request-id', 'x-client-ver', 'x-platform'];
        relevantHeaders.forEach(h => {
          if (req.headers[h]) {
            data.headers[h] = req.headers[h];
          }
        });
      }
      
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
        data.body = req.body;
      }

      // 执行验证
      const result = validator.validateRequest(version, operationId, data);

      const duration = Date.now() - startTime;

      // 记录验证耗时
      if (metrics.apiValidationDuration) {
        metrics.apiValidationDuration.observe(
          { operationId, type: 'request' },
          duration / 1000
        );
      }

      if (!result.valid) {
        // 记录验证错误
        if (metrics.apiValidationErrors) {
          metrics.apiValidationErrors.inc({ operationId, type: 'request' });
        }

        logger.warn('Request validation failed', {
          operationId,
          method: req.method,
          path: req.path,
          errors: result.errors,
          traceId: req.headers['x-trace-id'],
        });

        // 调用自定义错误处理
        if (onValidationError) {
          return onValidationError(result.errors, req, res, next);
        }

        // 格式化错误响应
        const formattedErrors = formatValidationErrors(result.errors);

        return res.status(400).json({
          code: 1001,
          message: '请求参数不符合规范',
          data: {
            validationErrors: formattedErrors,
            operationId,
            traceId: req.headers['x-trace-id'],
          },
        });
      }

      next();
    } catch (error) {
      logger.error('Request validation error', {
        operationId,
        error: error.message,
        stack: error.stack,
      });

      // 内部错误，放行
      next();
    }
  };
}

/**
 * 格式化验证错误为友好提示
 * @param {Array} errors - Ajv 错误数组
 * @returns {Array} 格式化后的错误
 */
function formatValidationErrors(errors) {
  const friendlyMessages = {
    required: (params) => `缺少必填字段: ${params.missingProperty}`,
    type: (params) => `字段类型错误: 期望 ${params.type}, 实际值不符合`,
    minimum: (params) => `数值过小: 最小值为 ${params.minimum}`,
    maximum: (params) => `数值过大: 最大值为 ${params.maximum}`,
    exclusiveMinimum: (params) => `数值过小: 必须大于 ${params.exclusiveMinimum}`,
    exclusiveMaximum: (params) => `数值过大: 必须小于 ${params.exclusiveMaximum}`,
    minLength: (params) => `字符串过短: 最小长度 ${params.limit}`,
    maxLength: (params) => `字符串过长: 最大长度 ${params.limit}`,
    pattern: (params) => `格式不正确: 应匹配 ${params.pattern}`,
    format: (params) => `格式不正确: 应为 ${params.format} 格式`,
    enum: (params) => `值不在允许范围内: 允许值 [${params.allowedValues?.join(', ') || params.allowedValues}]`,
    additionalProperties: (params) => `不允许的字段: ${params.additionalProperty}`,
    minItems: (params) => `数组元素过少: 最少 ${params.limit} 个`,
    maxItems: (params) => `数组元素过多: 最多 ${params.limit} 个`,
    minimum: (params) => `数值过小: 最小值为 ${params.minimum}`,
    multipleOf: (params) => `数值必须是 ${params.multipleOf} 的倍数`,
  };

  return errors.map(error => {
    const path = error.path || '';
    const params = error.params || {};
    
    // 获取友好错误消息
    const formatter = friendlyMessages[error.keyword];
    const message = formatter 
      ? formatter(params)
      : error.message;

    return {
      path,
      message,
      keyword: error.keyword,
      suggestion: getSuggestion(error),
    };
  });
}

/**
 * 获取修复建议
 * @param {Object} error - 错误对象
 * @returns {string} 修复建议
 */
function getSuggestion(error) {
  const suggestions = {
    required: '请确保该字段已填写',
    type: '请检查字段类型是否正确',
    minimum: '请确保数值不小于最小值',
    maximum: '请确保数值不大于最大值',
    minLength: '请增加字段内容长度',
    maxLength: '请减少字段内容长度',
    pattern: '请检查格式是否符合要求',
    format: '请检查格式是否正确（如邮箱、手机号等）',
    enum: '请选择允许的值之一',
    additionalProperties: '请删除该字段',
  };

  return suggestions[error.keyword] || '请检查字段值是否符合要求';
}

module.exports = {
  requestValidatorMiddleware,
  formatValidationErrors,
};
