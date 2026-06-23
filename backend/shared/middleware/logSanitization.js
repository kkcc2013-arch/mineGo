/**
 * Log Sanitization Middleware - 日志脱敏中间件
 * 
 * 自动检测并脱敏日志中的敏感信息，防止密钥泄露。
 * 
 * @module shared/middleware/logSanitization
 */

'use strict';

class LogSanitizer {
  constructor(options = {}) {
    this.sensitiveFields = options.sensitiveFields || [
      'password', 'token', 'secret', 'apiKey', 'api_key',
      'authorization', 'cookie', 'session', 'credential',
      'private_key', 'privateKey', 'access_token', 'refresh_token',
      'jwt_secret', 'master_key', 'encryption_key'
    ];
    
    this.patterns = [
      // Bearer Token
      /Bearer [A-Za-z0-9\-._~+/]+=*/g,
      // JWT Token
      /eyJ[A-Za-z0-9\-._~+/]+=*\.eyJ[A-Za-z0-9\-._~+/]+=*\.[A-Za-z0-9\-._~+/]+=*/g,
      // 长字符串（可能是密钥）
      /[A-Za-z0-9]{40,}/g,
      // 私钥
      /-----BEGIN.*PRIVATE KEY-----[\s\S]*?-----END.*PRIVATE KEY-----/g,
      // AWS 密钥
      /AKIA[A-Z0-9]{16}/g,
      // 连接字符串中的密码
      /(?:password|passwd|pwd)=([^;\s]+)/gi,
      // 邮箱
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    ];

    this.replacement = options.replacement || '[REDACTED]';
    this.enabled = options.enabled !== false;
  }

  /**
   * 脱敏对象
   * 
   * @param {any} obj - 要脱敏的对象
   * @param {number} depth - 递归深度限制
   * @returns {any} - 脱敏后的对象
   */
  sanitize(obj, depth = 10) {
    if (!this.enabled) {
      return obj;
    }

    if (depth <= 0) {
      return '[MAX_DEPTH_REACHED]';
    }

    if (obj === null || obj === undefined) {
      return obj;
    }

    // 字符串：检查模式并脱敏
    if (typeof obj === 'string') {
      return this.sanitizeString(obj);
    }

    // 数字、布尔、日期等：直接返回
    if (typeof obj !== 'object') {
      return obj;
    }

    // Buffer：转换为 base64（可能包含二进制数据）
    if (Buffer.isBuffer(obj)) {
      return '[Buffer]';
    }

    // Error 对象
    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: obj.message,
        stack: obj.stack ? this.sanitizeString(obj.stack) : undefined
      };
    }

    // 数组
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitize(item, depth - 1));
    }

    // 对象
    const sanitized = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      
      // 检查是否是敏感字段
      const isSensitive = this.sensitiveFields.some(
        field => lowerKey.includes(field.toLowerCase())
      );
      
      if (isSensitive) {
        sanitized[key] = this.replacement;
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitize(value, depth - 1);
      } else if (typeof value === 'string') {
        sanitized[key] = this.sanitizeString(value);
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * 脱敏字符串
   * 
   * @param {string} str - 要脱敏的字符串
   * @returns {string} - 脱敏后的字符串
   */
  sanitizeString(str) {
    if (!this.enabled || typeof str !== 'string') {
      return str;
    }

    let result = str;
    
    for (const pattern of this.patterns) {
      result = result.replace(pattern, this.replacement);
    }
    
    return result;
  }

  /**
   * 脱敏 HTTP 请求头
   */
  sanitizeHeaders(headers) {
    if (!this.enabled || !headers) {
      return headers;
    }

    const sanitized = {};
    
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      
      // 敏感头
      if (['authorization', 'cookie', 'set-cookie'].includes(lowerKey)) {
        sanitized[key] = this.replacement;
      } else {
        sanitized[key] = value;
      }
    }
    
    return sanitized;
  }

  /**
   * 脱敏 URL 查询参数
   */
  sanitizeQuery(query) {
    return this.sanitize(query);
  }

  /**
   * 脱敏请求体
   */
  sanitizeBody(body) {
    return this.sanitize(body);
  }

  /**
   * 检测字符串中的敏感信息
   * 
   * @param {string} str - 要检查的字符串
   * @returns {Array} - 检测到的敏感信息类型
   */
  detectSensitive(str) {
    const detected = [];
    
    const typePatterns = [
      { type: 'jwt', pattern: /eyJ[A-Za-z0-9\-._~+/]+=*\.eyJ[A-Za-z0-9\-._~+/]+=*\.[A-Za-z0-9\-._~+/]+=*/g },
      { type: 'bearer_token', pattern: /Bearer [A-Za-z0-9\-._~+/]+=*/g },
      { type: 'private_key', pattern: /-----BEGIN.*PRIVATE KEY-----/g },
      { type: 'aws_key', pattern: /AKIA[A-Z0-9]{16}/g },
      { type: 'password_in_url', pattern: /(?:password|passwd|pwd)=([^;\s]+)/gi }
    ];
    
    for (const { type, pattern } of typePatterns) {
      if (pattern.test(str)) {
        detected.push(type);
      }
    }
    
    return detected;
  }

  /**
   * 创建日志脱敏中间件
   */
  middleware() {
    return (req, res, next) => {
      // 保存原始方法
      const originalEnd = res.end;
      const originalWrite = res.write;
      const originalJson = res.json;
      const originalSend = res.send;
      
      // 脱敏请求信息
      req.sanitized = {
        headers: this.sanitizeHeaders(req.headers),
        query: this.sanitizeQuery(req.query),
        body: this.sanitizeBody(req.body)
      };
      
      // 覆盖 res.json
      res.json = (body) => {
        // 不脱敏响应体（可能包含合法数据）
        return originalJson.call(res, body);
      };
      
      next();
    };
  }
}

/**
 * 创建日志脱敏的 logger 包装器
 */
function createSanitizedLogger(logger, sanitizer) {
  const sanitizedLogger = {};
  
  const methods = ['info', 'warn', 'error', 'debug', 'trace', 'fatal'];
  
  for (const method of methods) {
    sanitizedLogger[method] = (...args) => {
      const sanitizedArgs = args.map(arg => {
        if (typeof arg === 'string') {
          return sanitizer.sanitizeString(arg);
        }
        if (typeof arg === 'object') {
          return sanitizer.sanitize(arg);
        }
        return arg;
      });
      
      return logger[method](...sanitizedArgs);
    };
  }
  
  return sanitizedLogger;
}

// 默认实例
const defaultSanitizer = new LogSanitizer();

// 单例模式
let instance = null;

function getLogSanitizer(options) {
  if (!instance) {
    instance = new LogSanitizer(options);
  }
  return instance;
}

module.exports = {
  LogSanitizer,
  getLogSanitizer,
  createSanitizedLogger,
  defaultSanitizer
};
