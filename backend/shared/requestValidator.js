/**
 * Request Validator - 统一的 API 请求参数验证中间件
 * 
 * 功能：
 * - 声明式参数验证规则定义
 * - 多种验证类型支持（类型、格式、范围、自定义）
 * - 高性能验证器缓存
 * - 统一的错误响应格式
 * - 注入攻击检测集成
 * 
 * @module shared/requestValidator
 * @version 1.0.0
 */

'use strict';

const { createLogger } = require('./logger');
const InjectionDetector = require('./injectionDetector');

const logger = createLogger('request-validator');

/**
 * 验证规则类型定义
 */
const VALIDATOR_TYPES = {
  string: { check: (v) => typeof v === 'string', name: 'string' },
  number: { check: (v) => typeof v === 'number' && !isNaN(v), name: 'number' },
  integer: { check: (v) => Number.isInteger(v), name: 'integer' },
  boolean: { check: (v) => typeof v === 'boolean', name: 'boolean' },
  array: { check: (v) => Array.isArray(v), name: 'array' },
  object: { check: (v) => v !== null && typeof v === 'object' && !Array.isArray(v), name: 'object' },
  date: { check: (v) => v instanceof Date || !isNaN(Date.parse(v)), name: 'date' }
};

/**
 * 格式验证器
 */
const FORMAT_VALIDATORS = {
  email: {
    check: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    name: 'email',
    message: 'Invalid email format'
  },
  url: {
    check: (v) => {
      try {
        new URL(v);
        return true;
      } catch {
        return false;
      }
    },
    name: 'url',
    message: 'Invalid URL format'
  },
  uuid: {
    check: (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v),
    name: 'uuid',
    message: 'Invalid UUID format'
  },
  objectId: {
    check: (v) => /^[a-f0-9]{24}$/i.test(v),
    name: 'objectId',
    message: 'Invalid ObjectId format'
  },
  phone: {
    check: (v) => /^1[3-9]\d{9}$/.test(v) || /^\+?[1-9]\d{1,14}$/.test(v),
    name: 'phone',
    message: 'Invalid phone number format'
  },
  ip: {
    check: (v) => /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(v) ||
                 /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(v),
    name: 'ip',
    message: 'Invalid IP address format'
  },
  lat: {
    check: (v) => typeof v === 'number' && v >= -90 && v <= 90,
    name: 'latitude',
    message: 'Latitude must be between -90 and 90'
  },
  lng: {
    check: (v) => typeof v === 'number' && v >= -180 && v <= 180,
    name: 'longitude',
    message: 'Longitude must be between -180 and 180'
  }
};

/**
 * 验证器缓存
 */
class ValidatorCache {
  constructor(maxSize = 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key) {
    return this.cache.get(key);
  }

  set(key, validator) {
    if (this.cache.size >= this.maxSize) {
      // LRU: 删除最旧的条目
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, validator);
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }
}

/**
 * 验证错误类
 */
class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.code = 400001;
    this.errors = errors;
  }

  toJSON(requestId) {
    return {
      success: false,
      error: {
        code: this.code,
        name: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: this.errors.map(err => ({
          field: err.field,
          code: err.code,
          message: err.message,
          received: err.received,
          expected: err.expected,
          i18nKey: `validation.${err.code.toLowerCase()}`
        }))
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString()
      }
    };
  }
}

/**
 * 验证规则编译器
 */
class ValidatorCompiler {
  constructor() {
    this.cache = new ValidatorCache();
  }

  /**
   * 编译验证规则
   * @param {Object} schema - 验证规则
   * @returns {Function} 验证函数
   */
  compile(schema) {
    const cacheKey = JSON.stringify(schema);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const validators = [];
    
    for (const [location, fields] of Object.entries(schema)) {
      for (const [fieldName, rules] of Object.entries(fields)) {
        validators.push(this._compileFieldValidator(location, fieldName, rules));
      }
    }

    const validator = (data) => {
      const errors = [];
      for (const validate of validators) {
        const result = validate(data);
        if (result) {
          errors.push(result);
        }
      }
      return errors.length > 0 ? errors : null;
    };

    this.cache.set(cacheKey, validator);
    return validator;
  }

