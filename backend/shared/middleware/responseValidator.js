/**
 * Response Validator Middleware - API 响应格式验证中间件
 * 
 * 功能：
 * - 开发/测试环境自动验证响应格式
 * - 检查响应是否符合 OpenAPI Schema
 * - 记录不一致问题
 * - 输出友好的警告信息
 * 
 * @module shared/middleware/responseValidator
 */

'use strict';

const { getSchemaValidator } = require('../schemaValidator');
const { createLogger } = require('../logger');
const metrics = require('../metrics');

const logger = createLogger('response-validator');

/**
 * 响应验证中间件
 * @param {Object} options - 配置选项
 * @param {string} options.version - API 版本 (默认 'v1')
 * @param {Array<string>} options.enabledEnvironments - 启用的环境
 * @param {boolean} options.throwOnError - 验证失败时抛出错误
 * @returns {Function} Express 中间件
 */
function responseValidatorMiddleware(options = {}) {
  const {
    version = 'v1',
    enabledEnvironments = ['development', 'test'],
    throwOnError = false,
  } = options;

  // 仅在指定环境启用
  if (!enabledEnvironments.includes(process.env.NODE_ENV)) {
    return (req, res, next) => next();
  }

  const validator = getSchemaValidator();

  return (req, res, next) => {
    // 获取 operationId
    const operationId = req.openapi?.operationId || req.operationId;
    
    if (!operationId) {
      return next();
    }

    // 拦截 res.json 方法
    const originalJson = res.json.bind(res);
    const originalSend = res.send?.bind(res);

    res.json = (data) => {
      validateResponse(validator, version, operationId, res.statusCode, data, req);
      return originalJson(data);
    };

    if (originalSend) {
      res.send = (data) => {
        if (typeof data === 'object') {
          validateResponse(validator, version, operationId, res.statusCode, data, req);
        }
        return originalSend(data);
      };
    }

    next();
  };
}

/**
 * 验证响应数据
 */
function validateResponse(validator, version, operationId, statusCode, data, req) {
  const startTime = Date.now();

  try {
    const result = validator.validateResponse(version, operationId, statusCode.toString(), data);

    const duration = Date.now() - startTime;

    // 记录验证耗时
    if (metrics.apiValidationDuration) {
      metrics.apiValidationDuration.observe(
        { operationId, type: 'response' },
        duration / 1000
      );
    }

    if (!result.valid) {
      // 记录验证错误
      if (metrics.apiValidationErrors) {
        metrics.apiValidationErrors.inc({ operationId, type: 'response' });
      }

      const errorInfo = {
        operationId,
        statusCode,
        errors: result.errors,
        actual: data,
        traceId: req.headers['x-trace-id'],
      };

      logger.warn('API 响应不符合 Schema', errorInfo);

      // 开发环境输出详细错误
      if (process.env.NODE_ENV === 'development') {
        console.error('\n❌ API 响应验证失败:');
        console.error(`   Operation: ${operationId}`);
        console.error(`   Status: ${statusCode}`);
        console.error('   Errors:');
        result.errors.forEach((err, i) => {
          console.error(`   ${i + 1}. ${err.path}: ${err.message}`);
        });
        console.error('   Expected Schema: 检查 OpenAPI 文档');
        console.error('');
      }

      // 测试环境抛出错误
      if (process.env.NODE_ENV === 'test' && process.env.API_VALIDATION_STRICT === 'true') {
        const error = new Error(`Response validation failed for ${operationId}`);
        error.validationErrors = result.errors;
        error.operationId = operationId;
        throw error;
      }
    }
  } catch (error) {
    logger.error('Response validation error', {
      operationId,
      error: error.message,
      stack: error.stack,
    });

    // 不影响正常响应
  }
}

module.exports = {
  responseValidatorMiddleware,
};
