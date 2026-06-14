# REQ-00200：敏感操作二次验证与风险分级验证系统

- **编号**：REQ-00200
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、payment-service、social-service、backend/shared/riskVerifier.js、game-client
- **创建时间**：2026-06-14 15:05
- **依赖需求**：REQ-00057（MFA 系统）、REQ-00064（CAPTCHA 系统）

## 1. 背景与问题

当前系统已实现 MFA（多因素认证）和 CAPTCHA（人机验证），但缺少针对**敏感操作**的分级验证机制：

1. **高风险操作无二次确认**：精灵交易、大额支付、账号注销等高风险操作仅需一次认证，存在被盗号后资产损失风险
2. **验证策略一刀切**：所有操作使用相同验证强度，低风险操作过度验证影响体验，高风险操作验证不足
3. **风险上下文缺失**：未考虑设备变更、异地登录、异常行为等风险信号，无法动态调整验证强度
4. **验证结果无时效管理**：二次验证通过后无有效期限制，长时间会话仍可执行高风险操作

## 2. 目标

建立**敏感操作二次验证与风险分级验证系统**，实现：

1. **风险分级**：将操作分为 P0（极高危）、P1（高危）、P2（中危）、P3（低危）四个等级
2. **动态验证策略**：根据用户风险画像、设备信任度、行为异常度动态选择验证方式
3. **多因素组合验证**：支持密码确认、短信/邮件 OTP、TOTP、生物识别等多种验证方式组合
4. **验证结果时效管理**：验证通过后设置有效期，过期需重新验证

## 3. 范围

- **包含**：
  - 敏感操作注册与风险分级配置
  - 用户风险画像计算（设备信任度、行为异常度、历史风险事件）
  - 动态验证策略引擎
  - 二次验证中间件与路由
  - 验证结果缓存与时效管理
  - 前端验证流程组件

- **不包含**：
  - 新的验证通道开发（复用现有 MFA、CAPTCHA 基础设施）
  - 生物识别硬件集成（仅预留接口）
  - 风控决策引擎（属于 REQ-00175 范围）

## 4. 详细需求

### 4.1 敏感操作风险分级配置

```javascript
// backend/shared/riskVerifier.js
const SENSITIVE_OPERATIONS = {
  // P0 极高危：资产永久损失风险
  'pokemon:trade:confirm': { level: 'P0', ttl: 300, methods: ['password', 'totp'] },
  'payment:withdraw': { level: 'P0', ttl: 600, methods: ['password', 'sms'] },
  'user:account:delete': { level: 'P0', ttl: 86400, methods: ['password', 'email', 'totp'] },
  'pokemon:release:batch': { level: 'P0', ttl: 300, methods: ['password'] },
  
  // P1 高危：资产转移或重要设置变更
  'payment:purchase:large': { level: 'P1', ttl: 600, methods: ['password', 'totp'] },
  'pokemon:evolve:rare': { level: 'P1', ttl: 300, methods: ['password'] },
  'user:password:change': { level: 'P1', ttl: 0, methods: ['password', 'totp'] },
  'user:email:change': { level: 'P1', ttl: 0, methods: ['password', 'email_old', 'email_new'] },
  'social:guild:disband': { level: 'P1', ttl: 600, methods: ['password'] },
  
  // P2 中危：可逆操作或中等价值资产
  'pokemon:trade:initiate': { level: 'P2', ttl: 1800, methods: ['password'] },
  'payment:purchase:normal': { level: 'P2', ttl: 1800, methods: ['pin'] },
  'social:friend:remove:batch': { level: 'P2', ttl: 300, methods: ['password'] },
  'user:settings:privacy': { level: 'P2', ttl: 3600, methods: ['password'] },
  
  // P3 低危：日常操作
  'pokemon:release:single': { level: 'P3', ttl: 3600, methods: ['pin'] },
  'social:friend:remove': { level: 'P3', ttl: 7200, methods: ['pin'] }
};
```

