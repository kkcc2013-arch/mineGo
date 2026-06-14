# REQ-00214: 敏感操作二次验证与风险分级验证系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00214 |
| 标题 | 敏感操作二次验证与风险分级验证系统 |
| 类别 | 安全加固 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway、user-service、payment-service、social-service、backend/shared/riskVerifier.js、game-client |
| 创建时间 | 2026-06-14 23:00 |

## 需求描述

### 背景
当前系统中的敏感操作（如账号注销、大额交易、精灵赠送、密码修改等）缺乏统一的风险分级验证机制，存在以下安全隐患：
1. 账号被盗后，攻击者可进行敏感操作
2. 缺乏二次验证，单因素认证风险高
3. 不同风险等级操作验证要求不一致
4. 无操作风险评分与异常行为检测

### 目标
构建完整的敏感操作二次验证与风险分级验证系统：
- 建立操作风险分级体系（低/中/高/极高）
- 根据风险等级触发不同验证方式
- 支持多因素验证（MFA、短信、邮箱、设备验证）
- 异常行为检测与强制验证触发

## 技术方案

### 1. 风险分级定义与配置系统

```javascript
// backend/shared/riskVerifier.js

const RISK_LEVELS = {
  LOW: {
    level: 1,
    name: 'low',
    requiredVerification: [],
    cooldownMinutes: 0,
    description: '常规操作，无需额外验证'
  },
  MEDIUM: {
    level: 2,
    name: 'medium',
    requiredVerification: ['password'],
    cooldownMinutes: 5,
    description: '需要密码确认'
  },
  HIGH: {
    level: 3,
    name: 'high',
    requiredVerification: ['password', 'otp'],
    cooldownMinutes: 10,
    description: '需要密码 + OTP 验证'
  },
  CRITICAL: {
    level: 4,
    name: 'critical',
    requiredVerification: ['password', 'otp', 'device'],
    cooldownMinutes: 30,
    description: '需要密码 + OTP + 设备验证'
  }
};

// 敏感操作定义
const SENSITIVE_OPERATIONS = {
  // 账号相关
  'account:delete': { riskLevel: 'CRITICAL', maxAttempts: 3 },
  'account:change_password': { riskLevel: 'HIGH', maxAttempts: 5 },
  'account:change_email': { riskLevel: 'HIGH', maxAttempts: 5 },
  'account:change_phone': { riskLevel: 'HIGH', maxAttempts: 5 },
  'account:disable_mfa': { riskLevel: 'CRITICAL', maxAttempts: 3 },
  
  // 交易相关
  'trade:initiate': { riskLevel: 'HIGH', maxAmount: 10000 },
  'trade:gift_pokemon': { riskLevel: 'HIGH', maxAttempts: 10 },
  'trade:bulk_transfer': { riskLevel: 'CRITICAL', maxAmount: 50000 },
  
  // 支付相关
  'payment:withdraw': { riskLevel: 'CRITICAL', minAmount: 100 },
  'payment:large_purchase': { riskLevel: 'HIGH', minAmount: 1000 },
  'payment:link_card': { riskLevel: 'HIGH', maxAttempts: 3 },
  
  // 社交相关
  'social:remove_friend': { riskLevel: 'MEDIUM', maxAttempts: 50 },
  'social:transfer_leadership': { riskLevel: 'HIGH', maxAttempts: 3 },
  
  // 数据导出
  'data:export_full': { riskLevel: 'HIGH', maxAttempts: 1 },
  'data:download_backup': { riskLevel: 'CRITICAL', maxAttempts: 1 }
};
```

### 2. 风险上下文评估器