  /**
   * 编译字段验证器
   */
  _compileFieldValidator(location, fieldName, rules) {
    const checks = [];

    // Required 检查
    const isRequired = rules.required === true;
    
    // Type 检查
    if (rules.type) {
      const typeValidator = VALIDATOR_TYPES[rules.type];
      if (!typeValidator) {
        throw new Error(`Unknown type: ${rules.type}`);
      }
      checks.push({
        name: 'type',
        validate: (value) => typeValidator.check(value),
        message: `Expected ${typeValidator.name}, received ${typeof value}`,
        code: 'INVALID_TYPE'
      });
    }

    // Format 检查
    if (rules.format) {
      const formatValidator = FORMAT_VALIDATORS[rules.format];
      if (!formatValidator) {
        throw new Error(`Unknown format: ${rules.format}`);
      }
      checks.push({
        name: 'format',
        validate: (value) => formatValidator.check(value),
        message: formatValidator.message,
        code: 'INVALID_FORMAT'
      });
    }

    // Enum 检查
    if (rules.enum) {
      const enumValues = Array.isArray(rules.enum) ? rules.enum : [rules.enum];
      checks.push({
        name: 'enum',
        validate: (value) => enumValues.includes(value),
        message: `Value must be one of: ${enumValues.join(', ')}`,
        code: 'INVALID_ENUM',
        expected: enumValues
      });
    }

    // Pattern 检查
    if (rules.pattern) {
      const pattern = rules.pattern instanceof RegExp ? rules.pattern : new RegExp(rules.pattern);
      checks.push({
        name: 'pattern',
        validate: (value) => pattern.test(value),
        message: `Value does not match required pattern`,
        code: 'INVALID_PATTERN'
      });
    }

    // Min 检查
    if (rules.min !== undefined) {
      checks.push({
        name: 'min',
        validate: (value) => value >= rules.min,
        message: `Value must be >= ${rules.min}`,
        code: 'INVALID_RANGE',
        expected: `>= ${rules.min}`
      });
    }

    // Max 检查
    if (rules.max !== undefined) {
      checks.push({
        name: 'max',
        validate: (value) => value <= rules.max,
        message: `Value must be <= ${rules.max}`,
        code: 'INVALID_RANGE',
        expected: `<= ${rules.max}`
      });
    }

    // MinLength 检查
    if (rules.minLength !== undefined) {
      checks.push({
        name: 'minLength',
        validate: (value) => value.length >= rules.minLength,
        message: `Length must be >= ${rules.minLength}`,
        code: 'INVALID_LENGTH',
        expected: `>= ${rules.minLength}`
      });
    }

    // MaxLength 检查
    if (rules.maxLength !== undefined) {
      checks.push({
        name: 'maxLength',
        validate: (value) => value.length <= rules.maxLength,
        message: `Length must be <= ${rules.maxLength}`,
        code: 'INVALID_LENGTH',
        expected: `<= ${rules.maxLength}`
      });
    }

    // MinItems 检查（数组）
    if (rules.minItems !== undefined) {
      checks.push({
        name: 'minItems',
        validate: (value) => Array.isArray(value) && value.length >= rules.minItems,
        message: `Array must have >= ${rules.minItems} items`,
        code: 'ARRAY_LIMIT',
        expected: `>= ${rules.minItems}`
      });
    }

    // MaxItems 检查（数组）
    if (rules.maxItems !== undefined) {
      checks.push({
        name: 'maxItems',
        validate: (value) => Array.isArray(value) && value.length <= rules.maxItems,
        message: `Array must have <= ${rules.maxItems} items`,
        code: 'ARRAY_LIMIT_EXCEEDED',
        expected: `<= ${rules.maxItems}`
      });
    }

    // Custom 检查
    if (typeof rules.validate === 'function') {
      checks.push({
        name: 'custom',
        validate: rules.validate,
        message: rules.customMessage || 'Custom validation failed',
        code: 'CUSTOM_VALIDATION_FAILED'
      });
    }

    // Items 检查（数组元素）
    if (rules.items && rules.type === 'array') {
      const itemValidator = this._compileItemValidator(rules.items);
      checks.push({
        name: 'items',
        validate: (value) => {
          if (!Array.isArray(value)) return true;
          for (let i = 0; i < value.length; i++) {
            const error = itemValidator(value[i]);
            if (error) {
              error.field = `${fieldName}[${i}]`;
              return false;
            }
          }
          return true;
        },
        message: 'Array item validation failed',
        code: 'ARRAY_ITEM_INVALID'
      });
    }

    // 返回验证函数
    return (data) => {
      const locationData = data[location] || {};
      const value = this._getFieldValue(locationData, fieldName);
      
      // Required 检查
      if (value === undefined || value === null) {
        if (isRequired) {
          return {
            field: `${location}.${fieldName}`,
            code: 'REQUIRED_FIELD_MISSING',
            message: `Field '${fieldName}' is required`,
            received: 'undefined'
          };
        }
        return null; // 可选字段且未提供，跳过验证
      }

      // 执行所有检查
      for (const check of checks) {
        try {
          if (!check.validate(value)) {
            return {
              field: `${location}.${fieldName}`,
              code: check.code,
              message: check.message,
              received: value,
              expected: check.expected
            };
          }
        } catch (error) {
          logger.error(`Validation check failed: ${check.name}`, {
            field: fieldName,
            error: error.message
          });
          return {
            field: `${location}.${fieldName}`,
            code: 'VALIDATION_ERROR',
            message: `Validation error: ${error.message}`,
            received: value
          };
        }
      }

      return null; // 验证通过
    };
  }

