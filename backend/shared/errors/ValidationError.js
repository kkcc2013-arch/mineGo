const BaseError = require('./BaseError');

/**
 * ValidationError - 参数验证错误
 * 用于请求参数不符合要求的情况
 */
class ValidationError extends BaseError {
  constructor(message, details = {}) {
    super(400, message, {
      statusCode: 400,
      details,
      isOperational: true
    });
  }
}

/**
 * 创建字段验证错误
 */
ValidationError.field = (fieldName, message, value = null) => {
  return new ValidationError(`Validation failed for field '${fieldName}': ${message}`, {
    field: fieldName,
    value,
    reason: message
  });
};

/**
 * 创建必填字段错误
 */
ValidationError.required = (fieldName) => {
  return new ValidationError(`Field '${fieldName}' is required`, {
    field: fieldName,
    reason: 'required'
  });
};

/**
 * 创建字段类型错误
 */
ValidationError.type = (fieldName, expectedType, actualType) => {
  return new ValidationError(`Field '${fieldName}' must be ${expectedType}, got ${actualType}`, {
    field: fieldName,
    expected: expectedType,
    actual: actualType,
    reason: 'type_mismatch'
  });
};

/**
 * 创建字段范围错误
 */
ValidationError.range = (fieldName, min, max, actual) => {
  return new ValidationError(`Field '${fieldName}' must be between ${min} and ${max}, got ${actual}`, {
    field: fieldName,
    min,
    max,
    actual,
    reason: 'out_of_range'
  });
};

module.exports = ValidationError;