```javascript
// backend/shared/riskContextEvaluator.js

class RiskContextEvaluator {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
  }

  /**
   * 评估操作风险上下文
   * @param {Object} context - 操作上下文
   * @returns {Object} 风险评估结果
   */
  async evaluateRiskContext(context) {
    const { userId, operation, deviceId, ip, location, timestamp } = context;
    
    const factors = {
      // 设备因素
      isKnownDevice: await this.checkKnownDevice(userId, deviceId),
      deviceRiskScore: await this.getDeviceRiskScore(deviceId),
      
      // 位置因素
      isKnownLocation: await this.checkKnownLocation(userId, location),
      locationAnomaly: await this.detectLocationAnomaly(userId, location),
      ipReputation: await this.checkIPReputation(ip),
      
      // 行为因素
      recentFailedAttempts: await this.getRecentFailedAttempts(userId, operation),
      operationFrequency: await this.getOperationFrequency(userId, operation),
      unusualTimePattern: await this.detectUnusualTimePattern(userId, timestamp),
      
      // 账号因素
      accountAge: await this.getAccountAge(userId),
      recentPasswordChange: await this.checkRecentPasswordChange(userId),
      mfaEnabled: await this.checkMFAEnabled(userId)
    };

    // 计算综合风险分数
    const riskScore = this.calculateRiskScore(factors);
    
    return {
      baseRiskLevel: SENSITIVE_OPERATIONS[operation]?.riskLevel || 'LOW',
      riskScore,
      factors,
      recommendedVerification: this.getRecommendedVerification(riskScore, factors),
      requiresChallenge: riskScore > 0.6
    };
  }

  calculateRiskScore(factors) {
    let score = 0;
    
    // 设备风险 (0-0.25)
    if (!factors.isKnownDevice) score += 0.15;
    score += factors.deviceRiskScore * 0.1;
    
    // 位置风险 (0-0.25)
    if (!factors.isKnownLocation) score += 0.1;
    if (factors.locationAnomaly) score += 0.1;
    score += (1 - factors.ipReputation) * 0.05;
    
    // 行为风险 (0-0.3)
    score += Math.min(factors.recentFailedAttempts * 0.05, 0.15);
    if (factors.operationFrequency > 10) score += 0.1;
    if (factors.unusualTimePattern) score += 0.05;
    
    // 账号风险 (0-0.2)
    if (factors.accountAge < 7) score += 0.1;
    if (factors.recentPasswordChange) score += 0.05;
    if (!factors.mfaEnabled) score += 0.05;
    
    return Math.min(score, 1);
  }

  getRecommendedVerification(riskScore, factors) {
    const verifications = [];
    
    if (riskScore >= 0.8) {
      verifications.push('password', 'otp', 'device', 'admin_approval');
    } else if (riskScore >= 0.6) {
      verifications.push('password', 'otp', 'device');
    } else if (riskScore >= 0.4) {
      verifications.push('password', 'otp');
    } else if (riskScore >= 0.2) {
      verifications.push('password');
    }
    
    return verifications;
  }
}
```

### 3. 验证会话管理器

```javascript
// backend/shared/verificationSession.js

class VerificationSessionManager {
  constructor(redis, db) {
    this.redis = redis;
    this.db = db;
  }

  /**
   * 创建验证会话
   */
  async createVerificationSession(userId, operation, context) {
    const sessionId = crypto.randomUUID();
    const evaluation = await riskEvaluator.evaluateRiskContext(context);
    
    const session = {
      id: sessionId,
      userId,
      operation,
      riskLevel: evaluation.baseRiskLevel,
      riskScore: evaluation.riskScore,
      requiredVerifications: evaluation.recommendedVerification,
      completedVerifications: [],
      attempts: 0,
      maxAttempts: SENSITIVE_OPERATIONS[operation]?.maxAttempts || 5,
      createdAt: Date.now(),
      expiresAt: Date.now() + 15 * 60 * 1000, // 15分钟过期
      context: {
        ip: context.ip,
        deviceId: context.deviceId,
        userAgent: context.userAgent
      }
    };

    await this.redis.setex(
      `verification:session:${sessionId}`,
      900,
      JSON.stringify(session)
    );

    // 记录审计日志
    await this.logVerificationAttempt(session, 'created');

    return session;
  }

  /**
   * 验证凭证
   */
  async verifyCredential(sessionId, credentialType, credentialValue) {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error('Verification session not found or expired');
    }

    if (session.attempts >= session.maxAttempts) {
      await this.lockSession(session);
      throw new Error('Maximum verification attempts exceeded');
    }

    // 验证凭证
    let isValid = false;
    switch (credentialType) {
      case 'password':
        isValid = await this.verifyPassword(session.userId, credentialValue);
        break;
      case 'otp':
        isValid = await this.verifyOTP(session.userId, credentialValue);
        break;
      case 'device':
        isValid = await this.verifyDevice(session.userId, session.context.deviceId);
        break;
      case 'email':
        isValid = await this.verifyEmailCode(session.userId, credentialValue);
        break;
      default:
        throw new Error(`Unknown credential type: ${credentialType}`);
    }

    session.attempts++;

    if (isValid) {
      session.completedVerifications.push(credentialType);
      session.attempts = 0; // 重置尝试次数
      
      // 检查是否所有验证都完成
      const allCompleted = session.requiredVerifications.every(
        v => session.completedVerifications.includes(v)
      );
      
      if (allCompleted) {
        session.status = 'completed';
        await this.grantOperationToken(session);
      }
    }

    await this.updateSession(session);
    await this.logVerificationAttempt(session, credentialType, isValid);

    return {
      success: isValid,
      completedVerifications: session.completedVerifications,
      remainingVerifications: session.requiredVerifications.filter(
        v => !session.completedVerifications.includes(v)
      ),
      isFullyVerified: session.status === 'completed'
    };
  }

  /**
   * 授予操作令牌
   */
  async grantOperationToken(session) {
    const operationToken = crypto.randomBytes(32).toString('hex');
    
    await this.redis.setex(
      `operation:token:${session.userId}:${session.operation}`,
      300, // 5分钟有效
      JSON.stringify({
        token: operationToken,
        sessionId: session.id,
        grantedAt: Date.now()
      })
    );

    return operationToken;
  }

  /**
   * 验证操作令牌
   */
  async verifyOperationToken(userId, operation, token) {
    const stored = await this.redis.get(`operation:token:${userId}:${operation}`);
    if (!stored) return false;
    
    const tokenData = JSON.parse(stored);
    if (tokenData.token !== token) return false;
    
    // 使用后立即删除（一次性令牌）
    await this.redis.del(`operation:token:${userId}:${operation}`);
    
    return true;
  }
}
```

