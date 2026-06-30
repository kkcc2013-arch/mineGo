// backend/shared/middleware/sensitiveDataFilter.js
// REQ-00394: 请求响应敏感数据过滤器

'use strict';

const { SensitiveDataMasker } = require('../SensitiveDataMasker');
const { createLogger } = require('../logger');

const logger = createLogger('sensitive-data-filter');

/**
 * 敏感数据过滤器中间件
 * 自动过滤 HTTP 请求/响应中的敏感字段
 * 
 * @param {Object} options - 配置选项
 * @param {boolean} options.filterRequestBody - 是否过滤请求体（默认 true）
 * @param {boolean} options.filterResponseBody - 是否过滤响应体（默认 true）
 * @param {boolean} options.filterHeaders - 是否过滤请求头（默认 true）
 * @param {boolean} options.filterQuery - 是否过滤查询参数（默认 true）
 * @param {Array<string>} options.skipRoutes - 跳过的路由列表
 */
function sensitiveDataFilter(options = {}) {
  const masker = new SensitiveDataMasker(options);
  
  const config = {
    filterRequestBody: options.filterRequestBody !== false,
    filterResponseBody: options.filterResponseBody !== false,
    filterHeaders: options.filterHeaders !== false,
    filterQuery: options.filterQuery !== false,
    skipRoutes: options.skipRoutes || [],
    logFiltered: options.logFiltered || false
  };
  
  // 敏感请求头列表
  const sensitiveHeaders = [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-access-token',
    'x-refresh-token',
    'x-session-id'
  ];
  
  logger.info('SensitiveDataFilter initialized', {
    filterRequestBody: config.filterRequestBody,
    filterResponseBody: config.filterResponseBody,
    filterHeaders: config.filterHeaders,
    filterQuery: config.filterQuery
  });
  
  return function(req, res, next) {
    // 检查是否跳过该路由
    const shouldSkip = config.skipRoutes.some(route => {
      if (typeof route === 'string') {
        return req.path === route || req.path.startsWith(route);
      }
      if (route instanceof RegExp) {
        return route.test(req.path);
      }
      return false;
    });
    
    if (shouldSkip) {
      return next();
    }
    
    // 构建上下文信息
    const context = {
      service: req.serviceName || process.env.SERVICE_NAME || 'unknown',
      requestId: req.requestId || req.headers['x-request-id'],
      userId: req.user?.id || req.userId,
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress,
      method: req.method,
      path: req.path,
      userAgent: req.headers['user-agent']
    };
    
    // ============================================================
    // 过滤请求体
    // ============================================================
    if (config.filterRequestBody && req.body && typeof req.body === 'object') {
      const originalBody = JSON.stringify(req.body).length;
      req.body = masker.mask(req.body, context);
      
      if (config.logFiltered) {
        logger.debug('Request body filtered', {
          originalSize: originalBody,
          maskedSize: JSON.stringify(req.body).length,
          path: req.path
        });
      }
    }
    
    // ============================================================
    // 过滤查询参数
    // ============================================================
    if (config.filterQuery && req.query && typeof req.query === 'object') {
      req.query = masker.mask(req.query, context);
    }
    
    // ============================================================
    // 过滤请求头
    // ============================================================
    if (config.filterHeaders && req.headers) {
      const filteredHeaders = {};
      const sensitiveHeaderMap = {};
      
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        
        if (sensitiveHeaders.includes(lowerKey)) {
          // 敏感请求头进行脱敏
          filteredHeaders[key] = masker.mask({ [key]: value }, context)[key];
          sensitiveHeaderMap[key] = true;
        } else {
          filteredHeaders[key] = value;
        }
      }
      
      // 将过滤后的请求头挂载到 req 对象
      req.filteredHeaders = filteredHeaders;
      req.sensitiveHeaders = Object.keys(sensitiveHeaderMap);
    }
    
    // ============================================================
    // 过滤响应体
    // ============================================================
    if (config.filterResponseBody) {
      // 保存原始 res.json 方法
      const originalJson = res.json.bind(res);
      
      // 重写 res.json 方法
      res.json = function(data) {
        if (data && typeof data === 'object') {
          const maskedData = masker.mask(data, context);
          return originalJson(maskedData);
        }
        return originalJson(data);
      };
      
      // 保存原始 res.send 方法
      const originalSend = res.send.bind(res);
      
      // 重写 res.send 方法
      res.send = function(data) {
        if (typeof data === 'string') {
          try {
            // 尝试解析 JSON 字符串
            const parsed = JSON.parse(data);
            const masked = masker.mask(parsed, context);
            return originalSend(JSON.stringify(masked));
          } catch (e) {
            // 非 JSON 字符串，直接返回
            return originalSend(data);
          }
        } else if (data && typeof data === 'object') {
          const maskedData = masker.mask(data, context);
          return originalSend(maskedData);
        }
        return originalSend(data);
      };
    }
    
    // ============================================================
    // 挂载 masker 到 req 对象，供手动使用
    // ============================================================
    req.masker = masker;
    req.maskContext = context;
    
    // 添加辅助方法：手动脱敏
    req.maskData = (data) => masker.mask(data, context);
    
    // 添加辅助方法：检查字段是否敏感
    req.isSensitiveField = (fieldName) => {
      const rule = masker.findMatchingRule(fieldName, fieldName.toLowerCase());
      return rule !== null;
    };
    
    next();
  };
}

