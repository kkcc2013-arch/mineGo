'use strict';
/**
 * 统一安全验证中间件
 * REQ-00041: 统一 API 输入验证与清理中间件
 * 
 * 结合 Zod 验证与输入清理，提供端到端的请求安全保护
 * - 模式校验（Zod Schema）
 * - XSS/SQL 注入防护
 * - 安全日志与监控上报
 */

const { z } = require('zod');
const logger = require('../logger');
const { metrics } = require('../index');
const InputSanitizer = require('../InputSanitizer');
const { formatZodErrors } = require('./requestValidator');

/**
 * 安全验证配置
 */
const DEFAULT_CONFIG = {
  // 清理选项
  sanitize: {
    enabled: true,
    encodeHTML: true,          // HTML 实体编码
    stripDangerousChars: true,  // 移除危险字符
    maxStringLength: 10000,     // 字符串最大长度
    maxObjectDepth: 10          // 对象最大深度
  },
  
  // 验证选项
  validate: {
    stripUnknown: true,        // 移除未知字段
    allowUnknown: false        // 是否允许未知字段
  },
  
  // 日志选项
  logging: {
    logBlockedRequests: true,  // 记录被拦截的请求
    includeOriginalValue: false // 日志中是否包含原始值（安全考虑默认关闭）
  },
  
  // 监控选项
  monitoring: {
    reportToMetrics: true,     // 上报到 Prometheus
    alertOnAttack: true        // 攻击尝试告警
  }
};

/**
 * 攻击模式检测规则
 */
