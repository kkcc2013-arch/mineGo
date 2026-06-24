'use strict';
/**
 * 统一请求参数验证中间件
 * REQ-00307: API 请求参数验证与响应格式一致性中间件系统
 * 
 * 基于 Zod 的请求参数验证，支持 body、query、params
 */

const { z } = require('zod');
const logger = require('../logger');
const i18n = require('../i18n');

/**
 * 验证错误详情
 * @typedef {Object} ValidationErrorDetail
 * @property {string} field - 字段路径
 * @property {string} message - 错误消息
 * @property {*} value - 原始值
 * @property {string} constraint - 验证规则类型
 */

/**
 * 格式化 Zod 错误
 * @param {z.ZodError} error - Zod 错误对象
 * @param {string} locale - 语言区域
 * @returns {ValidationErrorDetail[]} - 格式化后的错误详情列表
 */
function formatZodErrors(error, locale = 'zh-CN') {
  return error.errors.map(err => {
    const field = err.path.join('.');
    const constraint = err.code;
    
    // 获取本地化消息
    const message = getLocalizedMessage(err, locale);
    
    // 获取原始值（安全地）
    const value = getFieldValue(error.data, err.path);
    
    return {
      field,
      message,
      value: value !== undefined ? truncateValue(value) : undefined,
      constraint
    };
  });
}

/**
 * 获取字段值
 */
function getFieldValue(data, path) {
  if (!data) return undefined;
  
  let value = data;
  for (const key of path) {
    if (value === null || value === undefined) return undefined;
    value = value[key];
  }
  return value;
}

/**
 * 截断过长的值（防止日志泄露敏感信息）
 */
function truncateValue(value) {
  if (typeof value === 'string' && value.length > 50) {
    return value.substring(0, 50) + '...';
  }
  if (typeof value === 'object') {
    return '[object]';
  }
  return value;
}

/**
 * 获取本地化错误消息
 */
function getLocalizedMessage(err, locale) {
  const messages = getLocaleMessages(locale);
  
  // 尝试获取特定错误码的翻译
  const key = err.code;
  if (messages[key]) {
    if (typeof messages[key] === 'function') {
      return messages[key](err);
    }
    return messages[key];
  }
  
  // 回退到原始消息
  return err.message;
}

/**
 * 获取语言区域的消息映射
 */
function getLocaleMessages(locale) {
  const zhCNMessages = {
    invalid_type: (err) => `字段类型无效，期望 ${err.expected}，实际 ${err.received}`,
    invalid_literal: (err) => `值必须等于 ${err.expected}`,
    custom: '自定义验证失败',
    invalid_string: {
      email: '邮箱格式无效',
      url: 'URL 格式无效',
      uuid: 'UUID 格式无效',
      regex: '字符串格式不符合要求',
      datetime: '日期时间格式无效',
      starts_with: (err) => `字符串必须以 "${err.prefix}" 开头`,
      ends_with: (err) => `字符串必须以 "${err.suffix}" 结尾`,
    },
    too_small: (err) => {
      if (err.type === 'string') return `字符串长度至少 ${err.minimum} 个字符`;
      if (err.type === 'number') return `数值必须大于等于 ${err.minimum}`;
      if (err.type === 'array') return `数组至少需要 ${err.minimum} 个元素`;
      if (err.type === 'set') return `集合至少需要 ${err.minimum} 个元素`;
      return `值太小`;
    },
    too_big: (err) => {
      if (err.type === 'string') return `字符串长度最多 ${err.maximum} 个字符`;
      if (err.type === 'number') return `数值必须小于等于 ${err.maximum}`;
      if (err.type === 'array') return `数组最多 ${err.maximum} 个元素`;
      if (err.type === 'set') return `集合最多 ${err.maximum} 个元素`;
      return `值太大`;
    },
    invalid_date: '日期格式无效',
    invalid_enum_value: (err) => `必须是以下值之一：${err.options.join(', ')}`,
    not_multiple_of: (err) => `数值必须是 ${err.multipleOf} 的倍数`,
  };
  
  const enUSMessages = {
    invalid_type: (err) => `Invalid type, expected ${err.expected}, received ${err.received}`,
    invalid_literal: (err) => `Value must equal ${err.expected}`,
    custom: 'Custom validation failed',
    invalid_string: {
      email: 'Invalid email format',
      url: 'Invalid URL format',
      uuid: 'Invalid UUID format',
      regex: 'String format does not match requirement',
      datetime: 'Invalid datetime format',
      starts_with: (err) => `String must start with "${err.prefix}"`,
      ends_with: (err) => `String must end with "${err.suffix}"`,
    },
    too_small: (err) => {
      if (err.type === 'string') return `String must be at least ${err.minimum} characters`;
      if (err.type === 'number') return `Number must be >= ${err.minimum}`;
      if (err.type === 'array') return `Array must have at least ${err.minimum} elements`;
      return `Value too small`;
    },
    too_big: (err) => {
      if (err.type === 'string') return `String must be at most ${err.maximum} characters`;
      if (err.type === 'number') return `Number must be <= ${err.maximum}`;
      if (err.type === 'array') return `Array must have at most ${err.maximum} elements`;
      return `Value too big`;
    },
    invalid_date: 'Invalid date format',
    invalid_enum_value: (err) => `Must be one of: ${err.options.join(', ')}`,
    not_multiple_of: (err) => `Number must be a multiple of ${err.multipleOf}`,
  };
  
  return locale === 'zh-CN' ? zhCNMessages : enUSMessages;
}