### 4.2 用户风险画像计算

```javascript
// 风险分数计算（0-100，越高越危险）
async function calculateRiskScore(userId, context) {
  const factors = [];
  
  // 1. 设备信任度（0-30分）
  const deviceTrust = await getDeviceTrustScore(userId, context.deviceId);
  factors.push({ name: 'device_trust', score: 30 - deviceTrust, weight: 1 });
  
  // 2. 登录地点异常（0-25分）
  const locationRisk = await calculateLocationRisk(userId, context.ip, context.geo);
  factors.push({ name: 'location_risk', score: locationRisk, weight: 1 });
  
  // 3. 行为异常度（0-20分）
  const behaviorRisk = await getBehaviorAnomalyScore(userId);
  factors.push({ name: 'behavior_risk', score: behaviorRisk, weight: 1 });
  
  // 4. 历史风险事件（0-15分）
  const historyRisk = await getHistoryRiskScore(userId);
  factors.push({ name: 'history_risk', score: historyRisk, weight: 1 });
  
  // 5. 会话年龄（0-10分）
  const sessionAge = getSessionAgeRisk(context.sessionAge);
  factors.push({ name: 'session_age', score: sessionAge, weight: 1 });
  
  return {
    total: factors.reduce((sum, f) => sum + f.score * f.weight, 0),
    factors,
    level: getRiskLevel(factors.reduce((sum, f) => sum + f.score * f.weight, 0))
  };
}
```

### 4.3 动态验证策略引擎

```javascript
// 根据操作风险等级和用户风险画像选择验证方式
async function selectVerificationMethods(operation, userRisk) {
  const config = SENSITIVE_OPERATIONS[operation];
  if (!config) return null;
  
  const methods = [...config.methods];
  
  // 用户风险高时，追加验证方式
  if (userRisk.total >= 50) {
    // 高风险用户强制追加 TOTP
    if (!methods.includes('totp') && userRisk.factors.device_trust?.score > 20) {
      methods.push('totp');
    }
  }
  
  // 设备不信任时，强制追加设备验证
  if (userRisk.factors.device_trust?.score > 25) {
    methods.push('device_verify');
  }
  
  // 异地登录时，强制追加位置验证
  if (userRisk.factors.location_risk?.score > 20) {
    methods.push('location_confirm');
  }
  
  return {
    operation,
    requiredMethods: methods,
    ttl: config.ttl,
    riskLevel: config.level,
    userRiskScore: userRisk.total
  };
}
```

### 4.4 验证中间件

```javascript
// gateway/src/middleware/riskVerification.js
async function riskVerificationMiddleware(req, res, next) {
  const operation = req.route?.meta?.riskOperation;
  if (!operation) return next();
  
  const userId = req.user?.id;
  const context = {
    deviceId: req.headers['x-device-id'],
    ip: req.ip,
    geo: req.geoLocation,
    sessionAge: Date.now() - req.session?.createdAt,
    userAgent: req.headers['user-agent']
  };
  
  // 1. 计算用户风险画像
  const userRisk = await calculateRiskScore(userId, context);
  
  // 2. 选择验证策略
  const strategy = await selectVerificationMethods(operation, userRisk);
  
  // 3. 检查是否有有效的验证结果
  const cachedVerification = await getValidVerification(userId, operation);
  
  if (cachedVerification) {
    req.verificationContext = { verified: true, strategy };
    return next();
  }
  
  // 4. 需要验证，返回验证要求
  req.verificationContext = { verified: false, strategy, userRisk };
  
  // 如果是验证请求本身，放行
  if (req.path.endsWith('/verify')) return next();
  
  // 否则返回 403 要求验证
  return res.status(403).json({
    code: 1040,
    message: '需要进行二次验证',
    data: {
      operation,
      requiredMethods: strategy.requiredMethods,
      riskScore: userRisk.total,
      verificationEndpoint: `/api/v1/user/verify/${operation}`
    }
  });
}
```

