# REQ-00507: 密码强度策略与泄露检测系统

- **编号**：REQ-00507
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：user-service/src/routes/sessions.js、user-service/src/routes/auth.js、backend/shared/passwordPolicy.js、backend/shared/breachDetection.js
- **创建时间**：2026-07-08 16:00
- **依赖需求**：无

## 1. 背景与问题

mineGo 项目当前密码策略过于简单，仅要求：
```javascript
z.string().min(6).max(128)
  .regex(/^(?=.*[a-zA-Z])(?=.*\d).+$/, '密码必须包含字母和数字')
```

### 1.1 当前问题
1. **密码强度不足**：缺少特殊字符、大写字母等复杂度要求
2. **常见密码黑名单缺失**：用户可使用 "password123"、"123456" 等弱密码
3. **泄露密码检测缺失**：无法检测密码是否在已知泄露数据库中
4. **密码强度评分缺失**：用户无法获知密码安全等级
5. **管理员无法配置策略**：策略硬编码，无法动态调整

### 1.2 安全风险
- 暴力破解成功率偏高
- 凭证填充攻击风险
- 不符合 OWASP 密码安全指南
- 影响 SOC 2 / ISO 27001 合规认证

## 2. 目标

1. **强化密码策略**：实现多层次密码复杂度验证
2. **泄露密码检测**：对接 Have I Been Pwned API 检测泄露密码
3. **常见密码黑名单**：内置 Top 10000 常见密码黑名单
4. **密码强度评分**：为用户提供实时密码强度反馈
5. **可配置策略**：支持管理员动态调整密码策略

## 3. 范围

### 包含
- 密码策略验证模块：`PasswordPolicyValidator`
- 泄露密码检测服务：`BreachDetectionService`
- 常见密码黑名单加载器
- 密码强度评分算法（zxcvbn 或自定义）
- 配置中心集成：支持动态策略调整
- 注册/修改密码接口集成

### 不包含
- 密码管理器集成
- 生物认证替代
- 密码历史记录（已由其他需求覆盖）
- 多因素认证增强（REQ-00057 已实现）

## 4. 详细需求

### 4.1 密码策略验证模块

```javascript
// backend/shared/passwordPolicy.js

/**
 * 密码策略配置
 */
const DEFAULT_POLICY = {
  minLength: 10,
  maxLength: 128,
  requireUppercase: true,      // 至少1个大写字母
  requireLowercase: true,      // 至少1个小写字母
  requireDigit: true,          // 至少1个数字
  requireSpecial: true,        // 至少1个特殊字符
  specialChars: '!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`',
  minUniqueChars: 6,           // 最少不同字符数
  maxRepeatingChars: 3,        // 最大连续重复字符
  forbidUserInfo: true,        // 禁止包含用户信息
  forbidCommonPasswords: true, // 禁止常见密码
  checkBreach: true,           // 检测泄露密码
  minStrengthScore: 3          // 最低强度评分（0-4）
};

/**
 * 密码策略验证器
 */
class PasswordPolicyValidator {
  constructor(config = {}) {
    this.config = { ...DEFAULT_POLICY, ...config };
    this.commonPasswords = new Set();
    this.loadCommonPasswords();
  }

  /**
   * 加载常见密码黑名单
   */
  async loadCommonPasswords() {
    try {
      const fs = require('fs').promises;
      const path = require('path');
      const blacklistPath = path.join(__dirname, 'data', 'common-passwords.txt');
      const data = await fs.readFile(blacklistPath, 'utf-8');
      const passwords = data.split('\n').map(p => p.trim().toLowerCase());
      this.commonPasswords = new Set(passwords);
    } catch (err) {
      console.warn('Failed to load common passwords blacklist:', err.message);
    }
  }

  /**
   * 验证密码
   * @param {string} password 密码
   * @param {Object} userInfo 用户信息（用于检查密码是否包含用户信息）
   * @returns {Object} 验证结果
   */
  async validate(password, userInfo = {}) {
    const result = {
      valid: true,
      score: 0,
      errors: [],
      warnings: [],
      suggestions: []
    };

    // 基础长度检查
    if (password.length < this.config.minLength) {
      result.errors.push(`密码长度至少 ${ this.config.minLength} 个字符`);
      result.valid = false;
    }

    if (password.length > this.config.maxLength) {
      result.errors.push(`密码长度不能超过 ${this.config.maxLength} 个字符`);
      result.valid = false;
    }

    // 复杂度检查
    if (this.config.requireUppercase && !/[A-Z]/.test(password)) {
      result.errors.push('密码必须包含至少一个大写字母');
      result.valid = false;
    }

    if (this.config.requireLowercase && !/[a-z]/.test(password)) {
      result.errors.push('密码必须包含至少一个小写字母');
      result.valid = false;
    }

    if (this.config.requireDigit && !/\d/.test(password)) {
      result.errors.push('密码必须包含至少一个数字');
      result.valid = false;
    }

    if (this.config.requireSpecial && !this.containsSpecialChar(password)) {
      result.errors.push(`密码必须包含至少一个特殊字符 (${this.config.specialChars})`);
      result.valid = false;
    }

    // 连续重复字符检查
    if (this.hasRepeatingChars(password, this.config.maxRepeatingChars)) {
      result.warnings.push(`密码包含 ${this.config.maxRepeatingChars} 个以上连续重复字符`);
    }

    // 用户信息检查
    if (this.config.forbidUserInfo && this.containsUserInfo(password, userInfo)) {
      result.errors.push('密码不能包含用户名、手机号或邮箱');
      result.valid = false;
    }

    // 常见密码检查
    if (this.config.forbidCommonPasswords && this.commonPasswords.has(password.toLowerCase())) {
      result.errors.push('密码过于常见，请使用更复杂的密码');
      result.valid = false;
    }

    // 计算强度评分
    result.score = this.calculateStrength(password, userInfo);
    
    if (result.score < this.config.minStrengthScore) {
      result.warnings.push(`密码强度不足，建议增加复杂度`);
    }

    // 生成建议
    if (result.score < 4) {
      result.suggestions = this.generateSuggestions(password);
    }

    return result;
  }