  /**
   * 编译数组元素验证器
   */
  _compileItemValidator(itemSchema) {
    const checks = [];
    
    if (itemSchema.type) {
      const typeValidator = VALIDATOR_TYPES[itemSchema.type];
      checks.push((value) => typeValidator.check(value));
    }

    return (value) => {
      for (const check of checks) {
        if (!check(value)) {
          return { valid: false };
        }
      }
      return null;
    };
  }

  /**
   * 获取字段值（支持嵌套路径）
   */
  _getFieldValue(obj, path) {
    const parts = path.split('.');
    let current = obj;
    
    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = current[part];
    }
    
    return current;
  }
}

/**
 * 创建验证中间件
 * @param {Object} schema - 验证规则
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function validateRequest(schema, options = {}) {
  const compiler = new ValidatorCompiler();
  const validator = compiler.compile(schema);
  
  const injectionDetector = options.enableInjectionDetection !== false 
    ? new InjectionDetector(options.injectionOptions || {})
    : null;

  return (req, res, next) => {
    const startTime = Date.now();
    const requestId = req.headers['x-request-id'] || `req-${Date.now()}`;

    try {
      // 提取请求数据
      const data = {
        body: req.body || {},
        query: req.query || {},
        params: req.params || {},
        headers: req.headers || {}
      };

      // 注入检测
      if (injectionDetector) {
        const injectionErrors = detectInjection(injectionDetector, data);
        if (injectionErrors.length > 0) {
          logger.warn('Injection attack detected', {
            requestId,
            errors: injectionErrors,
            ip: req.ip,
            path: req.path
          });

          return res.status(400).json({
            success: false,
            error: {
              code: 400006,
              name: 'INJECTION_DETECTED',
              message: 'Potential injection attack detected',
              details: injectionErrors.map(err => ({
                field: err.field,
                type: err.type,
                severity: err.severity
              }))
            },
            meta: {
              requestId,
              timestamp: new Date().toISOString()
            }
          });
        }
      }

      // 参数验证
      const errors = validator(data);
      
      if (errors) {
        logger.warn('Request validation failed', {
          requestId,
          errors,
          path: req.path,
          method: req.method
        });

        const validationError = new ValidationError(errors);
        return res.status(400).json(validationError.toJSON(requestId));
      }

      // 验证通过
      const duration = Date.now() - startTime;
      if (duration > 5) {
        logger.warn('Slow validation', {
          requestId,
          duration,
          path: req.path
        });
      }

      next();
    } catch (error) {
      logger.error('Validation middleware error', {
        requestId,
        error: error.message,
        stack: error.stack
      });

      res.status(500).json({
        success: false,
        error: {
          code: 500000,
          name: 'INTERNAL_ERROR',
          message: 'Validation processing error'
        },
        meta: {
          requestId,
          timestamp: new Date().toISOString()
        }
      });
    }
  };
}

/**
 * 检测注入攻击
 */
