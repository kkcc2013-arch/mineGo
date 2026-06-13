const BaseError = require('./BaseError');

/**
 * DatabaseError - 数据库错误
 * 用于数据库操作失败的情况
 */
class DatabaseError extends BaseError {
  constructor(message, details = {}) {
    super(500, message, {
      statusCode: 500,
      details,
      isOperational: false // 数据库错误通常不可预期
    });
  }
}

/**
 * 创建连接错误
 */
DatabaseError.connectionFailed = (database = 'database') => {
  return new DatabaseError(`Failed to connect to ${database}`, {
    reason: 'connection_failed',
    database
  });
};

/**
 * 创建查询错误
 */
DatabaseError.queryFailed = (operation, originalError = null) => {
  const error = new DatabaseError(`Database query failed: ${operation}`, {
    reason: 'query_failed',
    operation
  });
  
  if (originalError) {
    error.details.originalError = originalError.message;
    error.stack = originalError.stack;
  }
  
  return error;
};

/**
 * 创建事务错误
 */
DatabaseError.transactionFailed = (operation, originalError = null) => {
  const error = new DatabaseError(`Database transaction failed: ${operation}`, {
    reason: 'transaction_failed',
    operation
  });
  
  if (originalError) {
    error.details.originalError = originalError.message;
  }
  
  return error;
};

/**
 * 创建唯一约束冲突错误
 */
DatabaseError.uniqueConstraintViolation = (constraint, value = null) => {
  return new DatabaseError(`Duplicate entry for constraint '${constraint}'`, {
    reason: 'unique_constraint_violation',
    constraint,
    value
  });
};

/**
 * 创建外键约束错误
 */
DatabaseError.foreignKeyViolation = (constraint, details = {}) => {
  return new DatabaseError(`Foreign key constraint violation: ${constraint}`, {
    reason: 'foreign_key_violation',
    constraint,
    ...details
  });
};

/**
 * 创建连接池耗尽错误
 */
DatabaseError.poolExhausted = (poolSize) => {
  return new DatabaseError('Database connection pool exhausted', {
    reason: 'pool_exhausted',
    poolSize
  });
};

module.exports = DatabaseError;