  /**
   * 计算密码强度评分（0-4）
   */
  calculateStrength(password, userInfo) {
    let score = 0;
    
    // 长度贡献
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (password.length >= 16) score++;

    // 复杂度贡献
    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = this.containsSpecialChar(password);
    
    const complexityCount = [hasUpper, hasLower, hasDigit, hasSpecial].filter(Boolean).length;
    if (complexityCount >= 3) score++;
    if (complexityCount === 4) score++;

    // 扣分项
    if (this.containsUserInfo(password, userInfo)) score = Math.max(0, score - 2);
    if (this.commonPasswords.has(password.toLowerCase())) score = 0;
    if (this.hasRepeatingChars(password, 4)) score = Math.max(0, score - 1);

    return Math.min(4, score);
  }

  /**
   * 检查是否包含特殊字符
   */
  containsSpecialChar(password) {
    const specialCharsRegex = new RegExp(`[${this.config.specialChars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`);
    return specialCharsRegex.test(password);
  }

  /**
   * 检查连续重复字符
   */
  hasRepeatingChars(password, maxRepeat) {
    const regex = new RegExp(`(.)\\1{${maxRepeat},}`);
    return regex.test(password);
  }

  /**
   * 检查是否包含用户信息
   */
  containsUserInfo(password, userInfo) {
    const lowerPassword = password.toLowerCase();
    const checkFields = ['username', 'phone', 'email', 'nickname'];
    
    for (const field of checkFields) {
      const value = userInfo[field];
      if (value && lowerPassword.includes(value.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * 生成密码建议
   */
  generateSuggestions(password) {
    const suggestions = [];
    
    if (!/[A-Z]/.test(password)) {
      suggestions.push('添加大写字母');
    }
    if (!/[a-z]/.test(password)) {
      suggestions.push('添加小写字母');
    }
    if (!/\d/.test(password)) {
      suggestions.push('添加数字');
    }
    if (!this.containsSpecialChar(password)) {
      suggestions.push('添加特殊字符');
    }
    if (password.length < 12) {
      suggestions.push('增加密码长度');
    }
    
    return suggestions;
  }
}

module.exports = { PasswordPolicyValidator, DEFAULT_POLICY };
```

### 4.2 泄露密码检测服务

```javascript
// backend/shared/breachDetection.js

const crypto = require('crypto');
const https = require('https');
const { createLogger } = require('./logger');

const logger = createLogger('breach-detection');

/**
 * 泄露密码检测服务
 * 使用 Have I Been Pwned API (k-anonymity)
 */
class BreachDetectionService {
  constructor(options = {}) {
    this.apiEndpoint = options.apiEndpoint || 'https://api.pwnedpasswords.com';
    this.timeout = options.timeout || 5000;
    this.cache = new Map(); // 密码哈希前缀缓存
    this.cacheTTL = options.cacheTTL || 3600000; // 1小时缓存
  }

  /**
   * 检测密码是否泄露
   * @param {string} password 密码
   * @returns {Promise<Object>} 检测结果
   */
  async checkBreach(password) {
    try {
      // SHA-1 哈希
      const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
      const prefix = sha1.substring(0, 5);
      const suffix = sha1.substring(5);

      // 检查缓存
      const cached = this.cache.get(prefix);
      if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
        const count = this.findSuffix(cached.data, suffix);
        return {
          breached: count > 0,
          count,
          cached: true
        };
      }

      // 调用 HIBP API
      const response = await this.fetchRange(prefix);
      
      // 缓存结果
      this.cache.set(prefix, {
        data: response,
        timestamp: Date.now()
      });

      const count = this.findSuffix(response, suffix);
      
      logger.info('Breach check completed', {
        prefix,
        breached: count > 0,
        count
      });

      return {
        breached: count > 0,
        count,
        cached: false
      };

    } catch (error) {
      logger.error('Breach check failed', {
        error: error.message
      });
      
      // API 失败时不阻止用户，但记录警告
      return {
        breached: false,
        count: 0,
        error: error.message
      };
    }
  }

  /**
   * 调用 HIBP range API
   * @param {string} prefix SHA-1 前缀
   * @returns {Promise<string>} API 响应
   */
  async fetchRange(prefix) {
    return new Promise((resolve, reject) => {
      const req = https.get(
        `${this.apiEndpoint}/range/${prefix}`,
        {
          timeout: this.timeout,
          headers: {
            'User-Agent': 'mineGo-PasswordSecurity/1.0'
          }
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HIBP API returned ${res.statusCode}`));
            return;
          }

          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('HIBP API timeout'));
      });
    });
  }

  /**
   * 在响应中查找后缀匹配
   * @param {string} response API 响应
   * @param {string} suffix SHA-1 后缀
   * @returns {number} 泄露次数
   */
  findSuffix(response, suffix) {
    const lines = response.split('\n');
    for (const line of lines) {
      const [hashSuffix, count] = line.split(':');
      if (hashSuffix === suffix) {
        return parseInt(count, 10);
      }
    }
    return 0;
  }

  /**
   * 批量检测（用于迁移或审计）
   * @param {string[]} passwords 密码数组
   * @returns {Promise<Object[]>} 检测结果数组
   */
  async checkBatch(passwords) {
    const results = [];
    for (const password of passwords) {
      const result = await this.checkBreach(password);
      results.push(result);
      // 限制请求速率
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return results;
  }
}

module.exports = { BreachDetectionService };
```

### 4.3 注册/修改密码接口集成

```javascript
// 在 user-service/src/routes/auth.js 中集成

const { PasswordPolicyValidator } = require('../../../../shared/passwordPolicy');
const { BreachDetectionService } = require('../../../../shared/breachDetection');

const passwordValidator = new PasswordPolicyValidator();
const breachDetector = new BreachDetectionService();

// 修改密码设置逻辑
async function validateAndSetPassword(password, userInfo) {
  // 1. 策略验证
  const policyResult = await passwordValidator.validate(password, userInfo);
  
  if (!policyResult.valid) {
    throw new AppError(1012, `密码不符合策略要求: ${policyResult.errors.join('; ')}`);
  }

  // 2. 泄露检测
  const breachResult = await breachDetector.checkBreach(password);
  
  if (breachResult.breached) {
    throw new AppError(1013, 
      `该密码已在已知泄露数据库中出现 ${breachResult.count} 次，请使用其他密码`,
      400
    );
  }

  // 3. 强度警告
  if (policyResult.score < 3) {
    // 记录弱密码警告，但不阻止
    logger.warn('Weak password used', {
      userId: userInfo.id,
      score: policyResult.score,
      suggestions: policyResult.suggestions
    });
  }

  return {
    valid: true,
    score: policyResult.score,
    suggestions: policyResult.suggestions
  };
}
```

### 4.4 API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/v1/auth/check-password` | POST | 检查密码强度和泄露状态（无需登录） |
| `/api/v1/admin/password-policy` | GET | 获取当前密码策略配置 |
| `/api/v1/admin/password-policy` | PUT | 更新密码策略配置（管理员） |

### 4.5 密码强度 API 响应

```json
{
  "valid": true,
  "score": 4,
  "scoreLabel": "非常强",
  "warnings": [],
  "suggestions": [],
  "breachCheck": {
    "breached": false,
    "count": 0
  }
}
```

## 5. 验收标准（可测试）

- [ ] 密码少于 10 个字符时返回错误
- [ ] 密码不包含大写字母时返回错误
- [ ] 密码不包含特殊字符时返回错误
- [ ] 常见密码（如 "password123"）被拒绝
- [ ] 泄露密码被拒绝并返回泄露次数
- [ ] 密码强度评分为 0-4
- [ ] 管理员可通过配置中心修改策略
- [ ] 密码检查 API 不泄露密码明文
- [ ] HIBP API 调用失败不阻止用户注册
- [ ] 单元测试覆盖率 ≥ 80%

## 6. 工作量估算

**M - 中等工作量**
- PasswordPolicyValidator 模块：2 小时
- BreachDetectionService 模块：2 小时
- 常见密码黑名单数据准备：0.5 小时
- 注册/修改密码接口集成：1.5 小时
- 管理接口开发：1 小时
- 单元测试：2 小时
- 集成测试：1 小时

总计约 10 小时，需 1.5 个工作日完成。

## 7. 优先级理由

**P1 - 高优先级**

理由：
1. **安全基线**：密码策略是账号安全的第一道防线
2. **合规要求**：符合 OWASP、NIST 密码安全指南
3. **风险缓解**：降低凭证填充攻击和暴力破解风险
4. **用户教育**：通过强度反馈引导用户使用强密码
5. **成熟度评分**：完成后"安全与合规"维度从 13 分提升至 15 分

此需求是项目安全加固的关键步骤，直接影响用户账号安全。