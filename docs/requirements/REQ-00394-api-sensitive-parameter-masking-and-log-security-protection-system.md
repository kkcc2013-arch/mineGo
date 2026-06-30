# REQ-00394: API 敏感参数自动脱敏与日志安全防护系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00394 |
| 标题 | API 敏感参数自动脱敏与日志安全防护系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、所有微服务、backend/shared/logger.js、backend/shared/middleware、admin-dashboard、database/migrations |
| 创建时间 | 2026-06-30 19:05 UTC |
| 依赖需求 | REQ-00003（支付订单幂等性与签名验证安全加固）、REQ-00343（API 密钥泄露检测与实时告警系统）、REQ-00338（API 敏感数据泄露防护与审计日志加密存储） |

## 1. 背景与问题

### 1.1 日志敏感信息泄露风险

mineGo 项目当前使用结构化日志系统（REQ-00002），但在日志输出方面存在以下安全风险：

1. **敏感参数直接记录**
   - 密码明文记录：用户注册、登录请求中的密码字段可能被记录到日志
   - 支付信息泄露：支付请求中的信用卡号、CVV、银行卡号可能被记录
   - 个人信息暴露：用户手机号、邮箱、身份证号等 PII 数据可能被完整记录
   - API 密钥泄露：第三方 API 密钥、JWT 令牌可能出现在日志中

2. **请求响应全量记录**
   - 当前日志可能记录完整的 HTTP 请求体和响应体
   - 敏感数据字段未被自动识别和脱敏
   - 开发调试时可能意外记录敏感信息

3. **合规风险**
   - **GDPR 第 32 条**：要求对个人数据实施适当的技术措施，包括日志保护
   - **PCI-DSS 要求 3.2**：禁止存储敏感认证数据（CVV、PIN 等），包括日志
   - **网络安全法**：要求采取技术措施防止个人信息泄露

### 1.2 当前系统缺陷分析

#### 1.2.1 Logger 模块缺陷
```javascript
// backend/shared/logger.js 当前实现
class Logger {
  info(message, meta = {}) {
    // 直接记录 meta 对象，未检查敏感字段
    console.log(JSON.stringify({
      level: 'info',
      message,
      ...meta, // 敏感数据可能直接被记录
      timestamp: new Date().toISOString()
    }));
  }
}

// 问题示例
logger.info('User login attempt', {
  email: 'user@example.com',
  password: 'MySecretPassword123', // 密码被记录到日志！
  userId: '12345'
});
```

#### 1.2.2 请求日志中间件缺陷
```javascript
// backend/shared/middleware/requestLogger.js
function requestLogger(req, res, next) {
  logger.info('Incoming request', {
    method: req.method,
    url: req.url,
    body: req.body, // 完整请求体，可能包含密码、支付信息
    headers: req.headers // 可能包含 Authorization 令牌
  });
  next();
}
```

#### 1.2.3 已知敏感信息泄露场景
1. 用户注册：密码、手机号、邮箱被记录
2. 用户登录：密码、设备信息被记录
3. 支付请求：银行卡号、CVV、支付密码被记录
4. 用户资料更新：身份证号、真实姓名被记录
5. API 调用：第三方 API 密钥、JWT 令牌被记录

### 1.3 安全事件案例参考

**行业案例**：
- 2019 年，某知名应用因日志记录用户密码明文，被安全研究员发现并披露
- 2020 年，某电商平台日志泄露用户支付信息，导致大规模数据泄露事件
- 2021 年，某游戏平台日志文件被黑客获取，导致用户个人信息大规模泄露

### 1.4 合规要求分析

| 法规 | 要求 | 当前状态 |
|------|------|----------|
| GDPR 第 32 条 | 实施适当技术措施保护个人数据 | ❌ 日志可能记录 PII |
| PCI-DSS 3.2 | 禁止存储敏感认证数据 | ❌ 日志可能记录 CVV |
| 网络安全法 | 采取技术措施防止信息泄露 | ⚠️ 部分合规 |
| ISO 27001 A.12.4 | 日志记录应保护敏感信息 | ❌ 未实施 |

## 2. 目标

构建 API 敏感参数自动脱敏与日志安全防护系统，实现：

1. **敏感字段自动识别**：基于规则库自动识别密码、支付信息、PII、API 密钥等敏感数据
2. **多层脱敏策略**：提供完全屏蔽、部分脱敏、哈希化等多种脱敏方式
3. **请求响应自动过滤**：对 HTTP 请求体、响应体、请求头自动过滤敏感字段
4. **动态配置管理**：支持动态添加/更新脱敏规则，无需重启服务
5. **审计日志记录**：记录脱敏操作日志，支持安全审计和事件追溯
6. **合规性保障**：满足 GDPR、PCI-DSS、网络安全法等合规要求

