/**
 * 注入攻击检测中间件
 * 自动检测并拦截 SQL 注入、XSS、路径遍历等攻击
 * 
 * @module injectionDetectionMiddleware
 */

const { InjectionGuard } = require('../../../../shared/InjectionGuard');
const { logger } = require('../../../../shared/logger');

// 创建注入防护实例
const injectionGuard = new InjectionGuard({
  enableSQL: true,
  enableNoSQL: true,
  enableXSS: true,
  enablePathTraversal: true,
  enableCommand: true,
  logAttacks: true,
  throwOnAttack: false,
});

/**
 * 注入攻击检测中间件
 * @param {Object} options - 配置选项
 * @returns {Function} Express 中间件
 */
function injectionDetectionMiddleware(options = {}) {
  const {
    // 排除的路径（不检测）
    excludePaths = [
      '/health',
      '/metrics',
      '/api/docs',
    ],
    // 排除的参数名（不检测）
    excludeParams = [
      'password',
      'confirmPassword',
      'token',
      'accessToken',
      'refreshToken',
    ],
    // 最大输入长度
    maxInputLength = 10000,
    // 是否阻止请求
    blockRequest = true,
    // 自定义错误处理
    onError = null,
  } = options;

  return async (req, res, next) => {
    // 跳过排除的路径
    if (excludePaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    try {
      // 收集所有输入参数
      const inputs = collectInputs(req, excludeParams, maxInputLength);
      
      // 扫描所有输入
      const result = await injectionGuard.scanObject(inputs, {
        ip: req.ip || req.connection?.remoteAddress,
        userId: req.user?.id,
        endpoint: req.path,
        method: req.method,
        userAgent: req.get('user-agent'),
      });

      // 检测到攻击
      if (result.threat) {
        const attack = result.mostSevere;
        
        logger.warn('Injection attack blocked', {
          type: attack.type,
          severity: attack.severity,
          endpoint: req.path,
          method: req.method,
          ip: req.ip,
          userId: req.user?.id,
          threats: result.threats.length,
        });

        // 自定义错误处理
        if (typeof onError === 'function') {
          return onError(req, res, next, result);
        }

        // 阻止请求
        if (blockRequest) {
          return res.status(400).json({
            error: 'INVALID_INPUT',
            message: '检测到非法输入，请求已被拦截',
            code: attack.type,
          });
        }
        
        // 不阻止但标记
        req.injectionWarning = result;
      }

      next();
    } catch (error) {
      logger.error('Injection detection error', {
        error: error.message,
        stack: error.stack,
        endpoint: req.path,
      });

      // 中间件错误不应阻止请求
      next();
    }
  };
}

/**
 * 收集请求中的所有输入参数
 * @param {Object} req - Express 请求对象
 * @param {Array} excludeParams - 排除的参数名
 * @param {number} maxLength - 最大长度
 * @returns {Object} 收集的输入参数
 */
function collectInputs(req, excludeParams, maxLength) {
  const inputs = {};

  // Query 参数
  if (req.query && typeof req.query === 'object') {
    for (const [key, value] of Object.entries(req.query)) {
      if (!excludeParams.includes(key)) {
        inputs[`query.${key}`] = truncateInput(value, maxLength);
      }
    }
  }

  // Body 参数
  if (req.body && typeof req.body === 'object') {
    if (Array.isArray(req.body)) {
      inputs.body = req.body.slice(0, 100).map(item => 
        truncateInput(item, maxLength)
      );
    } else {
      for (const [key, value] of Object.entries(req.body)) {
        if (!excludeParams.includes(key)) {
          inputs[`body.${key}`] = truncateInput(value, maxLength);
        }
      }
    }
  }

  // Path 参数
  if (req.params && typeof req.params === 'object') {
    for (const [key, value] of Object.entries(req.params)) {
      if (!excludeParams.includes(key)) {
        inputs[`params.${key}`] = truncateInput(value, maxLength);
      }
    }
  }

  // Headers（仅检查特定的头）
  const sensitiveHeaders = [
    'x-forwarded-for',
    'x-real-ip',
    'referer',
    'origin',
  ];
  
  for (const header of sensitiveHeaders) {
    const value = req.get(header);
    if (value) {
      inputs[`header.${header}`] = truncateInput(value, maxLength);
    }
  }

  return inputs;
}

/**
 * 截断输入以避免处理超长字符串
 * @param {*} value - 输入值
 * @param {number} maxLength - 最大长度
 * @returns {*} 截断后的值
 */
function truncateInput(value, maxLength) {
  if (typeof value === 'string' && value.length > maxLength) {
    return value.substring(0, maxLength);
  }
  
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => truncateInput(item, maxLength));
  }
  
  if (typeof value === 'object' && value !== null) {
    const truncated = {};
    const keys = Object.keys(value).slice(0, 50);
    for (const key of keys) {
      truncated[key] = truncateInput(value[key], maxLength);
    }
    return truncated;
  }
  
  return value;
}