const ATTACK_PATTERNS = {
  sqlInjection: [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE|TRUNCATE)\b)/gi,
    /(--\s*$)/gm,
    /(\bOR\s+1\s*=\s*1\b)/gi,
    /(\bAND\s+1\s*=\s*1\b)/gi,
    /('.*\bOR\b.*')/gi,
    /\bSLEEP\s*\(/gi,
    /\bBENCHMARK\s*\(/gi
  ],
  
  xss: [
    /<script\b[^>]*>(.*?)<\/script>/gi,
    /javascript\s*:/gi,
    /on\w+\s*=/gi,
    /<img\b[^>]*\s+src\s*=/gi,
    /<iframe\b/gi,
    /<embed\b/gi,
    /<object\b/gi,
    /expression\s*\(/gi,
    /vbscript\s*:/gi
  ],
  
  pathTraversal: [
    /\.\./g,
    /%2e%2e/gi,
    /%252e/gi,
    /\.\.%2f/gi,
    /\.\.%5c/gi
  ],
  
  commandInjection: [
    /\b(cat|ls|pwd|whoami|id|uname)\b/g,
    /[;&|`$]/g,
    /\$\(.*\)/g,
    /\bexec\s*\(/gi,
    /\bsystem\s*\(/gi
  ],
  
  ldapInjection: [
    /\)\(/g,
    /\*\)/g,
    /\(\|/g,
    /\)\(\|/g
  ],
  
  noSqlInjection: [
    /\$where/gi,
    /\$gt/g,
    /\$lt/g,
    /\$ne/g,
    /\$regex/gi,
    /\$exists/gi
  ]
};

/**
 * 敏感字段检测
 */
const SENSITIVE_FIELDS = [
  'password', 'pwd', 'passwd', 'secret', 'token', 'apiKey',
  'creditCard', 'ssn', 'idNumber', 'bankAccount'
];

/**
 * 统一安全验证器类
 */
class UnifiedSecurityValidator {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sanitizer = new InputSanitizer.InputSanitizer(this.config.sanitize);
    this.xssEncoder = InputSanitizer.XSSEncoder;
    this.sqlSanitizer = InputSanitizer.SQLSanitizer;
    this.pathSanitizer = InputSanitizer.PathSanitizer;
    
    // 统计数据
    this.stats = {
      totalRequests: 0,
      blockedRequests: 0,
      attackAttempts: 0,
      sqlInjectionAttempts: 0,
      xssAttempts: 0,
      pathTraversalAttempts: 0,
      commandInjectionAttempts: 0,
      validationErrors: 0
    };
    
    this._setupMetrics();
  }

  /**
   * 设置 Prometheus 指标
   */
  _setupMetrics() {
    if (!this.config.monitoring.reportToMetrics) return;
    
    this.metrics = {
      requestsTotal: metrics.counter('security_requests_total', 'Total requests processed'),
      requestsBlocked: metrics.counter('security_requests_blocked_total', 'Blocked requests'),
      attackAttempts: metrics.counter('security_attack_attempts_total', 'Attack attempts', ['type']),
      validationErrors: metrics.counter('security_validation_errors_total', 'Validation errors'),
      processingTime: metrics.histogram('security_processing_time_ms', 'Processing time', [], [1, 5, 10, 50, 100])
    };
  }

  /**
   * 创建验证中间件
   * @param {Object} schema - Zod Schema 定义
   * @param {Object} options - 验证选项
   * @returns {Function} Express 中间件
   */
  validate(schema, options = {}) {
    const config = { ...this.config, ...options };
    
    return async (req, res, next) => {
      const startTime = Date.now();
      const requestId = res.locals.requestId || 'unknown';
      
      try {
        // 1. 攻击检测
        const attackResult = this._detectAttacks(req);
        if (attackResult.detected) {
          this._handleAttackDetection(req, attackResult, requestId);
          return res.status(400).json({
            error: 'SECURITY_VIOLATION',
            message: '检测到潜在安全威胁，请求已被拦截',
            requestId
          });
        }
        
        // 2. 输入清理
        if (config.sanitize.enabled) {
          req.body = this._sanitizeInput(req.body, 'body');
          req.query = this._sanitizeInput(req.query, 'query');
          req.params = this._sanitizeInput(req.params, 'params');
        }
        
        // 3. Schema 验证
        if (schema) {
          const validationTargets = this._getValidationTargets(schema, req);
          
          for (const [target, targetSchema] of Object.entries(validationTargets)) {
            const result = targetSchema.safeParse(req[target]);
            
            if (!result.success) {
              this._handleValidationError(req, result.error, target, requestId);
              const details = formatZodErrors(result.error, req.locale || 'zh-CN');
              return res.status(400).json({
                error: 'VALIDATION_ERROR',
                message: '请求参数验证失败',
                details,
                requestId
              });
            }
            
            // 使用验证后的数据（已过滤未知字段）
            req[target] = result.data;
          }
        }
        
        // 4. 更新统计
        this._updateStats(true, false);
        
        // 5. 记录处理时间
        const processingTime = Date.now() - startTime;
        this._recordMetrics(processingTime);
        
        next();
        
      } catch (error) {
        logger.error('Security validation error', {
          requestId,
          error: error.message,
          stack: error.stack
        });
        
        this._updateStats(true, true);
        
        return res.status(500).json({
          error: 'INTERNAL_ERROR',
          message: '安全验证处理失败',
          requestId
        });
      }
    };
  }

  /**
   * 检测攻击模式
   * @param {Request} req - Express 请求对象
   * @returns {Object} 检测结果
   */
  _detectAttacks(req) {
    const result = {
      detected: false,
      types: [],
      matches: []
    };
    
    // 检查所有输入源
    const sources = [
      { name: 'body', data: req.body },
      { name: 'query', data: req.query },
      { name: 'params', data: req.params },
      { name: 'headers', data: this._extractDangerousHeaders(req.headers) }
    ];
    
    for (const source of sources) {
      const inputString = this._serializeInput(source.data);
      
      if (!inputString) continue;
      
      for (const [attackType, patterns] of Object.entries(ATTACK_PATTERNS)) {
        for (const pattern of patterns) {
          const matches = inputString.match(pattern);
          if (matches && matches.length > 0) {
            result.detected = true;
            result.types.push(attackType);
            result.matches.push({
              source: source.name,
              type: attackType,
              pattern: pattern.toString(),
              count: matches.length
            });
          }
        }
      }
    }
    
    return result;
  }

  /**
   * 提取危险的请求头
   */
  _extractDangerousHeaders(headers) {
    const dangerousHeaders = {};
    const headersToCheck = [
      'x-forwarded-for',
      'x-real-ip',
      'referer',
      'user-agent',
      'cookie',
      'authorization'
    ];
    
    for (const header of headersToCheck) {
      if (headers[header]) {
        dangerousHeaders[header] = headers[header];
      }
    }
    
    return dangerousHeaders;
  }

  /**
   * 序列化输入用于检测
   */
  _serializeInput(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }

  /**
   * 处理攻击检测
   */
  _handleAttackDetection(req, attackResult, requestId) {
    // 更新统计
    this.stats.attackAttempts++;
    this.stats.blockedRequests++;
    
    for (const type of attackResult.types) {
      const statKey = `${type}Attempts`;
      if (this.stats[statKey]) {
        this.stats[statKey]++;
      }
    }
    
    // 记录安全日志
    logger.warn('Attack attempt detected', {
      requestId,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      path: req.path,
      method: req.method,
      attackTypes: attackResult.types,
      matches: attackResult.matches
    });
    
    // 更新指标
    if (this.metrics) {
      this.metrics.requestsBlocked.inc();
      for (const type of attackResult.types) {
        this.metrics.attackAttempts.inc({ type });
      }
    }
    
    // 告警（可配置发送到外部监控系统）
    if (this.config.monitoring.alertOnAttack) {
      this._sendSecurityAlert(req, attackResult, requestId);
    }
  }

  /**
   * 发送安全告警
   */
  _sendSecurityAlert(req, attackResult, requestId) {
    // 这里可以集成到外部告警系统（如 PagerDuty、Slack、邮件等）
    // 当前仅记录高优先级日志
    logger.alert('SECURITY_ALERT', 'Potential attack attempt blocked', {
      requestId,
      ip: req.ip,
      path: req.path,
      attackTypes: attackResult.types,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * 清理输入数据
   */
  _sanitizeInput(data, source) {
    if (!data || typeof data !== 'object') return data;
    
    const sanitized = {};
    
    for (const [key, value] of Object.entries(data)) {
      // 检查敏感字段
      const isSensitive = SENSITIVE_FIELDS.some(field => 
        key.toLowerCase().includes(field.toLowerCase())
      );
      
      // 清理键名
      const sanitizedKey = this.sanitizer.sanitizeString(key, { maxLength: 100 });
      
      if (!sanitizedKey) continue;
      
      // 清理值
      sanitized[sanitizedKey] = this._sanitizeValue(value, isSensitive);
    }
    
    return sanitized;
  }

  /**
   * 清理单个值
   */
  _sanitizeValue(value, isSensitive = false) {
    if (value === null || value === undefined) return value;
    
    // 字符串：执行编码
    if (typeof value === 'string') {
      let sanitized = value;
      
      // 截断超长字符串
      if (sanitized.length > this.config.sanitize.maxStringLength) {
        sanitized = sanitized.substring(0, this.config.sanitize.maxStringLength);
      }
      
      // HTML 编码（非敏感字段）
      if (this.config.sanitize.encodeHTML && !isSensitive) {
        sanitized = this.xssEncoder.encodeHTML(sanitized);
      }
      
      return sanitized;
    }
    
    // 数组：递归处理
    if (Array.isArray(value)) {
      return value.map(item => this._sanitizeValue(item, isSensitive));
    }
    
    // 对象：递归处理
    if (typeof value === 'object') {
      return this._sanitizeInput(value, 'nested');
    }
    
    // 其他类型（数字、布尔）：直接返回
    return value;
  }

  /**
   * 处理验证错误
   */
  _handleValidationError(req, error, target, requestId) {
    this.stats.validationErrors++;
    
    const details = formatZodErrors(error, req.locale || 'zh-CN');
    
    if (this.config.logging.logBlockedRequests) {
      logger.warn('Request validation failed', {
        requestId,
        ip: req.ip,
        path: req.path,
        method: req.method,
        target,
        details,
        ...(this.config.logging.includeOriginalValue && { 
          originalValue: req[target] 
        })
      });
    }
    
    if (this.metrics) {
      this.metrics.validationErrors.inc();
    }
  }

  /**
   * 获取验证目标
   */
  _getValidationTargets(schema, req) {
    const targets = {};
    
    if (schema.body) targets.body = schema.body;
    if (schema.query) targets.query = schema.query;
    if (schema.params) targets.params = schema.params;
    if (schema.headers) targets.headers = schema.headers;
    
    return targets;
  }

  /**
   * 更新统计
   */
  _updateStats(processed, blocked) {
    this.stats.totalRequests++;
    if (blocked) {
      this.stats.blockedRequests++;
    }
  }

  /**
   * 记录指标
   */
  _recordMetrics(processingTime) {
    if (!this.metrics) return;
    
    this.metrics.requestsTotal.inc();
    this.metrics.processingTime.observe(processingTime);
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      blockRate: this.stats.totalRequests > 0 
        ? (this.stats.blockedRequests / this.stats.totalRequests * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * 创建预配置的验证中间件工厂
   */
  createValidator(preset = 'default') {
    const presets = {
      default: {},
      strict: {
        sanitize: {
          enabled: true,
          encodeHTML: true,
          stripDangerousChars: true,
          maxStringLength: 5000
        },
        validate: {
          stripUnknown: true,
          allowUnknown: false
        }
      },
      lenient: {
        sanitize: {
          enabled: true,
          encodeHTML: false
        },
        validate: {
          stripUnknown: false,
          allowUnknown: true
        }
      },
      api: {
        sanitize: {
          enabled: true,
          encodeHTML: true
        },
        validate: {
          stripUnknown: true
        }
      }
    };
    
    const presetConfig = presets[preset] || presets.default;
    return (schema, options = {}) => {
      return this.validate(schema, { ...presetConfig, ...options });
    };
  }
}

/**
 * 创建全局验证器实例
 */
function createSecurityValidator(config) {
  return new UnifiedSecurityValidator(config);
}

/**
 * 快捷验证中间件创建函数
 */
function validateRequest(schema, options = {}) {
  const validator = new UnifiedSecurityValidator(options);
  return validator.validate(schema, options);
}

/**
 * 预定义的安全 Schema
 */
const securitySchemas = {
  /**
   * 用户注册 Schema
   */
  userRegister: z.object({
    username: z.string().min(4).max(20).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
    email: z.string().email(),
    password: z.string().min(8).max(50)
      .regex(/[a-z]/)
      .regex(/[A-Z]/)
      .regex(/[0-9]/),
    nickname: z.string().min(2).max(20).optional()
  }),
  
  /**
   * 用户登录 Schema
   */
  userLogin: z.object({
    email: z.string().email(),
    password: z.string().min(1)
  }),
  
  /**
   * 精灵操作 Schema
   */
  pokemonAction: z.object({
    pokemonId: z.string().regex(/^pokemon_[a-z0-9]+$/),
    action: z.enum(['transfer', 'evolve', 'rename', 'favorite'])
  }),
  
  /**
   * 地理位置 Schema
   */
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180)
  }),
  
  /**
   * 分页查询 Schema
   */
  pagination: z.object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.string().max(50).optional(),
    sortOrder: z.enum(['asc', 'desc']).default('desc')
  })
};

module.exports = {
  UnifiedSecurityValidator,
  createSecurityValidator,
  validateRequest,
  securitySchemas,
  ATTACK_PATTERNS,
  SENSITIVE_FIELDS,
  DEFAULT_CONFIG
};