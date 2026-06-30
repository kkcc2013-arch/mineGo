// backend/shared/middleware/logSecurityMiddleware.js
// REQ-00394: 日志安全中间件

'use strict';

const { masker, SensitiveDataMasker } = require('../SensitiveDataMasker');
const { createLogger } = require('../logger');

const logger = createLogger('log-security-middleware');

/**
 * 日志安全中间件类
 * 拦截日志输出，自动过滤敏感信息
 */
class LogSecurityMiddleware {
  constructor(config = {}) {
    this.masker = new SensitiveDataMasker(config);
    this.enabled = config.enabled !== false;
    this.mode = config.mode || process.env.NODE_ENV || 'production';
    this.auditEnabled = config.auditEnabled !== false;
    
    // 拦截计数
    this.interceptCount = {
      info: 0,
      error: 0,
      warn: 0,
      debug: 0
    };
    
    logger.info('LogSecurityMiddleware initialized', {
      enabled: this.enabled,
      mode: this.mode,
      rulesCount: this.masker.getRulesCount()
    });
  }

  /**
   * 拦截 Logger 方法
   * @param {Object} targetLogger - 目标 logger 实例
   */
  interceptLogger(targetLogger) {
    const self = this;
    
    // 保存原始方法
    const originalMethods = {
      info: targetLogger.info.bind(targetLogger),
      error: targetLogger.error.bind(targetLogger),
      warn: targetLogger.warn.bind(targetLogger),
      debug: targetLogger.debug.bind(targetLogger)
    };
    
    // 重写 info 方法
    targetLogger.info = function(message, meta = {}) {
      const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
      self.interceptCount.info++;
      originalMethods.info(message, maskedMeta);
    };
    
    // 重写 error 方法
    targetLogger.error = function(message, meta = {}) {
      const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
      self.interceptCount.error++;
      originalMethods.error(message, maskedMeta);
    };
    
    // 重写 warn 方法
    targetLogger.warn = function(message, meta = {}) {
      const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
      self.interceptCount.warn++;
      originalMethods.warn(message, maskedMeta);
    };
    
    // 重写 debug 方法
    targetLogger.debug = function(message, meta = {}) {
      if (self.mode === 'development') {
        // 开发模式下不脱敏，方便调试
        originalMethods.debug(message, meta);
      } else {
        const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
        originalMethods.debug(message, maskedMeta);
      }
      self.interceptCount.debug++;
    };
    
    logger.info('Logger intercepted', {
      mode: this.mode,
      developmentSkip: this.mode === 'development'
    });
  }

  /**
   * 创建安全的日志上下文
   */
  createSafeContext(context) {
    return this.masker.mask(context, { service: 'context' });
  }

  /**
   * 手动脱敏
   */
  mask(data, context = {}) {
    return this.enabled ? this.masker.mask(data, context) : data;
  }

  /**
   * 临时禁用（用于调试）
   */
  disable() {
    this.enabled = false;
    logger.warn('LogSecurityMiddleware disabled');
  }

  /**
   * 启用
   */
  enable() {
    this.enabled = true;
    logger.info('LogSecurityMiddleware enabled');
  }

  /**
   * 获取拦截统计
   */
  getInterceptStats() {
    const total = Object.values(this.interceptCount).reduce((a, b) => a + b, 0);
    return {
      ...this.interceptCount,
      total,
      enabled: this.enabled,
      mode: this.mode
    };
  }

  /**
   * 获取脱敏统计
   */
  getMaskerStats() {
    return this.masker.getStats();
  }
}

/**
 * 请求日志安全中间件
 * 过滤 HTTP 请求中的敏感字段
 */