### 4.5 验证结果缓存

```javascript
// Redis 键设计
// risk:verify:{userId}:{operation} -> { verifiedAt, methods, expiresAt }

async function storeVerificationResult(userId, operation, methods) {
  const config = SENSITIVE_OPERATIONS[operation];
  const ttl = config.ttl || 3600;
  const key = `risk:verify:${userId}:${operation}`;
  
  await redis.setex(key, ttl, JSON.stringify({
    verifiedAt: Date.now(),
    methods,
    expiresAt: Date.now() + ttl * 1000
  }));
}

async function getValidVerification(userId, operation) {
  const key = `risk:verify:${userId}:${operation}`;
  const data = await redis.get(key);
  if (!data) return null;
  
  const parsed = JSON.parse(data);
  if (Date.now() > parsed.expiresAt) {
    await redis.del(key);
    return null;
  }
  return parsed;
}
```

### 4.6 API 接口

```
POST /api/v1/user/verify/:operation
请求体：{ method: 'password' | 'totp' | 'sms' | 'email', code: string }
响应：{ success: boolean, expiresIn: number, remainingMethods: string[] }

GET /api/v1/user/verify/:operation/status
响应：{ verified: boolean, expiresAt?: number, requiredMethods?: string[] }

DELETE /api/v1/user/verify/:operation
描述：清除指定操作的验证状态
```

### 4.7 前端验证流程组件

```javascript
// game-client/src/components/RiskVerification.js
class RiskVerification {
  async initiateVerification(operation) {
    const status = await fetch(`/api/v1/user/verify/${operation}/status`);
    if (status.verified) return { verified: true };
    
    return {
      verified: false,
      requiredMethods: status.requiredMethods,
      verify: async (method, code) => {
        const result = await fetch(`/api/v1/user/verify/${operation}`, {
          method: 'POST',
          body: JSON.stringify({ method, code })
        });
        return result;
      }
    };
  }
}
```

## 5. 验收标准（可测试）

- [ ] 敏感操作配置表完整，覆盖交易、支付、账号、精灵释放等核心场景
- [ ] 用户风险画像计算准确，5 个风险因子权重正确，总分范围 0-100
- [ ] 动态验证策略引擎根据风险分数正确追加验证方式
- [ ] 验证中间件正确拦截未验证的高风险请求，返回 403
- [ ] 验证结果缓存正确存储和过期清理
- [ ] P0 操作验证有效期 ≤ 10 分钟，P1 ≤ 30 分钟，P2 ≤ 1 小时
- [ ] 高风险用户（分数 ≥ 50）强制追加 TOTP 验证
- [ ] 前端验证组件正确处理多步骤验证流程
- [ ] 单元测试覆盖 riskVerifier.js 核心逻辑 ≥ 90%
- [ ] 集成测试覆盖完整验证流程：触发 → 验证 → 通过 → 执行操作

## 6. 工作量估算

**L（Large）**

- 后端核心逻辑（风险画像、策略引擎、中间件）：2 天
- 验证结果缓存与 API 接口：1 天
- 前端验证组件：1 天
- 单元测试与集成测试：1 天
- 文档更新：0.5 天

总计：5.5 人天

## 7. 优先级理由

**P1 理由**：

1. **安全合规要求**：金融类应用（涉及支付）必须具备敏感操作二次验证能力
2. **资产保护**：精灵交易、大额支付等操作涉及用户核心资产，被盗将造成实际损失
3. **用户体验平衡**：风险分级验证避免一刀切，在安全与体验间取得平衡
4. **依赖已就绪**：MFA、CAPTCHA 系统已实现，可复用验证通道，开发成本低
5. **行业最佳实践**：主流游戏（如原神、王者荣耀）均实现了敏感操作二次验证