**预期收益**：
- 消除日志敏感信息泄露风险，防止数据泄露事件
- 满足 GDPR、PCI-DSS 等合规要求，避免监管处罚
- 提升安全审计能力，快速定位安全问题
- 降低数据泄露导致的经济损失和声誉损害

## 3. 范围

### 包含
- SensitiveDataMasker 核心模块：敏感字段识别和脱敏引擎
- 日志安全中间件：自动过滤日志输出中的敏感信息
- 请求响应过滤器：过滤 HTTP 请求体、响应体中的敏感数据
- 脱敏规则配置系统：可配置的敏感字段定义和脱敏策略
- 敏感数据检测工具：扫描现有日志文件，检测敏感信息泄露
- 审计日志系统：记录脱敏操作和安全事件
- 动态规则管理接口：支持运行时更新脱敏规则
- admin-dashboard 集成：可视化脱敏规则管理

### 不包含
- 数据库字段级加密（已在 REQ-00338 实现）
- 网络传输加密（HTTPS 已实现）
- 文件存储加密（已有独立需求）
- 实时入侵检测系统（属于独立安全系统）

## 4. 详细需求

### 4.1 SensitiveDataMasker 核心模块

创建 `backend/shared/SensitiveDataMasker.js`：

```javascript
/**
 * 敏感数据脱敏引擎
 */
class SensitiveDataMasker {
  constructor(config = {}) {
    // 默认敏感字段配置
    this.rules = this.initializeDefaultRules();
    this.config = {
      enableHashing: config.enableHashing !== false,
      hashAlgorithm: config.hashAlgorithm || 'sha256',
      enablePartialMasking: config.enablePartialMasking !== false,
      auditEnabled: config.auditEnabled !== false,
      ...config
    };
    
    // 统计信息
    this.stats = {
      totalMasked: 0,
      byType: {},
      lastUpdated: new Date()
    };
  }

  /**
   * 初始化默认脱敏规则
   */
  initializeDefaultRules() {
    return {
      // 认证信息
      password: {
        patterns: ['password', 'passwd', 'pwd', 'pass', 'pin'],
        strategy: 'mask_all',
        priority: 1,
        description: '用户密码'
      },
      confirmPassword: {
        patterns: ['confirmPassword', 'confirm_password', 'confirmPass'],
        strategy: 'mask_all',
        priority: 1,
        description: '确认密码'
      },
      newPassword: {
        patterns: ['newPassword', 'new_password', 'newPass'],
        strategy: 'mask_all',
        priority: 1,
        description: '新密码'
      },
      
      // 支付信息
      creditCardNumber: {
        patterns: ['creditCard', 'cardNumber', 'card_number', 'pan', 'ccNumber'],
        strategy: 'mask_partial',
        priority: 1,
        description: '信用卡号'
      },
      cvv: {
        patterns: ['cvv', 'cvv2', 'securityCode', 'security_code'],
        strategy: 'mask_all',
        priority: 1,
        description: 'CVV 安全码'
      },
      cardExpiry: {
        patterns: ['expiry', 'expiryDate', 'expDate', 'exp_date'],
        strategy: 'mask_all',
        priority: 1,
        description: '卡片有效期'
      },
      bankAccount: {
        patterns: ['bankAccount', 'bank_account', 'accountNumber', 'account_number'],
        strategy: 'mask_partial',
        priority: 1,
        description: '银行账号'
      },
      
      // 个人身份信息 (PII)
      email: {
        patterns: ['email', 'emailAddress', 'email_address'],
        strategy: 'mask_email',
        priority: 2,
        description: '电子邮件地址'
      },
      phone: {
        patterns: ['phone', 'phoneNumber', 'phone_number', 'mobile', 'cellphone'],
        strategy: 'mask_phone',
        priority: 2,
        description: '手机号码'
      },
      idCard: {
        patterns: ['idCard', 'id_card', 'identityCard', 'identity_card', 'ssn'],
        strategy: 'mask_id_card',
        priority: 1,
        description: '身份证号'
      },
      realName: {
        patterns: ['realName', 'real_name', 'fullName', 'full_name'],
        strategy: 'mask_name',
        priority: 2,
        description: '真实姓名'
      },
      address: {
        patterns: ['address', 'street', 'homeAddress'],
        strategy: 'mask_partial',
        priority: 3,
        description: '地址信息'
      },
      
      // API 密钥和令牌
      apiKey: {
        patterns: ['apiKey', 'api_key', 'apikey', 'secretKey', 'secret_key'],
        strategy: 'mask_token',
        priority: 1,
        description: 'API 密钥'
      },
      accessToken: {
        patterns: ['accessToken', 'access_token', 'token', 'bearerToken'],
        strategy: 'mask_token',
        priority: 1,
        description: '访问令牌'
      },
      refreshToken: {
        patterns: ['refreshToken', 'refresh_token'],
        strategy: 'mask_token',
        priority: 1,
        description: '刷新令牌'
      },
      authorization: {
        patterns: ['authorization', 'Authorization'],
        strategy: 'mask_token',
        priority: 1,
        description: '认证头'
      },
      
      // 其他敏感信息
      ip: {
        patterns: ['ipAddress', 'ip_address', 'clientIp', 'client_ip'],
        strategy: 'mask_ip',
        priority: 3,
        description: 'IP 地址'
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
      if (!value || typeof value !== 'string') return '******';
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
      const [localPart, domain] = value.split('@');
      if (!domain) return '******';
      const maskedLocal = localPart.slice(0, 1) + '***';
      return `${maskedLocal}@${domain}`;
    },
    
    /**
     * 手机号脱敏：138****1234
     */
    mask_phone: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const str = String(value).replace(/\D/g, '');
      if (str.length < 7) return '******';
      return str.slice(0, 3) + '****' + str.slice(-4);
    },
    
    /**
     * 身份证号脱敏：110***********1234
     */
    mask_id_card: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const str = String(value);
      if (str.length < 6) return '******';
      return str.slice(0, 3) + '***********' + str.slice(-4);
    },
    
    /**
     * 姓名脱敏：张**
     */
    mask_name: (value) => {
      if (!value || typeof value !== 'string') return '******';
      return value.slice(0, 1) + '**';
    },
    
    /**
     * 令牌脱敏：保留前 8 位
     */
    mask_token: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const str = String(value);
      if (str.length <= 8) return '****';
      return str.slice(0, 8) + '****' + (str.length > 12 ? ' (masked)' : '');
    },
    
    /**
     * IP 地址脱敏：192.168.*.*
     */
    mask_ip: (value) => {
      if (!value || typeof value !== 'string') return '******';
      const parts = value.split('.');
      if (parts.length !== 4) return '******';
      return `${parts[0]}.${parts[1]}.*.*`;
    },
    
    /**
     * 哈希化：使用哈希算法替换
     */
    hash: (value, algorithm = 'sha256') => {
      if (!value) return '******';
      const crypto = require('crypto');
      return crypto.createHash(algorithm).update(String(value)).digest('hex').slice(0, 16);
    }
  };

  /**
   * 对对象进行递归脱敏
   */
  mask(obj, context = {}) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }
    
    const masked = Array.isArray(obj) ? [] : {};
    
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      
      // 查找匹配的规则
      const matchedRule = this.findMatchingRule(key, lowerKey);
      
      if (matchedRule) {
        // 应用脱敏策略
        const strategy = this.strategies[matchedRule.strategy];
        masked[key] = this.applyStrategy(value, strategy, matchedRule);
        
        // 更新统计
        this.updateStats(matchedRule);
        
        // 记录审计日志
        if (this.config.auditEnabled) {
          this.auditLog(key, matchedRule, context);
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
    for (const [ruleName, rule] of Object.entries(this.rules)) {
      for (const pattern of rule.patterns) {
        const lowerPattern = pattern.toLowerCase();
        if (lowerKey === lowerPattern || 
            lowerKey.includes(lowerPattern) ||
            this.fuzzyMatch(lowerKey, lowerPattern)) {
          return { name: ruleName, ...rule };
        }
      }
    }
    return null;
  }

  /**
   * 模糊匹配（支持驼峰、下划线等命名）
   */
  fuzzyMatch(key, pattern) {
    const normalizedKey = key.replace(/[_-]/g, '').toLowerCase();
    const normalizedPattern = pattern.replace(/[_-]/g, '').toLowerCase();
    return normalizedKey.includes(normalizedPattern);
  }

  /**
   * 应用脱敏策略
   */
  applyStrategy(value, strategy, rule) {
    if (value === null || value === undefined) {
      return value;
    }
    
    if (typeof value === 'object') {
      // 对对象值进行 JSON 序列化后再脱敏
      return this.strategies.mask_partial(JSON.stringify(value));
    }
    
    return strategy.call(this, value);
  }

  /**
   * 更新统计信息
   */
  updateStats(rule) {
    this.stats.totalMasked++;
    this.stats.byType[rule.name] = (this.stats.byType[rule.name] || 0) + 1;
    this.stats.lastUpdated = new Date();
  }

  /**
   * 审计日志
   */
  auditLog(field, rule, context) {
    const auditEntry = {
      timestamp: new Date().toISOString(),
      event: 'sensitive_data_masked',
      field,
      rule: rule.name,
      strategy: rule.strategy,
      description: rule.description,
      service: context.service || 'unknown',
      requestId: context.requestId,
      userId: context.userId
    };
    
    // 写入审计日志（使用独立文件，不混入普通日志）
    this.writeAuditLog(auditEntry);
  }

  /**
   * 写入审计日志
   */
  writeAuditLog(entry) {
    const fs = require('fs');
    const path = require('path');
    const auditLogPath = path.join(process.cwd(), 'logs', 'security-audit.log');
    
    try {
      fs.appendFileSync(auditLogPath, JSON.stringify(entry) + '\n');
    } catch (error) {
      // 审计日志写入失败，不应影响正常流程
      console.error('Failed to write audit log:', error.message);
    }
  }

  /**
   * 动态添加规则
   */
  addRule(ruleName, config) {
    this.rules[ruleName] = {
      patterns: config.patterns || [],
      strategy: config.strategy || 'mask_all',
      priority: config.priority || 3,
      description: config.description || ''
    };
    
    this.stats.lastUpdated = new Date();
    return true;
  }

  /**
   * 动态更新规则
   */
  updateRule(ruleName, updates) {
    if (this.rules[ruleName]) {
      this.rules[ruleName] = { ...this.rules[ruleName], ...updates };
      this.stats.lastUpdated = new Date();
      return true;
    }
    return false;
  }

  /**
   * 删除规则
   */
  removeRule(ruleName) {
    if (this.rules[ruleName]) {
      delete this.rules[ruleName];
      this.stats.lastUpdated = new Date();
      return true;
    }
    return false;
  }

  /**
   * 获取所有规则
   */
  getRules() {
    return { ...this.rules };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return { ...this.stats };
  }
}

module.exports = SensitiveDataMasker;
```

