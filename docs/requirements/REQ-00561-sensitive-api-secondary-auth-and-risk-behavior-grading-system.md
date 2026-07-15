# REQ-00561：敏感API二次认证与风险行为分级控制系统

- **编号**：REQ-00561
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、backend/shared/security、game-client/src/security
- **创建时间**：2026-07-15 10:00
- **依赖需求**：REQ-00057（MFA系统）、REQ-00200（敏感操作风险验证）

## 1. 背景与问题

mineGo 已实现多项安全功能（JWT黑名单、MFA、请求签名、内存保护），但**敏感API调用的风险控制仍不够精细**：

### 现实痛点
1. **敏感操作无二次确认**：精灵释放、账号注销、大额交易等操作一次认证即可执行，存在被盗号后资产损失风险
2. **风险行为无分级**：所有API调用统一认证，无法区分高低风险行为，安全策略一刀切
3. **异常行为无动态干预**：异地登录后立即执行敏感操作、凌晨非常规时段大额消费等无额外验证
4. **风控策略不透明**：用户不了解为何某些操作需要二次验证，体验突兀

### 数据现状
- 日均敏感API调用：约 50,000 次（精灵释放、交易、账号设置等）
- 被盗号后资产损失案例：月均 15-20 起
- 用户投诉账号注销被误操作：周均 3-5 起
- 异常时段敏感操作占比：约 8%（凌晨 2:00-5:00）

### 风险影响
- 账号安全风险高，用户信任度下降
- 敏感操作一旦被恶意执行，损失难以挽回
- 合规要求（如GDPR数据删除）需要额外验证层

## 2. 目标

建立敏感API二次认证与风险行为分级控制系统，**将敏感操作盗用损失降低 90%+**，同时保持用户体验流畅。

### 核心收益
1. **风险分级**：API调用按风险等级分类，实施差异化认证策略
2. **二次认证**：高风险操作强制二次验证（密码/OTP/生物识别）
3. **动态干预**：基于用户行为基线，异常时触发额外验证
4. **透明风控**：用户可查看风控状态，理解安全措施

## 3. 范围

### 包含
- API风险等级定义与分级引擎
- 二次认证中间件（密码、OTP、生物识别）
- 用户行为基线建模与异常检测
- 风险评分动态计算
- 风控策略配置管理
- 风控日志与审计追踪
- 前端二次认证组件

### 不包含
- MFA系统本身（已在 REQ-00057 实现）
- 设备指纹检测（已在 REQ-00045 实现）
- 支付风控（已在 REQ-00003 实现）

## 4. 详细需求

### 4.1 API风险等级定义

**风险等级矩阵**：
```javascript
const API_RISK_LEVELS = {
  // P0 - 极高风险：需要密码 + OTP + 24小时冷静期
  CRITICAL: {
    level: 4,
    name: '极高风险',
    apis: [
      'POST /api/user/account/delete',           // 账号注销
      'POST /api/user/account/transfer',        // 账号转移
      'POST /api/payment/withdraw',             // 提现
    ],
    authMethods: ['password', 'otp'],
    cooldownPeriod: 86400000, // 24小时
    requireConfirmation: true
  },

  // P1 - 高风险：需要密码 + OTP
  HIGH: {
    level: 3,
    name: '高风险',
    apis: [
      'POST /api/pokemon/release/batch',         // 批量精灵释放
      'POST /api/pokemon/trade',                // 精灵交易
      'POST /api/payment/purchase/large',       // 大额购买（>100元）
      'PUT /api/user/password',                 // 修改密码
      'POST /api/user/mfa/disable',             // 禁用MFA
    ],
    authMethods: ['password', 'otp'],
    cooldownPeriod: 0,
    requireConfirmation: true
  },

  // P2 - 中风险：需要密码 或 OTP
  MEDIUM: {
    level: 2,
    name: '中风险',
    apis: [
      'POST /api/pokemon/release',               // 单只精灵释放
      'POST /api/friend/remove',                // 删除好友
      'POST /api/guild/leave',                  // 退出公会
      'PUT /api/user/email',                    // 修改邮箱
      'POST /api/user/device/remove',          // 移除设备
    ],
    authMethods: ['password', 'otp'], // 任选其一
    cooldownPeriod: 0,
    requireConfirmation: false
  },

  // P3 - 低风险：需要重新登录验证
  LOW: {
    level: 1,
    name: '低风险',
    apis: [
      'PUT /api/user/settings',                 // 修改设置
      'POST /api/pokemon/favorite',             // 收藏精灵
      'POST /api/friend/request',               // 添加好友
    ],
    authMethods: ['reauth'], // 重新输入密码或生物识别
    cooldownPeriod: 0,
    requireConfirmation: false
  }
};
```

