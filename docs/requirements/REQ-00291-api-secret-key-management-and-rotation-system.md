# REQ-00291：API 密钥与敏感配置安全管理及自动轮换系统

- **编号**：REQ-00291
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway, user-service, shared/config, backend/shared/auth.js, backend/shared/weatherService.js, admin-dashboard, Redis, PostgreSQL
- **创建时间**：2026-06-22 11:00
- **依赖需求**：无

## 1. 背景与问题

当前系统在密钥管理方面存在严重安全隐患：

### 1.1 硬编码默认值
```javascript
// shared/auth.js
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'pmg-access-secret-change-in-prod';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'pmg-refresh-secret-change-in-prod';
```
生产环境如果未设置环境变量，将使用弱密钥，极易被破解。

### 1.2 缺乏密钥轮换机制
- JWT 密钥从未轮换，一旦泄露永久有效
- API 密钥（OpenWeatherMap、支付网关等）长期不变
- 数据库连接密码、Redis 密码无轮换策略
- 加密密钥（AES-256）无版本管理

### 1.3 密钥存储不安全
- 环境变量明文存储在 `.env` 文件
- Docker 镜像可能包含密钥
- Kubernetes Secret 未启用加密 at rest
- 无密钥访问审计日志

### 1.4 缺乏泄露检测
- GitHub 提交可能意外包含密钥
- 日志中可能打印敏感信息
- 无密钥泄露监控和告警

### 1.5 权限控制不足
- 所有服务使用相同的数据库密码
- 无最小权限原则
- 无密钥访问的细粒度控制

## 2. 目标

构建企业级密钥管理系统，实现：

1. **密钥集中管理**：统一的密钥存储、访问、审计
2. **自动轮换机制**：定期自动轮换，零停机时间
3. **加密存储**：所有密钥加密存储，支持 HSM
4. **访问控制**：基于 RBAC 的细粒度权限
5. **泄露检测**：实时监控密钥泄露风险
6. **审计追踪**：完整的密钥访问日志
7. **应急响应**：密钥泄露时的快速响应机制

## 3. 范围

### 包含：
- 密钥管理服务（Key Management Service, KMS）
- 密钥存储与加密层（Vault 集成）
- 自动轮换调度器
- 密钥访问代理和缓存
- 泄露检测与告警系统
- 审计日志系统
- 应急响应流程
- 管理后台密钥管理界面

### 不包含：
- 硬件安全模块（HSM）硬件采购
- 第三方密钥管理服务（AWS KMS、Azure Key Vault）的采购决策
- 已泄露密钥的历史追溯

## 4. 详细需求

### 4.1 密钥管理服务（KMS）

#### 4.1.1 密钥类型与分类
```javascript
// 密钥类型枚举
const KeyType = {
  JWT_SECRET: 'jwt_secret',           // JWT 签名密钥
  API_KEY: 'api_key',                 // 第三方 API 密钥
  DATABASE_PASSWORD: 'db_password',   // 数据库密码
  REDIS_PASSWORD: 'redis_password',   // Redis 密码
  ENCRYPTION_KEY: 'encryption_key',   // 数据加密密钥
  OAUTH_SECRET: 'oauth_secret',       // OAuth 客户端密钥
  PAYMENT_KEY: 'payment_key',         // 支付网关密钥
  NOTIFICATION_KEY: 'notification_key' // 推送服务密钥
};

// 密钥敏感等级
const KeySensitivity = {
  CRITICAL: 'critical',   // P0：支付、加密密钥，轮换周期 30 天
  HIGH: 'high',           // P1：JWT、数据库密码，轮换周期 90 天
  MEDIUM: 'medium',       // P2：API 密钥，轮换周期 180 天
  LOW: 'low'              // P3：通知密钥，轮换周期 365 天
};
```