### 4.2 日志安全中间件

创建 `backend/shared/middleware/logSecurityMiddleware.js`：

```javascript
const SensitiveDataMasker = require('../SensitiveDataMasker');
const logger = require('../logger');

/**
 * 日志安全中间件
 * 自动过滤日志输出中的敏感信息
 */
class LogSecurityMiddleware {
  constructor(config = {}) {
    this.masker = new SensitiveDataMasker(config);
    this.enabled = config.enabled !== false;
    this.mode = config.mode || 'production'; // 'production' | 'development' | 'audit'
    
    // 拦截原始 logger 方法
    this.interceptLogger();
  }

  /**
   * 拦截 logger 方法
   */
  interceptLogger() {
    const originalMethods = {
      info: logger.info.bind(logger),
      error: logger.error.bind(logger),
      warn: logger.warn.bind(logger),
      debug: logger.debug.bind(logger)
    };

    const self = this;

    // 重写 logger 方法
    logger.info = function(message, meta = {}) {
      const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
      originalMethods.info(message, maskedMeta);
    };

    logger.error = function(message, meta = {}) {
      const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
      originalMethods.error(message, maskedMeta);
    };

    logger.warn = function(message, meta = {}) {
      const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
      originalMethods.warn(message, maskedMeta);
    };

    logger.debug = function(message, meta = {}) {
      if (self.mode === 'development') {
        // 开发模式下不脱敏
        originalMethods.debug(message, meta);
      } else {
        const maskedMeta = self.enabled ? self.masker.mask(meta, { service: 'logger' }) : meta;
        originalMethods.debug(message, maskedMeta);
      }
    };
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
  mask(data) {
    return this.enabled ? this.masker.mask(data) : data;
  }

  /**
   * 临时禁用（用于调试）
   */
  disable() {
    this.enabled = false;
  }

  /**
   * 启用
   */
  enable() {
    this.enabled = true;
  }
}

module.exports = LogSecurityMiddleware;
```