### 4.2 风险评分动态计算

```javascript
// backend/shared/security/RiskScorer.js
class RiskScorer {
  constructor() {
    this.weights = {
      timeAnomaly: 0.15,      // 时间异常
      locationAnomaly: 0.20,  // 位置异常
      deviceAnomaly: 0.15,    // 设备异常
      behaviorAnomaly: 0.20, // 行为异常
      frequencyAnomaly: 0.15, // 频率异常
      historyRisk: 0.15      // 历史风险
    };
  }

  /**
   * 计算API调用的风险评分
   * @param {Object} context - 请求上下文
   * @returns {Object} 风险评分结果
   */
  async calculateRiskScore(context) {
    const { userId, api, ip, deviceId, timestamp, userAgent } = context;

    // 1. 获取用户行为基线
    const baseline = await this.getUserBaseline(userId);

    // 2. 计算各维度风险
    const scores = {
      timeAnomaly: this.scoreTimeAnomaly(timestamp, baseline.activeHours),
      locationAnomaly: await this.scoreLocationAnomaly(ip, baseline.commonLocations),
      deviceAnomaly: this.scoreDeviceAnomaly(deviceId, baseline.trustedDevices),
      behaviorAnomaly: await this.scoreBehaviorAnomaly(userId, api, baseline.commonActions),
      frequencyAnomaly: this.scoreFrequencyAnomaly(userId, api, baseline.apiFrequency),
      historyRisk: await this.scoreHistoryRisk(userId)
    };

    // 3. 加权求和
    let totalRisk = 0;
    for (const [dim, score] of Object.entries(scores)) {
      totalRisk += score * this.weights[dim];
    }

    // 4. 确定风险等级
    const riskLevel = this.determineRiskLevel(totalRisk);

    return {
      totalRisk: Math.round(totalRisk * 100) / 100,
      riskLevel,
      scores,
      recommendation: this.getRecommendation(totalRisk, context.api),
      requiresSecondaryAuth: riskLevel.level >= 2 || totalRisk > 0.5
    };
  }

  /**
   * 时间异常评分
   */
  scoreTimeAnomaly(timestamp, activeHours) {
    const hour = new Date(timestamp).getHours();

    // 凌晨 2:00-5:00 风险最高
    if (hour >= 2 && hour < 5) return 0.9;

    // 不在用户常规活跃时段
    if (!activeHours.includes(hour)) return 0.5;

    return 0.1;
  }

  /**
   * 位置异常评分
   */
  async scoreLocationAnomaly(ip, commonLocations) {
    const location = await this.getIPLocation(ip);

    // 新位置
    if (!commonLocations.some(loc => this.isNearby(loc, location, 50))) {
      return 0.8;
    }

    return 0.1;
  }

  /**
   * 确定风险等级
   */
  determineRiskLevel(totalRisk) {
    if (totalRisk >= 0.8) return API_RISK_LEVELS.CRITICAL;
    if (totalRisk >= 0.6) return API_RISK_LEVELS.HIGH;
    if (totalRisk >= 0.4) return API_RISK_LEVELS.MEDIUM;
    return API_RISK_LEVELS.LOW;
  }

  /**
   * 获取认证建议
   */
  getRecommendation(totalRisk, api) {
    const apiConfig = this.getApiConfig(api);

    // 动态调整认证方式
    if (totalRisk > 0.7) {
      return {
        authMethods: ['password', 'otp'],
        message: '检测到异常行为，请进行二次验证',
        cooldown: apiConfig.cooldownPeriod
      };
    }

    if (totalRisk > 0.5) {
      return {
        authMethods: apiConfig.authMethods.slice(0, 1),
        message: '安全提示：请确认操作',
        cooldown: 0
      };
    }

    return {
      authMethods: apiConfig.authMethods,
      message: null,
      cooldown: 0
    };
  }
}
```