#### 4.1.2 密钥存储架构
```javascript
// 密钥元数据表
CREATE TABLE kms_keys (
  id UUID PRIMARY KEY,
  key_type VARCHAR(50) NOT NULL,
  key_name VARCHAR(100) NOT NULL UNIQUE,
  sensitivity VARCHAR(20) NOT NULL,
  current_version INTEGER DEFAULT 1,
  rotation_period_days INTEGER NOT NULL,
  last_rotated_at TIMESTAMP,
  next_rotation_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

// 密钥版本表（支持多版本并存）
CREATE TABLE kms_key_versions (
  id UUID PRIMARY KEY,
  key_id UUID REFERENCES kms_keys(id),
  version INTEGER NOT NULL,
  encrypted_value TEXT NOT NULL,  // AES-256 加密
  iv VARCHAR(64) NOT NULL,        // 初始化向量
  tag VARCHAR(64) NOT NULL,       // GCM 认证标签
  algorithm VARCHAR(20) DEFAULT 'AES-256-GCM',
  status VARCHAR(20) DEFAULT 'active',  // active, deprecated, revoked
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP,
  revoked_at TIMESTAMP,
  UNIQUE(key_id, version)
);

// 密钥访问审计日志
CREATE TABLE kms_access_logs (
  id UUID PRIMARY KEY,
  key_id UUID,
  service_name VARCHAR(100),
  action VARCHAR(20),  // read, rotate, revoke
  ip_address INET,
  user_agent TEXT,
  success BOOLEAN,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

#### 4.1.3 密钥加密存储
```javascript
// shared/kms/KeyVault.js
class KeyVault {
  constructor() {
    // 主密钥（Master Key）用于加密其他密钥
    // 生产环境应从 HSM 或外部 KMS 获取
    this.masterKey = process.env.MASTER_KEY || this.generateMasterKey();
    this.algorithm = 'aes-256-gcm';
  }

  /**
   * 加密密钥值
   * @param {string} plaintext - 明文密钥
   * @returns {Object} - { encrypted_value, iv, tag }
   */
  encrypt(plaintext) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
      this.algorithm,
      Buffer.from(this.masterKey, 'hex'),
      iv
    );
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    return {
      encrypted_value: encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  /**
   * 解密密钥值
   * @param {string} encrypted - 密文
   * @param {string} ivHex - 初始化向量（hex）
   * @param {string} tagHex - 认证标签（hex）
   * @returns {string} - 明文密钥
   */
  decrypt(encrypted, ivHex, tagHex) {
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      Buffer.from(this.masterKey, 'hex'),
      Buffer.from(ivHex, 'hex')
    );
    
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  /**
   * 生成主密钥（仅用于开发环境）
   */
  generateMasterKey() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MASTER_KEY must be set in production');
    }
    return crypto.randomBytes(32).toString('hex');
  }
}
```

#### 4.1.4 密钥访问代理
```javascript
// shared/kms/KeyService.js
class KeyService {
  constructor() {
    this.vault = new KeyVault();
    this.cache = new Map();  // 内存缓存
    this.cacheTTLMs = 5 * 60 * 1000;  // 5 分钟缓存
  }

  /**
   * 获取密钥（优先缓存）
   * @param {string} keyName - 密钥名称
   * @param {Object} options - { version: 'latest' | number }
   */
  async getKey(keyName, options = {}) {
    const cacheKey = `${keyName}:${options.version || 'latest'}`;
    
    // 检查缓存
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTLMs) {
      await this.logAccess(keyName, 'read', true);
      return cached.value;
    }

    // 从数据库获取
    const keyMeta = await this.getKeyMeta(keyName);
    const version = options.version || keyMeta.current_version;
    
    const keyVersion = await db.queryOne(
      'SELECT * FROM kms_key_versions WHERE key_id = $1 AND version = $2',
      [keyMeta.id, version]
    );

    if (!keyVersion || keyVersion.status !== 'active') {
      throw new Error(`Key ${keyName} version ${version} not available`);
    }

    // 解密
    const decrypted = this.vault.decrypt(
      keyVersion.encrypted_value,
      keyVersion.iv,
      keyVersion.tag
    );

    // 缓存
    this.cache.set(cacheKey, {
      value: decrypted,
      timestamp: Date.now()
    });