/**
 * SQL 注入专用中间件
 * 用于数据库查询前的额外检查
 */
function sqlInjectionGuard(options = {}) {
  const {
    strict = false,
    excludeFields = [],
  } = options;

  return (req, res, next) => {
    const inputs = collectInputs(req, excludeFields, 10000);
    
    // 深度检查 SQL 注入特征
    const sqlPatterns = [
      /(\bOR\b|\bAND\b)\s*['"]?\d+['"]?\s*=\s*['"]?\d+['"]?/i,
      /UNION\s+(ALL\s+)?SELECT/i,
      /;\s*(DROP|DELETE|UPDATE|INSERT|EXEC)/i,
      /--\s*$|\/\*.*\*\//,
      /'\s*(OR|AND)\s*'/i,
    ];

    const checkValue = (value, path) => {
      if (typeof value !== 'string') return null;
      
      for (const pattern of sqlPatterns) {
        if (pattern.test(value)) {
          return {
            path,
            pattern: pattern.source,
            value: value.substring(0, 200),
          };
        }
      }
      return null;
    };

    const threats = [];
    
    const checkObject = (obj, prefix = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        
        if (typeof value === 'string') {
          const threat = checkValue(value, path);
          if (threat) threats.push(threat);
        } else if (Array.isArray(value)) {
          value.forEach((item, i) => {
            if (typeof item === 'string') {
              const threat = checkValue(item, `${path}[${i}]`);
              if (threat) threats.push(threat);
            }
          });
        } else if (typeof value === 'object' && value !== null) {
          checkObject(value, path);
        }
      }
    };

    checkObject(inputs);

    if (threats.length > 0) {
      logger.error('SQL injection attempt detected', {
        endpoint: req.path,
        method: req.method,
        ip: req.ip,
        threats,
      });

      if (strict) {
        return res.status(400).json({
          error: 'SQL_INJECTION_DETECTED',
          message: '检测到 SQL 注入攻击',
        });
      }
      
      req.sqlInjectionWarning = threats;
    }

    next();
  };
}

/**
 * XSS 防护中间件
 * 自动净化响应中的 HTML 内容
 */
function xssProtectionMiddleware(options = {}) {
  const {
    // 需要净化的字段
    sanitizeFields = ['nickname', 'content', 'description', 'title', 'comment'],
    // 是否自动净化
    autoSanitize = false,
  } = options;

  const { XSSEncoder } = require('../../../../shared/InputSanitizer');

  // 请求拦截：净化输入
  if (autoSanitize) {
    return (req, res, next) => {
      if (req.body && typeof req.body === 'object') {
        for (const field of sanitizeFields) {
          if (req.body[field] && typeof req.body[field] === 'string') {
            req.body[field] = XSSEncoder.encodeHTML(req.body[field]);
          }
        }
      }
      next();
    };
  }

  // 响应拦截：添加 CSP 头
  return (req, res, next) => {
    // 设置 XSS 防护头
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    next();
  };
}

module.exports = {
  injectionDetectionMiddleware,
  sqlInjectionGuard,
  xssProtectionMiddleware,
};