### 4. Gateway 中间件集成

```javascript
// gateway/src/middleware/sensitiveOperationGuard.js

const sensitiveOperationGuard = () => {
  return async (req, res, next) => {
    const operation = getOperationFromRequest(req);
    
    if (!operation || !SENSITIVE_OPERATIONS[operation]) {
      return next();
    }

    const userId = req.user.id;
    const operationToken = req.headers['x-operation-token'];
    
    // 检查操作令牌
    if (operationToken) {
      const isValid = await verificationManager.verifyOperationToken(
        userId,
        operation,
        operationToken
      );
      
      if (isValid) {
        return next();
      }
    }

    // 需要验证
    const context = {
      userId,
      operation,
      deviceId: req.headers['x-device-id'],
      ip: req.ip,
      location: req.headers['x-location'],
      userAgent: req.headers['user-agent'],
      timestamp: Date.now()
    };

    const session = await verificationManager.createVerificationSession(
      userId,
      operation,
      context
    );

    return res.status(403).json({
      error: 'VERIFICATION_REQUIRED',
      message: '此操作需要额外验证',
      verificationSession: {
        id: session.id,
        riskLevel: session.riskLevel,
        requiredVerifications: session.requiredVerifications,
        expiresIn: 900
      }
    });
  };
};

function getOperationFromRequest(req) {
  const route = req.route?.path;
  const method = req.method;
  
  // 路由到操作的映射
  const routeOperationMap = {
    'DELETE:/api/v1/account': 'account:delete',
    'PUT:/api/v1/account/password': 'account:change_password',
    'PUT:/api/v1/account/email': 'account:change_email',
    'POST:/api/v1/trade/initiate': 'trade:initiate',
    'POST:/api/v1/trade/gift': 'trade:gift_pokemon',
    'POST:/api/v1/payment/withdraw': 'payment:withdraw',
    'POST:/api/v1/data/export': 'data:export_full'
  };

  return routeOperationMap[`${method}:${route}`];
}
```

### 5. 数据库 Schema

```sql
-- 已知设备表
CREATE TABLE known_devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id VARCHAR(255) NOT NULL,
  device_name VARCHAR(255),
  device_type VARCHAR(50),
  first_seen_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW(),
  trust_score DECIMAL(3,2) DEFAULT 0.5,
  is_trusted BOOLEAN DEFAULT FALSE,
  UNIQUE(user_id, device_id)
);

-- 验证会话日志
CREATE TABLE verification_sessions_log (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  operation VARCHAR(100) NOT NULL,
  risk_level VARCHAR(20),
  risk_score DECIMAL(3,2),
  required_verifications TEXT[],
  completed_verifications TEXT[],
  attempts INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'pending',
  ip_address VARCHAR(45),
  device_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- 操作审计日志
CREATE TABLE sensitive_operations_audit (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  operation VARCHAR(100) NOT NULL,
  operation_token VARCHAR(255),
  session_id VARCHAR(255),
  status VARCHAR(20),
  ip_address VARCHAR(45),
  device_id VARCHAR(255),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_verification_sessions_user ON verification_sessions_log(user_id, created_at DESC);
CREATE INDEX idx_sensitive_operations_audit_user ON sensitive_operations_audit(user_id, created_at DESC);
```

### 6. 前端集成