### 4.3 二次认证中间件

```javascript
// backend/services/gateway/src/middleware/SecondaryAuthMiddleware.js
class SecondaryAuthMiddleware {
  constructor() {
    this.riskScorer = new RiskScorer();
    this.authProviders = {
      password: new PasswordAuthProvider(),
      otp: new OTPAuthProvider(),
      biometric: new BiometricAuthProvider(),
      reauth: new ReauthAuthProvider()
    };
  }

  /**
   * 中间件入口
   */
  async handle(req, res, next) {
    const apiPath = `${req.method} ${req.route.path}`;
    const apiConfig = this.getApiConfig(apiPath);

    if (!apiConfig) {
      return next(); // 非敏感API，放行
    }

    // 检查是否有有效的二次认证令牌
    const secondaryToken = req.headers['x-secondary-auth-token'];
    if (secondaryToken) {
      const validation = await this.validateSecondaryToken(secondaryToken, req.user.id, apiPath);
      if (validation.valid) {
        return next();
      }
    }

    // 计算动态风险评分
    const riskResult = await this.riskScorer.calculateRiskScore({
      userId: req.user.id,
      api: apiPath,
      ip: req.ip,
      deviceId: req.headers['x-device-id'],
      timestamp: Date.now(),
      userAgent: req.headers['user-agent']
    });

    // 存储风控结果供后续使用
    req.riskContext = riskResult;

    // 如果需要二次认证
    if (riskResult.requiresSecondaryAuth) {
      return res.status(403).json({
        error: 'SECONDARY_AUTH_REQUIRED',
        message: riskResult.recommendation.message || '此操作需要二次验证',
        authMethods: riskResult.recommendation.authMethods,
        riskScore: riskResult.totalRisk,
        cooldownUntil: riskResult.recommendation.cooldown > 0
          ? Date.now() + riskResult.recommendation.cooldown
          : null,
        challengeId: await this.generateChallenge(req.user.id, apiPath, riskResult)
      });
    }

    next();
  }

  /**
   * 验证二次认证
   */
  async verifySecondaryAuth(req, res) {
    const { challengeId, authMethod, authData } = req.body;

    // 1. 验证挑战
    const challenge = await this.getChallenge(challengeId);
    if (!challenge || challenge.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'CHALLENGE_EXPIRED' });
    }

    if (challenge.userId !== req.user.id) {
      return res.status(403).json({ error: 'CHALLENGE_MISMATCH' });
    }

    // 2. 执行认证
    const provider = this.authProviders[authMethod];
    if (!provider) {
      return res.status(400).json({ error: 'INVALID_AUTH_METHOD' });
    }

    const authResult = await provider.verify(req.user.id, authData);
    if (!authResult.success) {
      await this.recordFailedAttempt(challenge.userId, challenge.api);
      return res.status(401).json({
        error: 'AUTH_FAILED',
        attemptsRemaining: authResult.attemptsRemaining
      });
    }

    // 3. 生成二次认证令牌
    const secondaryToken = await this.generateSecondaryToken({
      userId: req.user.id,
      api: challenge.api,
      riskLevel: challenge.riskLevel,
      expiresAt: Date.now() + 300000 // 5分钟有效
    });

    // 4. 记录成功认证
    await this.recordSuccessfulAuth(challenge.userId, challenge.api, authMethod);

    res.json({
      success: true,
      secondaryToken,
      expiresAt: Date.now() + 300000,
      api: challenge.api
    });
  }

  /**
   * 生成二次认证令牌
   */
  async generateSecondaryToken(payload) {
    const token = crypto.randomBytes(32).toString('hex');
    const key = `secondary_auth:${token}`;

    await redis.setex(key, 300, JSON.stringify({
      ...payload,
      createdAt: Date.now()
    }));

    return token;
  }
}
```

### 4.4 用户行为基线建模

