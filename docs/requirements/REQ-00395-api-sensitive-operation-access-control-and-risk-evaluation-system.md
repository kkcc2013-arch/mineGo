# REQ-00395：API 敏感操作访问控制与风险评估系统

- **编号**：REQ-00395
- **类别**：安全加固
- **优先级**：P1
- **状态**：new
- **涉及服务/模块**：gateway、user-service、payment-service、social-service、backend/shared/riskEvaluator.js、backend/shared/sensitiveOperationGuard.js、database/migrations、admin-dashboard
- **创建时间**：2026-06-30 20:00 UTC
- **依赖需求**：REQ-00214（敏感操作二次验证）、REQ-00327（会话劫持防护）

## 1. 背景与问题

mineGo 存在多个敏感操作 API（如支付、精灵交易、账号删除、密码修改），当前安全防护存在以下问题：

### 1.1 缺乏操作级别访问控制
- 敏感操作与普通操作使用相同的认证机制
- 没有额外的访问频率限制和冷却期
- 攻击者获取凭证后可直接调用敏感 API

### 1.2 风险评估能力不足
- 无法根据用户历史行为评估当前操作风险
- 缺乏设备、位置、时间的多维风险分析
- 高风险操作缺乏自动拦截机制

### 1.3 敏感操作缺乏统一治理
- 各服务独立实现敏感操作检查
- 缺乏统一的敏感操作清单和风险等级定义
- 难以实施全局安全策略

### 1.4 缺乏操作追踪与审计
- 敏感操作缺乏详细的审计日志
- 无法追溯异常操作的完整上下文
- 安全事件响应缺乏数据支撑

## 2. 目标

建立统一的 API 敏感操作访问控制系统，提供多层防护：

1. **敏感操作清单**：集中定义所有敏感操作及其风险等级
2. **访问控制**：为高风险操作增加额外验证和频率限制
3. **风险评估**：根据用户历史、设备、位置等多维度评估风险
4. **自动拦截**：高风险操作自动触发额外验证或拒绝
5. **完整审计**：记录敏感操作的全链路上下文

**预期收益：**
- 防止敏感操作被滥用，保护用户资产安全
- 减少因凭证泄露导致的损失 90%
- 提升安全事件响应效率

## 3. 范围

- **包含**：
  - 敏感操作清单定义与风险分级
  - 敏感操作访问控制中间件
  - 多维风险评估引擎
  - 高风险操作自动拦截
  - 敏感操作审计日志增强
  - 管理后台风险操作看板

- **不包含**：
  - 会话劫持检测（见 REQ-00327）
  - IP 封禁系统（见 REQ-00075）
  - 二次验证机制（见 REQ-00214）

## 4. 详细需求

### 4.1 敏感操作清单定义

**敏感操作分级表**：

```javascript
// backend/shared/sensitiveOperations.js
const SENSITIVE_OPERATIONS = {
  // P0 - 极高风险：涉及资产转移或账号安全
  P0: {
    operations: [
      { method: 'POST', path: '/api/payment/purchase', description: '内购支付' },
      { method: 'POST', path: '/api/payment/withdraw', description: '精币提现' },
      { method: 'POST', path: '/api/social/trade/confirm', description: '精灵交易确认' },
      { method: 'DELETE', path: '/api/user/account', description: '账号删除' },
      { method: 'PUT', path: '/api/user/password', description: '密码修改' },
      { method: 'PUT', path: '/api/user/email', description: '邮箱修改' },
    ],
    config: {
      requireMFA: true,
      cooldownMs: 60000,      // 1分钟冷却
      maxAttemptsPerHour: 3,
      requireRecentAuth: true, // 需要5分钟内重新登录
    }
  },
  
  // P1 - 高风险：涉及社交或资产查看
  P1: {
    operations: [
      { method: 'POST', path: '/api/social/gift/send', description: '发送礼物' },
      { method: 'POST', path: '/api/pokemon/release', description: '精灵放生' },
      { method: 'GET', path: '/api/user/wallet', description: '钱包余额查看' },
      { method: 'GET', path: '/api/payment/history', description: '支付历史' },
    ],
    config: {
      requireMFA: false,
      cooldownMs: 30000,      // 30秒冷却
      maxAttemptsPerHour: 10,
      requireRecentAuth: false,
    }
  },
  
  // P2 - 中等风险：涉及数据导出或隐私
  P2: {
    operations: [
      { method: 'GET', path: '/api/user/export', description: '数据导出' },
      { method: 'GET', path: '/api/social/friends/all', description: '好友列表导出' },
      { method: 'PUT', path: '/api/user/profile', description: '资料修改' },
    ],
    config: {
      requireMFA: false,
      cooldownMs: 10000,      // 10秒冷却
      maxAttemptsPerHour: 20,
      requireRecentAuth: false,
    }
  }
};

function getOperationRisk(method, path) {
  for (const [level, data] of Object.entries(SENSITIVE_OPERATIONS)) {
    for (const op of data.operations) {
      if (op.method === method && path.startsWith(op.path.split('?')[0])) {
        return { level, config: data.config, description: op.description };
      }
    }
  }
  return null;
}

module.exports = { SENSITIVE_OPERATIONS, getOperationRisk };
```

