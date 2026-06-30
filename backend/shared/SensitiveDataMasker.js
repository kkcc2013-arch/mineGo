// backend/shared/SensitiveDataMasker.js
// REQ-00394: API 敏感参数自动脱敏与日志安全防护系统

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const logger = createLogger('sensitive-data-masker');

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_CONFIG = {
  enableHashing: true,
  hashAlgorithm: 'sha256',
  enablePartialMasking: true,
  auditEnabled: true,
  auditLogPath: path.join(process.cwd(), 'logs', 'security-audit.log'),
  maxAuditFileSize: 100 * 1024 * 1024, // 100MB
};

// ============================================================
// 敏感数据脱敏器类
// ============================================================

class SensitiveDataMasker {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // 初始化默认规则
    this.rules = this.initializeDefaultRules();
    
    // 统计信息
    this.stats = {
      totalMasked: 0,
      byType: {},
      lastUpdated: new Date(),
      startTime: new Date()
    };
    
    // 确保审计日志目录存在
    this.ensureAuditLogDirectory();
    
    logger.info('SensitiveDataMasker initialized', {
      rulesCount: Object.keys(this.rules).length,
      auditEnabled: this.config.auditEnabled
    });
  }

  /**
   * 初始化默认脱敏规则
   */
  initializeDefaultRules() {
    return {
      // ============================================================
      // 认证信息 - 最高优先级
      // ============================================================
      password: {
        patterns: ['password', 'passwd', 'pwd', 'pass', 'pin', 'secret', 'credential'],
        strategy: 'mask_all',
        priority: 1,
        description: '用户密码',
        category: 'authentication'
      },
      confirmPassword: {
        patterns: ['confirmPassword', 'confirm_password', 'confirmPass', 'confirm_pass'],
        strategy: 'mask_all',
        priority: 1,
        description: '确认密码',
        category: 'authentication'
      },
      newPassword: {
        patterns: ['newPassword', 'new_password', 'newPass', 'new_pass', 'newpwd'],
        strategy: 'mask_all',
        priority: 1,
        description: '新密码',
        category: 'authentication'
      },
      oldPassword: {
        patterns: ['oldPassword', 'old_password', 'oldPass', 'old_pass', 'currentPassword'],
        strategy: 'mask_all',
        priority: 1,
        description: '旧密码',
        category: 'authentication'
      },
      
      // ============================================================
      // 支付信息 - 最高优先级
      // ============================================================
      creditCardNumber: {
        patterns: ['creditCard', 'cardNumber', 'card_number', 'pan', 'ccNumber', 'ccNum', 'cardNum'],
        strategy: 'mask_partial',
        priority: 1,
        description: '信用卡号',
        category: 'payment'
      },
      cvv: {
        patterns: ['cvv', 'cvv2', 'securityCode', 'security_code', 'cvc', 'cvvCode'],
        strategy: 'mask_all',
        priority: 1,
        description: 'CVV 安全码',
        category: 'payment'
      },
      cardExpiry: {
        patterns: ['expiry', 'expiryDate', 'expDate', 'exp_date', 'expiration', 'expirationDate'],
        strategy: 'mask_all',
        priority: 1,
        description: '卡片有效期',
        category: 'payment'
      },
      bankAccount: {
        patterns: ['bankAccount', 'bank_account', 'accountNumber', 'account_number', 'acctNum'],
        strategy: 'mask_partial',
        priority: 1,
        description: '银行账号',
        category: 'payment'
      },
      paymentPassword: {
        patterns: ['paymentPassword', 'payment_password', 'payPwd', 'payPassword'],
        strategy: 'mask_all',
        priority: 1,
        description: '支付密码',
        category: 'payment'
      },
      
      // ============================================================
      // 个人身份信息 (PII) - 高优先级
      // ============================================================
      email: {
        patterns: ['email', 'emailAddress', 'email_address', 'mail', 'emailAddress'],
        strategy: 'mask_email',
        priority: 2,
        description: '电子邮件地址',
        category: 'pii'
      },
      phone: {
        patterns: ['phone', 'phoneNumber', 'phone_number', 'mobile', 'cellphone', 'tel', 'telephone'],
        strategy: 'mask_phone',
        priority: 2,
        description: '手机号码',
        category: 'pii'
      },
      idCard: {
        patterns: ['idCard', 'id_card', 'identityCard', 'identity_card', 'ssn', 'socialSecurity', 'nationalId'],
        strategy: 'mask_id_card',
        priority: 1,
        description: '身份证号',
        category: 'pii'
      },
      realName: {
        patterns: ['realName', 'real_name', 'fullName', 'full_name', 'name', 'userName', 'trueName'],
        strategy: 'mask_name',
        priority: 2,
        description: '真实姓名',
        category: 'pii'
      },
      address: {
        patterns: ['address', 'street', 'homeAddress', 'streetAddress', 'home_address', 'billingAddress'],
        strategy: 'mask_address',
        priority: 3,
        description: '地址信息',
        category: 'pii'
      },
      dateOfBirth: {
        patterns: ['dateOfBirth', 'dob', 'birthDate', 'birthday', 'birth_date', 'dob'],
        strategy: 'mask_partial',
        priority: 2,
        description: '出生日期',
        category: 'pii'
      },
      
      // ============================================================
      // API 密钥和令牌 - 最高优先级
      // ============================================================
      apiKey: {
        patterns: ['apiKey', 'api_key', 'apikey', 'secretKey', 'secret_key', 'secret', 'appKey'],
        strategy: 'mask_token',
        priority: 1,
        description: 'API 密钥',
        category: 'security'
      },
      accessToken: {
        patterns: ['accessToken', 'access_token', 'token', 'bearerToken', 'bearer', 'jwt'],
        strategy: 'mask_token',
        priority: 1,
        description: '访问令牌',
        category: 'security'
      },
      refreshToken: {
        patterns: ['refreshToken', 'refresh_token', 'refresh', 'refreshTok'],
        strategy: 'mask_token',
        priority: 1,
        description: '刷新令牌',
        category: 'security'
      },
      authorization: {
        patterns: ['authorization', 'Authorization', 'auth', 'authHeader'],
        strategy: 'mask_auth_header',
        priority: 1,
        description: '认证头',
        category: 'security'
      },
      cookie: {
        patterns: ['cookie', 'Cookie', 'setCookie', 'sessionCookie'],
        strategy: 'mask_cookie',
        priority: 1,
        description: 'Cookie',
        category: 'security'
      },
      
      // ============================================================
      // 其他敏感信息
      // ============================================================
      ip: {
        patterns: ['ipAddress', 'ip_address', 'clientIp', 'client_ip', 'ip', 'userIp', 'remoteIp'],
        strategy: 'mask_ip',
        priority: 3,
        description: 'IP 地址',
        category: 'network'
      },
      location: {
        patterns: ['gps', 'latitude', 'longitude', 'coordinates', 'position', 'geoLocation'],
        strategy: 'mask_location',
        priority: 2,
        description: '地理位置',
        category: 'pii'
      },
      deviceId: {
        patterns: ['deviceId', 'device_id', 'udid', 'imei', 'uuid', 'deviceToken'],
        strategy: 'mask_partial',
        priority: 2,
        description: '设备标识',
        category: 'device'
      },
      sessionId: {
        patterns: ['sessionId', 'session_id', 'sessId', 'sessionKey', 'sessionToken'],
        strategy: 'mask_partial',
        priority: 2,
        description: '会话ID',
        category: 'security'
      }
    };
  }

  /**
   * 脱敏策略实现
   */
  strategies = {
    /**
     * 完全屏蔽：替换为 ******
     */
    mask_all: (value) => '******',
    
    /**
     * 部分脱敏：保留部分字符
     * 例如：1234567890 -> 1234****7890
     */
    mask_partial: (value) => {
      if (!value) return '******';
      const str = String(value);
      if (str.length <= 4) return '****';
      if (str.length <= 8) return str.slice(0, 2) + '****' + str.slice(-2);
      return str.slice(0, 4) + '****' + str.slice(-4);
    },
    
    /**
     * 邮箱脱敏：u***@example.com
     */
    mask_email: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const atIndex = value.indexOf('@');
      if (atIndex <= 0) return '******';
      const localPart = value.slice(0, atIndex);
      const domain = value.slice(atIndex);
      const maskedLocal = localPart.slice(0, 1) + '***';
      return maskedLocal + domain;
    },
    
    /**
     * 手机号脱敏：138****1234
     */
    mask_phone: (value) => {
      if (!value) return '******';
      const str = String(value).replace(/\D/g, '');
      if (str.length < 7) return '******';
      if (str.length === 11) {
        // 中国手机号
        return str.slice(0, 3) + '****' + str.slice(-4);
      }
      return str.slice(0, 3) + '****' + str.slice(-4);
    },
    
    /**
     * 身份证号脱敏：110***********1234
     */
    mask_id_card: (value) => {
      if (!value) return '******';
      const str = String(value).replace(/\s/g, '');
      if (str.length < 8) return '******';
      // 中国身份证号 18位
      if (str.length === 18) {
        return str.slice(0, 3) + '***********' + str.slice(-4);
      }
      // 其他证件
      return str.slice(0, 3) + '****' + str.slice(-4);
    },
    
    /**
     * 姓名脱敏：张**
     */
    mask_name: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const str = value.trim();
      if (str.length <= 1) return '*';
      if (str.length <= 2) return str.slice(0, 1) + '*';
      // 中文姓名或英文姓名
      return str.slice(0, 1) + '**';
    },
    
    /**
     * 地址脱敏：北京市朝阳区****
     */
    mask_address: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const str = value.trim();
      if (str.length <= 10) return str.slice(0, 5) + '****';
      return str.slice(0, 10) + '****';
    },
    
    /**
     * 令牌脱敏：保留前 8 位
     */
    mask_token: (value) => {
      if (!value) return '******';
      const str = String(value).replace(/\s/g, '');
      if (str.length <= 8) return '****';
      return str.slice(0, 8) + '****';
    },
    
    /**
     * Auth Header 脱敏：Bearer ****
     */
    mask_auth_header: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const parts = value.split(' ');
      if (parts.length >= 2) {
        return parts[0] + ' ****';
      }
      return '****';
    },
    
    /**
     * Cookie 脱敏
     */
    mask_cookie: (value) => {
      if (!value || typeof value !== 'string') return '******';
      // 只保留第一个 cookie 的名称
      const firstCookie = value.split(';')[0];
      const eqIndex = firstCookie.indexOf('=');
      if (eqIndex > 0) {
        return firstCookie.slice(0, eqIndex + 1) + '****';
      }
      return '****';
    },
    
    /**
     * IP 地址脱敏：192.168.*.*
     */
    mask_ip: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const parts = value.split('.');
      if (parts.length === 4) {
        return parts[0] + '.' + parts[1] + '.*.*';
      }
      return '****';
    },
    
    /**
     * 地理位置脱敏
     */
    mask_location: (value) => {
      if (!value) return '******';
      if (typeof value === 'object') {
        return { lat: '****', lng: '****' };
      }
      return '****';
    },
    
    /**
     * 哈希化：使用哈希算法替换
     */
    hash: (value) => {
      if (!value) return '******';
      return crypto
        .createHash(this.config.hashAlgorithm)
        .update(String(value))
        .digest('hex')
        .slice(0, 16);
    }
  };

  /**
   * 对对象进行递归脱敏
   */
  mask(obj, context = {}) {
    if (!obj) return obj;
    
    // 处理基本类型
    if (typeof obj !== 'object') {
      return obj;
    }
    
    // 处理数组
    if (Array.isArray(obj)) {
      return obj.map(item => this.mask(item, context));
    }
    
    // 处理对象
    const masked = {};
    
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      
      // 查找匹配的规则
      const matchedRule = this.findMatchingRule(key, lowerKey);
      
      if (matchedRule) {
        // 应用脱敏策略
        const strategy = this.strategies[matchedRule.strategy];
        if (strategy) {
          masked[key] = this.applyStrategy(value, strategy, matchedRule);
          
          // 更新统计
          this.updateStats(matchedRule);
          
          // 记录审计日志
          if (this.config.auditEnabled) {
            this.auditLog(key, matchedRule, context);
          }
        } else {
          masked[key] = '******';
        }
      } else if (typeof value === 'object' && value !== null) {
        // 递归处理嵌套对象
        masked[key] = this.mask(value, context);
      } else {
        // 保留原值
        masked[key] = value;
      }
    }
    
    return masked;
  }

  /**
   * 查找匹配的规则
   */
  findMatchingRule(key, lowerKey) {
    let bestMatch = null;
    let bestPriority = Infinity;
    
    for (const [ruleName, rule] of Object.entries(this.rules)) {
      for (const pattern of rule.patterns) {
        const lowerPattern = pattern.toLowerCase();
        
        // 精确匹配
        if (lowerKey === lowerPattern) {
          if (rule.priority < bestPriority) {
            bestMatch = { name: ruleName, ...rule };
            bestPriority = rule.priority;
          }
        }
        // 包含匹配
        else if (lowerKey.includes(lowerPattern)) {
          if (rule.priority < bestPriority) {
            bestMatch = { name: ruleName, ...rule };
            bestPriority = rule.priority;
          }
        }
        // 模糊匹配（去除分隔符后比较）
        else if (this.fuzzyMatch(lowerKey, lowerPattern)) {
          if (rule.priority < bestPriority) {
            bestMatch = { name: ruleName, ...rule };
            bestPriority = rule.priority;
          }
        }
      }
    }
    
    return bestMatch;
  }

  /**
   * 模糊匹配（支持驼峰、下划线等命名）
   */
  fuzzyMatch(key, pattern) {
    const normalizedKey = key.replace(/[_\-\s]/g, '').toLowerCase();
    const normalizedPattern = pattern.replace(/[_\-\s]/g, '').toLowerCase();
    return normalizedKey.includes(normalizedPattern);
  }

  /**
   * 应用脱敏策略
   */
  applyStrategy(value, strategy, rule) {
    if (value === null || value === undefined) {
      return value;
    }
    
    // 处理对象类型值
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        return value.map(v => this.applyStrategy(v, strategy, rule));
      }
      // 对对象进行 JSON 序列化后脱敏
      return '******';
    }
    
    // 应用策略
    try {
      return strategy.call(this, value);
    } catch (err) {
      logger.error('Strategy application failed', {
        rule: rule.name,
        strategy: rule.strategy,
        error: err.message
      });
      return '******';
    }
  }

  /**
   * 更新统计信息
   */
  updateStats(rule) {
    this.stats.totalMasked++;
    this.stats.byType[rule.name] = (this.stats.byType[rule.name] || 0) + 1;
    this.stats.byCategory[rule.category] = (this.stats.byCategory[rule.category] || 0) + 1;
    this.stats.lastUpdated = new Date();
  }

  /**
   * 确保审计日志目录存在
   */
  ensureAuditLogDirectory() {
    const dir = path.dirname(this.config.auditLogPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 记录审计日志
   */
  auditLog(field, rule, context) {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      event: 'sensitive_data_masked',
      field,
      rule: rule.name,
      category: rule.category,
      strategy: rule.strategy,
      description: rule.description,
      priority: rule.priority,
      service: context.service || 'unknown',
      requestId: context.requestId || 'unknown',
      userId: context.userId || 'unknown',
      ip: context.ip || 'unknown'
    };
    
    this.writeAuditLog(auditEntry);
  }

  /**
   * 写入审计日志
   */
  writeAuditLog(entry) {
    try {
      // 检查日志文件大小
      if (fs.existsSync(this.config.auditLogPath)) {
        const stats = fs.statSync(this.config.auditLogPath);
        if (stats.size > this.config.maxAuditFileSize) {
          // 轮转日志文件
          this.rotateAuditLog();
        }
      }
      
      fs.appendFileSync(this.config.auditLogPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      // 审计日志写入失败不应影响正常流程
      logger.error('Failed to write audit log', {
        error: err.message,
        path: this.config.auditLogPath
      });
    }
  }

  /**
   * 轮转审计日志
   */
  rotateAuditLog() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = this.config.auditLogPath.replace('.log', `-${timestamp}.log`);
    
    try {
      fs.renameSync(this.config.auditLogPath, rotatedPath);
      logger.info('Audit log rotated', { rotatedPath });
    } catch (err) {
      logger.error('Failed to rotate audit log', { error: err.message });
    }
  }

  /**
   * 动态添加规则
   */
  addRule(ruleName, config) {
    if (this.rules[ruleName]) {
      logger.warn('Rule already exists, will be overwritten', { ruleName });
    }
    
    this.rules[ruleName] = {
      patterns: config.patterns || [],
      strategy: config.strategy || 'mask_all',
      priority: config.priority || 3,
      description: config.description || '',
      category: config.category || 'custom'
    };
    
    this.stats.lastUpdated = new Date();
    
    logger.info('Rule added', { ruleName, config });
    return true;
  }

  /**
   * 动态更新规则
   */
  updateRule(ruleName, updates) {
    if (!this.rules[ruleName]) {
      logger.warn('Rule not found', { ruleName });
      return false;
    }
    
    this.rules[ruleName] = { ...this.rules[ruleName], ...updates };
    this.stats.lastUpdated = new Date();
    
    logger.info('Rule updated', { ruleName, updates });
    return true;
  }

  /**
   * 删除规则
   */
  removeRule(ruleName) {
    if (!this.rules[ruleName]) {
      logger.warn('Rule not found', { ruleName });
      return false;
    }
    
    delete this.rules[ruleName];
    this.stats.lastUpdated = new Date();
    
    logger.info('Rule removed', { ruleName });
    return true;
  }

  /**
   * 获取所有规则
   */
  getRules() {
    return { ...this.rules };
  }

  /**
   * 获取规则数量
   */
  getRulesCount() {
    return Object.keys(this.rules).length;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime.getTime(),
      rulesCount: Object.keys(this.rules).length,
      categoriesCount: Object.keys(this.stats.byCategory || {}).length
    };
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this.stats = {
      totalMasked: 0,
      byType: {},
      byCategory: {},
      lastUpdated: new Date(),
      startTime: new Date()
    };
    logger.info('Stats reset');
  }

  /**
   * 测试脱敏效果
   */
  testMasking(data) {
    const result = this.mask(data);
    return {
      original: data,
      masked: result,
      stats: {
        totalMasked: this.stats.totalMasked,
        recentTypes: Object.keys(this.stats.byType)
      }
    };
  }
}

// ============================================================
// 导出单例和类
// ============================================================

// 创建默认单例实例
const defaultMasker = new SensitiveDataMasker();

module.exports = {
  SensitiveDataMasker,
  masker: defaultMasker,
  mask: (obj, context) => defaultMasker.mask(obj, context),
  getRules: () => defaultMasker.getRules(),
  getStats: () => defaultMasker.getStats(),
  addRule: (name, config) => defaultMasker.addRule(name, config),
  updateRule: (name, updates) => defaultMasker.updateRule(name, updates),
  removeRule: (name) => defaultMasker.removeRule(name)
};