```javascript
// backend/shared/security/BehaviorBaseline.js
class BehaviorBaseline {
  /**
   * 构建用户行为基线
   */
  async buildBaseline(userId, days = 30) {
    const logs = await this.getUserActivityLogs(userId, days);

    const baseline = {
      // 活跃时段
      activeHours: this.extractActiveHours(logs),

      // 常用位置
      commonLocations: await this.extractCommonLocations(logs),

      // 信任设备
      trustedDevices: this.extractTrustedDevices(logs),

      // API调用频率
      apiFrequency: this.calculateAPIFrequency(logs),

      // 常见操作序列
      commonSequences: this.extractCommonSequences(logs),

      // 更新时间
      updatedAt: Date.now()
    };

    // 存储基线
    await this.saveBaseline(userId, baseline);

    return baseline;
  }

  /**
   * 提取活跃时段
   */
  extractActiveHours(logs) {
    const hourCounts = new Array(24).fill(0);

    for (const log of logs) {
      const hour = new Date(log.timestamp).getHours();
      hourCounts[hour]++;
    }

    // 取前 12 个活跃时段
    const threshold = logs.length * 0.02; // 至少 2% 的活动
    return hourCounts
      .map((count, hour) => ({ hour, count }))
      .filter(h => h.count >= threshold)
      .map(h => h.hour);
  }

  /**
   * 计算API调用频率
   */
  calculateAPIFrequency(logs) {
    const apiCounts = {};

    for (const log of logs) {
      const api = log.api;
      if (!apiCounts[api]) {
        apiCounts[api] = { total: 0, hourly: new Array(24).fill(0) };
      }
      apiCounts[api].total++;
      const hour = new Date(log.timestamp).getHours();
      apiCounts[api].hourly[hour]++;
    }

    // 计算每个API的平均每日调用次数
    const frequency = {};
    const daysCovered = this.getDaysCovered(logs);

    for (const [api, counts] of Object.entries(apiCounts)) {
      frequency[api] = {
        dailyAverage: counts.total / daysCovered,
        peakHours: counts.hourly
          .map((c, h) => ({ hour: h, count: c }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5)
          .map(h => h.hour)
      };
    }

    return frequency;
  }
}
```

### 4.5 前端二次认证组件

