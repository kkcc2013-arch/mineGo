/**
 * 注入攻击防护系统
 * 提供 SQL 注入、NoSQL 注入、XSS、路径遍历、命令注入的统一防护
 * 
 * @module InjectionGuard
 * @requires AttackLogger
 */

const AttackLogger = require('./AttackLogger');
const { logger } = require('./logger');

/**
 * SQL 注入检测器
 */
class SQLInjectionDetector {
  // SQL 注入特征模式
  static patterns = [
    // OR/AND 注入
    /(\bOR\b|\bAND\b)\s*['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,
    // UNION 注入
    /UNION\s+(ALL\s+)?SELECT/i,
    // 堆叠查询
    /;\s*(DROP|DELETE|UPDATE|INSERT|EXEC|TRUNCATE|ALTER)/i,
    // 注释截断
    /--\s*$|\/\*.*\*\//,
    // 字符串逃逸
    /'\s*(OR|AND)\s*'/i,
    // 布尔注入
    /'\s*=\s*'/,
    // 时间盲注
    /WAITFOR\s+DELAY|SLEEP\s*\(|BENCHMARK\s*\(/i,
    // 报错注入
    /EXTRACTVALUE\s*\(|UPDATEXML\s*\(/i,
  ];

  /**
   * 检测 SQL 注入
   * @param {string} input - 输入字符串
   * @returns {Object|null} 检测结果
   */
  static detect(input) {
    if (typeof input !== 'string') return null;
    
    for (const pattern of this.patterns) {
      if (pattern.test(input)) {
        return {
          type: 'SQL_INJECTION',
          severity: 'critical',
          pattern: pattern.source,
          message: '检测到 SQL 注入特征',
        };
      }
    }
    
    return null;
  }

  /**
   * 验证参数化查询
   * @param {string} query - SQL 查询
   * @param {Array} params - 参数数组
   * @throws {Error} 如果检测到字符串拼接
   */
  static validateParameterized(query, params) {
    // 检测字符串模板拼接
    const hasTemplateConcat = /\$\{[^}]+\}/.test(query);
    // 检测字符串加号拼接
    const hasPlusConcat = /['"`]\s*\+/.test(query) || /\+\s*['"`]/.test(query);
    
    if ((hasTemplateConcat || hasPlusConcat) && (!params || params.length === 0)) {
      throw new Error('SQL_INJECTION_RISK: 必须使用参数化查询，禁止字符串拼接');
    }
  }
}

/**
 * NoSQL 注入检测器
 */
class NoSQLInjectionDetector {
  // MongoDB/Redis 注入特征
  static patterns = [
    // $where 注入
    /\$where/i,
    // $ne 永真
    /\$ne\s*:\s*null/i,
    // $gt/$lt 永真
    /\$gt\s*:\s*['"]/i,
    // JavaScript 注入
    /function\s*\(|new\s+Function/i,
    // 原型污染
    /__proto__|constructor|prototype/i,
  ];

  // Redis 键名白名单模式
  static redisKeyPatterns = [
    /^user:\d+:[a-z]+$/,
    /^pokemon:\d+:[a-z]+$/,
    /^session:[a-f0-9]{32}$/,
    /^cache:[a-z]+:[\w\-]+$/,
    /^leaderboard:[a-z]+:\d+$/,
    /^rate:[\w\-]+:\d+$/,
    /^geo:[a-z]+$/,
  ];

  /**
   * 检测 NoSQL 注入
   * @param {string|Object} input - 输入
   * @returns {Object|null} 检测结果
   */
  static detect(input) {
    const inputStr = typeof input === 'object' ? JSON.stringify(input) : String(input);
    
    for (const pattern of this.patterns) {
      if (pattern.test(inputStr)) {
        return {
          type: 'NOSQL_INJECTION',
          severity: 'critical',
          pattern: pattern.source,
          message: '检测到 NoSQL 注入特征',
        };
      }
    }
    
    return null;
  }

  /**
   * 验证 Redis 键名
   * @param {string} key - Redis 键名
   * @throws {Error} 如果键名非法
   */
  static validateRedisKey(key) {
    const isValid = this.redisKeyPatterns.some(p => p.test(key));
    
    if (!isValid) {
      throw new Error(`NOSQL_INJECTION_RISK: 非法 Redis 键名: ${key}`);
    }
  }
}

/**
 * XSS 检测器
 */
class XSSDetector {
  // XSS 特征模式
  static patterns = [
    // Script 标签
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    // 事件处理器
    /on\w+\s*=\s*['"][^'"]*['"]/gi,
    // JavaScript 协议
    /javascript\s*:/gi,
    // data URI
    /data\s*:\s*text\/html/gi,
    // SVG 标签
    /<svg\b[^>]*>/gi,
    // iframe 标签
    /<iframe\b[^>]*>/gi,
    // object/embed 标签
    /<(object|embed)\b[^>]*>/gi,
    // 表达式
    /expression\s*\(/gi,
  ];

  /**
   * 检测 XSS
   * @param {string} input - 输入字符串
   * @returns {Object|null} 检测结果
   */
  static detect(input) {
    if (typeof input !== 'string') return null;
    
    for (const pattern of this.patterns) {
      if (pattern.test(input)) {
        return {
          type: 'XSS',
          severity: 'high',
          pattern: pattern.source,
          message: '检测到 XSS 攻击特征',
        };
      }
    }
    
    return null;
  }
}

/**
 * 路径遍历检测器
 */
class PathTraversalDetector {
  // 路径遍历特征
  static patterns = [
    /\.\./,           // ../
    /\.\.\\/,         // ..\
    /%2e%2e/i,        // URL 编码
    /%252e%252e/i,    // 双重 URL 编码
    /\.\.%2f/i,       // 混合编码
    /\.\.%5c/i,       // 混合编码
  ];

  /**
   * 检测路径遍历
   * @param {string} input - 输入路径
   * @returns {Object|null} 检测结果
   */
  static detect(input) {
    if (typeof input !== 'string') return null;
    
    for (const pattern of this.patterns) {
      if (pattern.test(input)) {
        return {
          type: 'PATH_TRAVERSAL',
          severity: 'critical',
          pattern: pattern.source,
          message: '检测到路径遍历攻击',
        };
      }
    }
    
    return null;
  }

  /**
   * 验证路径安全性
   * @param {string} userPath - 用户提供的路径
   * @param {string} baseDir - 基准目录
   * @returns {string} 规范化后的安全路径
   * @throws {Error} 如果路径非法
   */
  static validate(userPath, baseDir) {
    const path = require('path');
    
    // 规范化路径
    const normalized = path.normalize(path.join(baseDir, userPath));
    const resolvedBase = path.resolve(baseDir);
    
    // 检查是否在允许目录内
    if (!normalized.startsWith(resolvedBase)) {
      throw new Error('PATH_TRAVERSAL: 非法路径访问');
    }
    
    return normalized;
  }
}

/**
 * 命令注入检测器
 */
class CommandInjectionDetector {
  // 命令注入特征
  static patterns = [
    /;\s*(ls|cat|rm|wget|curl|bash|sh|python|perl|ruby)/i,
    /\|\s*(ls|cat|rm|wget|curl)/i,
    /`[^`]+`/,           // 反引号执行
    /\$\([^)]+\)/,       // $() 执行
    /&&\s*(ls|cat|rm)/i,
    /\|\|\s*(ls|cat|rm)/i,
    />\s*\//,            // 重定向到根目录
    /<\s*\//,            // 从根目录读取
  ];

  /**
   * 检测命令注入
   * @param {string} input - 输入字符串
   * @returns {Object|null} 检测结果
   */
  static detect(input) {
    if (typeof input !== 'string') return null;
    
    for (const pattern of this.patterns) {
      if (pattern.test(input)) {
        return {
          type: 'COMMAND_INJECTION',
          severity: 'critical',
          pattern: pattern.source,
          message: '检测到命令注入特征',
        };
      }
    }
    
    return null;
  }
}

/**
 * 统一注入防护类
 */
class InjectionGuard {
  constructor(options = {}) {
    this.options = {
      enableSQL: true,
      enableNoSQL: true,
      enableXSS: true,
      enablePathTraversal: true,
      enableCommand: true,
      logAttacks: true,
      throwOnAttack: false,
      ...options,
    };
    
    this.logger = options.logger || logger;
    this.attackLogger = options.attackLogger || new AttackLogger();
  }

  /**
   * 扫描输入字符串，检测所有类型的注入攻击
   * @param {string} input - 输入字符串
   * @param {Object} context - 上下文信息
   * @returns {Object} 扫描结果
   */
  async scan(input, context = {}) {
    const threats = [];
    
    // SQL 注入检测
    if (this.options.enableSQL) {
      const sqlThreat = SQLInjectionDetector.detect(input);
      if (sqlThreat) threats.push(sqlThreat);
    }
    
    // NoSQL 注入检测
    if (this.options.enableNoSQL) {
      const nosqlThreat = NoSQLInjectionDetector.detect(input);
      if (nosqlThreat) threats.push(nosqlThreat);
    }
    
    // XSS 检测
    if (this.options.enableXSS) {
      const xssThreat = XSSDetector.detect(input);
      if (xssThreat) threats.push(xssThreat);
    }
    
    // 路径遍历检测
    if (this.options.enablePathTraversal) {
      const pathThreat = PathTraversalDetector.detect(input);
      if (pathThreat) threats.push(pathThreat);
    }
    
    // 命令注入检测
    if (this.options.enableCommand) {
      const cmdThreat = CommandInjectionDetector.detect(input);
      if (cmdThreat) threats.push(cmdThreat);
    }
    
    // 如果检测到威胁
    if (threats.length > 0) {
      const mostSevere = this.getMostSevereThreat(threats);
      
      // 记录攻击日志
      if (this.options.logAttacks) {
        await this.logAttack(mostSevere, input, context);
      }
      
      // 抛出异常
      if (this.options.throwOnAttack) {
        throw new Error(`INJECTION_ATTACK: ${mostSevere.message}`);
      }
      
      return {
        threat: true,
        type: mostSevere.type,
        severity: mostSevere.severity,
        message: mostSevere.message,
        allThreats: threats,
      };
    }
    
    return { threat: false };
  }

  /**
   * 扫描对象的所有属性
   * @param {Object} obj - 输入对象
   * @param {Object} context - 上下文信息
   * @returns {Object} 扫描结果
   */
  async scanObject(obj, context = {}) {
    if (typeof obj !== 'object' || obj === null) {
      return this.scan(String(obj), context);
    }
    
    const threats = [];
    const scanRecursive = async (current, path = '') => {
      if (typeof current === 'string') {
        const result = await this.scan(current, { ...context, path });
        if (result.threat) {
          threats.push({ ...result, path });
        }
      } else if (Array.isArray(current)) {
        for (let i = 0; i < current.length; i++) {
          await scanRecursive(current[i], `${path}[${i}]`);
        }
      } else if (typeof current === 'object' && current !== null) {
        for (const [key, value] of Object.entries(current)) {
          await scanRecursive(value, path ? `${path}.${key}` : key);
        }
      }
    };
    
    await scanRecursive(obj);
    
    if (threats.length > 0) {
      return {
        threat: true,
        threats,
        mostSevere: this.getMostSevereThreat(threats),
      };
    }
    
    return { threat: false };
  }

  /**
   * 获取最严重的威胁
   * @param {Array} threats - 威胁列表
   * @returns {Object} 最严重的威胁
   */
  getMostSevereThreat(threats) {
    const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    return threats.sort((a, b) => 
      (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0)
    )[0];
  }

  /**
   * 记录攻击日志
   * @param {Object} threat - 威胁信息
   * @param {string} input - 输入字符串
   * @param {Object} context - 上下文信息
   */
  async logAttack(threat, input, context) {
    try {
      await this.attackLogger.log({
        type: threat.type,
        severity: threat.severity,
        input: input.substring(0, 500), // 限制日志长度
        ...context,
      });
      
      this.logger.warn('Injection attack detected', {
        type: threat.type,
        severity: threat.severity,
        message: threat.message,
        ...context,
      });
    } catch (error) {
      this.logger.error('Failed to log attack', { error: error.message });
    }
  }
}

// 导出所有类
module.exports = {
  InjectionGuard,
  SQLInjectionDetector,
  NoSQLInjectionDetector,
  XSSDetector,
  PathTraversalDetector,
  CommandInjectionDetector,
};
