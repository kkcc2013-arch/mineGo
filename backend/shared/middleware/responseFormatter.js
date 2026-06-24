'use strict';
/**
 * 统一响应格式化中间件
 * REQ-00307: API 请求参数验证与响应格式一致性中间件系统
 * 
 * 提供标准化的 API 响应格式
 */

const logger = require('../logger');
const { v4: uuidv4 } = require('uuid');
const { ValidationErrorCodes, getHttpStatus } = require('../validators/errorCodes');

/**
 * 标准响应格式
 * @typedef {Object} ApiResponse
 * @property {boolean} success - 是否成功
 * @property {Object} [data] - 成功时返回的数据
 * @property {Object} [error] - 失败时的错误信息
 * @property {Object} meta - 元数据
 */

/**
 * 响应格式化中间件
 * 为 res 对象添加 apiSuccess 和 apiError 方法
 */
function responseFormatter(req, res, next) {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || 
                    req.id || 
                    generateRequestId();

  // 存储 requestId 到 res.locals
  res.locals.requestId = requestId;
  res.locals.startTime = startTime;

  /**
   * 发送成功响应
   * @param {*} data - 响应数据
   * @param {Object} options - 可选配置
   * @param {number} [options.statusCode=200] - HTTP 状态码
   * @param {Object} [options.meta] - 额外的元数据
   */
  res.apiSuccess = (data, options = {}) => {
    const { statusCode = 200, meta = {} } = options;
    
    const response = {
      success: true,
      data,
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        ...meta
      }
    };

    logger.debug('API Success Response', {
      requestId,
      statusCode,
      duration: response.meta.duration
    });

    res.status(statusCode).json(response);
  };

  /**
   * 发送错误响应
   * @param {string} code - 错误码
   * @param {string} message - 错误消息
   * @param {Array} [details] - 详细错误列表
   * @param {Object} options - 可选配置
   * @param {number} [options.statusCode] - HTTP 状态码（自动从错误码推断）
   */
  res.apiError = (code, message, details = null, options = {}) => {
    const httpStatus = options.statusCode || getHttpStatus(code);
    
    const response = {
      success: false,
      error: {
        code,
        message,
        details,
        requestId
      },
      meta: {
        requestId,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime
      }
    };

    logger.warn('API Error Response', {
      requestId,
      code,
      message,
      httpStatus,
      duration: response.meta.duration,
      detailsCount: details?.length || 0
    });

    res.status(httpStatus).json(response);
  };

  /**
   * 发送分页响应
   * @param {Array} items - 数据项列表
   * @param {Object} pagination - 分页信息
   * @param {number} pagination.page - 当前页
   * @param {number} pagination.pageSize - 每页数量
   * @param {number} pagination.total - 总数
   */
  res.apiPaginated = (items, pagination) => {
    const { page, pageSize, total } = pagination;
    const totalPages = Math.ceil(total / pageSize);
    
    res.apiSuccess({
      items,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });
  };

  /**
   * 发送创建成功响应
   * @param {*} data - 创建的资源数据
   * @param {string} [location] - 新资源的 URI
   */
  res.apiCreated = (data, location = null) => {
    if (location) {
      res.setHeader('Location', location);
    }
    res.apiSuccess(data, { statusCode: 201 });
  };

  /**
   * 发送无内容响应（删除成功）
   */
  res.apiNoContent = () => {
    const duration = Date.now() - startTime;
    logger.debug('API No Content Response', {
      requestId,
      duration
    });
    res.status(204).send();
  };

  /**
   * 发送已接受响应（异步处理）
   * @param {string} taskId - 任务 ID
   * @param {string} statusUrl - 状态查询 URL
   */
  res.apiAccepted = (taskId, statusUrl) => {
    res.apiSuccess(
      { taskId, statusUrl },
      { statusCode: 202 }
    );
  };

  next();
}

/**
 * 生成请求 ID
 */
function generateRequestId() {
  return `req_${Date.now()}_${uuidv4().split('-')[0]}`;
}

/**
 * 兼容旧响应格式的适配器
 * 用于渐进式迁移
 */
function legacyResponseAdapter(req, res, next) {
  const originalJson = res.json.bind(res);
  
  res.json = (data) => {
    // 如果响应已经是标准格式，直接返回
    if (data && typeof data === 'object' && 
        'success' in data && 'meta' in data) {
      return originalJson(data);
    }
    
    // 如果是错误响应
    if (data && typeof data === 'object' && 'error' in data) {
      return res.apiError(
        data.code || 'UNKNOWN_ERROR',
        data.message || data.error,
        data.details
      );
    }
    
    // 否则自动包装为成功响应
    return res.apiSuccess(data);
  };
  
  next();
}

/**
 * 响应时间统计中间件
 * 在响应头发送时记录耗时
 */
function responseTimeTracker(req, res, next) {
  const startTime = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    // 记录慢请求
    if (duration > 1000) {
      logger.warn('Slow request detected', {
        method: req.method,
        path: req.path,
        duration,
        statusCode: res.statusCode
      });
    }
    
    // 设置响应时间头
    res.setHeader('X-Response-Time', `${duration}ms`);
  });
  
  next();
}

module.exports = {
  responseFormatter,
  legacyResponseAdapter,
  responseTimeTracker,
  generateRequestId
};