/**
 * 请求体验证中间件
 * @param {z.ZodSchema} schema - Zod Schema
 * @param {Object} options - 验证选项
 * @param {string} [options.locale='zh-CN'] - 语言区域
 * @param {boolean} [options.stripUnknown=true] - 是否移除未知字段
 */
function validateBody(schema, options = {}) {
  const { locale = 'zh-CN', stripUnknown = true } = options;
  
  return async (req, res, next) => {
    try {
      // 如果配置了 stripUnknown，使用 safeParse 并过滤
      if (stripUnknown) {
        const result = schema.safeParse(req.body);
        if (!result.success) {
          const details = formatZodErrors(result.error, locale);
          logger.warn('Request body validation failed', {
            requestId: res.locals.requestId,
            details,
            path: req.path
          });
          return res.apiError('VALIDATION_ERROR', '请求参数验证失败', details);
        }
        req.body = result.data;
      } else {
        req.body = await schema.parseAsync(req.body);
      }
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = formatZodErrors(error, locale);
        logger.warn('Request body validation failed', {
          requestId: res.locals.requestId,
          details,
          path: req.path
        });
        return res.apiError('VALIDATION_ERROR', '请求参数验证失败', details);
      }
      next(error);
    }
  };
}

/**
 * 查询参数验证中间件
 * @param {z.ZodSchema} schema - Zod Schema
 * @param {Object} options - 验证选项
 */
function validateQuery(schema, options = {}) {
  const { locale = 'zh-CN' } = options;
  
  return async (req, res, next) => {
    try {
      req.query = await schema.parseAsync(req.query);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = formatZodErrors(error, locale);
        logger.warn('Query params validation failed', {
          requestId: res.locals.requestId,
          details,
          path: req.path
        });
        return res.apiError('VALIDATION_ERROR', '查询参数验证失败', details);
      }
      next(error);
    }
  };
}

/**
 * 路径参数验证中间件
 * @param {z.ZodSchema} schema - Zod Schema
 * @param {Object} options - 验证选项
 */
function validateParams(schema, options = {}) {
  const { locale = 'zh-CN' } = options;
  
  return async (req, res, next) => {
    try {
      req.params = await schema.parseAsync(req.params);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = formatZodErrors(error, locale);
        logger.warn('Path params validation failed', {
          requestId: res.locals.requestId,
          details,
          path: req.path
        });
        return res.apiError('VALIDATION_ERROR', '路径参数验证失败', details);
      }
      next(error);
    }
  };
}