### 4.3 请求响应过滤器

创建 `backend/shared/middleware/sensitiveDataFilter.js`：

```javascript
const SensitiveDataMasker = require('../SensitiveDataMasker');

/**
 * 请求响应敏感数据过滤器
 * 中间件：自动过滤 HTTP 请求体、响应体中的敏感字段
 */
function sensitiveDataFilter(options = {}) {
  const masker = new SensitiveDataMasker(options);
  const filterRequestBody = options.filterRequestBody !== false;
  const filterResponseBody = options.filterResponseBody !== false;
  const filterHeaders = options.filterHeaders !== false;

  return function(req, res, next) {
    // 上下文信息
    const context = {
      service: req.serviceName || 'unknown',
      requestId: req.requestId,
      userId: req.user?.id
    };

    // 过滤请求体
    if (filterRequestBody && req.body) {
      req.body = masker.mask(req.body, context);
    }

    // 过滤请求头
    if (filterHeaders && req.headers) {
      const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
      const filteredHeaders = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (sensitiveHeaders.includes(key.toLowerCase())) {
          filteredHeaders[key] = '******';
        } else {
          filteredHeaders[key] = value;
        }
      }
      req.filteredHeaders = filteredHeaders;
    }

    // 过滤响应体（拦截 res.json）
    if (filterResponseBody) {
      const originalJson = res.json.bind(res);
      res.json = function(data) {
        const maskedData = masker.mask(data, context);
        return originalJson(maskedData);
      };
    }

    // 挂载 masker 到 req 对象，供手动使用
    req.masker = masker;

    next();
  };
}

module.exports = sensitiveDataFilter;
```