### 4.2 风险评估引擎

```javascript
// backend/shared/riskEvaluator.js
const redis = require('../redis');
const db = require('../db');
const logger = require('../logger');

class RiskEvaluator {
  constructor() {
    this.riskThresholds = {
      low: 30,
      medium: 60,
      high: 80,
      critical: 95
    };
  }

  /**
   * 评估用户当前操作的风险分数
   * @param {string} userId - 用户ID
   * @param {object} context - 操作上下文
   * @returns {Promise<{score: number, level: string, factors: object}>}
   */
  async evaluate(userId, context) {
    const factors = {
      deviceRisk: await this.evaluateDeviceRisk(userId, context),
      locationRisk: await this.evaluateLocationRisk(userId, context),
      behaviorRisk: await this.evaluateBehaviorRisk(userId, context),
      timeRisk: this.evaluateTimeRisk(context),
      historyRisk: await this.evaluateHistoryRisk(userId, context)
    };

    // 加权计算总分
    const weights = {
      deviceRisk: 0.25,
      locationRisk: 0.20,
      behaviorRisk: 0.25,
      timeRisk: 0.10,
      historyRisk: 0.20
    };

    let totalScore = 0;
    for (const [factor, score] of Object.entries(factors)) {
      totalScore += score * weights[factor];
    }

    const level = this.getRiskLevel(totalScore);

    return {
      score: Math.round(totalScore),
      level,
      factors,
      recommendation: this.getRecommendation(level, context)
    };
  }

  /**
   * 设备风险评估
   */
  async evaluateDeviceRisk(userId, context) {
    const { deviceId, deviceType, isRooted, isEmulator } = context;
    let score = 0;

    // 检查是否是已知设备
    const knownDevice = await redis.hget(`user:devices:${userId}`, deviceId);
    if (!knownDevice) {
      score += 25; // 新设备 +25
    }

    // 检查设备安全状态
    if (isRooted) score += 30;
    if (isEmulator) score += 40;

    // 检查设备类型异常
    const lastDeviceType = await redis.get(`user:lastDeviceType:${userId}`);
    if (lastDeviceType && lastDeviceType !== deviceType) {
      score += 15; // 设备类型切换
    }

    return Math.min(100, score);
  }

  /**
   * 位置风险评估
   */
  async evaluateLocationRisk(userId, context) {
    const { latitude, longitude, country, ip } = context;
    let score = 0;

    // 获取用户最近位置
    const lastLocationStr = await redis.get(`user:lastLocation:${userId}`);
    if (lastLocationStr) {
      const lastLocation = JSON.parse(lastLocationStr);
      
      // 计算距离
      const distance = this.calculateDistance(
        lastLocation.latitude, lastLocation.longitude,
        latitude, longitude
      );

      // 距离异常
      if (distance > 1000) score += 20; // >1000km
      else if (distance > 500) score += 10;
      
      // 时间差
      const timeDiff = Date.now() - lastLocation.timestamp;
      const hours = timeDiff / (1000 * 60 * 60);
      
      // 不可能的速度（距离/时间）
      if (hours > 0 && distance / hours > 1000) {
        score += 30; // 不可能的速度
      }
    }

    // 国家/地区风险
    const highRiskCountries = ['XX', 'YY']; // 高风险国家代码
    if (highRiskCountries.includes(country)) {
      score += 20;
    }

    // IP 异常检查
    const knownIps = await redis.smembers(`user:knownIps:${userId}`);
    if (knownIps.length > 0 && !knownIps.includes(ip)) {
      score += 15;
    }

    return Math.min(100, score);
  }

  /**
   * 行为风险评估
   */
  async evaluateBehaviorRisk(userId, context) {
    const { operation, amount } = context;
    let score = 0;

    // 检查近期失败尝试
    const failCount = await redis.incr(`user:failAttempts:${userId}`);
    if (failCount > 3) {
      score += failCount * 10;
    }

    // 检查金额异常（针对支付操作）
    if (amount) {
      const avgAmount = await redis.get(`user:avgAmount:${userId}`);
      if (avgAmount && amount > parseFloat(avgAmount) * 3) {
        score += 25; // 金额异常偏高
      }
    }

    // 检查操作频率
    const hourOps = await redis.get(`user:hourOps:${userId}`);
    if (hourOps && parseInt(hourOps) > 50) {
      score += 20;
    }

    return Math.min(100, score);
  }

  /**
   * 时间风险评估
   */
  evaluateTimeRisk(context) {
    const hour = new Date().getHours();
    let score = 0;

    // 深夜操作（0-6点）
    if (hour >= 0 && hour < 6) {
      score += 15;
    }

    // 非常规时间段
    const userTimezone = context.timezone || 'UTC';
    const userHour = this.convertToUserTimezone(hour, userTimezone);
    if (userHour >= 0 && userHour < 6) {
      score += 10;
    }

    return Math.min(100, score);
  }

  /**
   * 历史风险评估
   */
  async evaluateHistoryRisk(userId, context) {
    let score = 0;

    // 检查历史风险记录
    const riskHistory = await redis.lrange(`user:riskHistory:${userId}`, 0, 10);
    const recentRisks = riskHistory.map(s => parseFloat(JSON.parse(s).score));
    const avgRisk = recentRisks.reduce((a, b) => a + b, 0) / recentRisks.length || 0;
    
    if (avgRisk > 60) score += 20;
    else if (avgRisk > 40) score += 10;

    // 检查账号年龄
    const accountAge = await this.getAccountAge(userId);
    if (accountAge < 7) score += 15; // 新账号

    return Math.min(100, score);
  }

  getRiskLevel(score) {
    if (score >= this.riskThresholds.critical) return 'critical';
    if (score >= this.riskThresholds.high) return 'high';
    if (score >= this.riskThresholds.medium) return 'medium';
    return 'low';
  }

  getRecommendation(level, context) {
    switch (level) {
      case 'critical':
        return { action: 'block', require: 'admin_approval' };
      case 'high':
        return { action: 'challenge', require: 'mfa' };
      case 'medium':
        return { action: 'monitor', require: 'rate_limit' };
      case 'low':
        return { action: 'allow', require: 'none' };
    }
  }

  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // 地球半径（公里）
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }

  toRad(deg) {
    return deg * Math.PI / 180;
  }

  async getAccountAge(userId) {
    const result = await db.query(
      `SELECT created_at FROM users WHERE id = $1`,
      [userId]
    );
    const createdAt = result.rows[0]?.created_at;
    if (!createdAt) return 0;
    return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  }

  convertToUserTimezone(hour, timezone) {
    // 简化实现，实际需要使用 moment-timezone
    return hour;
  }
}

module.exports = new RiskEvaluator();
```