/**
 * Headers 验证中间件
 * @param {z.ZodSchema} schema - Zod Schema
 * @param {Object} options - 验证选项
 */
function validateHeaders(schema, options = {}) {
  const { locale = 'zh-CN' } = options;
  
  return async (req, res, next) => {
    try {
      // 将 headers 转换为小写键（Express 已经做了）
      req.headers = await schema.parseAsync(req.headers);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = formatZodErrors(error, locale);
        logger.warn('Headers validation failed', {
          requestId: res.locals.requestId,
          details,
          path: req.path
        });
        return res.apiError('VALIDATION_ERROR', '请求头验证失败', details);
      }
      next(error);
    }
  };
}

/**
 * 组合验证中间件
 * 同时验证多个参数源
 * @param {Object} schemas - Schema 配置对象
 * @param {z.ZodSchema} [schemas.body] - Body Schema
 * @param {z.ZodSchema} [schemas.query] - Query Schema
 * @param {z.ZodSchema} [schemas.params] - Params Schema
 */
function validate(schemas, options = {}) {
  const middlewares = [];
  
  if (schemas.body) {
    middlewares.push(validateBody(schemas.body, options));
  }
  if (schemas.query) {
    middlewares.push(validateQuery(schemas.query, options));
  }
  if (schemas.params) {
    middlewares.push(validateParams(schemas.params, options));
  }
  
  return middlewares;
}

/**
 * 文件上传验证中间件
 * @param {Object} options - 验证选项
 * @param {number} [options.maxSize] - 最大文件大小（字节）
 * @param {string[]} [options.allowedMimeTypes] - 允许的 MIME 类型
 * @param {string[]} [options.allowedExtensions] - 允许的扩展名
 */
function validateFile(options = {}) {
  const { maxSize, allowedMimeTypes, allowedExtensions } = options;
  
  return (req, res, next) => {
    const file = req.file;
    
    if (!file) {
      return res.apiError('MISSING_REQUIRED_FIELD', '缺少上传文件');
    }
    
    const errors = [];
    
    // 检查文件大小
    if (maxSize && file.size > maxSize) {
      errors.push({
        field: 'file.size',
        message: `文件大小超过限制（最大 ${formatBytes(maxSize)}）`,
        value: formatBytes(file.size),
        constraint: 'too_big'
      });
    }
    
    // 检查 MIME 类型
    if (allowedMimeTypes && !allowedMimeTypes.includes(file.mimetype)) {
      errors.push({
        field: 'file.mimetype',
        message: `不允许的文件类型（允许：${allowedMimeTypes.join(', ')})`,
        value: file.mimetype,
        constraint: 'invalid_type'
      });
    }
    
    // 检查扩展名
    if (allowedExtensions) {
      const ext = file.originalname.split('.').pop()?.toLowerCase();
      if (!allowedExtensions.includes(ext)) {
        errors.push({
          field: 'file.extension',
          message: `不允许的文件扩展名（允许：${allowedExtensions.join(', ')})`,
          value: ext,
          constraint: 'invalid_type'
        });
      }
    }
    
    if (errors.length > 0) {
      return res.apiError('VALIDATION_ERROR', '文件验证失败', errors);
    }
    
    next();
  };
}

/**
 * 格式化字节大小
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * 条件验证中间件
 * 根据条件决定是否执行验证
 * @param {Function} condition - 条件函数 (req) => boolean
 * @param {z.ZodSchema} schema - Zod Schema
 * @param {string} source - 参数来源（body/query/params）
 */
function validateIf(condition, schema, source = 'body', options = {}) {
  return async (req, res, next) => {
    if (condition(req)) {
      const validators = {
        body: validateBody,
        query: validateQuery,
        params: validateParams
      };
      return validators[source](schema, options)(req, res, next);
    }
    next();
  };
}

module.exports = {
  validateBody,
  validateQuery,
  validateParams,
  validateHeaders,
  validate,
  validateFile,
  validateIf,
  formatZodErrors,
  getLocalizedMessage,
  getLocaleMessages
};