### 4.4 集成到现有 Logger

修改 `backend/shared/logger.js`：

```javascript
const SensitiveDataMasker = require('./SensitiveDataMasker');
const LogSecurityMiddleware = require('./middleware/logSecurityMiddleware');

// 初始化日志安全中间件
const logSecurity = new LogSecurityMiddleware({
  enabled: process.env.ENABLE_LOG_SECURITY !== 'false',
  mode: process.env.NODE_ENV === 'development' ? 'development' : 'production',
  auditEnabled: true
});

class Logger {
  // ... 现有实现保持不变
  
  // 添加安全日志方法
  safe(level, message, meta = {}) {
    const maskedMeta = logSecurity.mask(meta);
    this[level](message, maskedMeta);
  }
}

// 导出 logger 实例和安全中间件
module.exports = {
  logger: new Logger(),
  logSecurity,
  SensitiveDataMasker
};
```

### 4.5 脱敏规则管理 API

创建 `backend/services/admin/routes/masking-rules.js`：

```javascript
const express = require('express');
const router = express.Router();
const SensitiveDataMasker = require('../../../shared/SensitiveDataMasker');
const auth = require('../../../shared/auth');
const { requirePermission } = require('../../../shared/middleware/permission');

// 单例 masker 实例（从全局获取）
function getMasker() {
  return global.sensitiveDataMasker;
}

/**
 * 获取所有脱敏规则
 * GET /api/admin/masking-rules
 */
router.get('/',
  auth.authenticate,
  requirePermission('admin.security.read'),
  async (req, res) => {
    try {
      const masker = getMasker();
      const rules = masker.getRules();
      const stats = masker.getStats();

      res.json({
        success: true,
        data: {
          rules,
          stats,
          totalRules: Object.keys(rules).length
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 添加新的脱敏规则
 * POST /api/admin/masking-rules
 */
router.post('/',
  auth.authenticate,
  requirePermission('admin.security.write'),
  async (req, res) => {
    try {
      const { ruleName, patterns, strategy, priority, description } = req.body;

      if (!ruleName || !patterns || !strategy) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: ruleName, patterns, strategy'
        });
      }

      const masker = getMasker();
      const added = masker.addRule(ruleName, {
        patterns,
        strategy,
        priority: priority || 3,
        description: description || ''
      });

      if (added) {
        res.json({
          success: true,
          message: `Rule '${ruleName}' added successfully`,
          data: masker.getRules()[ruleName]
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to add rule'
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 更新脱敏规则
 * PUT /api/admin/masking-rules/:ruleName
 */
router.put('/:ruleName',
  auth.authenticate,
  requirePermission('admin.security.write'),
  async (req, res) => {
    try {
      const { ruleName } = req.params;
      const updates = req.body;

      const masker = getMasker();
      const updated = masker.updateRule(ruleName, updates);

      if (updated) {
        res.json({
          success: true,
          message: `Rule '${ruleName}' updated successfully`,
          data: masker.getRules()[ruleName]
        });
      } else {
        res.status(404).json({
          success: false,
          error: `Rule '${ruleName}' not found`
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 删除脱敏规则
 * DELETE /api/admin/masking-rules/:ruleName
 */
router.delete('/:ruleName',
  auth.authenticate,
  requirePermission('admin.security.write'),
  async (req, res) => {
    try {
      const { ruleName } = req.params;

      const masker = getMasker();
      const removed = masker.removeRule(ruleName);

      if (removed) {
        res.json({
          success: true,
          message: `Rule '${ruleName}' removed successfully`
        });
      } else {
        res.status(404).json({
          success: false,
          error: `Rule '${ruleName}' not found`
        });
      }
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/**
 * 获取脱敏统计信息
 * GET /api/admin/masking-rules/stats
 */
router.get('/stats',
  auth.authenticate,
  requirePermission('admin.security.read'),
  async (req, res) => {
    try {
      const masker = getMasker();
      const stats = masker.getStats();

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

module.exports = router;
```