function detectInjection(detector, data) {
  const errors = [];
  
  const checkValue = (value, path) => {
    if (typeof value === 'string') {
      const result = detector.detect(value);
      if (result.detected) {
        errors.push({
          field: path,
          type: result.type,
          severity: result.severity
        });
      }
    } else if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          checkValue(item, `${path}[${index}]`);
        });
      } else {
        for (const [key, val] of Object.entries(value)) {
          checkValue(val, `${path}.${key}`);
        }
      }
    }
  };

  for (const [location, obj] of Object.entries(data)) {
    checkValue(obj, location);
  }

  return errors;
}

/**
 * 链式 API - Body 验证器
 */
class BodyValidator {
  constructor() {
    this.fields = {};
  }

  field(name) {
    this._currentField = name;
    this.fields[name] = {};
    return this;
  }

  required() {
    this.fields[this._currentField].required = true;
    return this;
  }

  optional() {
    this.fields[this._currentField].required = false;
    return this;
  }

  isString() {
    this.fields[this._currentField].type = 'string';
    return this;
  }

  isNumber() {
    this.fields[this._currentField].type = 'number';
    return this;
  }

  isInt(options = {}) {
    this.fields[this._currentField].type = 'integer';
    if (options.min !== undefined) this.fields[this._currentField].min = options.min;
    if (options.max !== undefined) this.fields[this._currentField].max = options.max;
    return this;
  }

  isBoolean() {
    this.fields[this._currentField].type = 'boolean';
    return this;
  }

  isArray(options = {}) {
    this.fields[this._currentField].type = 'array';
    if (options.minItems !== undefined) this.fields[this._currentField].minItems = options.minItems;
    if (options.maxItems !== undefined) this.fields[this._currentField].maxItems = options.maxItems;
    return this;
  }

  isEmail() {
    this.fields[this._currentField].type = 'string';
    this.fields[this._currentField].format = 'email';
    return this;
  }

  isUrl() {
    this.fields[this._currentField].type = 'string';
    this.fields[this._currentField].format = 'url';
    return this;
  }

  isUuid() {
    this.fields[this._currentField].type = 'string';
    this.fields[this._currentField].format = 'uuid';
    return this;
  }

  isObjectId() {
    this.fields[this._currentField].type = 'string';
    this.fields[this._currentField].format = 'objectId';
    return this;
  }

  default(value) {
    this.fields[this._currentField].default = value;
    return this;
  }

  build() {
    return this.fields;
  }
}

/**
 * 链式 API - Query 验证器
 */
class QueryValidator extends BodyValidator {}

/**
 * 链式 API - Headers 验证器
 */
class HeadersValidator extends BodyValidator {}

/**
 * 链式 API 工厂函数
 */
function body() {
  return new BodyValidator();
}

function query() {
  return new QueryValidator();
}

function headers() {
  return new HeadersValidator();
}

/**
 * 导出模块
 */
module.exports = {
  validateRequest,
  ValidationError,
  ValidatorCompiler,
  ValidatorCache,
  BodyValidator,
  QueryValidator,
  HeadersValidator,
  body,
  query,
  headers,
  VALIDATOR_TYPES,
  FORMAT_VALIDATORS
};