function requestLogSecurityMiddleware(options = {}) {
  const masker = new SensitiveDataMasker(options);
  const enabled = options.enabled !== false;
  
  return function(req, res, next) {
    const context = {
      service: req.serviceName || 'unknown',
      requestId: req.requestId,
      userId: req.user?.id,
      ip: req.ip || req.headers['x-forwarded-for'] || 'unknown'
    };
    
    // 过滤请求体
    if (enabled && req.body) {
      req.body = masker.mask(req.body, context);
    }
    
    // 过滤请求头
    if (enabled && req.headers) {
      req.filteredHeaders = masker.mask(req.headers, context);
    }
    
    // 过滤查询参数
    if (enabled && req.query) {
      req.query = masker.mask(req.query, context);
    }
    
    // 挂载 masker 到 req 对象，供手动使用
    req.masker = masker;
    req.maskContext = context;
    
    next();
  };
}

/**
 * 响应日志安全中间件
 * 过滤 HTTP 响应中的敏感字段
 */
function responseLogSecurityMiddleware(options = {}) {
  const masker = new SensitiveDataMasker(options);
  const enabled = options.enabled !== false;
  const filterResponseBody = options.filterResponseBody !== false;
  
  return function(req, res, next) {
    if (!enabled || !filterResponseBody) {
      return next();
    }
    
    const context = {
      service: req.serviceName || 'unknown',
      requestId: req.requestId,
      userId: req.user?.id
    };
    
    // 保存原始 res.json 方法
    const originalJson = res.json.bind(res);
    
    // 重写 res.json 方法
    res.json = function(data) {
      const maskedData = masker.mask(data, context);
      return originalJson(maskedData);
    };
    
    next();
  };
}

/**
 * 控制台安全代理
 * 拦截 console 方法，过滤敏感信息
 */
function setupConsoleSecurity(options = {}) {
  const masker = new SensitiveDataMasker(options);
  const enabled = options.enabled !== false;
  
  // 保存原始方法
  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };
  
  // 辅助函数：过滤参数
  const filterArgs = (args) => {
    if (!enabled) return args;
    
    return args.map(arg => {
      if (typeof arg === 'object' && arg !== null) {
        return masker.mask(arg);
      }
      if (typeof arg === 'string') {
        // 简单字符串检测和替换
        return filterString(arg);
      }
      return arg;
    });
  };
  
  // 过滤字符串中的敏感信息
  const filterString = (str) => {
    if (typeof str !== 'string') return str;
    
    // 密码模式
    str = str.replace(/(?:"password"\s*:\s*")[^"]*"/gi, '"password":"******"');
    str = str.replace(/(?:"password"\s*:\s*)["'][^"']*["']/gi, '"password":"******"');
    
    // Token 模式
    str = str.replace(/(?:"token"\s*:\s*")[^"]*"/gi, '"token":"****"');
    str = str.replace(/(?:"apiKey"\s*:\s*")[^"]*"/gi, '"apiKey":"****"');
    
    // 邮箱模式
    str = str.replace(/[\w.-]+@[\w.-]+\.\w+/g, match => {
      const [local, domain] = match.split('@');
      return local[0] + '***@' + domain;
    });
    
    // 手机号模式
    str = str.replace(/\b1[3-9]\d{9}\b/g, match => {
      return match.slice(0, 3) + '****' + match.slice(-4);
    });
    
    return str;
  };
  
  // 重写 console 方法
  console.log = (...args) => originalConsole.log(...filterArgs(args));
  console.info = (...args) => originalConsole.info(...filterArgs(args));
  console.warn = (...args) => originalConsole.warn(...filterArgs(args));
  console.error = (...args) => originalConsole.error(...filterArgs(args));
  console.debug = (...args) => originalConsole.debug(...filterArgs(args));
  
  logger.info('Console security proxy installed');
  
  // 返回恢复函数
  return function restoreConsole() {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
    logger.info('Console security proxy removed');
  };
}

module.exports = {
  LogSecurityMiddleware,
  requestLogSecurityMiddleware,
  responseLogSecurityMiddleware,
  setupConsoleSecurity
};