### 4.6 敏感数据检测工具

创建 `backend/tools/sensitive-data-scanner.js`：

```javascript
#!/usr/bin/env node

/**
 * 敏感数据扫描工具
 * 扫描日志文件，检测敏感信息泄露
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// 敏感数据正则模式
const SENSITIVE_PATTERNS = {
  password: /(?:password|passwd|pwd)["\s:=]+["']?([^"'\s]{4,})["']?/gi,
  creditCard: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b(?:\+?\d{1,3}[-\s]?)?\(?\d{3}\)?[-\s]?\d{3}[-\s]?\d{4}\b/g,
  idCard: /\b\d{17}[\dXx]\b/g,
  apiKey: /(?:api[_-]?key|apikey)["\s:=]+["']?([a-zA-Z0-9]{20,})["']?/gi,
  token: /(?:bearer|token)["\s:=]+["']?([a-zA-Z0-9\-._~+/]+=*)["']?/gi
};

class SensitiveDataScanner {
  constructor(logDir) {
    this.logDir = logDir || path.join(process.cwd(), 'logs');
    this.results = {
      scanned: 0,
      totalFiles: 0,
      totalLines: 0,
      findings: [],
      summary: {}
    };
  }

  async scan() {
    console.log(`Scanning logs in: ${this.logDir}`);
    
    const files = await this.getLogFiles();
    this.results.totalFiles = files.length;

    for (const file of files) {
      await this.scanFile(file);
    }

    this.generateSummary();
    return this.results;
  }

  async getLogFiles() {
    const files = [];
    const items = fs.readdirSync(this.logDir);

    for (const item of items) {
      const fullPath = path.join(this.logDir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isFile() && (item.endsWith('.log') || item.endsWith('.json'))) {
        files.push(fullPath);
      }
    }

    return files;
  }

  async scanFile(filePath) {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      let lineNumber = 0;

      rl.on('line', (line) => {
        lineNumber++;
        this.results.totalLines++;
        this.scanLine(line, filePath, lineNumber);
      });

      rl.on('close', () => {
        this.results.scanned++;
        console.log(`Scanned: ${path.basename(filePath)} (${lineNumber} lines)`);
        resolve();
      });

      rl.on('error', (err) => {
        console.error(`Error reading ${filePath}:`, err.message);
        resolve();
      });
    });
  }

  scanLine(line, filePath, lineNumber) {
    for (const [type, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
      pattern.lastIndex = 0; // Reset regex
      const matches = line.match(pattern);
      
      if (matches) {
        this.results.findings.push({
          file: path.basename(filePath),
          line: lineNumber,
          type,
          match: this.truncateMatch(matches[0]),
          timestamp: new Date().toISOString()
        });
      }
    }
  }

  truncateMatch(match) {
    if (match.length > 50) {
      return match.substring(0, 50) + '...';
    }
    return match;
  }

  generateSummary() {
    this.results.summary = {};

    for (const finding of this.results.findings) {
      if (!this.results.summary[finding.type]) {
        this.results.summary[finding.type] = 0;
      }
      this.results.summary[finding.type]++;
    }
  }

  printReport() {
    console.log('\n=== Sensitive Data Scan Report ===\n');
    console.log(`Files scanned: ${this.results.scanned}/${this.results.totalFiles}`);
    console.log(`Total lines: ${this.results.totalLines}`);
    console.log(`Total findings: ${this.results.findings.length}`);
    
    if (Object.keys(this.results.summary).length > 0) {
      console.log('\nFindings by type:');
      for (const [type, count] of Object.entries(this.results.summary)) {
        console.log(`  ${type}: ${count}`);
      }

      console.log('\nTop 10 findings:');
      this.results.findings.slice(0, 10).forEach((finding, index) => {
        console.log(`  ${index + 1}. [${finding.file}:${finding.line}] ${finding.type}: ${finding.match}`);
      });

      if (this.results.findings.length > 10) {
        console.log(`  ... and ${this.results.findings.length - 10} more`);
      }
    } else {
      console.log('\n✅ No sensitive data found in logs.');
    }
  }

  saveReport(outputPath) {
    const report = {
      scanDate: new Date().toISOString(),
      logDir: this.logDir,
      ...this.results
    };

    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${outputPath}`);
  }
}