```javascript
// frontend/game-client/src/security/SecondaryAuthManager.js
class SecondaryAuthManager {
  constructor() {
    this.pendingChallenge = null;
    this.authMethods = {
      password: this.verifyPassword.bind(this),
      otp: this.verifyOTP.bind(this),
      biometric: this.verifyBiometric.bind(this)
    };
  }

  /**
   * 处理二次认证请求
   */
  async handleSecondaryAuthRequired(response) {
    const { challengeId, authMethods, message, riskScore } = response;

    // 显示二次认证弹窗
    const modal = this.showSecondaryAuthModal({
      message,
      authMethods,
      riskScore
    });

    this.pendingChallenge = {
      challengeId,
      authMethods,
      modal
    };
  }

  /**
   * 执行二次认证
   */
  async performAuth(authMethod, credentials) {
    if (!this.pendingChallenge) {
      throw new Error('No pending challenge');
    }

    const { challengeId } = this.pendingChallenge;

    try {
      const response = await fetch('/api/auth/secondary/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`
        },
        body: JSON.stringify({
          challengeId,
          authMethod,
          authData: credentials
        })
      });

      const result = await response.json();

      if (result.success) {
        // 存储二次认证令牌
        this.storeSecondaryToken(result.secondaryToken, result.expiresAt);

        // 关闭弹窗
        this.closeModal();

        // 重试原始请求
        return this.retryOriginalRequest();
      } else {
        this.showAuthError(result.error);
      }
    } catch (error) {
      console.error('Secondary auth failed:', error);
      this.showAuthError('NETWORK_ERROR');
    }
  }

  /**
   * 显示二次认证弹窗
   */
  showSecondaryAuthModal(options) {
    const modal = document.createElement('div');
    modal.className = 'secondary-auth-modal';
    modal.innerHTML = `
      <div class="auth-container">
        <div class="auth-header">
          <h2>安全验证</h2>
          <p class="auth-message">${options.message || '请进行二次验证以继续操作'}</p>
        </div>

        <div class="auth-methods">
          ${options.authMethods.map(method => `
            <button class="auth-method-btn" data-method="${method}">
              ${this.getAuthMethodIcon(method)}
              <span>${this.getAuthMethodName(method)}</span>
            </button>
          `).join('')}
        </div>

        <div class="auth-input-area" id="authInputArea"></div>

        <div class="auth-actions">
          <button class="auth-cancel-btn">取消</button>
          <button class="auth-confirm-btn" id="authConfirmBtn" disabled>确认</button>
        </div>

        <div class="auth-risk-info">
          <span class="risk-score">风险评分: ${Math.round(options.riskScore * 100)}%</span>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // 绑定事件
    modal.querySelectorAll('.auth-method-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const method = e.currentTarget.dataset.method;
        this.showAuthInput(method);
      });
    });

    return modal;
  }
}
```

### 4.6 风控策略配置API

```
GET  /api/admin/security/risk-policy
  - 功能：获取风控策略配置
  - 响应：{ apiRiskLevels, thresholds, authMethods }

PUT  /api/admin/security/risk-policy
  - 功能：更新风控策略配置（需 admin 权限）
  - 请求体：{ api: string, riskLevel: string, authMethods: string[] }

GET  /api/admin/security/risk-events
  - 功能：获取风控事件日志
  - 响应：{ events: [{ userId, api, riskScore, action, timestamp }] }

GET  /api/user/security/risk-status
  - 功能：获取用户风控状态
  - 响应：{ riskLevel, recentEvents, trustedDevices, baselineStatus }

POST /api/user/security/trust-device
  - 功能：标记设备为信任设备
  - 请求体：{ deviceId, deviceName }
```

### 4.7 Prometheus 指标

```javascript
const metrics = {
  // 二次认证触发次数
  secondaryAuthTriggered: new promClient.Counter({
    name: 'minego_secondary_auth_triggered_total',
    help: 'Secondary authentication triggered count',
    labelNames: ['risk_level', 'api', 'auth_method']
  }),

  // 二次认证成功率
  secondaryAuthSuccess: new promClient.Counter({
    name: 'minego_secondary_auth_success_total',
    help: 'Secondary authentication success count',
    labelNames: ['auth_method', 'api']
  }),

  // 二次认证失败次数
  secondaryAuthFailed: new promClient.Counter({
    name: 'minego_secondary_auth_failed_total',
    help: 'Secondary authentication failure count',
    labelNames: ['auth_method', 'api', 'error']
  }),

  // 风险评分分布
  riskScoreHistogram: new promClient.Histogram({
    name: 'minego_risk_score_distribution',
    help: 'Risk score distribution',
    buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
  }),

  // 被阻止的敏感操作
  sensitiveActionBlocked: new promClient.Counter({
    name: 'minego_sensitive_action_blocked_total',
    help: 'Sensitive actions blocked due to security',
    labelNames: ['api', 'reason']
  })
};
```

## 5. 验收标准（可测试）

- [ ] API风险等级定义完成，包含4级风险分类（CRITICAL/HIGH/MEDIUM/LOW）
- [ ] 风险评分引擎实现，支持6维度风险评估（时间/位置/设备/行为/频率/历史）
- [ ] 二次认证中间件实现，支持密码/OTP/生物识别三种认证方式
- [ ] 用户行为基线建模完成，支持动态更新
- [ ] 前端二次认证组件实现，包含风险提示UI
- [ ] 风控策略配置API实现，支持动态调整
- [ ] 数据库表创建完成：risk_events、user_baselines、secondary_auth_challenges
- [ ] 单元测试覆盖率 ≥ 75%，包含至少20个测试用例
- [ ] Prometheus指标集成，5个指标正常上报
- [ ] 敏感操作盗用事件下降 ≥ 90%

## 6. 工作量估算

**L (Large)** - 预计 2-3 天

理由：
- 涉及多维度风险评估算法
- 需要与现有MFA系统深度集成
- 需要前后端协同开发
- 需要用户行为基线建模

## 7. 优先级理由

**P1** - 高优先级

理由：
1. **账号安全至关重要**：敏感操作盗用直接导致用户资产损失
2. **合规需求**：GDPR等法规要求敏感操作需要额外验证
3. **用户投诉多**：月均15-20起被盗号资产损失案例
4. **技术可行性强**：已有MFA基础设施，可快速扩展
5. **差异化风控**：避免一刀切的安全策略，提升用户体验