/**
 * 敏感数据检测中间件
 * 检测请求中是否包含未加密的敏感数据
 */
function sensitiveDataDetector(options = {}) {
  const masker = new SensitiveDataMasker(options);
  
  return function(req, res, next) {
    const detected = {
      requestBody: [],
      queryParams: [],
      headers: []
    };
    
    // 检测请求体
    if (req.body && typeof req.body === 'object') {
      detectSensitiveFields(req.body, '', detected.requestBody, masker);
    }
    
    // 检测查询参数
    if (req.query && typeof req.query === 'object') {
      detectSensitiveFields(req.query, '', detected.queryParams, masker);
    }
    
    // 检测请求头
    if (req.headers) {
      for (const [key, value] of Object.entries(req.headers)) {
        const rule = masker.findMatchingRule(key, key.toLowerCase());
        if (rule) {
          detected.headers.push({
            field: key,
            rule: rule.name,
            category: rule.category
          });
        }
      }
    }
    
    // 将检测结果挂载到 req 对象
    req.sensitiveDataDetected = detected;
    
    // 如果检测到敏感数据，记录警告
    const totalDetected = 
      detected.requestBody.length + 
      detected.queryParams.length + 
      detected.headers.length;
    
    if (totalDetected > 0) {
      logger.warn('Sensitive data detected in request', {
        requestBody: detected.requestBody.length,
        queryParams: detected.queryParams.length,
        headers: detected.headers.length,
        path: req.path,
        method: req.method
      });
    }
    
    next();
  };
}

/**
 * 递归检测敏感字段
 */
function detectSensitiveFields(obj, prefix, results, masker) {
  if (!obj || typeof obj !== 'object') {
    return;
  }
  
  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    const rule = masker.findMatchingRule(key, key.toLowerCase());
    
    if (rule) {
      results.push({
        field: fieldPath,
        rule: rule.name,
        category: rule.category,
        priority: rule.priority
      });
    }
    
    // 递归检测嵌套对象
    if (value && typeof value === 'object') {
      detectSensitiveFields(value, fieldPath, results, masker);
    }
  }
}

/**
 * GraphQL 敏感数据过滤器
 * 专门用于 GraphQL 请求和响应
 */
function graphqlSensitiveDataFilter(options = {}) {
  const masker = new SensitiveDataMasker(options);
  
  return function(req, res, next) {
    // 只处理 GraphQL 请求
    if (!req.path.includes('/graphql')) {
      return next();
    }
    
    const context = {
      service: 'graphql',
      requestId: req.requestId,
      userId: req.user?.id
    };
    
    // 过滤 GraphQL 查询变量
    if (req.body && req.body.variables) {
      req.body.variables = masker.mask(req.body.variables, context);
    }
    
    // 过滤 GraphQL 响应
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (data && data.data) {
        data.data = masker.mask(data.data, context);
      }
      return originalJson(data);
    };
    
    next();
  };
}

/**
 * WebSocket 敏感数据过滤器
 */
function websocketSensitiveDataFilter(options = {}) {
  const masker = new SensitiveDataMasker(options);
  
  return function(ws, req, next) {
    // 挂载 masker 到 ws 对象
    ws.masker = masker;
    ws.maskContext = {
      service: 'websocket',
      userId: req.user?.id
    };
    
    // 保存原始 send 方法
    const originalSend = ws.send.bind(ws);
    
    // 重写 send 方法
    ws.send = function(data, options, callback) {
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          const masked = masker.mask(parsed, ws.maskContext);
          return originalSend(JSON.stringify(masked), options, callback);
        } catch (e) {
          // 非 JSON 数据，直接发送
          return originalSend(data, options, callback);
        }
      }
      return originalSend(data, options, callback);
    };
    
    if (next) next();
  };
}

module.exports = {
  sensitiveDataFilter,
  sensitiveDataDetector,
  graphqlSensitiveDataFilter,
  websocketSensitiveDataFilter
};