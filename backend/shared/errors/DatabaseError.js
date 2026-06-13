// backend/shared/errors/DatabaseError.js - 数据库错误
'use strict';

const BaseError = require('./BaseError');
const ERROR_CODES = require('./errorCodes');

/**
 * 数据库错误
 * 
 * 用于数据库操作失败的场景
 */
class DatabaseError extends BaseError {
  /**
   * @param {string} operation 操作类型（query, insert, update, delete）
   * @param {string} message 错误消息
   * @param {Error} cause 原始错误
   * @param {Object} options 额外选项
   */
  constructor(operation, message, cause = null, options = {}) {
    const code = ERROR_CODES.DATABASE_ERROR || 'DB-001';
    super(code, message, {
      statusCode: 500,
      isOperational: false,
      details: {
        operation,
        ...options.details
      },
      cause,
      ...options
    });
    
    this.operation = operation;
    this.name = 'DatabaseError';
  }
  
  get category() {
    return 'database';
  }
  
  get severity() {
    return 'critical';
  }
  
  /**
   * 从 PostgreSQL 错误创建
   */
  static fromPostgresError(error, operation = 'query') {
    // 常见 PostgreSQL 错误码映射
    const pgErrorMap = {
      '23505': { code: 'DB-DUP', message: '数据已存在' },
      '23503': { code: 'DB-FK', message: '关联数据不存在' },
      '23502': { code: 'DB-NOTNULL', message: '必填字段为空' },
      '08006': { code: 'DB-CONN', message: '数据库连接失败' },
      '53300': { code: 'DB-POOL', message: '连接池已满' },
      '40P01': { code: 'DB-DEADLOCK', message: '检测到死锁' },
    };
    
    const mapped = pgErrorMap[error.code] || {};
    
    return new DatabaseError(
      operation,
      mapped.message || error.message || 'Database operation failed',
      error,
      {
        details: {
          pgCode: error.code,
          constraint: error.constraint,
          table: error.table
        }
      }
    );
  }
}

module.exports = DatabaseError;