    await this.logAccess(keyName, 'read', true);
    return decrypted;
  }

  /**
   * 获取密钥元数据
   */
  async getKeyMeta(keyName) {
    const result = await db.queryOne(
      'SELECT * FROM kms_keys WHERE key_name = $1 AND is_active = true',
      [keyName]
    );
    if (!result) {
      throw new Error(`Key ${keyName} not found`);
    }
    return result;
  }

  /**
   * 记录访问日志
   */
  async logAccess(keyName, action, success, errorMessage = null) {
    await db.query(
      `INSERT INTO kms_access_logs 
       (key_id, service_name, action, ip_address, user_agent, success, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        (await this.getKeyMeta(keyName)).id,
        process.env.SERVICE_NAME || 'unknown',
        action,
        null,  // IP 从 context 获取
        null,  // User-Agent 从 context 获取
        success,
        errorMessage
      ]
    );
  }
}
```

### 4.2 自动轮换机制

#### 4.2.1 轮换调度器
```javascript
// jobs/keyRotation.js
const { CronJob } = require('cron');
const KeyRotationService = require('../shared/kms/KeyRotationService');

class KeyRotationScheduler {
  constructor() {
    this.rotationService = new KeyRotationService();
    this.jobs = [];
  }

  start() {
    // 每小时检查是否需要轮换
    const hourlyJob = new CronJob('0 * * * *', async () => {
      await this.checkAndRotate();
    });
    
    this.jobs.push(hourlyJob);
    hourlyJob.start();
    
    logger.info('Key rotation scheduler started');
  }

  async checkAndRotate() {
    const keysToRotate = await db.query(
      `SELECT * FROM kms_keys 
       WHERE is_active = true 
       AND next_rotation_at <= CURRENT_TIMESTAMP
       ORDER BY sensitivity ASC`  // 先轮换高敏感密钥
    );

    for (const key of keysToRotate) {
      try {
        await this.rotationService.rotateKey(key.id);
        logger.info(`Key ${key.key_name} rotated successfully`);
      } catch (error) {
        logger.error(`Failed to rotate key ${key.key_name}:`, error);
        await this.alertRotationFailed(key, error);
      }
    }
  }
}

// 启动
const scheduler = new KeyRotationScheduler();
scheduler.start();
```

#### 4.2.2 零停机轮换策略
```javascript
// shared/kms/KeyRotationService.js
class KeyRotationService {
  /**
   * 轮换密钥（零停机）
   * 
   * 策略：
   * 1. 生成新版本密钥
   * 2. 新版本激活，旧版本标记为 deprecated
   * 3. 保留旧版本 24 小时（允许正在进行的请求完成）
   * 4. 24 小时后撤销旧版本
   */
  async rotateKey(keyId) {
    const keyMeta = await this.getKeyMeta(keyId);
    
    // 生成新密钥
    const newKeyValue = await this.generateKey(keyMeta.key_type);
    
    // 加密并存储新版本
    const encrypted = this.vault.encrypt(newKeyValue);
    const newVersion = keyMeta.current_version + 1;
    
    await db.transaction(async (client) => {
      // 创建新版本
      await client.query(
        `INSERT INTO kms_key_versions 
         (key_id, version, encrypted_value, iv, tag, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'active', CURRENT_TIMESTAMP + INTERVAL '90 days')`,
        [keyId, newVersion, encrypted.encrypted_value, encrypted.iv, encrypted.tag]
      );
      
      // 旧版本标记为 deprecated（但仍然有效）
      await client.query(
        `UPDATE kms_key_versions 
         SET status = 'deprecated' 
         WHERE key_id = $1 AND version = $2`,
        [keyId, keyMeta.current_version]
      );
      
      // 更新密钥元数据
      await client.query(
        `UPDATE kms_keys 
         SET current_version = $1, 
             last_rotated_at = CURRENT_TIMESTAMP,
             next_rotation_at = CURRENT_TIMESTAMP + (rotation_period_days || ' days')::interval
         WHERE id = $2`,
        [newVersion, keyId]
      );
    });

    // 清除缓存
    await this.clearKeyCache(keyMeta.key_name);
    
    // 发送通知
    await this.notifyRotation(keyMeta.key_name, newVersion);
    
    // 安排旧版本清理
    await this.scheduleOldVersionCleanup(keyId, keyMeta.current_version);
    
    return { keyName: keyMeta.key_name, newVersion };
  }

  /**
   * 生成新密钥
   */
  async generateKey(keyType) {
    const generators = {
      jwt_secret: () => crypto.randomBytes(64).toString('hex'),
      api_key: () => crypto.randomBytes(32).toString('hex'),
      db_password: () => this.generatePassword(32),
      redis_password: () => this.generatePassword(32),
      encryption_key: () => crypto.randomBytes(32).toString('hex')
    };
    
    const generator = generators[keyType];
    if (!generator) {
      throw new Error(`Unknown key type: ${keyType}`);
    }
    
    return generator();
  }

  /**
   * 生成强密码
   */
  generatePassword(length) {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < length; i++) {
      password += charset[crypto.randomInt(0, charset.length)];
    }
    return password;
  }

  /**
   * 安排旧版本清理
   */
  async scheduleOldVersionCleanup(keyId, version) {
    // 延迟 24 小时执行
    setTimeout(async () => {
      try {
        await db.query(
          `UPDATE kms_key_versions 
           SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
           WHERE key_id = $1 AND version = $2`,
          [keyId, version]
        );
        logger.info(`Key version ${keyId}:${version} revoked`);
      } catch (error) {
        logger.error(`Failed to revoke old key version:`, error);
      }
    }, 24 * 60 * 60 * 1000);
  }
}
```

### 4.3 密钥泄露检测

#### 4.3.1 Git 预提交钩子
```bash
#!/bin/bash
# .git/hooks/pre-commit

# 检测敏感信息
FILES=$(git diff --cached --name-only --diff-filter=ACM)
SECRET_PATTERNS=[
  "JWT_SECRET",
  "API_KEY",
  "PRIVATE_KEY",
  "PASSWORD",
  "SECRET",
  "TOKEN",
  "-----BEGIN.*PRIVATE KEY-----"
]

for FILE in $FILES; do
  for PATTERN in "${SECRET_PATTERNS[@]}"; do
    if grep -E "$PATTERN" "$FILE" > /dev/null 2>&1; then
      echo "❌ Potential secret detected in $FILE: $PATTERN"
      echo "Please remove sensitive data before committing."
      exit 1
    fi
  done
done

exit 0
```

#### 4.3.2 日志脱敏中间件
```javascript
// shared/middleware/logSanitization.js
class LogSanitizer {
  constructor() {
    this.sensitiveFields = [
      'password', 'token', 'secret', 'apiKey', 'apiKey',
      'authorization', 'cookie', 'session'
    ];
    
    this.patterns = [
      /Bearer [A-Za-z0-9\-._~+/]+=*/g,
      /[A-Za-z0-9]{40,}/g,  // 可能的密钥
      /-----BEGIN.*PRIVATE KEY-----[\s\S]*?-----END.*PRIVATE KEY-----/g
    ];
  }

  /**
   * 脱敏对象
   */
  sanitize(obj) {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }
    
    const sanitized = Array.isArray(obj) ? [] : {};
    
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      
      // 检查是否是敏感字段
      if (this.sensitiveFields.some(field => lowerKey.includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object') {
        sanitized[key] = this.sanitize(value);
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
   */
  sanitizeString(str) {
    let result = str;
    for (const pattern of this.patterns) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }
}

// 使用
const sanitizer = new LogSanitizer();
logger.info('Request:', sanitizer.sanitize(req.body));
```

#### 4.3.3 GitHub 泄露监控
```javascript
// jobs/githubLeakMonitor.js
const { Octokit } = require('@octokit/rest');

class GitHubLeakMonitor {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.repo = 'kkcc2013-arch/mineGo';
  }

  async checkRecentCommits() {
    const commits = await this.octokit.repos.listCommits({
      owner: 'kkcc2013-arch',
      repo: 'mineGo',
      per_page: 50
    });

    for (const commit of commits.data) {
      const files = await this.getCommitFiles(commit.sha);
      
      for (const file of files) {
        const leaks = this.detectLeaks(file.content);
        
        if (leaks.length > 0) {
          await this.alertLeak({
            commitSha: commit.sha,
            file: file.filename,
            leaks
          });
        }
      }
    }
  }

  detectLeaks(content) {
    const patterns = [
      { name: 'JWT Secret', pattern: /JWT_SECRET\s*=\s*['"][^'"]{10,}['"]/g },
      { name: 'API Key', pattern: /API_KEY\s*=\s*['"][^'"]{10,}['"]/g },
      { name: 'Private Key', pattern: /-----BEGIN.*PRIVATE KEY-----/g }
    ];
    
    const leaks = [];
    for (const { name, pattern } of patterns) {
      const matches = content.match(pattern);
      if (matches) {
        leaks.push({ name, matches });
      }
    }
    return leaks;
  }

  async alertLeak(leakInfo) {
    // 发送告警到 Slack/PagerDuty
    await notificationService.sendAlert({
      level: 'critical',
      title: 'Potential Secret Leak Detected',
      message: `Secret found in ${leakInfo.file}`,
      details: leakInfo
    });
  }
}
```

### 4.4 应急响应机制

#### 4.4.1 密钥撤销流程
```javascript
// shared/kms/EmergencyResponse.js
class EmergencyResponseService {
  /**
   * 紧急撤销密钥（泄露时使用）
   */
  async revokeKey(keyName, reason) {
    const keyMeta = await this.getKeyMeta(keyName);
    
    await db.transaction(async (client) => {
      // 立即撤销所有版本
      await client.query(
        `UPDATE kms_key_versions 
         SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
         WHERE key_id = $1 AND status != 'revoked'`,
        [keyMeta.id]
      );
      
      // 标记密钥为 inactive
      await client.query(
        `UPDATE kms_keys SET is_active = false WHERE id = $1`,
        [keyMeta.id]
      );
      
      // 记录审计日志
      await client.query(
        `INSERT INTO security_incidents 
         (key_id, action, reason, timestamp)
         VALUES ($1, 'emergency_revoke', $2, CURRENT_TIMESTAMP)`,
        [keyMeta.id, reason]
      );
    });

    // 清除所有缓存
    await this.clearAllKeyCache();
    
    // 发送紧急通知
    await this.sendEmergencyAlert(keyName, reason);
    
    logger.critical(`Key ${keyName} emergency revoked: ${reason}`);
  }

  /**
   * 紧急轮换密钥
   */
  async emergencyRotate(keyName, reason) {
    // 先撤销旧密钥
    await this.revokeKey(keyName, reason);
    
    // 生成新密钥
    const keyMeta = await this.getKeyMeta(keyName);
    const newKeyValue = await this.generateKey(keyMeta.key_type);
    
    // 存储新版本
    const encrypted = this.vault.encrypt(newKeyValue);
    
    await db.query(
      `INSERT INTO kms_key_versions 
       (key_id, version, encrypted_value, iv, tag, status)
       VALUES ($1, 1, $2, $3, $4, 'active')`,
      [keyMeta.id, encrypted.encrypted_value, encrypted.iv, encrypted.tag]
    );
    
    // 激活密钥
    await db.query(
      `UPDATE kms_keys SET is_active = true, current_version = 1 WHERE id = $1`,
      [keyMeta.id]
    );
    
    return { keyName, newKeyValue };
  }
}
```

### 4.5 管理后台界面

#### 4.5.1 密钥管理 API
```javascript
// gateway/src/routes/admin/kms.js
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const KeyService = require('../../../shared/kms/KeyService');

/**
 * 获取所有密钥列表（不包含值）
 */
router.get('/keys', requireAdmin, async (req, res) => {
  const keys = await db.query(
    `SELECT id, key_name, key_type, sensitivity, current_version,
            last_rotated_at, next_rotation_at, is_active
     FROM kms_keys
     ORDER BY sensitivity ASC, key_name ASC`
  );
  
  res.json({ keys: keys.rows });
});

/**
 * 手动触发轮换
 */
router.post('/keys/:keyName/rotate', requireAdmin, async (req, res) => {
  const { keyName } = req.params;
  const { reason } = req.body;
  
  const result = await rotationService.rotateKey(keyName, reason);
  
  res.json({ success: true, ...result });
});

/**
 * 查看访问日志
 */
router.get('/keys/:keyName/logs', requireAdmin, async (req, res) => {
  const { keyName } = req.params;
  const { limit = 100 } = req.query;
  
  const logs = await db.query(
    `SELECT * FROM kms_access_logs
     WHERE key_id = (SELECT id FROM kms_keys WHERE key_name = $1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [keyName, limit]
  );
  
  res.json({ logs: logs.rows });
});