// CLI 入口
if (require.main === module) {
  const args = process.argv.slice(2);
  const logDir = args[0] || './logs';
  const output = args[1] || './sensitive-data-scan-report.json';

  const scanner = new SensitiveDataScanner(logDir);
  
  scanner.scan().then(() => {
    scanner.printReport();
    scanner.saveReport(output);
    
    // 如果发现敏感数据，返回非零退出码
    if (scanner.results.findings.length > 0) {
      process.exit(1);
    }
  });
}

module.exports = SensitiveDataScanner;
```

### 4.7 集成到网关

修改 `backend/services/gateway/server.js`：

```javascript
const express = require('express');
const sensitiveDataFilter = require('../../shared/middleware/sensitiveDataFilter');
const LogSecurityMiddleware = require('../../shared/middleware/logSecurityMiddleware');

const app = express();

// 初始化全局脱敏器
const SensitiveDataMasker = require('../../shared/SensitiveDataMasker');
global.sensitiveDataMasker = new SensitiveDataMasker({
  auditEnabled: true,
  enableHashing: true
});

// 初始化日志安全中间件
const logSecurity = new LogSecurityMiddleware({
  enabled: process.env.ENABLE_LOG_SECURITY !== 'false',
  mode: process.env.NODE_ENV,
  auditEnabled: true
});

// 应用请求响应过滤器
app.use(sensitiveDataFilter({
  filterRequestBody: true,
  filterResponseBody: true,
  filterHeaders: true
}));