### 4.3 敏感操作访问控制中间件

```javascript
// backend/shared/sensitiveOperationGuard.js
const { getOperationRisk } = require('./sensitiveOperations');
const riskEvaluator = require('./riskEvaluator');
const redis = require('../redis');
const logger = require('../logger');
const metrics = require('../metrics');

class SensitiveOperationGuard {
  constructor() {
    this.cooldownKey = 'sensitive:cooldown:';
    this.attemptsKey = 'sensitive:attempts:';
  }

  /**
   * 检查敏感操作访问权限
   */
  async checkAccess(req, res, next) {
    const { method, path } = req;
    const userId = req.user?.id;
    const deviceId = req.headers['x-device-id'];
    
    // 检查是否为敏感操作
    const operationRisk = getOperationRisk(method, path);
    if (!operationRisk) {
      return next();
    }

    const { level, config } = operationRisk;
    const startTime = Date.now();

    try {
      // 1. 检查冷却期
      const cooldownEnd = await redis.get(`${this.cooldownKey}${userId}:${path}`);
      if (cooldownEnd && Date.now() < parseInt(cooldownEnd)) {
        const waitTime = Math.ceil((parseInt(cooldownEnd) - Date.now()) / 1000);
        return res.status(429).json({
          error: '操作过于频繁',
          code: 'SENSITIVE_OPERATION_COOLDOWN',
          waitSeconds: waitTime,
          level
        });
      }

      // 2. 检查尝试次数
      const attempts = await redis.incr(`${this.attemptsKey}${userId}:${path}`);
      await redis.expire(`${this.attemptsKey}${userId}:${path}`, 3600);
      
      if (attempts > config.maxAttemptsPerHour) {
        logger.warn('敏感操作尝试次数超限', { userId, path, attempts });
        metrics.increment('sensitive_operation.limited');
        return res.status(429).json({
          error: '操作次数已达上限',
          code: 'SENSITIVE_OPERATION_LIMIT_REACHED',
          level
        });
      }

      // 3. 风险评估
      const context = {
        ...req.body,
        deviceId,
        deviceType: req.headers['x-device-type'],
        isRooted: req.headers['x-device-rooted'] === 'true',
        isEmulator: req.headers['x-device-emulator'] === 'true',
        latitude: parseFloat(req.headers['x-latitude'] || 0),
        longitude: parseFloat(req.headers['x-longitude'] || 0),
        country: req.headers['x-country'],
        ip: req.ip,
        timezone: req.headers['x-timezone'],
        operation: path
      };

      const riskResult = await riskEvaluator.evaluate(userId, context);

      // 4. 根据风险等级处理
      const action = this.determineAction(level, riskResult);

      // 记录风险历史
      await redis.lpush(`user:riskHistory:${userId}`, JSON.stringify({
        score: riskResult.score,
        level: riskResult.level,
        operation: path,
        timestamp: Date.now()
      }));
      await redis.ltrim(`user:riskHistory:${userId}`, 0, 99);

      // 记录审计日志
      logger.info('敏感操作访问检查', {
        userId,
        path,
        method,
        level,
        riskScore: riskResult.score,
        riskLevel: riskResult.level,
        factors: riskResult.factors,
        action: action.type,
        duration: Date.now() - startTime
      });

      // 5. 根据策略执行
      switch (action.type) {
        case 'block':
          metrics.increment('sensitive_operation.blocked');
          return res.status(403).json({
            error: '操作被安全系统拦截',
            code: 'SENSITIVE_OPERATION_BLOCKED',
            reason: action.reason,
            supportContact: 'security@minego.example.com'
          });

        case 'challenge':
          // 需要 MFA 或二次验证
          req.sensitiveOperationChallenge = {
            required: true,
            type: action.challengeType,
            riskLevel: riskResult.level,
            operationLevel: level
          };
          break;

        case 'allow_with_cooldown':
          // 设置冷却期
          await redis.set(
            `${this.cooldownKey}${userId}:${path}`,
            Date.now() + config.cooldownMs,
            'EX',
            Math.ceil(config.cooldownMs / 1000)
          );
          break;
      }

      // 6. 附加风险信息到请求
      req.sensitiveOperation = {
        level,
        riskResult,
        config,
        checked: true
      };

      metrics.timing('sensitive_operation.check_duration', Date.now() - startTime);
      next();

    } catch (error) {
      logger.error('敏感操作检查失败', { error, userId, path });
      // 安全失败：拒绝操作
      return res.status(500).json({
        error: '安全检查失败，请稍后重试',
        code: 'SENSITIVE_OPERATION_CHECK_FAILED'
      });
    }
  }

  determineAction(operationLevel, riskResult) {
    // 极高风险操作：任何风险都需挑战
    if (operationLevel === 'P0') {
      if (riskResult.level === 'critical') {
        return { type: 'block', reason: 'risk_score_too_high' };
      }
      if (riskResult.level === 'high') {
        return { type: 'challenge', challengeType: 'mfa' };
      }
      return { type: 'allow_with_cooldown' };
    }

    // 高风险操作：中高风险需挑战
    if (operationLevel === 'P1') {
      if (riskResult.level === 'critical') {
        return { type: 'challenge', challengeType: 'mfa' };
      }
      if (riskResult.level === 'high') {
        return { type: 'challenge', challengeType: 'password' };
      }
      return { type: 'allow' };
    }

    // 中等风险：仅监控
    return { type: 'allow' };
  }
}

module.exports = new SensitiveOperationGuard();
module.exports.sensitiveOperationMiddleware = () => 
  (req, res, next) => module.exports.checkAccess(req, res, next);
```

