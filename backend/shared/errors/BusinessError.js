const BaseError = require('./BaseError');

/**
 * BusinessError - 业务逻辑错误
 * 用于业务规则校验失败的情况
 */
class BusinessError extends BaseError {
  constructor(code, message, details = {}) {
    super(code, message, {
      statusCode: 400,
      details,
      isOperational: true
    });
  }
}

/**
 * 创建资源未找到错误
 */
BusinessError.notFound = (resourceType, resourceId = null) => {
  const message = resourceId 
    ? `${resourceType} with id '${resourceId}' not found`
    : `${resourceType} not found`;
  
  return new BusinessError(404, message, {
    resourceType,
    resourceId,
    reason: 'not_found'
  });
};

/**
 * 创建资源已存在错误
 */
BusinessError.alreadyExists = (resourceType, field, value) => {
  return new BusinessError(409, `${resourceType} with ${field}='${value}' already exists`, {
    resourceType,
    field,
    value,
    reason: 'already_exists'
  });
};

/**
 * 创建操作不允许错误
 */
BusinessError.notAllowed = (operation, reason = '') => {
  const message = reason 
    ? `Operation '${operation}' not allowed: ${reason}`
    : `Operation '${operation}' not allowed`;
  
  return new BusinessError(403, message, {
    operation,
    reason: reason || 'forbidden'
  });
};

/**
 * 创建业务规则冲突错误
 */
BusinessError.conflict = (message, details = {}) => {
  return new BusinessError(409, message, {
    ...details,
    reason: 'conflict'
  });
};

/**
 * 创建资源状态错误
 */
BusinessError.invalidState = (resourceType, currentState, requiredState) => {
  return new BusinessError(400, 
    `${resourceType} is in state '${currentState}', requires '${requiredState}'`, {
    resourceType,
    currentState,
    requiredState,
    reason: 'invalid_state'
  });
};

module.exports = BusinessError;