```javascript
// game-client/src/services/verificationService.js

class VerificationService {
  constructor(api) {
    this.api = api;
    this.currentSession = null;
  }

  /**
   * 处理验证要求响应
   */
  async handleVerificationRequired(response) {
    if (response.error !== 'VERIFICATION_REQUIRED') {
      return null;
    }

    this.currentSession = response.verificationSession;
    
    // 显示验证 UI
    await this.showVerificationUI(response.verificationSession);
    
    return this.currentSession;
  }

  /**
   * 显示验证 UI
   */
  async showVerificationUI(session) {
    const modal = document.createElement('verification-modal');
    
    modal.riskLevel = session.riskLevel;
    modal.requiredVerifications = session.requiredVerifications;
    modal.sessionId = session.id;
    
    // 根据风险级别显示不同 UI
    const uiConfig = {
      medium: { title: '请确认密码', icon: 'shield' },
      high: { title: '请完成安全验证', icon: 'shield-alert' },
      critical: { title: '⚠️ 高风险操作验证', icon: 'shield-x' }
    };

    modal.config = uiConfig[session.riskLevel] || uiConfig.medium;
    
    document.body.appendChild(modal);
    
    return new Promise((resolve, reject) => {
      modal.onComplete = (token) => {
        document.body.removeChild(modal);
        resolve(token);
      };
      modal.onCancel = () => {
        document.body.removeChild(modal);
        reject(new Error('Verification cancelled'));
      };
    });
  }

  /**
   * 提交验证凭证
   */
  async submitCredential(credentialType, value) {
    const response = await this.api.post('/api/v1/verification/verify', {
      sessionId: this.currentSession.id,
      credentialType,
      credentialValue: value
    });

    if (response.isFullyVerified) {
      // 所有验证完成，获取操作令牌
      return {
        operationToken: response.operationToken,
        completed: true
      };
    }

    // 更新会话状态
    this.currentSession.completedVerifications = response.completedVerifications;
    
    return {
      completed: false,
      remainingVerifications: response.remainingVerifications
    };
  }

  /**
   * 重试原始请求
   */
  async retryWithToken(originalRequest, operationToken) {
    return this.api.request({
      ...originalRequest,
      headers: {
        ...originalRequest.headers,
        'X-Operation-Token': operationToken
      }
    });
  }
}
```

## 验收标准

- [ ] **风险分级体系**
  - [ ] 实现 LOW/MEDIUM/HIGH/CRITICAL 四级风险分类
  - [ ] 定义至少 20 种敏感操作及其风险级别
  - [ ] 支持动态调整风险级别配置

- [ ] **风险上下文评估**
  - [ ] 实现设备信任度评估
  - [ ] 实现位置异常检测
  - [ ] 实现行为模式分析
  - [ ] 风险分数计算准确率 > 95%

- [ ] **多因素验证支持**
  - [ ] 密码验证集成
  - [ ] OTP（TOTP）验证集成
  - [ ] 设备验证集成
  - [ ] 邮箱验证码集成
  - [ ] 短信验证码集成（可选）

- [ ] **验证会话管理**
  - [ ] 会话创建、更新、过期机制
  - [ ] 尝试次数限制与锁定
  - [ ] 一次性操作令牌生成与验证
  - [ ] 审计日志记录完整

- [ ] **Gateway 集成**
  - [ ] 敏感操作自动拦截
  - [ ] 验证令牌校验中间件
  - [ ] 路由到操作映射配置

- [ ] **前端集成**
  - [ ] 验证 UI 组件（密码、OTP、设备验证）
  - [ ] 风险等级可视化提示
  - [ ] 验证进度展示
  - [ ] 自动重试原始请求

- [ ] **测试覆盖**
  - [ ] 单元测试覆盖率 > 80%
  - [ ] 集成测试覆盖主要流程
  - [ ] 安全渗透测试通过

## 影响范围

- **后端服务**
  - `gateway/` - 添加验证中间件和路由拦截
  - `user-service/` - OTP 验证、设备管理 API
  - `payment-service/` - 支付操作验证集成
  - `social-service/` - 交易操作验证集成
  - `backend/shared/` - 新增风险评估和验证管理模块

- **前端**
  - `game-client/src/services/` - 验证服务
  - `game-client/src/components/` - 验证 UI 组件
  - `game-client/src/screens/` - 账号设置页集成

- **数据库**
  - 新增 `known_devices` 表
  - 新增 `verification_sessions_log` 表
  - 新增 `sensitive_operations_audit` 表

- **配置**
  - 敏感操作定义配置文件
  - 风险级别配置文件
  - 验证策略配置

## 参考

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [NIST Digital Identity Guidelines](https://pages.nist.gov/800-63-3/)
- [PCI DSS Multi-Factor Authentication Requirements](https://www.pcisecuritystandards.org/)
- REQ-00057: 多因素认证（MFA）系统
- REQ-00127: 用户数据删除请求管理系统
