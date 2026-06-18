/**
 * 输入净化器
 * 提供 HTML 实体编码、路径净化、特殊字符转义等功能
 * 
 * @module InputSanitizer
 */

/**
 * XSS 编码器
 */
class XSSEncoder {
  /**
   * HTML 实体编码
   * @param {string} value - 输入值
   * @returns {string} 编码后的值
   */
  static encodeHTML(value) {
    if (typeof value !== 'string') return String(value);
    
    const htmlEntities = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#x27;',
      '/': '&#x2F;',
      '`': '&#x60;',
      '=': '&#x3D;',
    };
    
    return value.replace(/[&<>"'`=/]/g, char => htmlEntities[char]);
  }

  /**
   * HTML 属性编码
   * @param {string} value - 输入值
   * @returns {string} 编码后的值
   */
  static encodeAttribute(value) {
    if (typeof value !== 'string') return String(value);
    
    const attrEntities = {
      '"': '&quot;',
      "'": '&#x27;',
      '>': '&gt;',
      '<': '&lt;',
      '&': '&amp;',
    };
    
    return value.replace(/["'><&]/g, char => attrEntities[char]);
  }

  /**
   * JavaScript 编码
   * @param {string} value - 输入值
   * @returns {string} 编码后的值
   */
  static encodeJavaScript(value) {
    if (typeof value !== 'string') return String(value);
    
    return value.replace(/[\\'"<>\n\r]/g, char => {
      const code = char.charCodeAt(0);
      return '\\x' + code.toString(16).padStart(2, '0');
    });
  }

  /**
   * URL 编码
   * @param {string} value - 输入值
   * @returns {string} 编码后的值
   */
  static encodeURL(value) {
    if (typeof value !== 'string') return String(value);
    return encodeURIComponent(value);
  }

  /**
   * CSS 编码
   * @param {string} value - 输入值
   * @returns {string} 编码后的值
   */
  static encodeCSS(value) {
    if (typeof value !== 'string') return String(value);
    
    return value.replace(/[<>"'&]/g, char => {
      const code = char.charCodeAt(0);
      return '\\' + code.toString(16) + ' ';
    });
  }

  /**
   * 根据上下文自动选择编码方式
   * @param {string} value - 输入值
   * @param {string} context - 上下文类型
   * @returns {string} 编码后的值
   */
  static encode(value, context = 'html') {
    const encoders = {
      html: this.encodeHTML,
      attribute: this.encodeAttribute,
      javascript: this.encodeJavaScript,
      js: this.encodeJavaScript,
      url: this.encodeURL,
      css: this.encodeCSS,
    };
    
    const encoder = encoders[context] || this.encodeHTML;
    return encoder(value);
  }
}

/**
 * SQL 净化器
 */
class SQLSanitizer {
  /**
   * 转义 SQL 特殊字符
   * @param {string} value - 输入值
   * @returns {string} 转义后的值
   */
  static escapeString(value) {
    if (typeof value !== 'string') return String(value);
    
    return value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/"/g, '\\"')
      .replace(/\0/g, '\\0')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\x1a/g, '\\Z');
  }

  /**
   * 标识符净化（表名、字段名）
   * @param {string} identifier - 标识符
   * @returns {string} 净化后的标识符
   */
  static sanitizeIdentifier(identifier) {
    if (typeof identifier !== 'string') {
      throw new Error('Invalid identifier: must be a string');
    }
    
    // 只允许字母、数字、下划线
    const sanitized = identifier.replace(/[^a-zA-Z0-9_]/g, '');
    
    if (sanitized !== identifier) {
      throw new Error(`Invalid identifier: ${identifier} contains illegal characters`);
    }
    
    // 不能以数字开头
    if (/^\d/.test(sanitized)) {
      throw new Error(`Invalid identifier: ${identifier} cannot start with a number`);
    }
    
    return sanitized;
  }

  /**
   * LIKE 查询通配符转义
   * @param {string} value - 输入值
   * @returns {string} 转义后的值
   */
  static escapeLikePattern(value) {
    if (typeof value !== 'string') return String(value);
    
    return value
      .replace(/\\/g, '\\\\')
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
  }
}

/**
 * 路径净化器
 */
class PathSanitizer {
  /**
   * 净化文件名
   * @param {string} filename - 文件名
   * @returns {string} 净化后的文件名
   */
  static sanitizeFilename(filename) {
    if (typeof filename !== 'string') {
      throw new Error('Invalid filename: must be a string');
    }
    
    // 移除路径分隔符和特殊字符
    const sanitized = filename
      .replace(/\.\./g, '')           // 移除 ..
      .replace(/[\/\\]/g, '')         // 移除路径分隔符
      .replace(/[<>:"|?*]/g, '')      // 移除非法字符
      .replace(/[\x00-\x1f]/g, '');   // 移除控制字符
    
    if (sanitized.length === 0) {
      throw new Error('Invalid filename: empty after sanitization');
    }
    
    return sanitized;
  }

  /**
   * 净化路径
   * @param {string} userPath - 用户提供的路径
   * @param {string} baseDir - 基准目录
   * @returns {string} 净化后的安全路径
   */
  static sanitizePath(userPath, baseDir) {
    const path = require('path');
    
    // 规范化路径
    const normalized = path.normalize(path.join(baseDir, userPath));
    const resolvedBase = path.resolve(baseDir);
    
    // 检查是否在允许目录内
    if (!normalized.startsWith(resolvedBase)) {
      throw new Error('Path traversal detected: path escapes base directory');
    }
    
    return normalized;
  }

  /**
   * 净化 URL 路径
   * @param {string} urlPath - URL 路径
   * @returns {string} 净化后的路径
   */
  static sanitizeURLPath(urlPath) {
    if (typeof urlPath !== 'string') return '/';
    
    // 移除路径遍历
    let sanitized = urlPath
      .replace(/\.\./g, '')
      .replace(/\/+/g, '/');
    
    // 确保以 / 开头
    if (!sanitized.startsWith('/')) {
      sanitized = '/' + sanitized;
    }
    
    return sanitized;
  }
}

/**
 * 通用输入净化器
 */
class InputSanitizer {
  constructor(options = {}) {
    this.options = {
      maxStringLength: 10000,
      maxArrayLength: 1000,
      maxObjectDepth: 10,
      trimStrings: true,
      ...options,
    };
  }

  /**
   * 净化字符串
   * @param {string} value - 输入值
   * @param {Object} options - 选项
   * @returns {string} 净化后的值
   */
  sanitizeString(value, options = {}) {
    if (value === null || value === undefined) return '';
    
    let sanitized = String(value);
    
    // 截断超长字符串
    const maxLength = options.maxLength || this.options.maxStringLength;
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
    }
    
    // 移除控制字符（保留换行和制表符）
    sanitized = sanitized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    
    // 去除首尾空白
    if (options.trim !== false && this.options.trimStrings) {
      sanitized = sanitized.trim();
    }
    
    return sanitized;
  }

  /**
   * 净化数字
   * @param {*} value - 输入值
   * @param {Object} options - 选项
   * @returns {number|null} 净化后的数字
   */
  sanitizeNumber(value, options = {}) {
    if (value === null || value === undefined || value === '') return null;
    
    const num = Number(value);
    
    if (isNaN(num) || !isFinite(num)) {
      return null;
    }
    
    // 范围检查
    if (options.min !== undefined && num < options.min) {
      return options.min;
    }
    if (options.max !== undefined && num > options.max) {
      return options.max;
    }
    
    // 整数检查
    if (options.integer && !Number.isInteger(num)) {
      return Math.round(num);
    }
    
    return num;
  }

  /**
   * 净化布尔值
   * @param {*} value - 输入值
   * @returns {boolean} 净化后的布尔值
   */
  sanitizeBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lower = value.toLowerCase();
      return lower === 'true' || lower === '1' || lower === 'yes';
    }
    return Boolean(value);
  }

  /**
   * 净化数组
   * @param {Array} arr - 输入数组
   * @param {Function} itemSanitizer - 元素净化函数
   * @param {Object} options - 选项
   * @returns {Array} 净化后的数组
   */
  sanitizeArray(arr, itemSanitizer, options = {}) {
    if (!Array.isArray(arr)) return [];
    
    const maxLength = options.maxLength || this.options.maxArrayLength;
    const sanitized = arr.slice(0, maxLength);
    
    if (typeof itemSanitizer === 'function') {
      return sanitized.map(item => itemSanitizer(item));
    }
    
    return sanitized;
  }

  /**
   * 净化对象
   * @param {Object} obj - 输入对象
   * @param {Object} schema - 净化模式
   * @param {Object} options - 选项
   * @returns {Object} 净化后的对象
   */
  sanitizeObject(obj, schema, options = {}) {
    if (typeof obj !== 'object' || obj === null) return {};
    
    const sanitized = {};
    const depth = options.depth || 0;
    
    if (depth >= this.options.maxObjectDepth) {
      return sanitized;
    }
    
    for (const [key, value] of Object.entries(obj)) {
      // 净化键名
      const sanitizedKey = this.sanitizeString(key, { maxLength: 100 });
      
      if (!sanitizedKey) continue;
      
      // 根据模式净化值
      if (schema && schema[sanitizedKey]) {
        const fieldSchema = schema[sanitizedKey];
        sanitized[sanitizedKey] = this.sanitizeBySchema(value, fieldSchema, depth);
      } else {
        // 默认净化
        sanitized[sanitizedKey] = this.sanitizeAuto(value, depth);
      }
    }
    
    return sanitized;
  }

  /**
   * 根据模式净化值
   * @param {*} value - 输入值
   * @param {Object} schema - 字段模式
   * @param {number} depth - 当前深度
   * @returns {*} 净化后的值
   */
  sanitizeBySchema(value, schema, depth) {
    switch (schema.type) {
      case 'string':
        return this.sanitizeString(value, schema);
      case 'number':
        return this.sanitizeNumber(value, schema);
      case 'boolean':
        return this.sanitizeBoolean(value);
      case 'array':
        return this.sanitizeArray(value, item => this.sanitizeBySchema(item, schema.items || {}, depth), schema);
      case 'object':
        return this.sanitizeObject(value, schema.properties, { depth: depth + 1 });
      default:
        return this.sanitizeAuto(value, depth);
    }
  }

  /**
   * 自动推断类型并净化
   * @param {*} value - 输入值
   * @param {number} depth - 当前深度
   * @returns {*} 净化后的值
   */
  sanitizeAuto(value, depth = 0) {
    if (value === null || value === undefined) return null;
    
    if (typeof value === 'string') {
      return this.sanitizeString(value);
    }
    
    if (typeof value === 'number') {
      return this.sanitizeNumber(value);
    }
    
    if (typeof value === 'boolean') {
      return value;
    }
    
    if (Array.isArray(value)) {
      return this.sanitizeArray(value, item => this.sanitizeAuto(item, depth + 1));
    }
    
    if (typeof value === 'object') {
      return this.sanitizeObject(value, null, { depth: depth + 1 });
    }
    
    return null;
  }
}

// 导出所有类
module.exports = {
  XSSEncoder,
  SQLSanitizer,
  PathSanitizer,
  InputSanitizer,
};