### 4.4 Gateway 集成

```javascript
// gateway/src/middleware/sensitiveOperation.js
const { sensitiveOperationMiddleware } = require('@pmg/shared/sensitiveOperationGuard');

// 应用到敏感路由
router.post('/api/payment/purchase', 
  authMiddleware, 
  sensitiveOperationMiddleware(),
  proxy(paymentService)
);

router.delete('/api/user/account',
  authMiddleware,
  sensitiveOperationMiddleware(),
  proxy(userService)
);

router.post('/api/social/trade/confirm',
  authMiddleware,
  sensitiveOperationMiddleware(),
  proxy(socialService)
);
```

### 4.5 数据库迁移

```sql
-- database/migrations/20260630_create_sensitive_operation_logs.sql
CREATE TABLE sensitive_operation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  operation VARCHAR(255) NOT NULL,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(500) NOT NULL,
  operation_level VARCHAR(5) NOT NULL,
  risk_score INTEGER NOT NULL,
  risk_level VARCHAR(20) NOT NULL,
  device_id VARCHAR(255),
  ip_address INET,
  country VARCHAR(10),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  action_taken VARCHAR(50) NOT NULL,
  challenge_type VARCHAR(50),
  challenge_passed BOOLEAN,
  request_body JSONB,
  factors JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  INDEX idx_sensitive_ops_user (user_id, created_at DESC),
  INDEX idx_sensitive_ops_risk (risk_level, created_at DESC),
  INDEX idx_sensitive_ops_action (action_taken, created_at DESC)
);

-- 敏感操作统计视图
CREATE VIEW sensitive_operation_stats AS
SELECT 
  operation,
  method,
  operation_level,
  COUNT(*) as total_attempts,
  COUNT(*) FILTER (WHERE action_taken = 'blocked') as blocked_count,
  COUNT(*) FILTER (WHERE action_taken = 'challenged') as challenged_count,
  AVG(risk_score) as avg_risk_score,
  COUNT(DISTINCT user_id) as unique_users
FROM sensitive_operation_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY operation, method, operation_level;
```