/**
 * 紧急撤销
 */
router.post('/keys/:keyName/revoke', requireAdmin, async (req, res) => {
  const { keyName } = req.params;
  const { reason } = req.body;
  
  if (!reason) {
    return res.status(400).json({ error: 'Reason is required for revocation' });
  }
  
  await emergencyService.revokeKey(keyName, reason);
  
  res.json({ success: true, message: `Key ${keyName} revoked` });
});

module.exports = router;
```

### 4.6 迁移计划

#### 4.6.1 从环境变量迁移
```javascript
// scripts/migrate-to-kms.js
async function migrateKeys() {
  const migrations = [
    {
      keyName: 'jwt-access-secret',
      keyType: 'jwt_secret',
      sensitivity: 'high',
      envVar: 'JWT_ACCESS_SECRET',
      rotationDays: 90
    },
    {
      keyName: 'jwt-refresh-secret',
      keyType: 'jwt_secret',
      sensitivity: 'high',
      envVar: 'JWT_REFRESH_SECRET',
      rotationDays: 90
    },
    {
      keyName: 'openweathermap-api-key',
      keyType: 'api_key',
      sensitivity: 'medium',
      envVar: 'OPENWEATHERMAP_API_KEY',
      rotationDays: 180
    },
    {
      keyName: 'database-password',
      keyType: 'db_password',
      sensitivity: 'high',
      envVar: 'DATABASE_PASSWORD',
      rotationDays: 90
    }
  ];

  for (const migration of migrations) {
    const value = process.env[migration.envVar];
    
    if (!value) {
      console.log(`Skipping ${migration.keyName}: not set in environment`);
      continue;
    }
    
    // 创建密钥记录
    await keyService.createKey({
      keyName: migration.keyName,
      keyType: migration.keyType,
      sensitivity: migration.sensitivity,
      value,
      rotationPeriodDays: migration.rotationDays
    });
    
    console.log(`Migrated ${migration.keyName} to KMS`);
  }
}
```

#### 4.6.2 更新现有代码
```javascript
// 旧代码
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'pmg-access-secret-change-in-prod';