// ... 其他中间件
```

### 4.8 数据库迁移

创建 `database/migrations/20260630_add_masking_audit_logs.sql`：

```sql
-- 脱敏审计日志表
CREATE TABLE IF NOT EXISTS masking_audit_logs (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event VARCHAR(50) NOT NULL,
    field VARCHAR(100) NOT NULL,
    rule VARCHAR(100) NOT NULL,
    strategy VARCHAR(50) NOT NULL,
    description TEXT,
    service VARCHAR(50),
    request_id VARCHAR(100),
    user_id INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引
CREATE INDEX idx_masking_audit_timestamp ON masking_audit_logs(timestamp);
CREATE INDEX idx_masking_audit_event ON masking_audit_logs(event);
CREATE INDEX idx_masking_audit_user_id ON masking_audit_logs(user_id);

-- 脱敏规则配置表
CREATE TABLE IF NOT EXISTS masking_rules (
    id SERIAL PRIMARY KEY,
    rule_name VARCHAR(100) UNIQUE NOT NULL,
    patterns TEXT[] NOT NULL,
    strategy VARCHAR(50) NOT NULL,
    priority INTEGER DEFAULT 3,
    description TEXT,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 插入默认规则
INSERT INTO masking_rules (rule_name, patterns, strategy, priority, description) VALUES
('password', ARRAY['password', 'passwd', 'pwd', 'pass', 'pin'], 'mask_all', 1, '用户密码'),
('creditCard', ARRAY['creditCard', 'cardNumber', 'card_number', 'pan'], 'mask_partial', 1, '信用卡号'),
('cvv', ARRAY['cvv', 'cvv2', 'securityCode'], 'mask_all', 1, 'CVV安全码'),
('email', ARRAY['email', 'emailAddress'], 'mask_email', 2, '电子邮件'),
('phone', ARRAY['phone', 'phoneNumber', 'mobile'], 'mask_phone', 2, '手机号'),
('idCard', ARRAY['idCard', 'id_card', 'identityCard'], 'mask_id_card', 1, '身份证号'),
('apiKey', ARRAY['apiKey', 'api_key', 'secretKey'], 'mask_token', 1, 'API密钥'),
('accessToken', ARRAY['accessToken', 'access_token', 'token'], 'mask_token', 1, '访问令牌');

-- 脱敏统计表
CREATE TABLE IF NOT EXISTS masking_stats (
    id SERIAL PRIMARY KEY,
    service VARCHAR(50) NOT NULL,
    date DATE NOT NULL,
    total_masked INTEGER DEFAULT 0,
    by_type JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(service, date)
);

-- 分区表（按月分区）
CREATE TABLE IF NOT EXISTS masking_audit_logs_202606 PARTITION OF masking_audit_logs
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE IF NOT EXISTS masking_audit_logs_202607 PARTITION OF masking_audit_logs
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
```

## 5. 验收标准

- [ ] 创建 `backend/shared/SensitiveDataMasker.js` 核心模块，支持 20+ 种敏感字段类型
- [ ] 实现至少 8 种脱敏策略（mask_all, mask_partial, mask_email, mask_phone, mask_id_card, mask_name, mask_token, mask_ip）
- [ ] 创建 `backend/shared/middleware/logSecurityMiddleware.js`，自动拦截日志输出
- [ ] 创建 `backend/shared/middleware/sensitiveDataFilter.js`，自动过滤 HTTP 请求/响应
- [ ] 集成到 `backend/shared/logger.js`，所有现有日志输出自动脱敏
- [ ] 在 gateway 和所有微服务中启用日志安全中间件
- [ ] 创建 `backend/tools/sensitive-data-scanner.js` 扫描工具，检测现有日志中的敏感信息
- [ ] 在 admin-dashboard 添加脱敏规则管理界面
- [ ] 创建 `backend/services/admin/routes/masking-rules.js` API 路由
- [ ] 数据库迁移成功，创建审计日志表和规则配置表
- [ ] 单元测试覆盖率 ≥ 90%（针对 SensitiveDataMasker）
- [ ] 集成测试验证日志不再记录敏感信息
- [ ] 性能测试验证脱敏逻辑延迟 < 5ms
- [ ] 扫描现有日志文件，生成敏感数据泄露报告
- [ ] 安全审计通过，确认敏感信息不再泄露

## 6. 影响范围

### 直接影响
- `backend/shared/logger.js`：添加自动脱敏功能
- `backend/shared/SensitiveDataMasker.js`：新增核心脱敏模块
- `backend/shared/middleware/logSecurityMiddleware.js`：新增日志安全中间件
- `backend/shared/middleware/sensitiveDataFilter.js`：新增请求响应过滤器
- `backend/services/gateway/server.js`：集成脱敏中间件
- `backend/services/admin/routes/masking-rules.js`：新增管理 API
- `backend/tools/sensitive-data-scanner.js`：新增扫描工具
- `database/migrations/`：新增数据库迁移文件
- `frontend/admin-dashboard/src/pages/MaskingRules.js`：新增管理界面

### 间接影响
- 所有使用 logger 的微服务：自动获得日志脱敏能力
- 所有 API 请求/响应：自动过滤敏感字段
- 审计日志系统：增加新的审计事件类型
- 监控系统：增加脱敏统计指标

### 性能影响
- 日志输出延迟增加：< 5ms（可接受）
- 内存占用增加：约 10MB（规则缓存）
- CPU 开销：轻微（字符串匹配和替换）

## 7. 风险评估

### 技术风险
| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 脱敏规则遗漏敏感字段 | 中 | 高 | 定期审计日志，动态更新规则 |
| 脱敏性能影响日志输出 | 低 | 中 | 优化正则匹配，使用缓存 |
| 规则配置错误导致业务异常 | 低 | 高 | 充分测试，灰度发布 |

### 合规风险
| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 未完全满足 GDPR 要求 | 低 | 高 | 与法务团队确认合规性 |
| 审计日志不完整 | 低 | 中 | 多级审计日志机制 |

## 8. 参考资料

- **GDPR 第 32 条**：数据安全技术措施
- **PCI-DSS 3.2 要求 3.2**：敏感认证数据处理
- **OWASP Logging Cheat Sheet**：日志安全最佳实践
- **CWE-532**：日志信息泄露漏洞
- **NIST SP 800-92**：日志管理指南

## 9. 优先级理由

**P1** 理由：

1. **安全合规要求**：满足 GDPR、PCI-DSS 等法规的日志安全要求，避免监管处罚。
2. **数据泄露风险**：日志敏感信息泄露是常见的数据泄露途径，需优先防范。
3. **影响范围广**：涉及所有微服务的日志输出，影响系统整体安全性。
4. **依赖关系**：其他安全需求（如 REQ-00338、REQ-00343）依赖本需求提供基础防护能力。
5. **实施成本低**：工作量适中（M），可在短时间内完成并快速提升安全水位。

与项目目标一致性：
- 满足"安全加固"维度要求，提升成熟度评分
- 符合"生产可用"标准中的安全合规要求
- 支持 GDPR 合规目标，满足数据保护法规
