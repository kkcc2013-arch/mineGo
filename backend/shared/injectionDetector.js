/**
 * Injection Detector - 注入攻击检测引擎
 * 
 * 功能：
 * - SQL 注入检测
 * - NoSQL 注入检测
 * - XSS 攻击检测
 * - 路径遍历检测
 * - 命令注入检测
 * - 自定义规则扩展
 * 
 * @module shared/injectionDetector
 * @version 1.0.0
 */

'use strict';

const { createLogger } = require('./logger');

const logger = createLogger('injection-detector');

/**
 * 攻击类型枚举
 */
const ATTACK_TYPES = {
  SQL: 'sql',
  NOSQL: 'nosql',
  XSS: 'xss',
  PATH_TRAVERSAL: 'pathTraversal',
  COMMAND_INJECTION: 'commandInjection'
};

/**
 * 严重程度枚举
 */
const SEVERITY_LEVELS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
};

/**
 * 默认注入检测模式
 */
const DEFAULT_PATTERNS = {
  [ATTACK_TYPES.SQL]: [
    // UNION SELECT 注入
    {
      pattern: /(\bunion\b.*\bselect\b)/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'UNION SELECT injection detected'
    },
    // INSERT INTO 注入
    {
      pattern: /(\binsert\b.*\binto\b)/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'INSERT INTO injection detected'
    },
    // DELETE FROM 注入
    {
      pattern: /(\bdelete\b.*\bfrom\b)/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'DELETE FROM injection detected'
    },
    // DROP TABLE 注入
    {
      pattern: /(\bdrop\b.*\btable\b)/i,
      severity: SEVERITY_LEVELS.CRITICAL,
      description: 'DROP TABLE injection detected'
    },
    // OR/AND 逻辑注入
    {
      pattern: /(\'|\")\s*(\bor\b|\band\b)\s*(\'|\")/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'OR/AND logical injection detected'
    },
    // 单引号闭合
    {
      pattern: /\'\s*(\bor\b|\band\b|\bunion\b)/i,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Single quote injection detected'
    },
    // SQL 注释
    {
      pattern: /(--|#|\/\*|\*\/)/,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'SQL comment injection detected'
    },
    // EXEC/EXECUTE 调用
    {
      pattern: /(\bexec\b|\bexecute\b)\s*\(/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Stored procedure call detected'
    },
    // SELECT FROM 注入
    {
      pattern: /\bselect\b.*\bfrom\b/i,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'SELECT FROM statement detected'
    },
    // UPDATE SET 注入
    {
      pattern: /\bupdate\b.*\bset\b/i,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'UPDATE SET statement detected'
    }
  ],

  [ATTACK_TYPES.NOSQL]: [
    // MongoDB $where 注入
    {
      pattern: /\$where\s*:/i,
      severity: SEVERITY_LEVELS.CRITICAL,
      description: 'MongoDB $where injection detected'
    },
    // MongoDB 操作符注入
    {
      pattern: /\$(gt|lt|gte|lte|ne|eq|in|nin|or|and|not|regex|exists|type)\b/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'MongoDB operator injection detected'
    },
    // JavaScript 表达式注入
    {
      pattern: /function\s*\(|return\s+this\s*\./i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'JavaScript expression injection detected'
    },
    // $eval 注入
    {
      pattern: /\$eval\s*:/i,
      severity: SEVERITY_LEVELS.CRITICAL,
      description: 'MongoDB $eval injection detected'
    }
  ],

  [ATTACK_TYPES.XSS]: [
    // <script> 标签
    {
      pattern: /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
      severity: SEVERITY_LEVELS.CRITICAL,
      description: 'Script tag injection detected'
    },
    // JavaScript 协议
    {
      pattern: /javascript\s*:/gi,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'JavaScript protocol injection detected'
    },
    // 事件处理器
    {
      pattern: /on(load|error|click|mouse\w+|key\w+|focus|blur|change|submit|reset)\s*=/gi,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Event handler injection detected'
    },
    // <iframe> 标签
    {
      pattern: /<iframe[\s\S]*?>/gi,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Iframe tag injection detected'
    },
    // <object> 标签
    {
      pattern: /<object[\s\S]*?>/gi,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Object tag injection detected'
    },
    // <embed> 标签
    {
      pattern: /<embed[\s\S]*?>/gi,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Embed tag injection detected'
    },
    // <link> 标签
    {
      pattern: /<link[\s\S]*?>/gi,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Link tag injection detected'
    },
    // <style> 标签
    {
      pattern: /<style[\s\S]*?>[\s\S]*?<\/style>/gi,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Style tag injection detected'
    },
    // <base> 标签
    {
      pattern: /<base[\s\S]*?>/gi,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Base tag injection detected'
    },
    // HTML 实体编码绕过
    {
      pattern: /(&#x?[0-9a-f]+;|&#\d+;)/gi,
      severity: SEVERITY_LEVELS.LOW,
      description: 'HTML entity encoding detected'
    },
    // data: 协议
    {
      pattern: /data\s*:\s*[^,]*,/gi,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Data URI detected'
    },
    // vbscript 协议
    {
      pattern: /vbscript\s*:/gi,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'VBScript protocol injection detected'
    }
  ],

  [ATTACK_TYPES.PATH_TRAVERSAL]: [
    // ../ 序列
    {
      pattern: /(\.\.\/|\.\.\\)/,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Path traversal detected'
    },
    // 绝对路径
    {
      pattern: /^(\/|\\|c:|d:)/i,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Absolute path detected'
    },
    // URL 编码的路径遍历
    {
      pattern: /(%2e%2e%2f|%2e%2e\/|\.\.%2f|%2e%2e%5c)/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'URL encoded path traversal detected'
    },
    // 双重编码
    {
      pattern: /(%252e%252e%252f|%252e%252e\/)/i,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Double URL encoded path traversal detected'
    }
  ],

  [ATTACK_TYPES.COMMAND_INJECTION]: [
    // 管道符
    {
      pattern: /(\||;|&|\$\(|`)/,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Command injection characters detected'
    },
    // Shell 命令
    {
      pattern: /\b(cat|ls|pwd|whoami|id|uname|wget|curl|nc|bash|sh|zsh|python|perl|ruby|php)\b/i,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Shell command keyword detected'
    },
    // 环境变量访问
    {
      pattern: /\$\{[^}]+\}|\$[A-Z_]+/g,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'Environment variable access detected'
    },
    // 重定向
    {
      pattern: /(>|>>|<|<<)/,
      severity: SEVERITY_LEVELS.MEDIUM,
      description: 'I/O redirection detected'
    },
    // 反引号命令执行
    {
      pattern: /`[^`]+`/,
      severity: SEVERITY_LEVELS.HIGH,
      description: 'Backtick command execution detected'
    }
  ]
};

/**
 * 注入检测器类
 */
class InjectionDetector {
  /**
   * 构造函数
   * @param {Object} options - 配置选项
   * @param {Array<string>} options.enabledAttacks - 启用的攻击类型
   * @param {string} options.strictness - 严格程度 ('low' | 'medium' | 'high')
   * @param {Array<RegExp>} options.customPatterns - 自定义检测模式
   * @param {Object} options.whiteList - 白名单字段
   */
  constructor(options = {}) {
    this.options = {
      enabledAttacks: options.enabledAttacks || Object.values(ATTACK_TYPES),
      strictness: options.strictness || 'high',
      customPatterns: options.customPatterns || [],
      whiteList: options.whiteList || {},
      enableLogging: options.enableLogging !== false
    };

    // 加载检测模式
    this.patterns = new Map();
    
    for (const attackType of this.options.enabledAttacks) {
      if (DEFAULT_PATTERNS[attackType]) {
        this.patterns.set(attackType, DEFAULT_PATTERNS[attackType]);
      }
    }

    // 添加自定义模式
    if (this.options.customPatterns.length > 0) {
      this.patterns.set('custom', this.options.customPatterns.map(pattern => ({
        pattern,
        severity: SEVERITY_LEVELS.MEDIUM,
        description: 'Custom pattern match'
      })));
    }

    // 统计信息
    this.stats = {
      totalChecks: 0,
      detections: 0,
      byType: {},
      bySeverity: {}
    };

    // 初始化统计
    for (const type of this.options.enabledAttacks) {
      this.stats.byType[type] = 0;
    }
    for (const severity of Object.values(SEVERITY_LEVELS)) {
      this.stats.bySeverity[severity] = 0;
    }

    logger.info('Injection detector initialized', {
      enabledAttacks: this.options.enabledAttacks,
      strictness: this.options.strictness
    });
  }

  /**
   * 检测字符串中的注入攻击
   * @param {string} value - 待检测的字符串
   * @param {string} context - 检测上下文（如字段名）
   * @returns {Object} 检测结果 { detected: boolean, type?: string, severity?: string, matches?: Array }
   */
  detect(value, context = '') {
    if (typeof value !== 'string' || value.length === 0) {
      return { detected: false };
    }

    this.stats.totalChecks++;

    const matches = [];
    let maxSeverity = SEVERITY_LEVELS.LOW;
    let detectedType = null;

    // 检查白名单
    if (this.options.whiteList[context]) {
      return { detected: false };
    }

    // 遍历所有启用的攻击类型
    for (const [attackType, patterns] of this.patterns) {
      for (const patternDef of patterns) {
        const regex = patternDef.pattern;
        const match = value.match(regex);

        if (match) {
          // 根据严格程度过滤
          if (!this._shouldReport(patternDef.severity)) {
            continue;
          }

          matches.push({
            type: attackType,
            pattern: regex.source,
            severity: patternDef.severity,
            description: patternDef.description,
            match: match[0],
            index: match.index
          });

          // 更新最高严重程度
          if (this._compareSeverity(patternDef.severity, maxSeverity) > 0) {
            maxSeverity = patternDef.severity;
            detectedType = attackType;
          }
        }
      }
    }

    const detected = matches.length > 0;

    if (detected) {
      this.stats.detections++;
      this.stats.byType[detectedType] = (this.stats.byType[detectedType] || 0) + 1;
      this.stats.bySeverity[maxSeverity] = (this.stats.bySeverity[maxSeverity] || 0) + 1;

      if (this.options.enableLogging) {
        logger.warn('Injection attack detected', {
          context,
          type: detectedType,
          severity: maxSeverity,
          matchesCount: matches.length,
          sampleMatch: matches[0].match
        });
      }
    }

    return {
      detected,
      type: detectedType,
      severity: maxSeverity,
      matches
    };
  }

  /**
   * 批量检测对象中的注入攻击
   * @param {Object} obj - 待检测的对象
   * @param {string} basePath - 基础路径
   * @returns {Array} 检测到的所有注入攻击
   */
  detectInObject(obj, basePath = '') {
    const detections = [];

    const traverse = (value, path) => {
      if (typeof value === 'string') {
        const result = this.detect(value, path);
        if (result.detected) {
          detections.push({
            field: path,
            ...result
          });
        }
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          traverse(item, `${path}[${index}]`);
        });
      } else if (typeof value === 'object' && value !== null) {
        for (const [key, val] of Object.entries(value)) {
          traverse(val, path ? `${path}.${key}` : key);
        }
      }
    };

    traverse(obj, basePath);
    return detections;
  }

  /**
   * 判断是否应该报告该严重程度
   * @param {string} severity - 严重程度
   * @returns {boolean}
   */
  _shouldReport(severity) {
    const severityMap = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4
    };

    const strictnessMap = {
      low: 2,    // 只报告 medium 及以上
      medium: 2, // 只报告 medium 及以上
      high: 1    // 报告所有
    };

    return severityMap[severity] >= strictnessMap[this.options.strictness];
  }

  /**
   * 比较两个严重程度
   * @param {string} a - 严重程度 A
   * @param {string} b - 严重程度 B
   * @returns {number} 1 表示 A > B, -1 表示 A < B, 0 表示相等
   */
  _compareSeverity(a, b) {
    const severityMap = {
      low: 1,
      medium: 2,
      high: 3,
      critical: 4
    };

    return severityMap[a] - severityMap[b];
  }

  /**
   * 获取统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    return {
      ...this.stats,
      detectionRate: this.stats.totalChecks > 0
        ? (this.stats.detections / this.stats.totalChecks * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this.stats = {
      totalChecks: 0,
      detections: 0,
      byType: {},
      bySeverity: {}
    };

    for (const type of this.options.enabledAttacks) {
      this.stats.byType[type] = 0;
    }
    for (const severity of Object.values(SEVERITY_LEVELS)) {
      this.stats.bySeverity[severity] = 0;
    }
  }

  /**
   * 添加自定义检测规则
   * @param {string} attackType - 攻击类型
   * @param {Object} patternDef - 模式定义 { pattern: RegExp, severity: string, description: string }
   */
  addPattern(attackType, patternDef) {
    if (!this.patterns.has(attackType)) {
      this.patterns.set(attackType, []);
    }
    this.patterns.get(attackType).push({
      pattern: patternDef.pattern,
      severity: patternDef.severity || SEVERITY_LEVELS.MEDIUM,
      description: patternDef.description || 'Custom pattern'
    });
  }

  /**
   * 添加白名单字段
   * @param {string} field - 字段名
   */
  addWhiteList(field) {
    this.options.whiteList[field] = true;
  }

  /**
   * 移除白名单字段
   * @param {string} field - 字段名
   */
  removeWhiteList(field) {
    delete this.options.whiteList[field];
  }
}

/**
 * 创建注入防护中间件
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function injectionProtectionMiddleware(options = {}) {
  const detector = new InjectionDetector(options);

  return (req, res, next) => {
    const requestId = req.headers['x-request-id'] || `req-${Date.now()}`;

    // 检测 body
    if (req.body && typeof req.body === 'object') {
      const detections = detector.detectInObject(req.body, 'body');
      if (detections.length > 0) {
        logger.warn('Injection detected in request body', {
          requestId,
          detections: detections.slice(0, 5) // 只记录前 5 个
        });

        // 高危攻击直接阻断
        const highSeverity = detections.some(d => 
          d.severity === SEVERITY_LEVELS.HIGH || d.severity === SEVERITY_LEVELS.CRITICAL
        );

        if (highSeverity || options.blockLevel === 'all') {
          return res.status(400).json({
            success: false,
            error: {
              code: 400006,
              name: 'INJECTION_DETECTED',
              message: 'Potential injection attack detected'
            },
            meta: {
              requestId,
              timestamp: new Date().toISOString()
            }
          });
        }
      }
    }

    // 检测 query
    if (req.query && typeof req.query === 'object') {
      const detections = detector.detectInObject(req.query, 'query');
      if (detections.length > 0) {
        logger.warn('Injection detected in query parameters', {
          requestId,
          detections: detections.slice(0, 5)
        });

        const highSeverity = detections.some(d => 
          d.severity === SEVERITY_LEVELS.HIGH || d.severity === SEVERITY_LEVELS.CRITICAL
        );

        if (highSeverity || options.blockLevel === 'all') {
          return res.status(400).json({
            success: false,
            error: {
              code: 400006,
              name: 'INJECTION_DETECTED',
              message: 'Potential injection attack detected'
            },
            meta: {
              requestId,
              timestamp: new Date().toISOString()
            }
          });
        }
      }
    }

    // 检测 params
    if (req.params && typeof req.params === 'object') {
      const detections = detector.detectInObject(req.params, 'params');
      if (detections.length > 0) {
        logger.warn('Injection detected in route parameters', {
          requestId,
          detections: detections.slice(0, 5)
        });

        const highSeverity = detections.some(d => 
          d.severity === SEVERITY_LEVELS.HIGH || d.severity === SEVERITY_LEVELS.CRITICAL
        );

        if (highSeverity || options.blockLevel === 'all') {
          return res.status(400).json({
            success: false,
            error: {
              code: 400006,
              name: 'INJECTION_DETECTED',
              message: 'Potential injection attack detected'
            },
            meta: {
              requestId,
              timestamp: new Date().toISOString()
            }
          });
        }
      }
    }

    next();
  };
}

/**
 * 导出模块
 */
module.exports = InjectionDetector;
module.exports.default = InjectionDetector;
module.exports.ATTACK_TYPES = ATTACK_TYPES;
module.exports.SEVERITY_LEVELS = SEVERITY_LEVELS;
module.exports.injectionProtectionMiddleware = injectionProtectionMiddleware;