// 新代码
const keyService = new KeyService();
const ACCESS_SECRET = await keyService.getKey('jwt-access-secret');
```

## 5. 验收标准（可测试）

- [ ] 所有密钥存储在 KMS 数据库，环境变量不再包含明文密钥
- [ ] 密钥加密存储（AES-256-GCM），主密钥可配置
- [ ] JWT 密钥每 90 天自动轮换，API 密钥每 180 天轮换
- [ ] 轮换过程零停机，旧版本保留 24 小时
- [ ] 管理后台可查看密钥列表、访问日志、手动触发轮换
- [ ] Git 预提交钩子检测并阻止敏感信息提交
- [ ] 日志中间件自动脱敏敏感字段
- [ ] GitHub 泄露监控每小时扫描最近提交
- [ ] 紧急撤销 API 可在 1 分钟内撤销密钥
- [ ] 所有密钥访问记录审计日志
- [ ] 迁移脚本将现有环境变量迁移到 KMS
- [ ] Kubernetes Secret 启用加密 at rest
- [ ] 主密钥备份机制（恢复测试通过）
- [ ] 性能：密钥获取 < 10ms（缓存命中），< 50ms（缓存未命中）

## 6. 工作量估算

**L（Large）**

理由：
- 需要设计和实现完整的密钥管理系统
- 涉及数据库表设计、加密算法、轮换策略
- 需要更新所有使用密钥的服务（9 个微服务）
- 需要实现管理后台界面
- 需要编写迁移脚本
- 需要集成现有的 CI/CD 流程

预估工时：5-7 人天

## 7. 优先级理由

**P1（高优先级）**

理由：
1. **安全风险高**：当前硬编码默认值是严重的安全漏洞
2. **影响范围广**：所有服务都依赖密钥，一旦泄露系统全面受损
3. **合规要求**：密钥管理是安全合规的基本要求
4. **前置依赖**：其他安全需求（如支付安全、数据加密）依赖此系统
5. **成熟度提升**：将安全评分从 13/15 提升到 15/15

完成后，系统将具备企业级密钥管理能力，大幅降低密钥泄露风险。