### 4.6 管理后台风险看板

```javascript
// admin-dashboard/src/pages/SensitiveOperations.jsx
const SensitiveOperationsDashboard = () => {
  const [stats, setStats] = useState(null);
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    fetchSensitiveOperationStats().then(setStats);
    fetchRiskAlerts().then(setAlerts);
  }, []);

  return (
    <div className="sensitive-ops-dashboard">
      <h1>敏感操作监控</h1>
      
      <div className="stats-grid">
        <StatCard 
          title="今日操作总数" 
          value={stats?.totalAttempts || 0} 
        />
        <StatCard 
          title="拦截次数" 
          value={stats?.blockedCount || 0}
          variant="danger"
        />
        <StatCard 
          title="平均风险分" 
          value={stats?.avgRiskScore?.toFixed(1) || 0}
        />
        <StatCard 
          title="挑战成功率" 
          value={`${(stats?.challengeSuccessRate * 100 || 0).toFixed(1)}%`}
        />
      </div>

      <RiskAlertsTable alerts={alerts} />
      
      <OperationBreakdownChart data={stats?.operations} />
    </div>
  );
};
```

## 5. 验收标准（可测试）

- [ ] 敏感操作清单定义完整，包含 P0/P1/P2 三个级别
- [ ] P0 操作（支付、账号删除）触发时需要额外验证
- [ ] 风险评估引擎能返回 0-100 分数及风险等级
- [ ] 冷却期机制正常工作（P0 操作 1 分钟冷却）
- [ ] 每小时操作次数限制生效
- [ ] 高风险操作（score > 80）被自动拦截
- [ ] 新设备、异常位置增加风险分数
- [ ] 所有敏感操作记录到审计日志表
- [ ] 管理后台可查看实时风险统计
- [ ] 单元测试覆盖率 > 80%
- [ ] API 文档更新敏感操作说明

## 6. 工作量估算

**L**（较大）：约 5-6 天

- 敏感操作清单设计：1 天
- 风险评估引擎：2 天
- 中间件与 Gateway 集成：1 天
- 审计日志与管理后台：1 天
- 测试与文档：1 天

## 7. 优先级理由

P1 优先级理由：
- 直接保护用户资产安全，防止支付和交易欺诈
- 弥补当前安全防护的薄弱环节
- 与现有安全系统（IP封禁、会话检测）形成完整防护体系
- 实现难度适中，但安全收益显著
