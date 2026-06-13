// backend/shared/errors/NotFoundError.js - 资源不存在错误
'use strict';

const BaseError = require('./BaseError');
const ERROR_CODES = require('./errorCodes');

/**
 * 资源不存在错误
 * 
 * 用于请求资源未找到的场景
 */
class NotFoundError extends BaseError {
  /**
   * @param {string} resource 资源名称
   * @param {string} identifier 资源标识
   * @param {Object} options 额外选项
   */
  constructor(resource, identifier = null, options = {}) {
    super(
      ERROR_CODES.NOT_FOUND || 'RES-001',
      `${resource} not found`,
      {
        statusCode: 404,
        isOperational: true,
        details: {
          resource,
          identifier,
          ...options.details
        },
        ...options
      }
    );
    
    this.resource = resource;
    this.identifier = identifier;
    this.name = 'NotFoundError';
  }
  
  get category() {
    return 'not_found';
  }
  
  get severity() {
    return 'info';
  }
}

module.exports = NotFoundError;
